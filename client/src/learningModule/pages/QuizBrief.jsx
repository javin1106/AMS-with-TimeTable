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
import RichText from '../components/RichText';
import { ErrorState, Loading, SectionCard, StatTile } from '../components/common';
import { formatDateTime } from '../format';
import { isMobileDevice } from '../hooks/useProctoring';

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

const clock = (seconds) => {
  if (seconds === null || seconds === undefined) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((part) => String(part).padStart(2, '0')).join(':');
};

/**
 * The pre-test screen: rules, timings and eligibility, shown before a single
 * question is handed out. Starting is a deliberate action because for a
 * one-at-a-time paper the clock begins immediately and cannot be paused.
 */
export default function QuizBrief() {
  const { classId } = useOutletContext();
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

  if (loading) return <Loading label="Loading test details…" />;
  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!brief) return null;

  const { settings, window: state } = brief;
  const mobileBlocked = settings.preventMobile && isMobileDevice();
  const attemptsLeft = (settings.attemptsAllowed || 1) - brief.attemptsUsed;
  const canStart = state.canStart && !mobileBlocked && (attemptsLeft > 0 || brief.hasInProgress);

  return (
    <Box maxW="900px">
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
          label="Attempts left"
          value={Math.max(0, attemptsLeft)}
          accent={attemptsLeft > 0 ? 'green.500' : 'red.500'}
        />
      </Grid>

      {/* ---- eligibility banners ---- */}
      {mobileBlocked && (
        <Alert status="error" borderRadius="md" mb={4}>
          <AlertIcon />
          <Box>
            <Text fontWeight="600">This test cannot be taken on a mobile device</Text>
            <Text fontSize="sm">Please switch to a laptop or desktop and reload this page.</Text>
          </Box>
        </Alert>
      )}

      {state.notYetOpen && (
        <Alert status="info" borderRadius="md" mb={4}>
          <AlertIcon />
          <Box>
            <Text fontWeight="600">Opens {formatDateTime(state.opensAt)}</Text>
            {opensIn !== null && <Text fontSize="sm">Starts in {clock(opensIn)}</Text>}
          </Box>
        </Alert>
      )}

      {state.closed && (
        <Alert status="error" borderRadius="md" mb={4}>
          <AlertIcon />
          This test closed on {formatDateTime(state.closesAt)}.
        </Alert>
      )}

      {state.lateToStart && !state.closed && (
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

      {state.canStart && startDeadlineIn !== null && (
        <Alert status="warning" borderRadius="md" mb={4}>
          <AlertIcon />
          <Box>
            <Text fontWeight="600">You must start within {clock(startDeadlineIn)}</Text>
            <Text fontSize="sm">Late entry closes at {formatDateTime(state.startDeadline)}.</Text>
          </Box>
        </Alert>
      )}

      {brief.hasInProgress && (
        <Alert status="warning" borderRadius="md" mb={4}>
          <AlertIcon />
          <Box>
            <Text fontWeight="600">You have an attempt in progress</Text>
            <Text fontSize="sm">Continuing picks up exactly where you left off.</Text>
          </Box>
        </Alert>
      )}

      {/* ---- rules ---- */}
      <SectionCard title="How this test runs" mb={4}>
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
          <ListItem>
            <ListIcon as="span">🏁</ListIcon>
            Pass mark: {settings.passPercent}%.
          </ListItem>
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

      {brief.instructions?.length > 0 && (
        <SectionCard title="Instructions from your teacher" mb={4}>
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
        {!canStart && !mobileBlocked && attemptsLeft <= 0 && !brief.hasInProgress && (
          <Badge colorScheme="red">No attempts remaining</Badge>
        )}
        <HStack fontSize="xs" color="gray.500">
          <Text>Make sure you have a stable connection before starting.</Text>
        </HStack>
      </Flex>
    </Box>
  );
}
