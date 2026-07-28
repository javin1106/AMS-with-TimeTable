import React, { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
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
  Text,
  useDisclosure,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import NotificationBell from './NotificationBell';

const NAV_ITEMS = [
  { to: '/learning', label: 'Classes', icon: '🏫', end: true },
  { to: '/learning/todo', label: 'To-do', icon: '✅' },
  { to: '/learning/calendar', label: 'Calendar', icon: '📅' },
  { to: '/learning/notifications', label: 'Notifications', icon: '🔔' },
];

function NavItems({ onNavigate }) {
  return (
    <>
      {NAV_ITEMS.map((item) => (
        <Box
          key={item.to}
          as={NavLink}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
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
  const { isOpen, onOpen, onClose } = useDisclosure();
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      // Claiming invites first means a student who was added by email before
      // they had an account lands straight in their classes.
      await lmApi.claimInvites().catch(() => {});
      const [profile, summary] = await Promise.all([lmApi.me(), lmApi.overview()]);
      setMe(profile);
      setOverview(summary);
    } catch (error) {
      if (error.status === 401) navigate('/login', { replace: true });
    }
  }, [navigate]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Box minH="calc(100vh - 64px)" bg="gray.50">
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
            <Button size="sm" colorScheme="blue" onClick={() => navigate('/learning?create=1')}>
              Create
            </Button>
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
            <NavItems />
            {me && (
              <Box mt={6} px={4} py={3} bg="white" borderRadius="lg" borderWidth="1px" borderColor="gray.200">
                <Text fontSize="xs" color="gray.500">
                  Signed in as
                </Text>
                <Text fontSize="sm" fontWeight="600" noOfLines={1}>
                  {me.name}
                </Text>
                <Text fontSize="xs" color="gray.500" noOfLines={1}>
                  {me.email}
                </Text>
                <HStack mt={2} spacing={1} wrap="wrap">
                  {(me.roles || []).slice(0, 3).map((role) => (
                    <Badge key={role} fontSize="0.6rem" colorScheme="gray">
                      {role}
                    </Badge>
                  ))}
                </HStack>
              </Box>
            )}
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
            <NavItems onNavigate={onClose} />
          </DrawerBody>
        </DrawerContent>
      </Drawer>
    </Box>
  );
}
