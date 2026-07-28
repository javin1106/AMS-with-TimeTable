import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import {
  Accordion,
  AccordionButton,
  AccordionIcon,
  AccordionItem,
  AccordionPanel,
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Code,
  Flex,
  Grid,
  HStack,
  Heading,
  Input,
  Progress,
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
import { EmptyState, ErrorState, Loading, SectionCard, StatTile } from '../components/common';
import { richTextToPlain } from '../richTextUtils';
import { formatDateTime } from '../format';

/**
 * Teacher's review of a parameterised tutorial.
 *
 * Because every student answered different numbers, the useful signal is
 * per-answer-slot success rate (did they know the method?) rather than a
 * single correct value — that is what the analysis table shows.
 */
export default function TutorialResults() {
  const { classId } = useOutletContext();
  const { tutorialId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [adjust, setAdjust] = useState({});

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await lmApi.tutorialResults(classId, tutorialId));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId, tutorialId]);

  useEffect(() => {
    load();
  }, [load]);

  const applyAdjustment = async (attempt) => {
    const entry = adjust[attempt._id] || {};
    const value = Number(entry.adjustment);
    if (!Number.isFinite(value)) {
      toast({ status: 'error', title: 'Enter a numeric adjustment (may be negative).' });
      return;
    }
    try {
      const result = await lmApi.adjustTutorialAttempt(classId, attempt._id, value, entry.feedback || '');
      toast({ status: 'success', title: `Score set to ${result.score}` });
      setAdjust((prev) => ({ ...prev, [attempt._id]: {} }));
      await load();
    } catch (err) {
      toast({ status: 'error', title: err.message });
    }
  };

  if (loading) return <Loading label="Loading results…" />;
  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!data) return null;

  const { tutorial, attempts, summary, perAnswer } = data;
  const submitted = attempts.filter((attempt) => attempt.status !== 'in_progress');
  const anyWarnings = attempts.some((attempt) => (attempt.warnings || []).length > 0);

  return (
    <Box>
      <Button size="sm" variant="ghost" mb={2} onClick={() => navigate(`/learning/class/${classId}/tutorials`)}>
        ← Back to tutorials
      </Button>
      <Heading size="md" mb={1}>
        {tutorial.title}
      </Heading>
      <Text fontSize="sm" color="gray.500" mb={4}>
        {tutorial.questions.length} questions · {tutorial.totalMarks} marks · every student receives their
        own values
      </Text>

      <Grid templateColumns={{ base: '1fr 1fr', md: 'repeat(5, 1fr)' }} gap={3} mb={5}>
        <StatTile label="Submitted" value={`${summary.submitted}/${summary.enrolled}`} />
        <StatTile label="Started" value={summary.started} />
        <StatTile label="Average" value={summary.average === null ? '—' : `${summary.average}%`} accent="blue.500" />
        <StatTile label="Highest" value={summary.highest === null ? '—' : `${summary.highest}%`} accent="green.500" />
        <StatTile label="Pass rate" value={summary.passRate === null ? '—' : `${summary.passRate}%`} accent="purple.500" />
      </Grid>

      {anyWarnings && (
        <Alert status="warning" borderRadius="md" mb={4} fontSize="sm" alignItems="flex-start">
          <AlertIcon />
          <Box>
            <Text fontWeight="600">Some students received a question that could not be marked.</Text>
            <Text fontSize="xs">
              Usually a variable range that allows a divide-by-zero. Add or widen the question&apos;s
              constraint, then consider an adjustment for the affected students below.
            </Text>
          </Box>
        </Alert>
      )}

      {submitted.length === 0 ? (
        <EmptyState icon="🧮" title="No submissions yet" description="Results appear as students submit." />
      ) : (
        <>
          <SectionCard
            title="Method analysis"
            subtitle="Success rate per answer slot across every student's own figures — a low percentage means the method, not the arithmetic, needs revisiting."
            mb={4}
          >
            <Box overflowX="auto">
              <Table size="sm">
                <Thead>
                  <Tr>
                    <Th>Q</Th>
                    <Th>Answer</Th>
                    <Th>Formula</Th>
                    <Th isNumeric>Correct</Th>
                    <Th w="160px">Success rate</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {perAnswer.map((entry) => (
                    <Tr key={`${entry.questionId}-${entry.answerKey}`}>
                      <Td>{entry.questionIndex}</Td>
                      <Td>{entry.label}</Td>
                      <Td>
                        <Code fontSize="xs">{entry.formula}</Code>
                      </Td>
                      <Td isNumeric>
                        {entry.correct}/{entry.responses}
                      </Td>
                      <Td>
                        <Progress
                          value={entry.correctPercent || 0}
                          size="sm"
                          borderRadius="full"
                          colorScheme={
                            entry.correctPercent === null
                              ? 'gray'
                              : entry.correctPercent >= 70
                                ? 'green'
                                : entry.correctPercent >= 40
                                  ? 'orange'
                                  : 'red'
                          }
                        />
                        <Text fontSize="xs" color="gray.500">
                          {entry.correctPercent === null ? '—' : `${entry.correctPercent}%`}
                        </Text>
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </Box>
          </SectionCard>

          <SectionCard title={`Attempts (${attempts.length})`}>
            <Accordion allowToggle>
              {attempts.map((attempt) => (
                <AccordionItem key={attempt._id}>
                  <AccordionButton>
                    <Flex flex="1" align="center" gap={3} textAlign="left" wrap="wrap">
                      <Text fontSize="sm" fontWeight="500" flex="1" minW="140px">
                        {attempt.studentName || attempt.studentEmail}
                      </Text>
                      <Badge colorScheme={attempt.status === 'in_progress' ? 'gray' : 'blue'}>
                        {attempt.status === 'in_progress' ? 'in progress' : `attempt ${attempt.attemptNumber}`}
                      </Badge>
                      {attempt.status !== 'in_progress' && (
                        <>
                          <Text fontSize="sm" fontWeight="600">
                            {attempt.score}/{attempt.maxScore}
                          </Text>
                          <Badge colorScheme={attempt.passed ? 'green' : 'red'}>{attempt.percent}%</Badge>
                        </>
                      )}
                      {attempt.late && <Badge colorScheme="red">Late</Badge>}
                      {attempt.teacherAdjustment ? (
                        <Badge colorScheme="purple">adjusted {attempt.teacherAdjustment > 0 ? '+' : ''}{attempt.teacherAdjustment}</Badge>
                      ) : null}
                    </Flex>
                    <AccordionIcon />
                  </AccordionButton>

                  <AccordionPanel pb={4}>
                    {attempt.submittedAt && (
                      <Text fontSize="xs" color="gray.500" mb={3}>
                        Submitted {formatDateTime(attempt.submittedAt)} · took{' '}
                        {Math.round(attempt.durationSec / 60)} min
                      </Text>
                    )}

                    {(attempt.warnings || []).length > 0 && (
                      <Alert status="warning" borderRadius="md" mb={3} fontSize="xs">
                        <AlertIcon />
                        {attempt.warnings.join(' · ')}
                      </Alert>
                    )}

                    {(attempt.questions || []).map((question, index) => (
                      <Box key={index} mb={4} borderLeftWidth="3px" borderColor="gray.200" pl={3}>
                        <Text fontSize="sm" fontWeight="500">
                          Q{index + 1}. {richTextToPlain(question.prompt)}
                        </Text>
                        <HStack fontSize="xs" color="gray.500" mt={1} wrap="wrap">
                          {Object.entries(question.values || {}).map(([name, value]) => (
                            <Code key={name} fontSize="xs">
                              {name} = {String(value)}
                            </Code>
                          ))}
                        </HStack>
                        <Table size="sm" mt={2}>
                          <Thead>
                            <Tr>
                              <Th>Answer</Th>
                              <Th>Expected</Th>
                              <Th>Given</Th>
                              <Th isNumeric>Marks</Th>
                            </Tr>
                          </Thead>
                          <Tbody>
                            {(question.expected || []).map((expected) => {
                              const response = (attempt.responses || []).find(
                                (r) =>
                                  String(r.questionId) === String(question.questionId) &&
                                  r.answerKey === expected.key,
                              );
                              return (
                                <Tr key={expected.key}>
                                  <Td>{expected.label}</Td>
                                  <Td>
                                    {expected.value === null
                                      ? '—'
                                      : `${Math.round(expected.value * 1e6) / 1e6} ${expected.unit}`}
                                  </Td>
                                  <Td color={response?.correct ? 'green.600' : 'red.600'}>
                                    {response?.raw || '—'}
                                  </Td>
                                  <Td isNumeric>
                                    {response?.awarded ?? 0}/{expected.marks}
                                  </Td>
                                </Tr>
                              );
                            })}
                          </Tbody>
                        </Table>
                      </Box>
                    ))}

                    {attempt.status !== 'in_progress' && (
                      <Flex gap={2} align="flex-end" wrap="wrap" mt={3}>
                        <Box>
                          <Text fontSize="xs" fontWeight="600" mb={1}>
                            Adjust marks (+/−)
                          </Text>
                          <Input
                            size="sm"
                            w="110px"
                            type="number"
                            placeholder="e.g. 2"
                            value={adjust[attempt._id]?.adjustment ?? ''}
                            onChange={(event) =>
                              setAdjust((prev) => ({
                                ...prev,
                                [attempt._id]: { ...prev[attempt._id], adjustment: event.target.value },
                              }))
                            }
                          />
                        </Box>
                        <Box flex="1" minW="200px">
                          <Text fontSize="xs" fontWeight="600" mb={1}>
                            Feedback
                          </Text>
                          <Input
                            size="sm"
                            placeholder="Method was right, arithmetic slipped"
                            value={adjust[attempt._id]?.feedback ?? ''}
                            onChange={(event) =>
                              setAdjust((prev) => ({
                                ...prev,
                                [attempt._id]: { ...prev[attempt._id], feedback: event.target.value },
                              }))
                            }
                          />
                        </Box>
                        <Button size="sm" colorScheme="blue" onClick={() => applyAdjustment(attempt)}>
                          Apply
                        </Button>
                      </Flex>
                    )}
                  </AccordionPanel>
                </AccordionItem>
              ))}
            </Accordion>
          </SectionCard>
        </>
      )}
    </Box>
  );
}
