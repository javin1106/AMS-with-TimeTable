import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Checkbox,
  Divider,
  Flex,
  HStack,
  Heading,
  Input,
  Progress,
  Radio,
  RadioGroup,
  Stack,
  Text,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import RichText from '../components/RichText';
import { ErrorState, Loading, SectionCard, StatTile } from '../components/common';
import useProctoring from '../hooks/useProctoring';
import QuizReview from '../components/QuizReview';
import QuizStage from '../components/QuizStage';
import QuizCalculator from '../components/QuizCalculator';
import { requestQuizFullscreen, scrollStageToTop } from '../quizStage';

const clock = (seconds) => {
  const safe = Math.max(0, Math.round(seconds || 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

/**
 * What leaving the test screen costs, in the student's own terms.
 *
 * Spelled out at the moment they leave rather than only in the brief they read
 * ten minutes ago: a student who has just pressed Escape is the one person who
 * needs the number, and "this is recorded" on its own never tells them that a
 * submit is coming. Returns null when the paper does not police leaving.
 */
function leavingCost(settings, tabSwitches = 0) {
  if (!settings || settings.allowTabChange) return null;
  const budget = settings.maxTabSwitches || 0;
  const left = Math.max(0, budget - tabSwitches);
  return settings.autoSubmitOnTabLimit
    ? `Leaving fullscreen, or switching to another window or tab, is recorded. You may do so ${budget} time(s) in all — ${left} left — and after that your test is submitted automatically.`
    : `Leaving fullscreen, or switching to another window or tab, is recorded and shown to your teacher. You have done so ${tabSwitches} time(s).`;
}

/** Answer widget shared by both delivery modes. */
function AnswerInput({ question, value, onChange, isDisabled }) {
  if (question.type === 'numerical') {
    return (
      <Input
        type="text"
        inputMode="decimal"
        maxW="260px"
        placeholder="Enter a number"
        value={value.text || ''}
        isDisabled={isDisabled}
        onChange={(event) => onChange({ selected: [], text: event.target.value })}
      />
    );
  }
  if (question.type === 'msq') {
    return (
      <Stack>
        {question.options.map((option, index) => (
          <Checkbox
            key={index}
            alignItems="flex-start"
            isChecked={(value.selected || []).includes(String(index))}
            isDisabled={isDisabled}
            onChange={(event) => {
              const current = value.selected || [];
              const key = String(index);
              onChange({
                text: '',
                selected: event.target.checked ? [...current, key] : current.filter((c) => c !== key),
              });
            }}
          >
            <RichText>{option}</RichText>
          </Checkbox>
        ))}
      </Stack>
    );
  }
  return (
    <RadioGroup
      value={(value.selected || [])[0] ?? ''}
      isDisabled={isDisabled}
      onChange={(picked) => onChange({ selected: [picked], text: '' })}
    >
      <Stack>
        {question.options.map((option, index) => (
          <Radio key={index} value={String(index)} alignItems="flex-start">
            <RichText>{option}</RichText>
          </Radio>
        ))}
      </Stack>
    </RadioGroup>
  );
}

/**
 * A live quiz sitting.
 *
 * Two modes share this screen because they share all the surrounding machinery
 * (timers, proctoring, submission):
 *
 *   all_at_once   — every question on one page, free navigation, one clock
 *   one_at_a_time — the server hands out one question at a time and keeps the
 *                   cursor, so a refresh resumes rather than restarts
 */
export default function QuizAttempt() {
  const { classId, klass } = useOutletContext();
  const { quizId, attemptId } = useParams();
  const navigate = useNavigate();

  const [settings, setSettings] = useState(null);
  // Title, subject and faculty for the banner, taken from the quiz itself:
  // the sitting is the one screen that has to identify itself without leaning
  // on the class page around it.
  const [banner, setBanner] = useState({ title: '', subject: '', facultyName: '' });
  const [attempt, setAttempt] = useState(null);
  const [paper, setPaper] = useState(null);        // all_at_once
  const [current, setCurrent] = useState(null);    // one_at_a_time
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState('');
  const [remaining, setRemaining] = useState(null);
  const [notice, setNotice] = useState(null);
  // Set when Submit is pressed with questions still blank: the confirmation is
  // rendered inline rather than as a modal, because a Chakra modal portals to
  // document.body and would be invisible behind a fullscreened paper.
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const finishedRef = useRef(false);
  const noticeTimer = useRef(null);
  // Question card nodes, so the navigator can jump straight to one.
  const questionRefs = useRef({});

  const sequential = settings?.deliveryMode === 'one_at_a_time';

  /**
   * Chakra toasts render into a portal on `document.body`, which sits outside
   * the quiz stage and so is invisible the moment the stage is fullscreened.
   * Every message therefore goes inline above the paper instead — one path, so
   * nothing can go missing depending on whether fullscreen was granted.
   */
  const notify = useCallback((options) => {
    setNotice(options);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);

  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  /* ------------------------------ loading ------------------------------ */

  const loadSequential = useCallback(async () => {
    const data = await lmApi.getCurrentQuestion(classId, attemptId);
    if (data.done) {
      setCurrent(null);
      return true;
    }
    setCurrent(data);
    setAnswers(
      data.saved ? { [data.question._id]: { selected: data.saved.selected || [], text: data.saved.text || '' } } : {},
    );
    return false;
  }, [classId, attemptId]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const quiz = await lmApi.getQuiz(classId, quizId);
      setSettings(quiz.settings);
      setBanner({ title: quiz.title, subject: quiz.subject, facultyName: quiz.facultyName });

      if (quiz.settings.deliveryMode === 'one_at_a_time') {
        const done = await loadSequential();
        if (done) {
          const finished = await lmApi.getAttempt(classId, attemptId);
          setAttempt(finished.attempt);
          setResult(finished);
          finishedRef.current = true;
        }
      } else {
        const data = await lmApi.getAttemptPaper(classId, attemptId);
        setPaper(data);
        setAttempt(data.attempt);
        const restored = {};
        data.questions.forEach((question) => {
          if (question.saved) {
            restored[question._id] = {
              selected: question.saved.selected || [],
              text: question.saved.text || '',
            };
          }
        });
        setAnswers(restored);
        if (data.attempt.status !== 'in_progress') {
          const finished = await lmApi.getAttempt(classId, attemptId);
          setResult(finished);
          finishedRef.current = true;
        }
      }
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId, quizId, attemptId, loadSequential]);

  useEffect(() => {
    load();
  }, [load]);

  /* ---------------------------- submitting ----------------------------- */

  const payload = useCallback(
    () =>
      Object.entries(answers).map(([questionId, value]) => ({
        questionId,
        selected: value.selected || [],
        text: value.text || '',
      })),
    [answers],
  );

  const finish = useCallback(
    async (expired = false) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      setBusy('submit');
      try {
        const submitted = await lmApi.submitAttempt(classId, attemptId, payload(), expired);
        setAttempt(submitted.attempt);
        setResult(submitted);
        if (expired) notify({ status: 'warning', title: 'Time is up — your answers were submitted.' });
      } catch (err) {
        finishedRef.current = false;
        notify({ status: 'error', title: err.message });
      } finally {
        setBusy('');
      }
    },
    [classId, attemptId, payload, notify],
  );

  /* ---------------------------- proctoring ----------------------------- */

  /**
   * Whether a paper is live on screen.
   *
   * Not `attempt.status` alone: one-at-a-time delivery never hands back an
   * attempt document while it runs — the question endpoint is the whole
   * response — so an attempt-only test left the sequential mode, the one the
   * "Exam" preset uses and the one that turns every proctoring option on,
   * entirely unproctored: right-click worked, and leaving fullscreen was
   * neither reported nor noticed.
   */
  const sitting =
    !finishedRef.current &&
    !result &&
    (sequential ? Boolean(current) : attempt?.status === 'in_progress');

  const proctoring = useProctoring({
    settings: settings || {},
    active: sitting,
    onViolation: (type) => lmApi.recordViolation(classId, attemptId, type),
    onTerminated: async () => {
      finishedRef.current = true;
      const finished = await lmApi.getAttempt(classId, attemptId).catch(() => null);
      if (finished) {
        setAttempt(finished.attempt);
        setResult(finished);
      }
    },
  });

  /* ------------------------------ timers ------------------------------- */

  const deadline = sequential ? current?.deadline : paper?.deadline;

  const advance = useCallback(
    async (direction = 'forward', autoSubmitted = false) => {
      if (!current) return;
      const value = answers[current.question._id] || {};
      setBusy('advance');
      try {
        const next = await lmApi.answerAndAdvance(classId, attemptId, {
          selected: value.selected || [],
          text: value.text || '',
          direction,
          autoSubmitted,
        });
        if (next.done) {
          finishedRef.current = true;
          setCurrent(null);
          const finished = await lmApi.getAttempt(classId, attemptId);
          setAttempt(finished.attempt);
          setResult(finished);
          return;
        }
        setCurrent(next);
        setAnswers(
          next.saved
            ? { [next.question._id]: { selected: next.saved.selected || [], text: next.saved.text || '' } }
            : {},
        );
        scrollStageToTop();
      } catch (err) {
        notify({ status: 'error', title: err.message });
      } finally {
        setBusy('');
      }
    },
    [current, answers, classId, attemptId, notify],
  );

  useEffect(() => {
    if (!deadline || finishedRef.current) {
      setRemaining(null);
      return undefined;
    }
    const tick = () => {
      const left = Math.round((new Date(deadline) - Date.now()) / 1000);
      setRemaining(left);
      if (left <= 0) {
        // A per-question clock only ends that question; the paper clock ends
        // the whole sitting.
        if (sequential && settings?.perQuestionTiming) advance('forward', true);
        else finish(true);
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
    // `advance` and `finish` are stable enough here; re-running on every
    // keystroke would restart the countdown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deadline, sequential, settings?.perQuestionTiming]);

  /* ------------------------------ render ------------------------------- */

  // Which questions count as attempted — the navigator, the progress bar and
  // the submit guard all read the same set, so they can never disagree.
  const answeredIds = useMemo(
    () =>
      new Set(
        Object.entries(answers)
          .filter(([, value]) => (value.selected || []).length || String(value.text || '').trim())
          .map(([questionId]) => questionId),
      ),
    [answers],
  );
  const answeredCount = answeredIds.size;

  const total = sequential ? current?.totalQuestions || 0 : paper?.questions?.length || 0;
  const position = sequential ? (current?.cursor ?? 0) + 1 : answeredCount;
  const unansweredCount = sequential ? 0 : Math.max(0, total - answeredCount);
  const percentComplete = total ? Math.round((answeredCount / total) * 100) : 0;

  const goToQuestion = useCallback((questionId) => {
    questionRefs.current[questionId]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const attemptSubmit = useCallback(() => {
    if (unansweredCount > 0 && !confirmSubmit) {
      setConfirmSubmit(true);
      return;
    }
    finish(false);
  }, [unansweredCount, confirmSubmit, finish]);

  const inFullscreen = proctoring.isFullscreen;
  const finished = Boolean(result) && Boolean(attempt) && attempt.status !== 'in_progress';
  const leftFullscreenCost = leavingCost(settings, proctoring.tabSwitches);

  // The screen is handed back by leaving, not by submitting: the stage drops
  // fullscreen when it unmounts, so the result is read on the same canvas the
  // paper was written on and nothing jumps at the moment of submitting.

  const pending = attempt?.resultsPending;

  let content;
  if (loading) content = <Loading label="Loading your paper…" />;
  else if (error) content = <ErrorState error={error} onRetry={load} />;
  else if (finished) {
    /* ---- finished: show the result ---- */
    content = (
      <Box>
        <SectionCard title="Test submitted">
          {attempt.status === 'terminated' && (
            <Alert status="error" borderRadius="md" mb={4}>
              <AlertIcon />
              <Box>
                <Text fontWeight="600">This attempt was ended automatically</Text>
                <Text fontSize="sm">{attempt.terminationReason}</Text>
              </Box>
            </Alert>
          )}

          {pending ? (
            <Alert status="info" borderRadius="md">
              <AlertIcon />
              Your answers are saved. Results will be released by your teacher.
            </Alert>
          ) : (
            <>
              <Flex gap={3} wrap="wrap" mb={4}>
                <StatTile label="Score" value={`${attempt.score}/${attempt.maxScore}`} />
                <StatTile
                  label="Percent"
                  value={`${attempt.percent}%`}
                  accent={attempt.passed ? 'green.500' : 'red.500'}
                />
                <StatTile label="Correct" value={attempt.totalCorrect} accent="green.500" />
                <StatTile label="Wrong" value={attempt.totalWrong} accent="red.500" />
                <StatTile label="Unattempted" value={attempt.totalUnattempted} accent="gray.500" />
                {attempt.negativeApplied > 0 && (
                  <StatTile label="Negative" value={`−${attempt.negativeApplied}`} accent="red.500" />
                )}
              </Flex>
              <Progress
                value={attempt.percent}
                colorScheme={attempt.passed ? 'green' : 'red'}
                borderRadius="full"
                mb={4}
              />

              {attempt.sectionScores?.length > 1 && (
                <Box mb={4}>
                  <Heading size="xs" mb={2}>
                    By section
                  </Heading>
                  {attempt.sectionScores.map((section) => (
                    <Flex key={section.sectionName} justify="space-between" fontSize="sm" py={1}>
                      <Text>{section.sectionName}</Text>
                      <HStack spacing={3}>
                        <Text color="green.600">{section.correct} ✓</Text>
                        <Text color="red.600">{section.wrong} ✗</Text>
                        <Text color="gray.500">{section.unattempted} —</Text>
                        <Text fontWeight="600">
                          {section.score}/{section.maxScore}
                        </Text>
                      </HStack>
                    </Flex>
                  ))}
                </Box>
              )}
            </>
          )}

          <Button mt={2} onClick={() => navigate(`/learning/class/${classId}/quizzes`)}>
            Back to quizzes
          </Button>
        </SectionCard>

        {result.review && (
          <Box mt={4}>
            <QuizReview review={result.review} />
          </Box>
        )}
      </Box>
    );
  } else if (settings?.requireFullscreen && !inFullscreen) {
    /* ---- fullscreen gate ----
       Normally never seen: the stage takes fullscreen on the brief and holds it
       through to here. It is what is left when the browser refused — a cold tab
       with no user gesture behind it, or a student who pressed Escape. */
    content = (
      <SectionCard title="Fullscreen required">
        {leftFullscreenCost && (
          <Alert status="error" borderRadius="md" mb={4}>
            <AlertIcon />
            <Box>
              <Text fontWeight="600">You have left fullscreen</Text>
              <Text fontSize="sm">{leftFullscreenCost}</Text>
            </Box>
          </Alert>
        )}
        <Text fontSize="sm" color="gray.600" mb={4}>
          This test must be taken in fullscreen. Your clock is still running — go back in to carry on.
        </Text>
        <Button colorScheme="purple" onClick={requestQuizFullscreen}>
          Enter fullscreen and continue
        </Button>
      </SectionCard>
    );
  } else {
    content = (
      <Box userSelect={settings?.disableCopyPaste ? 'none' : undefined}>
        {/* ---- sticky status bar ----
            The progress bar lives inside it rather than below it: on a long
            single-page paper the one thing a student wants while scrolling is
            how much is left, and anything above the fold scrolls away. */}
        <Box
          position="sticky"
          top={0}
          zIndex={5}
          bg="white"
          borderWidth="1px"
          borderColor="gray.200"
          borderRadius="lg"
          mb={4}
          overflow="hidden"
          boxShadow="sm"
        >
          <Flex px={4} py={3} justify="space-between" align="center" gap={3} wrap="wrap">
            <Box>
              <HStack spacing={2}>
                <Text fontSize="sm" fontWeight="600">
                  {sequential ? `Question ${position} of ${total}` : `${answeredCount} of ${total} answered`}
                </Text>
                {!sequential && total > 0 && (
                  <Badge colorScheme={percentComplete === 100 ? 'green' : 'purple'} borderRadius="full">
                    {percentComplete}%
                  </Badge>
                )}
              </HStack>
              {!sequential && unansweredCount > 0 && (
                <Text fontSize="xs" color="gray.500">
                  {unansweredCount} still blank
                </Text>
              )}
              {current?.section && (
                <Badge colorScheme="purple" fontSize="0.65rem">
                  {current.section}
                </Badge>
              )}
            </Box>
            <HStack>
              {proctoring.remaining !== null && proctoring.remaining !== undefined && (
                <Badge colorScheme={proctoring.remaining > 0 ? 'orange' : 'red'}>
                  {proctoring.remaining} exit(s) left
                </Badge>
              )}
              {remaining !== null && (
                <Badge
                  colorScheme={remaining < 30 ? 'red' : remaining < 120 ? 'orange' : 'green'}
                  fontSize="md"
                  px={3}
                  py={1}
                  borderRadius="md"
                >
                  ⏱ {clock(remaining)}
                </Badge>
              )}
              {!sequential && (
                <Button
                  size="sm"
                  variant="outline"
                  isLoading={busy === 'save'}
                  onClick={async () => {
                    setBusy('save');
                    try {
                      await lmApi.saveAttemptDraft(classId, attemptId, payload());
                      notify({ status: 'success', title: 'Progress saved', duration: 1500 });
                    } catch (err) {
                      notify({ status: 'error', title: err.message });
                    } finally {
                      setBusy('');
                    }
                  }}
                >
                  Save
                </Button>
              )}
              {!sequential && (
                <Button size="sm" colorScheme="purple" onClick={attemptSubmit} isLoading={busy === 'submit'}>
                  Submit test
                </Button>
              )}
            </HStack>
          </Flex>
          {total > 0 && (
            <Progress
              value={sequential ? (position / total) * 100 : percentComplete}
              size="sm"
              colorScheme={!sequential && percentComplete === 100 ? 'green' : 'purple'}
              hasStripe={!sequential && percentComplete < 100}
              aria-label="Quiz progress"
            />
          )}
          {/* Submitting is irreversible, so a blank question is named before it
              is accepted. It lives in the sticky bar rather than beside either
              Submit button so it is visible wherever the student pressed one —
              and inline rather than in a modal, which would portal to
              document.body and disappear behind a fullscreened paper. */}
          {confirmSubmit && unansweredCount > 0 && (
            <Flex
              bg="orange.50"
              borderTopWidth="1px"
              borderColor="orange.200"
              px={4}
              py={2}
              gap={2}
              align="center"
              wrap="wrap"
            >
              <Text fontSize="sm" flex="1" minW="200px">
                {unansweredCount} question{unansweredCount === 1 ? ' is' : 's are'} still blank.
              </Text>
              <Button size="xs" variant="ghost" onClick={() => setConfirmSubmit(false)}>
                Keep working
              </Button>
              <Button size="xs" colorScheme="purple" onClick={() => finish(false)} isLoading={busy === 'submit'}>
                Submit anyway
              </Button>
            </Flex>
          )}
        </Box>

        {/* The paper does not demand fullscreen — the gate above never fires —
            but pressing Escape still drops the student out of the screen they
            were told to sit the test on, so it is said out loud rather than
            passing silently, with what it costs when it costs something. Not
            dismissible: it is true for exactly as long as they are out. */}
        {!inFullscreen && (
          <Alert status="warning" borderRadius="md" mb={4}>
            <AlertIcon />
            <Box flex="1">
              <Text fontWeight="600">You are no longer in fullscreen</Text>
              <Text fontSize="sm">
                {leftFullscreenCost ||
                  'Your clock is still running. Go back to fullscreen to carry on with the test on a clean screen.'}
              </Text>
            </Box>
            <Button size="xs" colorScheme="orange" onClick={requestQuizFullscreen}>
              Back to fullscreen
            </Button>
          </Alert>
        )}

        {notice && (
          <Alert status={notice.status || 'info'} borderRadius="md" mb={4}>
            <AlertIcon />
            <Box flex="1">{notice.title}</Box>
            <Button size="xs" variant="ghost" onClick={() => setNotice(null)}>
              Dismiss
            </Button>
          </Alert>
        )}

        {proctoring.warning && (
          <Alert status="warning" borderRadius="md" mb={4}>
            <AlertIcon />
            <Box flex="1">{proctoring.warning}</Box>
            <Button size="xs" variant="ghost" onClick={proctoring.dismissWarning}>
              Dismiss
            </Button>
          </Alert>
        )}

        {/* ---- question navigator ----
            Free navigation is the point of this mode, but on a twenty-question
            paper scrolling is a poor way to exercise it. The grid doubles as
            the "what have I missed" view the progress bar can only summarise. */}
        {!sequential && total > 1 && (
          <SectionCard mb={4} p={4}>
            <Flex justify="space-between" align="center" gap={3} wrap="wrap" mb={3}>
              <Text fontSize="xs" fontWeight="700" color="gray.600" textTransform="uppercase" letterSpacing="wide">
                Jump to question
              </Text>
              <HStack spacing={3} fontSize="0.65rem" color="gray.500">
                <HStack spacing={1.5}>
                  <Box w="10px" h="10px" borderRadius="sm" bg="purple.500" />
                  <Text>Answered</Text>
                </HStack>
                <HStack spacing={1.5}>
                  <Box w="10px" h="10px" borderRadius="sm" borderWidth="1px" borderColor="gray.300" />
                  <Text>Blank</Text>
                </HStack>
              </HStack>
            </Flex>
            <Flex wrap="wrap" gap={2}>
              {paper.questions.map((question, index) => {
                const done = answeredIds.has(question._id);
                return (
                  <Button
                    key={question._id}
                    size="sm"
                    minW="38px"
                    px={0}
                    fontSize="xs"
                    variant={done ? 'solid' : 'outline'}
                    colorScheme={done ? 'purple' : 'gray'}
                    color={done ? undefined : 'gray.600'}
                    onClick={() => goToQuestion(question._id)}
                    aria-label={`Question ${index + 1}, ${done ? 'answered' : 'not answered'}`}
                  >
                    {index + 1}
                  </Button>
                );
              })}
            </Flex>
          </SectionCard>
        )}

        {/* ---- sequential: one question ---- */}
        {sequential && current && (
          <SectionCard>
            <Flex justify="space-between" gap={3} mb={3}>
              <Box flex="1" minW={0}>
                <Text fontWeight="600" fontSize="sm" mb={1}>
                  Question {position}
                </Text>
                <RichText>{current.question.question}</RichText>
              </Box>
              <Badge colorScheme="gray" flexShrink={0}>
                {current.question.marks} mark{current.question.marks === 1 ? '' : 's'}
              </Badge>
            </Flex>

            <AnswerInput
              question={current.question}
              value={answers[current.question._id] || {}}
              onChange={(value) => setAnswers({ [current.question._id]: value })}
            />

            <Divider my={4} />
            <Flex gap={2} wrap="wrap">
              {current.canGoBack && (
                <Button size="sm" variant="outline" onClick={() => advance('back')} isLoading={busy === 'advance'}>
                  ← Previous
                </Button>
              )}
              <Box flex="1" />
              <Button size="sm" colorScheme="purple" onClick={() => advance('forward')} isLoading={busy === 'advance'}>
                {position >= total ? 'Finish test' : 'Save & next →'}
              </Button>
            </Flex>
            {!settings?.allowBacktracking && (
              <Text fontSize="xs" color="gray.500" mt={2}>
                You cannot return to this question once you move on.
              </Text>
            )}
          </SectionCard>
        )}

        {/* ---- all at once: full paper ---- */}
        {!sequential &&
          paper?.questions.map((question, index) => {
            const done = answeredIds.has(question._id);
            return (
              // SectionCard is a plain function component, so the scroll target
              // is this wrapper. The margin keeps the sticky bar from landing on
              // top of the question the navigator just jumped to.
              <Box
                key={question._id}
                ref={(node) => {
                  questionRefs.current[question._id] = node;
                }}
                scrollMarginTop="96px"
              >
                <SectionCard
                  mb={3}
                  borderLeftWidth="3px"
                  borderLeftColor={done ? 'purple.400' : 'transparent'}
                  transition="border-color 0.2s"
                >
                  <Flex justify="space-between" gap={3} mb={3}>
                    <Box flex="1" minW={0}>
                      <HStack mb={2} spacing={2}>
                        <Flex
                          align="center"
                          justify="center"
                          w="24px"
                          h="24px"
                          borderRadius="md"
                          flexShrink={0}
                          fontSize="xs"
                          fontWeight="700"
                          bg={done ? 'purple.500' : 'gray.100'}
                          color={done ? 'white' : 'gray.600'}
                        >
                          {index + 1}
                        </Flex>
                        {question.sectionName && (
                          <Badge colorScheme="purple" fontSize="0.6rem">
                            {question.sectionName}
                          </Badge>
                        )}
                        {!done && (
                          <Badge colorScheme="gray" fontSize="0.6rem" variant="outline">
                            Not answered
                          </Badge>
                        )}
                      </HStack>
                      <RichText>{question.question}</RichText>
                    </Box>
                    <Badge colorScheme="gray" flexShrink={0} h="fit-content">
                      {question.marks} mark{question.marks === 1 ? '' : 's'}
                    </Badge>
                  </Flex>
                  <AnswerInput
                    question={question}
                    value={answers[question._id] || {}}
                    onChange={(value) => setAnswers((prev) => ({ ...prev, [question._id]: value }))}
                  />
                </SectionCard>
              </Box>
            );
          })}

        {!sequential && (
          <Button
            colorScheme="purple"
            size="lg"
            w="100%"
            mt={2}
            onClick={attemptSubmit}
            isLoading={busy === 'submit'}
          >
            Submit test ({answeredCount}/{total} answered)
          </Button>
        )}

        {/* Floats over the paper on its own fixed layer, so it is reachable
            from any question in either delivery mode without moving anything
            the student is reading. */}
        {settings?.allowCalculator !== false && <QuizCalculator />}
      </Box>
    );
  }

  /**
   * The stage owns the screen — it is already fullscreen when the brief handed
   * over, and it covers the app either way, so the module header, class header
   * and tabs never appear beside a live paper.
   */
  return (
    <QuizStage
      subject={[banner.subject, klass?.subject, klass?.name].find(Boolean)}
      faculty={[banner.facultyName, klass?.ownerName].find(Boolean)}
      title={banner.title}
    >
      {content}
    </QuizStage>
  );
}
