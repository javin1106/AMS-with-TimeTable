const crypto = require('crypto');

const LmTutorial = require('../models/lmTutorial');
const LmTutorialAttempt = require('../models/lmTutorialAttempt');
const LmCoursework = require('../models/lmCoursework');
const LmSubmission = require('../models/lmSubmission');
const LmMembership = require('../models/lmMembership');
const { seedSubmissions } = require('./courseworkController');
const formula = require('../services/formulaEngine');
const variants = require('../services/variantGenerator');
const { notifyClass, notifyUser } = require('../services/notifyService');
const game = require('../services/gamification');

/* ─────────────────────────────── helpers ──────────────────────────────── */

// Mongoose Maps do not survive .lean() as plain objects everywhere, and the
// client only ever wants a plain object.
const plainValues = (values) => {
  if (!values) return {};
  if (values instanceof Map) return Object.fromEntries(values);
  return { ...values };
};

/** Everything a student may see about their own sitting. */
const attemptForStudent = (attempt, tutorial) => ({
  _id: attempt._id,
  tutorialId: attempt.tutorialId,
  attemptNumber: attempt.attemptNumber,
  status: attempt.status,
  score: attempt.score,
  maxScore: attempt.maxScore,
  percent: attempt.percent,
  passed: attempt.passed,
  startedAt: attempt.startedAt,
  submittedAt: attempt.submittedAt,
  late: attempt.late,
  teacherFeedback: attempt.teacherFeedback,
  questions: (attempt.questions || []).map((question) => {
    const submitted = attempt.status !== 'in_progress';
    const reveal = submitted && tutorial?.settings?.showSolutionAfterSubmit;
    return {
      questionId: question.questionId,
      prompt: question.prompt,
      values: plainValues(question.values),
      hint: tutorial?.settings?.showHints ? question.hint : '',
      // The worked solution and the numeric answer key stay server-side until
      // the paper is submitted, otherwise the whole exercise is pointless.
      solution: reveal ? question.solution : '',
      answers: (question.expected || []).map((expected) => ({
        key: expected.key,
        label: expected.label,
        unit: expected.unit,
        marks: expected.marks,
        expected: reveal ? expected.value : undefined,
        unavailable: Boolean(expected.error),
      })),
    };
  }),
  responses: attempt.responses || [],
});

const dueDateOf = (tutorial) => tutorial.settings?.dueDate || null;

const isOpen = (tutorial) => {
  const now = new Date();
  if (tutorial.settings?.availableFrom && now < tutorial.settings.availableFrom) return false;
  return true;
};

/* ────────────────────────── authoring (teacher) ───────────────────────── */

/**
 * Normalises and validates an incoming question list. Returns
 * `{ questions, errors }`; the caller rejects the write when errors is
 * non-empty, so a tutorial can never be saved with a formula that will blow
 * up at generation time for every student.
 */
