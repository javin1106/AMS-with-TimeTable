const crypto = require("crypto");

const LmClass = require("../models/lmClass");
const LmMembership = require("../models/lmMembership");
const LmAnnouncement = require("../models/lmAnnouncement");
const LmCoursework = require("../models/lmCoursework");
const LmSubmission = require("../models/lmSubmission");
const LmComment = require("../models/lmComment");
const LmQuiz = require("../models/lmQuiz");
const LmQuizAttempt = require("../models/lmQuizAttempt");
const LmAudioSession = require("../models/lmAudioSession");

// Ambiguous glyphs (0/O, 1/I/l) are excluded — the code gets read off a
// projector and typed by 60 students.
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

async function generateUniqueCode() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = Array.from(crypto.randomBytes(7))
      .map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length])
      .join("");
    // eslint-disable-next-line no-await-in-loop
    const clash = await LmClass.exists({ code });
    if (!clash) return code;
  }
  throw new Error("Could not allocate a unique class code, please retry.");
}

const publicClass = (klass, role) => ({
  ...(klass.toObject ? klass.toObject() : klass),
  myRole: role || null,
});

exports.createClass = async (req, res) => {
  const {
    name,
    section,
    subject,
    subjectCode,
    room,
    description,
    coverColor,
    meetLink,
    academicYear,
    semester,
    batch,
    dept,
  } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ message: "Class name is required." });
  }

  const code = await generateUniqueCode();
  const klass = await LmClass.create({
    name: String(name).trim(),
    section: section || "",
    subject: subject || "",
    subjectCode: subjectCode || "",
    room: room || "",
    description: description || "",
    coverColor: coverColor || "#1967d2",
    meetLink: meetLink || "",
    academicYear: academicYear || "",
    semester: semester || "",
    batch: batch || "",
    // The branch picked in the create form wins — faculty routinely teach a
    // class outside their own department.
    dept: dept || req.lmUser.department || "",
    code,
    ownerId: req.lmUser.id,
    ownerName: req.lmUser.name,
    ownerEmail: req.lmUser.email,
  });

  await LmMembership.create({
    classId: klass._id,
    userId: req.lmUser.id,
    email: req.lmUser.email,
    name: req.lmUser.name,
    role: "teacher",
    status: "active",
  });

  return res.status(201).json(publicClass(klass, "teacher"));
};

/** Every class the caller teaches or is enrolled in, plus a light summary. */
exports.listMyClasses = async (req, res) => {
  const status = req.query.status === "archived" ? "archived" : "active";

  const memberships = await LmMembership.find({
    userId: req.lmUser.id,
    status: { $in: ["active", "pending"] },
  }).lean();

  const byClassId = new Map(memberships.map((m) => [String(m.classId), m]));
  const classes = await LmClass.find({
    _id: { $in: memberships.map((m) => m.classId) },
    status,
  })
    .sort({ updated_at: -1 })
    .lean();

  const enriched = classes.map((klass) => {
    const membership = byClassId.get(String(klass._id));
    return {
      ...klass,
      myRole: membership?.role || null,
      myStatus: membership?.status || null,
    };
  });

  return res.json(enriched);
};

/** Admin/reporting view — every class on the platform. */
exports.listAllClasses = async (req, res) => {
  if (!req.lmUser.isAdmin) return res.status(403).json({ message: "Forbidden" });
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.dept) filter.dept = req.query.dept;
  if (req.query.q) filter.name = { $regex: String(req.query.q), $options: "i" };
  const classes = await LmClass.find(filter).sort({ created_at: -1 }).limit(500).lean();
  return res.json(classes);
};

