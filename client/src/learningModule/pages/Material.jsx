import React, { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useOutletContext } from 'react-router-dom';
import {
  Badge,
  Box,
  Button,
  Divider,
  Flex,
  FormControl,
  FormLabel,
  HStack,
  Heading,
  IconButton,
  Input,
  Menu,
  MenuButton,
  MenuItem,
  MenuList,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Select,
  Text,
  useDisclosure,
  useToast,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import { AttachmentPicker } from '../components/Attachments';
import RichTextEditor from '../components/RichTextEditor';
import { EmptyState, ErrorState, Loading } from '../components/common';
import { formatDate } from '../format';

// This tab is reading material and nothing else. Assessed work lives on its own
// tabs — Quizzes, Shorts, Tutorials — each of which owns its own editor, so
// there is no work-type picker here and nothing to grade.
const BLANK = {
  title: '',
  instructions: '',
  topicId: '',
  draft: false,
  scheduledFor: '',
};

function MaterialModal({ isOpen, onClose, classId, topics, onSaved, initial }) {
  const [form, setForm] = useState(BLANK);
  const [attachments, setAttachments] = useState([]);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (!isOpen) return;
    if (initial) {
      setForm({ ...BLANK, ...initial, topicId: initial.topicId || '' });
      setAttachments(initial.attachments || []);
    } else {
      setForm(BLANK);
      setAttachments([]);
    }
  }, [isOpen, initial]);

  const set = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));

  const save = async (asDraft) => {
    if (!form.title.trim()) return;
    setSaving(true);
    try {
      const payload = {
        workType: 'material',
        title: form.title,
        instructions: form.instructions,
        attachments,
        topicId: form.topicId || null,
        scheduledFor: form.scheduledFor || undefined,
        draft: asDraft,
        // Material is never assessed, so it carries no points and no deadline.
        graded: false,
        points: 0,
        dueDate: null,
      };
      if (initial) await lmApi.updateCoursework(classId, initial._id, payload);
      else await lmApi.createCoursework(classId, payload);
      onSaved();
      onClose();
    } catch (error) {
      toast({ status: 'error', title: 'Could not save', description: error.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="2xl" scrollBehavior="inside">
      <ModalOverlay />
      <ModalContent>
        <ModalHeader>{initial ? 'Edit material' : 'New material'}</ModalHeader>
        <ModalCloseButton />
        <ModalBody>
          <FormControl isRequired mb={4}>
            <FormLabel fontSize="sm">Title</FormLabel>
            <Input value={form.title} onChange={(e) => set('title', e.target.value)} autoFocus />
          </FormControl>

          <FormControl mb={4}>
            <FormLabel fontSize="sm">Content</FormLabel>
            <RichTextEditor
              value={form.instructions}
              onChange={(html) => set('instructions', html)}
              minH="260px"
              placeholder="Reading material, notes, links…"
            />
          </FormControl>

          <FormControl mb={4} maxW="320px">
            <FormLabel fontSize="sm">Topic</FormLabel>
            <Select value={form.topicId} onChange={(e) => set('topicId', e.target.value)}>
              <option value="">No topic</option>
              {topics.map((topic) => (
                <option key={topic._id} value={topic._id}>
                  {topic.name}
                </option>
              ))}
            </Select>
          </FormControl>

          <AttachmentPicker attachments={attachments} onChange={setAttachments} disabled={saving} />

          {!initial && (
            <FormControl mt={4}>
              <FormLabel fontSize="sm">Schedule for later (optional)</FormLabel>
              <Input
                type="datetime-local"
                maxW="260px"
                value={form.scheduledFor}
                onChange={(e) => set('scheduledFor', e.target.value)}
              />
            </FormControl>
          )}
        </ModalBody>
        <ModalFooter gap={2}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {!initial && (
            <Button variant="outline" onClick={() => save(true)} isDisabled={!form.title.trim() || saving}>
              Save draft
            </Button>
          )}
          <Button
            colorScheme="blue"
            onClick={() => save(false)}
            isLoading={saving}
            isDisabled={!form.title.trim()}
          >
            {initial ? 'Save changes' : form.scheduledFor ? 'Schedule' : 'Post'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function TopicManager({ classId, topics, onChanged }) {
  const [name, setName] = useState('');
  const toast = useToast();

  const add = async () => {
    if (!name.trim()) return;
    try {
      await lmApi.createTopic(classId, name.trim());
      setName('');
      onChanged();
    } catch (error) {
      toast({ status: 'error', title: error.message });
    }
  };

  const remove = async (topicId) => {
    try {
      await lmApi.deleteTopic(classId, topicId);
      onChanged();
    } catch (error) {
      toast({ status: 'error', title: error.message });
    }
  };

  return (
    <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="lg" p={4}>
      <Heading size="xs" mb={3} color="gray.700">
        Topics
      </Heading>
      {topics.length === 0 && (
        <Text fontSize="sm" color="gray.500" mb={3}>
          Group material into units, chapters or weeks.
        </Text>
      )}
      {topics.map((topic) => (
        <Flex key={topic._id} align="center" justify="space-between" py={1}>
          <Text fontSize="sm">{topic.name}</Text>
          <IconButton
            size="xs"
            variant="ghost"
            aria-label={`Delete topic ${topic.name}`}
            icon={<span>✕</span>}
            onClick={() => remove(topic._id)}
          />
        </Flex>
      ))}
      <Flex gap={2} mt={3}>
        <Input
          size="sm"
          placeholder="New topic"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <Button size="sm" onClick={add} isDisabled={!name.trim()}>
          Add
        </Button>
      </Flex>
    </Box>
  );
}

function MaterialRow({ item, classId, isTeacher, onChanged, onEdit }) {
  const toast = useToast();

  const remove = async () => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete "${item.title}"?`)) return;
    try {
      await lmApi.deleteCoursework(classId, item._id);
      onChanged();
    } catch (error) {
      toast({ status: 'error', title: error.message });
    }
  };

  return (
    <Flex
      bg="white"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="lg"
      p={4}
      mb={3}
      align="center"
      gap={4}
      _hover={{ borderColor: 'blue.300' }}
    >
      <Flex w="40px" h="40px" borderRadius="full" bg="green.50" align="center" justify="center" flexShrink={0}>
        📚
      </Flex>
      <Box
        as={RouterLink}
        to={`/learning/class/${classId}/work/${item._id}`}
        flex="1"
        minW={0}
        _hover={{ textDecoration: 'none' }}
      >
        <Flex align="center" gap={2} wrap="wrap">
          <Heading size="sm" color="gray.800" noOfLines={1}>
            {item.title}
          </Heading>
          {item.status !== 'published' && (
            <Badge colorScheme={item.status === 'draft' ? 'gray' : 'purple'}>{item.status}</Badge>
          )}
          {item.aiSourceSessionId && <Badge colorScheme="purple">✨ AI</Badge>}
        </Flex>
        <HStack spacing={3} mt={1} wrap="wrap">
          <Text fontSize="xs" color="gray.500">
            Posted {formatDate(item.publishedAt)}
          </Text>
          {item.attachments?.length > 0 && (
            <Text fontSize="xs" color="gray.500">
              📎 {item.attachments.length}
            </Text>
          )}
        </HStack>
      </Box>

      {isTeacher && (
        <Menu>
          <MenuButton as={IconButton} size="sm" variant="ghost" icon={<span>⋮</span>} aria-label="Material actions" />
          <MenuList>
            <MenuItem onClick={() => onEdit(item)}>Edit</MenuItem>
            <MenuItem color="red.600" onClick={remove}>
              Delete
            </MenuItem>
          </MenuList>
        </Menu>
      )}
    </Flex>
  );
}

export default function Material() {
  const { classId, klass, isTeacher, reloadClass } = useOutletContext();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const { isOpen, onOpen, onClose } = useDisclosure();

  const topics = klass.topics || [];

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await lmApi.listCoursework(classId, { workType: 'material' }));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId]);

  useEffect(() => {
    load();
  }, [load]);

  const openNew = () => {
    setEditing(null);
    onOpen();
  };
  const openEdit = (item) => {
    setEditing(item);
    onOpen();
  };
  const afterSave = async () => {
    await load();
    reloadClass();
  };

  const grouped = topics
    .map((topic) => ({ topic, items: items.filter((i) => String(i.topicId) === String(topic._id)) }))
    .filter((group) => group.items.length);
  const untopiced = items.filter((i) => !i.topicId);

  if (loading) return <Loading label="Loading material…" />;

  return (
    <Flex gap={6} align="flex-start" direction={{ base: 'column', lg: 'row' }}>
      <Box flex="1" minW={0} order={{ base: 2, lg: 1 }} w="100%">
        <Flex justify="space-between" align="center" mb={4} gap={3} wrap="wrap">
          <Box>
            <Heading size="md">Material</Heading>
            <Text fontSize="sm" color="gray.500">
              Reading material, notes and files for this class.
            </Text>
          </Box>
          {isTeacher && (
            <Button colorScheme="blue" size="sm" onClick={openNew}>
              + Add material
            </Button>
          )}
        </Flex>

        <ErrorState error={error} onRetry={load} />

        {items.length === 0 ? (
          <EmptyState
            icon="📚"
            title="No material yet"
            description={
              isTeacher
                ? 'Share reading material, notes or files with the class.'
                : 'Your teacher has not shared any material yet.'
            }
            action={
              isTeacher ? (
                <Button size="sm" colorScheme="blue" onClick={openNew}>
                  Add material
                </Button>
              ) : null
            }
          />
        ) : (
          <>
            {grouped.map((group) => (
              <Box key={group.topic._id} mb={6}>
                <Heading size="sm" color="gray.700" mb={2}>
                  {group.topic.name}
                </Heading>
                <Divider mb={3} />
                {group.items.map((item) => (
                  <MaterialRow
                    key={item._id}
                    item={item}
                    classId={classId}
                    isTeacher={isTeacher}
                    onChanged={afterSave}
                    onEdit={openEdit}
                  />
                ))}
              </Box>
            ))}
            {untopiced.length > 0 && (
              <Box>
                {grouped.length > 0 && (
                  <>
                    <Heading size="sm" color="gray.700" mb={2}>
                      Other
                    </Heading>
                    <Divider mb={3} />
                  </>
                )}
                {untopiced.map((item) => (
                  <MaterialRow
                    key={item._id}
                    item={item}
                    classId={classId}
                    isTeacher={isTeacher}
                    onChanged={afterSave}
                    onEdit={openEdit}
                  />
                ))}
              </Box>
            )}
          </>
        )}
      </Box>

      {isTeacher && (
        <Box w={{ base: '100%', lg: '260px' }} flexShrink={0} order={{ base: 1, lg: 2 }}>
          <TopicManager classId={classId} topics={topics} onChanged={reloadClass} />
        </Box>
      )}

      <MaterialModal
        isOpen={isOpen}
        onClose={onClose}
        classId={classId}
        topics={topics}
        onSaved={afterSave}
        initial={editing}
      />
    </Flex>
  );
}
