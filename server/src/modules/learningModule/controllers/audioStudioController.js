const LmAudioSession = require("../models/lmAudioSession");
const LmCoursework = require("../models/lmCoursework");
const LmQuiz = require("../models/lmQuiz");
const LmClass = require("../models/lmClass");
const ai = require("../services/aiService");
const recordings = require("../services/recordingService");
const { notifyClass } = require("../services/notifyService");

const log = (session, step, message, level = "info") => {
  session.jobLog.push({ step, message, level, at: new Date() });
  if (session.jobLog.length > 100) session.jobLog = session.jobLog.slice(-100);
};

const aiContext = (session, klass) => ({
  className: klass.name,
  subject: klass.subject || klass.subjectCode,
  title: session.title,
});

const requireTranscript = (session) => {
  const text = session.transcript?.text || "";
  if (text.trim().length < 100) {
    const error = new Error(
      "This session has no usable transcript yet. Transcribe the recording or paste the transcript first.",
    );
    error.status = 400;
    throw error;
  }
  return text;
};

/* ─────────────────────── attendance-module bridge ─────────────────────── */

/**
 * Class recordings captured by the attendance module, annotated with whether
 * this class has already turned each one into a session.
 */
exports.listAvailableRecordings = async (req, res) => {
  let available = [];
  let sourceError = null;
  try {
    available = await recordings.listUsableRecordings();
  } catch (error) {
    // The ML service being down must not blank the whole AI Studio — the
    // manual-transcript path still works.
    sourceError = error.response?.data?.error || error.message;
  }

  const used = await LmAudioSession.find({
    classId: req.lmClass._id,
    recordingFilename: { $ne: "" },
  })
    .select("recordingFilename _id title status")
    .lean();
  const byFilename = new Map(used.map((s) => [s.recordingFilename, s]));

  return res.json({
    recordings: available.map((rec) => ({
      ...rec,
      existingSession: byFilename.get(rec.filename) || null,
    })),
    sourceError,
    transcriptionConfigured: recordings.isTranscriptionConfigured(),
    aiProvider: ai.providerName(),
  });
};

/** Streams a recording's audio through Node so the browser player can use it. */
exports.streamRecordingAudio = async (req, res) => {
  try {
    const { stream, filename } = await recordings.fetchAudioStream(req.params.filename);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    stream.pipe(res);
    stream.on("error", () => {
      if (!res.writableEnded) res.end();
    });
  } catch (error) {
    if (error.response?.status === 404) {
      return res.status(404).json({ message: "Recording not found." });
    }
    return res.status(502).json({ message: "Could not reach the recording service." });
  }
};

/* ──────────────────────────── sessions CRUD ───────────────────────────── */

exports.listSessions = async (req, res) => {
  // Students only see sessions whose material has actually been published.
  if (!req.lmIsTeacher) {
    const sessions = await LmAudioSession.find({
      classId: req.lmClass._id,
      $or: [
        { "notes.publishedCourseworkId": { $ne: null } },
        { "tutorial.publishedCourseworkId": { $ne: null } },
      ],
    })
      .select("title lectureDate notes.markdown tutorial.summary tutorial.markdown status")
      .sort({ lectureDate: -1 })
      .lean();
    return res.json(sessions);
  }

  const sessions = await LmAudioSession.find({ classId: req.lmClass._id })
    .select("-transcript.segments -jobLog")
    .sort({ lectureDate: -1 })
    .lean();
  return res.json(
    sessions.map((s) => ({
      ...s,
      hasTranscript: Boolean(s.transcript?.text),
      hasNotes: Boolean(s.notes?.markdown),
      hasTutorial: Boolean(s.tutorial?.markdown),
      quizDraftCount: s.quizDraft?.questions?.length || 0,
    })),
  );
};

