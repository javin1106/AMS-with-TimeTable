import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
  NumberInput,
  NumberInputField,
  Radio,
  Select,
  SimpleGrid,
  Switch,
  Text,
  Textarea,
  VStack,
  useToast,
} from '@chakra-ui/react';
import { FiArrowDown, FiArrowUp, FiCopy, FiTrash2 } from 'react-icons/fi';

import lmApi from '../api/lmApi';
import { ErrorState, Loading, SectionCard } from '../components/common';
import RichTextEditor from '../components/RichTextEditor';
import { isRichTextEmpty } from '../richTextUtils';

/**
 * Authoring surface for a Short.
 *
 * Every slide type is edited in place rather than through a modal, because the
 * common motion is "add six quick questions before the lecture" and a dialog per
 * slide triples the number of clicks.
 *
 * Nothing here is trusted: the server re-runs prepareSlides/validateSlides on
 * save. The checks in this file exist so the teacher finds out before the room
 * is watching, not as enforcement.
 */

const SLIDE_TYPES = [
  { value: 'mcq', label: 'Multiple choice', hint: 'One answer from a list. Bar chart.' },
  { value: 'msq', label: 'Multiple answer', hint: 'Any number of answers. Bars can exceed 100%.' },
  { value: 'truefalse', label: 'True / false', hint: 'Options are fixed.' },
  { value: 'wordcloud', label: 'Word cloud', hint: 'A word or three, sized by how often it comes up.' },
  { value: 'scale', label: 'Scale', hint: 'Rate between two labels. Histogram, mean and median.' },
  { value: 'open', label: 'Open text', hint: 'A sentence or two, shown as cards.' },
  { value: 'ranking', label: 'Ranking', hint: 'Drag into order. Aggregated by Borda count.' },
  { value: 'numeric', label: 'Numeric estimate', hint: 'A number. Spread, mean and median.' },
];

const HAS_OPTIONS = ['mcq', 'msq', 'truefalse', 'ranking'];
// Only these can carry an answer key. A word cloud is an opinion, not a question.
const CAN_BE_MARKED = ['mcq', 'msq', 'truefalse', 'ranking', 'numeric'];

const blankSlide = (type = 'mcq') => ({
  _key: Math.random().toString(36).slice(2),
  type,
  question: '',
  options: type === 'truefalse' ? ['True', 'False'] : ['', ''],
  correctAnswers: [],
  explanation: '',
  timeLimitSec: 30,
  marks: 1,
  scaleMin: 1,
  scaleMax: 5,
  scaleMinLabel: '',
  scaleMaxLabel: '',
  correctNumber: '',
  tolerancePercent: 0,
  toleranceAbs: 0,
  maxWords: 3,
  maxLength: 200,
});

// The server sends slides without the local _key that keeps React's list stable
// across reordering, so one is minted on load.
const withKeys = (slides) =>
  (slides || []).map((slide) => ({
    ...blankSlide(slide.type),
    ...slide,
    correctNumber: slide.correctNumber ?? '',
    _key: String(slide._id || Math.random().toString(36).slice(2)),
  }));

/** Mirrors the server's validateSlides so problems surface while editing. */
function validate(slides) {
  const problems = [];
  slides.forEach((slide, index) => {
    const where = `Slide ${index + 1}`;
    if (isRichTextEmpty(slide.question)) problems.push(`${where}: the question is empty.`);
    if (['mcq', 'msq', 'ranking'].includes(slide.type)) {
      if (slide.options.filter((option) => option.trim()).length < 2) {
        problems.push(`${where}: add at least two options.`);
      }
    }
    if (slide.type === 'scale' && Number(slide.scaleMax) <= Number(slide.scaleMin)) {
      problems.push(`${where}: the scale maximum must be above the minimum.`);
    }
    if (slide.type === 'ranking' && slide.correctAnswers.length) {
      if (slide.correctAnswers.length !== slide.options.length) {
        problems.push(`${where}: a ranking key must place every option, or none.`);
      }
    }
  });
  return problems;
}

