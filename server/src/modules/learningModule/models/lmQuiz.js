const mongoose = require('mongoose');

/**
 * Quiz / online test.
 *
 * The option set here mirrors the aim2Crack exam engine (sections, per-question
 * timing, sequential delivery, proctoring, separate margin and result times) so
 * a placement-style test can be run from this module, while keeping the simpler
 * "answer everything on one page" mode as the default.
 */

const sectionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    order: { type: Number, default: 0 },
    instructions: { type: String, default: '' },
    // Optional section-level cap; 0 means "no separate section limit".
    timeLimitSec: { type: Number, default: 0 },
  },
  { _id: true },
);

const questionSchema = new mongoose.Schema(
  {
    question: { type: String, required: true },
    type: {
      type: String,
      // single/multiple are the aim2Crack names for mcq/msq; both are accepted
      // so an import from there does not need translating.
      enum: ['mcq', 'msq', 'truefalse', 'numerical'],
      default: 'mcq',
    },
    options: [{ type: String }],
    // Indices into `options` for choice types; the expected number (as a
    // string) for "numerical".
    correctAnswers: [{ type: String }],

    // numerical only: how far off an answer may be and still be correct.
    tolerancePercent: { type: Number, default: 0 },
    toleranceAbs: { type: Number, default: 0 },

    explanation: { type: String, default: '' },
    marks: { type: Number, default: 1 },
    // Per-question negative marking. Falls back to the quiz-level default when
    // left at null, so a teacher can set it once for the whole paper.
    negativeMarks: { type: Number, default: null },

    difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
    topic: { type: String, default: '' },

    // Per-question countdown for one-at-a-time delivery. 0 = fall back to the
    // quiz-level limit.
    timeLimitSec: { type: Number, default: 0 },

    sectionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    sectionName: { type: String, default: '' },
    order: { type: Number, default: 0 },

    // Where in the lecture transcript this question came from — lets a student
    // jump back to the source passage after seeing the answer.
    sourceExcerpt: { type: String, default: '' },
  },
  { _id: true },
);

