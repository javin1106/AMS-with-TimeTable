const crypto = require('crypto');

/**
 * The rules of a quiz sitting, kept out of the controller so they can be tested
 * without a database or an HTTP request.
 *
 * Covers paper construction (shuffling, option ordering, per-student draw),
 * answer marking for all five question types, negative marking, section
 * roll-ups, and the window checks that decide whether a student may start.
 */

/* ────────────────────────── deterministic shuffling ───────────────────────── */

/** mulberry32 — same generator the tutorial variants use. */
function makeRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFor(...parts) {
  return crypto.createHash('sha256').update(parts.join('|')).digest().readUInt32BE(0);
}

/** Fisher-Yates against a supplied RNG, so a shuffle is reproducible. */
function shuffle(items, rng) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Builds the paper for one student.
 *
 * Section order is always preserved — shuffling questions inside a section is
 * fine, but moving a question from section 3 into section 1 would break the
 * section timings and the student's mental model of the paper.
 *
 * @returns {{questionOrder: string[], optionOrder: object, maxScore: number}}
 */
function buildPaper(quiz, studentId, attemptNumber = 1) {
  const rng = makeRng(seedFor(String(quiz._id), String(studentId), String(attemptNumber)));
  const settings = quiz.settings || {};
  const questions = [...(quiz.questions || [])];

  // Group by section so shuffling stays within each one.
  const sectionRank = new Map(
    (quiz.sections || [])
      .slice()
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((section, index) => [String(section._id), index]),
  );
  const rankOf = (question) =>
    question.sectionId ? sectionRank.get(String(question.sectionId)) ?? 9999 : 9999;

  const groups = new Map();
  questions.forEach((question) => {
    const key = rankOf(question);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(question);
  });

  let ordered = [];
  [...groups.keys()]
    .sort((a, b) => a - b)
    .forEach((key) => {
      const group = groups.get(key).sort((a, b) => (a.order || 0) - (b.order || 0));
      ordered = ordered.concat(settings.shuffleQuestions ? shuffle(group, rng) : group);
    });

  // Per-student draw: take a random subset, keeping the ordering above.
  const draw = settings.questionsPerAttempt || 0;
  if (draw > 0 && draw < ordered.length) {
    const picked = new Set(shuffle(ordered, rng).slice(0, draw).map((q) => String(q._id)));
    ordered = ordered.filter((question) => picked.has(String(question._id)));
  }

  const optionOrder = {};
  if (settings.shuffleOptions) {
    ordered.forEach((question) => {
      // True/False must stay in its conventional order; shuffling it only
      // confuses the reader without adding any anti-copying value.
      if (question.type === 'truefalse' || !(question.options || []).length) return;
      const indices = question.options.map((_, index) => index);
      optionOrder[String(question._id)] = shuffle(indices, rng);
    });
  }

  return {
    questionOrder: ordered.map((question) => question._id),
    optionOrder,
    maxScore: ordered.reduce((sum, question) => sum + (question.marks || 0), 0),
  };
}

/* ──────────────────────────── student-safe views ─────────────────────────── */

/**
 * A question as the student should receive it: no answer key, no explanation,
 * and options permuted into their personal order.
 */
function questionForStudent(question, optionOrder) {
  const order = optionOrder && optionOrder.length ? optionOrder : null;
  const options = order
    ? order.map((originalIndex) => question.options[originalIndex])
    : question.options;

  return {
    _id: question._id,
    question: question.question,
    type: question.type,
    options,
    // The client sends back positions in the list it was shown; the mapping
    // back to original indices happens server-side in normaliseSelected().
    marks: question.marks,
    negativeMarks: question.negativeMarks,
    difficulty: question.difficulty,
    topic: question.topic,
    timeLimitSec: question.timeLimitSec || 0,
    sectionId: question.sectionId,
    sectionName: question.sectionName,
  };
}

/**
 * Translates the option positions a student clicked into original indices.
 * Without this, marking a shuffled paper would compare against the wrong slots.
 */
function normaliseSelected(selected, optionOrder) {
  const picked = (selected || []).map(String);
  if (!optionOrder || !optionOrder.length) return picked;
  return picked
    .map((shownIndex) => {
      const position = Number(shownIndex);
      return Number.isInteger(position) && position >= 0 && position < optionOrder.length
        ? String(optionOrder[position])
        : null;
    })
    .filter((value) => value !== null);
}