function prepareQuestions(input) {
  const errors = [];
  const questions = (Array.isArray(input) ? input : []).map((question, questionIndex) => {
    const where = `Question ${questionIndex + 1}`;

    const variableList = (Array.isArray(question.variables) ? question.variables : []).map((variable) => ({
      name: String(variable.name || '').trim(),
      label: variable.label || '',
      type: ['range', 'integer', 'set'].includes(variable.type) ? variable.type : 'range',
      min: Number(variable.min) || 0,
      max: Number(variable.max) || 0,
      step: Number(variable.step) || 0,
      decimals: Number.isFinite(Number(variable.decimals)) ? Number(variable.decimals) : 2,
      values: Array.isArray(variable.values) ? variable.values.map(String).filter(Boolean) : [],
      unit: variable.unit || '',
    }));

    const names = variableList.map((variable) => variable.name);
    names.forEach((name, i) => {
      if (!name) errors.push(`${where}: a variable has no name.`);
      else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        errors.push(`${where}: "${name}" is not a valid variable name (letters, digits and _ only, not starting with a digit).`);
      } else if (names.indexOf(name) !== i) {
        errors.push(`${where}: variable "${name}" is declared twice.`);
      }
    });

    variableList.forEach((variable) => {
      if (variable.type === 'set') {
        if (!variable.values.length) errors.push(`${where}: variable "${variable.name}" is a set with no values.`);
      } else if (variable.max < variable.min) {
        errors.push(`${where}: variable "${variable.name}" has max below min.`);
      }
    });

    // Placeholders in the prompt and worked solution must resolve, or students
    // see raw {{x}} on their paper.
    ['prompt', 'solutionSteps'].forEach((field) => {
      const label = field === 'prompt' ? 'prompt' : 'worked solution';
      variants.templateVariables(question[field]).forEach((name) => {
        if (!names.includes(name)) {
          errors.push(`${where}: the ${label} uses {{${name}}} but no such variable is declared.`);
        }
      });
      // Rich text authoring makes it easy to bold half of a placeholder, which
      // silently stops it substituting. Catch it at save time.
      variants.splitPlaceholders(question[field]).forEach((name) => {
        errors.push(
          `${where}: the ${label}'s {{${name}}} placeholder has formatting inside the braces, so it will not be replaced. Delete it and re-insert it with the variable button.`,
        );
      });
    });

    // The prompt arrives as HTML, so an "empty" editor still sends <p><br></p>.
    if (!variants.stripTags(question.prompt).replace(/&nbsp;|\s/g, '')) {
      errors.push(`${where}: the prompt is empty.`);
    }

    const constraint = String(question.constraint || '').trim();
    if (constraint) {
      const check = formula.validate(constraint, names);
      if (!check.ok) errors.push(`${where} constraint: ${check.error}`);
    }

    const answerList = (Array.isArray(question.answers) ? question.answers : []).map((answer, answerIndex) => {
      const check = formula.validate(answer.formula, names);
      if (!check.ok) {
        errors.push(`${where}, answer ${answerIndex + 1} (${answer.label || 'unnamed'}): ${check.error}`);
      }
      return {
        // A stable key so a student's saved response survives a relabel.
        key: String(answer.key || '').trim() || crypto.randomBytes(6).toString('hex'),
        label: String(answer.label || `Answer ${answerIndex + 1}`),
        formula: String(answer.formula || ''),
        unit: answer.unit || '',
        tolerancePercent: Number.isFinite(Number(answer.tolerancePercent)) ? Number(answer.tolerancePercent) : 1,
        toleranceAbs: Number.isFinite(Number(answer.toleranceAbs)) ? Number(answer.toleranceAbs) : 0,
        decimals: answer.decimals === null || answer.decimals === '' ? null : Number(answer.decimals),
        marks: Number(answer.marks) || 1,
      };
    });

    if (!answerList.length) errors.push(`${where}: add at least one answer.`);

    return {
      _id: question._id || undefined,
      prompt: String(question.prompt || ''),
      variables: variableList,
      answers: answerList,
      constraint,
      hint: String(question.hint || ''),
      solutionSteps: String(question.solutionSteps || ''),
      difficulty: ['easy', 'medium', 'hard'].includes(question.difficulty) ? question.difficulty : 'medium',
      topic: String(question.topic || ''),
      order: Number(question.order) || questionIndex,
    };
  });

  return { questions, errors };
}

// Exported for unit testing: this function gates every tutorial write, so its
// validation rules are worth pinning down without needing a database.
exports.prepareQuestions = prepareQuestions;

exports.listTutorials = async (req, res) => {
  const filter = { classId: req.lmClass._id, ...(req.lmIsTeacher ? {} : { published: true }) };
  const tutorials = await LmTutorial.find(filter).sort({ created_at: -1 }).lean();

  if (req.lmIsTeacher) {
    const stats = await LmTutorialAttempt.aggregate([
      { $match: { classId: req.lmClass._id, status: { $in: ['submitted', 'graded'] } } },
      { $group: { _id: '$tutorialId', attempts: { $sum: 1 }, avg: { $avg: '$percent' } } },
    ]);
    const byTutorial = new Map(stats.map((entry) => [String(entry._id), entry]));
    return res.json(
      tutorials.map((tutorial) => ({
        ...tutorial,
        stats: byTutorial.get(String(tutorial._id)) || { attempts: 0, avg: null },
      })),
    );
  }

  const mine = await LmTutorialAttempt.find({
    classId: req.lmClass._id,
    studentId: req.lmUser.id,
  })
    .select('tutorialId status score maxScore percent passed attemptNumber submittedAt')
    .lean();

  return res.json(
    tutorials.map((tutorial) => {
      const attempts = mine.filter((attempt) => String(attempt.tutorialId) === String(tutorial._id));
      const best = attempts.reduce(
        (top, attempt) => (!top || attempt.percent > top.percent ? attempt : top),
        null,
      );
      return {
        _id: tutorial._id,
        title: tutorial.title,
        description: tutorial.description,
        topicName: tutorial.topicName,
        totalMarks: tutorial.totalMarks,
        questionCount: tutorial.questions.length,
        settings: tutorial.settings,
        attemptsUsed: attempts.length,
        bestAttempt: best,
        open: isOpen(tutorial),
      };
    }),
  );
};

