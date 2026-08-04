import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Checkbox,
  CheckboxGroup,
  Divider,
  Flex,
  FormControl,
  FormLabel,
  HStack,
  Heading,
  Input,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Radio,
  RadioGroup,
  Select,
  Stack,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Text,
  Textarea,
  useDisclosure,
  useToast,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import Markdown from '../components/Markdown';
import RichTextEditor from '../components/RichTextEditor';
import { EmptyState, ErrorState, Loading, SectionCard } from '../components/common';
import { formatDate, relativeTime } from '../format';
import { duplicateOptionIndexes } from '../questionRules';

const prettySize = (bytes) => (bytes ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : '');

/** Step 1 — pick a recording captured by the attendance module, or paste text. */
function NewSessionModal({ isOpen, onClose, classId, onCreated }) {
  const [tab, setTab] = useState(0);
  const [recordings, setRecordings] = useState(null);
  const [sourceError, setSourceError] = useState(null);
  const [selected, setSelected] = useState('');
  const [title, setTitle] = useState('');
  const [lectureDate, setLectureDate] = useState(new Date().toISOString().slice(0, 10));
  const [transcript, setTranscript] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (!isOpen) return;
    lmApi
      .studioRecordings(classId)
      .then((data) => {
        setRecordings(data.recordings);
        setSourceError(data.sourceError);
      })
      .catch((error) => {
        setRecordings([]);
        setSourceError(error.message);
      });
  }, [isOpen, classId]);

  const create = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const recording = recordings?.find((r) => r.filename === selected);
      const created = await lmApi.createSession(classId, {
        title: title.trim(),
        lectureDate,
        source: tab === 0 ? 'attendance-recording' : 'manual-transcript',
        recordingFilename: tab === 0 ? selected : '',
        recordingLabel: recording?.label || '',
        transcript: tab === 1 ? transcript : undefined,
      });
      toast({ status: 'success', title: 'Lecture session created' });
      setTitle('');
      setTranscript('');
      setSelected('');
      onCreated(created);
      onClose();
    } catch (error) {
      toast({ status: 'error', title: 'Could not create session', description: error.message });
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = title.trim() && (tab === 0 ? selected : transcript.trim().length > 100);

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="2xl" scrollBehavior="inside">
      <ModalOverlay />
      <ModalContent>
        <ModalHeader>New lecture session</ModalHeader>
        <ModalCloseButton />
        <ModalBody>
          <FormControl isRequired mb={4}>
            <FormLabel fontSize="sm">Lecture title</FormLabel>
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Fourier transforms — properties and examples"
              autoFocus
            />
          </FormControl>
          <FormControl mb={4} maxW="220px">
            <FormLabel fontSize="sm">Lecture date</FormLabel>
            <Input type="date" value={lectureDate} onChange={(event) => setLectureDate(event.target.value)} />
          </FormControl>

          <Tabs index={tab} onChange={setTab} size="sm" colorScheme="purple" variant="enclosed">
            <TabList>
              <Tab>From a class recording</Tab>
              <Tab>Paste a transcript</Tab>
            </TabList>
            <TabPanels>
              <TabPanel px={0}>
                {sourceError && (
                  <Alert status="warning" borderRadius="md" mb={3} fontSize="sm">
                    <AlertIcon />
                    <Box>
                      <Text fontWeight="600">Recording service unreachable</Text>
                      <Text fontSize="xs">{sourceError}</Text>
                      <Text fontSize="xs" mt={1}>
                        You can still paste a transcript on the other tab.
                      </Text>
                    </Box>
                  </Alert>
                )}
                {recordings === null ? (
                  <Loading minH="120px" label="Fetching recordings…" />
                ) : recordings.length === 0 ? (
                  <EmptyState
                    icon="🎧"
                    title="No class recordings available"
                    description="Recordings captured with audio by the attendance module appear here once they finish."
                  />
                ) : (
                  <RadioGroup value={selected} onChange={setSelected}>
                    <Stack maxH="300px" overflowY="auto">
                      {recordings.map((recording) => (
                        <Box
                          key={recording.filename}
                          borderWidth="1px"
                          borderColor={selected === recording.filename ? 'purple.400' : 'gray.200'}
                          borderRadius="md"
                          p={3}
                        >
                          <Radio value={recording.filename} isDisabled={Boolean(recording.existingSession)}>
                            <Box ml={1}>
                              <Text fontSize="sm" fontWeight="500">
                                {recording.label || recording.filename}
                              </Text>
                              <Text fontSize="xs" color="gray.500">
                                {recording.filename} · {prettySize(recording.sizeBytes)} ·{' '}
                                {recording.started ? relativeTime(recording.started) : ''}
                              </Text>
                              {recording.existingSession && (
                                <Badge colorScheme="gray" mt={1}>
                                  Already used by &ldquo;{recording.existingSession.title}&rdquo;
                                </Badge>
                              )}
                            </Box>
                          </Radio>
                        </Box>
                      ))}
                    </Stack>
                  </RadioGroup>
                )}
              </TabPanel>
              <TabPanel px={0}>
                <Text fontSize="sm" color="gray.600" mb={2}>
                  Paste the lecture transcript. Notes, a tutorial and a quiz are generated from it directly —
                  no speech-to-text needed.
                </Text>
                <Textarea
                  rows={12}
                  value={transcript}
                  onChange={(event) => setTranscript(event.target.value)}
                  placeholder="Paste the full transcript here…"
                />
                <Text fontSize="xs" color="gray.500" mt={1}>
                  {transcript.trim().split(/\s+/).filter(Boolean).length} words
                </Text>
              </TabPanel>
            </TabPanels>
          </Tabs>
        </ModalBody>
        <ModalFooter gap={2}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button colorScheme="purple" onClick={create} isLoading={busy} isDisabled={!canSubmit}>
            Create session
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function QuestionEditor({ question, index, onChange, onRemove }) {
  const set = (field, value) => onChange({ ...question, [field]: value });
  const isChoice = ['mcq', 'msq', 'truefalse'].includes(question.type);
  // A generated draft is exactly where a repeated option turns up, and the
  // publish endpoint refuses one — so say which option before it is sent.
  const duplicates = isChoice ? duplicateOptionIndexes(question.options) : new Set();

  return (
    <Box borderWidth="1px" borderColor="gray.200" borderRadius="md" p={4} mb={3} bg="white">
      <Flex justify="space-between" align="flex-start" gap={2} mb={2}>
        <Text fontSize="xs" color="gray.500" fontWeight="600">
          Q{index + 1}
        </Text>
        <HStack>
          <Select size="xs" w="110px" value={question.type} onChange={(e) => set('type', e.target.value)}>
            <option value="mcq">Single choice</option>
            <option value="msq">Multi choice</option>
            <option value="truefalse">True/False</option>
          </Select>
          <Select size="xs" w="90px" value={question.difficulty} onChange={(e) => set('difficulty', e.target.value)}>
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
          </Select>
          <Input
            size="xs"
            w="60px"
            type="number"
            value={question.marks}
            onChange={(e) => set('marks', Number(e.target.value) || 1)}
            aria-label="Marks"
          />
          <Button size="xs" variant="ghost" colorScheme="red" onClick={onRemove}>
            ✕
          </Button>
        </HStack>
      </Flex>

      <Box mb={2}>
        <RichTextEditor
          compact
          value={question.question}
          onChange={(html) => set('question', html)}
          placeholder="Question text"
        />
      </Box>

      {isChoice && (
        <Stack spacing={1} mb={2}>
          {(question.options || []).map((option, optionIndex) => (
            <Flex key={optionIndex} gap={2} align="center">
              <Checkbox
                isChecked={(question.correctAnswers || []).map(String).includes(String(optionIndex))}
                onChange={(event) => {
                  const current = (question.correctAnswers || []).map(String);
                  const key = String(optionIndex);
                  let next;
                  if (question.type === 'msq') {
                    next = event.target.checked ? [...current, key] : current.filter((c) => c !== key);
                  } else {
                    next = event.target.checked ? [key] : [];
                  }
                  set('correctAnswers', next);
                }}
              />
              <Box
                flex="1"
                borderWidth={duplicates.has(optionIndex) ? '1px' : 0}
                borderColor="red.400"
                borderRadius="md"
              >
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
                {duplicates.has(optionIndex) && (
                  <Text fontSize="xs" color="red.600" px={2} pb={1}>
                    Same as an option above
                  </Text>
                )}
              </Box>
            </Flex>
          ))}
          <Button size="xs" variant="link" alignSelf="flex-start" onClick={() => set('options', [...(question.options || []), ''])}>
            + Add option
          </Button>
        </Stack>
      )}

      <RichTextEditor
        compact
        minH="56px"
        value={question.explanation || ''}
        onChange={(html) => set('explanation', html)}
        placeholder="Explanation shown after submission"
      />
      {question.sourceExcerpt && (
        <Text fontSize="xs" color="gray.500" mt={2} fontStyle="italic" noOfLines={2}>
          Source: “{question.sourceExcerpt}”
        </Text>
      )}
    </Box>
  );
}

/** Step 2+ — the workspace for one lecture session. */
function SessionWorkspace({ classId, sessionId, topics, onChanged, onClose }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [working, setWorking] = useState('');
  const [transcriptDraft, setTranscriptDraft] = useState('');
  const [artefacts, setArtefacts] = useState(['notes', 'tutorial', 'quiz']);
  const [questionCount, setQuestionCount] = useState(10);
  const [difficulty, setDifficulty] = useState('mixed');
  const [askQuestion, setAskQuestion] = useState('');
  const [askAnswer, setAskAnswer] = useState('');
  const [draftQuestions, setDraftQuestions] = useState([]);
  const [notesTopicId, setNotesTopicId] = useState('');
  const toast = useToast();
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await lmApi.getSession(classId, sessionId);
      setSession(data);
      setTranscriptDraft(data.transcript?.text || '');
      setDraftQuestions(data.quizDraft?.questions || []);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId, sessionId]);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (key, fn, successTitle) => {
    setWorking(key);
    try {
      const result = await fn();
      if (successTitle) toast({ status: 'success', title: successTitle });
      await load();
      onChanged?.();
      return result;
    } catch (err) {
      toast({ status: 'error', title: err.message, duration: 8000 });
      return null;
    } finally {
      setWorking('');
    }
  };

  if (loading) return <Loading label="Loading session…" />;
  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!session) return null;

  const hasTranscript = (session.transcript?.text || '').trim().length > 100;

  return (
    <Box>
      <Flex justify="space-between" align="flex-start" mb={4} gap={3} wrap="wrap">
        <Box>
          <Button size="sm" variant="ghost" onClick={onClose} mb={1}>
            ← All lectures
          </Button>
          <Heading size="md">{session.title}</Heading>
          <HStack fontSize="sm" color="gray.500" spacing={3} mt={1} wrap="wrap">
            <Text>{formatDate(session.lectureDate)}</Text>
            <Badge colorScheme={session.status === 'ready' ? 'green' : session.status === 'failed' ? 'red' : 'gray'}>
              {session.status}
            </Badge>
            {session.recordingFilename && <Text>🎧 {session.recordingFilename}</Text>}
            {session.transcript?.wordCount > 0 && <Text>{session.transcript.wordCount} words</Text>}
          </HStack>
        </Box>
        <Button
          size="sm"
          variant="outline"
          colorScheme="red"
          onClick={async () => {
            // eslint-disable-next-line no-alert
            if (!window.confirm('Delete this session and everything generated from it?')) return;
            await lmApi.deleteSession(classId, sessionId).catch((e) => toast({ status: 'error', title: e.message }));
            onChanged?.();
            onClose();
          }}
        >
          Delete session
        </Button>
      </Flex>

      {session.error && (
        <Alert status="warning" borderRadius="md" mb={4} fontSize="sm">
          <AlertIcon />
          {session.error}
        </Alert>
      )}

      <Tabs colorScheme="purple" variant="enclosed">
        <TabList>
          <Tab fontSize="sm">1 · Transcript</Tab>
          <Tab fontSize="sm" isDisabled={!hasTranscript}>
            2 · Notes
          </Tab>
          <Tab fontSize="sm" isDisabled={!hasTranscript}>
            3 · Tutorial
          </Tab>
          <Tab fontSize="sm" isDisabled={!hasTranscript}>
            4 · Quiz
          </Tab>
          <Tab fontSize="sm" isDisabled={!hasTranscript}>
            Ask
          </Tab>
        </TabList>

        <TabPanels>
          {/* Transcript */}
          <TabPanel px={0}>
            <SectionCard
              title="Lecture transcript"
              subtitle="Everything downstream is generated from this text — fix any mis-heard terms before generating."
            >
              {session.recordingFilename && (
                <Box mb={4}>
                  <Text fontSize="sm" fontWeight="600" mb={2}>
                    Class audio
                  </Text>
                  {/* crossOrigin is needed in dev, where the Vite origin differs
                      from the API origin and a bare <audio> would not send the
                      auth cookie this endpoint requires. */}
                  <audio
                    controls
                    crossOrigin="use-credentials"
                    style={{ width: '100%' }}
                    src={lmApi.studioAudioUrl(classId, session.recordingFilename)}
                  />
                  <HStack mt={3}>
                    <Button
                      size="sm"
                      colorScheme="purple"
                      isLoading={working === 'transcribe'}
                      onClick={() => run('transcribe', () => lmApi.transcribeSession(classId, sessionId, 'en'), 'Transcribed')}
                    >
                      Transcribe automatically
                    </Button>
                    <Text fontSize="xs" color="gray.500">
                      Requires a speech-to-text service (LM_TRANSCRIBE_URL). Otherwise paste below.
                    </Text>
                  </HStack>
                </Box>
              )}

              <Textarea
                rows={16}
                value={transcriptDraft}
                onChange={(event) => setTranscriptDraft(event.target.value)}
                placeholder="Paste or correct the lecture transcript here…"
                fontFamily="mono"
                fontSize="sm"
              />
              <HStack mt={3}>
                <Button
                  size="sm"
                  colorScheme="blue"
                  isLoading={working === 'saveTranscript'}
                  onClick={() =>
                    run(
                      'saveTranscript',
                      () => lmApi.updateSession(classId, sessionId, { transcript: transcriptDraft }),
                      'Transcript saved',
                    )
                  }
                >
                  Save transcript
                </Button>
                <Text fontSize="xs" color="gray.500">
                  {transcriptDraft.trim().split(/\s+/).filter(Boolean).length} words
                </Text>
              </HStack>

              <Divider my={5} />

              <Heading size="xs" mb={3}>
                Generate study material
              </Heading>
              <CheckboxGroup value={artefacts} onChange={setArtefacts}>
                <HStack spacing={5} wrap="wrap">
                  <Checkbox value="notes">Notes</Checkbox>
                  <Checkbox value="tutorial">Tutorial</Checkbox>
                  <Checkbox value="quiz">Quiz</Checkbox>
                </HStack>
              </CheckboxGroup>
              <HStack mt={3} spacing={3} wrap="wrap">
                <FormControl maxW="140px">
                  <FormLabel fontSize="xs">Questions</FormLabel>
                  <Input
                    size="sm"
                    type="number"
                    min={1}
                    max={30}
                    value={questionCount}
                    onChange={(event) => setQuestionCount(Number(event.target.value))}
                  />
                </FormControl>
                <FormControl maxW="160px">
                  <FormLabel fontSize="xs">Difficulty</FormLabel>
                  <Select size="sm" value={difficulty} onChange={(event) => setDifficulty(event.target.value)}>
                    <option value="mixed">Mixed</option>
                    <option value="easy">Easy</option>
                    <option value="medium">Medium</option>
                    <option value="hard">Hard</option>
                  </Select>
                </FormControl>
              </HStack>
              <Button
                mt={4}
                colorScheme="purple"
                isLoading={working === 'generate'}
                loadingText="Generating — this can take a minute"
                isDisabled={!hasTranscript || !artefacts.length}
                onClick={() =>
                  run(
                    'generate',
                    () =>
                      lmApi.generateFromSession(classId, sessionId, {
                        artefacts,
                        questionCount,
                        difficulty,
                      }),
                    'Study material generated',
                  )
                }
              >
                ✨ Generate {artefacts.join(', ') || 'nothing'}
              </Button>
              {!hasTranscript && (
                <Text fontSize="xs" color="gray.500" mt={2}>
                  Save a transcript of at least 100 characters first.
                </Text>
              )}
            </SectionCard>
          </TabPanel>

          {/* Notes */}
          <TabPanel px={0}>
            <SectionCard
              title="Lecture notes"
              subtitle={session.notes?.provider ? `Generated by ${session.notes.provider}` : 'Not generated yet'}
              action={
                session.notes?.markdown ? (
                  <HStack>
                    <Select
                      size="sm"
                      maxW="160px"
                      placeholder="No topic"
                      value={notesTopicId}
                      onChange={(event) => setNotesTopicId(event.target.value)}
                    >
                      {topics.map((topic) => (
                        <option key={topic._id} value={topic._id}>
                          {topic.name}
                        </option>
                      ))}
                    </Select>
                    <Button
                      size="sm"
                      colorScheme="green"
                      isLoading={working === 'publishNotes'}
                      onClick={() =>
                        run(
                          'publishNotes',
                          () => lmApi.publishNotes(classId, sessionId, { topicId: notesTopicId || null }),
                          'Notes published to the class',
                        )
                      }
                    >
                      {session.notes.publishedCourseworkId ? 'Re-publish' : 'Publish to class'}
                    </Button>
                  </HStack>
                ) : null
              }
            >
              {session.notes?.markdown ? (
                <>
                  {session.notes.publishedCourseworkId && (
                    <Badge colorScheme="green" mb={3}>
                      Published as class material
                    </Badge>
                  )}
                  <Textarea
                    rows={8}
                    fontSize="sm"
                    fontFamily="mono"
                    value={session.notes.markdown}
                    onChange={(event) =>
                      setSession((prev) => ({ ...prev, notes: { ...prev.notes, markdown: event.target.value } }))
                    }
                    mb={2}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    mb={5}
                    isLoading={working === 'saveNotes'}
                    onClick={() =>
                      run(
                        'saveNotes',
                        () => lmApi.updateSession(classId, sessionId, { notesMarkdown: session.notes.markdown }),
                        'Notes saved',
                      )
                    }
                  >
                    Save edits
                  </Button>
                  <Divider mb={4} />
                  <Text fontSize="xs" color="gray.500" mb={2}>
                    Preview
                  </Text>
                  <Markdown>{session.notes.markdown}</Markdown>
                </>
              ) : (
                <EmptyState icon="📝" title="No notes yet" description="Generate them from the Transcript tab." />
              )}
            </SectionCard>
          </TabPanel>

          {/* Tutorial */}
          <TabPanel px={0}>
            <SectionCard
              title="Self-study tutorial"
              subtitle={session.tutorial?.provider ? `Generated by ${session.tutorial.provider}` : 'Not generated yet'}
              action={
                session.tutorial?.markdown ? (
                  <Button
                    size="sm"
                    colorScheme="green"
                    isLoading={working === 'publishTutorial'}
                    onClick={() =>
                      run('publishTutorial', () => lmApi.publishSessionTutorial(classId, sessionId), 'Tutorial published')
                    }
                  >
                    {session.tutorial.publishedCourseworkId ? 'Re-publish' : 'Publish to class'}
                  </Button>
                ) : null
              }
            >
              {session.tutorial?.markdown || session.tutorial?.summary ? (
                <>
                  {session.tutorial.summary && (
                    <Box bg="purple.50" borderRadius="md" p={4} mb={4}>
                      <Text fontSize="sm" fontWeight="600" mb={1}>
                        Summary
                      </Text>
                      <Text fontSize="sm">{session.tutorial.summary}</Text>
                    </Box>
                  )}

                  {session.tutorial.keyTerms?.length > 0 && (
                    <Box mb={4}>
                      <Heading size="xs" mb={2}>
                        Key terms
                      </Heading>
                      {session.tutorial.keyTerms.map((term) => (
                        <Box key={term.term} py={1.5} borderBottomWidth="1px" borderColor="gray.100">
                          <Text fontSize="sm" fontWeight="600">
                            {term.term}
                          </Text>
                          <Text fontSize="sm" color="gray.600">
                            {term.definition}
                          </Text>
                        </Box>
                      ))}
                    </Box>
                  )}

                  {session.tutorial.flashcards?.length > 0 && (
                    <Box mb={4}>
                      <Heading size="xs" mb={2}>
                        Flashcards ({session.tutorial.flashcards.length})
                      </Heading>
                      <Flex wrap="wrap" gap={2}>
                        {session.tutorial.flashcards.map((card, index) => (
                          <Box
                            key={index}
                            borderWidth="1px"
                            borderColor="gray.200"
                            borderRadius="md"
                            p={3}
                            w="220px"
                            bg="white"
                          >
                            <Text fontSize="sm" fontWeight="600" mb={1}>
                              {card.front}
                            </Text>
                            <Text fontSize="xs" color="gray.600">
                              {card.back}
                            </Text>
                          </Box>
                        ))}
                      </Flex>
                    </Box>
                  )}

                  {session.tutorial.faq?.length > 0 && (
                    <Box mb={4}>
                      <Heading size="xs" mb={2}>
                        FAQ
                      </Heading>
                      {session.tutorial.faq.map((entry, index) => (
                        <Box key={index} mb={2}>
                          <Text fontSize="sm" fontWeight="600">
                            {entry.question}
                          </Text>
                          <Text fontSize="sm" color="gray.600">
                            {entry.answer}
                          </Text>
                        </Box>
                      ))}
                    </Box>
                  )}

                  {session.tutorial.markdown && (
                    <>
                      <Divider my={4} />
                      <Textarea
                        rows={8}
                        fontSize="sm"
                        fontFamily="mono"
                        value={session.tutorial.markdown}
                        onChange={(event) =>
                          setSession((prev) => ({
                            ...prev,
                            tutorial: { ...prev.tutorial, markdown: event.target.value },
                          }))
                        }
                        mb={2}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        mb={5}
                        isLoading={working === 'saveTutorial'}
                        onClick={() =>
                          run(
                            'saveTutorial',
                            () =>
                              lmApi.updateSession(classId, sessionId, {
                                tutorialMarkdown: session.tutorial.markdown,
                              }),
                            'Tutorial saved',
                          )
                        }
                      >
                        Save edits
                      </Button>
                      <Divider mb={4} />
                      <Text fontSize="xs" color="gray.500" mb={2}>
                        Preview
                      </Text>
                      <Markdown>{session.tutorial.markdown}</Markdown>
                    </>
                  )}
                </>
              ) : (
                <EmptyState icon="🧑‍🏫" title="No tutorial yet" description="Generate it from the Transcript tab." />
              )}
            </SectionCard>
          </TabPanel>

          {/* Quiz */}
          <TabPanel px={0}>
            <SectionCard
              title={`Quiz draft (${draftQuestions.length} questions)`}
              subtitle="Review and edit every question, then turn it into a real quiz. Nothing reaches students until you publish it from the Quizzes tab."
              action={
                draftQuestions.length ? (
                  <HStack>
                    <Button
                      size="sm"
                      variant="outline"
                      isLoading={working === 'saveDraft'}
                      onClick={() =>
                        run(
                          'saveDraft',
                          () => lmApi.updateSession(classId, sessionId, { quizDraftQuestions: draftQuestions }),
                          'Draft saved',
                        )
                      }
                    >
                      Save draft
                    </Button>
                    <Button
                      size="sm"
                      colorScheme="purple"
                      isLoading={working === 'makeQuiz'}
                      onClick={async () => {
                        const quiz = await run(
                          'makeQuiz',
                          () => lmApi.publishQuizDraft(classId, sessionId, { questions: draftQuestions }),
                          'Quiz created — publish it from the Quizzes tab',
                        );
                        if (quiz?._id) navigate(`/learning/class/${classId}/quiz/${quiz._id}/edit`);
                      }}
                    >
                      Create quiz
                    </Button>
                  </HStack>
                ) : null
              }
            >
              {draftQuestions.length === 0 ? (
                <EmptyState icon="🧠" title="No quiz draft yet" description="Generate one from the Transcript tab." />
              ) : (
                <>
                  {draftQuestions.map((question, index) => (
                    <QuestionEditor
                      key={index}
                      index={index}
                      question={question}
                      onChange={(updated) =>
                        setDraftQuestions((prev) => prev.map((q, i) => (i === index ? updated : q)))
                      }
                      onRemove={() => setDraftQuestions((prev) => prev.filter((_, i) => i !== index))}
                    />
                  ))}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setDraftQuestions((prev) => [
                        ...prev,
                        {
                          question: '',
                          type: 'mcq',
                          options: ['', '', '', ''],
                          correctAnswers: [],
                          explanation: '',
                          marks: 1,
                          difficulty: 'medium',
                        },
                      ])
                    }
                  >
                    + Add question
                  </Button>
                </>
              )}
            </SectionCard>
          </TabPanel>

          {/* Ask */}
          <TabPanel px={0}>
            <SectionCard title="Ask this lecture" subtitle="Answers are grounded in the transcript only.">
              <Flex gap={2}>
                <Input
                  value={askQuestion}
                  onChange={(event) => setAskQuestion(event.target.value)}
                  placeholder="What did the lecturer say about convolution?"
                  onKeyDown={(event) => event.key === 'Enter' && askQuestion.trim() && (async () => {
                    setWorking('ask');
                    try {
                      const result = await lmApi.askSession(classId, sessionId, askQuestion);
                      setAskAnswer(result.text);
                    } catch (err) {
                      toast({ status: 'error', title: err.message });
                    } finally {
                      setWorking('');
                    }
                  })()}
                />
                <Button
                  colorScheme="purple"
                  isLoading={working === 'ask'}
                  isDisabled={!askQuestion.trim()}
                  onClick={async () => {
                    setWorking('ask');
                    try {
                      const result = await lmApi.askSession(classId, sessionId, askQuestion);
                      setAskAnswer(result.text);
                    } catch (err) {
                      toast({ status: 'error', title: err.message });
                    } finally {
                      setWorking('');
                    }
                  }}
                >
                  Ask
                </Button>
              </Flex>
              {askAnswer && (
                <Box mt={4} p={4} bg="gray.50" borderRadius="md">
                  <Markdown>{askAnswer}</Markdown>
                </Box>
              )}
            </SectionCard>
          </TabPanel>
        </TabPanels>
      </Tabs>
    </Box>
  );
}

