const LmQuiz = require("../models/lmQuiz");
const LmQuizAttempt = require("../models/lmQuizAttempt");
const LmCoursework = require("../models/lmCoursework");
const LmSubmission = require("../models/lmSubmission");
const LmMembership = require("../models/lmMembership");
const User = require("../../../models/usermanagement/user");
const { seedSubmissions } = require("./courseworkController");
const engine = require("../services/examEngine");
const { duplicateOptionMessage } = require("../services/questionRules");
const { notifyClass, notifyUser } = require("../services/notifyService");
const game = require("../services/gamification");

/* ─────────────────────────────── helpers ──────────────────────────────── */

/**
 * A date field off the wire. Blank and unparseable both mean "no date" rather
 * than an Invalid Date, which mongoose would happily store and every comparison
 * downstream would then read as false.
 */
const readDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Teachers manage every quiz in their class; a quiz may additionally name
 * collaborators who can edit that one quiz without being class staff.
 */
const canManage = (req, quiz) =>
  req.lmIsTeacher ||
  (quiz.collaborators || []).some(
    (collaborator) =>
      String(collaborator.userId) === req.lmUser.id ||
      (collaborator.email && req.lmUser.emails.includes(String(collaborator.email).toLowerCase())),
  );

const requireManage = (req, res, quiz) => {
  if (canManage(req, quiz)) return true;
  res.status(403).json({ message: "You do not have edit access to this quiz." });
  return false;
};

/**
 * Who this paper belongs to, for the banner above a sitting.
 *
 * Sent with the quiz rather than read from the class the surrounding page
 * happens to have loaded: the test screen is the one place in the module that
 * renders outside the class layout, so it cannot rely on that being there.
 */
const paperHeader = (klass, quiz) => ({
  className: klass.name,
  subject: klass.subject || klass.name,
  // The subject's faculty first — the class owner — falling back to whoever set
  // the paper when a class predates the owner name being recorded.
  facultyName: klass.ownerName || quiz?.createdByName || "",
});

/** Answer key stripped. Applied to every student-facing read of a quiz. */
const forStudent = (quiz) => ({
  ...quiz,
  questions: (quiz.questions || []).map((question) => engine.questionForStudent(question, null)),
});

const optionOrderOf = (attempt) =>
  attempt.optionOrder instanceof Map
    ? Object.fromEntries(attempt.optionOrder)
    : attempt.optionOrder || {};

/** Everything a student may see about their own attempt. */
const attemptForStudent = (attempt, quiz, now = new Date()) => {
  const reveal = attempt.status !== "in_progress" && engine.resultsVisible(quiz, now);
  const showScore = reveal && quiz.settings?.showScoreImmediately !== false;

  return {
    _id: attempt._id,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    startedAt: attempt.startedAt,
    submittedAt: attempt.submittedAt,
    durationSec: attempt.durationSec,
    cursor: attempt.cursor,
    totalQuestions: (attempt.questionOrder || []).length,
    tabSwitches: attempt.tabSwitches,
    terminationReason: attempt.terminationReason,
    resultsPending: attempt.status !== "in_progress" && !reveal,
    ...(showScore
      ? {
          score: attempt.score,
          maxScore: attempt.maxScore,
          percent: attempt.percent,
          passed: attempt.passed,
          totalCorrect: attempt.totalCorrect,
          totalWrong: attempt.totalWrong,
          totalUnattempted: attempt.totalUnattempted,
          negativeApplied: attempt.negativeApplied,
          sectionScores: attempt.sectionScores,
        }
      : {}),
  };
};

/* ───────────────────────────── authoring ──────────────────────────────── */

/**
 * Normalises an incoming question list: resolves section names, coerces the
 * aim2Crack type names, and clamps timings.
 */
const prepareQuestions = (input, sections) => {
  const byId = new Map((sections || []).map((section) => [String(section._id), section]));
  const TYPE_ALIASES = { single: "mcq", multiple: "msq", integer: "numerical" };

  return (Array.isArray(input) ? input : []).map((question, index) => {
    const type = TYPE_ALIASES[question.type] || question.type;
    const section = question.sectionId ? byId.get(String(question.sectionId)) : null;

    return {
      _id: question._id || undefined,
      question: String(question.question || ""),
      type: ["mcq", "msq", "truefalse", "numerical"].includes(type) ? type : "mcq",
      options: Array.isArray(question.options) ? question.options.map(String) : [],
      correctAnswers: Array.isArray(question.correctAnswers)
        ? question.correctAnswers.map(String)
        : [String(question.correctAnswers ?? "")].filter(Boolean),
      tolerancePercent: Number(question.tolerancePercent) || 0,
      toleranceAbs: Number(question.toleranceAbs) || 0,
      explanation: String(question.explanation || ""),
      marks: Number(question.marks) || 1,
      negativeMarks:
        question.negativeMarks === null || question.negativeMarks === undefined || question.negativeMarks === ""
          ? null
          : Number(question.negativeMarks),
      difficulty: ["easy", "medium", "hard"].includes(question.difficulty) ? question.difficulty : "medium",
      topic: String(question.topic || ""),
      timeLimitSec: Math.max(0, Math.min(Number(question.timeLimitSec) || 0, 7200)),
      sectionId: section?._id || null,
      sectionName: section?.name || "",
      order: Number.isFinite(Number(question.order)) ? Number(question.order) : index,
      sourceExcerpt: String(question.sourceExcerpt || "").slice(0, 400),
    };
  });
};

/**
 * Keeps the two timing methods exclusive, whatever a client sends.
 *
 * Per-question timers are only enforceable when the server hands out one
 * question at a time (the all-at-once page runs a single paper clock, and
 * `questionDeadline` is called with no question there), so an all-at-once quiz
 * always falls back to the whole-paper clock. Mutate the merged settings rather
 * than the request body, so a partial update is judged on the end state.
 */
const normaliseTiming = (settings) => {
  if (settings.deliveryMode !== "one_at_a_time") settings.perQuestionTiming = false;
  if (settings.perQuestionTiming) {
    settings.timeLimitMinutes = 0;
    // Backtracking is only offered under the whole-paper clock: re-serving a
    // question restamps `currentServedAt`, so a student could farm a fresh
    // countdown by stepping back and forward again.
    settings.allowBacktracking = false;
  }
  settings.defaultQuestionSec = Math.max(0, Math.min(Number(settings.defaultQuestionSec) || 0, 7200));
  return settings;
};

const prepareSections = (input) =>
  (Array.isArray(input) ? input : []).map((section, index) => ({
    _id: section._id || undefined,
    name: String(section.name || `Section ${index + 1}`).trim(),
    order: Number.isFinite(Number(section.order)) ? Number(section.order) : index,
    instructions: String(section.instructions || ""),
    timeLimitSec: Math.max(0, Number(section.timeLimitSec) || 0),
  }));

