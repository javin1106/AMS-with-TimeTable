const LmNotebook = require('../models/lmNotebook');
const LmNotebookAttempt = require('../models/lmNotebookAttempt');
const LmMembership = require('../models/lmMembership');
const LmCoursework = require('../models/lmCoursework');
const LmSubmission = require('../models/lmSubmission');
const { seedSubmissions } = require('./courseworkController');
const nb = require('../services/notebookService');
const { notifyClass } = require('../services/notifyService');
const game = require('../services/gamification');

/* ─────────────────────────────── authoring ────────────────────────────── */

exports.listNotebooks = async (req, res) => {
  const query = { classId: req.lmClass._id };
  // A student has no business seeing a half-written worksheet.
  if (!req.lmIsTeacher) query.published = true;

  const notebooks = await LmNotebook.find(query).sort({ created_at: -1 }).lean();

  const attempts = req.lmIsTeacher
    ? await LmNotebookAttempt.find({ classId: req.lmClass._id })
        .select('notebookId studentId submittedAt gradedAt')
        .lean()
    : await LmNotebookAttempt.find({ classId: req.lmClass._id, studentId: req.lmUser.id })
        .select('notebookId submittedAt gradedAt lastSavedAt')
        .lean();

  const byNotebook = new Map();
  attempts.forEach((attempt) => {
    const key = String(attempt.notebookId);
    if (!byNotebook.has(key)) byNotebook.set(key, []);
    byNotebook.get(key).push(attempt);
  });

  return res.json(
    notebooks.map((notebook) => {
      const mine = byNotebook.get(String(notebook._id)) || [];
      return {
        _id: notebook._id,
        title: notebook.title,
        description: notebook.description,
        published: notebook.published,
        dueDate: notebook.dueDate,
        packages: notebook.packages,
        cellCount: (notebook.cells || []).length,
        codeCellCount: (notebook.cells || []).filter((cell) => cell.type === 'code' && !cell.hidden).length,
        createdByName: notebook.createdByName,
        created_at: notebook.created_at,
        ...(req.lmIsTeacher
          ? {
              startedCount: mine.length,
              submittedCount: mine.filter((attempt) => attempt.submittedAt).length,
              gradedCount: mine.filter((attempt) => attempt.gradedAt).length,
            }
          : {
              myStatus: mine[0]?.submittedAt ? 'submitted' : mine[0]?.lastSavedAt ? 'in-progress' : 'not-started',
              myGraded: Boolean(mine[0]?.gradedAt),
            }),
      };
    }),
  );
};

exports.createNotebook = async (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ message: 'Give the notebook a title.' });

  const notebook = new LmNotebook({
    classId: req.lmClass._id,
    title,
    description: req.body.description || '',
    cells: nb.prepareCells(req.body.cells),
    packages: nb.preparePackages(req.body.packages),
    createdBy: req.lmUser.id,
    createdByName: req.lmUser.name,
  });
  if (req.body.settings) Object.assign(notebook.settings, req.body.settings);
  await notebook.save();
  return res.status(201).json(notebook);
};

/** The authored notebook. Teachers only — students get their attempt instead. */
exports.getNotebook = async (req, res) => {
  const notebook = await LmNotebook.findOne({
    _id: req.params.notebookId,
    classId: req.lmClass._id,
  }).lean();
  if (!notebook) return res.status(404).json({ message: 'Notebook not found.' });
  return res.json(notebook);
};

