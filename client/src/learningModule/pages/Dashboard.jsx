import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import {
  Badge,
  Box,
  Button,
  Flex,
  FormControl,
  FormHelperText,
  FormLabel,
  Grid,
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
  SimpleGrid,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Text,
  Textarea,
  useToast,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import { EmptyState, ErrorState, Loading, StatTile } from '../components/common';
import { CLASS_COLORS } from '../format';

function ClassCard({ klass, onOpen }) {
  const isTeacher = ['teacher', 'co-teacher'].includes(klass.myRole);
  return (
    <Box
      as="button"
      textAlign="left"
      onClick={() => onOpen(klass)}
      bg="white"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="lg"
      overflow="hidden"
      transition="all 0.15s"
      _hover={{ boxShadow: 'md', transform: 'translateY(-2px)' }}
    >
      <Box bg={klass.coverColor || '#1967d2'} px={5} pt={5} pb={4} color="white" position="relative">
        <Heading size="md" noOfLines={2} pr={16}>
          {klass.name}
        </Heading>
        <Text fontSize="sm" opacity={0.9} noOfLines={1}>
          {[klass.section, klass.subject].filter(Boolean).join(' · ') || ' '}
        </Text>
        <Badge
          position="absolute"
          top={4}
          right={4}
          colorScheme={isTeacher ? 'yellow' : 'whiteAlpha'}
          borderRadius="full"
          fontSize="0.65rem"
        >
          {isTeacher ? 'Teaching' : 'Student'}
        </Badge>
      </Box>
      <Box px={5} py={4}>
        <Text fontSize="sm" color="gray.600" noOfLines={1}>
          {klass.ownerName}
        </Text>
        <HStack mt={3} spacing={4} fontSize="xs" color="gray.500">
          <Text>👥 {klass.stats?.studentCount ?? 0}</Text>
          <Text>📄 {klass.stats?.courseworkCount ?? 0}</Text>
          {isTeacher && <Text>🔑 {klass.code}</Text>}
        </HStack>
        {klass.myStatus === 'pending' && (
          <Badge mt={3} colorScheme="orange">
            Waiting for approval
          </Badge>
        )}
      </Box>
    </Box>
  );
}

function CreateClassModal({ isOpen, onClose, onCreated }) {
  const blank = {
    name: '',
    section: '',
    subject: '',
    subjectCode: '',
    room: '',
    description: '',
    coverColor: CLASS_COLORS[0],
  };
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const set = (field) => (event) => setForm((prev) => ({ ...prev, [field]: event.target.value }));

  const submit = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const created = await lmApi.createClass(form);
      toast({ status: 'success', title: `"${created.name}" created`, description: `Class code: ${created.code}` });
      setForm(blank);
      onCreated(created);
    } catch (error) {
      toast({ status: 'error', title: 'Could not create class', description: error.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg">
      <ModalOverlay />
      <ModalContent>
        <ModalHeader>Create a class</ModalHeader>
        <ModalCloseButton />
        <ModalBody>
          <FormControl isRequired mb={4}>
            <FormLabel fontSize="sm">Class name</FormLabel>
            <Input value={form.name} onChange={set('name')} placeholder="Digital Signal Processing" autoFocus />
          </FormControl>
          <SimpleGrid columns={{ base: 1, sm: 2 }} spacing={4} mb={4}>
            <FormControl>
              <FormLabel fontSize="sm">Section</FormLabel>
              <Input value={form.section} onChange={set('section')} placeholder="ECE-6A" />
            </FormControl>
            <FormControl>
              <FormLabel fontSize="sm">Subject</FormLabel>
              <Input value={form.subject} onChange={set('subject')} placeholder="Signal Processing" />
            </FormControl>
            <FormControl>
              <FormLabel fontSize="sm">Subject code</FormLabel>
              <Input value={form.subjectCode} onChange={set('subjectCode')} placeholder="ECPC-302" />
            </FormControl>
            <FormControl>
              <FormLabel fontSize="sm">Room</FormLabel>
              <Input value={form.room} onChange={set('room')} placeholder="LT-3" />
            </FormControl>
          </SimpleGrid>
          <FormControl mb={4}>
            <FormLabel fontSize="sm">Description</FormLabel>
            <Textarea
              value={form.description}
              onChange={set('description')}
              rows={3}
              placeholder="What this course covers…"
            />
          </FormControl>
          <FormControl>
            <FormLabel fontSize="sm">Theme colour</FormLabel>
            <HStack spacing={2}>
              {CLASS_COLORS.map((color) => (
                <Box
                  key={color}
                  as="button"
                  aria-label={`Use colour ${color}`}
                  w="30px"
                  h="30px"
                  borderRadius="full"
                  bg={color}
                  borderWidth={form.coverColor === color ? '3px' : '1px'}
                  borderColor={form.coverColor === color ? 'gray.800' : 'gray.200'}
                  onClick={() => setForm((prev) => ({ ...prev, coverColor: color }))}
                />
              ))}
            </HStack>
          </FormControl>
        </ModalBody>
        <ModalFooter gap={2}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button colorScheme="blue" onClick={submit} isLoading={saving} isDisabled={!form.name.trim()}>
            Create class
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function JoinClassModal({ isOpen, onClose, onJoined }) {
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  // Peek at the class as soon as a full-length code is typed, so a student
  // knows what they are about to join.
  useEffect(() => {
    const trimmed = code.trim();
    if (trimmed.length < 6) {
      setPreview(null);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const found = await lmApi.previewCode(trimmed);
        if (!cancelled) setPreview(found);
      } catch {
        if (!cancelled) setPreview(null);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code]);

  const submit = async () => {
    setBusy(true);
    try {
      const result = await lmApi.joinByCode(code.trim());
      toast({
        status: 'success',
        title: result.status === 'pending' ? 'Request sent' : 'Joined',
        description:
          result.status === 'pending'
            ? 'The teacher will review your request.'
            : `You are now in ${result.className || 'the class'}.`,
      });
      setCode('');
      setPreview(null);
      onJoined(result);
    } catch (error) {
      toast({ status: 'error', title: 'Could not join', description: error.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose}>
      <ModalOverlay />
      <ModalContent>
        <ModalHeader>Join a class</ModalHeader>
        <ModalCloseButton />
        <ModalBody>
          <FormControl>
            <FormLabel fontSize="sm">Class code</FormLabel>
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="e.g. k3mq9xt"
              autoFocus
              onKeyDown={(event) => event.key === 'Enter' && code.trim() && submit()}
            />
            <FormHelperText>Ask your teacher for the 7-character class code.</FormHelperText>
          </FormControl>
          {preview && (
            <Box mt={4} p={3} borderWidth="1px" borderRadius="md" borderLeftWidth="4px" borderLeftColor={preview.coverColor}>
              <Text fontWeight="600">{preview.name}</Text>
              <Text fontSize="sm" color="gray.600">
                {[preview.section, preview.subject].filter(Boolean).join(' · ')}
              </Text>
              <Text fontSize="xs" color="gray.500">
                Taught by {preview.ownerName}
              </Text>
            </Box>
          )}
        </ModalBody>
        <ModalFooter gap={2}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button colorScheme="blue" onClick={submit} isLoading={busy} isDisabled={code.trim().length < 4}>
            Join
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

export default function Dashboard() {
  const { overview, reloadOverview } = useOutletContext() || {};
  const [classes, setClasses] = useState([]);
  const [archived, setArchived] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const showCreate = searchParams.get('create') === '1';
  const showJoin = searchParams.get('join') === '1';
  const closeModals = () => setSearchParams({}, { replace: true });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [active, old] = await Promise.all([lmApi.listClasses(), lmApi.listClasses('archived')]);
      setClasses(active);
      setArchived(old);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openClass = (klass) => navigate(`/learning/class/${klass._id}`);

  const afterChange = async () => {
    closeModals();
    await load();
    reloadOverview?.();
  };

  return (
    <Box>
      <Flex justify="space-between" align="center" mb={5} wrap="wrap" gap={3}>
        <Box>
          <Heading size="lg" color="gray.800">
            Your classes
          </Heading>
          <Text color="gray.500" fontSize="sm">
            Everything you teach or are enrolled in.
          </Text>
        </Box>
        <HStack>
          <Button variant="outline" onClick={() => setSearchParams({ join: '1' })}>
            Join class
          </Button>
          <Button colorScheme="blue" onClick={() => setSearchParams({ create: '1' })}>
            Create class
          </Button>
        </HStack>
      </Flex>

      {overview && (
        <Grid templateColumns={{ base: '1fr 1fr', md: 'repeat(4, 1fr)' }} gap={4} mb={6}>
          <StatTile label="Classes" value={overview.classCount} hint={`${overview.teachingCount} teaching`} />
          <StatTile label="Pending work" value={overview.pendingWork} accent="orange.500" hint="Not turned in" />
          <StatTile label="To review" value={overview.awaitingReview} accent="purple.500" hint="Student submissions" />
          <StatTile label="Due this week" value={overview.dueThisWeek} accent="red.500" />
        </Grid>
      )}

      <ErrorState error={error} onRetry={load} />

      {loading ? (
        <Loading label="Loading your classes…" />
      ) : (
        <Tabs colorScheme="blue" variant="soft-rounded">
          <TabList mb={4}>
            <Tab fontSize="sm">Active ({classes.length})</Tab>
            <Tab fontSize="sm">Archived ({archived.length})</Tab>
          </TabList>
          <TabPanels>
            <TabPanel px={0}>
              {classes.length === 0 ? (
                <EmptyState
                  icon="🏫"
                  title="No classes yet"
                  description="Create a class if you teach, or join one with the code your teacher shared."
                  action={
                    <HStack>
                      <Button size="sm" variant="outline" onClick={() => setSearchParams({ join: '1' })}>
                        Join a class
                      </Button>
                      <Button size="sm" colorScheme="blue" onClick={() => setSearchParams({ create: '1' })}>
                        Create a class
                      </Button>
                    </HStack>
                  }
                />
              ) : (
                <SimpleGrid columns={{ base: 1, sm: 2, lg: 3 }} spacing={5}>
                  {classes.map((klass) => (
                    <ClassCard key={klass._id} klass={klass} onOpen={openClass} />
                  ))}
                </SimpleGrid>
              )}
            </TabPanel>
            <TabPanel px={0}>
              {archived.length === 0 ? (
                <EmptyState icon="🗄️" title="Nothing archived" description="Archived classes stay readable but are hidden from the main list." />
              ) : (
                <SimpleGrid columns={{ base: 1, sm: 2, lg: 3 }} spacing={5}>
                  {archived.map((klass) => (
                    <ClassCard key={klass._id} klass={klass} onOpen={openClass} />
                  ))}
                </SimpleGrid>
              )}
            </TabPanel>
          </TabPanels>
        </Tabs>
      )}

      <CreateClassModal isOpen={showCreate} onClose={closeModals} onCreated={afterChange} />
      <JoinClassModal isOpen={showJoin} onClose={closeModals} onJoined={afterChange} />
    </Box>
  );
}
