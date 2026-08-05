const crypto = require("crypto");
const mongoose = require("mongoose");

const LmPoints = require("../models/lmPoints");
const LmBadge = require("../models/lmBadge");

/**
 * `$match` is not a query, and mongoose does not cast inside an aggregation
 * pipeline. `req.lmUser.id` is a string, so a pipeline matching on it directly
 * quietly matches nothing at all and reports a total of zero — a bug with no
 * error attached to it. Everything entering a pipeline goes through here.
 */
const asId = (value) =>
  value instanceof mongoose.Types.ObjectId ? value : new mongoose.Types.ObjectId(String(value));

/**
 * A stable reference for something that has no document of its own.
 *
 * Winning a week is an event, not a record — there is nothing to point `refId`
 * at, and leaving it null opts the row out of the unique index entirely (the
 * index is partial, so several null-referenced bonuses may coexist). Hashing
 * the week key into an id gives the ledger something to collide on, which is
 * what stops every read of the leaderboard recording the same win again.
 */
const stableRef = (text) =>
  new mongoose.Types.ObjectId(crypto.createHash("sha1").update(String(text)).digest("hex").slice(0, 24));

/**
 * Points and badges, per class.
 *
 * Two rules shape everything here.
 *
 * **Nothing a student earns may fail their request.** Points are a garnish on
 * an action that has already succeeded — the submission is saved, the quiz is
 * marked — so every entry point swallows its own errors. A student who cannot
 * turn in their work because the leaderboard was busy would be a far worse bug
 * than a missing point.
 *
 * **Effort is rewarded, not correctness alone.** The marks already exist and
 * are the teacher's job. If points tracked accuracy they would be a second,
 * noisier grade, and the class already has one of those. So submitting pays,
 * turning up pays, and doing well adds a modest bonus on top rather than
 * dominating the table.
 */

/* ─────────────────────────────── the week ─────────────────────────────── */

/**
 * ISO-8601 week key, e.g. "2026-W31".
 *
 * ISO rather than "the last seven days": a leaderboard that resets on a rolling
 * window has no shared starting line, so two students comparing scores are
 * reading different tables. ISO weeks start Monday, which is also what a
 * timetable does.
 */
function weekKeyOf(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // Thursday decides the year: an ISO week belongs to whichever year holds its
  // Thursday, which is what makes the turn of the year come out right.
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Monday 00:00 UTC of the week a key names, for "week of…" labelling. */
function weekStartOf(key) {
  const [year, week] = String(key).split("-W").map(Number);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1) + (week - 1) * 7);
  return monday;
}

/* ─────────────────────────────── the rules ────────────────────────────── */

/**
 * What each activity is worth.
 *
 * Weighted by what the task actually costs a student, so an evening on a coding
 * exercise cannot be matched by a afternoon of comments. The ladder, heaviest
 * first: assignment, coding exercise, quiz, tutorial, feedback, live Short,
 * comment. A coding exercise pays the most in total — its base is modest and
 * the rest is the completion bonus, so the points follow working it through
 * rather than opening it. Flat values rather than a share of the task's marks —
 * a student
 * should be able to look at this and know what something is worth before they
 * do it, and "40% of the marks available" is not that.
 *
 * Late work still pays, at roughly 40%. Paying nothing teaches "do not bother",
 * which is the opposite of what a participation score is for.
 */
const POINTS = {
  // Written, run and debugged — but most of what it pays is the bonus below,
  // not this. Turning one in barely started is not worth an assignment.
  notebookOnTime: 20,
  notebookLate: 12,
  // On top, for actually working it through rather than submitting a shell.
  notebookCompleted: 15,

  submissionOnTime: 25,
  submissionLate: 10,

  quizAttempt: 20,
  // Up to 20 more, a point per 5%. Sitting the paper is still half of it at
  // most: points are not a second grade.
  quizScoreBonus: (percent) => Math.round(Math.max(0, Math.min(100, percent || 0)) / 5),

  tutorial: 20,

  // Anonymous feedback. Worth real points — it is real work and the class
  // needs it — see the note on `onFeedback` about what that costs.
  feedback: 15,

  // Per *session*, not per slide: turning up to a fifteen-question deck should
  // be worth turning up for, not fifteen assignments.
  shortAnswer: 5,

  // Starting a topic worth the class's time. Rationed to one a week, so this
  // cannot be farmed and can afford to be worth something.
  discussion: 15,

  // A bug an admin has confirmed is real. Worth about an assignment: finding
  // one is genuinely useful work, and it is paid on acknowledgement rather than
  // on submission so the queue cannot be farmed.
  bugReport: 25,

  // The cheapest thing available, and capped daily besides.
  comment: 2,
};

// A comment is worth a point, which is exactly the kind of thing somebody will
// try to farm. Past this many in a day the points stop; the comments do not.
const COMMENT_DAILY_CAP = 10;

/* ────────────────────────────── the badges ────────────────────────────── */