exports.createTutorial = async (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ message: 'A tutorial title is required.' });

  const { questions, errors } = prepareQuestions(req.body.questions);
  if (errors.length) return res.status(400).json({ message: errors[0], errors });

  const topic = req.body.topicId ? req.lmClass.topics.id(req.body.topicId) : null;

  const tutorial = new LmTutorial({
    classId: req.lmClass._id,
    title,
    description: req.body.description || '',
    topicId: topic?._id || null,
    topicName: topic?.name || '',
    questions,
    createdBy: req.lmUser.id,
    createdByName: req.lmUser.name,
  });
  if (req.body.settings) Object.assign(tutorial.settings, req.body.settings);
  await tutorial.save();

  return res.status(201).json(tutorial);
};

exports.getTutorial = async (req, res) => {
  const tutorial = await LmTutorial.findOne({
    _id: req.params.tutorialId,
    classId: req.lmClass._id,
  }).lean();
  if (!tutorial) return res.status(404).json({ message: 'Tutorial not found.' });

  // A student must never receive the formulas — they are the answer key.
  if (!req.lmIsTeacher) {
    if (!tutorial.published) return res.status(404).json({ message: 'Tutorial not found.' });
    return res.json({
      _id: tutorial._id,
      title: tutorial.title,
      description: tutorial.description,
      totalMarks: tutorial.totalMarks,
      questionCount: tutorial.questions.length,
      settings: tutorial.settings,
      open: isOpen(tutorial),
    });
  }

  return res.json(tutorial);
};

exports.updateTutorial = async (req, res) => {
  const tutorial = await LmTutorial.findOne({
    _id: req.params.tutorialId,
    classId: req.lmClass._id,
  });
  if (!tutorial) return res.status(404).json({ message: 'Tutorial not found.' });

  if (req.body.title !== undefined) tutorial.title = String(req.body.title).trim();
  if (req.body.description !== undefined) tutorial.description = String(req.body.description);
  if (req.body.topicId !== undefined) {
    const topic = req.body.topicId ? req.lmClass.topics.id(req.body.topicId) : null;
    tutorial.topicId = topic?._id || null;
    tutorial.topicName = topic?.name || '';
  }
  if (req.body.questions !== undefined) {
    const { questions, errors } = prepareQuestions(req.body.questions);
    if (errors.length) return res.status(400).json({ message: errors[0], errors });
    tutorial.questions = questions;
  }
  if (req.body.settings) Object.assign(tutorial.settings, req.body.settings);

  tutorial.updated_at = new Date();
  await tutorial.save();

  // Attempts already in flight keep the paper they were given — see the note
  // on lmTutorialAttempt — so an edit never invalidates existing work.
  return res.json(tutorial);
};

exports.deleteTutorial = async (req, res) => {
  const tutorial = await LmTutorial.findOne({
    _id: req.params.tutorialId,
    classId: req.lmClass._id,
  });
  if (!tutorial) return res.status(404).json({ message: 'Tutorial not found.' });

  await LmTutorialAttempt.deleteMany({ tutorialId: tutorial._id });
  if (tutorial.courseworkId) {
    await LmSubmission.deleteMany({ courseworkId: tutorial.courseworkId });
    await LmCoursework.deleteOne({ _id: tutorial.courseworkId });
  }
  await LmTutorial.deleteOne({ _id: tutorial._id });
  return res.json({ deleted: true });
};

/**
 * Authoring aid: checks one formula against a declared variable list without
 * saving anything, so the editor can show errors as the teacher types.
 */
