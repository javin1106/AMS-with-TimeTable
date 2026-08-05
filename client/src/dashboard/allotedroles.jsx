import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Container,
  Flex,
  Heading,
  Icon,
  SimpleGrid,
  Spinner,
  Text,
  useColorModeValue,
} from '@chakra-ui/react';
import {
  FiAward,
  FiBookOpen,
  FiCalendar,
  FiMic,
  FiShield,
  FiUser,
  FiUserCheck,
} from 'react-icons/fi';
import getEnvironment from '../getenvironment';

const apiUrl = getEnvironment();

const ROLE_META = {
  ITTC: {
    name: 'Institute Time Table Coordinator',
    link: '/tt/admin',
    description: 'Manage institute-wide timetables',
    icon: FiCalendar,
    accent: 'blue',
  },
  DTTI: {
    name: 'Department Time Table Coordinator',
    link: '/tt/dashboard',
    description: 'Manage department timetables',
    icon: FiCalendar,
    accent: 'blue',
  },
  CM: {
    name: 'Event Certificate Manager',
    link: '/cm/dashboard',
    description: 'Create and manage certificates',
    icon: FiAward,
    accent: 'green',
  },
  admin: {
    name: 'XCEED Super User',
    link: '/superadmin',
    description: 'Full system administration',
    icon: FiShield,
    accent: 'red',
  },
  EO: {
    name: 'Event Organiser',
    link: '/cf/dashboard',
    description: 'Organize and manage events',
    icon: FiMic,
    accent: 'purple',
  },
  FACULTY: {
    name: 'Faculty',
    link: '/learning',
    description: 'Your classes and coursework',
    icon: FiUser,
    accent: 'orange',
  },
  'iams-admin': {
    name: 'iLEED Admin',
    link: '/iams-admin',
    description: 'Manage face recognition attendance system',
    icon: FiUserCheck,
    accent: 'cyan',
  },
  'iams-dept-admin': {
    name: 'iLEED Department Admin',
    link: '/dept-admin/dashboard',
    description: 'Department-level attendance management',
    icon: FiUserCheck,
    accent: 'cyan',
  },
  STUDENT: {
    name: 'Student',
    link: '/learning',
    description: 'Your classes, coursework and tutorials',
    icon: FiBookOpen,
    accent: 'teal',
  },
  'lm-admin': {
    name: 'Learning Module Admin',
    link: '/learning/lm-admin',
    description: 'Bug reports, feedback and usage stats for the Learning module',
    icon: FiShield,
    accent: 'purple',
  },
  // Synthetic entries: not platform roles, but the standing a user holds
  // inside the Learning module. Appended only when they actually have classes,
  // so they never displace a real role or the single-role auto-redirect.
  'learning-teacher': {
    name: 'Learning — Teacher',
    link: '/learning',
    description: 'Classes you teach',
    icon: FiBookOpen,
    accent: 'teal',
  },
  'learning-student': {
    name: 'Learning — Student',
    link: '/learning',
    description: 'Classes you are enrolled in',
    icon: FiBookOpen,
    accent: 'teal',
  },
};

const roleMeta = (role) =>
  ROLE_META[role] || {
    name: role,
    link: '#',
    description: 'Access your dashboard',
    icon: FiUser,
    accent: 'gray',
  };

const singleRoleTarget = (role, user) => {
  if (user?.name?.toLowerCase() === 'coe@nitj.ac.in') return '/tt/coe/facultyload';
  return roleMeta(role).link;
};

