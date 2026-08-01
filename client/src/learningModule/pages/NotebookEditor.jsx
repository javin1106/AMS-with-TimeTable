import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

import { FiUpload } from 'react-icons/fi';

import lmApi from '../api/lmApi';
import { ErrorState, Loading, SectionCard } from '../components/common';
import NotebookCell from '../components/NotebookCell';
import usePyodide from '../hooks/usePyodide';
import { MAX_IMPORT_CELLS, cellsFromFile } from '../notebookImport';

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
  // Which button is working: 'save' | 'publish' | null. One shared boolean put a
  // spinner on both of them at once, so a plain Save looked like it was
  // publishing too.
  const [savingAction, setSavingAction] = useState(null);
  const [problems, setProblems] = useState([]);
  const [setupDone, setSetupDone] = useState(false);

  // The buttons only disable once React has re-rendered, which is a tick later
  // than the click that started the save.
  const savingRef = useRef(false);

  const cellsRef = useRef(cells);
  cellsRef.current = cells;

  const fileInputRef = useRef(null);

  /**
   * The packages box, not the saved notebook.
   *
   * An import writes what the file declares and imports straight into this box,
   * and a teacher can type into it. Starting the kernel from `notebook.packages`
   * instead meant none of that reached Pyodide until a save *and* a restart, so
   * a freshly imported notebook raised ModuleNotFoundError on every cell while
   * the toast said the packages had been added.
   */
  const packages = useMemo(
    () => packagesText.split(',').map((name) => name.trim()).filter(Boolean),
    [packagesText],
  );

  const { status, detail, busyCellId, kernelPackages, start, restart, runCell, stop } =
    usePyodide(packages);

  // Installs happen once, at startup: a package added after that is not in the
  // running kernel however many times the cell is run.
  const missingFromKernel = kernelPackages
    ? packages.filter((name) => !kernelPackages.includes(name))
    : [];

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

  /**
   * Brings a `.py` or `.ipynb` file in as cells.
   *
   * Appended rather than replacing what is already here, and left unsaved: the
   * teacher decides what is locked, what is hidden setup and whether the split
   * came out right before any of it reaches a student.
   */
  const importFile = async (file) => {
    if (!file) return;
    const isIpynb = /\.ipynb$/i.test(file.name);

    try {
      const { cells: imported, truncated, marked, skipped, language, packages, magics } = cellsFromFile(
        file.name,
        await file.text(),
      );

      if (!imported.length) {
        toast({ status: 'warning', title: `${file.name} has nothing to import.`, duration: 4000 });
        return;
      }

      setCells((current) => [
        ...current,
        ...imported.map((cell) => ({ ...newCell(cell.type), source: cell.source })),
      ]);

      // Without this the cells import perfectly and then every one of them
      // raises ModuleNotFoundError, because the packages box is still empty.
      const existing = packagesText.split(',').map((name) => name.trim()).filter(Boolean);
      const added = packages.filter((name) => !existing.includes(name));
      if (added.length) setPackagesText([...existing, ...added].join(', '));

      const notes = [];
      // Say so rather than letting a one-cell import read as a failed split.
      if (!isIpynb && !marked) notes.push('There were no # %% markers, so it came in as a single cell.');
      if (skipped) notes.push(`${skipped} raw ${skipped === 1 ? 'cell' : 'cells'} could not be imported.`);
      if (magics) {
        notes.push(
          `${magics} Jupyter ${magics === 1 ? 'magic was' : 'magics were'} commented out — the browser kernel has no IPython.`,
        );
      }
      if (added.length) notes.push(`Added ${added.join(', ')} to Packages.`);
      if (truncated) notes.push(`Only the first ${MAX_IMPORT_CELLS} cells fit.`);
      notes.push('Outputs are not carried over. Save to keep the cells.');

      toast({
        status: 'success',
        title: `Imported ${imported.length} ${imported.length === 1 ? 'cell' : 'cells'} from ${file.name}`,
        description: notes.join(' '),
        duration: 7000,
      });

      // An R or Julia notebook imports perfectly cleanly and then fails on every
      // cell, because the kernel here only speaks Python. Worth its own warning.
      if (language && !/^python/i.test(language)) {
        toast({
          status: 'warning',
          title: `That notebook was written for ${language}.`,
          description: 'Cells here run against a Python kernel, so they will not work unmodified.',
          duration: 9000,
        });
      }
    } catch (err) {
      toast({ status: 'error', title: 'Could not import that file.', description: err.message });
    }
  };

  const save = async ({ thenPublish = false } = {}) => {
    // Two saves in flight against one notebook race each other: `cells` is
    // replaced wholesale server-side, so the slower response decides what the
    // notebook ends up containing.
    if (savingRef.current) return;
    savingRef.current = true;
    setSavingAction(thenPublish ? 'publish' : 'save');
    setProblems([]);

    // Publishing is a second request on top of the save, and it can be rejected
    // on its own (an empty text cell, say) after the save has already landed.
    let stored = false;
    try {
      await lmApi.updateNotebook(classId, notebookId, {
        title: notebook.title,
        description: notebook.description,
        settings: notebook.settings,
        packages,
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

      stored = true;

      if (thenPublish) {
        await lmApi.publishNotebook(classId, notebookId, { publish: true });
        toast({ status: 'success', title: 'Saved and published' });
      } else {
        toast({ status: 'success', title: 'Saved' });
      }
    } catch (err) {
      setProblems(err.payload?.errors || [err.message]);
      toast({ status: 'error', title: err.message });
    } finally {
      // Only once the save itself landed. Reloading after a *rejected* save
      // would throw away the very edits the teacher has to fix — but a publish
      // that failed on top of a save that worked still needs the reload, or the
      // editor keeps showing placeholder ids for cells the server has stored.
      if (stored) await load();
      savingRef.current = false;
      setSavingAction(null);
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
        <Button
          size="sm"
          onClick={() => save()}
          isLoading={savingAction === 'save'}
          isDisabled={Boolean(savingAction)}
        >
          Save
        </Button>
        <Button
          size="sm"
          colorScheme="purple"
          onClick={() => save({ thenPublish: true })}
          isLoading={savingAction === 'publish'}
          isDisabled={Boolean(savingAction)}
        >
          Save &amp; publish
        </Button>
      </Flex>

      {detail ? (
        <Alert status={status === 'failed' ? 'error' : 'info'} borderRadius="md" py={2} fontSize="sm">
          <AlertIcon />
          {detail}
        </Alert>
      ) : null}

      {missingFromKernel.length > 0 && (
        <Alert status="warning" borderRadius="md" py={2} fontSize="sm">
          <AlertIcon />
          <Box flex="1">
            Python is already running without {missingFromKernel.join(', ')}. Restart it to install{' '}
            {missingFromKernel.length === 1 ? 'that package' : 'those packages'}.
          </Box>
          <Button
            size="xs"
            ml={3}
            onClick={() => {
              setSetupDone(false);
              restart();
            }}
          >
            Restart &amp; install
          </Button>
        </Alert>
      )}

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

      <HStack wrap="wrap">
        <Button size="sm" variant="outline" onClick={() => setCells((c) => [...c, newCell('code')])}>
          + Code cell
        </Button>
        <Button size="sm" variant="outline" onClick={() => setCells((c) => [...c, newCell('markdown')])}>
          + Text cell
        </Button>

        <input
          ref={fileInputRef}
          type="file"
          accept=".py,.ipynb,text/x-python,application/x-ipynb+json"
          hidden
          data-testid="notebook-import"
          onChange={(event) => {
            importFile(event.target.files?.[0]);
            // Cleared so picking the same file again still fires a change.
            event.target.value = '';
          }}
        />
        <Tooltip label="A Jupyter notebook, or a script split on the # %% markers VS Code, Spyder and jupytext write">
          <Button
            size="sm"
            variant="outline"
            leftIcon={<FiUpload />}
            onClick={() => fileInputRef.current?.click()}
          >
            Import .ipynb / .py
          </Button>
        </Tooltip>
      </HStack>

      <Text fontSize="xs" opacity={0.6}>
        Importing adds cells to the end of this notebook, without their saved outputs. An{' '}
        <Box as="code">.ipynb</Box> already knows where its cells are; in a <Box as="code">.py</Box> put{' '}
        <Box as="code"># %%</Box> on its own line to start a new cell, or <Box as="code"># %% [markdown]</Box>{' '}
        for a text cell.
      </Text>
    </VStack>
  );
}