exports.validateFormula = async (req, res) => {
  const names = Array.isArray(req.body.variables)
    ? req.body.variables.map((variable) => String(variable.name || variable)).filter(Boolean)
    : [];
  return res.json(formula.validate(req.body.formula, names));
};

/**
 * Rolls sample variants so the teacher can see the actual numbers students
 * will get, and catch a formula that only fails for part of the range.
 */
exports.previewTutorial = async (req, res) => {
  const tutorial = await LmTutorial.findOne({
    _id: req.params.tutorialId,
    classId: req.lmClass._id,
  }).lean();
  if (!tutorial) return res.status(404).json({ message: 'Tutorial not found.' });

  const count = Math.min(Math.max(Number(req.body.count) || 3, 1), 10);
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    // Distinct pseudo-students, so the samples differ from one another.
    const variant = variants.generateVariant(tutorial, `preview-${i}`, 1);
    samples.push({
      label: `Student ${i + 1}`,
      warnings: variant.warnings,
      questions: variant.questions.map((question) => ({
        prompt: question.prompt,
        values: question.values,
        solution: question.solution,
        expected: question.expected,
      })),
    });
  }

  return res.json({
    samples,
    // Aggregated so a formula that fails on 1 draw in 5 is still obvious.
    warnings: [...new Set(samples.flatMap((sample) => sample.warnings))],
  });
};

exports.publishTutorial = async (req, res) => {
  const tutorial = await LmTutorial.findOne({
    _id: req.params.tutorialId,
    classId: req.lmClass._id,
  });
  if (!tutorial) return res.status(404).json({ message: 'Tutorial not found.' });
  if (!tutorial.questions.length) {
    return res.status(400).json({ message: 'Add at least one question before publishing.' });
  }

  const publish = req.body.publish !== false;

  if (publish) {
    // Refuse to publish something that cannot be generated. Sampling a few
    // variants catches range-dependent failures a single check would miss.
    const problems = new Set();
    for (let i = 0; i < 5; i += 1) {
      variants
        .generateVariant(tutorial.toObject(), `publish-check-${i}`, 1)
        .warnings.forEach((warning) => problems.add(warning));
    }
    if (problems.size) {
      return res.status(400).json({
        message: 'Fix these before publishing — some students would get an unanswerable paper.',
        errors: [...problems],
      });
    }
  }

  tutorial.published = publish;

  if (!publish) {
    if (tutorial.courseworkId) {
      await LmCoursework.updateOne({ _id: tutorial.courseworkId }, { $set: { status: 'draft' } });
    }
    await tutorial.save();
    return res.json({ published: false });
  }

  if (req.body.dueDate !== undefined) {
    tutorial.settings.dueDate = req.body.dueDate ? new Date(req.body.dueDate) : null;
  }

  let coursework = tutorial.courseworkId ? await LmCoursework.findById(tutorial.courseworkId) : null;
  if (coursework) {
    coursework.title = tutorial.title;
    coursework.instructions = tutorial.description;
    coursework.points = tutorial.totalMarks;
    coursework.dueDate = tutorial.settings.dueDate;
    coursework.status = 'published';
    await coursework.save();
  } else {
    coursework = await LmCoursework.create({
      classId: req.lmClass._id,
      workType: 'assignment',
      title: tutorial.title,
      instructions: tutorial.description,
      topicId: tutorial.topicId,
      topicName: tutorial.topicName,
      points: tutorial.totalMarks,
      dueDate: tutorial.settings.dueDate,
      createdBy: req.lmUser.id,
      createdByName: req.lmUser.name,
    });
    tutorial.courseworkId = coursework._id;
  }

  await tutorial.save();
  await seedSubmissions(coursework, req.lmClass);

  await notifyClass({
    klass: req.lmClass,
    excludeUserId: req.lmUser.id,
    type: 'coursework',
    title: `New tutorial in ${req.lmClass.name}: ${tutorial.title}`,
    body: `${tutorial.questions.length} questions · ${tutorial.totalMarks} marks · everyone gets their own values`,
    link: `/learning/class/${req.lmClass._id}/tutorial/${tutorial._id}`,
    actorName: req.lmUser.name,
    email: true,
  });

  return res.json({ published: true, courseworkId: coursework._id, tutorialId: tutorial._id });
};

/* ─────────────────────────── sitting (student) ────────────────────────── */

