/**
 * Live-poll aggregation. These numbers go straight onto a projector in front of
 * a room, so an off-by-one in a bar chart or a mis-ranked list is immediately
 * and publicly wrong. Pure functions — no database.
 */

const agg = require('../../src/modules/learningModule/services/shortsAggregator');

const response = (overrides) => ({ selected: [], text: '', number: null, correct: null, ...overrides });

describe('learningModule shortsAggregator — effectiveSlideState', () => {
  const T0 = new Date('2026-01-01T10:00:00Z').getTime();
  const autoReveal = { settings: { autoRevealOnClose: true } };
  const noAutoReveal = { settings: { autoRevealOnClose: false } };
  const openAt = (deadlineMs) => ({
    slideState: 'open',
    slideDeadline: deadlineMs === null ? null : new Date(deadlineMs),
  });

  it('leaves a slide open while the countdown is still running', () => {
    expect(agg.effectiveSlideState(openAt(T0 + 5000), autoReveal, T0)).toBe('open');
  });

  it('leaves a slide with no countdown open indefinitely', () => {
    // timeLimitSec 0 means the teacher closes it by hand; it must never time out
    // on its own.
    expect(agg.effectiveSlideState(openAt(null), autoReveal, T0 + 60 * 60 * 1000)).toBe('open');
  });

  it('reveals a slide once the countdown has passed', () => {
    // This is the whole point: the answer appears when time is up, without the
    // teacher having to press anything.
    expect(agg.effectiveSlideState(openAt(T0 + 5000), autoReveal, T0 + 5001)).toBe('revealed');
  });

  it('only locks, not reveals, when the deck turns auto-reveal off', () => {
    expect(agg.effectiveSlideState(openAt(T0 + 5000), noAutoReveal, T0 + 5001)).toBe('locked');
  });

  it('treats the exact deadline instant as still open', () => {
    // The boundary matches submitResponse, which rejects strictly after the
    // deadline — otherwise an answer could be accepted by one and refused by the
    // other in the same millisecond.
    expect(agg.effectiveSlideState(openAt(T0 + 5000), autoReveal, T0 + 5000)).toBe('open');
  });

  it('never resurrects a slide the teacher already closed', () => {
    // A locked slide with a stale deadline must not jump to revealed, and a
    // waiting slide must not become anything at all.
    expect(agg.effectiveSlideState({ slideState: 'locked', slideDeadline: new Date(T0) }, autoReveal, T0 + 9999)).toBe('locked');
    expect(agg.effectiveSlideState({ slideState: 'waiting', slideDeadline: null }, autoReveal, T0)).toBe('waiting');
    expect(agg.effectiveSlideState({ slideState: 'revealed', slideDeadline: null }, autoReveal, T0)).toBe('revealed');
  });

  it('accepts a Date as well as a timestamp for now', () => {
    expect(agg.effectiveSlideState(openAt(T0 + 5000), autoReveal, new Date(T0 + 6000))).toBe('revealed');
  });

  it('defaults to waiting when there is no session', () => {
    expect(agg.effectiveSlideState(null, autoReveal, T0)).toBe('waiting');
  });
});

describe('learningModule shortsAggregator — gradability', () => {
  it('treats a choice slide with a key as gradable', () => {
    expect(agg.slideIsGradable({ type: 'mcq', correctAnswers: ['0'] })).toBe(true);
    expect(agg.slideIsGradable({ type: 'mcq', correctAnswers: [] })).toBe(false);
  });

  it('treats opinions as never gradable', () => {
    // A word cloud or a rating is not a question with a right answer.
    expect(agg.slideIsGradable({ type: 'wordcloud', correctAnswers: ['x'] })).toBe(false);
    expect(agg.slideIsGradable({ type: 'open' })).toBe(false);
    expect(agg.slideIsGradable({ type: 'scale' })).toBe(false);
  });

  it('treats a numeric slide as gradable only with a target', () => {
    expect(agg.slideIsGradable({ type: 'numeric', correctNumber: 42 })).toBe(true);
    expect(agg.slideIsGradable({ type: 'numeric', correctNumber: null })).toBe(false);
    // Zero is a legitimate answer and must not be read as "no key".
    expect(agg.slideIsGradable({ type: 'numeric', correctNumber: 0 })).toBe(true);
  });
});

