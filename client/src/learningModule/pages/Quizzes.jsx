import React, { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useNavigate, useOutletContext } from 'react-router-dom';
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Flex,
  FormControl,
  FormHelperText,
  FormLabel,
  HStack,
  Heading,
  Input,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Radio,
  RadioGroup,
  Stack,
  Text,
  Textarea,
  Tooltip,
  useDisclosure,
  useToast,
} from '@chakra-ui/react';
// From emotion, not from '@chakra-ui/react' — Chakra v2 does not re-export
// `keyframes` from its root, and importing a name a module does not export
// fails the whole module, which is a blank page rather than a missing
// animation. Emotion is a declared dependency and Chakra's own styling engine.
import { keyframes } from '@emotion/react';
import lmApi from '../api/lmApi';
import { CopyLinkButton, EmptyState, ErrorState, Loading, SectionCard } from '../components/common';
import PublishQuizModal from '../components/PublishQuizModal';
import { formatDateTime, relativeTime } from '../format';

// Slow enough to read as "running" rather than "alarm" — this sits in a list a
// teacher scans, not on a monitoring dashboard.
const livePulse = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
`;

// Two starting points over the same model. "Quiz" is the low-stakes default —
// one page, free navigation, answers shown straight after. "Exam" switches on
// the placement-test behaviour the exam engine already supports; everything
// stays editable afterwards in the quiz editor.
const PRESETS = {
  quiz: {
    label: 'Quiz',
    icon: '📝',
    hint: 'All questions on one page, free navigation, answers shown on submit.',
    settings: {
      deliveryMode: 'all_at_once',
      allowBacktracking: true,
      perQuestionTiming: false,
      showAnswersAfterSubmit: true,
      showScoreImmediately: true,
      allowReviewBeforeSubmit: true,
    },
  },
  exam: {
    label: 'Exam',
    icon: '🎓',
    hint: 'One question at a time, no going back, results held until you release them.',
    settings: {
      deliveryMode: 'one_at_a_time',
      allowBacktracking: false,
      perQuestionTiming: false,
      showAnswersAfterSubmit: false,
      showScoreImmediately: false,
      allowReviewBeforeSubmit: false,
      shuffleQuestions: true,
      shuffleOptions: true,
      allowTabChange: false,
      autoSubmitOnTabLimit: true,
      requireFullscreen: true,
      disableCopyPaste: true,
      disableRightClick: true,
    },
  },
};

// The two clocks are exclusive, and the choice is made here rather than in the
// editor: a teacher who has already typed times onto twenty questions should
// never discover afterwards that only the paper clock was ever running.
const TIMING = {
  overall: {
    label: 'One timer for the whole paper',
    hint: 'Students see a single countdown and the test submits when it reaches zero.',
    field: 'Time limit (minutes)',
    placeholder: 'Leave blank for no limit',
  },
  per_question: {
    label: 'A timer on each question',
    hint: 'Each question gets its own countdown and moves on by itself. Questions are delivered one at a time, with no going back.',
    field: 'Seconds per question',
    placeholder: '60',
  },
};

function CreateQuizModal({ isOpen, onClose, classId }) {
  const [mode, setMode] = useState('quiz');
  const [timing, setTiming] = useState('overall');
  const [allowBack, setAllowBack] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [timeLimit, setTimeLimit] = useState('');
  const [saving, setSaving] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();

  // Going back is only a decision to make when questions are handed out one at
  // a time *and* one clock covers the paper. On a single-page quiz students can
  // already move freely, and under per-question timers a revisit would restart
  // that question's countdown — so there is nothing coherent to offer.
  const canChooseBacktracking = mode === 'exam' && timing === 'overall';

  const reset = () => {
    setMode('quiz');
    setTiming('overall');
    setAllowBack(false);
    setTitle('');
    setDescription('');
    setTimeLimit('');
  };

  const close = () => {
    reset();
    onClose();
  };

  const submit = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      const entered = Number(timeLimit);
      const value = Number.isFinite(entered) && entered > 0 ? entered : 0;
      // Per-question timers are only enforceable one question at a time, so
      // choosing them settles the delivery mode too — the server holds the same
      // rule, and a quiz that claimed both would run on the paper clock alone.
      const timingSettings =
        timing === 'per_question'
          ? {
              perQuestionTiming: true,
              deliveryMode: 'one_at_a_time',
              allowBacktracking: false,
              timeLimitMinutes: 0,
              defaultQuestionSec: value || 60,
            }
          : {
              perQuestionTiming: false,
              timeLimitMinutes: value,
              defaultQuestionSec: 0,
              ...(canChooseBacktracking ? { allowBacktracking: allowBack } : {}),
            };
      const created = await lmApi.createQuiz(classId, {
        title: title.trim(),
        description: description.trim(),
        settings: { ...PRESETS[mode].settings, ...timingSettings },
      });
      reset();
      onClose();
      // Straight into the editor — a quiz with no questions cannot be published
      // anyway, so there is nothing useful to come back to the list for.
      navigate(`/learning/class/${classId}/quiz/${created._id}/edit`);
    } catch (error) {
      toast({ status: 'error', title: 'Could not create quiz', description: error.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={close} size="lg">
      <ModalOverlay />
      <ModalContent>
        <ModalHeader>Create a quiz</ModalHeader>
        <ModalCloseButton />
        <ModalBody>
          <FormControl isRequired mb={4}>
            <FormLabel fontSize="sm">Title</FormLabel>
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Unit 2 — Fourier transforms"
              autoFocus
              onKeyDown={(event) => event.key === 'Enter' && title.trim() && submit()}
            />
          </FormControl>

          <FormControl mb={4}>
            <FormLabel fontSize="sm">Description</FormLabel>
            <Textarea
              rows={2}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Shown to students before they start."
            />
          </FormControl>

          <FormControl mb={4}>
            <FormLabel fontSize="sm">Mode</FormLabel>
            <RadioGroup value={mode} onChange={setMode}>
              <Stack spacing={3}>
                {Object.entries(PRESETS).map(([key, preset]) => (
                  <Box
                    key={key}
                    borderWidth="1px"
                    borderColor={mode === key ? 'blue.400' : 'gray.200'}
                    bg={mode === key ? 'blue.50' : 'white'}
                    borderRadius="md"
                    px={3}
                    py={2}
                  >
                    <Radio value={key}>
                      <Text fontSize="sm" fontWeight="600">
                        {preset.icon} {preset.label}
                      </Text>
                      <Text fontSize="xs" color="gray.600">
                        {preset.hint}
                      </Text>
                    </Radio>
                  </Box>
                ))}
              </Stack>
            </RadioGroup>
            <FormHelperText>Every one of these settings stays editable afterwards.</FormHelperText>
          </FormControl>

          <FormControl mb={4}>
            <FormLabel fontSize="sm">Timing</FormLabel>
            <RadioGroup
              value={timing}
              // The number below changes unit with the mode, so a value typed
              // for the other one must not carry over.
              onChange={(value) => {
                setTiming(value);
                setTimeLimit('');
              }}
            >
              <Stack spacing={3}>
                {Object.entries(TIMING).map(([key, option]) => (
                  <Box
                    key={key}
                    borderWidth="1px"
                    borderColor={timing === key ? 'blue.400' : 'gray.200'}
                    bg={timing === key ? 'blue.50' : 'white'}
                    borderRadius="md"
                    px={3}
                    py={2}
                  >
                    <Radio value={key}>
                      <Text fontSize="sm" fontWeight="600">
                        {option.label}
                      </Text>
                      <Text fontSize="xs" color="gray.600">
                        {option.hint}
                      </Text>
                    </Radio>
                  </Box>
                ))}
              </Stack>
            </RadioGroup>
            <FormHelperText>
              Only one clock ever runs. Pick per-question timing and the whole-paper limit is switched
              off; pick a paper limit and the per-question boxes stay disabled.
            </FormHelperText>
          </FormControl>

          <FormControl>
            <FormLabel fontSize="sm">{TIMING[timing].field}</FormLabel>
            <Input
              type="number"
              min={0}
              value={timeLimit}
              onChange={(event) => setTimeLimit(event.target.value)}
              placeholder={TIMING[timing].placeholder}
              maxW="220px"
            />
            <FormHelperText fontSize="xs">
              {timing === 'per_question'
                ? 'Stamped on every question you add — change it per question in the editor.'
                : 'Leave blank or 0 for an untimed quiz.'}
            </FormHelperText>
          </FormControl>

          {canChooseBacktracking && (
            <Checkbox
              mt={4}
              size="sm"
              isChecked={allowBack}
              onChange={(event) => setAllowBack(event.target.checked)}
            >
              <Text fontSize="sm">Let students go back to earlier questions</Text>
              <Text fontSize="xs" color="gray.600">
                Off is placement-test behaviour: once a question is answered, it is closed.
              </Text>
            </Checkbox>
          )}
        </ModalBody>
        <ModalFooter gap={2}>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button colorScheme="blue" onClick={submit} isLoading={saving} isDisabled={!title.trim()}>
            Create & add questions
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

// Teachers get the whole quiz document back; students get a trimmed projection
// that carries questionCount instead of questions, and `window` rather than any
// single "can I start this" flag.
function startState(quiz) {
  // One sitting per student — a submitted paper cannot be taken again.
  if (quiz.attemptsUsed) return { can: false, why: 'Already attempted' };
  if (quiz.window?.notYetOpen) return { can: false, why: 'Not open yet' };
  if (quiz.window?.closed) return { can: false, why: 'Closed' };
  if (quiz.window?.lateToStart) return { can: false, why: 'Start window has passed' };
  return { can: true, why: null };
}

/**
 * Whether a card should say the test is running, and what "finished" means on it.
 *
 * Deliberately different for the two audiences, because "is this live" is a
 * different question depending on who asks:
 *
 *  - a **teacher** wants to know whether anyone is sitting it *right now* — an
 *    open window with nobody in it is not a live test, and it is the middle of a
 *    sitting they may need to intervene in. So `sittingNow` leads, and the open
 *    window is the weaker second answer.
 *  - a **student** wants to know whether it is open to them and whether their
 *    own paper is still going.
 *
 * "Completed" likewise: the cohort's last submission for staff, the student's
 * own submission for them.
 */
function liveState(quiz, isTeacher) {
  const open = quiz.window?.open && (isTeacher ? quiz.published : true);

  if (isTeacher) {
    const sitting = quiz.sittingNow || 0;
    return {
      live: sitting > 0,
      label: sitting > 0 ? `🔴 Live · ${sitting} sitting now` : null,
      open: Boolean(open && !sitting),
      completedAt: quiz.stats?.lastSubmittedAt || null,
      completedLabel: 'Last submission',
    };
  }

  return {
    live: Boolean(quiz.inProgress),
    label: quiz.inProgress ? '🔴 Your test is in progress' : null,
    open: Boolean(open && !quiz.inProgress),
    completedAt: quiz.completedAt || null,
    completedLabel: 'You completed this',
  };
}

function QuizRow({ quiz, classId, isTeacher, onPublish, onUnpublish, onDelete }) {
  const isExam = quiz.settings?.deliveryMode === 'one_at_a_time';
  const questionCount = quiz.questionCount ?? quiz.questions?.length ?? 0;
  const start = isTeacher ? { can: true, why: null } : startState(quiz);
  const scheduled = quiz.publish?.scheduled;
  const opensAt = quiz.settings?.availableFrom;
  const entryCloses = quiz.window?.startDeadline;
  const state = liveState(quiz, isTeacher);
  return (
    <Flex
      bg="white"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="lg"
      p={4}
      mb={3}
      align="center"
      gap={4}
      wrap="wrap"
    >
      <Box flex="1" minW="220px">
        <HStack>
          <Heading size="sm">{quiz.title}</Heading>
          <Badge colorScheme={isExam ? 'red' : 'blue'}>{isExam ? '🎓 Exam' : '📝 Quiz'}</Badge>
          {quiz.source === 'ai' && <Badge colorScheme="purple">✨ AI</Badge>}
          {isTeacher && (
            <Badge colorScheme={scheduled ? 'orange' : quiz.published ? 'green' : 'gray'}>
              {scheduled ? 'Scheduled' : quiz.published ? 'Published' : 'Draft'}
            </Badge>
          )}
          {/* The pulse is the point: a static red dot reads as an error badge,
              and this one has to be findable while scanning a list of twenty. */}
          {state.live && (
            <Badge
              colorScheme="red"
              variant="solid"
              borderRadius="full"
              px={2}
              sx={{ animation: `${livePulse} 1.8s ease-in-out infinite` }}
            >
              {state.label}
            </Badge>
          )}
          {state.open && (
            <Badge colorScheme="green" variant="subtle" borderRadius="full" px={2}>
              🟢 Open now
            </Badge>
          )}
        </HStack>
        {isTeacher && (scheduled || opensAt || entryCloses) && (
          <Text fontSize="xs" color="gray.600" mt={1}>
            {[
              scheduled && `🔗 Link goes live ${formatDateTime(quiz.publish.publishAt)}`,
              opensAt && `▶️ Starts ${formatDateTime(opensAt)}`,
              entryCloses && `🚪 Entry closes ${formatDateTime(entryCloses)}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        )}
        <Text fontSize="xs" color="gray.500" mt={1}>
          {questionCount} questions · {quiz.totalMarks} marks
          {quiz.settings?.timeLimitMinutes ? ` · ${quiz.settings.timeLimitMinutes} min` : ''}
        </Text>

        {/* Shown to students and staff alike. For a student it answers "did my
            submission actually register?", which is the question they otherwise
            ask a teacher; for staff it is when the cohort finished, which a
            scheduled window does not tell them. */}
        {state.completedAt && (
          <Tooltip label={formatDateTime(state.completedAt)}>
            <Text fontSize="xs" color="green.700" mt={1} fontWeight="500" display="inline-block">
              ✅ {state.completedLabel} {relativeTime(state.completedAt)} ·{' '}
              {formatDateTime(state.completedAt)}
            </Text>
          </Tooltip>
        )}
        {!state.completedAt && !state.live && quiz.window?.closed && (
          <Text fontSize="xs" color="gray.500" mt={1}>
            🔒 Closed {relativeTime(quiz.window.closesAt)} · {formatDateTime(quiz.window.closesAt)}
          </Text>
        )}
        {isTeacher && quiz.stats && (
          <Text fontSize="xs" color="gray.500">
            {quiz.stats.attempts} attempt(s)
            {quiz.stats.avg !== null && quiz.stats.avg !== undefined
              ? ` · avg ${Math.round(quiz.stats.avg * 10) / 10}%`
              : ''}
          </Text>
        )}
        {!isTeacher && quiz.bestAttempt && (
          <Badge colorScheme={quiz.bestAttempt.passed ? 'green' : 'red'} mt={1}>
            Best: {quiz.bestAttempt.score}/{quiz.bestAttempt.maxScore} ({quiz.bestAttempt.percent}%)
          </Badge>
        )}
        {!isTeacher && quiz.resultsPending && (
          <Badge colorScheme="orange" mt={1}>
            Results not released yet
          </Badge>
        )}
        {!isTeacher && start.why && (
          <Text fontSize="xs" color="gray.500" mt={1}>
            {start.why}
          </Text>
        )}
      </Box>

      <HStack>
        {isTeacher ? (
          <>
            <Button as={RouterLink} to={`/learning/class/${classId}/quiz/${quiz._id}/edit`} size="sm" variant="outline">
              Edit
            </Button>
            <Button as={RouterLink} to={`/learning/class/${classId}/quiz/${quiz._id}/results`} size="sm" variant="outline">
              Results
            </Button>
            {/* Only once published: the link resolves to the student brief, which
                a draft quiz will not serve to anyone but its author. */}
            {quiz.published && <CopyLinkButton to={`/learning/class/${classId}/quiz/${quiz._id}`} />}
            {quiz.published ? (
              <>
                <Button size="sm" variant="outline" onClick={onPublish}>
                  🗓 Schedule
                </Button>
                <Button size="sm" colorScheme="gray" onClick={onUnpublish}>
                  Unpublish
                </Button>
              </>
            ) : (
              <Button size="sm" colorScheme="green" onClick={onPublish}>
                Publish
              </Button>
            )}
            <Button size="sm" variant="ghost" colorScheme="red" onClick={onDelete} aria-label="Delete quiz">
              ✕
            </Button>
          </>
        ) : (
          <Button
            as={RouterLink}
            to={`/learning/class/${classId}/quiz/${quiz._id}`}
            size="sm"
            colorScheme="purple"
          >
            {/* The card always opens. A paper that has not opened yet still has
                instructions, timings and a countdown worth reading beforehand,
                and a finished one still has a result to read back — the brief
                page is what refuses to hand out questions, not this link. */}
            {quiz.attemptsUsed > 0 ? 'Review' : start.can ? `Start ${isExam ? 'exam' : 'quiz'}` : 'View instructions'}
          </Button>
        )}
      </HStack>
    </Flex>
  );
}

