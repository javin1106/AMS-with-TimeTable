const mongoose = require("mongoose");

/**
 * Something a user says is broken.
 *
 * Open to students and staff alike, from the sidebar, because the people who
 * find bugs are the people using the thing — and a bug nobody can be bothered
 * to report is a bug that gets found by a class of two hundred instead.
 *
 * Points are paid on **acknowledgement**, not on submission. Paying on submit
 * would turn "report a bug" into a button worth pressing for its own sake, and
 * the queue would fill with noise faster than anyone could read it. A platform
 * admin deciding "yes, that is real" is the thing worth rewarding.
 */
const lmBugReportSchema = new mongoose.Schema({
  reporterId: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true, index: true },
  reporterName: { type: String, default: "" },
  reporterEmail: { type: String, default: "" },
  // Whether they were acting as staff or a student when they hit it. Kept
  // because "the faculty view is broken" and "the student view is broken" are
  // different bugs and the report rarely says which.
  reporterRole: { type: String, default: "" },

  title: { type: String, required: true, trim: true },
  description: { type: String, default: "" },
  // Where they were. Not parsed, just recorded — the single most useful line in
  // any bug report and the one people always forget to include.
  pageUrl: { type: String, default: "" },

  /**
   * The class it happened in, when it happened in one.
   *
   * Optional: plenty of bugs are platform-wide. When it is set and the report
   * is acknowledged, the badge is granted in that class — badges are per-class,
   * and a class-specific bug is a contribution to that class.
   */
  classId: { type: mongoose.Schema.Types.ObjectId, ref: "lm_class", default: null, index: true },
  className: { type: String, default: "" },
  // Copied from the class so a profile can group the award by session without
  // re-reading a class that may since have been archived.
  session: { type: String, default: "" },

  /**
   * open        → waiting for an admin to look
   * acknowledged→ real, and paid for
   * duplicate   → real, but already known; no second payment
   * rejected    → not a bug
   * fixed       → done, for the reporter's benefit
   */
  status: {
    type: String,
    enum: ["open", "acknowledged", "duplicate", "rejected", "fixed"],
    default: "open",
    index: true,
  },
  adminNote: { type: String, default: "" },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "user", default: null },
  reviewedByName: { type: String, default: "" },
  reviewedAt: { type: Date, default: null },

  /**
   * Set the first time this report is acknowledged.
   *
   * The award itself is already idempotent — the points ledger refuses a second
   * row for the same report — but this makes "has this been paid" answerable
   * without reading the ledger, so an admin flipping acknowledged → fixed →
   * acknowledged does not have to be reasoned about.
   */
  awardedAt: { type: Date, default: null },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

lmBugReportSchema.index({ status: 1, created_at: -1 });

module.exports = mongoose.model("lm_bug_report", lmBugReportSchema);
