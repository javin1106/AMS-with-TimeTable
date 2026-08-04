const mongoose = require('mongoose');

/**
 * One student's sitting of a quiz.
 *
 * For one-at-a-time delivery this document *is* the exam state: the paper the
 * student was dealt (`questionOrder`, `optionOrder`), how far through they are
 * (`cursor`), and what they have answered so far. Persisting all of it means a
 * dropped connection or a closed laptop resumes exactly where it left off
 * rather than restarting or being lost.
 */

const responseSchema = new mongoose.Schema(
  {
    questionId: { type: mongoose.Schema.Types.ObjectId, required: true },
    selected: [{ type: String }],
    text: { type: String, default: '' },

    correct: { type: Boolean, default: false },
    awarded: { type: Number, default: 0 },
    // Distinguishes "got it wrong" from "never answered", which matters for
    // negative marking and for the unattempted count.
    attempted: { type: Boolean, default: false },

    // Seconds actually spent on this question, measured server-side from when
    // it was served — not trusted from the client.
    timeSpentSec: { type: Number, default: 0 },
    servedAt: { type: Date, default: null },
    answeredAt: { type: Date, default: null },
    // True when the countdown expired and the answer was taken as-is.
    autoSubmitted: { type: Boolean, default: false },

    sectionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    sectionName: { type: String, default: '' },
    _id: false,
  },
  { _id: false },
);

const lmQuizAttemptSchema = new mongoose.Schema({
  quizId: { type: mongoose.Schema.Types.ObjectId, ref: 'lm_quiz', required: true, index: true },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'lm_class', required: true, index: true },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true, index: true },
  studentName: { type: String, default: '' },
  studentEmail: { type: String, default: '' },
  rollNumber: { type: String, default: '' },

  attemptNumber: { type: Number, default: 1 },
  status: {
    type: String,
    enum: ['in_progress', 'submitted', 'expired', 'terminated'],
    default: 'in_progress',
    index: true,
  },

  /* ---- the paper this student was dealt ---- */
  // Question ids in the order this student sees them. Fixed at start so a
  // reload cannot reshuffle the paper mid-test.
  questionOrder: [{ type: mongoose.Schema.Types.ObjectId }],
  // questionId → shuffled option index order, when shuffleOptions is on. The
  // stored answer indices always refer to the *original* option order, so
  // marking is unaffected by the shuffle.
  optionOrder: { type: Map, of: [Number], default: {} },
  // How far through questionOrder the student is (one-at-a-time delivery).
  cursor: { type: Number, default: 0 },
  // When the question at `cursor` was handed out, for the server-side clock.
  currentServedAt: { type: Date, default: null },

  responses: [responseSchema],

  /* ---- outcome ---- */
  score: { type: Number, default: 0 },
  maxScore: { type: Number, default: 0 },
  percent: { type: Number, default: 0 },
  passed: { type: Boolean, default: false },
  totalCorrect: { type: Number, default: 0 },
  totalWrong: { type: Number, default: 0 },
  totalUnattempted: { type: Number, default: 0 },
  negativeApplied: { type: Number, default: 0 },

  sectionScores: [
    {
      sectionId: { type: mongoose.Schema.Types.ObjectId, default: null },
      sectionName: { type: String, default: '' },
      score: { type: Number, default: 0 },
      maxScore: { type: Number, default: 0 },
      correct: { type: Number, default: 0 },
      wrong: { type: Number, default: 0 },
      unattempted: { type: Number, default: 0 },
      timeSpentSec: { type: Number, default: 0 },
      _id: false,
    },
  ],

  /* ---- proctoring record ---- */
  tabSwitches: { type: Number, default: 0 },
  violations: [
    {
      type: {
        type: String,
        enum: [
          'tab_switch', 'blur', 'fullscreen_exit', 'copy', 'paste', 'right_click', 'mobile_detected',
          // The signals below are raised by the *server*, so unlike the ones
          // above a modified client cannot decline to report them.
          //
          // heartbeat_lost: the page stopped checking in while the attempt was
          //   still open. Usually a flaky connection; also what blocking the
          //   proctoring requests looks like, which previously read as flawless
          //   behaviour.
          // late_answer:    an answer arrived after that question's clock ran
          //   out and was not counted.
          // device_changed: the User-Agent or IP moved mid-attempt — a second
          //   machine, or somebody driving the API with a copied token.
          'heartbeat_lost', 'late_answer', 'device_changed',
        ],
      },
      at: { type: Date, default: Date.now },
      // Free-text context for the server-raised kinds above; empty for the rest.
      detail: { type: String, default: '' },
      _id: false,
    },
  ],
  device: {
    userAgent: { type: String, default: '' },
    isMobile: { type: Boolean, default: false },
    // Recorded so a sitting driven from somewhere other than the browser that
    // started it is visible afterwards. Not a control — an IP is not an
    // identity, and campus NAT means most students share one — but a change
    // mid-attempt is worth a teacher's attention.
    ip: { type: String, default: '' },
  },

  // Last time the page checked in. `null` until the first heartbeat, so an
  // attempt started before this field existed is not retroactively suspicious.
  lastSeenAt: { type: Date, default: null },
  // Set once when a lost heartbeat has been recorded, so a student offline for an
  // hour collects one violation rather than one per sweep.
  heartbeatLostAt: { type: Date, default: null },
  // Set when the attempt was ended by the proctoring rules rather than by the
  // student, so a teacher can see why.
  terminationReason: { type: String, default: '' },

  /* ---- staff intervention ---- */
  /**
   * An absolute deadline for this one sitting, set when staff reopen it.
   *
   * It has to be absolute rather than "extra minutes", because the case it
   * exists for is a paper that closed hours ago: `startedAt + timeLimit` and
   * the quiz's own `availableTo` are both already in the past, and adding to
   * either lands in the past too. When set, it supersedes both — see
   * `examEngine.questionDeadline`.
   */
  deadlineOverride: { type: Date, default: null },
  reopenedAt: { type: Date, default: null },
  reopenedByName: { type: String, default: '' },
  // Counts every reopen, including the ones that restarted the paper. Left on
  // a restarted attempt on purpose: the fact that a student sat this twice
  // survives the wiping of what they wrote the first time.
  reopenCount: { type: Number, default: 0 },

  // Last time these marks were recomputed other than by the student submitting
  // — a re-evaluation of the whole paper after its answer key was corrected.
  // Kept on the attempt so a result that looks wrong against the key can be
  // told apart from one that has already been put right, and so a student
  // querying a changed mark can be told when and by whom it changed.
  regradedAt: { type: Date, default: null },
  regradedByName: { type: String, default: '' },

  startedAt: { type: Date, default: Date.now },
  submittedAt: { type: Date, default: null },
  durationSec: { type: Number, default: 0 },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

lmQuizAttemptSchema.index({ quizId: 1, studentId: 1, attemptNumber: 1 }, { unique: true });

module.exports = mongoose.model('lm_quiz_attempt', lmQuizAttemptSchema);
