const mongoose = require('mongoose');

/**
 * A parameterised tutorial: the teacher authors a question once, with
 * variables and ranges, and every student receives their own numbers.
 * Answers are checked against formulas rather than a fixed key.
 */

const variableSchema = new mongoose.Schema(
  {
    // Referenced as {{name}} in the prompt and by name in the formulas.
    name: { type: String, required: true, trim: true },
    label: { type: String, default: '' },
    type: { type: String, enum: ['range', 'integer', 'set'], default: 'range' },

    min: { type: Number, default: 1 },
    max: { type: Number, default: 10 },
    // Grid spacing. Keeps drawn values human-readable (4.5, not 4.51378).
    step: { type: Number, default: 0 },
    decimals: { type: Number, default: 2 },

    // type === 'set': draw from this explicit list instead of a range.
    values: [{ type: String }],

    unit: { type: String, default: '' },
  },
  { _id: true },
);

const answerSchema = new mongoose.Schema(
  {
    // Stable identifier used to match a student's input to this answer slot;
    // survives the teacher renaming the visible label.
    key: { type: String, required: true },
    label: { type: String, default: '' },
    // Evaluated against the student's drawn variable values.
    formula: { type: String, required: true },
    unit: { type: String, default: '' },

    tolerancePercent: { type: Number, default: 1 },
    toleranceAbs: { type: Number, default: 0 },
    decimals: { type: Number, default: null },

    marks: { type: Number, default: 1 },
  },
  { _id: true },
);

const questionSchema = new mongoose.Schema(
  {
    // Supports {{variable}} placeholders.
    prompt: { type: String, required: true },
    variables: [variableSchema],
    answers: [answerSchema],

    // Optional expression that must be true for a drawn set of values to be
    // accepted — the guard against divide-by-zero and similar.
    constraint: { type: String, default: '' },

    hint: { type: String, default: '' },
    solutionSteps: { type: String, default: '' },

    difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
    topic: { type: String, default: '' },
    order: { type: Number, default: 0 },
  },
  { _id: true },
);

const lmTutorialSchema = new mongoose.Schema({
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'lm_class', required: true, index: true },
  title: { type: String, required: true, trim: true },
  description: { type: String, default: '' },

  topicId: { type: mongoose.Schema.Types.ObjectId, default: null },
  topicName: { type: String, default: '' },

  questions: [questionSchema],
  totalMarks: { type: Number, default: 0 },

  settings: {
    attemptsAllowed: { type: Number, default: 1 },
    // When true a retry re-draws fresh numbers; when false the student
    // retries the identical paper.
    newValuesOnRetry: { type: Boolean, default: true },
    showSolutionAfterSubmit: { type: Boolean, default: true },
    showHints: { type: Boolean, default: true },
    dueDate: { type: Date, default: null },
    availableFrom: { type: Date, default: null },
    passPercent: { type: Number, default: 40 },
  },

  published: { type: Boolean, default: false, index: true },
  // Mirrors the quiz flow: publishing also drops a Classwork item so the
  // tutorial appears in the stream, to-do list and gradebook.
  courseworkId: { type: mongoose.Schema.Types.ObjectId, ref: 'lm_coursework', default: null },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
  createdByName: { type: String, default: '' },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

lmTutorialSchema.pre('save', function recomputeTotal(next) {
  this.totalMarks = (this.questions || []).reduce(
    (sum, question) =>
      sum + (question.answers || []).reduce((inner, answer) => inner + (Number(answer.marks) || 0), 0),
    0,
  );
  next();
});

module.exports = mongoose.model('lm_tutorial', lmTutorialSchema);