/* ──────────────────────────────── marking ───────────────────────────────── */

const sameSet = (a, b) => {
  const left = new Set((a || []).map(String));
  const right = new Set((b || []).map(String));
  if (left.size !== right.size) return false;
  return [...left].every((value) => right.has(value));
};

/**
 * Marks a single response.
 *
 * @param {object} question   the authored question (original option order)
 * @param {object} response   { selected: string[] (original indices), text }
 * @param {number} negativeMarks  effective penalty for a wrong answer
 */
function markAnswer(question, response, negativeMarks = 0) {
  const selected = (response?.selected || []).map(String);
  const text = String(response?.text ?? '').trim();

  const attempted = question.type === 'numerical' ? text.length > 0 : selected.length > 0;

  if (!attempted) {
    // Unattempted never attracts a penalty — that is the convention students
    // expect, and it is what makes leaving a question blank a real choice.
    return { correct: false, attempted: false, awarded: 0 };
  }

  let correct = false;

  if (question.type === 'numerical') {
    const expected = Number((question.correctAnswers || [])[0]);
    const given = Number(text);
    if (Number.isFinite(expected) && Number.isFinite(given)) {
      const allowed = Math.max(
        Number(question.toleranceAbs) || 0,
        Math.abs(expected) * ((Number(question.tolerancePercent) || 0) / 100),
      );
      correct = Math.abs(given - expected) <= allowed;
    }
  } else {
    correct = sameSet(selected, question.correctAnswers);
  }

  return {
    correct,
    attempted: true,
    awarded: correct ? question.marks || 0 : -(negativeMarks || 0),
  };
}

/**
 * Marks a whole attempt and rolls the numbers up.
 *
 * Works off `attempt.questionOrder`, so a per-student draw is scored against
 * the questions that student actually received rather than the full bank.
 */
function scoreAttempt(quiz, attempt) {
  const byId = new Map((quiz.questions || []).map((question) => [String(question._id), question]));
  const responsesById = new Map(
    (attempt.responses || []).map((response) => [String(response.questionId), response]),
  );
  const optionOrder = attempt.optionOrder instanceof Map
    ? Object.fromEntries(attempt.optionOrder)
    : attempt.optionOrder || {};

  const defaultNegative = quiz.settings?.negativeMarking || 0;
  const sections = new Map();

  let score = 0;
  let maxScore = 0;
  let totalCorrect = 0;
  let totalWrong = 0;
  let totalUnattempted = 0;
  let negativeApplied = 0;

  const marked = (attempt.questionOrder || []).map((questionId) => {
    const question = byId.get(String(questionId));
    if (!question) return null;

    const response = responsesById.get(String(questionId)) || {};
    const negative = question.negativeMarks !== null && question.negativeMarks !== undefined
      ? question.negativeMarks
      : defaultNegative;

    const result = markAnswer(question, response, negative);

    maxScore += question.marks || 0;
    score += result.awarded;
    if (result.awarded < 0) negativeApplied += Math.abs(result.awarded);
    if (!result.attempted) totalUnattempted += 1;
    else if (result.correct) totalCorrect += 1;
    else totalWrong += 1;

    const key = question.sectionId ? String(question.sectionId) : '__none';
    if (!sections.has(key)) {
      sections.set(key, {
        sectionId: question.sectionId || null,
        sectionName: question.sectionName || 'Ungrouped',
        score: 0,
        maxScore: 0,
        correct: 0,
        wrong: 0,
        unattempted: 0,
        timeSpentSec: 0,
      });
    }
    const section = sections.get(key);
    section.maxScore += question.marks || 0;
    section.score += result.awarded;
    section.timeSpentSec += response.timeSpentSec || 0;
    if (!result.attempted) section.unattempted += 1;
    else if (result.correct) section.correct += 1;
    else section.wrong += 1;

    return {
      questionId: question._id,
      selected: response.selected || [],
      text: response.text || '',
      correct: result.correct,
      attempted: result.attempted,
      awarded: result.awarded,
      timeSpentSec: response.timeSpentSec || 0,
      servedAt: response.servedAt || null,
      answeredAt: response.answeredAt || null,
      autoSubmitted: Boolean(response.autoSubmitted),
      sectionId: question.sectionId || null,
      sectionName: question.sectionName || '',
    };
  }).filter(Boolean);

  // A negatively-marked paper can go below zero; clamping keeps a bad sitting
  // from reading as a debt in the gradebook.
  const finalScore = Math.max(0, Math.round(score * 100) / 100);
  const percent = maxScore ? Math.round((finalScore / maxScore) * 1000) / 10 : 0;

  return {
    responses: marked,
    score: finalScore,
    rawScore: Math.round(score * 100) / 100,
    maxScore,
    percent,
    passed: percent >= (quiz.settings?.passPercent || 0),
    totalCorrect,
    totalWrong,
    totalUnattempted,
    negativeApplied: Math.round(negativeApplied * 100) / 100,
    sectionScores: [...sections.values()].map((section) => ({
      ...section,
      score: Math.round(section.score * 100) / 100,
    })),
    optionOrder,
  };
}