exports.listQuizzes = async (req, res) => {
  const now = new Date();
  const filter = {
    classId: req.lmClass._id,
    ...(req.lmIsTeacher ? {} : engine.liveQuizFilter(now)),
  };
  const quizzes = await LmQuiz.find(filter).sort({ created_at: -1 }).lean();

  if (req.lmIsTeacher) {
    const stats = await LmQuizAttempt.aggregate([
      { $match: { classId: req.lmClass._id, status: { $in: ["submitted", "expired", "terminated"] } } },
      {
        $group: {
          _id: "$quizId",
          attempts: { $sum: 1 },
          avg: { $avg: "$percent" },
          // When the cohort actually finished, which is the honest answer to
          // "when did this test complete" — a window that closes at midnight
          // says nothing about a test everyone had left by 10:20.
          lastSubmittedAt: { $max: "$submittedAt" },
        },
      },
    ]);
    const byQuiz = new Map(stats.map((entry) => [String(entry._id), entry]));

    // Who is sitting right now. The card cannot say a test is live from the
    // window alone: "open until Friday" is not the same thing as anyone being
    // in it, and it is the second one a teacher is watching for.
    const sittingNow = await LmQuizAttempt.aggregate([
      { $match: { classId: req.lmClass._id, status: "in_progress" } },
      { $group: { _id: "$quizId", count: { $sum: 1 } } },
    ]);
    const liveByQuiz = new Map(sittingNow.map((entry) => [String(entry._id), entry.count]));

    return res.json(
      quizzes.map((quiz) => ({
        ...quiz,
        stats: byQuiz.get(String(quiz._id)) || { attempts: 0, avg: null, lastSubmittedAt: null },
        sittingNow: liveByQuiz.get(String(quiz._id)) || 0,
        window: engine.windowState(quiz, now),
        publish: engine.publishState(quiz, now),
      })),
    );
  }

  const myAttempts = await LmQuizAttempt.find({
    classId: req.lmClass._id,
    studentId: req.lmUser.id,
  })
    .select("quizId status score maxScore percent passed attemptNumber submittedAt")
    .lean();

  return res.json(
    quizzes.map((quiz) => {
      const mine = myAttempts.filter((attempt) => String(attempt.quizId) === String(quiz._id));
      const best = mine.reduce((top, attempt) => (!top || attempt.percent > top.percent ? attempt : top), null);
      const visible = engine.resultsVisible(quiz, now);
      // Deliberately outside the `visible` gate below. When a student finished
      // is not a mark and does not leak one — withholding it while withholding
      // the score just leaves them unsure whether the submission registered at
      // all, which is the anxious question they ask staff about.
      const submitted = mine
        .map((attempt) => attempt.submittedAt)
        .filter(Boolean)
        .sort((a, b) => new Date(b) - new Date(a));
      return {
        completedAt: submitted[0] || null,
        inProgress: mine.some((attempt) => attempt.status === "in_progress"),
        _id: quiz._id,
        title: quiz.title,
        description: quiz.description,
        totalMarks: quiz.totalMarks,
        questionCount: quiz.questions.length,
        sections: quiz.sections,
        settings: quiz.settings,
        attemptsUsed: mine.length,
        bestAttempt: visible ? best : null,
        resultsPending: Boolean(best && !visible),
        window: engine.windowState(quiz, now),
        estimatedDurationSec: engine.estimatedDurationSec(quiz),
      };
    }),
  );
};

exports.createQuiz = async (req, res) => {
  const title = String(req.body.title || "").trim();
  if (!title) return res.status(400).json({ message: "A quiz title is required." });

  const sections = prepareSections(req.body.sections);
  const questions = prepareQuestions(req.body.questions, sections);
  const duplicates = duplicateOptionMessage(questions);
  if (duplicates) return res.status(400).json({ message: duplicates });

  const quiz = new LmQuiz({
    classId: req.lmClass._id,
    title,
    description: req.body.description || "",
    source: req.body.source === "ai" ? "ai" : "manual",
    audioSessionId: req.body.audioSessionId || null,
    instructions: Array.isArray(req.body.instructions) ? req.body.instructions.map(String) : [],
    sections,
    questions,
    createdBy: req.lmUser.id,
    createdByName: req.lmUser.name,
  });
  if (req.body.settings) Object.assign(quiz.settings, req.body.settings);
  normaliseTiming(quiz.settings);
  await quiz.save();
  return res.status(201).json(quiz);
};

exports.getQuiz = async (req, res) => {
  const quiz = await LmQuiz.findOne({ _id: req.params.quizId, classId: req.lmClass._id }).lean();
  if (!quiz) return res.status(404).json({ message: "Quiz not found." });
  const now = new Date();

  if (canManage(req, quiz)) {
    return res.json({
      ...quiz,
      ...paperHeader(req.lmClass, quiz),
      window: engine.windowState(quiz, now),
      publish: engine.publishState(quiz, now),
      canManage: true,
    });
  }
  // A dated publish is not a publish yet — until then the quiz does not exist
  // as far as anyone holding the link is concerned.
  if (!engine.isLive(quiz, now)) return res.status(404).json({ message: "Quiz not found." });

  const attempts = await LmQuizAttempt.find({ quizId: quiz._id, studentId: req.lmUser.id })
    .sort({ attemptNumber: 1 })
    .lean();

  return res.json({
    ...forStudent(quiz),
    ...paperHeader(req.lmClass, quiz),
    attempts: attempts.map((attempt) => attemptForStudent(attempt, quiz, now)),
    attemptsUsed: attempts.length,
    window: engine.windowState(quiz, now),
    estimatedDurationSec: engine.estimatedDurationSec(quiz),
    canManage: false,
  });
};

/**
 * The pre-test screen: instructions, timings and eligibility, without handing
 * out a single question.
 */
exports.getQuizBrief = async (req, res) => {
  const now = new Date();
  const quiz = await LmQuiz.findOne({
    _id: req.params.quizId,
    classId: req.lmClass._id,
    ...engine.liveQuizFilter(now),
  }).lean();
  if (!quiz) return res.status(404).json({ message: "Quiz not found." });

  const attempts = await LmQuizAttempt.find({ quizId: quiz._id, studentId: req.lmUser.id }).lean();
  const inProgress = attempts.find((attempt) => attempt.status === "in_progress");

  return res.json({
    _id: quiz._id,
    title: quiz.title,
    description: quiz.description,
    ...paperHeader(req.lmClass, quiz),
    createdByName: quiz.createdByName,
    instructions: quiz.instructions,
    sections: quiz.sections.map((section) => ({
      ...section,
      questionCount: quiz.questions.filter((q) => String(q.sectionId) === String(section._id)).length,
      marks: quiz.questions
        .filter((q) => String(q.sectionId) === String(section._id))
        .reduce((sum, q) => sum + (q.marks || 0), 0),
    })),
    questionCount: quiz.settings.questionsPerAttempt || quiz.questions.length,
    totalMarks: quiz.totalMarks,
    estimatedDurationSec: engine.estimatedDurationSec(quiz),
    settings: quiz.settings,
    window: engine.windowState(quiz, now),
    attemptsUsed: attempts.length,
    hasInProgress: Boolean(inProgress),
    inProgressId: inProgress?._id || null,
  });
};

