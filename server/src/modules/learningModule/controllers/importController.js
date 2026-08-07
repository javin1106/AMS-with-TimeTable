const LmMembership = require("../models/lmMembership");
const LmClass = require("../models/lmClass");
const LmQuiz = require("../models/lmQuiz");
const LmShort = require("../models/lmShort");
const LmTutorial = require("../models/lmTutorial");
const LmNotebook = require("../models/lmNotebook");

/**
 * Reusing questions from another subject.
 *
 * A department sets the same paper to four branches and reuses half of it the
 * following year, and until now the only way to get a question into a second
 * class was to type it again. So a teacher can pull individual questions out of
 * any *other* class they staff, and they are appended to the item open in front
 * of them as their own editable copies.
 *
 * Three rules, and they are why this is one module rather than four endpoints
 * written four ways:
 *
 *  1. **Like into like.** Quiz questions go into a quiz, Short slides into a
 *     Short, tutorial questions into a tutorial, notebook cells into a
 *     notebook. The shapes are genuinely different — a slide has a scale range,
 *     a tutorial question has variables and formulas — so a "convert" would
 *     silently drop the half that has nowhere to go.
 *  2. **A copy, never a link.** The copy lands in the present class and belongs
 *     to it. Editing it must not reach back into somebody's live paper, and the
 *     source changing later must not rewrite a paper already set.
 *  3. **Nothing but the question travels.** No settings, no windows, no result
 *     times, no student work — those describe the source class's run of it.
 */

/* ─────────────────────────────── the catalogue ─────────────────────────── */

/** Rich text in, one line of plain text out, for a pick list. */
const plain = (value, limit = 160) => {
  const text = String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
};

/**
 * What each importable type is, in one place.
 *
 * `field` is the array the questions live in; `describe` turns one of them into
 * the line a teacher picks from; `clean` strips whatever tied it to the
 * document it came out of.
 */
const TYPES = {
  quiz: {
    label: "Quiz",
    itemLabel: "quiz",
    partLabel: "questions",
    model: () => LmQuiz,
    field: "questions",
    describe: (part) => ({
      title: plain(part.question),
      note: `${part.type} · ${part.marks || 0} mark(s)`,
    }),
    // Sections belong to the source paper: a `sectionId` pointing into another
    // quiz's section list would put the question in a section this quiz does
    // not have, and the section roll-up would then be counting a phantom. The
    // question arrives ungrouped and the teacher files it.
    clean: (part) => {
      delete part.sectionId;
      delete part.sectionName;
    },
  },
  short: {
    label: "Short",
    itemLabel: "deck",
    partLabel: "slides",
    model: () => LmShort,
    field: "slides",
    describe: (part) => ({ title: plain(part.question), note: part.type }),
  },
  tutorial: {
    label: "Tutorial",
    itemLabel: "tutorial",
    partLabel: "questions",
    model: () => LmTutorial,
    field: "questions",
    describe: (part) => ({
      title: plain(part.prompt),
      note: `${(part.variables || []).length} variable(s) · ${(part.answers || []).length} answer(s)`,
    }),
  },
  notebook: {
    label: "Coding notebook",
    itemLabel: "notebook",
    partLabel: "cells",
    model: () => LmNotebook,
    field: "cells",
    describe: (part) => ({ title: plain(part.source) || "(empty cell)", note: part.type }),
  },
};

const typeOf = (value) => TYPES[String(value || "")] || null;

/** Whether the caller staffs a class — proved per request, never assumed. */
const staffs = (userId, classId) =>
  LmMembership.exists({
    userId,
    classId,
    role: { $in: ["teacher", "co-teacher"] },
    status: "active",
  });

/* ──────────────────────────────── reading ─────────────────────────────── */

/** The classes this teacher could import from — every other one they staff. */
exports.listSources = async (req, res) => {
  const spec = typeOf(req.query.type);
  if (!spec) return res.status(400).json({ message: "Unknown item type." });

  const memberships = await LmMembership.find({
    userId: req.lmUser.id,
    role: { $in: ["teacher", "co-teacher"] },
    status: "active",
    classId: { $ne: req.lmClass._id },
  })
    .select("classId")
    .lean();

  const classIds = memberships.map((membership) => membership.classId);
  if (!classIds.length) return res.json([]);

  const classes = await LmClass.find({ _id: { $in: classIds } })
    .select("name section subject coverColor status")
    .sort({ updated_at: -1 })
    .lean();

  // How much there is to take, so a teacher is not made to open four empty
  // classes to find the one holding the paper.
  const rows = await spec
    .model()
    .aggregate([
      { $match: { classId: { $in: classIds } } },
      { $group: { _id: "$classId", items: { $sum: 1 } } },
    ]);
  const byClass = new Map(rows.map((row) => [String(row._id), row.items]));

  return res.json(
    classes.map((klass) => ({ ...klass, items: byClass.get(String(klass._id)) || 0 })),
  );
};

