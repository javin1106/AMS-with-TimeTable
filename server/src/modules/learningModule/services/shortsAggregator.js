/**
 * Turns raw Short responses into the shape the projector renders, and marks
 * answers on slides that carry a key.
 *
 * Pure functions with no database or request access, because this is the part
 * that has to be right in front of a room: an off-by-one in a bar chart or a
 * mis-ranked list is visible to sixty people at once.
 */

/* ──────────────────────────── slide timing ────────────────────────────── */

/**
 * The state the room should actually be in right now.
 *
 * `slideState` is only written when the presenter acts, so a slide whose
 * countdown has run out is still stored as `open`. Nothing watches the clock,
 * and nothing should: a timer on the server would have to survive a restart,
 * and a timer in the presenter's browser stops when the laptop sleeps. Instead
 * every read derives the truth from `slideDeadline`, which is a stored
 * timestamp and is therefore right regardless of who happens to be awake.
 *
 * Deriving it here — rather than only persisting it — is what makes a student's
 * phone stop offering an answer the instant the clock passes, rather than
 * whenever the next write happens to land.
 *
 * @param {Date|number} [now] injectable for tests
 */
function effectiveSlideState(session, short, now = Date.now()) {
  if (!session) return 'waiting';
  if (session.slideState !== 'open') return session.slideState;
  if (!session.slideDeadline) return 'open';

  const at = now instanceof Date ? now.getTime() : now;
  if (at <= new Date(session.slideDeadline).getTime()) return 'open';

  // Same rule the presenter's own "close answering" uses, so a slide that times
  // out and one the teacher closes by hand land in the same place.
  return short?.settings?.autoRevealOnClose ? 'revealed' : 'locked';
}

/* ─────────────────────────────── marking ──────────────────────────────── */

const sameSet = (a, b) => {
  const left = new Set((a || []).map(String));
  const right = new Set((b || []).map(String));
  if (left.size !== right.size) return false;
  return [...left].every((value) => right.has(value));
};

/** A slide is only marked when the teacher gave it an answer. */
function slideIsGradable(slide) {
  if (!slide) return false;
  if (slide.type === 'numeric') return slide.correctNumber !== null && slide.correctNumber !== undefined;
  if (['mcq', 'msq', 'truefalse', 'ranking'].includes(slide.type)) {
    return (slide.correctAnswers || []).length > 0;
  }
  // Word clouds, open text and scales are opinions, not answers.
  return false;
}

/**
 * Marks one answer.
 * @returns {{correct: boolean|null, awarded: number}} correct is null when the
 *          slide is a poll rather than a question.
 */
function markResponse(slide, response) {
  if (!slideIsGradable(slide)) return { correct: null, awarded: 0 };

  const marks = slide.marks || 0;
  let correct = false;

  if (slide.type === 'numeric') {
    const given = Number(response.number);
    const expected = Number(slide.correctNumber);
    if (Number.isFinite(given) && Number.isFinite(expected)) {
      const allowed = Math.max(
        Number(slide.toleranceAbs) || 0,
        Math.abs(expected) * ((Number(slide.tolerancePercent) || 0) / 100),
      );
      correct = Math.abs(given - expected) <= allowed;
    }
  } else if (slide.type === 'ranking') {
    // Ranking is only correct as an exact sequence — order is the answer.
    const given = (response.selected || []).map(String);
    const expected = (slide.correctAnswers || []).map(String);
    correct = given.length === expected.length && given.every((value, index) => value === expected[index]);
  } else {
    correct = sameSet(response.selected, slide.correctAnswers);
  }

  return { correct, awarded: correct ? marks : 0 };
}

/* ──────────────────────────── text normalising ────────────────────────── */

// Words too common to be worth a place in a word cloud of a lecture answer.
const STOP_WORDS = new Set(
  ('the a an and or but if then of to in on at for with by from as is are was were be been being it its ' +
    'this that these those i we you they he she my our your their there here what which who whom will would ' +
    'can could should shall may might must do does did have has had not no yes so very just also more most ' +
    'some any all other such only same than too s t don now').split(' '),
);

