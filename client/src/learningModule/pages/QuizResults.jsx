import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Checkbox,
  Flex,
  Grid,
  HStack,
  Heading,
  Input,
  Progress,
  Radio,
  RadioGroup,
  Stack,
  Switch,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Table,
  Tabs,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tooltip,
  Tr,
  FormControl,
  FormHelperText,
  FormLabel,
  Menu,
  MenuButton,
  MenuDivider,
  MenuItem,
  MenuList,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  NumberInput,
  NumberInputField,
  useToast,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import { EmptyState, ErrorState, Loading, SectionCard, StatTile, buttonTextStyles } from '../components/common';
import QuizReview from '../components/QuizReview';
import { richTextToPlain } from '../richTextUtils';
import { formatDateTime, relativeTime } from '../format';

const duration = (seconds) => {
  if (!seconds) return '—';
  const mins = Math.floor(seconds / 60);
  return mins >= 1 ? `${mins}m ${seconds % 60}s` : `${seconds}s`;
};

const bandColor = (percent) =>
  percent === null ? 'gray' : percent >= 70 ? 'green' : percent >= 40 ? 'orange' : 'red';

const nameOf = (person) => person.studentName || person.studentEmail || 'Unknown student';

/** How often the invigilation view re-reads the server while it is open. */
const LIVE_POLL_MS = 15000;

/**
 * A once-a-second re-render, so countdowns tick without the page re-fetching.
 *
 * Only mounted by the monitor view: a timer running behind the analytics tabs
 * would re-render tables that cannot change between polls.
 */
function useSecondTick(enabled) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    const id = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(id);
  }, [enabled]);
}

/**
 * Time left on a sitting, counted against the server's clock rather than the
 * browser's.
 *
 * `skewMs` is how far this machine is ahead of the server, measured when the
 * results were fetched. An invigilator's laptop being three minutes fast is
 * common and would otherwise show students being cut off before they are.
 */
function TimeLeft({ deadline, skewMs }) {
  if (!deadline) {
    return (
      <Text fontSize="xs" color="gray.500">
        no limit
      </Text>
    );
  }

  const remaining = new Date(deadline).getTime() - (Date.now() + skewMs);
  if (remaining <= 0) {
    return (
      <Badge colorScheme="red" fontSize="0.6rem">
        time up
      </Badge>
    );
  }

  const totalSec = Math.floor(remaining / 1000);
  const mins = Math.floor(totalSec / 60);
  return (
    <Text fontSize="xs" fontWeight="600" color={mins < 5 ? 'red.600' : mins < 15 ? 'orange.600' : 'gray.700'}>
      {mins}:{String(totalSec % 60).padStart(2, '0')}
    </Text>
  );
}

/** The proctoring badges shown against an attempt, in monitor and in results. */
function AttemptFlags({ attempt }) {
  const fullscreen = (attempt.violations || []).filter((v) => v.type === 'fullscreen_exit').length;
  return (
    <>
      {attempt.tabSwitches > 0 && (
        <Badge colorScheme="orange" fontSize="0.6rem" mr={1}>
          {attempt.tabSwitches}× away
        </Badge>
      )}
      {fullscreen > 0 && (
        <Tooltip label={`Left fullscreen ${fullscreen} time(s)`}>
          <Badge colorScheme="purple" fontSize="0.6rem" mr={1}>
            fs {fullscreen}
          </Badge>
        </Tooltip>
      )}
      {attempt.device?.isMobile && (
        <Badge colorScheme="gray" fontSize="0.6rem" mr={1}>
          mobile
        </Badge>
      )}
      {attempt.regradedAt && (
        <Tooltip
          label={`Re-marked ${relativeTime(attempt.regradedAt)}${
            attempt.regradedByName ? ` by ${attempt.regradedByName}` : ''
          }`}
        >
          <Badge colorScheme="blue" fontSize="0.6rem">
            re-marked
          </Badge>
        </Tooltip>
      )}
    </>
  );
}

/**
 * The three ways a teacher can put one student's sitting right.
 *
 * They are kept behind a menu rather than laid out as buttons because two of
 * them destroy exam data and the third hands out extra time — none belongs
 * under a stray click in a table row that is otherwise read-only.
 */
const ACTIONS = {
  continue: {
    label: '▶️ Reopen — continue',
    title: 'Let them carry on',
    colorScheme: 'blue',
    confirm: 'Reopen',
    describe: (attempt) =>
      `${attempt.studentName || attempt.studentEmail} keeps every answer already given and resumes at question ${
        (attempt.cursor ?? 0) + 1
      }. Use this when the test ended for a reason that was not their doing — a dropped connection, a dead battery, the window closing mid-paper.`,
  },
  restart: {
    label: '🔄 Restart as a new test',
    title: 'Give them a fresh paper',
    colorScheme: 'orange',
    confirm: 'Restart',
    describe: (attempt) =>
      `Everything ${attempt.studentName || attempt.studentEmail} answered is deleted and they sit the test again from question 1, on a freshly shuffled paper. Their old score goes with it.`,
  },
  delete: {
    label: '🗑 Delete this response',
    title: 'Remove the attempt',
    colorScheme: 'red',
    confirm: 'Delete',
    describe: (attempt) =>
      `Deletes this sitting by ${attempt.studentName || attempt.studentEmail} and its score, and frees the attempt slot so they can start again themselves — but only while the quiz window is open. To let them back in after it has closed, use Restart instead.`,
  },
};

function AttemptActions({ attempt, onAct }) {
  return (
    <Menu placement="bottom-end">
      <MenuButton as={Button} size="xs" variant="ghost" aria-label="Fix this attempt">
        ⋯
      </MenuButton>
      <MenuList fontSize="sm">
        <MenuItem {...buttonTextStyles} onClick={() => onAct('continue')}>
          {attempt.status === 'in_progress' ? '⏱ Give more time' : ACTIONS.continue.label}
        </MenuItem>
        <MenuItem {...buttonTextStyles} onClick={() => onAct('restart')}>
          {ACTIONS.restart.label}
        </MenuItem>
        <MenuDivider />
        <MenuItem color="red.600" onClick={() => onAct('delete')}>
          {ACTIONS.delete.label}
        </MenuItem>
      </MenuList>
    </Menu>
  );
}

