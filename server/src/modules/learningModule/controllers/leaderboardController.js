const LmPoints = require("../models/lmPoints");
const LmBadge = require("../models/lmBadge");
const game = require("../services/gamification");

/**
 * The class leaderboard, weekly and all-time, plus the caller's own standing.
 *
 * Staff appear nowhere on it. A teacher's activity is not the same game — they
 * post the work rather than doing it — and a class list topped by the person
 * who set the homework is not a leaderboard anybody wants to be on.
 */
exports.getLeaderboard = async (req, res) => {
  const classId = req.lmClass._id;
  const scope = req.query.scope === "all" ? "all" : "week";
  const weekKey = scope === "week" ? game.weekKeyOf() : null;

  // Lazily, on read: one badge a week is not worth a cron nobody remembers.
  await game.crownLastWeek(classId);
  await game.checkOverallBadges(classId);

  const [rows, mine, badgeCounts, summary] = await Promise.all([
    game.leaderboard({ classId, weekKey }),
    // Staff do not earn, so there is no standing to fetch for them.
    req.lmIsTeacher ? null : game.standingFor({ classId, studentId: req.lmUser.id }),
    LmBadge.aggregate([
      // An aggregation does no casting; classId is already an ObjectId here.
      { $match: { classId } },
      { $group: { _id: "$studentId", count: { $sum: 1 } } },
    ]),
    // A teacher is not on this table and is not asking who is winning — they
    // want to know whether the class is engaged and who has gone quiet.
    req.lmIsTeacher ? game.classSummary(classId) : null,
  ]);

  const badgesBy = new Map(badgeCounts.map((row) => [String(row._id), row.count]));

  return res.json({
    scope,
    weekKey,
    weekStart: weekKey ? game.weekStartOf(weekKey) : null,
    isTeacher: Boolean(req.lmIsTeacher),
    rows: rows.map((row) => ({
      ...row,
      badges: badgesBy.get(String(row.studentId)) || 0,
      isMe: String(row.studentId) === req.lmUser.id,
    })),
    me: mine
      ? {
          ...mine,
          // Their own position, even when they are nowhere near the visible
          // top. A leaderboard that simply omits you is one you stop opening.
          rank: rows.findIndex((row) => String(row.studentId) === req.lmUser.id) + 1 || null,
        }
      : null,
    summary,
    catalogue: Object.keys(game.BADGES).map((id) => game.describeBadge(id)),
  });
};

/**
 * How points work, served rather than written into the client.
 *
 * The numbers live in one place — the service — and a guide that restated them
 * in JSX would drift the first time anybody tuned a value, which is exactly the
 * kind of wrong documentation that is worse than none.
 */
exports.getPointsGuide = async (req, res) => {
  const p = game.POINTS;

  return res.json({
    // Ordered heaviest first, which is the order the page reads in.
    earning: [
      {
        id: "notebook",
        label: "Coding exercise",
        points: p.notebookOnTime,
        latePoints: p.notebookLate,
        bonus: p.notebookCompleted,
        bonusFor: "running every cell with no errors left",
        note: "The heaviest thing here — written, run and debugged.",
      },
      {
        id: "submission",
        label: "Assignment turned in",
        points: p.submissionOnTime,
        latePoints: p.submissionLate,
      },
      {
        id: "quiz",
        label: "Quiz sat",
        points: p.quizAttempt,
        bonus: p.quizScoreBonus(100),
        bonusFor: "your score — a point per 5%",
        note: "Sitting it is at least half the points however it went.",
      },
      { id: "tutorial", label: "Tutorial worked through", points: p.tutorial },
      {
        id: "feedback",
        label: "Anonymous feedback",
        points: p.feedback,
        note: "Once per class. Your history says only “took part”, never what you wrote.",
      },
      {
        id: "discussion",
        label: "Starting a discussion",
        points: p.discussion,
        note: "One new topic per week.",
      },
      {
        id: "short",
        label: "Joining a live Short",
        points: p.shortAnswer,
        note: "Per session, not per question.",
      },
      {
        id: "comment",
        label: "Replying in a discussion",
        points: p.comment,
        note: `Up to ${game.COMMENT_DAILY_CAP} a day.`,
      },
    ],
    weeklyResets: true,
    badges: Object.keys(game.BADGES).map((id) => game.describeBadge(id)),
    principles: [
      "Points are for effort, not marks. Your grades are separate and always will be.",
      "Late work still earns, at roughly 40%. Something beats nothing.",
      "Nothing pays twice — resubmitting the same work does not earn again.",
      "The weekly board resets every Monday. The all-time board never does.",
    ],
  });
};

/** Where a student's own points came from — the answer to "why 240?". */
exports.getMyPoints = async (req, res) => {
  const classId = req.lmClass._id;
  const [standing, history] = await Promise.all([
    game.standingFor({ classId, studentId: req.lmUser.id }),
    LmPoints.find({ classId, studentId: req.lmUser.id })
      .sort({ created_at: -1 })
      .limit(50)
      .select("kind points reason created_at")
      .lean(),
  ]);

  return res.json({
    ...standing,
    history,
    catalogue: Object.keys(game.BADGES).map((id) => game.describeBadge(id)),
  });
};