/**
 * Word-cloud normalisation: lowercase, strip punctuation, drop stop words.
 * Deliberately does *not* stem — "matrices" and "matrix" staying separate is
 * less confusing to a room than an aggressive stemmer merging unrelated words.
 */
function normaliseWords(text, { maxWords = 3 } = {}) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^[-']+|[-']+$/g, ''))
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .slice(0, Math.max(1, maxWords));
}

/**
 * Numeric answers only. Blank answers must be filtered *before* coercing,
 * because Number(null) is 0 — which is finite, and would silently be counted
 * as somebody answering zero.
 */
const numericValues = (responses) =>
  (responses || [])
    .filter((response) => response.number !== null && response.number !== undefined && response.number !== '')
    .map((response) => Number(response.number))
    .filter((value) => Number.isFinite(value));

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const round = (value, places = 2) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/* ────────────────────────────── aggregation ───────────────────────────── */

/**
 * Builds the live result payload for one slide.
 *
 * @param {object} slide
 * @param {object[]} responses  responses to this slide only
 * @param {object} options
 * @param {boolean} options.reveal      include the answer key
 * @param {boolean} options.anonymous   omit participant names
 * @returns {object} `{ type, totalResponses, ...type-specific }`
 */
function aggregateSlide(slide, responses = [], options = {}) {
  const { reveal = false, anonymous = true } = options;
  const answered = responses.length;
  const gradable = slideIsGradable(slide);

  const base = {
    slideId: slide._id,
    type: slide.type,
    question: slide.question,
    totalResponses: answered,
    gradable,
    ...(reveal && gradable
      ? {
          correctAnswers: slide.type === 'numeric' ? [String(slide.correctNumber)] : slide.correctAnswers,
          explanation: slide.explanation || '',
          correctCount: responses.filter((response) => response.correct).length,
        }
      : {}),
  };

  switch (slide.type) {
    case 'mcq':
    case 'msq':
    case 'truefalse': {
      const counts = (slide.options || []).map((label, index) => {
        const count = responses.filter((response) =>
          (response.selected || []).map(String).includes(String(index)),
        ).length;
        return {
          index,
          label,
          count,
          // For msq the denominator is people, not selections, so the bars can
          // legitimately sum past 100%.
          percent: answered ? round((count / answered) * 100, 1) : 0,
          isCorrect: reveal && gradable ? (slide.correctAnswers || []).map(String).includes(String(index)) : undefined,
        };
      });
      return { ...base, options: counts };
    }

    case 'wordcloud': {
      const frequencies = new Map();
      responses.forEach((response) => {
        // Deduplicate within one person's answer so nobody can inflate a word
        // by repeating it.
        new Set(normaliseWords(response.text, { maxWords: slide.maxWords })).forEach((word) => {
          frequencies.set(word, (frequencies.get(word) || 0) + 1);
        });
      });
      const words = [...frequencies.entries()]
        .map(([text, count]) => ({ text, count }))
        .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
        .slice(0, 60);
      return { ...base, words, maxCount: words[0]?.count || 0 };
    }

    case 'open': {
      const entries = responses
        .filter((response) => String(response.text || '').trim())
        .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
        .map((response) => ({
          text: response.text,
          name: anonymous ? '' : response.participantName,
          at: response.created_at,
        }));
      return { ...base, entries };
    }

    case 'scale': {
      const min = Number(slide.scaleMin ?? 1);
      const max = Number(slide.scaleMax ?? 5);
      const values = numericValues(responses);

      const buckets = [];
      for (let value = min; value <= max; value += 1) {
        const count = values.filter((entry) => entry === value).length;
        buckets.push({
          value,
          count,
          percent: values.length ? round((count / values.length) * 100, 1) : 0,
        });
      }

      return {
        ...base,
        min,
        max,
        minLabel: slide.scaleMinLabel || '',
        maxLabel: slide.scaleMaxLabel || '',
        buckets,
        average: values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : null,
        median: median(values),
      };
    }

    case 'numeric': {
      const values = numericValues(responses);
      const average = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

      // Ten buckets across the observed range, which is more informative for an
      // estimate question than a fixed axis.
      const low = values.length ? Math.min(...values) : 0;
      const high = values.length ? Math.max(...values) : 0;
      const span = high - low;
      const width = span > 0 ? span / 10 : 1;
      const buckets = [];
      if (values.length) {
        for (let i = 0; i < 10; i += 1) {
          const from = low + width * i;
          const to = i === 9 ? high : from + width;
          buckets.push({
            from: round(from, 3),
            to: round(to, 3),
            count: values.filter((value) =>
              i === 9 ? value >= from && value <= to : value >= from && value < to,
            ).length,
          });
        }
      }

      return {
        ...base,
        average: average === null ? null : round(average),
        median: median(values),
        lowest: values.length ? low : null,
        highest: values.length ? high : null,
        buckets,
      };
    }

    case 'ranking': {
      // Borda count: in a list of N, first place scores N points, last scores 1.
      // Chosen over "average position" because it degrades sensibly when some
      // people rank only part of the list.
      const size = (slide.options || []).length;
      const scores = (slide.options || []).map((label, index) => {
        let points = 0;
        let placements = 0;
        responses.forEach((response) => {
          const position = (response.selected || []).map(String).indexOf(String(index));
          if (position >= 0) {
            points += size - position;
            placements += 1;
          }
        });
        return {
          index,
          label,
          points,
          placements,
          averagePosition: placements ? round(points / placements, 2) : null,
        };
      });

      const ordered = [...scores].sort((a, b) => b.points - a.points);
      return {
        ...base,
        items: ordered.map((item, position) => ({ ...item, rank: position + 1 })),
        correctOrder:
          reveal && gradable
            ? (slide.correctAnswers || []).map((index) => (slide.options || [])[Number(index)])
            : undefined,
      };
    }

    default:
      return base;
  }
}

