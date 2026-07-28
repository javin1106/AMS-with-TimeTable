import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  Badge,
  Box,
  Button,
  Container,
  Flex,
  Heading,
  Icon,
  IconButton,
  Input,
  InputGroup,
  InputLeftElement,
  Menu,
  MenuButton,
  MenuItemOption,
  MenuList,
  MenuOptionGroup,
  Select,
  Spinner,
  Table,
  Tag,
  TagCloseButton,
  TagLabel,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
  useColorModeValue,
  useDisclosure,
  useToast,
  Wrap,
  WrapItem,
} from '@chakra-ui/react';
import { FiArrowLeft, FiSearch, FiUserPlus, FiUsers } from 'react-icons/fi';
import getEnvironment from '../getenvironment';

const apiUrl = getEnvironment();

const ROLE_OPTIONS = [
  { value: 'admin', label: 'Admin' },
  { value: 'ITTC', label: 'Institute Time Table Coordinator' },
  { value: 'DTTI', label: 'Department Time Table Coordinator' },
  { value: 'CM', label: 'Certificate Manager' },
  { value: 'EO', label: 'Event Organiser' },
  { value: 'editor', label: 'Editor' },
  { value: 'PRM', label: 'PRM' },
  { value: 'FACULTY', label: 'Faculty' },
  { value: 'doctor', label: 'Doctor' },
  { value: 'patient', label: 'Patient' },
  { value: 'dm-admin', label: 'Diabetics Module Admin' },
  { value: 'iams-admin', label: 'iLEED Admin' },
  { value: 'iams-dept-admin', label: 'iLEED Department Admin' },
];

const userEmails = (user) =>
  (Array.isArray(user.email) ? user.email : [user.email]).filter(Boolean).map(String);

const userEmail = (user) => userEmails(user).join(', ');

const departmentKey = (value) =>
  String(value || '').trim().replace(/[\s_-]+/g, '').toUpperCase();

