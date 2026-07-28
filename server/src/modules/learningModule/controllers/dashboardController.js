const LmClass = require("../models/lmClass");
const LmMembership = require("../models/lmMembership");
const LmCoursework = require("../models/lmCoursework");
const LmSubmission = require("../models/lmSubmission");
const LmAnnouncement = require("../models/lmAnnouncement");
const LmQuizAttempt = require("../models/lmQuizAttempt");
const LmAudioSession = require("../models/lmAudioSession");

const myActiveClassIds = async (userId) => {
  const memberships = await LmMembership.find({ userId, status: "active" })
    .select("classId role")
    .lean();
  const classes = await LmClass.find({
    _id: { $in: memberships.map((m) => m.classId) },
    status: "active",
  })
    .select("name coverColor section subject")
    .lean();

  const roleByClass = new Map(memberships.map((m) => [String(m.classId), m.role]));
  return { classes, roleByClass };
};

/**
 * Cross-class "To do" — the student's upcoming/missing work, or the teacher's
 * pile of work waiting to be reviewed.
 */
exports.getTodo = async (req, res) => {
  const { classes, roleByClass } = await myActiveClassIds(req.lmUser.id);
  const classById = new Map(classes.map((c) => [String(c._id), c]));

  const teachingIds = classes
    .filter((c) => ["teacher", "co-teacher"].includes(roleByClass.get(String(c._id))))
    .map((c) => c._id);
  const learningIds = classes
    .filter((c) => roleByClass.get(String(c._id)) === "student")
    .map((c) => c._id);

  const now = new Date();

  const [studentSubmissions, toReview] = await Promise.all([
    LmSubmission.find({
      classId: { $in: learningIds },
      studentId: req.lmUser.id,
    })
      .populate("courseworkId", "title dueDate points workType status")
      .lean(),
    LmSubmission.find({
      classId: { $in: teachingIds },
      state: "turned_in",
    })
      .populate("courseworkId", "title dueDate points")
      .lean(),
  ]);

  const withCoursework = studentSubmissions.filter(
    (s) => s.courseworkId && s.courseworkId.status !== "draft",
  );

  const decorate = (submission) => ({
    submissionId: submission._id,
    courseworkId: submission.courseworkId?._id,
    title: submission.courseworkId?.title,
    dueDate: submission.courseworkId?.dueDate,
    points: submission.courseworkId?.points,
    workType: submission.courseworkId?.workType,
    state: submission.state,
    grade: submission.grade,
    maxPoints: submission.maxPoints,
    class: classById.get(String(submission.classId)) || null,
    studentName: submission.studentName,
  });

  const pending = withCoursework.filter((s) => s.state === "assigned" || s.state === "reclaimed");

  return res.json({
    assigned: pending
      .filter((s) => !s.courseworkId?.dueDate || new Date(s.courseworkId.dueDate) >= now)
      .sort((a, b) => new Date(a.courseworkId?.dueDate || 0) - new Date(b.courseworkId?.dueDate || 0))
      .map(decorate),
    missing: pending
      .filter((s) => s.courseworkId?.dueDate && new Date(s.courseworkId.dueDate) < now)
      .map(decorate),
    done: withCoursework
      .filter((s) => s.state === "turned_in" || s.state === "returned")
      .sort((a, b) => new Date(b.turnedInAt || 0) - new Date(a.turnedInAt || 0))
      .slice(0, 50)
      .map(decorate),
    toReview: toReview
      .sort((a, b) => new Date(a.turnedInAt || 0) - new Date(b.turnedInAt || 0))
      .map(decorate),
  });
};

/** Due dates across every class the caller is in, for the calendar view. */
exports.getCalendar = async (req, res) => {
  const { classes, roleByClass } = await myActiveClassIds(req.lmUser.id);
  const classById = new Map(classes.map((c) => [String(c._id), c]));

  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 7 * 864e5);
  const to = req.query.to ? new Date(req.query.to) : new Date(Date.now() + 60 * 864e5);

  const coursework = await LmCoursework.find({
    classId: { $in: classes.map((c) => c._id) },
    status: "published",
    dueDate: { $gte: from, $lte: to },
  })
    .select("title dueDate points workType classId")
    .sort({ dueDate: 1 })
    .lean();

  const mySubmissions = await LmSubmission.find({
    studentId: req.lmUser.id,
    courseworkId: { $in: coursework.map((c) => c._id) },
  })
    .select("courseworkId state grade")
    .lean();
  const byCoursework = new Map(mySubmissions.map((s) => [String(s.courseworkId), s]));

  return res.json(
    coursework.map((item) => ({
      ...item,
      class: classById.get(String(item.classId)) || null,
      myRole: roleByClass.get(String(item.classId)) || null,
      mySubmissionState: byCoursework.get(String(item._id))?.state || null,
    })),
  );
};