/**
 * The catalogue.
 *
 * Named to be worth screenshotting — that is the entire point of a badge, and
 * "Consistent Submitter" has never made anyone want one. Each carries a plain
 * `hint` as well, because a name that lands with one person is a shrug to
 * another, and nobody should have to guess what they did to earn it.
 *
 * Slang dates. These live here, not in the database, precisely so renaming one
 * is a code change rather than a migration across everybody holding it.
 */
const BADGES = {
  "first-dibs": {
    emoji: "🥇",
    name: "First Dibs",
    hint: "First in the class to turn something in.",
  },
  "understood-the-assignment": {
    emoji: "🎯",
    name: "Understood the Assignment",
    hint: "Full marks on a quiz.",
  },
  "locked-in": {
    emoji: "🔒",
    name: "Locked In",
    hint: "Five submissions in a row, all before the deadline.",
  },
  "full-send": {
    emoji: "🚀",
    name: "Full Send",
    hint: "Ran every cell in a coding exercise before submitting it.",
  },
  "main-character": {
    emoji: "👑",
    name: "Main Character",
    hint: "Finished top of the weekly leaderboard.",
  },
  speedrun: {
    emoji: "⚡",
    name: "Speedrun",
    hint: "Turned something in within an hour of it being set.",
  },
  "no-days-off": {
    emoji: "📅",
    name: "No Days Off",
    hint: "Earned points in four different weeks.",
  },
  "glow-up": {
    emoji: "📈",
    name: "Glow Up",
    hint: "Beat your own previous quiz score by 20 points or more.",
  },
  yapper: {
    emoji: "💬",
    name: "Yapper",
    hint: "Twenty-five comments. You keep the class talking.",
  },
  "triple-digits": {
    emoji: "💯",
    name: "Triple Digits",
    hint: "One hundred points in this class.",
  },

  /* ── the hard tier ──────────────────────────────────────────────────────
     Everything above can be had in a good fortnight. These are meant to be
     rare enough that holding one says something — each needs either a long
     run of consistency or a result nobody manages by accident. They are
     deliberately not purchasable with effort alone in a single week. */

  "no-notes": {
    emoji: "🧠",
    name: "No Notes",
    hint: "Full marks on three different quizzes.",
    rare: true,
  },
  "cracked": {
    emoji: "🦾",
    name: "Cracked",
    hint: "Ten submissions in a row, every one before the deadline.",
    rare: true,
  },
  "no-off-season": {
    emoji: "🏃",
    name: "No Off Season",
    hint: "Earned points in ten different weeks. You never really stop.",
    rare: true,
  },
  dynasty: {
    emoji: "🏛️",
    name: "Dynasty",
    hint: "Top of the weekly leaderboard three times.",
    rare: true,
  },
  "goated": {
    emoji: "🐐",
    name: "GOATed",
    hint: "Five hundred points in one class.",
    rare: true,
  },
  // Replaces a "finished every coding exercise" badge, which said nothing that
  // Full Send did not already say. Breadth is the thing nothing else here
  // rewards: it is entirely possible to top the table on assignments alone and
  // never once turn up to a Short or answer anybody in the forum.
  "all-rounder": {
    emoji: "🎛️",
    name: "All-Rounder",
    hint: "Earned points five different ways — work, quizzes, code, the room and the forum.",
    rare: true,
  },

  /* ── the room, and the table ─────────────────────────────────────────── */

  "spoke-up": {
    emoji: "🕊️",
    name: "Spoke Up",
    hint: "Left anonymous feedback for the class. Nobody sees who — not even us.",
  },
  "bug-bounty": {
    emoji: "🐛",
    name: "Bug Bounty",
    hint: "Reported something broken and an admin confirmed it was real.",
  },
  exterminator: {
    emoji: "🪳",
    name: "Exterminator",
    hint: "Five confirmed bug reports. The software is better because of you.",
    rare: true,
  },
  "opened-the-floor": {
    emoji: "🗣️",
    name: "Opened The Floor",
    hint: "Started three discussions in the class forum.",
  },
  "went-viral": {
    emoji: "🔥",
    name: "Went Viral",
    hint: "Started a discussion that drew twenty replies.",
    rare: true,
  },
  "always-in-the-room": {
    emoji: "🙋",
    name: "Always In The Room",
    hint: "Joined in on ten live Shorts.",
  },
  "quickest-hands": {
    emoji: "🏹",
    name: "Quickest Hands",
    hint: "First correct answer on a Short slide.",
  },
  "podium": {
    emoji: "🏅",
    name: "Podium",
    hint: "Top three on the all-time leaderboard.",
    rare: true,
  },
  "undisputed": {
    emoji: "🏆",
    name: "Undisputed",
    hint: "Number one on the all-time leaderboard, with the class at full strength.",
    rare: true,
  },
};

const describeBadge = (id) => ({ id, ...(BADGES[id] || { emoji: "🏅", name: id, hint: "" }) });

/* ──────────────────────────────── awarding ────────────────────────────── */

/**
 * Records an award, or does nothing if it has already been recorded.
 *
 * The duplicate key error *is* the check. Reading first and then writing leaves
 * a window where two requests both find nothing and both insert — which for a
 * "first in the class" badge is precisely the case that matters.
 *
 * @returns {Promise<boolean>} whether this call was the one that awarded it
 */
