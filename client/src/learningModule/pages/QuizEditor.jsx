import React, { useCallback, useEffect, useState } from 'react';
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
  FormControl,
  FormHelperText,
  FormLabel,
  HStack,
  Heading,
  IconButton,
  Input,
  Radio,
  RadioGroup,
  Select,
  SimpleGrid,
  Stack,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Text,
  Textarea,
  Tooltip,
  useToast,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import RichTextEditor from '../components/RichTextEditor';
import { ErrorState, Loading, SectionCard } from '../components/common';

const BLANK_QUESTION = {
  question: '',
  type: 'mcq',
  options: ['', '', '', ''],
  correctAnswers: [],
  explanation: '',
  marks: 1,
  negativeMarks: null,
  difficulty: 'medium',
  topic: '',
  timeLimitSec: 60,
  sectionId: null,
  tolerancePercent: 0,
  toleranceAbs: 0,
};

const TYPE_LABELS = {
  mcq: 'Single correct',
  msq: 'Multiple correct',
  truefalse: 'True / False',
  numerical: 'Numerical / integer',
  short: 'Short answer',
};

const toLocalInput = (value) =>
  value ? new Date(new Date(value).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';

function QuestionCard({ question, index, sections, onChange, onRemove, onDuplicate, perQuestionTiming }) {
  const set = (field, value) => onChange({ ...question, [field]: value });
  const isChoice = ['mcq', 'msq', 'truefalse'].includes(question.type);

  const setType = (type) => {
    if (type === 'truefalse') {
      onChange({ ...question, type, options: ['True', 'False'], correctAnswers: [] });
    } else if (type === 'short' || type === 'numerical') {
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
        <HStack>
          <Text fontWeight="600" fontSize="sm">
            Question {index + 1}
          </Text>
          <Badge colorScheme="gray">{TYPE_LABELS[question.type]}</Badge>
        </HStack>
        <HStack>
          <Button size="xs" variant="ghost" onClick={onDuplicate}>
            Duplicate
          </Button>
          <Button size="xs" variant="ghost" colorScheme="red" onClick={onRemove}>
            Delete
          </Button>
        </HStack>
      </Flex>

      <Box mb={3}>
        <RichTextEditor
          value={question.question}
          onChange={(html) => set('question', html)}
          placeholder="Question text — formatting, sub/superscripts and images are supported"
          minH="110px"
        />
      </Box>

      <SimpleGrid columns={{ base: 2, md: 4 }} spacing={3} mb={3}>
        <FormControl>
          <FormLabel fontSize="xs">Type</FormLabel>
          <Select size="sm" value={question.type} onChange={(e) => setType(e.target.value)}>
            {Object.entries(TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </FormControl>
        <FormControl>
          <FormLabel fontSize="xs">Difficulty</FormLabel>
          <Select size="sm" value={question.difficulty} onChange={(e) => set('difficulty', e.target.value)}>
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
          </Select>
        </FormControl>
        <FormControl>
          <FormLabel fontSize="xs">Marks</FormLabel>
          <Input size="sm" type="number" min={0} value={question.marks} onChange={(e) => set('marks', Number(e.target.value) || 0)} />
        </FormControl>
        <FormControl>
          <Tooltip label="Leave blank to use the quiz-wide negative marking">
            <FormLabel fontSize="xs">Negative</FormLabel>
          </Tooltip>
          <Input
            size="sm"
            type="number"
            min={0}
            placeholder="default"
            value={question.negativeMarks ?? ''}
            onChange={(e) => set('negativeMarks', e.target.value === '' ? null : Number(e.target.value))}
          />
        </FormControl>
      </SimpleGrid>

      <SimpleGrid columns={{ base: 2, md: 3 }} spacing={3} mb={3}>
        <FormControl>
          <FormLabel fontSize="xs">Section</FormLabel>
          <Select size="sm" value={question.sectionId || ''} onChange={(e) => set('sectionId', e.target.value || null)}>
            <option value="">Ungrouped</option>
            {sections.map((section) => (
              <option key={section._id} value={section._id}>
                {section.name}
              </option>
            ))}
          </Select>
        </FormControl>
        <FormControl isInvalid={perQuestionTiming && !question.timeLimitSec}>
          <FormLabel fontSize="xs">Time (seconds)</FormLabel>
          <Input
            size="sm"
            type="number"
            min={0}
            value={question.timeLimitSec}
            onChange={(e) => set('timeLimitSec', Number(e.target.value) || 0)}
          />
          {perQuestionTiming && !question.timeLimitSec && (
            <FormHelperText fontSize="xs" color="red.500">
              Required while per-question timing is on
            </FormHelperText>
          )}
        </FormControl>
        <FormControl>
          <FormLabel fontSize="xs">Topic</FormLabel>
          <Input size="sm" value={question.topic} onChange={(e) => set('topic', e.target.value)} placeholder="Optional" />
        </FormControl>
      </SimpleGrid>

      {isChoice && (
        <Stack spacing={2} mb={3}>
          <Text fontSize="xs" color="gray.500">
            Tick the correct {question.type === 'msq' ? 'answers' : 'answer'}.
          </Text>
          {question.options.map((option, optionIndex) => (
            <Flex key={optionIndex} gap={2} align="flex-start">
              <Checkbox
                mt={2}
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
              {question.type === 'truefalse' ? (
                <Input size="sm" value={option} isReadOnly />
              ) : (
                <Box flex="1">
                  <RichTextEditor
                    compact
                    minH="46px"
                    value={option}
                    onChange={(html) => {
                      const options = [...question.options];
                      options[optionIndex] = html;
                      set('options', options);
                    }}
                    placeholder={`Option ${optionIndex + 1}`}
                  />
                </Box>
              )}
              {question.type !== 'truefalse' && question.options.length > 2 && (
                <IconButton
                  mt={1}
                  size="xs"
                  variant="ghost"
                  aria-label="Remove option"
                  icon={<span>✕</span>}
                  onClick={() => {
                    set('options', question.options.filter((_, i) => i !== optionIndex));
                    set(
                      'correctAnswers',
                      (question.correctAnswers || []).filter((c) => String(c) !== String(optionIndex)),
                    );
                  }}
                />
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

      {question.type === 'numerical' && (
        <SimpleGrid columns={{ base: 1, md: 3 }} spacing={3} mb={3}>
          <FormControl>
            <FormLabel fontSize="xs">Correct value</FormLabel>
            <Input
              size="sm"
              value={(question.correctAnswers || [])[0] || ''}
              placeholder="42"
              onChange={(e) => set('correctAnswers', [e.target.value])}
            />
          </FormControl>
          <FormControl>
            <FormLabel fontSize="xs">Tolerance %</FormLabel>
            <Input
              size="sm"
              type="number"
              min={0}
              value={question.tolerancePercent}
              onChange={(e) => set('tolerancePercent', Number(e.target.value) || 0)}
            />
          </FormControl>
          <FormControl>
            <Tooltip label="Absolute allowance — needed when the answer is near zero">
              <FormLabel fontSize="xs">Tolerance ±</FormLabel>
            </Tooltip>
            <Input
              size="sm"
              type="number"
              min={0}
              value={question.toleranceAbs}
              onChange={(e) => set('toleranceAbs', Number(e.target.value) || 0)}
            />
          </FormControl>
        </SimpleGrid>
      )}

      {question.type === 'short' && (
        <Input
          size="sm"
          mb={3}
          placeholder="Expected answer (case-insensitive exact match auto-grades)"
          value={(question.correctAnswers || [])[0] || ''}
          onChange={(e) => set('correctAnswers', [e.target.value])}
        />
      )}

      <RichTextEditor
        compact
        value={question.explanation || ''}
        onChange={(html) => set('explanation', html)}
        placeholder="Explanation shown to students after they submit"
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
  const [collaboratorEmails, setCollaboratorEmails] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await lmApi.getQuiz(classId, quizId);
      setQuiz(data);
      setCollaboratorEmails((data.collaborators || []).map((c) => c.email).join(', '));
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
        instructions: quiz.instructions,
        sections: quiz.sections,
        questions: quiz.questions,
        settings: quiz.settings,
      });
      toast({ status: 'success', title: 'Quiz saved' });
      await load();
      return true;
    } catch (err) {
      toast({ status: 'error', title: err.message, duration: 8000 });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    if (!(await save())) return;
    try {
      await lmApi.publishQuiz(classId, quizId, { publish: true });
      toast({ status: 'success', title: 'Published to the class' });
      navigate(`/learning/class/${classId}/grades`);
    } catch (err) {
      toast({ status: 'error', title: err.message, duration: 10000 });
    }
  };

  if (loading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!quiz) return null;

  const set = (changes) => setQuiz((prev) => ({ ...prev, ...changes }));
  const setSetting = (key, value) => set({ settings: { ...quiz.settings, [key]: value } });
  const settings = quiz.settings;

  const totalMarks = quiz.questions.reduce((sum, q) => sum + (Number(q.marks) || 0), 0);

  return (
    <Box>
      <Flex justify="space-between" align="center" mb={4} gap={3} wrap="wrap">
        <Box>
          <Button size="sm" variant="ghost" onClick={() => navigate(`/learning/class/${classId}/grades`)}>
            ← Back to quizzes
          </Button>
          <Heading size="md" mt={1}>
            {quiz.title}
          </Heading>
          <Text fontSize="sm" color="gray.500">
            {quiz.questions.length} questions · {totalMarks} marks
            {settings.questionsPerAttempt > 0 && ` · ${settings.questionsPerAttempt} drawn per student`}
            {quiz.source === 'ai' && ' · generated from a class recording'}
          </Text>
        </Box>
        <HStack>
          <Button size="sm" variant="outline" onClick={save} isLoading={saving}>
            Save
          </Button>
          <Button size="sm" colorScheme="green" onClick={publish} isDisabled={!quiz.questions.length}>
            Save &amp; publish
          </Button>
        </HStack>
      </Flex>

      <Tabs colorScheme="purple" variant="enclosed">
        <TabList>
          <Tab fontSize="sm">Questions ({quiz.questions.length})</Tab>
          <Tab fontSize="sm">Sections ({quiz.sections.length})</Tab>
          <Tab fontSize="sm">Delivery &amp; timing</Tab>
          <Tab fontSize="sm">Marking</Tab>
          <Tab fontSize="sm">Proctoring</Tab>
          <Tab fontSize="sm">Instructions</Tab>
          <Tab fontSize="sm">Access</Tab>
        </TabList>

        <TabPanels>
          {/* ---------- questions ---------- */}
          <TabPanel px={0}>
            {quiz.questions.map((question, index) => (
              <QuestionCard
                key={question._id || index}
                index={index}
                question={question}
                sections={quiz.sections}
                perQuestionTiming={settings.perQuestionTiming}
                onChange={(updated) =>
                  set({ questions: quiz.questions.map((q, i) => (i === index ? updated : q)) })
                }
                onRemove={() => set({ questions: quiz.questions.filter((_, i) => i !== index) })}
                onDuplicate={() => {
                  const copy = JSON.parse(JSON.stringify(question));
                  delete copy._id;
                  const next = [...quiz.questions];
                  next.splice(index + 1, 0, copy);
                  set({ questions: next });
                }}
              />
            ))}
            <Button
              variant="outline"
              onClick={() => set({ questions: [...quiz.questions, JSON.parse(JSON.stringify(BLANK_QUESTION))] })}
            >
              + Add question
            </Button>
          </TabPanel>

          {/* ---------- sections ---------- */}
          <TabPanel px={0}>
            <SectionCard
              title="Sections"
              subtitle="Group questions into parts, e.g. Aptitude / Coding. Question order is only ever shuffled inside a section, never across them."
            >
              {quiz.sections.length === 0 && (
                <Text fontSize="sm" color="gray.500" mb={3}>
                  No sections — every question sits in one flat list.
                </Text>
              )}
              {quiz.sections.map((section, index) => (
                <Flex key={section._id || index} gap={2} align="flex-end" mb={3} wrap="wrap">
                  <FormControl maxW="200px">
                    <FormLabel fontSize="xs">Name</FormLabel>
                    <Input
                      size="sm"
                      value={section.name}
                      onChange={(e) =>
                        set({
                          sections: quiz.sections.map((s, i) =>
                            i === index ? { ...s, name: e.target.value } : s,
                          ),
                        })
                      }
                    />
                  </FormControl>
                  <FormControl flex="1" minW="220px">
                    <FormLabel fontSize="xs">Notes shown on the brief</FormLabel>
                    <Input
                      size="sm"
                      value={section.instructions}
                      onChange={(e) =>
                        set({
                          sections: quiz.sections.map((s, i) =>
                            i === index ? { ...s, instructions: e.target.value } : s,
                          ),
                        })
                      }
                    />
                  </FormControl>
                  <Button
                    size="sm"
                    variant="ghost"
                    colorScheme="red"
                    onClick={() => set({ sections: quiz.sections.filter((_, i) => i !== index) })}
                  >
                    ✕
                  </Button>
                </Flex>
              ))}
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  set({
                    sections: [
                      ...quiz.sections,
                      { name: `Section ${quiz.sections.length + 1}`, order: quiz.sections.length, instructions: '' },
                    ],
                  })
                }
              >
                + Add section
              </Button>
              <Text fontSize="xs" color="gray.500" mt={3}>
                Save after adding a section, then assign questions to it from the Questions tab.
              </Text>
            </SectionCard>
          </TabPanel>

          {/* ---------- delivery & timing ---------- */}
          <TabPanel px={0}>
            <SectionCard title="How questions are delivered" mb={4}>
              <RadioGroup value={settings.deliveryMode} onChange={(value) => setSetting('deliveryMode', value)}>
                <Stack spacing={3}>
                  <Radio value="all_at_once">
                    <Box>
                      <Text fontSize="sm" fontWeight="600">
                        All questions on one page
                      </Text>
                      <Text fontSize="xs" color="gray.500">
                        Students answer in any order and submit when ready. Best for classroom quizzes.
                      </Text>
                    </Box>
                  </Radio>
                  <Radio value="one_at_a_time">
                    <Box>
                      <Text fontSize="sm" fontWeight="600">
                        One question at a time
                      </Text>
                      <Text fontSize="xs" color="gray.500">
                        The server hands out one question at a time and remembers the position, so a refresh or
                        a dropped connection resumes instead of restarting. Best for placement-style tests.
                      </Text>
                    </Box>
                  </Radio>
                </Stack>
              </RadioGroup>

              {settings.deliveryMode === 'one_at_a_time' && (
                <Checkbox
                  mt={4}
                  size="sm"
                  isChecked={settings.allowBacktracking}
                  onChange={(e) => setSetting('allowBacktracking', e.target.checked)}
                >
                  Let students go back to earlier questions
                </Checkbox>
              )}
            </SectionCard>

            <SectionCard title="Timing" mb={4}>
              <Checkbox
                size="sm"
                isChecked={settings.perQuestionTiming}
                onChange={(e) => setSetting('perQuestionTiming', e.target.checked)}
              >
                Give each question its own timer (auto-submits when it expires)
              </Checkbox>
              {settings.perQuestionTiming && (
                <Alert status="info" borderRadius="md" mt={3} fontSize="xs">
                  <AlertIcon />
                  Set a time on every question in the Questions tab, or an overall limit below as a fallback —
                  publishing is blocked otherwise.
                </Alert>
              )}

              <SimpleGrid columns={{ base: 1, md: 2 }} spacing={4} mt={4}>
                <FormControl>
                  <FormLabel fontSize="xs">Overall time limit (minutes, 0 = none)</FormLabel>
                  <Input
                    size="sm"
                    type="number"
                    min={0}
                    value={settings.timeLimitMinutes}
                    onChange={(e) => setSetting('timeLimitMinutes', Number(e.target.value) || 0)}
                  />
                </FormControl>
                <FormControl>
                  <Tooltip label="Students may still be sitting the test after this, but nobody new can begin">
                    <FormLabel fontSize="xs">Late-entry window (minutes after opening)</FormLabel>
                  </Tooltip>
                  <Input
                    size="sm"
                    type="number"
                    min={0}
                    value={settings.marginMinutes}
                    onChange={(e) => setSetting('marginMinutes', Number(e.target.value) || 0)}
                  />
                  <FormHelperText fontSize="xs">0 = anyone may start while the quiz is open.</FormHelperText>
                </FormControl>
                <FormControl>
                  <FormLabel fontSize="xs">Opens at</FormLabel>
                  <Input
                    size="sm"
                    type="datetime-local"
                    value={toLocalInput(settings.availableFrom)}
                    onChange={(e) => setSetting('availableFrom', e.target.value || null)}
                  />
                </FormControl>
                <FormControl>
                  <FormLabel fontSize="xs">Closes at</FormLabel>
                  <Input
                    size="sm"
                    type="datetime-local"
                    value={toLocalInput(settings.availableTo)}
                    onChange={(e) => setSetting('availableTo', e.target.value || null)}
                  />
                </FormControl>
                <FormControl>
                  <Tooltip label="Scores stay hidden until this moment, so a whole cohort sees them together">
                    <FormLabel fontSize="xs">Release results at</FormLabel>
                  </Tooltip>
                  <Input
                    size="sm"
                    type="datetime-local"
                    value={toLocalInput(settings.resultReleaseAt)}
                    onChange={(e) => setSetting('resultReleaseAt', e.target.value || null)}
                  />
                  <FormHelperText fontSize="xs">Leave blank to show results immediately.</FormHelperText>
                </FormControl>
              </SimpleGrid>
            </SectionCard>
          </TabPanel>

          {/* ---------- marking ---------- */}
          <TabPanel px={0}>
            <SectionCard title="Marking and randomisation">
              <SimpleGrid columns={{ base: 2, md: 4 }} spacing={4}>
                <FormControl>
                  <Tooltip label="Applied to any question that does not set its own. Unanswered questions are never penalised.">
                    <FormLabel fontSize="xs">Negative marking (default)</FormLabel>
                  </Tooltip>
                  <Input
                    size="sm"
                    type="number"
                    min={0}
                    value={settings.negativeMarking}
                    onChange={(e) => setSetting('negativeMarking', Number(e.target.value) || 0)}
                  />
                </FormControl>
                <FormControl>
                  <FormLabel fontSize="xs">Pass mark (%)</FormLabel>
                  <Input
                    size="sm"
                    type="number"
                    min={0}
                    max={100}
                    value={settings.passPercent}
                    onChange={(e) => setSetting('passPercent', Number(e.target.value) || 0)}
                  />
                </FormControl>
                <FormControl>
                  <FormLabel fontSize="xs">Attempts allowed</FormLabel>
                  <Input
                    size="sm"
                    type="number"
                    min={1}
                    value={settings.attemptsAllowed}
                    onChange={(e) => setSetting('attemptsAllowed', Number(e.target.value) || 1)}
                  />
                </FormControl>
                <FormControl>
                  <Tooltip label="Draw this many questions at random from the bank for each student. 0 = serve every question.">
                    <FormLabel fontSize="xs">Questions per student</FormLabel>
                  </Tooltip>
                  <Input
                    size="sm"
                    type="number"
                    min={0}
                    max={quiz.questions.length}
                    value={settings.questionsPerAttempt}
                    onChange={(e) => setSetting('questionsPerAttempt', Number(e.target.value) || 0)}
                  />
                </FormControl>
              </SimpleGrid>

              <Divider my={4} />
              <Stack spacing={2}>
                <Checkbox
                  size="sm"
                  isChecked={settings.shuffleQuestions}
                  onChange={(e) => setSetting('shuffleQuestions', e.target.checked)}
                >
                  Shuffle question order per student
                </Checkbox>
                <Checkbox
                  size="sm"
                  isChecked={settings.shuffleOptions}
                  onChange={(e) => setSetting('shuffleOptions', e.target.checked)}
                >
                  Shuffle options per student (True/False is left alone)
                </Checkbox>
                <Checkbox
                  size="sm"
                  isChecked={settings.showAnswersAfterSubmit}
                  onChange={(e) => setSetting('showAnswersAfterSubmit', e.target.checked)}
                >
                  Show correct answers and explanations after submitting
                </Checkbox>
                <Checkbox
                  size="sm"
                  isChecked={settings.showScoreImmediately}
                  onChange={(e) => setSetting('showScoreImmediately', e.target.checked)}
                >
                  Show the score immediately (subject to the release time)
                </Checkbox>
              </Stack>
            </SectionCard>
          </TabPanel>

          {/* ---------- proctoring ---------- */}
          <TabPanel px={0}>
            <SectionCard
              title="Proctoring"
              subtitle="Deterrents, not guarantees — a determined student can defeat any of them. What makes them useful is that every event is recorded on the attempt for you to review."
            >
              <Stack spacing={3}>
                <Checkbox
                  size="sm"
                  isChecked={!settings.allowTabChange}
                  onChange={(e) => setSetting('allowTabChange', !e.target.checked)}
                >
                  Record when a student leaves the test tab or window
                </Checkbox>
                {!settings.allowTabChange && (
                  <Box pl={6}>
                    <HStack>
                      <FormControl maxW="140px">
                        <FormLabel fontSize="xs">Allowed switches</FormLabel>
                        <Input
                          size="sm"
                          type="number"
                          min={0}
                          value={settings.maxTabSwitches}
                          onChange={(e) => setSetting('maxTabSwitches', Number(e.target.value) || 0)}
                        />
                      </FormControl>
                    </HStack>
                    <Checkbox
                      mt={2}
                      size="sm"
                      isChecked={settings.autoSubmitOnTabLimit}
                      onChange={(e) => setSetting('autoSubmitOnTabLimit', e.target.checked)}
                    >
                      Submit the test automatically once that limit is passed
                    </Checkbox>
                  </Box>
                )}

                <Checkbox
                  size="sm"
                  isChecked={settings.preventMobile}
                  onChange={(e) => setSetting('preventMobile', e.target.checked)}
                >
                  Block mobile devices (checked server-side on start)
                </Checkbox>
                <Checkbox
                  size="sm"
                  isChecked={settings.requireFullscreen}
                  onChange={(e) => setSetting('requireFullscreen', e.target.checked)}
                >
                  Require fullscreen, and record when it is exited
                </Checkbox>
                <Checkbox
                  size="sm"
                  isChecked={settings.disableCopyPaste}
                  onChange={(e) => setSetting('disableCopyPaste', e.target.checked)}
                >
                  Disable copy, cut and paste
                </Checkbox>
                <Checkbox
                  size="sm"
                  isChecked={settings.disableRightClick}
                  onChange={(e) => setSetting('disableRightClick', e.target.checked)}
                >
                  Disable right-click
                </Checkbox>
              </Stack>
            </SectionCard>
          </TabPanel>

          {/* ---------- instructions ---------- */}
          <TabPanel px={0}>
            <SectionCard
              title="Instructions"
              subtitle="Shown on the pre-test screen, before any question is handed out. One instruction per line."
            >
              <FormControl mb={4}>
                <FormLabel fontSize="sm">Title</FormLabel>
                <Input value={quiz.title} onChange={(e) => set({ title: e.target.value })} />
              </FormControl>
              <FormControl mb={4}>
                <FormLabel fontSize="sm">Description</FormLabel>
                <RichTextEditor
                  compact
                  value={quiz.description}
                  onChange={(html) => set({ description: html })}
                  placeholder="What this test covers"
                />
              </FormControl>
              <FormControl>
                <FormLabel fontSize="sm">Instruction lines</FormLabel>
                <Textarea
                  rows={8}
                  value={(quiz.instructions || []).join('\n')}
                  onChange={(e) => set({ instructions: e.target.value.split('\n') })}
                  placeholder={'Keep your ID card on the desk\nUse of a calculator is not permitted\nRaise your hand if the page stops responding'}
                />
                <FormHelperText fontSize="xs">
                  The delivery, timing and proctoring rules are described automatically — you only need to add
                  anything specific to your test.
                </FormHelperText>
              </FormControl>
            </SectionCard>
          </TabPanel>

          {/* ---------- access ---------- */}
          <TabPanel px={0}>
            <SectionCard
              title="Collaborators"
              subtitle="Give another member of staff edit access to this quiz without making them a class teacher."
              mb={4}
            >
              <FormControl>
                <FormLabel fontSize="sm">Emails</FormLabel>
                <Textarea
                  rows={3}
                  value={collaboratorEmails}
                  onChange={(e) => setCollaboratorEmails(e.target.value)}
                  placeholder="colleague@nitj.ac.in, another@nitj.ac.in"
                />
              </FormControl>
              <Button
                size="sm"
                mt={3}
                variant="outline"
                onClick={async () => {
                  try {
                    const result = await lmApi.setQuizCollaborators(
                      classId,
                      quizId,
                      collaboratorEmails.split(/[\s,;]+/).filter(Boolean),
                    );
                    toast({ status: 'success', title: `${result.collaborators.length} collaborator(s) set` });
                    load();
                  } catch (err) {
                    toast({ status: 'error', title: err.message });
                  }
                }}
              >
                Save collaborators
              </Button>
              {quiz.collaborators?.length > 0 && (
                <HStack mt={3} wrap="wrap">
                  {quiz.collaborators.map((collaborator) => (
                    <Badge key={collaborator.email} colorScheme={collaborator.userId ? 'green' : 'orange'}>
                      {collaborator.email}
                      {collaborator.userId ? '' : ' (no account yet)'}
                    </Badge>
                  ))}
                </HStack>
              )}
            </SectionCard>

            <SectionCard title="Danger zone" borderColor="red.200">
              <Flex justify="space-between" align="center" gap={3} wrap="wrap" py={2}>
                <Box>
                  <Text fontSize="sm" fontWeight="600" color="red.600">
                    Delete all responses
                  </Text>
                  <Text fontSize="xs" color="gray.500">
                    Clears every attempt so the same cohort can sit this test again. Their gradebook entries
                    are reset too.
                  </Text>
                </Box>
                <Button
                  size="sm"
                  colorScheme="red"
                  variant="outline"
                  onClick={async () => {
                    // eslint-disable-next-line no-alert
                    if (!window.confirm('Delete every attempt at this quiz? This cannot be undone.')) return;
                    try {
                      const result = await lmApi.deleteQuizResponses(classId, quizId);
                      toast({ status: 'success', title: `${result.deleted} attempt(s) deleted` });
                    } catch (err) {
                      toast({ status: 'error', title: err.message });
                    }
                  }}
                >
                  Delete responses
                </Button>
              </Flex>
            </SectionCard>
          </TabPanel>
        </TabPanels>
      </Tabs>
    </Box>
  );
}