/** Per-class analytics for the teacher's Insights tab. */
exports.getClassAnalytics = async (req, res) => {
  const classId = req.lmClass._id;

  const [members, coursework, submissions, announcements, attempts, sessions] = await Promise.all([
    LmMembership.find({ classId, status: "active" }).select("role userId name lastSeenAt").lean(),
    LmCoursework.find({ classId, status: "published" }).select("title points workType dueDate").lean(),
    LmSubmission.find({ classId }).select("courseworkId studentId state grade maxPoints late turnedInAt").lean(),
    LmAnnouncement.countDocuments({ classId, status: "published" }),
    LmQuizAttempt.find({ classId, status: "submitted" }).select("percent studentId quizId").lean(),
    LmAudioSession.countDocuments({ classId }),
  ]);

  const students = members.filter((m) => m.role === "student");
  const graded = submissions.filter((s) => s.grade !== null && s.grade !== undefined);

  const perStudent = students.map((student) => {
    const mine = submissions.filter((s) => String(s.studentId) === String(student.userId));
    const myGraded = mine.filter((s) => s.grade !== null && s.grade !== undefined);
    const earned = myGraded.reduce((sum, s) => sum + s.grade, 0);
    const possible = myGraded.reduce((sum, s) => sum + (s.maxPoints || 0), 0);
    return {
      userId: student.userId,
      name: student.name,
      lastSeenAt: student.lastSeenAt,
      assigned: mine.length,
      turnedIn: mine.filter((s) => s.state === "turned_in" || s.state === "returned").length,
      missing: mine.filter(
        (s) => s.state === "assigned" || s.state === "reclaimed",
      ).length,
      late: mine.filter((s) => s.late).length,
      percent: possible ? Math.round((earned / possible) * 1000) / 10 : null,
    };
  });

  const perCoursework = coursework.map((item) => {
    const mine = submissions.filter((s) => String(s.courseworkId) === String(item._id));
    const scored = mine.filter((s) => s.grade !== null && s.grade !== undefined);
    return {
      courseworkId: item._id,
      title: item.title,
      workType: item.workType,
      dueDate: item.dueDate,
      assigned: mine.length,
      turnedIn: mine.filter((s) => s.state === "turned_in" || s.state === "returned").length,
      late: mine.filter((s) => s.late).length,
      average: scored.length
        ? Math.round((scored.reduce((sum, s) => sum + s.grade, 0) / scored.length) * 10) / 10
        : null,
      maxPoints: item.points,
    };
  });

  const submissionRate = submissions.length
    ? Math.round(
        (submissions.filter((s) => s.state === "turned_in" || s.state === "returned").length /
          submissions.length) *
          1000,
      ) / 10
    : null;

  return res.json({
    totals: {
      students: students.length,
      teachers: members.length - students.length,
      coursework: coursework.length,
      announcements,
      lectureSessions: sessions,
      submissions: submissions.length,
      graded: graded.length,
      quizAttempts: attempts.length,
    },
    rates: {
      submissionRate,
      lateRate: submissions.length
        ? Math.round((submissions.filter((s) => s.late).length / submissions.length) * 1000) / 10
        : null,
      classAverage: graded.length
        ? Math.round(
            (graded.reduce((sum, s) => sum + (s.grade / (s.maxPoints || 1)) * 100, 0) /
              graded.length) *
              10,
          ) / 10
        : null,
      quizAverage: attempts.length
        ? Math.round((attempts.reduce((sum, a) => sum + a.percent, 0) / attempts.length) * 10) / 10
        : null,
    },
    perStudent: perStudent.sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1)),
    perCoursework,
    // Students who have handed in nothing and have at least one missing item —
    // the list a teacher actually acts on.
    atRisk: perStudent
      .filter((s) => s.missing > 0 && s.turnedIn === 0)
      .map((s) => ({ name: s.name, userId: s.userId, missing: s.missing })),
  });
};

/** Landing summary across all of the caller's classes. */
exports.getOverview = async (req, res) => {
  const { classes, roleByClass } = await myActiveClassIds(req.lmUser.id);
  const teachingIds = classes
    .filter((c) => ["teacher", "co-teacher"].includes(roleByClass.get(String(c._id))))
    .map((c) => c._id);
  const learningIds = classes
    .filter((c) => roleByClass.get(String(c._id)) === "student")
    .map((c) => c._id);

  const now = new Date();
  const soon = new Date(Date.now() + 7 * 864e5);

  const [dueSoon, awaitingReview, unreadClasses] = await Promise.all([
    LmSubmission.countDocuments({
      classId: { $in: learningIds },
      studentId: req.lmUser.id,
      state: { $in: ["assigned", "reclaimed"] },
    }),
    LmSubmission.countDocuments({ classId: { $in: teachingIds }, state: "turned_in" }),
    LmCoursework.countDocuments({
      classId: { $in: classes.map((c) => c._id) },
      status: "published",
      dueDate: { $gte: now, $lte: soon },
    }),
  ]);

  return res.json({
    classCount: classes.length,
    teachingCount: teachingIds.length,
    enrolledCount: learningIds.length,
    pendingWork: dueSoon,
    awaitingReview,
    dueThisWeek: unreadClasses,
  });
};