async function award({
  classId,
  studentId,
  studentName,
  kind,
  points,
  reason,
  refId = null,
  session = "",
  at = new Date(),
}) {
  // Two deliberate non-checks here.
  //
  // `classId` may be null: something earned outside any class — a confirmed
  // platform bug — has no class to credit, and is invisible to every
  // leaderboard precisely because they all match a specific class.
  //
  // `points` is checked against null rather than for truthiness: a zero-point
  // row is a legitimate record of something that happened (winning a week)
  // without moving anybody's total.
  if (!studentId || points === null || points === undefined) return false;
  try {
    await LmPoints.create({
      classId,
      studentId,
      studentName,
      kind,
      points,
      reason,
      refId,
      session,
      weekKey: weekKeyOf(at),
      created_at: at,
    });
    return true;
  } catch (error) {
    // 11000 is the idempotency rule doing its job, not a failure.
    if (error.code !== 11000) {
      console.error("[LearningModule] award failed:", error.message);
    }
    return false;
  }
}

/** Grants a badge once. Same reasoning as `award`. */
async function grantBadge({ classId, studentId, studentName, badge, detail = "", session = "" }) {
  if (!classId || !studentId || !BADGES[badge]) return false;
  try {
    await LmBadge.create({ classId, studentId, studentName, badge, detail, session });
    return true;
  } catch (error) {
    if (error.code !== 11000) {
      console.error("[LearningModule] badge failed:", error.message);
    }
    return false;
  }
}

/* ───────────────────────────── the criteria ───────────────────────────── */

const totalFor = async (classId, studentId) => {
  const [row] = await LmPoints.aggregate([
    { $match: { classId: asId(classId), studentId: asId(studentId) } },
    { $group: { _id: null, points: { $sum: "$points" } } },
  ]);
  return row?.points || 0;
};

/**
 * The badges that depend only on a running total or a count, checked after
 * every award. Cheap enough to run each time; each one is a single aggregate.
 *
 * Exported as well as used internally: it is the "reconsider this student's
 * standing" operation, which is what a backfill over existing classes would
 * need, and what the tests drive directly rather than through six controllers.
 */
async function checkStandingBadges({ classId, studentId, studentName, session = "" }) {
  const [points, weeks, comments, kinds] = await Promise.all([
    totalFor(classId, studentId),
    LmPoints.distinct("weekKey", { classId, studentId }),
    LmPoints.countDocuments({ classId, studentId, kind: "comment" }),
    LmPoints.distinct("kind", { classId, studentId }),
  ]);

  if (points >= 100) {
    await grantBadge({ classId, studentId, studentName, session, badge: "triple-digits", detail: `${points} points` });
  }
  if (weeks.length >= 4) {
    await grantBadge({
      classId,
      studentId,
      studentName,
      badge: "no-days-off",
      detail: `Active in ${weeks.length} weeks`,
    });
  }
  if (comments >= 25) {
    await grantBadge({ classId, studentId, studentName, session, badge: "yapper", detail: `${comments} comments` });
  }

  // The hard tier, on the same two counters. Checked here rather than in their
  // own pass because they are the same aggregates already in hand.
  if (points >= 500) {
    await grantBadge({ classId, studentId, studentName, session, badge: "goated", detail: `${points} points` });
  }
  if (weeks.length >= 10) {
    await grantBadge({
      classId,
      studentId,
      studentName,
      badge: "no-off-season",
      detail: `Active in ${weeks.length} weeks`,
    });
  }
  if (kinds.length >= 5) {
    await grantBadge({
      classId,
      studentId,
      studentName,
      badge: "all-rounder",
      detail: `${kinds.length} different kinds of activity`,
    });
  }
}

/* ──────────────────────────── the earning events ──────────────────────── */

/**
 * Every entry point below is fire-and-forget from the caller's side and
 * swallows its own errors — see the note at the top of the file. They are
 * `await`ed inside so the badge checks see the points that were just written.
 */
const safely = async (fn) => {
  try {
    await fn();
  } catch (error) {
    console.error("[LearningModule] gamification:", error.message);
  }
};

/**
 * Who earned it, and in which session.
 *
 * The session rides along here rather than being looked up per award: every
 * entry point already has , and the class is the authority on
 * which session it belongs to.
 */
/**
 * Who earned it, and in which academic session.
 *
 * The session rides along here rather than being looked up per award: every
 * entry point already holds `req.lmClass`, and the class is the authority on
 * which session it belongs to. Spreading `...who` therefore carries it into
 * every `award` and `grantBadge` call without each one remembering to.
 */
const actor = (req) => ({
  studentId: req.lmUser.id,
  studentName: req.lmUser.name,
  session: req.lmClass?.session || "",
});

