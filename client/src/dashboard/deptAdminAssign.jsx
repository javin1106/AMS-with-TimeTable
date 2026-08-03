import React, { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Container,
  Flex,
  FormControl,
  FormLabel,
  Heading,
  Icon,
  IconButton,
  Input,
  Menu,
  MenuButton,
  MenuItemOption,
  MenuList,
  MenuOptionGroup,
  Select,
  Spinner,
  Table,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
  useColorModeValue,
  useToast,
} from '@chakra-ui/react';
import { FiArrowLeft, FiShield, FiTrash2, FiUserPlus } from 'react-icons/fi';
import { useNavigate } from 'react-router-dom';
import getEnvironment from '../getenvironment';

const apiUrl = getEnvironment();

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

const DeptAdminAssignPage = () => {
  const [email, setEmail] = useState('');
  const [dept, setDept] = useState('');
  const [departments, setDepartments] = useState([]);
  const [admins, setAdmins] = useState([]);
  const [departmentDrafts, setDepartmentDrafts] = useState({});
  const [loadingAdmins, setLoadingAdmins] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [savingAccess, setSavingAccess] = useState(null);
  const toast = useToast();
  const navigate = useNavigate();
  const goBack = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate('/attendance');
  };

  const cardBg = useColorModeValue('white', 'gray.800');
  const border = useColorModeValue('gray.200', 'gray.700');
  const pageBg = useColorModeValue('gray.50', 'gray.900');
  const subColor = useColorModeValue('gray.600', 'gray.400');
  const iconBg = useColorModeValue('cyan.50', 'cyan.900');
  const iconColor = useColorModeValue('cyan.600', 'cyan.300');

  const fetchAdmins = async () => {
    setLoadingAdmins(true);
    try {
      const res = await fetch(`${apiUrl}/user/getuser/dept-admins`, {
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load department admins');
      const users = data.users || [];
      setAdmins(users);
      setDepartmentDrafts(
        Object.fromEntries(users.map((user) => [user._id, assignedDepartments(user)])),
      );
    } catch (err) {
      toast({ title: 'Could not load department admins', description: err.message, status: 'error', duration: 5000, isClosable: true });
    } finally {
      setLoadingAdmins(false);
    }
  };

  useEffect(() => {
    fetchAdmins();
    (async () => {
      try {
        const res = await fetch(`${apiUrl}/timetablemodule/timetable/sess/allsessanddept`, {
          credentials: 'include',
        });
        if (!res.ok) throw new Error('Failed to load departments');
        const data = await res.json();
        const unique = Array.from(
          new Set((data.uniqueDept || []).map((d) => d?.trim()).filter(Boolean)),
        ).sort((a, b) => a.localeCompare(b));
        setDepartments(unique);
      } catch (err) {
        toast({ title: 'Could not load departments', description: err.message, status: 'error', duration: 5000, isClosable: true });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAssign = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch(`${apiUrl}/user/getuser/assign-dept-admin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: email.trim(), dept }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || 'Failed to assign role');
      toast({
        title: data.created ? 'User created and role assigned' : 'Role assigned',
        description: `${email.trim()} is now iLEED Department Admin for ${data.user?.dept || dept}.`,
        status: 'success',
        duration: 5000,
        isClosable: true,
      });
      setEmail('');
      setDept('');
      fetchAdmins();
    } catch (err) {
      toast({ title: 'Assignment failed', description: err.message, status: 'error', duration: 6000, isClosable: true });
    } finally {
      setSubmitting(false);
    }
  };

  const setAccessDraft = (user, values) => {
    setDepartmentDrafts((current) => ({
      ...current,
      [user._id]: uniqueDepartments([
        user.dept,
        ...(Array.isArray(values) ? values : [values]),
      ]),
    }));
  };

  const handleSaveAccess = async (user) => {
    const attendanceDepartments = uniqueDepartments([
      user.dept,
      ...(departmentDrafts[user._id] || assignedDepartments(user)),
    ]);
    setSavingAccess(user._id);
    try {
      const res = await fetch(`${apiUrl}/user/getuser/department`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          userId: user._id,
          dept: user.dept || '',
          attendanceDepartments,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || 'Failed to update access');
      setAdmins((current) =>
        current.map((admin) => (admin._id === user._id ? data.user : admin)));
      setDepartmentDrafts((current) => ({
        ...current,
        [user._id]: assignedDepartments(data.user),
      }));
      toast({
        title: 'GT / Roll department access updated',
        status: 'success',
        duration: 4000,
        isClosable: true,
      });
    } catch (err) {
      toast({
        title: 'Could not update department access',
        description: err.message,
        status: 'error',
        duration: 6000,
        isClosable: true,
      });
    } finally {
      setSavingAccess(null);
    }
  };

  const handleRemove = async (user) => {
    setRemoving(user._id);
    try {
      const res = await fetch(`${apiUrl}/user/getuser/remove-dept-admin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userId: user._id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to remove role');
      toast({ title: 'Role removed', status: 'success', duration: 4000, isClosable: true });
      fetchAdmins();
    } catch (err) {
      toast({ title: 'Could not remove role', description: err.message, status: 'error', duration: 6000, isClosable: true });
    } finally {
      setRemoving(null);
    }
  };

  return (
    <Box bg={pageBg} minH="100vh" py={{ base: 8, md: 14 }}>
      <Container maxW="6xl">
        <Flex align="center" gap={4} mb={{ base: 6, md: 10 }} flexWrap="wrap">
          <Flex align="center" justify="center" boxSize={12} borderRadius="lg" bg={iconBg} color={iconColor}>
            <Icon as={FiShield} boxSize={6} />
          </Flex>
          <Box>
            <Heading as="h1" size="lg">
              iLEED Department Admins
            </Heading>
            <Text color={subColor}>
              Assign the role and control which departments appear in Ground Truth and Roll Assignment.
            </Text>
          </Box>
          <Button
            leftIcon={<FiArrowLeft />}
            variant="outline"
            size="sm"
            ml="auto"
            onClick={goBack}
          >
            Back
          </Button>
        </Flex>

        <Box as="form" onSubmit={handleAssign} bg={cardBg} borderWidth="1px" borderColor={border} borderRadius="xl" p={6} mb={8}>
          <Flex gap={4} direction={{ base: 'column', md: 'row' }} align={{ md: 'flex-end' }}>
            <FormControl isRequired>
              <FormLabel>Email ID</FormLabel>
              <Input
                type="email"
                placeholder="faculty@nitj.ac.in"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </FormControl>
            <FormControl isRequired>
              <FormLabel>Department</FormLabel>
              <Select value={dept} onChange={(e) => setDept(e.target.value)} placeholder="Select department">
                {departments.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            </FormControl>
            <Button
              type="submit"
              colorScheme="cyan"
              leftIcon={<FiUserPlus />}
              isLoading={submitting}
              px={8}
              flexShrink={0}
            >
              Assign
            </Button>
          </Flex>
        </Box>

        <Box bg={cardBg} borderWidth="1px" borderColor={border} borderRadius="xl" p={6}>
          <Heading as="h2" size="md" mb={4}>
            Current Department Admins
          </Heading>
          {loadingAdmins ? (
            <Flex justify="center" py={8}>
              <Spinner />
            </Flex>
          ) : admins.length === 0 ? (
            <Text color={subColor}>No iLEED Department Admins assigned yet.</Text>
          ) : (
            <Box overflowX="auto">
              <Table size="md" variant="simple">
                <Thead>
                  <Tr>
                    <Th>Email</Th>
                    <Th>Primary Department</Th>
                    <Th minW="260px">GT / Roll Departments</Th>
                    <Th width="1%">Remove</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {admins.map((user) => (
                    <Tr key={user._id}>
                      <Td>{Array.isArray(user.email) ? user.email.join(', ') : user.email}</Td>
                      <Td>{user.dept || '—'}</Td>
                      <Td>
                        <Flex gap={2} align="center">
                          <Menu closeOnSelect={false}>
                            <MenuButton
                              as={Button}
                              size="sm"
                              variant="outline"
                              minW="170px"
                              textAlign="left"
                            >
                              {(departmentDrafts[user._id] || assignedDepartments(user)).length}
                              {' '}department(s)
                            </MenuButton>
                            <MenuList maxH="280px" overflowY="auto">
                              <MenuOptionGroup
                                type="checkbox"
                                value={departmentDrafts[user._id] || assignedDepartments(user)}
                                onChange={(values) => setAccessDraft(user, values)}
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
                            colorScheme="cyan"
                            variant="outline"
                            isLoading={savingAccess === user._id}
                            isDisabled={sameDepartments(
                              departmentDrafts[user._id] || assignedDepartments(user),
                              assignedDepartments(user),
                            )}
                            onClick={() => handleSaveAccess(user)}
                          >
                            Save
                          </Button>
                        </Flex>
                      </Td>
                      <Td>
                        <IconButton
                          aria-label="Remove department admin role"
                          icon={<FiTrash2 />}
                          size="sm"
                          colorScheme="red"
                          variant="ghost"
                          isLoading={removing === user._id}
                          onClick={() => handleRemove(user)}
                        />
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </Box>
          )}
        </Box>
      </Container>
    </Box>
  );
};

export default DeptAdminAssignPage;