describe('learningModule shortsAggregator — markResponse', () => {
  it('marks single choice', () => {
    const slide = { type: 'mcq', correctAnswers: ['1'], marks: 2 };
    expect(agg.markResponse(slide, response({ selected: ['1'] }))).toEqual({ correct: true, awarded: 2 });
    expect(agg.markResponse(slide, response({ selected: ['0'] }))).toEqual({ correct: false, awarded: 0 });
  });

  it('requires the exact set for multi-select', () => {
    const slide = { type: 'msq', correctAnswers: ['0', '2'], marks: 3 };
    expect(agg.markResponse(slide, response({ selected: ['2', '0'] })).correct).toBe(true);
    expect(agg.markResponse(slide, response({ selected: ['0'] })).correct).toBe(false);
  });

  it('marks a numeric estimate within tolerance', () => {
    const slide = { type: 'numeric', correctNumber: 100, tolerancePercent: 5, marks: 1 };
    expect(agg.markResponse(slide, response({ number: 103 })).correct).toBe(true);
    expect(agg.markResponse(slide, response({ number: 120 })).correct).toBe(false);
  });

  it('requires the exact sequence for a ranking', () => {
    const slide = { type: 'ranking', correctAnswers: ['0', '1', '2'], marks: 3 };
    expect(agg.markResponse(slide, response({ selected: ['0', '1', '2'] })).correct).toBe(true);
    // Same items, wrong order — order is the answer here.
    expect(agg.markResponse(slide, response({ selected: ['0', '2', '1'] })).correct).toBe(false);
  });

  it('returns null rather than false for a poll', () => {
    // The distinction matters: false means "wrong", null means "not a question".
    expect(agg.markResponse({ type: 'wordcloud' }, response({ text: 'hi' }))).toEqual({
      correct: null,
      awarded: 0,
    });
  });
});

describe('learningModule shortsAggregator — choice slides', () => {
  const slide = {
    _id: 's1',
    type: 'mcq',
    question: 'Pick one',
    options: ['A', 'B', 'C'],
    correctAnswers: ['1'],
    marks: 1,
  };

  it('counts each option and computes percentages', () => {
    const result = agg.aggregateSlide(slide, [
      response({ selected: ['0'] }),
      response({ selected: ['1'] }),
      response({ selected: ['1'] }),
      response({ selected: ['1'] }),
    ]);
    expect(result.totalResponses).toBe(4);
    expect(result.options[0]).toMatchObject({ label: 'A', count: 1, percent: 25 });
    expect(result.options[1]).toMatchObject({ label: 'B', count: 3, percent: 75 });
    expect(result.options[2]).toMatchObject({ label: 'C', count: 0, percent: 0 });
  });

  it('withholds the answer key until revealed', () => {
    const hidden = agg.aggregateSlide(slide, [response({ selected: ['1'] })], { reveal: false });
    expect(hidden.correctAnswers).toBeUndefined();
    expect(hidden.options[1].isCorrect).toBeUndefined();

    const shown = agg.aggregateSlide(slide, [response({ selected: ['1'], correct: true })], { reveal: true });
    expect(shown.correctAnswers).toEqual(['1']);
    expect(shown.options[1].isCorrect).toBe(true);
    expect(shown.correctCount).toBe(1);
  });

  it('handles zero responses without dividing by zero', () => {
    const result = agg.aggregateSlide(slide, []);
    expect(result.totalResponses).toBe(0);
    expect(result.options.every((option) => option.percent === 0)).toBe(true);
  });

  it('lets multi-select percentages exceed 100 in total', () => {
    // Denominator is people, not selections, so two picks each is 100%+100%.
    const msq = { ...slide, type: 'msq', correctAnswers: ['0', '1'] };
    const result = agg.aggregateSlide(msq, [
      response({ selected: ['0', '1'] }),
      response({ selected: ['0', '1'] }),
    ]);
    expect(result.options[0].percent).toBe(100);
    expect(result.options[1].percent).toBe(100);
  });
});

