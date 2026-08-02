import React, { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, NavLink, Outlet, useMatch } from 'react-router-dom';
import {
  Avatar,
  Badge,
  Box,
  Button,
  Container,
  Drawer,
  DrawerBody,
  DrawerCloseButton,
  DrawerContent,
  DrawerHeader,
  DrawerOverlay,
  Flex,
  HStack,
  Heading,
  Icon,
  IconButton,
  Menu,
  MenuButton,
  MenuDivider,
  MenuItem,
  MenuList,
  Text,
  Tooltip,
  useDisclosure,
} from '@chakra-ui/react';
import getEnvironment from '../../getenvironment';
import { loginPathFor } from '../../authRedirect';
import lmApi from '../api/lmApi';
import useStableNavigate from '../hooks/useStableNavigate';
import { canCreateClass, isStudentOnly } from '../roles';
import NotificationBell from './NotificationBell';
import { buttonTextStyles } from './common';

const NAV_ITEMS = [
  { to: '/learning', label: 'Classes', icon: '🏫', end: true },
  { to: '/learning/todo', label: 'To-do', icon: '✅' },
  { to: '/learning/calendar', label: 'Calendar', icon: '📅' },
  { to: '/learning/notifications', label: 'Notifications', icon: '🔔' },
  // Points and badges are a student's record. Staff earn none — they set the
  // work rather than doing it, and the leaderboard leaves them off entirely —
  // so a "My progress" that was always empty would only invite the question.
  { to: '/learning/profile', label: 'My progress', icon: '🎖️', studentOnly: true },
  // Last, and separated below. Reporting something broken is not navigation —
  // it is what you do *instead* of what you came here for, and it has to be
  // reachable from wherever the thing broke.
  { to: '/learning/bugs', label: 'Report a bug', icon: '🛠️', foot: true },
];

/**
 * Class tabs that exist under every class and need no further id in the path.
 *
 * Switching class from inside one of these keeps you on the same tab — the
 * reason to switch is usually to compare ("what did the other section get for
 * this?"), and landing on the stream every time means two clicks back to where
 * you were. Anything else — a quiz, a notebook, an id-bearing route — drops to
 * the class home, because that id does not exist in the class being switched to.
 *
 * `insights` and `playground` are on the list even though each is one role only.
 * Carrying a tab the new class will not show is handled: RequireTeacher (or the
 * server) redirects to the class stream, which is where the fallback would have
 * put them anyway.
 */
const PORTABLE_TABS = new Set([
  'material',
  'quizzes',
  'tutorials',
  'shorts',
  'notebooks',
  'grades',
  'studio',
  'playground',
  'insights',
  'feedback',
  'people',
]);

/**
 * The rail's class list.
 *
 * It replaced a card that showed the signed-in name, email and role badges —
 * three facts the user already knows about themselves, occupying the one piece
 * of always-visible furniture on the page. Identity still lives in the header
 * avatar menu, one click away, which is the only place it was ever needed.
 */
function ClassSwitcher({ classes, activeClassId, carriedTab, onNavigate }) {
  if (!classes) return null;

  const href = (klass) =>
    `/learning/class/${klass._id}${carriedTab ? `/${carriedTab}` : ''}`;

  return (
    <Box mt={6} bg="white" borderRadius="lg" borderWidth="1px" borderColor="gray.200" overflow="hidden">
      <Text
        px={4}
        pt={3}
        pb={2}
        fontSize="xs"
        fontWeight="700"
        textTransform="uppercase"
        letterSpacing="wide"
        color="gray.500"
      >
        {activeClassId ? 'Switch class' : 'My classes'}
      </Text>

      {classes.length === 0 ? (
        <Text px={4} pb={3} fontSize="xs" color="gray.500">
          You are not in any class yet. Use <b>Join class</b> above with the code your teacher gave you.
        </Text>
      ) : (
        <Box maxH="280px" overflowY="auto" pb={1}>
          {classes.map((klass) => {
            const active = String(klass._id) === String(activeClassId);
            return (
              <Tooltip
                key={klass._id}
                label={[klass.name, klass.section, klass.subject].filter(Boolean).join(' · ')}
                placement="right"
                openDelay={400}
              >
                <Flex
                  as={RouterLink}
                  to={href(klass)}
                  onClick={onNavigate}
                  align="center"
                  gap={2.5}
                  px={4}
                  py={2}
                  fontSize="sm"
                  bg={active ? 'blue.50' : 'transparent'}
                  color={active ? 'blue.800' : 'gray.700'}
                  fontWeight={active ? '600' : '400'}
                  borderLeftWidth="3px"
                  borderLeftColor={active ? 'blue.500' : 'transparent'}
                  _hover={{ bg: active ? 'blue.50' : 'gray.50', textDecoration: 'none' }}
                >
                  {/* The class's own colour, the same one the header and the
                      dashboard card use — it is how people recognise a class
                      before they have read its name. */}
                  <Box
                    w="10px"
                    h="10px"
                    borderRadius="full"
                    bg={klass.coverColor || '#1967d2'}
                    flexShrink={0}
                  />
                  <Text noOfLines={1}>{klass.name}</Text>
                </Flex>
              </Tooltip>
            );
          })}
        </Box>
      )}

      <Box borderTopWidth="1px" borderColor="gray.100">
        <Text
          as={RouterLink}
          to="/learning"
          onClick={onNavigate}
          display="block"
          px={4}
          py={2}
          fontSize="xs"
          fontWeight="600"
          color="blue.600"
          _hover={{ bg: 'gray.50', textDecoration: 'none' }}
        >
          All classes →
        </Text>
      </Box>
    </Box>
  );
}

