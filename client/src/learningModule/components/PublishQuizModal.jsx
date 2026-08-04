import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  AlertIcon,
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
  Switch,
  Text,
  useClipboard,
  useToast,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import { formatDateTime, toDateTimeInput } from '../format';

/**
 * Publishing, with its two clocks.
 *
 * When the link goes live and when the paper opens are separate questions, and
 * both have to be answerable: a cohort needs the link — and the instructions
 * behind it — in hand before the test starts, while a link handed out at the
 * moment the clock starts is a link half the room opens late. So publishing
 * takes a publish time and a start time, and hands back the link either way.
 *
 * Shared by the quiz list and the editor so the two entry points cannot drift
 * into setting different things.
 */
export default function PublishQuizModal({ isOpen, onClose, quiz, classId, onPublished }) {
  const [publishAt, setPublishAt] = useState('');
  const [availableFrom, setAvailableFrom] = useState('');
  const [availableTo, setAvailableTo] = useState('');
  const [limitEntry, setLimitEntry] = useState(false);
  const [startDeadline, setStartDeadline] = useState('');
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
  }, [isOpen, quiz]);

  // Orderings that produce a quiz nobody can sit: a paper that opens before the
  // link it lives behind exists, or an entry cut-off that has passed before
  // either. Caught here as well as on the server so the teacher sees it while
  // they are still looking at the fields.
  const cutOff = limitEntry ? startDeadline : '';
  const startsBeforePublished = Boolean(
    publishAt && availableFrom && new Date(availableFrom) < new Date(publishAt),
  );
  const closesTooEarly = Boolean(
    cutOff &&
      ((availableFrom && new Date(cutOff) < new Date(availableFrom)) ||
        (publishAt && new Date(cutOff) < new Date(publishAt))),
  );
  const missingCutOff = limitEntry && !startDeadline;
  const outOfOrder = startsBeforePublished || closesTooEarly || missingCutOff;

  const submit = async () => {
    setSaving(true);
    try {
      const result = await lmApi.publishQuiz(classId, quiz._id, {
        publish: true,
        publishAt: publishAt || null,
        availableFrom: availableFrom || null,
        availableTo: availableTo || null,
        startDeadline: cutOff || null,
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
    <Modal isOpen={isOpen} onClose={onClose} size="lg">
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
                      Entry closes {formatDateTime(cutOff)}; nobody may begin after that.
                    </Text>
                  )}
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
              <FormControl mb={4}>
                <FormLabel fontSize="sm">1 · Publish at</FormLabel>
                <Input
                  type="datetime-local"
                  maxW="260px"
                  value={publishAt}
                  onChange={(event) => setPublishAt(event.target.value)}
                />
                <FormHelperText fontSize="xs">
                  When the link starts answering and the quiz appears in the class. Leave blank to
                  publish now.
                </FormHelperText>
              </FormControl>

              <FormControl mb={4} isInvalid={startsBeforePublished}>
                <FormLabel fontSize="sm">2 · Students can start at</FormLabel>
                <Input
                  type="datetime-local"
                  maxW="260px"
                  value={availableFrom}
                  onChange={(event) => setAvailableFrom(event.target.value)}
                />
                <FormHelperText fontSize="xs">
                  Until then the link shows the instructions and a countdown, with the Start button
                  locked. Leave blank to let them start straight away.
                </FormHelperText>
              </FormControl>

              {/* The third clock is optional in a way the other two are not, so
                  it is behind a switch: most quizzes want anyone to be able to
                  begin while the paper is open, and an entry cut-off left on by
                  accident turns students away for good. */}
              <FormControl mb={4} isInvalid={closesTooEarly || missingCutOff}>
                <Flex align="center" gap={3}>
                  <Switch
                    id="limit-entry"
                    isChecked={limitEntry}
                    onChange={(event) => setLimitEntry(event.target.checked)}
                  />
                  <FormLabel htmlFor="limit-entry" fontSize="sm" mb={0}>
                    3 · Close entry after a set time
                  </FormLabel>
                </Flex>
                {limitEntry ? (
                  <Box mt={3}>
                    <Input
                      type="datetime-local"
                      maxW="260px"
                      value={startDeadline}
                      onChange={(event) => setStartDeadline(event.target.value)}
                    />
                    <FormHelperText fontSize="xs">
                      Nobody may begin after this. Students already sitting the paper keep their full
                      time and finish normally.
                    </FormHelperText>
                  </Box>
                ) : (
                  <FormHelperText fontSize="xs" ml="52px" mt={1}>
                    Off — anyone may begin at any point while the quiz is open.
                  </FormHelperText>
                )}
              </FormControl>

              <Divider mb={4} />

              <FormControl>
                <FormLabel fontSize="sm">Closes at (optional)</FormLabel>
                <Input
                  type="datetime-local"
                  maxW="260px"
                  value={availableTo}
                  onChange={(event) => setAvailableTo(event.target.value)}
                />
                <FormHelperText fontSize="xs">
                  After this nobody can open the paper. It also becomes the due date on the class
                  stream.
                </FormHelperText>
              </FormControl>

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
            </>
          )}
        </ModalBody>
        <ModalFooter gap={2}>
          <Button variant={link ? 'solid' : 'ghost'} onClick={onClose}>
            {link ? 'Done' : 'Cancel'}
          </Button>
          {!link && (
            <Button colorScheme="green" onClick={submit} isLoading={saving} isDisabled={outOfOrder}>
              {publishAt ? 'Schedule & get link' : 'Publish & get link'}
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