exports.updateQuiz = async (req, res) => {
  const quiz = await LmQuiz.findOne({ _id: req.params.quizId, classId: req.lmClass._id });
  if (!quiz) return res.status(404).json({ message: "Quiz not found." });
  if (!requireManage(req, res, quiz)) return undefined;

  if (req.body.title !== undefined) quiz.title = String(req.body.title);
  if (req.body.description !== undefined) quiz.description = String(req.body.description);
  if (req.body.instructions !== undefined) {
    quiz.instructions = (Array.isArray(req.body.instructions) ? req.body.instructions : [])
      .map(String)
      .filter((line) => line.trim());
  }
  if (req.body.sections !== undefined) quiz.sections = prepareSections(req.body.sections);
  if (req.body.questions !== undefined) {
    const questions = prepareQuestions(req.body.questions, quiz.sections);
    const duplicates = duplicateOptionMessage(questions);
    if (duplicates) return res.status(400).json({ message: duplicates });
    quiz.questions = questions;
  }
  if (req.body.settings) Object.assign(quiz.settings, req.body.settings);
  normaliseTiming(quiz.settings);

  quiz.updated_at = new Date();
  await quiz.save();
  return res.json(quiz);
};

/** Adds or removes co-authors by email. */
exports.setCollaborators = async (req, res) => {
  const quiz = await LmQuiz.findOne({ _id: req.params.quizId, classId: req.lmClass._id });
  if (!quiz) return res.status(404).json({ message: "Quiz not found." });
  if (!req.lmIsTeacher) {
    return res.status(403).json({ message: "Only a class teacher can change collaborators." });
  }

  const emails = (Array.isArray(req.body.emails) ? req.body.emails : String(req.body.emails || "").split(/[\s,;]+/))
    .map((email) => String(email || "").trim().toLowerCase())
    .filter(Boolean);

  const users = await User.find({ email: { $in: emails } }).select("name email").lean();
  const byEmail = new Map();
  users.forEach((user) => {
    (Array.isArray(user.email) ? user.email : [user.email]).forEach((address) => {
      if (address) byEmail.set(String(address).toLowerCase(), user);
    });
  });

  quiz.collaborators = emails.map((email) => {
    const user = byEmail.get(email);
    return { userId: user?._id || null, email, name: user?.name || "" };
  });
  await quiz.save();

  return res.json({ collaborators: quiz.collaborators });
};

exports.deleteQuiz = async (req, res) => {
  const quiz = await LmQuiz.findOne({ _id: req.params.quizId, classId: req.lmClass._id });
  if (!quiz) return res.status(404).json({ message: "Quiz not found." });
  if (!requireManage(req, res, quiz)) return undefined;

  await LmQuizAttempt.deleteMany({ quizId: quiz._id });
  await LmCoursework.updateMany({ quizId: quiz._id }, { $set: { quizId: null } });
  await LmQuiz.deleteOne({ _id: quiz._id });
  return res.json({ deleted: true });
};

/** Wipes every attempt so a quiz can be re-run with the same cohort. */
exports.deleteResponses = async (req, res) => {
  const quiz = await LmQuiz.findOne({ _id: req.params.quizId, classId: req.lmClass._id });
  if (!quiz) return res.status(404).json({ message: "Quiz not found." });
  if (!requireManage(req, res, quiz)) return undefined;

  const result = await LmQuizAttempt.deleteMany({ quizId: quiz._id });

  // Reset the mirrored gradebook rows too, or students keep a score for an
  // attempt that no longer exists.
  const coursework = await LmCoursework.findOne({ quizId: quiz._id, classId: req.lmClass._id });
  if (coursework) {
    await LmSubmission.updateMany(
      { courseworkId: coursework._id },
      {
        $set: {
          state: "assigned",
          grade: null,
          feedback: "",
          turnedInAt: null,
          returnedAt: null,
          gradedAt: null,
        },
      },
    );
  }
  return res.json({ deleted: result.deletedCount });
};

exports.publishQuiz = async (req, res) => {
  const quiz = await LmQuiz.findOne({ _id: req.params.quizId, classId: req.lmClass._id });
  if (!quiz) return res.status(404).json({ message: "Quiz not found." });
  if (!requireManage(req, res, quiz)) return undefined;
  if (!quiz.questions.length) {
    return res.status(400).json({ message: "Add at least one question before publishing." });
  }

  // Checked again here rather than trusted from the save: a quiz authored
  // before this rule existed has never been through the save path since.
  const duplicates = duplicateOptionMessage(quiz.questions);
  if (duplicates) return res.status(400).json({ message: duplicates });

  // A per-question-timed paper with a question that has no clock would hang the
  // student on that question forever — and with the whole-paper clock now held
  // at 0 in this mode, there is no fallback to catch it.
  if (quiz.settings.perQuestionTiming) {
    const untimed = quiz.questions.filter((question) => !question.timeLimitSec);
    if (untimed.length) {
      return res.status(400).json({
        message: `Per-question timing is on but ${untimed.length} question(s) have no time limit. Set a time on each question, or switch to a single timer for the whole paper.`,
      });
    }
  }

  const now = new Date();
  const link = `/learning/class/${req.lmClass._id}/quiz/${quiz._id}`;

  quiz.published = req.body.publish !== false;

  if (!quiz.published) {
    quiz.publishAt = null;
    await quiz.save();
    await LmCoursework.updateMany({ quizId: quiz._id }, { $set: { status: "draft" } });
    return res.json({ published: false });
  }

  // The three clocks, set together because only together do they make sense.
  // `publishAt` decides when the link answers; `availableFrom` when the Start
  // button unlocks behind it; `startDeadline` when it locks again for anyone
  // who has not begun. Out of order they produce a quiz nobody can ever sit,
  // so the ordering is checked here rather than discovered on the day.
  const publishAt = readDate(req.body.publishAt);
  const availableFrom = readDate(req.body.availableFrom);
  const startDeadline = readDate(req.body.startDeadline);

  if (publishAt && availableFrom && availableFrom < publishAt) {
    return res.status(400).json({
      message: "The quiz cannot start before it is published. Move the start time later, or publish earlier.",
    });
  }
  if (startDeadline && availableFrom && startDeadline < availableFrom) {
    return res.status(400).json({
      message: "Entry would close before the quiz opens. Move the entry cut-off later than the start time.",
    });
  }
  if (startDeadline && publishAt && startDeadline < publishAt) {
    return res.status(400).json({
      message: "Entry would close before the quiz is published. Move the entry cut-off later.",
    });
  }

  quiz.publishAt = publishAt && publishAt > now ? publishAt : null;
  if (req.body.availableFrom !== undefined) quiz.settings.availableFrom = availableFrom;
  if (req.body.availableTo !== undefined) quiz.settings.availableTo = readDate(req.body.availableTo);
  if (req.body.startDeadline !== undefined) {
    quiz.settings.startDeadline = startDeadline;
    // Clearing the cut-off has to clear the relative form too, or a quiz
    // carrying a legacy margin would silently keep turning latecomers away
    // after the teacher switched the option off.
    if (!startDeadline) quiz.settings.marginMinutes = 0;
  }
  if (req.body.marginMinutes !== undefined) {
    quiz.settings.marginMinutes = Math.max(0, Number(req.body.marginMinutes) || 0);
  }
  await quiz.save();

  const scheduled = Boolean(quiz.publishAt);
  const dueDate =
    req.body.dueDate !== undefined
      ? readDate(req.body.dueDate)
      : quiz.settings.availableTo || null;

  let coursework = await LmCoursework.findOne({ quizId: quiz._id, classId: req.lmClass._id });
  if (coursework) {
    // A scheduled publish rides the stream's own lazy release, so the class
    // entry appears at the same moment the link starts answering.
    coursework.status = scheduled ? "scheduled" : "published";
    coursework.scheduledFor = scheduled ? quiz.publishAt : null;
    coursework.title = quiz.title;
    coursework.points = quiz.totalMarks;
    if (req.body.dueDate !== undefined || req.body.availableTo !== undefined) {
      coursework.dueDate = dueDate;
    }
    await coursework.save();
  } else {
    coursework = await LmCoursework.create({
      classId: req.lmClass._id,
      workType: "quiz",
      title: quiz.title,
      instructions: quiz.description,
      points: quiz.totalMarks,
      dueDate,
      status: scheduled ? "scheduled" : "published",
      scheduledFor: scheduled ? quiz.publishAt : null,
      publishedAt: quiz.publishAt || now,
      quizId: quiz._id,
      aiSourceSessionId: quiz.audioSessionId || null,
      createdBy: req.lmUser.id,
      createdByName: req.lmUser.name,
    });
  }

  await seedSubmissions(coursework, req.lmClass);

  // Announcing a quiz nobody can open yet would only send the class to a 404;
  // the scheduled stream entry does the announcing when it goes live.
  //
  // `announcedAt` rather than "is this the first publish": a teacher who
  // corrects the window and saves again has not added a second quiz. It also
  // covers the other order — a quiz first scheduled, then brought forward to
  // publish now — which was announced by neither branch.
  if (!scheduled && !quiz.announcedAt) {
    quiz.announcedAt = now;
    await quiz.save();
    await notifyClass({
      klass: req.lmClass,
      excludeUserId: req.lmUser.id,
      type: "quiz",
      title: `New quiz in ${req.lmClass.name}: ${quiz.title}`,
      body: `${quiz.questions.length} questions · ${quiz.totalMarks} marks`,
      link,
      actorName: req.lmUser.name,
      email: true,
    });
  }

  return res.json({
    published: true,
    courseworkId: coursework._id,
    link,
    publish: engine.publishState(quiz, now),
    window: engine.windowState(quiz, now),
  });
};

