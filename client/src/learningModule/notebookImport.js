/**
 * Turns a `.py` or `.ipynb` file into notebook cells.
 *
 * **`.py`** is split on the `# %%` convention rather than one invented here: it
 * is what VS Code, Spyder, PyCharm and jupytext all write, so a teacher who
 * keeps lecture code as a script can hand that file over unchanged. Files
 * exported the other way — `jupyter nbconvert --to script` — mark cells as
 * `# In[3]:` instead, so those are read too. A file with no markers becomes a
 * single cell rather than being chopped up on blank lines: guessing wrong
 * produces a notebook to repair by hand, which is worse than one cell the
 * teacher can split themselves.
 *
 * **`.ipynb`** already knows where its cells are, so nothing is guessed — it is
 * read as nbformat JSON. Outputs are dropped, because an authored notebook has
 * nowhere to put them; the student's own run is what fills them in.
 *
 * Pure, and separate from the editor, because the interesting failures are all
 * in the parsing: a docstring containing `# %%`, a markdown block that keeps its
 * comment hashes, an `.ipynb` whose `source` is a list of lines that already end
 * in newlines, an import that silently drops the file's last cell.
 */

// `# %%`, `#%%`, `# %% [markdown]`, `# %% Some title` — anything after the
// marker is a label in every tool that writes these, so only the tag matters.
const CELL_MARKER = /^[ \t]*#[ \t]*%%(.*)$/;
// `# In[1]:` / `# In[ ]:`, which is how nbconvert delimits a script.
const NBCONVERT_MARKER = /^[ \t]*#[ \t]*In\[[^\]]*\]:[ \t]*$/;
const MARKDOWN_TAG = /\[[ \t]*(markdown|md)[ \t]*\]/i;
const FENCE = /"""|'''/g;

/**
 * Follows triple-quoted strings so a `# %%` inside a docstring does not split
 * the file in half.
 *
 * Deliberately shallow: it tracks `"""` and `'''` and nothing else. That covers
 * the case that actually happens — a teacher's docstring quoting cell syntax —
 * and stops well short of pretending to be a Python lexer.
 */
const advanceFence = (line, fence) => {
  let open = fence;
  FENCE.lastIndex = 0;
  for (let match = FENCE.exec(line); match; match = FENCE.exec(line)) {
    if (!open) open = match[0];
    else if (open === match[0]) open = null;
  }
  return open;
};

// The server stores at most 200 cells; stopping here means an import that would
// be truncated says so instead of silently losing the tail.
export const MAX_IMPORT_CELLS = 200;

/** Drops blank lines from both ends without touching indentation inside. */
const trimBlankLines = (lines) => {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return lines.slice(start, end);
};

/**
 * Strips the comment prefix jupytext puts on every line of a markdown cell.
 *
 * `# ` rather than `#` so that `#### Heading` keeps three of its hashes — the
 * markdown heading level is the content, not the comment marker.
 */
const uncomment = (lines) => lines.map((line) => line.replace(/^[ \t]*#[ \t]?/, ''));

/* ──────────────────────── IPython magics and imports ────────────────────── */

/**
 * A notebook out of Jupyter or Colab is not a Python file.
 *
 * `%matplotlib inline`, `!pip install pandas`, `%%time` — IPython rewrites those
 * before CPython ever sees them. The kernel here is plain Pyodide calling
 * `runPythonAsync`, so an imported cell that opens with a magic dies on its
 * first line with a SyntaxError, which reads as "the import broke my notebook".
 *
 * So the magics come out at import time: installs become packages, the
 * matplotlib backend is dropped as redundant, and everything else is commented
 * rather than deleted — a teacher should be able to see what was taken out.
 */
const MAGIC = /^[ \t]*%{1,2}(\w+)(.*)$/;
const SHELL = /^[ \t]*!(.*)$/;
const INSTALL = /^[ \t]*(?:pip3?|python3?[ \t]+-m[ \t]+pip|conda|mamba)[ \t]+install[ \t]+(.*)$/;
const MAGIC_INSTALLER = /^(?:pip|conda|mamba)$/;
const IMPORT = /^[ \t]*(?:import|from)[ \t]+([A-Za-z_][\w.]*)/;

// `jupyter nbconvert --to script` does not leave magics as magics: it rewrites
// them into `get_ipython()` calls, which parse cleanly and then fail at runtime
// with a NameError. Same problem, later and more confusingly.
const IPYTHON_CALL = /^[ \t]*get_ipython\(\)[ \t]*\.[ \t]*(\w+)\((.*)\)[ \t]*$/;
const QUOTED = /'([^']*)'|"([^"]*)"/g;

const quotedArgs = (text) => {
  const args = [];
  QUOTED.lastIndex = 0;
  for (let match = QUOTED.exec(text); match; match = QUOTED.exec(text)) {
    args.push(match[1] ?? match[2]);
  }
  return args;
};

/** `-q pandas==1.5 "scikit-learn[extra]"` → `['pandas', 'scikit-learn']` */
const installArgs = (args) =>
  String(args)
    .split(/[ \t]+/)
    .filter((token) => token && !token.startsWith('-'))
    .map((token) => token.replace(/^["']|["']$/g, '').split(/[<>=!~,[\]]/)[0].trim())
    .filter(Boolean);

/**
 * Import names that are not what the package is called on PyPI. Only the ones
 * that actually turn up in teaching notebooks — a complete map is PyPI's job.
 */
const PACKAGE_ALIAS = {
  Bio: 'biopython',
  PIL: 'pillow',
  bs4: 'beautifulsoup4',
  cv2: 'opencv-python',
  dateutil: 'python-dateutil',
  mpl_toolkits: 'matplotlib',
  serial: 'pyserial',
  skimage: 'scikit-image',
  sklearn: 'scikit-learn',
  yaml: 'pyyaml',
};

/**
 * Standard library, which must never end up in the packages box — micropip
 * would go looking for it on PyPI and the install would fail for no reason.
 */
const STDLIB = new Set(
  `abc argparse ast asyncio base64 binascii bisect builtins calendar cmath collections colorsys
   contextlib copy csv ctypes dataclasses datetime decimal difflib enum fnmatch fractions
   functools gc getpass glob gzip hashlib heapq hmac html http importlib inspect io itertools
   json logging math mimetypes multiprocessing numbers operator os pathlib pickle platform
   pprint queue random re secrets shutil signal socket sqlite3 statistics string stringprep
   struct subprocess sys tempfile textwrap threading time timeit tkinter token tokenize
   traceback types typing unicodedata unittest urllib uuid warnings wave weakref xml zipfile
   zlib`.split(/\s+/),
);
// Provided by the runtime itself rather than installed.
const BUILT_IN = new Set(['js', 'pyodide', 'micropip', '__future__']);

/**
 * Rewrites one code cell for a plain-Python kernel.
 *
 * @returns {{source: string, packages: string[], magics: number}}
 */
export function stripMagics(source) {
  const out = [];
  const packages = [];
  let magics = 0;
  let fence = null;

  String(source).split('\n').forEach((line) => {
    // A triple-quoted string may legitimately contain a line starting with `%`
    // or `!`; rewriting those would corrupt the text.
    const inString = Boolean(fence);
    fence = advanceFence(line, fence);
    if (inString) {
      out.push(line);
      return;
    }

    // `!pip install x` is how a notebook declares a dependency; it becomes one.
    // Any other shell line is asking for an OS that is not there.
    const comment = () => {
      magics += 1;
      out.push(`# ${line.trim()}`);
    };
    const install = (args) => packages.push(...installArgs(args));

    const shell = SHELL.exec(line);
    if (shell) {
      const pip = INSTALL.exec(shell[1]);
      if (pip) install(pip[1]);
      else comment();
      return;
    }

    const ipython = IPYTHON_CALL.exec(line);
    if (ipython) {
      const args = quotedArgs(ipython[2]);
      // .system('pip install x') and .run_line_magic('pip', 'install x')
      const asShell = ipython[1] === 'system' ? INSTALL.exec(args[0] || '') : null;
      const asMagic =
        MAGIC_INSTALLER.test(args[0] || '') ? /^[ \t]*install[ \t]+(.*)$/.exec(args[1] || '') : null;

      if (asShell) install(asShell[1]);
      else if (asMagic) install(asMagic[1]);
      else if (args[0] === 'matplotlib') return;
      else comment();
      return;
    }

    const magic = MAGIC.exec(line);
    if (!magic) {
      out.push(line);
      return;
    }

    if (MAGIC_INSTALLER.test(magic[1])) {
      const pip = /^[ \t]*install[ \t]+(.*)$/.exec(magic[2]);
      if (pip) {
        install(pip[1]);
        return;
      }
    }
    // `%matplotlib inline` asks for exactly what the worker already sets up —
    // the Agg backend with `plt.show` redirected — so it is dropped rather than
    // commented, to avoid flagging something that is not actually missing.
    if (magic[1] === 'matplotlib') return;

    comment();
  });

  return { source: out.join('\n'), packages, magics };
}

/**
 * The third-party modules a set of cells imports.
 *
 * Nothing is installed on the teacher's behalf — the names are offered into the
 * packages box, where they can see and edit them before a student's kernel ever
 * tries to fetch one.
 */
export function scanImports(cells) {
  const found = new Set();

  cells.forEach((cell) => {
    if (cell.type !== 'code') return;
    let fence = null;
    cell.source.split('\n').forEach((line) => {
      const inString = Boolean(fence);
      fence = advanceFence(line, fence);
      if (inString) return;

      const match = IMPORT.exec(line);
      if (!match) return;
      // Only the top-level package: `matplotlib.pyplot` installs as matplotlib,
      // and a relative `from . import x` has no package to install at all.
      const root = match[1].split('.')[0];
      if (!root || STDLIB.has(root) || BUILT_IN.has(root)) return;
      found.add(PACKAGE_ALIAS[root] || root);
    });
  });

  return [...found].sort();
}

/**
 * The shape every parser here returns.
 *
 * @typedef {object} Import
 * @property {{type: string, source: string}[]} cells
 * @property {boolean} truncated  more cells in the file than a notebook holds
 * @property {boolean} marked     `.py` only: the file carried cell markers
 * @property {number}  skipped    `.ipynb` only: cells that were neither code nor prose
 * @property {?string} language   `.ipynb` only: the kernel the file was written for
 * @property {string[]} packages  what the cells import or ask pip to install
 * @property {number}  magics     IPython lines commented out to leave valid Python
 */

/**
 * Applies the shared cap, rewrites the code cells for a plain-Python kernel and
 * fills in the fields a given format does not use.
 */
const result = (cells, extra = {}) => {
  const declared = [];
  let magics = 0;

  const cleaned = cells.map((cell) => {
    if (cell.type !== 'code') return cell;
    const stripped = stripMagics(cell.source);
    declared.push(...stripped.packages);
    magics += stripped.magics;
    return { ...cell, source: stripped.source };
  });

  // A cell that was nothing but `!pip install …` has no code left in it.
  const kept = cleaned.filter((cell) => cell.source.trim());

  return {
    cells: kept.slice(0, MAX_IMPORT_CELLS),
    truncated: kept.length > MAX_IMPORT_CELLS,
    marked: false,
    skipped: 0,
    language: null,
    // Declared installs first: a notebook that pins its own dependency knows
    // something the import scan cannot see.
    packages: [...new Set([...declared, ...scanImports(kept)])],
    magics,
    ...extra,
  };
};

/**
 * @param {string} text raw file contents
 * @returns {Import}
 */
export function cellsFromPython(text) {
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');

  const chunks = [];
  // The preamble: a shebang, an encoding line or a block of imports sitting
  // above the first marker is still code the notebook needs.
  let current = { type: 'code', lines: [] };
  let marked = false;
  let fence = null;

  lines.forEach((line) => {
    const inString = Boolean(fence);
    fence = advanceFence(line, fence);

    const marker = inString ? null : CELL_MARKER.exec(line);
    const isBoundary = Boolean(marker) || (!inString && NBCONVERT_MARKER.test(line));
    if (!isBoundary) {
      current.lines.push(line);
      return;
    }

    marked = true;
    chunks.push(current);
    current = {
      type: marker && MARKDOWN_TAG.test(marker[1]) ? 'markdown' : 'code',
      lines: [],
    };
  });
  chunks.push(current);

  const cells = [];
  chunks.forEach((chunk) => {
    const body = trimBlankLines(chunk.lines);
    if (!body.length) return;
    const source = (chunk.type === 'markdown' ? trimBlankLines(uncomment(body)) : body).join('\n');
    // A markdown cell of nothing but empty comments has no content to show.
    if (!source.trim()) return;
    cells.push({ type: chunk.type, source });
  });

  return result(cells, { marked });
}

/* ─────────────────────────────── .ipynb ─────────────────────────────────── */

/**
 * `source` is either a string or a list of lines that **already end in `\n`**.
 *
 * Joining that list on `\n` is the classic way to import a notebook with a blank
 * line inserted between every line of every cell, so it is joined on nothing.
 */
const ipynbSource = (source) => {
  const text = Array.isArray(source) ? source.join('') : String(source ?? '');
  return trimBlankLines(text.replace(/\r\n?/g, '\n').split('\n')).join('\n');
};

/** nbformat 4 keeps cells at the top level; nbformat 3 nested them in sheets. */
const ipynbCells = (doc) => {
  if (Array.isArray(doc?.cells)) return doc.cells;
  if (Array.isArray(doc?.worksheets)) {
    return doc.worksheets.flatMap((sheet) => (Array.isArray(sheet?.cells) ? sheet.cells : []));
  }
  return null;
};

/**
 * @param {string} text the contents of an `.ipynb`
 * @returns {Import}
 * @throws if the file is not readable as a notebook — the caller shows the message
 */
export function cellsFromIpynb(text) {
  let doc;
  try {
    doc = JSON.parse(String(text ?? ''));
  } catch {
    throw new Error('That .ipynb is not valid JSON — it may be truncated or partly downloaded.');
  }

  const source = ipynbCells(doc);
  if (!source) throw new Error('That .ipynb has no cells in it.');

  const cells = [];
  let skipped = 0;

  source.forEach((cell) => {
    // 'raw' and nbformat 3's 'heading' are neither code nor prose. Counted
    // rather than dropped quietly, so the toast can account for every cell.
    const type = { code: 'code', markdown: 'markdown' }[cell?.cell_type];
    if (!type) {
      skipped += 1;
      return;
    }
    // Outputs are deliberately not carried over: an authored notebook has no
    // field for them, and a student should meet the cell unrun.
    const body = ipynbSource(cell.source);
    if (!body.trim()) return;
    cells.push({ type, source: body });
  });

  // Worth surfacing: an R or Julia notebook imports cleanly and then fails on
  // every cell, because the kernel here only speaks Python.
  const language =
    doc?.metadata?.language_info?.name || doc?.metadata?.kernelspec?.language || null;

  return result(cells, { skipped, language: language ? String(language) : null });
}

/** Picks the parser from the file name. */
export function cellsFromFile(fileName, text) {
  return /\.ipynb$/i.test(String(fileName || '')) ? cellsFromIpynb(text) : cellsFromPython(text);
}

export default cellsFromFile;
