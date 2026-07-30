import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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

/**
 * Code entry for joining a live Short.
 *
 * Not class-scoped on purpose: someone walking into a lecture has a six-digit
 * code off the projector and nothing else. The server resolves the code to a
 * session and checks class membership there.
 *
 * When the code is already in the URL — the QR path, or the notification link —
 * this joins straight away and the form is never shown.
 */
export default function ShortJoin() {
  const { code: codeParam } = useParams();
  const navigate = useNavigate();

  const [code, setCode] = useState(codeParam || '');
  const [busy, setBusy] = useState(Boolean(codeParam));
  const [error, setError] = useState('');

  const join = useCallback(
    async (value) => {
      const trimmed = String(value || '').trim();
      if (!trimmed) {
        setError('Enter the code shown on screen.');
        return;
      }
      setBusy(true);
      setError('');
      try {
        const result = await lmApi.joinShort(trimmed);
        navigate(`/learning/short/live/${result.sessionId}`, { replace: true });
      } catch (err) {
        setError(err.message);
        setBusy(false);
      }
    },
    [navigate],
  );

  useEffect(() => {
    if (codeParam) join(codeParam);
  }, [codeParam, join]);

  const cardBg = useColorModeValue('white', 'gray.800');

  return (
    <Box maxW="420px" mx="auto" mt={{ base: 6, md: 16 }} bg={cardBg} borderRadius="xl" borderWidth="1px" p={8}>
      <VStack align="stretch" spacing={5}>
        <Box textAlign="center">
          <Text fontSize="3xl">⚡</Text>
          <Heading size="lg">Join a short</Heading>
          <Text fontSize="sm" opacity={0.7} mt={1}>
            Type the code on the projector.
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
            if (event.key === 'Enter') join(code);
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
          autoFocus
        />

        <Button colorScheme="purple" size="lg" onClick={() => join(code)} isLoading={busy}>
          Join
        </Button>

        <Button variant="ghost" size="sm" onClick={() => navigate('/learning')}>
          Back to my classes
        </Button>
      </VStack>
    </Box>
  );
}
