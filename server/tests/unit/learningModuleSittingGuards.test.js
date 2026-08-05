/**
 * The three things browser-side proctoring cannot see, judged server-side.
 *
 * Each of these was previously either recorded-and-ignored or not visible at
 * all, and each has the same shape of exploit: the student's own browser behaves
 * perfectly while the cheating happens somewhere it cannot observe — a second
 * screen, a second machine, or a page that has simply been told to stop talking.
 *
 * These are the pure decision functions. What is asserted is the verdict, since
 * the verdict is the part that used to be missing.
 */

const quizController = require('../../src/modules/learningModule/controllers/quizController');

const { noteDevice, bindSession, forStudent } = quizController;

const MINUTE = 60 * 1000;
const NOW = new Date('2026-03-01T10:00:00Z');
const ago = (ms) => new Date(NOW.getTime() - ms);

const LAPTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36';
const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1';

const makeReq = ({ userAgent = LAPTOP, ip = '10.0.0.1', session } = {}) => ({
  ip,
  get: (header) => {
    if (header === 'User-Agent') return userAgent;
    if (header === 'X-Quiz-Session') return session;
    return undefined;
  },
});

const makeAttempt = (overrides = {}) => ({
  startedAt: ago(20 * MINUTE),
  violations: [],
  device: { userAgent: LAPTOP, ip: '10.0.0.1', isMobile: false },
  sessionToken: '',
  sessionBoundAt: null,
  lastSeenAt: null,
  ...overrides,
});

describe('learningModule forStudent', () => {
  /**
   * The largest hole in the module: this view was returned by a route needing no
   * attempt at all, so one-at-a-time delivery could be read in full from
   * question one, and any live paper could be read days before being sat.
   */
  it('does not hand the student the questions', () => {
    const view = forStudent({
      title: 'Thermodynamics',
      settings: { deliveryMode: 'one_at_a_time' },
      questions: [{ _id: 'q1', question: 'Why?' }, { _id: 'q2', question: 'How?' }],
    });

    expect(view.questions).toBeUndefined();
    expect(view.questionCount).toBe(2);
    expect(view.title).toBe('Thermodynamics');
    expect(view.settings.deliveryMode).toBe('one_at_a_time');
  });

  it('survives a quiz with no questions rather than reporting undefined', () => {
    expect(forStudent({ title: 'Empty' }).questionCount).toBe(0);
  });
});

describe('learningModule noteDevice', () => {
  it('lets an IP change pass, because a campus network moves under honest students', () => {
    const attempt = makeAttempt();

    expect(noteDevice(attempt, makeReq({ ip: '10.0.0.9' }), {})).toBeNull();
    expect(attempt.violations).toEqual([
      expect.objectContaining({ type: 'device_changed', detail: 'network changed mid-attempt' }),
    ]);
  });

  it('ends the sitting when the browser changes, which no single browser does', () => {
    const attempt = makeAttempt();

    const verdict = noteDevice(attempt, makeReq({ userAgent: 'Mozilla/5.0 (X11; Linux) Firefox/121.0' }), {});

    expect(verdict).toEqual({ terminate: 'The test moved to a different browser or device' });
    expect(attempt.violations).toEqual([
      expect.objectContaining({ type: 'device_changed', detail: 'browser changed mid-attempt' }),
    ]);
  });

  /**
   * `preventMobile` used to be checked only at `startAttempt`, so beginning on a
   * laptop and continuing on a handset walked straight past it.
   */
  it('ends the sitting when a preventMobile paper continues on a phone', () => {
    const attempt = makeAttempt({ device: { userAgent: PHONE, ip: '10.0.0.1' } });

    const verdict = noteDevice(attempt, makeReq({ userAgent: PHONE }), {
      settings: { preventMobile: true },
    });

    expect(verdict).toEqual({ terminate: 'Continued the test on a mobile device' });
    expect(attempt.violations).toEqual([
      expect.objectContaining({ type: 'mobile_detected', detail: 'continued on a mobile device' }),
    ]);
  });

  it('leaves a phone alone on a paper that never asked for a laptop', () => {
    const attempt = makeAttempt({ device: { userAgent: PHONE, ip: '10.0.0.1' } });

    expect(noteDevice(attempt, makeReq({ userAgent: PHONE }), { settings: {} })).toBeNull();
    expect(attempt.violations).toEqual([]);
  });

  it('says nothing at all about a sitting that has not moved', () => {
    const attempt = makeAttempt();

    expect(noteDevice(attempt, makeReq(), {})).toBeNull();
    expect(attempt.violations).toEqual([]);
  });
});