/* ───────────────────────────── attempts ───────────────────────────────── */

const rollNumberOf = async (classId, userId) => {
  const membership = await LmMembership.findOne({ classId, userId }).select("rollNumber").lean();
  return membership?.rollNumber || "";
};

exports.startAttempt = async (req, res) => {
  const now = new Date();
  const quiz = await LmQuiz.findOne({
    _id: req.params.quizId,
    classId: req.lmClass._id,
    ...engine.liveQuizFilter(now),
  });
  if (!quiz) return res.status(404).json({ message: "Quiz not found." });

  const userAgent = req.get("User-Agent") || "";
  const isMobile = engine.isMobileUserAgent(userAgent);

  if (quiz.settings.preventMobile && isMobile) {
    return res.status(403).json({
      message: "This test must be taken on a laptop or desktop. Please switch device and try again.",
      code: "MOBILE_BLOCKED",
    });
  }

  const existing = await LmQuizAttempt.find({ quizId: quiz._id, studentId: req.lmUser.id }).sort({
    attemptNumber: 1,
  });

  // Resume rather than restart if a sitting is already open — a refresh or a
  // dropped connection must not cost the student their paper.
  const inProgress = existing.find((attempt) => attempt.status === "in_progress");
  if (inProgress) {
    return res.json({ attempt: attemptForStudent(inProgress, quiz, now), resumed: true });
  }

  const state = engine.windowState(quiz, now);
  if (!state.canStart) {
    const message = state.notYetOpen
      ? "This quiz has not opened yet."
      : state.closed
        ? "This quiz has closed."
        : "The window to start this quiz has passed.";
    return res.status(400).json({ message, code: "WINDOW_CLOSED", window: state });
  }

  // One sitting per student. A paper that went wrong is reopened by a teacher
  // deleting the attempt, not by the student starting a fresh one.
  if (existing.length) {
    return res.status(400).json({ message: "You have already attempted this quiz." });
  }

  const attemptNumber = existing.length + 1;
  const paper = engine.buildPaper(quiz.toObject(), req.lmUser.id, attemptNumber);

  const attempt = await LmQuizAttempt.create({
    quizId: quiz._id,
    classId: req.lmClass._id,
    studentId: req.lmUser.id,
    studentName: req.lmUser.name,
    studentEmail: req.lmUser.email,
    rollNumber: await rollNumberOf(req.lmClass._id, req.lmUser.id),
    attemptNumber,
    questionOrder: paper.questionOrder,
    optionOrder: paper.optionOrder,
    maxScore: paper.maxScore,
    cursor: 0,
    currentServedAt: now,
    device: { userAgent, isMobile },
  });

  return res.status(201).json({ attempt: attemptForStudent(attempt, quiz, now), resumed: false });
};

/**
 * The paper for an all-at-once sitting: every question at once, in this
 * student's order, with their option permutation applied.
 */
exports.getAttemptPaper = async (req, res) => {
  const attempt = await LmQuizAttempt.findOne({
    _id: req.params.attemptId,
    classId: req.lmClass._id,
    studentId: req.lmUser.id,
  });
  if (!attempt) return res.status(404).json({ message: "Attempt not found." });

  const quiz = await LmQuiz.findById(attempt.quizId).lean();
  if (!quiz) return res.status(404).json({ message: "Quiz not found." });

  const byId = new Map(quiz.questions.map((question) => [String(question._id), question]));
  const orders = optionOrderOf(attempt);
  const saved = new Map((attempt.responses || []).map((r) => [String(r.questionId), r]));

  const questions = attempt.questionOrder
    .map((questionId) => {
      const question = byId.get(String(questionId));
      if (!question) return null;
      const view = engine.questionForStudent(question, orders[String(questionId)]);
      const response = saved.get(String(questionId));
      return { ...view, saved: response ? { selected: response.selected, text: response.text } : null };
    })
    .filter(Boolean);

  return res.json({
    attempt: attemptForStudent(attempt, quiz),
    questions,
    deadline: engine.questionDeadline(quiz, attempt, null),
    settings: quiz.settings,
  });
};

