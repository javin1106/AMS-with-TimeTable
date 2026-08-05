import React, { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useOutletContext } from 'react-router-dom';
import {
  Box,
  Button,
  Flex,
  HStack,
  Input,
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
import { EmptyState, ErrorState, Loading } from '../components/common';

function GradebookGrid({ classId, isTeacher }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await lmApi.gradebook(classId));
      setEdits({});
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <Loading label="Building the gradebook…" />;
  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!data?.coursework?.length) {
    return <EmptyState icon="💯" title="No graded work yet" description="Assignments and quizzes appear here once they are assigned." />;
  }

  const saveEdits = async () => {
    const grades = Object.entries(edits).map(([submissionId, grade]) => ({ submissionId, grade }));
    if (!grades.length) return;
    setSaving(true);
    try {
      const result = await lmApi.bulkGrade(classId, grades);
      toast({ status: 'success', title: `Updated ${result.updated} grade(s)` });
      await load();
    } catch (err) {
      toast({ status: 'error', title: err.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box>
      <Flex justify="space-between" align="center" mb={3} gap={2} wrap="wrap">
        <Text fontSize="sm" color="gray.500">
          {isTeacher
            ? 'Type marks straight into the grid. Grades appear to students only once you return their work.'
            : 'Only work your teacher has returned is shown.'}
        </Text>
        <HStack>
          {Object.keys(edits).length > 0 && (
            <Button size="sm" colorScheme="blue" onClick={saveEdits} isLoading={saving}>
              Save {Object.keys(edits).length} change(s)
            </Button>
          )}
          {isTeacher && (
            <Button as="a" href={lmApi.gradebookCsvUrl(classId)} size="sm" variant="outline">
              Export CSV
            </Button>
          )}
        </HStack>
      </Flex>

      <Box overflowX="auto" bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="lg">
        <Table size="sm">
          <Thead bg="gray.50">
            <Tr>
              <Th position="sticky" left={0} bg="gray.50" zIndex={1} minW="200px">
                Student
              </Th>
              {data.coursework.map((item, index) => (
                <Th key={item._id} textAlign="center" minW="110px">
                  <Text
                    as={RouterLink}
                    to={`/learning/class/${classId}/work/${item._id}`}
                    fontSize="xs"
                    noOfLines={2}
                    _hover={{ color: 'blue.600' }}
                  >
                    {item.title}
                  </Text>
                  <Text fontSize="0.65rem" color="gray.500" fontWeight="400">
                    /{item.points}
                    {data.classAverages?.[index]?.average !== null &&
                      ` · avg ${data.classAverages[index].average}`}
                  </Text>
                </Th>
              ))}
              <Th textAlign="center" minW="110px">
                Total
              </Th>
            </Tr>
          </Thead>
          <Tbody>
            {data.rows.map((row) => (
              <Tr key={row.student.userId} _hover={{ bg: 'gray.50' }}>
                <Td position="sticky" left={0} bg="white" zIndex={1} fontWeight="500">
                  {row.student.name || row.student.email}
                  {row.student.rollNumber && (
                    <Text as="span" fontSize="xs" color="gray.500" ml={2}>
                      {row.student.rollNumber}
                    </Text>
                  )}
                </Td>
                {row.cells.map((cell) => {
                  const key = `${row.student.userId}-${cell.courseworkId}`;
                  // Teachers mark straight in the grid; students see a read-only
                  // value (and only for work that has been returned to them).
                  if (isTeacher && cell.submissionId) {
                    const pending = edits[cell.submissionId];
                    return (
                      <Td key={key} textAlign="center" px={1}>
                        <Input
                          size="xs"
                          textAlign="center"
                          w="60px"
                          type="number"
                          min={0}
                          max={cell.maxPoints}
                          placeholder={cell.state === 'turned_in' ? '•' : '—'}
                          borderColor={pending !== undefined ? 'blue.400' : undefined}
                          bg={cell.state === 'turned_in' && cell.grade === null ? 'orange.50' : undefined}
                          value={pending !== undefined ? pending : (cell.grade ?? '')}
                          onChange={(event) =>
                            setEdits((prev) => ({ ...prev, [cell.submissionId]: event.target.value }))
                          }
                        />
                      </Td>
                    );
                  }
                  return (
                    <Td key={key} textAlign="center">
                      {cell.grade === null || cell.grade === undefined ? (
                        <Text fontSize="xs" color={cell.state === 'turned_in' ? 'orange.500' : 'gray.300'}>
                          {cell.state === 'turned_in' ? 'to grade' : '—'}
                        </Text>
                      ) : (
                        <Text fontWeight="600" color={cell.late ? 'red.600' : 'gray.700'}>
                          {cell.grade}
                        </Text>
                      )}
                    </Td>
                  );
                })}
                <Td textAlign="center">
                  <Text fontWeight="700">
                    {row.total.percent === null ? '—' : `${row.total.percent}%`}
                  </Text>
                  <Text fontSize="xs" color="gray.500">
                    {row.total.earned}/{row.total.possible}
                  </Text>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Box>
    </Box>
  );
}

// Quizzes used to sit behind a sub-tab here. They now have their own class tab,
// which is where they are authored and published; this page is the gradebook.
export default function Grades() {
  const { classId, isTeacher } = useOutletContext();
  return <GradebookGrid classId={classId} isTeacher={isTeacher} />;
}
