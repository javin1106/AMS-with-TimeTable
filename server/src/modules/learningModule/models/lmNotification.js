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
      "material",
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