describe('learningModule shortsAggregator — word cloud', () => {
  const slide = { _id: 's2', type: 'wordcloud', question: 'One word?', maxWords: 3 };

  it('counts word frequency, ignoring case and punctuation', () => {
    const result = agg.aggregateSlide(slide, [
      response({ text: 'Fourier' }),
      response({ text: 'fourier!' }),
      response({ text: 'Laplace' }),
    ]);
    expect(result.words[0]).toEqual({ text: 'fourier', count: 2 });
    expect(result.maxCount).toBe(2);
  });

  it('drops stop words so the cloud is not full of "the"', () => {
    const result = agg.aggregateSlide(slide, [response({ text: 'the transform' })]);
    expect(result.words.map((word) => word.text)).toEqual(['transform']);
  });

  it('does not let one person inflate a word by repeating it', () => {
    const result = agg.aggregateSlide(slide, [response({ text: 'signal signal signal' })]);
    expect(result.words).toEqual([{ text: 'signal', count: 1 }]);
  });

  it('respects the per-answer word cap', () => {
    const result = agg.aggregateSlide({ ...slide, maxWords: 2 }, [response({ text: 'alpha beta gamma' })]);
    expect(result.words.map((word) => word.text).sort()).toEqual(['alpha', 'beta']);
  });

  it('normaliseWords keeps hyphens and strips edge punctuation', () => {
    expect(agg.normaliseWords("well-known, 'quoted'", { maxWords: 5 })).toEqual(['well-known', 'quoted']);
  });
});

describe('learningModule shortsAggregator — open text', () => {
  const slide = { _id: 's3', type: 'open', question: 'Thoughts?' };

  it('returns entries newest first', () => {
    const result = agg.aggregateSlide(slide, [
      response({ text: 'older', created_at: new Date('2026-01-01T10:00:00Z') }),
      response({ text: 'newer', created_at: new Date('2026-01-01T11:00:00Z') }),
    ]);
    expect(result.entries.map((entry) => entry.text)).toEqual(['newer', 'older']);
  });

  it('hides names when the deck is anonymous', () => {
    const responses = [response({ text: 'hi', participantName: 'Asha' })];
    expect(agg.aggregateSlide(slide, responses, { anonymous: true }).entries[0].name).toBe('');
    expect(agg.aggregateSlide(slide, responses, { anonymous: false }).entries[0].name).toBe('Asha');
  });

  it('skips blank submissions', () => {
    const result = agg.aggregateSlide(slide, [response({ text: '   ' }), response({ text: 'real' })]);
    expect(result.entries).toHaveLength(1);
  });
});

describe('learningModule shortsAggregator — scale', () => {
  const slide = { _id: 's4', type: 'scale', question: 'Confidence?', scaleMin: 1, scaleMax: 5 };

  it('buckets every point on the scale, including empty ones', () => {
    const result = agg.aggregateSlide(slide, [
      response({ number: 1 }),
      response({ number: 5 }),
      response({ number: 5 }),
    ]);
    expect(result.buckets).toHaveLength(5);
    expect(result.buckets.map((bucket) => bucket.count)).toEqual([1, 0, 0, 0, 2]);
    expect(result.average).toBeCloseTo(3.67, 2);
    expect(result.median).toBe(5);
  });

  it('reports nulls rather than NaN with no responses', () => {
    const result = agg.aggregateSlide(slide, []);
    expect(result.average).toBeNull();
    expect(result.median).toBeNull();
  });
});

