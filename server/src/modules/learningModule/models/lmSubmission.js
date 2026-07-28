const mongoose = require("mongoose");
const { attachmentSchema } = require("./lmClass");

const lmSubmissionSchema = new mongoose.Schema({
  courseworkId: { type: mongoose.Schema.Types.ObjectId, ref: "lm_coursework", required: true, index: true },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: "lm_class", required: true, index: true },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true, index: true },
  studentName: { type: String, default: "" },
  studentEmail: { type: String, default: "" },

  // assigned  → row exists but nothing handed in
  // turned_in → student submitted, awaiting grading
  // returned  → teacher graded and returned it
  // reclaimed → teacher pulled a returned submission back for regrading
  state: {
    type: String,
    enum: ["assigned", "turned_in", "returned", "reclaimed"],
    default: "assigned",
    index: true,
  },

  attachments: [attachmentSchema],
  textAnswer: { type: String, default: "" },
  choiceAnswer: { type: String, default: "" },

  turnedInAt: { type: Date, default: null },
  late: { type: Boolean, default: false },

  grade: { type: Number, default: null },
  maxPoints: { type: Number, default: 100 },
  feedback: { type: String, default: "" },
  rubricScores: [
    {
      criterion: { type: String, default: "" },
      points: { type: Number, default: 0 },
      _id: false,
    },
  ],

  gradedBy: { type: mongoose.Schema.Types.ObjectId, ref: "user", default: null },
  gradedByName: { type: String, default: "" },
  gradedAt: { type: Date, default: null },
  returnedAt: { type: Date, default: null },

  // Append-only audit of every state/grade change — a returned-then-regraded
  // submission otherwise loses its earlier marks.
  history: [
    {
      action: { type: String, default: "" },
      actorName: { type: String, default: "" },
      grade: { type: Number, default: null },
      at: { type: Date, default: Date.now },
      _id: false,
    },
  ],

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

lmSubmissionSchema.index({ courseworkId: 1, studentId: 1 }, { unique: true });

module.exports = mongoose.model("lm_submission", lmSubmissionSchema);
