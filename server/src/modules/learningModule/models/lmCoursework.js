const mongoose = require("mongoose");
const { attachmentSchema } = require("./lmClass");

// One collection backs all four Classwork item types. They share ~90% of their
// fields (title, instructions, attachments, topic, scheduling, audience) and
// the Classwork page always lists them together ordered by date, so splitting
// them into four collections would mean a four-way merge on every read.
const lmCourseworkSchema = new mongoose.Schema({
  classId: { type: mongoose.Schema.Types.ObjectId, ref: "lm_class", required: true, index: true },
  workType: {
    type: String,
    enum: ["assignment", "quiz", "question", "material"],
    default: "assignment",
    index: true,
  },

  title: { type: String, required: true, trim: true },
  instructions: { type: String, default: "" },
  attachments: [attachmentSchema],

  topicId: { type: mongoose.Schema.Types.ObjectId, default: null },
  topicName: { type: String, default: "" },

  points: { type: Number, default: 100 },
  graded: { type: Boolean, default: true },
  dueDate: { type: Date, default: null, index: true },
  allowLateSubmission: { type: Boolean, default: true },

  status: { type: String, enum: ["draft", "scheduled", "published"], default: "published", index: true },
  scheduledFor: { type: Date, default: null },
  publishedAt: { type: Date, default: Date.now },

  audience: [{ type: mongoose.Schema.Types.ObjectId, ref: "user" }],

  rubric: [
    {
      criterion: { type: String, default: "" },
      description: { type: String, default: "" },
      points: { type: Number, default: 0 },
      _id: false,
    },
  ],

  // workType === "question"
  questionConfig: {
    answerType: { type: String, enum: ["short", "mcq"], default: "short" },
    choices: [{ type: String }],
    studentsCanReplyToEachOther: { type: Boolean, default: true },
    studentsCanEditAnswer: { type: Boolean, default: false },
  },

  // workType === "quiz"
  quizId: { type: mongoose.Schema.Types.ObjectId, ref: "lm_quiz", default: null },

  // A coding notebook mirrored into Classwork. Same idea as `quizId`: the row
  // carries the due date and the gradebook link, but the work itself lives on
  // its own page, and a calendar entry that sent the class to the gradebook row
  // instead of the exercise would be a dead end.
  notebookId: { type: mongoose.Schema.Types.ObjectId, ref: "lm_notebook", default: null },

  // Set when the item was produced by the audio → AI pipeline, so the source
  // lecture stays traceable from the published material.
  aiSourceSessionId: { type: mongoose.Schema.Types.ObjectId, ref: "lm_audio_session", default: null },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true },
  createdByName: { type: String, default: "" },
  commentCount: { type: Number, default: 0 },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

lmCourseworkSchema.index({ classId: 1, status: 1, publishedAt: -1 });

module.exports = mongoose.model("lm_coursework", lmCourseworkSchema);
