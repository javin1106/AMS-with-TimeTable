const mongoose = require("mongoose");

const lmQuizAttemptSchema = new mongoose.Schema({
  quizId: { type: mongoose.Schema.Types.ObjectId, ref: "lm_quiz", required: true, index: true },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: "lm_class", required: true, index: true },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true, index: true },
  studentName: { type: String, default: "" },

  attemptNumber: { type: Number, default: 1 },
  status: { type: String, enum: ["in_progress", "submitted", "expired"], default: "in_progress", index: true },

  answers: [
    {
      questionId: { type: mongoose.Schema.Types.ObjectId },
      selected: [{ type: String }],
      text: { type: String, default: "" },
      correct: { type: Boolean, default: false },
      awarded: { type: Number, default: 0 },
      _id: false,
    },
  ],

  score: { type: Number, default: 0 },
  maxScore: { type: Number, default: 0 },
  percent: { type: Number, default: 0 },
  passed: { type: Boolean, default: false },

  startedAt: { type: Date, default: Date.now },
  submittedAt: { type: Date, default: null },
  durationSec: { type: Number, default: 0 },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

lmQuizAttemptSchema.index({ quizId: 1, studentId: 1, attemptNumber: 1 }, { unique: true });

module.exports = mongoose.model("lm_quiz_attempt", lmQuizAttemptSchema);