exports.getClass = async (req, res) => {
  const [studentCount, teacherCount, courseworkCount] = await Promise.all([
    LmMembership.countDocuments({ classId: req.lmClass._id, role: "student", status: "active" }),
    LmMembership.countDocuments({
      classId: req.lmClass._id,
      role: { $in: ["teacher", "co-teacher"] },
      status: "active",
    }),
    LmCoursework.countDocuments({ classId: req.lmClass._id, status: "published" }),
  ]);

  return res.json({
    ...publicClass(req.lmClass, req.lmRole),
    isTeacher: req.lmIsTeacher,
    isOwner: String(req.lmClass.ownerId) === req.lmUser.id,
    counts: { studentCount, teacherCount, courseworkCount },
  });
};

exports.updateClass = async (req, res) => {
  const editable = [
    "name",
    "section",
    "subject",
    "subjectCode",
    "room",
    "description",
    "coverColor",
    "coverImage",
    "meetLink",
    "academicYear",
    "semester",
    "batch",
  ];
  editable.forEach((field) => {
    if (req.body[field] !== undefined) req.lmClass[field] = req.body[field];
  });

  if (req.body.settings && typeof req.body.settings === "object") {
    Object.entries(req.body.settings).forEach(([key, value]) => {
      if (req.lmClass.settings[key] !== undefined) req.lmClass.settings[key] = value;
    });
  }

  req.lmClass.updated_at = new Date();
  await req.lmClass.save();
  return res.json(publicClass(req.lmClass, req.lmRole));
};

exports.regenerateCode = async (req, res) => {
  req.lmClass.code = await generateUniqueCode();
  req.lmClass.updated_at = new Date();
  await req.lmClass.save();
  return res.json({ code: req.lmClass.code });
};

exports.archiveClass = async (req, res) => {
  const archive = req.body.archive !== false;
  req.lmClass.status = archive ? "archived" : "active";
  req.lmClass.archivedAt = archive ? new Date() : null;
  await req.lmClass.save();
  return res.json({ status: req.lmClass.status });
};

/** Hard delete — only the owner, and it takes every child document with it. */
exports.deleteClass = async (req, res) => {
  const classId = req.lmClass._id;
  await Promise.all([
    LmMembership.deleteMany({ classId }),
    LmAnnouncement.deleteMany({ classId }),
    LmCoursework.deleteMany({ classId }),
    LmSubmission.deleteMany({ classId }),
    LmComment.deleteMany({ classId }),
    LmQuiz.deleteMany({ classId }),
    LmQuizAttempt.deleteMany({ classId }),
    LmAudioSession.deleteMany({ classId }),
  ]);
  await LmClass.deleteOne({ _id: classId });
  return res.json({ deleted: true });
};

/* ─────────────────────────────── topics ──────────────────────────────── */

exports.listTopics = async (req, res) =>
  res.json([...req.lmClass.topics].sort((a, b) => a.order - b.order));

exports.createTopic = async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ message: "Topic name is required." });
  if (req.lmClass.topics.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ message: "That topic already exists." });
  }
  req.lmClass.topics.push({ name, order: req.lmClass.topics.length });
  await req.lmClass.save();
  return res.status(201).json(req.lmClass.topics[req.lmClass.topics.length - 1]);
};

exports.updateTopic = async (req, res) => {
  const topic = req.lmClass.topics.id(req.params.topicId);
  if (!topic) return res.status(404).json({ message: "Topic not found." });
  if (req.body.name !== undefined) topic.name = String(req.body.name).trim();
  if (req.body.order !== undefined) topic.order = Number(req.body.order) || 0;
  await req.lmClass.save();

  // Keep the denormalised topicName on classwork in step with the rename.
  await LmCoursework.updateMany({ topicId: topic._id }, { $set: { topicName: topic.name } });
  return res.json(topic);
};

exports.deleteTopic = async (req, res) => {
  const topic = req.lmClass.topics.id(req.params.topicId);
  if (!topic) return res.status(404).json({ message: "Topic not found." });
  topic.deleteOne();
  await req.lmClass.save();
  // Items keep existing; they just fall back into the untopiced bucket.
  await LmCoursework.updateMany(
    { classId: req.lmClass._id, topicId: req.params.topicId },
    { $set: { topicId: null, topicName: "" } },
  );
  return res.json({ deleted: true });
};
