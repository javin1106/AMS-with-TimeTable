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
  // Last, and in its own colour. It is not another kind of classwork — it runs
  // the other way, from the class to the teacher — and sitting it mid-row in
  // the same grey as Quizzes made it read as one more thing to submit. The
  // purple is the tell that this tab plays by different rules.
  { path: 'feedback', label: 'Anonymous Feedback', accent: 'purple' },
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
        px={{ base: 4, md: 5 }}
        py={2}
        mb={4}
        position="relative"
        overflow="hidden"
      >
        {/* One row, fixed height: the class identity scrolls out of the way as
            the window narrows, but the actions on the right stay put. */}
        <Flex justify="space-between" align="center" gap={3} wrap="nowrap">
          {/* Clips itself rather than pushing the actions off the card: without
              `overflow`, the nowrap children spill past the right edge and the
              card's own `overflow="hidden"` eats the settings button. */}
          <HStack spacing={3} flex="1 1 auto" minW={0} overflow="hidden" fontSize="sm" opacity={0.9}>
            <Heading size="sm" whiteSpace="nowrap" opacity={1}>
              {klass.name}
            </Heading>
            <Text isTruncated minW={0}>
              {[klass.section, klass.subject, klass.room].filter(Boolean).join(' · ')}
            </Text>
            <Text whiteSpace="nowrap">👤 {klass.ownerName}</Text>
            <Text whiteSpace="nowrap">📄 {klass.counts?.courseworkCount ?? 0} items</Text>
            {klass.status === 'archived' && <Badge colorScheme="orange">Archived</Badge>}
          </HStack>

          <HStack spacing={2} flexShrink={0}>
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
              <Tooltip label={hasCopied ? 'Copied!' : 'Click to copy class code'}>
                <Button
                  onClick={onCopy}
                  size="sm"
                  fontFamily="mono"
                  letterSpacing="wider"
                  {...headerLinkStyles}
                >
                  {klass.code}
                </Button>
              </Tooltip>
            )}
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
        {visibleTabs.map((tab) => {
          // Blue is the module's default tab accent; a tab may claim its own to
          // say it is a different kind of thing rather than the next item in a
          // sequence. `ml="auto"` pushes an accented tab to the far end of the
          // row, away from the teaching tabs it does not belong with.
          const accent = tab.accent || 'blue';
          return (
            <Box
              key={tab.path || 'stream'}
              as={NavLink}
              to={tab.path ? `/learning/class/${classId}/${tab.path}` : `/learning/class/${classId}`}
              end={tab.end}
              px={4}
              py={3}
              ml={tab.accent ? 'auto' : undefined}
              fontSize="sm"
              fontWeight={tab.accent ? '600' : '500'}
              color={tab.accent ? `${accent}.600` : 'gray.600'}
              whiteSpace="nowrap"
              borderBottomWidth="3px"
              borderColor="transparent"
              _hover={{ color: `${accent}.600`, bg: tab.accent ? `${accent}.50` : undefined }}
              sx={{
                '&.active': {
                  color: `${accent}.600`,
                  borderColor: `${accent}.500`,
                  fontWeight: '600',
                  ...(tab.accent ? { bg: `${accent}.50` } : {}),
                },
              }}
            >
              {tab.label}
            </Box>
          );
        })}
      </Flex>

      <Outlet context={{ klass, isTeacher, classId, reloadClass: load, toast }} />
    </Box>
  );
}
