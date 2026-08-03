import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Heading,
  IconButton,
  Progress,
  Text,
  Tooltip,
  VStack,
  useColorModeValue,
  useToast,
} from '@chakra-ui/react';
import { FiChevronLeft, FiChevronRight, FiMaximize, FiMinimize } from 'react-icons/fi';
import QRCode from 'qrcode';

import lmApi from '../api/lmApi';
import { ErrorState, Loading } from '../components/common';
import RichText from '../components/RichText';
import ShortResults from '../components/ShortResults';
import useShortStream from '../hooks/useShortStream';

/**
 * The projector. This is the screen at the front of the room, so it is built for
 * being read from the back row: oversized type, one thing at a time, and the
 * join code always visible because someone always arrives late.
 *
 * The teacher's controls sit in a bar at the bottom rather than beside the
 * results — on a projected 16:9 the sides are the first thing to get cropped.
 */

const STATE_LABEL = {
  waiting: 'Not open yet',
  open: 'Answering',
  locked: 'Closed',
  revealed: 'Answer shown',
};

/** Renders the join code as a QR so phones do not have to type anything. */
function JoinQr({ url, size = 132 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!canvasRef.current || !url) return;
    // Errors here are cosmetic — the numeric code below is the real path in.
    QRCode.toCanvas(canvasRef.current, url, { width: size, margin: 1 }, () => {});
  }, [url, size]);

  return <canvas ref={canvasRef} style={{ borderRadius: 8, background: '#fff' }} />;
}

/**
 * Counts down against the server's deadline rather than a local duration, so a
 * reconnect or a tab that was backgrounded lands on the right number instead of
 * restarting the clock.
 */
function Countdown({ deadline, big }) {
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
    <Text
      fontSize={big ? '5xl' : '2xl'}
      fontWeight="800"
      color={seconds <= 5 ? 'red.400' : undefined}
      lineHeight="1"
      fontVariantNumeric="tabular-nums"
    >
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </Text>
  );
}