function OptionRows({ slide, onChange }) {
  const single = slide.type === 'mcq' || slide.type === 'truefalse';
  const locked = slide.type === 'truefalse';
  const isRanking = slide.type === 'ranking';

  const setOption = (index, value) => {
    const options = [...slide.options];
    options[index] = value;
    onChange({ options });
  };

  const addOption = () => {
    const options = [...slide.options, ''];
    // A ranking key has to place every item, so a new row joins the key at the
    // end rather than leaving the slide failing validation the moment it is
    // added. Nothing to do when there is no key — the slide is a poll.
    if (slide.type === 'ranking' && slide.correctAnswers.length) {
      onChange({ options, correctAnswers: [...slide.correctAnswers, String(slide.options.length)] });
      return;
    }
    onChange({ options });
  };

  const removeOption = (index) => {
    const options = slide.options.filter((_, i) => i !== index);
    // A key referring to a removed option would mark the whole room wrong with
    // nothing on screen to explain why, so keys are re-indexed here.
    const correctAnswers = slide.correctAnswers
      .filter((value) => Number(value) !== index)
      .map((value) => String(Number(value) > index ? Number(value) - 1 : Number(value)));
    onChange({ options, correctAnswers });
  };

  const toggleCorrect = (index) => {
    const value = String(index);
    if (single) {
      onChange({ correctAnswers: slide.correctAnswers.includes(value) ? [] : [value] });
      return;
    }
    onChange({
      correctAnswers: slide.correctAnswers.includes(value)
        ? slide.correctAnswers.filter((entry) => entry !== value)
        : [...slide.correctAnswers, value],
    });
  };

  // The key for a ranking *is* an order, so there is no checkbox to tick — the
  // controls below all write a permutation of the option indices.
  const identityOrder = () => slide.options.map((_, i) => String(i));
  const currentOrder = () =>
    slide.correctAnswers.length ? [...slide.correctAnswers] : identityOrder();

  const moveInKey = (index, delta) => {
    const order = currentOrder();
    const from = order.indexOf(String(index));
    const to = from + delta;
    if (from < 0 || to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to], order[from]];
    onChange({ correctAnswers: order });
  };

  // Stating a rank outright, rather than nudging towards it. Swapping with
  // whoever holds that rank keeps the key a complete permutation at every step,
  // which is what the server requires — a half-assigned key is not a valid one.
  const setRank = (index, rank) => {
    const order = currentOrder();
    const from = order.indexOf(String(index));
    const to = rank - 1;
    if (from < 0 || to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to], order[from]];
    onChange({ correctAnswers: order });
  };

  const keyOrder = slide.correctAnswers.length ? slide.correctAnswers : null;
  // Unique per slide, so one slide's answer key is never a sibling of another's.
  const keyPrefix = `answer-${slide._key}`;

  return (
    <VStack align="stretch" spacing={2}>
      {slide.options.map((option, index) => (
        <HStack key={index} spacing={2}>
          {isRanking ? (
            /* A rank the teacher picks, not only one they nudge towards with
               the arrows. Until a key exists every row reads "–", which is the
               honest state: an unkeyed ranking runs as an opinion poll. */
            <Select
              size="sm"
              w="70px"
              flexShrink={0}
              value={keyOrder ? keyOrder.indexOf(String(index)) + 1 : ''}
              title="Position in the correct order"
              onChange={(event) =>
                // Choosing "–" drops the key entirely: a ranking is keyed as a
                // whole sequence or not at all, so there is no single row to
                // un-rank on its own.
                event.target.value
                  ? setRank(index, Number(event.target.value))
                  : onChange({ correctAnswers: [] })
              }
            >
              <option value="">–</option>
              {slide.options.map((_, rank) => (
                <option key={rank} value={rank + 1}>
                  {rank + 1}
                </option>
              ))}
            </Select>
          ) : single ? (
            /* The id and name are not decoration. A Radio inside a FormControl
               but outside a RadioGroup inherits the *FormControl's* id, and its
               root label points `htmlFor` at it — so every row would carry the
               same id and every click would land on the first option. */
            <Radio
              id={`${keyPrefix}-${index}`}
              name={keyPrefix}
              isChecked={slide.correctAnswers.includes(String(index))}
              onChange={() => toggleCorrect(index)}
              title="Mark as the correct answer"
            />
          ) : (
            <Checkbox
              id={`${keyPrefix}-${index}`}
              isChecked={slide.correctAnswers.includes(String(index))}
              onChange={() => toggleCorrect(index)}
              title="Mark as a correct answer"
            />
          )}

          <Input
            size="sm"
            value={option}
            isReadOnly={locked}
            placeholder={`Option ${index + 1}`}
            onChange={(event) => setOption(index, event.target.value)}
          />

          {isRanking && (
            <>
              <IconButton
                aria-label="Move earlier in the correct order"
                icon={<FiArrowUp />}
                size="xs"
                variant="ghost"
                onClick={() => moveInKey(index, -1)}
              />
              <IconButton
                aria-label="Move later in the correct order"
                icon={<FiArrowDown />}
                size="xs"
                variant="ghost"
                onClick={() => moveInKey(index, 1)}
              />
            </>
          )}

          {!locked && slide.options.length > 2 && (
            <IconButton
              aria-label="Remove option"
              icon={<FiTrash2 />}
              size="xs"
              variant="ghost"
              colorScheme="red"
              onClick={() => removeOption(index)}
            />
          )}
        </HStack>
      ))}

      {!locked && (
        <HStack>
          <Button size="xs" variant="outline" onClick={addOption}>
            Add option
          </Button>
          {!isRanking && slide.correctAnswers.length > 0 && (
            <Button size="xs" variant="ghost" onClick={() => onChange({ correctAnswers: [] })}>
              Clear answer key (make it a poll)
            </Button>
          )}
          {/* The obvious intent — "I typed them in the right order" — had no
              control at all: every other way in swaps two rows, so the order as
              listed could only be keyed by nudging one row away and back. */}
          {isRanking && !slide.correctAnswers.length && slide.options.length > 1 && (
            <Button
              size="xs"
              variant="outline"
              colorScheme="purple"
              onClick={() => onChange({ correctAnswers: slide.options.map((_, i) => String(i)) })}
            >
              Use the order shown as the answer
            </Button>
          )}
          {isRanking && slide.correctAnswers.length > 0 && (
            <Button size="xs" variant="ghost" onClick={() => onChange({ correctAnswers: [] })}>
              Clear correct order
            </Button>
          )}
        </HStack>
      )}
    </VStack>
  );
}

