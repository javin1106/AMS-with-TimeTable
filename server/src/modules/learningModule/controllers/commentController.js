const LmComment = require("../models/lmComment");
const LmAnnouncement = require("../models/lmAnnouncement");
const LmCoursework = require("../models/lmCoursework");
const LmSubmission = require("../models/lmSubmission");
const { notifyUser, notifyClass } = require("../services/notifyService");

const TARGET_MODELS = {
  announcement: LmAnnouncement,
  coursework: LmCoursework,
  submission: LmSubmission,
};

const canComment = (req) => {
  if (req.lmIsTeacher) return true;
  if (req.lmMembership?.muted) return false;
  return req.lmClass.settings.whoCanPost !== "teachers_only";
};

/**
 * Private comments live on a submission and are visible only to that student
 * and the teaching staff, so the reader has to be checked against the
 * submission's owner rather than just class membership.
 */
async function assertCanSeePrivateThread(req, targetType, targetId) {
  if (targetType !== "submission") return true;
  const submission = await LmSubmission.findById(targetId).select("studentId classId").lean();
  if (!submission || String(submission.classId) !== String(req.lmClass._id)) return false;
  return req.lmIsTeacher || String(submission.studentId) === req.lmUser.id;
}

exports.listComments = async (req, res) => {
  const { targetType, targetId } = req.params;
  if (!TARGET_MODELS[targetType] && targetType !== "audioSession") {
    return res.status(400).json({ message: "Unknown comment target." });
  }
  if (!(await assertCanSeePrivateThread(req, targetType, targetId))) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const filter = {
    classId: req.lmClass._id,
    targetType,
    targetId,
    deleted: false,
  };
  // Class comments are public within the class; private ones only surface on
  // the submission thread, which the check above has already authorised.
  if (targetType !== "submission") filter.visibility = "class";

  const comments = await LmComment.find(filter).sort({ created_at: 1 }).limit(500).lean();
  return res.json(comments);
};

exports.createComment = async (req, res) => {
  const { targetType, targetId } = req.params;
  const text = String(req.body.text || "").trim();
  if (!text) return res.status(400).json({ message: "Comment cannot be empty." });
  if (!TARGET_MODELS[targetType] && targetType !== "audioSession") {
    return res.status(400).json({ message: "Unknown comment target." });
  }

  const isPrivate = targetType === "submission";
  if (!isPrivate && !canComment(req)) {
    return res.status(403).json({ message: "Commenting is disabled for students in this class." });
  }
  if (!(await assertCanSeePrivateThread(req, targetType, targetId))) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const comment = await LmComment.create({
    classId: req.lmClass._id,
    targetType,
    targetId,
    parentId: req.body.parentId || null,
    authorId: req.lmUser.id,
    authorName: req.lmUser.name,
    authorRole: req.lmRole,
    text,
    visibility: isPrivate ? "private" : "class",
  });

  if (targetType === "announcement") {
    await LmAnnouncement.updateOne({ _id: targetId }, { $inc: { commentCount: 1 } });
  } else if (targetType === "coursework") {
    await LmCoursework.updateOne({ _id: targetId }, { $inc: { commentCount: 1 } });
  }

  // Private thread → tell the other side. Class comment → tell the author of
  // the thing being commented on, not the whole class.
  if (isPrivate) {
    const submission = await LmSubmission.findById(targetId).select("studentId").lean();
    const recipient = req.lmIsTeacher ? submission?.studentId : req.lmClass.ownerId;
    await notifyUser({
      userId: recipient,
      klass: req.lmClass,
      type: "comment",
      title: `Private comment in ${req.lmClass.name}`,
      body: text.slice(0, 200),
      link: `/learning/class/${req.lmClass._id}/work/${
        (await LmSubmission.findById(targetId).select("courseworkId").lean())?.courseworkId
      }`,
      actorName: req.lmUser.name,
    });
  } else {
    const Model = TARGET_MODELS[targetType];
    const target = Model
      ? await Model.findById(targetId).select("authorId createdBy").lean()
      : null;
    const ownerId = target?.authorId || target?.createdBy;
    if (ownerId && String(ownerId) !== req.lmUser.id) {
      await notifyClass({
        klass: req.lmClass,
        userIds: [ownerId],
        excludeUserId: req.lmUser.id,
        type: "comment",
        title: `New comment in ${req.lmClass.name}`,
        body: `${req.lmUser.name}: ${text.slice(0, 160)}`,
        link: `/learning/class/${req.lmClass._id}`,
        actorName: req.lmUser.name,
      });
    }
  }

  return res.status(201).json(comment);
};

exports.updateComment = async (req, res) => {
  const comment = await LmComment.findOne({ _id: req.params.commentId, classId: req.lmClass._id });
  if (!comment) return res.status(404).json({ message: "Comment not found." });
  if (String(comment.authorId) !== req.lmUser.id) {
    return res.status(403).json({ message: "You can only edit your own comment." });
  }
  comment.text = String(req.body.text || comment.text);
  comment.updated_at = new Date();
  await comment.save();
  return res.json(comment);
};

exports.deleteComment = async (req, res) => {
  const comment = await LmComment.findOne({ _id: req.params.commentId, classId: req.lmClass._id });
  if (!comment) return res.status(404).json({ message: "Comment not found." });
  // Teachers moderate; authors delete their own.
  if (String(comment.authorId) !== req.lmUser.id && !req.lmIsTeacher) {
    return res.status(403).json({ message: "Forbidden" });
  }
  comment.deleted = true;
  comment.deletedAt = new Date();
  await comment.save();
  return res.json({ deleted: true });
};