exports.updateNotebook = async (req, res) => {
  const notebook = await LmNotebook.findOne({
    _id: req.params.notebookId,
    classId: req.lmClass._id,
  });
  if (!notebook) return res.status(404).json({ message: 'Notebook not found.' });

  if (req.body.title !== undefined) notebook.title = String(req.body.title).trim();
  if (req.body.description !== undefined) notebook.description = String(req.body.description);
  if (req.body.packages !== undefined) notebook.packages = nb.preparePackages(req.body.packages);
  if (req.body.cells !== undefined) {
    const cells = nb.prepareCells(req.body.cells);
    const errors = nb.validateCells(cells);
    if (errors.length) return res.status(400).json({ message: errors[0], errors });
    notebook.cells = cells;
  }
  if (req.body.settings) Object.assign(notebook.settings, req.body.settings);
  if (req.body.dueDate !== undefined) {
    notebook.dueDate = req.body.dueDate ? new Date(req.body.dueDate) : null;
  }

  notebook.updated_at = new Date();
  await notebook.save();

  // The Classwork row is what the calendar and the gradebook read, so a
  // deadline moved from here has to reach it. Publishing is not the only way a
  // date changes — a teacher extending a deadline just saves.
  if (notebook.courseworkId) {
    await LmCoursework.updateOne(
      { _id: notebook.courseworkId },
      { $set: { dueDate: notebook.dueDate, title: notebook.title, notebookId: notebook._id } },
    );
  }

  return res.json(notebook);
};

exports.deleteNotebook = async (req, res) => {
  const notebook = await LmNotebook.findOne({
    _id: req.params.notebookId,
    classId: req.lmClass._id,
  });
  if (!notebook) return res.status(404).json({ message: 'Notebook not found.' });

  await LmNotebookAttempt.deleteMany({ notebookId: notebook._id });
  if (notebook.courseworkId) {
    await LmSubmission.deleteMany({ courseworkId: notebook.courseworkId });
    await LmCoursework.deleteOne({ _id: notebook.courseworkId });
  }
  await LmNotebook.deleteOne({ _id: notebook._id });
  return res.json({ deleted: true });
};

exports.publishNotebook = async (req, res) => {
  const notebook = await LmNotebook.findOne({
    _id: req.params.notebookId,
    classId: req.lmClass._id,
  });
  if (!notebook) return res.status(404).json({ message: 'Notebook not found.' });

  const publish = req.body.publish !== false;

  if (!publish) {
    notebook.published = false;
    if (notebook.courseworkId) {
      await LmCoursework.updateOne({ _id: notebook.courseworkId }, { $set: { status: 'draft' } });
    }
    await notebook.save();
    return res.json({ published: false });
  }

  const errors = nb.validateCells(notebook.cells || []);
  if (errors.length) {
    return res.status(400).json({ message: 'Fix these before publishing.', errors });
  }

  notebook.published = true;
  notebook.publishedAt = notebook.publishedAt || new Date();
  // Announce once. Publishing again after editing a cell is the same notebook,
  // and re-notifying the class for it is how a working mailer becomes noise.
  const announce = !notebook.announcedAt;
  if (announce) notebook.announcedAt = new Date();
  if (req.body.dueDate !== undefined) {
    notebook.dueDate = req.body.dueDate ? new Date(req.body.dueDate) : null;
  }

  let coursework = notebook.courseworkId ? await LmCoursework.findById(notebook.courseworkId) : null;
  if (coursework) {
    coursework.title = notebook.title;
    coursework.instructions = notebook.description;
    coursework.dueDate = notebook.dueDate;
    coursework.status = 'published';
    // Backfills rows written before notebooks were linked, so an existing
    // exercise starts pointing at itself on the next publish.
    coursework.notebookId = notebook._id;
    await coursework.save();
  } else {
    coursework = await LmCoursework.create({
      classId: req.lmClass._id,
      workType: 'assignment',
      title: notebook.title,
      instructions: notebook.description,
      dueDate: notebook.dueDate,
      notebookId: notebook._id,
      createdBy: req.lmUser.id,
      createdByName: req.lmUser.name,
    });
    notebook.courseworkId = coursework._id;
  }

  await notebook.save();
  await seedSubmissions(coursework, req.lmClass);

  if (announce) {
    const codeCells = (notebook.cells || []).filter((cell) => cell.type === 'code' && !cell.hidden).length;
    await notifyClass({
      klass: req.lmClass,
      excludeUserId: req.lmUser.id,
      type: 'coursework',
      title: `New coding notebook in ${req.lmClass.name}: ${notebook.title}`,
      body: `${codeCells} code ${codeCells === 1 ? 'cell' : 'cells'} · runs in your browser, nothing to install`,
      link: `/learning/class/${req.lmClass._id}/notebook/${notebook._id}`,
      actorName: req.lmUser.name,
      email: true,
    });
  }

  return res.json({ published: true, courseworkId: coursework._id });
};

