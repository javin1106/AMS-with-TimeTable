const LmQuiz = require("../models/lmQuiz");
const LmQuizAttempt = require("../models/lmQuizAttempt");
const LmCoursework = require("../models/lmCoursework");
const LmSubmission = require("../models/lmSubmission");
const { seedSubmissions } = require("./courseworkController");
const { notifyClass } = require("../services/notifyService");

// Strips the answer key. Applied to every student-facing read of a quiz.
const forStudent = (quiz) => ({
  ...quiz,
  questions: (quiz.questions || []).map((q) => ({
    _id: q._id,
    question: q.question,
    type: q.type,
    options: q.options,
    marks: q.marks,
    negativeMarks: q.negativeMarks,
    difficulty: q.difficulty,
    topic: q.topic,
  })),
});

const isAvailable = (quiz) => {
  const now = new Date();
  if (quiz.settings?.availableFrom && now < quiz.settings.availableFrom) return false;
  if (quiz.settings?.availableTo && now > quiz.settings.availableTo) return false;
  return true;
};

exports.listQuizzes = async (req, res) => {
  const filter = { classId: req.lmClass._id, ...(req.lmIsTeacher ? {} : { published: true }) };
  const quizzes = await LmQuiz.find(filter).sort({ created_at: -1 }).lean();

  if (req.lmIsTeacher) {
    const counts = await LmQuizAttempt.aggregate([
      { $match: { classId: req.lmClass._id, status: "submitted" } },
      { $group: { _id: "$quizId", attempts: { $sum: 1 }, avg: { $avg: "$percent" } } },
    ]);
    const byQuiz = new Map(counts.map((c) => [String(c._id), c]));
    return res.json(
      quizzes.map((q) => ({
        ...q,
        stats: byQuiz.get(String(q._id)) || { attempts: 0, avg: null },
      })),
    );
  }

  const myAttempts = await LmQuizAttempt.find({
    classId: req.lmClass._id,
    studentId: req.lmUser.id,
  })
    .select("quizId status score maxScore percent attemptNumber submittedAt")
    .lean();
  const byQuiz = new Map();
  myAttempts.forEach((a) => {
    const key = String(a.quizId);
    const best = byQuiz.get(key);
    if (!best || (a.percent || 0) > (best.percent || 0)) byQuiz.set(key, a);
  });

  return res.json(
    quizzes.map((q) => ({
      ...forStudent(q),
      attemptsUsed: myAttempts.filter((a) => String(a.quizId) === String(q._id)).length,
      bestAttempt: byQuiz.get(String(q._id)) || null,
      available: isAvailable(q),
    })),
  );
};

exports.createQuiz = async (req, res) => {
  const title = String(req.body.title || "").trim();
  if (!title) return res.status(400).json({ message: "A quiz title is required." });

  const quiz = new LmQuiz({
    classId: req.lmClass._id,
    title,
    description: req.body.description || "",
    source: req.body.source === "ai" ? "ai" : "manual",
    audioSessionId: req.body.audioSessionId || null,
    questions: Array.isArray(req.body.questions) ? req.body.questions : [],
    createdBy: req.lmUser.id,
    createdByName: req.lmUser.name,
  });
  if (req.body.settings) Object.assign(quiz.settings, req.body.settings);
  await quiz.save();
  return res.status(201).json(quiz);
};

exports.getQuiz = async (req, res) => {
  const quiz = await LmQuiz.findOne({ _id: req.params.quizId, classId: req.lmClass._id }).lean();
  if (!quiz) return res.status(404).json({ message: "Quiz not found." });
  if (req.lmIsTeacher) return res.json(quiz);
  if (!quiz.published) return res.status(404).json({ message: "Quiz not found." });

  const attempts = await LmQuizAttempt.find({ quizId: quiz._id, studentId: req.lmUser.id })
    .sort({ attemptNumber: 1 })
    .lean();

  return res.json({
    ...forStudent(quiz),
    attempts: attempts.map((a) => ({
      _id: a._id,
      attemptNumber: a.attemptNumber,
      status: a.status,
      score: a.score,
      maxScore: a.maxScore,
      percent: a.percent,
      passed: a.passed,
      submittedAt: a.submittedAt,
    })),
    attemptsUsed: attempts.length,
    available: isAvailable(quiz),
  });
};

