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
  useDisclosure,
  useToast,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import { CopyLinkButton, EmptyState, ErrorState, Loading, SectionCard } from '../components/common';

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
      attemptsAllowed: 1,
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
      attemptsAllowed: 1,
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
  const attemptsAllowed = quiz.settings?.attemptsAllowed || 1;
  if (quiz.attemptsUsed >= attemptsAllowed) return { can: false, why: 'No attempts left' };
  if (quiz.window?.notYetOpen) return { can: false, why: 'Not open yet' };
  if (quiz.window?.closed) return { can: false, why: 'Closed' };
  if (quiz.window?.lateToStart) return { can: false, why: 'Start window has passed' };
  return { can: true, why: null };
}

function QuizRow({ quiz, classId, isTeacher, dueDate, onDueDateChange, onTogglePublish, onDelete }) {
  const isExam = quiz.settings?.deliveryMode === 'one_at_a_time';
  const questionCount = quiz.questionCount ?? quiz.questions?.length ?? 0;
  const start = isTeacher ? { can: true, why: null } : startState(quiz);
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
            <Badge colorScheme={quiz.published ? 'green' : 'gray'}>
              {quiz.published ? 'Published' : 'Draft'}
            </Badge>
          )}
        </HStack>
        <Text fontSize="xs" color="gray.500" mt={1}>
          {questionCount} questions · {quiz.totalMarks} marks
          {quiz.settings?.timeLimitMinutes ? ` · ${quiz.settings.timeLimitMinutes} min` : ''}
        </Text>
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
            {!quiz.published && (
              <Input
                size="sm"
                type="datetime-local"
                maxW="200px"
                value={dueDate || ''}
                onChange={(event) => onDueDateChange(event.target.value)}
                placeholder="Due date"
              />
            )}
            <Button as={RouterLink} to={`/learning/class/${classId}/quiz/${quiz._id}/edit`} size="sm" variant="outline">
              Edit
            </Button>
            <Button as={RouterLink} to={`/learning/class/${classId}/quiz/${quiz._id}/results`} size="sm" variant="outline">
              Results
            </Button>
            {/* Only once published: the link resolves to the student brief, which
                a draft quiz will not serve to anyone but its author. */}
            {quiz.published && <CopyLinkButton to={`/learning/class/${classId}/quiz/${quiz._id}`} />}
            <Button size="sm" colorScheme={quiz.published ? 'gray' : 'green'} onClick={onTogglePublish}>
              {quiz.published ? 'Unpublish' : 'Publish'}
            </Button>
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
            // A finished attempt stays openable so the student can read their
            // result back; only an unstartable fresh attempt is blocked.
            isDisabled={!start.can && !quiz.attemptsUsed}
          >
            {quiz.attemptsUsed > 0 ? 'Review / retake' : `Start ${isExam ? 'exam' : 'quiz'}`}
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
  const [dueDates, setDueDates] = useState({});
  const { isOpen, onOpen, onClose } = useDisclosure();
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

  const togglePublish = async (quiz) => {
    try {
      await lmApi.publishQuiz(classId, quiz._id, {
        publish: !quiz.published,
        dueDate: dueDates[quiz._id] || undefined,
      });
      toast({ status: 'success', title: quiz.published ? 'Quiz unpublished' : 'Quiz published to the class' });
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
              dueDate={dueDates[quiz._id]}
              onDueDateChange={(value) => setDueDates((prev) => ({ ...prev, [quiz._id]: value }))}
              onTogglePublish={() => togglePublish(quiz)}
              onDelete={() => remove(quiz)}
            />
          ))
        )}
      </SectionCard>

      <CreateQuizModal isOpen={isOpen} onClose={onClose} classId={classId} />
    </Box>
  );
}