/** One-at-a-time delivery: the question the student is currently on. */
exports.getCurrentQuestion = async (req, res) => {
  const attempt = await LmQuizAttempt.findOne({
    _id: req.params.attemptId,
    classId: req.lmClass._id,
    studentId: req.lmUser.id,
  });
  if (!attempt) return res.status(404).json({ message: "Attempt not found." });
  if (attempt.status !== "in_progress") {
    return res.status(400).json({ message: "This attempt is already finished.", code: "FINISHED" });
  }

  const quiz = await LmQuiz.findById(attempt.quizId);
  if (!quiz) return res.status(404).json({ message: "Quiz not found." });

  const total = attempt.questionOrder.length;
  if (attempt.cursor >= total) {
    return res.json({ done: true, cursor: attempt.cursor, totalQuestions: total });
  }

  const questionId = attempt.questionOrder[attempt.cursor];
  const question = quiz.questions.id(questionId);
  if (!question) {
    // The teacher deleted a question mid-sitting; skip past it rather than
    // stranding the student.
    attempt.cursor += 1;
    await attempt.save();
    return exports.getCurrentQuestion(req, res);
  }

  // Stamp the serve time once per question, so the server-side clock cannot be
  // reset by reloading the page.
  const existing = attempt.responses.find((r) => String(r.questionId) === String(questionId));
  if (!attempt.currentServedAt || (existing && !existing.servedAt)) {
    attempt.currentServedAt = new Date();
  }
  if (!existing) {
    attempt.responses.push({ questionId, servedAt: attempt.currentServedAt, sectionId: question.sectionId, sectionName: question.sectionName });
  }
  await attempt.save();

  const orders = optionOrderOf(attempt);
  return res.json({
    done: false,
    question: engine.questionForStudent(question, orders[String(questionId)]),
    cursor: attempt.cursor,
    totalQuestions: total,
    deadline: engine.questionDeadline(quiz, attempt, question),
    saved: existing ? { selected: existing.selected, text: existing.text } : null,
    canGoBack: Boolean(quiz.settings.allowBacktracking) && attempt.cursor > 0,
    section: question.sectionName || "",
  });
};

/**
 * Records the answer to the current question and advances.
 *
 * Time spent is computed from the server's own serve timestamp, so a client
 * cannot claim to have answered instantly.
 */
exports.answerAndAdvance = async (req, res) => {
  const attempt = await LmQuizAttempt.findOne({
    _id: req.params.attemptId,
    classId: req.lmClass._id,
    studentId: req.lmUser.id,
  });
  if (!attempt) return res.status(404).json({ message: "Attempt not found." });
  if (attempt.status !== "in_progress") {
    return res.status(400).json({ message: "This attempt is already finished.", code: "FINISHED" });
  }

  const quiz = await LmQuiz.findById(attempt.quizId);
  if (!quiz) return res.status(404).json({ message: "Quiz not found." });

  const direction = req.body.direction === "back" ? "back" : "forward";
  const questionId = attempt.questionOrder[attempt.cursor];

  if (questionId) {
    const question = quiz.questions.id(questionId);
    const orders = optionOrderOf(attempt);
    const selected = engine.normaliseSelected(req.body.selected, orders[String(questionId)]);
    const now = new Date();

    let response = attempt.responses.find((r) => String(r.questionId) === String(questionId));
    if (!response) {
      attempt.responses.push({ questionId, servedAt: attempt.currentServedAt || now });
      response = attempt.responses[attempt.responses.length - 1];
    }
    response.selected = selected;
    response.text = String(req.body.text ?? "");
    response.answeredAt = now;
    response.autoSubmitted = Boolean(req.body.autoSubmitted);
    response.sectionId = question?.sectionId || null;
    response.sectionName = question?.sectionName || "";
    // Accumulate rather than overwrite, so revisiting a question under
    // backtracking adds to the time spent instead of resetting it.
    const servedAt = response.servedAt ? new Date(response.servedAt) : now;
    response.timeSpentSec = (response.timeSpentSec || 0) + Math.max(0, Math.round((now - servedAt) / 1000));
  }

  if (direction === "back") {
    if (!quiz.settings.allowBacktracking) {
      return res.status(400).json({ message: "Going back is not allowed in this quiz." });
    }
    attempt.cursor = Math.max(0, attempt.cursor - 1);
  } else {
    attempt.cursor += 1;
  }
  attempt.currentServedAt = new Date();
  await attempt.save();

  if (attempt.cursor >= attempt.questionOrder.length) {
    // Last question answered — finalise immediately so the student cannot be
    // left with an un-submitted paper.
    const finished = await finaliseAttempt(attempt, quiz, req, "completed");
    return res.json({ done: true, attempt: attemptForStudent(finished, quiz) });
  }

  return exports.getCurrentQuestion(req, res);
};

/** Saves progress on an all-at-once paper without submitting. */
exports.saveAttemptDraft = async (req, res) => {
  const attempt = await LmQuizAttempt.findOne({
    _id: req.params.attemptId,
    classId: req.lmClass._id,
    studentId: req.lmUser.id,
  });
  if (!attempt) return res.status(404).json({ message: "Attempt not found." });
  if (attempt.status !== "in_progress") {
    return res.status(400).json({ message: "This attempt is already finished." });
  }

  const quiz = await LmQuiz.findById(attempt.quizId).lean();
  const orders = optionOrderOf(attempt);
  const allowed = new Set(attempt.questionOrder.map(String));

  (Array.isArray(req.body.answers) ? req.body.answers : []).forEach((entry) => {
    const key = String(entry.questionId);
    if (!allowed.has(key)) return;
    let response = attempt.responses.find((r) => String(r.questionId) === key);
    if (!response) {
      attempt.responses.push({ questionId: entry.questionId });
      response = attempt.responses[attempt.responses.length - 1];
    }
    response.selected = engine.normaliseSelected(entry.selected, orders[key]);
    response.text = String(entry.text ?? "");
    response.answeredAt = new Date();
  });

  attempt.updated_at = new Date();
  await attempt.save();
  return res.json({ saved: true, savedAt: attempt.updated_at, deadline: engine.questionDeadline(quiz, attempt, null) });
};

/**
 * Marks and closes an attempt, mirroring the result into the gradebook.
 * Shared by the student submit path, the auto-submit path and termination.
 */
