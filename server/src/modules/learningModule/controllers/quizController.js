const crypto = require("node:crypto");
const LmQuiz = require("../models/lmQuiz");
const LmQuizAttempt = require("../models/lmQuizAttempt");
const LmClass = require("../models/lmClass");
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

/**
 * A quiz as a student may read it *outside* a sitting: everything about the
 * paper except the paper.
 *
 * The questions are not merely stripped of their answer key here — they are not
 * sent at all. Handing over the question list was the single largest hole in the
 * whole module, and it undid two separate defences at once:
 *
 *  - **One-at-a-time delivery became decoration.** The cursor, the per-question
 *    clock and the late-answer check are all server-side and all correct, and a
 *    student could read the entire paper off this endpoint while sitting on
 *    question one.
 *  - **The paper was readable before it was sat.** This route needs no attempt,
 *    so during a multi-day window it returned the questions on the first day to
 *    anybody who could see the quiz existed.
 *
 * Questions now come from exactly two places, both of which require an open
 * attempt belonging to the caller: `getAttemptPaper` and `getCurrentQuestion`.
 * `questionCount` is kept because the pre-test screen legitimately says how long
 * the paper is.
 */
const forStudent = (quiz) => {
  const { questions, ...rest } = quiz;
  return { ...rest, questionCount: (questions || []).length };
};

const optionOrderOf = (attempt) =>
  attempt.optionOrder instanceof Map
    ? Object.fromEntries(attempt.optionOrder)
    : attempt.optionOrder || {};

/**
 * Everything a student may see about their own attempt.
 *
 * The score fields travel together with `resultsPending`, and both are decided
 * by the one predicate: either the marks are released and every field is here,
 * or they are withheld and none of them is. They used to be governed by two
 * different tests — `resultsVisible` for the flag, `showScoreImmediately` for
 * the fields — so an exam paper reported "results are out" and then sent no
 * numbers, and the result screen rendered `undefined/undefined`.
 */