/**
 * One student's paper, question by question.
 *
 * The table above it answers "how did the class do"; this answers the question
 * a teacher is actually asked at the desk afterwards — "which one did I get
 * wrong, and what was the right answer?" It reuses the review the student sees,
 * against the same endpoint, so staff and student are never looking at two
 * different accounts of the same paper.
 */
function AttemptAnswersModal({ attempt, classId, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!attempt) {
      setData(null);
      setError(null);
      return undefined;
    }
    let cancelled = false;
    setData(null);
    setError(null);
    lmApi
      .getAttempt(classId, attempt._id)
      .then((fetched) => !cancelled && setData(fetched))
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [attempt, classId]);

  const review = data?.review || [];

  return (
    <Modal isOpen={Boolean(attempt)} onClose={onClose} size="4xl" scrollBehavior="inside">
      <ModalOverlay />
      <ModalContent>
        <ModalHeader>
          {attempt?.studentName || attempt?.studentEmail}
          <Text fontSize="sm" fontWeight="400" color="gray.600">
            {attempt?.rollNumber ? `${attempt.rollNumber} · ` : ''}
            {attempt?.score}/{attempt?.maxScore} ({attempt?.percent}%) ·{' '}
            {attempt?.totalCorrect} correct · {attempt?.totalWrong} wrong ·{' '}
            {attempt?.totalUnattempted} unattempted
          </Text>
        </ModalHeader>
        <ModalCloseButton />
        <ModalBody pb={6}>
          <ErrorState error={error} />
          {!data && !error ? (
            <Loading label="Loading the paper…" />
          ) : review.length === 0 ? (
            <EmptyState
              icon="📝"
              title="Nothing to show"
              description="This sitting has no marked answers — it may still be in progress."
            />
          ) : (
            <QuizReview
              review={review}
              title=""
              answerLabel={`${attempt?.studentName || 'Student'}’s answer`}
            />
          )}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

/**
 * Confirmation for all three, with the minutes granted where they apply.
 *
 * A reopened sitting gets its own clock: the paper's original time limit runs
 * from when the student started, and the quiz's own closing time has usually
 * passed — which is precisely the situation being fixed — so both would expire
 * the moment the student clicked back in.
 */
function AttemptActionModal({ state, onClose, onDone, classId, toast }) {
  const [minutes, setMinutes] = useState(30);
  const [busy, setBusy] = useState(false);
  const meta = state ? ACTIONS[state.action] : null;
  const timed = state?.action !== 'delete';

  const run = async () => {
    setBusy(true);
    try {
      if (state.action === 'delete') {
        await lmApi.deleteQuizAttempt(classId, state.attempt._id);
        toast({ title: 'Attempt deleted', status: 'success', duration: 4000 });
      } else {
        await lmApi.reopenQuizAttempt(classId, state.attempt._id, {
          mode: state.action === 'restart' ? 'restart' : 'continue',
          minutes: Number(minutes) || 30,
        });
        toast({
          title: state.action === 'restart' ? 'Test reset for the student' : 'Test reopened',
          description: `They have ${minutes} minutes from now. They have been notified.`,
          status: 'success',
          duration: 5000,
        });
      }
      onDone();
      onClose();
    } catch (err) {
      toast({ title: err.message || 'Could not do that', status: 'error', duration: 6000 });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={Boolean(state)} onClose={onClose} isCentered>
      <ModalOverlay />
      <ModalContent>
        <ModalHeader>{meta?.title}</ModalHeader>
        <ModalCloseButton />
        <ModalBody>
          <Text fontSize="sm" color="gray.700">
            {state && meta?.describe(state.attempt)}
          </Text>

          {timed && (
            <FormControl mt={4}>
              <FormLabel fontSize="sm">Minutes allowed from now</FormLabel>
              <NumberInput
                size="sm"
                min={1}
                max={600}
                value={minutes}
                onChange={(value) => setMinutes(value)}
              >
                <NumberInputField />
              </NumberInput>
              <FormHelperText fontSize="xs">
                This sitting runs on its own clock, so a closed quiz window will not shut them out
                again.
              </FormHelperText>
            </FormControl>
          )}

          {state?.action === 'restart' && (
            <Alert status="warning" borderRadius="md" mt={4} fontSize="xs">
              <AlertIcon />
              Their previous answers cannot be recovered afterwards.
            </Alert>
          )}
        </ModalBody>
        <ModalFooter gap={2}>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" colorScheme={meta?.colorScheme} onClick={run} isLoading={busy}>
            {meta?.confirm}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

/* ──────────────────── correcting the answer key ────────────────────────── */

const keyFieldsOf = (question) => ({
  correctAnswers: (question.correctAnswers || []).map(String),
  marks: String(question.marks ?? 1),
  tolerancePercent: String(question.tolerancePercent ?? 0),
  toleranceAbs: String(question.toleranceAbs ?? 0),
});

/**
 * Fix the answer key of a paper the class has already sat, then re-mark them all.
 *
 * Only the fields that decide marks are editable here. Question text and
 * options are shown but locked: a stored response is an *index* into the
 * options as authored, so reordering or rewording them under a cohort that has
 * already answered silently changes what every recorded answer means. Rewriting
 * a question belongs in the quiz editor, before anybody sits it.
 */
function AnswerKeyModal({ isOpen, quiz, classId, onClose, onDone, toast }) {
  const initial = useMemo(() => {
    const draft = {};
    (quiz?.questions || []).forEach((question) => {
      draft[String(question._id)] = keyFieldsOf(question);
    });
    return draft;
  }, [quiz]);

  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (isOpen) {
      setDraft(initial);
      setResult(null);
    }
  }, [isOpen, initial]);

  const set = (questionId, value) =>
    setDraft((current) => ({ ...current, [questionId]: { ...current[questionId], ...value } }));

  const changedIds = useMemo(
    () =>
      Object.keys(draft).filter((id) => {
        const before = initial[id];
        const after = draft[id];
        if (!before || !after) return false;
        return (
          before.correctAnswers.join() !== after.correctAnswers.join() ||
          Number(before.marks) !== Number(after.marks) ||
          Number(before.tolerancePercent) !== Number(after.tolerancePercent) ||
          Number(before.toleranceAbs) !== Number(after.toleranceAbs)
        );
      }),
    [draft, initial],
  );

  const save = async () => {
    setBusy(true);
    try {
      const outcome = await lmApi.updateAnswerKey(
        classId,
        quiz._id,
        changedIds.map((questionId) => ({
          questionId,
          correctAnswers: draft[questionId].correctAnswers,
          marks: Number(draft[questionId].marks) || 0,
          tolerancePercent: Number(draft[questionId].tolerancePercent) || 0,
          toleranceAbs: Number(draft[questionId].toleranceAbs) || 0,
        })),
      );
      setResult(outcome);
      toast({
        title: `Answer key updated — ${outcome.changed} question(s)`,
        description: outcome.regrade
          ? `${outcome.regrade.regraded} paper(s) re-marked, ${outcome.regrade.changed} result(s) changed.`
          : 'No paper needed re-marking.',
        status: 'success',
        duration: 7000,
      });
      onDone();
    } catch (err) {
      toast({ title: err.message || 'Could not update the answer key', status: 'error', duration: 6000 });
    } finally {
      setBusy(false);
    }
  };

  if (!quiz) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="3xl" scrollBehavior="inside">
      <ModalOverlay />
      <ModalContent>
        <ModalHeader>
          Answer key — {quiz.title}
          <Text fontSize="xs" fontWeight="400" color="gray.500">
            Tick the right answer, or change what a question is worth. Saving re-marks every paper
            already submitted and updates the gradebook. Question wording and options are edited in
            the quiz editor, not here.
          </Text>
        </ModalHeader>
        <ModalCloseButton />
        <ModalBody>
          {result ? (
            <Box>
              <Alert status="success" borderRadius="md" mb={3} fontSize="sm">
                <AlertIcon />
                <Box>
                  {result.changed} question(s) corrected.{' '}
                  {result.regrade
                    ? `${result.regrade.regraded} paper(s) re-marked, ${result.regrade.changed} result(s) changed.`
                    : 'Nothing needed re-marking.'}
                </Box>
              </Alert>
              {result.regrade?.changes?.length > 0 && (
                <Table size="sm">
                  <Thead>
                    <Tr>
                      <Th>Student</Th>
                      <Th isNumeric>Was</Th>
                      <Th isNumeric>Now</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {result.regrade.changes.map((change) => (
                      <Tr key={change.attemptId}>
                        <Td fontSize="xs">{change.studentName}</Td>
                        <Td isNumeric fontSize="xs">
                          {change.before.score}
                        </Td>
                        <Td
                          isNumeric
                          fontSize="xs"
                          fontWeight="600"
                          color={change.after.score > change.before.score ? 'green.600' : 'red.600'}
                        >
                          {change.after.score}
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              )}
            </Box>
          ) : (
            (quiz.questions || []).map((question, index) => {
              const id = String(question._id);
              const entry = draft[id] || keyFieldsOf(question);
              const multi = question.type === 'msq';
              const numerical = question.type === 'numerical';
              const changed = changedIds.includes(id);

              return (
                <Box
                  key={id}
                  py={3}
                  px={changed ? 2 : 0}
                  borderBottomWidth="1px"
                  borderColor="gray.100"
                  bg={changed ? 'purple.50' : undefined}
                  borderRadius="md"
                >
                  <Flex justify="space-between" gap={3} align="flex-start">
                    <Text fontSize="sm" fontWeight="600">
                      Q{index + 1}. {richTextToPlain(question.question)}
                    </Text>
                    <HStack spacing={1} flexShrink={0}>
                      {changed && (
                        <Badge colorScheme="purple" fontSize="0.6rem">
                          changed
                        </Badge>
                      )}
                      <Badge fontSize="0.6rem">{question.type}</Badge>
                    </HStack>
                  </Flex>

                  {numerical ? (
                    <HStack mt={2} spacing={3} align="flex-end" wrap="wrap">
                      <FormControl w="160px">
                        <FormLabel fontSize="xs" mb={1}>
                          Correct value
                        </FormLabel>
                        <Input
                          size="sm"
                          value={entry.correctAnswers[0] || ''}
                          onChange={(event) => set(id, { correctAnswers: [event.target.value] })}
                        />
                      </FormControl>
                      <FormControl w="120px">
                        <FormLabel fontSize="xs" mb={1}>
                          ± percent
                        </FormLabel>
                        <Input
                          size="sm"
                          value={entry.tolerancePercent}
                          onChange={(event) => set(id, { tolerancePercent: event.target.value })}
                        />
                      </FormControl>
                      <FormControl w="120px">
                        <FormLabel fontSize="xs" mb={1}>
                          ± absolute
                        </FormLabel>
                        <Input
                          size="sm"
                          value={entry.toleranceAbs}
                          onChange={(event) => set(id, { toleranceAbs: event.target.value })}
                        />
                      </FormControl>
                    </HStack>
                  ) : multi ? (
                    <Stack mt={2} spacing={1}>
                      {(question.options || []).map((option, optionIndex) => (
                        <Checkbox
                          key={optionIndex}
                          size="sm"
                          isChecked={entry.correctAnswers.includes(String(optionIndex))}
                          onChange={(event) => {
                            const picked = new Set(entry.correctAnswers);
                            if (event.target.checked) picked.add(String(optionIndex));
                            else picked.delete(String(optionIndex));
                            set(id, { correctAnswers: [...picked].sort() });
                          }}
                        >
                          <Text as="span" fontSize="sm">
                            {richTextToPlain(option)}
                          </Text>
                        </Checkbox>
                      ))}
                    </Stack>
                  ) : (
                    <RadioGroup
                      mt={2}
                      value={entry.correctAnswers[0] ?? ''}
                      onChange={(value) => set(id, { correctAnswers: [value] })}
                    >
                      <Stack spacing={1}>
                        {(question.options || []).map((option, optionIndex) => (
                          <Radio key={optionIndex} size="sm" value={String(optionIndex)}>
                            <Text as="span" fontSize="sm">
                              {richTextToPlain(option)}
                            </Text>
                          </Radio>
                        ))}
                      </Stack>
                    </RadioGroup>
                  )}

                  <HStack mt={2} spacing={3} align="flex-end">
                    <FormControl w="110px">
                      <FormLabel fontSize="xs" mb={1}>
                        Marks
                      </FormLabel>
                      <Input
                        size="sm"
                        value={entry.marks}
                        onChange={(event) => set(id, { marks: event.target.value })}
                      />
                    </FormControl>
                    {changed && (
                      <Button size="xs" variant="link" onClick={() => set(id, initial[id])}>
                        Undo
                      </Button>
                    )}
                  </HStack>
                </Box>
              );
            })
          )}
        </ModalBody>
        <ModalFooter gap={2}>
          {!result && (
            <Text fontSize="sm" color="gray.600" mr="auto">
              {changedIds.length === 0
                ? 'No changes yet'
                : `${changedIds.length} question(s) will change and every submitted paper re-marked`}
            </Text>
          )}
          <Button size="sm" variant="ghost" onClick={onClose}>
            {result ? 'Close' : 'Cancel'}
          </Button>
          {!result && (
            <Button
              size="sm"
              colorScheme="purple"
              onClick={save}
              isLoading={busy}
              isDisabled={changedIds.length === 0}
            >
              Save key &amp; re-evaluate
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

/**
 * Re-mark the whole cohort against the key as it stands now, without changing it.
 *
 * Separate from the key editor because the key is not always what moved: a
 * question edited in the quiz editor, or a paper whose marks were never
 * recomputed after an earlier fix, both need this and neither needs the key
 * touching. The confirmation says how many results moved afterwards, since
 * "nothing changed" is a common and useful outcome — it says the correction did
 * not affect anybody.
 */
function RegradeModal({ isOpen, onClose, onDone, classId, quizId, toast }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (isOpen) setResult(null);
  }, [isOpen]);

  const run = async () => {
    setBusy(true);
    try {
      const outcome = await lmApi.regradeQuiz(classId, quizId);
      setResult(outcome);
      toast({
        title: `Re-evaluated ${outcome.regraded} paper(s)`,
        description: outcome.changed
          ? `${outcome.changed} result(s) changed. Those students have been notified.`
          : 'No result changed.',
        status: 'success',
        duration: 6000,
      });
      onDone();
    } catch (err) {
      toast({ title: err.message || 'Could not re-evaluate', status: 'error', duration: 6000 });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} isCentered size="lg" scrollBehavior="inside">
      <ModalOverlay />
      <ModalContent>
        <ModalHeader>Re-evaluate the whole quiz</ModalHeader>
        <ModalCloseButton />
        <ModalBody>
          {result ? (
            <Box>
              <Text fontSize="sm" mb={2}>
                {result.regraded} paper(s) re-marked, {result.changed} result(s) changed.
              </Text>
              {result.changes.length > 0 && (
                <Table size="sm">
                  <Thead>
                    <Tr>
                      <Th>Student</Th>
                      <Th isNumeric>Was</Th>
                      <Th isNumeric>Now</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {result.changes.map((change) => (
                      <Tr key={change.attemptId}>
                        <Td fontSize="xs">{change.studentName}</Td>
                        <Td isNumeric fontSize="xs">
                          {change.before.score}
                        </Td>
                        <Td
                          isNumeric
                          fontSize="xs"
                          fontWeight="600"
                          color={change.after.score > change.before.score ? 'green.600' : 'red.600'}
                        >
                          {change.after.score}
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              )}
            </Box>
          ) : (
            <>
              <Text fontSize="sm" color="gray.700">
                Every submitted, expired and terminated paper is marked again against the answer key,
                marks and questions <b>as they stand now</b>. Use this when the paper was corrected
                elsewhere — fixing a question on its own does not move marks that have already been
                awarded.
              </Text>
              <Alert status="info" borderRadius="md" mt={4} fontSize="xs">
                <AlertIcon />
                <Box>
                  Students still sitting the test are left alone — their paper will be marked from the
                  corrected key when they submit. Students whose score changes are notified.
                </Box>
              </Alert>
            </>
          )}
        </ModalBody>
        <ModalFooter gap={2}>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {result ? 'Close' : 'Cancel'}
          </Button>
          {!result && (
            <Button size="sm" colorScheme="purple" onClick={run} isLoading={busy}>
              Re-evaluate now
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

/* ───────────────────────── live invigilation view ──────────────────────── */

/**
 * Who is writing, who has stopped, and who never appeared.
 *
 * The results tabs answer "how did the cohort do"; this one answers "what is
 * happening right now", which during a test is the only question that matters
 * and which a table sorted by score cannot answer. The three groups are kept
 * apart rather than badged within one table because the action each calls for
 * is different: watch, let back in, or chase.
 */
function LiveMonitor({ data, skewMs, onAct, onRefresh, refreshing, auto, setAuto, updatedAt }) {
  useSecondTick(true);

  const { attempts, notStartedStudents, quiz } = data;
  const writing = attempts.filter((attempt) => attempt.status === 'in_progress');
  // Terminated and expired first: those are the students who lost the paper
  // through something other than choosing to finish, and they are who the
  // invigilator is looking for.
  const stopped = attempts
    .filter((attempt) => attempt.status !== 'in_progress')
    .sort((a, b) => {
      const rank = (attempt) => (attempt.status === 'submitted' ? 1 : 0);
      return rank(a) - rank(b) || new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0);
    });

  const closedEarly = stopped.filter((attempt) => attempt.status !== 'submitted');

  return (
    <Box>
      <Flex justify="space-between" align="center" mb={3} gap={3} wrap="wrap">
        <HStack spacing={3}>
          <FormControl display="flex" alignItems="center" w="auto">
            <Switch
              id="live-refresh"
              size="sm"
              isChecked={auto}
              onChange={(event) => setAuto(event.target.checked)}
              mr={2}
            />
            <FormLabel htmlFor="live-refresh" fontSize="sm" mb={0}>
              Auto-refresh
            </FormLabel>
          </FormControl>
          <Text fontSize="xs" color="gray.500">
            updated {relativeTime(updatedAt)}
          </Text>
        </HStack>
        <Button size="xs" variant="outline" onClick={onRefresh} isLoading={refreshing}>
          Refresh now
        </Button>
      </Flex>

      {closedEarly.length > 0 && (
        <Alert status="warning" borderRadius="md" mb={4} fontSize="sm">
          <AlertIcon />
          <Box>
            <Text fontWeight="600">
              {closedEarly.length} student(s) had the test end on them rather than finishing it
            </Text>
            <Text fontSize="xs">
              Use <b>Let back in</b> below to hand the paper back with their answers intact — they
              carry on from the question they were on.
            </Text>
          </Box>
        </Alert>
      )}

      {/* ---- writing now ---- */}
      <SectionCard
        title={`Writing now (${writing.length})`}
        subtitle="Progress counts questions with something written on them. The clock is the server's, including any extra time you have granted."
        mb={4}
      >
        {writing.length === 0 ? (
          <Text fontSize="sm" color="gray.500">
            Nobody is sitting the test at the moment.
          </Text>
        ) : (
          <Box overflowX="auto">
            <Table size="sm">
              <Thead>
                <Tr>
                  <Th>Student</Th>
                  <Th>Roll</Th>
                  <Th w="180px">Progress</Th>
                  <Th>Time left</Th>
                  <Th>Last answer</Th>
                  <Th>Flags</Th>
                  <Th>Fix</Th>
                </Tr>
              </Thead>
              <Tbody>
                {writing.map((attempt) => {
                  const total = attempt.questionCount || quiz.questions.length || 1;
                  const percent = Math.round((attempt.answeredCount / total) * 100);
                  return (
                    <Tr key={attempt._id}>
                      <Td>{nameOf(attempt)}</Td>
                      <Td fontSize="xs">{attempt.rollNumber}</Td>
                      <Td>
                        <Progress value={percent} size="sm" borderRadius="full" colorScheme="green" />
                        <Text fontSize="xs" color="gray.500">
                          {attempt.answeredCount}/{total} answered
                          {quiz.settings.deliveryMode === 'one_at_a_time' &&
                            ` · on Q${(attempt.cursor ?? 0) + 1}`}
                        </Text>
                      </Td>
                      <Td>
                        <TimeLeft deadline={attempt.deadline} skewMs={skewMs} />
                      </Td>
                      <Td fontSize="xs" color="gray.600">
                        {relativeTime(attempt.lastActivityAt)}
                      </Td>
                      <Td>
                        <AttemptFlags attempt={attempt} />
                      </Td>
                      <Td>
                        <AttemptActions attempt={attempt} onAct={(action) => onAct(attempt, action)} />
                      </Td>
                    </Tr>
                  );
                })}
              </Tbody>
            </Table>
          </Box>
        )}
      </SectionCard>

      {/* ---- stopped ---- */}
      <SectionCard
        title={`Submitted or closed (${stopped.length})`}
        subtitle="A paper that ended by itself — the window closing, a proctoring rule, a dead connection — can be handed straight back."
        mb={4}
      >
        {stopped.length === 0 ? (
          <Text fontSize="sm" color="gray.500">
            Nobody has finished yet.
          </Text>
        ) : (
          <Box overflowX="auto">
            <Table size="sm">
              <Thead>
                <Tr>
                  <Th>Student</Th>
                  <Th>Roll</Th>
                  <Th>How it ended</Th>
                  <Th isNumeric>Answered</Th>
                  <Th isNumeric>Score</Th>
                  <Th>When</Th>
                  <Th>Flags</Th>
                  <Th>Let back in</Th>
                  <Th>Fix</Th>
                </Tr>
              </Thead>
              <Tbody>
                {stopped.map((attempt) => (
                  <Tr key={attempt._id} bg={attempt.status === 'terminated' ? 'red.50' : undefined}>
                    <Td>{nameOf(attempt)}</Td>
                    <Td fontSize="xs">{attempt.rollNumber}</Td>
                    <Td>
                      <Badge
                        colorScheme={
                          attempt.status === 'terminated'
                            ? 'red'
                            : attempt.status === 'expired'
                              ? 'orange'
                              : 'green'
                        }
                        fontSize="0.6rem"
                      >
                        {attempt.status === 'terminated'
                          ? 'ended by proctoring'
                          : attempt.status === 'expired'
                            ? 'ran out of time'
                            : 'submitted'}
                      </Badge>
                      {attempt.terminationReason && (
                        <Text fontSize="0.65rem" color="red.600" maxW="220px">
                          {attempt.terminationReason}
                        </Text>
                      )}
                      {attempt.reopenCount > 0 && (
                        <Text color="purple.600" fontSize="0.65rem">
                          reopened ×{attempt.reopenCount}
                          {attempt.reopenedByName ? ` by ${attempt.reopenedByName}` : ''}
                        </Text>
                      )}
                    </Td>
                    <Td isNumeric fontSize="xs">
                      {attempt.answeredCount}/{attempt.questionCount || quiz.questions.length}
                    </Td>
                    <Td isNumeric fontSize="xs">
                      {attempt.score}/{attempt.maxScore}
                    </Td>
                    <Td fontSize="xs">{attempt.submittedAt ? relativeTime(attempt.submittedAt) : '—'}</Td>
                    <Td>
                      <AttemptFlags attempt={attempt} />
                    </Td>
                    <Td>
                      <Button
                        size="xs"
                        colorScheme="blue"
                        variant={attempt.status === 'submitted' ? 'ghost' : 'solid'}
                        onClick={() => onAct(attempt, 'continue')}
                      >
                        Let back in
                      </Button>
                    </Td>
                    <Td>
                      <AttemptActions attempt={attempt} onAct={(action) => onAct(attempt, action)} />
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </Box>
        )}
      </SectionCard>

      {/* ---- never started ---- */}
      <SectionCard title={`Not started (${notStartedStudents.length})`}>
        {notStartedStudents.length === 0 ? (
          <Text fontSize="sm" color="gray.500">
            Every student on the roll has opened the test.
          </Text>
        ) : (
          <Flex wrap="wrap" gap={2}>
            {notStartedStudents.map((student) => (
              <Badge key={student.studentId} colorScheme="gray" px={2} py={1} borderRadius="md" fontWeight="400">
                {student.rollNumber ? `${student.rollNumber} · ` : ''}
                {nameOf(student)}
              </Badge>
            ))}
          </Flex>
        )}
      </SectionCard>
    </Box>
  );
}

export default function QuizResults() {
  const { classId } = useOutletContext();
  const { quizId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // `{ attempt, action }` while a fix is being confirmed.
  const [action, setAction] = useState(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const [regrading, setRegrading] = useState(false);
  const [tab, setTab] = useState(0);
  const [auto, setAuto] = useState(true);
  const [releasing, setReleasing] = useState(false);
  // The attempt whose answer sheet is open, if any.
  const [viewing, setViewing] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);
  // How far this browser's clock is ahead of the server's, so the countdowns
  // shown to an invigilator agree with the deadline the server will enforce.
  const skewRef = useRef(0);
  const toast = useToast();

  /**
   * `quiet` is what makes polling usable: a background refresh must not blank
   * the page into its loading state, or the monitor would flicker every fifteen
   * seconds and the menu you were reaching for would vanish under the cursor.
   */
  const load = useCallback(
    async (quiet = false) => {
      if (quiet) setRefreshing(true);
      setError(null);
      try {
        const fetched = await lmApi.quizResults(classId, quizId);
        if (fetched.serverTime) skewRef.current = Date.now() - new Date(fetched.serverTime).getTime();
        setData(fetched);
        setUpdatedAt(new Date());
      } catch (err) {
        // A failed background poll leaves the last good data on screen; only a
        // failed first load has nothing to show and becomes the error state.
        if (!quiet) setError(err);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [classId, quizId],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Poll only while the monitor is the tab on screen. The analytics tabs read a
  // finished cohort and gain nothing from re-fetching, and a poll running behind
  // them would keep a class-sized query warm for nobody.
  useEffect(() => {
    if (tab !== 0 || !auto) return undefined;
    const id = setInterval(() => load(true), LIVE_POLL_MS);
    return () => clearInterval(id);
  }, [tab, auto, load]);

  const act = useCallback((attempt, next) => setAction({ attempt, action: next }), []);

  /**
   * The override the whole scheduling exists to be overridden by.
   *
   * Confirmed rather than immediate: it notifies every student who sat the
   * paper and cannot be taken back, and the commonest moment to press it is
   * while still deciding whether the marks are right.
   */
  const releaseNow = useCallback(async () => {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Announce these results to the class now? Every student who sat the paper is notified, and this cannot be undone.')) {
      return;
    }
    setReleasing(true);
    try {
      const outcome = await lmApi.releaseQuizResults(classId, quizId);
      toast({
        status: 'success',
        title: 'Results published',
        description: outcome.notified
          ? `${outcome.notified} student(s) notified.`
          : 'Nobody has sat this paper yet, so there was nobody to notify.',
      });
      await load(true);
    } catch (err) {
      toast({ status: 'error', title: 'Could not publish results', description: err.message });
    } finally {
      setReleasing(false);
    }
  }, [classId, quizId, load, toast]);

  if (loading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!data) return null;

  const { quiz, attempts, summary, perQuestion, perSection, distribution, resultsVisible } = data;
  const notStartedStudents = data.notStartedStudents || [];
  // `results` is absent on a response cached from before this shipped; falling
  // back to the old boolean keeps the page rendering rather than blanking.
  const results = data.results || { released: resultsVisible };
  const maxBand = Math.max(1, ...distribution.map((band) => band.count));

  return (
    <Box>
      <Flex justify="space-between" align="flex-start" mb={4} gap={3} wrap="wrap">
        <Box>
          <Button size="sm" variant="ghost" onClick={() => navigate(`/learning/class/${classId}/quizzes`)}>
            ← Back to quizzes
          </Button>
          <Heading size="md" mt={1}>
            {quiz.title}
          </Heading>
          <Text fontSize="sm" color="gray.500">
            {quiz.questions.length} questions · {quiz.totalMarks} marks ·{' '}
            {quiz.settings.deliveryMode === 'one_at_a_time' ? 'one at a time' : 'all on one page'}
            {quiz.settings.negativeMarking > 0 && ` · −${quiz.settings.negativeMarking} per wrong answer`}
          </Text>
        </Box>
        <HStack>
          {/* The override, sitting where a teacher looks when they have just
              finished checking the marks — not buried back in the publish
              dialog, which is about setting the paper rather than closing it. */}
          {!results.released && (
            <Button size="sm" colorScheme="green" onClick={releaseNow} isLoading={releasing}>
              📢 Publish results now
            </Button>
          )}
          <Button size="sm" colorScheme="purple" onClick={() => setKeyOpen(true)}>
            Edit answer key
          </Button>
          <Button size="sm" variant="outline" colorScheme="purple" onClick={() => setRegrading(true)}>
            Re-evaluate all
          </Button>
          <Button as="a" href={lmApi.quizResultsCsvUrl(classId, quizId)} size="sm" variant="outline">
            Export CSV
          </Button>
        </HStack>
      </Flex>

      {/* Three states, because "students cannot see this yet" has three quite
          different reasons and only one of them is a date. */}
      {!results.released && (
        <Alert status="info" borderRadius="md" mb={4} fontSize="sm">
          <AlertIcon />
          <Box>
            <Text>
              {results.scheduled
                ? `Results are scheduled for ${formatDateTime(results.releaseAt)} — students cannot see their scores yet, but you can.`
                : 'Results are held until you release them — students cannot see their scores yet, but you can.'}
            </Text>
            <Text fontSize="xs" color="gray.600">
              Publishing notifies every student who sat the paper, and marks the subject on their
              class card until they have read it.
            </Text>
          </Box>
        </Alert>
      )}
      {results.released && results.announcedAt && (
        <Alert status="success" borderRadius="md" mb={4} fontSize="sm">
          <AlertIcon />
          <Box>
            <Text>
              Results announced {formatDateTime(results.announcedAt)}
              {results.announcedByName ? ` by ${results.announcedByName}` : ''}.
            </Text>
            {(results.viewed > 0 || results.awaitingView > 0) && (
              <Text fontSize="xs" color="gray.600">
                {results.viewed} student(s) have opened their result; {results.awaitingView} have not
                yet.
              </Text>
            )}
          </Box>
        </Alert>
      )}

      <Grid templateColumns={{ base: '1fr 1fr', md: 'repeat(6, 1fr)' }} gap={3} mb={4}>
        <StatTile label="Submitted" value={`${summary.submitted}/${summary.enrolled}`} />
        <StatTile label="In progress" value={summary.inProgress} accent="orange.500" />
        <StatTile label="Not started" value={summary.notStarted} accent="gray.500" />
        <StatTile label="Average" value={summary.average === null ? '—' : `${summary.average}%`} accent="blue.500" />
        <StatTile label="Pass rate" value={summary.passRate === null ? '—' : `${summary.passRate}%`} accent="green.500" />
        <StatTile label="Avg time" value={duration(summary.avgDurationSec)} />
      </Grid>

      {(summary.flagged > 0 || summary.terminated > 0) && (
        <Alert status="warning" borderRadius="md" mb={4} fontSize="sm">
          <AlertIcon />
          <Box>
            <Text fontWeight="600">
              {summary.flagged} attempt(s) recorded a proctoring event
              {summary.terminated > 0 && `, ${summary.terminated} ended automatically`}
            </Text>
            <Text fontSize="xs">See the Live monitor tab for who, and to let them back in.</Text>
          </Box>
        </Alert>
      )}

      {summary.lastRegradedAt && (
        <Alert status="info" borderRadius="md" mb={4} fontSize="sm">
          <AlertIcon />
          <Box>
            <Text>
              These marks were last re-evaluated on {formatDateTime(summary.lastRegradedAt)} — the
              scores below reflect the answer key as it stands now.
            </Text>
          </Box>
        </Alert>
      )}

      <Tabs colorScheme="purple" variant="enclosed" index={tab} onChange={setTab}>
        <TabList>
          <Tab fontSize="sm">
            Live monitor
            {summary.inProgress > 0 && (
              <Badge ml={2} colorScheme="orange" fontSize="0.6rem">
                {summary.inProgress}
              </Badge>
            )}
          </Tab>
          <Tab fontSize="sm">Student analysis ({attempts.length})</Tab>
          <Tab fontSize="sm">Question analysis</Tab>
          {perSection.length > 0 && <Tab fontSize="sm">Sections</Tab>}
          <Tab fontSize="sm">Distribution</Tab>
        </TabList>

        <TabPanels>
          {/* ---- live monitor ---- */}
          <TabPanel px={0}>
            <LiveMonitor
              data={{ ...data, notStartedStudents }}
              skewMs={skewRef.current}
              onAct={act}
              onRefresh={() => load(true)}
              refreshing={refreshing}
              auto={auto}
              setAuto={setAuto}
              updatedAt={updatedAt}
            />
          </TabPanel>

          {/* ---- attempts ---- */}
          <TabPanel px={0}>
            {attempts.length === 0 ? (
              <EmptyState icon="📊" title="No attempts yet" description="Results appear as students sit the test." />
            ) : (
              <SectionCard>
                <Box overflowX="auto">
                  <Table size="sm">
                    <Thead>
                      <Tr>
                        <Th>Student</Th>
                        <Th>Roll</Th>
                        <Th isNumeric>#</Th>
                        <Th isNumeric>Score</Th>
                        <Th isNumeric>%</Th>
                        <Th>Result</Th>
                        <Th isNumeric>✓</Th>
                        <Th isNumeric>✗</Th>
                        <Th isNumeric>—</Th>
                        <Th isNumeric>Neg</Th>
                        <Th isNumeric>Time</Th>
                        <Th>Flags</Th>
                        <Th>Submitted</Th>
                        {/* Was a "Fix" menu duplicating the one on the Live
                            monitor, where reopening and resetting a sitting
                            belong. This column answers the question the table
                            cannot: what did this student actually write. */}
                        <Th>Answers</Th>
                      </Tr>
                    </Thead>
                    <Tbody>
                      {attempts.map((attempt) => (
                        <Tr key={attempt._id} bg={attempt.status === 'terminated' ? 'red.50' : undefined}>
                          <Td>{attempt.studentName || attempt.studentEmail}</Td>
                          <Td fontSize="xs">{attempt.rollNumber}</Td>
                          <Td isNumeric>{attempt.attemptNumber}</Td>
                          <Td isNumeric>
                            {attempt.score}/{attempt.maxScore}
                          </Td>
                          <Td isNumeric>{attempt.percent}%</Td>
                          <Td>
                            {attempt.status === 'in_progress' ? (
                              <Badge colorScheme="orange">in progress</Badge>
                            ) : attempt.status === 'terminated' ? (
                              <Badge colorScheme="red">terminated</Badge>
                            ) : (
                              <Badge colorScheme={attempt.passed ? 'green' : 'red'}>
                                {attempt.passed ? 'Pass' : 'Fail'}
                              </Badge>
                            )}
                          </Td>
                          <Td isNumeric color="green.600">
                            {attempt.totalCorrect}
                          </Td>
                          <Td isNumeric color="red.600">
                            {attempt.totalWrong}
                          </Td>
                          <Td isNumeric color="gray.500">
                            {attempt.totalUnattempted}
                          </Td>
                          <Td isNumeric>{attempt.negativeApplied ? `−${attempt.negativeApplied}` : '—'}</Td>
                          <Td isNumeric fontSize="xs">
                            {duration(attempt.durationSec)}
                          </Td>
                          <Td>
                            <AttemptFlags attempt={attempt} />
                          </Td>
                          <Td fontSize="xs">
                            {attempt.status === 'in_progress' ? (
                              <Badge colorScheme="red" fontSize="0.6rem">
                                sitting now
                              </Badge>
                            ) : attempt.submittedAt ? (
                              formatDateTime(attempt.submittedAt)
                            ) : (
                              '—'
                            )}
                            {attempt.reopenCount > 0 && (
                              <Text color="purple.600" fontSize="0.65rem">
                                reopened ×{attempt.reopenCount}
                                {attempt.reopenedByName ? ` by ${attempt.reopenedByName}` : ''}
                              </Text>
                            )}
                            {attempt.regradedAt && (
                              <Text color="blue.600" fontSize="0.65rem">
                                re-marked {relativeTime(attempt.regradedAt)}
                                {attempt.regradedByName ? ` by ${attempt.regradedByName}` : ''}
                              </Text>
                            )}
                          </Td>
                          <Td>
                            <Button
                              size="xs"
                              variant="outline"
                              colorScheme="purple"
                              isDisabled={attempt.status === 'in_progress'}
                              onClick={() => setViewing(attempt)}
                            >
                              View answers
                            </Button>
                          </Td>
                        </Tr>
                      ))}
                    </Tbody>
                  </Table>
                </Box>
                {attempts.some((attempt) => attempt.terminationReason) && (
                  <Box mt={3}>
                    <Text fontSize="xs" fontWeight="600" mb={1}>
                      Termination reasons
                    </Text>
                    {attempts
                      .filter((attempt) => attempt.terminationReason)
                      .map((attempt) => (
                        <Text key={attempt._id} fontSize="xs" color="gray.600">
                          {attempt.studentName}: {attempt.terminationReason}
                        </Text>
                      ))}
                  </Box>
                )}
              </SectionCard>
            )}
          </TabPanel>

          {/* ---- question analysis ---- */}
          <TabPanel px={0}>
            <SectionCard
              title="Question analysis"
              subtitle="Success rate is measured over students who actually attempted the question, so a high skip rate shows up separately rather than masquerading as difficulty."
            >
              <Box overflowX="auto">
                <Table size="sm">
                  <Thead>
                    <Tr>
                      <Th>Q</Th>
                      <Th>Question</Th>
                      <Th>Type</Th>
                      <Th>Level</Th>
                      <Th isNumeric>Correct</Th>
                      <Th w="140px">Success</Th>
                      <Th isNumeric>Skipped</Th>
                      <Th isNumeric>Avg time</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {perQuestion.map((entry, index) => (
                      <Tr key={entry.questionId}>
                        <Td>{index + 1}</Td>
                        <Td maxW="260px">
                          <Text fontSize="xs" noOfLines={2}>
                            {richTextToPlain(entry.question)}
                          </Text>
                          {entry.sectionName && (
                            <Badge fontSize="0.55rem" colorScheme="purple">
                              {entry.sectionName}
                            </Badge>
                          )}
                        </Td>
                        <Td fontSize="xs">{entry.type}</Td>
                        <Td fontSize="xs">{entry.difficulty}</Td>
                        <Td isNumeric fontSize="xs">
                          {entry.correct}/{entry.attempted}
                        </Td>
                        <Td>
                          <Progress
                            value={entry.correctPercent || 0}
                            size="sm"
                            borderRadius="full"
                            colorScheme={bandColor(entry.correctPercent)}
                          />
                          <Text fontSize="xs" color="gray.500">
                            {entry.correctPercent === null ? '—' : `${entry.correctPercent}%`}
                          </Text>
                        </Td>
                        <Td isNumeric fontSize="xs" color={entry.skipRate > 30 ? 'orange.600' : undefined}>
                          {entry.skipRate === null ? '—' : `${entry.skipRate}%`}
                        </Td>
                        <Td isNumeric fontSize="xs">
                          {entry.avgTimeSec === null ? '—' : `${entry.avgTimeSec}s`}
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              </Box>
            </SectionCard>
          </TabPanel>

          {/* ---- sections ---- */}
          {perSection.length > 0 && (
            <TabPanel px={0}>
              <SectionCard title="Section performance">
                {perSection.map((section) => (
                  <Box key={section.sectionName} py={3} borderBottomWidth="1px" borderColor="gray.100">
                    <Flex justify="space-between" mb={1} gap={3} wrap="wrap">
                      <Text fontSize="sm" fontWeight="600">
                        {section.sectionName}
                      </Text>
                      <HStack fontSize="xs" spacing={3}>
                        <Text color="green.600">{section.correct} correct</Text>
                        <Text color="red.600">{section.wrong} wrong</Text>
                        <Text color="gray.500">{section.unattempted} skipped</Text>
                        <Text fontWeight="600">
                          {section.avgPercent === null ? '—' : `${section.avgPercent}%`}
                        </Text>
                      </HStack>
                    </Flex>
                    <Progress
                      value={section.avgPercent || 0}
                      size="sm"
                      borderRadius="full"
                      colorScheme={bandColor(section.avgPercent)}
                    />
                    <Text fontSize="xs" color="gray.500" mt={1}>
                      {duration(Math.round(section.timeSpentSec / Math.max(1, section.count)))} average per
                      student
                    </Text>
                  </Box>
                ))}
              </SectionCard>
            </TabPanel>
          )}

          {/* ---- distribution ---- */}
          <TabPanel px={0}>
            <SectionCard title="Score distribution">
              {distribution.map((band) => (
                <Flex key={band.label} align="center" gap={3} py={2}>
                  <Text fontSize="xs" w="70px" color="gray.600">
                    {band.label}
                  </Text>
                  <Box flex="1" bg="gray.100" borderRadius="full" h="18px" overflow="hidden">
                    <Box
                      w={`${(band.count / maxBand) * 100}%`}
                      h="100%"
                      bg="purple.400"
                      borderRadius="full"
                      transition="width 0.3s"
                    />
                  </Box>
                  <Text fontSize="xs" w="30px" textAlign="right" fontWeight="600">
                    {band.count}
                  </Text>
                </Flex>
              ))}
              <HStack mt={4} spacing={6} fontSize="sm" wrap="wrap">
                <Text>
                  Median: <b>{summary.median === null ? '—' : `${summary.median}%`}</b>
                </Text>
                <Text>
                  Highest: <b>{summary.highest === null ? '—' : `${summary.highest}%`}</b>
                </Text>
                <Text>
                  Lowest: <b>{summary.lowest === null ? '—' : `${summary.lowest}%`}</b>
                </Text>
                {summary.totalNegative > 0 && (
                  <Text>
                    Marks lost to negatives: <b>{summary.totalNegative}</b>
                  </Text>
                )}
              </HStack>
            </SectionCard>
          </TabPanel>
        </TabPanels>
      </Tabs>

      <AttemptAnswersModal attempt={viewing} classId={classId} onClose={() => setViewing(null)} />

      <AttemptActionModal
        state={action}
        classId={classId}
        toast={toast}
        onClose={() => setAction(null)}
        onDone={load}
      />

      <AnswerKeyModal
        isOpen={keyOpen}
        quiz={quiz}
        classId={classId}
        toast={toast}
        onClose={() => setKeyOpen(false)}
        onDone={load}
      />

      <RegradeModal
        isOpen={regrading}
        classId={classId}
        quizId={quizId}
        toast={toast}
        onClose={() => setRegrading(false)}
        onDone={load}
      />
    </Box>
  );
}
