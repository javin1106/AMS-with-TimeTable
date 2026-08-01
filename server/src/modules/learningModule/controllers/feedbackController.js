const LmFeedback = require("../models/lmFeedback");
const LmFeedbackStrike = require("../models/lmFeedbackStrike");
const LmMembership = require("../models/lmMembership");
const { findProfanity, profanityMessage } = require("../services/profanityFilter");
const { notifyClass, notifyUser } = require("../services/notifyService");

const MIN_LENGTH = 15;
const MAX_LENGTH = 2000;
const MAX_PER_DAY = 5;

/**
 * Warnings before the feedback channel closes for that account.
 *
 * Three, not one: the word list has false positives in it, and a student whose
 * honest complaint tripped on a surname deserves to find that out and rephrase
 * rather than lose the channel over it. Three refusals in a row is no longer a
 * misunderstanding.
 */
const STRIKE_LIMIT = 3;

const CATEGORIES = ["teaching", "pace", "content", "assessment", "communication", "other"];
const SENTIMENTS = ["praise", "suggestion", "concern"];

const isAdmin = (req) => Boolean(req.lmUser?.isAdmin);

/**
 * The teacher's view of a feedback row.
 *
 * Every field that could identify the author is dropped here, and this is the
 * only projection any staff-facing response goes through — so the promise the
 * student was made is kept in one function rather than in the discipline of
 * every handler that touches the collection.
 *
 * `created_at` is deliberately blunted to the date. A precise timestamp is a
 * de-anonymiser in a small class: a teacher who can see "17:42, four minutes
 * after I finished the lab" alongside a room of laptops has a name, and no
 * amount of hiding `studentId` prevents it. The day is all the teacher needs to
 * read feedback in context.
 *
 * `identify` is set only for a platform admin, and adds the author back.
 */
function forTeacher(doc, { identify = false } = {}) {
  const dayOf = (value) => {
    const date = new Date(value);
    date.setHours(0, 0, 0, 0);
    return date;
  };

  const view = {
    _id: doc._id,
    category: doc.category,
    sentiment: doc.sentiment,
    text: doc.text,
    status: doc.status,
    response: doc.response,
    respondedAt: doc.respondedAt,
    respondedByName: doc.respondedByName,
    withdrawn: Boolean(doc.deleted),
    created_at: identify ? doc.created_at : dayOf(doc.created_at),
  };

  if (identify) {
    view.student = {
      id: doc.studentId,
      name: doc.studentName,
      email: doc.studentEmail,
      rollNumber: doc.studentRollNumber,
    };
  }

  return view;
}

/** The author's own row — they wrote it, so they see all of it. */
const forAuthor = (doc) => ({
  _id: doc._id,
  category: doc.category,
  sentiment: doc.sentiment,
  text: doc.text,
  status: doc.status,
  response: doc.response,
  respondedAt: doc.respondedAt,
  respondedByName: doc.respondedByName,
  withdrawn: Boolean(doc.deleted),
  created_at: doc.created_at,
});

const countToday = async (studentId, classId) => {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return LmFeedback.countDocuments({ classId, studentId, created_at: { $gte: midnight } });
};

/** Standing of one account in the warning ladder. */
async function strikeState(userId) {
  const strikes = await LmFeedbackStrike.countDocuments({ studentId: userId });
  return {
    strikes,
    limit: STRIKE_LIMIT,
    remaining: Math.max(0, STRIKE_LIMIT - strikes),
    blocked: strikes >= STRIKE_LIMIT,
  };
}

