import React, { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useParams } from 'react-router-dom';
import {
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Heading,
  IconButton,
  Text,
  Tooltip,
  useClipboard,
  useToast,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import { loginPathFor } from '../../authRedirect';
import { ErrorState, Loading } from '../components/common';
import useStableNavigate from '../hooks/useStableNavigate';

// People and Settings are about the class rather than its work, so they sit in
// the header beside the class code instead of competing with the teaching tabs.
const TABS = [
  { path: '', label: 'Stream', end: true },
  { path: 'material', label: 'Material' },
  { path: 'quizzes', label: 'Quizzes' },
  { path: 'tutorials', label: 'Tutorials' },
  { path: 'shorts', label: 'Shorts' },
  { path: 'notebooks', label: 'Coding' },
  { path: 'grades', label: 'Grades' },
  { path: 'studio', label: 'AI Studio' },
  { path: 'playground', label: 'AI Playground', studentOnly: true },
  { path: 'insights', label: 'Insights', teacherOnly: true },
];

// Sits on the coloured header, so the active state has to read against the
// class colour rather than the usual blue-on-white.
const headerLinkStyles = {
  bg: 'whiteAlpha.300',
  color: 'white',
  fontWeight: '500',
  _hover: { bg: 'whiteAlpha.400', textDecoration: 'none' },
  _active: { bg: 'whiteAlpha.500' },
  sx: { '&.active': { bg: 'white', color: 'gray.800', fontWeight: '600' } },
};

export default function ClassLayout() {
  const { classId } = useParams();
  const [klass, setKlass] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const navigate = useStableNavigate();
  const toast = useToast();
  const { onCopy, hasCopied } = useClipboard(klass?.code || '');

  // Refreshes triggered by a child (a new member, a renamed class) must not
  // unmount the header and tabs underneath the user, so only the initial fetch
  // for a class touches `loading`.
  const load = useCallback(async () => {
    setError(null);
    try {
      setKlass(await lmApi.getClass(classId));
    } catch (err) {
      setError(err);
      // See LearningLayout: `window.location` keeps the current page out of
      // this callback's dependencies, and matches it under BrowserRouter.
      if (err.status === 401) navigate(loginPathFor(window.location), { replace: true });
    } finally {
      setLoading(false);
    }
  }, [classId, navigate]);

  useEffect(() => {
    setLoading(true);
    setKlass(null);
    load();
  }, [load]);

  if (loading) return <Loading label="Opening class…" minH="360px" />;
  if (error) {
    return (
      <Box>
        <ErrorState error={error} onRetry={load} />
        <Button size="sm" onClick={() => navigate('/learning')}>
          Back to classes
        </Button>
      </Box>
    );
  }
  if (!klass) return null;

  const isTeacher = klass.isTeacher;
  const visibleTabs = TABS.filter(
    (tab) => (!tab.teacherOnly || isTeacher) && (!tab.studentOnly || !isTeacher),
  );

  return (
    <Box>
      <Box
        bg={klass.coverColor || '#1967d2'}
        color="white"
        borderRadius="lg"
        px={{ base: 5, md: 8 }}
        py={{ base: 6, md: 8 }}
        mb={4}
        position="relative"
        overflow="hidden"
      >
        <Flex justify="space-between" align="flex-start" gap={4} wrap="wrap">
          <Box>
            <Heading size="lg">{klass.name}</Heading>
            <Text opacity={0.9} fontSize="sm" mt={1}>
              {[klass.section, klass.subject, klass.room].filter(Boolean).join(' · ')}
            </Text>
            <HStack mt={3} spacing={3} fontSize="sm" opacity={0.9} wrap="wrap">
              <Text>👤 {klass.ownerName}</Text>
              <Text>📄 {klass.counts?.courseworkCount ?? 0} items</Text>
              {klass.status === 'archived' && <Badge colorScheme="orange">Archived</Badge>}
            </HStack>
          </Box>

          <Flex direction="column" align="flex-end" gap={3}>
            <HStack spacing={2}>
              <Button
                as={NavLink}
                to={`/learning/class/${classId}/people`}
                size="sm"
                leftIcon={<span>👥</span>}
                {...headerLinkStyles}
              >
                People · {klass.counts?.studentCount ?? 0}
              </Button>
              {isTeacher && (
                <Tooltip label="Class settings">
                  <IconButton
                    as={NavLink}
                    to={`/learning/class/${classId}/settings`}
                    size="sm"
                    aria-label="Class settings"
                    icon={<span>⚙️</span>}
                    {...headerLinkStyles}
                  />
                </Tooltip>
              )}
            </HStack>

            {isTeacher && (
              <Box textAlign="right" bg="whiteAlpha.300" borderRadius="md" px={4} py={3}>
                <Text fontSize="xs" opacity={0.9}>
                  Class code
                </Text>
                <Tooltip label={hasCopied ? 'Copied!' : 'Click to copy'}>
                  <Text
                    as="button"
                    onClick={onCopy}
                    fontSize="xl"
                    fontWeight="700"
                    letterSpacing="wider"
                    fontFamily="mono"
                  >
                    {klass.code}
                  </Text>
                </Tooltip>
              </Box>
            )}
          </Flex>
        </Flex>
      </Box>

      <Flex
        gap={1}
        borderBottomWidth="1px"
        borderColor="gray.200"
        mb={5}
        overflowX="auto"
        bg="white"
        borderTopRadius="lg"
        px={2}
      >
        {visibleTabs.map((tab) => (
          <Box
            key={tab.path || 'stream'}
            as={NavLink}
            to={tab.path ? `/learning/class/${classId}/${tab.path}` : `/learning/class/${classId}`}
            end={tab.end}
            px={4}
            py={3}
            fontSize="sm"
            fontWeight="500"
            color="gray.600"
            whiteSpace="nowrap"
            borderBottomWidth="3px"
            borderColor="transparent"
            _hover={{ color: 'blue.600' }}
            sx={{
              '&.active': { color: 'blue.600', borderColor: 'blue.500', fontWeight: '600' },
            }}
          >
            {tab.label}
          </Box>
        ))}
      </Flex>

      <Outlet context={{ klass, isTeacher, classId, reloadClass: load, toast }} />
    </Box>
  );
}
