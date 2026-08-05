import React, { useCallback, useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import {
  Badge,
  Box,
  Flex,
  Grid,
  Progress,
  Table,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import { EmptyState, ErrorState, Loading, SectionCard, StatTile } from '../components/common';
import { relativeTime } from '../format';

export default function Insights() {
  const { classId } = useOutletContext();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await lmApi.analytics(classId));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <Loading label="Crunching class data…" />;
  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!data) return null;

  const { totals, rates, perStudent, perCoursework, atRisk } = data;

  return (
    <Box>
      <Grid templateColumns={{ base: '1fr 1fr', md: 'repeat(4, 1fr)' }} gap={4} mb={4}>
        <StatTile label="Students" value={totals.students} />
        <StatTile label="Classwork" value={totals.coursework} hint={`${totals.announcements} announcements`} />
        <StatTile label="Lecture sessions" value={totals.lectureSessions} accent="purple.500" hint="AI Studio" />
        <StatTile label="Quiz attempts" value={totals.quizAttempts} accent="purple.500" />
      </Grid>

      <Grid templateColumns={{ base: '1fr 1fr', md: 'repeat(4, 1fr)' }} gap={4} mb={5}>
        <StatTile
          label="Submission rate"
          value={rates.submissionRate === null ? '—' : `${rates.submissionRate}%`}
          accent="green.500"
        />
        <StatTile label="Late rate" value={rates.lateRate === null ? '—' : `${rates.lateRate}%`} accent="red.500" />
        <StatTile
          label="Class average"
          value={rates.classAverage === null ? '—' : `${rates.classAverage}%`}
          accent="blue.500"
        />
        <StatTile
          label="Quiz average"
          value={rates.quizAverage === null ? '—' : `${rates.quizAverage}%`}
          accent="purple.500"
        />
      </Grid>

      {atRisk.length > 0 && (
        <SectionCard
          title={`${atRisk.length} student${atRisk.length === 1 ? '' : 's'} need attention`}
          subtitle="Nothing turned in, with work outstanding."
          mb={4}
        >
          <Flex wrap="wrap" gap={2}>
            {atRisk.map((student) => (
              <Badge key={student.userId} colorScheme="red" px={3} py={1} borderRadius="full">
                {student.name} · {student.missing} missing
              </Badge>
            ))}
          </Flex>
        </SectionCard>
      )}

      <SectionCard title="Per-assignment breakdown" mb={4}>
        {perCoursework.length === 0 ? (
          <EmptyState icon="📄" title="No classwork yet" />
        ) : (
          <Box overflowX="auto">
            <Table size="sm">
              <Thead>
                <Tr>
                  <Th>Item</Th>
                  <Th isNumeric>Turned in</Th>
                  <Th isNumeric>Late</Th>
                  <Th isNumeric>Average</Th>
                  <Th w="140px">Completion</Th>
                </Tr>
              </Thead>
              <Tbody>
                {perCoursework.map((item) => {
                  const pct = item.assigned ? Math.round((item.turnedIn / item.assigned) * 100) : 0;
                  return (
                    <Tr key={item.courseworkId}>
                      <Td>
                        <Text fontSize="sm" noOfLines={1}>
                          {item.title}
                        </Text>
                        <Text fontSize="xs" color="gray.500">
                          {item.workType}
                        </Text>
                      </Td>
                      <Td isNumeric>
                        {item.turnedIn}/{item.assigned}
                      </Td>
                      <Td isNumeric>{item.late}</Td>
                      <Td isNumeric>
                        {item.average === null ? '—' : `${item.average}/${item.maxPoints}`}
                      </Td>
                      <Td>
                        <Progress
                          value={pct}
                          size="sm"
                          borderRadius="full"
                          colorScheme={pct >= 80 ? 'green' : pct >= 50 ? 'orange' : 'red'}
                        />
                      </Td>
                    </Tr>
                  );
                })}
              </Tbody>
            </Table>
          </Box>
        )}
      </SectionCard>

      <SectionCard title="Per-student breakdown">
        {perStudent.length === 0 ? (
          <EmptyState icon="👥" title="No students enrolled" />
        ) : (
          <Box overflowX="auto">
            <Table size="sm">
              <Thead>
                <Tr>
                  <Th>Student</Th>
                  <Th isNumeric>Turned in</Th>
                  <Th isNumeric>Missing</Th>
                  <Th isNumeric>Late</Th>
                  <Th isNumeric>Average</Th>
                  <Th>Last active</Th>
                </Tr>
              </Thead>
              <Tbody>
                {perStudent.map((student) => (
                  <Tr key={student.userId}>
                    <Td>{student.name}</Td>
                    <Td isNumeric>
                      {student.turnedIn}/{student.assigned}
                    </Td>
                    <Td isNumeric>
                      <Text color={student.missing > 0 ? 'red.600' : 'gray.600'} fontWeight={student.missing > 0 ? '600' : '400'}>
                        {student.missing}
                      </Text>
                    </Td>
                    <Td isNumeric>{student.late}</Td>
                    <Td isNumeric>{student.percent === null ? '—' : `${student.percent}%`}</Td>
                    <Td fontSize="xs" color="gray.500">
                      {student.lastSeenAt ? relativeTime(student.lastSeenAt) : 'never'}
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </Box>
        )}
      </SectionCard>
    </Box>
  );
}
