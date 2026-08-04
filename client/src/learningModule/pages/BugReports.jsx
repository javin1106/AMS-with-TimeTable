import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Input,
  Select,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Text,
  Textarea,
  VStack,
  useToast,
} from '@chakra-ui/react';

import lmApi from '../api/lmApi';
import { EmptyState, ErrorState, Loading, SectionCard } from '../components/common';
import { formatDateTime, relativeTime } from '../format';

/**
 * "Something is broken" — or "this would be better if".
 *
 * Open to students and staff alike, because the people who find bugs are the
 * people using the thing. Points are paid when a platform admin confirms the
 * report is real — never on submission, which would make this a button worth
 * pressing for its own sake and fill the queue faster than anyone could read it.
 */

const STATUS_STYLE = {
  open: { colorScheme: 'blue', label: 'waiting to be read' },
  acknowledged: { colorScheme: 'green', label: 'approved — points added' },
  duplicate: { colorScheme: 'purple', label: 'already known' },
  rejected: { colorScheme: 'gray', label: 'not taken up' },
  fixed: { colorScheme: 'teal', label: 'done' },
};

const KIND_STYLE = {
  bug: { colorScheme: 'red', label: 'Bug' },
  suggestion: { colorScheme: 'orange', label: 'Suggestion' },
};

// The two halves of the form that read differently depending on which one you
// are filing. Asking "is this broken, or could it be better?" once is cheaper
// than an admin reading the whole thing to work it out.
const KIND_COPY = {
  bug: {
    title: 'What went wrong, in one line?',
    description: 'What were you doing, what did you expect, and what happened instead?',
  },
  suggestion: {
    title: 'What would you like to see, in one line?',
    description: 'What are you trying to do, and how would this make it easier?',
  },
};

function ReportForm({ classes, pointsPerReport, onSent }) {
  const [kind, setKind] = useState('bug');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [classId, setClassId] = useState('');
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const submit = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      await lmApi.reportBug({
        kind,
        title: title.trim(),
        description: description.trim(),
        classId: classId || null,
        // The single most useful line in any bug report, and the one people
        // always forget to include.
        pageUrl: window.location.href,
      });
      toast({ status: 'success', title: 'Sent — thank you', duration: 4000 });
      setTitle('');
      setDescription('');
      setClassId('');
      onSent();
    } catch (err) {
      toast({ status: 'error', title: err.message, duration: 6000 });
    } finally {
      setSaving(false);
    }
  };

  return (
    <VStack align="stretch" spacing={3}>
      <Select value={kind} onChange={(event) => setKind(event.target.value)} maxW="420px">
        <option value="bug">🐛 Something is broken (bug)</option>
        <option value="suggestion">💡 Something could be better (suggestion)</option>
      </Select>
      <Input
        placeholder={KIND_COPY[kind].title}
        value={title}
        maxLength={160}
        onChange={(event) => setTitle(event.target.value)}
      />
      <Textarea
        placeholder={KIND_COPY[kind].description}
        rows={5}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />
      <Select
        placeholder="Was it in a particular class? (optional)"
        value={classId}
        onChange={(event) => setClassId(event.target.value)}
        maxW="420px"
      >
        {classes.map((klass) => (
          <option key={klass._id} value={klass._id}>
            {klass.name}
          </option>
        ))}
      </Select>
      <Flex align="center" gap={3} wrap="wrap">
        <Button colorScheme="purple" onClick={submit} isLoading={saving} isDisabled={!title.trim()}>
          Send
        </Button>
        <Text fontSize="xs" color="gray.500">
          {pointsPerReport} points once an administrator approves it — and a badge if it was in one
          of your classes.
        </Text>
      </Flex>
    </VStack>
  );
}