/* ──────────────────────────── window / eligibility ───────────────────────── */

/**
 * Whether the quiz has actually gone live for students.
 *
 * A publish can be dated, so the flag alone is not the answer: until `publishAt`
 * passes the quiz is published in intent only, and neither the list, the link,
 * nor a new attempt may see it. Deriving this on read rather than flipping a
 * field on a schedule means a server that was asleep at the appointed minute
 * still behaves correctly the moment it wakes.
 */
function isLive(quiz, now = new Date()) {
  if (!quiz?.published) return false;
  return !quiz.publishAt || now >= new Date(quiz.publishAt);
}

/** The same test as `isLive`, as a Mongo filter for student-facing queries. */
function liveQuizFilter(now = new Date()) {
  return { published: true, $or: [{ publishAt: null }, { publishAt: { $lte: now } }] };
}

/** When the link goes live, and whether it still lies ahead. */
function publishState(quiz, now = new Date()) {
  const at = quiz?.publishAt ? new Date(quiz.publishAt) : null;
  return {
    live: isLive(quiz, now),
    publishAt: at,
    scheduled: Boolean(quiz?.published && at && now < at),
  };
}

/**
 * Whether the quiz is open, and whether a *new* attempt may start.
 *
 * These are two different questions, which is the point of a margin window: the
 * test can still be open for people already in it while turning away anyone
 * arriving late.
 */
function windowState(quiz, now = new Date()) {
  const settings = quiz.settings || {};
  const from = settings.availableFrom ? new Date(settings.availableFrom) : null;
  const to = settings.availableTo ? new Date(settings.availableTo) : null;

  const notYetOpen = Boolean(from && now < from);
  const closed = Boolean(to && now > to);

  // An explicit cut-off wins over the relative one: a teacher who set a moment
  // meant that moment, and unlike the margin it still works on a quiz that has
  // no opening time to count from.
  let startDeadline = settings.startDeadline ? new Date(settings.startDeadline) : null;
  if (!startDeadline && from && settings.marginMinutes > 0) {
    startDeadline = new Date(from.getTime() + settings.marginMinutes * 60000);
  }
  const lateToStart = Boolean(startDeadline && now > startDeadline);

  return {
    open: !notYetOpen && !closed,
    notYetOpen,
    closed,
    canStart: !notYetOpen && !closed && !lateToStart,
    lateToStart,
    opensAt: from,
    closesAt: to,
    startDeadline,
  };
}

/** Whether marks and answers may be shown yet. */
function resultsVisible(quiz, now = new Date()) {
  const releaseAt = quiz.settings?.resultReleaseAt;
  if (!releaseAt) return true;
  return now >= new Date(releaseAt);
}

/**
 * How much slack to allow past a deadline before an answer is refused.
 *
 * A student who clicks with one second left should not lose the answer to
 * network latency, and a laptop clock a couple of seconds out should not either.
 * Small enough that it cannot be farmed: five seconds on a paper is noise, and
 * the whole-paper deadline is checked with the same slack so it cannot be
 * accumulated question by question.
 */
const DEADLINE_GRACE_MS = 5000;

