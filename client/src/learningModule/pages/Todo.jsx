import React, { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Badge,
  Box,
  Flex,
  HStack,
  Heading,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Text,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import { DueBadge, EmptyState, ErrorState, Loading, StateBadge } from '../components/common';
import { courseworkMeta } from '../format';

function WorkRow({ entry, showStudent }) {
  const meta = courseworkMeta(entry);
  const link = entry.class
    ? `/learning/class/${entry.class._id}/work/${entry.courseworkId}`
    : '/learning';

  return (
    <Flex
      as={RouterLink}
      to={link}
      bg="white"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="lg"
      p={4}
      mb={3}
      align="center"
      gap={4}
      _hover={{ borderColor: 'blue.300', textDecoration: 'none' }}
    >
      <Box
        w="4px"
        alignSelf="stretch"
        borderRadius="full"
        bg={entry.class?.coverColor || 'gray.300'}
        flexShrink={0}
      />
      <Text fontSize="lg">{meta.icon}</Text>
      <Box flex="1" minW={0}>
        <Heading size="sm" noOfLines={1}>
          {entry.title || 'Untitled'}
        </Heading>
        <HStack spacing={3} mt={1} wrap="wrap">
          <Text fontSize="xs" color="gray.500">
            {entry.class?.name}
            {entry.class?.section ? ` · ${entry.class.section}` : ''}
          </Text>
          <DueBadge dueDate={entry.dueDate} />
          {showStudent && (
            <Badge colorScheme="blue" fontSize="0.65rem">
              {entry.studentName}
            </Badge>
          )}
        </HStack>
      </Box>
      <Box textAlign="right">
        <StateBadge state={entry.state} />
        {entry.grade !== null && entry.grade !== undefined && (
          <Text fontSize="sm" fontWeight="700" mt={1}>
            {entry.grade}/{entry.maxPoints}
          </Text>
        )}
      </Box>
    </Flex>
  );
}

export default function Todo() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await lmApi.todo());
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <Loading label="Gathering your work…" />;
  if (error) return <ErrorState error={error} onRetry={load} />;

  const { assigned = [], missing = [], done = [], toReview = [] } = data || {};

  return (
    <Box>
      <Heading size="lg" mb={1}>
        To-do
      </Heading>
      <Text color="gray.500" fontSize="sm" mb={5}>
        Work across every class you are in.
      </Text>

      <Tabs colorScheme="blue" variant="soft-rounded">
        <TabList mb={4} flexWrap="wrap" gap={2}>
          <Tab fontSize="sm">Assigned ({assigned.length})</Tab>
          <Tab fontSize="sm" color={missing.length ? 'red.600' : undefined}>
            Missing ({missing.length})
          </Tab>
          <Tab fontSize="sm">Done ({done.length})</Tab>
          {toReview.length > 0 && <Tab fontSize="sm">To review ({toReview.length})</Tab>}
        </TabList>
        <TabPanels>
          <TabPanel px={0}>
            {assigned.length === 0 ? (
              <EmptyState icon="🎉" title="Nothing pending" description="You are all caught up." />
            ) : (
              assigned.map((entry) => <WorkRow key={entry.submissionId} entry={entry} />)
            )}
          </TabPanel>
          <TabPanel px={0}>
            {missing.length === 0 ? (
              <EmptyState icon="✅" title="Nothing missing" description="No overdue work." />
            ) : (
              missing.map((entry) => <WorkRow key={entry.submissionId} entry={entry} />)
            )}
          </TabPanel>
          <TabPanel px={0}>
            {done.length === 0 ? (
              <EmptyState icon="📥" title="Nothing turned in yet" />
            ) : (
              done.map((entry) => <WorkRow key={entry.submissionId} entry={entry} />)
            )}
          </TabPanel>
          {toReview.length > 0 && (
            <TabPanel px={0}>
              {toReview.map((entry) => (
                <WorkRow key={entry.submissionId} entry={entry} showStudent />
              ))}
            </TabPanel>
          )}
        </TabPanels>
      </Tabs>
    </Box>
  );
}
