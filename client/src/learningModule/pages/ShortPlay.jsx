import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Checkbox,
  Flex,
  HStack,
  Heading,
  IconButton,
  Input,
  SimpleGrid,
  Spinner,
  Text,
  Textarea,
  VStack,
  useColorModeValue,
  useToast,
} from '@chakra-ui/react';
import { FiArrowDown, FiArrowUp } from 'react-icons/fi';

import lmApi from '../api/lmApi';
import { ErrorState, Loading } from '../components/common';
import RichText from '../components/RichText';
import ShortResults from '../components/ShortResults';
import StageBar from '../components/StageBar';
import useShortStream from '../hooks/useShortStream';

/**
 * The same bar the quiz stage carries.
 *
 * This screen sits outside LearningLayout — a deck can admit someone with no
 * account, so it cannot depend on the signed-in chrome — which left a scanned
 * QR landing on a page with no indication of what it was. It wraps the loading
 * and error states too: those are the moments where "did that QR work?" is the
 * actual question.
 */
function PlayShell({ title, presenter, children }) {
  return (
    <Box minH="100vh" bg={useColorModeValue('gray.50', 'gray.900')}>
      <StageBar label="Live Short" faculty={presenter} title={title} />
      <Box maxW="560px" mx="auto" px={{ base: 3, md: 6 }} py={5} pb={10}>
        {children}
      </Box>
    </Box>
  );
}

/**
 * The student's phone.
 *
 * Built thumb-first: full-width tap targets, no horizontal scrolling and nothing
 * that needs a second hand. The slide the teacher is on arrives over the stream,
 * so a student who unlocks their phone thirty seconds late lands on the right
 * question with no action.
 *
 * The draft answer is deliberately *not* reset on every stream frame — that
 * would wipe half-typed text 40 times a minute. It resets when the slide changes.
 */

const STATE_MESSAGE = {
  locked: 'Answering is closed.',
  revealed: 'Answers are in.',
};

/**
 * The hold screen, from joining until the presenter opens a slide.
 *
 * Deliberately the deck's title card rather than the question: a student who
 * has just typed a six-digit code needs to know they landed in the right room,
 * and the question is the teacher's to reveal when the room is ready for it.
 */
function TitleCard({ state, cardBg }) {
  const first = state.slideIndex === 0;
  return (
    <Box bg={cardBg} borderWidth="1px" borderRadius="xl" p={8} textAlign="center">
      <Text fontSize="4xl" lineHeight="1">
        ⚡
      </Text>
      <Heading size="lg" mt={3}>
        {state.title}
      </Heading>
      {state.description ? (
        <Box fontSize="sm" opacity={0.75} mt={2}>
          <RichText>{state.description}</RichText>
        </Box>
      ) : null}

      <HStack justify="center" spacing={2} mt={4} wrap="wrap">
        {state.slideCount > 0 && (
          <Badge>
            {state.slideCount} {state.slideCount === 1 ? 'question' : 'questions'}
          </Badge>
        )}
        {state.presentedByName ? <Badge>{state.presentedByName}</Badge> : null}
        {state.participantCount > 0 ? <Badge colorScheme="purple">{state.participantCount} joined</Badge> : null}
      </HStack>

      <HStack justify="center" spacing={3} mt={8}>
        <Spinner size="sm" speed="0.9s" color="purple.400" />
        <Text fontWeight="600">
          {first ? 'Waiting for your faculty to launch the short…' : 'Waiting for the next question…'}
        </Text>
      </HStack>
      <Text fontSize="xs" opacity={0.6} mt={2}>
        {first
          ? 'You are in. Keep this screen open — the first question appears here.'
          : `Question ${state.slideIndex + 1} of ${state.slideCount} is coming up.`}
      </Text>
    </Box>
  );
}

