import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Checkbox,
  Flex,
  FormControl,
  FormLabel,
  HStack,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Select,
  Text,
  useToast,
} from '@chakra-ui/react';
import lmApi from '../api/lmApi';
import { EmptyState, ErrorState, Loading } from './common';

/**
 * Taking questions out of another subject.
 *
 * Three narrowing choices — which class, which paper, which questions — because
 * that is how a teacher actually remembers where a question is ("the entropy
 * one, in the Sem 4 mid-sem"). They are stacked in one dialog rather than a
 * wizard: the picks are cheap to change and a teacher hunting for a question
 * needs to move between them freely.
 *
 * Never crosses type. A quiz imports quiz questions, a Short imports slides —
 * their shapes differ enough (a slide has a scale range, a tutorial question
 * has variables and formulas) that converting one to another would quietly drop
 * whatever had nowhere to go.
 *
 * @param {string} type    quiz | short | tutorial | notebook
 * @param {string} targetId  the item open in the editor — where copies land
 * @param {string} partLabel  what to call the questions, in this type's words
 */
export default function ImportQuestionsModal({
  isOpen,
  onClose,
  classId,
  type,
  targetId,
  partLabel = 'questions',
  onImported,
}) {
  const [sources, setSources] = useState(null);
  const [sourceId, setSourceId] = useState('');
  const [items, setItems] = useState([]);
  const [itemId, setItemId] = useState('');
  const [parts, setParts] = useState([]);
  const [picked, setPicked] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const toast = useToast();

  // The classes to choose from, once per opening.
  useEffect(() => {
    if (!isOpen) {
      setSources(null);
      setSourceId('');
      setItems([]);
      setItemId('');
      setParts([]);
      setPicked([]);
      setError(null);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    lmApi
      .importSources(classId, type)
      .then((list) => {
        if (cancelled) return;
        setSources(list);
        // Straight to the first class that actually holds something of this
        // type, so the dialog never opens on an empty list.
        const withSome = list.find((klass) => klass.items > 0);
        if (withSome) setSourceId(String(withSome._id));
      })
      .catch((err) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [isOpen, classId, type]);

  // The papers in the chosen class.
  useEffect(() => {
    setItems([]);
    setItemId('');
    if (!isOpen || !sourceId) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    lmApi
      .importItems(classId, sourceId, type)
      .then((list) => {
        if (cancelled) return;
        setItems(list);
        const withSome = list.find((item) => item.count > 0);
        if (withSome) setItemId(String(withSome._id));
      })
      .catch((err) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [isOpen, classId, sourceId, type]);

  const loadParts = useCallback(async () => {
    setPicked([]);
    if (!itemId) {
      setParts([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const fetched = await lmApi.importParts(classId, itemId, type);
      setParts(fetched.parts || []);
    } catch (err) {
      setError(err);
      setParts([]);
    } finally {
      setLoading(false);
    }
  }, [classId, itemId, type]);

  useEffect(() => {
    loadParts();
  }, [loadParts]);

  const toggle = (id) =>
    setPicked((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );

  const submit = async () => {
    setBusy(true);
    try {
      const outcome = await lmApi.importInto(classId, {
        type,
        sourceItemId: itemId,
        partIds: picked,
        targetId,
      });
      toast({
        status: 'success',
        title: `${outcome.imported} ${partLabel} imported`,
        description: `Added to the end of "${outcome.targetTitle}" as your own copies.`,
      });
      onClose();
      await onImported?.(outcome);
    } catch (err) {
      toast({ status: 'error', title: 'Could not import', description: err.message });
    } finally {
      setBusy(false);
    }
  };

  const noSources = sources && sources.length === 0;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl" scrollBehavior="inside">
      <ModalOverlay />
      <ModalContent>
        <ModalHeader>Import {partLabel} from another subject</ModalHeader>
        <ModalCloseButton />
        <ModalBody>
          <ErrorState error={error} onRetry={loadParts} />

          {noSources ? (
            <EmptyState
              icon="📭"
              title="No other classes to import from"
              description="You can import from any other class you teach or co-teach."
            />
          ) : (
            <>
              <HStack align="flex-start" spacing={3} mb={4}>
                <FormControl>
                  <FormLabel fontSize="sm">From class</FormLabel>
                  <Select
                    size="sm"
                    value={sourceId}
                    onChange={(event) => setSourceId(event.target.value)}
                    placeholder={sources ? 'Select a class' : 'Loading…'}
                    isDisabled={!sources}
                  >
                    {(sources || []).map((klass) => (
                      <option key={klass._id} value={klass._id}>
                        {[klass.name, klass.section].filter(Boolean).join(' · ')} — {klass.items}
                      </option>
                    ))}
                  </Select>
                </FormControl>
                <FormControl>
                  <FormLabel fontSize="sm">From</FormLabel>
                  <Select
                    size="sm"
                    value={itemId}
                    onChange={(event) => setItemId(event.target.value)}
                    placeholder={items.length ? 'Select one' : 'Nothing in that class'}
                    isDisabled={!items.length}
                  >
                    {items.map((item) => (
                      <option key={item._id} value={item._id}>
                        {item.title} ({item.count})
                      </option>
                    ))}
                  </Select>
                </FormControl>
              </HStack>

              {loading ? (
                <Loading label="Loading…" />
              ) : (
                itemId && (
                  <Box>
                    <Flex justify="space-between" align="center" mb={2} gap={2} wrap="wrap">
                      <Text fontSize="sm" fontWeight="600">
                        {parts.length} available · {picked.length} selected
                      </Text>
                      {parts.length > 0 && (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            setPicked(
                              picked.length === parts.length ? [] : parts.map((part) => String(part._id)),
                            )
                          }
                        >
                          {picked.length === parts.length ? 'Clear all' : 'Select all'}
                        </Button>
                      )}
                    </Flex>

                    {parts.length === 0 ? (
                      <EmptyState
                        icon="🗂"
                        title={`No ${partLabel} in there`}
                        description="Pick a different one above."
                      />
                    ) : (
                      <Box borderWidth="1px" borderColor="gray.200" borderRadius="md" maxH="340px" overflowY="auto">
                        {parts.map((part, index) => {
                          const id = String(part._id);
                          const isPicked = picked.includes(id);
                          return (
                            <Flex
                              key={id}
                              px={3}
                              py={2}
                              gap={3}
                              align="flex-start"
                              borderBottomWidth="1px"
                              borderColor="gray.100"
                              bg={isPicked ? 'blue.50' : undefined}
                            >
                              <Checkbox mt={1} isChecked={isPicked} onChange={() => toggle(id)} />
                              <Text fontSize="xs" color="gray.400" mt={1} w="22px" flexShrink={0}>
                                {index + 1}
                              </Text>
                              <Box flex="1" minW={0}>
                                <Text fontSize="sm" noOfLines={2}>
                                  {part.title}
                                </Text>
                                <Badge colorScheme="gray" fontSize="0.6rem">
                                  {part.note}
                                </Badge>
                              </Box>
                            </Flex>
                          );
                        })}
                      </Box>
                    )}

                    <Alert status="info" borderRadius="md" mt={4} fontSize="sm">
                      <AlertIcon />
                      Copies are added to the end of what you have open, in this class. Editing them
                      never touches the original, and no marks, dates or student work come with them.
                    </Alert>
                  </Box>
                )
              )}
            </>
          )}
        </ModalBody>
        <ModalFooter gap={2}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button colorScheme="blue" onClick={submit} isLoading={busy} isDisabled={!picked.length}>
            Import {picked.length || ''}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
