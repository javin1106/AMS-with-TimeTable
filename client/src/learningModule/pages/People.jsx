import React, { useCallback, useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import {
  Avatar,
  Badge,
  Box,
  Button,
  Divider,
  Flex,
  FormControl,
  FormHelperText,
  FormLabel,
  HStack,
  Heading,
  Menu,
  MenuButton,
  MenuDivider,
  MenuItem,
  MenuList,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Progress,
  Select,
  Text,
  Textarea,
  useDisclosure,
  useToast,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import { EmptyState, ErrorState, Loading, SectionCard } from '../components/common';
import { formatDate, initials, relativeTime } from '../format';

function InviteModal({ isOpen, onClose, classId, onDone }) {
  const [emails, setEmails] = useState('');
  const [role, setRole] = useState('student');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const submit = async () => {
    const list = emails
      .split(/[\s,;]+/)
      .map((e) => e.trim())
      .filter(Boolean);
    if (!list.length) return;

    setBusy(true);
    try {
      const result = await lmApi.inviteMembers(classId, list, role);
      const added = result.results.filter((r) => r.status === 'added').length;
      const invited = result.results.filter((r) => r.status === 'invited').length;
      const existing = result.results.filter((r) => r.status === 'already_member').length;
      toast({
        status: 'success',
        title: 'Invites processed',
        description: `${added} added, ${invited} invited by email, ${existing} already in the class.`,
      });
      setEmails('');
      onDone();
      onClose();
    } catch (error) {
      toast({ status: 'error', title: 'Could not invite', description: error.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg">
      <ModalOverlay />
      <ModalContent>
        <ModalHeader>Invite people</ModalHeader>
        <ModalCloseButton />
        <ModalBody>
          <FormControl mb={4}>
            <FormLabel fontSize="sm">Role</FormLabel>
            <Select value={role} onChange={(event) => setRole(event.target.value)}>
              <option value="student">Student</option>
              <option value="co-teacher">Co-teacher</option>
            </Select>
          </FormControl>
          <FormControl>
            <FormLabel fontSize="sm">Email addresses</FormLabel>
            <Textarea
              rows={6}
              value={emails}
              onChange={(event) => setEmails(event.target.value)}
              placeholder={'one@nitj.ac.in\ntwo@nitj.ac.in, three@nitj.ac.in'}
            />
            <FormHelperText>
              Separate with commas, spaces or new lines. People without an XCEED account are enrolled
              automatically the first time they sign in.
            </FormHelperText>
          </FormControl>
        </ModalBody>
        <ModalFooter gap={2}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button colorScheme="blue" onClick={submit} isLoading={busy} isDisabled={!emails.trim()}>
            Send invites
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function ProgressModal({ isOpen, onClose, classId, membership }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!isOpen || !membership) return;
    setData(null);
    lmApi.memberProgress(classId, membership._id).then(setData).catch(() => setData(null));
  }, [isOpen, membership, classId]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl" scrollBehavior="inside">
      <ModalOverlay />
      <ModalContent>
        <ModalHeader>{membership?.name || 'Student'}</ModalHeader>
        <ModalCloseButton />
        <ModalBody pb={6}>
          {!data ? (
            <Loading minH="160px" />
          ) : (
            <>
              <HStack spacing={6} mb={4}>
                <Box>
                  <Text fontSize="2xl" fontWeight="700">
                    {data.summary.turnedIn}
                  </Text>
                  <Text fontSize="xs" color="gray.500">
                    Turned in
                  </Text>
                </Box>
                <Box>
                  <Text fontSize="2xl" fontWeight="700" color="red.500">
                    {data.summary.late}
                  </Text>
                  <Text fontSize="xs" color="gray.500">
                    Late
                  </Text>
                </Box>
                <Box>
                  <Text fontSize="2xl" fontWeight="700" color="blue.500">
                    {data.summary.percent === null ? '—' : `${data.summary.percent}%`}
                  </Text>
                  <Text fontSize="xs" color="gray.500">
                    {data.summary.earned}/{data.summary.possible} points
                  </Text>
                </Box>
              </HStack>
              {data.summary.percent !== null && (
                <Progress value={data.summary.percent} colorScheme="blue" borderRadius="full" mb={4} />
              )}
              <Divider mb={3} />
              {data.submissions.map((submission) => (
                <Flex key={submission._id} justify="space-between" py={2} borderBottomWidth="1px" borderColor="gray.100">
                  <Box>
                    <Text fontSize="sm">{submission.courseworkId?.title || 'Deleted item'}</Text>
                    <Text fontSize="xs" color="gray.500">
                      {submission.state}
                      {submission.late ? ' · late' : ''}
                    </Text>
                  </Box>
                  <Text fontSize="sm" fontWeight="600">
                    {submission.grade === null || submission.grade === undefined
                      ? '—'
                      : `${submission.grade}/${submission.maxPoints}`}
                  </Text>
                </Flex>
              ))}
            </>
          )}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

function PersonRow({ member, isTeacher, isOwner, classId, onChanged, onViewProgress }) {
  const toast = useToast();

  const act = async (fn, successTitle) => {
    try {
      await fn();
      toast({ status: 'success', title: successTitle });
      onChanged();
    } catch (error) {
      toast({ status: 'error', title: error.message });
    }
  };

  return (
    <Flex align="center" gap={3} py={3} borderBottomWidth="1px" borderColor="gray.100">
      <Avatar size="sm" name={member.name || member.email} getInitials={() => initials(member.name || member.email)} />
      <Box flex="1" minW={0}>
        <HStack spacing={2}>
          <Text fontSize="sm" fontWeight="500" noOfLines={1}>
            {member.name || member.email || 'Pending user'}
          </Text>
          {member.role !== 'student' && <Badge colorScheme="yellow">{member.role}</Badge>}
          {member.status === 'pending' && <Badge colorScheme="orange">Requested</Badge>}
          {member.status === 'invited' && <Badge colorScheme="cyan">Invited</Badge>}
          {member.muted && <Badge colorScheme="red">Muted</Badge>}
        </HStack>
        <Text fontSize="xs" color="gray.500" noOfLines={1}>
          {member.email}
          {member.rollNumber ? ` · ${member.rollNumber}` : ''}
          {member.lastSeenAt ? ` · active ${relativeTime(member.lastSeenAt)}` : ''}
        </Text>
      </Box>

      {member.status === 'pending' && isTeacher && (
        <HStack>
          <Button
            size="xs"
            colorScheme="green"
            onClick={() => act(() => lmApi.decideJoinRequest(classId, member._id, true), 'Approved')}
          >
            Approve
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() => act(() => lmApi.decideJoinRequest(classId, member._id, false), 'Declined')}
          >
            Decline
          </Button>
        </HStack>
      )}

      {isTeacher && member.status === 'active' && (
        <Menu>
          <MenuButton as={Button} size="xs" variant="ghost">
            ⋮
          </MenuButton>
          <MenuList>
            {member.role === 'student' && (
              <MenuItem onClick={() => onViewProgress(member)}>View progress</MenuItem>
            )}
            {member.role === 'student' && (
              <MenuItem onClick={() => act(() => lmApi.updateMember(classId, member._id, { role: 'co-teacher' }), 'Promoted to co-teacher')}>
                Make co-teacher
              </MenuItem>
            )}
            {member.role === 'co-teacher' && (
              <MenuItem onClick={() => act(() => lmApi.updateMember(classId, member._id, { role: 'student' }), 'Changed to student')}>
                Make student
              </MenuItem>
            )}
            <MenuItem onClick={() => act(() => lmApi.updateMember(classId, member._id, { muted: !member.muted }), member.muted ? 'Unmuted' : 'Muted')}>
              {member.muted ? 'Allow posting' : 'Mute (no posts or comments)'}
            </MenuItem>
            {isOwner && member.role !== 'teacher' && (
              <>
                <MenuDivider />
                <MenuItem
                  onClick={() => {
                    // eslint-disable-next-line no-alert
                    if (window.confirm(`Transfer ownership of this class to ${member.name}?`)) {
                      act(() => lmApi.transferOwnership(classId, member._id), 'Ownership transferred');
                    }
                  }}
                >
                  Transfer ownership
                </MenuItem>
              </>
            )}
            <MenuDivider />
            <MenuItem
              color="red.600"
              onClick={() => {
                // eslint-disable-next-line no-alert
                if (window.confirm(`Remove ${member.name || member.email} from the class?`)) {
                  act(() => lmApi.removeMember(classId, member._id), 'Removed');
                }
              }}
            >
              Remove from class
            </MenuItem>
          </MenuList>
        </Menu>
      )}
    </Flex>
  );
}

export default function People() {
  const { classId, klass, isTeacher, reloadClass } = useOutletContext();
  const [members, setMembers] = useState({ teachers: [], students: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [progressFor, setProgressFor] = useState(null);
  const invite = useDisclosure();
  const progress = useDisclosure();

  const load = useCallback(async () => {
    setError(null);
    try {
      setMembers(await lmApi.listMembers(classId));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId]);

  useEffect(() => {
    load();
  }, [load]);

  const afterChange = async () => {
    await load();
    reloadClass();
  };

  const openProgress = (member) => {
    setProgressFor(member);
    progress.onOpen();
  };

  if (loading) return <Loading label="Loading people…" />;

  const pending = members.students.filter((m) => m.status === 'pending');

  return (
    <Box>
      <ErrorState error={error} onRetry={load} />

      {pending.length > 0 && isTeacher && (
        <Box mb={4}>
          <SectionCard title={`${pending.length} join request${pending.length === 1 ? '' : 's'}`}>
            {pending.map((member) => (
              <PersonRow
                key={member._id}
                member={member}
                isTeacher={isTeacher}
                isOwner={klass.isOwner}
                classId={classId}
                onChanged={afterChange}
                onViewProgress={openProgress}
              />
            ))}
          </SectionCard>
        </Box>
      )}

      <SectionCard
        title={`Teachers (${members.teachers.length})`}
        action={
          isTeacher ? (
            <Button size="sm" variant="outline" onClick={invite.onOpen}>
              + Invite
            </Button>
          ) : null
        }
        mb={4}
      >
        {members.teachers.map((member) => (
          <PersonRow
            key={member._id}
            member={member}
            isTeacher={isTeacher}
            isOwner={klass.isOwner}
            classId={classId}
            onChanged={afterChange}
            onViewProgress={openProgress}
          />
        ))}
      </SectionCard>

      <SectionCard title={`Students (${members.students.filter((m) => m.status !== 'pending').length})`}>
        {members.students.filter((m) => m.status !== 'pending').length === 0 ? (
          <EmptyState
            icon="👥"
            title="No students yet"
            description={
              isTeacher
                ? `Share the class code "${klass.code}" or invite students by email.`
                : 'The roster is empty.'
            }
            action={
              isTeacher ? (
                <Button size="sm" colorScheme="blue" onClick={invite.onOpen}>
                  Invite students
                </Button>
              ) : null
            }
          />
        ) : (
          members.students
            .filter((m) => m.status !== 'pending')
            .map((member) => (
              <PersonRow
                key={member._id}
                member={member}
                isTeacher={isTeacher}
                isOwner={klass.isOwner}
                classId={classId}
                onChanged={afterChange}
                onViewProgress={openProgress}
              />
            ))
        )}
      </SectionCard>

      {!isTeacher && (
        <Box mt={4}>
          <Text fontSize="xs" color="gray.500">
            Joined {formatDate(klass.created_at)} · taught by {klass.ownerName}
          </Text>
        </Box>
      )}

      <InviteModal isOpen={invite.isOpen} onClose={invite.onClose} classId={classId} onDone={afterChange} />
      <ProgressModal
        isOpen={progress.isOpen}
        onClose={progress.onClose}
        classId={classId}
        membership={progressFor}
      />
    </Box>
  );
}
