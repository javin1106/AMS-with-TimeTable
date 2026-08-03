import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Divider,
  Flex,
  Grid,
  HStack,
  IconButton,
  Select,
  Tag,
  Text,
  Textarea,
  Tooltip,
  useToast,
} from '@chakra-ui/react';
import { ViewIcon, ViewOffIcon } from '@chakra-ui/icons';
import lmApi from '../api/lmApi';
import { EmptyState, ErrorState, Loading, SectionCard, StatTile } from '../components/common';
import { formatDate, formatDateTime, relativeTime } from '../format';

/**
 * Anonymous feedback.
 *
 * One screen, three audiences, chosen by the server: a student writes and sees
 * their own notes back, staff read the class's with no names on them, and a
 * platform admin reads the same list with the names restored plus the attempts
 * the word filter refused.
 *
 * The `view` field in the response is what switches — not the local `isTeacher`
 * flag. The client learning it from context would mean two places deciding who
 * sees a name, and the wrong one winning is a broken promise rather than a
 * broken layout.
 */

const CATEGORY_META = {
  teaching: { label: 'Teaching style', icon: '🎓' },
  pace: { label: 'Pace of the course', icon: '⏱️' },
  content: { label: 'Course content', icon: '📚' },
  assessment: { label: 'Assessment & grading', icon: '📝' },
  communication: { label: 'Communication', icon: '💬' },
  other: { label: 'Something else', icon: '💡' },
};

const SENTIMENT_META = {
  praise: { label: 'Praise', colorScheme: 'green', icon: '👏' },
  suggestion: { label: 'Suggestion', colorScheme: 'blue', icon: '💡' },
  concern: { label: 'Concern', colorScheme: 'orange', icon: '⚠️' },
};

const STATUS_META = {
  new: { label: 'Unread', colorScheme: 'purple' },
  read: { label: 'Read', colorScheme: 'gray' },
  actioned: { label: 'Acted on', colorScheme: 'green' },
};

const MIN_LENGTH = 15;
const MAX_LENGTH = 2000;

const categoryLabel = (key) => CATEGORY_META[key]?.label || key;

export default function Feedback() {
  const { classId, klass } = useOutletContext();
  const toast = useToast();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await lmApi.listFeedback(classId));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  if (loading) return <Loading label="Opening the feedback box…" />;
  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!data) return null;

  return data.view === 'student' ? (
    <StudentView data={data} classId={classId} klass={klass} toast={toast} onChange={load} />
  ) : (
    <StaffView data={data} classId={classId} toast={toast} onChange={load} />
  );
}

/* ────────────────────────────── student ─────────────────────────────────── */

