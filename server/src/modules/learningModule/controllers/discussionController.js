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
  title: discussion.removed ? "Removed" : discussion.title,
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
    // Removed threads stay in the list as a tombstone, whoever removed them —
    // a post that just quietly vanishes is worse than one flagged as gone,
    // and it is the only way faculty can tell a withdrawn thread from one that
    // was never posted.
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

  // Not awaited — starting a discussion should not wait on SMTP.
  notifyClass({
    klass: req.lmClass,
    excludeUserId: req.lmUser.id,
    type: "discussion",
    title: `New discussion in ${req.lmClass.name}: ${title}`,
    body,
    link: `/learning/class/${req.lmClass._id}/discussions/${discussion._id}`,
    actorName: req.lmUser.name,
    // Mailed like any other post. This was in-app only, on the reasoning that a
    // thread nobody is graded on does not merit an email — but a discussion is
    // still something posted to the class, and students who do not open the
    // stream daily never learned it existed. The volume this was guarding
    // against is bounded by the weekly per-student limit enforced above, and a
    // class that finds it too much can turn class mail off in its settings.
    email: true,
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
 * Either way the row survives as a flag rather than being deleted, and the
 * week is *not* given back: deleting the row would delete the rate-limit entry
 * with it, and post → delete → post is not a limit. It also leaves a visible
 * tombstone regardless of who removed it — a thread that just vanished would
 * leave the class, and faculty checking a point award against it, looking at
 * a gap with no explanation.
 *
 * Any points the discussion earned when it was posted are undone alongside
 * it, so a removed thread never leaves an unexplained line on the leaderboard.
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

  await game.onDiscussionRemoved({ discussion });

  return res.json({ removed: true, tombstone: true });
};