/**
 * Session-wide roll-up: per-slide participation, and a leaderboard when the
 * deck has gradable slides.
 */
function aggregateSession(short, session, responses = []) {
  const byslide = new Map();
  responses.forEach((response) => {
    const key = String(response.slideId);
    if (!byslide.has(key)) byslide.set(key, []);
    byslide.get(key).push(response);
  });

  const slides = (short.slides || []).map((slide, index) => {
    const slideResponses = byslide.get(String(slide._id)) || [];
    const gradable = slideIsGradable(slide);
    const correct = slideResponses.filter((response) => response.correct).length;
    const times = slideResponses.map((r) => r.responseMs).filter((ms) => Number.isFinite(ms));

    return {
      index,
      slideId: slide._id,
      type: slide.type,
      question: slide.question,
      responses: slideResponses.length,
      gradable,
      correct: gradable ? correct : null,
      correctPercent: gradable && slideResponses.length ? round((correct / slideResponses.length) * 100, 1) : null,
      avgResponseMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
      results: aggregateSlide(slide, slideResponses, {
        reveal: true,
        anonymous: short.settings?.anonymous !== false,
      }),
    };
  });

  const gradableSlides = (short.slides || []).filter(slideIsGradable);
  const maxScore = gradableSlides.reduce((sum, slide) => sum + (slide.marks || 0), 0);

  const perParticipant = new Map();
  (session.participants || []).forEach((participant) => {
    perParticipant.set(String(participant.userId), {
      userId: participant.userId,
      name: participant.name,
      email: participant.email,
      rollNumber: participant.rollNumber,
      answered: 0,
      correct: 0,
      score: 0,
      totalResponseMs: 0,
    });
  });

  responses.forEach((response) => {
    const key = String(response.participantId);
    if (!perParticipant.has(key)) {
      // Someone answered without a participant row — possible if they joined
      // during a restart. Keep them rather than dropping their answers.
      perParticipant.set(key, {
        userId: response.participantId,
        name: response.participantName,
        email: '',
        rollNumber: response.rollNumber,
        answered: 0,
        correct: 0,
        score: 0,
        totalResponseMs: 0,
      });
    }
    const entry = perParticipant.get(key);
    entry.answered += 1;
    if (response.correct) entry.correct += 1;
    entry.score += response.awarded || 0;
    if (Number.isFinite(response.responseMs)) entry.totalResponseMs += response.responseMs;
  });

  const leaderboard = [...perParticipant.values()]
    .map((entry) => ({
      ...entry,
      percent: maxScore ? round((entry.score / maxScore) * 100, 1) : null,
    }))
    // Score first, then how much they actually attempted, then speed. The
    // middle term matters: someone who answered nothing has accumulated 0 ms,
    // and on a pure time tie-break would outrank a classmate who answered and
    // was merely slower.
    .sort(
      (a, b) =>
        b.score - a.score || b.answered - a.answered || a.totalResponseMs - b.totalResponseMs,
    );

  return {
    slides,
    maxScore,
    hasGradableSlides: gradableSlides.length > 0,
    leaderboard,
    summary: {
      participants: perParticipant.size,
      slidesPresented: slides.filter((slide) => slide.responses > 0).length,
      totalResponses: responses.length,
      averageParticipation: slides.length
        ? round(slides.reduce((sum, slide) => sum + slide.responses, 0) / slides.length, 1)
        : 0,
    },
  };
}