async function finaliseAttempt(attempt, quiz, req, reason = "completed") {
  const now = new Date();
  const scored = engine.scoreAttempt(quiz.toObject ? quiz.toObject() : quiz, attempt);

  attempt.responses = scored.responses;
  attempt.score = scored.score;
  attempt.maxScore = scored.maxScore;
  attempt.percent = scored.percent;
  attempt.passed = scored.passed;
  attempt.totalCorrect = scored.totalCorrect;
  attempt.totalWrong = scored.totalWrong;
  attempt.totalUnattempted = scored.totalUnattempted;
  attempt.negativeApplied = scored.negativeApplied;
  attempt.sectionScores = scored.sectionScores;
  attempt.status = reason === "terminated" ? "terminated" : reason === "expired" ? "expired" : "submitted";
  if (reason === "terminated") attempt.terminationReason = req?.body?.reason || "Proctoring rule breached";
  attempt.submittedAt = now;
  attempt.durationSec = Math.round((now - new Date(attempt.startedAt)) / 1000);
  await attempt.save();

  // Sitting the paper is what pays; the score adds a modest bonus on top. The
  // marks are the teacher's business — points are not a second grade.
  await game.onQuizSubmitted({ req, quiz, percent: scored.percent, at: now });

  // Best-of across attempts. A student now sits a quiz once, but rows from
  // before that rule — or from a re-sit a teacher opened up — are still read.
  const coursework = await LmCoursework.findOne({ quizId: quiz._id, classId: attempt.classId });
  if (coursework) {
    const best = await LmQuizAttempt.find({
      quizId: quiz._id,
      studentId: attempt.studentId,
      status: { $in: ["submitted", "expired", "terminated"] },
    })
      .sort({ score: -1 })
      .limit(1)
      .lean();
    const bestScore = best[0]?.score ?? attempt.score;

    await LmSubmission.findOneAndUpdate(
      { courseworkId: coursework._id, studentId: attempt.studentId },
      {
        $set: {
          classId: attempt.classId,
          studentName: attempt.studentName,
          studentEmail: attempt.studentEmail,
          state: "returned",
          grade: bestScore,
          maxPoints: attempt.maxScore || quiz.totalMarks,
          turnedInAt: now,
          returnedAt: now,
          gradedAt: now,
          gradedByName: "Auto-graded",
          feedback: `Quiz auto-graded: ${bestScore}/${attempt.maxScore || quiz.totalMarks}`,
        },
      },
      { upsert: true },
    );
  }

  return attempt;
}

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

  const quiz = await LmQuiz.findById(attempt.quizId);
  if (!quiz) return res.status(404).json({ message: "Quiz not found." });

  // Accept a final batch of answers alongside the submit, which is how the
  // all-at-once player and the auto-submit-on-expiry path both behave.
  if (Array.isArray(req.body.answers)) {
    const orders = optionOrderOf(attempt);
    const allowed = new Set(attempt.questionOrder.map(String));
    req.body.answers.forEach((entry) => {
      const key = String(entry.questionId);
      if (!allowed.has(key)) return;
      let response = attempt.responses.find((r) => String(r.questionId) === key);
      if (!response) {
        attempt.responses.push({ questionId: entry.questionId });
        response = attempt.responses[attempt.responses.length - 1];
      }
      response.selected = engine.normaliseSelected(entry.selected, orders[key]);
      response.text = String(entry.text ?? "");
      response.answeredAt = new Date();
      if (entry.timeSpentSec) response.timeSpentSec = Number(entry.timeSpentSec) || 0;
    });
  }

  const reason = req.body.expired ? "expired" : "completed";
  const finished = await finaliseAttempt(attempt, quiz, req, reason);
  const now = new Date();
  const reveal = engine.resultsVisible(quiz, now);

  return res.json({
    attempt: attemptForStudent(finished, quiz, now),
    review:
      reveal && quiz.settings.showAnswersAfterSubmit
        ? buildReview(quiz, finished)
        : null,
  });
};

/** Per-question review shown after submitting, when the teacher allows it. */
function buildReview(quiz, attempt) {
  const byId = new Map(quiz.questions.map((question) => [String(question._id), question]));
  const orders = optionOrderOf(attempt);

  return (attempt.questionOrder || [])
    .map((questionId) => {
      const question = byId.get(String(questionId));
      if (!question) return null;
      const response = (attempt.responses || []).find((r) => String(r.questionId) === String(questionId));
      const order = orders[String(questionId)];

      // Present options — and the answer indices — in the order this student
      // actually saw, otherwise the highlighted answer points at the wrong row.
      const options = order ? order.map((index) => question.options[index]) : question.options;
      const remap = (indices) =>
        order
          ? (indices || []).map((original) => String(order.indexOf(Number(original)))).filter((i) => i !== "-1")
          : (indices || []).map(String);

      return {
        questionId: question._id,
        question: question.question,
        type: question.type,
        options,
        correctAnswers: question.type === "numerical"
          ? question.correctAnswers
          : remap(question.correctAnswers),
        explanation: question.explanation,
        sourceExcerpt: question.sourceExcerpt,
        marks: question.marks,
        sectionName: question.sectionName,
        timeSpentSec: response?.timeSpentSec || 0,
        yourAnswer: response
          ? {
              selected: remap(response.selected),
              text: response.text,
              correct: response.correct,
              awarded: response.awarded,
              attempted: response.attempted,
              autoSubmitted: response.autoSubmitted,
            }
          : null,
      };
    })
    .filter(Boolean);
}

/**
 * Records a proctoring event, and ends the attempt when the tab-switch budget
 * is exhausted and the teacher asked for that.
 */
exports.recordViolation = async (req, res) => {
  const attempt = await LmQuizAttempt.findOne({
    _id: req.params.attemptId,
    classId: req.lmClass._id,
    studentId: req.lmUser.id,
  });
  if (!attempt) return res.status(404).json({ message: "Attempt not found." });
  if (attempt.status !== "in_progress") return res.json({ status: attempt.status });

  const type = req.body.type;
  const allowed = ["tab_switch", "blur", "fullscreen_exit", "copy", "paste", "right_click", "mobile_detected"];
  if (!allowed.includes(type)) return res.status(400).json({ message: "Unknown violation type." });

  attempt.violations.push({ type, at: new Date() });
  if (type === "tab_switch" || type === "blur") attempt.tabSwitches += 1;
  await attempt.save();

  const quiz = await LmQuiz.findById(attempt.quizId);
  const settings = quiz?.settings || {};
  const overBudget = !settings.allowTabChange && attempt.tabSwitches > (settings.maxTabSwitches || 0);

  if (overBudget && settings.autoSubmitOnTabLimit) {
    const finished = await finaliseAttempt(attempt, quiz, { body: { reason: `Exceeded ${settings.maxTabSwitches} tab switches` } }, "terminated");
    return res.json({
      status: finished.status,
      terminated: true,
      tabSwitches: finished.tabSwitches,
      message: "Your test was submitted automatically because you left the test window too many times.",
    });
  }

  return res.json({
    status: attempt.status,
    tabSwitches: attempt.tabSwitches,
    warning: overBudget
      ? "You have exceeded the allowed number of tab switches. This has been recorded."
      : null,
    remaining: settings.allowTabChange
      ? null
      : Math.max(0, (settings.maxTabSwitches || 0) - attempt.tabSwitches),
  });
};

exports.getAttempt = async (req, res) => {
  const attempt = await LmQuizAttempt.findOne({
    _id: req.params.attemptId,
    classId: req.lmClass._id,
  }).lean();
  if (!attempt) return res.status(404).json({ message: "Attempt not found." });

  const isOwner = String(attempt.studentId) === req.lmUser.id;
  if (!req.lmIsTeacher && !isOwner) return res.status(403).json({ message: "Forbidden" });

  const quiz = await LmQuiz.findById(attempt.quizId).lean();
  const now = new Date();
  const reveal = req.lmIsTeacher || (engine.resultsVisible(quiz, now) && quiz?.settings?.showAnswersAfterSubmit);

  return res.json({
    attempt: req.lmIsTeacher ? attempt : attemptForStudent(attempt, quiz, now),
    review: reveal && attempt.status !== "in_progress" ? buildReview(quiz, attempt) : null,
  });
};

/* ─────────────── staff intervention on one student's sitting ───────────── */

// How long a reopened sitting runs for when the teacher does not say.
const DEFAULT_REOPEN_MINUTES = 30;
const MAX_REOPEN_MINUTES = 600;

/**
 * Rewrites one student's mirrored gradebook row from whatever attempts are
 * left.
 *
 * Not a blanket reset: `finaliseAttempt` mirrors the *best* of a student's
 * attempts, so blanking the row would throw away a legitimate earlier sitting,
 * and leaving it would show a mark for an attempt that no longer exists. The
 * only correct answer is to recompute, which is what this does — clearing the
 * row only when nothing finished is left.
 */
