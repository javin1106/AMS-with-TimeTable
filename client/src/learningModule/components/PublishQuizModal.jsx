import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Divider,
  Flex,
  FormControl,
  FormHelperText,
  FormLabel,
  HStack,
  Input,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Radio,
  RadioGroup,
  Stack,
  Switch,
  Text,
  useClipboard,
  useToast,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import { formatDateTime, toDateTimeInput } from '../format';

/**
 * Publishing, and the four moments it settles.
 *
 * They are laid out as a timeline because they are one: the link appears, the
 * paper opens, the door shuts on latecomers, the paper closes, and afterwards
 * the marks go out. Two of them used to be labelled in ways a teacher could not
 * tell apart — "close entry after a set time" and "closes at" both read as
 * "when does this thing close" — so each row now says what *stops* at that
 * moment, in the student's terms, and the two closing times sit next to each
 * other where the difference between them is visible.
 *
 * Shared by the quiz list and the editor so the two entry points cannot drift
 * into setting different things.
 */

/** One row of the timeline: a number, a name, what it stops, and a field. */
function ClockRow({ step, title, subtitle, children, isInvalid, action }) {
  return (
    <FormControl mb={5} isInvalid={isInvalid}>
      <Flex gap={3} align="flex-start">
        <Flex
          align="center"
          justify="center"
          flexShrink={0}
          w="26px"
          h="26px"
          mt="2px"
          borderRadius="full"
          bg="purple.500"
          color="white"
          fontSize="xs"
          fontWeight="700"
        >
          {step}
        </Flex>
        <Box flex="1" minW={0}>
          <Flex align="center" gap={2} wrap="wrap">
            <FormLabel fontSize="sm" mb={0} fontWeight="600">
              {title}
            </FormLabel>
            {action}
          </Flex>
          <Text fontSize="xs" color="gray.600" mb={2}>
            {subtitle}
          </Text>
          {children}
        </Box>
      </Flex>
    </FormControl>
  );
}

/** Now, as `<input type="datetime-local">` wants it. */
const nowForInput = () => toDateTimeInput(new Date());

