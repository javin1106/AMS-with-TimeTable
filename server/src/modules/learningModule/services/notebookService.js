/**
 * Notebook cell handling: coercing authored cells, seeding a student's working
 * copy, and clamping what a browser is allowed to store back as output.
 *
 * Pure functions, no database. The clamping in particular is the part worth
 * testing in isolation — it is the only thing standing between a `while True:
 * print(x)` loop and a multi-megabyte document.
 */

const MAX_SOURCE_LENGTH = 100_000;
const MAX_OUTPUTS_PER_CELL = 50;
const MAX_OUTPUT_TEXT = 20_000;
// A matplotlib PNG is comfortably under this; anything larger is someone
// pushing a video frame at us.
const MAX_IMAGE_CHARS = 4_000_000;
const MAX_CELLS = 200;
const MAX_PACKAGES = 30;

const OUTPUT_TYPES = ['stdout', 'stderr', 'result', 'error', 'image'];

// Only names pip would accept anyway. Rejecting the rest here means a stray
// value never reaches micropip on the client with a shell-looking payload in it.
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const truncate = (value, limit) => {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  // Say so in the text itself: silently dropping the tail of a traceback is how
  // a student spends ten minutes debugging an error they cannot see the end of.
  return `${text.slice(0, limit)}\n… truncated (${text.length - limit} more characters)`;
};

/** Coerces teacher-authored cells into storable shape. */
function prepareCells(input) {
  return (Array.isArray(input) ? input : []).slice(0, MAX_CELLS).map((cell, index) => ({
    _id: cell._id || undefined,
    type: cell.type === 'markdown' ? 'markdown' : 'code',
    source: truncate(cell.source, MAX_SOURCE_LENGTH),
    locked: Boolean(cell.locked),
    // A markdown cell has nothing to hide — hiding it would just delete it.
    hidden: cell.type === 'code' ? Boolean(cell.hidden) : false,
    order: Number.isFinite(Number(cell.order)) ? Number(cell.order) : index,
  }));
}

function preparePackages(input) {
  return [...new Set((Array.isArray(input) ? input : []).map((name) => String(name).trim()))]
    .filter((name) => PACKAGE_NAME.test(name))
    .slice(0, MAX_PACKAGES);
}

/** Rejects a notebook that cannot be worked through. */
function validateCells(cells) {
  const errors = [];
  if (!cells.length) errors.push('Add at least one cell.');
  cells.forEach((cell, index) => {
    // A hidden *and* locked cell that is empty contributes nothing but confuses
    // the run order, and an empty visible cell is just noise on the page.
    if (cell.type === 'markdown' && !cell.source.trim()) {
      errors.push(`Cell ${index + 1}: the text is empty.`);
    }
  });
  return errors;
}

/**
 * The cells a student starts from.
 *
 * Hidden cells are deliberately **not** copied: they are setup the notebook
 * needs but the student should not see, so they are replayed from the authored
 * notebook at kernel start instead of being handed over in the attempt payload.
 */
function seedAttemptCells(notebook) {
  return (notebook.cells || [])
    .filter((cell) => !cell.hidden)
    .map((cell, index) => ({
      sourceCellId: cell._id,
      type: cell.type,
      source: cell.source,
      locked: cell.locked,
      outputs: [],
      executedAt: null,
      runCount: 0,
      order: index,
    }));
}

/** Setup replayed into a fresh kernel, in authored order, before anything else. */
const hiddenSetup = (notebook) =>
  (notebook.cells || [])
    .filter((cell) => cell.hidden && cell.type === 'code')
    .map((cell) => cell.source);

/**
 * Clamps one output entry reported by a browser.
 *
 * Everything here is untrusted: the size, the type and the content are all
 * chosen by the client.
 */
function normaliseOutput(output) {
  const type = OUTPUT_TYPES.includes(output?.type) ? output.type : 'stdout';
  const limit = type === 'image' ? MAX_IMAGE_CHARS : MAX_OUTPUT_TEXT;
  return {
    type,
    text: truncate(output?.text, limit),
    created_at: new Date(),
  };
}

/**
 * Merges a student's save into their stored attempt.
 *
 * Locked cells keep the teacher's source no matter what arrives: the client
 * disables the editor, but the client is not a security boundary and a locked
 * setup cell being quietly rewritten is exactly the kind of thing nobody would
 * notice until the marks looked strange.
 */
function applyStudentCells(existingCells, incoming, { allowAddCells = true } = {}) {
  const byId = new Map((existingCells || []).map((cell) => [String(cell._id), cell]));
  const submitted = Array.isArray(incoming) ? incoming.slice(0, MAX_CELLS) : [];

  const merged = [];
  submitted.forEach((cell, index) => {
    const existing = byId.get(String(cell._id));

    if (!existing) {
      // A cell the student added. Dropped outright when the notebook does not
      // allow it, rather than accepted and hidden by the UI.
      if (!allowAddCells) return;
      merged.push({
        sourceCellId: null,
        type: cell.type === 'markdown' ? 'markdown' : 'code',
        source: truncate(cell.source, MAX_SOURCE_LENGTH),
        locked: false,
        outputs: (cell.outputs || []).slice(0, MAX_OUTPUTS_PER_CELL).map(normaliseOutput),
        executedAt: cell.executedAt ? new Date(cell.executedAt) : null,
        runCount: Math.max(0, Number(cell.runCount) || 0),
        order: index,
      });
      return;
    }

    merged.push({
      ...(existing.toObject ? existing.toObject() : existing),
      source: existing.locked ? existing.source : truncate(cell.source, MAX_SOURCE_LENGTH),
      outputs: (cell.outputs || []).slice(0, MAX_OUTPUTS_PER_CELL).map(normaliseOutput),
      executedAt: cell.executedAt ? new Date(cell.executedAt) : existing.executedAt,
      runCount: Math.max(0, Number(cell.runCount) || 0),
      order: index,
    });
  });

  // A cell the student deleted is gone — unless it was locked, which is the
  // whole point of locking it.
  const keptIds = new Set(merged.map((cell) => String(cell._id)));
  (existingCells || []).forEach((cell) => {
    if (cell.locked && !keptIds.has(String(cell._id))) {
      merged.push(cell.toObject ? cell.toObject() : cell);
    }
  });

  return merged.map((cell, index) => ({ ...cell, order: index }));
}

/**
 * How far through the notebook a submission actually got.
 *
 * "Completed" is every code cell run with nothing left erroring — the teacher's
 * question is "did they work through it", and a cell that ran and raised is not
 * a cell that worked. Markdown is ignored: there is nothing to run.
 *
 * Reads only what the student's browser reported, which is forgeable. This is a
 * read on effort, never a basis for a mark — see the note on the schema field.
 */
function summariseAttempt(cells) {
  const code = (cells || []).filter((cell) => cell.type === 'code');
  const run = code.filter((cell) => cell.executedAt || cell.runCount > 0);
  const errored = code.filter((cell) => (cell.outputs || []).some((output) => output.type === 'error'));

  return {
    codeCells: code.length,
    cellsRun: run.length,
    cellsErrored: errored.length,
    // An empty notebook is not a completed one.
    completed: code.length > 0 && run.length === code.length && errored.length === 0,
  };
}

module.exports = {
  summariseAttempt,
  prepareCells,
  preparePackages,
  validateCells,
  seedAttemptCells,
  hiddenSetup,
  normaliseOutput,
  applyStudentCells,
  MAX_SOURCE_LENGTH,
  MAX_OUTPUTS_PER_CELL,
  MAX_OUTPUT_TEXT,
  MAX_CELLS,
};