const uniqueDepartments = (values) => {
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter((value) => {
      const key = departmentKey(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

const assignedDepartments = (user) =>
  uniqueDepartments([user.dept, ...(user.attendanceDepartments || [])]);

const sameDepartments = (left, right) => {
  const leftKeys = uniqueDepartments(left).map(departmentKey).sort();
  const rightKeys = uniqueDepartments(right).map(departmentKey).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]);
};

const UserManagementPage = () => {
  const navigate = useNavigate();
  const toast = useToast();

  const [users, setUsers] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedRoles, setSelectedRoles] = useState({});
  const [assigning, setAssigning] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [departmentDrafts, setDepartmentDrafts] = useState({});
  const [attendanceDepartmentDrafts, setAttendanceDepartmentDrafts] = useState({});
  const [departmentsLoading, setDepartmentsLoading] = useState(true);
  const [savingDepartment, setSavingDepartment] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null); // { userId, role, email }
  const [deleting, setDeleting] = useState(false);
  const { isOpen, onOpen, onClose } = useDisclosure();
  const cancelRef = useRef();

  const pageBg = useColorModeValue('gray.50', 'gray.900');
  const cardBg = useColorModeValue('white', 'gray.800');
  const border = useColorModeValue('gray.200', 'gray.700');
  const subColor = useColorModeValue('gray.600', 'gray.400');
  const headBg = useColorModeValue('gray.50', 'gray.900');
  const iconBg = useColorModeValue('teal.50', 'teal.900');
  const iconColor = useColorModeValue('teal.600', 'teal.300');

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${apiUrl}/user/getuser/all`, {
          credentials: 'include',
        });
        if (!res.ok) throw new Error(`Failed to fetch users: ${res.statusText}`);
        const data = await res.json();
        setUsers(data.user || []);
        setDepartmentDrafts(
          Object.fromEntries((data.user || []).map((u) => [u._id, u.dept || ''])),
        );
        setAttendanceDepartmentDrafts(
          Object.fromEntries(
            (data.user || []).map((u) => [u._id, assignedDepartments(u)]),
          ),
        );
      } catch (err) {
        toast({ title: 'Could not load users', description: err.message, status: 'error', duration: 6000, isClosable: true });
      } finally {
        setIsLoading(false);
      }
    })();

    (async () => {
      try {
        const res = await fetch(
          `${apiUrl}/timetablemodule/timetable/sess/allsessanddept`,
          { credentials: 'include' },
        );
        if (!res.ok) throw new Error('Failed to load departments');
        const data = await res.json();
        const unique = Array.from(
          new Set((data.uniqueDept || []).map((d) => d?.trim()).filter(Boolean)),
        ).sort((a, b) => a.localeCompare(b));
        setDepartments(unique);
      } catch (err) {
        toast({ title: 'Could not load departments', description: err.message, status: 'error', duration: 6000, isClosable: true });
      } finally {
        setDepartmentsLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const roleCounts = useMemo(() => {
    const counts = {};
    for (const u of users) {
      for (const role of u.role || []) {
        counts[role] = (counts[role] || 0) + 1;
      }
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [users]);

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    // A query that exactly names a role filters by role membership, so
    // "admin" doesn't also match iams-admin / dm-admin via substring.
    const isRoleQuery = users.some((u) =>
      (u.role || []).some((r) => r.toLowerCase() === q),
    );
    if (isRoleQuery) {
      return users.filter((u) => (u.role || []).some((r) => r.toLowerCase() === q));
    }
    return users.filter((u) => {
      const haystack = [
        userEmail(u),
        u.dept || '',
        ...assignedDepartments(u),
        ...(u.role || []),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [users, search]);

  const replaceUser = (updated) =>
    setUsers((current) => current.map((u) => (u._id === updated._id ? updated : u)));

  const handleAssignRole = async (user) => {
    const role = selectedRoles[user._id];
    if (!role) return;
    if (user.role.includes(role)) {
      toast({ title: 'Role already assigned', status: 'info', duration: 3000, isClosable: true });
      return;
    }
    setAssigning(user._id);
    try {
      const res = await fetch(`${apiUrl}/user/getuser/assignrole`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userId: user._id, role }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to assign role');
      replaceUser(data.user);
      setSelectedRoles((s) => ({ ...s, [user._id]: '' }));
      toast({ title: `Role "${role}" assigned`, status: 'success', duration: 3000, isClosable: true });
    } catch (err) {
      toast({ title: 'Could not assign role', description: err.message, status: 'error', duration: 6000, isClosable: true });
    } finally {
      setAssigning(null);
    }
  };

  const confirmDeleteRole = (user, role) => {
    setDeleteTarget({ userId: user._id, role, email: userEmail(user) });
    onOpen();
  };

  const handleDeleteRole = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`${apiUrl}/user/getuser/deleterole`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userId: deleteTarget.userId, role: deleteTarget.role }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to remove role');
      replaceUser(data.user);
      toast({ title: `Role "${deleteTarget.role}" removed`, status: 'success', duration: 3000, isClosable: true });
      onClose();
    } catch (err) {
      toast({ title: 'Could not remove role', description: err.message, status: 'error', duration: 6000, isClosable: true });
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  const setPrimaryDepartmentDraft = (userId, department) => {
    setDepartmentDrafts((current) => ({ ...current, [userId]: department }));
    setAttendanceDepartmentDrafts((current) => ({
      ...current,
      [userId]: uniqueDepartments([department, ...(current[userId] || [])]),
    }));
  };

  const setAssignedDepartmentDraft = (user, values) => {
    const primaryDepartment = departmentDrafts[user._id] ?? user.dept ?? '';
    setAttendanceDepartmentDrafts((current) => ({
      ...current,
      [user._id]: uniqueDepartments([
        primaryDepartment,
        ...(Array.isArray(values) ? values : [values]),
      ]),
    }));
  };

  const handleDepartmentUpdate = async (user) => {
    const dept = departmentDrafts[user._id] || '';
    const attendanceDepartments = uniqueDepartments([
      dept,
      ...(attendanceDepartmentDrafts[user._id] || assignedDepartments(user)),
    ]);
    setSavingDepartment(user._id);
    try {
      const res = await fetch(`${apiUrl}/user/getuser/department`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          userId: user._id,
          dept,
          attendanceDepartments,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || 'Failed to update department');
      replaceUser(data.user);
      setDepartmentDrafts((d) => ({ ...d, [user._id]: data.user.dept || '' }));
      setAttendanceDepartmentDrafts((current) => ({
        ...current,
        [user._id]: assignedDepartments(data.user),
      }));
      toast({ title: 'Department access updated', status: 'success', duration: 3000, isClosable: true });
    } catch (err) {
      toast({ title: 'Could not update department', description: err.message, status: 'error', duration: 6000, isClosable: true });
    } finally {
      setSavingDepartment(null);
    }
  };

  return (
    <Box bg={pageBg} minH="100vh" py={{ base: 6, md: 10 }}>
      <Container maxW="6xl">
        {/* Header */}
        <Flex
          align={{ base: 'flex-start', md: 'center' }}
          justify="space-between"
          direction={{ base: 'column', md: 'row' }}
          gap={4}
          mb={8}
        >
          <Flex align="center" gap={4}>
            <IconButton
              aria-label="Go back"
              icon={<FiArrowLeft />}
              variant="ghost"
              onClick={() => navigate(-1)}
            />
            <Flex align="center" justify="center" boxSize={12} borderRadius="lg" bg={iconBg} color={iconColor}>
              <Icon as={FiUsers} boxSize={6} />
            </Flex>
            <Box>
              <Heading as="h1" size="lg">
                User Management
              </Heading>
              <Text color={subColor} fontSize="sm">
                {users.length} user{users.length === 1 ? '' : 's'} — manage roles and departments
              </Text>
            </Box>
          </Flex>
          <Button
            colorScheme="teal"
            leftIcon={<FiUserPlus />}
            onClick={() => navigate('/register')}
            flexShrink={0}
          >
            Create New User
          </Button>
        </Flex>

        {/* Role-wise counts */}
        {roleCounts.length > 0 && (
          <Wrap spacing={2} mb={6}>
            {roleCounts.map(([role, count]) => (
              <WrapItem key={role}>
                <Tag
                  size="md"
                  variant={search.trim().toLowerCase() === role.toLowerCase() ? 'solid' : 'subtle'}
                  colorScheme="teal"
                  borderRadius="full"
                  cursor="pointer"
                  title={`Show users with the ${role} role`}
                  onClick={() =>
                    setSearch((current) =>
                      current.trim().toLowerCase() === role.toLowerCase() ? '' : role,
                    )
                  }
                >
                  <TagLabel>{role}</TagLabel>
                  <Badge ml={2} borderRadius="full" px={2} colorScheme="teal" variant="solid">
                    {count}
                  </Badge>
                </Tag>
              </WrapItem>
            ))}
          </Wrap>
        )}

        {/* Search */}
        <InputGroup mb={6} maxW="md">
          <InputLeftElement pointerEvents="none">
            <Icon as={FiSearch} color={subColor} />
          </InputLeftElement>
          <Input
            placeholder="Search by email, role or department…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            bg={cardBg}
          />
        </InputGroup>

        {/* Table */}
        <Box bg={cardBg} borderWidth="1px" borderColor={border} borderRadius="xl" overflow="hidden">
          {isLoading ? (
            <Flex justify="center" py={16}>
              <Spinner size="lg" />
            </Flex>
          ) : filteredUsers.length === 0 ? (
            <Text color={subColor} textAlign="center" py={16}>
              {search ? 'No users match your search.' : 'No users found.'}
            </Text>
          ) : (
            <Box overflowX="auto">
              <Table size="md" variant="simple">
                <Thead bg={headBg}>
                  <Tr>
                    <Th>Email</Th>
                    <Th minW="300px">Department Access</Th>
                    <Th>Roles</Th>
                    <Th minW="260px">Add Role</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {filteredUsers.map((user) => (
                    <Tr key={user._id}>
                      <Td wordBreak="break-all">
                        <Flex align="flex-start" gap={2}>
                          <Box>
                            {userEmails(user).map((address) => (
                              <Text key={address} fontWeight="500">
                                {address}
                              </Text>
                            ))}
                          </Box>
                          <Badge
                            colorScheme={userEmails(user).length > 1 ? 'purple' : 'gray'}
                            borderRadius="full"
                            px={2}
                            flexShrink={0}
                            title={`${userEmails(user).length} email address(es) attached to this account`}
                          >
                            {userEmails(user).length}
                          </Badge>
                        </Flex>
                      </Td>
                      <Td>
                        <Flex direction="column" align="stretch" gap={2}>
                          <Text fontSize="xs" color={subColor} fontWeight="600">
                            Primary dashboard department
                          </Text>
                          <Select
                            size="sm"
                            value={departmentDrafts[user._id] ?? user.dept ?? ''}
                            onChange={(e) => setPrimaryDepartmentDraft(user._id, e.target.value)}
                            isDisabled={departmentsLoading}
                          >
                            <option value="">No department</option>
                            {user.dept &&
                              !departments.some(
                                (d) => d.toLowerCase() === user.dept.toLowerCase(),
                              ) && <option value={user.dept}>{user.dept}</option>}
                            {departments.map((d) => (
                              <option key={d} value={d}>
                                {d}
                              </option>
                            ))}
                          </Select>
                          <Text fontSize="xs" color={subColor} fontWeight="600" mt={1}>
                            Ground Truth + Roll Assignment
                          </Text>
                          <Menu closeOnSelect={false}>
                            <MenuButton
                              as={Button}
                              size="sm"
                              variant="outline"
                              textAlign="left"
                              fontWeight="normal"
                              isDisabled={departmentsLoading}
                            >
                              {(attendanceDepartmentDrafts[user._id]
                                || assignedDepartments(user)).length
                                ? `${(attendanceDepartmentDrafts[user._id]
                                  || assignedDepartments(user)).length} department(s) selected`
                                : 'No departments selected'}
                            </MenuButton>
                            <MenuList maxH="280px" overflowY="auto">
                              <MenuOptionGroup
                                type="checkbox"
                                value={attendanceDepartmentDrafts[user._id]
                                  || assignedDepartments(user)}
                                onChange={(values) => setAssignedDepartmentDraft(user, values)}
                              >
                                {uniqueDepartments([
                                  ...departments,
                                  ...assignedDepartments(user),
                                ]).map((department) => (
                                  <MenuItemOption key={department} value={department}>
                                    {department}
                                  </MenuItemOption>
                                ))}
                              </MenuOptionGroup>
                            </MenuList>
                          </Menu>
                          <Button
                            size="sm"
                            variant="outline"
                            colorScheme="teal"
                            isLoading={savingDepartment === user._id}
                            isDisabled={
                              departmentsLoading ||
                              (
                                (departmentDrafts[user._id] ?? user.dept ?? '') ===
                                  (user.dept || '')
                                && sameDepartments(
                                  attendanceDepartmentDrafts[user._id]
                                    || assignedDepartments(user),
                                  assignedDepartments(user),
                                )
                              )
                            }
                            onClick={() => handleDepartmentUpdate(user)}
                          >
                            Save
                          </Button>
                        </Flex>
                      </Td>
                      <Td>
                        {user.role?.length ? (
                          <Wrap spacing={2}>
                            {user.role.map((role) => (
                              <WrapItem key={role}>
                                <Tag size="md" colorScheme="teal" variant="subtle" borderRadius="full">
                                  <TagLabel>{role}</TagLabel>
                                  <TagCloseButton
                                    aria-label={`Remove role ${role}`}
                                    onClick={() => confirmDeleteRole(user, role)}
                                  />
                                </Tag>
                              </WrapItem>
                            ))}
                          </Wrap>
                        ) : (
                          <Text fontSize="sm" color={subColor}>
                            No roles
                          </Text>
                        )}
                      </Td>
                      <Td>
                        <Flex align="center" gap={2}>
                          <Select
                            size="sm"
                            minW="170px"
                            placeholder="Select role"
                            value={selectedRoles[user._id] || ''}
                            onChange={(e) =>
                              setSelectedRoles((s) => ({ ...s, [user._id]: e.target.value }))
                            }
                          >
                            {ROLE_OPTIONS.filter((r) => !user.role?.includes(r.value)).map((r) => (
                              <option key={r.value} value={r.value}>
                                {r.label}
                              </option>
                            ))}
                          </Select>
                          <Button
                            size="sm"
                            colorScheme="blue"
                            isDisabled={!selectedRoles[user._id]}
                            isLoading={assigning === user._id}
                            onClick={() => handleAssignRole(user)}
                          >
                            Assign
                          </Button>
                        </Flex>
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </Box>
          )}
        </Box>
      </Container>

      {/* Delete role confirmation */}
      <AlertDialog isOpen={isOpen} leastDestructiveRef={cancelRef} onClose={onClose} isCentered>
        <AlertDialogOverlay>
          <AlertDialogContent>
            <AlertDialogHeader fontSize="lg" fontWeight="bold">
              Remove Role
            </AlertDialogHeader>
            <AlertDialogBody>
              Remove the role <strong>{deleteTarget?.role}</strong> from{' '}
              <strong>{deleteTarget?.email}</strong>?
            </AlertDialogBody>
            <AlertDialogFooter>
              <Button ref={cancelRef} onClick={onClose}>
                Cancel
              </Button>
              <Button colorScheme="red" onClick={handleDeleteRole} isLoading={deleting} ml={3}>
                Remove
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogOverlay>
      </AlertDialog>
    </Box>
  );
};

export default UserManagementPage;
