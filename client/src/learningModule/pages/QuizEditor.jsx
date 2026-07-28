import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import {
  Box,
  Button,
  Checkbox,
  Flex,
  FormControl,
  FormLabel,
  HStack,
  Input,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  useToast,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import { ErrorState, Loading, SectionCard } from '../components/common';

const BLANK_QUESTION = {
  question: '',
  type: 'mcq',
  options: ['', '', '', ''],
  correctAnswers: [],
  explanation: '',
  marks: 1,
  negativeMarks: 0,
  difficulty: 'medium',
  topic: '',
};

function QuestionCard({ question, index, onChange, onRemove }) {
  const set = (field, value) => onChange({ ...question, [field]: value });
  const isChoice = ['mcq', 'msq', 'truefalse'].includes(question.type);

  const setType = (type) => {
    // True/False has a fixed option set; switching to it should not leave the
    // previous four blanks behind.
    if (type === 'truefalse') {
      onChange({ ...question, type, options: ['True', 'False'], correctAnswers: [] });
    } else if (type === 'short') {
      onChange({ ...question, type, options: [], correctAnswers: [''] });
    } else {
      onChange({
        ...question,
        type,
        options: question.options?.length ? question.options : ['', '', '', ''],
        correctAnswers: [],
      });
    }
  };

  return (
    <SectionCard mb={3}>
      <Flex justify="space-between" align="center" mb={3} gap={2} wrap="wrap">
        <Text fontWeight="600" fontSize="sm">
          Question {index + 1}
        </Text>
        <HStack>
          <Select size="sm" w="130px" value={question.type} onChange={(e) => setType(e.target.value)}>
            <option value="mcq">Single choice</option>
            <option value="msq">Multi choice</option>
            <option value="truefalse">True / False</option>
            <option value="short">Short answer</option>
          </Select>
          <Select size="sm" w="100px" value={question.difficulty} onChange={(e) => set('difficulty', e.target.value)}>
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
          </Select>
          <Input
            size="sm"
            w="70px"
            type="number"
            min={0}
            value={question.marks}
            onChange={(e) => set('marks', Number(e.target.value) || 0)}
            aria-label="Marks"
          />
          <Button size="sm" variant="ghost" colorScheme="red" onClick={onRemove}>
            Delete
          </Button>
        </HStack>
      </Flex>

      <Textarea
        rows={2}
        placeholder="Question text"
        value={question.question}
        onChange={(e) => set('question', e.target.value)}
        mb={3}
      />

      {isChoice && (
        <Stack spacing={2} mb={3}>
          <Text fontSize="xs" color="gray.500">
            Tick the correct {question.type === 'msq' ? 'answers' : 'answer'}.
          </Text>
          {question.options.map((option, optionIndex) => (
            <Flex key={optionIndex} gap={2} align="center">
              <Checkbox
                isChecked={(question.correctAnswers || []).map(String).includes(String(optionIndex))}
                onChange={(event) => {
                  const current = (question.correctAnswers || []).map(String);
                  const key = String(optionIndex);
                  const next =
                    question.type === 'msq'
                      ? event.target.checked
                        ? [...current, key]
                        : current.filter((c) => c !== key)
                      : event.target.checked
                        ? [key]
                        : [];
                  set('correctAnswers', next);
                }}
              />
              <Input
                size="sm"
                value={option}
                placeholder={`Option ${optionIndex + 1}`}
                onChange={(event) => {
                  const options = [...question.options];
                  options[optionIndex] = event.target.value;
                  set('options', options);
                }}
                isReadOnly={question.type === 'truefalse'}
              />
              {question.type !== 'truefalse' && question.options.length > 2 && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    set(
                      'options',
                      question.options.filter((_, i) => i !== optionIndex),
                    );
                    set(
                      'correctAnswers',
                      (question.correctAnswers || []).filter((c) => String(c) !== String(optionIndex)),
                    );
                  }}
                >
                  ✕
                </Button>
              )}
            </Flex>
          ))}
          {question.type !== 'truefalse' && (
            <Button size="xs" variant="link" alignSelf="flex-start" onClick={() => set('options', [...question.options, ''])}>
              + Add option
            </Button>
          )}
        </Stack>
      )}

      {question.type === 'short' && (
        <Input
          size="sm"
          mb={3}
          placeholder="Expected answer (case-insensitive exact match auto-grades; others are left for you)"
          value={(question.correctAnswers || [])[0] || ''}
          onChange={(event) => set('correctAnswers', [event.target.value])}
        />
      )}

      <Textarea
        rows={2}
        size="sm"
        placeholder="Explanation shown to students after they submit"
        value={question.explanation || ''}
        onChange={(e) => set('explanation', e.target.value)}
      />
    </SectionCard>
  );
}