/* ──────────────────────────── working on one ──────────────────────────── */

/**
 * The student's own copy, created on first open.
 *
 * `hiddenSetup` rides along separately from the cells: it is code the kernel
 * runs before anything else but the student never sees in the document. It has
 * to reach the browser to run at all, so this is concealment for tidiness, not
 * secrecy — anything genuinely secret has no business in a notebook that
 * executes client-side.
 */
exports.getMyAttempt = async (req, res) => {
  const notebook = await LmNotebook.findOne({
    _id: req.params.notebookId,
    classId: req.lmClass._id,
  });
  if (!notebook) return res.status(404).json({ message: 'Notebook not found.' });
  if (!notebook.published && !req.lmIsTeacher) {
    return res.status(403).json({ message: 'This notebook has not been published yet.' });
  }

  let attempt = await LmNotebookAttempt.findOne({
    notebookId: notebook._id,
    studentId: req.lmUser.id,
  });

  if (!attempt) {
    const membership = await LmMembership.findOne({
      classId: req.lmClass._id,
      userId: req.lmUser.id,
      status: 'active',
    }).lean();

    attempt = await LmNotebookAttempt.create({
      notebookId: notebook._id,
      classId: req.lmClass._id,
      studentId: req.lmUser.id,
      studentName: req.lmUser.name,
      studentEmail: req.lmUser.email,
      rollNumber: membership?.rollNumber || '',
      cells: nb.seedAttemptCells(notebook),
    });
  }

  return res.json({
    notebook: {
      _id: notebook._id,
      title: notebook.title,
      description: notebook.description,
      packages: notebook.packages,
      settings: notebook.settings,
      dueDate: notebook.dueDate,
      published: notebook.published,
    },
    hiddenSetup: nb.hiddenSetup(notebook),
    attempt,
    // Only after they have committed to an answer, and only if the teacher
    // turned it on.
    solution:
      notebook.settings?.showSolutionAfterSubmit && attempt.submittedAt
        ? (notebook.cells || []).filter((cell) => !cell.hidden).map((cell) => ({
            _id: cell._id,
            type: cell.type,
            source: cell.source,
          }))
        : null,
  });
};

exports.saveAttempt = async (req, res) => {
  const attempt = await LmNotebookAttempt.findOne({
    _id: req.params.attemptId,
    classId: req.lmClass._id,
  });
  if (!attempt) return res.status(404).json({ message: 'Notebook not found.' });
  if (String(attempt.studentId) !== req.lmUser.id) {
    return res.status(403).json({ message: 'This is not your notebook.' });
  }
  if (attempt.submittedAt) {
    return res.status(400).json({ message: 'You have already submitted this notebook.' });
  }

  // A stale save is the two-tabs case: refuse rather than let the older tab
  // silently overwrite work done in the newer one.
  const clientRevision = Number(req.body.revision);
  if (Number.isFinite(clientRevision) && clientRevision < attempt.revision) {
    return res.status(409).json({
      message: 'This notebook was changed in another tab. Reload to get the newer copy.',
      code: 'STALE_REVISION',
      revision: attempt.revision,
    });
  }

  const notebook = await LmNotebook.findById(attempt.notebookId).lean();
  attempt.cells = nb.applyStudentCells(attempt.cells, req.body.cells, {
    allowAddCells: notebook?.settings?.allowAddCells !== false,
  });
  attempt.revision += 1;
  attempt.lastSavedAt = new Date();
  attempt.updated_at = new Date();
  await attempt.save();

  return res.json({ saved: true, revision: attempt.revision, cells: attempt.cells });
};

