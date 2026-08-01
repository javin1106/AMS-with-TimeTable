const LmClass = require("../models/lmClass");
const LmCoursework = require("../models/lmCoursework");
const LmSubmission = require("../models/lmSubmission");
const LmMembership = require("../models/lmMembership");
const LmQuiz = require("../models/lmQuiz");
const LmComment = require("../models/lmComment");
const { notifyClass } = require("../services/notifyService");

const WORK_TYPES = ["assignment", "quiz", "question", "material"];

const audienceFilter = (req) =>
  req.lmIsTeacher ? {} : { $or: [{ audience: { $size: 0 } }, { audience: req.lmUser.id }] };

/**
 * Creates the per-student submission rows for a published, graded item so the
 * gradebook has a complete grid from the moment the work goes out — the
 * alternative (creating rows on first view) leaves "not submitted" students
 * invisible to the teacher.
 */
async function seedSubmissions(coursework, klass) {
  if (coursework.workType === "material") return;

  const targeted = coursework.audience?.length ? coursework.audience.map(String) : null;
  const students = await LmMembership.find({
    classId: klass._id,
    role: "student",
    status: "active",
    ...(targeted ? { userId: { $in: targeted } } : {}),
  })
    .select("userId name email")
    .lean();

  if (!students.length) return;

  await LmSubmission.bulkWrite(
    students.map((student) => ({
      updateOne: {
        filter: { courseworkId: coursework._id, studentId: student.userId },
        update: {
          $setOnInsert: {
            courseworkId: coursework._id,
            classId: klass._id,
            studentId: student.userId,
            studentName: student.name,
            studentEmail: student.email,
            state: "assigned",
            maxPoints: coursework.points,
          },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );
}

// Exported so quizController can seed the same rows when it publishes a quiz
// through its own Classwork item.
exports.seedSubmissions = seedSubmissions;

exports.listCoursework = async (req, res) => {
  const filter = {
    classId: req.lmClass._id,
    ...audienceFilter(req),
    ...(req.lmIsTeacher ? {} : { status: "published" }),
  };
  if (req.query.workType && WORK_TYPES.includes(req.query.workType)) {
    filter.workType = req.query.workType;
  }
  if (req.query.topicId) filter.topicId = req.query.topicId;

  const items = await LmCoursework.find(filter).sort({ publishedAt: -1 }).lean();

  // Students get their own submission state stapled on; teachers get the
  // turned-in / graded counts they need for the "3 handed in" badges.
  if (!req.lmIsTeacher) {
    const submissions = await LmSubmission.find({
      classId: req.lmClass._id,
      studentId: req.lmUser.id,
      courseworkId: { $in: items.map((i) => i._id) },
    }).lean();
    const byWork = new Map(submissions.map((s) => [String(s.courseworkId), s]));
    return res.json(
      items.map((item) => ({ ...item, mySubmission: byWork.get(String(item._id)) || null })),
    );
  }

  const counts = await LmSubmission.aggregate([
    { $match: { courseworkId: { $in: items.map((i) => i._id) } } },
    {
      $group: {
        _id: "$courseworkId",
        total: { $sum: 1 },
        turnedIn: { $sum: { $cond: [{ $in: ["$state", ["turned_in", "returned"]] }, 1, 0] } },
        graded: { $sum: { $cond: [{ $ne: ["$grade", null] }, 1, 0] } },
      },
    },
  ]);
  const byWork = new Map(counts.map((c) => [String(c._id), c]));
  return res.json(
    items.map((item) => ({
      ...item,
      submissionStats: byWork.get(String(item._id)) || { total: 0, turnedIn: 0, graded: 0 },
    })),
  );
};

exports.createCoursework = async (req, res) => {
  const workType = WORK_TYPES.includes(req.body.workType) ? req.body.workType : "assignment";
  const title = String(req.body.title || "").trim();
  if (!title) return res.status(400).json({ message: "A title is required." });

  const topic = req.body.topicId ? req.lmClass.topics.id(req.body.topicId) : null;
  const scheduledFor = req.body.scheduledFor ? new Date(req.body.scheduledFor) : null;
  const isScheduled = Boolean(scheduledFor && scheduledFor > new Date());
  const status = req.body.draft ? "draft" : isScheduled ? "scheduled" : "published";

  const coursework = await LmCoursework.create({
    classId: req.lmClass._id,
    workType,
    title,
    instructions: req.body.instructions || "",
    attachments: Array.isArray(req.body.attachments) ? req.body.attachments : [],
    topicId: topic?._id || null,
    topicName: topic?.name || "",
    points: workType === "material" ? 0 : Number(req.body.points ?? req.lmClass.settings.defaultPoints),
    graded: workType === "material" ? false : req.body.graded !== false,
    dueDate: req.body.dueDate ? new Date(req.body.dueDate) : null,
    allowLateSubmission: req.body.allowLateSubmission !== false,
    status,
    scheduledFor: isScheduled ? scheduledFor : null,
    publishedAt: status === "published" ? new Date() : scheduledFor || new Date(),
    audience: Array.isArray(req.body.audience) ? req.body.audience : [],
    rubric: Array.isArray(req.body.rubric) ? req.body.rubric : [],
    questionConfig:
      workType === "question"
        ? {
            answerType: req.body.answerType === "mcq" ? "mcq" : "short",
            choices: Array.isArray(req.body.choices) ? req.body.choices : [],
            studentsCanReplyToEachOther: req.body.studentsCanReplyToEachOther !== false,
            studentsCanEditAnswer: Boolean(req.body.studentsCanEditAnswer),
          }
        : undefined,
    quizId: req.body.quizId || null,
    aiSourceSessionId: req.body.aiSourceSessionId || null,
    createdBy: req.lmUser.id,
    createdByName: req.lmUser.name,
  });

  if (status === "published") {
    await seedSubmissions(coursework, req.lmClass);
    await LmClass.updateOne({ _id: req.lmClass._id }, { $inc: { "stats.courseworkCount": 1 } });
    await notifyClass({
      klass: req.lmClass,
      userIds: coursework.audience.length ? coursework.audience : null,
      excludeUserId: req.lmUser.id,
      type: workType === "material" ? "material" : "coursework",
      title: `${req.lmClass.name}: ${title}`,
      body: coursework.dueDate
        ? `Due ${new Date(coursework.dueDate).toLocaleString("en-IN")}`
        : "No due date",
      link: `/learning/class/${req.lmClass._id}/work/${coursework._id}`,
      actorName: req.lmUser.name,
      email: true,
    });
  }

  return res.status(201).json(coursework);
};

exports.getCoursework = async (req, res) => {
  const coursework = await LmCoursework.findOne({
    _id: req.params.courseworkId,
    classId: req.lmClass._id,
  }).lean();
  if (!coursework) return res.status(404).json({ message: "Item not found." });
  if (!req.lmIsTeacher && coursework.status !== "published") {
    return res.status(404).json({ message: "Item not found." });
  }
  if (
    !req.lmIsTeacher &&
    coursework.audience?.length &&
    !coursework.audience.map(String).includes(req.lmUser.id)
  ) {
    return res.status(403).json({ message: "This item was not assigned to you." });
  }

  const quiz = coursework.quizId
    ? await LmQuiz.findById(coursework.quizId)
        .select(req.lmIsTeacher ? "" : "-questions.correctAnswers -questions.explanation")
        .lean()
    : null;

  if (req.lmIsTeacher) {
    const submissions = await LmSubmission.find({ courseworkId: coursework._id })
      .sort({ studentName: 1 })
      .lean();
    return res.json({ ...coursework, quiz, submissions });
  }

  let mySubmission = await LmSubmission.findOne({
    courseworkId: coursework._id,
    studentId: req.lmUser.id,
  }).lean();

  // A student who joined after the item was published has no seeded row yet.
  if (!mySubmission && coursework.workType !== "material") {
    mySubmission = (
      await LmSubmission.create({
        courseworkId: coursework._id,
        classId: req.lmClass._id,
        studentId: req.lmUser.id,
        studentName: req.lmUser.name,
        studentEmail: req.lmUser.email,
        maxPoints: coursework.points,
      })
    ).toObject();
  }

  return res.json({ ...coursework, quiz, mySubmission });
};

exports.updateCoursework = async (req, res) => {
  const coursework = await LmCoursework.findOne({
    _id: req.params.courseworkId,
    classId: req.lmClass._id,
  });
  if (!coursework) return res.status(404).json({ message: "Item not found." });

  const wasPublished = coursework.status === "published";
  const editable = ["title", "instructions", "attachments", "points", "graded", "allowLateSubmission", "rubric", "audience"];
  editable.forEach((field) => {
    if (req.body[field] !== undefined) coursework[field] = req.body[field];
  });

  if (req.body.dueDate !== undefined) {
    coursework.dueDate = req.body.dueDate ? new Date(req.body.dueDate) : null;
  }
  if (req.body.topicId !== undefined) {
    const topic = req.body.topicId ? req.lmClass.topics.id(req.body.topicId) : null;
    coursework.topicId = topic?._id || null;
    coursework.topicName = topic?.name || "";
  }
  if (req.body.publish === true && !wasPublished) {
    coursework.status = "published";
    coursework.publishedAt = new Date();
    coursework.scheduledFor = null;
  }

  coursework.updated_at = new Date();
  await coursework.save();

  if (coursework.status === "published") {
    await seedSubmissions(coursework, req.lmClass);
    // Keep already-seeded rows in step with a changed point value.
    await LmSubmission.updateMany(
      { courseworkId: coursework._id },
      { $set: { maxPoints: coursework.points } },
    );
  }

  // Publishing a draft is the moment the class gains the item, so it announces
  // exactly as `createCoursework` does when something is published outright.
  // Only this transition: an ordinary edit of a live item must not re-announce
  // it, which is what `wasPublished` guards.
  if (!wasPublished && coursework.status === "published") {
    await LmClass.updateOne({ _id: req.lmClass._id }, { $inc: { "stats.courseworkCount": 1 } });
    await notifyClass({
      klass: req.lmClass,
      userIds: coursework.audience.length ? coursework.audience : null,
      excludeUserId: req.lmUser.id,
      type: coursework.workType === "material" ? "material" : "coursework",
      title: `${req.lmClass.name}: ${coursework.title}`,
      body: coursework.dueDate
        ? `Due ${new Date(coursework.dueDate).toLocaleString("en-IN")}`
        : "No due date",
      link: `/learning/class/${req.lmClass._id}/work/${coursework._id}`,
      actorName: req.lmUser.name,
      email: true,
    });
  }

  return res.json(coursework);
};

exports.deleteCoursework = async (req, res) => {
  const coursework = await LmCoursework.findOne({
    _id: req.params.courseworkId,
    classId: req.lmClass._id,
  });
  if (!coursework) return res.status(404).json({ message: "Item not found." });

  await Promise.all([
    LmSubmission.deleteMany({ courseworkId: coursework._id }),
    LmComment.deleteMany({ targetType: "coursework", targetId: coursework._id }),
  ]);
  await LmCoursework.deleteOne({ _id: coursework._id });
  return res.json({ deleted: true });
};

/** Teacher's "Student work" screen for one item. */
exports.getSubmissionGrid = async (req, res) => {
  const coursework = await LmCoursework.findOne({
    _id: req.params.courseworkId,
    classId: req.lmClass._id,
  }).lean();
  if (!coursework) return res.status(404).json({ message: "Item not found." });

  const submissions = await LmSubmission.find({ courseworkId: coursework._id })
    .sort({ studentName: 1 })
    .lean();

  const graded = submissions.filter((s) => s.grade !== null && s.grade !== undefined);
  const average = graded.length
    ? Math.round((graded.reduce((sum, s) => sum + s.grade, 0) / graded.length) * 10) / 10
    : null;

  return res.json({
    coursework,
    submissions,
    summary: {
      total: submissions.length,
      turnedIn: submissions.filter((s) => s.state === "turned_in").length,
      returned: submissions.filter((s) => s.state === "returned").length,
      assigned: submissions.filter((s) => s.state === "assigned").length,
      late: submissions.filter((s) => s.late).length,
      graded: graded.length,
      average,
    },
  });
};