exports.updateQuiz = async (req, res) => {
  const quiz = await LmQuiz.findOne({ _id: req.params.quizId, classId: req.lmClass._id });
  if (!quiz) return res.status(404).json({ message: "Quiz not found." });

  if (req.body.title !== undefined) quiz.title = String(req.body.title);
  if (req.body.description !== undefined) quiz.description = String(req.body.description);
  if (Array.isArray(req.body.questions)) quiz.questions = req.body.questions;
  if (req.body.settings) Object.assign(quiz.settings, req.body.settings);

  quiz.updated_at = new Date();
  await quiz.save();
  return res.json(quiz);
};

exports.deleteQuiz = async (req, res) => {
  const quiz = await LmQuiz.findOne({ _id: req.params.quizId, classId: req.lmClass._id });
  if (!quiz) return res.status(404).json({ message: "Quiz not found." });
  await LmQuizAttempt.deleteMany({ quizId: quiz._id });
  await LmCoursework.updateMany({ quizId: quiz._id }, { $set: { quizId: null } });
  await LmQuiz.deleteOne({ _id: quiz._id });
  return res.json({ deleted: true });
};

/**
 * Publishing a quiz also drops a Classwork item in front of the students —
 * otherwise a published quiz would only be reachable from the Quizzes tab and
 * would never appear in the stream, the to-do list or the gradebook.
 */
exports.publishQuiz = async (req, res) => {
  const quiz = await LmQuiz.findOne({ _id: req.params.quizId, classId: req.lmClass._id });
  if (!quiz) return res.status(404).json({ message: "Quiz not found." });
  if (!quiz.questions.length) {
    return res.status(400).json({ message: "Add at least one question before publishing." });
  }

  quiz.published = req.body.publish !== false;
  await quiz.save();

  if (!quiz.published) {
    await LmCoursework.updateMany({ quizId: quiz._id }, { $set: { status: "draft" } });
    return res.json({ published: false });
  }

  let coursework = await LmCoursework.findOne({ quizId: quiz._id, classId: req.lmClass._id });
  if (coursework) {
    coursework.status = "published";
    coursework.title = quiz.title;
    coursework.points = quiz.totalMarks;
    if (req.body.dueDate !== undefined) {
      coursework.dueDate = req.body.dueDate ? new Date(req.body.dueDate) : null;
    }
    await coursework.save();
  } else {
    coursework = await LmCoursework.create({
      classId: req.lmClass._id,
      workType: "quiz",
      title: quiz.title,
      instructions: quiz.description,
      points: quiz.totalMarks,
      dueDate: req.body.dueDate ? new Date(req.body.dueDate) : quiz.settings.availableTo || null,
      quizId: quiz._id,
      aiSourceSessionId: quiz.audioSessionId || null,
      createdBy: req.lmUser.id,
      createdByName: req.lmUser.name,
    });
  }

  // Same seeding as any other published item, so the quiz shows up in every
  // student's to-do list and in the teacher's review grid before anyone
  // attempts it.
  await seedSubmissions(coursework, req.lmClass);

  await notifyClass({
    klass: req.lmClass,
    excludeUserId: req.lmUser.id,
    type: "quiz",
    title: `New quiz in ${req.lmClass.name}: ${quiz.title}`,
    body: `${quiz.questions.length} questions · ${quiz.totalMarks} marks`,
    link: `/learning/class/${req.lmClass._id}/quiz/${quiz._id}`,
    actorName: req.lmUser.name,
    email: true,
  });

  return res.json({ published: true, courseworkId: coursework._id });
};

