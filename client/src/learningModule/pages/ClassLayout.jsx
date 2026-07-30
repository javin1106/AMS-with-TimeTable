import React, { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import {
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Heading,
  Text,
  Tooltip,
  useClipboard,
  useToast,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import { ErrorState, Loading } from '../components/common';

const TABS = [
  { path: '', label: 'Stream', end: true },
  { path: 'classwork', label: 'Classwork' },
  { path: 'tutorials', label: 'Tutorials' },
  { path: 'shorts', label: 'Shorts' },
  { path: 'people', label: 'People' },
  { path: 'grades', label: 'Grades' },
  { path: 'studio', label: 'AI Studio', teacherOnly: false },
  { path: 'insights', label: 'Insights', teacherOnly: true },
  { path: 'settings', label: 'Settings', teacherOnly: true },
];

export default function ClassLayout() {
  const { classId } = useParams();
  const [klass, setKlass] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const navigate = useNavigate();
  const toast = useToast();
  const { onCopy, hasCopied } = useClipboard(klass?.code || '');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setKlass(await lmApi.getClass(classId));
    } catch (err) {
      setError(err);
      if (err.status === 401) navigate('/login', { replace: true });
    } finally {
      setLoading(false);
    }
  }, [classId, navigate]);

  useEffect(() => {
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
  const visibleTabs = TABS.filter((tab) => !tab.teacherOnly || isTeacher);

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
              <Text>👥 {klass.counts?.studentCount ?? 0} students</Text>
              <Text>📄 {klass.counts?.courseworkCount ?? 0} items</Text>
              {klass.status === 'archived' && <Badge colorScheme="orange">Archived</Badge>}
            </HStack>
          </Box>

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