describe('learningModule bindSession', () => {
  it('binds the first browser to reach an unbound sitting', () => {
    const attempt = makeAttempt();

    const result = bindSession(attempt, makeReq({ session: 'tab-a' }), NOW);

    expect(result).toEqual({ token: 'tab-a' });
    expect(attempt.sessionBoundAt).toEqual(NOW);
    expect(attempt.violations).toEqual([]);
  });

  it('lets the bound browser carry on, silently', () => {
    const attempt = makeAttempt({ sessionToken: 'tab-a', sessionBoundAt: ago(5 * MINUTE) });

    expect(bindSession(attempt, makeReq({ session: 'tab-a' }), NOW)).toEqual({ token: 'tab-a' });
    expect(attempt.violations).toEqual([]);
  });

  /** The second screen: a phone opening the paper the laptop is sitting. */
  it('refuses a second browser while the first is still checking in', () => {
    const attempt = makeAttempt({
      sessionToken: 'tab-a',
      sessionBoundAt: ago(10 * MINUTE),
      lastSeenAt: ago(20 * 1000),
    });

    expect(bindSession(attempt, makeReq({ session: 'phone' }), NOW)).toEqual({ conflict: true });
    expect(attempt.sessionToken).toBe('tab-a');
    expect(attempt.violations).toEqual([
      expect.objectContaining({
        type: 'second_session',
        detail: 'a second browser tried to open this sitting while the first was live',
      }),
    ]);
  });

  it('refuses a client that produces no token at all, once one is bound', () => {
    const attempt = makeAttempt({
      sessionToken: 'tab-a',
      sessionBoundAt: ago(10 * MINUTE),
      lastSeenAt: ago(20 * 1000),
    });

    expect(bindSession(attempt, makeReq({ session: undefined }), NOW)).toEqual({ conflict: true });
  });

  /**
   * The case that stops this from being a trap. Resuming a dropped sitting where
   * it left off is promised elsewhere in the module, and a crashed browser
   * cannot produce the token it lost.
   */
  it('rebinds once the first browser has gone quiet, and says so', () => {
    const attempt = makeAttempt({
      sessionToken: 'tab-a',
      sessionBoundAt: ago(10 * MINUTE),
      lastSeenAt: ago(4 * MINUTE),
    });

    expect(bindSession(attempt, makeReq({ session: 'tab-b' }), NOW)).toEqual({ token: 'tab-b' });
    expect(attempt.sessionToken).toBe('tab-b');
    expect(attempt.violations).toEqual([
      expect.objectContaining({
        type: 'second_session',
        detail: 'resumed in a different browser after the first stopped responding',
      }),
    ]);
  });

  /**
   * A sitting that has only just started has never heartbeated. Judging liveness
   * on `lastSeenAt` alone left the first thirty seconds of every paper open to
   * whoever asked second.
   */
  it('counts a just-bound session as live even before its first heartbeat', () => {
    const attempt = makeAttempt({
      sessionToken: 'tab-a',
      sessionBoundAt: ago(5 * 1000),
      lastSeenAt: null,
    });

    expect(bindSession(attempt, makeReq({ session: 'phone' }), NOW)).toEqual({ conflict: true });
  });
});
