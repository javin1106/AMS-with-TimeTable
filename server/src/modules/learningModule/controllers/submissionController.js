const LmCoursework = require("../models/lmCoursework");
const LmSubmission = require("../models/lmSubmission");
const LmMembership = require("../models/lmMembership");
const { notifyUser } = require("../services/notifyService");
const game = require("../services/gamification");

async function loadOwnSubmission(req) {
  const coursework = await LmCoursework.findOne({
    _id: req.params.courseworkId,
    classId: req.lmClass._id,
    status: "published",
  });
  if (!coursework) return { error: { status: 404, message: "Item not found." } };

  let submission = await LmSubmission.findOne({
    courseworkId: coursework._id,
    studentId: req.lmUser.id,
  });
  if (!submission) {
    submission = await LmSubmission.create({
      courseworkId: coursework._id,
      classId: req.lmClass._id,
      studentId: req.lmUser.id,
      studentName: req.lmUser.name,
      studentEmail: req.lmUser.email,
      maxPoints: coursework.points,
    });
  }
  return { coursework, submission };
}

/** Saves draft work without handing it in. */
exports.saveDraft = async (req, res) => {
  const { coursework, submission, error } = await loadOwnSubmission(req);
  if (error) return res.status(error.status).json({ message: error.message });
  if (submission.state === "returned") {
    return res.status(400).json({ message: "This work has been returned — unsubmit to edit it." });
  }

  if (req.body.attachments !== undefined) submission.attachments = req.body.attachments;
  if (req.body.textAnswer !== undefined) submission.textAnswer = String(req.body.textAnswer);
  if (req.body.choiceAnswer !== undefined) submission.choiceAnswer = String(req.body.choiceAnswer);
  submission.maxPoints = coursework.points;
  submission.updated_at = new Date();
  await submission.save();
  return res.json(submission);
};

exports.turnIn = async (req, res) => {
  const { coursework, submission, error } = await loadOwnSubmission(req);
  if (error) return res.status(error.status).json({ message: error.message });

  if (req.body.attachments !== undefined) submission.attachments = req.body.attachments;
  if (req.body.textAnswer !== undefined) submission.textAnswer = String(req.body.textAnswer);
  if (req.body.choiceAnswer !== undefined) submission.choiceAnswer = String(req.body.choiceAnswer);

  const hasWork =
    submission.attachments.length || submission.textAnswer.trim() || submission.choiceAnswer.trim();
  if (!hasWork) {
    return res.status(400).json({ message: "Attach a file or write an answer before turning in." });
  }

  const now = new Date();
  const isLate = Boolean(coursework.dueDate && now > coursework.dueDate);
  if (isLate && !coursework.allowLateSubmission) {
    return res.status(400).json({ message: "The due date has passed and late work is not accepted." });
  }

  submission.state = "turned_in";
  submission.turnedInAt = now;
  submission.late = isLate;
  submission.maxPoints = coursework.points;
  submission.history.push({ action: "turned_in", actorName: req.lmUser.name, at: now });
  await submission.save();

  // Rides on a save that has already succeeded, and swallows its own failures:
  // nobody should be unable to turn work in because the leaderboard was busy.
  await game.onSubmission({ req, coursework, late: isLate, at: now });

  await notifyUser({
    userId: coursework.createdBy,
    klass: req.lmClass,
    type: "submission",
    title: `${req.lmUser.name} turned in ${coursework.title}`,
    body: isLate ? "Submitted late." : "Submitted on time.",
    link: `/learning/class/${req.lmClass._id}/work/${coursework._id}/grade`,
    actorName: req.lmUser.name,
  });

  return res.json(submission);
};

exports.unsubmit = async (req, res) => {
  const { coursework, submission, error } = await loadOwnSubmission(req);
  if (error) return res.status(error.status).json({ message: error.message });
  if (submission.state === "assigned") {
    return res.status(400).json({ message: "Nothing has been turned in." });
  }
  if (submission.state === "returned" && submission.grade !== null) {
    return res.status(400).json({ message: "Graded work cannot be unsubmitted." });
  }

  submission.state = "assigned";
  submission.turnedInAt = null;
  submission.late = false;
  submission.history.push({ action: "unsubmitted", actorName: req.lmUser.name, at: new Date() });
  await submission.save();
  return res.json(submission);
};

