const mongoose = require("mongoose");

/**
 * One rejected attempt to send abusive anonymous feedback.
 *
 * The rejected text is *never stored on the feedback collection* — it was
 * refused, so it never became feedback and no teacher will ever read it. It is
 * kept here instead, with the student's name on it, because the two things the
 * warning promises both need it: an escalating count the student can be told
 * about, and something for the administrator to look at before acting on it.
 *
 * Rows are the audit trail for a sanction, so nothing deletes them. The count is
 * per *student*, not per class — the point is a pattern of behaviour, and a
 * counter that reset every time they opened a different subject would not
 * measure one.
 */
const lmFeedbackStrikeSchema = new mongoose.Schema({
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true, index: true },
  studentName: { type: String, default: "" },
  studentEmail: { type: String, default: "" },

  classId: { type: mongoose.Schema.Types.ObjectId, ref: "lm_class", default: null, index: true },
  className: { type: String, default: "" },

  // What they tried to send, verbatim. An administrator deciding whether to
  // block an account should read the words themselves rather than trust the
  // filter's verdict — the list has false positives in it, and "your account was
  // blocked by a regex" is not a decision anyone can defend.
  text: { type: String, default: "" },
  terms: [{ type: String }],

  // Which warning this was, at the time it was issued. Stored rather than
  // recomputed so the record still says what the student was actually told.
  strikeNumber: { type: Number, default: 1 },

  created_at: { type: Date, default: Date.now },
});

lmFeedbackStrikeSchema.index({ studentId: 1, created_at: -1 });

module.exports = mongoose.model("lm_feedback_strike", lmFeedbackStrikeSchema);
