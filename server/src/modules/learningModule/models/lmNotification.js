const mongoose = require("mongoose");

const lmNotificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true, index: true },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: "lm_class", default: null },
  className: { type: String, default: "" },

  type: {
    type: String,
    enum: [
      "announcement",
      "coursework",
      "comment",
      "grade",
      "submission",
      "invite",
      "join_request",
      "quiz",
      // Marks released for a quiz already sat. Separate from "quiz", which
      // announces a paper to sit: a student scanning the bell needs to tell
      // "there is work to do" from "your marks are out" at a glance.
      "quiz_result",
      "material",
      // Carries no actorName, unlike every other type here — see
      // feedbackController.createFeedback.
      "feedback",
      // A forum topic. In-app only: a class of two hundred each starting a
      // thread a week would be two hundred emails.
      "discussion",
      // A verdict on a bug report. Fires whether or not the bug named a class,
      // so this is one of the few notifications with no class attached.
      "bug",
    ],
    required: true,
  },
  title: { type: String, default: "" },
  body: { type: String, default: "" },
  link: { type: String, default: "" },
  actorName: { type: String, default: "" },

  read: { type: Boolean, default: false, index: true },
  readAt: { type: Date, default: null },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

lmNotificationSchema.index({ userId: 1, read: 1, created_at: -1 });

module.exports = mongoose.model("lm_notification", lmNotificationSchema);