function StudentView({ data, classId, klass, toast, onChange }) {
  const [text, setText] = useState('');
  const [category, setCategory] = useState('teaching');
  const [sentiment, setSentiment] = useState('suggestion');
  const [sending, setSending] = useState(false);
  // Held separately from the toast: a refusal for language comes with a warning
  // count attached, and that has to stay on screen next to the box being
  // rewritten rather than slide away after five seconds.
  const [refusal, setRefusal] = useState(null);

  const warnings = data.warnings || { strikes: 0, limit: 3, remaining: 3, blocked: false };
  const tooShort = text.trim().length > 0 && text.trim().length < MIN_LENGTH;
  const canSend =
    !warnings.blocked && !sending && text.trim().length >= MIN_LENGTH && data.remainingToday > 0;

  const send = async () => {
    setSending(true);
    setRefusal(null);
    try {
      await lmApi.sendFeedback(classId, { text: text.trim(), category, sentiment });
      setText('');
      toast({
        title: 'Sent anonymously',
        description: `Your teacher will see this without your name on it.`,
        status: 'success',
        duration: 5000,
      });
      onChange();
    } catch (err) {
      const payload = err.payload || {};
      if (payload.code === 'PROFANITY' || payload.code === 'FEEDBACK_BLOCKED') {
        setRefusal({ message: err.message, terms: payload.terms || [], warnings: payload.warnings });
        onChange();
      } else {
        toast({ title: err.message || 'Could not send', status: 'error', duration: 6000 });
      }
    } finally {
      setSending(false);
    }
  };

  const live = refusal?.warnings || warnings;

  return (
    <Grid templateColumns={{ base: '1fr', lg: '1.1fr 0.9fr' }} gap={5} alignItems="start">
      <Box>
        <SectionCard
          title="Send anonymous feedback"
          subtitle={`Your name is never shown to the teaching staff of ${klass?.name || 'this class'}.`}
        >
          <PromiseNote />

          {live.strikes > 0 && !live.blocked && (
            <Alert status="warning" borderRadius="md" mb={4} alignItems="flex-start" fontSize="sm">
              <AlertIcon />
              <Box>
                <Text fontWeight="600">
                  {live.strikes} of {live.limit} warnings used
                </Text>
                <Text mt={1}>
                  Abusive language has been recorded against your account{' '}
                  {live.strikes === 1 ? 'once' : `${live.strikes} times`}, with your name on it.{' '}
                  {live.remaining === 1
                    ? 'One more and your account will be blocked from sending feedback and referred to the administrator.'
                    : `${live.remaining} more and your account will be blocked from sending feedback and referred to the administrator.`}
                </Text>
              </Box>
            </Alert>
          )}

          {live.blocked && (
            <Alert status="error" borderRadius="md" mb={4} alignItems="flex-start" fontSize="sm">
              <AlertIcon />
              <Box>
                <Text fontWeight="600">Your account is blocked from sending feedback</Text>
                <Text mt={1}>
                  It was blocked after {live.limit} warnings about non-parliamentary language, and
                  the attempts have been referred to your administrator. Speak to your department
                  administrator if you believe this was a mistake.
                </Text>
              </Box>
            </Alert>
          )}

          {refusal && !live.blocked && (
            <Alert status="error" borderRadius="md" mb={4} alignItems="flex-start" fontSize="sm">
              <AlertIcon />
              <Box>
                <Text fontWeight="600">Not sent — please rewrite it</Text>
                <Text mt={1} whiteSpace="pre-line">
                  {refusal.message}
                </Text>
                {refusal.terms?.length > 0 && (
                  <HStack mt={2} spacing={2} wrap="wrap">
                    {refusal.terms.map((term) => (
                      <Tag key={term} size="sm" colorScheme="red" variant="subtle">
                        {term}
                      </Tag>
                    ))}
                  </HStack>
                )}
              </Box>
            </Alert>
          )}

          <Grid templateColumns={{ base: '1fr', sm: '1fr 1fr' }} gap={3} mb={3}>
            <Box>
              <Text fontSize="xs" color="gray.600" mb={1} fontWeight="600">
                What is this about?
              </Text>
              <Select
                size="sm"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                isDisabled={live.blocked}
              >
                {Object.entries(CATEGORY_META).map(([key, meta]) => (
                  <option key={key} value={key}>
                    {meta.icon} {meta.label}
                  </option>
                ))}
              </Select>
            </Box>
            <Box>
              <Text fontSize="xs" color="gray.600" mb={1} fontWeight="600">
                How would you describe it?
              </Text>
              <Select
                size="sm"
                value={sentiment}
                onChange={(event) => setSentiment(event.target.value)}
                isDisabled={live.blocked}
              >
                {Object.entries(SENTIMENT_META).map(([key, meta]) => (
                  <option key={key} value={key}>
                    {meta.icon} {meta.label}
                  </option>
                ))}
              </Select>
            </Box>
          </Grid>

          <Textarea
            value={text}
            onChange={(event) => setText(event.target.value.slice(0, MAX_LENGTH))}
            placeholder="Be specific and be constructive — what would you change, and why? Feedback that names a problem and suggests a fix is the kind that actually gets acted on."
            rows={7}
            isDisabled={live.blocked}
            resize="vertical"
          />

          <Flex justify="space-between" align="center" mt={2} gap={3} wrap="wrap">
            <Text fontSize="xs" color={tooShort ? 'orange.600' : 'gray.500'}>
              {tooShort
                ? `At least ${MIN_LENGTH} characters, so your teacher can act on it.`
                : `${text.length} / ${MAX_LENGTH} characters`}
            </Text>
            <HStack spacing={3}>
              <Text fontSize="xs" color="gray.500">
                {data.remainingToday} left today
              </Text>
              <Button size="sm" colorScheme="blue" onClick={send} isLoading={sending} isDisabled={!canSend}>
                Send anonymously
              </Button>
            </HStack>
          </Flex>
        </SectionCard>
      </Box>

      <SectionCard
        title="What you have sent"
        subtitle="Only you and your administrator can see that these came from you. Once sent, feedback cannot be taken back."
      >
        {data.items.length === 0 ? (
          <EmptyState
            icon="✉️"
            title="Nothing sent yet"
            description="Anything you send appears here so you can follow what happened to it."
          />
        ) : (
          <Flex direction="column" gap={3}>
            {data.items.map((item) => (
              <Box
                key={item._id}
                borderWidth="1px"
                borderColor="gray.200"
                borderRadius="md"
                p={3}
                opacity={item.withdrawn ? 0.55 : 1}
              >
                <Flex justify="space-between" align="center" gap={2} mb={2} wrap="wrap">
                  <HStack spacing={2}>
                    <Badge colorScheme={SENTIMENT_META[item.sentiment]?.colorScheme || 'gray'}>
                      {SENTIMENT_META[item.sentiment]?.label || item.sentiment}
                    </Badge>
                    <Text fontSize="xs" color="gray.500">
                      {categoryLabel(item.category)}
                    </Text>
                  </HStack>
                  <Tooltip label={formatDateTime(item.created_at)}>
                    <Text fontSize="xs" color="gray.500">
                      {relativeTime(item.created_at)}
                    </Text>
                  </Tooltip>
                </Flex>

                <Text fontSize="sm" whiteSpace="pre-wrap" color="gray.800">
                  {item.text}
                </Text>

                {item.response && (
                  <Box mt={3} bg="blue.50" borderRadius="md" p={3}>
                    <Text fontSize="xs" fontWeight="700" color="blue.800">
                      Reply from {item.respondedByName || 'the teaching staff'}
                    </Text>
                    <Text fontSize="sm" color="blue.900" whiteSpace="pre-wrap" mt={1}>
                      {item.response}
                    </Text>
                  </Box>
                )}

                <Flex justify="space-between" align="center" mt={3} gap={2}>
                  <Badge colorScheme={STATUS_META[item.status]?.colorScheme || 'gray'} variant="subtle">
                    {item.withdrawn ? 'Withdrawn' : STATUS_META[item.status]?.label || item.status}
                  </Badge>
                </Flex>
              </Box>
            ))}
          </Flex>
        )}
      </SectionCard>
    </Grid>
  );
}