/** Coursework turned in. `postedAt` drives the Speedrun badge. */
const onSubmission = ({ req, coursework, late, at = new Date() }) =>
  safely(async () => {
    const classId = req.lmClass._id;
    const who = actor(req);

    const granted = await award({
      classId,
      ...who,
      kind: "submission",
      points: late ? POINTS.submissionLate : POINTS.submissionOnTime,
      reason: `Turned in "${coursework.title}"${late ? " (late)" : ""}`,
      refId: coursework._id,
      at,
    });
    // Everything below is about *this* submission, so a repeat pays for none of
    // it — which is also what stops un-submitting and re-submitting farming.
    if (!granted) return;

    const posted = coursework.publishedAt || coursework.created_at;
    if (posted && at - new Date(posted) <= 60 * 60 * 1000) {
      await grantBadge({ classId, ...who, badge: "speedrun", detail: `"${coursework.title}"` });
    }

    // First in the class. The unique index settles a tie between two students
    // submitting in the same instant; whoever's insert lands first holds it.
    const earlier = await LmPoints.countDocuments({
      classId,
      kind: "submission",
      refId: coursework._id,
      studentId: { $ne: req.lmUser.id },
    });
    if (earlier === 0) {
      await grantBadge({ classId, ...who, badge: "first-dibs", detail: `"${coursework.title}"` });
    }

    if (!late) await checkStreak({ classId, ...who });
    await checkStandingBadges({ classId, ...who });
  });

/**
 * Five on-time submissions in a row.
 *
 * Read off the ledger rather than kept as a counter: a counter would have to be
 * reset by the late submission that breaks the streak, and nothing pays points
 * for being late-and-therefore-resetting-something.
 */
async function checkStreak({ classId, studentId, studentName, session = "" }) {
  const recent = await LmPoints.find({ classId, studentId, kind: { $in: ["submission", "notebook"] } })
    .sort({ created_at: -1 })
    .limit(10)
    .select("reason")
    .lean();

  const onTime = (row) => !/\(late\)/.test(row.reason);

  if (recent.length >= 5 && recent.slice(0, 5).every(onTime)) {
    await grantBadge({ classId, studentId, studentName, session, badge: "locked-in", detail: "5 on time in a row" });
  }
  if (recent.length >= 10 && recent.every(onTime)) {
    await grantBadge({ classId, studentId, studentName, session, badge: "cracked", detail: "10 on time in a row" });
  }
}

/** A quiz submitted. `percent` drives the score bonus and two badges. */
const onQuizSubmitted = ({ req, quiz, percent, at = new Date() }) =>
  safely(async () => {
    const classId = req.lmClass._id;
    const who = actor(req);

    const granted = await award({
      classId,
      ...who,
      kind: "quiz",
      points: POINTS.quizAttempt + POINTS.quizScoreBonus(percent),
      reason: `Sat "${quiz.title}" — ${Math.round(percent || 0)}%`,
      refId: quiz._id,
      at,
    });
    if (!granted) return;

    if (percent >= 100) {
      await grantBadge({ classId, ...who, badge: "understood-the-assignment", detail: `"${quiz.title}"` });

      // Three of them. Counted off the ledger's own reasons rather than a
      // separate tally, so it stays true if points are ever recalculated.
      const perfect = await LmPoints.countDocuments({
        classId,
        studentId: req.lmUser.id,
        kind: "quiz",
        reason: /— 100%$/,
      });
      if (perfect >= 3) {
        await grantBadge({ classId, ...who, badge: "no-notes", detail: `${perfect} perfect papers` });
      }
    }

    // Improvement against their own last quiz in this class, which is the only
    // comparison that means anything — everyone starts somewhere different.
    const previous = await LmPoints.find({ classId, studentId: req.lmUser.id, kind: "quiz" })
      .sort({ created_at: -1 })
      .limit(2)
      .select("reason")
      .lean();
    const before = Number(String(previous[1]?.reason || "").match(/(\d+)%/)?.[1]);
    if (Number.isFinite(before) && percent - before >= 20) {
      await grantBadge({
        classId,
        ...who,
        badge: "glow-up",
        detail: `${Math.round(before)}% → ${Math.round(percent)}%`,
      });
    }

    await checkStandingBadges({ classId, ...who });
  });

/** A coding exercise submitted. `completed` is every cell run, none erroring. */
const onNotebookSubmitted = ({ req, notebook, late, completed, at = new Date() }) =>
  safely(async () => {
    const classId = req.lmClass._id;
    const who = actor(req);

    const granted = await award({
      classId,
      ...who,
      kind: "notebook",
      points:
        (late ? POINTS.notebookLate : POINTS.notebookOnTime) + (completed ? POINTS.notebookCompleted : 0),
      reason: `Submitted "${notebook.title}"${late ? " (late)" : ""}`,
      refId: notebook._id,
      at,
    });
    if (!granted) return;

    if (completed) {
      await grantBadge({ classId, ...who, badge: "full-send", detail: `"${notebook.title}"` });
    }
    if (!late) await checkStreak({ classId, ...who });
    await checkStandingBadges({ classId, ...who });
  });

