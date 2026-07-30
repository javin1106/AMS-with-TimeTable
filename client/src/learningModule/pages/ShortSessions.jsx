import React, { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useOutletContext, useParams } from 'react-router-dom';
import {
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Heading,
  Table,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
  VStack,
} from '@chakra-ui/react';

import lmApi from '../api/lmApi';
import { EmptyState, ErrorState, Loading } from '../components/common';
import { formatDateTime, relativeTime } from '../format';

/**
 * Every time this Short has been presented.
 *
 * Runs are listed rather than merged because the same warm-up in two sections is
 * two different rooms — averaging them would hide that one cohort understood it
 * and the other did not.
 */
export default function ShortSessions() {
  const { classId } = useOutletContext();
  const { shortId } = useParams();

  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSessions(await lmApi.listShortSessions(classId, shortId));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId, shortId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <Loading label="Loading sessions…" />;
  if (error) return <ErrorState error={error} onRetry={load} />;

  return (
    <VStack align="stretch" spacing={4}>
      <Flex align="center" gap={3} wrap="wrap">
        <Heading size="md" flex="1">
          Sessions
        </Heading>
        <Button as={RouterLink} to={`/learning/class/${classId}/shorts`} size="sm" variant="ghost">
          Back to shorts
        </Button>
        <Button as={RouterLink} to={`/learning/class/${classId}/short/${shortId}/edit`} size="sm" variant="outline">
          Edit deck
        </Button>
      </Flex>

      {sessions.length === 0 ? (
        <EmptyState
          icon="📽️"
          title="Never presented"
          description="Present this short to a class and its results will show up here."
        />
      ) : (
        <Box overflowX="auto">
          <Table size="sm">
            <Thead>
              <Tr>
                <Th>Started</Th>
                <Th>Presented by</Th>
                <Th isNumeric>Joined</Th>
                <Th isNumeric>Answers</Th>
                <Th />
              </Tr>
            </Thead>
            <Tbody>
              {sessions.map((session) => (
                <Tr key={session._id}>
                  <Td>
                    <HStack spacing={2}>
                      <Text>{formatDateTime(session.startedAt)}</Text>
                      {session.status === 'live' ? (
                        <Badge colorScheme="red" variant="solid">
                          live · {session.joinCode}
                        </Badge>
                      ) : (
                        <Badge>{relativeTime(session.endedAt || session.startedAt)}</Badge>
                      )}
                    </HStack>
                  </Td>
                  <Td>{session.presentedByName || '—'}</Td>
                  <Td isNumeric>{session.participantCount}</Td>
                  <Td isNumeric>{session.responseCount}</Td>
                  <Td textAlign="right">
                    {session.status === 'live' ? (
                      <Button
                        as={RouterLink}
                        to={`/learning/class/${classId}/short/${shortId}/present/${session._id}`}
                        size="xs"
                        colorScheme="red"
                      >
                        Back to presenting
                      </Button>
                    ) : (
                      <Button
                        as={RouterLink}
                        to={`/learning/class/${classId}/short/${shortId}/report/${session._id}`}
                        size="xs"
                        variant="outline"
                      >
                        Report
                      </Button>
                    )}
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </Box>
      )}
    </VStack>
  );
}