exports.createSession = async (req, res) => {
  const title = String(req.body.title || "").trim();
  if (!title) return res.status(400).json({ message: "Give the lecture a title." });

  const source = ["attendance-recording", "upload", "external-url", "manual-transcript"].includes(
    req.body.source,
  )
    ? req.body.source
    : "attendance-recording";

  if (source === "attendance-recording" && !req.body.recordingFilename) {
    return res.status(400).json({ message: "Pick a recording from the attendance module." });
  }

  const session = new LmAudioSession({
    classId: req.lmClass._id,
    title,
    lectureDate: req.body.lectureDate ? new Date(req.body.lectureDate) : new Date(),
    source,
    recordingFilename: req.body.recordingFilename || "",
    recordingLabel: req.body.recordingLabel || "",
    period: req.body.period || "",
    room: req.body.room || "",
    audioUrl: req.body.audioUrl || "",
    durationSec: Number(req.body.durationSec) || 0,
    createdBy: req.lmUser.id,
    createdByName: req.lmUser.name,
  });

  if (req.body.transcript) {
    session.transcript.text = String(req.body.transcript);
    session.transcript.wordCount = session.transcript.text.split(/\s+/).filter(Boolean).length;
    session.transcript.provider = "manual";
    session.transcript.generatedAt = new Date();
    session.status = "transcribed";
    log(session, "transcript", "Transcript supplied manually.");
  } else {
    log(session, "created", `Session created from ${source}.`);
  }

  await session.save();
  return res.status(201).json(session);
};

exports.getSession = async (req, res) => {
  const session = await LmAudioSession.findOne({
    _id: req.params.sessionId,
    classId: req.lmClass._id,
  }).lean();
  if (!session) return res.status(404).json({ message: "Session not found." });

  // Students get the published study material only — never the raw transcript
  // or the unreviewed quiz draft.
  if (!req.lmIsTeacher) {
    const published =
      session.notes?.publishedCourseworkId || session.tutorial?.publishedCourseworkId;
    if (!published) return res.status(404).json({ message: "Session not found." });
    return res.json({
      _id: session._id,
      title: session.title,
      lectureDate: session.lectureDate,
      notes: session.notes?.publishedCourseworkId ? { markdown: session.notes.markdown } : null,
      tutorial: session.tutorial?.publishedCourseworkId ? session.tutorial : null,
    });
  }

  return res.json(session);
};

exports.updateSession = async (req, res) => {
  const session = await LmAudioSession.findOne({
    _id: req.params.sessionId,
    classId: req.lmClass._id,
  });
  if (!session) return res.status(404).json({ message: "Session not found." });

  if (req.body.title !== undefined) session.title = String(req.body.title).trim();
  if (req.body.lectureDate !== undefined) session.lectureDate = new Date(req.body.lectureDate);

  // Teachers routinely fix transcription slips before generating material.
  if (req.body.transcript !== undefined) {
    session.transcript.text = String(req.body.transcript);
    session.transcript.wordCount = session.transcript.text.split(/\s+/).filter(Boolean).length;
    session.transcript.generatedAt = new Date();
    if (!session.transcript.provider) session.transcript.provider = "manual";
    if (session.status === "new") session.status = "transcribed";
    log(session, "transcript", "Transcript edited.");
  }
  if (req.body.notesMarkdown !== undefined) {
    session.notes.markdown = String(req.body.notesMarkdown);
    log(session, "notes", "Notes edited.");
  }
  if (req.body.tutorialMarkdown !== undefined) {
    session.tutorial.markdown = String(req.body.tutorialMarkdown);
    log(session, "tutorial", "Tutorial edited.");
  }
  if (Array.isArray(req.body.quizDraftQuestions)) {
    session.quizDraft.questions = req.body.quizDraftQuestions;
    log(session, "quiz", "Quiz draft edited.");
  }

  session.updated_at = new Date();
  await session.save();
  return res.json(session);
};

exports.deleteSession = async (req, res) => {
  const result = await LmAudioSession.deleteOne({
    _id: req.params.sessionId,
    classId: req.lmClass._id,
  });
  if (!result.deletedCount) return res.status(404).json({ message: "Session not found." });
  return res.json({ deleted: true });
};

/* ──────────────────────────── the pipeline ────────────────────────────── */

const loadSessionForWork = async (req) => {
  const session = await LmAudioSession.findOne({
    _id: req.params.sessionId,
    classId: req.lmClass._id,
  });
  if (!session) {
    const error = new Error("Session not found.");
    error.status = 404;
    throw error;
  }
  return session;
};

