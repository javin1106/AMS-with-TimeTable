import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Checkbox,
  Divider,
  Flex,
  HStack,
  Heading,
  Input,
  Progress,
  Radio,
  RadioGroup,
  Stack,
  Text,
  useToast,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import { ErrorState, Loading, SectionCard, StatTile } from '../components/common';
import RichText from '../components/RichText';

const formatClock = (seconds) => {
  const mins = Math.floor(Math.max(0, seconds) / 60);
  const secs = Math.max(0, seconds) % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

function ResultView({ result, quizTitle, onDone }) {
  const { attempt, review } = result;
  return (
    <Box>
      <SectionCard title={`${quizTitle} — result`}>
        <Flex gap={4} wrap="wrap" mb={4}>
          <StatTile label="Score" value={`${attempt.score}/${attempt.maxScore}`} />
          <StatTile label="Percent" value={`${attempt.percent}%`} accent={attempt.passed ? 'green.500' : 'red.500'} />
          <StatTile label="Outcome" value={attempt.passed ? 'Passed' : 'Not passed'} accent={attempt.passed ? 'green.500' : 'red.500'} />
          <StatTile label="Time taken" value={formatClock(attempt.durationSec)} />
        </Flex>
        <Progress value={attempt.percent} colorScheme={attempt.passed ? 'green' : 'red'} borderRadius="full" mb={4} />

        {review ? (
          review.map((entry, index) => {
            const correct = entry.yourAnswer?.correct;
            return (
              <Box
                key={index}
                borderWidth="1px"
                borderLeftWidth="4px"
                borderLeftColor={correct ? 'green.400' : 'red.400'}
                borderColor="gray.200"
                borderRadius="md"
                p={4}
                mb={3}
              >
                <Flex justify="space-between" gap={3}>
                  <Box flex="1" minW={0}>
                    <Text fontSize="sm" fontWeight="600" mb={1}>
                      Q{index + 1}.
                    </Text>
                    <RichText>{entry.question}</RichText>
                  </Box>
                  <Badge colorScheme={correct ? 'green' : 'red'}>
                    {correct ? 'Correct' : 'Incorrect'} · {entry.yourAnswer?.awarded ?? 0}
                  </Badge>
                </Flex>

                {entry.options?.length > 0 && (
                  <Stack mt={2} spacing={1}>
                    {entry.options.map((option, optionIndex) => {
                      const isCorrect = (entry.correctAnswers || []).map(String).includes(String(optionIndex));
                      const chose = (entry.yourAnswer?.selected || []).map(String).includes(String(optionIndex));
                      return (
                        <Flex
                          key={optionIndex}
                          gap={2}
                          px={2}
                          py={1}
                          borderRadius="sm"
                          bg={isCorrect ? 'green.50' : chose ? 'red.50' : 'transparent'}
                        >
                          <Text fontSize="sm" flexShrink={0}>
                            {isCorrect ? '✓' : chose ? '✗' : '\u00a0'}
                          </Text>
                          <RichText color={isCorrect ? 'green.800' : chose ? 'red.800' : 'gray.700'}>
                            {option}
                          </RichText>
                        </Flex>
                      );
                    })}
                  </Stack>
                )}

                {entry.type === 'short' && (
                  <Text fontSize="sm" mt={2} color="gray.600">
                    Your answer: <b>{entry.yourAnswer?.text || '—'}</b> · Expected:{' '}
                    <b>{(entry.correctAnswers || []).join(', ')}</b>
                  </Text>
                )}

                {entry.explanation && (
                  <Box mt={2} bg="blue.50" borderRadius="md" px={3} py={2}>
                    <RichText>{entry.explanation}</RichText>
                  </Box>
                )}
                {entry.sourceExcerpt && (
                  <Text fontSize="xs" color="gray.500" mt={2} fontStyle="italic">
                    From the lecture: “{entry.sourceExcerpt}”
                  </Text>
                )}
              </Box>
            );
          })
        ) : (
          <Alert status="info" borderRadius="md">
            <AlertIcon />
            Your teacher has hidden the answer key for this quiz.
          </Alert>
        )}

        <Button mt={4} onClick={onDone}>
          Done
        </Button>
      </SectionCard>
    </Box>
  );
}

export default function QuizPlayer() {
  const { classId } = useOutletContext();
  const { quizId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [quiz, setQuiz] = useState(null);
  const [attempt, setAttempt] = useState(null);
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [remaining, setRemaining] = useState(null);
  const submittedRef = useRef(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setQuiz(await lmApi.getQuiz(classId, quizId));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId, quizId]);

  useEffect(() => {
    load();
  }, [load]);

  const submit = useCallback(
    async (auto = false) => {
      if (submittedRef.current || !attempt) return;
      submittedRef.current = true;
      setSubmitting(true);
      try {
        const payload = Object.entries(answers).map(([questionId, value]) => ({
          questionId,
          selected: Array.isArray(value) ? value : value === undefined || value === '' ? [] : [value],
          text: typeof value === 'string' && !Array.isArray(value) ? value : '',
        }));
        const submitted = await lmApi.submitAttempt(classId, attempt._id, payload);
        setResult(submitted);
        if (auto) toast({ status: 'warning', title: 'Time is up — your answers were submitted.' });
      } catch (err) {
        submittedRef.current = false;
        toast({ status: 'error', title: err.message });
      } finally {
        setSubmitting(false);
      }
    },
    [answers, attempt, classId, toast],
  );

  // Countdown for timed quizzes; auto-submits when it hits zero.
  useEffect(() => {
    if (!attempt || !quiz?.settings?.timeLimitMinutes) return undefined;
    const deadline = new Date(attempt.startedAt).getTime() + quiz.settings.timeLimitMinutes * 60000;
    const tick = () => {
      const left = Math.round((deadline - Date.now()) / 1000);
      setRemaining(left);
      if (left <= 0) submit(true);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [attempt, quiz, submit]);

  const start = async () => {
    try {
      const started = await lmApi.startAttempt(classId, quizId);
      submittedRef.current = false;
      setAttempt(started.attempt);
      setQuiz((prev) => ({ ...prev, ...started.quiz }));
      setAnswers({});
      setResult(null);
    } catch (err) {
      toast({ status: 'error', title: err.message });
    }
  };

  const answered = useMemo(
    () => Object.values(answers).filter((v) => (Array.isArray(v) ? v.length : v !== '' && v !== undefined)).length,
    [answers],
  );

  if (loading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!quiz) return null;

  if (result) {
    return (
      <ResultView
        result={result}
        quizTitle={quiz.title}
        onDone={() => navigate(`/learning/class/${classId}/grades`)}
      />
    );
  }

  if (!attempt) {
    const attemptsLeft = (quiz.settings?.attemptsAllowed || 1) - (quiz.attemptsUsed || 0);
    return (
      <SectionCard title={quiz.title} subtitle={quiz.description}>
        <Flex gap={4} wrap="wrap" mb={4}>
          <StatTile label="Questions" value={quiz.questions?.length || 0} />
          <StatTile label="Total marks" value={quiz.totalMarks} />
          <StatTile
            label="Time limit"
            value={quiz.settings?.timeLimitMinutes ? `${quiz.settings.timeLimitMinutes} min` : 'None'}
          />
          <StatTile label="Attempts left" value={Math.max(0, attemptsLeft)} accent={attemptsLeft > 0 ? 'green.500' : 'red.500'} />
        </Flex>

        {quiz.attempts?.length > 0 && (
          <Box mb={4}>
            <Heading size="xs" mb={2}>
              Your previous attempts
            </Heading>
            {quiz.attempts.map((previous) => (
              <Flex key={previous._id} justify="space-between" py={2} borderBottomWidth="1px" borderColor="gray.100">
                <Text fontSize="sm">Attempt {previous.attemptNumber}</Text>
                <Badge colorScheme={previous.passed ? 'green' : 'red'}>
                  {previous.score}/{previous.maxScore} ({previous.percent}%)
                </Badge>
              </Flex>
            ))}
          </Box>
        )}

        {!quiz.available && (
          <Alert status="warning" borderRadius="md" mb={4}>
            <AlertIcon />
            This quiz is not open right now.
          </Alert>
        )}

        <Button colorScheme="purple" onClick={start} isDisabled={attemptsLeft <= 0 || !quiz.available}>
          {quiz.attemptsUsed > 0 ? 'Start another attempt' : 'Start quiz'}
        </Button>
      </SectionCard>
    );
  }

  return (
    <Box>
      <Flex
        position="sticky"
        top="72px"
        zIndex={5}
        bg="white"
        borderWidth="1px"
        borderColor="gray.200"
        borderRadius="lg"
        px={4}
        py={3}
        mb={4}
        justify="space-between"
        align="center"
        gap={3}
        wrap="wrap"
      >
        <Box>
          <Heading size="sm">{quiz.title}</Heading>
          <Text fontSize="xs" color="gray.500">
            {answered} of {quiz.questions.length} answered
          </Text>
        </Box>
        <HStack>
          {remaining !== null && (
            <Badge
              colorScheme={remaining < 60 ? 'red' : remaining < 300 ? 'orange' : 'green'}
              fontSize="md"
              px={3}
              py={1}
              borderRadius="md"
            >
              ⏱ {formatClock(remaining)}
            </Badge>
          )}
          <Button colorScheme="purple" onClick={() => submit(false)} isLoading={submitting}>
            Submit quiz
          </Button>
        </HStack>
      </Flex>

      <Progress
        value={(answered / (quiz.questions.length || 1)) * 100}
        size="xs"
        colorScheme="purple"
        borderRadius="full"
        mb={4}
      />

      {quiz.questions.map((question, index) => (
        <SectionCard key={question._id} mb={3}>
          <Flex justify="space-between" gap={3} mb={3}>
            <Box flex="1" minW={0}>
              <Text fontWeight="600" fontSize="sm" mb={1}>
                Q{index + 1}.
              </Text>
              <RichText>{question.question}</RichText>
            </Box>
            <Badge colorScheme="gray" flexShrink={0}>
              {question.marks} mark{question.marks === 1 ? '' : 's'}
            </Badge>
          </Flex>

          {question.type === 'short' ? (
            <Input
              placeholder="Your answer"
              value={answers[question._id] || ''}
              onChange={(event) => setAnswers((prev) => ({ ...prev, [question._id]: event.target.value }))}
            />
          ) : question.type === 'msq' ? (
            <Stack>
              {question.options.map((option, optionIndex) => (
                <Checkbox
                  key={optionIndex}
                  isChecked={(answers[question._id] || []).includes(String(optionIndex))}
                  onChange={(event) =>
                    setAnswers((prev) => {
                      const current = prev[question._id] || [];
                      const key = String(optionIndex);
                      return {
                        ...prev,
                        [question._id]: event.target.checked
                          ? [...current, key]
                          : current.filter((c) => c !== key),
                      };
                    })
                  }
                >
                  <RichText>{option}</RichText>
                </Checkbox>
              ))}
            </Stack>
          ) : (
            <RadioGroup
              value={(answers[question._id] || [])[0] ?? ''}
              onChange={(value) => setAnswers((prev) => ({ ...prev, [question._id]: [value] }))}
            >
              <Stack>
                {question.options.map((option, optionIndex) => (
                  <Radio key={optionIndex} value={String(optionIndex)} alignItems="flex-start">
                    <RichText>{option}</RichText>
                  </Radio>
                ))}
              </Stack>
            </RadioGroup>
          )}
        </SectionCard>
      ))}

      <Divider my={4} />
      <Button colorScheme="purple" size="lg" onClick={() => submit(false)} isLoading={submitting} w="100%">
        Submit quiz ({answered}/{quiz.questions.length} answered)
      </Button>
    </Box>
  );
}
