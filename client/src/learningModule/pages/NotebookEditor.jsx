import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Checkbox,
  Divider,
  Flex,
  FormControl,
  FormHelperText,
  FormLabel,
  HStack,
  Heading,
  Input,
  Switch,
  Text,
  Textarea,
  Tooltip,
  VStack,
  useToast,
} from '@chakra-ui/react';

import lmApi from '../api/lmApi';
import { ErrorState, Loading, SectionCard } from '../components/common';
import NotebookCell from '../components/NotebookCell';
import usePyodide from '../hooks/usePyodide';

/**
 * Authoring a coding notebook.
 *
 * The teacher can run cells here too, against the same in-browser kernel the
 * students get — which is the only honest way to check a worksheet works, since
 * "works on my machine with my Python" is exactly what this feature exists to
 * avoid.
 */

const newCell = (type) => ({
  _id: `new-${Math.random().toString(36).slice(2)}`,
  type,
  source: '',
  locked: false,
  hidden: false,
  outputs: [],
  runCount: 0,
});

export default function NotebookEditor() {
  const { classId } = useOutletContext();
  const { notebookId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [notebook, setNotebook] = useState(null);
  const [cells, setCells] = useState([]);
  const [packagesText, setPackagesText] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState([]);
  const [setupDone, setSetupDone] = useState(false);

  const cellsRef = useRef(cells);
  cellsRef.current = cells;

  const { status, detail, busyCellId, start, restart, runCell, stop } = usePyodide(
    notebook?.packages || [],
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const loaded = await lmApi.getNotebook(classId, notebookId);
      setNotebook(loaded);
      setCells((loaded.cells || []).map((cell) => ({ ...cell, outputs: [], runCount: 0 })));
      setPackagesText((loaded.packages || []).join(', '));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [classId, notebookId]);

  useEffect(() => {
    load();
  }, [load]);

  const patchCell = (cellId, patch) =>
    setCells((current) =>
      current.map((cell) => (String(cell._id) === String(cellId) ? { ...cell, ...patch } : cell)),
    );

  const moveCell = (index, delta) =>
    setCells((current) => {
      const to = index + delta;
      if (to < 0 || to >= current.length) return current;
      const next = [...current];
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });

  /** Runs hidden setup first, exactly as a student's kernel will. */
  const executeCell = async (cell) => {
    if (status !== 'ready') {
      toast({ status: 'info', title: 'Start Python first.', duration: 2000 });
      return;
    }
    if (!setupDone) {
      for (const setup of cellsRef.current.filter((entry) => entry.hidden && entry.type === 'code')) {
        // eslint-disable-next-line no-await-in-loop
        await runCell('__setup__', setup.source, () => {});
      }
      setSetupDone(true);
    }

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
      patchCell(cell._id, { outputs: [...collected], runCount: (cell.runCount || 0) + 1 });
    } catch (err) {
      patchCell(cell._id, { outputs: [{ type: 'error', text: err.message }] });
    }
  };

  const save = async ({ thenPublish = false } = {}) => {
    setSaving(true);
    setProblems([]);
    try {
      await lmApi.updateNotebook(classId, notebookId, {
        title: notebook.title,
        description: notebook.description,
        settings: notebook.settings,
        packages: packagesText.split(',').map((name) => name.trim()).filter(Boolean),
        cells: cells.map((cell, order) => ({
          // A `new-…` placeholder must not be sent as an _id; Mongo mints the
          // real one and the reload below picks it up.
          _id: String(cell._id).startsWith('new-') ? undefined : cell._id,
          type: cell.type,
          source: cell.source,
          locked: cell.locked,
          hidden: cell.hidden,
          order,
        })),
      });

      if (thenPublish) {
        await lmApi.publishNotebook(classId, notebookId, { publish: true });
        toast({ status: 'success', title: 'Saved and published' });
      } else {
        toast({ status: 'success', title: 'Saved' });
      }
      await load();
    } catch (err) {
      setProblems(err.payload?.errors || [err.message]);
      toast({ status: 'error', title: err.message });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loading label="Loading notebook…" />;
  if (error) return <ErrorState error={error} onRetry={load} />;

  const setSetting = (key, value) =>
    setNotebook((current) => ({ ...current, settings: { ...current.settings, [key]: value } }));

  return (
    <VStack align="stretch" spacing={5}>
      <Flex gap={3} wrap="wrap" align="center">
        <Heading size="md" flex="1">
          Edit notebook
        </Heading>
        <Button size="sm" variant="ghost" onClick={() => navigate(`/learning/class/${classId}/notebooks`)}>
          Back
        </Button>
        {status === 'idle' || status === 'failed' ? (
          <Button size="sm" variant="outline" onClick={start}>
            Start Python
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setSetupDone(false);
              restart();
            }}
          >
            Restart Python
          </Button>
        )}
        <Button size="sm" onClick={() => save()} isLoading={saving}>
          Save
        </Button>
        <Button size="sm" colorScheme="purple" onClick={() => save({ thenPublish: true })} isLoading={saving}>
          Save &amp; publish
        </Button>
      </Flex>

      {detail ? (
        <Alert status={status === 'failed' ? 'error' : 'info'} borderRadius="md" py={2} fontSize="sm">
          <AlertIcon />
          {detail}
        </Alert>
      ) : null}

      {problems.length > 0 && (
        <Alert status="warning" borderRadius="md" alignItems="flex-start">
          <AlertIcon />
          <VStack align="stretch" spacing={0} fontSize="sm">
            {problems.map((problem) => (
              <Text key={problem}>{problem}</Text>
            ))}
          </VStack>
        </Alert>
      )}

      <SectionCard title="Notebook">
        <VStack align="stretch" spacing={3}>
          <FormControl>
            <FormLabel fontSize="sm">Title</FormLabel>
            <Input value={notebook.title} onChange={(e) => setNotebook({ ...notebook, title: e.target.value })} />
          </FormControl>

          <FormControl>
            <FormLabel fontSize="sm">Description</FormLabel>
            <Textarea
              rows={2}
              value={notebook.description || ''}
              placeholder="What the student is working through."
              onChange={(e) => setNotebook({ ...notebook, description: e.target.value })}
            />
          </FormControl>

          <FormControl>
            <FormLabel fontSize="sm">Packages</FormLabel>
            <Input
              value={packagesText}
              placeholder="numpy, pandas, matplotlib"
              onChange={(e) => setPackagesText(e.target.value)}
            />
            <FormHelperText fontSize="xs">
              Installed into the browser kernel before the notebook runs. numpy, pandas, matplotlib, scipy,
              sympy and scikit-learn have prebuilt WebAssembly builds; a package needing a C extension that has
              not been built for the browser will not install.
            </FormHelperText>
          </FormControl>

          <Divider />

          <FormControl display="flex" alignItems="flex-start" gap={3}>
            <Switch
              mt={1}
              isChecked={notebook.settings?.allowAddCells !== false}
              onChange={(e) => setSetting('allowAddCells', e.target.checked)}
            />
            <Box>
              <FormLabel mb={0} fontSize="sm">
                Let students add their own cells
              </FormLabel>
              <Text fontSize="xs" opacity={0.6}>
                Off makes it a fixed worksheet.
              </Text>
            </Box>
          </FormControl>

          <FormControl display="flex" alignItems="flex-start" gap={3}>
            <Switch
              mt={1}
              isChecked={Boolean(notebook.settings?.showSolutionAfterSubmit)}
              onChange={(e) => setSetting('showSolutionAfterSubmit', e.target.checked)}
            />
            <Box>
              <FormLabel mb={0} fontSize="sm">
                Show your version after they submit
              </FormLabel>
              <Text fontSize="xs" opacity={0.6}>
                Your cell sources appear under their work once it is handed in.
              </Text>
            </Box>
          </FormControl>
        </VStack>
      </SectionCard>

      <VStack align="stretch" spacing={3}>
        {cells.map((cell, index) => (
          <Box key={cell._id}>
            {cell.type === 'code' && (
              <HStack spacing={4} mb={1} px={1}>
                <Tooltip label="The student can run it but not edit it — imports and scaffolding">
                  <Checkbox
                    size="sm"
                    isChecked={cell.locked}
                    onChange={(e) => patchCell(cell._id, { locked: e.target.checked })}
                  >
                    <Text fontSize="xs">Locked</Text>
                  </Checkbox>
                </Tooltip>
                <Tooltip label="Runs before their cells but is never shown — data setup, helper functions">
                  <Checkbox
                    size="sm"
                    isChecked={cell.hidden}
                    onChange={(e) => patchCell(cell._id, { hidden: e.target.checked })}
                  >
                    <Text fontSize="xs">Hidden setup</Text>
                  </Checkbox>
                </Tooltip>
                {cell.hidden && (
                  <Badge colorScheme="orange" fontSize="2xs">
                    not shown to students
                  </Badge>
                )}
              </HStack>
            )}
            <NotebookCell
              cell={cell}
              index={index}
              total={cells.length}
              running={String(busyCellId) === String(cell._id)}
              canRun={status === 'ready' && !busyCellId}
              onChange={(patch) => patchCell(cell._id, patch)}
              onRun={() => executeCell(cell)}
              onStop={stop}
              onMove={(delta) => moveCell(index, delta)}
              onDelete={() => setCells((current) => current.filter((entry) => entry._id !== cell._id))}
            />
          </Box>
        ))}
      </VStack>

      <HStack>
        <Button size="sm" variant="outline" onClick={() => setCells((c) => [...c, newCell('code')])}>
          + Code cell
        </Button>
        <Button size="sm" variant="outline" onClick={() => setCells((c) => [...c, newCell('markdown')])}>
          + Text cell
        </Button>
      </HStack>
    </VStack>
  );
}