/**
 * Fetches the caller's current variant, generating it on first request.
 * Idempotent: a reload returns the identical paper.
 */
exports.getMyAttempt = async (req, res) => {
  const tutorial = await LmTutorial.findOne({
    _id: req.params.tutorialId,
    classId: req.lmClass._id,
    published: true,
  });
  if (!tutorial) return res.status(404).json({ message: 'Tutorial not found.' });
  if (!isOpen(tutorial)) return res.status(400).json({ message: 'This tutorial is not open yet.' });

  const existing = await LmTutorialAttempt.find({
    tutorialId: tutorial._id,
    studentId: req.lmUser.id,
  }).sort({ attemptNumber: 1 });

  const inProgress = existing.find((attempt) => attempt.status === 'in_progress');
  if (inProgress) {
    return res.json({
      attempt: attemptForStudent(inProgress, tutorial),
      history: existing.filter((a) => a.status !== 'in_progress').map((a) => attemptForStudent(a, tutorial)),
      attemptsUsed: existing.length,
      attemptsAllowed: tutorial.settings.attemptsAllowed,
    });
  }

  if (existing.length >= (tutorial.settings.attemptsAllowed || 1)) {
    // Out of attempts: hand back the latest sitting read-only.
    const last = existing[existing.length - 1];
    return res.json({
      attempt: last ? attemptForStudent(last, tutorial) : null,
      history: existing.map((a) => attemptForStudent(a, tutorial)),
      attemptsUsed: existing.length,
      attemptsAllowed: tutorial.settings.attemptsAllowed,
      exhausted: true,
    });
  }

  const attemptNumber = existing.length + 1;
  // When the teacher chose not to re-roll on retry, reuse attempt 1's numbers
  // so a resit is the same paper.
  const variantSource = tutorial.settings.newValuesOnRetry ? attemptNumber : 1;
  const variant = variants.generateVariant(tutorial.toObject(), req.lmUser.id, variantSource);

  const attempt = await LmTutorialAttempt.create({
    tutorialId: tutorial._id,
    classId: req.lmClass._id,
    studentId: req.lmUser.id,
    studentName: req.lmUser.name,
    studentEmail: req.lmUser.email,
    attemptNumber,
    seed: variant.seed,
    questions: variant.questions,
    warnings: variant.warnings,
    maxScore: tutorial.totalMarks,
  });

  return res.status(201).json({
    attempt: attemptForStudent(attempt, tutorial),
    history: existing.map((a) => attemptForStudent(a, tutorial)),
    attemptsUsed: attemptNumber,
    attemptsAllowed: tutorial.settings.attemptsAllowed,
  });
};

const applyResponses = (attempt, incoming) => {
  const byQuestion = new Map(
    (attempt.questions || []).map((question) => [String(question.questionId), question]),
  );

  return (Array.isArray(incoming) ? incoming : [])
    .filter((response) => byQuestion.has(String(response.questionId)))
    .map((response) => ({
      questionId: response.questionId,
      answerKey: String(response.answerKey || ''),
      raw: String(response.raw ?? ''),
      value: formula.parseStudentValue(response.raw),
      correct: false,
      awarded: 0,
      difference: null,
    }));
};

exports.saveAttempt = async (req, res) => {
  const attempt = await LmTutorialAttempt.findOne({
    _id: req.params.attemptId,
    classId: req.lmClass._id,
    studentId: req.lmUser.id,
  });
  if (!attempt) return res.status(404).json({ message: 'Attempt not found.' });
  if (attempt.status !== 'in_progress') {
    return res.status(400).json({ message: 'This tutorial has already been submitted.' });
  }

  attempt.responses = applyResponses(attempt, req.body.responses);
  attempt.updated_at = new Date();
  await attempt.save();
  return res.json({ saved: true, savedAt: attempt.updated_at });
};

