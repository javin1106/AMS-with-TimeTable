import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Checkbox,
  Code,
  Divider,
  Flex,
  FormControl,
  FormLabel,
  HStack,
  Heading,
  Input,
  List,
  ListItem,
  Select,
  SimpleGrid,
  Table,
  Tbody,
  Td,
  Text,
  Textarea,
  Th,
  Thead,
  Tr,
  Tooltip,
  useToast,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import { ErrorState, Loading, SectionCard } from '../components/common';
import RichText from '../components/RichText';
import RichTextEditor from '../components/RichTextEditor';
import ImportQuestionsModal from '../components/ImportQuestionsModal';

const BLANK_VARIABLE = { name: '', type: 'range', min: 1, max: 10, step: 0, decimals: 2, values: [], unit: '' };
const BLANK_ANSWER = { key: '', label: '', formula: '', unit: '', tolerancePercent: 1, toleranceAbs: 0, marks: 1 };
const BLANK_QUESTION = {
  prompt: '',
  variables: [{ ...BLANK_VARIABLE, name: 'x' }],
  answers: [{ ...BLANK_ANSWER, label: 'Answer', formula: 'x' }],
  constraint: '',
  hint: '',
  solutionSteps: '',
  difficulty: 'medium',
};

/** Live formula check, debounced, so errors show while the teacher types. */
function useFormulaCheck(classId, formula, variableNames) {
  const [state, setState] = useState({ ok: true, error: null });
  const key = `${formula}|${variableNames.join(',')}`;

  useEffect(() => {
    if (!formula?.trim()) {
      setState({ ok: false, error: null });
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const result = await lmApi.validateFormula(classId, formula, variableNames);
        if (!cancelled) setState(result);
      } catch {
        if (!cancelled) setState({ ok: true, error: null });
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `key` collapses the two real inputs into one stable dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, key]);

  return state;
}

function VariableRow({ variable, onChange, onRemove }) {
  const set = (field, value) => onChange({ ...variable, [field]: value });

  return (
    <Flex gap={2} align="flex-end" wrap="wrap" mb={2}>
      <FormControl maxW="110px">
        <FormLabel fontSize="xs" mb={1}>
          Name
        </FormLabel>
        <Input
          size="sm"
          value={variable.name}
          placeholder="R"
          onChange={(event) => set('name', event.target.value.trim())}
        />
      </FormControl>
      <FormControl maxW="120px">
        <FormLabel fontSize="xs" mb={1}>
          Type
        </FormLabel>
        <Select size="sm" value={variable.type} onChange={(event) => set('type', event.target.value)}>
          <option value="range">Decimal</option>
          <option value="integer">Integer</option>
          <option value="set">From a list</option>
        </Select>
      </FormControl>

      {variable.type === 'set' ? (
        <FormControl flex="1" minW="200px">
          <FormLabel fontSize="xs" mb={1}>
            Values (comma separated)
          </FormLabel>
          <Input
            size="sm"
            value={(variable.values || []).join(', ')}
            placeholder="2, 4, 8"
            onChange={(event) =>
              set(
                'values',
                event.target.value
                  .split(',')
                  .map((value) => value.trim())
                  .filter(Boolean),
              )
            }
          />
        </FormControl>
      ) : (
        <>
          <FormControl maxW="90px">
            <FormLabel fontSize="xs" mb={1}>
              Min
            </FormLabel>
            <Input size="sm" type="number" value={variable.min} onChange={(e) => set('min', Number(e.target.value))} />
          </FormControl>
          <FormControl maxW="90px">
            <FormLabel fontSize="xs" mb={1}>
              Max
            </FormLabel>
            <Input size="sm" type="number" value={variable.max} onChange={(e) => set('max', Number(e.target.value))} />
          </FormControl>
          <FormControl maxW="90px">
            <Tooltip label="Values land on this grid, so students get 4.5 not 4.5137">
              <FormLabel fontSize="xs" mb={1}>
                Step
              </FormLabel>
            </Tooltip>
            <Input size="sm" type="number" value={variable.step} onChange={(e) => set('step', Number(e.target.value))} />
          </FormControl>
          {variable.type === 'range' && (
            <FormControl maxW="90px">
              <FormLabel fontSize="xs" mb={1}>
                Decimals
              </FormLabel>
              <Input
                size="sm"
                type="number"
                value={variable.decimals}
                onChange={(e) => set('decimals', Number(e.target.value))}
              />
            </FormControl>
          )}
        </>
      )}

      <FormControl maxW="90px">
        <FormLabel fontSize="xs" mb={1}>
          Unit
        </FormLabel>
        <Input size="sm" value={variable.unit} placeholder="Ω" onChange={(e) => set('unit', e.target.value)} />
      </FormControl>
      <Button size="sm" variant="ghost" colorScheme="red" onClick={onRemove}>
        ✕
      </Button>
    </Flex>
  );
}

function AnswerRow({ classId, answer, variableNames, onChange, onRemove }) {
  const set = (field, value) => onChange({ ...answer, [field]: value });
  const check = useFormulaCheck(classId, answer.formula, variableNames);

  return (
    <Box borderWidth="1px" borderColor="gray.200" borderRadius="md" p={3} mb={2}>
      <Flex gap={2} align="flex-end" wrap="wrap">
        <FormControl maxW="150px">
          <FormLabel fontSize="xs" mb={1}>
            Label
          </FormLabel>
          <Input size="sm" value={answer.label} placeholder="Power" onChange={(e) => set('label', e.target.value)} />
        </FormControl>
        <FormControl flex="1" minW="220px">
          <FormLabel fontSize="xs" mb={1}>
            Answer formula
          </FormLabel>
          <Input
            size="sm"
            fontFamily="mono"
            value={answer.formula}
            placeholder="I^2*R"
            isInvalid={Boolean(check.error)}
            onChange={(e) => set('formula', e.target.value)}
          />
        </FormControl>
        <FormControl maxW="80px">
          <FormLabel fontSize="xs" mb={1}>
            Unit
          </FormLabel>
          <Input size="sm" value={answer.unit} placeholder="W" onChange={(e) => set('unit', e.target.value)} />
        </FormControl>
        <FormControl maxW="90px">
          <Tooltip label="An answer within this percentage of the exact value is marked correct">
            <FormLabel fontSize="xs" mb={1}>
              Tol %
            </FormLabel>
          </Tooltip>
          <Input
            size="sm"
            type="number"
            value={answer.tolerancePercent}
            onChange={(e) => set('tolerancePercent', Number(e.target.value))}
          />
        </FormControl>
        <FormControl maxW="90px">
          <Tooltip label="Absolute allowance — needed when the answer is close to zero">
            <FormLabel fontSize="xs" mb={1}>
              Tol ±
            </FormLabel>
          </Tooltip>
          <Input
            size="sm"
            type="number"
            value={answer.toleranceAbs}
            onChange={(e) => set('toleranceAbs', Number(e.target.value))}
          />
        </FormControl>
        <FormControl maxW="80px">
          <FormLabel fontSize="xs" mb={1}>
            Marks
          </FormLabel>
          <Input size="sm" type="number" value={answer.marks} onChange={(e) => set('marks', Number(e.target.value))} />
        </FormControl>
        <Button size="sm" variant="ghost" colorScheme="red" onClick={onRemove}>
          ✕
        </Button>
      </Flex>
      {check.error && (
        <Text fontSize="xs" color="red.600" mt={2}>
          {check.error}
        </Text>
      )}
    </Box>
  );
}

function QuestionCard({ classId, question, index, onChange, onRemove }) {
  const set = (field, value) => onChange({ ...question, [field]: value });
  const variableNames = useMemo(
    () => (question.variables || []).map((variable) => variable.name).filter(Boolean),
    [question.variables],
  );
  const constraintCheck = useFormulaCheck(classId, question.constraint, variableNames);

  const usedInPrompt = useMemo(() => {
    const found = new Set();
    String(question.prompt || '').replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (m, name) => {
      found.add(name);
      return m;
    });
    return [...found];
  }, [question.prompt]);
  const missingInPrompt = usedInPrompt.filter((name) => !variableNames.includes(name));

  return (
    <SectionCard mb={4}>
      <Flex justify="space-between" align="center" mb={3}>
        <Heading size="sm">Question {index + 1}</Heading>
        <HStack>
          <Select size="sm" w="110px" value={question.difficulty} onChange={(e) => set('difficulty', e.target.value)}>
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
          </Select>
          <Button size="sm" variant="ghost" colorScheme="red" onClick={onRemove}>
            Delete
          </Button>
        </HStack>
      </Flex>

      <FormControl mb={1}>
        <FormLabel fontSize="sm">
          Prompt — use the buttons below to drop a <Code fontSize="xs">{'{{variable}}'}</Code> at the cursor
        </FormLabel>
        <RichTextEditor
          value={question.prompt}
          onChange={(html) => set('prompt', html)}
          placeholder="A resistor of {{R}} Ω carries {{I}} A. Find the power dissipated."
          variables={variableNames}
          minH="110px"
        />
      </FormControl>
      {missingInPrompt.length > 0 && (
        <Text fontSize="xs" color="red.600" mb={3}>
          The prompt uses {missingInPrompt.map((name) => `{{${name}}}`).join(', ')} but{' '}
          {missingInPrompt.length === 1 ? 'that variable is' : 'those variables are'} not declared below.
        </Text>
      )}

      <Divider my={4} />
      <Heading size="xs" mb={2} color="gray.700">
        Variables
      </Heading>
      {(question.variables || []).map((variable, variableIndex) => (
        <VariableRow
          key={variableIndex}
          variable={variable}
          onChange={(updated) =>
            set(
              'variables',
              question.variables.map((v, i) => (i === variableIndex ? updated : v)),
            )
          }
          onRemove={() =>
            set(
              'variables',
              question.variables.filter((_, i) => i !== variableIndex),
            )
          }
        />
      ))}
      <Button size="xs" variant="link" onClick={() => set('variables', [...(question.variables || []), { ...BLANK_VARIABLE }])}>
        + Add variable
      </Button>

      <Divider my={4} />
      <Heading size="xs" mb={2} color="gray.700">
        Answers
      </Heading>
      <Text fontSize="xs" color="gray.500" mb={2}>
        Each answer is a formula over the variables above. It is evaluated per student and compared
        with what they type.
      </Text>
      {(question.answers || []).map((answer, answerIndex) => (
        <AnswerRow
          key={answerIndex}
          classId={classId}
          answer={answer}
          variableNames={variableNames}
          onChange={(updated) =>
            set(
              'answers',
              question.answers.map((a, i) => (i === answerIndex ? updated : a)),
            )
          }
          onRemove={() =>
            set(
              'answers',
              question.answers.filter((_, i) => i !== answerIndex),
            )
          }
        />
      ))}
      <Button size="xs" variant="link" onClick={() => set('answers', [...(question.answers || []), { ...BLANK_ANSWER }])}>
        + Add answer
      </Button>

      <Divider my={4} />
      <SimpleGrid columns={{ base: 1, md: 2 }} spacing={4}>
        <FormControl>
          <Tooltip label="Values are re-drawn until this is true — use it to avoid divide-by-zero">
            <FormLabel fontSize="sm">Constraint (optional)</FormLabel>
          </Tooltip>
          <Input
            size="sm"
            fontFamily="mono"
            value={question.constraint}
            placeholder="b != c && R > 0"
            isInvalid={Boolean(constraintCheck.error)}
            onChange={(e) => set('constraint', e.target.value)}
          />
          {constraintCheck.error && (
            <Text fontSize="xs" color="red.600" mt={1}>
              {constraintCheck.error}
            </Text>
          )}
        </FormControl>
        <FormControl>
          <FormLabel fontSize="sm">Hint (optional)</FormLabel>
          <RichTextEditor
            compact
            minH="56px"
            value={question.hint}
            onChange={(html) => set('hint', html)}
            placeholder="Ohm's law relates V, I and R"
          />
        </FormControl>
      </SimpleGrid>

      <FormControl mt={4}>
        <FormLabel fontSize="sm">Worked solution — shown after submitting</FormLabel>
        <RichTextEditor
          value={question.solutionSteps}
          onChange={(html) => set('solutionSteps', html)}
          placeholder="P = I²R = {{I}}² × {{R}}"
          variables={variableNames}
          minH="110px"
        />
      </FormControl>
    </SectionCard>
  );
}

