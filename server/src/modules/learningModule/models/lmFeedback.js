const mongoose = require("mongoose");

/**
 * Anonymous feedback from a student to the teaching staff of one class.
 *
 * "Anonymous" here means *anonymous to the teacher*, not unattributed. The
 * author is stored in full — id, name, email, roll number — and a platform
 * admin can read it. Two reasons the identity is kept rather than discarded:
 *
 *  1. a channel nobody can be held to is a channel that fills with abuse, and
 *     the word filter only catches the crude half of it;
 *  2. feedback that alleges something serious about a member of staff has to be
 *     traceable to be actionable at all.
 *
 * What that costs is honesty at the margin, so the promise made to the student
 * in the UI is exactly the promise this schema keeps, and no more: the teacher
 * never sees who wrote it, the administrator can.
 *
 * The projection that enforces it lives in `feedbackController.forTeacher()` —
 * one place, so "who may see the name" is a single decision rather than a habit
 * every handler has to remember. Nothing else in the module reads this
 * collection.
 */
const lmFeedbackSchema = new mongoose.Schema({
  classId: { type: mongoose.Schema.Types.ObjectId, ref: "lm_class", required: true, index: true },

  // ── the half the teacher never receives ────────────────────────────────────
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true, index: true },
  // Denormalised the same way authorName is on comments: the admin audit view
  // has to keep working after a student leaves the class or the account is
  // renamed, and a removed membership would otherwise leave a bare ObjectId.
  studentName: { type: String, default: "" },
  studentEmail: { type: String, default: "" },
  studentRollNumber: { type: String, default: "" },

  // ── the half that is shown ─────────────────────────────────────────────────
  category: {
    type: String,
    enum: ["teaching", "pace", "content", "assessment", "communication", "other"],
    default: "other",
    index: true,
  },
  text: { type: String, required: true },

  // Plain text, never rich text — see the controller. Sentiment is the
  // student's own framing of what they wrote, so the teacher can tell praise
  // from a complaint before opening it.
  sentiment: { type: String, enum: ["praise", "suggestion", "concern"], default: "suggestion" },

  status: { type: String, enum: ["new", "read", "actioned"], default: "new", index: true },
  readAt: { type: Date, default: null },
  // Staff can mark what they did about it. Visible to the class as an
  // acknowledgement that the box is being read, which is the only thing that
  // keeps students using it.
  response: { type: String, default: "" },
  respondedAt: { type: Date, default: null },
  respondedByName: { type: String, default: "" },

  // Soft delete, so a withdrawn item still exists for the admin audit.
  deleted: { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

lmFeedbackSchema.index({ classId: 1, created_at: -1 });
lmFeedbackSchema.index({ classId: 1, studentId: 1, created_at: -1 });

module.exports = mongoose.model("lm_feedback", lmFeedbackSchema);
