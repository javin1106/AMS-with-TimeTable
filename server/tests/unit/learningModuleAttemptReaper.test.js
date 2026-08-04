/**
 * The abandoned-attempt sweep and the heartbeat signal.
 *
 * Closing the tab used to be a clean escape: an attempt stayed `in_progress` for
 * ever, so it never scored, never showed up as a completed sitting, and left the
 * student able to say they were never marked. Every other timing check in the
 * system happens on a request the student chooses to make, so nothing caught it.
 *
 * Mongo is stubbed. What is asserted is the decision the reaper makes about each
 * attempt it finds, and the latching on the heartbeat signal.
 */

const mongoose = require('mongoose');

const quizController = require('../../src/modules/learningModule/controllers/quizController');
const LmQuizAttempt = require('../../src/modules/learningModule/models/lmQuizAttempt');
const LmQuiz = require('../../src/modules/learningModule/models/lmQuiz');
const LmCoursework = require('../../src/modules/learningModule/models/lmCoursework');

const oid = () => new mongoose.Types.ObjectId().toString();
const QUIZ_ID = oid();
const CLASS_ID = oid();
const STUDENT_ID = oid();

const MINUTE = 60 * 1000;
const NOW = new Date('2026-03-01T10:00:00Z');
const ago = (ms) => new Date(NOW.getTime() - ms);

/** A saveable attempt stand-in that records whether it was written. */
const makeAttempt = (overrides = {}) => ({
  _id: oid(),
  quizId: QUIZ_ID,
  classId: CLASS_ID,
  studentId: STUDENT_ID,
  status: 'in_progress',
  startedAt: ago(90 * MINUTE),
  currentServedAt: ago(90 * MINUTE),
  questionOrder: [],
  responses: [],
  violations: [],
  lastSeenAt: null,
  heartbeatLostAt: null,
  saved: false,
  async save() {
    this.saved = true;
    return this;
  },
  ...overrides,
});

const stubFind = (attempts) => {
  jest.spyOn(LmQuizAttempt, 'find').mockReturnValue({
    sort: () => ({ limit: () => Promise.resolve(attempts) }),
  });
};

const stubQuiz = (settings) => {
  jest.spyOn(LmQuiz, 'findById').mockResolvedValue(
    settings === null
      ? null
      : { _id: QUIZ_ID, settings, questions: [], toObject: () => ({ settings, questions: [] }) },
  );
};

// finaliseAttempt mirrors the best score into the gradebook. That path has its
// own tests; here it would just require a second layer of stubs to reach the
// same conclusion.
const stubNoCoursework = () => jest.spyOn(LmCoursework, 'findOne').mockResolvedValue(null);

afterEach(() => jest.restoreAllMocks());

describe('reapExpiredAttempts', () => {
  it('finalises an attempt whose paper clock ran out', async () => {
    const abandoned = makeAttempt();
    stubFind([abandoned]);
    stubQuiz({ timeLimitMinutes: 30 });
    stubNoCoursework();

    const result = await quizController.reapExpiredAttempts({ now: NOW });
    expect(result.scanned).toBe(1);
    expect(result.expired).toBe(1);
    // Recorded as expired rather than submitted, so a teacher can tell a paper
    // that ran out from one that was handed in.
    expect(abandoned.status).toBe('expired');
    expect(abandoned.submittedAt).toBeTruthy();
  });

  it('leaves an attempt that still has time', async () => {
    stubFind([makeAttempt({ startedAt: ago(5 * MINUTE) })]);
    stubQuiz({ timeLimitMinutes: 30 });

    const result = await quizController.reapExpiredAttempts({ now: NOW });
    expect(result.expired).toBe(0);
  });

  it('leaves an untimed, open-ended attempt alone for ever', async () => {
    // A quiz deliberately left open must not be reaped, however old the sitting.
    stubFind([makeAttempt({ startedAt: ago(400 * 24 * 60 * MINUTE) })]);
    stubQuiz({});

    const result = await quizController.reapExpiredAttempts({ now: NOW });
    expect(result.expired).toBe(0);
  });

  it('skips an attempt whose quiz has been deleted rather than guessing', async () => {
    stubFind([makeAttempt()]);
    stubQuiz(null);

    const result = await quizController.reapExpiredAttempts({ now: NOW });
    expect(result.scanned).toBe(1);
    expect(result.expired).toBe(0);
  });

  it('reads each quiz once however many attempts reference it', async () => {
    // A cohort of two hundred sitting one paper must not be two hundred reads.
    stubFind([makeAttempt(), makeAttempt(), makeAttempt()]);
    stubNoCoursework();
    const findById = jest.fn().mockResolvedValue({
      _id: QUIZ_ID,
      settings: {},
      questions: [],
      toObject: () => ({ settings: {}, questions: [] }),
    });
    jest.spyOn(LmQuiz, 'findById').mockImplementation(findById);

    await quizController.reapExpiredAttempts({ now: NOW });
    expect(findById).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there is nothing in progress', async () => {
    stubFind([]);
    const result = await quizController.reapExpiredAttempts({ now: NOW });
    expect(result).toEqual({ scanned: 0, expired: 0, flagged: 0 });
  });
});

describe('noteHeartbeatLoss', () => {
  const { noteHeartbeatLoss, HEARTBEAT_GRACE_MS } = quizController;

  it('records a page that stopped checking in', async () => {
    const attempt = makeAttempt({ lastSeenAt: ago(5 * MINUTE) });
    expect(noteHeartbeatLoss(attempt, NOW)).toBe(true);
    expect(attempt.violations.map((v) => v.type)).toEqual(['heartbeat_lost']);
    expect(attempt.violations[0].detail).toMatch(/\d+s/);
  });

  it('says nothing about a brief hiccup', async () => {
    // A student on flaky wifi must not collect violations for it.
    const attempt = makeAttempt({ lastSeenAt: new Date(NOW.getTime() - (HEARTBEAT_GRACE_MS - 1000)) });
    expect(noteHeartbeatLoss(attempt, NOW)).toBe(false);
    expect(attempt.violations).toEqual([]);
  });

  it('records the loss once, not once per sweep', async () => {
    // Latched: an hour offline is one note, or the record is unreadable.
    const attempt = makeAttempt({ lastSeenAt: ago(5 * MINUTE) });
    expect(noteHeartbeatLoss(attempt, NOW)).toBe(true);
    expect(noteHeartbeatLoss(attempt, new Date(NOW.getTime() + 10 * MINUTE))).toBe(false);
    expect(attempt.violations).toHaveLength(1);
  });

  it('says nothing about an attempt that has never checked in', async () => {
    // An attempt started before heartbeats existed, or one only a few seconds
    // old, is not evidence of anything.
    const attempt = makeAttempt({ lastSeenAt: null });
    expect(noteHeartbeatLoss(attempt, NOW)).toBe(false);
  });

  it('is a note, never a termination', async () => {
    const attempt = makeAttempt({ lastSeenAt: ago(60 * MINUTE) });
    noteHeartbeatLoss(attempt, NOW);
    // The commonest cause is a student's connection. Ending their paper for it
    // would be worse than the problem it detects.
    expect(attempt.status).toBe('in_progress');
  });
});

describe('startAttemptReaper', () => {
  it('does not hold the process open', () => {
    // An unref'd timer, or `jest --detectOpenHandles` and every graceful
    // shutdown would hang on it.
    const timer = quizController.startAttemptReaper({ intervalMs: 60 * 1000 });
    expect(timer.hasRef()).toBe(false);
    clearInterval(timer);
  });
});
