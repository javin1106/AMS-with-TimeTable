import React, { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useNavigate, useOutletContext } from 'react-router-dom';
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Heading,
  Text,
  VStack,
  useToast,
} from '@chakra-ui/react';

import lmApi from '../api/lmApi';
import { EmptyState, ErrorState, Loading, SectionCard } from '../components/common';
import { relativeTime } from '../format';

/**
 * The class's Shorts — decks of instant questions run live from the front of the
 * room.
 *
 * Deliberately separate from Quizzes: a quiz has a window, an attempt cap and a
 * gradebook row, and none of that applies to a thirty-second temperature check
 * in the middle of a lecture. Mixing them would mean every warm-up poll asking
 * the teacher to pick a due date.
 */

const SLIDE_TYPE_LABEL = {
  mcq: 'Multiple choice',
  msq: 'Multiple answer',
  truefalse: 'True / false',
  wordcloud: 'Word cloud',
  scale: 'Scale',
  open: 'Open text',
  ranking: 'Ranking',
  numeric: 'Numeric estimate',
};

export default function Shorts() {
  const { classId, isTeacher } = useOutletContext();
  const [shorts, setShorts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState('');
  const navigate = useNavigate();
  const toast = useToast();

  const load = useCallback(async () => {
    setError(null);
    try {
      setShorts(await lmApi.listShorts(classId));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId]);

  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    setBusy('new');
    try {
      const created = await lmApi.createShort(classId, {
        title: 'Untitled short',
        slides: [
          {
            type: 'mcq',
            question: 'Which of these did we cover today?',
            options: ['Option A', 'Option B', 'Option C', 'Option D'],
            correctAnswers: [],
            timeLimitSec: 30,
          },
        ],
      });
      navigate(`/learning/class/${classId}/short/${created._id}/edit`);
    } catch (err) {
      toast({ status: 'error', title: err.message });
    } finally {
      setBusy('');
    }
  };

  const present = async (short) => {
    setBusy(short._id);
    try {
      const { session } = await lmApi.presentShort(classId, short._id);
      navigate(`/learning/class/${classId}/short/${short._id}/present/${session.sessionId}`);
    } catch (err) {
      // The deck-level validation errors are the useful ones — show the first,
      // since the editor will show all of them in place.
      toast({
        status: 'error',
        title: err.message,
        description: err.payload?.errors?.slice(1).join(' '),
      });
    } finally {
      setBusy('');
    }
  };

  const remove = async (short) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete "${short.title}" and every session's answers?`)) return;
    try {
      await lmApi.deleteShort(classId, short._id);
      toast({ status: 'success', title: 'Short deleted' });
      await load();
    } catch (err) {
      toast({ status: 'error', title: err.message });
    }
  };

  if (loading) return <Loading label="Loading shorts…" />;
  if (error) return <ErrorState error={error} onRetry={load} />;

  const live = shorts.filter((short) => short.liveSession);

  return (
    <VStack align="stretch" spacing={5}>
      <Flex align="center" gap={3} wrap="wrap">
        <Box>
          <Heading size="md">Shorts</Heading>
          <Text fontSize="sm" opacity={0.7}>
            Instant questions the room answers on their phones, live.
          </Text>
        </Box>
        <Box flex="1" />
        <Button as={RouterLink} to="/learning/short/join" variant="outline" size="sm">
          Join with a code
        </Button>
        {isTeacher && (
          <Button colorScheme="purple" size="sm" onClick={create} isLoading={busy === 'new'}>
            New short
          </Button>
        )}
      </Flex>

      {live.length > 0 && (
        <Alert status="info" borderRadius="md">
          <AlertIcon />
          <Box flex="1">
            <Text fontWeight="600">
              {live.length === 1 ? 'A short is live now' : `${live.length} shorts are live now`}
            </Text>
            <Text fontSize="sm">
              {isTeacher
                ? 'Open the presenter view to keep driving it.'
                : `Join with code ${live[0].liveSession.joinCode}.`}
            </Text>
          </Box>
          {!isTeacher && (
            <Button
              as={RouterLink}
              to={`/learning/short/join/${live[0].liveSession.joinCode}`}
              size="sm"
              colorScheme="blue"
            >
              Join
            </Button>
          )}
        </Alert>
      )}

      {shorts.length === 0 ? (
        <EmptyState
          icon="⚡"
          title="No shorts yet"
          description={
            isTeacher
              ? 'Build a deck of quick questions, put the join code on the projector and watch the answers land.'
              : 'Your teacher has not created any shorts for this class yet.'
          }
          action={isTeacher ? <Button colorScheme="purple" onClick={create}>New short</Button> : null}
        />
      ) : (
        <VStack align="stretch" spacing={3}>
          {shorts.map((short) => (
            <SectionCard key={short._id}>
              <Flex gap={4} wrap="wrap" align="flex-start">
                <Box flex="1" minW="220px">
                  <HStack spacing={2} mb={1} wrap="wrap">
                    <Text fontWeight="700">{short.title}</Text>
                    {short.liveSession && (
                      <Badge colorScheme="red" variant="solid">
                        live · {short.liveSession.joinCode}
                      </Badge>
                    )}
                    {short.settings?.graded && <Badge colorScheme="purple">graded</Badge>}
                    {short.settings?.anonymous && <Badge>anonymous</Badge>}
                  </HStack>

                  {short.description ? (
                    <Text fontSize="sm" opacity={0.75} noOfLines={2}>
                      {short.description}
                    </Text>
                  ) : null}

                  <Text fontSize="xs" opacity={0.6} mt={1}>
                    {short.slideCount} {short.slideCount === 1 ? 'slide' : 'slides'}
                    {short.runCount ? ` · presented ${short.runCount}×` : ' · never presented'}
                    {short.lastRunAt ? ` · last ${relativeTime(short.lastRunAt)}` : ''}
                  </Text>

                  {isTeacher && short.slides?.length ? (
                    <HStack spacing={1} mt={2} wrap="wrap">
                      {[...new Set(short.slides.map((slide) => slide.type))].map((type) => (
                        <Badge key={type} variant="subtle" fontSize="2xs">
                          {SLIDE_TYPE_LABEL[type] || type}
                        </Badge>
                      ))}
                    </HStack>
                  ) : null}
                </Box>

                {isTeacher ? (
                  <HStack spacing={2} wrap="wrap">
                    <Button
                      size="sm"
                      colorScheme={short.liveSession ? 'red' : 'purple'}
                      onClick={() => present(short)}
                      isLoading={busy === short._id}
                    >
                      {short.liveSession ? 'Back to presenting' : 'Present'}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      as={RouterLink}
                      to={`/learning/class/${classId}/short/${short._id}/edit`}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      as={RouterLink}
                      to={`/learning/class/${classId}/short/${short._id}/sessions`}
                    >
                      Reports
                    </Button>
                    <Button size="sm" variant="ghost" colorScheme="red" onClick={() => remove(short)}>
                      Delete
                    </Button>
                  </HStack>
                ) : (
                  short.liveSession && (
                    <Button
                      as={RouterLink}
                      to={`/learning/short/join/${short.liveSession.joinCode}`}
                      size="sm"
                      colorScheme="blue"
                    >
                      Join
                    </Button>
                  )
                )}
              </Flex>
            </SectionCard>
          ))}
        </VStack>
      )}
    </VStack>
  );
}