function PreviewPanel({ classId, tutorialId, dirty }) {
  const [samples, setSamples] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const run = async () => {
    setBusy(true);
    try {
      const result = await lmApi.previewTutorial(classId, tutorialId, 3);
      setSamples(result.samples);
      setWarnings(result.warnings);
    } catch (error) {
      toast({ status: 'error', title: error.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard
      title="Preview"
      subtitle="Roll sample papers to see the actual numbers students will get."
      action={
        <Button size="sm" colorScheme="teal" variant="outline" onClick={run} isLoading={busy}>
          Roll samples
        </Button>
      }
    >
      {dirty && (
        <Alert status="info" borderRadius="md" mb={3} fontSize="sm">
          <AlertIcon />
          Save your changes first — the preview runs against the saved version.
        </Alert>
      )}

      {warnings.length > 0 && (
        <Alert status="warning" borderRadius="md" mb={3} fontSize="sm" alignItems="flex-start">
          <AlertIcon />
          <Box>
            <Text fontWeight="600">Some draws produce an unanswerable question:</Text>
            <List fontSize="xs" mt={1}>
              {warnings.map((warning) => (
                <ListItem key={warning}>• {warning}</ListItem>
              ))}
            </List>
          </Box>
        </Alert>
      )}

      {!samples ? (
        <Text fontSize="sm" color="gray.500">
          No samples rolled yet.
        </Text>
      ) : (
        samples.map((sample) => (
          <Box key={sample.label} mb={4} borderWidth="1px" borderColor="gray.200" borderRadius="md" p={3}>
            <Badge mb={2}>{sample.label}</Badge>
            {sample.questions.map((question, index) => (
              <Box key={index} mb={3}>
                <RichText>{question.prompt}</RichText>
                <HStack fontSize="xs" color="gray.500" mt={1} wrap="wrap">
                  {Object.entries(question.values).map(([name, value]) => (
                    <Code key={name} fontSize="xs">
                      {name} = {String(value)}
                    </Code>
                  ))}
                </HStack>
                <HStack fontSize="xs" mt={1} wrap="wrap">
                  {question.expected.map((expected) => (
                    <Badge key={expected.key} colorScheme={expected.error ? 'red' : 'green'}>
                      {expected.label}:{' '}
                      {expected.error ? 'failed' : `${Math.round(expected.value * 1e6) / 1e6} ${expected.unit}`}
                    </Badge>
                  ))}
                </HStack>
              </Box>
            ))}
          </Box>
        ))
      )}
    </SectionCard>
  );
}

export default function TutorialEditor() {
  const { classId, klass } = useOutletContext();
  const { tutorialId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [tutorial, setTutorial] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [reference, setReference] = useState(null);
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [data, ref] = await Promise.all([
        lmApi.getTutorial(classId, tutorialId),
        lmApi.formulaReference(classId).catch(() => null),
      ]);
      setTutorial(data);
      setReference(ref);
      setDirty(false);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId, tutorialId]);

  useEffect(() => {
    load();
  }, [load]);

  const update = (changes) => {
    setTutorial((prev) => ({ ...prev, ...changes }));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await lmApi.updateTutorial(classId, tutorialId, {
        title: tutorial.title,
        description: tutorial.description,
        topicId: tutorial.topicId,
        questions: tutorial.questions,
        settings: tutorial.settings,
      });
      toast({ status: 'success', title: 'Tutorial saved' });
      await load();
      return true;
    } catch (err) {
      toast({
        status: 'error',
        title: err.message,
        description: err.payload?.errors?.slice(1, 4).join(' · '),
        duration: 10000,
      });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    if (!(await save())) return;
    try {
      await lmApi.publishTutorial(classId, tutorialId, { publish: true });
      toast({ status: 'success', title: 'Published to the class' });
      navigate(`/learning/class/${classId}/tutorials`);
    } catch (err) {
      toast({
        status: 'error',
        title: err.message,
        description: err.payload?.errors?.slice(0, 3).join(' · '),
        duration: 10000,
      });
    }
  };

  if (loading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!tutorial) return null;

  const setSetting = (key, value) =>
    update({ settings: { ...tutorial.settings, [key]: value } });

  const totalMarks = (tutorial.questions || []).reduce(
    (sum, question) => sum + (question.answers || []).reduce((inner, a) => inner + (Number(a.marks) || 0), 0),
    0,
  );

  return (
    <Box>
      <Flex justify="space-between" align="center" mb={4} gap={3} wrap="wrap">
        <Box>
          <Button size="sm" variant="ghost" onClick={() => navigate(`/learning/class/${classId}/tutorials`)}>
            ← Back to tutorials
          </Button>
          <Text fontSize="sm" color="gray.500" mt={1}>
            {tutorial.questions.length} questions · {totalMarks} marks
            {dirty ? ' · unsaved changes' : ''}
          </Text>
        </Box>
        <HStack>
          <Button size="sm" variant="outline" onClick={save} isLoading={saving}>
            Save
          </Button>
          <Button size="sm" colorScheme="green" onClick={publish} isDisabled={!tutorial.questions.length}>
            Save &amp; publish
          </Button>
        </HStack>
      </Flex>

      <SectionCard title="Tutorial details" mb={4}>
        <FormControl mb={3}>
          <FormLabel fontSize="sm">Title</FormLabel>
          <Input value={tutorial.title} onChange={(e) => update({ title: e.target.value })} />
        </FormControl>
        <FormControl mb={4}>
          <FormLabel fontSize="sm">Description</FormLabel>
          <Textarea rows={2} value={tutorial.description} onChange={(e) => update({ description: e.target.value })} />
        </FormControl>

        <SimpleGrid columns={{ base: 2, md: 4 }} spacing={4}>
          <FormControl>
            <FormLabel fontSize="xs">Topic</FormLabel>
            <Select size="sm" value={tutorial.topicId || ''} onChange={(e) => update({ topicId: e.target.value || null })}>
              <option value="">No topic</option>
              {(klass.topics || []).map((topic) => (
                <option key={topic._id} value={topic._id}>
                  {topic.name}
                </option>
              ))}
            </Select>
          </FormControl>
          <FormControl>
            <FormLabel fontSize="xs">Attempts allowed</FormLabel>
            <Input
              size="sm"
              type="number"
              min={1}
              value={tutorial.settings.attemptsAllowed}
              onChange={(e) => setSetting('attemptsAllowed', Number(e.target.value) || 1)}
            />
          </FormControl>
          <FormControl>
            <FormLabel fontSize="xs">Pass mark (%)</FormLabel>
            <Input
              size="sm"
              type="number"
              value={tutorial.settings.passPercent}
              onChange={(e) => setSetting('passPercent', Number(e.target.value) || 0)}
            />
          </FormControl>
          <FormControl>
            <FormLabel fontSize="xs">Due date</FormLabel>
            <Input
              size="sm"
              type="datetime-local"
              value={tutorial.settings.dueDate ? new Date(tutorial.settings.dueDate).toISOString().slice(0, 16) : ''}
              onChange={(e) => setSetting('dueDate', e.target.value || null)}
            />
          </FormControl>
        </SimpleGrid>

        <HStack mt={4} spacing={5} wrap="wrap">
          <Checkbox
            size="sm"
            isChecked={tutorial.settings.newValuesOnRetry}
            onChange={(e) => setSetting('newValuesOnRetry', e.target.checked)}
          >
            Fresh numbers on each retry
          </Checkbox>
          <Checkbox
            size="sm"
            isChecked={tutorial.settings.showSolutionAfterSubmit}
            onChange={(e) => setSetting('showSolutionAfterSubmit', e.target.checked)}
          >
            Show the worked solution after submitting
          </Checkbox>
          <Checkbox
            size="sm"
            isChecked={tutorial.settings.showHints}
            onChange={(e) => setSetting('showHints', e.target.checked)}
          >
            Show hints
          </Checkbox>
        </HStack>
      </SectionCard>

      {reference && (
        <SectionCard title="Formula reference" mb={4}>
          <Text fontSize="sm" color="gray.600" mb={2}>
            Operators <Code fontSize="xs">+ - * / % ^</Code>, comparisons{' '}
            <Code fontSize="xs">== != &lt; &lt;= &gt; &gt;=</Code> and <Code fontSize="xs">&amp;&amp; ||</Code> for
            constraints. Constants: {reference.constants.map((c) => <Code key={c} fontSize="xs" mr={1}>{c}</Code>)}
          </Text>
          <Flex wrap="wrap" gap={1}>
            {reference.functions.map((fn) => (
              <Code key={fn} fontSize="xs">
                {fn}()
              </Code>
            ))}
          </Flex>
        </SectionCard>
      )}

      {tutorial.questions.map((question, index) => (
        <QuestionCard
          key={question._id || index}
          classId={classId}
          question={question}
          index={index}
          onChange={(updated) =>
            update({ questions: tutorial.questions.map((q, i) => (i === index ? updated : q)) })
          }
          onRemove={() => update({ questions: tutorial.questions.filter((_, i) => i !== index) })}
        />
      ))}

      <Flex gap={2} mb={5} wrap="wrap">
        <Button
          variant="outline"
          onClick={() => update({ questions: [...tutorial.questions, JSON.parse(JSON.stringify(BLANK_QUESTION))] })}
        >
          + Add question
        </Button>
        {/* Save first: the import appends to the stored tutorial and this page
            reloads it afterwards, so unsaved edits would go with the reload. */}
        <Button
          variant="outline"
          isLoading={saving}
          onClick={async () => {
            if (!(await save())) return;
            setImporting(true);
          }}
        >
          📥 Import questions
        </Button>
      </Flex>

      <ImportQuestionsModal
        isOpen={importing}
        onClose={() => setImporting(false)}
        classId={classId}
        type="tutorial"
        targetId={tutorialId}
        partLabel="questions"
        onImported={load}
      />

      <PreviewPanel classId={classId} tutorialId={tutorialId} dirty={dirty} />
    </Box>
  );
}
