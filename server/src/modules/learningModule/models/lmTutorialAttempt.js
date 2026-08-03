const mongoose = require('mongoose');

/**
 * One student's personalised sitting of a parameterised tutorial.
 *
 * Everything the student was actually shown is persisted here — the drawn
 * variable values, the rendered prompt, and the expected answers computed at
 * generation time. That is deliberate: a teacher editing the question or its
 * formula afterwards must not retroactively change what an in-progress or
 * already-marked student was asked, nor silently re-mark their work.
 */

const questionInstanceSchema = new mongoose.Schema(
  {
    questionId: { type: mongoose.Schema.Types.ObjectId, required: true },
    // The values drawn for this student, keyed by variable name.
    values: { type: Map, of: mongoose.Schema.Types.Mixed, default: {} },

    prompt: { type: String, default: '' },
    hint: { type: String, default: '' },
    solution: { type: String, default: '' },

    expected: [
      {
        key: { type: String, default: '' },
        label: { type: String, default: '' },
        unit: { type: String, default: '' },
        value: { type: Number, default: null },
        marks: { type: Number, default: 0 },
        error: { type: String, default: null },
        _id: false,
      },
    ],
  },
  { _id: false },
);

const responseSchema = new mongoose.Schema(
  {
    questionId: { type: mongoose.Schema.Types.ObjectId, required: true },
    answerKey: { type: String, default: '' },
    // Kept as text so the teacher can see exactly what was typed, including
    // an expression like "2*pi*3" that the engine evaluated.
    raw: { type: String, default: '' },
    value: { type: Number, default: null },
    correct: { type: Boolean, default: false },
    awarded: { type: Number, default: 0 },
    difference: { type: Number, default: null },
    _id: false,
  },
  { _id: false },
);

const lmTutorialAttemptSchema = new mongoose.Schema({
  tutorialId: { type: mongoose.Schema.Types.ObjectId, ref: 'lm_tutorial', required: true, index: true },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'lm_class', required: true, index: true },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true, index: true },
  studentName: { type: String, default: '' },
  studentEmail: { type: String, default: '' },

  attemptNumber: { type: Number, default: 1 },
  // Reproducibility aid only — `questions` below is the source of truth.
  seed: { type: Number, default: 0 },

  questions: [questionInstanceSchema],
  responses: [responseSchema],

  status: {
    type: String,
    enum: ['in_progress', 'submitted', 'graded'],
    default: 'in_progress',
    index: true,
  },

  score: { type: Number, default: 0 },
  maxScore: { type: Number, default: 0 },
  percent: { type: Number, default: 0 },
  passed: { type: Boolean, default: false },

  // Recorded when a constraint could not be satisfied or a formula failed for
  // this particular draw, so the teacher can see it on the results page.
  warnings: [{ type: String }],

  startedAt: { type: Date, default: Date.now },
  submittedAt: { type: Date, default: null },
  late: { type: Boolean, default: false },
  durationSec: { type: Number, default: 0 },

  // Teacher override after auto-marking.
  teacherAdjustment: { type: Number, default: 0 },
  teacherFeedback: { type: String, default: '' },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

lmTutorialAttemptSchema.index({ tutorialId: 1, studentId: 1, attemptNumber: 1 }, { unique: true });

module.exports = mongoose.model('lm_tutorial_attempt', lmTutorialAttemptSchema);
