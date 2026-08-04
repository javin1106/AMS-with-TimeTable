import React, { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useOutletContext } from 'react-router-dom';
import {
  Avatar,
  Badge,
  Box,
  Button,
  Checkbox,
  Collapse,
  Divider,
  Flex,
  HStack,
  Heading,
  IconButton,
  Input,
  Menu,
  MenuButton,
  MenuItem,
  MenuList,
  Text,
  Tooltip,
  useToast,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import { AttachmentList, AttachmentPicker } from '../components/Attachments';
import CommentThread from '../components/CommentThread';
import RichText from '../components/RichText';
import RichTextEditor from '../components/RichTextEditor';
import { isRichTextEmpty } from '../richTextUtils';
import { DueBadge, EmptyState, ErrorState, Loading, StateBadge, buttonTextStyles } from '../components/common';
import { courseworkLink, courseworkMeta, relativeTime } from '../format';

function Composer({ classId, onPosted }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [scheduledFor, setScheduledFor] = useState('');
  const [pinned, setPinned] = useState(false);
  const [posting, setPosting] = useState(false);
  const toast = useToast();

  const reset = () => {
    setText('');
    setAttachments([]);
    setScheduledFor('');
    setPinned(false);
    setOpen(false);
  };

  const submit = async () => {
    if (isRichTextEmpty(text) && !attachments.length) return;
    setPosting(true);
    try {
      await lmApi.createAnnouncement(classId, {
        text,
        attachments,
        pinned,
        scheduledFor: scheduledFor || undefined,
      });
      reset();
      onPosted();
    } catch (error) {
      toast({ status: 'error', title: 'Could not post', description: error.message });
    } finally {
      setPosting(false);
    }
  };

  return (
    <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="lg" p={4} mb={5}>
      {!open ? (
        <Flex
          as="button"
          w="100%"
          align="center"
          gap={3}
          onClick={() => setOpen(true)}
          color="gray.500"
          textAlign="left"
        >
          <Avatar size="sm" />
          <Text fontSize="sm">Announce something to your class…</Text>
        </Flex>
      ) : (
        <Box>
          <Box mb={3}>
            <RichTextEditor
              value={text}
              onChange={setText}
              placeholder="Share an update, a reminder, or a resource…"
            />
          </Box>
          <AttachmentPicker attachments={attachments} onChange={setAttachments} disabled={posting} />
          <Flex mt={4} gap={3} align="center" wrap="wrap">
            <Checkbox size="sm" isChecked={pinned} onChange={(e) => setPinned(e.target.checked)}>
              Pin to top
            </Checkbox>
            <HStack spacing={2}>
              <Text fontSize="sm" color="gray.600">
                Schedule
              </Text>
              <Input
                size="sm"
                type="datetime-local"
                value={scheduledFor}
                onChange={(event) => setScheduledFor(event.target.value)}
                maxW="220px"
              />
            </HStack>
            <Box flex="1" />
            <Button size="sm" variant="ghost" onClick={reset}>
              Cancel
            </Button>
            <Button
              size="sm"
              colorScheme="blue"
              onClick={submit}
              isLoading={posting}
              isDisabled={isRichTextEmpty(text) && !attachments.length}
            >
              {scheduledFor ? 'Schedule' : 'Post'}
            </Button>
          </Flex>
        </Box>
      )}
    </Box>
  );
}

/** Who reacted, the reader first, then everyone else in the order they did. */
function likedByNames(reactions, myId) {
  const mine = reactions.some((r) => String(r.userId) === String(myId));
  const others = reactions
    .filter((r) => String(r.userId) !== String(myId))
    .map((r) => r.userName || 'Someone');
  return mine ? ['You', ...others] : others;
}

/** Collapses that list to "You, Asha and 2 others" for the inline summary. */
function likedBySummary(names) {
  if (names.length <= 2) return names.join(' and ');
  const rest = names.length - 2;
  return `${names.slice(0, 2).join(', ')} and ${rest} ${rest === 1 ? 'other' : 'others'}`;
}

function AnnouncementCard({ item, classId, isTeacher, me, onChanged }) {
  const [showComments, setShowComments] = useState(false);
  const [reactions, setReactions] = useState(item.reactions || []);
  const [commentCount, setCommentCount] = useState(item.commentCount || 0);
  const toast = useToast();

  const myReaction = reactions.some((r) => String(r.userId) === String(me?.id));
  const likedBy = likedByNames(reactions, me?.id);

  const react = async () => {
    try {
      const result = await lmApi.reactToAnnouncement(classId, item._id, '👍');
      setReactions(result.reactions);
    } catch (error) {
      toast({ status: 'error', title: error.message });
    }
  };

  const remove = async () => {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Delete this post? Its comments go with it.')) return;
    try {
      await lmApi.deleteAnnouncement(classId, item._id);
      onChanged();
    } catch (error) {
      toast({ status: 'error', title: error.message });
    }
  };

  const togglePin = async () => {
    try {
      await lmApi.updateAnnouncement(classId, item._id, { pinned: !item.pinned });
      onChanged();
    } catch (error) {
      toast({ status: 'error', title: error.message });
    }
  };

  const canManage = isTeacher || String(item.authorId) === String(me?.id);

  return (
    <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="lg" p={5} mb={4}>
      <Flex gap={3} align="flex-start">
        <Avatar size="sm" name={item.authorName} />
        <Box flex="1" minW={0}>
          <Flex align="center" gap={2} wrap="wrap">
            <Text fontWeight="600" fontSize="sm">
              {item.authorName}
            </Text>
            <Text fontSize="xs" color="gray.500">
              {relativeTime(item.publishedAt)}
            </Text>
            {item.pinned && <Badge colorScheme="yellow">📌 Pinned</Badge>}
            {item.status === 'scheduled' && <Badge colorScheme="purple">Scheduled</Badge>}
            {item.status === 'draft' && <Badge colorScheme="gray">Draft</Badge>}
            {item.audience?.length > 0 && <Badge colorScheme="cyan">Targeted</Badge>}
          </Flex>
          <Box mt={2}>
            <RichText>{item.text}</RichText>
          </Box>
          <AttachmentList attachments={item.attachments} />
        </Box>

        {canManage && (
          <Menu>
            <MenuButton as={IconButton} size="sm" variant="ghost" icon={<span>⋮</span>} aria-label="Post actions" />
            <MenuList>
              {isTeacher && (
                <MenuItem {...buttonTextStyles} onClick={togglePin}>
                  {item.pinned ? 'Unpin' : 'Pin to top'}
                </MenuItem>
              )}
              <MenuItem color="red.600" onClick={remove}>
                Delete post
              </MenuItem>
            </MenuList>
          </Menu>
        )}
      </Flex>

      <Divider my={3} />
      <HStack spacing={3} wrap="wrap">
        <Button
          size="xs"
          variant={myReaction ? 'solid' : 'ghost'}
          colorScheme="blue"
          onClick={react}
          leftIcon={<span>👍</span>}
        >
          {reactions.length || ''}
        </Button>
        {likedBy.length > 0 && (
          <Tooltip label={likedBy.join(', ')} placement="top" hasArrow>
            <Text fontSize="xs" color="gray.500" cursor="default">
              Liked by {likedBySummary(likedBy)}
            </Text>
          </Tooltip>
        )}
        <Button size="xs" variant="ghost" onClick={() => setShowComments((v) => !v)}>
          💬 {commentCount} class {commentCount === 1 ? 'comment' : 'comments'}
        </Button>
      </HStack>

      <Collapse in={showComments} animateOpacity>
        <Box mt={3}>
          <CommentThread
            classId={classId}
            targetType="announcement"
            targetId={item._id}
            currentUserId={me?.id}
            canModerate={isTeacher}
            onCountChange={setCommentCount}
          />
        </Box>
      </Collapse>
    </Box>
  );
}

function CourseworkStreamCard({ item, classId }) {
  const meta = courseworkMeta(item);
  return (
    <Box
      as={RouterLink}
      // A coding card opens the exercise; /work/:id is its gradebook row, which
      // has no code on it and nowhere to go from there.
      to={courseworkLink({ ...item, classId })}
      display="block"
      bg="white"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="lg"
      p={5}
      mb={4}
      _hover={{ boxShadow: 'sm', borderColor: 'blue.300', textDecoration: 'none' }}
    >
      <Flex gap={3} align="center">
        <Flex
          w="40px"
          h="40px"
          borderRadius="full"
          bg={`${meta.colorScheme}.50`}
          align="center"
          justify="center"
          fontSize="lg"
          flexShrink={0}
        >
          {meta.icon}
        </Flex>
        <Box flex="1" minW={0}>
          <Text fontSize="sm" color="gray.600">
            {item.createdByName} posted a new {meta.label.toLowerCase()}
          </Text>
          <Heading size="sm" color="gray.800" noOfLines={1}>
            {item.title}
          </Heading>
          <HStack spacing={3} mt={1}>
            <Text fontSize="xs" color="gray.400">
              {relativeTime(item.publishedAt)}
            </Text>
            {item.workType !== 'material' && <DueBadge dueDate={item.dueDate} />}
            {item.mySubmission && <StateBadge state={item.mySubmission.state} late={item.mySubmission.late} />}
            {item.submissionStats && (
              <Badge colorScheme="gray">
                {item.submissionStats.turnedIn}/{item.submissionStats.total} handed in
              </Badge>
            )}
          </HStack>
        </Box>
      </Flex>
      {item.aiSourceSessionId && (
        <Badge mt={3} colorScheme="purple">
          ✨ Generated from a class recording
        </Badge>
      )}
      {item.workType === 'material' && item.instructions && (
        <Box mt={3} maxH="140px" overflow="hidden" position="relative">
          <RichText>{item.instructions.slice(0, 600)}</RichText>
          <Box
            position="absolute"
            bottom={0}
            left={0}
            right={0}
            h="50px"
            bgGradient="linear(to-t, white, transparent)"
          />
        </Box>
      )}
    </Box>
  );
}

export default function Stream() {
  const { classId, klass, isTeacher } = useOutletContext();
  const [data, setData] = useState(null);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [stream, profile] = await Promise.all([lmApi.getStream(classId), lmApi.me()]);
      setData(stream);
      setMe(profile);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <Loading label="Loading the stream…" />;

  return (
    <Flex gap={6} align="flex-start" direction={{ base: 'column', lg: 'row' }}>
      <Box w={{ base: '100%', lg: '280px' }} flexShrink={0}>
        <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="lg" p={4} mb={4}>
          <Heading size="xs" mb={3} color="gray.700">
            Upcoming
          </Heading>
          <Text fontSize="sm" color="gray.500">
            Track due dates on the{' '}
            <Text as={RouterLink} to="/learning/todo" color="blue.600" textDecoration="underline">
              To-do page
            </Text>
            .
          </Text>
          <Button as={RouterLink} to={`/learning/class/${classId}/material`} size="sm" mt={3} w="100%" variant="outline">
            View class material
          </Button>
        </Box>

        {klass.description && (
          <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="lg" p={4}>
            <Heading size="xs" mb={2} color="gray.700">
              About
            </Heading>
            <Text fontSize="sm" color="gray.600" whiteSpace="pre-wrap">
              {klass.description}
            </Text>
          </Box>
        )}
      </Box>

      <Box flex="1" minW={0}>
        <ErrorState error={error} onRetry={load} />
        {data?.canPost && <Composer classId={classId} onPosted={load} />}

        {!data?.items?.length ? (
          <EmptyState
            icon="📭"
            title="Nothing here yet"
            description={
              isTeacher
                ? 'Post an announcement or add material to get the class started.'
                : 'Your teacher has not posted anything yet.'
            }
          />
        ) : (
          data.items.map((item) =>
            item.streamType === 'announcement' ? (
              <AnnouncementCard
                key={item._id}
                item={item}
                classId={classId}
                isTeacher={isTeacher}
                me={me}
                onChanged={load}
              />
            ) : (
              <CourseworkStreamCard key={item._id} item={item} classId={classId} />
            ),
          )
        )}
      </Box>
    </Flex>
  );
}