/**
 * The promise, stated in full and stated first.
 *
 * Half a promise is worse than none here: a student told only "this is
 * anonymous" writes something they would not have written knowing an
 * administrator can read it, which is neither fair to them nor useful to
 * anybody. So both halves appear, before the box, at the same size.
 */
function PromiseNote() {
  return (
    <Box bg="gray.50" borderRadius="md" p={3} mb={4} borderLeftWidth="3px" borderLeftColor="blue.400">
      <Text fontSize="sm" color="gray.700">
        <b>Your teacher will not see who wrote this.</b> No name, no roll number, no email — and the
        time is shown to them only as a date.
      </Text>
      <Text fontSize="sm" color="gray.700" mt={2}>
        <b>Your institute administrator can.</b> The sender is recorded, so the channel can stay open
        without becoming a place to abuse staff anonymously. Say what you honestly think — including
        things that are hard to say — but say it the way you would sign your name to.
      </Text>
    </Box>
  );
}

/* ───────────────────────────── staff / admin ────────────────────────────── */

function StaffView({ data, classId, toast, onChange }) {
  const isAdminView = data.view === 'admin';
  const [category, setCategory] = useState('all');
  const [status, setStatus] = useState('all');
  const [showStrikes, setShowStrikes] = useState(false);

  const items = useMemo(
    () =>
      data.items.filter(
        (item) =>
          (category === 'all' || item.category === category) &&
          (status === 'all' || item.status === status),
      ),
    [data.items, category, status],
  );

  const update = async (id, body) => {
    try {
      await lmApi.updateFeedback(classId, id, body);
      onChange();
    } catch (err) {
      toast({ title: err.message || 'Could not update', status: 'error' });
    }
  };

  const { counts } = data;

  return (
    <Box>
      <Grid templateColumns={{ base: '1fr 1fr', md: 'repeat(4, 1fr)' }} gap={4} mb={4}>
        <StatTile label="Total received" value={counts.total} />
        <StatTile label="Unread" value={counts.unread} accent="purple.500" />
        <StatTile label="Concerns" value={counts.bySentiment?.concern || 0} accent="orange.500" />
        <StatTile label="Praise" value={counts.bySentiment?.praise || 0} accent="green.500" />
      </Grid>

      <Alert status="info" borderRadius="md" mb={4} fontSize="sm" alignItems="flex-start">
        <AlertIcon />
        <Box>
          <Text>
            These notes reach you without a sender. Names, roll numbers and exact times are withheld
            deliberately — a timestamp is enough to identify someone in a small class.
          </Text>
          {isAdminView && (
            <Text mt={2} fontWeight="600" color="red.700">
              You are viewing this as a platform administrator, so the senders are shown below. A
              member of teaching staff sees none of it.
            </Text>
          )}
        </Box>
      </Alert>

      <Flex gap={3} mb={4} wrap="wrap" align="center">
        <Select size="sm" maxW="220px" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="all">All topics</option>
          {Object.entries(CATEGORY_META).map(([key, meta]) => (
            <option key={key} value={key}>
              {meta.label} ({counts.byCategory?.[key] || 0})
            </option>
          ))}
        </Select>
        <Select size="sm" maxW="180px" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">Any status</option>
          <option value="new">Unread</option>
          <option value="read">Read</option>
          <option value="actioned">Acted on</option>
        </Select>
        {isAdminView && data.strikes?.length > 0 && (
          <Button size="sm" variant="outline" colorScheme="red" onClick={() => setShowStrikes((v) => !v)}>
            {showStrikes ? 'Hide' : 'Show'} blocked attempts ({data.strikes.length})
          </Button>
        )}
      </Flex>

      {isAdminView && showStrikes && <StrikeAudit strikes={data.strikes} />}

      {items.length === 0 ? (
        <EmptyState
          icon="🕊️"
          title={data.items.length ? 'Nothing matches that filter' : 'No feedback yet'}
          description={
            data.items.length
              ? 'Try a different topic or status.'
              : 'Students can send anonymous feedback from this tab. Mentioning it once in class is usually what starts it off.'
          }
        />
      ) : (
        <Flex direction="column" gap={4}>
          {items.map((item) => (
            <FeedbackCard
              key={item._id}
              item={item}
              isAdminView={isAdminView}
              onUpdate={(body) => update(item._id, body)}
            />
          ))}
        </Flex>
      )}
    </Box>
  );
}

