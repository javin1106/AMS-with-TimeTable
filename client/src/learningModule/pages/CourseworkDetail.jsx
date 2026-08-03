import React, { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Divider,
  Flex,
  HStack,
  Heading,
  Radio,
  RadioGroup,
  Stack,
  Text,
  Textarea,
  useDisclosure,
  useToast,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import { AttachmentList, AttachmentPicker } from '../components/Attachments';
import CommentThread from '../components/CommentThread';
import MaterialModal from '../components/MaterialModal';
import RichText from '../components/RichText';
import { DueBadge, ErrorState, Loading, SectionCard, StateBadge } from '../components/common';
import { courseworkMeta, formatDateTime } from '../format';

/** The student's "Your work" panel — draft, turn in, unsubmit, see the grade. */
function YourWork({ classId, coursework, submission, onChanged }) {
  const [attachments, setAttachments] = useState(submission?.attachments || []);
  const [textAnswer, setTextAnswer] = useState(submission?.textAnswer || '');
  const [choiceAnswer, setChoiceAnswer] = useState(submission?.choiceAnswer || '');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    setAttachments(submission?.attachments || []);
    setTextAnswer(submission?.textAnswer || '');
    setChoiceAnswer(submission?.choiceAnswer || '');
  }, [submission]);

  if (!submission) return null;

  const locked = submission.state === 'turned_in' || submission.state === 'returned';
  const isQuestion = coursework.workType === 'question';
  const isMcq = isQuestion && coursework.questionConfig?.answerType === 'mcq';

  const payload = () => ({ attachments, textAnswer, choiceAnswer });

  const run = async (action, successTitle) => {
    setBusy(true);
    try {
      await action();
      toast({ status: 'success', title: successTitle });
      onChanged();
    } catch (error) {
      toast({ status: 'error', title: error.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard title="Your work" subtitle={<StateBadge state={submission.state} late={submission.late} />}>
      {submission.state === 'returned' && (
        <Alert status={submission.grade !== null ? 'success' : 'info'} borderRadius="md" mb={4}>
          <AlertIcon />
          <Box>
            <Text fontWeight="600">
              {submission.grade !== null && submission.grade !== undefined
                ? `Graded: ${submission.grade} / ${submission.maxPoints}`
                : 'Returned by your teacher'}
            </Text>
            {submission.feedback && (
              <Text fontSize="sm" mt={1}>
                {submission.feedback}
              </Text>
            )}
          </Box>
        </Alert>
      )}

      {isMcq ? (
        <RadioGroup value={choiceAnswer} onChange={setChoiceAnswer} isDisabled={locked}>
          <Stack>
            {(coursework.questionConfig?.choices || []).map((choice) => (
              <Radio key={choice} value={choice}>
                {choice}
              </Radio>
            ))}
          </Stack>
        </RadioGroup>
      ) : (
        <Textarea
          rows={isQuestion ? 4 : 6}
          placeholder={isQuestion ? 'Type your answer…' : 'Add your response or notes (optional if you attach a file)'}
          value={textAnswer}
          onChange={(event) => setTextAnswer(event.target.value)}
          isDisabled={locked}
          mb={3}
        />
      )}

      {!isQuestion && (
        <Box mt={3}>
          {locked ? (
            <AttachmentList attachments={attachments} />
          ) : (
            <AttachmentPicker attachments={attachments} onChange={setAttachments} disabled={busy} />
          )}
        </Box>
      )}

      <HStack mt={5} spacing={2}>
        {!locked && (
          <>
            <Button
              size="sm"
              variant="outline"
              isLoading={busy}
              onClick={() => run(() => lmApi.saveDraft(classId, coursework._id, payload()), 'Draft saved')}
            >
              Save draft
            </Button>
            <Button
              size="sm"
              colorScheme="blue"
              isLoading={busy}
              onClick={() => run(() => lmApi.turnIn(classId, coursework._id, payload()), 'Turned in')}
            >
              Turn in
            </Button>
          </>
        )}
        {locked && submission.grade === null && (
          <Button
            size="sm"
            variant="outline"
            isLoading={busy}
            onClick={() => run(() => lmApi.unsubmit(classId, coursework._id), 'Unsubmitted')}
          >
            Unsubmit
          </Button>
        )}
      </HStack>

      {submission.turnedInAt && (
        <Text fontSize="xs" color="gray.500" mt={3}>
          Turned in {formatDateTime(submission.turnedInAt)}
          {submission.late ? ' (late)' : ''}
        </Text>
      )}

      <Divider my={4} />
      <Heading size="xs" color="gray.700" mb={2}>
        Private comments
      </Heading>
      <Text fontSize="xs" color="gray.500" mb={2}>
        Only you and the teaching staff can see these.
      </Text>
      <CommentThread
        classId={classId}
        targetType="submission"
        targetId={submission._id}
        placeholder="Message your teacher…"
        emptyLabel="No private comments."
      />
    </SectionCard>
  );
}

export default function CourseworkDetail() {
  const { classId, klass, isTeacher, reloadClass } = useOutletContext();
  const { courseworkId } = useParams();
  const [item, setItem] = useState(null);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { isOpen: isEditOpen, onOpen: onEditOpen, onClose: onEditClose } = useDisclosure();
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setError(null);
    try {
      const [detail, profile] = await Promise.all([
        lmApi.getCoursework(classId, courseworkId),
        lmApi.me(),
      ]);
      setItem(detail);
      setMe(profile);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId, courseworkId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!item) return null;

  const meta = courseworkMeta(item);

  // Material has its own tab; everything else reached this page from the stream.
  const isMaterial = item.workType === 'material';
  const backTo = isMaterial
    ? `/learning/class/${classId}/material`
    : `/learning/class/${classId}`;

  return (
    <Box>
      <Button size="sm" variant="ghost" mb={3} onClick={() => navigate(backTo)}>
        ← Back to {isMaterial ? 'material' : 'stream'}
      </Button>

      <Flex gap={6} align="flex-start" direction={{ base: 'column', lg: 'row' }}>
        <Box flex="1" minW={0} w="100%">
          <SectionCard>
            <Flex gap={3} align="flex-start">
              <Text fontSize="2xl">{meta.icon}</Text>
              <Box flex="1" minW={0}>
                <Heading size="md" color="gray.800">
                  {item.title}
                </Heading>
                <HStack mt={2} spacing={3} wrap="wrap">
                  <Text fontSize="sm" color="gray.600">
                    {item.createdByName}
                  </Text>
                  <Badge colorScheme={meta.colorScheme}>{meta.label}</Badge>
                  {item.points > 0 && <Text fontSize="sm" color="gray.600">{item.points} points</Text>}
                  <DueBadge dueDate={item.dueDate} />
                  {item.topicName && <Badge colorScheme="gray">{item.topicName}</Badge>}
                  {item.aiSourceSessionId && <Badge colorScheme="purple">✨ From a class recording</Badge>}
                </HStack>
              </Box>
              {isTeacher && isMaterial && (
                <Button size="sm" colorScheme="blue" variant="outline" onClick={onEditOpen}>
                  Edit
                </Button>
              )}
              {isTeacher && !isMaterial && (
                <Button
                  as={RouterLink}
                  to={`/learning/class/${classId}/work/${item._id}/grade`}
                  size="sm"
                  colorScheme="blue"
                >
                  Review work
                </Button>
              )}
              {item.quiz && !isTeacher && (
                <Button as={RouterLink} to={`/learning/class/${classId}/quiz/${item.quiz._id}`} size="sm" colorScheme="purple">
                  Take quiz
                </Button>
              )}
            </Flex>

            {item.instructions && (
              <Box mt={5}>
                <Divider mb={4} />
                <RichText>{item.instructions}</RichText>
              </Box>
            )}

            <AttachmentList attachments={item.attachments} />

            {/* Material is never assigned or graded, so it has no counts. */}
            {isTeacher && !isMaterial && item.submissions && (
              <Box mt={5}>
                <Divider mb={3} />
                <HStack spacing={5}>
                  <Box>
                    <Text fontSize="xl" fontWeight="700">
                      {item.submissions.filter((s) => s.state === 'turned_in').length}
                    </Text>
                    <Text fontSize="xs" color="gray.500">
                      Turned in
                    </Text>
                  </Box>
                  <Box>
                    <Text fontSize="xl" fontWeight="700">
                      {item.submissions.filter((s) => s.state === 'assigned').length}
                    </Text>
                    <Text fontSize="xs" color="gray.500">
                      Assigned
                    </Text>
                  </Box>
                  <Box>
                    <Text fontSize="xl" fontWeight="700">
                      {item.submissions.filter((s) => s.state === 'returned').length}
                    </Text>
                    <Text fontSize="xs" color="gray.500">
                      Graded
                    </Text>
                  </Box>
                </HStack>
              </Box>
            )}
          </SectionCard>

          <Box mt={4}>
            <SectionCard title="Class comments">
              <CommentThread
                classId={classId}
                targetType="coursework"
                targetId={item._id}
                currentUserId={me?.id}
                canModerate={isTeacher}
              />
            </SectionCard>
          </Box>
        </Box>

        {!isTeacher && item.workType !== 'material' && (
          <Box w={{ base: '100%', lg: '340px' }} flexShrink={0}>
            <YourWork classId={classId} coursework={item} submission={item.mySubmission} onChanged={load} />
          </Box>
        )}
      </Flex>

      {isTeacher && isMaterial && (
        <MaterialModal
          isOpen={isEditOpen}
          onClose={onEditClose}
          classId={classId}
          topics={klass?.topics || []}
          initial={item}
          onSaved={async () => {
            await load();
            reloadClass?.();
          }}
        />
      )}
    </Box>
  );
}
