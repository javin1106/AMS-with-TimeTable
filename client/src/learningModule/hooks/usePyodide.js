import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Owns the Python kernel for a notebook page.
 *
 * The runtime is fetched from a CDN at first use rather than bundled: the
 * Pyodide core is several megabytes of WebAssembly, and putting that in the app
 * bundle would slow every page in the platform down to pay for one. The URL is
 * an env var so it can be pointed at a self-hosted copy for a campus network
 * that blocks the CDN, or for offline use.
 *
 * Stopping a run means terminating the worker. There is no gentler option:
 * Pyodide's cooperative interrupt needs SharedArrayBuffer, which needs
 * cross-origin isolation headers this app does not send. So Stop is a kernel
 * restart, and the UI says so rather than pretending otherwise.
 */

const PYODIDE_URL =
  import.meta.env.VITE_PYODIDE_URL || 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';

/**
 * @param {string[]} [packages] PyPI names to install with micropip. Only needed
 *        for things Pyodide does not ship — numpy, pandas, matplotlib, scipy
 *        and friends are found by scanning `sources` and need no declaration.
 * @param {string[]} [sources]  the notebook's cell sources, read at kernel
 *        start so their imports are fetched during the startup wait rather
 *        than stalling the first cell that needs one.
 */
export default function usePyodide(packages = [], sources = []) {
  // 'idle' until something actually needs Python — a notebook that is only
  // being read should not pull ten megabytes.
  const [status, setStatus] = useState('idle');
  const [detail, setDetail] = useState('');
  const [busyCellId, setBusyCellId] = useState(null);
  // What the live kernel was actually started with, which is not the same as
  // `packages` the moment someone edits the list: installs happen at startup
  // only. A caller that can change the list mid-session needs to be able to see
  // the difference and offer a restart, rather than letting the notebook fail
  // on an import it believes it has already declared.
  const [kernelPackages, setKernelPackages] = useState(null);

  const workerRef = useRef(null);
  // Resolver for the run currently in flight, keyed so a stale worker's late
  // message cannot resolve a newer run.
  const pendingRef = useRef(null);
  const packagesRef = useRef(packages);
  packagesRef.current = packages;
  // Read at start/restart rather than captured, so a kernel started after the
  // notebook loads still sees the cells it has to scan.
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  const teardown = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    if (pendingRef.current) {
      pendingRef.current.reject(new Error('The kernel was stopped.'));
      pendingRef.current = null;
    }
    setBusyCellId(null);
    setKernelPackages(null);
  }, []);

  useEffect(() => teardown, [teardown]);

  const spawn = useCallback(() => {
    // BASE_URL keeps this working when the app is served from a sub-path.
    const worker = new Worker(`${import.meta.env.BASE_URL}pyodide-worker.js`);
    workerRef.current = worker;

    worker.onmessage = (event) => {
      const message = event.data || {};
      const pending = pendingRef.current;

      if (message.type === 'status') {
        if (message.phase === 'ready') {
          setStatus('ready');
          setDetail('');
        } else if (message.phase === 'failed') {
          setStatus('failed');
          setDetail(message.detail);
          teardown();
        } else {
          // 'warning' keeps the kernel usable — a package that would not install
          // is worth saying, but not worth refusing to run over.
          setDetail(message.detail);
        }
        return;
      }

      if (!pending || pending.id !== message.id) return;

      if (message.type === 'stream') {
        pending.onOutput({ type: message.stream, text: message.text });
      } else if (message.type === 'image') {
        pending.onOutput({ type: 'image', text: message.text });
      } else if (message.type === 'done') {
        pendingRef.current = null;
        setBusyCellId(null);
        pending.resolve({ result: message.result, error: message.error, ms: message.ms });
      }
    };

    worker.onerror = (event) => {
      setStatus('failed');
      setDetail(event.message || 'The Python kernel crashed.');
      teardown();
    };

    return worker;
  }, [teardown]);

  /** Starts the kernel. Safe to call repeatedly; only the first does work. */
  const start = useCallback(() => {
    if (workerRef.current) return;
    setStatus('loading');
    setDetail('Starting Python…');
    const worker = spawn();
    setKernelPackages([...packagesRef.current]);
    worker.postMessage({
      type: 'init',
      indexURL: PYODIDE_URL,
      packages: packagesRef.current,
      sources: sourcesRef.current,
    });
  }, [spawn]);

  /** Throws away the kernel and starts a clean one — the notebook "restart". */
  const restart = useCallback(() => {
    teardown();
    setStatus('loading');
    setDetail('Restarting Python…');
    const worker = spawn();
    setKernelPackages([...packagesRef.current]);
    worker.postMessage({
      type: 'init',
      indexURL: PYODIDE_URL,
      packages: packagesRef.current,
      sources: sourcesRef.current,
    });
  }, [spawn, teardown]);

  /**
   * Runs one cell.
   *
   * `onOutput` is called as output arrives rather than only at the end, so a
   * long loop prints progressively the way it would in a terminal.
   */
  const runCell = useCallback(
    (cellId, code, onOutput) =>
      new Promise((resolve, reject) => {
        if (!workerRef.current) {
          reject(new Error('Python is not running yet.'));
          return;
        }
        if (pendingRef.current) {
          reject(new Error('Another cell is still running.'));
          return;
        }
        const id = `${cellId}:${Date.now()}`;
        pendingRef.current = { id, resolve, reject, onOutput };
        setBusyCellId(cellId);
        workerRef.current.postMessage({ type: 'run', id, code });
      }),
    [],
  );

  /** Kills whatever is running. The kernel goes with it; see the note above. */
  const stop = useCallback(() => {
    teardown();
    setStatus('idle');
    setDetail('Stopped. Variables from the previous run are gone.');
  }, [teardown]);

  return { status, detail, busyCellId, kernelPackages, start, restart, runCell, stop };
}