/** The admin queue. Only rendered when the API let this account read it. */
function AdminQueue({ reports, counts, onReviewed }) {
  const [note, setNote] = useState({});
  const toast = useToast();

  const decide = async (report, status) => {
    try {
      await lmApi.reviewBug(report._id, { status, adminNote: note[report._id] || '' });
      toast({ status: 'success', title: `Marked ${status}` });
      onReviewed();
    } catch (err) {
      toast({ status: 'error', title: err.message });
    }
  };

  return (
    <VStack align="stretch" spacing={3}>
      <HStack spacing={2} wrap="wrap">
        {Object.entries(counts).map(([status, count]) => (
          <Badge key={status} colorScheme={STATUS_STYLE[status]?.colorScheme || 'gray'} borderRadius="full" px={2}>
            {count} {status}
          </Badge>
        ))}
      </HStack>

      {reports.length === 0 ? (
        <EmptyState icon="🎉" title="Nothing in the queue" />
      ) : (
        reports.map((report) => (
          <Box key={report._id} borderWidth="1px" borderRadius="md" p={4}>
            <Flex justify="space-between" gap={3} wrap="wrap" mb={1}>
              <HStack spacing={2}>
                <Badge colorScheme={KIND_STYLE[report.kind]?.colorScheme || 'red'}>
                  {KIND_STYLE[report.kind]?.label || 'Bug'}
                </Badge>
                <Text fontWeight="600">{report.title}</Text>
              </HStack>
              <Badge colorScheme={STATUS_STYLE[report.status]?.colorScheme || 'gray'}>{report.status}</Badge>
            </Flex>
            <Text fontSize="xs" color="gray.500" mb={2}>
              {report.reporterName} ({report.reporterRole || 'user'}) · {relativeTime(report.created_at)}
              {report.className ? ` · in ${report.className}` : ' · platform-wide'}
            </Text>
            {report.description && (
              <Text fontSize="sm" whiteSpace="pre-wrap" mb={2}>
                {report.description}
              </Text>
            )}
            {report.pageUrl && (
              <Text fontSize="xs" color="gray.500" mb={2} wordBreak="break-all">
                {report.pageUrl}
              </Text>
            )}

            {report.awardedAt && (
              <Badge colorScheme="green" mb={2}>
                points already paid
              </Badge>
            )}

            <Input
              size="sm"
              placeholder="Note back to the reporter (optional)"
              value={note[report._id] ?? report.adminNote ?? ''}
              onChange={(event) => setNote((current) => ({ ...current, [report._id]: event.target.value }))}
              mb={2}
            />
            <HStack spacing={2} wrap="wrap">
              {/* Only "approve" pays, and only the first time — the server will
                  not pay twice however often this is pressed. */}
              <Button size="xs" colorScheme="green" onClick={() => decide(report, 'acknowledged')}>
                Approve
              </Button>
              <Button size="xs" variant="outline" onClick={() => decide(report, 'fixed')}>
                {report.kind === 'suggestion' ? 'Done' : 'Fixed'}
              </Button>
              <Button size="xs" variant="outline" onClick={() => decide(report, 'duplicate')}>
                Already known
              </Button>
              <Button size="xs" variant="ghost" colorScheme="red" onClick={() => decide(report, 'rejected')}>
                Reject
              </Button>
            </HStack>
          </Box>
        ))
      )}
    </VStack>
  );
}

export default function BugReports() {
  const [mine, setMine] = useState(null);
  const [queue, setQueue] = useState(null);
  const [classes, setClasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [own, myClasses, admin] = await Promise.all([
        lmApi.myBugReports(),
        lmApi.listClasses().catch(() => []),
        // 403 for everyone who is not a platform admin, which is how this page
        // decides whether to show the queue at all.
        lmApi.allBugReports().catch(() => null),
      ]);
      setMine(own);
      setClasses(myClasses);
      setQueue(admin);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <Loading label="Loading…" />;
  if (error) return <ErrorState error={error} onRetry={load} />;

  const form = (
    <SectionCard
      title="Bug / Suggestion"
      subtitle="Found something broken, or thought of something better? Tell us and we will look."
    >
      <ReportForm classes={classes} pointsPerReport={mine.pointsPerReport} onSent={load} />
    </SectionCard>
  );

  const history = (
    <SectionCard title="Your submissions">
      {mine.reports.length === 0 ? (
        <EmptyState icon="🐛" title="Nothing sent yet" />
      ) : (
        <VStack align="stretch" spacing={2}>
          {mine.reports.map((report) => (
            <Box key={report._id} borderWidth="1px" borderRadius="md" p={3}>
              <Flex justify="space-between" gap={2} wrap="wrap">
                <HStack spacing={2}>
                  <Badge colorScheme={KIND_STYLE[report.kind]?.colorScheme || 'red'}>
                    {KIND_STYLE[report.kind]?.label || 'Bug'}
                  </Badge>
                  <Text fontSize="sm" fontWeight="500">
                    {report.title}
                  </Text>
                </HStack>
                <HStack spacing={2}>
                  {report.awarded && <Badge colorScheme="purple">+{mine.pointsPerReport}</Badge>}
                  <Badge colorScheme={STATUS_STYLE[report.status]?.colorScheme || 'gray'}>
                    {STATUS_STYLE[report.status]?.label || report.status}
                  </Badge>
                </HStack>
              </Flex>
              <Text fontSize="xs" color="gray.500">
                {formatDateTime(report.created_at)}
                {report.className ? ` · ${report.className}` : ''}
              </Text>
              {report.adminNote && (
                <Alert status="info" borderRadius="md" fontSize="xs" mt={2}>
                  <AlertIcon />
                  {report.adminNote}
                </Alert>
              )}
            </Box>
          ))}
        </VStack>
      )}
    </SectionCard>
  );

  // Admins get the queue alongside their own reports; everyone else just files.
  if (!queue) {
    return (
      <VStack align="stretch" spacing={4}>
        {form}
        {history}
      </VStack>
    );
  }

  return (
    <Tabs colorScheme="purple" isLazy>
      <TabList>
        <Tab>Bug / Suggestion</Tab>
        <Tab>
          Queue
          {queue.counts?.open ? (
            <Badge ml={2} colorScheme="blue" borderRadius="full">
              {queue.counts.open}
            </Badge>
          ) : null}
        </Tab>
      </TabList>
      <TabPanels>
        <TabPanel px={0}>
          <VStack align="stretch" spacing={4}>
            {form}
            {history}
          </VStack>
        </TabPanel>
        <TabPanel px={0}>
          <SectionCard
            title="Bugs & suggestions"
            subtitle="Approving pays the person who sent it, once."
          >
            <AdminQueue reports={queue.reports} counts={queue.counts || {}} onReviewed={load} />
          </SectionCard>
        </TabPanel>
      </TabPanels>
    </Tabs>
  );
}