/** Student-facing list of the study material published from lectures. */
function StudentLibrary({ classId }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(null);

  useEffect(() => {
    lmApi
      .listSessions(classId)
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, [classId]);

  if (loading) return <Loading />;
  if (!sessions.length) {
    return (
      <EmptyState
        icon="🎧"
        title="No lecture material yet"
        description="When your teacher turns a class recording into notes or a tutorial, it shows up here."
      />
    );
  }

  return (
    <Box>
      {sessions.map((session) => (
        <SectionCard
          key={session._id}
          title={session.title}
          subtitle={formatDate(session.lectureDate)}
          mb={3}
          action={
            <Button size="sm" variant="outline" onClick={() => setOpen(open === session._id ? null : session._id)}>
              {open === session._id ? 'Hide' : 'Read'}
            </Button>
          }
        >
          {open === session._id && (
            <Box mt={2}>
              {session.tutorial?.summary && (
                <Box bg="purple.50" p={4} borderRadius="md" mb={4}>
                  <Text fontSize="sm">{session.tutorial.summary}</Text>
                </Box>
              )}
              {session.notes?.markdown && <Markdown>{session.notes.markdown}</Markdown>}
              {session.tutorial?.markdown && (
                <>
                  <Divider my={4} />
                  <Markdown>{session.tutorial.markdown}</Markdown>
                </>
              )}
            </Box>
          )}
        </SectionCard>
      ))}
    </Box>
  );
}

export default function AiStudio() {
  const { classId, klass, isTeacher } = useOutletContext();
  const [sessions, setSessions] = useState([]);
  const [status, setStatus] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const newSession = useDisclosure();

  const load = useCallback(async () => {
    if (!isTeacher) return;
    setError(null);
    try {
      const [list, studioStatus] = await Promise.all([
        lmApi.listSessions(classId),
        lmApi.studioStatus(classId).catch(() => null),
      ]);
      setSessions(list);
      setStatus(studioStatus);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId, isTeacher]);

  useEffect(() => {
    load();
  }, [load]);

  if (!isTeacher) return <StudentLibrary classId={classId} />;
  if (loading) return <Loading label="Opening AI Studio…" />;

  if (activeId) {
    return (
      <SessionWorkspace
        classId={classId}
        sessionId={activeId}
        topics={klass.topics || []}
        onChanged={load}
        onClose={() => setActiveId(null)}
      />
    );
  }

  return (
    <Box>
      <Flex justify="space-between" align="flex-start" mb={4} gap={3} wrap="wrap">
        <Box>
          <Heading size="md">AI Studio</Heading>
          <Text fontSize="sm" color="gray.500">
            Turn a recorded class into notes, a tutorial and a quiz, then publish them to the class.
          </Text>
        </Box>
        <Button colorScheme="purple" onClick={newSession.onOpen}>
          + New lecture session
        </Button>
      </Flex>

      {status && (
        <Alert status={status.aiConfigured ? 'info' : 'warning'} borderRadius="md" mb={4} fontSize="sm">
          <AlertIcon />
          <Box>
            <Text>
              AI provider: <b>{status.aiProvider}</b> · Speech-to-text:{' '}
              <b>{status.transcriptionConfigured ? 'configured' : 'not configured'}</b>
            </Text>
            {!status.aiConfigured && (
              <Text fontSize="xs" mt={1}>
                No AI key is set (LM_AI_API_KEY), so generation falls back to an extractive draft built from
                the transcript. Everything still works — the output is just rougher.
              </Text>
            )}
            {!status.transcriptionConfigured && (
              <Text fontSize="xs">
                Without LM_TRANSCRIBE_URL you can still paste or upload a transcript for any lecture.
              </Text>
            )}
          </Box>
        </Alert>
      )}

      <ErrorState error={error} onRetry={load} />

      {sessions.length === 0 ? (
        <EmptyState
          icon="🎧"
          title="No lecture sessions yet"
          description="Pick a recording captured by the attendance module — or paste a transcript — and generate study material from it."
          action={
            <Button colorScheme="purple" onClick={newSession.onOpen}>
              Create your first session
            </Button>
          }
        />
      ) : (
        sessions.map((session) => (
          <Flex
            key={session._id}
            bg="white"
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="lg"
            p={4}
            mb={3}
            align="center"
            gap={4}
            wrap="wrap"
            _hover={{ borderColor: 'purple.300' }}
          >
            <Box flex="1" minW="220px">
              <Heading size="sm">{session.title}</Heading>
              <HStack fontSize="xs" color="gray.500" spacing={3} mt={1} wrap="wrap">
                <Text>{formatDate(session.lectureDate)}</Text>
                <Badge colorScheme={session.status === 'ready' ? 'green' : session.status === 'failed' ? 'red' : 'gray'}>
                  {session.status}
                </Badge>
                {session.recordingFilename && <Text>🎧 {session.recordingFilename}</Text>}
              </HStack>
              <HStack mt={2} spacing={2} wrap="wrap">
                <Badge colorScheme={session.hasTranscript ? 'green' : 'gray'}>
                  {session.hasTranscript ? '✓' : '○'} Transcript
                </Badge>
                <Badge colorScheme={session.hasNotes ? 'green' : 'gray'}>
                  {session.hasNotes ? '✓' : '○'} Notes
                  {session.notes?.publishedCourseworkId ? ' (published)' : ''}
                </Badge>
                <Badge colorScheme={session.hasTutorial ? 'green' : 'gray'}>
                  {session.hasTutorial ? '✓' : '○'} Tutorial
                </Badge>
                <Badge colorScheme={session.quizDraftCount ? 'green' : 'gray'}>
                  {session.quizDraftCount ? '✓' : '○'} Quiz ({session.quizDraftCount})
                </Badge>
              </HStack>
            </Box>
            <Button size="sm" colorScheme="purple" variant="outline" onClick={() => setActiveId(session._id)}>
              Open
            </Button>
          </Flex>
        ))
      )}

      <NewSessionModal
        isOpen={newSession.isOpen}
        onClose={newSession.onClose}
        classId={classId}
        onCreated={(created) => {
          load();
          setActiveId(created._id);
        }}
      />
    </Box>
  );
}
