const mongoose = require("mongoose");
const { attachmentSchema } = require("./lmClass");

const lmAnnouncementSchema = new mongoose.Schema({
  classId: { type: mongoose.Schema.Types.ObjectId, ref: "lm_class", required: true, index: true },
  authorId: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true },
  authorName: { type: String, default: "" },
  authorRole: { type: String, default: "teacher" },

  text: { type: String, default: "" },
  attachments: [attachmentSchema],

  // Empty audience array = whole class. Populated = only those members see it.
  audience: [{ type: mongoose.Schema.Types.ObjectId, ref: "user" }],

  pinned: { type: Boolean, default: false },
  status: { type: String, enum: ["draft", "scheduled", "published"], default: "published", index: true },
  scheduledFor: { type: Date, default: null },
  publishedAt: { type: Date, default: Date.now },

  reactions: [
    {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
      emoji: { type: String, default: "👍" },
      _id: false,
    },
  ],
  commentCount: { type: Number, default: 0 },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

lmAnnouncementSchema.index({ classId: 1, pinned: -1, publishedAt: -1 });

module.exports = mongoose.model("lm_announcement", lmAnnouncementSchema);
