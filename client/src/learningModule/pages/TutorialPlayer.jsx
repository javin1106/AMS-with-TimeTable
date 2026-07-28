import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Code,
  Divider,
  Flex,
  HStack,
  Heading,
  Input,
  InputGroup,
  InputRightAddon,
  Progress,
  Text,
  useToast,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import { ErrorState, Loading, SectionCard, StatTile } from '../components/common';
import RichText from '../components/RichText';
import { formatDateTime } from '../format';

const answerId = (questionId, key) => `${questionId}:${key}`;

/**
 * The student's sitting of a parameterised tutorial. Their variable values
 * come from the server and are fixed for this attempt, so the paper is stable
 * across reloads.
 */
export default function TutorialPlayer() {
  const { classId } = useOutletContext();
  const { tutorialId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [tutorial, setTutorial] = useState(null);
  const [attempt, setAttempt] = useState(null);
  const [meta, setMeta] = useState({ attemptsUsed: 0, attemptsAllowed: 1, exhausted: false });
  const [inputs, setInputs] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState('');
  const [savedAt, setSavedAt] = useState(null);
  const submittedRef = useRef(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [detail, sitting] = await Promise.all([
        lmApi.getTutorial(classId, tutorialId),
        lmApi.myTutorialAttempt(classId, tutorialId),
      ]);
      setTutorial(detail);
      setAttempt(sitting.attempt);
      setMeta({
        attemptsUsed: sitting.attemptsUsed,
        attemptsAllowed: sitting.attemptsAllowed,
        exhausted: Boolean(sitting.exhausted),
      });

      // Re-hydrate a saved draft so a student can leave and come back.
      const restored = {};
      (sitting.attempt?.responses || []).forEach((response) => {
        restored[answerId(response.questionId, response.answerKey)] = response.raw;
      });
      setInputs(restored);
      submittedRef.current = sitting.attempt?.status !== 'in_progress';
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId, tutorialId]);

  useEffect(() => {
    load();
  }, [load]);

  const responses = useMemo(
    () =>
      Object.entries(inputs)
        .map(([composite, raw]) => {
          const separator = composite.lastIndexOf(':');
          return {
            questionId: composite.slice(0, separator),
            answerKey: composite.slice(separator + 1),
            raw,
          };
        })
        .filter((response) => String(response.raw ?? '').trim() !== ''),
    [inputs],
  );

  const totalSlots = useMemo(
    () => (attempt?.questions || []).reduce((sum, question) => sum + question.answers.length, 0),
    [attempt],
  );

  const saveDraft = async () => {
    if (!attempt || attempt.status !== 'in_progress') return;
    setBusy('save');
    try {
      const result = await lmApi.saveTutorialAttempt(classId, attempt._id, responses);
      setSavedAt(result.savedAt);
      toast({ status: 'success', title: 'Progress saved', duration: 1500 });
    } catch (err) {
      toast({ status: 'error', title: err.message });
    } finally {
      setBusy('');
    }
  };

  const submit = async () => {
    if (submittedRef.current) return;
    // eslint-disable-next-line no-alert
    if (!window.confirm('Submit this tutorial? Your answers will be marked immediately.')) return;

    submittedRef.current = true;
    setBusy('submit');
    try {
      const result = await lmApi.submitTutorialAttempt(classId, attempt._id, responses);
      setAttempt(result.attempt);
      toast({
        status: result.attempt.passed ? 'success' : 'info',
        title: `Scored ${result.attempt.score}/${result.attempt.maxScore} (${result.attempt.percent}%)`,
      });
    } catch (err) {
      submittedRef.current = false;
      toast({ status: 'error', title: err.message });
    } finally {
      setBusy('');
    }
  };

  if (loading) return <Loading label="Preparing your questions…" />;
  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!tutorial) return null;

  if (!attempt) {
    return (
      <SectionCard title={tutorial.title}>
        <Alert status="info" borderRadius="md">
          <AlertIcon />
          This tutorial is not open for you right now.
        </Alert>
        <Button mt={4} size="sm" onClick={() => navigate(`/learning/class/${classId}/tutorials`)}>
          Back to tutorials
        </Button>
      </SectionCard>
    );
  }

  const submitted = attempt.status !== 'in_progress';
  const answeredCount = responses.length;
  const byKey = new Map((attempt.responses || []).map((r) => [answerId(r.questionId, r.answerKey), r]));

  return (
    <Box>
      <Button size="sm" variant="ghost" mb={2} onClick={() => navigate(`/learning/class/${classId}/tutorials`)}>
        ← Back to tutorials
      </Button>

      <Flex justify="space-between" align="flex-start" gap={3} mb={4} wrap="wrap">
        <Box>
          <Heading size="md">{tutorial.title}</Heading>
          {tutorial.description && (
            <Text fontSize="sm" color="gray.600">
              {tutorial.description}
            </Text>
          )}
          <HStack fontSize="xs" color="gray.500" mt={1} wrap="wrap">
            <Text>
              Attempt {attempt.attemptNumber} of {meta.attemptsAllowed}
            </Text>
            {tutorial.settings?.dueDate && <Text>Due {formatDateTime(tutorial.settings.dueDate)}</Text>}
            {attempt.late && <Badge colorScheme="red">Late</Badge>}
          </HStack>
        </Box>
        {!submitted && (
          <HStack>
            <Button size="sm" variant="outline" onClick={saveDraft} isLoading={busy === 'save'}>
              Save progress
            </Button>
            <Button size="sm" colorScheme="teal" onClick={submit} isLoading={busy === 'submit'}>
              Submit
            </Button>
          </HStack>
        )}
      </Flex>

      <Alert status="info" borderRadius="md" mb={4} fontSize="sm">
        <AlertIcon />
        <Box>
          Your figures are unique to you — comparing final answers with a classmate will not help, but
          comparing <em>method</em> will. You may type an expression such as <Code fontSize="xs">2*pi*3</Code>{' '}
          instead of a decimal.
        </Box>
      </Alert>

      {submitted && (
        <Flex gap={3} mb={5} wrap="wrap">
          <StatTile label="Score" value={`${attempt.score}/${attempt.maxScore}`} />
          <StatTile
            label="Percent"
            value={`${attempt.percent}%`}
            accent={attempt.passed ? 'green.500' : 'red.500'}
          />
          <StatTile
            label="Outcome"
            value={attempt.passed ? 'Passed' : 'Not passed'}
            accent={attempt.passed ? 'green.500' : 'red.500'}
          />
          {meta.attemptsUsed < meta.attemptsAllowed && (
            <Box>
              <Button
                mt={2}
                size="sm"
                colorScheme="teal"
                variant="outline"
                onClick={async () => {
                  submittedRef.current = false;
                  setLoading(true);
                  await load();
                }}
              >
                Start attempt {meta.attemptsUsed + 1}
              </Button>
            </Box>
          )}
        </Flex>
      )}

      {attempt.teacherFeedback && (
        <Alert status="success" borderRadius="md" mb={4} fontSize="sm">
          <AlertIcon />
          <Box>
            <Text fontWeight="600">Teacher feedback</Text>
            <Text>{attempt.teacherFeedback}</Text>
          </Box>
        </Alert>
      )}

      {!submitted && totalSlots > 0 && (
        <Progress
          value={(answeredCount / totalSlots) * 100}
          size="xs"
          colorScheme="teal"
          borderRadius="full"
          mb={4}
        />
      )}

      {attempt.questions.map((question, index) => (
        <SectionCard key={question.questionId} mb={4}>
          <Flex justify="space-between" gap={3} mb={2}>
            <Heading size="sm">Question {index + 1}</Heading>
            <Badge colorScheme="gray">
              {question.answers.reduce((sum, a) => sum + a.marks, 0)} marks
            </Badge>
          </Flex>

          <Box mb={3}>
            <RichText>{question.prompt}</RichText>
          </Box>

          <HStack fontSize="xs" color="gray.500" mb={3} wrap="wrap">
            <Text>Your values:</Text>
            {Object.entries(question.values).map(([name, value]) => (
              <Code key={name} fontSize="xs">
                {name} = {String(value)}
              </Code>
            ))}
          </HStack>

          {question.hint && !submitted && (
            <Flex fontSize="xs" color="blue.600" mb={3} gap={1}>
              <Text>💡</Text>
              <RichText fontSize="xs" color="blue.600">
                {question.hint}
              </RichText>
            </Flex>
          )}

          {question.answers.map((answer) => {
            const id = answerId(question.questionId, answer.key);
            const graded = byKey.get(id);
            return (
              <Box key={answer.key} mb={3}>
                <Flex align="center" gap={3} wrap="wrap">
                  <Text fontSize="sm" fontWeight="500" minW="110px">
                    {answer.label}
                  </Text>
                  <InputGroup size="sm" maxW="240px">
                    <Input
                      value={inputs[id] ?? ''}
                      isReadOnly={submitted}
                      placeholder="Your answer"
                      borderColor={
                        submitted ? (graded?.correct ? 'green.400' : 'red.400') : undefined
                      }
                      onChange={(event) =>
                        setInputs((prev) => ({ ...prev, [id]: event.target.value }))
                      }
                    />
                    {answer.unit && <InputRightAddon>{answer.unit}</InputRightAddon>}
                  </InputGroup>
                  <Text fontSize="xs" color="gray.500">
                    {answer.marks} mark{answer.marks === 1 ? '' : 's'}
                  </Text>
                  {submitted && graded && (
                    <Badge colorScheme={graded.correct ? 'green' : 'red'}>
                      {graded.correct ? `+${graded.awarded}` : '0'}
                    </Badge>
                  )}
                  {answer.unavailable && (
                    <Badge colorScheme="orange">Not markable — tell your teacher</Badge>
                  )}
                </Flex>
                {submitted && answer.expected !== undefined && (
                  <Text fontSize="xs" color="gray.600" mt={1} ml="122px">
                    Correct answer: <b>{Math.round(answer.expected * 1e6) / 1e6}</b> {answer.unit}
                  </Text>
                )}
              </Box>
            );
          })}

          {submitted && question.solution && (
            <>
              <Divider my={3} />
              <Text fontSize="xs" fontWeight="600" color="gray.600" mb={1}>
                Worked solution
              </Text>
              <RichText>{question.solution}</RichText>
            </>
          )}
        </SectionCard>
      ))}

      {!submitted && (
        <>
          {savedAt && (
            <Text fontSize="xs" color="gray.500" mb={2}>
              Draft saved {formatDateTime(savedAt)}
            </Text>
          )}
          <Button colorScheme="teal" size="lg" w="100%" onClick={submit} isLoading={busy === 'submit'}>
            Submit tutorial ({answeredCount}/{totalSlots} answered)
          </Button>
        </>
      )}
    </Box>
  );
}
