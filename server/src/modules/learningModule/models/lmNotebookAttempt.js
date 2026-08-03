const mongoose = require('mongoose');

/**
 * One student's working copy of a notebook.
 *
 * A copy rather than a diff against the authored cells: the teacher will edit
 * the notebook mid-term, and a student who has spent an hour on it should not
 * find their work re-based onto new prose overnight. `sourceCellId` keeps the
 * link back for the teacher's side-by-side view, and survives the original cell
 * being deleted.
 */

const outputSchema = new mongoose.Schema(
  {
    // stdout / stderr are streams; 'result' is the repr of the last expression,
    // the way a notebook shows a bare value on the final line; 'error' is a
    // traceback; 'image' is a base64 PNG, which is how a matplotlib figure gets
    // out of the worker.
    type: { type: String, enum: ['stdout', 'stderr', 'result', 'error', 'image'], default: 'stdout' },
    text: { type: String, default: '' },
    created_at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const attemptCellSchema = new mongoose.Schema(
  {
    sourceCellId: { type: mongoose.Schema.Types.ObjectId, default: null },
    type: { type: String, enum: ['markdown', 'code'], default: 'code' },
    source: { type: String, default: '' },
    locked: { type: Boolean, default: false },

    /**
     * The last run's output, as reported by the student's browser.
     *
     * Not evidence. Pyodide runs in the student's tab, so anyone willing to open
     * devtools can post whatever they like here. It is stored so the teacher can
     * see what the student saw, and so reopening the notebook is not a blank
     * page — never as the basis for a mark.
     */
    outputs: [outputSchema],
    executedAt: { type: Date, default: null },
    // Execution count, the `In [3]:` a notebook shows. Per attempt, reset when
    // the kernel restarts.
    runCount: { type: Number, default: 0 },

    order: { type: Number, default: 0 },
  },
  { _id: true },
);

const lmNotebookAttemptSchema = new mongoose.Schema({
  notebookId: { type: mongoose.Schema.Types.ObjectId, ref: 'lm_notebook', required: true, index: true },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'lm_class', required: true, index: true },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
  studentName: { type: String, default: '' },
  studentEmail: { type: String, default: '' },
  rollNumber: { type: String, default: '' },

  cells: [attemptCellSchema],

  // Bumped whenever the student's browser saves, so a second tab can notice it
  // is behind rather than silently overwriting the newer copy.
  revision: { type: Number, default: 0 },
  lastSavedAt: { type: Date, default: null },
  submittedAt: { type: Date, default: null },

  /**
   * What the notebook looked like at the moment it was turned in.
   *
   * Frozen rather than derived on read, for one blunt reason: deriving it means
   * loading `cells.outputs` for every student in the class, and those outputs
   * hold base64 PNGs. A roster of two hundred would be tens of megabytes to
   * answer "how many finished it".
   *
   * `completed` is every code cell run with no error left behind — a student
   * who worked through the notebook, as against one who opened it and pressed
   * submit. It is not a mark and does not pretend to be: the outputs come from
   * the student's own browser and are trivially forged. It is a read on effort,
   * for a teacher who wants to know who to go and talk to.
   */
  summary: {
    codeCells: { type: Number, default: 0 },
    cellsRun: { type: Number, default: 0 },
    cellsErrored: { type: Number, default: 0 },
    completed: { type: Boolean, default: false },
  },

  // Marked by hand. There is no auto-grade here on purpose: the only thing the
  // server can vouch for is the code, so a human reads it.
  grade: { type: Number, default: null },
  maxPoints: { type: Number, default: null },
  feedback: { type: String, default: '' },
  gradedAt: { type: Date, default: null },
  gradedByName: { type: String, default: '' },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

// One working copy per student per notebook.
lmNotebookAttemptSchema.index({ notebookId: 1, studentId: 1 }, { unique: true });

module.exports = mongoose.model('lm_notebook_attempt', lmNotebookAttemptSchema);
