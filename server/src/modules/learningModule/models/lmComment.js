const mongoose = require("mongoose");

// Polymorphic: the same shape backs class comments on the stream, comments on
// a classwork item, answers to a "question" post, and the private teacher ⇄
// student thread on a submission (visibility: "private").
const lmCommentSchema = new mongoose.Schema({
  classId: { type: mongoose.Schema.Types.ObjectId, ref: "lm_class", required: true, index: true },
  targetType: {
    type: String,
    // "discussion" is a forum thread. Replies are ordinary comments so that
    // threading, notification and moderation stay in one place rather than
    // being reimplemented per surface.
    enum: ["announcement", "coursework", "submission", "audioSession", "discussion"],
    required: true,
  },
  targetId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  parentId: { type: mongoose.Schema.Types.ObjectId, ref: "lm_comment", default: null },

  authorId: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true },
  authorName: { type: String, default: "" },
  authorRole: { type: String, default: "student" },

  text: { type: String, required: true },
  visibility: { type: String, enum: ["class", "private"], default: "class", index: true },

  deleted: { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

lmCommentSchema.index({ targetType: 1, targetId: 1, created_at: 1 });

module.exports = mongoose.model("lm_comment", lmCommentSchema);