/* ───────────────────────────── attempts ──────────────────────────────── */

exports.startAttempt = async (req, res) => {
  const quiz = await LmQuiz.findOne({
    _id: req.params.quizId,
    classId: req.lmClass._id,
    published: true,
  }).lean();
  if (!quiz) return res.status(404).json({ message: "Quiz not found." });
  if (!isAvailable(quiz)) {
    return res.status(400).json({ message: "This quiz is not open right now." });
  }

  const existing = await LmQuizAttempt.find({ quizId: quiz._id, studentId: req.lmUser.id }).sort({
    attemptNumber: -1,
  });

  // Resume rather than start over if the student's tab crashed mid-attempt.
  const inProgress = existing.find((a) => a.status === "in_progress");
  if (inProgress) {
    return res.json({ attempt: inProgress, quiz: forStudent(quiz), resumed: true });
  }

  const allowed = quiz.settings.attemptsAllowed || 1;
  if (existing.length >= allowed) {
    return res.status(400).json({ message: `You have used all ${allowed} attempt(s).` });
  }

  const attempt = await LmQuizAttempt.create({
    quizId: quiz._id,
    classId: req.lmClass._id,
    studentId: req.lmUser.id,
    studentName: req.lmUser.name,
    attemptNumber: existing.length + 1,
    maxScore: quiz.totalMarks,
  });

  let questions = forStudent(quiz).questions;
  if (quiz.settings.shuffleQuestions) {
    questions = [...questions].sort(() => Math.random() - 0.5);
  }

  return res.status(201).json({
    attempt,
    quiz: { ...forStudent(quiz), questions },
    resumed: false,
  });
};

// Answers are compared as sets of strings so ordering never matters and msq
// works with the same code path as mcq.
const sameSet = (a, b) => {
  const left = new Set((a || []).map(String));
  const right = new Set((b || []).map(String));
  if (left.size !== right.size) return false;
  return [...left].every((value) => right.has(value));
};

exports.submitAttempt = async (req, res) => {
  const attempt = await LmQuizAttempt.findOne({
    _id: req.params.attemptId,
    classId: req.lmClass._id,
    studentId: req.lmUser.id,
  });
  if (!attempt) return res.status(404).json({ message: "Attempt not found." });
  if (attempt.status !== "in_progress") {
    return res.status(400).json({ message: "This attempt was already submitted." });
  }

  const quiz = await LmQuiz.findById(attempt.quizId).lean();
  if (!quiz) return res.status(404).json({ message: "Quiz not found." });

  const submitted = Array.isArray(req.body.answers) ? req.body.answers : [];
  const byQuestion = new Map(submitted.map((a) => [String(a.questionId), a]));

  let score = 0;
  const graded = quiz.questions.map((question) => {
    const given = byQuestion.get(String(question._id)) || {};
    let correct = false;

    if (question.type === "short") {
      // Short answers are auto-marked only on an exact case-insensitive match;
      // anything else is left for the teacher, who sees them in the results.
      const expected = (question.correctAnswers || []).map((s) => String(s).trim().toLowerCase());
      correct = expected.includes(String(given.text || "").trim().toLowerCase());
    } else {
      correct = sameSet(given.selected, question.correctAnswers);
    }

    const answered = question.type === "short" ? Boolean(given.text) : Boolean(given.selected?.length);
    const awarded = correct ? question.marks : answered ? -(question.negativeMarks || 0) : 0;
    score += awarded;

    return {
      questionId: question._id,
      selected: given.selected || [],
      text: given.text || "",
      correct,
      awarded,
    };
  });

  const now = new Date();
  attempt.answers = graded;
  attempt.score = Math.max(0, Math.round(score * 100) / 100);
  attempt.maxScore = quiz.totalMarks;
  attempt.percent = quiz.totalMarks ? Math.round((attempt.score / quiz.totalMarks) * 1000) / 10 : 0;
  attempt.passed = attempt.percent >= (quiz.settings.passPercent || 0);
  attempt.status = "submitted";
  attempt.submittedAt = now;
  attempt.durationSec = Math.round((now - attempt.startedAt) / 1000);
  await attempt.save();

  // Mirror the result into the gradebook so quizzes and assignments are marked
  // in one place.
  const coursework = await LmCoursework.findOne({ quizId: quiz._id, classId: req.lmClass._id });
  if (coursework) {
    await LmSubmission.findOneAndUpdate(
      { courseworkId: coursework._id, studentId: req.lmUser.id },
      {
        $set: {
          classId: req.lmClass._id,
          studentName: req.lmUser.name,
          studentEmail: req.lmUser.email,
          state: "returned",
          grade: attempt.score,
          maxPoints: quiz.totalMarks,
          turnedInAt: now,
          returnedAt: now,
          gradedAt: now,
          gradedByName: "Auto-graded",
          feedback: `Quiz auto-graded: ${attempt.score}/${quiz.totalMarks} (${attempt.percent}%)`,
        },
      },
      { upsert: true },
    );
  }

  const reveal = quiz.settings.showAnswersAfterSubmit;
  return res.json({
    attempt,
    review: reveal
      ? quiz.questions.map((question, index) => ({
          question: question.question,
          type: question.type,
          options: question.options,
          correctAnswers: question.correctAnswers,
          explanation: question.explanation,
          sourceExcerpt: question.sourceExcerpt,
          yourAnswer: graded[index],
        }))
      : null,
  });
};

