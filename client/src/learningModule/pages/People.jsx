import React, { useCallback, useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import {
  Avatar,
  Badge,
  Box,
  Button,
  Checkbox,
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
import { EmptyState, ErrorState, Loading, SectionCard, buttonTextStyles } from '../components/common';
import { formatDate, initials, relativeTime } from '../format';

function InviteModal({ isOpen, onClose, classId, onDone }) {
  const [emails, setEmails] = useState('');
  const [role, setRole] = useState('student');
  const [createAccounts, setCreateAccounts] = useState(true);
  const [grantRoleToExisting, setGrantRoleToExisting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState(null);
  const toast = useToast();

  const platformRole = role === 'co-teacher' ? 'FACULTY' : 'STUDENT';

  const submit = async () => {
    const list = emails
      .split(/[\s,;]+/)
      .map((e) => e.trim())
      .filter(Boolean);
    if (!list.length) return;

    setBusy(true);
    setReport(null);
    try {
      const result = await lmApi.inviteMembers(classId, list, role, {
        createAccounts,
        grantRoleToExisting,
      });
      const count = (status) => result.results.filter((r) => r.status === status).length;
      const failures = result.results.filter((r) => r.status === 'error');
      // `mailed === false` means the person was enrolled but the invitation
      // email did not leave — worth saying out loud rather than reporting a
      // clean success.
      const unmailed = result.results.filter((r) => r.mailed === false);

      toast({
        status: failures.length || unmailed.length ? 'warning' : 'success',
        title: 'Invites processed',
        description: [
          count('account_created') && `${count('account_created')} account(s) created`,
          count('added') && `${count('added')} enrolled`,
          count('invited') && `${count('invited')} invited by email`,
          count('already_member') && `${count('already_member')} already in the class`,
          failures.length && `${failures.length} failed`,
          unmailed.length && `${unmailed.length} enrolled but the email could not be sent`,
        ]
          .filter(Boolean)
          .join(', '),
        duration: 8000,
      });

      setReport(result.results);
      if (!failures.length && !unmailed.length) {
        setEmails('');
        onDone();
        onClose();
        return;
      }
      // Keep the dialog open when something failed so the teacher can see which.
      onDone();
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
            <FormHelperText>Separate with commas, spaces or new lines.</FormHelperText>
          </FormControl>

          <Box mt={5} p={4} borderWidth="1px" borderColor="gray.200" borderRadius="md" bg="gray.50">
            <Checkbox
              isChecked={createAccounts}
              onChange={(event) => setCreateAccounts(event.target.checked)}
            >
              <Text fontSize="sm" fontWeight="600">
                Create XCEED accounts for addresses that don&apos;t have one
              </Text>
            </Checkbox>
            <Text fontSize="xs" color="gray.600" mt={2} ml={6}>
              {createAccounts ? (
                <>
                  Each new person gets an account with the <Badge colorScheme="cyan">{platformRole}</Badge>{' '}
                  role and is enrolled straight away. They receive an email inviting them to set their own
                  password — no password is ever emailed, and the account cannot be signed into until they
                  do.
                </>
              ) : (
                <>
                  Addresses without an account are stored as pending invites and enrolled automatically the
                  first time that person signs in to XCEED.
                </>
              )}
            </Text>

            <Checkbox
              mt={3}
              size="sm"
              isChecked={grantRoleToExisting}
              onChange={(event) => setGrantRoleToExisting(event.target.checked)}
            >
              Also give the {platformRole} role to people who already have an account without it
            </Checkbox>
            <Text fontSize="xs" color="gray.500" mt={1} ml={6}>
              Off by default — changing an existing user&apos;s platform roles is usually an
              administrator&apos;s decision.
            </Text>
          </Box>

          {report && (
            <Box mt={4}>
              <Text fontSize="sm" fontWeight="600" mb={1}>
                Result
              </Text>
              {report.map((entry) => (
                <Flex key={entry.email} fontSize="xs" justify="space-between" py={1} gap={2}>
                  <Text noOfLines={1}>{entry.email}</Text>
                  <HStack spacing={1}>
                    <Badge
                      colorScheme={
                        entry.status === 'error'
                          ? 'red'
                          : entry.status === 'already_member'
                            ? 'gray'
                            : 'green'
                      }
                    >
                      {entry.status === 'account_created'
                        ? `account created (${entry.platformRole})`
                        : entry.status === 'error'
                          ? entry.message || 'failed'
                          : entry.status.replace(/_/g, ' ')}
                    </Badge>
                    {entry.mailed === false && <Badge colorScheme="orange">email failed</Badge>}
                  </HStack>
                </Flex>
              ))}
            </Box>
          )}
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
              <MenuItem {...buttonTextStyles} onClick={() => onViewProgress(member)}>
                View progress
              </MenuItem>
            )}
            {member.role === 'student' && (
              <MenuItem {...buttonTextStyles} onClick={() => act(() => lmApi.updateMember(classId, member._id, { role: 'co-teacher' }), 'Promoted to co-teacher')}>
                Make co-teacher
              </MenuItem>
            )}
            {member.role === 'co-teacher' && (
              <MenuItem {...buttonTextStyles} onClick={() => act(() => lmApi.updateMember(classId, member._id, { role: 'student' }), 'Changed to student')}>
                Make student
              </MenuItem>
            )}
            <MenuItem {...buttonTextStyles} onClick={() => act(() => lmApi.updateMember(classId, member._id, { muted: !member.muted }), member.muted ? 'Unmuted' : 'Muted')}>
              {member.muted ? 'Allow posting' : 'Mute (no posts or comments)'}
            </MenuItem>
            {isOwner && member.role !== 'teacher' && (
              <>
                <MenuDivider />
                <MenuItem
                  {...buttonTextStyles}
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