function SlideCard({ slide, index, total, onChange, onMove, onRemove, onDuplicate }) {
  const meta = SLIDE_TYPES.find((entry) => entry.value === slide.type);
  const marked = CAN_BE_MARKED.includes(slide.type) &&
    (slide.correctAnswers.length > 0 || (slide.type === 'numeric' && slide.correctNumber !== ''));

  const changeType = (type) => {
    // Options and keys rarely survive a type change intact; resetting them is
    // less surprising than carrying a key that now points at the wrong thing.
    onChange({
      type,
      options: type === 'truefalse' ? ['True', 'False'] : HAS_OPTIONS.includes(type) ? slide.options : [],
      correctAnswers: [],
    });
  };

  return (
    <SectionCard>
      <Flex align="center" gap={2} mb={3} wrap="wrap">
        <Badge fontSize="sm" px={2} py={1}>
          {index + 1}
        </Badge>
        <Select
          size="sm"
          maxW="220px"
          value={slide.type}
          onChange={(event) => changeType(event.target.value)}
        >
          {SLIDE_TYPES.map((type) => (
            <option key={type.value} value={type.value}>
              {type.label}
            </option>
          ))}
        </Select>
        {marked ? (
          <Badge colorScheme="green">marked</Badge>
        ) : (
          <Badge colorScheme="gray">poll</Badge>
        )}
        <Box flex="1" />
        <IconButton
          aria-label="Move slide up"
          icon={<FiArrowUp />}
          size="xs"
          variant="ghost"
          isDisabled={index === 0}
          onClick={() => onMove(-1)}
        />
        <IconButton
          aria-label="Move slide down"
          icon={<FiArrowDown />}
          size="xs"
          variant="ghost"
          isDisabled={index === total - 1}
          onClick={() => onMove(1)}
        />
        <IconButton aria-label="Duplicate slide" icon={<FiCopy />} size="xs" variant="ghost" onClick={onDuplicate} />
        <IconButton
          aria-label="Delete slide"
          icon={<FiTrash2 />}
          size="xs"
          variant="ghost"
          colorScheme="red"
          onClick={onRemove}
        />
      </Flex>

      {meta?.hint ? (
        <Text fontSize="xs" opacity={0.6} mb={2}>
          {meta.hint}
        </Text>
      ) : null}

      <FormControl mb={3} isInvalid={isRichTextEmpty(slide.question)}>
        <FormLabel fontSize="sm">Question</FormLabel>
        <RichTextEditor
          value={slide.question}
          onChange={(question) => onChange({ question })}
          placeholder="What do you want to ask the room?"
          compact
          minH="90px"
        />
      </FormControl>

      {HAS_OPTIONS.includes(slide.type) && (
        <FormControl mb={3}>
          <FormLabel fontSize="sm">
            {slide.type === 'ranking' ? 'Items to rank' : 'Options'}
          </FormLabel>
          <OptionRows slide={slide} onChange={onChange} />
          <FormHelperText fontSize="xs">
            {slide.type === 'ranking'
              ? 'Give each item its position in the correct order — pick a number, use the arrows, or take the order shown as it stands. Leave every position blank to run it as an opinion poll.'
              : 'Tick the correct answer to have it marked. Leave everything unticked to run it as a poll.'}
          </FormHelperText>
        </FormControl>
      )}

      {slide.type === 'scale' && (
        <SimpleGrid columns={{ base: 2, md: 4 }} spacing={3} mb={3}>
          <FormControl>
            <FormLabel fontSize="sm">From</FormLabel>
            <NumberInput
              size="sm"
              value={slide.scaleMin}
              onChange={(value) => onChange({ scaleMin: Number(value) || 0 })}
            >
              <NumberInputField />
            </NumberInput>
          </FormControl>
          <FormControl>
            <FormLabel fontSize="sm">To</FormLabel>
            <NumberInput
              size="sm"
              value={slide.scaleMax}
              onChange={(value) => onChange({ scaleMax: Number(value) || 0 })}
            >
              <NumberInputField />
            </NumberInput>
          </FormControl>
          <FormControl>
            <FormLabel fontSize="sm">Low label</FormLabel>
            <Input
              size="sm"
              value={slide.scaleMinLabel}
              placeholder="Not at all"
              onChange={(event) => onChange({ scaleMinLabel: event.target.value })}
            />
          </FormControl>
          <FormControl>
            <FormLabel fontSize="sm">High label</FormLabel>
            <Input
              size="sm"
              value={slide.scaleMaxLabel}
              placeholder="Completely"
              onChange={(event) => onChange({ scaleMaxLabel: event.target.value })}
            />
          </FormControl>
        </SimpleGrid>
      )}

      {slide.type === 'numeric' && (
        <SimpleGrid columns={{ base: 1, md: 3 }} spacing={3} mb={3}>
          <FormControl>
            <FormLabel fontSize="sm">Correct number</FormLabel>
            <Input
              size="sm"
              value={slide.correctNumber}
              placeholder="Leave blank for an estimate poll"
              onChange={(event) => onChange({ correctNumber: event.target.value })}
            />
          </FormControl>
          <FormControl>
            <FormLabel fontSize="sm">Tolerance ±%</FormLabel>
            <NumberInput
              size="sm"
              value={slide.tolerancePercent}
              onChange={(value) => onChange({ tolerancePercent: Number(value) || 0 })}
            >
              <NumberInputField />
            </NumberInput>
          </FormControl>
          <FormControl>
            <FormLabel fontSize="sm">Tolerance ± absolute</FormLabel>
            <NumberInput
              size="sm"
              value={slide.toleranceAbs}
              onChange={(value) => onChange({ toleranceAbs: Number(value) || 0 })}
            >
              <NumberInputField />
            </NumberInput>
            <FormHelperText fontSize="xs">Whichever is larger wins.</FormHelperText>
          </FormControl>
        </SimpleGrid>
      )}

      {(slide.type === 'wordcloud' || slide.type === 'open') && (
        <SimpleGrid columns={2} spacing={3} mb={3}>
          {slide.type === 'wordcloud' && (
            <FormControl>
              <FormLabel fontSize="sm">Words counted per answer</FormLabel>
              <NumberInput
                size="sm"
                min={1}
                max={10}
                value={slide.maxWords}
                onChange={(value) => onChange({ maxWords: Number(value) || 1 })}
              >
                <NumberInputField />
              </NumberInput>
            </FormControl>
          )}
          <FormControl>
            <FormLabel fontSize="sm">Character limit</FormLabel>
            <NumberInput
              size="sm"
              min={1}
              max={2000}
              value={slide.maxLength}
              onChange={(value) => onChange({ maxLength: Number(value) || 1 })}
            >
              <NumberInputField />
            </NumberInput>
          </FormControl>
        </SimpleGrid>
      )}

      <SimpleGrid columns={{ base: 1, md: 2 }} spacing={3} mb={3}>
        <FormControl>
          <FormLabel fontSize="sm">Countdown (seconds)</FormLabel>
          <NumberInput
            size="sm"
            min={0}
            max={3600}
            value={slide.timeLimitSec}
            onChange={(value) => onChange({ timeLimitSec: Number(value) || 0 })}
          >
            <NumberInputField />
          </NumberInput>
          <FormHelperText fontSize="xs">0 means you close it by hand.</FormHelperText>
        </FormControl>
        {marked && (
          <FormControl>
            <FormLabel fontSize="sm">Marks</FormLabel>
            <NumberInput
              size="sm"
              min={0}
              value={slide.marks}
              onChange={(value) => onChange({ marks: Number(value) || 0 })}
            >
              <NumberInputField />
            </NumberInput>
          </FormControl>
        )}
      </SimpleGrid>

      {marked && (
        <FormControl>
          <FormLabel fontSize="sm">Explanation shown on reveal</FormLabel>
          <Textarea
            size="sm"
            rows={2}
            value={slide.explanation}
            placeholder="Why is that the answer?"
            onChange={(event) => onChange({ explanation: event.target.value })}
          />
        </FormControl>
      )}
    </SectionCard>
  );
}