exports.getAttempt = async (req, res) => {
  const attempt = await LmQuizAttempt.findOne({
    _id: req.params.attemptId,
    classId: req.lmClass._id,
  }).lean();
  if (!attempt) return res.status(404).json({ message: "Attempt not found." });
  if (!req.lmIsTeacher && String(attempt.studentId) !== req.lmUser.id) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const quiz = await LmQuiz.findById(attempt.quizId).lean();
  const reveal = req.lmIsTeacher || quiz?.settings?.showAnswersAfterSubmit;

  return res.json({
    attempt,
    quiz: reveal ? quiz : forStudent(quiz || {}),
  });
};

/** Teacher-facing results table plus per-question difficulty analysis. */
exports.getQuizResults = async (req, res) => {
  const quiz = await LmQuiz.findOne({ _id: req.params.quizId, classId: req.lmClass._id }).lean();
  if (!quiz) return res.status(404).json({ message: "Quiz not found." });

  const attempts = await LmQuizAttempt.find({ quizId: quiz._id, status: "submitted" })
    .sort({ percent: -1 })
    .lean();

  const perQuestion = quiz.questions.map((question) => {
    const responses = attempts
      .map((a) => a.answers.find((ans) => String(ans.questionId) === String(question._id)))
      .filter(Boolean);
    const correct = responses.filter((r) => r.correct).length;
    return {
      questionId: question._id,
      question: question.question,
      topic: question.topic,
      difficulty: question.difficulty,
      responses: responses.length,
      correct,
      correctPercent: responses.length ? Math.round((correct / responses.length) * 1000) / 10 : null,
    };
  });

  const percents = attempts.map((a) => a.percent);
  const sorted = [...percents].sort((a, b) => a - b);

  return res.json({
    quiz,
    attempts,
    summary: {
      attempts: attempts.length,
      average: percents.length
        ? Math.round((percents.reduce((a, b) => a + b, 0) / percents.length) * 10) / 10
        : null,
      median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
      highest: sorted.length ? sorted[sorted.length - 1] : null,
      lowest: sorted.length ? sorted[0] : null,
      passRate: attempts.length
        ? Math.round((attempts.filter((a) => a.passed).length / attempts.length) * 1000) / 10
        : null,
    },
    perQuestion,
  });
};
