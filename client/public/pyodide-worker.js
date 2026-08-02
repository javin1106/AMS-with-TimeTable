/* eslint-env worker */
/* global loadPyodide */

/**
 * The Python kernel for coding notebooks.
 *
 * CPython compiled to WebAssembly (Pyodide), running in a Web Worker in the
 * student's own browser. Nothing here touches the server — which is the point:
 * executing arbitrary student Python server-side would be a remote-code-execution
 * surface, and this platform has no container sandboxing to put behind one.
 *
 * A worker rather than the main thread because Python here is synchronous and
 * blocking. `while True: pass` on the main thread freezes the whole tab
 * including the Stop button; in a worker it freezes only the kernel, and the
 * page can terminate it.
 *
 * Served from /public rather than bundled: it needs `importScripts` to pull the
 * Pyodide runtime, which a module worker cannot do.
 *
 * ── protocol ──────────────────────────────────────────────────────────────
 * in:  { type: 'init', indexURL, packages: [], sources: [] }
 *        `packages` are PyPI names installed with micropip; `sources` are the
 *        notebook's cells, scanned so anything Pyodide already ships a wheel
 *        for is fetched up front without being declared at all.
 *      { type: 'run', id, code }
 * out: { type: 'status', phase, detail }
 *      { type: 'stream', id, stream: 'stdout'|'stderr', text }
 *      { type: 'image', id, text }            base64 PNG
 *      { type: 'done', id, result, error, ms }
 */

let pyodide = null;
let ready = false;
let running = false;

const post = (message) => self.postMessage(message);

/** Batches stdout so a tight print loop does not post ten thousand messages. */
function makeStream(id, stream) {
  let buffer = '';
  let timer = null;

  const flush = () => {
    if (!buffer) return;
    post({ type: 'stream', id, stream, text: buffer });
    buffer = '';
    timer = null;
  };

  return {
    write(text) {
      buffer += text;
      // Flush early on a big burst so long-running output still streams in
      // rather than arriving all at once at the end.
      if (buffer.length > 8192) {
        clearTimeout(timer);
        flush();
        return;
      }
      if (!timer) timer = setTimeout(flush, 60);
    },
    close() {
      clearTimeout(timer);
      flush();
    },
  };
}

/**
 * Makes matplotlib usable without a display.
 *
 * The Agg backend renders to a buffer instead of a window, and `plt.show` is
 * redirected to hand that buffer back as a base64 PNG. Without this a student's
 * first plot silently does nothing, which reads as "my code is wrong".
 */
const MATPLOTLIB_SHIM = `
import base64, io, js

def _lm_install_matplotlib_hook():
    try:
        import matplotlib
    except ImportError:
        # Not loaded yet. An import in a later cell can pull it in, so the
        # caller retries rather than treating this as settled.
        return False
    matplotlib.use("AGG", force=True)
    import matplotlib.pyplot as plt

    def _lm_show(*args, **kwargs):
        for num in plt.get_fignums():
            figure = plt.figure(num)
            buffer = io.BytesIO()
            figure.savefig(buffer, format="png", bbox_inches="tight", dpi=110)
            js._lm_emit_image(base64.b64encode(buffer.getvalue()).decode())
        plt.close("all")

    plt.show = _lm_show
    return True

_lm_install_matplotlib_hook()
`;

/**
 * Installs the matplotlib hook, retrying on later cells until it takes.
 *
 * It used to run once at startup and give up quietly if matplotlib was not
 * there. Now that an `import matplotlib.pyplot` in any cell can load it, the
 * hook has to be installed at that point too — otherwise the plot renders to a
 * buffer nobody reads and the student's chart just never appears.
 */
let matplotlibHooked = false;
async function installMatplotlibHook() {
  if (matplotlibHooked || !pyodide) return;
  try {
    matplotlibHooked = Boolean(await pyodide.runPythonAsync(MATPLOTLIB_SHIM));
  } catch {
    // Nothing to recover: the next cell tries again.
  }
}

/**
 * Every import in the notebook, gathered into one synthetic snippet.
 *
 * Import *lines* rather than whole cells: a cell need not parse on its own — a
 * half-finished edit, or a block continued in the next cell — and the import
 * scanner needs something parseable. An import line with its indentation
 * stripped always is. Continuation forms (`from x import (`) are dropped rather
 * than repaired; the per-cell load catches those when the cell actually runs.
 */