describe('learningModule shortsAggregator — numeric', () => {
  const slide = { _id: 's5', type: 'numeric', question: 'Estimate', correctNumber: 50 };

  it('reports centre and spread', () => {
    const result = agg.aggregateSlide(slide, [
      response({ number: 10 }),
      response({ number: 20 }),
      response({ number: 30 }),
    ]);
    expect(result.average).toBe(20);
    expect(result.median).toBe(20);
    expect(result.lowest).toBe(10);
    expect(result.highest).toBe(30);
    expect(result.buckets).toHaveLength(10);
    // Every value must land in exactly one bucket.
    expect(result.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(3);
  });

  it('handles every answer being identical without a zero-width bucket', () => {
    const result = agg.aggregateSlide(slide, [response({ number: 7 }), response({ number: 7 })]);
    expect(result.average).toBe(7);
    expect(result.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(2);
  });

  it('ignores non-numeric answers', () => {
    const result = agg.aggregateSlide(slide, [response({ number: 10 }), response({ number: null })]);
    expect(result.average).toBe(10);
  });
});

describe('learningModule shortsAggregator — ranking', () => {
  const slide = {
    _id: 's6',
    type: 'ranking',
    question: 'Order these',
    options: ['X', 'Y', 'Z'],
    correctAnswers: ['0', '1', '2'],
    marks: 1,
  };

  it('scores by Borda count and orders the result', () => {
    // Two voters put Y first, one puts X first.
    const result = agg.aggregateSlide(slide, [
      response({ selected: ['1', '0', '2'] }),
      response({ selected: ['1', '2', '0'] }),
      response({ selected: ['0', '1', '2'] }),
    ]);
    // Y: 3+3+2 = 8, X: 2+1+3 = 6, Z: 1+2+1 = 4
    expect(result.items[0]).toMatchObject({ label: 'Y', points: 8, rank: 1 });
    expect(result.items[1]).toMatchObject({ label: 'X', points: 6, rank: 2 });
    expect(result.items[2]).toMatchObject({ label: 'Z', points: 4, rank: 3 });
  });

  it('copes with a partial ranking', () => {
    // Borda over placements only, so someone ranking two of three still counts.
    const result = agg.aggregateSlide(slide, [response({ selected: ['0', '1'] })]);
    const z = result.items.find((item) => item.label === 'Z');
    expect(z.placements).toBe(0);
    expect(z.averagePosition).toBeNull();
  });

  it('shows the intended order only when revealed', () => {
    const responses = [response({ selected: ['0', '1', '2'] })];
    expect(agg.aggregateSlide(slide, responses, { reveal: false }).correctOrder).toBeUndefined();
    expect(agg.aggregateSlide(slide, responses, { reveal: true }).correctOrder).toEqual(['X', 'Y', 'Z']);
  });
});

describe('learningModule shortsAggregator — normaliseAnswer', () => {
  it('accepts and clamps a single choice', () => {
    const slide = { type: 'mcq', options: ['A', 'B'] };
    expect(agg.normaliseAnswer(slide, { selected: ['1'] }).selected).toEqual(['1']);
    // Only one pick survives on a single-answer slide.
    expect(agg.normaliseAnswer(slide, { selected: ['0', '1'] }).selected).toEqual(['0']);
  });

  it('rejects an out-of-range option instead of storing it', () => {
    const slide = { type: 'mcq', options: ['A', 'B'] };
    expect(agg.normaliseAnswer(slide, { selected: ['9'] }).error).toBeTruthy();
    expect(agg.normaliseAnswer(slide, { selected: [] }).error).toBeTruthy();
  });

  it('deduplicates a multi-select', () => {
    const slide = { type: 'msq', options: ['A', 'B', 'C'] };
    expect(agg.normaliseAnswer(slide, { selected: ['1', '1', '2'] }).selected).toEqual(['1', '2']);
  });

  it('requires a complete ranking', () => {
    const slide = { type: 'ranking', options: ['A', 'B', 'C'] };
    expect(agg.normaliseAnswer(slide, { selected: ['0', '1'] }).error).toBeTruthy();
    expect(agg.normaliseAnswer(slide, { selected: ['2', '0', '1'] }).selected).toEqual(['2', '0', '1']);
  });

  it('trims and caps text', () => {
    const slide = { type: 'wordcloud', maxLength: 5 };
    expect(agg.normaliseAnswer(slide, { text: '  abcdefgh ' }).text).toBe('abcde');
    expect(agg.normaliseAnswer(slide, { text: '   ' }).error).toBeTruthy();
  });

  it('bounds a scale answer', () => {
    const slide = { type: 'scale', scaleMin: 1, scaleMax: 5 };
    expect(agg.normaliseAnswer(slide, { number: 3 }).number).toBe(3);
    expect(agg.normaliseAnswer(slide, { number: 9 }).error).toBeTruthy();
    expect(agg.normaliseAnswer(slide, { number: 0 }).error).toBeTruthy();
  });

  it('accepts any finite number for an estimate, including negatives', () => {
    const slide = { type: 'numeric' };
    expect(agg.normaliseAnswer(slide, { number: -12.5 }).number).toBe(-12.5);
    expect(agg.normaliseAnswer(slide, { number: 'abc' }).error).toBeTruthy();
  });
});

describe('learningModule shortsAggregator — aggregateSession', () => {
  const short = {
    settings: { anonymous: false },
    slides: [
      { _id: 'a', type: 'mcq', question: 'Q1', options: ['A', 'B'], correctAnswers: ['0'], marks: 2 },
      { _id: 'b', type: 'wordcloud', question: 'Q2', maxWords: 2 },
    ],
  };
  const session = {
    participants: [
      { userId: 'u1', name: 'Asha', email: 'a@x', rollNumber: '01' },
      { userId: 'u2', name: 'Ben', email: 'b@x', rollNumber: '02' },
      { userId: 'u3', name: 'Chen', email: 'c@x', rollNumber: '03' },
    ],
  };
  const responses = [
    { slideId: 'a', participantId: 'u1', participantName: 'Asha', selected: ['0'], correct: true, awarded: 2, responseMs: 1200 },
    { slideId: 'a', participantId: 'u2', participantName: 'Ben', selected: ['1'], correct: false, awarded: 0, responseMs: 900 },
    { slideId: 'b', participantId: 'u1', participantName: 'Asha', text: 'signal', correct: null, awarded: 0, responseMs: 3000 },
  ];

  it('rolls up per-slide participation and correctness', () => {
    const result = agg.aggregateSession(short, session, responses);
    expect(result.slides[0]).toMatchObject({ responses: 2, gradable: true, correct: 1, correctPercent: 50 });
    expect(result.slides[0].avgResponseMs).toBe(1050);
    // A word cloud has no notion of correct.
    expect(result.slides[1]).toMatchObject({ responses: 1, gradable: false, correct: null });
  });

  it('reports the gradable maximum, ignoring poll slides', () => {
    const result = agg.aggregateSession(short, session, responses);
    expect(result.maxScore).toBe(2);
    expect(result.hasGradableSlides).toBe(true);
  });

  it('ranks by score then by speed', () => {
    const result = agg.aggregateSession(short, session, responses);
    expect(result.leaderboard[0]).toMatchObject({ name: 'Asha', score: 2, correct: 1, percent: 100 });
    // Ben answered faster than Chen (who did not answer at all) but scored 0.
    expect(result.leaderboard[1].name).toBe('Ben');
  });

  it('includes participants who never answered, so gaps are visible', () => {
    const result = agg.aggregateSession(short, session, responses);
    const chen = result.leaderboard.find((entry) => entry.name === 'Chen');
    expect(chen).toMatchObject({ answered: 0, score: 0 });
    expect(result.summary.participants).toBe(3);
  });

  it('keeps answers from someone with no participant row', () => {
    const orphan = [{ slideId: 'a', participantId: 'u9', participantName: 'Late', selected: ['0'], correct: true, awarded: 2 }];
    const result = agg.aggregateSession(short, session, orphan);
    expect(result.leaderboard.find((entry) => entry.name === 'Late')).toBeTruthy();
  });

  it('handles a session with no responses at all', () => {
    const result = agg.aggregateSession(short, session, []);
    expect(result.summary.totalResponses).toBe(0);
    expect(result.summary.slidesPresented).toBe(0);
    expect(result.leaderboard).toHaveLength(3);
  });
});