function ChoiceButtons({ slide, value, onChange, multi, disabled }) {
  const selected = (value || []).map(String);
  const pick = (index) => {
    const key = String(index);
    if (!multi) {
      onChange([key]);
      return;
    }
    onChange(selected.includes(key) ? selected.filter((entry) => entry !== key) : [...selected, key]);
  };

  return (
    <VStack align="stretch" spacing={3}>
      {(slide.options || []).map((option, index) => {
        const isOn = selected.includes(String(index));
        return (
          <Button
            key={index}
            onClick={() => pick(index)}
            isDisabled={disabled}
            size="lg"
            h="auto"
            py={4}
            whiteSpace="normal"
            textAlign="left"
            justifyContent="flex-start"
            variant={isOn ? 'solid' : 'outline'}
            colorScheme={isOn ? 'purple' : 'gray'}
            leftIcon={multi ? <Checkbox isChecked={isOn} pointerEvents="none" /> : undefined}
          >
            {option || `Option ${index + 1}`}
          </Button>
        );
      })}
    </VStack>
  );
}

function ScalePicker({ slide, value, onChange, disabled }) {
  const min = Number(slide.scaleMin ?? 1);
  const max = Number(slide.scaleMax ?? 5);
  const steps = [];
  for (let i = min; i <= max; i += 1) steps.push(i);

  return (
    <VStack align="stretch" spacing={3}>
      <SimpleGrid columns={Math.min(steps.length, 6)} spacing={2}>
        {steps.map((step) => (
          <Button
            key={step}
            onClick={() => onChange(step)}
            isDisabled={disabled}
            size="lg"
            variant={Number(value) === step ? 'solid' : 'outline'}
            colorScheme={Number(value) === step ? 'purple' : 'gray'}
          >
            {step}
          </Button>
        ))}
      </SimpleGrid>
      <Flex justify="space-between" fontSize="xs" opacity={0.7}>
        <Text>{slide.scaleMinLabel || min}</Text>
        <Text>{slide.scaleMaxLabel || max}</Text>
      </Flex>
    </VStack>
  );
}

/**
 * Ranking on a phone. Arrow buttons rather than drag-and-drop: HTML5 drag does
 * not work on touch without a polyfill, and a mis-drop in the middle of a
 * thirty-second window is worse than two taps.
 */
function RankingPicker({ slide, value, onChange, disabled }) {
  const order = value?.length ? value.map(String) : (slide.options || []).map((_, index) => String(index));

  const move = (position, delta) => {
    const to = position + delta;
    if (to < 0 || to >= order.length) return;
    const next = [...order];
    [next[position], next[to]] = [next[to], next[position]];
    onChange(next);
  };

  return (
    <VStack align="stretch" spacing={2}>
      {order.map((optionIndex, position) => (
        <Flex key={optionIndex} align="center" gap={2} borderWidth="1px" borderRadius="md" p={3}>
          <Badge minW="28px" textAlign="center">
            {position + 1}
          </Badge>
          <Text flex="1" fontSize="sm">
            {(slide.options || [])[Number(optionIndex)]}
          </Text>
          <IconButton
            aria-label="Move up"
            icon={<FiArrowUp />}
            size="sm"
            variant="ghost"
            isDisabled={disabled || position === 0}
            onClick={() => move(position, -1)}
          />
          <IconButton
            aria-label="Move down"
            icon={<FiArrowDown />}
            size="sm"
            variant="ghost"
            isDisabled={disabled || position === order.length - 1}
            onClick={() => move(position, 1)}
          />
        </Flex>
      ))}
    </VStack>
  );
}

function Countdown({ deadline }) {
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (!deadline) {
      setRemaining(0);
      return undefined;
    }
    const tick = () => setRemaining(Math.max(0, new Date(deadline).getTime() - Date.now()));
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [deadline]);

  if (!deadline) return null;
  const seconds = Math.ceil(remaining / 1000);
  return (
    <Badge colorScheme={seconds <= 5 ? 'red' : 'purple'} fontSize="md" px={3} py={1} fontVariantNumeric="tabular-nums">
      {seconds}s
    </Badge>
  );
}

