const mongoose = require("mongoose");

// The bridge between the attendance module's class recordings and this
// module's study material. One document per lecture: it holds the pointer to
// the recording, the transcript, and every artefact generated from it, so a
// teacher can regenerate or re-publish without re-transcribing.
const lmAudioSessionSchema = new mongoose.Schema({
  classId: { type: mongoose.Schema.Types.ObjectId, ref: "lm_class", required: true, index: true },
  title: { type: String, required: true, trim: true },
  lectureDate: { type: Date, default: Date.now },

  source: {
    type: String,
    enum: ["attendance-recording", "upload", "external-url", "manual-transcript"],
    default: "attendance-recording",
  },
  // For source === "attendance-recording": the filename as listed by the
  // attendance module's /camera/recording/list endpoint. Audio bytes stay on
  // the ML service's disk; we only keep the reference.
  recordingFilename: { type: String, default: "" },
  recordingLabel: { type: String, default: "" },
  period: { type: String, default: "" },
  room: { type: String, default: "" },
  audioUrl: { type: String, default: "" },
  durationSec: { type: Number, default: 0 },

  transcript: {
    text: { type: String, default: "" },
    language: { type: String, default: "en" },
    provider: { type: String, default: "" },
    wordCount: { type: Number, default: 0 },
    segments: [
      {
        start: { type: Number, default: 0 },
        end: { type: Number, default: 0 },
        text: { type: String, default: "" },
        speaker: { type: String, default: "" },
        _id: false,
      },
    ],
    generatedAt: { type: Date, default: null },
  },

  notes: {
    markdown: { type: String, default: "" },
    outline: [{ type: String }],
    provider: { type: String, default: "" },
    generatedAt: { type: Date, default: null },
    publishedCourseworkId: { type: mongoose.Schema.Types.ObjectId, ref: "lm_coursework", default: null },
  },

  tutorial: {
    markdown: { type: String, default: "" },
    summary: { type: String, default: "" },
    keyTerms: [{ term: String, definition: String, _id: false }],
    flashcards: [{ front: String, back: String, _id: false }],
    faq: [{ question: String, answer: String, _id: false }],
    furtherReading: [{ type: String }],
    provider: { type: String, default: "" },
    generatedAt: { type: Date, default: null },
    publishedCourseworkId: { type: mongoose.Schema.Types.ObjectId, ref: "lm_coursework", default: null },
  },

  // Held as a draft until a teacher reviews it and promotes it to a real quiz.
  quizDraft: {
    questions: { type: Array, default: [] },
    provider: { type: String, default: "" },
    generatedAt: { type: Date, default: null },
  },
  generatedQuizId: { type: mongoose.Schema.Types.ObjectId, ref: "lm_quiz", default: null },

  status: {
    type: String,
    enum: ["new", "transcribing", "transcribed", "generating", "ready", "failed"],
    default: "new",
    index: true,
  },
  error: { type: String, default: "" },
  jobLog: [
    {
      step: { type: String, default: "" },
      message: { type: String, default: "" },
      level: { type: String, default: "info" },
      at: { type: Date, default: Date.now },
      _id: false,
    },
  ],

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true },
  createdByName: { type: String, default: "" },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model("lm_audio_session", lmAudioSessionSchema);
