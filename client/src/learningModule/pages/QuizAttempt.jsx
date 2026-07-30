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
  useToast,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import RichText from '../components/RichText';
import { ErrorState, Loading, SectionCard, StatTile } from '../components/common';
import useProctoring from '../hooks/useProctoring';
import QuizReview from '../components/QuizReview';

const clock = (seconds) => {
  const safe = Math.max(0, Math.round(seconds || 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

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
  if (question.type === 'short') {
    return (
      <Input
        placeholder="Your answer"
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
  const { classId } = useOutletContext();
  const { quizId, attemptId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [settings, setSettings] = useState(null);
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
  const finishedRef = useRef(false);
  const shellRef = useRef(null);
  const noticeTimer = useRef(null);

  const sequential = settings?.deliveryMode === 'one_at_a_time';

  /**
   * Chakra toasts render into a portal on `document.body`, which sits outside
   * the fullscreened quiz element and so would be invisible mid-test. While
   * fullscreen, the same message goes inline above the paper instead.
   */
  const notify = useCallback(
    (options) => {
      if (!document.fullscreenElement) {
        toast(options);
        return;
      }
      setNotice(options);
      clearTimeout(noticeTimer.current);
      noticeTimer.current = setTimeout(() => setNotice(null), 4000);
    },
    [toast],
  );

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

  const proctoring = useProctoring({
    settings: settings || {},
    active: Boolean(attempt) && attempt.status === 'in_progress' && !finishedRef.current,
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
        shellRef.current?.scrollTo(0, 0);
        window.scrollTo(0, 0);
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

  const answeredCount = useMemo(
    () =>
      Object.values(answers).filter(
        (value) => (value.selected || []).length || String(value.text || '').trim(),
      ).length,
    [answers],
  );

  const inFullscreen = proctoring.isFullscreen;
  const finished = Boolean(result) && Boolean(attempt) && attempt.status !== 'in_progress';

  // Hand the screen back once the sitting is over: the result belongs in the
  // app, with its header and tabs, not on a bare fullscreen canvas.
  const { exitFullscreen } = proctoring;
  useEffect(() => {
    if (finished) exitFullscreen();
  }, [finished, exitFullscreen]);

  const pending = attempt?.resultsPending;
  const total = sequential ? current?.totalQuestions || 0 : paper?.questions?.length || 0;
  const position = sequential ? (current?.cursor ?? 0) + 1 : answeredCount;

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
    /* ---- fullscreen gate ---- */
    content = (
      <SectionCard title="Fullscreen required">
        <Text fontSize="sm" color="gray.600" mb={4}>
          This test must be taken in fullscreen. Leaving fullscreen during the test is recorded.
        </Text>
        <Button colorScheme="purple" onClick={() => proctoring.enterFullscreen(shellRef.current)}>
          Enter fullscreen and continue
        </Button>
      </SectionCard>
    );
  } else {
    content = (
      <Box userSelect={settings?.disableCopyPaste ? 'none' : undefined}>
        {/* ---- sticky status bar ---- */}
        <Flex
          position="sticky"
          top={inFullscreen ? 0 : '72px'}
          zIndex={5}
          bg="white"
          borderWidth="1px"
          borderColor="gray.200"
          borderRadius="lg"
          px={4}
          py={3}
          mb={4}
          justify="space-between"
          align="center"
          gap={3}
          wrap="wrap"
        >
          <Box>
            <Text fontSize="sm" fontWeight="600">
              {sequential ? `Question ${position} of ${total}` : `${answeredCount} of ${total} answered`}
            </Text>
            {current?.section && (
              <Badge colorScheme="purple" fontSize="0.65rem">
                {current.section}
              </Badge>
            )}
          </Box>
          <HStack>
            {proctoring.remaining !== null && proctoring.remaining !== undefined && (
              <Badge colorScheme={proctoring.remaining > 0 ? 'orange' : 'red'}>
                {proctoring.remaining} tab switch(es) left
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
              <Button size="sm" colorScheme="purple" onClick={() => finish(false)} isLoading={busy === 'submit'}>
                Submit test
              </Button>
            )}
          </HStack>
        </Flex>

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

        {total > 0 && (
          <Progress
            value={sequential ? (position / total) * 100 : (answeredCount / total) * 100}
            size="xs"
            colorScheme="purple"
            borderRadius="full"
            mb={4}
          />
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
          paper?.questions.map((question, index) => (
            <SectionCard key={question._id} mb={3}>
              <Flex justify="space-between" gap={3} mb={3}>
                <Box flex="1" minW={0}>
                  <HStack mb={1}>
                    <Text fontWeight="600" fontSize="sm">
                      Q{index + 1}.
                    </Text>
                    {question.sectionName && (
                      <Badge colorScheme="purple" fontSize="0.6rem">
                        {question.sectionName}
                      </Badge>
                    )}
                  </HStack>
                  <RichText>{question.question}</RichText>
                </Box>
                <Badge colorScheme="gray" flexShrink={0}>
                  {question.marks} mark{question.marks === 1 ? '' : 's'}
                </Badge>
              </Flex>
              <AnswerInput
                question={question}
                value={answers[question._id] || {}}
                onChange={(value) => setAnswers((prev) => ({ ...prev, [question._id]: value }))}
              />
            </SectionCard>
          ))}

        {!sequential && (
          <Button
            colorScheme="purple"
            size="lg"
            w="100%"
            mt={2}
            onClick={() => finish(false)}
            isLoading={busy === 'submit'}
          >
            Submit test ({answeredCount}/{total} answered)
          </Button>
        )}
      </Box>
    );
  }

  /**
   * `shellRef` is what actually goes fullscreen, so a test fills the screen on
   * its own — the module header, class header and tabs stay behind. Outside
   * fullscreen this is an ordinary wrapper and the page looks unchanged.
   */
  return (
    <Box
      ref={shellRef}
      {...(inFullscreen && {
        bg: 'gray.50',
        w: '100vw',
        h: '100vh',
        overflowY: 'auto',
        px: { base: 3, md: 6 },
        py: 4,
      })}
    >
      <Box maxW={inFullscreen ? '960px' : undefined} mx={inFullscreen ? 'auto' : undefined}>
        {content}
      </Box>
    </Box>
  );
}