const lmQuizSchema = new mongoose.Schema({
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'lm_class', required: true, index: true },
  title: { type: String, required: true, trim: true },
  description: { type: String, default: '' },

  source: { type: String, enum: ['manual', 'ai'], default: 'manual' },
  audioSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'lm_audio_session', default: null },

  // Shown on the pre-test instructions screen, one line per entry.
  instructions: [{ type: String }],
  sections: [sectionSchema],
  questions: [questionSchema],
  totalMarks: { type: Number, default: 0 },

  // Co-authors who may edit this quiz without being class teachers.
  collaborators: [
    {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
      email: { type: String, default: '' },
      name: { type: String, default: '' },
      _id: false,
    },
  ],

  settings: {
    /* ---- delivery methodology ---- */
    // all_at_once  → every question on one page, free navigation (default)
    // one_at_a_time→ server hands out one question at a time, resumable
    deliveryMode: {
      type: String,
      enum: ['all_at_once', 'one_at_a_time'],
      default: 'all_at_once',
    },
    // Only meaningful for one_at_a_time. False reproduces a placement test
    // where a delivered question cannot be revisited.
    allowBacktracking: { type: Boolean, default: false },
    // The two timing methods are mutually exclusive — a paper is either run on
    // one clock or on a clock per question, never both, because a student
    // watching two countdowns cannot tell which one will end their sitting.
    // True: each question gets its own countdown and auto-submits on expiry.
    // Only meaningful for one_at_a_time; the all-at-once page has no way to
    // enforce it, so the controller clears it when the delivery mode changes.
    perQuestionTiming: { type: Boolean, default: false },

    /* ---- timing ---- */
    // Whole-paper clock. Held at 0 while perQuestionTiming is on.
    timeLimitMinutes: { type: Number, default: 0 },
    // Seconds stamped on each newly added question, chosen once when the quiz
    // is created so the teacher is not asked again per question.
    defaultQuestionSec: { type: Number, default: 60 },
    // Latest a student may *start*. The test stays open for those already in
    // it; late arrivals are turned away rather than given a full clock.
    //
    // Two spellings, because they answer to different habits. `startDeadline`
    // is an absolute moment set alongside the publish and start times, and wins
    // whenever it is set. `marginMinutes` is the older relative form — minutes
    // after availableFrom — kept working for quizzes already carrying it, and
    // useless on its own when no opening time was ever set.
    startDeadline: { type: Date, default: null },
    marginMinutes: { type: Number, default: 0 },
    availableFrom: { type: Date, default: null },
    availableTo: { type: Date, default: null },
    // Results stay hidden until this moment even after submitting, so a whole
    // cohort can be released together. Null means "as soon as the paper is
    // marked", which is the moment the student submits.
    //
    // A teacher can always bring it forward from the results page — see
    // `quizController.releaseResults`, which writes `now` here — so this is the
    // plan, not a promise the staff are locked into.
    resultReleaseAt: { type: Date, default: null },

    /* ---- marking ---- */
    // Quiz-wide default used by any question whose negativeMarks is null.
    negativeMarking: { type: Number, default: 0 },
    passPercent: { type: Number, default: 40 },

    /* ---- randomisation ---- */
    shuffleQuestions: { type: Boolean, default: false },
    shuffleOptions: { type: Boolean, default: false },
    // 0 = serve every question. Above 0, draw that many at random per student.
    questionsPerAttempt: { type: Number, default: 0 },

    /* ---- feedback ---- */
    showAnswersAfterSubmit: { type: Boolean, default: true },
    showScoreImmediately: { type: Boolean, default: true },
    allowReviewBeforeSubmit: { type: Boolean, default: true },

    /* ---- tools ---- */
    // An on-screen scientific calculator during the sitting. Defaults on: most
    // papers either want one or do not care, and a teacher who needs mental
    // arithmetic tested turns it off per quiz.
    allowCalculator: { type: Boolean, default: true },

    /* ---- proctoring ----
       Leaving the sitting is no longer a budget a teacher sets: every paper is
       sat in fullscreen, and the first tab change, window change or fullscreen
       exit submits the attempt. The old `allowTabChange` / `maxTabSwitches` /
       `autoSubmitOnTabLimit` / `requireFullscreen` settings are gone — a quiz
       carrying them from before simply has them ignored, because the rule no
       longer varies by quiz, and a stored `requireFullscreen: false` must not
       be able to unlock a paper written after the rule changed. */

    // Discourages phones; does not prevent them. The check is on the
    // User-Agent, which the browser chooses for itself — devtools' device
    // toolbar defeats it in one click. Kept because it does turn away the
    // student who wandered in on a phone by accident, but the UI no longer
    // calls it a block, because a teacher who believes it is one plans around a
    // guarantee that does not exist.
    preventMobile: { type: Boolean, default: false },
    disableCopyPaste: { type: Boolean, default: false },
    disableRightClick: { type: Boolean, default: false },
  },

  // Publishing and starting are two separate clocks, and both are needed: the
  // link has to exist and be readable before the paper opens, or a cohort has
  // nowhere to wait. `published` is the teacher's decision; `publishAt` is the
  // moment it takes effect. Read paths ask `engine.isLive()` rather than the
  // flag alone, so a scheduled publish needs no cron — the same lazy-release
  // approach the stream already takes with scheduled posts.
  published: { type: Boolean, default: false, index: true },
  publishAt: { type: Date, default: null },
  // When the class was told this quiz exists. Distinct from `publishAt`: a
  // teacher who adjusts the window and saves again is republishing, not adding
  // a second quiz, and the class should not be notified twice for it.
  announcedAt: { type: Date, default: null },
  // When the class was told the *marks* exist — a separate announcement from
  // the one above, and the one students are waiting on. Latched, so a release
  // time that passes while the sweep runs every few minutes, a teacher pressing
  // "Publish results now", and a teacher pressing it twice all produce exactly
  // one notification per student.
  resultsAnnouncedAt: { type: Date, default: null },
  resultsAnnouncedByName: { type: String, default: '' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
  createdByName: { type: String, default: '' },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

lmQuizSchema.pre('save', function recomputeTotal(next) {
  // With a per-attempt draw the paper is a subset, so the achievable total is
  // the mean mark times the draw size rather than the sum of every question.
  const questions = this.questions || [];
  const sum = questions.reduce((total, q) => total + (q.marks || 0), 0);
  const draw = this.settings?.questionsPerAttempt || 0;
  this.totalMarks =
    draw > 0 && draw < questions.length
      ? Math.round((sum / questions.length) * draw * 100) / 100
      : sum;
  next();
});

/** Effective negative marking for a question, applying the quiz default. */
lmQuizSchema.methods.negativeFor = function negativeFor(question) {
  if (question.negativeMarks !== null && question.negativeMarks !== undefined) {
    return question.negativeMarks;
  }
  return this.settings?.negativeMarking || 0;
};

module.exports = mongoose.model('lm_quiz', lmQuizSchema);