exports.submitAttempt = async (req, res) => {
  const attempt = await LmNotebookAttempt.findOne({
    _id: req.params.attemptId,
    classId: req.lmClass._id,
  });
  if (!attempt) return res.status(404).json({ message: 'Notebook not found.' });
  if (String(attempt.studentId) !== req.lmUser.id) {
    return res.status(403).json({ message: 'This is not your notebook.' });
  }
  if (attempt.submittedAt) return res.status(400).json({ message: 'Already submitted.' });

  const notebook = await LmNotebook.findById(attempt.notebookId);
  if (!notebook) return res.status(404).json({ message: 'Notebook not found.' });

  if (Array.isArray(req.body.cells)) {
    attempt.cells = nb.applyStudentCells(attempt.cells, req.body.cells, {
      allowAddCells: notebook.settings?.allowAddCells !== false,
    });
  }
  attempt.submittedAt = new Date();
  attempt.summary = nb.summariseAttempt(attempt.cells);
  attempt.revision += 1;
  attempt.updated_at = new Date();
  await attempt.save();

  await game.onNotebookSubmitted({
    req,
    notebook,
    late: Boolean(notebook.dueDate && attempt.submittedAt > new Date(notebook.dueDate)),
    completed: attempt.summary.completed,
    at: attempt.submittedAt,
  });

  // Mirror into the gradebook as turned-in but *ungraded*. There is no auto
  // mark: the outputs came from the student's own browser, so the only honest
  // basis for a grade is a human reading the code.
  if (notebook.courseworkId) {
    await LmSubmission.findOneAndUpdate(
      { courseworkId: notebook.courseworkId, studentId: req.lmUser.id },
      {
        $set: {
          classId: req.lmClass._id,
          studentName: req.lmUser.name,
          studentEmail: req.lmUser.email,
          state: notebook.dueDate && new Date() > new Date(notebook.dueDate) ? 'late' : 'turned-in',
          turnedInAt: attempt.submittedAt,
        },
      },
      { upsert: true },
    );
  }

  return res.json({ submitted: true, submittedAt: attempt.submittedAt });
};

/** Lets a teacher hand a notebook back for another go. */
exports.reopenAttempt = async (req, res) => {
  const attempt = await LmNotebookAttempt.findOne({
    _id: req.params.attemptId,
    classId: req.lmClass._id,
  });
  if (!attempt) return res.status(404).json({ message: 'Notebook not found.' });

  attempt.submittedAt = null;
  attempt.revision += 1;
  attempt.updated_at = new Date();
  await attempt.save();

  const notebook = await LmNotebook.findById(attempt.notebookId).select('courseworkId').lean();
  if (notebook?.courseworkId) {
    await LmSubmission.updateOne(
      { courseworkId: notebook.courseworkId, studentId: attempt.studentId },
      { $set: { state: 'assigned', turnedInAt: null } },
    );
  }

  return res.json({ reopened: true });
};

/* ─────────────────────────────── marking ──────────────────────────────── */