export default function QuizEditor() {
  const { classId } = useOutletContext();
  const { quizId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [quiz, setQuiz] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

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

  const save = async () => {
    setSaving(true);
    try {
      await lmApi.updateQuiz(classId, quizId, {
        title: quiz.title,
        description: quiz.description,
        questions: quiz.questions,
        settings: quiz.settings,
      });
      toast({ status: 'success', title: 'Quiz saved' });
      await load();
    } catch (err) {
      toast({ status: 'error', title: err.message });
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    await save();
    try {
      await lmApi.publishQuiz(classId, quizId, { publish: true });
      toast({ status: 'success', title: 'Quiz published to the class' });
      navigate(`/learning/class/${classId}/grades`);
    } catch (err) {
      toast({ status: 'error', title: err.message });
    }
  };

  if (loading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!quiz) return null;

  const setSetting = (key, value) =>
    setQuiz((prev) => ({ ...prev, settings: { ...prev.settings, [key]: value } }));

  const totalMarks = quiz.questions.reduce((sum, q) => sum + (Number(q.marks) || 0), 0);

  return (
    <Box>
      <Flex justify="space-between" align="center" mb={4} gap={3} wrap="wrap">
        <Box>
          <Button size="sm" variant="ghost" onClick={() => navigate(`/learning/class/${classId}/grades`)}>
            ← Back to quizzes
          </Button>
          <Text fontSize="sm" color="gray.500" mt={1}>
            {quiz.questions.length} questions · {totalMarks} marks
            {quiz.source === 'ai' ? ' · generated from a class recording' : ''}
          </Text>
        </Box>
        <HStack>
          <Button size="sm" variant="outline" onClick={save} isLoading={saving}>
            Save
          </Button>
          <Button size="sm" colorScheme="green" onClick={publish} isDisabled={!quiz.questions.length}>
            Save & publish
          </Button>
        </HStack>
      </Flex>

      <SectionCard title="Quiz details" mb={4}>
        <FormControl mb={3}>
          <FormLabel fontSize="sm">Title</FormLabel>
          <Input value={quiz.title} onChange={(e) => setQuiz((prev) => ({ ...prev, title: e.target.value }))} />
        </FormControl>
        <FormControl mb={4}>
          <FormLabel fontSize="sm">Description</FormLabel>
          <Textarea
            rows={2}
            value={quiz.description}
            onChange={(e) => setQuiz((prev) => ({ ...prev, description: e.target.value }))}
          />
        </FormControl>

        <SimpleGrid columns={{ base: 2, md: 4 }} spacing={4}>
          <FormControl>
            <FormLabel fontSize="xs">Time limit (min, 0 = none)</FormLabel>
            <Input
              size="sm"
              type="number"
              min={0}
              value={quiz.settings.timeLimitMinutes}
              onChange={(e) => setSetting('timeLimitMinutes', Number(e.target.value) || 0)}
            />
          </FormControl>
          <FormControl>
            <FormLabel fontSize="xs">Attempts allowed</FormLabel>
            <Input
              size="sm"
              type="number"
              min={1}
              value={quiz.settings.attemptsAllowed}
              onChange={(e) => setSetting('attemptsAllowed', Number(e.target.value) || 1)}
            />
          </FormControl>
          <FormControl>
            <FormLabel fontSize="xs">Pass mark (%)</FormLabel>
            <Input
              size="sm"
              type="number"
              min={0}
              max={100}
              value={quiz.settings.passPercent}
              onChange={(e) => setSetting('passPercent', Number(e.target.value) || 0)}
            />
          </FormControl>
          <FormControl>
            <FormLabel fontSize="xs">Open until</FormLabel>
            <Input
              size="sm"
              type="datetime-local"
              value={quiz.settings.availableTo ? new Date(quiz.settings.availableTo).toISOString().slice(0, 16) : ''}
              onChange={(e) => setSetting('availableTo', e.target.value || null)}
            />
          </FormControl>
        </SimpleGrid>

        <HStack mt={4} spacing={5} wrap="wrap">
          <Checkbox
            size="sm"
            isChecked={quiz.settings.shuffleQuestions}
            onChange={(e) => setSetting('shuffleQuestions', e.target.checked)}
          >
            Shuffle questions
          </Checkbox>
          <Checkbox
            size="sm"
            isChecked={quiz.settings.showAnswersAfterSubmit}
            onChange={(e) => setSetting('showAnswersAfterSubmit', e.target.checked)}
          >
            Show answers after submitting
          </Checkbox>
        </HStack>
      </SectionCard>

      {quiz.questions.map((question, index) => (
        <QuestionCard
          key={question._id || index}
          index={index}
          question={question}
          onChange={(updated) =>
            setQuiz((prev) => ({
              ...prev,
              questions: prev.questions.map((q, i) => (i === index ? updated : q)),
            }))
          }
          onRemove={() =>
            setQuiz((prev) => ({ ...prev, questions: prev.questions.filter((_, i) => i !== index) }))
          }
        />
      ))}

      <Button
        variant="outline"
        onClick={() => setQuiz((prev) => ({ ...prev, questions: [...prev.questions, { ...BLANK_QUESTION }] }))}
      >
        + Add question
      </Button>
    </Box>
  );
}
