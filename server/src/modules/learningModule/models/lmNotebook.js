const mongoose = require('mongoose');

/**
 * A coding notebook — a sequence of prose and Python cells a student works
 * through, Colab-style.
 *
 * Execution happens in the student's own browser (Pyodide/WebAssembly), never
 * on our servers. That is a deliberate constraint, not a shortcut: running
 * arbitrary student Python server-side is a remote-code-execution surface, and
 * this platform has no container sandboxing to put behind it. The consequence is
 * written down here because it shapes everything below — **an output stored on
 * an attempt is a claim by the client, not a fact the server witnessed.** Marks
 * must never be derived from one.
 *
 * What the server does own: the authored notebook, each student's source code,
 * and who ran what when.
 */

const CELL_TYPES = ['markdown', 'code'];

const cellSchema = new mongoose.Schema(
  {
    type: { type: String, enum: CELL_TYPES, default: 'code' },
    // Markdown prose, or Python source. For a code cell this is the starter
    // code the student begins from.
    source: { type: String, default: '' },

    // A locked cell is shown but cannot be edited — imports and setup the rest
    // of the notebook depends on, which a student breaking by accident would
    // derail the whole sheet.
    locked: { type: Boolean, default: false },
    // Runs before the student's cells on every fresh kernel but is never shown.
    // Useful for seeding data without pasting forty lines of it into the sheet.
    hidden: { type: Boolean, default: false },

    order: { type: Number, default: 0 },
  },
  { _id: true },
);

const lmNotebookSchema = new mongoose.Schema({
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'lm_class', required: true, index: true },
  title: { type: String, required: true, trim: true },
  description: { type: String, default: '' },

  cells: [cellSchema],

  // Loaded into the kernel with micropip before the notebook runs. Named on the
  // notebook rather than discovered from the source, because guessing imports
  // from a regex gets it wrong on exactly the cases that matter.
  packages: [{ type: String }],

  settings: {
    // Let a student add and delete their own cells. Off turns the notebook into
    // a fixed worksheet.
    allowAddCells: { type: Boolean, default: true },
    // Show the teacher's original source alongside the student's, after they
    // have submitted.
    showSolutionAfterSubmit: { type: Boolean, default: false },
  },

  published: { type: Boolean, default: false },
  publishedAt: { type: Date, default: null },
  // When the class was told this notebook exists — see the note on lmQuiz's
  // own `announcedAt`. Editing cells and publishing again must not re-announce.
  announcedAt: { type: Date, default: null },
  // Set when a published notebook has been mirrored into the Classwork list.
  courseworkId: { type: mongoose.Schema.Types.ObjectId, ref: 'lm_coursework', default: null },
  dueDate: { type: Date, default: null },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
  createdByName: { type: String, default: '' },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model('lm_notebook', lmNotebookSchema);
module.exports.CELL_TYPES = CELL_TYPES;
