import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Flex,
  Grid,
  HStack,
  Heading,
  List,
  ListIcon,
  ListItem,
  Table,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
  useToast,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import QuizStage from '../components/QuizStage';
import RichText from '../components/RichText';
import { ErrorState, Loading, SectionCard, StatTile } from '../components/common';
import { formatDateTime } from '../format';
import useProctoring, { isMobileDevice } from '../hooks/useProctoring';

const formatDuration = (seconds) => {
  if (!seconds) return 'No limit';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return secs ? `${mins}m ${secs}s` : `${mins} min`;
};

const useCountdown = (target) => {
  const [remaining, setRemaining] = useState(null);

  useEffect(() => {
    if (!target) {
      setRemaining(null);
      return undefined;
    }
    const tick = () => setRemaining(Math.max(0, Math.round((new Date(target) - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [target]);

  return remaining;
};

/**
 * The clock a waiting student actually watches, given its own block rather than
 * a line inside an alert — on a fullscreen brief this is the one thing on the
 * page that changes, and it has to be readable from a desk away.
 */
function CountdownPanel({ label, seconds, note, accent }) {
  const parts = [
    { unit: 'hrs', value: Math.floor(seconds / 3600) },
    { unit: 'min', value: Math.floor((seconds % 3600) / 60) },
    { unit: 'sec', value: seconds % 60 },
  ];

  return (
    <Box
      bg="white"
      borderWidth="1px"
      borderColor={`${accent}.200`}
      borderLeftWidth="4px"
      borderLeftColor={`${accent}.400`}
      borderRadius="lg"
      p={4}
      mb={4}
    >
      <Text
        fontSize="xs"
        fontWeight="700"
        textTransform="uppercase"
        letterSpacing="wide"
        color={`${accent}.600`}
      >
        {label}
      </Text>
      <HStack spacing={2} mt={2} role="timer" aria-live="off">
        {parts.map((part) => (
          <Box key={part.unit} bg={`${accent}.50`} borderRadius="md" px={3} py={2} minW="68px" textAlign="center">
            <Text fontSize="2xl" fontWeight="700" fontFamily="mono" lineHeight="1.1" color={`${accent}.700`}>
              {String(part.value).padStart(2, '0')}
            </Text>
            <Text fontSize="0.6rem" color="gray.500" textTransform="uppercase" letterSpacing="wide">
              {part.unit}
            </Text>
          </Box>
        ))}
      </HStack>
      {note && (
        <Text fontSize="sm" color="gray.600" mt={2}>
          {note}
        </Text>
      )}
    </Box>
  );
}

/**
 * The pre-test screen: rules, timings and eligibility, shown before a single
 * question is handed out. Starting is a deliberate action because for a
 * one-at-a-time paper the clock begins immediately and cannot be paused.
 *
 * It runs on the shared quiz stage, so the instructions fill the screen the
 * same way the paper will — and the fullscreen the student is granted here
 * carries straight through into the sitting.
 */
export default function QuizBrief() {
  const { classId, klass, isTeacher } = useOutletContext();
  const { quizId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [brief, setBrief] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setBrief(await lmApi.quizBrief(classId, quizId));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId, quizId]);

  useEffect(() => {
    load();
  }, [load]);

  const opensIn = useCountdown(brief?.window?.notYetOpen ? brief.window.opensAt : null);
  const startDeadlineIn = useCountdown(
    brief?.window?.canStart && brief?.window?.startDeadline ? brief.window.startDeadline : null,
  );

  // Refresh once the quiz opens so the Start button becomes live without a
  // manual reload.
  useEffect(() => {
    if (opensIn === 0) load();
  }, [opensIn, load]);

  // The brief is already on the fullscreen stage, so it is already "in the
  // test" as far as the student can tell — and a right-click menu or a copy
  // that works here reads as the lockdown not being on. No `onViolation`: the
  // restrictions hold, but there is no attempt yet to record them against.
  useProctoring({ settings: brief?.settings || {}, active: Boolean(brief) && !isTeacher });

  const start = async () => {
    setStarting(true);
    try {
      const result = await lmApi.startAttempt(classId, quizId);
      navigate(`/learning/class/${classId}/quiz/${quizId}/attempt/${result.attempt._id}`);
    } catch (err) {
      toast({
        status: 'error',
        title: err.message,
        duration: 8000,
      });
      // A blocked start usually changes the window state; refresh to show why.
      load();
    } finally {
      setStarting(false);
    }
  };

  // The stage is mounted before the brief has loaded on purpose: fullscreen is
  // only granted while the click that brought us here still counts as a user
  // gesture, and waiting for the fetch would spend that window.
  //
  // The brief carries its own subject and faculty so the banner does not depend
  // on the class layout above having them; the class is only the stand-in for
  // the moment before the fetch lands.
  const subject = [brief?.subject, klass?.subject, klass?.name].find(Boolean);
  const faculty = [brief?.facultyName, klass?.ownerName, brief?.createdByName].find(Boolean);

  let body;
  if (loading) body = <Loading label="Loading test details…" />;
  else if (error) body = <ErrorState error={error} onRetry={load} />;
  else if (!brief) body = null;
  else {
    const { settings, window: state } = brief;
    const mobileBlocked = settings.preventMobile && isMobileDevice();
    // One sitting per student, so a used attempt is the end of it.
    const attemptUsed = brief.attemptsUsed > 0;
    const hasInstructions = brief.instructions?.length > 0;
    // Staff can read this page — it is the one they hand out, and checking what
    // the class will see is the point — but only the roll can sit the paper.
    // An open sitting outranks the window, mirroring the server: `startAttempt`
    // resumes an in-progress attempt before it checks `canStart`. This is what
    // makes a teacher's reopen reach the student — the case it exists for is a
    // paper whose window has *already* closed, so a closed window must not be
    // what turns them away at the door.
    const canStart =
      !mobileBlocked && !isTeacher && (brief.hasInProgress || (state.canStart && !attemptUsed));

    body = (
      <>
        <Button size="sm" variant="ghost" mb={2} onClick={() => navigate(`/learning/class/${classId}/quizzes`)}>
          ← Back to quizzes
        </Button>

        <Heading size="lg" mb={1}>
          {brief.title}
        </Heading>
        {brief.description && (
          <Box mb={4}>
            <RichText>{brief.description}</RichText>
          </Box>
        )}

        <Grid templateColumns={{ base: '1fr 1fr', md: 'repeat(4, 1fr)' }} gap={3} mb={5}>
          <StatTile label="Questions" value={brief.questionCount} />
          <StatTile label="Total marks" value={brief.totalMarks} />
          <StatTile label="Duration" value={formatDuration(brief.estimatedDurationSec)} />
          <StatTile
            label="Attempt"
            value={attemptUsed ? 'Used' : 'Single'}
            accent={attemptUsed ? 'red.500' : 'green.500'}
          />
        </Grid>

        {/* ---- the clock ---- */}
        {state.notYetOpen && opensIn !== null && (
          <CountdownPanel
            accent="purple"
            label="Starts in"
            seconds={opensIn}
            note={`Opens ${formatDateTime(state.opensAt)} — this page unlocks itself, so stay here.`}
          />
        )}

        {state.canStart && startDeadlineIn !== null && (
          <CountdownPanel
            accent="orange"
            label="Time left to start"
            seconds={startDeadlineIn}
            note={`Late entry closes at ${formatDateTime(state.startDeadline)}.`}
          />
        )}

        {/* ---- eligibility banners ---- */}
        {isTeacher && (
          <Alert status="info" borderRadius="md" mb={4}>
            <AlertIcon />
            <Box>
              <Text fontWeight="600">You are seeing this as staff</Text>
              <Text fontSize="sm">
                This is exactly what your students will read. Only students enrolled in this class
                can sit the paper — a staff attempt would be scored into their results.
              </Text>
            </Box>
          </Alert>
        )}

        {mobileBlocked && (
          <Alert status="error" borderRadius="md" mb={4}>
            <AlertIcon />
            <Box>
              <Text fontWeight="600">This test cannot be taken on a mobile device</Text>
              <Text fontSize="sm">Please switch to a laptop or desktop and reload this page.</Text>
            </Box>
          </Alert>
        )}

        {/* Suppressed when a sitting is open: the student's teacher has just
            reopened the paper for them, and "this test closed" above a working
            Continue button reads as a bug and stops people clicking it. */}
        {state.closed && !brief.hasInProgress && (
          <Alert status="error" borderRadius="md" mb={4}>
            <AlertIcon />
            This test closed on {formatDateTime(state.closesAt)}.
          </Alert>
        )}

        {state.lateToStart && !state.closed && !brief.hasInProgress && (
          <Alert status="error" borderRadius="md" mb={4}>
            <AlertIcon />
            <Box>
              <Text fontWeight="600">The window to start has passed</Text>
              <Text fontSize="sm">
                New attempts had to begin by {formatDateTime(state.startDeadline)}. Contact your teacher if you
                were unable to start in time.
              </Text>
            </Box>
          </Alert>
        )}

        {brief.hasInProgress && (
          <Alert status={state.closed ? 'info' : 'warning'} borderRadius="md" mb={4}>
            <AlertIcon />
            <Box>
              <Text fontWeight="600">
                {state.closed
                  ? 'Your teacher has reopened this test for you'
                  : 'You have an attempt in progress'}
              </Text>
              <Text fontSize="sm">
                Continuing picks up exactly where you left off.
                {state.closed
                  ? ' The test is closed for everyone else, so finish it in one go — your teacher set the time you have.'
                  : ''}
              </Text>
            </Box>
          </Alert>
        )}

        {/* ---- rules ----
            The teacher's own instructions sit beside the generated rules rather
            than under them: they are the part a student is told to read, and a
            long "How this test runs" list would otherwise push them off screen. */}
        <Grid
          templateColumns={{ base: '1fr', lg: hasInstructions ? 'minmax(0, 3fr) minmax(0, 2fr)' : '1fr' }}
          gap={4}
          mb={4}
          alignItems="start"
        >
          <SectionCard title="How this test runs">
            <List spacing={2} fontSize="sm">
              <ListItem>
                <ListIcon as="span">{settings.deliveryMode === 'one_at_a_time' ? '1️⃣' : '📋'}</ListIcon>
                {settings.deliveryMode === 'one_at_a_time'
                  ? 'Questions are shown one at a time.'
                  : 'All questions are shown on one page — answer them in any order.'}
              </ListItem>
              {settings.deliveryMode === 'one_at_a_time' && (
                <ListItem>
                  <ListIcon as="span">{settings.allowBacktracking ? '↩️' : '⛔'}</ListIcon>
                  {settings.allowBacktracking
                    ? 'You may go back to earlier questions.'
                    : 'Once you move on, you cannot return to a question.'}
                </ListItem>
              )}
              <ListItem>
                <ListIcon as="span">⏱</ListIcon>
                {settings.perQuestionTiming
                  ? 'Each question has its own timer and submits automatically when it runs out.'
                  : settings.timeLimitMinutes
                    ? `You have ${settings.timeLimitMinutes} minutes for the whole paper.`
                    : 'There is no time limit.'}
              </ListItem>
              {settings.negativeMarking > 0 && (
                <ListItem>
                  <ListIcon as="span">➖</ListIcon>
                  <b>Negative marking:</b> {settings.negativeMarking} mark(s) deducted for a wrong answer.
                  Unanswered questions are never penalised.
                </ListItem>
              )}
              {settings.shuffleQuestions && (
                <ListItem>
                  <ListIcon as="span">🔀</ListIcon>
                  Question order is randomised — your paper differs from your neighbour&apos;s.
                </ListItem>
              )}
              {settings.questionsPerAttempt > 0 && (
                <ListItem>
                  <ListIcon as="span">🎲</ListIcon>
                  {settings.questionsPerAttempt} questions are drawn at random for you.
                </ListItem>
              )}
              {/* Stated up front, not only as the countdown above: a student
                  reading the brief early needs to know there is a door that
                  closes, whether or not it is closing while they read. */}
              {state.startDeadline && (
                <ListItem>
                  <ListIcon as="span">🚪</ListIcon>
                  You must <b>begin</b> by {formatDateTime(state.startDeadline)}. Nobody may start after
                  that, though anyone already sitting the paper keeps their full time.
                </ListItem>
              )}
              <ListItem>
                <ListIcon as="span">☝️</ListIcon>
                You get <b>one attempt</b> — once you submit, this test cannot be taken again.
              </ListItem>
              <ListItem>
                <ListIcon as="span">🏁</ListIcon>
                Pass mark: {settings.passPercent}%.
              </ListItem>
              {settings.allowCalculator !== false && (
                <ListItem>
                  <ListIcon as="span">🖩</ListIcon>
                  A scientific calculator is available on screen during the test.
                </ListItem>
              )}
              {settings.resultReleaseAt && (
                <ListItem>
                  <ListIcon as="span">📅</ListIcon>
                  Results are released on {formatDateTime(settings.resultReleaseAt)}.
                </ListItem>
              )}
            </List>

            {(!settings.allowTabChange || settings.disableCopyPaste || settings.disableRightClick || settings.requireFullscreen || settings.preventMobile) && (
              <Box mt={4} p={3} bg="orange.50" borderRadius="md" borderWidth="1px" borderColor="orange.200">
                <Text fontSize="sm" fontWeight="600" mb={1}>
                  Monitored conditions
                </Text>
                <List spacing={1} fontSize="xs">
                  {!settings.allowTabChange && (
                    <ListItem>
                      • Leaving this tab or window is recorded. You may do so at most{' '}
                      {settings.maxTabSwitches} time(s)
                      {settings.autoSubmitOnTabLimit
                        ? ' — beyond that your test is submitted automatically.'
                        : '.'}
                    </ListItem>
                  )}
                  {settings.requireFullscreen && <ListItem>• The test runs in fullscreen.</ListItem>}
                  {settings.disableCopyPaste && <ListItem>• Copy and paste are disabled.</ListItem>}
                  {settings.disableRightClick && <ListItem>• Right-click is disabled.</ListItem>}
                  {settings.preventMobile && <ListItem>• Mobile devices are not permitted.</ListItem>}
                </List>
              </Box>
            )}
          </SectionCard>

          {hasInstructions && (
            <SectionCard title="Instructions from your teacher">
              <List spacing={2} fontSize="sm">
                {brief.instructions.map((line, index) => (
                  <ListItem key={index}>
                    <ListIcon as="span">•</ListIcon>
                    {line}
                  </ListItem>
                ))}
              </List>
            </SectionCard>
          )}
        </Grid>

        {brief.sections?.length > 0 && (
          <SectionCard title="Sections" mb={4}>
            <Table size="sm">
              <Thead>
                <Tr>
                  <Th>Section</Th>
                  <Th isNumeric>Questions</Th>
                  <Th isNumeric>Marks</Th>
                  <Th>Notes</Th>
                </Tr>
              </Thead>
              <Tbody>
                {brief.sections.map((section) => (
                  <Tr key={section._id}>
                    <Td fontWeight="500">{section.name}</Td>
                    <Td isNumeric>{section.questionCount}</Td>
                    <Td isNumeric>{section.marks}</Td>
                    <Td fontSize="xs" color="gray.600">
                      {section.instructions}
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </SectionCard>
        )}

        <Flex gap={3} align="center" wrap="wrap">
          <Button
            size="lg"
            colorScheme="purple"
            onClick={start}
            isLoading={starting}
            isDisabled={!canStart}
          >
            {brief.hasInProgress ? 'Continue attempt' : 'Start test'}
          </Button>
          {isTeacher && <Badge colorScheme="blue">Enrolled students only</Badge>}
          {!canStart && !isTeacher && !mobileBlocked && attemptUsed && !brief.hasInProgress && (
            <Badge colorScheme="red">Already attempted — this test cannot be retaken</Badge>
          )}
          <HStack fontSize="xs" color="gray.500">
            <Text>Make sure you have a stable connection before starting.</Text>
          </HStack>
        </Flex>
      </>
    );
  }

  return (
    <QuizStage subject={subject} faculty={faculty} title={brief?.title}>
      {body}
    </QuizStage>
  );
}
