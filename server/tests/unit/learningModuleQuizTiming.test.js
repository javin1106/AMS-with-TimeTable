/**
 * Server-side enforcement of the quiz clock.
 *
 * The client's countdown can be paused in a debugger, rewritten from the
 * console, or skipped entirely by talking to the API with a token copied out of
 * localStorage — so nothing may depend on it. Before this, `questionDeadline` was
 * computed and *reported* and never compared against anything: an answer posted
 * an hour after the paper closed was accepted, and `submitAttempt` asked the
 * client whether it had run out of time.
 *
 * These cover the pure decision function. The handlers that call it are wired in
 * quizController; what is asserted here is the rule they all share.
 */

const engine = require('../../src/modules/learningModule/services/examEngine');

const MINUTE = 60 * 1000;
const T0 = new Date('2026-03-01T09:00:00Z');
const at = (ms) => new Date(T0.getTime() + ms);

const quiz = (settings = {}) => ({ settings });
const attempt = (overrides = {}) => ({ startedAt: T0, currentServedAt: T0, ...overrides });
const question = (timeLimitSec) => ({ timeLimitSec });

describe('examEngine.attemptDeadline', () => {
  it('is the paper clock when only a duration is set', () => {
    expect(engine.attemptDeadline(quiz({ timeLimitMinutes: 30 }), attempt())).toEqual(at(30 * MINUTE));
  });

  it('is the closing time when that comes first', () => {
    const closesAt = at(10 * MINUTE);
    expect(
      engine.attemptDeadline(quiz({ timeLimitMinutes: 30, availableTo: closesAt }), attempt()),
    ).toEqual(closesAt);
  });

  it('is null when the quiz is untimed and open-ended', () => {
    // Nothing to enforce, and inventing a deadline would end papers that were
    // deliberately left open.
    expect(engine.attemptDeadline(quiz({}), attempt())).toBeNull();
  });

  it('ignores the per-question clock', () => {
    // The distinction the whole design turns on: running out of time on one
    // question ends the question, not the sitting.
    const state = engine.attemptDeadline(
      quiz({ perQuestionTiming: true, timeLimitMinutes: 60 }),
      attempt(),
    );
    expect(state).toEqual(at(60 * MINUTE));
  });

  it('counts from when the attempt started, not from now', () => {
    // Otherwise reloading the page would buy another full paper's worth of time.
    const late = attempt({ startedAt: at(-50 * MINUTE) });
    expect(engine.attemptDeadline(quiz({ timeLimitMinutes: 30 }), late)).toEqual(at(-20 * MINUTE));
  });
});

describe('examEngine.deadlineState — the paper clock', () => {
  it('leaves an attempt alone while there is time left', () => {
    const state = engine.deadlineState(quiz({ timeLimitMinutes: 30 }), attempt(), null, at(10 * MINUTE));
    expect(state.attemptExpired).toBe(false);
    expect(state.questionExpired).toBe(false);
  });

  it('expires it once the paper clock has passed', () => {
    const state = engine.deadlineState(quiz({ timeLimitMinutes: 30 }), attempt(), null, at(31 * MINUTE));
    expect(state.attemptExpired).toBe(true);
  });

  it('expires it once the quiz has closed, however long the paper allowed', () => {
    // A student who started five minutes before the window shut does not get the
    // full hour.
    const state = engine.deadlineState(
      quiz({ timeLimitMinutes: 60, availableTo: at(5 * MINUTE) }),
      attempt(),
      null,
      at(6 * MINUTE),
    );
    expect(state.attemptExpired).toBe(true);
  });

  it('never expires an untimed, open-ended quiz', () => {
    const state = engine.deadlineState(quiz({}), attempt(), null, at(365 * 24 * 60 * MINUTE));
    expect(state.attemptExpired).toBe(false);
  });

  it('allows a few seconds of slack for latency and clock skew', () => {
    // A click with one second left must not be lost to the round trip.
    const justAfter = at(30 * MINUTE + 2000);
    expect(engine.deadlineState(quiz({ timeLimitMinutes: 30 }), attempt(), null, justAfter).attemptExpired)
      .toBe(false);
  });

  it('does not let the slack be farmed', () => {
    // Comfortably past the grace, so no amount of repeating the trick extends
    // the paper.
    const wellAfter = at(30 * MINUTE + engine.DEADLINE_GRACE_MS + 1000);
    expect(engine.deadlineState(quiz({ timeLimitMinutes: 30 }), attempt(), null, wellAfter).attemptExpired)
      .toBe(true);
  });
});

describe('examEngine.deadlineState — the per-question clock', () => {
  const perQuestion = quiz({ perQuestionTiming: true, timeLimitMinutes: 60 });

  it('flags an answer that arrives after its question timed out', () => {
    const state = engine.deadlineState(perQuestion, attempt(), question(60), at(70 * 1000));
    expect(state.questionExpired).toBe(true);
    // The paper is untouched — 60 minutes of it remain.
    expect(state.attemptExpired).toBe(false);
  });

  it('leaves an answer inside its question clock alone', () => {
    const state = engine.deadlineState(perQuestion, attempt(), question(60), at(30 * 1000));
    expect(state.questionExpired).toBe(false);
  });

  it('measures from when the question was served, not when the paper began', () => {
    // currentServedAt is stamped server-side, so reloading cannot restart it —
    // but a question served late in the paper must get its own full allowance.
    const midPaper = attempt({ currentServedAt: at(40 * MINUTE) });
    const state = engine.deadlineState(perQuestion, midPaper, question(60), at(40 * MINUTE + 30 * 1000));
    expect(state.questionExpired).toBe(false);
  });

  it('reports the paper as expired rather than the question when both have run out', () => {
    // A caller that finalises on attemptExpired must never also have to handle
    // questionExpired, or a dead paper would be recorded as a late answer and
    // carry on.
    const state = engine.deadlineState(perQuestion, attempt(), question(60), at(61 * MINUTE));
    expect(state.attemptExpired).toBe(true);
    expect(state.questionExpired).toBe(false);
  });

  it('ignores a per-question limit when the setting is off', () => {
    // The limit is stored on the question either way; only the setting decides
    // whether it counts.
    const off = quiz({ perQuestionTiming: false, timeLimitMinutes: 60 });
    expect(engine.deadlineState(off, attempt(), question(10), at(5 * MINUTE)).questionExpired).toBe(false);
  });

  it('ignores a zero limit, which means "no limit on this question"', () => {
    expect(engine.deadlineState(perQuestion, attempt(), question(0), at(50 * MINUTE)).questionExpired)
      .toBe(false);
  });
});

describe('examEngine.deadlineState — the deadline it reports', () => {
  it('hands back the earliest of the clocks in play', () => {
    const state = engine.deadlineState(
      quiz({ perQuestionTiming: true, timeLimitMinutes: 60, availableTo: at(90 * MINUTE) }),
      attempt(),
      question(120),
      T0,
    );
    // Two minutes on this question beats sixty on the paper and ninety on the
    // window.
    expect(state.deadline).toEqual(at(2 * MINUTE));
  });

  it('hands back null when nothing constrains the attempt', () => {
    expect(engine.deadlineState(quiz({}), attempt(), null, T0).deadline).toBeNull();
  });
});