function NavItems({ onNavigate, studentOnly = false }) {
  return (
    <>
      {NAV_ITEMS.filter((item) => !item.studentOnly || studentOnly).map((item) => (
        <Box
          key={item.to}
          as={NavLink}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          // Pushed away from the navigation proper: it is not another place to
          // go, it is the escape hatch when a place you went is broken.
          mt={item.foot ? 4 : undefined}
          borderTopWidth={item.foot ? '1px' : undefined}
          borderColor="gray.200"
          pt={item.foot ? 4 : undefined}
          px={4}
          py={2.5}
          borderRadius="full"
          display="flex"
          alignItems="center"
          gap={3}
          fontSize="sm"
          fontWeight="500"
          color="gray.700"
          _hover={{ bg: 'gray.100' }}
          sx={{
            '&.active': { bg: 'blue.50', color: 'blue.700', fontWeight: '600' },
          }}
        >
          <Text as="span">{item.icon}</Text>
          {item.label}
        </Box>
      ))}
    </>
  );
}

/**
 * Shell for every learning-module screen: a left rail on desktop, a drawer on
 * mobile, and the header that carries the join/create actions.
 */
export default function LearningLayout() {
  const [me, setMe] = useState(null);
  const [overview, setOverview] = useState(null);
  const [classes, setClasses] = useState(null);
  const { isOpen, onOpen, onClose } = useDisclosure();
  const navigate = useStableNavigate();

  // Which class is open, and where inside it. Read with useMatch rather than
  // useParams: `class/:classId` is a *descendant* route of this layout, so its
  // params are not visible here.
  const classMatch = useMatch('/learning/class/:classId/*');
  const activeClassId = classMatch?.params?.classId || null;
  const openTab = classMatch?.params?.['*'] || '';
  const carriedTab = PORTABLE_TABS.has(openTab) ? openTab : '';

  const load = useCallback(async () => {
    try {
      // Claiming invites first means a student who was added by email before
      // they had an account lands straight in their classes.
      await lmApi.claimInvites().catch(() => {});
      const [profile, summary, myClasses] = await Promise.all([
        lmApi.me(),
        lmApi.overview(),
        // The switcher must not be able to break the shell: a failed class list
        // costs the rail a panel, not the whole module.
        lmApi.listClasses().catch(() => []),
      ]);
      setMe(profile);
      setOverview(summary);
      setClasses(myClasses);
    } catch (error) {
      // `window.location` rather than `useLocation()` so the current page isn't
      // a dependency of `load` — that would refetch the profile on every hop
      // inside the module. Under BrowserRouter the two agree.
      if (error.status === 401) navigate(loginPathFor(window.location), { replace: true });
    }
  }, [navigate]);

  useEffect(() => {
    load();
  }, [load]);

  const handleLogout = useCallback(async () => {
    try {
      await fetch(`${getEnvironment()}/user/getuser/logout`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch (error) {
      // A failed call must not strand the user on a signed-in screen; the
      // local token still goes and the login page re-checks the session.
      console.error('Error during logout:', error.message);
    }
    localStorage.removeItem('token');
    navigate('/login', { replace: true });
  }, [navigate]);

  const mayCreateClass = canCreateClass(me?.roles);
  // Students have no platform navbar above this header, so it owns the page.
  const studentOnly = isStudentOnly(me?.roles);

  return (
    <Box minH={studentOnly ? '100vh' : 'calc(100vh - 64px)'} bg="gray.50">
      <Box bg="white" borderBottomWidth="1px" borderColor="gray.200" position="sticky" top={0} zIndex={20}>
        <Container maxW="1400px" py={3}>
          <Flex align="center" gap={3}>
            <IconButton
              display={{ base: 'inline-flex', md: 'none' }}
              variant="ghost"
              aria-label="Open menu"
              icon={<span>☰</span>}
              onClick={onOpen}
            />
            <Flex as={RouterLink} to="/learning" align="center" gap={2} _hover={{ textDecoration: 'none' }}>
              <Text fontSize="xl">🎓</Text>
              <Box>
                <Heading size="sm" color="gray.800" lineHeight="1.1">
                  XCEED Learning
                </Heading>
                <Text fontSize="xs" color="gray.500" display={{ base: 'none', sm: 'block' }}>
                  Classes, coursework & AI study material
                </Text>
              </Box>
            </Flex>

            <Box flex="1" />

            {overview?.awaitingReview > 0 && (
              <Badge
                as={RouterLink}
                to="/learning/todo"
                colorScheme="orange"
                borderRadius="full"
                px={3}
                py={1}
                display={{ base: 'none', md: 'inline-flex' }}
              >
                {overview.awaitingReview} to review
              </Badge>
            )}

            <NotificationBell />

            <Button
              size="sm"
              variant="outline"
              onClick={() => navigate('/learning?join=1')}
              display={{ base: 'none', sm: 'inline-flex' }}
            >
              Join class
            </Button>
            {mayCreateClass && (
              <Button size="sm" colorScheme="blue" onClick={() => navigate('/learning?create=1')}>
                Create
              </Button>
            )}

            {me && (
              <Menu placement="bottom-end">
                <MenuButton as={Button} variant="ghost" size="sm" px={2}>
                  <HStack spacing={2}>
                    <Avatar size="xs" name={me.name} />
                    <Text
                      fontSize="sm"
                      fontWeight="600"
                      noOfLines={1}
                      maxW="140px"
                      display={{ base: 'none', md: 'block' }}
                    >
                      {me.name}
                    </Text>
                  </HStack>
                </MenuButton>
                <MenuList>
                  <Box px={3} py={2}>
                    <Text fontSize="sm" fontWeight="600" noOfLines={1}>
                      {me.name}
                    </Text>
                    <Text fontSize="xs" color="gray.500" noOfLines={1}>
                      {me.email}
                    </Text>
                  </Box>
                  <MenuDivider />
                  <MenuItem {...buttonTextStyles} onClick={handleLogout}>
                    Log out
                  </MenuItem>
                </MenuList>
              </Menu>
            )}
          </Flex>
        </Container>
      </Box>

      <Container maxW="1400px" py={6}>
        <Flex gap={6} align="flex-start">
          <Box
            as="nav"
            display={{ base: 'none', md: 'block' }}
            w="220px"
            flexShrink={0}
            position="sticky"
            top="88px"
          >
            <NavItems studentOnly={studentOnly} />
            <ClassSwitcher
              classes={classes}
              activeClassId={activeClassId}
              carriedTab={carriedTab}
            />
          </Box>

          <Box flex="1" minW={0}>
            <Outlet context={{ me, overview, reloadOverview: load }} />
          </Box>
        </Flex>
      </Container>

      <Drawer isOpen={isOpen} placement="left" onClose={onClose}>
        <DrawerOverlay />
        <DrawerContent>
          <DrawerCloseButton />
          <DrawerHeader>
            <Icon as="span">🎓</Icon> XCEED Learning
          </DrawerHeader>
          <DrawerBody>
            <NavItems onNavigate={onClose} studentOnly={studentOnly} />
            <ClassSwitcher
              classes={classes}
              activeClassId={activeClassId}
              carriedTab={carriedTab}
              onNavigate={onClose}
            />
          </DrawerBody>
        </DrawerContent>
      </Drawer>
    </Box>
  );
}
