import React, { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useOutletContext } from 'react-router-dom';
import {
  Badge,
  Box,
  Button,
  Checkbox,
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
  NumberInput,
  NumberInputField,
  Select,
  SimpleGrid,
  Text,
  Textarea,
  useDisclosure,
  useToast,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import { AttachmentPicker } from '../components/Attachments';
import { DueBadge, EmptyState, ErrorState, Loading, StateBadge } from '../components/common';
import { WORK_TYPE_META, formatDate } from '../format';

const BLANK = {
  workType: 'assignment',
  title: '',
  instructions: '',
  points: 100,
  dueDate: '',
  topicId: '',
  allowLateSubmission: true,
  graded: true,
  answerType: 'short',
  choices: '',
  draft: false,
  scheduledFor: '',
};

function CourseworkModal({ isOpen, onClose, classId, topics, onSaved, initial }) {
  const [form, setForm] = useState(BLANK);
  const [attachments, setAttachments] = useState([]);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (!isOpen) return;
    if (initial) {
      setForm({
        ...BLANK,
        ...initial,
        dueDate: initial.dueDate ? new Date(initial.dueDate).toISOString().slice(0, 16) : '',
        topicId: initial.topicId || '',
        choices: (initial.questionConfig?.choices || []).join('\n'),
        answerType: initial.questionConfig?.answerType || 'short',
      });
      setAttachments(initial.attachments || []);
    } else {
      setForm(BLANK);
      setAttachments([]);
    }
  }, [isOpen, initial]);

  const set = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));

  const submit = async () => {
    if (!form.title.trim()) return;
    setSaving(true);
    try {
      const payload = {
        ...form,
        attachments,
        dueDate: form.dueDate || null,
        topicId: form.topicId || null,
        scheduledFor: form.scheduledFor || undefined,
        choices: form.choices
          .split('\n')
          .map((c) => c.trim())
          .filter(Boolean),
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

  const isMaterial = form.workType === 'material';

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="2xl" scrollBehavior="inside">
      <ModalOverlay />
      <ModalContent>
        <ModalHeader>{initial ? 'Edit item' : 'New classwork'}</ModalHeader>
        <ModalCloseButton />
        <ModalBody>
          {!initial && (
            <FormControl mb={4}>
              <FormLabel fontSize="sm">Type</FormLabel>
              <Select value={form.workType} onChange={(e) => set('workType', e.target.value)}>
                <option value="assignment">📄 Assignment</option>
                <option value="question">❓ Question</option>
                <option value="material">📚 Material</option>
              </Select>
              <Text fontSize="xs" color="gray.500" mt={1}>
                Quizzes are created from the Grades → Quizzes tab or the AI Studio.
              </Text>
            </FormControl>
          )}

          <FormControl isRequired mb={4}>
            <FormLabel fontSize="sm">Title</FormLabel>
            <Input value={form.title} onChange={(e) => set('title', e.target.value)} autoFocus />
          </FormControl>

          <FormControl mb={4}>
            <FormLabel fontSize="sm">{isMaterial ? 'Content (Markdown supported)' : 'Instructions'}</FormLabel>
            <Textarea
              value={form.instructions}
              onChange={(e) => set('instructions', e.target.value)}
              rows={isMaterial ? 10 : 5}
            />
          </FormControl>

          {form.workType === 'question' && (
            <SimpleGrid columns={{ base: 1, md: 2 }} spacing={4} mb={4}>
              <FormControl>
                <FormLabel fontSize="sm">Answer type</FormLabel>
                <Select value={form.answerType} onChange={(e) => set('answerType', e.target.value)}>
                  <option value="short">Short answer</option>
                  <option value="mcq">Multiple choice</option>
                </Select>
              </FormControl>
              {form.answerType === 'mcq' && (
                <FormControl>
                  <FormLabel fontSize="sm">Choices (one per line)</FormLabel>
                  <Textarea rows={4} value={form.choices} onChange={(e) => set('choices', e.target.value)} />
                </FormControl>
              )}
            </SimpleGrid>
          )}

          <SimpleGrid columns={{ base: 1, md: 3 }} spacing={4} mb={4}>
            {!isMaterial && (
              <FormControl>
                <FormLabel fontSize="sm">Points</FormLabel>
                <NumberInput min={0} value={form.points} onChange={(_, value) => set('points', Number.isNaN(value) ? 0 : value)}>
                  <NumberInputField />
                </NumberInput>
              </FormControl>
            )}
            {!isMaterial && (
              <FormControl>
                <FormLabel fontSize="sm">Due date</FormLabel>
                <Input type="datetime-local" value={form.dueDate} onChange={(e) => set('dueDate', e.target.value)} />
              </FormControl>
            )}
            <FormControl>
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
          </SimpleGrid>

          <AttachmentPicker attachments={attachments} onChange={setAttachments} disabled={saving} />

          {!isMaterial && (
            <Checkbox
              mt={4}
              size="sm"
              isChecked={form.allowLateSubmission}
              onChange={(e) => set('allowLateSubmission', e.target.checked)}
            >
              Accept work after the due date (flagged as late)
            </Checkbox>
          )}

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
            <Button
              variant="outline"
              onClick={() => {
                set('draft', true);
                setTimeout(submit, 0);
              }}
              isDisabled={!form.title.trim() || saving}
            >
              Save draft
            </Button>
          )}
          <Button colorScheme="blue" onClick={submit} isLoading={saving} isDisabled={!form.title.trim()}>
            {initial ? 'Save changes' : form.scheduledFor ? 'Schedule' : 'Assign'}
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
          Group classwork into units, chapters or weeks.
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

function CourseworkRow({ item, classId, isTeacher, onChanged, onEdit }) {
  const meta = WORK_TYPE_META[item.workType] || WORK_TYPE_META.assignment;
  const toast = useToast();

  const remove = async () => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete "${item.title}"? All submissions and grades for it are removed.`)) return;
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
      <Flex
        w="40px"
        h="40px"
        borderRadius="full"
        bg={`${meta.colorScheme}.50`}
        align="center"
        justify="center"
        flexShrink={0}
      >
        {meta.icon}
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
          {item.status !== 'published' && <Badge colorScheme={item.status === 'draft' ? 'gray' : 'purple'}>{item.status}</Badge>}
          {item.aiSourceSessionId && <Badge colorScheme="purple">✨ AI</Badge>}
        </Flex>
        <HStack spacing={3} mt={1} wrap="wrap">
          <Text fontSize="xs" color="gray.500">
            Posted {formatDate(item.publishedAt)}
          </Text>
          {item.workType !== 'material' && <DueBadge dueDate={item.dueDate} />}
          {item.points > 0 && (
            <Text fontSize="xs" color="gray.500">
              {item.points} pts
            </Text>
          )}
          {item.mySubmission && <StateBadge state={item.mySubmission.state} late={item.mySubmission.late} />}
        </HStack>
      </Box>

      {isTeacher && item.submissionStats && (
        <Box textAlign="right" display={{ base: 'none', md: 'block' }}>
          <Text fontSize="lg" fontWeight="700" color="gray.700" lineHeight="1">
            {item.submissionStats.turnedIn}
          </Text>
          <Text fontSize="xs" color="gray.500">
            of {item.submissionStats.total} in
          </Text>
        </Box>
      )}

      {isTeacher && (
        <Menu>
          <MenuButton as={IconButton} size="sm" variant="ghost" icon={<span>⋮</span>} aria-label="Item actions" />
          <MenuList>
            <MenuItem as={RouterLink} to={`/learning/class/${classId}/work/${item._id}/grade`}>
              Review student work
            </MenuItem>
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

export default function Classwork() {
  const { classId, klass, isTeacher, reloadClass } = useOutletContext();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState(null);
  const { isOpen, onOpen, onClose } = useDisclosure();

  const topics = klass.topics || [];

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await lmApi.listCoursework(classId, { workType: filter || undefined }));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId, filter]);

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

  if (loading) return <Loading label="Loading classwork…" />;

  return (
    <Flex gap={6} align="flex-start" direction={{ base: 'column', lg: 'row' }}>
      <Box flex="1" minW={0} order={{ base: 2, lg: 1 }} w="100%">
        <Flex justify="space-between" align="center" mb={4} gap={3} wrap="wrap">
          <HStack>
            <Select size="sm" maxW="180px" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">All work</option>
              <option value="assignment">Assignments</option>
              <option value="quiz">Quizzes</option>
              <option value="question">Questions</option>
              <option value="material">Materials</option>
            </Select>
          </HStack>
          {isTeacher && (
            <Button colorScheme="blue" size="sm" onClick={openNew}>
              + Create
            </Button>
          )}
        </Flex>

        <ErrorState error={error} onRetry={load} />

        {items.length === 0 ? (
          <EmptyState
            icon="📚"
            title="No classwork yet"
            description={
              isTeacher
                ? 'Assign work, post a question, or share reading material.'
                : 'Nothing has been assigned yet.'
            }
            action={isTeacher ? <Button size="sm" colorScheme="blue" onClick={openNew}>Create classwork</Button> : null}
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
                  <CourseworkRow
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
                  <CourseworkRow
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

      <CourseworkModal
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