const onTutorialSubmitted = ({ req, tutorial, at = new Date() }) =>
  safely(async () => {
    const classId = req.lmClass._id;
    const who = actor(req);
    const granted = await award({
      classId,
      ...who,
      kind: "tutorial",
      points: POINTS.tutorial,
      reason: `Worked through "${tutorial.title}"`,
      refId: tutorial._id,
      at,
    });
    if (granted) await checkStandingBadges({ classId, ...who });
  });

/**
 * Answering in a live Short.
 *
 * Keyed on the *session*, not the slide: a deck of fifteen questions should be
 * worth turning up for, not fifteen times as much as handing in an assignment.
 */
const onShortAnswer = ({
  classId,
  studentId,
  studentName,
  // The live Short's own session document. Named apart from `session` — the
  // *academic* session everything else here means — because one collision
  // between the two would file a term's points under a Short's id.
  shortSession,
  session = "",
  firstCorrect = false,
  at = new Date(),
}) =>
  safely(async () => {
    if (!studentId) return; // guests have nowhere to put points
    const who = { studentId, studentName, session };
    const title = shortSession?.title || "a live Short";

    // Not gated on the award: being first to a *slide* can happen on any slide
    // of a deck already paid for.
    if (firstCorrect) {
      await grantBadge({ classId, ...who, badge: "quickest-hands", detail: `"${title}"` });
    }

    const granted = await award({
      classId,
      ...who,
      kind: "short",
      points: POINTS.shortAnswer,
      reason: `Joined in "${title}"`,
      refId: shortSession?._id,
      at,
    });
    if (!granted) return;

    // One row per Short session, so this counts decks rather than answers.
    const decks = await LmPoints.countDocuments({ classId, studentId, kind: "short" });
    if (decks >= 10) {
      await grantBadge({
        classId,
        ...who,
        badge: "always-in-the-room",
        detail: `${decks} live Shorts`,
      });
    }
    await checkStandingBadges({ classId, ...who });
  });

/**
 * Anonymous feedback left.
 *
 * Paid like everything else, with one deliberate difference: the ledger row
 * says "Took part in the class" rather than naming feedback.
 *
 * That is not decoration. `my-points` shows a student their own history, and a
 * teacher reading a total beside a timestamp is one correlation away from
 * knowing who left what — in a class of twenty, points appearing seconds after
 * feedback arrives is close to a name. The generic reason removes the label;
 * it does not remove the timing, which is the part that cannot be fixed while
 * also crediting the work immediately. Worth knowing before this ships to a
 * small cohort.
 *
 * `refId` is the class, so it pays once per class however much feedback is
 * left — otherwise the leaderboard would count how often somebody complains.
 */
const onFeedback = ({ classId, studentId, studentName }) =>
  safely(async () => {
    if (!studentId) return;
    await grantBadge({ classId, studentId, studentName, session, badge: "spoke-up" });
    const granted = await award({
      classId,
      studentId,
      studentName,
      kind: "bonus",
      points: POINTS.feedback,
      reason: "Took part in the class",
      refId: stableRef(`feedback:${classId}`),
    });
    if (granted) await checkStandingBadges({ classId, studentId, studentName });
  });

/**
 * A bug report an admin has confirmed is real.
 *
 * Two things are deliberate here.
 *
 * The points carry **no class** when the report named none — a platform bug is
 * not participation in anybody's subject, and crediting it to a class would put
 * it on that class's leaderboard where it does not belong. It still counts on
 * the reporter's own profile, which totals everything they have done.
 *
 * The badge, by contrast, needs a class to live in — badges are per-class — so
 * it is only granted when the report named one. Everyone still gets the points.
 *
 * Called with the reporter rather than a request: the acknowledging admin is
 * not the person being paid.
 */
const onBugAcknowledged = ({ report }) =>
  safely(async () => {
    const who = {
      studentId: report.reporterId,
      studentName: report.reporterName,
      session: report.session || "",
    };

    const granted = await award({
      classId: report.classId || null,
      ...who,
      kind: "bonus",
      points: POINTS.bugReport,
      reason: `Reported a bug: "${report.title}"`,
      refId: report._id,
    });
    if (!granted) return;

    if (report.classId) {
      await grantBadge({ classId: report.classId, ...who, badge: "bug-bounty", detail: report.title });

      const confirmed = await LmPoints.countDocuments({
        studentId: report.reporterId,
        kind: "bonus",
        reason: /^Reported a bug: /,
      });
      if (confirmed >= 5) {
        await grantBadge({
          classId: report.classId,
          ...who,
          badge: "exterminator",
          detail: `${confirmed} confirmed reports`,
        });
      }
      await checkStandingBadges({ classId: report.classId, ...who });
    }
  });

/** A forum topic opened. Rationed to one a week by the model's own index. */
const onDiscussion = ({ req, discussion, at = new Date() }) =>
  safely(async () => {
    const classId = req.lmClass._id;
    const who = actor(req);
    if (req.lmIsTeacher) return; // staff run the forum, they do not score in it

    const granted = await award({
      classId,
      ...who,
      kind: "comment",
      points: POINTS.discussion,
      reason: `Started "${discussion.title}"`,
      refId: discussion._id,
      at,
    });
    if (!granted) return;

    const started = await LmPoints.countDocuments({
      classId,
      studentId: req.lmUser.id,
      kind: "comment",
      reason: /^Started "/,
    });
    if (started >= 3) {
      await grantBadge({
        classId,
        ...who,
        badge: "opened-the-floor",
        detail: `${started} discussions started`,
      });
    }
    await checkStandingBadges({ classId, ...who });
  });