exports.transcribe = async (req, res) => {
  const session = await loadSessionForWork(req);
  if (!session.recordingFilename && !session.audioUrl) {
    return res.status(400).json({
      message: "This session has no audio attached — paste the transcript instead.",
    });
  }

  session.status = "transcribing";
  session.error = "";
  log(session, "transcribe", "Transcription requested.");
  await session.save();

  try {
    const result = await recordings.transcribeRecording({
      filename: session.recordingFilename,
      audioUrl: session.audioUrl,
      language: req.body.language || "en",
    });

    session.transcript.text = result.text;
    session.transcript.language = result.language;
    session.transcript.segments = result.segments;
    session.transcript.provider = result.provider;
    session.transcript.wordCount = result.text.split(/\s+/).filter(Boolean).length;
    session.transcript.generatedAt = new Date();
    if (result.durationSec) session.durationSec = result.durationSec;
    session.status = "transcribed";
    log(session, "transcribe", `Transcribed ${session.transcript.wordCount} words.`);
    await session.save();

    return res.json({ status: session.status, transcript: session.transcript });
  } catch (error) {
    session.status = "failed";
    session.error = error.message;
    log(session, "transcribe", error.message, "error");
    await session.save();
    return res.status(error.status || 502).json({ message: error.message });
  }
};

/**
 * Runs one or more generators over the transcript. `artefacts` may contain
 * "notes", "tutorial" and "quiz"; the default runs all three, which is the
 * one-click path from the UI.
 */
exports.generate = async (req, res) => {
  const session = await loadSessionForWork(req);
  const transcript = requireTranscript(session);

  const requested = Array.isArray(req.body.artefacts) && req.body.artefacts.length
    ? req.body.artefacts
    : ["notes", "tutorial", "quiz"];
  const ctx = aiContext(session, req.lmClass);

  session.status = "generating";
  session.error = "";
  await session.save();

  const produced = [];
  const failures = [];

  // Sequential rather than parallel: three long completions in flight at once
  // is what trips provider rate limits on a shared campus key.
  for (const artefact of requested) {
    try {
      if (artefact === "notes") {
        // eslint-disable-next-line no-await-in-loop
        const notes = await ai.generateNotes(transcript, ctx);
        session.notes.markdown = notes.markdown;
        session.notes.outline = notes.outline;
        session.notes.provider = notes.provider;
        session.notes.generatedAt = new Date();
        log(session, "notes", `Notes generated via ${notes.provider}.`);
        produced.push("notes");
      } else if (artefact === "tutorial") {
        // eslint-disable-next-line no-await-in-loop
        const tutorial = await ai.generateTutorial(transcript, ctx);
        Object.assign(session.tutorial, tutorial, { generatedAt: new Date() });
        log(session, "tutorial", `Tutorial generated via ${tutorial.provider}.`);
        produced.push("tutorial");
      } else if (artefact === "quiz") {
        // eslint-disable-next-line no-await-in-loop
        const quiz = await ai.generateQuiz(transcript, ctx, {
          count: req.body.questionCount,
          difficulty: req.body.difficulty,
        });
        session.quizDraft.questions = quiz.questions;
        session.quizDraft.provider = quiz.provider;
        session.quizDraft.generatedAt = new Date();
        log(session, "quiz", `${quiz.questions.length} questions drafted via ${quiz.provider}.`);
        produced.push("quiz");
      }
    } catch (error) {
      failures.push({ artefact, message: error.message });
      log(session, artefact, error.message, "error");
    }
  }

  session.status = produced.length ? "ready" : "failed";
  session.error = failures.map((f) => `${f.artefact}: ${f.message}`).join("; ");
  await session.save();

  return res.json({
    status: session.status,
    produced,
    failures,
    provider: ai.providerName(),
    notes: session.notes,
    tutorial: session.tutorial,
    quizDraft: session.quizDraft,
  });
};

/** Ask a question against this lecture's transcript. */
exports.ask = async (req, res) => {
  const session = await LmAudioSession.findOne({
    _id: req.params.sessionId,
    classId: req.lmClass._id,
  }).lean();
  if (!session) return res.status(404).json({ message: "Session not found." });

  // Students may only query a lecture whose material was published to them.
  if (!req.lmIsTeacher && !session.notes?.publishedCourseworkId && !session.tutorial?.publishedCourseworkId) {
    return res.status(403).json({ message: "This lecture has not been published yet." });
  }

  const question = String(req.body.question || "").trim();
  if (!question) return res.status(400).json({ message: "Ask a question." });
  if (!session.transcript?.text) {
    return res.status(400).json({ message: "This lecture has no transcript to search." });
  }

  const answer = await ai.answerFromTranscript(session.transcript.text, question, {
    className: req.lmClass.name,
    subject: req.lmClass.subject,
    title: session.title,
  });
  return res.json(answer);
};