async function remirrorGradebook(quiz, classId, studentId) {
  const coursework = await LmCoursework.findOne({ quizId: quiz._id, classId });
  if (!coursework) return;

  const [top] = await LmQuizAttempt.find({
    quizId: quiz._id,
    studentId,
    status: { $in: ["submitted", "expired", "terminated"] },
  })
    .sort({ score: -1 })
    .limit(1)
    .lean();

  if (!top) {
    await LmSubmission.updateOne(
      { courseworkId: coursework._id, studentId },
      {
        $set: {
          state: "assigned",
          grade: null,
          feedback: "",
          turnedInAt: null,
          returnedAt: null,
          gradedAt: null,
        },
      },
    );
    return;
  }

  const maxPoints = top.maxScore || quiz.totalMarks;
  await LmSubmission.updateOne(
    { courseworkId: coursework._id, studentId },
    {
      $set: {
        grade: top.score,
        maxPoints,
        feedback: `Quiz auto-graded: ${top.score}/${maxPoints}`,
      },
    },
  );
}

const tellStudent = (attempt, quiz, req, title, body) =>
  notifyUser({
    userId: attempt.studentId,
    klass: req.lmClass,
    type: "quiz",
    title,
    body,
    link: `/learning/class/${req.lmClass._id}/quiz/${quiz._id}`,
    actorName: req.lmUser.name,
  });

/**
 * Delete one student's sitting.
 *
 * The class-wide `deleteResponses` already existed; this is the same act aimed
 * at one person, which is what a teacher actually needs when a single student's
 * test went wrong. The row is removed rather than flagged, because a student
 * gets one sitting: a kept-but-hidden attempt would still stand in their way
 * and they would be unable to sit the paper again.
 */
exports.deleteAttempt = async (req, res) => {
  const attempt = await LmQuizAttempt.findOne({
    _id: req.params.attemptId,
    classId: req.lmClass._id,
  });
  if (!attempt) return res.status(404).json({ message: "Attempt not found." });

  const quiz = await LmQuiz.findById(attempt.quizId);
  if (!quiz) return res.status(404).json({ message: "Quiz not found." });

  await LmQuizAttempt.deleteOne({ _id: attempt._id });
  await remirrorGradebook(quiz, req.lmClass._id, attempt.studentId);

  await tellStudent(
    attempt,
    quiz,
    req,
    `Your attempt at "${quiz.title}" was cleared`,
    "Your teacher removed this attempt. If you are meant to sit the test again, it will be open for you.",
  );

  return res.json({ deleted: true, studentId: attempt.studentId });
};

/**
 * Let one student back into a test that has already ended for them.
 *
 * Two modes, because the two situations are genuinely different and a teacher
 * knows which one they are in:
 *
 *  - **continue** — the paper closed under them (a dropped connection, a dead
 *    battery, a proctoring termination, the window expiring mid-sitting). Their
 *    answers and their position in the paper are kept and they carry on. What
 *    they had already written is not their fault and should not be thrown away.
 *
 *  - **restart** — the sitting is to be discarded and taken again from the
 *    beginning. The old attempt is deleted and a fresh paper is dealt, with a
 *    *different* shuffle: with `questionsPerAttempt` randomisation, reusing the
 *    seed would deal the identical subset they have already seen and read a
 *    second time.
 *
 * Either way the sitting gets its own deadline (`deadlineOverride`), because
 * both of the clocks that would otherwise apply — the paper's time limit
 * measured from `startedAt`, and the quiz's own `availableTo` — have already run
 * out in exactly the case this endpoint is for.
 */
exports.reopenAttempt = async (req, res) => {
  const now = new Date();
  const mode = req.body.mode === "restart" ? "restart" : "continue";
  const minutes = Math.min(
    MAX_REOPEN_MINUTES,
    Math.max(1, Number(req.body.minutes) || DEFAULT_REOPEN_MINUTES),
  );
  const deadlineOverride = new Date(now.getTime() + minutes * 60000);

  const attempt = await LmQuizAttempt.findOne({
    _id: req.params.attemptId,
    classId: req.lmClass._id,
  });
  if (!attempt) return res.status(404).json({ message: "Attempt not found." });

  const quiz = await LmQuiz.findById(attempt.quizId);
  if (!quiz) return res.status(404).json({ message: "Quiz not found." });

  if (mode === "continue") {
    if (attempt.status === "in_progress") {
      // Already open. Not an error — the teacher's intent is "let them sit for
      // another N minutes", and extending the clock delivers exactly that.
      attempt.deadlineOverride = deadlineOverride;
      attempt.reopenedAt = now;
      attempt.reopenedByName = req.lmUser.name;
      attempt.reopenCount += 1;
      await attempt.save();
      await tellStudent(
        attempt,
        quiz,
        req,
        `More time on "${quiz.title}"`,
        `Your teacher extended your test by ${minutes} minutes.`,
      );
      return res.json({ attempt, mode, extended: true, deadlineOverride });
    }

    attempt.status = "in_progress";
    attempt.submittedAt = null;
    attempt.terminationReason = "";
    // The clock on the question in front of them starts again from now — they
    // are being handed the paper back, not caught mid-thought.
    attempt.currentServedAt = now;
    attempt.deadlineOverride = deadlineOverride;
    attempt.reopenedAt = now;
    attempt.reopenedByName = req.lmUser.name;
    attempt.reopenCount += 1;
    await attempt.save();

    // The mark that was mirrored into the gradebook came from a sitting that is
    // no longer finished, so it stops standing for anything until they submit
    // again.
    await remirrorGradebook(quiz, req.lmClass._id, attempt.studentId);

    await tellStudent(
      attempt,
      quiz,
      req,
      `"${quiz.title}" has been reopened for you`,
      `Continue from where you stopped. You have ${minutes} minutes.`,
    );

    return res.json({ attempt, mode, deadlineOverride });
  }

  // restart
  const { studentId, studentName, studentEmail, rollNumber, attemptNumber, reopenCount } = attempt;
  await LmQuizAttempt.deleteOne({ _id: attempt._id });

  // A seed the student has not sat before. `buildPaper` uses this argument for
  // nothing but the shuffle, so varying it is safe and `attemptNumber` on the
  // new row stays truthful.
  const paper = engine.buildPaper(quiz.toObject(), String(studentId), `${attemptNumber}-r${reopenCount + 1}`);

  const fresh = await LmQuizAttempt.create({
    quizId: quiz._id,
    classId: req.lmClass._id,
    studentId,
    studentName,
    studentEmail,
    rollNumber,
    attemptNumber,
    questionOrder: paper.questionOrder,
    optionOrder: paper.optionOrder,
    maxScore: paper.maxScore,
    cursor: 0,
    currentServedAt: now,
    startedAt: now,
    deadlineOverride,
    reopenedAt: now,
    reopenedByName: req.lmUser.name,
    reopenCount: reopenCount + 1,
  });

  await remirrorGradebook(quiz, req.lmClass._id, studentId);

  await tellStudent(
    fresh,
    quiz,
    req,
    `"${quiz.title}" has been reset for you`,
    `Your teacher cleared your previous attempt. You can take the test again — you have ${minutes} minutes from now.`,
  );

  return res.json({ attempt: fresh, mode, deadlineOverride });
};

