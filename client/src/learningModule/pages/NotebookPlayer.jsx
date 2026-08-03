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
import { DeadlineCountdown, ErrorState, Loading } from '../components/common';
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

/**
 * A cell's identity for as long as this page is open.
 *
 * Deliberately not the `_id`: a cell the student adds has no `_id` until a save
 * comes back with one, so anything keyed on `_id` — a run writing its output
 * back, the busy spinner, React's reconciliation — loses track of the cell at
 * exactly the moment the save lands.
 */
let keySeq = 0;
const clientKey = () => `cell-${(keySeq += 1)}`;
const withKeys = (cells) => (cells || []).map((cell) => ({ ...cell, key: clientKey() }));

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

  const revisionRef = useRef(0);
  const saveTimer = useRef(null);
  // Set while a save is in flight so the debounce does not stack requests.
  const savingRef = useRef(false);
  const dirtyRef = useRef(false);
  // The hidden-setup run, kept as the promise rather than a flag so a second
  // caller waits for the first instead of racing it.
  const setupRef = useRef(null);
  // scheduleSave is defined below save() but save() needs to re-arm it.
  const scheduleSaveRef = useRef(() => {});

  const packages = useMemo(() => notebook?.packages || [], [notebook]);
  // Scanned for imports at kernel start. The hidden setup counts: it runs first
  // and is exactly the place a notebook does its `import numpy`.
  const sources = useMemo(
    () => [...hiddenSetup, ...cells.map((cell) => cell.source)],
    [hiddenSetup, cells],
  );
  const lateSubmission =
    Boolean(notebook?.dueDate && attempt?.submittedAt) &&
    new Date(attempt.submittedAt) > new Date(notebook.dueDate);
  const { status, detail, busyCellId, start, restart, runCell, stop } = usePyodide(packages, sources);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await lmApi.notebookAttempt(classId, notebookId);
      setNotebook(data.notebook);
      setAttempt(data.attempt);
      setCells(withKeys(data.attempt.cells));
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

  // One debounce for the whole document. `cells` is read at fire time rather
  // than captured, so a burst of edits saves once with the latest content.
  const cellsRef = useRef(cells);
  cellsRef.current = cells;

  /**
   * Folds the stored cells back into local state instead of replacing it.
   *
   * The ids have to be adopted — a cell the student added has none until the
   * server assigns one, and without it the next save would store a duplicate.
   * But adopting the whole array throws away everything that happened while the
   * request was on the wire: keystrokes typed since, and the output of a cell
   * still running, which is written back against the id this call just changed.
   */
  const adoptServerCells = useCallback((serverCells, sent) => {
    const stored = serverCells || [];
    const byId = new Map(stored.map((cell) => [String(cell._id), cell]));
    const claimed = new Set();
    const matches = new Map();

    // Cells the server already knew about pair up on id.
    sent.forEach((cell) => {
      if (!cell._id) return;
      const match = byId.get(String(cell._id));
      if (!match) return;
      matches.set(cell.key, match);
      claimed.add(String(match._id));
    });

    // What is left over lines up in order with the cells we sent without an id:
    // the server stores the payload in the order it arrived.
    const fresh = stored.filter((cell) => !claimed.has(String(cell._id)));
    let next = 0;
    sent.forEach((cell) => {
      if (cell._id || next >= fresh.length) return;
      matches.set(cell.key, fresh[next]);
      next += 1;
    });

    const sentByKey = new Map(sent.map((cell) => [cell.key, cell]));

    setCells((current) =>
      current.map((cell) => {
        const match = matches.get(cell.key);
        if (!match) return cell;
        return {
          ...cell,
          _id: match._id,
          locked: match.locked,
          // The server rewrites a locked cell's source back to the teacher's and
          // truncates an oversized one, so its copy wins — unless the student
          // has typed since this save left, in which case theirs is newer.
          source: cell.source === sentByKey.get(cell.key)?.source ? match.source : cell.source,
        };
      }),
    );
  }, []);

  const save = useCallback(async () => {
    if (submitted) return;
    if (savingRef.current) {
      // Already on the wire. Leave the document marked dirty so the save that is
      // running re-arms the debounce on its way out; returning quietly here is
      // how an edit made mid-request ends up never sent under a "saved" badge.
      dirtyRef.current = true;
      return;
    }

    const sent = cellsRef.current;
    savingRef.current = true;
    // Cleared here rather than in the debounce, so anything typed from this
    // point on is still recorded as unsaved — it is not in `sent`.
    dirtyRef.current = false;
    setSaveState('saving');

    let saved = false;
    try {
      const result = await lmApi.saveNotebookAttempt(classId, attempt._id, {
        revision: revisionRef.current,
        cells: sent,
      });
      revisionRef.current = result.revision;
      adoptServerCells(result.cells, sent);
      saved = true;
      setSaveState(dirtyRef.current ? 'unsaved' : 'saved');
    } catch (err) {
      // Still dirty either way: the server did not take this content.
      dirtyRef.current = true;
      if (err.payload?.code === 'STALE_REVISION') {
        setSaveState('conflict');
      } else {
        setSaveState('error');
        toast({ status: 'error', title: err.message, duration: 3000 });
      }
    } finally {
      savingRef.current = false;
      // Only after a success: retrying a rejected save on a timer would spin
      // against a server that has already said no.
      if (saved && dirtyRef.current) scheduleSaveRef.current();
    }
  }, [adoptServerCells, classId, attempt, submitted, toast]);

  const scheduleSave = useCallback(() => {
    if (submitted) return;
    dirtyRef.current = true;
    // A conflict is not cleared by typing — the other tab's copy is still newer,
    // and hiding the warning would let the student write over it.
    setSaveState((current) => (current === 'conflict' ? current : 'unsaved'));
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(save, AUTOSAVE_MS);
  }, [save, submitted]);

  scheduleSaveRef.current = scheduleSave;

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

  /** `patch` may be a function of the current cell, for counters and the like. */
  const patchCell = useCallback((key, patch) => {
    setCells((current) =>
      current.map((cell) =>
        cell.key === key ? { ...cell, ...(typeof patch === 'function' ? patch(cell) : patch) } : cell,
      ),
    );
  }, []);

  /** Replays the teacher's hidden setup into a fresh kernel, once. */
  const ensureSetup = useCallback(() => {
    if (!hiddenSetup.length) return Promise.resolve();
    if (!setupRef.current) {
      setupRef.current = (async () => {
        for (const source of hiddenSetup) {
          // Sequential on purpose: setup cells depend on each other in order.
          // eslint-disable-next-line no-await-in-loop
          await runCell('__setup__', source, () => {});
        }
      })().catch((err) => {
        // Setup that failed has not run, so the next cell should try again
        // rather than execute against a half-built namespace.
        setupRef.current = null;
        throw err;
      });
    }
    return setupRef.current;
  }, [hiddenSetup, runCell]);

  const executeCell = useCallback(
    async (cell) => {
      if (status !== 'ready') {
        toast({ status: 'info', title: 'Python is still starting.', duration: 2000 });
        return;
      }

      // Clear last run's output first, so a cell that now prints less does not
      // leave the old tail on screen looking like part of this run.
      const collected = [];
      patchCell(cell.key, { outputs: [] });

      const push = (output) => {
        collected.push(output);
        patchCell(cell.key, { outputs: [...collected] });
      };

      try {
        await ensureSetup();
        const { result, error: runError } = await runCell(cell.key, cell.source, push);
        if (runError) collected.push({ type: 'error', text: runError });
        else if (result !== null && result !== undefined) collected.push({ type: 'result', text: result });

        patchCell(cell.key, (current) => ({
          outputs: [...collected],
          executedAt: new Date().toISOString(),
          runCount: (current.runCount || 0) + 1,
        }));
        scheduleSave();
      } catch (err) {
        patchCell(cell.key, { outputs: [{ type: 'error', text: err.message }] });
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
    setupRef.current = null;
    restart();
    setCells((current) => current.map((cell) => ({ ...cell, runCount: 0 })));
  }, [restart]);

  // Stop terminates the worker, so the setup that ran in it is gone too — and
  // with it every variable the ticks were vouching for. Same reset as a
  // restart, or the notebook would look run against a kernel that no longer
  // exists.
  const stopKernel = useCallback(() => {
    setupRef.current = null;
    stop();
    setCells((current) => current.map((cell) => ({ ...cell, runCount: 0 })));
  }, [stop]);

  /* ──────────────────────────── editing cells ─────────────────────────── */

  const addCell = (type) => {
    // No `_id`: the server assigns one, and `key` is what this page tracks the
    // cell by until it does.
    setCells((current) => [...current, { key: clientKey(), type, source: '', outputs: [], runCount: 0 }]);
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
    // eslint-disable-next-line no-alert
    if (!window.confirm('Submit this notebook? You will not be able to edit it afterwards.')) return;
    // Only once they have committed — cancelling out of the prompt must not
    // discard a save that was already due.
    clearTimeout(saveTimer.current);
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
            {/* A live counter rather than a date, and dropped once they have
                turned it in — a clock still ticking down on submitted work
                reads as though something is still owed. */}
            {!submitted && <DeadlineCountdown dueDate={notebook.dueDate} />}
            {submitted ? (
              <Badge colorScheme={lateSubmission ? 'orange' : 'green'}>
                submitted {formatDateTime(attempt.submittedAt)}
                {lateSubmission ? ' · after the deadline' : ''}
              </Badge>
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
                <Button size="sm" colorScheme="red" leftIcon={<FiSquare />} onClick={stopKernel}>
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
            key={cell.key}
            cell={cell}
            index={index}
            total={cells.length}
            readOnly={submitted}
            running={busyCellId === cell.key}
            canRun={status === 'ready' && !busyCellId}
            onChange={(patch) => {
              patchCell(cell.key, patch);
              scheduleSave();
            }}
            onRun={() => executeCell(cell)}
            onStop={stopKernel}
            onMove={(delta) => moveCell(index, delta)}
            onDelete={() => {
              setCells((current) => current.filter((entry) => entry.key !== cell.key));
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
