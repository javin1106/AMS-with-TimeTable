const LmClass = require("../models/lmClass");
const LmMembership = require("../models/lmMembership");
const LmBugReport = require("../models/lmBugReport");
const LmFeedback = require("../models/lmFeedback");

/**
 * The lm-admin dashboard's one call: a platform-wide read of what the module
 * looks like right now, plus the handful of items that most need a look
 * (open bugs/suggestions, unread feedback). Everything a class-scoped screen
 * already answers (who is enrolled where, the queues themselves) is left to
 * those screens — this exists for the questions none of them answer: how many
 * classes exist at all, and how many people are actually in them.
 */
exports.getSummary = async (req, res) => {
  if (!req.lmUser.isAdmin) return res.status(403).json({ message: "Forbidden" });

  const [
    courseCount,
    activeCourseCount,
    studentCount,
    teacherCount,
    bugStatusCounts,
    bugKindCounts,
    recentBugs,
    feedbackStatusCounts,
    feedbackTotal,
    recentFeedback,
  ] = await Promise.all([
    LmClass.countDocuments(),
    LmClass.countDocuments({ status: "active" }),
    LmMembership.countDocuments({ role: "student", status: "active" }),
    LmMembership.countDocuments({ role: { $in: ["teacher", "co-teacher"] }, status: "active" }),
    LmBugReport.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    LmBugReport.aggregate([
      { $group: { _id: { $ifNull: ["$kind", "bug"] }, count: { $sum: 1 } } },
    ]),
    LmBugReport.find({ status: "open" }).sort({ created_at: -1 }).limit(5).lean(),
    LmFeedback.aggregate([
      { $match: { deleted: { $ne: true } } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    LmFeedback.countDocuments({ deleted: { $ne: true } }),
    LmFeedback.find({ deleted: { $ne: true } })
      .sort({ created_at: -1 })
      .limit(5)
      .populate("classId", "name subject")
      .lean(),
  ]);

  return res.json({
    courses: { total: courseCount, active: activeCourseCount },
    people: { students: studentCount, teachers: teacherCount },
    bugs: {
      total: bugStatusCounts.reduce((sum, row) => sum + row.count, 0),
      byStatus: Object.fromEntries(bugStatusCounts.map((row) => [row._id, row.count])),
      byKind: Object.fromEntries(bugKindCounts.map((row) => [row._id, row.count])),
      recent: recentBugs,
    },
    feedback: {
      total: feedbackTotal,
      byStatus: Object.fromEntries(feedbackStatusCounts.map((row) => [row._id, row.count])),
      // Identified the same way feedbackController's admin view is: an
      // administrator is one of the two audiences allowed to see who sent it.
      recent: recentFeedback.map((item) => ({
        _id: item._id,
        className: item.classId?.name || item.classId?.subject || "",
        classId: item.classId?._id || item.classId || null,
        category: item.category,
        sentiment: item.sentiment,
        status: item.status,
        text: item.text,
        studentName: item.studentName,
        created_at: item.created_at,
      })),
    },
  });
};