/* ────────────────────────────── analytics ─────────────────────────────── */

exports.getQuizResults = async (req, res) => {
  const quiz = await LmQuiz.findOne({ _id: req.params.quizId, classId: req.lmClass._id }).lean();
  if (!quiz) return res.status(404).json({ message: "Quiz not found." });

  const attempts = await LmQuizAttempt.find({ quizId: quiz._id }).sort({ percent: -1 }).lean();
  const finished = attempts.filter((attempt) => attempt.status !== "in_progress");
  const enrolled = await LmMembership.countDocuments({
    classId: req.lmClass._id,
    role: "student",
    status: "active",
  });

  // Per-question difficulty across the cohort.
  const perQuestion = quiz.questions.map((question) => {
    const responses = finished
      .flatMap((attempt) => attempt.responses || [])
      .filter((response) => String(response.questionId) === String(question._id));
    const attemptedResponses = responses.filter((response) => response.attempted);
    const correct = responses.filter((response) => response.correct).length;
    const times = responses.map((response) => response.timeSpentSec || 0).filter(Boolean);

    return {
      questionId: question._id,
      question: question.question,
      type: question.type,
      topic: question.topic,
      difficulty: question.difficulty,
      sectionName: question.sectionName,
      marks: question.marks,
      served: responses.length,
      attempted: attemptedResponses.length,
      correct,
      correctPercent: attemptedResponses.length
        ? Math.round((correct / attemptedResponses.length) * 1000) / 10
        : null,
      skipRate: responses.length
        ? Math.round(((responses.length - attemptedResponses.length) / responses.length) * 1000) / 10
        : null,
      avgTimeSec: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
    };
  });

  // Section roll-up across every attempt.
  const sectionTotals = new Map();
  finished.forEach((attempt) => {
    (attempt.sectionScores || []).forEach((section) => {
      const key = section.sectionName || "Ungrouped";
      if (!sectionTotals.has(key)) {
        sectionTotals.set(key, { sectionName: key, score: 0, maxScore: 0, correct: 0, wrong: 0, unattempted: 0, timeSpentSec: 0, count: 0 });
      }
      const entry = sectionTotals.get(key);
      entry.score += section.score;
      entry.maxScore += section.maxScore;
      entry.correct += section.correct;
      entry.wrong += section.wrong;
      entry.unattempted += section.unattempted;
      entry.timeSpentSec += section.timeSpentSec;
      entry.count += 1;
    });
  });

  const percents = finished.map((attempt) => attempt.percent);
  const sorted = [...percents].sort((a, b) => a - b);
  const bands = [
    { label: "0-20%", min: 0, max: 20 },
    { label: "21-40%", min: 20, max: 40 },
    { label: "41-60%", min: 40, max: 60 },
    { label: "61-80%", min: 60, max: 80 },
    { label: "81-100%", min: 80, max: 100.01 },
  ].map((band) => ({
    label: band.label,
    count: percents.filter((value) => value > band.min && value <= band.max).length +
      (band.min === 0 ? percents.filter((value) => value === 0).length : 0),
  }));

  return res.json({
    quiz,
    attempts,
    summary: {
      enrolled,
      started: attempts.length,
      submitted: finished.length,
      inProgress: attempts.length - finished.length,
      notStarted: Math.max(0, enrolled - attempts.length),
      average: percents.length ? Math.round((percents.reduce((a, b) => a + b, 0) / percents.length) * 10) / 10 : null,
      median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
      highest: sorted.length ? sorted[sorted.length - 1] : null,
      lowest: sorted.length ? sorted[0] : null,
      passRate: finished.length
        ? Math.round((finished.filter((attempt) => attempt.passed).length / finished.length) * 1000) / 10
        : null,
      avgDurationSec: finished.length
        ? Math.round(finished.reduce((sum, attempt) => sum + (attempt.durationSec || 0), 0) / finished.length)
        : null,
      totalNegative: Math.round(finished.reduce((sum, a) => sum + (a.negativeApplied || 0), 0) * 100) / 100,
      flagged: finished.filter((attempt) => (attempt.violations || []).length > 0).length,
      terminated: finished.filter((attempt) => attempt.status === "terminated").length,
    },
    perQuestion,
    perSection: [...sectionTotals.values()].map((section) => ({
      ...section,
      score: Math.round(section.score * 100) / 100,
      avgPercent: section.maxScore ? Math.round((section.score / section.maxScore) * 1000) / 10 : null,
    })),
    distribution: bands,
    resultsVisible: engine.resultsVisible(quiz),
  });
};

/** Full result export, one row per attempt plus per-question columns. */
exports.exportResultsCsv = async (req, res) => {
  const quiz = await LmQuiz.findOne({ _id: req.params.quizId, classId: req.lmClass._id }).lean();
  if (!quiz) return res.status(404).json({ message: "Quiz not found." });

  const attempts = await LmQuizAttempt.find({ quizId: quiz._id }).sort({ studentName: 1 }).lean();
  const byId = new Map(quiz.questions.map((question) => [String(question._id), question]));

  const escape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const header = [
    "Roll No", "Student", "Email", "Attempt", "Status",
    "Score", "Max", "Percent", "Result",
    "Correct", "Wrong", "Unattempted", "Negative",
    "Duration (s)", "Tab switches", "Violations", "Submitted at",
    ...(quiz.sections || []).map((section) => `${section.name} score`),
    ...quiz.questions.map((question, index) => `Q${index + 1} awarded`),
  ];
  const lines = [header.map(escape).join(",")];

  attempts.forEach((attempt) => {
    const responseFor = (questionId) =>
      (attempt.responses || []).find((r) => String(r.questionId) === String(questionId));

    lines.push(
      [
        attempt.rollNumber,
        attempt.studentName,
        attempt.studentEmail,
        attempt.attemptNumber,
        attempt.status,
        attempt.score,
        attempt.maxScore,
        attempt.percent,
        attempt.status === "in_progress" ? "" : attempt.passed ? "Pass" : "Fail",
        attempt.totalCorrect,
        attempt.totalWrong,
        attempt.totalUnattempted,
        attempt.negativeApplied,
        attempt.durationSec,
        attempt.tabSwitches,
        (attempt.violations || []).map((violation) => violation.type).join(" "),
        attempt.submittedAt ? new Date(attempt.submittedAt).toISOString() : "",
        ...(quiz.sections || []).map((section) => {
          const found = (attempt.sectionScores || []).find(
            (entry) => String(entry.sectionId) === String(section._id),
          );
          return found ? `${found.score}/${found.maxScore}` : "";
        }),
        ...quiz.questions.map((question) => {
          const response = responseFor(question._id);
          if (!response) return "";
          return response.attempted ? response.awarded : "NA";
        }),
      ]
        .map(escape)
        .join(","),
    );
  });

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${String(quiz.title).replace(/[^a-z0-9]+/gi, "_")}_results.csv"`,
  );
  return res.send(lines.join("\n"));
};

exports.buildReview = buildReview;
exports.finaliseAttempt = finaliseAttempt;