function FeedbackCard({ item, isAdminView, onUpdate }) {
  const [reply, setReply] = useState(item.response || '');
  const [replying, setReplying] = useState(false);
  const sentiment = SENTIMENT_META[item.sentiment] || SENTIMENT_META.suggestion;

  return (
    <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="lg" p={5}>
      <Flex justify="space-between" align="flex-start" gap={3} wrap="wrap" mb={3}>
        <HStack spacing={2} wrap="wrap">
          <Badge colorScheme={sentiment.colorScheme}>
            {sentiment.icon} {sentiment.label}
          </Badge>
          <Tag size="sm" variant="subtle">
            {CATEGORY_META[item.category]?.icon} {categoryLabel(item.category)}
          </Tag>
          <Badge colorScheme={STATUS_META[item.status]?.colorScheme || 'gray'} variant="outline">
            {STATUS_META[item.status]?.label || item.status}
          </Badge>
        </HStack>
        <Text fontSize="xs" color="gray.500">
          {isAdminView ? formatDateTime(item.created_at) : formatDate(item.created_at)}
        </Text>
      </Flex>

      <Text color="gray.800" whiteSpace="pre-wrap">
        {item.text}
      </Text>

      {isAdminView && item.student && (
        <Box mt={4} bg="red.50" borderRadius="md" p={3} borderWidth="1px" borderColor="red.100">
          <Text fontSize="xs" fontWeight="700" color="red.800" textTransform="uppercase" letterSpacing="wide">
            Administrator view — sender
          </Text>
          <Text fontSize="sm" color="red.900" mt={1}>
            {item.student.name || 'Unknown'}
            {item.student.rollNumber ? ` · ${item.student.rollNumber}` : ''}
            {item.student.email ? ` · ${item.student.email}` : ''}
          </Text>
        </Box>
      )}

      {item.withdrawn && (
        <Text fontSize="xs" color="gray.500" mt={2}>
          Withdrawn by the sender.
        </Text>
      )}

      <Divider my={4} />

      {item.response ? (
        <Box bg="blue.50" borderRadius="md" p={3}>
          <Text fontSize="xs" fontWeight="700" color="blue.800">
            Your reply — sent to the student, still anonymously
          </Text>
          <Text fontSize="sm" color="blue.900" whiteSpace="pre-wrap" mt={1}>
            {item.response}
          </Text>
        </Box>
      ) : (
        replying && (
          <Box mb={3}>
            <Textarea
              size="sm"
              rows={3}
              value={reply}
              onChange={(event) => setReply(event.target.value)}
              placeholder="Reply to the student. They are notified without you ever learning who they are."
            />
            <HStack mt={2} spacing={2}>
              <Button
                size="xs"
                colorScheme="blue"
                isDisabled={!reply.trim()}
                onClick={() => onUpdate({ response: reply.trim() })}
              >
                Send reply
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setReplying(false)}>
                Cancel
              </Button>
            </HStack>
          </Box>
        )
      )}

      <HStack spacing={2} wrap="wrap">
        {item.status === 'new' && (
          <Button size="xs" variant="outline" onClick={() => onUpdate({ status: 'read' })}>
            Mark as read
          </Button>
        )}
        {item.status !== 'actioned' && (
          <Button size="xs" variant="outline" colorScheme="green" onClick={() => onUpdate({ status: 'actioned' })}>
            Mark as acted on
          </Button>
        )}
        {!item.response && !replying && (
          <Button size="xs" variant="ghost" colorScheme="blue" onClick={() => setReplying(true)}>
            Reply
          </Button>
        )}
      </HStack>
    </Box>
  );
}

