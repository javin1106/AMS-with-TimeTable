const mongoose = require("mongoose");

/**
 * A badge somebody has earned, in one class.
 *
 * Per class rather than per platform on purpose: "Locked In" ought to mean
 * "you kept up in *this* subject", and a student carrying a badge earned in an
 * easy elective into a hard one devalues it in both.
 *
 * Only the id is stored. The name, the emoji and the criterion live in the
 * gamification service, so renaming a badge — which will happen, because slang
 * moves — is a code change and not a migration over everyone who holds it.
 */
const lmBadgeSchema = new mongoose.Schema({
  classId: { type: mongoose.Schema.Types.ObjectId, ref: "lm_class", required: true, index: true },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true, index: true },
  studentName: { type: String, default: "" },

  badge: { type: String, required: true },
  // The session the class ran in, copied at award time — see lmPoints. A class
  // belongs to one session, so a per-class badge is already per-session; this
  // is what lets a profile group them without reading every class.
  session: { type: String, default: '' },
  // What they did to get it, frozen at the moment they did. "Topped the
  // leaderboard for 2026-W31" stays true; recomputing it later would not.
  detail: { type: String, default: "" },

  earnedAt: { type: Date, default: Date.now },
});

// Earned once. The award path leans on this rather than checking first, so two
// simultaneous requests cannot both decide they are the first.
lmBadgeSchema.index({ classId: 1, studentId: 1, badge: 1 }, { unique: true });

module.exports = mongoose.model("lm_badge", lmBadgeSchema);