exports.submitAttempt = async (req, res) => {
  const attempt = await LmTutorialAttempt.findOne({
    _id: req.params.attemptId,
    classId: req.lmClass._id,
    studentId: req.lmUser.id,
  });
  if (!attempt) return res.status(404).json({ message: 'Attempt not found.' });
  if (attempt.status !== 'in_progress') {
    return res.status(400).json({ message: 'This tutorial has already been submitted.' });
  }

  const tutorial = await LmTutorial.findById(attempt.tutorialId);
  if (!tutorial) return res.status(404).json({ message: 'Tutorial not found.' });

  const responses = applyResponses(attempt, req.body.responses);

  // Mark against the expected values stored on the attempt, not against a
  // freshly evaluated formula — the teacher may have edited it since.
  const expectedByKey = new Map();
  attempt.questions.forEach((question) => {
    (question.expected || []).forEach((expected) => {
      expectedByKey.set(`${question.questionId}:${expected.key}`, expected);
    });
  });

  // Tolerances do live on the tutorial, since they are marking policy rather
  // than part of the student's paper.
  const toleranceByKey = new Map();
  tutorial.questions.forEach((question) => {
    (question.answers || []).forEach((answer) => {
      toleranceByKey.set(`${question._id}:${answer.key}`, answer);
    });
  });

  let score = 0;
  const graded = responses.map((response) => {
    const lookup = `${response.questionId}:${response.answerKey}`;
    const expected = expectedByKey.get(lookup);
    const policy = toleranceByKey.get(lookup) || {};

    const result = variants.gradeAnswer(response.value, expected?.value, {
      tolerancePercent: policy.tolerancePercent,
      toleranceAbs: policy.toleranceAbs,
    });
    const awarded = result.correct ? expected?.marks || 0 : 0;
    score += awarded;

    return {
      ...response,
      correct: result.correct,
      awarded,
      difference: Number.isFinite(result.difference) ? result.difference : null,
    };
  });

  const now = new Date();
  const due = dueDateOf(tutorial);

  attempt.responses = graded;
  attempt.score = Math.round(score * 100) / 100;
  attempt.maxScore = tutorial.totalMarks;
  attempt.percent = tutorial.totalMarks
    ? Math.round((attempt.score / tutorial.totalMarks) * 1000) / 10
    : 0;
  attempt.passed = attempt.percent >= (tutorial.settings.passPercent || 0);
  attempt.status = 'submitted';
  attempt.submittedAt = now;
  attempt.late = Boolean(due && now > due);
  attempt.durationSec = Math.round((now - attempt.startedAt) / 1000);
  await attempt.save();

  await game.onTutorialSubmitted({ req, tutorial, at: now });

  // Mirror into the gradebook alongside every other piece of classwork.
  if (tutorial.courseworkId) {
    const best = await LmTutorialAttempt.find({
      tutorialId: tutorial._id,
      studentId: req.lmUser.id,
      status: { $in: ['submitted', 'graded'] },
    })
      .sort({ score: -1 })
      .limit(1)
      .lean();
    const bestScore = best[0]?.score ?? attempt.score;

    await LmSubmission.findOneAndUpdate(
      { courseworkId: tutorial.courseworkId, studentId: req.lmUser.id },
      {
        $set: {
          classId: req.lmClass._id,
          studentName: req.lmUser.name,
          studentEmail: req.lmUser.email,
          state: 'returned',
          grade: bestScore,
          maxPoints: tutorial.totalMarks,
          turnedInAt: now,
          returnedAt: now,
          gradedAt: now,
          gradedByName: 'Auto-graded',
          late: attempt.late,
          feedback: `Tutorial auto-graded: ${bestScore}/${tutorial.totalMarks}`,
        },
      },
      { upsert: true },
    );
  }

  await notifyUser({
    userId: tutorial.createdBy,
    klass: req.lmClass,
    type: 'submission',
    title: `${req.lmUser.name} submitted ${tutorial.title}`,
    body: `Scored ${attempt.score}/${attempt.maxScore} (${attempt.percent}%).`,
    link: `/learning/class/${req.lmClass._id}/tutorial/${tutorial._id}/results`,
    actorName: req.lmUser.name,
  });

  return res.json({ attempt: attemptForStudent(attempt, tutorial) });
};

/* ─────────────────────────── review (teacher) ─────────────────────────── */