/** Teacher grading a single submission. */
exports.gradeSubmission = async (req, res) => {
  const submission = await LmSubmission.findOne({
    _id: req.params.submissionId,
    classId: req.lmClass._id,
  });
  if (!submission) return res.status(404).json({ message: "Submission not found." });

  if (req.body.grade !== undefined && req.body.grade !== null) {
    const grade = Number(req.body.grade);
    if (Number.isNaN(grade) || grade < 0) {
      return res.status(400).json({ message: "Grade must be a non-negative number." });
    }
    if (grade > submission.maxPoints) {
      return res.status(400).json({
        message: `Grade cannot exceed the maximum of ${submission.maxPoints} points.`,
      });
    }
    submission.grade = grade;
  }

  if (req.body.feedback !== undefined) submission.feedback = String(req.body.feedback);
  if (Array.isArray(req.body.rubricScores)) submission.rubricScores = req.body.rubricScores;

  submission.gradedBy = req.lmUser.id;
  submission.gradedByName = req.lmUser.name;
  submission.gradedAt = new Date();
  submission.history.push({
    action: "graded",
    actorName: req.lmUser.name,
    grade: submission.grade,
    at: new Date(),
  });
  await submission.save();
  return res.json(submission);
};

/** Returns graded work to the student(s), which is what makes the grade visible. */
exports.returnSubmissions = async (req, res) => {
  const ids = Array.isArray(req.body.submissionIds) ? req.body.submissionIds : [];
  if (!ids.length) return res.status(400).json({ message: "Select at least one submission." });

  const submissions = await LmSubmission.find({
    _id: { $in: ids },
    classId: req.lmClass._id,
  }).populate("courseworkId", "title");

  const now = new Date();
  for (const submission of submissions) {
    submission.state = "returned";
    submission.returnedAt = now;
    submission.history.push({
      action: "returned",
      actorName: req.lmUser.name,
      grade: submission.grade,
      at: now,
    });
    // eslint-disable-next-line no-await-in-loop
    await submission.save();
    // eslint-disable-next-line no-await-in-loop
    await notifyUser({
      userId: submission.studentId,
      klass: req.lmClass,
      type: "grade",
      title: `Work returned: ${submission.courseworkId?.title || "Assignment"}`,
      body:
        submission.grade !== null && submission.grade !== undefined
          ? `You scored ${submission.grade}/${submission.maxPoints}.`
          : "Your teacher returned your work.",
      link: `/learning/class/${req.lmClass._id}/work/${submission.courseworkId?._id || ""}`,
      actorName: req.lmUser.name,
    });
  }

  return res.json({ returned: submissions.length });
};

/** Pulls a returned submission back so it can be regraded. */
exports.reclaimSubmission = async (req, res) => {
  const submission = await LmSubmission.findOne({
    _id: req.params.submissionId,
    classId: req.lmClass._id,
  });
  if (!submission) return res.status(404).json({ message: "Submission not found." });
  submission.state = "reclaimed";
  submission.returnedAt = null;
  submission.history.push({ action: "reclaimed", actorName: req.lmUser.name, at: new Date() });
  await submission.save();
  return res.json(submission);
};

/**
 * Builds the gradebook matrix. Shared by the JSON endpoint and the CSV export
 * so both always agree on visibility rules.
 * Returns `{ error }` instead of throwing when the caller may not see grades.
 */
