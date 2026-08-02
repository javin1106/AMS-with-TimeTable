const LmDiscussion = require("../models/lmDiscussion");
const LmComment = require("../models/lmComment");
const { notifyClass } = require("../services/notifyService");
const game = require("../services/gamification");

/**
 * The class forum: topics students open, and staff moderate.
 *
 * The one interesting rule is the rate limit, and it is enforced by a unique
 * index rather than a count — see the note on the model.
 */

const MAX_TITLE = 140;
const MAX_BODY = 8000;

const forClient = (discussion, req) => ({
  _id: discussion._id,
  title: discussion.removed ? "Removed by staff" : discussion.title,
  body: discussion.body,
  removed: Boolean(discussion.removed),
  removedByName: discussion.removedByName || "",
  authorId: discussion.authorId,
  authorName: discussion.authorName,
  authorRole: discussion.authorRole,
  replyCount: discussion.replyCount,
  lastReplyAt: discussion.lastReplyAt,
  lastReplyBy: discussion.lastReplyBy,
  pinned: discussion.pinned,
  closed: discussion.closed,
  created_at: discussion.created_at,
  // Staff moderate anything; an author may remove their own thread while it is
  // still unanswered, which is the "posted it in the wrong class" case.
  canDelete:
    !discussion.removed &&
    (req.lmIsTeacher || (String(discussion.authorId) === req.lmUser.id && discussion.replyCount === 0)),
});

exports.listDiscussions = async (req, res) => {
  const discussions = await LmDiscussion.find({
    classId: req.lmClass._id,
    // A thread a student withdrew is simply gone; one staff took down leaves a
    // tombstone, so the class can see moderation happened rather than quietly
    // finding a post missing.
    $or: [{ removed: false }, { removedByStaff: true }],
  })
    // Pinned first, then whatever was talked about most recently — a thread
    // with a new reply is more use at the top than one posted more recently
    // and ignored.
    .sort({ pinned: -1, lastReplyAt: -1, created_at: -1 })
    .limit(200)
    .lean();

  // What the caller has left this week, so the client can say so before they
  // have written anything rather than after.
  const weekKey = game.weekKeyOf();
  const mineThisWeek = req.lmIsTeacher
    ? 0
    : await LmDiscussion.countDocuments({
        classId: req.lmClass._id,
        authorId: req.lmUser.id,
        weekKey,
      });

  return res.json({
    discussions: discussions.map((discussion) => forClient(discussion, req)),
    canStart: req.lmIsTeacher || mineThisWeek === 0,
    // Staff are not rationed; `null` says "no limit" rather than "none left".
    remainingThisWeek: req.lmIsTeacher ? null : Math.max(0, 1 - mineThisWeek),
    weekKey,
  });
};

exports.createDiscussion = async (req, res) => {
  const title = String(req.body.title || "").trim().slice(0, MAX_TITLE);
  const body = String(req.body.body || "").trim().slice(0, MAX_BODY);
  if (!title) return res.status(400).json({ message: "Give the discussion a title." });
  if (req.lmMembership?.muted) {
    return res.status(403).json({ message: "You cannot post in this class." });
  }

  const weekKey = game.weekKeyOf();

  let discussion;
  try {
    discussion = await LmDiscussion.create({
      classId: req.lmClass._id,
      title,
      body,
      authorId: req.lmUser.id,
      authorName: req.lmUser.name,
      authorRole: req.lmIsTeacher ? req.lmRole : "student",
      weekKey,
    });
  } catch (error) {
    // The index refused it, which is the rate limit doing its job. Reported as
    // a rule rather than an error, because it is not a failure — it is next
    // week's post.
    if (error.code === 11000) {
      return res.status(429).json({
        message: "You have already started a discussion this week. You can start another next week.",
        code: "WEEKLY_LIMIT",
      });
    }
    throw error;
  }

  await game.onDiscussion({ req, discussion });

  await notifyClass({
    klass: req.lmClass,
    excludeUserId: req.lmUser.id,
    type: "discussion",
    title: `New discussion in ${req.lmClass.name}: ${title}`,
    body,
    link: `/learning/class/${req.lmClass._id}/discussions/${discussion._id}`,
    actorName: req.lmUser.name,
    // Deliberately no email. A class of two hundred each starting a thread a
    // week is two hundred emails; the in-app notification is enough for a
    // conversation nobody is graded on.
    email: false,
  });

  return res.status(201).json(forClient(discussion, req));
};

exports.getDiscussion = async (req, res) => {
  const discussion = await LmDiscussion.findOne({
    _id: req.params.discussionId,
    classId: req.lmClass._id,
  }).lean();
  if (!discussion) return res.status(404).json({ message: "Discussion not found." });
  return res.json(forClient(discussion, req));
};

/** Pin or close. Staff only, and neither touches the text. */
exports.updateDiscussion = async (req, res) => {
  const discussion = await LmDiscussion.findOne({
    _id: req.params.discussionId,
    classId: req.lmClass._id,
  });
  if (!discussion) return res.status(404).json({ message: "Discussion not found." });

  if (req.body.pinned !== undefined) discussion.pinned = Boolean(req.body.pinned);
  if (req.body.closed !== undefined) discussion.closed = Boolean(req.body.closed);
  discussion.updated_at = new Date();
  await discussion.save();

  return res.json(forClient(discussion, req));
};

/**
 * Removes a thread and its replies.
 *
 * Staff can remove anything. The author can remove their own only while nobody
 * has replied — once a conversation exists it is not theirs alone to end.
 *
 * Either way the row survives as a flag, and the week is *not* given back.
 * Deleting the row would delete the rate-limit entry with it, and post → delete
 * → post is not a limit. Only a staff removal leaves a visible tombstone; a
 * student withdrawing their own unanswered thread just disappears, since there
 * is nothing for the class to be told about.
 */
exports.deleteDiscussion = async (req, res) => {
  const discussion = await LmDiscussion.findOne({
    _id: req.params.discussionId,
    classId: req.lmClass._id,
    removed: false,
  });
  if (!discussion) return res.status(404).json({ message: "Discussion not found." });

  const isAuthor = String(discussion.authorId) === req.lmUser.id;
  const byStaff = req.lmIsTeacher && !isAuthor;
  if (!req.lmIsTeacher && !(isAuthor && discussion.replyCount === 0)) {
    return res.status(403).json({ message: "Only staff can remove a discussion once it has replies." });
  }

  await LmComment.deleteMany({ targetType: "discussion", targetId: discussion._id });

  discussion.removed = true;
  discussion.removedByStaff = byStaff;
  discussion.removedByName = byStaff ? req.lmUser.name : "";
  discussion.body = "";
  discussion.closed = true;
  discussion.replyCount = 0;
  discussion.updated_at = new Date();
  await discussion.save();

  return res.json({ removed: true, tombstone: byStaff });
};
