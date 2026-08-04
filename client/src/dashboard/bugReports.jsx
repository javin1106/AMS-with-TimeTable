import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Container,
  Flex,
  HStack,
  Heading,
  Input,
  Link,
  Select,
  Spinner,
  Stat,
  StatLabel,
  StatNumber,
  Text,
  VStack,
  useColorModeValue,
  useToast,
} from '@chakra-ui/react';
import { Link as RouterLink } from 'react-router-dom';

import lmApi from '../learningModule/api/lmApi';

/**
 * Bugs and suggestions, for the people who can act on them.
 *
 * The same queue already exists inside the learning module, but it sits behind
 * that module's sidebar — which is the wrong place for an administrator whose
 * job today is the platform, not a class. This is the same data and the same
 * endpoints, reachable from the Super Admin dashboard in one click.
 *
 * There is no role check here: the list endpoint 403s for anyone who is not a
 * platform admin, and this page renders that refusal. Guarding in the browser
 * as well would only mean two places to keep in step.
 */

const STATUS_STYLE = {
  open: { colorScheme: 'blue', label: 'Waiting' },
  acknowledged: { colorScheme: 'green', label: 'Approved' },
  duplicate: { colorScheme: 'purple', label: 'Already known' },
  rejected: { colorScheme: 'gray', label: 'Rejected' },
  fixed: { colorScheme: 'teal', label: 'Done' },
};

const KIND_STYLE = {
  bug: { colorScheme: 'red', label: '🐛 Bug' },
  suggestion: { colorScheme: 'orange', label: '💡 Suggestion' },
};

const formatWhen = (value) => (value ? new Date(value).toLocaleString() : '');

function ReportCard({ report, onDecide }) {
  const [note, setNote] = useState(report.adminNote || '');
  const [busy, setBusy] = useState(false);
  const cardBg = useColorModeValue('white', 'gray.800');
  const border = useColorModeValue('gray.200', 'gray.700');
  const quoteBg = useColorModeValue('gray.50', 'gray.900');
  const subColor = useColorModeValue('gray.600', 'gray.400');

  const decide = async (status) => {
    setBusy(true);
    try {
      await onDecide(report, status, note);
    } finally {
      setBusy(false);
    }
  };

  const kind = KIND_STYLE[report.kind] || KIND_STYLE.bug;
  const status = STATUS_STYLE[report.status] || { colorScheme: 'gray', label: report.status };

  return (
    <Box bg={cardBg} borderWidth="1px" borderColor={border} borderRadius="lg" p={5}>
      <Flex justify="space-between" align="flex-start" gap={3} wrap="wrap" mb={2}>
        <HStack spacing={2} align="center">
          <Badge colorScheme={kind.colorScheme}>{kind.label}</Badge>
          <Heading as="h3" size="sm">
            {report.title}
          </Heading>
        </HStack>
        <HStack spacing={2}>
          {report.awardedAt && <Badge colorScheme="purple">points paid</Badge>}
          <Badge colorScheme={status.colorScheme}>{status.label}</Badge>
        </HStack>
      </Flex>

      <Text fontSize="xs" color={subColor} mb={3}>
        {report.reporterName || 'Unknown'}
        {report.reporterEmail ? ` · ${report.reporterEmail}` : ''}
        {report.reporterRole ? ` · ${report.reporterRole}` : ''} · {formatWhen(report.created_at)}
        {report.className ? ` · ${report.className}` : ' · platform-wide'}
      </Text>

      {report.description && (
        <Box
          bg={quoteBg}
          borderWidth="1px"
          borderColor={border}
          borderRadius="md"
          p={3}
          mb={3}
          fontSize="sm"
          whiteSpace="pre-wrap"
        >
          {report.description}
        </Box>
      )}

      {report.pageUrl && (
        <Text fontSize="xs" color={subColor} mb={3} wordBreak="break-all">
          Reported from{' '}
          <Link href={report.pageUrl} isExternal color="blue.500">
            {report.pageUrl}
          </Link>
        </Text>
      )}

      {report.reviewedByName && (
        <Text fontSize="xs" color={subColor} mb={3}>
          Last reviewed by {report.reviewedByName} on {formatWhen(report.reviewedAt)}
        </Text>
      )}

      <Input
        size="sm"
        mb={3}
        placeholder="Note back to the reporter (optional)"
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />

      <HStack spacing={2} wrap="wrap">
        {/* Only "Approve" pays, and only the first time: the server records the
            award on the report and the ledger refuses a second row for it, so
            approve → done → approve cannot pay twice. */}
        <Button size="sm" colorScheme="green" isLoading={busy} onClick={() => decide('acknowledged')}>
          Approve
        </Button>
        <Button size="sm" variant="outline" isLoading={busy} onClick={() => decide('fixed')}>
          {report.kind === 'suggestion' ? 'Mark done' : 'Mark fixed'}
        </Button>
        <Button size="sm" variant="outline" isLoading={busy} onClick={() => decide('duplicate')}>
          Already known
        </Button>
        <Button
          size="sm"
          variant="ghost"
          colorScheme="red"
          isLoading={busy}
          onClick={() => decide('rejected')}
        >
          Reject
        </Button>
      </HStack>
    </Box>
  );
}