async function buildGradebook(req) {
  const coursework = await LmCoursework.find({
    classId: req.lmClass._id,
    status: "published",
    graded: true,
    workType: { $ne: "material" },
  })
    .select("title points dueDate workType")
    .sort({ dueDate: 1, publishedAt: 1 })
    .lean();

  // Students only ever see their own row, and only if the class allows it.
  const studentFilter = req.lmIsTeacher ? {} : { userId: req.lmUser.id };
  if (!req.lmIsTeacher && !req.lmClass.settings.showGradesToStudents) {
    return { error: { status: 403, message: "Grades are hidden for this class." } };
  }

  const students = await LmMembership.find({
    classId: req.lmClass._id,
    role: "student",
    status: "active",
    ...studentFilter,
  })
    .select("userId name email rollNumber")
    .sort({ name: 1 })
    .lean();

  const submissions = await LmSubmission.find({
    classId: req.lmClass._id,
    courseworkId: { $in: coursework.map((c) => c._id) },
    ...(req.lmIsTeacher ? {} : { studentId: req.lmUser.id }),
  })
    .select("_id courseworkId studentId grade state late maxPoints")
    .lean();

  const key = (studentId, courseworkId) => `${studentId}:${courseworkId}`;
  const byKey = new Map(submissions.map((s) => [key(s.studentId, s.courseworkId), s]));

  const rows = students.map((student) => {
    const cells = coursework.map((item) => {
      const submission = byKey.get(key(student.userId, item._id));
      // A grade only counts once it has actually been returned to the student.
      const visible = req.lmIsTeacher || submission?.state === "returned";
      return {
        courseworkId: item._id,
        // Only teachers get the submission id — it is the handle the inline
        // gradebook editor posts back to /gradebook/bulk.
        submissionId: req.lmIsTeacher ? submission?._id || null : undefined,
        grade: visible ? submission?.grade ?? null : null,
        state: submission?.state || "assigned",
        late: Boolean(submission?.late),
        maxPoints: item.points,
      };
    });

    const scored = cells.filter((c) => c.grade !== null && c.grade !== undefined);
    const earned = scored.reduce((sum, c) => sum + c.grade, 0);
    const possible = scored.reduce((sum, c) => sum + (c.maxPoints || 0), 0);

    return {
      student,
      cells,
      total: { earned, possible, percent: possible ? Math.round((earned / possible) * 1000) / 10 : null },
    };
  });

  const classAverages = coursework.map((item, index) => {
    const values = rows.map((r) => r.cells[index].grade).filter((g) => g !== null && g !== undefined);
    return {
      courseworkId: item._id,
      average: values.length
        ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10
        : null,
      gradedCount: values.length,
    };
  });

  return { coursework, rows, classAverages };
}

exports.getGradebook = async (req, res) => {
  const result = await buildGradebook(req);
  if (result.error) return res.status(result.error.status).json({ message: result.error.message });
  return res.json(result);
};

/** CSV export of the gradebook for offline record-keeping. */
exports.exportGradebookCsv = async (req, res) => {
  const result = await buildGradebook(req);
  if (result.error) return res.status(result.error.status).json({ message: result.error.message });

  const { coursework, rows } = result;
  const escape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const header = ["Roll No", "Student", "Email", ...coursework.map((c) => `${c.title} (/${c.points})`), "Total", "Percent"];
  const lines = [header.map(escape).join(",")];

  rows.forEach((row) => {
    lines.push(
      [
        row.student.rollNumber,
        row.student.name,
        Array.isArray(row.student.email) ? row.student.email[0] : row.student.email,
        ...row.cells.map((c) => (c.grade === null || c.grade === undefined ? "" : c.grade)),
        `${row.total.earned}/${row.total.possible}`,
        row.total.percent === null ? "" : `${row.total.percent}%`,
      ]
        .map(escape)
        .join(","),
    );
  });

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${req.lmClass.name.replace(/[^a-z0-9]+/gi, "_")}_grades.csv"`,
  );
  return res.send(lines.join("\n"));
};

/** Bulk grade entry straight from the gradebook grid. */
exports.bulkGrade = async (req, res) => {
  const entries = Array.isArray(req.body.grades) ? req.body.grades : [];
  if (!entries.length) return res.status(400).json({ message: "No grades supplied." });

  let updated = 0;
  for (const entry of entries) {
    if (!entry.submissionId) continue;
    // eslint-disable-next-line no-await-in-loop
    const submission = await LmSubmission.findOne({
      _id: entry.submissionId,
      classId: req.lmClass._id,
    });
    if (!submission) continue;

    const grade = entry.grade === null || entry.grade === "" ? null : Number(entry.grade);
    if (grade !== null && (Number.isNaN(grade) || grade < 0 || grade > submission.maxPoints)) continue;

    submission.grade = grade;
    submission.gradedBy = req.lmUser.id;
    submission.gradedByName = req.lmUser.name;
    submission.gradedAt = new Date();
    submission.history.push({ action: "graded", actorName: req.lmUser.name, grade, at: new Date() });
    // eslint-disable-next-line no-await-in-loop
    await submission.save();
    updated += 1;
  }

  return res.json({ updated });
};
