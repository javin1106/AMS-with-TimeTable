import React, { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useNavigate, useOutletContext } from 'react-router-dom';
import {
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Heading,
  Input,
  Text,
  useToast,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import { EmptyState, ErrorState, Loading, SectionCard } from '../components/common';

/**
 * Lists the class's parameterised tutorials — the ones where every student
 * gets their own numbers.
 */
export default function Tutorials() {
  const { classId, isTeacher } = useOutletContext();
  const [tutorials, setTutorials] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dueDates, setDueDates] = useState({});
  const navigate = useNavigate();
  const toast = useToast();

  const load = useCallback(async () => {
    setError(null);
    try {
      setTutorials(await lmApi.listTutorials(classId));
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
    try {
      const created = await lmApi.createTutorial(classId, {
        title: 'Untitled tutorial',
        questions: [
          {
            prompt: 'A resistor of {{R}} Ω carries a current of {{I}} A. Find the power dissipated.',
            constraint: 'R > 0',
            solutionSteps: 'P = I²R = {{I}}² × {{R}}',
            variables: [
              { name: 'R', type: 'integer', min: 10, max: 100, step: 5, unit: 'Ω' },
              { name: 'I', type: 'range', min: 0.5, max: 3, step: 0.5, decimals: 1, unit: 'A' },
            ],
            answers: [
              { key: 'p', label: 'Power', formula: 'I^2*R', unit: 'W', marks: 5, tolerancePercent: 1 },
            ],
          },
        ],
      });
      navigate(`/learning/class/${classId}/tutorial/${created._id}/edit`);
    } catch (err) {
      toast({ status: 'error', title: err.message });
    }
  };

  const togglePublish = async (tutorial) => {
    try {
      const result = await lmApi.publishTutorial(classId, tutorial._id, {
        publish: !tutorial.published,
        dueDate: dueDates[tutorial._id] || undefined,
      });
      toast({
        status: 'success',
        title: result.published ? 'Published to the class' : 'Unpublished',
      });
      await load();
    } catch (err) {
      toast({
        status: 'error',
        title: err.message,
        description: err.payload?.errors?.slice(0, 3).join(' · '),
        duration: 10000,
      });
    }
  };

  const remove = async (tutorial) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete "${tutorial.title}" and every student attempt at it?`)) return;
    try {
      await lmApi.deleteTutorial(classId, tutorial._id);
      await load();
    } catch (err) {
      toast({ status: 'error', title: err.message });
    }
  };

  if (loading) return <Loading label="Loading tutorials…" />;

  return (
    <Box>
      <Flex justify="space-between" align="flex-start" mb={4} gap={3} wrap="wrap">
        <Box>
          <Heading size="md">Tutorials</Heading>
          <Text fontSize="sm" color="gray.500">
            Numerical practice where every student gets their own values and answers are marked
            against a formula.
          </Text>
        </Box>
        {isTeacher && (
          <Button colorScheme="teal" onClick={create}>
            + New tutorial
          </Button>
        )}
      </Flex>

      <ErrorState error={error} onRetry={load} />

      {tutorials.length === 0 ? (
        <EmptyState
          icon="🧮"
          title="No tutorials yet"
          description={
            isTeacher
              ? 'Write a question once with variables and ranges — each student is given different numbers, and their answers are checked against your formula.'
              : 'Your teacher has not set any numerical tutorials yet.'
          }
          action={
            isTeacher ? (
              <Button colorScheme="teal" onClick={create}>
                Create your first tutorial
              </Button>
            ) : null
          }
        />
      ) : (
        tutorials.map((tutorial) => (
          <SectionCard key={tutorial._id} mb={3}>
            <Flex align="center" gap={4} wrap="wrap">
              <Box flex="1" minW="220px">
                <HStack>
                  <Heading size="sm">{tutorial.title}</Heading>
                  {isTeacher && (
                    <Badge colorScheme={tutorial.published ? 'green' : 'gray'}>
                      {tutorial.published ? 'Published' : 'Draft'}
                    </Badge>
                  )}
                  {tutorial.topicName && <Badge colorScheme="gray">{tutorial.topicName}</Badge>}
                </HStack>
                {tutorial.description && (
                  <Text fontSize="sm" color="gray.600" noOfLines={2} mt={1}>
                    {tutorial.description}
                  </Text>
                )}
                <Text fontSize="xs" color="gray.500" mt={1}>
                  {tutorial.questionCount ?? tutorial.questions?.length ?? 0} questions ·{' '}
                  {tutorial.totalMarks} marks
                  {tutorial.settings?.attemptsAllowed > 1
                    ? ` · ${tutorial.settings.attemptsAllowed} attempts`
                    : ''}
                </Text>
                {isTeacher && tutorial.stats && (
                  <Text fontSize="xs" color="gray.500">
                    {tutorial.stats.attempts} submission(s)
                    {tutorial.stats.avg !== null && tutorial.stats.avg !== undefined
                      ? ` · avg ${Math.round(tutorial.stats.avg * 10) / 10}%`
                      : ''}
                  </Text>
                )}
                {!isTeacher && tutorial.bestAttempt && (
                  <Badge colorScheme={tutorial.bestAttempt.passed ? 'green' : 'red'} mt={1}>
                    Best: {tutorial.bestAttempt.score}/{tutorial.bestAttempt.maxScore} (
                    {tutorial.bestAttempt.percent}%)
                  </Badge>
                )}
              </Box>

              <HStack>
                {isTeacher ? (
                  <>
                    {!tutorial.published && (
                      <Input
                        size="sm"
                        type="datetime-local"
                        maxW="200px"
                        value={dueDates[tutorial._id] || ''}
                        onChange={(event) =>
                          setDueDates((prev) => ({ ...prev, [tutorial._id]: event.target.value }))
                        }
                      />
                    )}
                    <Button
                      as={RouterLink}
                      to={`/learning/class/${classId}/tutorial/${tutorial._id}/edit`}
                      size="sm"
                      variant="outline"
                    >
                      Edit
                    </Button>
                    <Button
                      as={RouterLink}
                      to={`/learning/class/${classId}/tutorial/${tutorial._id}/results`}
                      size="sm"
                      variant="outline"
                    >
                      Results
                    </Button>
                    <Button
                      size="sm"
                      colorScheme={tutorial.published ? 'gray' : 'green'}
                      onClick={() => togglePublish(tutorial)}
                    >
                      {tutorial.published ? 'Unpublish' : 'Publish'}
                    </Button>
                    <Button size="sm" variant="ghost" colorScheme="red" onClick={() => remove(tutorial)}>
                      ✕
                    </Button>
                  </>
                ) : (
                  <Button
                    as={RouterLink}
                    to={`/learning/class/${classId}/tutorial/${tutorial._id}`}
                    size="sm"
                    colorScheme="teal"
                    isDisabled={!tutorial.open}
                  >
                    {tutorial.attemptsUsed > 0 ? 'Open' : 'Start'}
                  </Button>
                )}
              </HStack>
            </Flex>
          </SectionCard>
        ))
      )}
    </Box>
  );
}
