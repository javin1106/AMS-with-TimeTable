import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import {
  Avatar,
  Badge,
  Box,
  Button,
  Checkbox,
  Divider,
  Flex,
  Grid,
  HStack,
  Heading,
  Input,
  Select,
  Text,
  Textarea,
  useToast,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import { AttachmentList } from '../components/Attachments';
import CommentThread from '../components/CommentThread';
import { ErrorState, Loading, SectionCard, StatTile, StateBadge } from '../components/common';
import { formatDateTime, initials } from '../format';

/**
 * The teacher's grading workspace: student list on the left, the selected
 * student's work and grade entry on the right.
 */
export default function GradeWork() {
  const { classId } = useOutletContext();
  const { courseworkId } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [checked, setChecked] = useState(() => new Set());
  const [filter, setFilter] = useState('all');
  const [grade, setGrade] = useState('');
  const [feedback, setFeedback] = useState('');
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await lmApi.submissionGrid(classId, courseworkId);
      setData(result);
      setSelectedId((current) => current || result.submissions[0]?._id || null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId, courseworkId]);

  useEffect(() => {
    load();
  }, [load]);

  const selected = useMemo(
    () => data?.submissions.find((s) => s._id === selectedId) || null,
    [data, selectedId],
  );

  useEffect(() => {
    setGrade(selected?.grade ?? '');
    setFeedback(selected?.feedback ?? '');
  }, [selected]);

  const filtered = useMemo(() => {
    if (!data) return [];
    if (filter === 'all') return data.submissions;
    if (filter === 'ungraded') {
      return data.submissions.filter((s) => s.state === 'turned_in' && s.grade === null);
    }
    return data.submissions.filter((s) => s.state === filter);
  }, [data, filter]);

  const saveGrade = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await lmApi.gradeSubmission(classId, selected._id, {
        grade: grade === '' ? null : Number(grade),
        feedback,
      });
      toast({ status: 'success', title: 'Grade saved' });
      await load();
    } catch (err) {
      toast({ status: 'error', title: err.message });
    } finally {
      setSaving(false);
    }
  };

  const returnSelected = async (ids) => {
    if (!ids.length) return;
    try {
      const result = await lmApi.returnSubmissions(classId, ids);
      toast({ status: 'success', title: `Returned ${result.returned} submission(s)` });
      setChecked(new Set());
      await load();
    } catch (err) {
      toast({ status: 'error', title: err.message });
    }
  };

  const toggleCheck = (id) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (loading) return <Loading label="Loading student work…" />;
  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!data) return null;

  return (
    <Box>
      <Flex justify="space-between" align="center" mb={4} gap={3} wrap="wrap">
        <Box>
          <Button size="sm" variant="ghost" onClick={() => navigate(`/learning/class/${classId}/work/${courseworkId}`)}>
            ← Back
          </Button>
          <Heading size="md" mt={1}>
            {data.coursework.title}
          </Heading>
          <Text fontSize="sm" color="gray.500">
            {data.coursework.points} points
          </Text>
        </Box>
        <HStack>
          <Button
            size="sm"
            colorScheme="blue"
            isDisabled={checked.size === 0}
            onClick={() => returnSelected([...checked])}
          >
            Return {checked.size > 0 ? `(${checked.size})` : ''}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              returnSelected(
                data.submissions.filter((s) => s.grade !== null && s.state !== 'returned').map((s) => s._id),
              )
            }
          >
            Return all graded
          </Button>
        </HStack>
      </Flex>

      <Grid templateColumns={{ base: '1fr 1fr', md: 'repeat(5, 1fr)' }} gap={3} mb={5}>
        <StatTile label="Turned in" value={data.summary.turnedIn} accent="green.500" />
        <StatTile label="Assigned" value={data.summary.assigned} accent="gray.500" />
        <StatTile label="Returned" value={data.summary.returned} accent="blue.500" />
        <StatTile label="Late" value={data.summary.late} accent="red.500" />
        <StatTile label="Average" value={data.summary.average ?? '—'} accent="purple.500" />
      </Grid>

      <Flex gap={5} align="flex-start" direction={{ base: 'column', md: 'row' }}>
        <Box w={{ base: '100%', md: '320px' }} flexShrink={0}>
          <SectionCard>
            <Select size="sm" mb={3} value={filter} onChange={(event) => setFilter(event.target.value)}>
              <option value="all">All students ({data.submissions.length})</option>
              <option value="turned_in">Turned in</option>
              <option value="ungraded">Turned in, not graded</option>
              <option value="assigned">Not submitted</option>
              <option value="returned">Returned</option>
            </Select>

            <Box maxH="520px" overflowY="auto">
              {filtered.map((submission) => (
                <Flex
                  key={submission._id}
                  align="center"
                  gap={2}
                  px={2}
                  py={2}
                  borderRadius="md"
                  bg={submission._id === selectedId ? 'blue.50' : 'transparent'}
                  _hover={{ bg: submission._id === selectedId ? 'blue.50' : 'gray.50' }}
                >
                  <Checkbox
                    isChecked={checked.has(submission._id)}
                    onChange={() => toggleCheck(submission._id)}
                    aria-label={`Select ${submission.studentName}`}
                  />
                  <Flex
                    as="button"
                    flex="1"
                    minW={0}
                    align="center"
                    gap={2}
                    textAlign="left"
                    onClick={() => setSelectedId(submission._id)}
                  >
                    <Avatar size="xs" name={submission.studentName} getInitials={() => initials(submission.studentName)} />
                    <Box flex="1" minW={0}>
                      <Text fontSize="sm" noOfLines={1} fontWeight={submission._id === selectedId ? '600' : '400'}>
                        {submission.studentName || 'Unnamed student'}
                      </Text>
                      <StateBadge state={submission.state} late={submission.late} />
                    </Box>
                    <Text fontSize="sm" fontWeight="600" color={submission.grade === null ? 'gray.300' : 'gray.700'}>
                      {submission.grade === null || submission.grade === undefined ? '—' : submission.grade}
                    </Text>
                  </Flex>
                </Flex>
              ))}
              {filtered.length === 0 && (
                <Text fontSize="sm" color="gray.500" py={4} textAlign="center">
                  No students match this filter.
                </Text>
              )}
            </Box>
          </SectionCard>
        </Box>

        <Box flex="1" minW={0} w="100%">
          {!selected ? (
            <SectionCard>
              <Text color="gray.500">Select a student to review their work.</Text>
            </SectionCard>
          ) : (
            <SectionCard
              title={selected.studentName || 'Student'}
              subtitle={
                selected.turnedInAt
                  ? `Turned in ${formatDateTime(selected.turnedInAt)}${selected.late ? ' · late' : ''}`
                  : 'Nothing turned in yet'
              }
            >
              <StateBadge state={selected.state} late={selected.late} />

              {selected.textAnswer && (
                <Box mt={4} p={4} bg="gray.50" borderRadius="md" borderWidth="1px" borderColor="gray.200">
                  <Text fontSize="sm" whiteSpace="pre-wrap" color="gray.700">
                    {selected.textAnswer}
                  </Text>
                </Box>
              )}
              {selected.choiceAnswer && (
                <Badge mt={4} colorScheme="blue" fontSize="sm" px={3} py={1}>
                  Selected: {selected.choiceAnswer}
                </Badge>
              )}
              <AttachmentList attachments={selected.attachments} />

              {!selected.textAnswer && !selected.choiceAnswer && !selected.attachments?.length && (
                <Text mt={4} fontSize="sm" color="gray.500">
                  This student has not submitted anything.
                </Text>
              )}

              <Divider my={5} />

              <Flex gap={4} align="flex-end" wrap="wrap">
                <Box>
                  <Text fontSize="sm" fontWeight="600" mb={1}>
                    Grade
                  </Text>
                  <HStack>
                    <Input
                      type="number"
                      size="sm"
                      w="90px"
                      min={0}
                      max={selected.maxPoints}
                      value={grade}
                      onChange={(event) => setGrade(event.target.value)}
                    />
                    <Text fontSize="sm" color="gray.500">
                      / {selected.maxPoints}
                    </Text>
                  </HStack>
                </Box>
                <Button size="sm" colorScheme="blue" onClick={saveGrade} isLoading={saving}>
                  Save grade
                </Button>
                <Button size="sm" variant="outline" onClick={() => returnSelected([selected._id])}>
                  Save & return
                </Button>
                {selected.state === 'returned' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      await lmApi.reclaimSubmission(classId, selected._id).catch((e) =>
                        toast({ status: 'error', title: e.message }),
                      );
                      load();
                    }}
                  >
                    Reclaim for regrading
                  </Button>
                )}
              </Flex>

              <Box mt={4}>
                <Text fontSize="sm" fontWeight="600" mb={1}>
                  Feedback
                </Text>
                <Textarea
                  size="sm"
                  rows={3}
                  value={feedback}
                  onChange={(event) => setFeedback(event.target.value)}
                  placeholder="What did they do well? What should they fix?"
                />
              </Box>

              <Divider my={5} />
              <Heading size="xs" mb={2} color="gray.700">
                Private comments
              </Heading>
              <CommentThread
                classId={classId}
                targetType="submission"
                targetId={selected._id}
                canModerate
                placeholder="Message this student…"
                emptyLabel="No private comments."
              />
            </SectionCard>
          )}
        </Box>
      </Flex>
    </Box>
  );
}
