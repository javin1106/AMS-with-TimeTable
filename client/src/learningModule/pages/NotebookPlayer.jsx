import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Heading,
  Text,
  VStack,
  useColorModeValue,
  useToast,
} from '@chakra-ui/react';
import { FiFastForward, FiPlay, FiRefreshCw, FiSquare } from 'react-icons/fi';

import lmApi from '../api/lmApi';
import { ErrorState, Loading } from '../components/common';
import NotebookCell from '../components/NotebookCell';
import RichText from '../components/RichText';
import usePyodide from '../hooks/usePyodide';
import { formatDateTime } from '../format';

/**
 * A student working through a coding notebook.
 *
 * Python runs in this tab, not on the server — see `usePyodide` for why. The
 * consequences show up here: the kernel has to be started explicitly (it is a
 * multi-megabyte download nobody should pay for by accident), and "Stop" is a
 * restart rather than an interrupt.
 *
 * Autosave is on a debounce rather than on every keystroke. A notebook is
 * hundreds of lines across dozens of cells; saving per character would be a
 * request per keypress carrying the whole document.
 */

const AUTOSAVE_MS = 2500;

export default function NotebookPlayer() {
  const { classId, isTeacher } = useOutletContext();
  const { notebookId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [notebook, setNotebook] = useState(null);
  const [attempt, setAttempt] = useState(null);
  const [cells, setCells] = useState([]);
  const [hiddenSetup, setHiddenSetup] = useState([]);
  const [solution, setSolution] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saveState, setSaveState] = useState('saved');
  const [setupDone, setSetupDone] = useState(false);

  const revisionRef = useRef(0);
  const saveTimer = useRef(null);
  // Set while a save is in flight so the debounce does not stack requests.
  const savingRef = useRef(false);
  const dirtyRef = useRef(false);

  const packages = useMemo(() => notebook?.packages || [], [notebook]);
  const { status, detail, busyCellId, start, restart, runCell, stop } = usePyodide(packages);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await lmApi.notebookAttempt(classId, notebookId);
      setNotebook(data.notebook);
      setAttempt(data.attempt);
      setCells(data.attempt.cells || []);
      setHiddenSetup(data.hiddenSetup || []);
      setSolution(data.solution);
      revisionRef.current = data.attempt.revision || 0;
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId, notebookId]);

  useEffect(() => {
    load();
  }, [load]);

  const submitted = Boolean(attempt?.submittedAt);

  /* ───────────────────────────── autosave ─────────────────────────────── */

  const save = useCallback(
    async (payload) => {
      if (savingRef.current || submitted) return;
      savingRef.current = true;
      setSaveState('saving');
      try {
        const result = await lmApi.saveNotebookAttempt(classId, attempt._id, {
          revision: revisionRef.current,
          cells: payload,
        });
        revisionRef.current = result.revision;
        // Adopt the server's cells: a cell the student added has no id until it
        // is stored, and without this the next save would create a duplicate.
        setCells(result.cells);
        setSaveState(dirtyRef.current ? 'unsaved' : 'saved');
      } catch (err) {
        if (err.payload?.code === 'STALE_REVISION') {
          setSaveState('conflict');
        } else {
          setSaveState('error');
          toast({ status: 'error', title: err.message, duration: 3000 });
        }
      } finally {
        savingRef.current = false;
      }
    },
    [classId, attempt, submitted, toast],
  );

  // One debounce for the whole document. `cells` is read at fire time rather
  // than captured, so a burst of edits saves once with the latest content.
  const cellsRef = useRef(cells);
  cellsRef.current = cells;

  const scheduleSave = useCallback(() => {
    if (submitted) return;
    dirtyRef.current = true;
    setSaveState('unsaved');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      dirtyRef.current = false;
      save(cellsRef.current);
    }, AUTOSAVE_MS);
  }, [save, submitted]);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  // Last line of defence against losing work to a closed tab. Cannot await, so
  // it is a best-effort flag rather than a guarantee — the debounce above is
  // what actually protects the work.
  useEffect(() => {
    const onBeforeUnload = (event) => {
      if (saveState === 'saved' || submitted) return undefined;
      event.preventDefault();
      event.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [saveState, submitted]);

  /* ─────────────────────────── running cells ──────────────────────────── */

  const patchCell = useCallback((cellId, patch) => {
    setCells((current) =>
      current.map((cell) => (String(cell._id) === String(cellId) ? { ...cell, ...patch } : cell)),
    );
  }, []);

  /** Replays the teacher's hidden setup into a fresh kernel, once. */
  const ensureSetup = useCallback(async () => {
    if (setupDone || !hiddenSetup.length) return;
    for (const source of hiddenSetup) {
      // Sequential on purpose: setup cells depend on each other in order.
      // eslint-disable-next-line no-await-in-loop
      await runCell('__setup__', source, () => {});
    }
    setSetupDone(true);
  }, [hiddenSetup, runCell, setupDone]);

  const executeCell = useCallback(
    async (cell) => {
      if (status !== 'ready') {
        toast({ status: 'info', title: 'Python is still starting.', duration: 2000 });
        return;
      }
      await ensureSetup();

      // Clear last run's output first, so a cell that now prints less does not
      // leave the old tail on screen looking like part of this run.
      const collected = [];
      patchCell(cell._id, { outputs: [] });

      const push = (output) => {
        collected.push(output);
        patchCell(cell._id, { outputs: [...collected] });
      };

      try {
        const { result, error: runError } = await runCell(cell._id, cell.source, push);
        if (runError) collected.push({ type: 'error', text: runError });
        else if (result !== null && result !== undefined) collected.push({ type: 'result', text: result });

        patchCell(cell._id, {
          outputs: [...collected],
          executedAt: new Date().toISOString(),
          runCount: (cell.runCount || 0) + 1,
        });
        scheduleSave();
      } catch (err) {
        patchCell(cell._id, { outputs: [{ type: 'error', text: err.message }] });
      }
    },
    [ensureSetup, patchCell, runCell, scheduleSave, status, toast],
  );

  const runAll = useCallback(async () => {
    if (status !== 'ready') return;
    for (const cell of cellsRef.current) {
      if (cell.type !== 'code' || !cell.source.trim()) continue;
      // Sequential because a notebook's cells share one namespace and order is
      // the whole contract.
      // eslint-disable-next-line no-await-in-loop
      await executeCell(cell);
    }
  }, [executeCell, status]);

  const restartKernel = useCallback(() => {
    setSetupDone(false);
    restart();
    setCells((current) => current.map((cell) => ({ ...cell, runCount: 0 })));
  }, [restart]);

  /* ──────────────────────────── editing cells ─────────────────────────── */

  const addCell = (type) => {
    setCells((current) => [
      ...current,
      { _id: `new-${Math.random().toString(36).slice(2)}`, type, source: '', outputs: [], runCount: 0 },
    ]);
    scheduleSave();
  };

  const moveCell = (index, delta) => {
    setCells((current) => {
      const to = index + delta;
      if (to < 0 || to >= current.length) return current;
      const next = [...current];
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });
    scheduleSave();
  };

  const submit = async () => {
    clearTimeout(saveTimer.current);
    // eslint-disable-next-line no-alert
    if (!window.confirm('Submit this notebook? You will not be able to edit it afterwards.')) return;
    try {
      await lmApi.submitNotebookAttempt(classId, attempt._id, { cells: cellsRef.current });
      toast({ status: 'success', title: 'Submitted' });
      await load();
    } catch (err) {
      toast({ status: 'error', title: err.message });
    }
  };

  const cardBg = useColorModeValue('white', 'gray.800');

  if (loading) return <Loading label="Opening the notebook…" />;
  if (error) return <ErrorState error={error} onRetry={load} />;

  const kernelBadge =
    { idle: ['gray', 'not started'], loading: ['yellow', 'starting'], ready: ['green', 'ready'], failed: ['red', 'failed'] }[
      status
    ] || ['gray', status];

  return (
    <VStack align="stretch" spacing={4}>
      <Flex gap={3} wrap="wrap" align="flex-start">
        <Box flex="1" minW="220px">
          <Heading size="md">{notebook.title}</Heading>
          {notebook.description ? (
            <Box fontSize="sm" opacity={0.75} mt={1}>
              <RichText>{notebook.description}</RichText>
            </Box>
          ) : null}
          <HStack spacing={2} mt={2} wrap="wrap">
            <Badge colorScheme={kernelBadge[0]}>Python {kernelBadge[1]}</Badge>
            {notebook.packages?.length ? <Badge>{notebook.packages.join(', ')}</Badge> : null}
            {notebook.dueDate ? <Badge colorScheme="orange">due {formatDateTime(notebook.dueDate)}</Badge> : null}
            {submitted ? (
              <Badge colorScheme="green">submitted {formatDateTime(attempt.submittedAt)}</Badge>
            ) : (
              <Badge
                colorScheme={
                  { saved: 'gray', saving: 'blue', unsaved: 'yellow', conflict: 'red', error: 'red' }[saveState]
                }
              >
                {{
                  saved: 'saved',
                  saving: 'saving…',
                  unsaved: 'unsaved changes',
                  conflict: 'open in another tab',
                  error: 'save failed',
                }[saveState]}
              </Badge>
            )}
          </HStack>
        </Box>

        <HStack spacing={2} wrap="wrap">
          {status === 'idle' || status === 'failed' ? (
            <Button size="sm" colorScheme="green" leftIcon={<FiPlay />} onClick={start}>
              Start Python
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                leftIcon={<FiFastForward />}
                onClick={runAll}
                isDisabled={status !== 'ready' || Boolean(busyCellId)}
              >
                Run all
              </Button>
              <Button size="sm" variant="outline" leftIcon={<FiRefreshCw />} onClick={restartKernel}>
                Restart
              </Button>
              {busyCellId ? (
                <Button size="sm" colorScheme="red" leftIcon={<FiSquare />} onClick={stop}>
                  Stop
                </Button>
              ) : null}
            </>
          )}
        </HStack>
      </Flex>

      {detail ? (
        <Alert status={status === 'failed' ? 'error' : 'info'} borderRadius="md" py={2} fontSize="sm">
          <AlertIcon />
          {detail}
        </Alert>
      ) : null}

      {status === 'idle' && (
        <Alert status="info" borderRadius="md" fontSize="sm">
          <AlertIcon />
          <Box>
            <Text fontWeight="600">Python runs in this browser tab.</Text>
            <Text>
              Nothing to install, and your code never leaves your machine to run — but the first start downloads
              a few megabytes, so it is worth doing on a decent connection.
            </Text>
          </Box>
        </Alert>
      )}

      {saveState === 'conflict' && (
        <Alert status="warning" borderRadius="md" fontSize="sm">
          <AlertIcon />
          <Box flex="1">
            This notebook was changed in another tab. Reload to pick up the newer copy — saving from here would
            overwrite it.
          </Box>
          <Button size="xs" onClick={load}>
            Reload
          </Button>
        </Alert>
      )}

      {submitted && (
        <Alert status="success" borderRadius="md" fontSize="sm">
          <AlertIcon />
          <Box flex="1">
            Submitted on {formatDateTime(attempt.submittedAt)}. You can still run cells to explore — nothing more
            will be saved.
          </Box>
        </Alert>
      )}

      <VStack align="stretch" spacing={3}>
        {cells.map((cell, index) => (
          <NotebookCell
            key={cell._id}
            cell={cell}
            index={index}
            total={cells.length}
            readOnly={submitted}
            running={String(busyCellId) === String(cell._id)}
            canRun={status === 'ready' && !busyCellId}
            onChange={(patch) => {
              patchCell(cell._id, patch);
              scheduleSave();
            }}
            onRun={() => executeCell(cell)}
            onStop={stop}
            onMove={(delta) => moveCell(index, delta)}
            onDelete={() => {
              setCells((current) => current.filter((entry) => String(entry._id) !== String(cell._id)));
              scheduleSave();
            }}
          />
        ))}
      </VStack>

      {!submitted && notebook.settings?.allowAddCells !== false && (
        <HStack>
          <Button size="sm" variant="outline" onClick={() => addCell('code')}>
            + Code cell
          </Button>
          <Button size="sm" variant="outline" onClick={() => addCell('markdown')}>
            + Text cell
          </Button>
        </HStack>
      )}

      {solution ? (
        <Box bg={cardBg} borderWidth="1px" borderRadius="lg" p={4}>
          <Heading size="sm" mb={3}>
            Your teacher&apos;s version
          </Heading>
          <VStack align="stretch" spacing={2}>
            {solution.map((cell) => (
              <Box key={cell._id} borderWidth="1px" borderRadius="md" p={3} fontSize="sm">
                {cell.type === 'markdown' ? (
                  <RichText>{cell.source}</RichText>
                ) : (
                  <Box as="pre" fontFamily="mono" fontSize="13px" whiteSpace="pre-wrap" m={0}>
                    {cell.source}
                  </Box>
                )}
              </Box>
            ))}
          </VStack>
        </Box>
      ) : null}

      <Flex gap={2} wrap="wrap">
        <Button size="sm" variant="ghost" onClick={() => navigate(`/learning/class/${classId}/notebooks`)}>
          Back to notebooks
        </Button>
        <Box flex="1" />
        {isTeacher && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => navigate(`/learning/class/${classId}/notebook/${notebookId}/submissions`)}
          >
            See submissions
          </Button>
        )}
        {!submitted && (
          <Button size="sm" colorScheme="purple" onClick={submit}>
            Submit
          </Button>
        )}
      </Flex>
    </VStack>
  );
}
