import React, { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useOutletContext } from 'react-router-dom';
import {
  Badge,
  Box,
  Button,
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
  useDisclosure,
  useToast,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import { AttachmentList } from '../components/Attachments';
import MaterialModal from '../components/MaterialModal';
import { EmptyState, ErrorState, Loading } from '../components/common';
import { formatDate } from '../format';

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
    <Box
      bg="white"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="lg"
      p={4}
      mb={3}
      _hover={{ borderColor: 'blue.300' }}
    >
      <Flex align="center" gap={4}>
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

      {/* Links and files sit outside the row link so they stay clickable. */}
      <Box pl={{ base: 0, sm: '56px' }}>
        <AttachmentList attachments={item.attachments} compact />
      </Box>
    </Box>
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