/* ────────────────────────────── publishing ────────────────────────────── */

const publishAsMaterial = async (req, session, kind) => {
  const isNotes = kind === "notes";
  const markdown = isNotes ? session.notes.markdown : session.tutorial.markdown;
  if (!markdown) {
    const error = new Error(`No ${kind} have been generated for this lecture yet.`);
    error.status = 400;
    throw error;
  }

  const topicId = req.body.topicId || null;
  const topic = topicId ? req.lmClass.topics.id(topicId) : null;
  const title = String(req.body.title || "").trim() ||
    `${isNotes ? "Notes" : "Tutorial"} — ${session.title}`;

  const existingId = isNotes
    ? session.notes.publishedCourseworkId
    : session.tutorial.publishedCourseworkId;

  let coursework = existingId ? await LmCoursework.findById(existingId) : null;

  if (coursework) {
    coursework.title = title;
    coursework.instructions = markdown;
    coursework.status = "published";
    coursework.updated_at = new Date();
    await coursework.save();
  } else {
    coursework = await LmCoursework.create({
      classId: req.lmClass._id,
      workType: "material",
      title,
      instructions: markdown,
      topicId: topic?._id || null,
      topicName: topic?.name || "",
      points: 0,
      graded: false,
      aiSourceSessionId: session._id,
      createdBy: req.lmUser.id,
      createdByName: req.lmUser.name,
    });
    await LmClass.updateOne({ _id: req.lmClass._id }, { $inc: { "stats.courseworkCount": 1 } });
  }

  if (isNotes) session.notes.publishedCourseworkId = coursework._id;
  else session.tutorial.publishedCourseworkId = coursework._id;
  log(session, "publish", `${isNotes ? "Notes" : "Tutorial"} published as "${title}".`);
  await session.save();

  await notifyClass({
    klass: req.lmClass,
    excludeUserId: req.lmUser.id,
    type: "material",
    title: `${req.lmClass.name}: ${title}`,
    body: `Study material from the ${new Date(session.lectureDate).toLocaleDateString("en-IN")} lecture is available.`,
    link: `/learning/class/${req.lmClass._id}/work/${coursework._id}`,
    actorName: req.lmUser.name,
    email: true,
  });

  return coursework;
};

exports.publishNotes = async (req, res) => {
  const session = await loadSessionForWork(req);
  const coursework = await publishAsMaterial(req, session, "notes");
  return res.status(201).json(coursework);
};

exports.publishTutorial = async (req, res) => {
  const session = await loadSessionForWork(req);
  const coursework = await publishAsMaterial(req, session, "tutorial");
  return res.status(201).json(coursework);
};

/**
 * Promotes the reviewed quiz draft to a real quiz. It is created unpublished so
 * the teacher still gets a final look and can set timing before students see it.
 */
exports.createQuizFromDraft = async (req, res) => {
  const session = await loadSessionForWork(req);
  const questions = Array.isArray(req.body.questions) && req.body.questions.length
    ? req.body.questions
    : session.quizDraft.questions;

  if (!questions?.length) {
    return res.status(400).json({ message: "There are no draft questions to turn into a quiz." });
  }

  const quiz = new LmQuiz({
    classId: req.lmClass._id,
    title: String(req.body.title || "").trim() || `Quiz — ${session.title}`,
    description: req.body.description || `Auto-generated from the lecture on ${new Date(
      session.lectureDate,
    ).toLocaleDateString("en-IN")}.`,
    source: "ai",
    audioSessionId: session._id,
    questions,
    createdBy: req.lmUser.id,
    createdByName: req.lmUser.name,
    published: false,
  });
  if (req.body.settings) Object.assign(quiz.settings, req.body.settings);
  await quiz.save();

  session.generatedQuizId = quiz._id;
  log(session, "quiz", `Quiz "${quiz.title}" created with ${questions.length} questions.`);
  await session.save();

  return res.status(201).json(quiz);
};

/** Status/config panel for the AI Studio header. */
exports.getStudioStatus = async (req, res) =>
  res.json({
    aiProvider: ai.providerName(),
    aiConfigured: ai.isConfigured(),
    transcriptionConfigured: recordings.isTranscriptionConfigured(),
    mlServiceUrl: process.env.ML_SERVICE_URL ? "configured" : "default (localhost:8500)",
  });
