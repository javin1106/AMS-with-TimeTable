import React, { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useOutletContext, useParams } from 'react-router-dom';
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Heading,
  Input,
  Table,
  Tbody,
  Td,
  Text,
  Textarea,
  Th,
  Thead,
  Tr,
  VStack,
  useColorModeValue,
  useToast,
} from '@chakra-ui/react';

import lmApi from '../api/lmApi';
import { EmptyState, ErrorState, Loading, SectionCard } from '../components/common';
import RichText from '../components/RichText';
import { formatDateTime } from '../format';

/**
 * Marking a coding notebook.
 *
 * Marked by hand, and the page says why: the outputs stored against a cell came
 * from the student's own browser, so they are what the student *saw*, not
 * something the server witnessed. The code is the reliable artefact, so the code
 * is what is put in front of the teacher.
 */
export default function NotebookSubmissions() {
  const { classId } = useOutletContext();
  const { notebookId } = useParams();
  const toast = useToast();

  const [attempts, setAttempts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  const [draft, setDraft] = useState({ grade: '', maxPoints: '', feedback: '' });

  const load = useCallback(async () => {
    setError(null);
    try {
      setAttempts(await lmApi.listNotebookAttempts(classId, notebookId));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId, notebookId]);

  useEffect(() => {
    load();
  }, [load]);

  const openAttempt = async (row) => {
    if (open?.attempt?._id === row._id) {
      setOpen(null);
      return;
    }
    try {
      const data = await lmApi.getNotebookAttempt(classId, row._id);
      setOpen(data);
      setDraft({
        grade: data.attempt.grade ?? '',
        maxPoints: data.attempt.maxPoints ?? '',
        feedback: data.attempt.feedback || '',
      });
    } catch (err) {
      toast({ status: 'error', title: err.message });
    }
  };

  const grade = async () => {
    try {
      await lmApi.gradeNotebookAttempt(classId, open.attempt._id, {
        grade: draft.grade === '' ? null : Number(draft.grade),
        maxPoints: draft.maxPoints === '' ? null : Number(draft.maxPoints),
        feedback: draft.feedback,
      });
      toast({ status: 'success', title: 'Graded and returned' });
      setOpen(null);
      await load();
    } catch (err) {
      toast({ status: 'error', title: err.message });
    }
  };

  const reopen = async (row) => {
    try {
      await lmApi.reopenNotebookAttempt(classId, row._id);
      toast({ status: 'success', title: 'Handed back for another go' });
      await load();
    } catch (err) {
      toast({ status: 'error', title: err.message });
    }
  };

  const codeBg = useColorModeValue('gray.50', 'blackAlpha.400');

  if (loading) return <Loading label="Loading submissions…" />;
  if (error) return <ErrorState error={error} onRetry={load} />;

  return (
    <VStack align="stretch" spacing={4}>
      <Flex align="center" gap={3} wrap="wrap">
        <Heading size="md" flex="1">
          Submissions
        </Heading>
        <Button as={RouterLink} to={`/learning/class/${classId}/notebooks`} size="sm" variant="ghost">
          Back to notebooks
        </Button>
        <Button
          as={RouterLink}
          to={`/learning/class/${classId}/notebook/${notebookId}/edit`}
          size="sm"
          variant="outline"
        >
          Edit notebook
        </Button>
      </Flex>

      <Alert status="info" borderRadius="md" fontSize="sm">
        <AlertIcon />
        <Box>
          <Text fontWeight="600">Marked by hand, on purpose.</Text>
          <Text>
            Cell output is recorded from the student&apos;s own browser, so it shows what they saw rather than
            anything the server ran. The code is the part worth grading.
          </Text>
        </Box>
      </Alert>

      {attempts.length === 0 ? (
        <EmptyState icon="🐍" title="Nobody has opened it yet" description="Work will appear here as students start." />
      ) : (
        <Box overflowX="auto">
          <Table size="sm">
            <Thead>
              <Tr>
                <Th>Student</Th>
                <Th>Roll no</Th>
                <Th>Status</Th>
                <Th isNumeric>Cells run</Th>
                <Th isNumeric>Grade</Th>
                <Th />
              </Tr>
            </Thead>
            <Tbody>
              {attempts.map((row) => (
                <Tr key={row._id}>
                  <Td>{row.studentName || row.studentEmail}</Td>
                  <Td>{row.rollNumber || '—'}</Td>
                  <Td>
                    {row.submittedAt ? (
                      <Badge colorScheme="green">submitted {formatDateTime(row.submittedAt)}</Badge>
                    ) : row.lastSavedAt ? (
                      <Badge colorScheme="blue">in progress</Badge>
                    ) : (
                      <Badge>opened</Badge>
                    )}
                  </Td>
                  <Td isNumeric>{row.cellsRun}</Td>
                  <Td isNumeric>
                    {row.grade === null || row.grade === undefined
                      ? '—'
                      : `${row.grade}${row.maxPoints ? `/${row.maxPoints}` : ''}`}
                  </Td>
                  <Td textAlign="right">
                    <HStack spacing={1} justify="flex-end">
                      <Button size="xs" variant="outline" onClick={() => openAttempt(row)}>
                        {open?.attempt?._id === row._id ? 'Close' : 'Read'}
                      </Button>
                      {row.submittedAt && (
                        <Button size="xs" variant="ghost" onClick={() => reopen(row)}>
                          Reopen
                        </Button>
                      )}
                    </HStack>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </Box>
      )}

      {open && (
        <SectionCard
          title={open.attempt.studentName || open.attempt.studentEmail}
          subtitle={
            open.attempt.submittedAt
              ? `Submitted ${formatDateTime(open.attempt.submittedAt)}`
              : 'Not submitted yet'
          }
        >
          <VStack align="stretch" spacing={3}>
            {(open.attempt.cells || []).map((cell) => (
              <Box key={cell._id} borderWidth="1px" borderRadius="md" overflow="hidden">
                {cell.type === 'markdown' ? (
                  <Box px={4} py={3} fontSize="sm">
                    <RichText>{cell.source}</RichText>
                  </Box>
                ) : (
                  <>
                    <Box
                      as="pre"
                      px={4}
                      py={3}
                      m={0}
                      fontFamily="mono"
                      fontSize="13px"
                      whiteSpace="pre-wrap"
                      wordBreak="break-word"
                    >
                      {cell.source || <Text as="span" opacity={0.5}>(empty)</Text>}
                    </Box>
                    {(cell.outputs || []).length > 0 && (
                      <Box bg={codeBg} borderTopWidth="1px" px={4} py={2} maxH="260px" overflow="auto">
                        {cell.outputs.map((output, index) =>
                          output.type === 'image' ? (
                            <Box
                              key={index}
                              as="img"
                              src={`data:image/png;base64,${output.text}`}
                              alt="Figure the student produced"
                              maxW="100%"
                            />
                          ) : (
                            <Box
                              key={index}
                              as="pre"
                              m={0}
                              fontFamily="mono"
                              fontSize="12px"
                              whiteSpace="pre-wrap"
                              color={output.type === 'stderr' || output.type === 'error' ? 'red.400' : 'inherit'}
                            >
                              {output.text}
                            </Box>
                          ),
                        )}
                      </Box>
                    )}
                  </>
                )}
              </Box>
            ))}

            <Flex gap={3} wrap="wrap" align="flex-end">
              <Box>
                <Text fontSize="xs" mb={1}>
                  Grade
                </Text>
                <Input
                  size="sm"
                  w="90px"
                  value={draft.grade}
                  onChange={(e) => setDraft({ ...draft, grade: e.target.value })}
                />
              </Box>
              <Box>
                <Text fontSize="xs" mb={1}>
                  Out of
                </Text>
                <Input
                  size="sm"
                  w="90px"
                  value={draft.maxPoints}
                  onChange={(e) => setDraft({ ...draft, maxPoints: e.target.value })}
                />
              </Box>
              <Box flex="1" minW="220px">
                <Text fontSize="xs" mb={1}>
                  Feedback
                </Text>
                <Textarea
                  size="sm"
                  rows={2}
                  value={draft.feedback}
                  onChange={(e) => setDraft({ ...draft, feedback: e.target.value })}
                />
              </Box>
              <Button size="sm" colorScheme="purple" onClick={grade}>
                Return grade
              </Button>
            </Flex>
          </VStack>
        </SectionCard>
      )}
    </VStack>
  );
}