const BugReportsAdmin = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState('open');
  const [kind, setKind] = useState('');
  const toast = useToast();

  const pageBg = useColorModeValue('gray.50', 'gray.900');
  const subColor = useColorModeValue('gray.600', 'gray.400');
  const statBg = useColorModeValue('white', 'gray.800');
  const border = useColorModeValue('gray.200', 'gray.700');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await lmApi.allBugReports({ status: status || undefined, kind: kind || undefined }));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [status, kind]);

  useEffect(() => {
    load();
  }, [load]);

  const decide = async (report, nextStatus, adminNote) => {
    try {
      await lmApi.reviewBug(report._id, { status: nextStatus, adminNote });
      toast({
        status: 'success',
        title: nextStatus === 'acknowledged' ? 'Approved' : `Marked ${nextStatus}`,
        duration: 3000,
      });
      await load();
    } catch (err) {
      toast({ status: 'error', title: err.message, duration: 6000 });
    }
  };

  const counts = data?.counts || {};
  const kindCounts = data?.kindCounts || {};
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);

  const tiles = [
    { label: 'Waiting on you', value: counts.open || 0, color: 'blue.500' },
    { label: 'Approved', value: counts.acknowledged || 0, color: 'green.500' },
    { label: 'Bugs', value: kindCounts.bug || 0, color: 'red.500' },
    { label: 'Suggestions', value: kindCounts.suggestion || 0, color: 'orange.500' },
    { label: 'All time', value: total, color: 'gray.500' },
  ];

  return (
    <Box bg={pageBg} minH="100vh" py={{ base: 8, md: 12 }}>
      <Container maxW="5xl">
        <Flex justify="space-between" align="flex-start" gap={4} wrap="wrap" mb={6}>
          <Box>
            <Heading as="h1" size="lg" mb={1}>
              Bugs &amp; Suggestions
            </Heading>
            <Text color={subColor}>
              Everything users have reported from the platform. Approving awards the person who sent
              it, once.
            </Text>
          </Box>
          <Button as={RouterLink} to="/superadmin" variant="outline" size="sm">
            Back to Super Admin
          </Button>
        </Flex>

        {error ? (
          <Alert status={error.status === 403 ? 'warning' : 'error'} borderRadius="md">
            <AlertIcon />
            {error.status === 403
              ? 'This queue is for platform administrators only.'
              : error.message || 'Could not load the queue.'}
          </Alert>
        ) : (
          <>
            <Flex gap={3} wrap="wrap" mb={5}>
              {tiles.map((tile) => (
                <Stat
                  key={tile.label}
                  bg={statBg}
                  borderWidth="1px"
                  borderColor={border}
                  borderRadius="lg"
                  px={4}
                  py={3}
                  minW="140px"
                  flex="0 1 auto"
                >
                  <StatLabel fontSize="xs" color={subColor}>
                    {tile.label}
                  </StatLabel>
                  <StatNumber fontSize="2xl" color={tile.color}>
                    {tile.value}
                  </StatNumber>
                </Stat>
              ))}
            </Flex>

            <HStack spacing={3} mb={5} wrap="wrap">
              <Select
                maxW="220px"
                bg={statBg}
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                <option value="">Any status</option>
                <option value="open">Waiting</option>
                <option value="acknowledged">Approved</option>
                <option value="fixed">Done</option>
                <option value="duplicate">Already known</option>
                <option value="rejected">Rejected</option>
              </Select>
              <Select
                maxW="220px"
                bg={statBg}
                value={kind}
                onChange={(event) => setKind(event.target.value)}
              >
                <option value="">Bugs and suggestions</option>
                <option value="bug">Bugs only</option>
                <option value="suggestion">Suggestions only</option>
              </Select>
              <Button size="md" variant="outline" onClick={load} isLoading={loading}>
                Refresh
              </Button>
            </HStack>

            {loading ? (
              <Flex justify="center" py={16}>
                <Spinner size="lg" />
              </Flex>
            ) : data?.reports?.length ? (
              <VStack align="stretch" spacing={4}>
                {data.reports.map((report) => (
                  // Keyed on the review stamp as well as the id so the note box
                  // inside re-initialises from the server after a decision,
                  // rather than holding the text typed against the old verdict.
                  <ReportCard
                    key={`${report._id}-${report.reviewedAt || ''}`}
                    report={report}
                    onDecide={decide}
                  />
                ))}
              </VStack>
            ) : (
              <Box
                bg={statBg}
                borderWidth="1px"
                borderColor={border}
                borderRadius="lg"
                p={10}
                textAlign="center"
              >
                <Text fontSize="3xl" mb={2}>
                  🎉
                </Text>
                <Text color={subColor}>Nothing here.</Text>
              </Box>
            )}
          </>
        )}
      </Container>
    </Box>
  );
};

export default BugReportsAdmin;