exports.getTutorialResults = async (req, res) => {
  const tutorial = await LmTutorial.findOne({
    _id: req.params.tutorialId,
    classId: req.lmClass._id,
  }).lean();
  if (!tutorial) return res.status(404).json({ message: 'Tutorial not found.' });

  const attempts = await LmTutorialAttempt.find({ tutorialId: tutorial._id })
    .sort({ studentName: 1, attemptNumber: 1 })
    .lean();

  const submitted = attempts.filter((attempt) => attempt.status !== 'in_progress');
  const enrolled = await LmMembership.countDocuments({
    classId: req.lmClass._id,
    role: 'student',
    status: 'active',
  });

  // Per-answer-slot difficulty across the class. Because every student had
  // different numbers, this measures the *method*, not one specific sum.
  const perAnswer = [];
  tutorial.questions.forEach((question, questionIndex) => {
    (question.answers || []).forEach((answer) => {
      const responses = submitted
        .flatMap((attempt) => attempt.responses || [])
        .filter(
          (response) =>
            String(response.questionId) === String(question._id) && response.answerKey === answer.key,
        );
      const correct = responses.filter((response) => response.correct).length;
      perAnswer.push({
        questionIndex: questionIndex + 1,
        questionId: question._id,
        answerKey: answer.key,
        label: answer.label,
        formula: answer.formula,
        marks: answer.marks,
        responses: responses.length,
        correct,
        correctPercent: responses.length ? Math.round((correct / responses.length) * 1000) / 10 : null,
      });
    });
  });

  const percents = submitted.map((attempt) => attempt.percent);

  return res.json({
    tutorial,
    attempts: attempts.map((attempt) => ({
      ...attempt,
      questions: (attempt.questions || []).map((question) => ({
        ...question,
        values: plainValues(question.values),
      })),
    })),
    summary: {
      enrolled,
      started: attempts.length,
      submitted: submitted.length,
      average: percents.length
        ? Math.round((percents.reduce((a, b) => a + b, 0) / percents.length) * 10) / 10
        : null,
      highest: percents.length ? Math.max(...percents) : null,
      lowest: percents.length ? Math.min(...percents) : null,
      passRate: submitted.length
        ? Math.round((submitted.filter((attempt) => attempt.passed).length / submitted.length) * 1000) / 10
        : null,
    },
    perAnswer,
  });
};

/** Manual override on top of auto-marking (partial credit for method, etc.). */
exports.adjustAttempt = async (req, res) => {
  const attempt = await LmTutorialAttempt.findOne({
    _id: req.params.attemptId,
    classId: req.lmClass._id,
  });
  if (!attempt) return res.status(404).json({ message: 'Attempt not found.' });

  const adjustment = Number(req.body.adjustment);
  if (!Number.isFinite(adjustment)) {
    return res.status(400).json({ message: 'Adjustment must be a number.' });
  }

  const autoScore = (attempt.responses || []).reduce((sum, response) => sum + (response.awarded || 0), 0);
  const total = Math.max(0, Math.min(attempt.maxScore, autoScore + adjustment));

  attempt.teacherAdjustment = adjustment;
  if (req.body.feedback !== undefined) attempt.teacherFeedback = String(req.body.feedback);
  attempt.score = Math.round(total * 100) / 100;
  attempt.percent = attempt.maxScore ? Math.round((attempt.score / attempt.maxScore) * 1000) / 10 : 0;
  attempt.status = 'graded';
  await attempt.save();

  const tutorial = await LmTutorial.findById(attempt.tutorialId).select('courseworkId').lean();
  if (tutorial?.courseworkId) {
    await LmSubmission.updateOne(
      { courseworkId: tutorial.courseworkId, studentId: attempt.studentId },
      {
        $set: {
          grade: attempt.score,
          feedback: attempt.teacherFeedback || `Adjusted to ${attempt.score}/${attempt.maxScore}`,
          gradedBy: req.lmUser.id,
          gradedByName: req.lmUser.name,
          gradedAt: new Date(),
        },
      },
    );
  }

  await notifyUser({
    userId: attempt.studentId,
    klass: req.lmClass,
    type: 'grade',
    title: 'Your tutorial was reviewed',
    body: `Score updated to ${attempt.score}/${attempt.maxScore}.`,
    link: `/learning/class/${req.lmClass._id}/tutorial/${attempt.tutorialId}`,
    actorName: req.lmUser.name,
  });

  return res.json({ score: attempt.score, percent: attempt.percent });
};

/** Reference data for the authoring UI's help panel. */
exports.getFormulaReference = async (req, res) =>
  res.json({ functions: formula.FUNCTION_NAMES, constants: formula.CONSTANT_NAMES });
