import React, { useCallback, useEffect, useState } from 'react';
import { Badge, Box, Flex, Link as RouterLinkStyle, SimpleGrid, Text, VStack } from '@chakra-ui/react';
import { Link as RouterLink } from 'react-router-dom';

import lmApi from '../api/lmApi';
import { EmptyState, ErrorState, Loading, SectionCard, StatTile } from '../components/common';
import { relativeTime } from '../format';

/**
 * The lm-admin dashboard: what the module looks like right now, platform-wide.
 *
 * Deliberately a *summary* rather than a second copy of the bug queue or the
 * feedback inbox — those already exist, already work, and duplicating their
 * review actions here would just be a second place for the two to disagree.
 * This page answers the questions neither of them can: how many classes and
 * people are actually using the module, and what needs a look right now.
 */

const BUG_STATUS_STYLE = {
  open: { colorScheme: 'blue', label: 'open' },
  acknowledged: { colorScheme: 'green', label: 'acknowledged' },
  duplicate: { colorScheme: 'purple', label: 'duplicate' },
  rejected: { colorScheme: 'gray', label: 'rejected' },
  fixed: { colorScheme: 'teal', label: 'fixed' },
};

const FEEDBACK_STATUS_STYLE = {
  new: { colorScheme: 'purple', label: 'unread' },
  read: { colorScheme: 'gray', label: 'read' },
  actioned: { colorScheme: 'green', label: 'acted on' },
};

function CountBadges({ counts, styles }) {
  const entries = Object.entries(counts || {});
  if (entries.length === 0) return <Text fontSize="sm" color="gray.500">Nothing yet.</Text>;
  return (
    <Flex gap={2} wrap="wrap">
      {entries.map(([key, count]) => (
        <Badge key={key} colorScheme={styles[key]?.colorScheme || 'gray'} borderRadius="full" px={2}>
          {count} {styles[key]?.label || key}
        </Badge>
      ))}
    </Flex>
  );
}

export default function LmAdmin() {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSummary(await lmApi.adminSummary());
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <Loading label="Loading admin dashboard…" />;
  if (error) return <ErrorState error={error} onRetry={load} />;

  const { courses, people, bugs, feedback } = summary;

  return (
    <VStack align="stretch" spacing={6}>
      <Box>
        <Text fontSize="xl" fontWeight="700" color="gray.800">
          Learning Module — Admin
        </Text>
        <Text fontSize="sm" color="gray.500">
          Platform-wide numbers for the module, plus anything currently waiting on a look.
        </Text>
      </Box>

      <SimpleGrid columns={{ base: 2, md: 5 }} spacing={4}>
        <StatTile label="Courses" value={courses.total} hint={`${courses.active} active`} accent="blue.500" />
        <StatTile label="Students enrolled" value={people.students} accent="teal.500" />
        <StatTile label="Teaching staff" value={people.teachers} accent="orange.500" />
        <StatTile
          label="Bugs & suggestions"
          value={bugs.total}
          hint={`${bugs.byStatus.open || 0} open`}
          accent="red.500"
        />
        <StatTile
          label="Feedback"
          value={feedback.total}
          hint={`${feedback.byStatus.new || 0} unread`}
          accent="purple.500"
        />
      </SimpleGrid>

      <SectionCard
        title="Bugs & suggestions"
        subtitle="Full queue, with review actions, lives on the Bug / Suggestion page."
        action={
          <RouterLinkStyle as={RouterLink} to="/learning/bugs" fontSize="sm" color="blue.600">
            Open queue →
          </RouterLinkStyle>
        }
      >
        <VStack align="stretch" spacing={4}>
          <CountBadges counts={bugs.byStatus} styles={BUG_STATUS_STYLE} />
          {bugs.recent.length === 0 ? (
            <EmptyState icon="🎉" title="Nothing open" />
          ) : (
            <VStack align="stretch" spacing={2}>
              {bugs.recent.map((report) => (
                <Flex key={report._id} justify="space-between" gap={3} wrap="wrap" borderWidth="1px" borderRadius="md" p={3}>
                  <Box>
                    <Text fontSize="sm" fontWeight="600">{report.title}</Text>
                    <Text fontSize="xs" color="gray.500">
                      {report.reporterName} · {relativeTime(report.created_at)}
                      {report.className ? ` · in ${report.className}` : ' · platform-wide'}
                    </Text>
                  </Box>
                  <Badge colorScheme={report.kind === 'suggestion' ? 'orange' : 'red'}>
                    {report.kind === 'suggestion' ? 'Suggestion' : 'Bug'}
                  </Badge>
                </Flex>
              ))}
            </VStack>
          )}
        </VStack>
      </SectionCard>

      <SectionCard
        title="Feedback"
        subtitle="Recent items across every class. Respond from the class's own Feedback tab."
      >
        <VStack align="stretch" spacing={4}>
          <CountBadges counts={feedback.byStatus} styles={FEEDBACK_STATUS_STYLE} />
          {feedback.recent.length === 0 ? (
            <EmptyState icon="💬" title="No feedback yet" />
          ) : (
            <VStack align="stretch" spacing={2}>
              {feedback.recent.map((item) => (
                <Box key={item._id} borderWidth="1px" borderRadius="md" p={3}>
                  <Flex justify="space-between" gap={2} wrap="wrap" mb={1}>
                    <Text fontSize="sm" fontWeight="600">
                      {item.className || 'Unknown class'}
                    </Text>
                    <Badge colorScheme={FEEDBACK_STATUS_STYLE[item.status]?.colorScheme || 'gray'}>
                      {FEEDBACK_STATUS_STYLE[item.status]?.label || item.status}
                    </Badge>
                  </Flex>
                  <Text fontSize="sm" color="gray.700" noOfLines={2}>
                    {item.text}
                  </Text>
                  <Text fontSize="xs" color="gray.500" mt={1}>
                    {item.studentName || 'Unknown student'} · {relativeTime(item.created_at)}
                  </Text>
                </Box>
              ))}
            </VStack>
          )}
        </VStack>
      </SectionCard>
    </VStack>
  );
}