exports.listFeedback = async (req, res) => {
  const admin = isAdmin(req);

  // A platform admin reaches every class as staff, so the student branch has to
  // be the *narrow* test — an active student enrolment — rather than "not a
  // teacher". Otherwise an admin with a stale membership row could land here.
  const isStudent = req.lmMembership?.status === "active" && req.lmMembership.role === "student";

  if (isStudent && !req.lmIsTeacher) {
    const mine = await LmFeedback.find({ classId: req.lmClass._id, studentId: req.lmUser.id })
      .sort({ created_at: -1 })
      .limit(100)
      .lean();

    return res.json({
      view: "student",
      items: mine.map(forAuthor),
      warnings: await strikeState(req.lmUser.id),
      categories: CATEGORIES,
      remainingToday: Math.max(0, MAX_PER_DAY - (await countToday(req.lmUser.id, req.lmClass._id))),
    });
  }

  if (!req.lmIsTeacher) return res.status(403).json({ message: "Forbidden" });

  const items = await LmFeedback.find({ classId: req.lmClass._id, deleted: false })
    .sort({ created_at: -1 })
    .limit(500)
    .lean();

  const counts = items.reduce(
    (acc, item) => {
      acc.total += 1;
      if (item.status === "new") acc.unread += 1;
      acc.byCategory[item.category] = (acc.byCategory[item.category] || 0) + 1;
      acc.bySentiment[item.sentiment] = (acc.bySentiment[item.sentiment] || 0) + 1;
      return acc;
    },
    { total: 0, unread: 0, byCategory: {}, bySentiment: {} },
  );

  const payload = {
    view: admin ? "admin" : "teacher",
    items: items.map((doc) => forTeacher(doc, { identify: admin })),
    counts,
    categories: CATEGORIES,
  };

  // The admin audit tab: the attempts that were refused, which by definition
  // never became feedback and are in no teacher's list.
  if (admin) {
    payload.strikes = await LmFeedbackStrike.find({ classId: req.lmClass._id })
      .sort({ created_at: -1 })
      .limit(200)
      .lean();
  }

  return res.json(payload);
};

exports.createFeedback = async (req, res) => {
  const text = String(req.body.text || "").trim();
  const category = CATEGORIES.includes(req.body.category) ? req.body.category : "other";
  const sentiment = SENTIMENTS.includes(req.body.sentiment) ? req.body.sentiment : "suggestion";

  const standing = await strikeState(req.lmUser.id);
  if (standing.blocked) {
    return res.status(403).json({
      code: "FEEDBACK_BLOCKED",
      warnings: standing,
      message: `Your account can no longer send anonymous feedback. It was blocked after ${STRIKE_LIMIT} warnings about abusive language, and the attempts have been recorded for the administrator. Speak to your department administrator if you believe this was a mistake.`,
    });
  }

  if (text.length < MIN_LENGTH) {
    return res.status(400).json({
      message: `Please write at least ${MIN_LENGTH} characters so your teacher can act on it.`,
    });
  }
  if (text.length > MAX_LENGTH) {
    return res.status(400).json({ message: `Feedback is limited to ${MAX_LENGTH} characters.` });
  }

  // Checked before anything is written, so refused text never reaches the
  // feedback collection at all — only the strike record, which is admin-only.
  const terms = findProfanity(text);
  if (terms.length) {
    const strikeNumber = standing.strikes + 1;
    await LmFeedbackStrike.create({
      studentId: req.lmUser.id,
      studentName: req.lmUser.name,
      studentEmail: req.lmUser.email,
      classId: req.lmClass._id,
      className: req.lmClass.name,
      text,
      terms,
      strikeNumber,
    });

    const remaining = Math.max(0, STRIKE_LIMIT - strikeNumber);
    const warning = remaining
      ? `This is warning ${strikeNumber} of ${STRIKE_LIMIT}. The attempt has been recorded against your account, with your name on it. ${
          remaining === 1
            ? "One more and your account will be blocked from sending feedback and referred to the administrator."
            : `${remaining} more and your account will be blocked from sending feedback and referred to the administrator.`
        }`
      : `That was warning ${STRIKE_LIMIT} of ${STRIKE_LIMIT}. Your account is now blocked from sending anonymous feedback and the attempts have been referred to the administrator.`;

    return res.status(400).json({
      code: "PROFANITY",
      terms,
      warnings: await strikeState(req.lmUser.id),
      message: `${profanityMessage(terms)}\n\n${warning}`,
    });
  }

  if ((await countToday(req.lmUser.id, req.lmClass._id)) >= MAX_PER_DAY) {
    return res.status(429).json({
      message: `You have sent ${MAX_PER_DAY} pieces of feedback for this class today. Please continue tomorrow.`,
    });
  }

  const membership = req.lmMembership;
  const feedback = await LmFeedback.create({
    classId: req.lmClass._id,
    studentId: req.lmUser.id,
    studentName: membership?.name || req.lmUser.name,
    studentEmail: membership?.email || req.lmUser.email,
    studentRollNumber: membership?.rollNumber || "",
    category,
    sentiment,
    text,
  });

  // Deliberately no `actorName`, and a title that names the class rather than
  // the sender. Every other notifyClass call in the module identifies its
  // actor; this is the one place that must not, and the omission is the whole
  // point of the feature.
  const staff = await LmMembership.find({
    classId: req.lmClass._id,
    status: "active",
    role: { $in: ["teacher", "co-teacher"] },
  })
    .select("userId")
    .lean();

  const recipients = [...new Set([String(req.lmClass.ownerId), ...staff.map((m) => String(m.userId))])].filter(
    Boolean,
  );

  await notifyClass({
    klass: req.lmClass,
    userIds: recipients,
    type: "feedback",
    title: `New anonymous feedback in ${req.lmClass.name}`,
    body: "A student has sent anonymous feedback. Open the Anonymous Feedback tab to read it.",
    link: `/learning/class/${req.lmClass._id}/feedback`,
  });

  return res.status(201).json(forAuthor(feedback));
};

