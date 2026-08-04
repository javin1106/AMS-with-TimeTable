import React, { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useOutletContext } from 'react-router-dom';
import {
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  SimpleGrid,
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
import { ErrorState, Loading, SectionCard } from '../components/common';

/**
 * How points work, in one place a student can be pointed at.
 *
 * Every number here is served by the API rather than written into this file.
 * The rules live in the gamification service, and a guide that restated them in
 * JSX would drift the first time anybody tuned a value — documentation that is
 * confidently wrong is worse than none at all.
 */
export default function PointsGuide() {
  const { classId } = useOutletContext();
  const [guide, setGuide] = useState(null);
  const [mine, setMine] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [rules, standing] = await Promise.all([
        lmApi.pointsGuide(classId),
        lmApi.myPoints(classId).catch(() => null),
      ]);
      setGuide(rules);
      setMine(standing);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <Loading label="Reading the rules…" />;
  if (error) return <ErrorState error={error} onRetry={load} />;

  const earned = new Set((mine?.badges || []).map((badge) => badge.id));

  return (
    <VStack align="stretch" spacing={4}>
      <SectionCard
        title="How points work"
        subtitle="Points are for effort. Your grades are separate and always will be."
        action={
          <Button as={RouterLink} to={`/learning/class/${classId}/leaderboard`} size="sm" variant="outline">
            🏆 Leaderboard
          </Button>
        }
      >
        <Box overflowX="auto">
          <Table size="sm">
            <Thead>
              <Tr>
                <Th>What you do</Th>
                <Th isNumeric>Points</Th>
                <Th isNumeric>If it is late</Th>
                <Th>Bonus</Th>
              </Tr>
            </Thead>
            <Tbody>
              {guide.earning.map((row) => (
                <Tr key={row.id}>
                  <Td>
                    <Text fontWeight="500">{row.label}</Text>
                    {row.note && (
                      <Text fontSize="xs" color="gray.500">
                        {row.note}
                      </Text>
                    )}
                  </Td>
                  <Td isNumeric fontWeight="700">
                    {row.points}
                  </Td>
                  <Td isNumeric color={row.latePoints ? 'orange.500' : 'gray.400'}>
                    {row.latePoints ?? '—'}
                  </Td>
                  <Td fontSize="xs" color="gray.600">
                    {row.bonus ? `+${row.bonus} for ${row.bonusFor}` : '—'}
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </Box>
      </SectionCard>

      <SectionCard title="The rules behind the rules">
        <VStack align="stretch" spacing={2}>
          {guide.principles.map((line) => (
            <HStack key={line} align="flex-start" spacing={2}>
              <Text color="purple.400">•</Text>
              <Text fontSize="sm">{line}</Text>
            </HStack>
          ))}
        </VStack>
      </SectionCard>

      <SectionCard
        title="Badges"
        subtitle={`${earned.size} of ${guide.badges.length} earned in this class`}
      >
        <SimpleGrid columns={{ base: 1, md: 2 }} spacing={2}>
          {guide.badges.map((badge) => {
            const mineNow = earned.has(badge.id);
            return (
              <Flex
                key={badge.id}
                gap={3}
                align="flex-start"
                p={3}
                borderWidth="1px"
                borderRadius="md"
                borderColor={mineNow ? 'purple.200' : 'gray.200'}
                bg={mineNow ? 'purple.50' : 'transparent'}
              >
                <Text fontSize="xl" filter={mineNow ? 'none' : 'grayscale(1)'} opacity={mineNow ? 1 : 0.5}>
                  {badge.emoji}
                </Text>
                <Box flex="1" minW={0}>
                  <HStack spacing={2}>
                    <Text fontSize="sm" fontWeight="600">
                      {badge.name}
                    </Text>
                    {badge.rare && (
                      <Badge colorScheme="orange" fontSize="0.55rem">
                        rare
                      </Badge>
                    )}
                    {mineNow && (
                      <Badge colorScheme="green" fontSize="0.55rem">
                        earned
                      </Badge>
                    )}
                  </HStack>
                  {/* Every badge says what it takes. A name that lands with one
                      person is a shrug to another, and a badge nobody can aim
                      at is just a surprise. */}
                  <Text fontSize="xs" color="gray.600">
                    {badge.hint}
                  </Text>
                </Box>
              </Flex>
            );
          })}
        </SimpleGrid>
      </SectionCard>

      {mine?.history?.length > 0 && (
        <SectionCard title="Your last few" subtitle="Where your own points came from">
          <VStack align="stretch" spacing={0}>
            {mine.history.slice(0, 15).map((row) => (
              <Flex key={row._id} justify="space-between" py={2} borderBottomWidth="1px" borderColor="gray.100">
                <Text fontSize="sm" noOfLines={1}>
                  {row.reason}
                </Text>
                <Badge colorScheme={row.points > 0 ? 'purple' : 'gray'} borderRadius="full">
                  {row.points > 0 ? `+${row.points}` : row.points}
                </Badge>
              </Flex>
            ))}
          </VStack>
        </SectionCard>
      )}
    </VStack>
  );
}
