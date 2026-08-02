import React, { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Badge,
  Box,
  Flex,
  HStack,
  SimpleGrid,
  Text,
  Tooltip,
  VStack,
} from '@chakra-ui/react';

import lmApi from '../api/lmApi';
import { EmptyState, ErrorState, Loading, SectionCard } from '../components/common';
import { formatDate } from '../format';

/**
 * Everything a student has done here, grouped by academic session.
 *
 * Points and badges are earned per class by design — "Locked In" means you kept
 * up in *that* subject — so no class page can show a whole career. This is the
 * only place it adds up.
 *
 * Newest session first: the current term is what somebody opens this to see,
 * and last year is history.
 */
/**
 * Folds a session's badges back onto the class each was earned in.
 *
 * The API returns points per class and badges per session, because that is the
 * shape the two aggregates come out in. A student does not think that way: a
 * badge means "I kept up in Digital Signal Processing", and pooling every badge
 * of a term under one heading loses the only thing it says.
 *
 * A badge whose class has no points row — possible only if the ledger and the
 * badges have diverged — still gets a home rather than vanishing.
 */
function classWise(entry) {
  const byClass = new Map(
    entry.classes.map((klass) => [String(klass.classId || 'none'), { ...klass, badges: [] }]),
  );

  entry.badges.forEach((badge) => {
    const key = String(badge.classId || 'none');
    if (!byClass.has(key)) {
      byClass.set(key, {
        classId: badge.classId,
        name: 'A class that no longer exists',
        coverColor: '#718096',
        points: 0,
        awards: 0,
        badges: [],
      });
    }
    byClass.get(key).badges.push(badge);
  });

  return [...byClass.values()].sort((a, b) => b.points - a.points);
}

export default function Profile() {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setProfile(await lmApi.myProfile());
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <Loading label="Adding it all up…" />;
  if (error) return <ErrorState error={error} onRetry={load} />;

  if (!profile.sessions.length) {
    return (
      <EmptyState
        icon="🎖️"
        title="Nothing here yet"
        description="Turn work in, sit a quiz, join a Short — it all shows up here."
      />
    );
  }

  return (
    <VStack align="stretch" spacing={4}>
      <SectionCard title="My progress">
        <SimpleGrid columns={{ base: 3 }} spacing={4}>
          <Box>
            <Text fontSize="3xl" fontWeight="700">
              {profile.totalPoints}
            </Text>
            <Text fontSize="xs" color="gray.500">
              points, all time
            </Text>
          </Box>
          <Box>
            <Text fontSize="3xl" fontWeight="700" color="purple.500">
              {profile.totalBadges}
            </Text>
            <Text fontSize="xs" color="gray.500">
              badges
            </Text>
          </Box>
          <Box>
            <Text fontSize="3xl" fontWeight="700" color="blue.500">
              {profile.sessions.filter((entry) => entry.session).length}
            </Text>
            <Text fontSize="xs" color="gray.500">
              sessions
            </Text>
          </Box>
        </SimpleGrid>
      </SectionCard>

      {profile.sessions.map((entry) => (
        <SectionCard
          key={entry.session || 'unrecorded'}
          // A blank session gets its own heading rather than being hidden:
          // points earned before sessions were recorded, and anything earned
          // outside a class, are still points.
          title={entry.session || 'Not filed under a session'}
          subtitle={`${entry.points} points · ${entry.badges.length} badge${
            entry.badges.length === 1 ? '' : 's'
          }`}
        >
          <VStack align="stretch" spacing={3}>
            {classWise(entry).map((klass) => (
              <Box
                key={String(klass.classId || 'none')}
                borderWidth="1px"
                borderColor="gray.200"
                borderRadius="md"
                overflow="hidden"
              >
                <Flex
                  align="center"
                  gap={3}
                  as={klass.classId ? RouterLink : undefined}
                  to={klass.classId ? `/learning/class/${klass.classId}/leaderboard` : undefined}
                  _hover={klass.classId ? { bg: 'gray.50', textDecoration: 'none' } : undefined}
                  px={3}
                  py={2.5}
                >
                  <Box w="4px" h="32px" borderRadius="full" bg={klass.coverColor} flexShrink={0} />
                  <Box flex="1" minW={0}>
                    <Text fontSize="sm" fontWeight="600" noOfLines={1}>
                      {klass.name}
                    </Text>
                    <Text fontSize="xs" color="gray.500">
                      {klass.awards} award{klass.awards === 1 ? '' : 's'}
                      {klass.lastAt ? ` · last on ${formatDate(klass.lastAt)}` : ''}
                    </Text>
                  </Box>
                  <Badge colorScheme="purple" borderRadius="full" px={2.5}>
                    {klass.points}
                  </Badge>
                </Flex>

                {/* Badges sit with the class that earned them rather than in one
                    pile per session. A badge means "you kept up in *that*
                    subject" — pooling them loses the only thing they say. */}
                {klass.badges.length > 0 && (
                  <HStack
                    spacing={2}
                    wrap="wrap"
                    px={3}
                    py={2}
                    borderTopWidth="1px"
                    borderColor="gray.100"
                    bg="gray.50"
                  >
                    {klass.badges.map((badge) => (
                      <Tooltip
                        key={badge.id}
                        label={badge.detail ? `${badge.hint} — ${badge.detail}` : badge.hint}
                      >
                        <HStack
                          spacing={1.5}
                          borderWidth="1px"
                          borderColor={badge.rare ? 'orange.200' : 'purple.200'}
                          bg={badge.rare ? 'orange.50' : 'white'}
                          borderRadius="full"
                          px={2.5}
                          py={1}
                        >
                          <Text>{badge.emoji}</Text>
                          <Text fontSize="xs" fontWeight="600">
                            {badge.name}
                          </Text>
                        </HStack>
                      </Tooltip>
                    ))}
                  </HStack>
                )}
              </Box>
            ))}
          </VStack>
        </SectionCard>
      ))}
    </VStack>
  );
}