/**
 * Staff mark a note read, or answer it for the class to see.
 *
 * There is no path here to edit or hide the text itself. Feedback a teacher can
 * quietly rewrite is not feedback, and the one thing this channel has to be
 * proof against is the person it is about.
 */
exports.updateFeedback = async (req, res) => {
  const feedback = await LmFeedback.findOne({
    _id: req.params.feedbackId,
    classId: req.lmClass._id,
  });
  if (!feedback) return res.status(404).json({ message: "Feedback not found." });

  if (["new", "read", "actioned"].includes(req.body.status)) {
    feedback.status = req.body.status;
    if (req.body.status !== "new" && !feedback.readAt) feedback.readAt = new Date();
  }

  if (typeof req.body.response === "string") {
    feedback.response = req.body.response.trim().slice(0, MAX_LENGTH);
    feedback.respondedAt = feedback.response ? new Date() : null;
    feedback.respondedByName = feedback.response ? req.lmUser.name : "";
    if (feedback.response && feedback.status === "new") feedback.status = "read";

    // The author is the one person who can be told, and telling them is what
    // keeps the box in use — a channel that never visibly produces anything
    // stops being written to.
    if (feedback.response) {
      await notifyUser({
        userId: feedback.studentId,
        klass: req.lmClass,
        type: "feedback",
        title: `Your feedback for ${req.lmClass.name} was answered`,
        body: feedback.response,
        link: `/learning/class/${req.lmClass._id}/feedback`,
        actorName: req.lmUser.name,
      });
    }
  }

  feedback.updated_at = new Date();
  await feedback.save();
  return res.json(forTeacher(feedback, { identify: isAdmin(req) }));
};

/**
 * Remove a note. **Platform admins only.**
 *
 * Nobody inside the class can delete from this collection — not the teacher a
 * complaint is about, and not the student who sent it.
 *
 * The author is excluded on purpose. A withdraw button reads as a kindness, but
 * it is a pressure point: it only has to exist for a teacher who has guessed who
 * wrote something to be able to ask for it to be taken down, and for the student
 * to have no answer except that they could. Feedback that cannot be retracted
 * cannot be retracted under pressure either, so the UI says so plainly before
 * the student sends — that is where the caution belongs, not afterwards.
 *
 * Which leaves the administrator as the only route for a note that genuinely
 * has to go, and a soft delete so the record survives the removal.
 */
exports.deleteFeedback = async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({
      message:
        "Anonymous feedback cannot be deleted from inside the class. Ask your institute administrator if something here needs to be removed.",
    });
  }

  const feedback = await LmFeedback.findOne({
    _id: req.params.feedbackId,
    classId: req.lmClass._id,
  });
  if (!feedback) return res.status(404).json({ message: "Feedback not found." });

  feedback.deleted = true;
  feedback.deletedAt = new Date();
  await feedback.save();
  return res.json({ deleted: true });
};
