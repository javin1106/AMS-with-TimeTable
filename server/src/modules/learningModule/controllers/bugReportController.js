const LmBugReport = require("../models/lmBugReport");
const LmClass = require("../models/lmClass");
const LmMembership = require("../models/lmMembership");
const game = require("../services/gamification");
const { notifyUser, sendBugReportMail } = require("../services/notifyService");

/**
 * "Something is broken" — or "this would be better if" — from the sidebar, for
 * anyone.
 *
 * Deliberately outside the class router: most bugs are not about a class, and
 * making somebody navigate into one first is how a bug goes unreported.
 */

const MAX_TITLE = 160;
const MAX_DESCRIPTION = 4000;

const KINDS = ["bug", "suggestion"];
const STATUSES = ["open", "acknowledged", "duplicate", "rejected", "fixed"];

// A reporter cannot open an unbounded number of tickets. Generous enough that
// nobody hits it in good faith, low enough that the queue stays readable.
const OPEN_LIMIT = 10;

const forReporter = (report) => ({
  _id: report._id,
  kind: report.kind || "bug",
  title: report.title,
  description: report.description,
  pageUrl: report.pageUrl,
  className: report.className,
  status: report.status,
  adminNote: report.adminNote,
  reviewedByName: report.reviewedByName,
  reviewedAt: report.reviewedAt,
  awarded: Boolean(report.awardedAt),
  created_at: report.created_at,
});

exports.createBugReport = async (req, res) => {
  const title = String(req.body.title || "").trim().slice(0, MAX_TITLE);
  const description = String(req.body.description || "").trim().slice(0, MAX_DESCRIPTION);
  if (!title) return res.status(400).json({ message: "Say briefly what went wrong." });

  // Anything unrecognised is treated as a bug: the queue is read defect-first,
  // and a defect miscategorised as a suggestion is the costlier mistake.
  const kind = KINDS.includes(req.body.kind) ? req.body.kind : "bug";

  const open = await LmBugReport.countDocuments({ reporterId: req.lmUser.id, status: "open" });
  if (open >= OPEN_LIMIT) {
    return res.status(429).json({
      message: `You have ${open} reports still waiting to be looked at. Give us a chance to catch up.`,
      code: "TOO_MANY_OPEN",
    });
  }

  // The class is checked rather than trusted: a report claiming a class the
  // reporter is not in would put a badge in somebody else's class.
  let klass = null;
  if (req.body.classId) {
    const membership = await LmMembership.findOne({
      classId: req.body.classId,
      userId: req.lmUser.id,
      status: "active",
    }).lean();
    if (membership) {
      klass = await LmClass.findById(req.body.classId).select("name session").lean();
    }
  }

  const report = await LmBugReport.create({
    reporterId: req.lmUser.id,
    reporterName: req.lmUser.name,
    reporterEmail: req.lmUser.email,
    reporterRole: req.lmUser.roles?.[0] || "",
    kind,
    title,
    description,
    pageUrl: String(req.body.pageUrl || "").slice(0, 500),
    classId: klass?._id || null,
    className: klass?.name || "",
    session: klass?.session || "",
  });

  // Not awaited: mailing every admin walks the user collection and then the
  // SMTP pool, and the person who just pressed "Send" should not be made to
  // wait for it — nor should their report be lost if the mail box is down.
  // sendBugReportMail swallows its own failures.
  sendBugReportMail(report);

  return res.status(201).json(forReporter(report));
};

/** The reporter's own tickets, so "did anything come of it" is answerable. */
exports.listMyBugReports = async (req, res) => {
  const reports = await LmBugReport.find({ reporterId: req.lmUser.id })
    .sort({ created_at: -1 })
    .limit(100)
    .lean();
  return res.json({
    reports: reports.map(forReporter),
    pointsPerReport: game.POINTS.bugReport,
  });
};

/** The queue. Platform admins only — see the note on `reviewBugReport`. */
exports.listAllBugReports = async (req, res) => {
  if (!req.lmUser.isAdmin) return res.status(403).json({ message: "Forbidden" });

  const filter = {};
  if (STATUSES.includes(req.query.status)) filter.status = String(req.query.status);
  // Legacy rows predate `kind` and carry no value at all; asking for bugs has
  // to include them, or the queue would appear to empty itself on upgrade.
  if (req.query.kind === "bug") filter.kind = { $in: ["bug", null] };
  else if (req.query.kind === "suggestion") filter.kind = "suggestion";

  const reports = await LmBugReport.find(filter)
    .sort({ status: 1, created_at: -1 })
    .limit(500)
    .lean();

  const [statusCounts, kindCounts] = await Promise.all([
    LmBugReport.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    LmBugReport.aggregate([
      { $group: { _id: { $ifNull: ["$kind", "bug"] }, count: { $sum: 1 } } },
    ]),
  ]);

  return res.json({
    reports: reports.map((report) => ({ ...report, kind: report.kind || "bug" })),
    counts: Object.fromEntries(statusCounts.map((row) => [row._id, row.count])),
    kindCounts: Object.fromEntries(kindCounts.map((row) => [row._id, row.count])),
  });
};

/**
 * An admin's verdict on a report.
 *
 * Platform admin rather than class faculty on purpose: these are defects in the
 * software, and the person who can confirm one is not the person who happens to
 * teach the class it was noticed in. It also keeps a teacher from awarding
 * points to their own students for reports nobody else has seen.
 *
 * Only `acknowledged` pays, and only the first time — `awardedAt` records that,
 * and the ledger refuses a second row for the same report regardless. So an
 * admin moving a ticket acknowledged → fixed → acknowledged cannot pay twice.
 */
exports.reviewBugReport = async (req, res) => {
  if (!req.lmUser.isAdmin) return res.status(403).json({ message: "Forbidden" });

  const status = String(req.body.status || "");
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ message: "Unknown status." });
  }

  const report = await LmBugReport.findById(req.params.reportId);
  if (!report) return res.status(404).json({ message: "Report not found." });

  const firstAcknowledgement = status === "acknowledged" && !report.awardedAt;

  report.status = status;
  if (req.body.adminNote !== undefined) report.adminNote = String(req.body.adminNote).slice(0, 2000);
  report.reviewedBy = req.lmUser.id;
  report.reviewedByName = req.lmUser.name;
  report.reviewedAt = new Date();
  if (firstAcknowledgement) report.awardedAt = new Date();
  report.updated_at = new Date();
  await report.save();

  if (firstAcknowledgement) {
    const suggestion = report.kind === "suggestion";
    await game.onBugAcknowledged({ report });
    await notifyUser({
      userId: report.reporterId,
      klass: report.classId ? { _id: report.classId, name: report.className } : null,
      type: "bug",
      title: suggestion
        ? `Your suggestion was approved: ${report.title}`
        : `Your bug report was confirmed: ${report.title}`,
      body: suggestion
        ? `Thanks — we are taking that one up. ${game.POINTS.bugReport} points added.`
        : `Thanks — that was a real one. ${game.POINTS.bugReport} points added.`,
      link: "/learning/bugs",
      actorName: report.reviewedByName,
    });
  }

  return res.json(report);
};
