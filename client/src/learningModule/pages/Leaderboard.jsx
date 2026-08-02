import React, { useCallback, useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import {
  Avatar,
  Badge,
  Box,
  Flex,
  HStack,
  Heading,
  SimpleGrid,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Text,
  Tooltip,
  VStack,
  useColorModeValue,
} from '@chakra-ui/react';

import lmApi from '../api/lmApi';
import { EmptyState, ErrorState, Loading, SectionCard } from '../components/common';
import { formatDate } from '../format';

/**
 * Points and badges for one class.
 *
 * Two tables rather than one: a term-long total rewards whoever started first
 * and is unwinnable by anybody who joined late or had a bad fortnight, so the
 * weekly board is the one that stays live and the all-time board is the record.
 * Weekly leads, because it is the one worth checking twice.
 *
 * Staff are absent by construction — the server leaves them out. A table topped
 * by the person who set the homework is not one anybody wants to be on.
 */

const MEDALS = ['🥇', '🥈', '🥉'];

function Row({ row, highlight }) {
  const bg = useColorModeValue('purple.50', 'purple.900');
  return (
    <Flex
      align="center"
      gap={3}
      px={3}
      py={2.5}
      borderRadius="md"
      bg={highlight ? bg : 'transparent'}
      borderWidth={highlight ? '1px' : 0}
      borderColor="purple.200"
    >
      <Box minW="34px" fontSize="lg" textAlign="center">
        {MEDALS[row.rank - 1] || (
          <Text fontSize="sm" color="gray.500" fontVariantNumeric="tabular-nums">
            {row.rank}
          </Text>
        )}
      </Box>
      <Avatar size="xs" name={row.studentName} />
      <Box flex="1" minW={0}>
        <Text fontSize="sm" fontWeight={highlight ? '700' : '500'} noOfLines={1}>
          {row.studentName}
          {highlight && (
            <Text as="span" fontSize="xs" color="purple.500" ml={2}>
              you
            </Text>
          )}
        </Text>
        {row.badges > 0 && (
          <Text fontSize="xs" color="gray.500">
            {row.badges} badge{row.badges === 1 ? '' : 's'}
          </Text>
        )}
      </Box>
      <Badge colorScheme="purple" borderRadius="full" px={2.5} fontVariantNumeric="tabular-nums">
        {row.points}
      </Badge>
    </Flex>
  );
}

function Board({ data }) {
  if (!data.rows.length) {
    return (
      <EmptyState
        icon="🏁"
        title="Nothing on the board yet"
        description="Points arrive as work is turned in and the class joins in."
      />
    );
  }
  return (
    <VStack align="stretch" spacing={1}>
      {data.rows.map((row) => (
        <Row key={String(row.studentId)} row={row} highlight={row.isMe} />
      ))}
      {/* Somebody outside the visible top still wants to know where they are —
          a board that simply omits you is one you stop opening. */}
      {data.me && !data.rows.some((row) => row.isMe) && data.me.points > 0 && (
        <>
          <Text fontSize="xs" color="gray.400" textAlign="center" py={1}>
            ⋯
          </Text>
          <Row row={{ rank: data.me.rank || '—', studentName: 'You', points: data.me.points, badges: data.me.badges.length }} highlight />
        </>
      )}
    </VStack>
  );
}

const KIND_LABELS = {
  submission: 'Assignments turned in',
  quiz: 'Quizzes sat',
  notebook: 'Coding exercises',
  tutorial: 'Tutorials',
  short: 'Live Shorts',
  comment: 'Discussion',
  bonus: 'Other activity',
};

/**
 * What staff see instead.
 *
 * A teacher is not on the table and earns nothing, so "where you stand" was
 * showing them a scoreboard for a game they are not playing. The questions they
 * actually have are whether the class is engaged, what it engages *with*, and
 * who has gone quiet — so the summary leads, and the tail of the table is given
 * as much room as the top of it.
 */
function TeacherView({ week, all }) {
  const summary = week?.summary;
  if (!summary) return <ErrorState error={{ message: 'No summary available.' }} />;

  const busiest = summary.byKind[0];

  return (
    <VStack align="stretch" spacing={4}>
      <SectionCard title="How the class is doing">
        <SimpleGrid columns={{ base: 2, md: 4 }} spacing={4}>
          <Box>
            <Text fontSize="2xl" fontWeight="700">
              {summary.totalPoints}
            </Text>
            <Text fontSize="xs" color="gray.500">
              points earned, all time
            </Text>
          </Box>
          <Box>
            <Text fontSize="2xl" fontWeight="700" color="green.500">
              {summary.weeklyPoints}
            </Text>
            <Text fontSize="xs" color="gray.500">
              this week
            </Text>
          </Box>
          <Box>
            <Text fontSize="2xl" fontWeight="700" color="purple.500">
              {summary.weeklyActiveStudents}
            </Text>
            <Text fontSize="xs" color="gray.500">
              students active this week
            </Text>
          </Box>
          <Box>
            <Text fontSize="2xl" fontWeight="700">
              {summary.earningStudents}
            </Text>
            <Text fontSize="xs" color="gray.500">
              have ever earned anything
            </Text>
          </Box>
        </SimpleGrid>
      </SectionCard>

      <SectionCard
        title="Where the points come from"
        subtitle={busiest ? `Most of it: ${KIND_LABELS[busiest.kind] || busiest.kind}` : undefined}
      >
        {summary.byKind.length === 0 ? (
          <EmptyState icon="📊" title="Nothing earned yet" />
        ) : (
          <VStack align="stretch" spacing={2}>
            {summary.byKind.map((row) => {
              const share = summary.totalPoints ? Math.round((row.points / summary.totalPoints) * 100) : 0;
              return (
                <Box key={row.kind}>
                  <Flex justify="space-between" fontSize="sm" mb={1}>
                    <Text>{KIND_LABELS[row.kind] || row.kind}</Text>
                    <Text color="gray.500">
                      {row.points} pts · {row.awards} award{row.awards === 1 ? '' : 's'}
                    </Text>
                  </Flex>
                  <Box bg="gray.100" borderRadius="full" h="6px" overflow="hidden">
                    <Box bg="purple.400" h="100%" w={`${share}%`} />
                  </Box>
                </Box>
              );
            })}
          </VStack>
        )}
      </SectionCard>

      <SimpleGrid columns={{ base: 1, lg: 2 }} spacing={4}>
        <SectionCard title="Quietest in the class">
          {/* The part a teacher can act on. Ascending on purpose: the top of a
              leaderboard looks after itself. */}
          {summary.quietest.length === 0 ? (
            <EmptyState icon="🤔" title="Nobody has earned anything yet" />
          ) : (
            <VStack align="stretch" spacing={1}>
              {summary.quietest.map((row) => (
                <Flex key={String(row.studentId)} justify="space-between" px={2} py={1.5}>
                  <Text fontSize="sm">{row.studentName}</Text>
                  <Badge colorScheme="gray" borderRadius="full">
                    {row.points}
                  </Badge>
                </Flex>
              ))}
            </VStack>
          )}
        </SectionCard>

        <SectionCard title="Badges held">
          {summary.badges.length === 0 ? (
            <EmptyState icon="🏅" title="No badges earned yet" />
          ) : (
            <VStack align="stretch" spacing={1}>
              {summary.badges.map((badge) => (
                <Flex key={badge.id} align="center" gap={2} px={2} py={1.5}>
                  <Text>{badge.emoji}</Text>
                  <Text fontSize="sm" flex="1" noOfLines={1}>
                    {badge.name}
                  </Text>
                  <Badge colorScheme={badge.rare ? 'orange' : 'purple'} borderRadius="full">
                    {badge.holders}
                  </Badge>
                </Flex>
              ))}
            </VStack>
          )}
        </SectionCard>
      </SimpleGrid>

      <SectionCard title="The table">
        <Tabs colorScheme="purple" size="sm" isLazy>
          <TabList>
            <Tab>This week</Tab>
            <Tab>All time</Tab>
          </TabList>
          <TabPanels>
            <TabPanel px={0}>
              <Board data={week} />
            </TabPanel>
            <TabPanel px={0}>
              <Board data={all} />
            </TabPanel>
          </TabPanels>
        </Tabs>
      </SectionCard>
    </VStack>
  );
}

export default function Leaderboard() {
  const { classId } = useOutletContext();
  const [week, setWeek] = useState(null);
  const [all, setAll] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [weekly, overall] = await Promise.all([
        lmApi.leaderboard(classId, 'week'),
        lmApi.leaderboard(classId, 'all'),
      ]);
      setWeek(weekly);
      setAll(overall);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <Loading label="Counting up…" />;
  if (error) return <ErrorState error={error} onRetry={load} />;

  // Staff earn nothing and appear on neither table, so showing them "where you
  // stand" was showing them a game they are not playing. They get the class.
  if (week?.isTeacher) return <TeacherView week={week} all={all} />;

  const me = week?.me;
  const earned = new Set((me?.badges || []).map((badge) => badge.id));

  return (
    <VStack align="stretch" spacing={4}>
      <SectionCard title="Where you stand">
        <SimpleGrid columns={{ base: 3, md: 3 }} spacing={4}>
          <Box>
            <Text fontSize="2xl" fontWeight="700">
              {me?.points ?? 0}
            </Text>
            <Text fontSize="xs" color="gray.500">
              points all time
            </Text>
          </Box>
          <Box>
            <Text fontSize="2xl" fontWeight="700" color="green.500">
              {me?.weeklyPoints ?? 0}
            </Text>
            <Text fontSize="xs" color="gray.500">
              this week
            </Text>
          </Box>
          <Box>
            <Text fontSize="2xl" fontWeight="700" color="purple.500">
              {me?.badges?.length ?? 0}
            </Text>
            <Text fontSize="xs" color="gray.500">
              badges
            </Text>
          </Box>
        </SimpleGrid>
      </SectionCard>

      <SectionCard title="Badges">
        {/* The whole catalogue, with the unearned ones dimmed rather than
            hidden. A badge nobody knows exists cannot be aimed at, which is
            most of what a badge is for. */}
        <SimpleGrid columns={{ base: 2, md: 3, lg: 5 }} spacing={3}>
          {(week?.catalogue || []).map((badge) => {
            const mine = earned.has(badge.id);
            const held = (me?.badges || []).find((row) => row.id === badge.id);
            return (
              <Tooltip
                key={badge.id}
                label={held?.detail ? `${badge.hint} — ${held.detail}` : badge.hint}
              >
                <Box
                  textAlign="center"
                  p={3}
                  borderWidth={badge.rare ? '2px' : '1px'}
                  borderRadius="lg"
                  borderColor={mine ? (badge.rare ? 'orange.300' : 'purple.200') : 'gray.200'}
                  bg={mine ? (badge.rare ? 'orange.50' : 'purple.50') : 'transparent'}
                  opacity={mine ? 1 : 0.45}
                  filter={mine ? 'none' : 'grayscale(1)'}
                  position="relative"
                >
                  {/* Marked rather than hidden. A hard badge that nobody knows
                      is hard is just a badge they have not got yet. */}
                  {badge.rare && (
                    <Badge
                      position="absolute"
                      top={1}
                      right={1}
                      colorScheme="orange"
                      fontSize="0.55rem"
                      borderRadius="full"
                    >
                      rare
                    </Badge>
                  )}
                  <Text fontSize="2xl">{badge.emoji}</Text>
                  <Text fontSize="xs" fontWeight="600" noOfLines={2}>
                    {badge.name}
                  </Text>
                </Box>
              </Tooltip>
            );
          })}
        </SimpleGrid>
      </SectionCard>

      <SectionCard title="Leaderboard">
        <Tabs colorScheme="purple" size="sm" isLazy>
          <TabList>
            <Tab>
              This week
              {week?.weekStart && (
                <Text as="span" fontSize="xs" color="gray.500" ml={2}>
                  from {formatDate(week.weekStart)}
                </Text>
              )}
            </Tab>
            <Tab>All time</Tab>
          </TabList>
          <TabPanels>
            <TabPanel px={0}>
              <HStack fontSize="xs" color="gray.500" mb={2}>
                <Text>Resets every Monday, so a slow week is never the end of it.</Text>
              </HStack>
              <Board data={week} />
            </TabPanel>
            <TabPanel px={0}>
              <Board data={all} />
            </TabPanel>
          </TabPanels>
        </Tabs>
      </SectionCard>

      <Heading size="xs" color="gray.500" fontWeight="500">
        Points come from turning work in, sitting quizzes, working through coding exercises and joining
        in — not from marks. Your grades are separate and always will be.
      </Heading>
    </VStack>
  );
}
