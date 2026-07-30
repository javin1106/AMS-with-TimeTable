const mongoose = require('mongoose');

/**
 * A "Short" — a deck of live, instant questions a teacher runs from the front
 * of the room while students answer on their phones, like an audience-response
 * tool. Distinct from a quiz: no window, no attempt cap, no gradebook by
 * default. The point is the room seeing its own answers within seconds.
 *
 * The deck is the reusable artefact; each time it is presented a
 * `lm_short_session` is created (see that model for why).
 */

const SLIDE_TYPES = [
  'mcq',        // one answer from a list — bar chart
  'msq',        // several answers from a list — bar chart
  'truefalse',
  'wordcloud',  // short free text, aggregated by frequency
  'scale',      // rate on 1..N — histogram plus mean
  'open',       // longer free text, shown as cards
  'ranking',    // drag into order — aggregated by Borda count
  'numeric',    // estimate a number — mean/median/spread
];

const slideSchema = new mongoose.Schema(
  {
    type: { type: String, enum: SLIDE_TYPES, default: 'mcq' },
    question: { type: String, required: true },
    // Only used by mcq/msq/truefalse/ranking.
    options: [{ type: String }],
    // Indices into `options`. Empty means "this is a poll, not a test" — a
    // slide with no key is never marked and shows no right answer.
    correctAnswers: [{ type: String }],
    explanation: { type: String, default: '' },

    // 0 = no countdown; the teacher closes it by hand.
    timeLimitSec: { type: Number, default: 0 },
    marks: { type: Number, default: 1 },

    // scale only
    scaleMin: { type: Number, default: 1 },
    scaleMax: { type: Number, default: 5 },
    scaleMinLabel: { type: String, default: '' },
    scaleMaxLabel: { type: String, default: '' },

    // numeric only — tolerance for marking an estimate correct
    correctNumber: { type: Number, default: null },
    tolerancePercent: { type: Number, default: 0 },
    toleranceAbs: { type: Number, default: 0 },

    // wordcloud/open only
    maxWords: { type: Number, default: 3 },
    maxLength: { type: Number, default: 200 },

    order: { type: Number, default: 0 },
    imageUrl: { type: String, default: '' },
  },
  { _id: true },
);

const lmShortSchema = new mongoose.Schema({
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'lm_class', required: true, index: true },
  title: { type: String, required: true, trim: true },
  description: { type: String, default: '' },

  slides: [slideSchema],

  settings: {
    // Names are hidden from the projected results. Responses are still tied to
    // an account server-side, so the teacher can see who has not answered and
    // grading remains possible — "anonymous" is about what the room sees.
    anonymous: { type: Boolean, default: true },
    // Show the tally to students on their own device as it comes in, or keep
    // it on the projector only.
    showResultsToStudents: { type: Boolean, default: false },
    // Let someone answer a slide again while it is still open.
    allowChangeAnswer: { type: Boolean, default: true },
    // Students who arrive mid-deck can still join the running session.
    allowLateJoin: { type: Boolean, default: true },
    // Off by default: a warm-up poll is not an assessment. On, scores land in
    // the gradebook like a quiz.
    graded: { type: Boolean, default: false },
    // Reveal the correct answer automatically when a slide is closed.
    autoRevealOnClose: { type: Boolean, default: true },
  },

  // Set when a graded short has been mirrored into the Classwork list.
  courseworkId: { type: mongoose.Schema.Types.ObjectId, ref: 'lm_coursework', default: null },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
  createdByName: { type: String, default: '' },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

lmShortSchema.virtual('totalMarks').get(function totalMarks() {
  return (this.slides || [])
    .filter((slide) => (slide.correctAnswers || []).length || slide.correctNumber !== null)
    .reduce((sum, slide) => sum + (slide.marks || 0), 0);
});

lmShortSchema.set('toJSON', { virtuals: true });
lmShortSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('lm_short', lmShortSchema);
module.exports.SLIDE_TYPES = SLIDE_TYPES;
