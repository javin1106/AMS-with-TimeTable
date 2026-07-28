const mongoose = require("mongoose");

const questionSchema = new mongoose.Schema(
  {
    question: { type: String, required: true },
    type: { type: String, enum: ["mcq", "msq", "truefalse", "short"], default: "mcq" },
    options: [{ type: String }],
    // Indices into `options` for mcq/msq/truefalse; free text for "short".
    correctAnswers: [{ type: String }],
    explanation: { type: String, default: "" },
    marks: { type: Number, default: 1 },
    negativeMarks: { type: Number, default: 0 },
    difficulty: { type: String, enum: ["easy", "medium", "hard"], default: "medium" },
    topic: { type: String, default: "" },
    // Where in the lecture transcript this question came from — lets a student
    // jump back to the source passage after seeing the answer.
    sourceExcerpt: { type: String, default: "" },
  },
  { _id: true },
);

const lmQuizSchema = new mongoose.Schema({
  classId: { type: mongoose.Schema.Types.ObjectId, ref: "lm_class", required: true, index: true },
  title: { type: String, required: true, trim: true },
  description: { type: String, default: "" },

  source: { type: String, enum: ["manual", "ai"], default: "manual" },
  audioSessionId: { type: mongoose.Schema.Types.ObjectId, ref: "lm_audio_session", default: null },

  questions: [questionSchema],
  totalMarks: { type: Number, default: 0 },

  settings: {
    timeLimitMinutes: { type: Number, default: 0 },
    shuffleQuestions: { type: Boolean, default: false },
    shuffleOptions: { type: Boolean, default: false },
    attemptsAllowed: { type: Number, default: 1 },
    showAnswersAfterSubmit: { type: Boolean, default: true },
    availableFrom: { type: Date, default: null },
    availableTo: { type: Date, default: null },
    passPercent: { type: Number, default: 40 },
  },

  published: { type: Boolean, default: false, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true },
  createdByName: { type: String, default: "" },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

lmQuizSchema.pre("save", function recomputeTotal(next) {
  this.totalMarks = (this.questions || []).reduce((sum, q) => sum + (q.marks || 0), 0);
  next();
});

module.exports = mongoose.model("lm_quiz", lmQuizSchema);