export default function ShortPresent() {
  const { classId } = useOutletContext();
  const { shortId, sessionId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [busy, setBusy] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const stageRef = useRef(null);

  const streamUrl = useMemo(
    () => lmApi.shortPresenterStreamUrl(classId, sessionId),
    [classId, sessionId],
  );
  // The hook's fallback when the event-stream cannot be established: the room
  // keeps seeing answers land, just at polling granularity.
  const pollState = useCallback(async () => {
    const { session } = await lmApi.shortPresenterState(classId, sessionId);
    return session;
  }, [classId, sessionId]);

  const { state, connection, error, merge } = useShortStream(streamUrl, { fetchState: pollState });

  const joinUrl = state
    ? `${window.location.origin}/learning/short/join/${state.joinCode}`
    : '';

  const control = async (action, extra) => {
    setBusy(true);
    try {
      const { session } = await lmApi.controlShortSession(classId, sessionId, action, extra);
      merge(session);
    } catch (err) {
      toast({ status: 'error', title: err.message });
    } finally {
      setBusy(false);
    }
  };

  const end = async () => {
    // eslint-disable-next-line no-alert
    if (!window.confirm('End this session? The join code stops working.')) return;
    try {
      await lmApi.endShortSession(classId, sessionId);
      navigate(`/learning/class/${classId}/short/${shortId}/report/${sessionId}`);
    } catch (err) {
      toast({ status: 'error', title: err.message });
    }
  };

  const toggleFullscreen = () => {
    const node = stageRef.current;
    if (!node) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else node.requestFullscreen?.();
  };

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Keyboard driving, because the teacher is usually holding a presenter remote
  // that sends arrow keys and nothing else.
  useEffect(() => {
    const onKey = (event) => {
      if (event.target.matches?.('input, textarea, [contenteditable="true"]')) return;
      if (event.key === 'ArrowRight') control('next');
      else if (event.key === 'ArrowLeft') control('previous');
      else if (event.key === ' ') {
        event.preventDefault();
        if (state?.slideState === 'waiting') control('open');
        else if (state?.slideState === 'open') control('lock');
        else if (state?.slideState === 'locked') control('reveal');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // control is recreated each render; the effect only needs the current state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.slideState]);

  const stageBg = useColorModeValue('white', 'gray.900');
  const panelBg = useColorModeValue('purple.50', 'whiteAlpha.100');

  if (connection === 'denied' || (error && !state)) {
    return <ErrorState error={{ message: error || 'Cannot open this session.' }} onRetry={() => navigate(0)} />;
  }
  if (!state) return <Loading label="Opening the presenter view…" />;

  const answered = state.results?.totalResponses || 0;
  const joined = state.participantCount || 0;
  const ended = state.status === 'ended';

  return (
    <Box ref={stageRef} bg={stageBg} borderRadius="lg" p={{ base: 3, md: 6 }}>
      <VStack align="stretch" spacing={5}>
        <Flex gap={4} wrap="wrap" align="flex-start">
          <Box flex="1" minW="240px">
            <HStack spacing={2} mb={1} wrap="wrap">
              <Heading size="md">{state.title}</Heading>
              <Badge colorScheme={ended ? 'gray' : 'red'} variant="solid">
                {ended ? 'ended' : 'live'}
              </Badge>
              <Badge colorScheme={connection === 'live' ? 'green' : 'yellow'}>
                {connection === 'live' ? 'streaming' : connection}
              </Badge>
            </HStack>
            <Text fontSize="sm" opacity={0.7}>
              Slide {state.slideIndex + 1} of {state.slideCount} · {STATE_LABEL[state.slideState]}
            </Text>
          </Box>

          <HStack spacing={4} align="center" bg={panelBg} borderRadius="lg" p={3}>
            <JoinQr url={joinUrl} />
            <Box>
              <Text fontSize="xs" textTransform="uppercase" letterSpacing="wide" opacity={0.7}>
                Join at {window.location.host}/learning/short/join
              </Text>
              <Text fontSize={{ base: '4xl', md: '5xl' }} fontWeight="900" letterSpacing="0.15em" lineHeight="1.1">
                {state.joinCode}
              </Text>
              <Text fontSize="sm" opacity={0.75}>
                {joined} {joined === 1 ? 'person' : 'people'} joined · {answered} answered this slide
              </Text>
              {/* The teacher set this when authoring, possibly weeks ago. It
                  changes who can walk in, so it belongs next to the code they
                  are about to put on a projector. */}
              {state.settings?.requireLogin === false ? (
                <Badge colorScheme="orange" mt={1}>
                  Open — anyone with the code can join
                </Badge>
              ) : null}
            </Box>
          </HStack>

          <Tooltip label={fullscreen ? 'Leave full screen' : 'Full screen'}>
            <IconButton
              aria-label="Toggle full screen"
              icon={fullscreen ? <FiMinimize /> : <FiMaximize />}
              onClick={toggleFullscreen}
              variant="outline"
            />
          </Tooltip>
        </Flex>

        {connection !== 'live' && !ended && (
          <Alert status="warning" borderRadius="md" py={2}>
            <AlertIcon />
            <Text fontSize="sm">
              Live updates are {connection === 'connecting' ? 'reconnecting' : connection}. Your controls still
              work — the tally refreshes each time you use one.
            </Text>
          </Alert>
        )}

        {state.slide ? (
          <>
            <Flex gap={4} align="flex-start" wrap="wrap">
              <Box flex="1" minW="260px" fontSize={{ base: 'xl', md: '3xl' }} fontWeight="700">
                <RichText>{state.slide.question}</RichText>
              </Box>
              <Countdown deadline={state.slideState === 'open' ? state.slideDeadline : null} big />
            </Flex>

            {joined > 0 && (
              <Progress
                value={(answered / joined) * 100}
                colorScheme="purple"
                size="sm"
                borderRadius="full"
                hasStripe={state.slideState === 'open'}
                isAnimated={state.slideState === 'open'}
              />
            )}

            {state.slideState === 'waiting' ? (
              <Box textAlign="center" py={10} opacity={0.6}>
                <Text fontSize="2xl">Ready when you are.</Text>
                <Text fontSize="sm">Open the slide to start accepting answers.</Text>
              </Box>
            ) : (
              <ShortResults results={state.results} size="lg" />
            )}
          </>
        ) : (
          <Text opacity={0.6}>This short has no slides.</Text>
        )}

        {!ended && (
          <Flex
            gap={2}
            wrap="wrap"
            align="center"
            position="sticky"
            bottom={0}
            bg={stageBg}
            pt={3}
            borderTopWidth="1px"
          >
            <IconButton
              aria-label="Previous slide"
              icon={<FiChevronLeft />}
              onClick={() => control('previous')}
              isDisabled={busy || state.slideIndex === 0}
            />
            <IconButton
              aria-label="Next slide"
              icon={<FiChevronRight />}
              onClick={() => control('next')}
              isDisabled={busy || state.slideIndex >= state.slideCount - 1}
            />

            {state.slideState === 'waiting' && (
              <Button colorScheme="green" onClick={() => control('open')} isLoading={busy}>
                Open for answers
              </Button>
            )}
            {state.slideState === 'open' && (
              <Button colorScheme="orange" onClick={() => control('lock')} isLoading={busy}>
                Close answering
              </Button>
            )}
            {state.slideState === 'locked' && (
              <>
                {state.slide?.gradable && (
                  <Button colorScheme="blue" onClick={() => control('reveal')} isLoading={busy}>
                    Reveal the answer
                  </Button>
                )}
                <Button variant="outline" onClick={() => control('reopen')} isLoading={busy}>
                  Reopen
                </Button>
              </>
            )}
            {state.slideState === 'revealed' && (
              <Button variant="outline" onClick={() => control('reopen')} isLoading={busy}>
                Reopen
              </Button>
            )}

            <Box flex="1" />
            <Text fontSize="xs" opacity={0.5} display={{ base: 'none', md: 'block' }}>
              ← → to move · space to open / close / reveal
            </Text>
            <Button size="sm" variant="ghost" colorScheme="red" onClick={end}>
              End session
            </Button>
          </Flex>
        )}

        {ended && (
          <Button
            colorScheme="purple"
            onClick={() => navigate(`/learning/class/${classId}/short/${shortId}/report/${sessionId}`)}
          >
            See the report
          </Button>
        )}
      </VStack>
    </Box>
  );
}
