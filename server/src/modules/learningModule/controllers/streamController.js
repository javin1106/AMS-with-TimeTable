const LmAnnouncement = require("../models/lmAnnouncement");
const LmCoursework = require("../models/lmCoursework");
const LmClass = require("../models/lmClass");
const LmMembership = require("../models/lmMembership");
const LmQuiz = require("../models/lmQuiz");
const { notifyClass } = require("../services/notifyService");

/**
 * Fills in reaction names for rows written before userName was denormalised,
 * in one membership lookup for the whole page rather than one per reaction.
 */
async function withReactionNames(announcements, classId) {
  const missing = new Set();
  announcements.forEach((a) =>
    (a.reactions || []).forEach((r) => {
      if (r.userId && !r.userName) missing.add(String(r.userId));
    }),
  );
  if (!missing.size) return announcements;

  const members = await LmMembership.find({ classId, userId: { $in: [...missing] } })
    .select("userId name")
    .lean();
  const nameById = new Map(members.map((m) => [String(m.userId), m.name]));

  return announcements.map((a) => ({
    ...a,
    reactions: (a.reactions || []).map((r) => ({
      ...r,
      userName: r.userName || nameById.get(String(r.userId)) || "Someone",
    })),
  }));
}

const canPost = (req) => {
  if (req.lmIsTeacher) return true;
  return req.lmClass.settings.whoCanPost === "students_can_post" && !req.lmMembership?.muted;
};

/**
 * Scheduled posts go live lazily: any read of the stream first flips items
 * whose scheduledFor has passed. That avoids running a cron for something the
 * stream itself observes, and keeps behaviour identical on a restarted server.
 *
 * Going live is also when the class is told. It used to be an `updateMany` and
 * nothing else, so a post or quiz a teacher scheduled for Monday morning simply
 * appeared — no notification, no email — while the same item published by hand
 * announced itself. The scheduling teacher had no way to know the difference.
 *
 * Two things make announcing here safe. Each row is *claimed* with its own
 * conditional update rather than flipped in bulk: `status: "scheduled"` in the
 * filter means only one caller's update matches, so concurrent readers cannot
 * each announce the same item. And the announcing is deliberately not awaited —
 * this sits in front of every stream fetch, and no student's page load should
 * wait on SMTP. `notifyClass` handles its own failures and never rejects.
 */
async function releaseScheduled(klass) {
  const classId = klass._id;
  const now = new Date();
  const due = { classId, status: "scheduled", scheduledFor: { $lte: now } };

  const [announcements, coursework] = await Promise.all([
    LmAnnouncement.find(due).select("authorId authorName text audience").lean(),
    LmCoursework.find(due)
      .select("createdBy createdByName title workType dueDate audience quizId")
      .lean(),
  ]);
  if (!announcements.length && !coursework.length) return;

  const claim = (Model, id) =>
    Model.findOneAndUpdate(
      { _id: id, status: "scheduled" },
      { $set: { status: "published", publishedAt: now } },
    ).lean();

  const claimed = await Promise.all([
    ...announcements.map((item) =>
      claim(LmAnnouncement, item._id).then((won) => (won ? { kind: "announcement", item } : null)),
    ),
    ...coursework.map((item) =>
      claim(LmCoursework, item._id).then((won) => (won ? { kind: "coursework", item } : null)),
    ),
  ]);

  claimed.filter(Boolean).forEach(({ kind, item }) => {
    if (kind === "announcement") {
      notifyClass({
        klass,
        userIds: item.audience?.length ? item.audience : null,
        excludeUserId: item.authorId,
        type: "announcement",
        title: `New post in ${klass.name}`,
        body: item.text,
        link: `/learning/class/${classId}`,
        actorName: item.authorName,
        email: true,
      });
      return;
    }

    // A scheduled quiz rides on its coursework row, and the class wants the
    // paper itself — /work/:id is the gradebook entry, not the door.
    const isQuiz = Boolean(item.quizId);
    notifyClass({
      klass,
      userIds: item.audience?.length ? item.audience : null,
      excludeUserId: item.createdBy,
      type: isQuiz ? "quiz" : item.workType === "material" ? "material" : "coursework",
      title: isQuiz
        ? `New quiz in ${klass.name}: ${item.title}`
        : `${klass.name}: ${item.title}`,
      body: item.dueDate ? `Due ${new Date(item.dueDate).toLocaleString("en-IN")}` : "No due date",
      link: isQuiz
        ? `/learning/class/${classId}/quiz/${item.quizId}`
        : `/learning/class/${classId}/work/${item._id}`,
      actorName: item.createdByName,
      email: true,
    });

    // Keep the quiz's own once-only marker in step, so bringing a released
    // quiz forward later is not treated as a fresh one.
    if (isQuiz) {
      LmQuiz.updateOne({ _id: item.quizId, announcedAt: null }, { $set: { announcedAt: now } }).catch(
        (err) => console.error("[LearningModule] quiz announcedAt:", err.message),
      );
    }
  });
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
  await releaseScheduled(req.lmClass);

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

  const named = await withReactionNames(announcements, req.lmClass._id);

  const items = [
    ...named.map((a) => ({ ...a, streamType: "announcement" })),
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
    // Not awaited — same reasoning as releaseScheduled() above: no teacher's
    // "post" click should wait on SMTP.
    notifyClass({
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

  // Publishing here is the same event as posting: a draft the teacher was
  // still writing, or a scheduled item brought forward, now exists for the
  // class. It used to flip the status and stop — so a post written as a draft
  // first, which is how most long posts are written, reached the stream with
  // no notification and no email, while the same text posted directly
  // announced itself to everyone.
  const published = req.body.publish === true && announcement.status !== "published";
  if (published) {
    announcement.status = "published";
    announcement.publishedAt = new Date();
    announcement.scheduledFor = null;
  }

  announcement.updated_at = new Date();
  await announcement.save();

  if (published) {
    await LmClass.updateOne({ _id: req.lmClass._id }, { $inc: { "stats.announcementCount": 1 } });
    // Not awaited — same reasoning as releaseScheduled() above.
    notifyClass({
      klass: req.lmClass,
      userIds: announcement.audience.length ? announcement.audience : null,
      excludeUserId: announcement.authorId,
      type: "announcement",
      title: `New post in ${req.lmClass.name}`,
      body: announcement.text,
      link: `/learning/class/${req.lmClass._id}`,
      actorName: announcement.authorName,
      email: true,
    });
  }

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
  else announcement.reactions.push({ userId: req.lmUser.id, userName: req.lmUser.name, emoji });

  await announcement.save();
  const [named] = await withReactionNames([announcement.toObject()], req.lmClass._id);
  return res.json({ reactions: named.reactions });
};