/**
 * The hard end of the attempt: the paper clock and the closing time, with the
 * per-question clock deliberately excluded.
 *
 * Separate from `questionDeadline` because the two mean different things when
 * enforcing. Running out of time on one question ends that question; running out
 * of paper time ends the sitting. Treating them alike would either finalise a
 * paper the moment one question timed out, or let the paper run forever as long
 * as each question was answered promptly.
 */
function attemptDeadline(quiz, attempt) {
  const settings = quiz.settings || {};
  const candidates = [];

  if (settings.timeLimitMinutes > 0) {
    candidates.push(new Date(new Date(attempt.startedAt).getTime() + settings.timeLimitMinutes * 60000));
  }
  if (settings.availableTo) candidates.push(new Date(settings.availableTo));

  if (!candidates.length) return null;
  return new Date(Math.min(...candidates.map((date) => date.getTime())));
}

/**
 * What the server should do with a request that has just arrived on an attempt.
 *
 * The client's countdown is a courtesy — it can be paused in a debugger,
 * rewritten from the console, or simply ignored by talking to the API directly —
 * so nothing may depend on it. This is the function that decides, and every
 * handler that accepts an answer calls it.
 *
 * @returns {{deadline: Date|null, attemptExpired: boolean, questionExpired: boolean}}
 *   `attemptExpired` means the sitting is over and must be finalised.
 *   `questionExpired` means only this question's clock has run out, so the
 *   answer does not count but the paper continues.
 */
function deadlineState(quiz, attempt, question, now = new Date()) {
  const at = now instanceof Date ? now.getTime() : now;
  const hard = attemptDeadline(quiz, attempt);
  const current = questionDeadline(quiz, attempt, question, new Date(at));

  const past = (deadline) => Boolean(deadline && at > new Date(deadline).getTime() + DEADLINE_GRACE_MS);

  return {
    deadline: current,
    attemptExpired: past(hard),
    // Only meaningful when the paper itself has not run out; a caller that
    // finalises on attemptExpired never needs to look at this.
    questionExpired: !past(hard) && past(current),
  };
}

/**
 * Deadline for the question currently in front of the student, whichever of the
 * per-question clock and the whole-paper clock runs out first.
 */
function questionDeadline(quiz, attempt, question, now = new Date()) {
  const settings = quiz.settings || {};
  const candidates = [];

  if (settings.perQuestionTiming) {
    const seconds = question?.timeLimitSec || 0;
    if (seconds > 0) {
      const servedAt = attempt.currentServedAt ? new Date(attempt.currentServedAt) : now;
      candidates.push(new Date(servedAt.getTime() + seconds * 1000));
    }
  }
  // A reopened sitting runs on its own clock. Both of the candidates below are
  // in the past for the case this exists for — a paper the teacher reopened
  // after it closed — so the override replaces them rather than joining them.
  // Per-question timing above is untouched: it is measured from when *this*
  // question was served, so it is still meaningful on a resumed paper.
  if (attempt.deadlineOverride) {
    candidates.push(new Date(attempt.deadlineOverride));
  } else {
    if (settings.timeLimitMinutes > 0) {
      candidates.push(new Date(new Date(attempt.startedAt).getTime() + settings.timeLimitMinutes * 60000));
    }
    if (settings.availableTo) candidates.push(new Date(settings.availableTo));
  }

  if (!candidates.length) return null;
  return new Date(Math.min(...candidates.map((date) => date.getTime())));
}

/** Total time a paper is expected to take, for the pre-test screen. */
function estimatedDurationSec(quiz) {
  const settings = quiz.settings || {};
  if (settings.perQuestionTiming) {
    return (quiz.questions || []).reduce((sum, question) => sum + (question.timeLimitSec || 0), 0);
  }
  return (settings.timeLimitMinutes || 0) * 60;
}

const MOBILE_PATTERN = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i;

const isMobileUserAgent = (userAgent) => MOBILE_PATTERN.test(String(userAgent || ''));

module.exports = {
  makeRng,
  seedFor,
  shuffle,
  buildPaper,
  questionForStudent,
  normaliseSelected,
  markAnswer,
  scoreAttempt,
  windowState,
  isLive,
  liveQuizFilter,
  publishState,
  resultsVisible,
  questionDeadline,
  attemptDeadline,
  deadlineState,
  DEADLINE_GRACE_MS,
  estimatedDurationSec,
  isMobileUserAgent,
  sameSet,
};