const attemptForStudent = (attempt, quiz, now = new Date()) => {
  const finished = attempt.status !== "in_progress";
  const released = engine.resultState(quiz, now);
  const showScore = finished && released.released;

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
    resultsPending: finished && !released.released,
    // So a waiting student is told *when*, or told there is no date to wait
    // for, rather than only "not yet" — the shape that sends them to the
    // faculty to ask.
    resultReleaseAt: released.releaseAt,
    resultsAwaitingTeacher: finished && !released.released && released.awaitingTeacher,
    resultViewedAt: attempt.resultViewedAt || null,
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
    .select("quizId status score maxScore percent passed attemptNumber submittedAt resultViewedAt")
    .lean();

  return res.json(
    quizzes.map((quiz) => {
      const mine = myAttempts.filter((attempt) => String(attempt.quizId) === String(quiz._id));
      const best = mine.reduce((top, attempt) => (!top || attempt.percent > top.percent ? attempt : top), null);
      const results = engine.resultState(quiz, now);
      const visible = results.released;
      // Announced but not yet read by this student — what puts the marker on
      // the quiz row and on the class card, and what clears when they open it.
      const unread =
        visible && mine.some((attempt) => attempt.submittedAt && !attempt.resultViewedAt);
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
        resultsUnread: Boolean(unread),
        resultReleaseAt: results.releaseAt,
        // The sitting to open when the student asks to review — their latest,
        // which is the one the announcement is about. Without it the "Review"
        // button has nowhere to go but the brief, which never shows a mark.
        lastAttemptId:
          mine
            .filter((attempt) => attempt.submittedAt)
            .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt))[0]?._id || null,
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

  // The clocks, set together because only together do they make sense.
  // `publishAt` decides when the link answers; `availableFrom` when the Start
  // button unlocks behind it; `startDeadline` when it locks again for anyone
  // who has not begun; `availableTo` when the paper shuts for everyone; and
  // `resultReleaseAt` when the marks go out afterwards. Out of order they
  // produce a quiz nobody can sit or a result nobody can wait for, so the
  // ordering is checked here rather than discovered on the day.
  const publishAt = readDate(req.body.publishAt);
  const availableFrom = readDate(req.body.availableFrom);
  const startDeadline = readDate(req.body.startDeadline);
  const resultReleaseAt = readDate(req.body.resultReleaseAt);
  const availableTo =
    req.body.availableTo !== undefined ? readDate(req.body.availableTo) : quiz.settings.availableTo;

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
  // Results announced before the paper shuts would hand the answer key to
  // everyone still sitting it — the one ordering mistake here that cannot be
  // undone once it has happened.
  if (resultReleaseAt && availableTo && resultReleaseAt < availableTo) {
    return res.status(400).json({
      message:
        "Results would be announced while the test is still open, so students still sitting it could read the answers. Announce them after the test closes.",
    });
  }
  if (resultReleaseAt && availableFrom && resultReleaseAt < availableFrom) {
    return res.status(400).json({
      message: "Results would be announced before the test starts. Move the announcement later.",
    });
  }

  quiz.publishAt = publishAt && publishAt > now ? publishAt : null;
  if (req.body.availableFrom !== undefined) quiz.settings.availableFrom = availableFrom;
  if (req.body.availableTo !== undefined) quiz.settings.availableTo = availableTo;
  if (req.body.resultReleaseAt !== undefined) {
    quiz.settings.resultReleaseAt = resultReleaseAt;
    // Answering the results question settles the whole policy, so the older
    // "hold the score back" flag stops being a second, invisible gate on top
    // of it. Left alone it would contradict the answer just given: an Exam
    // preset carries `showScoreImmediately: false`, and a teacher who chose
    // "as each student submits" would still have had every mark withheld.
    quiz.settings.showScoreImmediately = true;
    // Rescheduling into the future un-announces: the sweep re-announces when
    // the new moment arrives, and without this a teacher who pushed the date
    // back would find the marks still on show and no way to take them off it.
    if (resultReleaseAt && resultReleaseAt > now) {
      quiz.resultsAnnouncedAt = null;
      quiz.resultsAnnouncedByName = "";
    }
  }
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
    // Not awaited — publishing a quiz should not wait on SMTP.
    notifyClass({
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
    results: engine.resultState(quiz, now),
  });
};

/* ─────────────────────────── announcing results ───────────────────────── */

/**
 * Tells the students who sat a quiz that their marks are out.
 *
 * Shared by the teacher pressing "Publish results now" and by the sweep that
 * catches a scheduled release, so both produce the same notification and the
 * same latch. Idempotent: `resultsAnnouncedAt` is written first, and a quiz
 * that already carries one is left alone, so nobody is told twice.
 *
 * Only students with a finished sitting are notified — a class-wide message
 * about marks would reach thirty people who never took the paper.
 *
 * @returns {Promise<number>} how many students were notified
 */
async function announceResults(quiz, klass, actorName = "") {
  if (!quiz || quiz.resultsAnnouncedAt) return 0;

  const now = new Date();
  quiz.resultsAnnouncedAt = now;
  quiz.resultsAnnouncedByName = actorName || "";
  await quiz.save();

  const finished = await LmQuizAttempt.find({
    quizId: quiz._id,
    status: { $in: ["submitted", "expired", "terminated"] },
  })
    .select("studentId")
    .lean();

  const studentIds = [...new Set(finished.map((attempt) => String(attempt.studentId)))];
  if (!studentIds.length) return 0;

  await notifyClass({
    klass,
    userIds: studentIds,
    type: "quiz_result",
    title: `Results are out: ${quiz.title}`,
    body: `Your marks for "${quiz.title}" have been released. Open the quiz to see your score and go through the answers.`,
    link: `/learning/class/${klass._id}/quizzes`,
    actorName,
    email: true,
  });

  return studentIds.length;
}

/** Teacher override: marks out now, whatever the schedule said. */
exports.releaseResults = async (req, res) => {
  const quiz = await LmQuiz.findOne({ _id: req.params.quizId, classId: req.lmClass._id });
  if (!quiz) return res.status(404).json({ message: "Quiz not found." });
  if (!requireManage(req, res, quiz)) return undefined;

  const now = new Date();
  // Bringing the announcement forward means moving the date, not working
  // around it: a release time still sitting in the future would otherwise keep
  // `resultsVisible` false and hide the marks the teacher just published.
  quiz.settings.resultReleaseAt = now;
  const notified = await announceResults(quiz, req.lmClass, req.lmUser.name);
  // `announceResults` saves only when it is the one doing the announcing. A
  // second press has nothing to announce but still moved the date above, and
  // that has to reach the database or the marks stay hidden.
  if (quiz.isModified()) await quiz.save();

  return res.json({
    results: engine.resultState(quiz, now),
    notified,
  });
};

/**
 * Announces every quiz whose scheduled release time has arrived.
 *
 * Lazy release is enough to *show* a mark — every read path asks the clock —
 * but not to tell anybody it happened, and a result nobody is told about is one
 * students keep asking staff for. So this runs alongside the attempt reaper,
 * on the same interval, and is bounded for the same reason.
 */
async function announceDueResults({ limit = 100, now = new Date() } = {}) {
  const due = await LmQuiz.find({
    published: true,
    resultsAnnouncedAt: null,
    "settings.resultReleaseAt": { $ne: null, $lte: now },
  })
    .limit(limit);

  let announced = 0;
  for (const quiz of due) {
    // eslint-disable-next-line no-await-in-loop
    const klass = await LmClass.findById(quiz.classId).lean();
    if (!klass) continue;
    // eslint-disable-next-line no-await-in-loop
    await announceResults(quiz, klass);
    announced += 1;
  }

  return { scanned: due.length, announced };
}

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
    // Resuming re-binds through the same rule as everything else, so pressing
    // Start on a second device while the first is live is refused here rather
    // than one request later.
    const guard = await guardSitting(inProgress, quiz, req, res, now);
    if (guard.stop) return undefined;
    await inProgress.save();
    res.set(SESSION_HEADER, guard.token);
    return res.json({
      attempt: attemptForStudent(inProgress, quiz, now),
      sessionToken: guard.token,
      resumed: true,
    });
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
  // Minted here rather than accepted from the client: the browser that starts
  // the paper is the one that owns it, and it should not get to choose its own
  // name for itself.
  const sessionToken = mintSessionToken();

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
    sessionToken,
    sessionBoundAt: now,
  });

  res.set(SESSION_HEADER, sessionToken);
  return res.status(201).json({
    attempt: attemptForStudent(attempt, quiz, now),
    sessionToken,
    resumed: false,
  });
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

  // Only a live sitting is guarded. Re-reading a paper already submitted is the
  // student's own finished work and has no second-screen to deny.
  if (attempt.status === "in_progress") {
    const guard = await guardSitting(attempt, quiz, req, res);
    if (guard.stop) return undefined;
    await attempt.save();
    res.set(SESSION_HEADER, guard.token);
  }

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

  // Ahead of the cursor check and the deadline check both: a second screen must
  // be turned away before it is told anything at all about the paper, including
  // how far through it the real session is.
  const guard = await guardSitting(attempt, quiz, req, res);
  if (guard.stop) return undefined;
  res.set(SESSION_HEADER, guard.token);

  const total = attempt.questionOrder.length;
  if (attempt.cursor >= total) {
    await attempt.save();
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

  // Refuse to hand out another question after the paper has closed. Without
  // this, reopening a stale tab resumed a sitting whose time was long gone.
  const timing = await enforceDeadline(attempt, quiz, req, question);
  if (timing.expiredAttempt) {
    return res.json({
      done: true,
      expired: true,
      attempt: attemptForStudent(timing.expiredAttempt, quiz),
    });
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
 * Notes the machine an attempt is being driven from, and says whether it is a
 * machine the sitting may continue on.
 *
 * Every request on a live attempt goes through this. A User-Agent or IP that
 * moves mid-sitting is the visible trace of the two things browser-side
 * proctoring cannot see at all: a second device, and somebody talking to the API
 * directly with a token lifted out of localStorage.
 *
 * The two signals are not worth the same, and treating them alike was why this
 * used to record everything and enforce nothing:
 *
 *  - **IP is a note.** Campus NAT means most of a class shares one, wifi-to-
 *    mobile-data handover changes it mid-question, and it is not an identity.
 *    Blocking on it would fail honest students constantly.
 *  - **User-Agent ends the sitting.** A browser does not change its User-Agent
 *    between one request and the next; a second machine does. The false positive
 *    — a browser that updated itself *during the exam* and kept the same
 *    session — costs a student their paper, so it is reported with the reason
 *    spelled out and is reopenable by staff, which is the same remedy the rest
 *    of the proctoring rules already rely on.
 *
 * @returns {{terminate: string}|null} the termination reason, or null to carry on
 */
function noteDevice(attempt, req, quiz) {
  const userAgent = String(req.get?.("User-Agent") || "").slice(0, 400);
  const ip = String(req.ip || "").slice(0, 64);

  if (!attempt.device) attempt.device = {};

  const browserChanged = Boolean(
    attempt.device.userAgent && userAgent && attempt.device.userAgent !== userAgent,
  );
  const ipChanged = Boolean(attempt.device.ip && ip && attempt.device.ip !== ip);

  if (!attempt.device.userAgent) attempt.device.userAgent = userAgent;
  if (!attempt.device.ip) attempt.device.ip = ip;

  const changes = [];
  if (browserChanged) changes.push("browser");
  if (ipChanged) changes.push("network");

  if (changes.length) {
    attempt.violations.push({
      type: "device_changed",
      at: new Date(),
      detail: `${changes.join(" and ")} changed mid-attempt`,
    });
    // Track the latest, so a third change is noticed rather than compared
    // against the original forever.
    attempt.device.userAgent = userAgent || attempt.device.userAgent;
    attempt.device.ip = ip || attempt.device.ip;
  }

  // A paper that refused to start on a phone must also refuse to *continue* on
  // one. The check used to live only in `startAttempt`, so beginning on a laptop
  // and finishing on a handset walked straight past it.
  if (quiz?.settings?.preventMobile && engine.isMobileUserAgent(userAgent)) {
    if (!changes.length) {
      attempt.violations.push({
        type: "mobile_detected",
        at: new Date(),
        detail: "continued on a mobile device",
      });
    }
    attempt.device.isMobile = true;
    return { terminate: "Continued the test on a mobile device" };
  }

  if (browserChanged) return { terminate: "The test moved to a different browser or device" };
  return null;
}

/* ───────────────────────── one browser per sitting ────────────────────────── */

/** Header the sitting carries; see `lmQuizAttempt.sessionToken`. */
const SESSION_HEADER = "X-Quiz-Session";

const mintSessionToken = () => crypto.randomUUID();

/**
 * Decides whether this request may drive this sitting.
 *
 * "One attempt per student" was never "one *screen* per student". A phone signed
 * into the same account could hold the paper open beside the laptop and read it
 * at leisure: no tab switch, no blur, no fullscreen exit, nothing to report,
 * because the laptop never misbehaved. Nothing in the browser-side proctoring
 * can see a second screen — but the server can see two clients driving one
 * attempt, and that is the same thing from the only angle we have.
 *
 * The rule turns on whether the bound session is *still alive*, which is the
 * distinction that makes this safe to enforce:
 *
 *  - **Bound session still checking in** → the other client is live, so this is
 *    a genuine second screen. Recorded and refused.
 *  - **Bound session gone quiet** → a crashed browser, a closed tab, a flat
 *    battery. Rebinds silently, because resuming a dropped sitting where it left
 *    off is a promise the module makes elsewhere and must not break here.
 *
 * A missing token counts as a different one: once a sitting is bound, a client
 * that cannot produce the token is not the client that started it.
 *
 * @returns {{token: string}|{conflict: true}}
 */
function bindSession(attempt, req, now = new Date()) {
  const presented = String(req.get?.(SESSION_HEADER) || "");

  if (!attempt.sessionToken) {
    attempt.sessionToken = presented || mintSessionToken();
    attempt.sessionBoundAt = now;
    return { token: attempt.sessionToken };
  }

  if (presented && presented === attempt.sessionToken) return { token: attempt.sessionToken };

  // The later of the two, because a sitting that has only just started has not
  // heartbeated yet: judging liveness on `lastSeenAt` alone left the first
  // thirty seconds of every paper open to whoever asked second.
  const lastSeen = Math.max(
    attempt.lastSeenAt ? new Date(attempt.lastSeenAt).getTime() : 0,
    attempt.sessionBoundAt ? new Date(attempt.sessionBoundAt).getTime() : 0,
  );
  const boundIsLive = lastSeen > 0 && now.getTime() - lastSeen < HEARTBEAT_GRACE_MS;

  if (boundIsLive) {
    attempt.violations.push({
      type: "second_session",
      at: now,
      detail: "a second browser tried to open this sitting while the first was live",
    });
    return { conflict: true };
  }

  attempt.violations.push({
    type: "second_session",
    at: now,
    detail: "resumed in a different browser after the first stopped responding",
  });
  attempt.sessionToken = presented || mintSessionToken();
  attempt.sessionBoundAt = now;
  return { token: attempt.sessionToken };
}

/** The 409 a losing second screen gets. */
const sessionConflict = (res) =>
  res.status(409).json({
    message:
      "This test is already open in another browser or on another device. " +
      "Go back to the one you started on and continue there.",
    code: "SESSION_CONFLICT",
  });

/**
 * Everything a live attempt must be checked for before it is served.
 *
 * One place, so a route cannot be added that quietly skips half of it — which is
 * how `getAttemptPaper` came to hand out a paper without ever noting the device
 * it was going to.
 *
 * @returns {{stop: true}|{token: string}} `stop` means a response was sent
 */
async function guardSitting(attempt, quiz, req, res, now = new Date()) {
  const session = bindSession(attempt, req, now);
  if (session.conflict) {
    await attempt.save();
    sessionConflict(res);
    return { stop: true };
  }

  // Before `lastSeenAt` is touched anywhere: the gap has to be measured against
  // where the silence actually ended. The 5-minute sweep used to be the only
  // thing that noticed, so any outage shorter than one sweep interval left no
  // record at all — including a client that had simply been told, in devtools,
  // to stop reporting.
  noteHeartbeatLoss(attempt, now);

  const device = noteDevice(attempt, req, quiz);
  if (device?.terminate) {
    const finished = await finaliseAttempt(attempt, quiz, { body: { reason: device.terminate } }, "terminated");
    res.status(403).json({
      message: `Your test was submitted automatically. ${device.terminate}.`,
      code: "TERMINATED",
      attempt: attemptForStudent(finished, quiz, now),
    });
    return { stop: true };
  }

  return { token: session.token };
}

/**
 * The one place the clock is enforced.
 *
 * Returns `{ expiredAttempt }` when the sitting is over — the caller must stop
 * and hand that back rather than continuing — and `{ questionExpired }` when only
 * the current question's clock has run out, in which case the answer is not
 * counted but the paper carries on.
 *
 * Before this existed, `questionDeadline` was computed and *reported* to the
 * client and never compared against anything: an answer posted an hour after the
 * paper closed was accepted, and `submitAttempt` asked the client whether it had
 * run out of time.
 */
async function enforceDeadline(attempt, quiz, req, question = null) {
  const state = engine.deadlineState(quiz, attempt, question);
  if (!state.attemptExpired) return state;

  const finished = await finaliseAttempt(attempt, quiz, req, "expired");
  return { ...state, expiredAttempt: finished };
}

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

  const currentQuestion = questionId ? quiz.questions.id(questionId) : null;

  const guard = await guardSitting(attempt, quiz, req, res);
  if (guard.stop) return undefined;
  res.set(SESSION_HEADER, guard.token);

  const timing = await enforceDeadline(attempt, quiz, req, currentQuestion);
  if (timing.expiredAttempt) {
    return res.json({
      done: true,
      expired: true,
      attempt: attemptForStudent(timing.expiredAttempt, quiz),
    });
  }

  // The question's own clock ran out. The paper continues, but this answer does
  // not count — that is what a per-question limit means — and the attempt
  // carries a note saying so.
  if (timing.questionExpired) {
    attempt.violations.push({
      type: "late_answer",
      at: new Date(),
      detail: `answer for question ${attempt.cursor + 1} arrived after its time limit`,
    });
  }

  if (questionId && !timing.questionExpired) {
    const question = currentQuestion;
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

  // An autosave after the paper closed is how a tab left open overnight used to
  // keep writing answers.
  const guard = await guardSitting(attempt, quiz, req, res);
  if (guard.stop) return undefined;
  res.set(SESSION_HEADER, guard.token);

  const timing = await enforceDeadline(attempt, quiz, req, null);
  if (timing.expiredAttempt) {
    return res.status(400).json({
      message: "Time is up for this quiz — it has been submitted automatically.",
      code: "EXPIRED",
      attempt: attemptForStudent(timing.expiredAttempt, quiz),
    });
  }

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
 * Marks an attempt against the quiz's *current* answer key, in place.
 *
 * Deliberately touches nothing but the marks: not the status, not
 * `submittedAt`, not the clock. That is what lets the same function serve both
 * the student's submit — which sets those separately — and the two staff paths
 * that re-mark a sitting that is already closed and must stay closed.
 *
 * Marking always reads the key as it stands now rather than as it stood at
 * submission time, which is the whole point of a re-evaluation: a question
 * whose correct option was wrong when the cohort sat it is fixed by correcting
 * the question and marking again.
 */
function applyScore(attempt, quiz) {
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

  return scored;
}

/**
 * Marks and closes an attempt, mirroring the result into the gradebook.
 * Shared by the student submit path, the auto-submit path and termination.
 */
async function finaliseAttempt(attempt, quiz, req, reason = "completed") {
  const now = new Date();
  const scored = applyScore(attempt, quiz);

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

  // Guarded like the rest, because submitting is the one thing a second screen
  // could do that hurts the student rather than helping them.
  const guard = await guardSitting(attempt, quiz, req, res);
  if (guard.stop) return undefined;
  res.set(SESSION_HEADER, guard.token);

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

  // Derived, not taken from the request. `req.body.expired` was the client
  // telling the server whether it had run out of time, which made the whole
  // timer advisory: submitting late as `expired: false` was recorded as a normal
  // on-time completion.
  const { attemptExpired } = engine.deadlineState(quiz, attempt, null);
  const reason = attemptExpired ? "expired" : "completed";
  const finished = await finaliseAttempt(attempt, quiz, req, reason);
  const now = new Date();
  const reveal = engine.resultsReleased(quiz, now);

  // Reading the marks on the last page of the paper *is* reviewing them, so
  // nothing is left flagged as unread on the class card for a student who has
  // already seen the number.
  if (reveal) {
    finished.resultViewedAt = finished.resultViewedAt || now;
    await finished.save();
  }

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
 * What counts as leaving the test.
 *
 * All three are one thing to a student — the paper stopped being the only thing
 * on their screen — and all three now end the attempt, so they are treated
 * alike rather than weighed against a budget. A quiz is sat in fullscreen with
 * nothing else in front of it, and the brief says exactly that.
 */
const countsAsLeaving = (type) =>
  type === "tab_switch" || type === "blur" || type === "fullscreen_exit";

// Below this, the gap is just network latency and is not worth writing down.
const REPORT_DELAY_NOTE_SEC = 5;

/** How the auto-submit is written onto the attempt, per departure. */
const TERMINATION_REASON = {
  tab_switch: "Switched away from the test tab",
  blur: "Switched to another window or application",
  fullscreen_exit: "Left fullscreen during the test",
};

/**
 * When a reported event actually happened.
 *
 * The client stamps its own clock because a report that could not be sent is
 * queued and replayed later — the alternative, timing it by arrival, would write
 * down the moment the student reconnected rather than the moment they left.
 *
 * Clamped to the sitting so the timestamp cannot be used for anything except
 * being honest about a delay: a value before the paper started or after now is
 * not believed, and anything unparseable falls back to now. It only ever moves a
 * violation *earlier* within a window the student was already sitting in, so
 * there is nothing to gain by lying either way — the termination happens
 * regardless of what this says.
 */
function violationTime(raw, attempt, now = new Date()) {
  if (!raw) return now;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return now;
  if (at > now) return now;
  const startedAt = new Date(attempt.startedAt);
  if (at < startedAt) return startedAt;
  return at;
}

/**
 * Records a proctoring event, and ends the attempt the moment the student
 * leaves the test.
 *
 * There is no allowance: the first tab change, window change or fullscreen exit
 * submits the paper. One departure can still reach us as two events — a browser
 * that drops fullscreen as it loses focus fires both — but that no longer needs
 * coalescing, because the first one already finished the attempt and the second
 * finds a sitting that is no longer `in_progress`.
 *
 * Arriving late changes nothing about the verdict. A student who drops their
 * connection, leaves fullscreen and comes back is reported the moment anything
 * reaches us again, and the attempt ends then — the delay is written into the
 * record, not forgiven.
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

  const quiz = await LmQuiz.findById(attempt.quizId);

  const now = new Date();
  const at = violationTime(req.body.at, attempt, now);
  // Worth a teacher's eye on its own: a departure that could only be reported a
  // minute later means the connection was down at the moment it happened, which
  // is the shape of both a bad campus wifi and a deliberately pulled cable.
  const delayedBySec = Math.round((now - at) / 1000);
  const detail = delayedBySec >= REPORT_DELAY_NOTE_SEC ? `reported ${delayedBySec}s late` : "";

  const leaving = countsAsLeaving(type);
  attempt.violations.push({ type, at, detail });
  if (leaving) attempt.tabSwitches += 1;
  await attempt.save();

  if (leaving) {
    const reason = TERMINATION_REASON[type] || "Left the test";
    const finished = await finaliseAttempt(
      attempt,
      quiz,
      { body: { reason: detail ? `${reason} (${detail})` : reason } },
      "terminated",
    );
    return res.json({
      status: finished.status,
      terminated: true,
      tabSwitches: finished.tabSwitches,
      remaining: 0,
      message:
        "Your test was submitted automatically because you left the test screen. " +
        "The paper had to be taken in fullscreen without changing tab or window.",
    });
  }

  return res.json({
    status: attempt.status,
    tabSwitches: attempt.tabSwitches,
    warning: null,
    remaining: null,
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
  const released = engine.resultsReleased(quiz, now);
  const reveal = req.lmIsTeacher || (released && quiz?.settings?.showAnswersAfterSubmit);

  // The student opening their own released result is what "reviewed" means, so
  // this is where the announcement stops being unread. A teacher reading the
  // same attempt must not clear it on their behalf, and neither does a student
  // arriving before the marks are out — there is nothing to have read yet.
  if (!req.lmIsTeacher && isOwner && released && attempt.status !== "in_progress" && !attempt.resultViewedAt) {
    await LmQuizAttempt.updateOne({ _id: attempt._id }, { $set: { resultViewedAt: now } });
    attempt.resultViewedAt = now;
  }

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
    // Released, not carried over. Staff reopen a sitting precisely when the
    // machine it was bound to is gone — a dead laptop, a lab they have left —
    // and a token nobody can produce any more would lock them out of their own
    // reopened paper until the heartbeat grace expired.
    attempt.sessionToken = "";
    attempt.sessionBoundAt = null;
    attempt.lastSeenAt = null;
    attempt.heartbeatLostAt = null;
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

/* ───────────────── correcting the answer key ──────────────── */

/**
 * Re-mark every finished sitting against the answer key as it stands now.
 *
 * What it is for is the key itself having been wrong: a question published with
 * the wrong option ticked, a mark value that should have been two, a
 * question dropped from the paper after the cohort sat it. Correcting the quiz
 * fixes nothing on its own, because each attempt carries the numbers worked out
 * at the moment it was submitted — this is what makes the correction reach the
 * marks that were already awarded.
 *
 * In-progress sittings are skipped rather than marked: they have no result yet,
 * and one will be worked out from the corrected key when the student submits.
 */
async function regradeAllAttempts(quiz, req) {
  const attempts = await LmQuizAttempt.find({
    quizId: quiz._id,
    status: { $in: ["submitted", "expired", "terminated"] },
  });

  const now = new Date();
  const changes = [];
  const touched = new Set();

  for (const attempt of attempts) {
    const before = { score: attempt.score, percent: attempt.percent, passed: attempt.passed };
    applyScore(attempt, quiz);
    attempt.regradedAt = now;
    attempt.regradedByName = req.lmUser.name;
    attempt.updated_at = now;
    await attempt.save();
    touched.add(String(attempt.studentId));

    if (attempt.score !== before.score || attempt.passed !== before.passed) {
      changes.push({
        attemptId: attempt._id,
        studentId: attempt.studentId,
        studentName: attempt.studentName || attempt.studentEmail,
        rollNumber: attempt.rollNumber,
        before,
        after: { score: attempt.score, percent: attempt.percent, passed: attempt.passed },
      });
    }
  }

  // The gradebook mirrors the *best* of a student's attempts, so it has to be
  // rebuilt from what the re-mark left rather than written per attempt: a
  // student's second sitting overtaking their first is exactly the kind of
  // thing a re-evaluation causes.
  for (const studentId of touched) {
    await remirrorGradebook(quiz, req.lmClass._id, studentId);
  }

  // Only the students whose result actually moved hear about it. Telling a
  // whole cohort their marks were "reviewed" when nothing changed for most of
  // them invites a flood of queries about nothing.
  for (const change of changes) {
    await notifyUser({
      userId: change.studentId,
      klass: req.lmClass,
      type: "quiz",
      title: `Your result for "${quiz.title}" was revised`,
      body: `The paper was re-evaluated. Your score is now ${change.after.score}/${quiz.totalMarks} (was ${change.before.score}).`,
      link: `/learning/class/${req.lmClass._id}/quiz/${quiz._id}`,
      actorName: req.lmUser.name,
    });
  }

  return {
    regraded: attempts.length,
    changed: changes.length,
    changes,
    regradedAt: now,
  };
}

exports.regradeQuiz = async (req, res) => {
  const quiz = await LmQuiz.findOne({ _id: req.params.quizId, classId: req.lmClass._id });
  if (!quiz) return res.status(404).json({ message: "Quiz not found." });
  return res.json(await regradeAllAttempts(quiz, req));
};

/** The answer-key fields of one question, for the before/after in the response. */
const keyOf = (question) => ({
  questionId: question._id,
  question: question.question,
  type: question.type,
  options: question.options,
  correctAnswers: (question.correctAnswers || []).map(String),
  marks: question.marks,
  negativeMarks: question.negativeMarks,
  tolerancePercent: question.tolerancePercent,
  toleranceAbs: question.toleranceAbs,
  explanation: question.explanation,
});

/** Answer indices off the wire, kept to options the question actually has. */
const sanitiseKey = (values, question) => {
  if (question.type === "numerical") {
    return [String((Array.isArray(values) ? values[0] : values) ?? "").trim()].filter(Boolean);
  }
  const seen = new Set();
  const picked = (Array.isArray(values) ? values : [values])
    .map((value) => Number(value))
    .filter((index) => Number.isInteger(index) && index >= 0 && index < (question.options || []).length)
    .filter((index) => (seen.has(index) ? false : seen.add(index)))
    .map(String);
  // Single-answer types cannot carry two right answers; `sameSet` marking would
  // then be unsatisfiable and every student would score zero on the question.
  return question.type === "msq" ? picked : picked.slice(0, 1);
};

/**
 * Correct the answer key of a quiz people have already sat, and re-mark them.
 *
 * The fault this addresses is in the paper, not in any one student's sitting: a
 * question published with the wrong option ticked, a mark value that should
 * have been two, a tolerance too tight for the numbers the question asks for.
 * Every student who answered it is affected identically, so the fix belongs to
 * the key and the re-mark belongs to the whole cohort — which is why this
 * endpoint does both, and why there is no per-student equivalent.
 *
 * It writes only the fields that decide marks, matched by question `_id`:
 *
 *  - **Question text and options are untouched, deliberately.** A recorded
 *    response is an *index* into the options as authored. Reordering or
 *    rewording them under a cohort that has already answered silently changes
 *    what every stored answer means, and no re-mark can recover the original
 *    intent. Rewriting a question is the editor's job, before anybody sits it.
 *  - **Questions are matched, never replaced.** Sending a whole `questions`
 *    array through `updateQuiz` from a stale page would rewrite the paper; here
 *    an unknown id is skipped and anything not named is left exactly as it was.
 */
exports.updateAnswerKey = async (req, res) => {
  const quiz = await LmQuiz.findOne({ _id: req.params.quizId, classId: req.lmClass._id });
  if (!quiz) return res.status(404).json({ message: "Quiz not found." });

  const incoming = Array.isArray(req.body.questions) ? req.body.questions : [];
  const changes = [];

  incoming.forEach((entry) => {
    const question = quiz.questions.id(entry.questionId);
    if (!question) return;

    const before = keyOf(question);

    if (entry.correctAnswers !== undefined) {
      question.correctAnswers = sanitiseKey(entry.correctAnswers, question);
    }
    if (entry.marks !== undefined) {
      question.marks = Math.max(0, Number(entry.marks) || 0);
    }
    if (entry.negativeMarks !== undefined) {
      question.negativeMarks =
        entry.negativeMarks === null || entry.negativeMarks === ""
          ? null
          : Math.max(0, Number(entry.negativeMarks) || 0);
    }
    if (entry.tolerancePercent !== undefined) {
      question.tolerancePercent = Math.max(0, Number(entry.tolerancePercent) || 0);
    }
    if (entry.toleranceAbs !== undefined) {
      question.toleranceAbs = Math.max(0, Number(entry.toleranceAbs) || 0);
    }
    if (entry.explanation !== undefined) {
      question.explanation = String(entry.explanation || "");
    }

    const after = keyOf(question);
    const moved =
      after.correctAnswers.join() !== before.correctAnswers.join() ||
      after.marks !== before.marks ||
      after.negativeMarks !== before.negativeMarks ||
      after.tolerancePercent !== before.tolerancePercent ||
      after.toleranceAbs !== before.toleranceAbs;

    if (moved || after.explanation !== before.explanation) {
      changes.push({ questionId: question._id, before, after, affectsMarks: moved });
    }
  });

  if (!changes.length) {
    return res.json({ quiz, changed: 0, regrade: null });
  }

  quiz.updated_at = new Date();
  // `pre('save')` recomputes totalMarks, so a changed mark value carries through
  // to the paper's total without a second write.
  await quiz.save();

  // Re-marking is the default rather than an extra step: a corrected key that
  // has not reached the marks it decides is the exact state this endpoint
  // exists to prevent anybody being left in.
  const regrade =
    req.body.regrade === false || !changes.some((change) => change.affectsMarks)
      ? null
      : await regradeAllAttempts(quiz, req);

  return res.json({ quiz, changed: changes.length, changes, regrade });
};

/* ────────────────────────────── analytics ─────────────────────────────── */

exports.getQuizResults = async (req, res) => {
  const quiz = await LmQuiz.findOne({ _id: req.params.quizId, classId: req.lmClass._id }).lean();
  if (!quiz) return res.status(404).json({ message: "Quiz not found." });

  const now = new Date();
  const raw = await LmQuizAttempt.find({ quizId: quiz._id }).sort({ percent: -1 }).lean();

  /**
   * What the invigilation view needs on top of the stored attempt.
   *
   * `answeredCount` cannot be read off `attempted`, which only exists once a
   * paper has been marked — mid-sitting every response is unmarked, so a live
   * attempt would show nothing done however far through it is. Counting the
   * responses that actually carry something is the only measure available
   * while the paper is still being written.
   *
   * `deadline` is computed here rather than in the browser because it is the
   * one the server will itself enforce, override and all; a client that
   * recomputed it from the quiz settings would show the wrong clock to exactly
   * the students whose sitting was reopened.
   */
  const attempts = raw.map((attempt) => {
    const responses = attempt.responses || [];
    const answered = responses.filter(
      (response) => (response.selected || []).length > 0 || String(response.text || "").trim() !== "",
    ).length;
    const stamps = responses
      .map((response) => response.answeredAt)
      .filter(Boolean)
      .map((date) => new Date(date).getTime());

    return {
      ...attempt,
      answeredCount: answered,
      questionCount: (attempt.questionOrder || []).length,
      lastActivityAt: new Date(
        Math.max(
          ...stamps,
          new Date(attempt.currentServedAt || attempt.startedAt).getTime(),
          new Date(attempt.startedAt).getTime(),
        ),
      ),
      deadline:
        attempt.status === "in_progress" ? engine.questionDeadline(quiz, attempt, null, now) : null,
    };
  });

  const finished = attempts.filter((attempt) => attempt.status !== "in_progress");

  // The full student roster, not just a count: an invigilator watching a test
  // run needs the names of who has not appeared, which is unrecoverable from a
  // number. Removed and invited rows are left out — neither is somebody who is
  // expected to be sitting the paper right now.
  const roster = await LmMembership.find({
    classId: req.lmClass._id,
    role: "student",
    status: "active",
  })
    .select("userId name email rollNumber")
    .sort({ rollNumber: 1, name: 1 })
    .lean();
  const enrolled = roster.length;
  const sat = new Set(attempts.map((attempt) => String(attempt.studentId)));
  const notStartedStudents = roster
    .filter((member) => member.userId && !sat.has(String(member.userId)))
    .map((member) => ({
      studentId: member.userId,
      studentName: member.name || member.email,
      studentEmail: member.email,
      rollNumber: member.rollNumber,
    }));

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
    notStartedStudents,
    // The clock every countdown on the results page is measured against. A
    // browser whose own clock is minutes out would otherwise show an
    // invigilator time remaining that the server disagrees with.
    serverTime: now,
    summary: {
      enrolled,
      started: attempts.length,
      submitted: finished.length,
      inProgress: attempts.length - finished.length,
      notStarted: notStartedStudents.length,
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
      lastRegradedAt:
        attempts.reduce((latest, attempt) => {
          const at = attempt.regradedAt ? new Date(attempt.regradedAt) : null;
          return at && (!latest || at > latest) ? at : latest;
        }, null) || null,
    },
    perQuestion,
    perSection: [...sectionTotals.values()].map((section) => ({
      ...section,
      score: Math.round(section.score * 100) / 100,
      avgPercent: section.maxScore ? Math.round((section.score / section.maxScore) * 1000) / 10 : null,
    })),
    distribution: bands,
    resultsVisible: engine.resultsReleased(quiz, now),
    results: {
      ...engine.resultState(quiz, now),
      announcedByName: quiz.resultsAnnouncedByName || "",
      // How much of the cohort has actually read the marks. The point of
      // holding the flag until it is read is lost if staff cannot see whether
      // anybody has.
      viewed: finished.filter((attempt) => attempt.resultViewedAt).length,
      awaitingView: finished.filter((attempt) => !attempt.resultViewedAt).length,
    },
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
/* ─────────────────────── abandoned-attempt sweep ──────────────────────── */

// How long a page may go without checking in before it is noted. Three missed
// 30-second heartbeats, so a brief hiccup is not held against anybody.
const HEARTBEAT_GRACE_MS = 95 * 1000;

/**
 * Records that a sitting stopped checking in.
 *
 * Deliberately a note and not a termination. The commonest cause is a student's
 * wifi, and ending their paper for it would be worse than the problem. But it is
 * also exactly what blocking the proctoring requests in devtools looks like,
 * which until now was indistinguishable from flawless behaviour — so it is worth
 * writing down where a teacher will see it.
 *
 * Latched with `heartbeatLostAt` so an hour offline is one violation rather than
 * one per sweep.
 */
function noteHeartbeatLoss(attempt, now = new Date()) {
  if (attempt.heartbeatLostAt) return false;
  if (!attempt.lastSeenAt) return false;

  const silentFor = now.getTime() - new Date(attempt.lastSeenAt).getTime();
  if (silentFor < HEARTBEAT_GRACE_MS) return false;

  attempt.heartbeatLostAt = now;
  attempt.violations.push({
    type: "heartbeat_lost",
    at: now,
    detail: `page stopped responding for ${Math.round(silentFor / 1000)}s`,
  });
  return true;
}

/**
 * Finalises attempts whose time has run out but which nobody came back to.
 *
 * Closing the tab used to be a clean escape: the attempt stayed `in_progress`
 * for ever, so it never scored, never appeared as a completed sitting, and left
 * the student able to claim they were never marked. Nothing else in the system
 * expires them, because every other check happens on a request the student
 * chooses to make.
 *
 * Bounded per run so a backlog cannot stall the process, and it re-reads the
 * quiz per attempt rather than trusting a cached copy, since a teacher may have
 * changed the window in between.
 */
async function reapExpiredAttempts({ limit = 200, now = new Date() } = {}) {
  const stale = await LmQuizAttempt.find({ status: "in_progress" })
    .sort({ startedAt: 1 })
    .limit(limit);

  const quizCache = new Map();
  let expired = 0;
  let flagged = 0;

  for (const attempt of stale) {
    const key = String(attempt.quizId);
    if (!quizCache.has(key)) {
      // eslint-disable-next-line no-await-in-loop
      quizCache.set(key, await LmQuiz.findById(attempt.quizId));
    }
    const quiz = quizCache.get(key);
    // An attempt whose quiz has been deleted has no deadline to judge it by;
    // leave it rather than guess.
    if (!quiz) continue;

    const { attemptExpired } = engine.deadlineState(quiz, attempt, null, now);

    if (attemptExpired) {
      // eslint-disable-next-line no-await-in-loop
      await finaliseAttempt(attempt, quiz, { body: {} }, "expired");
      expired += 1;
      continue;
    }

    if (noteHeartbeatLoss(attempt, now)) {
      flagged += 1;
      // eslint-disable-next-line no-await-in-loop
      await attempt.save();
    }
  }

  return { scanned: stale.length, expired, flagged };
}

/**
 * Starts the sweep on an interval.
 *
 * `unref` so the timer never holds the process open — a test run or a graceful
 * shutdown should not wait on it. Interval is generous because nothing depends
 * on the sweep for correctness: every path a student can take enforces the
 * deadline itself, and this only catches the sittings nobody came back to.
 */
function startAttemptReaper({ intervalMs = 5 * 60 * 1000 } = {}) {
  const timer = setInterval(() => {
    reapExpiredAttempts().catch((error) => {
      console.error("[LearningModule] attempt reaper", error.message);
    });
    // Rides the same timer rather than starting a second one. Neither sweep is
    // load-bearing — the marks are already readable the moment the clock passes,
    // this only tells the class about it — so a few minutes' lag is the right
    // trade for one interval instead of two.
    announceDueResults().catch((error) => {
      console.error("[LearningModule] result announcer", error.message);
    });
  }, intervalMs);
  timer.unref?.();
  return timer;
}

/* ─────────────────────────────── heartbeat ────────────────────────────── */

/**
 * The page saying it is still there.
 *
 * Cheap on purpose — it is called every thirty seconds per sitting student — so
 * it writes two fields and answers with the deadline. It also enforces the
 * deadline, which means a tab left running gets submitted at the right moment
 * even if the student never touches it again.
 */
exports.heartbeat = async (req, res) => {
  const attempt = await LmQuizAttempt.findOne({
    _id: req.params.attemptId,
    classId: req.lmClass._id,
    studentId: req.lmUser.id,
  });
  if (!attempt) return res.status(404).json({ message: "Attempt not found." });
  if (attempt.status !== "in_progress") {
    return res.json({ status: attempt.status, finished: true });
  }

  const quiz = await LmQuiz.findById(attempt.quizId);
  if (!quiz) return res.status(404).json({ message: "Quiz not found." });

  // The guard runs here too, and it matters most here: `lastSeenAt` is what
  // decides who owns the sitting, so only the bound session may refresh it. A
  // second screen pinging away would otherwise hold the attempt "live" and make
  // the student's real browser look like the intruder.
  const guard = await guardSitting(attempt, quiz, req, res);
  if (guard.stop) return undefined;
  res.set(SESSION_HEADER, guard.token);

  const timing = await enforceDeadline(attempt, quiz, req, null);
  if (timing.expiredAttempt) {
    return res.json({
      status: timing.expiredAttempt.status,
      finished: true,
      expired: true,
      attempt: attemptForStudent(timing.expiredAttempt, quiz),
    });
  }

  const now = new Date();
  // Cleared on return so a student who reconnects is not permanently marked; the
  // violation already recorded stays, which is the part a teacher needs.
  attempt.lastSeenAt = now;
  attempt.heartbeatLostAt = null;
  await attempt.save();

  return res.json({ status: "in_progress", deadline: timing.deadline, serverTime: now });
};

exports.announceResults = announceResults;
exports.announceDueResults = announceDueResults;
exports.reapExpiredAttempts = reapExpiredAttempts;
exports.startAttemptReaper = startAttemptReaper;
exports.noteHeartbeatLoss = noteHeartbeatLoss;
exports.violationTime = violationTime;
exports.noteDevice = noteDevice;
exports.bindSession = bindSession;
exports.forStudent = forStudent;
exports.SESSION_HEADER = SESSION_HEADER;
exports.HEARTBEAT_GRACE_MS = HEARTBEAT_GRACE_MS;
exports.finaliseAttempt = finaliseAttempt;
