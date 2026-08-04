const mongoose = require("mongoose");

/**
 * One row per award. A ledger, not a running total.
 *
 * Three things follow from that and are the reason for it:
 *
 * - **Weekly and all-time come from the same data.** A counter on the
 *   membership could not answer "who won last week" without a second store that
 *   would drift out of step with the first.
 * - **Awards are idempotent.** The unique index below means re-submitting work,
 *   a double-tapped button or a retried request cannot pay twice for the same
 *   thing. The award path relies on the write failing, not on checking first.
 * - **A teacher can see where a total came from.** "You have 240 points" is not
 *   answerable from a counter, and an unexplainable score is one nobody trusts.
 *
 * `studentName` is denormalised so a leaderboard is one query. A leaderboard
 * that had to join the roster would be the slowest page in the module.
 */
const lmPointsSchema = new mongoose.Schema({
  /**
   * The class the points were earned in, or null for something earned outside
   * any class — reporting a platform bug, say.
   *
   * A null-class row is deliberately invisible to every leaderboard: they all
   * match on a specific `classId`, so it takes no filtering to exclude. That is
   * the right semantics rather than a convenience — finding a bug in the
   * software is not participation in Digital Signal Processing, and it should
   * not move that class's table. It still counts on the student's own profile,
   * which is a total of everything they have done.
   */
  classId: { type: mongoose.Schema.Types.ObjectId, ref: "lm_class", default: null, index: true },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true, index: true },
  studentName: { type: String, default: "" },

  // What earned it. Kept coarse: the reason string carries the detail, and a
  // long enum is a migration every time a new way to earn points is added.
  kind: {
    type: String,
    enum: ["submission", "quiz", "notebook", "tutorial", "short", "comment", "bonus"],
    required: true,
  },
  points: { type: Number, required: true },
  // Shown to the student as-is, so it has to read as a sentence.
  reason: { type: String, default: "" },

  /**
   * The thing that earned it — a coursework id, a quiz id, a session id.
   *
   * Part of the uniqueness rule, so it must be *stable* for a given award. For
   * anything that can happen repeatedly and legitimately (a comment) it is the
   * thing's own id; for anything that should only ever pay once (submitting a
   * given quiz) it is that quiz.
   */
  refId: { type: mongoose.Schema.Types.ObjectId, default: null },

  // ISO week, e.g. "2026-W31". Stored rather than derived at query time so the
  // weekly leaderboard is a plain grouped match instead of a date-range scan
  // that has to agree with the client about when a week starts.
  weekKey: { type: String, required: true, index: true },

  /**
   * The academic session the class belonged to, copied from it at award time.
   *
   * Redundant — the class already knows — and that is the point: a student's
   * profile groups a whole career by session, and deriving it would mean
   * loading every class they have ever been in to read one string off each.
   *
   * Copied rather than referenced so it stays true to when it was earned.
   */
  session: { type: String, default: '', index: true },

  created_at: { type: Date, default: Date.now },
});

// The idempotency rule. Partial, because `refId: null` is legitimate for a
// manual bonus and several of those should be allowed to coexist.
lmPointsSchema.index(
  { classId: 1, studentId: 1, kind: 1, refId: 1 },
  { unique: true, partialFilterExpression: { refId: { $type: "objectId" } } },
);
// The two leaderboard queries.
lmPointsSchema.index({ classId: 1, weekKey: 1 });
lmPointsSchema.index({ classId: 1, studentId: 1, created_at: -1 });

module.exports = mongoose.model("lm_points", lmPointsSchema);
