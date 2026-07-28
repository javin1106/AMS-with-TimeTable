import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import {
  Badge,
  Box,
  Button,
  Flex,
  Grid,
  Heading,
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
import { formatDateTime } from '../format';

export default function QuizResults() {
  const { classId } = useOutletContext();
  const { quizId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await lmApi.quizResults(classId, quizId));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId, quizId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!data) return null;

  const { quiz, attempts, summary, perQuestion } = data;

  return (
    <Box>
      <Button size="sm" variant="ghost" mb={2} onClick={() => navigate(`/learning/class/${classId}/grades`)}>
        ← Back to quizzes
      </Button>
      <Heading size="md" mb={1}>
        {quiz.title}
      </Heading>
      <Text fontSize="sm" color="gray.500" mb={4}>
        {quiz.questions.length} questions · {quiz.totalMarks} marks
      </Text>

      <Grid templateColumns={{ base: '1fr 1fr', md: 'repeat(5, 1fr)' }} gap={3} mb={5}>
        <StatTile label="Attempts" value={summary.attempts} />
        <StatTile label="Average" value={summary.average === null ? '—' : `${summary.average}%`} accent="blue.500" />
        <StatTile label="Median" value={summary.median === null ? '—' : `${summary.median}%`} />
        <StatTile label="Highest" value={summary.highest === null ? '—' : `${summary.highest}%`} accent="green.500" />
        <StatTile label="Pass rate" value={summary.passRate === null ? '—' : `${summary.passRate}%`} accent="purple.500" />
      </Grid>

      {attempts.length === 0 ? (
        <EmptyState icon="📊" title="No attempts yet" description="Results appear as students take the quiz." />
      ) : (
        <>
          <SectionCard title="Question analysis" subtitle="Low percentages point at topics worth revisiting." mb={4}>
            {perQuestion.map((entry, index) => (
              <Box key={entry.questionId} py={3} borderBottomWidth="1px" borderColor="gray.100">
                <Flex justify="space-between" gap={3} mb={1}>
                  <Text fontSize="sm" noOfLines={2}>
                    Q{index + 1}. {entry.question}
                  </Text>
                  <Badge
                    flexShrink={0}
                    colorScheme={
                      entry.correctPercent === null
                        ? 'gray'
                        : entry.correctPercent >= 70
                          ? 'green'
                          : entry.correctPercent >= 40
                            ? 'orange'
                            : 'red'
                    }
                  >
                    {entry.correctPercent === null ? '—' : `${entry.correctPercent}% correct`}
                  </Badge>
                </Flex>
                <Progress
                  value={entry.correctPercent || 0}
                  size="xs"
                  borderRadius="full"
                  colorScheme={
                    entry.correctPercent >= 70 ? 'green' : entry.correctPercent >= 40 ? 'orange' : 'red'
                  }
                />
                <Text fontSize="xs" color="gray.500" mt={1}>
                  {entry.correct}/{entry.responses} correct · {entry.difficulty}
                  {entry.topic ? ` · ${entry.topic}` : ''}
                </Text>
              </Box>
            ))}
          </SectionCard>

          <SectionCard title="Attempts">
            <Box overflowX="auto">
              <Table size="sm">
                <Thead>
                  <Tr>
                    <Th>Student</Th>
                    <Th isNumeric>Attempt</Th>
                    <Th isNumeric>Score</Th>
                    <Th isNumeric>Percent</Th>
                    <Th>Result</Th>
                    <Th isNumeric>Time</Th>
                    <Th>Submitted</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {attempts.map((attempt) => (
                    <Tr key={attempt._id}>
                      <Td>{attempt.studentName}</Td>
                      <Td isNumeric>{attempt.attemptNumber}</Td>
                      <Td isNumeric>
                        {attempt.score}/{attempt.maxScore}
                      </Td>
                      <Td isNumeric>{attempt.percent}%</Td>
                      <Td>
                        <Badge colorScheme={attempt.passed ? 'green' : 'red'}>
                          {attempt.passed ? 'Pass' : 'Fail'}
                        </Badge>
                      </Td>
                      <Td isNumeric>{Math.round(attempt.durationSec / 60)}m</Td>
                      <Td fontSize="xs">{formatDateTime(attempt.submittedAt)}</Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </Box>
          </SectionCard>
        </>
      )}
    </Box>
  );
}