/**
 * Quizzes and exams live on their own tab rather than inside Classwork: they
 * are authored in a dedicated editor, published on their own schedule, and the
 * classwork item is only the announcement of an already-built paper.
 */
export default function Quizzes() {
  const { classId, isTeacher } = useOutletContext();
  const [quizzes, setQuizzes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [publishing, setPublishing] = useState(null);
  const { isOpen, onOpen, onClose } = useDisclosure();
  const publishDialog = useDisclosure();
  const toast = useToast();

  const load = useCallback(async () => {
    setError(null);
    try {
      setQuizzes(await lmApi.listQuizzes(classId));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId]);

  useEffect(() => {
    load();
  }, [load]);

  // Publishing goes through the dialog — it is where the two clocks are set and
  // where the link comes back. Unpublishing needs neither, so it stays direct.
  const openPublish = (quiz) => {
    setPublishing(quiz);
    publishDialog.onOpen();
  };

  const unpublish = async (quiz) => {
    try {
      await lmApi.publishQuiz(classId, quiz._id, { publish: false });
      toast({ status: 'success', title: 'Quiz unpublished' });
      await load();
    } catch (err) {
      toast({ status: 'error', title: err.message });
    }
  };

  const remove = async (quiz) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete "${quiz.title}" and all its attempts?`)) return;
    try {
      await lmApi.deleteQuiz(classId, quiz._id);
      await load();
    } catch (err) {
      toast({ status: 'error', title: err.message });
    }
  };

  if (loading) return <Loading label="Loading quizzes…" />;

  return (
    <Box>
      <Flex justify="space-between" align="center" mb={4} gap={3} wrap="wrap">
        <Box>
          <Heading size="md" color="gray.800">
            Quizzes & exams
          </Heading>
          <Text fontSize="sm" color="gray.500">
            {isTeacher
              ? 'Build a paper here, then publish it to the class.'
              : 'Everything your teacher has published.'}
          </Text>
        </Box>
        {isTeacher && (
          <HStack>
            <Button as={RouterLink} to={`/learning/class/${classId}/studio`} size="sm" variant="outline">
              ✨ Generate from a recording
            </Button>
            <Button colorScheme="blue" size="sm" onClick={onOpen}>
              + Create quiz
            </Button>
          </HStack>
        )}
      </Flex>

      <ErrorState error={error} onRetry={load} />

      <SectionCard>
        {quizzes.length === 0 ? (
          <EmptyState
            icon="🧠"
            title="No quizzes yet"
            description={
              isTeacher
                ? 'Create one from scratch, or generate it from a class recording in the AI Studio.'
                : 'Your teacher has not published any quizzes.'
            }
            action={
              isTeacher ? (
                <Button size="sm" colorScheme="blue" onClick={onOpen}>
                  Create a quiz
                </Button>
              ) : null
            }
          />
        ) : (
          quizzes.map((quiz) => (
            <QuizRow
              key={quiz._id}
              quiz={quiz}
              classId={classId}
              isTeacher={isTeacher}
              onPublish={() => openPublish(quiz)}
              onUnpublish={() => unpublish(quiz)}
              onDelete={() => remove(quiz)}
            />
          ))
        )}
      </SectionCard>

      <CreateQuizModal isOpen={isOpen} onClose={onClose} classId={classId} />
      <PublishQuizModal
        isOpen={publishDialog.isOpen}
        onClose={publishDialog.onClose}
        quiz={publishing}
        classId={classId}
        onPublished={load}
      />
    </Box>
  );
}