/** Validates and coerces an incoming answer for its slide type. */
function normaliseAnswer(slide, body) {
  const result = { selected: [], text: '', number: null };

  switch (slide.type) {
    case 'mcq':
    case 'truefalse': {
      const picked = (Array.isArray(body.selected) ? body.selected : [body.selected])
        .filter((value) => value !== undefined && value !== null && value !== '')
        .map(String)
        .slice(0, 1);
      const valid = picked.filter((index) => Number(index) >= 0 && Number(index) < (slide.options || []).length);
      if (!valid.length) return { error: 'Choose an option.' };
      result.selected = valid;
      break;
    }

    case 'msq': {
      const picked = [...new Set((Array.isArray(body.selected) ? body.selected : []).map(String))];
      const valid = picked.filter((index) => Number(index) >= 0 && Number(index) < (slide.options || []).length);
      if (!valid.length) return { error: 'Choose at least one option.' };
      result.selected = valid;
      break;
    }

    case 'ranking': {
      const order = (Array.isArray(body.selected) ? body.selected : []).map(String);
      const size = (slide.options || []).length;
      const unique = [...new Set(order)].filter((index) => Number(index) >= 0 && Number(index) < size);
      if (unique.length !== size) return { error: 'Rank every option exactly once.' };
      result.selected = unique;
      break;
    }

    case 'wordcloud':
    case 'open': {
      const text = String(body.text ?? '').trim().slice(0, slide.maxLength || 200);
      if (!text) return { error: 'Type an answer.' };
      result.text = text;
      break;
    }

    case 'scale': {
      const value = Number(body.number);
      const min = Number(slide.scaleMin ?? 1);
      const max = Number(slide.scaleMax ?? 5);
      if (!Number.isFinite(value) || value < min || value > max) {
        return { error: `Choose a value between ${min} and ${max}.` };
      }
      result.number = Math.round(value);
      break;
    }

    case 'numeric': {
      const value = Number(body.number);
      if (!Number.isFinite(value)) return { error: 'Enter a number.' };
      result.number = value;
      break;
    }

    default:
      return { error: 'Unsupported slide type.' };
  }

  return result;
}

module.exports = {
  effectiveSlideState,
  slideIsGradable,
  markResponse,
  normaliseWords,
  aggregateSlide,
  aggregateSession,
  normaliseAnswer,
  STOP_WORDS,
};