/**
 * A forum topic withdrawn or removed — undoes the points `onDiscussion` paid,
 * if any were paid. Deleting the ledger row rather than leaving it standing:
 * the discussion itself no longer exists for anyone to see, so a leaderboard
 * entry claiming credit for it would be a total nobody could explain, which is
 * the one thing the ledger design promises never to be. Freeing the `refId`
 * this way is also safe — a discussion, once removed, cannot be un-removed to
 * earn it again.
 */
const onDiscussionRemoved = ({ discussion }) =>
  safely(async () => {
    await LmPoints.deleteOne({
      classId: discussion.classId,
      studentId: discussion.authorId,
      kind: "comment",
      refId: discussion._id,
    });

    // "Opened The Floor" is earned at three started discussions still on the
    // board; removing one can take the count back under that line, and a
    // badge nobody can reproduce from the profile that supposedly earned it
    // is worse than not having it.
    const started = await LmPoints.countDocuments({
      classId: discussion.classId,
      studentId: discussion.authorId,
      kind: "comment",
      reason: /^Started "/,
    });
    if (started < 3) {
      await LmBadge.deleteOne({
        classId: discussion.classId,
        studentId: discussion.authorId,
        badge: "opened-the-floor",
      });
    }

    // "Went Viral" is earned by one specific discussion, and there is only
    // ever one on a student's record (the badge index is unique per
    // classId+studentId+badge) — so if it exists and its frozen detail names
    // *this* thread, it goes with it rather than outliving the thread it was
    // about.
    const viral = await LmBadge.findOne({
      classId: discussion.classId,
      studentId: discussion.authorId,
      badge: "went-viral",
    }).lean();
    if (viral && viral.detail.startsWith(`"${discussion.title}" — `)) {
      await LmBadge.deleteOne({ _id: viral._id });
    }
  });

/**
 * A thread of somebody's reached twenty replies.
 *
 * Awarded to the *author*, not the replier — the badge is for having asked
 * something the class wanted to talk about.
 */
const onDiscussionPopular = ({ classId, discussion }) =>
  safely(async () => {
    if (discussion.replyCount < 20) return;
    await grantBadge({
      classId,
      studentId: discussion.authorId,
      studentName: discussion.authorName,
      badge: "went-viral",
      detail: `"${discussion.title}" — ${discussion.replyCount} replies`,
    });
  });

/** A comment, capped daily so the cheapest points cannot be farmed. */
const onComment = ({ req, comment, at = new Date() }) =>
  safely(async () => {
    const classId = req.lmClass._id;
    const who = actor(req);

    const since = new Date(at);
    since.setHours(0, 0, 0, 0);
    const today = await LmPoints.countDocuments({
      classId,
      studentId: req.lmUser.id,
      kind: "comment",
      created_at: { $gte: since },
    });
    if (today >= COMMENT_DAILY_CAP) return;

    const granted = await award({
      classId,
      ...who,
      kind: "comment",
      points: POINTS.comment,
      reason: "Joined a discussion",
      refId: comment._id,
      at,
    });
    if (granted) await checkStandingBadges({ classId, ...who });
  });

/* ─────────────────────────────── reading ──────────────────────────────── */

/**
 * The table. `weekKey` narrows it to one week; omitted, it is all time.
 *
 * Ties break on who got there first — the same score reached earlier is the
 * better run, and a stable order matters more than the tiebreak being clever.
 */
async function leaderboard({ classId, weekKey = null, limit = 50 }) {
  const rows = await LmPoints.aggregate([
    { $match: { classId: asId(classId), ...(weekKey ? { weekKey } : {}) } },
    {
      $group: {
        _id: "$studentId",
        points: { $sum: "$points" },
        studentName: { $last: "$studentName" },
        lastAt: { $max: "$created_at" },
        awards: { $sum: 1 },
      },
    },
    { $sort: { points: -1, lastAt: 1 } },
    { $limit: limit },
  ]);

  return rows.map((row, index) => ({
    rank: index + 1,
    studentId: row._id,
    studentName: row.studentName || "Someone",
    points: row.points,
    awards: row.awards,
  }));
}

/** One student's standing, for their own class card. */
async function standingFor({ classId, studentId }) {
  const [points, weekly, badges] = await Promise.all([
    totalFor(classId, studentId),
    LmPoints.aggregate([
      { $match: { classId: asId(classId), studentId: asId(studentId), weekKey: weekKeyOf() } },
      { $group: { _id: null, points: { $sum: "$points" } } },
    ]),
    LmBadge.find({ classId, studentId }).sort({ earnedAt: -1 }).lean(),
  ]);

  return {
    points,
    weeklyPoints: weekly[0]?.points || 0,
    badges: badges.map((row) => ({ ...describeBadge(row.badge), detail: row.detail, earnedAt: row.earnedAt })),
  };
}