export default function PublishQuizModal({ isOpen, onClose, quiz, classId, onPublished }) {
  const [publishAt, setPublishAt] = useState('');
  const [availableFrom, setAvailableFrom] = useState('');
  const [availableTo, setAvailableTo] = useState('');
  const [limitEntry, setLimitEntry] = useState(false);
  const [startDeadline, setStartDeadline] = useState('');
  // '' until the teacher has answered the results question — see `answered`.
  const [resultsMode, setResultsMode] = useState('');
  const [resultReleaseAt, setResultReleaseAt] = useState('');
  const [saving, setSaving] = useState(false);
  const [link, setLink] = useState('');
  const toast = useToast();

  const url = link && typeof window !== 'undefined' ? new URL(link, window.location.origin).href : '';
  const { onCopy, hasCopied } = useClipboard(url);

  // Hydrates once per opening, not on every new `quiz` object.
  //
  // Publishing calls `onPublished`, and a parent that reloads the quiz there
  // hands back a fresh object with the same contents. Keying the effect on the
  // prop itself made that reload re-run it, which cleared `link` and dropped
  // the teacher back into the form a moment after they had scheduled the paper
  // — the link they came for gone, and the dialog looking like it had failed.
  const hydratedFor = useRef(null);

  useEffect(() => {
    if (!isOpen || !quiz) {
      hydratedFor.current = null;
      return;
    }
    if (hydratedFor.current === String(quiz._id)) return;
    hydratedFor.current = String(quiz._id);

    setLink('');
    setPublishAt(toDateTimeInput(quiz.publishAt));
    setAvailableFrom(toDateTimeInput(quiz.settings?.availableFrom));
    setAvailableTo(toDateTimeInput(quiz.settings?.availableTo));
    // `window.startDeadline` rather than the setting, so a quiz still carrying
    // the older "minutes after opening" margin opens the toggle already on,
    // showing the moment that margin actually works out to.
    const cutOff = quiz.settings?.startDeadline || quiz.window?.startDeadline;
    setLimitEntry(Boolean(cutOff));
    setStartDeadline(toDateTimeInput(cutOff));
    // The results question is unanswered until a teacher answers it, and a
    // quiz that has never been published has never been asked. An already
    // published paper carries its own answer: a release time means "at a set
    // time", and its absence means the teacher published once already knowing
    // marks appear on submit.
    const releaseTime = quiz.settings?.resultReleaseAt;
    setResultsMode(releaseTime ? 'scheduled' : quiz.published ? 'immediate' : '');
    setResultReleaseAt(toDateTimeInput(releaseTime));
  }, [isOpen, quiz]);

  // Orderings that produce a quiz nobody can sit, or a result nobody can wait
  // for: a paper that opens before the link it lives behind exists, an entry
  // cut-off that has passed before either, or marks announced while students
  // are still writing. Caught here as well as on the server so the teacher sees
  // it while they are still looking at the fields.
  const cutOff = limitEntry ? startDeadline : '';
  const releaseAt = resultsMode === 'scheduled' ? resultReleaseAt : '';
  const startsBeforePublished = Boolean(
    publishAt && availableFrom && new Date(availableFrom) < new Date(publishAt),
  );
  const closesTooEarly = Boolean(
    cutOff &&
      ((availableFrom && new Date(cutOff) < new Date(availableFrom)) ||
        (publishAt && new Date(cutOff) < new Date(publishAt))),
  );
  const missingCutOff = limitEntry && !startDeadline;
  const resultsBeforeClose = Boolean(
    releaseAt && availableTo && new Date(releaseAt) < new Date(availableTo),
  );
  const missingRelease = resultsMode === 'scheduled' && !resultReleaseAt;
  // Publishing is the moment a cohort is committed to a result policy, and a
  // default chosen by the dialog is not the teacher's answer. So the question
  // has no pre-selected option and the button stays shut until it is answered.
  // Saving the quiz elsewhere is unaffected — only publishing needs the answer.
  const unanswered = !resultsMode;
  const outOfOrder =
    startsBeforePublished ||
    closesTooEarly ||
    missingCutOff ||
    resultsBeforeClose ||
    missingRelease ||
    unanswered;

  const submit = async () => {
    setSaving(true);
    try {
      const result = await lmApi.publishQuiz(classId, quiz._id, {
        publish: true,
        publishAt: publishAt || null,
        availableFrom: availableFrom || null,
        availableTo: availableTo || null,
        startDeadline: cutOff || null,
        resultReleaseAt: releaseAt || null,
      });
      setLink(result.link);
      await onPublished?.();
    } catch (error) {
      toast({ status: 'error', title: 'Could not publish', description: error.message });
    } finally {
      setSaving(false);
    }
  };

  if (!quiz) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" scrollBehavior="inside">
      <ModalOverlay />
      <ModalContent>
        <ModalHeader>{link ? 'Published' : `Publish "${quiz.title}"`}</ModalHeader>
        <ModalCloseButton />
        <ModalBody>
          {link ? (
            <>
              <Alert status="success" borderRadius="md" mb={4}>
                <AlertIcon />
                <Box>
                  <Text fontWeight="600">
                    {publishAt ? `Scheduled for ${formatDateTime(publishAt)}` : 'Live now'}
                  </Text>
                  <Text fontSize="sm">
                    {availableFrom
                      ? `Students can start from ${formatDateTime(availableFrom)} — until then the link shows the instructions and a countdown.`
                      : 'Students can start as soon as they open the link.'}
                  </Text>
                  {cutOff && (
                    <Text fontSize="sm">
                      Nobody may begin after {formatDateTime(cutOff)}.
                    </Text>
                  )}
                  {availableTo && (
                    <Text fontSize="sm">The paper closes {formatDateTime(availableTo)}.</Text>
                  )}
                  <Text fontSize="sm">
                    {releaseAt
                      ? `Results are announced ${formatDateTime(releaseAt)} — you can release them earlier from the results page.`
                      : 'Each student sees their result as soon as they submit.'}
                  </Text>
                </Box>
              </Alert>

              <FormLabel fontSize="sm">Share this link</FormLabel>
              <HStack>
                <Input value={url} isReadOnly fontSize="sm" onFocus={(event) => event.target.select()} />
                <Button onClick={onCopy} colorScheme={hasCopied ? 'green' : 'blue'} flexShrink={0}>
                  {hasCopied ? '✓ Copied' : 'Copy'}
                </Button>
              </HStack>
              <Text fontSize="xs" color="gray.500" mt={2}>
                It opens the test in fullscreen. Anyone in the class can use it; nobody outside can.
              </Text>
            </>
          ) : (
            <>
              <ClockRow
                step="1"
                title="Link goes live"
                subtitle="When the quiz appears in the class and the link starts answering. Nothing starts yet."
                action={
                  publishAt ? (
                    <Button size="xs" variant="outline" onClick={() => setPublishAt('')}>
                      Publish now instead
                    </Button>
                  ) : (
                    <Badge colorScheme="green" borderRadius="full" px={2}>
                      ✓ Publishing now
                    </Badge>
                  )
                }
              >
                <Input
                  type="datetime-local"
                  maxW="260px"
                  value={publishAt}
                  onChange={(event) => setPublishAt(event.target.value)}
                />
                <FormHelperText fontSize="xs">
                  {publishAt
                    ? 'Scheduled. Clear this box — or press "Publish now instead" — to put it up the moment you publish.'
                    : 'Empty means now: the class sees it as soon as you press Publish.'}
                </FormHelperText>
              </ClockRow>

              <ClockRow
                step="2"
                title="Students can start"
                subtitle="When the Start button unlocks. Before this the link shows the instructions and a countdown."
                isInvalid={startsBeforePublished}
              >
                <Input
                  type="datetime-local"
                  maxW="260px"
                  value={availableFrom}
                  onChange={(event) => setAvailableFrom(event.target.value)}
                />
                <FormHelperText fontSize="xs">
                  Leave blank to let them start straight away.
                </FormHelperText>
              </ClockRow>

              {/* The two closing times, deliberately adjacent. They answer
                  different questions — "who may still walk in" and "when does
                  the room shut" — and reading them side by side is the only way
                  the difference is obvious. */}
              <ClockRow
                step="3"
                title="Last time to start (latecomers turned away)"
                subtitle="Nobody may begin after this. Students already sitting the paper keep their full time and finish normally."
                isInvalid={closesTooEarly || missingCutOff}
                action={
                  <HStack spacing={2}>
                    <Switch
                      id="limit-entry"
                      size="sm"
                      isChecked={limitEntry}
                      onChange={(event) => setLimitEntry(event.target.checked)}
                    />
                    <Text fontSize="xs" color="gray.500">
                      {limitEntry ? 'On' : 'Off — anyone may begin while it is open'}
                    </Text>
                  </HStack>
                }
              >
                {limitEntry && (
                  <Input
                    type="datetime-local"
                    maxW="260px"
                    value={startDeadline}
                    onChange={(event) => setStartDeadline(event.target.value)}
                  />
                )}
              </ClockRow>

              <ClockRow
                step="4"
                title="Test closes (paper ends for everyone)"
                subtitle="After this nobody can open the paper, and any sitting still running is submitted. It is also the due date on the class stream."
              >
                <Input
                  type="datetime-local"
                  maxW="260px"
                  value={availableTo}
                  onChange={(event) => setAvailableTo(event.target.value)}
                />
                <FormHelperText fontSize="xs">
                  Leave blank for a paper with no closing time.
                </FormHelperText>
              </ClockRow>

              <Divider mb={5} />

              <ClockRow
                step="5"
                title="Results announced"
                subtitle="When students see their score and the answers. They are notified, and the subject stays marked on their class card until they have read it."
                isInvalid={resultsBeforeClose || missingRelease || unanswered}
                action={
                  unanswered ? (
                    <Badge colorScheme="orange" borderRadius="full" px={2}>
                      Answer required
                    </Badge>
                  ) : null
                }
              >
                <RadioGroup
                  value={resultsMode}
                  onChange={(value) => {
                    setResultsMode(value);
                    // A cohort released together is almost always released
                    // after the paper shuts, so that is the offered start.
                    if (value === 'scheduled' && !resultReleaseAt) {
                      setResultReleaseAt(availableTo || nowForInput());
                    }
                  }}
                >
                  <Stack spacing={2}>
                    <Radio value="immediate">
                      <Text fontSize="sm">As each student submits</Text>
                      <Text fontSize="xs" color="gray.600">
                        Their score appears on the last page of their own paper.
                      </Text>
                    </Radio>
                    <Radio value="scheduled">
                      <Text fontSize="sm">At a set time, for the whole class together</Text>
                      <Text fontSize="xs" color="gray.600">
                        Nobody sees a mark until then, however early they finish.
                      </Text>
                    </Radio>
                  </Stack>
                </RadioGroup>
                {resultsMode === 'scheduled' && (
                  <Box mt={3}>
                    <Input
                      type="datetime-local"
                      maxW="260px"
                      value={resultReleaseAt}
                      onChange={(event) => setResultReleaseAt(event.target.value)}
                    />
                    <FormHelperText fontSize="xs">
                      You can always release them sooner — the results page has a “Publish results
                      now” button that overrides this.
                    </FormHelperText>
                  </Box>
                )}
              </ClockRow>

              {startsBeforePublished && (
                <Alert status="error" borderRadius="md" mt={4} fontSize="sm">
                  <AlertIcon />
                  The quiz would start before it is published. Move the start time later, or publish
                  earlier.
                </Alert>
              )}
              {closesTooEarly && (
                <Alert status="error" borderRadius="md" mt={4} fontSize="sm">
                  <AlertIcon />
                  Entry would close before the quiz opens, so nobody could ever begin. Move the
                  cut-off later.
                </Alert>
              )}
              {missingCutOff && (
                <Alert status="warning" borderRadius="md" mt={4} fontSize="sm">
                  <AlertIcon />
                  Set the time after which nobody may begin, or switch the cut-off off.
                </Alert>
              )}
              {resultsBeforeClose && (
                <Alert status="error" borderRadius="md" mt={4} fontSize="sm">
                  <AlertIcon />
                  Results would be announced while the test is still open, so anyone still writing
                  could read the answers. Announce them after it closes.
                </Alert>
              )}
              {missingRelease && (
                <Alert status="warning" borderRadius="md" mt={4} fontSize="sm">
                  <AlertIcon />
                  Set the time the results are announced, or choose to show each student their score
                  as they submit.
                </Alert>
              )}
              {unanswered && (
                <Alert status="warning" borderRadius="md" mt={4} fontSize="sm">
                  <AlertIcon />
                  Choose when results are announced (step 5) before publishing. Everything else on
                  this paper can be changed afterwards; when a class first sees its marks cannot.
                </Alert>
              )}
            </>
          )}
        </ModalBody>
        <ModalFooter gap={2}>
          <Button variant={link ? 'solid' : 'ghost'} onClick={onClose}>
            {link ? 'Done' : 'Cancel'}
          </Button>
          {!link && (
            <Button colorScheme="green" onClick={submit} isLoading={saving} isDisabled={outOfOrder}>
              {publishAt ? 'Schedule & get link' : 'Publish now & get link'}
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