/**
 * An address that has to be readable but should not be on screen by default.
 *
 * Masked until asked for, because most of what an administrator does on this
 * page — reading the message, judging whether the filter was right — needs no
 * address at all, and a column of student emails is a column that gets read over
 * a shoulder, screenshotted into a WhatsApp group, or left open on a projector.
 * Revealing is one click and leaves the rest of the list masked.
 *
 * Not a security control: the address is in the payload either way. It is there
 * so that seeing it is a thing somebody chose to do.
 */
function RevealableEmail({ email }) {
  const [shown, setShown] = useState(false);
  if (!email) return null;

  // Enough of the address to tell two rows apart at a glance without naming
  // either — the local part's first character, and the domain.
  const [local = '', domain = ''] = String(email).split('@');
  const masked = `${local.slice(0, 1)}${'•'.repeat(Math.max(3, local.length - 1))}@${domain}`;

  return (
    <HStack spacing={1} display="inline-flex">
      <Text fontSize="sm" color="gray.700" fontFamily={shown ? 'inherit' : 'mono'}>
        {shown ? email : masked}
      </Text>
      <Tooltip label={shown ? 'Hide email address' : 'Show email address'}>
        <IconButton
          size="xs"
          variant="ghost"
          colorScheme="gray"
          aria-label={shown ? `Hide email address` : `Show email address`}
          aria-pressed={shown}
          icon={shown ? <ViewOffIcon /> : <ViewIcon />}
          onClick={() => setShown((value) => !value)}
        />
      </Tooltip>
    </HStack>
  );
}

/**
 * The refused attempts. Admin only, and shown with the words intact — an
 * administrator deciding whether to sanction an account has to read what was
 * actually written rather than take the filter's word for it.
 */
function StrikeAudit({ strikes }) {
  return (
    <SectionCard
      title="Blocked attempts"
      subtitle="Messages the language filter refused. These never reached any teacher."
      mb={4}
      borderColor="red.200"
    >
      <Flex direction="column" gap={3}>
        {strikes.map((strike) => (
          <Box key={strike._id} borderWidth="1px" borderColor="red.100" borderRadius="md" p={3} bg="red.50">
            <Flex justify="space-between" gap={3} wrap="wrap" mb={2}>
              <HStack spacing={2} wrap="wrap">
                <Text fontSize="sm" fontWeight="600" color="red.900">
                  {strike.studentName || 'Unknown'}
                </Text>
                <RevealableEmail email={strike.studentEmail} />
              </HStack>
              <HStack spacing={2}>
                <Badge colorScheme="red">Warning {strike.strikeNumber}</Badge>
                <Text fontSize="xs" color="gray.600">
                  {formatDateTime(strike.created_at)}
                </Text>
              </HStack>
            </Flex>
            <Text fontSize="sm" color="gray.800" whiteSpace="pre-wrap">
              {strike.text}
            </Text>
            <HStack mt={2} spacing={2} wrap="wrap">
              {(strike.terms || []).map((term) => (
                <Tag key={term} size="sm" colorScheme="red" variant="solid">
                  {term}
                </Tag>
              ))}
            </HStack>
          </Box>
        ))}
      </Flex>
    </SectionCard>
  );
}