const RoleItem = ({ role, index, onOpen, descriptionOverride }) => {
  const meta = roleMeta(role);
  const { name, accent } = meta;
  const description = descriptionOverride || meta.description;
  const cardBg = useColorModeValue(`${accent}.50`, `${accent}.900`);
  const cardBorder = useColorModeValue(`${accent}.100`, `${accent}.700`);
  const hoverBg = useColorModeValue(`${accent}.100`, `${accent}.800`);
  const hoverBorder = useColorModeValue(`${accent}.400`, `${accent}.500`);
  const descColor = useColorModeValue('gray.600', 'gray.300');
  const nameColor = useColorModeValue('gray.800', 'white');
  const numColor = useColorModeValue(`${accent}.500`, `${accent}.300`);

  return (
    <Flex
      as="button"
      onClick={onOpen}
      role="group"
      direction="column"
      textAlign="left"
      h="full"
      bg={cardBg}
      borderWidth="1px"
      borderColor={cardBorder}
      borderRadius="2xl"
      p={{ base: 5, md: 6 }}
      transition="all 0.2s ease"
      _hover={{
        bg: hoverBg,
        borderColor: hoverBorder,
        transform: 'translateY(-4px)',
        boxShadow: 'lg',
      }}
      _focusVisible={{ boxShadow: 'outline' }}
    >
      <Flex align="center" justify="space-between" w="full" mb={{ base: 4, md: 5 }}>
        <Text
          fontSize={{ base: '3xl', md: '4xl' }}
          fontWeight="extrabold"
          fontFamily="mono"
          lineHeight="1"
          color={numColor}
        >
          {String(index + 1).padStart(2, '0')}
        </Text>
        <Box
          as="span"
          aria-hidden="true"
          fontSize={{ base: '2xl', md: '3xl' }}
          lineHeight="1"
          color={numColor}
          opacity={0}
          transform="translateX(-10px)"
          transition="all 0.2s ease"
          _groupHover={{ opacity: 1, transform: 'translateX(0)' }}
        >
          &rarr;
        </Box>
      </Flex>
      <Heading
        as="h3"
        fontSize={{ base: 'lg', md: 'xl' }}
        lineHeight="1.3"
        mb={2}
        color={nameColor}
      >
        {name}
      </Heading>
      <Text fontSize={{ base: 'sm', md: 'md' }} color={descColor} lineHeight="1.5">
        {description}
      </Text>
    </Flex>
  );
};

