import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import {
  Alert,
  AlertIcon,
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
  Select,
  SimpleGrid,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Text,
  useToast,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import {
  ClassCardPreview,
  ColorPicker,
  EmptyState,
  ErrorState,
  Loading,
  StatTile,
} from '../components/common';
import { CLASS_COLORS } from '../format';
import { canCreateClass } from '../roles';

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

// A class is always "a subject, taught to one semester of one branch", and the
// timetable module already holds that catalogue — so the form picks from it
// rather than asking the teacher to retype names and codes. Everything else
// (room, description, meeting link) is left to class settings.
function CreateClassModal({ isOpen, onClose, onCreated }) {
  const [branches, setBranches] = useState([]);
  const [semesters, setSemesters] = useState([]);
  const [subjects, setSubjects] = useState([]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [loadingSemesters, setLoadingSemesters] = useState(false);
  const [loadingSubjects, setLoadingSubjects] = useState(false);
  const [catalogueError, setCatalogueError] = useState(null);

  const [branchCode, setBranchCode] = useState('');
  const [semester, setSemester] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [name, setName] = useState('');
  const [coverColor, setCoverColor] = useState(CLASS_COLORS[0]);
  const [saving, setSaving] = useState(false);
  // Once the teacher edits the name themselves, stop overwriting it when they
  // change the subject.
  const [nameTouched, setNameTouched] = useState(false);
  const toast = useToast();

  const branch = branches.find((item) => item.code === branchCode) || null;
  const subject = subjects.find((item) => item.id === subjectId) || null;
  const section = semester ? `Sem ${semester}` : '';

  const reset = useCallback(() => {
    setBranchCode('');
    setSemester('');
    setSubjectId('');
    setName('');
    setNameTouched(false);
    setCoverColor(CLASS_COLORS[0]);
  }, []);

  // Branches of the current academic session.
  useEffect(() => {
    if (!isOpen) return undefined;
    let cancelled = false;
    setLoadingBranches(true);
    setCatalogueError(null);
    lmApi
      .ttBranches()
      .then((list) => {
        if (cancelled) return;
        setBranches(list);
        // Nothing to choose between when the department runs a single branch.
        if (list.length === 1) setBranchCode(list[0].code);
      })
      .catch((error) => !cancelled && setCatalogueError(error))
      .finally(() => !cancelled && setLoadingBranches(false));
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  useEffect(() => {
    setSemester('');
    setSubjectId('');
    setSemesters([]);
    if (!branchCode) return undefined;
    let cancelled = false;
    setLoadingSemesters(true);
    lmApi
      .ttSemesters(branchCode)
      .then((list) => !cancelled && setSemesters(list))
      .catch(() => !cancelled && setSemesters([]))
      .finally(() => !cancelled && setLoadingSemesters(false));
    return () => {
      cancelled = true;
    };
  }, [branchCode]);

  useEffect(() => {
    setSubjectId('');
    setSubjects([]);
    if (!branchCode || !semester) return undefined;
    let cancelled = false;
    setLoadingSubjects(true);
    lmApi
      .ttSubjects(branchCode, semester)
      .then((list) => !cancelled && setSubjects(list))
      .catch(() => !cancelled && setSubjects([]))
      .finally(() => !cancelled && setLoadingSubjects(false));
    return () => {
      cancelled = true;
    };
  }, [branchCode, semester]);

  // The subject name is the sensible class name; keep it in step until edited.
  useEffect(() => {
    if (nameTouched) return;
    setName(subject ? subject.name : '');
  }, [subject, nameTouched]);

  const submit = async () => {
    if (!subject || !name.trim()) return;
    setSaving(true);
    try {
      const created = await lmApi.createClass({
        name: name.trim(),
        section,
        subject: subject.subName || subject.name,
        subjectCode: subject.subCode,
        semester,
        dept: branch?.dept || '',
        coverColor,
      });
      toast({ status: 'success', title: `"${created.name}" created`, description: `Class code: ${created.code}` });
      reset();
      onCreated(created);
    } catch (error) {
      toast({ status: 'error', title: 'Could not create class', description: error.message });
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    reset();
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={close} size="lg">
      <ModalOverlay />
      <ModalContent>
        <ModalHeader>Create a class</ModalHeader>
        <ModalCloseButton />
        <ModalBody>
          <ErrorState error={catalogueError} />
          {!catalogueError && !loadingBranches && branches.length === 0 && (
            <Alert status="warning" borderRadius="md" mb={4} fontSize="sm">
              <AlertIcon />
              No timetable is set up for the current session yet, so there are no branches to pick
              from. Ask the timetable admin to publish one.
            </Alert>
          )}

          <SimpleGrid columns={{ base: 1, sm: 2 }} spacing={4} mb={4}>
            <FormControl isRequired>
              <FormLabel fontSize="sm">Branch</FormLabel>
              <Select
                value={branchCode}
                onChange={(event) => setBranchCode(event.target.value)}
                placeholder={loadingBranches ? 'Loading…' : 'Select branch'}
                isDisabled={loadingBranches || branches.length === 0}
                autoFocus
              >
                {branches.map((item) => (
                  <option key={item.code} value={item.code}>
                    {item.dept}
                  </option>
                ))}
              </Select>
            </FormControl>
            <FormControl isRequired>
              <FormLabel fontSize="sm">Semester</FormLabel>
              <Select
                value={semester}
                onChange={(event) => setSemester(event.target.value)}
                placeholder={loadingSemesters ? 'Loading…' : 'Select semester'}
                isDisabled={!branchCode || loadingSemesters}
              >
                {semesters.map((item) => (
                  <option key={item} value={item}>
                    Semester {item}
                  </option>
                ))}
              </Select>
              {branchCode && !loadingSemesters && semesters.length === 0 && (
                <FormHelperText color="orange.600">
                  No subjects are registered for this branch yet.
                </FormHelperText>
              )}
            </FormControl>
          </SimpleGrid>

          <FormControl isRequired mb={4}>
            <FormLabel fontSize="sm">Subject</FormLabel>
            <Select
              value={subjectId}
              onChange={(event) => setSubjectId(event.target.value)}
              placeholder={loadingSubjects ? 'Loading…' : 'Select subject'}
              isDisabled={!semester || loadingSubjects}
            >
              {subjects.map((item) => (
                <option key={item.id} value={item.id}>
                  {[item.subCode, item.name].filter(Boolean).join(' — ')}
                  {item.type ? ` (${item.type})` : ''}
                </option>
              ))}
            </Select>
            {semester && !loadingSubjects && subjects.length === 0 && (
              <FormHelperText color="orange.600">
                No subjects found for this branch and semester in the timetable.
              </FormHelperText>
            )}
          </FormControl>

          <FormControl isRequired mb={4}>
            <FormLabel fontSize="sm">Class name</FormLabel>
            <Input
              value={name}
              onChange={(event) => {
                setNameTouched(true);
                setName(event.target.value);
              }}
              placeholder="Picked from the subject — edit if you want"
            />
          </FormControl>

          <FormControl mb={4}>
            <FormLabel fontSize="sm">Theme colour</FormLabel>
            <ColorPicker value={coverColor} options={CLASS_COLORS} onChange={setCoverColor} />
          </FormControl>

          <Box>
            <Text fontSize="xs" color="gray.500" mb={2}>
              Preview
            </Text>
            <ClassCardPreview
              color={coverColor}
              title={name || 'Class name'}
              subtitle={
                [section, subject?.subName || subject?.name].filter(Boolean).join(' · ') ||
                'Semester · Subject'
              }
            />
          </Box>
        </ModalBody>
        <ModalFooter gap={2}>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            colorScheme="blue"
            onClick={submit}
            isLoading={saving}
            isDisabled={!subject || !name.trim()}
          >
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
  const { me, overview, reloadOverview } = useOutletContext() || {};
  const [classes, setClasses] = useState([]);
  const [archived, setArchived] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  // Creating a class is faculty-only on the server, so a student never sees
  // the entry points — nor the modal if they land on ?create=1 by hand.
  const mayCreateClass = canCreateClass(me?.roles);
  const showCreate = mayCreateClass && searchParams.get('create') === '1';
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
        {/* Creating a class lives only in the module header, so it is not
            offered twice on the same screen. Joining stays here: it is the
            action a student came for. */}
        <HStack>
          <Button variant="outline" onClick={() => setSearchParams({ join: '1' })}>
            Join class
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
                  description={
                    mayCreateClass
                      ? 'Use Create in the header if you teach, or join one with the code your teacher shared.'
                      : 'Join one with the code your teacher shared.'
                  }
                  action={
                    <Button size="sm" variant="outline" onClick={() => setSearchParams({ join: '1' })}>
                      Join a class
                    </Button>
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
