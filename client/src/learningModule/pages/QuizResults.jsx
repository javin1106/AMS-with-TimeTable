import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Flex,
  Grid,
  HStack,
  Heading,
  Progress,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Table,
  Tabs,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import { EmptyState, ErrorState, Loading, SectionCard, StatTile } from '../components/common';
import { richTextToPlain } from '../richTextUtils';
import { formatDateTime } from '../format';

const duration = (seconds) => {
  if (!seconds) return '—';
  const mins = Math.floor(seconds / 60);
  return mins >= 1 ? `${mins}m ${seconds % 60}s` : `${seconds}s`;
};

const bandColor = (percent) =>
  percent === null ? 'gray' : percent >= 70 ? 'green' : percent >= 40 ? 'orange' : 'red';

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

  const { quiz, attempts, summary, perQuestion, perSection, distribution, resultsVisible } = data;
  const maxBand = Math.max(1, ...distribution.map((band) => band.count));

  return (
    <Box>
      <Flex justify="space-between" align="flex-start" mb={4} gap={3} wrap="wrap">
        <Box>
          <Button size="sm" variant="ghost" onClick={() => navigate(`/learning/class/${classId}/quizzes`)}>
            ← Back to quizzes
          </Button>
          <Heading size="md" mt={1}>
            {quiz.title}
          </Heading>
          <Text fontSize="sm" color="gray.500">
            {quiz.questions.length} questions · {quiz.totalMarks} marks ·{' '}
            {quiz.settings.deliveryMode === 'one_at_a_time' ? 'one at a time' : 'all on one page'}
            {quiz.settings.negativeMarking > 0 && ` · −${quiz.settings.negativeMarking} per wrong answer`}
          </Text>
        </Box>
        <Button as="a" href={lmApi.quizResultsCsvUrl(classId, quizId)} size="sm" variant="outline">
          Export CSV
        </Button>
      </Flex>

      {!resultsVisible && (
        <Alert status="info" borderRadius="md" mb={4} fontSize="sm">
          <AlertIcon />
          Results are scheduled for release on {formatDateTime(quiz.settings.resultReleaseAt)} — students
          cannot see their scores yet, but you can.
        </Alert>
      )}

      <Grid templateColumns={{ base: '1fr 1fr', md: 'repeat(6, 1fr)' }} gap={3} mb={4}>
        <StatTile label="Submitted" value={`${summary.submitted}/${summary.enrolled}`} />
        <StatTile label="In progress" value={summary.inProgress} accent="orange.500" />
        <StatTile label="Not started" value={summary.notStarted} accent="gray.500" />
        <StatTile label="Average" value={summary.average === null ? '—' : `${summary.average}%`} accent="blue.500" />
        <StatTile label="Pass rate" value={summary.passRate === null ? '—' : `${summary.passRate}%`} accent="green.500" />
        <StatTile label="Avg time" value={duration(summary.avgDurationSec)} />
      </Grid>

      {(summary.flagged > 0 || summary.terminated > 0) && (
        <Alert status="warning" borderRadius="md" mb={4} fontSize="sm">
          <AlertIcon />
          <Box>
            <Text fontWeight="600">
              {summary.flagged} attempt(s) recorded a proctoring event
              {summary.terminated > 0 && `, ${summary.terminated} ended automatically`}
            </Text>
            <Text fontSize="xs">See the Attempts tab for who and what.</Text>
          </Box>
        </Alert>
      )}

      <Tabs colorScheme="purple" variant="enclosed">
        <TabList>
          <Tab fontSize="sm">Attempts ({attempts.length})</Tab>
          <Tab fontSize="sm">Question analysis</Tab>
          {perSection.length > 0 && <Tab fontSize="sm">Sections</Tab>}
          <Tab fontSize="sm">Distribution</Tab>
        </TabList>

        <TabPanels>
          {/* ---- attempts ---- */}
          <TabPanel px={0}>
            {attempts.length === 0 ? (
              <EmptyState icon="📊" title="No attempts yet" description="Results appear as students sit the test." />
            ) : (
              <SectionCard>
                <Box overflowX="auto">
                  <Table size="sm">
                    <Thead>
                      <Tr>
                        <Th>Student</Th>
                        <Th>Roll</Th>
                        <Th isNumeric>#</Th>
                        <Th isNumeric>Score</Th>
                        <Th isNumeric>%</Th>
                        <Th>Result</Th>
                        <Th isNumeric>✓</Th>
                        <Th isNumeric>✗</Th>
                        <Th isNumeric>—</Th>
                        <Th isNumeric>Neg</Th>
                        <Th isNumeric>Time</Th>
                        <Th>Flags</Th>
                        <Th>Submitted</Th>
                      </Tr>
                    </Thead>
                    <Tbody>
                      {attempts.map((attempt) => (
                        <Tr key={attempt._id} bg={attempt.status === 'terminated' ? 'red.50' : undefined}>
                          <Td>{attempt.studentName || attempt.studentEmail}</Td>
                          <Td fontSize="xs">{attempt.rollNumber}</Td>
                          <Td isNumeric>{attempt.attemptNumber}</Td>
                          <Td isNumeric>
                            {attempt.score}/{attempt.maxScore}
                          </Td>
                          <Td isNumeric>{attempt.percent}%</Td>
                          <Td>
                            {attempt.status === 'in_progress' ? (
                              <Badge colorScheme="orange">in progress</Badge>
                            ) : attempt.status === 'terminated' ? (
                              <Badge colorScheme="red">terminated</Badge>
                            ) : (
                              <Badge colorScheme={attempt.passed ? 'green' : 'red'}>
                                {attempt.passed ? 'Pass' : 'Fail'}
                              </Badge>
                            )}
                          </Td>
                          <Td isNumeric color="green.600">
                            {attempt.totalCorrect}
                          </Td>
                          <Td isNumeric color="red.600">
                            {attempt.totalWrong}
                          </Td>
                          <Td isNumeric color="gray.500">
                            {attempt.totalUnattempted}
                          </Td>
                          <Td isNumeric>{attempt.negativeApplied ? `−${attempt.negativeApplied}` : '—'}</Td>
                          <Td isNumeric fontSize="xs">
                            {duration(attempt.durationSec)}
                          </Td>
                          <Td>
                            {attempt.tabSwitches > 0 && (
                              <Badge colorScheme="orange" fontSize="0.6rem" mr={1}>
                                {attempt.tabSwitches} switch
                              </Badge>
                            )}
                            {(attempt.violations || []).some((v) => v.type === 'fullscreen_exit') && (
                              <Badge colorScheme="purple" fontSize="0.6rem" mr={1}>
                                fs
                              </Badge>
                            )}
                            {attempt.device?.isMobile && (
                              <Badge colorScheme="gray" fontSize="0.6rem">
                                mobile
                              </Badge>
                            )}
                          </Td>
                          <Td fontSize="xs">{attempt.submittedAt ? formatDateTime(attempt.submittedAt) : '—'}</Td>
                        </Tr>
                      ))}
                    </Tbody>
                  </Table>
                </Box>
                {attempts.some((attempt) => attempt.terminationReason) && (
                  <Box mt={3}>
                    <Text fontSize="xs" fontWeight="600" mb={1}>
                      Termination reasons
                    </Text>
                    {attempts
                      .filter((attempt) => attempt.terminationReason)
                      .map((attempt) => (
                        <Text key={attempt._id} fontSize="xs" color="gray.600">
                          {attempt.studentName}: {attempt.terminationReason}
                        </Text>
                      ))}
                  </Box>
                )}
              </SectionCard>
            )}
          </TabPanel>

          {/* ---- question analysis ---- */}
          <TabPanel px={0}>
            <SectionCard
              title="Question analysis"
              subtitle="Success rate is measured over students who actually attempted the question, so a high skip rate shows up separately rather than masquerading as difficulty."
            >
              <Box overflowX="auto">
                <Table size="sm">
                  <Thead>
                    <Tr>
                      <Th>Q</Th>
                      <Th>Question</Th>
                      <Th>Type</Th>
                      <Th>Level</Th>
                      <Th isNumeric>Correct</Th>
                      <Th w="140px">Success</Th>
                      <Th isNumeric>Skipped</Th>
                      <Th isNumeric>Avg time</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {perQuestion.map((entry, index) => (
                      <Tr key={entry.questionId}>
                        <Td>{index + 1}</Td>
                        <Td maxW="260px">
                          <Text fontSize="xs" noOfLines={2}>
                            {richTextToPlain(entry.question)}
                          </Text>
                          {entry.sectionName && (
                            <Badge fontSize="0.55rem" colorScheme="purple">
                              {entry.sectionName}
                            </Badge>
                          )}
                        </Td>
                        <Td fontSize="xs">{entry.type}</Td>
                        <Td fontSize="xs">{entry.difficulty}</Td>
                        <Td isNumeric fontSize="xs">
                          {entry.correct}/{entry.attempted}
                        </Td>
                        <Td>
                          <Progress
                            value={entry.correctPercent || 0}
                            size="sm"
                            borderRadius="full"
                            colorScheme={bandColor(entry.correctPercent)}
                          />
                          <Text fontSize="xs" color="gray.500">
                            {entry.correctPercent === null ? '—' : `${entry.correctPercent}%`}
                          </Text>
                        </Td>
                        <Td isNumeric fontSize="xs" color={entry.skipRate > 30 ? 'orange.600' : undefined}>
                          {entry.skipRate === null ? '—' : `${entry.skipRate}%`}
                        </Td>
                        <Td isNumeric fontSize="xs">
                          {entry.avgTimeSec === null ? '—' : `${entry.avgTimeSec}s`}
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              </Box>
            </SectionCard>
          </TabPanel>

          {/* ---- sections ---- */}
          {perSection.length > 0 && (
            <TabPanel px={0}>
              <SectionCard title="Section performance">
                {perSection.map((section) => (
                  <Box key={section.sectionName} py={3} borderBottomWidth="1px" borderColor="gray.100">
                    <Flex justify="space-between" mb={1} gap={3} wrap="wrap">
                      <Text fontSize="sm" fontWeight="600">
                        {section.sectionName}
                      </Text>
                      <HStack fontSize="xs" spacing={3}>
                        <Text color="green.600">{section.correct} correct</Text>
                        <Text color="red.600">{section.wrong} wrong</Text>
                        <Text color="gray.500">{section.unattempted} skipped</Text>
                        <Text fontWeight="600">
                          {section.avgPercent === null ? '—' : `${section.avgPercent}%`}
                        </Text>
                      </HStack>
                    </Flex>
                    <Progress
                      value={section.avgPercent || 0}
                      size="sm"
                      borderRadius="full"
                      colorScheme={bandColor(section.avgPercent)}
                    />
                    <Text fontSize="xs" color="gray.500" mt={1}>
                      {duration(Math.round(section.timeSpentSec / Math.max(1, section.count)))} average per
                      student
                    </Text>
                  </Box>
                ))}
              </SectionCard>
            </TabPanel>
          )}

          {/* ---- distribution ---- */}
          <TabPanel px={0}>
            <SectionCard title="Score distribution">
              {distribution.map((band) => (
                <Flex key={band.label} align="center" gap={3} py={2}>
                  <Text fontSize="xs" w="70px" color="gray.600">
                    {band.label}
                  </Text>
                  <Box flex="1" bg="gray.100" borderRadius="full" h="18px" overflow="hidden">
                    <Box
                      w={`${(band.count / maxBand) * 100}%`}
                      h="100%"
                      bg="purple.400"
                      borderRadius="full"
                      transition="width 0.3s"
                    />
                  </Box>
                  <Text fontSize="xs" w="30px" textAlign="right" fontWeight="600">
                    {band.count}
                  </Text>
                </Flex>
              ))}
              <HStack mt={4} spacing={6} fontSize="sm" wrap="wrap">
                <Text>
                  Median: <b>{summary.median === null ? '—' : `${summary.median}%`}</b>
                </Text>
                <Text>
                  Highest: <b>{summary.highest === null ? '—' : `${summary.highest}%`}</b>
                </Text>
                <Text>
                  Lowest: <b>{summary.lowest === null ? '—' : `${summary.lowest}%`}</b>
                </Text>
                {summary.totalNegative > 0 && (
                  <Text>
                    Marks lost to negatives: <b>{summary.totalNegative}</b>
                  </Text>
                )}
              </HStack>
            </SectionCard>
          </TabPanel>
        </TabPanels>
      </Tabs>
    </Box>
  );
}