/** The items of one type in one source class, as a pick list. */
exports.listItems = async (req, res) => {
  const spec = typeOf(req.query.type);
  if (!spec) return res.status(400).json({ message: "Unknown item type." });

  // Read access proved against the class the questions come *out* of, not
  // merely named in the path. Without this, any teacher could read every paper
  // on the platform by guessing a class id.
  if (!(await staffs(req.lmUser.id, req.params.sourceClassId))) {
    return res.status(403).json({ message: "You do not teach that class." });
  }

  const items = await spec
    .model()
    .find({ classId: req.params.sourceClassId })
    .select(`title created_at createdByName ${spec.field}`)
    .sort({ created_at: -1 })
    .limit(300)
    .lean();

  return res.json(
    items.map((item) => ({
      _id: item._id,
      title: item.title,
      count: (item[spec.field] || []).length,
      createdByName: item.createdByName,
      created_at: item.created_at,
    })),
  );
};

/** The questions inside one source item, for ticking. */
exports.listParts = async (req, res) => {
  const spec = typeOf(req.query.type);
  if (!spec) return res.status(400).json({ message: "Unknown item type." });

  const item = await spec.model().findById(req.params.itemId).lean();
  if (!item) return res.status(404).json({ message: "Not found." });
  if (!(await staffs(req.lmUser.id, item.classId))) {
    return res.status(403).json({ message: "You do not teach that class." });
  }

  const parts = [...(item[spec.field] || [])].sort((a, b) => (a.order || 0) - (b.order || 0));

  return res.json({
    _id: item._id,
    title: item.title,
    parts: parts.map((part) => ({ _id: part._id, ...spec.describe(part) })),
  });
};

/** Where the copies could go: the items of that type already in this class. */
exports.listTargets = async (req, res) => {
  const spec = typeOf(req.query.type);
  if (!spec) return res.status(400).json({ message: "Unknown item type." });

  const items = await spec
    .model()
    .find({ classId: req.lmClass._id })
    .select(`title ${spec.field}`)
    .sort({ created_at: -1 })
    .limit(300)
    .lean();

  return res.json(
    items.map((item) => ({
      _id: item._id,
      title: item.title,
      count: (item[spec.field] || []).length,
    })),
  );
};

/* ──────────────────────────────── writing ─────────────────────────────── */

exports.importParts = async (req, res) => {
  const spec = typeOf(req.body.type);
  if (!spec) return res.status(400).json({ message: "Unknown item type." });

  const ids = (Array.isArray(req.body.partIds) ? req.body.partIds : []).map(String).filter(Boolean);
  if (!ids.length) {
    return res.status(400).json({ message: `Select at least one of the ${spec.partLabel} to import.` });
  }

  const source = await spec.model().findById(req.body.sourceItemId).lean();
  if (!source) return res.status(404).json({ message: "The source was not found." });
  if (!(await staffs(req.lmUser.id, source.classId))) {
    return res.status(403).json({ message: "You do not teach that class." });
  }

  // The copy is made *into this class*, and the target is re-read from it
  // rather than taken on trust: an id from a class the caller merely knows
  // about must not be writable by naming it here.
  const target = await spec.model().findOne({ _id: req.body.targetId, classId: req.lmClass._id });
  if (!target) {
    return res.status(404).json({ message: `Choose a ${spec.itemLabel} in this class to add them to.` });
  }

  const wanted = new Set(ids);
  const picked = (source[spec.field] || []).filter((part) => wanted.has(String(part._id)));
  if (!picked.length) return res.status(404).json({ message: "Nothing to import was found." });

  // Appended, never interleaved: the teacher's own ordering of what they have
  // already written is not ours to rearrange.
  let order = (target[spec.field] || []).reduce(
    (highest, part) => Math.max(highest, part.order || 0),
    -1,
  );

  picked.forEach((part) => {
    const copy = { ...part };
    // A fresh identity, so the same question imported twice is two questions
    // and neither collides with the other — and so nothing in the source class
    // is addressed by anything here.
    delete copy._id;
    spec.clean?.(copy);
    order += 1;
    copy.order = order;
    target[spec.field].push(copy);
  });

  target.updated_at = new Date();
  await target.save();

  return res.json({
    imported: picked.length,
    targetId: target._id,
    targetTitle: target.title,
    // Totals recomputed on save for quizzes and tutorials, so this is the real
    // figure rather than the one the client would have guessed.
    total: target[spec.field].length,
    totalMarks: target.totalMarks,
  });
};

exports.TYPES = TYPES;