export default function ShortEditor() {
  const { classId } = useOutletContext();
  const { shortId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [short, setShort] = useState(null);
  const [slides, setSlides] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [serverProblems, setServerProblems] = useState([]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const loaded = await lmApi.getShort(classId, shortId);
      setShort(loaded);
      setSlides(withKeys(loaded.slides));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId, shortId]);

  useEffect(() => {
    load();
  }, [load]);

  const problems = useMemo(() => validate(slides), [slides]);

  const patchSlide = (index, patch) =>
    setSlides((current) => current.map((slide, i) => (i === index ? { ...slide, ...patch } : slide)));

  const moveSlide = (index, delta) =>
    setSlides((current) => {
      const to = index + delta;
      if (to < 0 || to >= current.length) return current;
      const next = [...current];
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });

  const save = async ({ thenPresent = false } = {}) => {
    if (problems.length) {
      toast({ status: 'warning', title: problems[0] });
      return;
    }
    setSaving(true);
    setServerProblems([]);
    try {
      await lmApi.updateShort(classId, shortId, {
        title: short.title,
        description: short.description,
        settings: short.settings,
        slides: slides.map((slide, order) => ({
          ...slide,
          _key: undefined,
          order,
          // Blank means "no key", which the server stores as null. Sending '' as
          // a number would coerce to 0 and mark 0 as the correct answer.
          correctNumber: slide.correctNumber === '' ? null : Number(slide.correctNumber),
        })),
      });
      toast({ status: 'success', title: 'Saved' });

      if (thenPresent) {
        const { session } = await lmApi.presentShort(classId, shortId);
        navigate(`/learning/class/${classId}/short/${shortId}/present/${session.sessionId}`);
        return;
      }
      await load();
    } catch (err) {
      setServerProblems(err.payload?.errors || [err.message]);
      toast({ status: 'error', title: err.message });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loading label="Loading short…" />;
  if (error) return <ErrorState error={error} onRetry={load} />;

  const setSetting = (key, value) =>
    setShort((current) => ({ ...current, settings: { ...current.settings, [key]: value } }));

  return (
    <VStack align="stretch" spacing={5}>
      <Flex gap={3} wrap="wrap" align="center">
        <Heading size="md" flex="1">
          Edit short
        </Heading>
        <Button size="sm" variant="ghost" onClick={() => navigate(`/learning/class/${classId}/shorts`)}>
          Back
        </Button>
        <Button size="sm" onClick={() => save()} isLoading={saving}>
          Save
        </Button>
        <Button size="sm" colorScheme="purple" onClick={() => save({ thenPresent: true })} isLoading={saving}>
          Save &amp; present
        </Button>
      </Flex>

      {(problems.length > 0 || serverProblems.length > 0) && (
        <Alert status="warning" borderRadius="md" alignItems="flex-start">
          <AlertIcon />
          <VStack align="stretch" spacing={0} fontSize="sm">
            {[...new Set([...problems, ...serverProblems])].map((problem) => (
              <Text key={problem}>{problem}</Text>
            ))}
          </VStack>
        </Alert>
      )}

      <SectionCard title="Deck">
        <VStack align="stretch" spacing={3}>
          <FormControl>
            <FormLabel fontSize="sm">Title</FormLabel>
            <Input
              value={short.title}
              onChange={(event) => setShort({ ...short, title: event.target.value })}
            />
          </FormControl>
          <FormControl>
            <FormLabel fontSize="sm">Description</FormLabel>
            <Textarea
              rows={2}
              value={short.description || ''}
              placeholder="Shown to the class when they join."
              onChange={(event) => setShort({ ...short, description: event.target.value })}
            />
          </FormControl>

          <Divider />

          <SimpleGrid columns={{ base: 1, md: 2 }} spacingY={3} spacingX={6}>
            {[
              // The fourth field is the default for a deck saved before the
              // setting existed: those must read as on, not as off.
              [
                'requireLogin',
                'Require sign-in to join',
                'On, only signed-in members of this class can answer. Off, anyone with the code types a name and joins — guests are left out of the gradebook.',
                true,
              ],
              ['anonymous', 'Hide names in results', 'Answers are still tied to accounts server-side.'],
              ['showResultsToStudents', 'Mirror results to phones', 'Otherwise results stay on the projector.'],
              ['allowChangeAnswer', 'Allow changing an answer', 'While the slide is still open.'],
              ['allowLateJoin', 'Allow joining mid-deck', 'Off means only slide 1 accepts new joiners.'],
              ['autoRevealOnClose', 'Reveal the answer when I close a slide', ''],
              ['graded', 'Send scores to the gradebook', 'Creates classwork when the session ends.'],
            ].map(([key, label, hint, defaultOn]) => (
              <FormControl key={key} display="flex" alignItems="flex-start" gap={3}>
                <Switch
                  mt={1}
                  isChecked={
                    defaultOn ? short.settings?.[key] !== false : Boolean(short.settings?.[key])
                  }
                  onChange={(event) => setSetting(key, event.target.checked)}
                />
                <Box>
                  <FormLabel mb={0} fontSize="sm">
                    {label}
                  </FormLabel>
                  {hint ? (
                    <Text fontSize="xs" opacity={0.6}>
                      {hint}
                    </Text>
                  ) : null}
                </Box>
              </FormControl>
            ))}
          </SimpleGrid>
        </VStack>
      </SectionCard>

      {slides.map((slide, index) => (
        <SlideCard
          key={slide._key}
          slide={slide}
          index={index}
          total={slides.length}
          onChange={(patch) => patchSlide(index, patch)}
          onMove={(delta) => moveSlide(index, delta)}
          onRemove={() => setSlides((current) => current.filter((_, i) => i !== index))}
          onDuplicate={() =>
            setSlides((current) => [
              ...current.slice(0, index + 1),
              // Drop the _id so the copy is a new slide rather than an alias of
              // the original — sharing an _id would merge their responses.
              { ...current[index], _id: undefined, _key: Math.random().toString(36).slice(2) },
              ...current.slice(index + 1),
            ])
          }
        />
      ))}

      <HStack wrap="wrap">
        {SLIDE_TYPES.map((type) => (
          <Button
            key={type.value}
            size="sm"
            variant="outline"
            onClick={() => setSlides((current) => [...current, blankSlide(type.value)])}
          >
            + {type.label}
          </Button>
        ))}
      </HStack>
    </VStack>
  );
}