const IMPORT_LINE = /^\s*(?:import|from)\s+[A-Za-z0-9_.]+\s/;
const importProbe = (sources) => [
  ...new Set(
    (sources || [])
      .flatMap((source) => String(source || '').split('\n'))
      .map((line) => line.trim())
      .filter((line) => IMPORT_LINE.test(`${line} `) && !/[(,\\]$/.test(line)),
  ),
].join('\n');

async function init(indexURL, packages, sources) {
  post({ type: 'status', phase: 'loading', detail: 'Downloading the Python runtime…' });

  importScripts(`${indexURL}pyodide.js`);
  pyodide = await loadPyodide({ indexURL });

  // Fetch the bundled wheels the notebook needs — numpy, pandas, matplotlib and
  // the rest — while the student is already waiting for the kernel, instead of
  // stalling whichever cell first says `import numpy`. Declaring them is no
  // longer required for anything Pyodide ships; the packages list is for PyPI
  // names it does not.
  const probe = importProbe(sources);
  if (probe) {
    try {
      await pyodide.loadPackagesFromImports(probe, {
        messageCallback: (text) => post({ type: 'status', phase: 'loading', detail: text }),
        errorCallback: () => {},
      });
    } catch (error) {
      // Not fatal, and not worth reporting: a package that could not be fetched
      // here is retried when its own cell runs, and fails there with a message
      // that names it.
    }
  }

  if (packages && packages.length) {
    post({ type: 'status', phase: 'loading', detail: `Installing ${packages.join(', ')}…` });
    try {
      // loadPackage handles anything with a prebuilt wasm wheel (numpy, pandas,
      // matplotlib, scipy…); micropip covers pure-Python packages from PyPI.
      await pyodide.loadPackage('micropip');
      const micropip = pyodide.pyimport('micropip');
      await micropip.install(packages);
    } catch (error) {
      // A missing package is not fatal — the notebook may still be most of the
      // way usable, and the student should see which one failed.
      post({ type: 'status', phase: 'warning', detail: `Could not install: ${error.message}` });
    }
  }

  await installMatplotlibHook();

  ready = true;
  post({ type: 'status', phase: 'ready', detail: '' });
}

async function run(id, code) {
  if (!ready) {
    post({ type: 'done', id, error: 'The Python kernel is still starting.', ms: 0 });
    return;
  }
  if (running) {
    post({ type: 'done', id, error: 'Another cell is still running.', ms: 0 });
    return;
  }

  running = true;
  const startedAt = Date.now();
  const stdout = makeStream(id, 'stdout');
  const stderr = makeStream(id, 'stderr');

  self._lm_emit_image = (text) => post({ type: 'image', id, text });

  pyodide.setStdout({ batched: (text) => stdout.write(`${text}\n`) });
  pyodide.setStderr({ batched: (text) => stderr.write(`${text}\n`) });

  let result = null;
  let error = null;

  // Pyodide ships prebuilt wheels for numpy, pandas, matplotlib, scipy and
  // friends, but loads none of them until asked. Only the notebook's declared
  // `packages` were ever installed, so a cell that simply says `import numpy` —
  // the most ordinary line in a teaching notebook — failed with
  // ModuleNotFoundError against a runtime that had numpy sitting right there.
  // This resolves the imports in the cell about to run and loads what it can.
  //
  // Outside the run's own try: a loader that cannot fetch a wheel must not
  // replace the error Python is about to raise. `ModuleNotFoundError: No module
  // named 'numpy'` names the package; "failed to fetch" does not.
  try {
    await pyodide.loadPackagesFromImports(code, {
      messageCallback: (text) => post({ type: 'status', phase: 'loading', detail: text }),
      errorCallback: (text) => post({ type: 'status', phase: 'warning', detail: text }),
    });
    // Clear the loader line. `phase: 'loading'` only ever sets the detail text,
    // so this does not disturb the kernel's ready state.
    post({ type: 'status', phase: 'loading', detail: '' });
    await installMatplotlibHook();
  } catch (thrown) {
    post({ type: 'status', phase: 'warning', detail: `Could not load imports: ${thrown.message || thrown}` });
  }

  try {
    const value = await pyodide.runPythonAsync(code);
    // A notebook shows the value of the last expression. `undefined` means the
    // cell ended in a statement, which should print nothing at all — as opposed
    // to `None`, which a student may have asked for explicitly.
    if (value !== undefined) {
      result = pyodide.globals.get('repr')(value);
      if (value?.destroy) value.destroy();
    }
  } catch (thrown) {
    error = String(thrown.message || thrown);
  } finally {
    stdout.close();
    stderr.close();
    running = false;
  }

  post({ type: 'done', id, result, error, ms: Date.now() - startedAt });
}

self.onmessage = async (event) => {
  const { type } = event.data || {};
  try {
    if (type === 'init') await init(event.data.indexURL, event.data.packages, event.data.sources);
    else if (type === 'run') await run(event.data.id, event.data.code);
  } catch (error) {
    post({ type: 'status', phase: 'failed', detail: String(error.message || error) });
  }
};