/**
 * Where one student's total in a class actually came from.
 *
 * The split and the rows come from the same collection in one round trip, so
 * the two can never disagree — a breakdown that did not add up to the number
 * on the leaderboard would be worse than no breakdown at all.
 *
 * Kinds with nothing in them are absent rather than zeroed: the caller knows
 * the full set of kinds and can decide whether an unused one is worth drawing.
 */
async function breakdownFor({ classId, studentId, historyLimit = 50 }) {
  const [byKind, history] = await Promise.all([
    LmPoints.aggregate([
      { $match: { classId: asId(classId), studentId: asId(studentId) } },
      {
        $group: {
          _id: "$kind",
          points: { $sum: "$points" },
          awards: { $sum: 1 },
          lastAt: { $max: "$created_at" },
        },
      },
      { $sort: { points: -1 } },
    ]),
    LmPoints.find({ classId, studentId })
      .sort({ created_at: -1 })
      .limit(historyLimit)
      .select("kind points reason studentName created_at")
      .lean(),
  ]);

  return {
    byKind: byKind.map((row) => ({
      kind: row._id,
      points: row.points,
      awards: row.awards,
      lastAt: row.lastAt,
    })),
    history,
    // Denormalised on the ledger, so the caller does not have to hold the
    // roster open just to put a name on the panel.
    studentName: history[0]?.studentName || "",
  };
}

/**
 * Crowns last week's winner.
 *
 * Run lazily when the leaderboard is read rather than on a timer, the same way
 * the stream releases scheduled posts: a cron for one badge a week is a moving
 * part nobody would remember exists.
 */
async function crownLastWeek(classId) {
  const lastWeek = weekKeyOf(new Date(Date.now() - 7 * 864e5));
  const [top] = await leaderboard({ classId, weekKey: lastWeek, limit: 1 });
  if (!top || !top.points) return;

  const week = weekStartOf(lastWeek).toISOString().slice(0, 10);
  await grantBadge({
    classId,
    studentId: top.studentId,
    studentName: top.studentName,
    badge: "main-character",
    detail: `Top of the table, week of ${week}`,
  });

  /**
   * Three weekly wins.
   *
   * `main-character` is granted once and then never again, so it cannot count
   * the wins — a ledger row does. Recording the win as a zero-point award
   * keeps the tally in the one place that is already idempotent per week: a
   * second read of the leaderboard in the same week cannot inflate it.
   */
  const recorded = await award({
    classId,
    studentId: top.studentId,
    studentName: top.studentName,
    kind: "bonus",
    // Zero: a record of the win, not a payout. Crediting the previous week's
    // winner into the current week would let one good week compound into the
    // next, which is the opposite of what a weekly reset is for.
    points: 0,
    reason: `Won the week of ${week}`,
    refId: stableRef(`week-win:${lastWeek}`),
  });
  if (!recorded) return;

  const wins = await LmPoints.countDocuments({
    classId,
    studentId: top.studentId,
    kind: "bonus",
    reason: /^Won the week of /,
  });
  if (wins >= 3) {
    await grantBadge({
      classId,
      studentId: top.studentId,
      studentName: top.studentName,
      badge: "dynasty",
      detail: `${wins} weekly wins`,
    });
  }
}

/**
 * Badges for standing on the all-time table.
 *
 * Both need a table worth standing on. `MIN_RANKED` keeps them from being
 * handed to the first person who submits anything in a class of one — a podium
 * with nobody else on it is not a podium, and a badge that arrives that easily
 * devalues every copy of it in every other class.
 *
 * Once granted they are kept, even if the holder is later overtaken. A badge
 * records something that happened; taking it back would make the whole set
 * provisional and unscreenshottable, which is most of the point of having one.
 */
const MIN_RANKED = 5;

async function checkOverallBadges(classId) {
  const rows = await leaderboard({ classId, limit: MIN_RANKED });
  if (rows.length < MIN_RANKED) return;

  await Promise.all(
    rows.slice(0, 3).map((row, index) =>
      grantBadge({
        classId,
        studentId: row.studentId,
        studentName: row.studentName,
        badge: index === 0 ? "undisputed" : "podium",
        detail: `#${index + 1} of ${rows.length}+ on the all-time table`,
      }).then(() =>
        // First place earns both — the podium is where they are standing.
        index === 0
          ? grantBadge({
              classId,
              studentId: row.studentId,
              studentName: row.studentName,
              badge: "podium",
              detail: "#1 of the all-time table",
            })
          : null,
      ),
    ),
  );
}

/**
 * What a teacher needs from this page, which is not a table they are not on.
 *
 * A leaderboard answers "am I winning". Staff are asking something else — is
 * the class engaged, who has gone quiet, and where the points are actually
 * coming from. So they get totals, a breakdown by activity, and the tail of the
 * table rather than its head.
 */
