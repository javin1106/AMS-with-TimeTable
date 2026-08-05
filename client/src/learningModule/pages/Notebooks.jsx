import React, { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useNavigate, useOutletContext } from 'react-router-dom';
import {
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
import { DeadlineCountdown, EmptyState, ErrorState, Loading, SectionCard } from '../components/common';
import { formatDate, relativeTime } from '../format';

/**
 * The class's coding notebooks.
 *
 * Python here runs in the student's own browser rather than on a server, so
 * there is no queue, no per-run cost and nothing for a teacher to provision —
 * which is what makes handing one to two hundred students at once reasonable.
 */

const STATUS_META = {
  'not-started': ['gray', 'not started'],
  'in-progress': ['blue', 'in progress'],
  submitted: ['green', 'submitted'],
};

const STARTER_CELLS = [
  {
    type: 'markdown',
    source: '## Getting started\n\nRun the cell below with the ▶ button, then change the numbers and run it again.',
  },
  { type: 'code', source: 'for i in range(5):\n    print(i, i ** 2)\n' },
  { type: 'markdown', source: '### Your turn\n\nWrite a function that returns the mean of a list.' },
  { type: 'code', source: 'def mean(values):\n    # your code here\n    pass\n\n\nmean([1, 2, 3, 4])\n' },
];

export default function Notebooks() {
  const { classId, isTeacher } = useOutletContext();
  const [notebooks, setNotebooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState('');
  const navigate = useNavigate();
  const toast = useToast();

  const load = useCallback(async () => {
    setError(null);
    try {
      setNotebooks(await lmApi.listNotebooks(classId));
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
      const created = await lmApi.createNotebook(classId, {
        title: 'Untitled notebook',
        cells: STARTER_CELLS,
      });
      navigate(`/learning/class/${classId}/notebook/${created._id}/edit`);
    } catch (err) {
      toast({ status: 'error', title: err.message });
    } finally {
      setBusy('');
    }
  };

  const togglePublish = async (notebook) => {
    try {
      const result = await lmApi.publishNotebook(classId, notebook._id, { publish: !notebook.published });
      toast({ status: 'success', title: result.published ? 'Published to the class' : 'Unpublished' });
      await load();
    } catch (err) {
      toast({
        status: 'error',
        title: err.message,
        description: err.payload?.errors?.slice(1).join(' '),
      });
    }
  };

  const remove = async (notebook) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete "${notebook.title}" and every student's work on it?`)) return;
    try {
      await lmApi.deleteNotebook(classId, notebook._id);
      toast({ status: 'success', title: 'Notebook deleted' });
      await load();
    } catch (err) {
      toast({ status: 'error', title: err.message });
    }
  };

  if (loading) return <Loading label="Loading notebooks…" />;
  if (error) return <ErrorState error={error} onRetry={load} />;

  return (
    <VStack align="stretch" spacing={5}>
      <Flex align="center" gap={3} wrap="wrap">
        <Box>
          <Heading size="md">Coding notebooks</Heading>
          <Text fontSize="sm" opacity={0.7}>
            Python cells that run in the browser — nothing to install.
          </Text>
        </Box>
        <Box flex="1" />
        {isTeacher && (
          <Button colorScheme="purple" size="sm" onClick={create} isLoading={busy === 'new'}>
            New notebook
          </Button>
        )}
      </Flex>

      {notebooks.length === 0 ? (
        <EmptyState
          icon="🐍"
          title="No notebooks yet"
          description={
            isTeacher
              ? 'Write a worksheet of prose and Python cells. Students run it in their own browser — no setup, no server, no accounts anywhere else.'
              : 'Your teacher has not published any coding notebooks for this class yet.'
          }
          action={isTeacher ? <Button colorScheme="purple" onClick={create}>New notebook</Button> : null}
        />
      ) : (
        <VStack align="stretch" spacing={3}>
          {notebooks.map((notebook) => {
            const [scheme, label] = STATUS_META[notebook.myStatus] || [];
            return (
              <SectionCard key={notebook._id}>
                <Flex gap={4} wrap="wrap" align="flex-start">
                  <Box flex="1" minW="220px">
                    <HStack spacing={2} mb={1} wrap="wrap">
                      <Text fontWeight="700">{notebook.title}</Text>
                      {isTeacher && !notebook.published && <Badge>draft</Badge>}
                      {!isTeacher && label && <Badge colorScheme={scheme}>{label}</Badge>}
                      {!isTeacher && notebook.myGraded && <Badge colorScheme="purple">graded</Badge>}
                      {notebook.packages?.length ? (
                        <Badge variant="subtle" fontSize="2xs">
                          {notebook.packages.join(', ')}
                        </Badge>
                      ) : null}
                      {/* Up here with the title rather than in the metadata
                          line below: the deadline is the one thing on this card
                          that changes while you are looking at it. */}
                      <DeadlineCountdown dueDate={notebook.dueDate} size="xs" />
                    </HStack>

                    {notebook.description ? (
                      <Text fontSize="sm" opacity={0.75} noOfLines={2}>
                        {notebook.description}
                      </Text>
                    ) : null}

                    <Text fontSize="xs" opacity={0.6} mt={1}>
                      {notebook.codeCellCount} code {notebook.codeCellCount === 1 ? 'cell' : 'cells'} ·{' '}
                      {notebook.cellCount} total
                      {notebook.dueDate ? ` · due ${formatDate(notebook.dueDate)}` : ''}
                      {isTeacher
                        ? ` · ${notebook.submittedCount}/${notebook.startedCount} submitted`
                        : ` · added ${relativeTime(notebook.created_at)}`}
                    </Text>
                  </Box>

                  <HStack spacing={2} wrap="wrap">
                    <Button
                      as={RouterLink}
                      to={`/learning/class/${classId}/notebook/${notebook._id}`}
                      size="sm"
                      colorScheme="purple"
                    >
                      {isTeacher ? 'Open' : notebook.myStatus === 'not-started' ? 'Start' : 'Continue'}
                    </Button>
                    {isTeacher && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          as={RouterLink}
                          to={`/learning/class/${classId}/notebook/${notebook._id}/edit`}
                        >
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => togglePublish(notebook)}>
                          {notebook.published ? 'Unpublish' : 'Publish'}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          as={RouterLink}
                          to={`/learning/class/${classId}/notebook/${notebook._id}/submissions`}
                        >
                          Submissions
                        </Button>
                        <Button size="sm" variant="ghost" colorScheme="red" onClick={() => remove(notebook)}>
                          Delete
                        </Button>
                      </>
                    )}
                  </HStack>
                </Flex>
              </SectionCard>
            );
          })}
        </VStack>
      )}
    </VStack>
  );
}