const AllocatedRolesPage = () => {
  const navigate = useNavigate();
  const [allocatedRoles, setAllocatedRoles] = useState([]);
  const [learningCards, setLearningCards] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [user, setUser] = useState(null);

  const pageBg = useColorModeValue('gray.50', 'gray.900');
  const subColor = useColorModeValue('gray.500', 'gray.400');
  const emptyCardBg = useColorModeValue('white', 'gray.800');
  const emptyCardBorder = useColorModeValue('gray.100', 'gray.700');
  const labelColor = useColorModeValue('gray.400', 'gray.500');
  const emptyIconBg = useColorModeValue('gray.100', 'gray.700');

  useEffect(() => {
    (async () => {
      try {
        const response = await fetch(`${apiUrl}/user/getuser`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
        });
        if (!response.ok) throw new Error('Failed to fetch allocated roles');
        const userdetails = await response.json();
        // The paper-review and diabetics modules are gone, but the roles they
        // issued still sit on existing user records — hide them rather than
        // offering a card that leads to a route that no longer exists.
        // Matched case-insensitively: 'editor' was stored with either casing.
        const excludedRoles = [
          'reviewer',
          'author',
          'editor',
          'prm',
          'doctor',
          'patient',
          'dm-admin',
        ];
        const platformRoles = (userdetails.user.role || []).filter(
          (role) => !excludedRoles.includes(String(role).toLowerCase()),
        );
        setAllocatedRoles(platformRoles);
        setUser(userdetails.user);

        // Learning-module standing is per-class, not a platform role, so it has
        // to be asked for separately. Kept out of `allocatedRoles` so the
        // single-role auto-redirect below behaves exactly as before.
        try {
          const lmResponse = await fetch(`${apiUrl}/api/v1/learningmodule/overview`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
          });
          if (lmResponse.ok) {
            const overview = await lmResponse.json();
            const cards = [];
            if (overview.teachingCount > 0) {
              cards.push({
                role: 'learning-teacher',
                description: `${overview.teachingCount} class${overview.teachingCount === 1 ? '' : 'es'} you teach${
                  overview.awaitingReview ? ` · ${overview.awaitingReview} to review` : ''
                }`,
              });
            }
            // A student who already has the STUDENT platform role has a card
            // for it, so only add this when their enrolment would otherwise be
            // invisible (e.g. a faculty member sitting in a colleague's class).
            if (overview.enrolledCount > 0 && !platformRoles.includes('STUDENT')) {
              cards.push({
                role: 'learning-student',
                description: `${overview.enrolledCount} class${overview.enrolledCount === 1 ? '' : 'es'} you are enrolled in${
                  overview.pendingWork ? ` · ${overview.pendingWork} pending` : ''
                }`,
              });
            }
            setLearningCards(cards);
          }
        } catch {
          // The learning module being unreachable must not blank the roles page.
        }
      } catch (error) {
        console.error('Error fetching allocated roles:', error.message);
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  // Single-role users skip the picker and land on their dashboard directly.
  useEffect(() => {
    if (!isLoading && allocatedRoles.length === 1 && user) {
      const target = singleRoleTarget(allocatedRoles[0], user);
      if (target !== '#') navigate(target);
    }
  }, [isLoading, allocatedRoles, user, navigate]);

  if (isLoading) {
    return (
      <Flex bg={pageBg} minH="100vh" align="center" justify="center">
        <Spinner size="lg" />
      </Flex>
    );
  }

  const email = Array.isArray(user?.email) ? user.email[0] : user?.email;
  const displayName = user?.name || email || 'there';
  const roleCount = allocatedRoles.length + learningCards.length;

  return (
    <Box bg={pageBg} minH="100vh" py={{ base: 8, md: 16 }}>
      <Container maxW="5xl">
        {/* Header */}
        <Box mb={{ base: 8, md: 12 }}>
          <Text
            fontSize={{ base: 'xs', md: 'sm' }}
            fontWeight="bold"
            letterSpacing="0.12em"
            textTransform="uppercase"
            color={labelColor}
            mb={2}
          >
            Welcome back
          </Text>
          <Heading
            as="h1"
            fontSize={{ base: 'xl', md: '3xl' }}
            lineHeight="1.2"
            letterSpacing="-0.01em"
            wordBreak="break-word"
          >
            {email || displayName}
          </Heading>
          <Text color={subColor} fontSize={{ base: 'md', md: 'lg' }} mt={3}>
            {roleCount
              ? `Choose a workspace to continue — you have ${roleCount} ${roleCount === 1 ? 'role' : 'roles'}.`
              : 'No roles have been assigned to your account yet.'}
          </Text>
        </Box>

        {roleCount ? (
          <SimpleGrid columns={{ base: 1, sm: 2, lg: 3 }} spacing={{ base: 4, md: 6 }}>
            {allocatedRoles.map((role, index) => (
              <RoleItem
                key={role}
                role={role}
                index={index}
                onOpen={() => navigate(singleRoleTarget(role, user))}
              />
            ))}
            {learningCards.map((card, index) => (
              <RoleItem
                key={card.role}
                role={card.role}
                index={allocatedRoles.length + index}
                descriptionOverride={card.description}
                onOpen={() => navigate(roleMeta(card.role).link)}
              />
            ))}
          </SimpleGrid>
        ) : (
          <Flex
            direction="column"
            align="center"
            textAlign="center"
            bg={emptyCardBg}
            borderWidth="1px"
            borderColor={emptyCardBorder}
            borderRadius="2xl"
            py={{ base: 12, md: 16 }}
            px={6}
          >
            <Flex
              align="center"
              justify="center"
              boxSize={16}
              borderRadius="full"
              bg={emptyIconBg}
              color={subColor}
              mb={4}
            >
              <Icon as={FiUser} boxSize={8} />
            </Flex>
            <Heading as="h2" fontSize={{ base: 'lg', md: 'xl' }} mb={2}>
              No roles assigned yet
            </Heading>
            <Text color={subColor} fontSize={{ base: 'sm', md: 'md' }} maxW="sm">
              Your account doesn&apos;t have any roles yet. Please contact your administrator to get access.
            </Text>
          </Flex>
        )}
      </Container>
    </Box>
  );
};

export default AllocatedRolesPage;