async function classSummary(classId) {
  const id = asId(classId);
  const thisWeek = weekKeyOf();

  const [byKind, totals, weekly, badgeSpread, quietest] = await Promise.all([
    // Where the points came from, which is the quickest read on what the class
    // actually engages with.
    LmPoints.aggregate([
      { $match: { classId: id } },
      { $group: { _id: "$kind", points: { $sum: "$points" }, awards: { $sum: 1 } } },
      { $sort: { points: -1 } },
    ]),
    LmPoints.aggregate([
      { $match: { classId: id } },
      {
        $group: {
          _id: null,
          points: { $sum: "$points" },
          awards: { $sum: 1 },
          students: { $addToSet: "$studentId" },
        },
      },
    ]),
    LmPoints.aggregate([
      { $match: { classId: id, weekKey: thisWeek } },
      { $group: { _id: null, points: { $sum: "$points" }, students: { $addToSet: "$studentId" } } },
    ]),
    LmBadge.aggregate([
      { $match: { classId: id } },
      { $group: { _id: "$badge", holders: { $sum: 1 } } },
      { $sort: { holders: -1 } },
    ]),
    // The bottom of the table, which is the part a teacher can do something
    // about. Ascending, so it is the people to go and talk to.
    LmPoints.aggregate([
      { $match: { classId: id } },
      { $group: { _id: "$studentId", studentName: { $last: "$studentName" }, points: { $sum: "$points" } } },
      { $sort: { points: 1 } },
      { $limit: 5 },
    ]),
  ]);

  const total = totals[0] || { points: 0, awards: 0, students: [] };

  return {
    totalPoints: total.points,
    totalAwards: total.awards,
    earningStudents: (total.students || []).length,
    weeklyPoints: weekly[0]?.points || 0,
    weeklyActiveStudents: (weekly[0]?.students || []).length,
    byKind: byKind.map((row) => ({ kind: row._id, points: row.points, awards: row.awards })),
    badges: badgeSpread.map((row) => ({ ...describeBadge(row._id), holders: row.holders })),
    quietest: quietest.map((row) => ({
      studentId: row._id,
      studentName: row.studentName || "Someone",
      points: row.points,
    })),
  };
}

/**
 * A student's whole record, grouped by academic session.
 *
 * The reason `session` is copied onto every row rather than derived: this is
 * one aggregate over the ledger instead of loading every class the student has
 * ever been in to read one string off each.
 *
 * Sessions sort newest first — the current term is what somebody opens their
 * profile to see, and last year is history. A blank session (rows written
 * before the field existed, and anything earned outside a class) collects under
 * its own heading rather than being hidden or invented.
 */
async function profileFor(studentId) {
  const id = asId(studentId);

  const [points, badges] = await Promise.all([
    LmPoints.aggregate([
      { $match: { studentId: id } },
      {
        $group: {
          _id: { session: "$session", classId: "$classId" },
          points: { $sum: "$points" },
          awards: { $sum: 1 },
          lastAt: { $max: "$created_at" },
        },
      },
    ]),
    LmBadge.find({ studentId: id }).sort({ earnedAt: -1 }).lean(),
  ]);

  const bySession = new Map();
  const bucket = (session) => {
    const key = session || "";
    if (!bySession.has(key)) {
      bySession.set(key, { session: key, points: 0, awards: 0, classes: [], badges: [] });
    }
    return bySession.get(key);
  };

  points.forEach((row) => {
    const entry = bucket(row._id.session);
    entry.points += row.points;
    entry.awards += row.awards;
    entry.classes.push({
      classId: row._id.classId,
      points: row.points,
      awards: row.awards,
      lastAt: row.lastAt,
    });
  });

  badges.forEach((row) => {
    bucket(row.session).badges.push({
      ...describeBadge(row.badge),
      classId: row.classId,
      detail: row.detail,
      earnedAt: row.earnedAt,
    });
  });

  const sessions = [...bySession.values()].sort((a, b) => {
    // Unrecorded last, whatever it sorts as alphabetically.
    if (!a.session) return 1;
    if (!b.session) return -1;
    return b.session.localeCompare(a.session);
  });
  sessions.forEach((entry) => entry.classes.sort((a, b) => b.points - a.points));

  return {
    sessions,
    totalPoints: sessions.reduce((sum, entry) => sum + entry.points, 0),
    totalBadges: badges.length,
  };
}

module.exports = {
  BADGES,
  MIN_RANKED,
  profileFor,
  onBugAcknowledged,
  classSummary,
  checkOverallBadges,
  onFeedback,
  POINTS,
  COMMENT_DAILY_CAP,
  weekKeyOf,
  weekStartOf,
  describeBadge,
  award,
  checkStandingBadges,
  grantBadge,
  leaderboard,
  standingFor,
  breakdownFor,
  crownLastWeek,
  onSubmission,
  onQuizSubmitted,
  onNotebookSubmitted,
  onTutorialSubmitted,
  onShortAnswer,
  onComment,
  onDiscussion,
  onDiscussionRemoved,
  onDiscussionPopular,
};