export default function ShortPlay() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [draft, setDraft] = useState({ selected: [], text: '', number: null });
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [expired, setExpired] = useState(false);
  const lastSlideId = useRef(null);

  const streamUrl = useMemo(() => lmApi.shortParticipantStreamUrl(sessionId), [sessionId]);
  const pollState = useCallback(() => lmApi.shortLiveState(sessionId), [sessionId]);
  const { state, connection, error } = useShortStream(streamUrl, { fetchState: pollState });

  const slide = state?.slide || null;

  // Reset the draft when the room moves to a different slide — but only then,
  // so an incoming tally does not clear what the student is halfway through
  // typing.
  useEffect(() => {
    if (!slide) return;
    if (lastSlideId.current === String(slide._id)) return;
    lastSlideId.current = String(slide._id);
    setSent(false);
    setDraft({ selected: [], text: '', number: null });
  }, [slide]);

  // Trip `expired` exactly when the countdown runs out. A timer rather than a
  // comparison on each render, because nothing else would re-render the page at
  // the moment the clock passes.
  useEffect(() => {
    setExpired(false);
    if (!state?.slideDeadline) return undefined;
    const remaining = new Date(state.slideDeadline).getTime() - Date.now();
    if (remaining <= 0) {
      setExpired(true);
      return undefined;
    }
    const timer = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [state?.slideDeadline]);

  // An answer the server already has takes precedence over an empty draft — this
  // is what makes reloading the page mid-slide non-destructive.
  useEffect(() => {
    if (!state?.myAnswer) return;
    setSent(true);
    setDraft((current) => {
      const empty = !current.selected.length && !current.text && current.number === null;
      if (!empty) return current;
      return {
        selected: (state.myAnswer.selected || []).map(String),
        text: state.myAnswer.text || '',
        number: state.myAnswer.number ?? null,
      };
    });
  }, [state?.myAnswer]);

  const submit = async () => {
    if (!slide) return;
    setSending(true);
    try {
      await lmApi.answerShort(sessionId, {
        slideId: slide._id,
        selected: draft.selected,
        text: draft.text,
        number: draft.number,
      });
      setSent(true);
      toast({ status: 'success', title: 'Answer sent', duration: 1200 });
    } catch (err) {
      // STALE_SLIDE is not the student's fault — the teacher moved on between
      // the tap and the request landing, and the stream will bring the new slide
      // along in a moment.
      const code = err.payload?.code;
      toast({
        status: code === 'STALE_SLIDE' ? 'info' : 'error',
        title: err.message,
        duration: 2500,
      });
    } finally {
      setSending(false);
    }
  };

  const cardBg = useColorModeValue('white', 'gray.800');

  if (connection === 'denied') {
    return (
      <PlayShell>
        <ErrorState error={{ message: error }} onRetry={() => navigate('/learning/short/join')} />
      </PlayShell>
    );
  }
  if (!state) {
    return (
      <PlayShell>
        <Loading label="Joining…" />
      </PlayShell>
    );
  }

  const ended = state.status === 'ended' || connection === 'ended';
  // `expired` is the local half of the same rule the server applies: the stream
  // can be up to a tick behind, and Send must stop working the moment the clock
  // hits zero rather than a second later. The server still has the final say —
  // this only avoids offering a tap that would come back rejected.
  const open = state.canAnswer && !ended && !expired;
  const locked = !open || (sent && state.canChange === false);
  // Nothing to answer yet: either the presenter has not opened the current slide
  // (`pending`, and the server has withheld its text) or there is no slide at all.
  const holding = !ended && (!slide || slide.pending || state.slideState === 'waiting');

  const hasDraft =
    draft.selected.length > 0 || String(draft.text || '').trim().length > 0 || draft.number !== null;

  return (
    <PlayShell title={state.title} presenter={state.presentedByName}>
      <VStack align="stretch" spacing={4}>
        {/* The title moved up into the bar, so what is left here is the pair
            that changes as the room moves: which slide, and how long is left.
            The hold screen carries its own title card. */}
        {!holding && (
          <Flex align="center" gap={2} wrap="wrap">
            <Box flex="1" />
            <Badge>
              {state.slideIndex + 1} / {state.slideCount}
            </Badge>
            <Countdown deadline={open ? state.slideDeadline : null} />
          </Flex>
        )}

        {connection !== 'live' && !ended && (
          <Alert status="warning" borderRadius="md" py={2} fontSize="sm">
            <AlertIcon />
            {connection === 'polling' ? 'Updating a little slower than usual.' : 'Reconnecting…'}
          </Alert>
        )}

        {ended && (
          <Alert status="info" borderRadius="md">
            <AlertIcon />
            <Box>
              <Text fontWeight="600">This short has ended.</Text>
              <Text fontSize="sm">Thanks for taking part.</Text>
            </Box>
          </Alert>
        )}

        {holding ? (
          <TitleCard state={state} cardBg={cardBg} />
        ) : slide && !slide.pending ? (
          <Box bg={cardBg} borderWidth="1px" borderRadius="xl" p={5}>
            <Box fontSize="lg" fontWeight="700" mb={4}>
              <RichText>{slide.question}</RichText>
            </Box>

            {!open && !ended ? (
              <Alert status="info" borderRadius="md" mb={4} fontSize="sm">
                <AlertIcon />
                {/* The stale frame still says "open" for a moment after the
                    clock passes, and "wait for the question to open" would be
                    exactly backwards at that point. */}
                {expired && state.slideState === 'open'
                  ? 'Time is up.'
                  : STATE_MESSAGE[state.slideState] || 'Hold on.'}
              </Alert>
            ) : null}

            {(slide.type === 'mcq' || slide.type === 'truefalse' || slide.type === 'msq') && (
              <ChoiceButtons
                slide={slide}
                value={draft.selected}
                multi={slide.type === 'msq'}
                disabled={locked}
                onChange={(selected) => setDraft({ ...draft, selected })}
              />
            )}

            {slide.type === 'ranking' && (
              <RankingPicker
                slide={slide}
                value={draft.selected}
                disabled={locked}
                onChange={(selected) => setDraft({ ...draft, selected })}
              />
            )}

            {slide.type === 'scale' && (
              <ScalePicker
                slide={slide}
                value={draft.number}
                disabled={locked}
                onChange={(number) => setDraft({ ...draft, number })}
              />
            )}

            {slide.type === 'wordcloud' && (
              <>
                <Input
                  size="lg"
                  value={draft.text}
                  isDisabled={locked}
                  maxLength={slide.maxLength || 200}
                  placeholder={
                    slide.maxWords > 1 ? `Up to ${slide.maxWords} words` : 'One word'
                  }
                  onChange={(event) => setDraft({ ...draft, text: event.target.value })}
                />
                <Text fontSize="xs" opacity={0.6} mt={1}>
                  The first {slide.maxWords} {slide.maxWords === 1 ? 'word' : 'words'} count towards the cloud.
                </Text>
              </>
            )}

            {slide.type === 'open' && (
              <Textarea
                rows={4}
                value={draft.text}
                isDisabled={locked}
                maxLength={slide.maxLength || 200}
                placeholder="Type your answer"
                onChange={(event) => setDraft({ ...draft, text: event.target.value })}
              />
            )}

            {slide.type === 'numeric' && (
              <Input
                size="lg"
                type="number"
                inputMode="decimal"
                value={draft.number ?? ''}
                isDisabled={locked}
                placeholder="Your number"
                onChange={(event) =>
                  setDraft({ ...draft, number: event.target.value === '' ? null : Number(event.target.value) })
                }
              />
            )}

            {open && (
              <Button
                mt={5}
                w="100%"
                size="lg"
                colorScheme="purple"
                onClick={submit}
                isLoading={sending}
                isDisabled={!hasDraft || locked}
              >
                {sent ? 'Change my answer' : 'Send'}
              </Button>
            )}

            {sent && state.myAnswer?.correct !== null && state.myAnswer?.correct !== undefined && (
              <Alert
                status={state.myAnswer.correct ? 'success' : 'error'}
                borderRadius="md"
                mt={4}
                fontSize="sm"
              >
                <AlertIcon />
                {state.myAnswer.correct
                  ? `Correct · ${state.myAnswer.awarded} ${state.myAnswer.awarded === 1 ? 'mark' : 'marks'}`
                  : 'Not this time.'}
              </Alert>
            )}

            {sent && !open && !state.results && (
              <HStack mt={4} fontSize="sm" opacity={0.7}>
                <Text>Your answer is in.</Text>
              </HStack>
            )}
          </Box>
        ) : null}

        {state.results && !holding && (
          <Box bg={cardBg} borderWidth="1px" borderRadius="xl" p={5}>
            <Text fontSize="sm" fontWeight="700" mb={3} opacity={0.7}>
              What the room said
            </Text>
            <ShortResults results={state.results} />
          </Box>
        )}

        <Button variant="ghost" size="sm" onClick={() => navigate('/learning')}>
          Leave
        </Button>
      </VStack>
    </PlayShell>
  );
}
