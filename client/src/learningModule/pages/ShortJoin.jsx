import React, { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  AlertIcon,
  Box,
  Button,
  Heading,
  Input,
  Text,
  VStack,
  useColorModeValue,
} from '@chakra-ui/react';

import lmApi from '../api/lmApi';
import StageBar from '../components/StageBar';
import { loginPathFor } from '../../authRedirect';

/**
 * Code entry for joining a live Short.
 *
 * Not class-scoped on purpose: someone walking into a lecture has a six-digit
 * code off the projector and nothing else. The server resolves the code to a
 * session and decides there who may join.
 *
 * Whether a sign-in is needed is a property of the deck (`requireLogin`), which
 * this page cannot know until the code has been sent. So it always tries the
 * plain join first and lets the answer tell it what else to ask for:
 * `LOGIN_REQUIRED` sends them to the login page and back, `NAME_REQUIRED`
 * reveals the name field. That keeps one round trip in the common case instead
 * of looking the code up twice.
 *
 * When the code is already in the URL — the QR path, or the notification link —
 * this joins straight away and the form is never shown.
 */
export default function ShortJoin() {
  const { code: codeParam } = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  const [code, setCode] = useState(codeParam || '');
  const [name, setName] = useState('');
  const [needsName, setNeedsName] = useState(false);
  const [busy, setBusy] = useState(Boolean(codeParam));
  const [error, setError] = useState('');

  const join = useCallback(
    async (value, displayName) => {
      const trimmed = String(value || '').trim();
      if (!trimmed) {
        setError('Enter the code shown on screen.');
        return;
      }
      setBusy(true);
      setError('');
      try {
        const result = await lmApi.joinShort(trimmed, { name: displayName });
        if (result.guestToken) lmApi.shortGuest.save(result.sessionId, result.guestToken);
        navigate(`/learning/short/live/${result.sessionId}`, { replace: true });
      } catch (err) {
        const reason = err.payload?.code;
        if (reason === 'LOGIN_REQUIRED') {
          // Come back to this exact code once they have signed in.
          navigate(loginPathFor({ ...location, pathname: `/learning/short/join/${trimmed}` }), {
            replace: true,
          });
          return;
        }
        if (reason === 'NAME_REQUIRED') {
          setNeedsName(true);
          setError('');
        } else {
          setError(err.message);
        }
        setBusy(false);
      }
    },
    [location, navigate],
  );

  useEffect(() => {
    if (codeParam) join(codeParam);
  }, [codeParam, join]);

  const cardBg = useColorModeValue('white', 'gray.800');
  const pageBg = useColorModeValue('gray.50', 'gray.900');
  const submit = () => join(code, name.trim());

  return (
    <Box minH="100vh" bg={pageBg}>
      {/* The same bar the quiz and the short itself carry. This is the first
          screen a scanned QR reaches, often for someone with no account, and it
          had nothing on it saying whose platform they had just landed on. */}
      <StageBar label="Live Short" />
      <Box
        maxW="420px"
        mx="auto"
        mt={{ base: 6, md: 16 }}
        bg={cardBg}
        borderRadius="xl"
        borderWidth="1px"
        p={8}
      >
        <VStack align="stretch" spacing={5}>
          <Box textAlign="center">
            <Text fontSize="3xl">⚡</Text>
            <Heading size="lg">Join a short</Heading>
            <Text fontSize="sm" opacity={0.7} mt={1}>
              {needsName ? 'One more thing — what should the room call you?' : 'Type the code on the projector.'}
            </Text>
          </Box>

          {error ? (
            <Alert status="error" borderRadius="md" fontSize="sm">
              <AlertIcon />
              {error}
            </Alert>
          ) : null}

          <Input
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
            }}
            placeholder="000000"
            textAlign="center"
            fontSize="4xl"
            fontWeight="800"
            letterSpacing="0.3em"
            h="72px"
            // Brings up the numeric keypad on a phone without rejecting paste.
            inputMode="numeric"
            autoComplete="off"
            autoFocus={!needsName}
          />

          {needsName ? (
            <Input
              value={name}
              onChange={(event) => setName(event.target.value.slice(0, 60))}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit();
              }}
              placeholder="Your name"
              size="lg"
              textAlign="center"
              autoComplete="name"
              autoFocus
            />
          ) : null}

          <Button
            colorScheme="purple"
            size="lg"
            onClick={submit}
            isLoading={busy}
            isDisabled={needsName && !name.trim()}
          >
            Join
          </Button>

          <Button variant="ghost" size="sm" onClick={() => navigate('/learning')}>
            Back to my classes
          </Button>
        </VStack>
      </Box>
    </Box>
  );
}