exports.listAttempts = async (req, res) => {
  const notebook = await LmNotebook.findOne({
    _id: req.params.notebookId,
    classId: req.lmClass._id,
  })
    .select('dueDate title')
    .lean();
  if (!notebook) return res.status(404).json({ message: 'Notebook not found.' });

  const attempts = await LmNotebookAttempt.find({
    notebookId: req.params.notebookId,
    classId: req.lmClass._id,
  })
    .select(
      'studentId studentName studentEmail rollNumber submittedAt lastSavedAt grade maxPoints gradedAt summary cells.executedAt',
    )
    .sort({ submittedAt: -1, studentName: 1 })
    .lean();

  const due = notebook.dueDate ? new Date(notebook.dueDate) : null;

  const rows = attempts.map((attempt) => {
    // Derived, not frozen: extending a deadline should forgive the people it
    // was extended for, rather than leaving them marked late for ever.
    const late = Boolean(due && attempt.submittedAt && new Date(attempt.submittedAt) > due);

    return {
      _id: attempt._id,
      studentId: attempt.studentId,
      studentName: attempt.studentName,
      studentEmail: attempt.studentEmail,
      rollNumber: attempt.rollNumber,
      submittedAt: attempt.submittedAt,
      lastSavedAt: attempt.lastSavedAt,
      grade: attempt.grade,
      maxPoints: attempt.maxPoints,
      gradedAt: attempt.gradedAt,
      late,
      // How much of the notebook they actually ran, which is the quickest read
      // on whether somebody engaged or pasted. The frozen summary is the
      // submitted state; the live count covers anyone still working.
      cellsRun: attempt.summary?.cellsRun ?? (attempt.cells || []).filter((cell) => cell.executedAt).length,
      codeCells: attempt.summary?.codeCells ?? null,
      cellsErrored: attempt.summary?.cellsErrored ?? null,
      // Only meaningful once submitted — before that it is a work in progress,
      // not an incomplete submission.
      completed: attempt.submittedAt ? Boolean(attempt.summary?.completed) : null,
    };
  });

  const submitted = rows.filter((row) => row.submittedAt);

  return res.json({
    dueDate: notebook.dueDate,
    attempts: rows,
    tally: {
      started: rows.length,
      submitted: submitted.length,
      // The two numbers the deadline exists to produce.
      onTime: due ? submitted.filter((row) => !row.late).length : null,
      late: due ? submitted.filter((row) => row.late).length : null,
      // Worked through it, as against opened it and pressed submit.
      completed: submitted.filter((row) => row.completed).length,
    },
  });
};

exports.getAttempt = async (req, res) => {
  const attempt = await LmNotebookAttempt.findOne({
    _id: req.params.attemptId,
    classId: req.lmClass._id,
  }).lean();
  if (!attempt) return res.status(404).json({ message: 'Notebook not found.' });

  // A student may read their own; anyone else needs to be staff.
  if (!req.lmIsTeacher && String(attempt.studentId) !== req.lmUser.id) {
    return res.status(403).json({ message: 'Forbidden' });
  }

  const notebook = await LmNotebook.findById(attempt.notebookId).lean();
  return res.json({
    attempt,
    notebook: notebook
      ? { _id: notebook._id, title: notebook.title, cells: req.lmIsTeacher ? notebook.cells : undefined }
      : null,
  });
};

exports.gradeAttempt = async (req, res) => {
  const attempt = await LmNotebookAttempt.findOne({
    _id: req.params.attemptId,
    classId: req.lmClass._id,
  });
  if (!attempt) return res.status(404).json({ message: 'Notebook not found.' });

  const grade = req.body.grade === null || req.body.grade === '' ? null : Number(req.body.grade);
  if (grade !== null && !Number.isFinite(grade)) {
    return res.status(400).json({ message: 'The grade must be a number.' });
  }

  attempt.grade = grade;
  attempt.maxPoints = Number(req.body.maxPoints) || attempt.maxPoints;
  attempt.feedback = String(req.body.feedback || '');
  attempt.gradedAt = grade === null ? null : new Date();
  attempt.gradedByName = req.lmUser.name;
  attempt.updated_at = new Date();
  await attempt.save();

  const notebook = await LmNotebook.findById(attempt.notebookId).select('courseworkId').lean();
  if (notebook?.courseworkId) {
    await LmSubmission.updateOne(
      { courseworkId: notebook.courseworkId, studentId: attempt.studentId },
      {
        $set: {
          grade: attempt.grade,
          maxPoints: attempt.maxPoints,
          feedback: attempt.feedback,
          state: grade === null ? 'turned-in' : 'returned',
          gradedAt: attempt.gradedAt,
          returnedAt: grade === null ? null : new Date(),
          gradedByName: req.lmUser.name,
        },
      },
    );
  }

  return res.json({ graded: true, grade: attempt.grade });
};
