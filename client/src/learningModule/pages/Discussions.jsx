import React, { useCallback, useEffect, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Heading,
  Input,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Text,
  Textarea,
  VStack,
  useDisclosure,
  useToast,
} from '@chakra-ui/react';

import lmApi from '../api/lmApi';
import CommentThread from '../components/CommentThread';
import { EmptyState, ErrorState, Loading, SectionCard } from '../components/common';
import { relativeTime } from '../format';

/**
 * The class forum.
 *
 * Distinct from the stream, which is the teacher broadcasting. Here the class
 * talks and staff join in, so a student question is not competing with the
 * homework for the same space.
 *
 * One new topic per student per week, and the button says so *before* anything
 * is typed — the server refuses the second one either way, but finding that out
 * after writing a post is a bad way to learn a rule.
 */

function NewTopicModal({ isOpen, onClose, classId, onCreated }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const submit = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      await lmApi.createDiscussion(classId, { title: title.trim(), body: body.trim() });
      toast({ status: 'success', title: 'Discussion started' });
      setTitle('');
      setBody('');
      onCreated();
      onClose();
    } catch (err) {
      toast({
        status: err.payload?.code === 'WEEKLY_LIMIT' ? 'info' : 'error',
        title: err.message,
        duration: 6000,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl">
      <ModalOverlay />
      <ModalContent>
        <ModalHeader>Start a discussion</ModalHeader>
        <ModalCloseButton />
        <ModalBody>
          <VStack align="stretch" spacing={3}>
            <Input
              placeholder="What do you want to ask the class?"
              value={title}
              maxLength={140}
              onChange={(event) => setTitle(event.target.value)}
              autoFocus
            />
            <Textarea
              placeholder="Add any detail — what you have tried, where you got stuck."
              rows={6}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
            <Text fontSize="xs" color="gray.500">
              You get one new topic a week, so make it one worth the class&apos;s time. Replying to
              other people&apos;s threads is unlimited.
            </Text>
          </VStack>
        </ModalBody>
        <ModalFooter gap={2}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button colorScheme="purple" onClick={submit} isLoading={saving} isDisabled={!title.trim()}>
            Post it
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function Thread({ discussion, classId, isTeacher, onChanged }) {
  const [open, setOpen] = useState(false);
  const toast = useToast();

  const remove = async () => {
    try {
      await lmApi.deleteDiscussion(classId, discussion._id);
      toast({ status: 'success', title: 'Discussion removed' });
      onChanged();
    } catch (err) {
      toast({ status: 'error', title: err.message });
    }
  };

  const setFlag = async (patch) => {
    try {
      await lmApi.updateDiscussion(classId, discussion._id, patch);
      onChanged();
    } catch (err) {
      toast({ status: 'error', title: err.message });
    }
  };

  if (discussion.removed) {
    // The tombstone. Deliberately visible: moderation that looks like the post
    // never existed is worse than moderation.
    return (
      <Box borderWidth="1px" borderRadius="md" px={4} py={3} opacity={0.6}>
        <Text fontSize="sm" fontStyle="italic">
          🚫 A discussion here was removed{discussion.removedByName ? ` by ${discussion.removedByName}` : ''}.
        </Text>
      </Box>
    );
  }

  return (
    <Box borderWidth="1px" borderRadius="md" overflow="hidden">
      <Flex
        as="button"
        w="100%"
        textAlign="left"
        px={4}
        py={3}
        gap={3}
        align="flex-start"
        _hover={{ bg: 'gray.50' }}
        onClick={() => setOpen((current) => !current)}
      >
        <Box flex="1" minW={0}>
          <HStack spacing={2} mb={0.5} wrap="wrap">
            {discussion.pinned && <Badge colorScheme="purple">pinned</Badge>}
            {discussion.closed && <Badge colorScheme="gray">closed</Badge>}
            <Text fontWeight="600" noOfLines={2}>
              {discussion.title}
            </Text>
          </HStack>
          <Text fontSize="xs" color="gray.500">
            {discussion.authorName}
            {discussion.authorRole !== 'student' ? ' · staff' : ''} · {relativeTime(discussion.created_at)}
            {discussion.replyCount > 0
              ? ` · ${discussion.replyCount} repl${discussion.replyCount === 1 ? 'y' : 'ies'}`
              : ' · no replies yet'}
            {discussion.lastReplyBy ? ` · last from ${discussion.lastReplyBy}` : ''}
          </Text>
        </Box>
        <Text fontSize="lg" flexShrink={0} aria-hidden="true">
          {open ? '−' : '+'}
        </Text>
      </Flex>

      {open && (
        <Box px={4} pb={4} borderTopWidth="1px">
          {discussion.body && (
            <Text fontSize="sm" whiteSpace="pre-wrap" py={3}>
              {discussion.body}
            </Text>
          )}

          <HStack spacing={2} mb={3} wrap="wrap">
            {isTeacher && (
              <>
                <Button size="xs" variant="outline" onClick={() => setFlag({ pinned: !discussion.pinned })}>
                  {discussion.pinned ? 'Unpin' : 'Pin'}
                </Button>
                <Button size="xs" variant="outline" onClick={() => setFlag({ closed: !discussion.closed })}>
                  {discussion.closed ? 'Reopen' : 'Close'}
                </Button>
              </>
            )}
            {discussion.canDelete && (
              <Button size="xs" variant="ghost" colorScheme="red" onClick={remove}>
                Remove
              </Button>
            )}
          </HStack>

          {discussion.closed ? (
            <Alert status="info" borderRadius="md" fontSize="sm">
              <AlertIcon />
              This discussion has been closed. You can still read it.
            </Alert>
          ) : (
            /* Ordinary comments, so threading, notification and moderation
               behave exactly as they do everywhere else in the module. */
            <CommentThread
              classId={classId}
              targetType="discussion"
              targetId={discussion._id}
              canModerate={isTeacher}
              placeholder="Reply to this discussion…"
              emptyLabel="No replies yet — go on."
              onCountChange={onChanged}
            />
          )}
        </Box>
      )}
    </Box>
  );
}

export default function Discussions() {
  const { classId, isTeacher } = useOutletContext();
  const { discussionId } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { isOpen, onOpen, onClose } = useDisclosure();

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await lmApi.listDiscussions(classId));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <Loading label="Loading the forum…" />;
  if (error) return <ErrorState error={error} onRetry={load} />;

  // A deep link from a notification opens straight onto its thread.
  const ordered = discussionId
    ? [...data.discussions].sort((a, b) =>
        String(a._id) === discussionId ? -1 : String(b._id) === discussionId ? 1 : 0,
      )
    : data.discussions;

  return (
    <VStack align="stretch" spacing={4}>
      <SectionCard
        title="Class forum"
        subtitle="Ask the class something. Anyone can start a topic; everyone can reply."
        action={
          <Button size="sm" colorScheme="purple" onClick={onOpen} isDisabled={!data.canStart}>
            Start a discussion
          </Button>
        }
      >
        {!data.canStart && (
          <Alert status="info" borderRadius="md" fontSize="sm" mb={3}>
            <AlertIcon />
            You have started your discussion for this week. You can start another next Monday —
            replying to other threads is unlimited.
          </Alert>
        )}

        {ordered.length === 0 ? (
          <EmptyState
            icon="💬"
            title="Nothing here yet"
            description="Be the first to ask the class something."
          />
        ) : (
          <VStack align="stretch" spacing={2}>
            {ordered.map((discussion) => (
              <Thread
                key={discussion._id}
                discussion={discussion}
                classId={classId}
                isTeacher={isTeacher}
                onChanged={load}
              />
            ))}
          </VStack>
        )}
      </SectionCard>

      <Heading size="xs" color="gray.500" fontWeight="500">
        Starting a discussion and replying to one both earn points. Staff can remove anything; you can
        remove your own thread while nobody has replied to it.
      </Heading>

      <NewTopicModal isOpen={isOpen} onClose={onClose} classId={classId} onCreated={load} />
    </VStack>
  );
}
