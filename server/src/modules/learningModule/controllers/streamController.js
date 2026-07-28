const LmAnnouncement = require("../models/lmAnnouncement");
const LmCoursework = require("../models/lmCoursework");
const LmClass = require("../models/lmClass");
const { notifyClass } = require("../services/notifyService");

const canPost = (req) => {
  if (req.lmIsTeacher) return true;
  return req.lmClass.settings.whoCanPost === "students_can_post" && !req.lmMembership?.muted;
};

// Scheduled posts go live lazily: any read of the stream first flips items
// whose scheduledFor has passed. That avoids running a cron for something the
// stream itself observes, and keeps behaviour identical on a restarted server.
async function releaseScheduled(classId) {
  const now = new Date();
  await Promise.all([
    LmAnnouncement.updateMany(
      { classId, status: "scheduled", scheduledFor: { $lte: now } },
      { $set: { status: "published", publishedAt: now } },
    ),
    LmCoursework.updateMany(
      { classId, status: "scheduled", scheduledFor: { $lte: now } },
      { $set: { status: "published", publishedAt: now } },
    ),
  ]);
}

// Targeted posts (audience non-empty) are only visible to the listed students;
// teachers always see everything.
const audienceFilter = (req) =>
  req.lmIsTeacher ? {} : { $or: [{ audience: { $size: 0 } }, { audience: req.lmUser.id }] };

/**
 * The unified class stream: announcements interleaved with "X posted a new
 * assignment" entries, newest first, pinned items on top.
 */
exports.getStream = async (req, res) => {
  await releaseScheduled(req.lmClass._id);

  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const before = req.query.before ? new Date(req.query.before) : null;

  const baseFilter = { classId: req.lmClass._id, ...audienceFilter(req) };
  const statusFilter = req.lmIsTeacher
    ? { status: { $in: ["published", "scheduled", "draft"] } }
    : { status: "published" };
  const timeFilter = before ? { publishedAt: { $lt: before } } : {};

  const [announcements, coursework] = await Promise.all([
    LmAnnouncement.find({ ...baseFilter, ...statusFilter, ...timeFilter })
      .sort({ pinned: -1, publishedAt: -1 })
      .limit(limit)
      .lean(),
    LmCoursework.find({ ...baseFilter, ...statusFilter, ...timeFilter })
      .sort({ publishedAt: -1 })
      .limit(limit)
      .lean(),
  ]);

  const items = [
    ...announcements.map((a) => ({ ...a, streamType: "announcement" })),
    ...coursework.map((c) => ({ ...c, streamType: "coursework" })),
  ]
    .sort((a, b) => {
      if (Boolean(b.pinned) !== Boolean(a.pinned)) return b.pinned ? 1 : -1;
      return new Date(b.publishedAt) - new Date(a.publishedAt);
    })
    .slice(0, limit);

  return res.json({
    items,
    canPost: canPost(req),
    nextCursor: items.length === limit ? items[items.length - 1].publishedAt : null,
  });
};

exports.createAnnouncement = async (req, res) => {
  if (!canPost(req)) {
    return res.status(403).json({ message: "Only teachers can post in this class." });
  }

  const text = String(req.body.text || "").trim();
  const attachments = Array.isArray(req.body.attachments) ? req.body.attachments : [];
  if (!text && !attachments.length) {
    return res.status(400).json({ message: "Write something or attach a file." });
  }

  const scheduledFor = req.body.scheduledFor ? new Date(req.body.scheduledFor) : null;
  const isScheduled = Boolean(scheduledFor && scheduledFor > new Date());
  const status = req.body.draft ? "draft" : isScheduled ? "scheduled" : "published";

  const announcement = await LmAnnouncement.create({
    classId: req.lmClass._id,
    authorId: req.lmUser.id,
    authorName: req.lmUser.name,
    authorRole: req.lmRole,
    text,
    attachments,
    audience: Array.isArray(req.body.audience) ? req.body.audience : [],
    pinned: req.lmIsTeacher ? Boolean(req.body.pinned) : false,
    status,
    scheduledFor: isScheduled ? scheduledFor : null,
    publishedAt: status === "published" ? new Date() : scheduledFor || new Date(),
  });

  if (status === "published") {
    await LmClass.updateOne({ _id: req.lmClass._id }, { $inc: { "stats.announcementCount": 1 } });
    await notifyClass({
      klass: req.lmClass,
      userIds: announcement.audience.length ? announcement.audience : null,
      excludeUserId: req.lmUser.id,
      type: "announcement",
      title: `New post in ${req.lmClass.name}`,
      body: text,
      link: `/learning/class/${req.lmClass._id}`,
      actorName: req.lmUser.name,
      email: true,
    });
  }

  return res.status(201).json(announcement);
};

const loadOwnAnnouncement = async (req) => {
  const announcement = await LmAnnouncement.findOne({
    _id: req.params.announcementId,
    classId: req.lmClass._id,
  });
  if (!announcement) return { error: { status: 404, message: "Post not found." } };
  const mine = String(announcement.authorId) === req.lmUser.id;
  if (!mine && !req.lmIsTeacher) {
    return { error: { status: 403, message: "You can only edit your own posts." } };
  }
  return { announcement };
};

exports.updateAnnouncement = async (req, res) => {
  const { announcement, error } = await loadOwnAnnouncement(req);
  if (error) return res.status(error.status).json({ message: error.message });

  if (req.body.text !== undefined) announcement.text = String(req.body.text);
  if (req.body.attachments !== undefined) announcement.attachments = req.body.attachments;
  if (req.body.audience !== undefined) announcement.audience = req.body.audience;
  if (req.body.pinned !== undefined && req.lmIsTeacher) announcement.pinned = Boolean(req.body.pinned);

  if (req.body.publish === true && announcement.status !== "published") {
    announcement.status = "published";
    announcement.publishedAt = new Date();
    announcement.scheduledFor = null;
  }

  announcement.updated_at = new Date();
  await announcement.save();
  return res.json(announcement);
};

exports.deleteAnnouncement = async (req, res) => {
  const { announcement, error } = await loadOwnAnnouncement(req);
  if (error) return res.status(error.status).json({ message: error.message });
  await LmAnnouncement.deleteOne({ _id: announcement._id });
  return res.json({ deleted: true });
};

/** Toggling the caller's reaction on a post. */
exports.reactToAnnouncement = async (req, res) => {
  const emoji = String(req.body.emoji || "👍").slice(0, 8);
  const announcement = await LmAnnouncement.findOne({
    _id: req.params.announcementId,
    classId: req.lmClass._id,
  });
  if (!announcement) return res.status(404).json({ message: "Post not found." });

  const index = announcement.reactions.findIndex(
    (r) => String(r.userId) === req.lmUser.id && r.emoji === emoji,
  );
  if (index >= 0) announcement.reactions.splice(index, 1);
  else announcement.reactions.push({ userId: req.lmUser.id, emoji });

  await announcement.save();
  return res.json({ reactions: announcement.reactions });
};
