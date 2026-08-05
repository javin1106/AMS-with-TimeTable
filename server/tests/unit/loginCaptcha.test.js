/**
 * The login captcha: the challenge itself, and when the form asks for one.
 *
 * The challenge tests matter because a signed token that is not single-use is
 * worse than no captcha at all — solve one, replay it a thousand times — and
 * because a signature check that can be skipped by malforming the token is not a
 * signature check.
 *
 * The gate tests matter because the *shape* of the trigger is the whole design:
 * a per-account counter cannot see password spraying, so there is an install-wide
 * one, and neither may reveal whether an address is registered.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-captcha-tests';

const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');

const User = require('../../src/models/usermanagement/user');
const captcha = require('../../src/modules/usermanagement/captcha');
const captchaGate = require('../../src/modules/usermanagement/captchaGate');
const { login, captcha: captchaRoute } = require('../../src/modules/usermanagement/controllers/usercontroller');

const { issueChallenge, verifyChallenge, ALPHABET, CODE_LENGTH } = captcha;

const PASSWORD = 'correct-horse-battery-staple';
let passwordHash;

const userDoc = () => ({
  _id: '507f1f77bcf86cd799439011',
  name: 'Asha Rao',
  email: ['asha@nitj.ac.in'],
  role: ['FACULTY'],
  password: passwordHash,
});

const stubLookup = (result) => {
  jest.spyOn(User, 'findOne').mockReturnValue({ select: () => Promise.resolve(result) });
};

/** No rate limiters: these tests are about the captcha, not the throttle. */
const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.post('/auth/login', login);
  app.get('/auth/captcha', captchaRoute);
  return app;
};

/**
 * Reads the answer back out of a challenge.
 *
 * The server never stores it, so a test cannot look it up — it has to do what a
 * human does and read the image. Each glyph is its own `<text>` element in
 * document order, which is exactly how it is drawn.
 */
const solve = (svg) => (svg.match(/>([A-Z0-9])<\/text>/g) || [])
  .map((match) => match.slice(1, 2))
  .join('');

beforeAll(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 10);
});

beforeEach(() => {
  captchaGate.reset();
  captcha.resetSpent();
});

afterEach(() => jest.restoreAllMocks());

describe('the challenge', () => {
  it('issues a token and an image whose answer solves it', () => {
    const { token, svg } = issueChallenge();
    const answer = solve(svg);
    expect(answer).toHaveLength(CODE_LENGTH);
    expect(verifyChallenge(token, answer)).toEqual({ ok: true });
  });

  it('never puts the answer in the token', () => {
    // The token goes to the browser that has to solve it. Only a keyed hash of
    // the answer is in there.
    const { token, svg } = issueChallenge();
    const answer = solve(svg);
    const decoded = Buffer.from(token.split('.')[0], 'base64url').toString('utf8');
    expect(decoded).not.toContain(answer);
  });

  it('accepts the answer in any case', () => {
    // Reading case off a distorted glyph is not a useful test of anything.
    const { token, svg } = issueChallenge();
    expect(verifyChallenge(token, solve(svg).toLowerCase())).toEqual({ ok: true });
  });

  it('ignores surrounding whitespace', () => {
    const { token, svg } = issueChallenge();
    expect(verifyChallenge(token, `  ${solve(svg)} `)).toEqual({ ok: true });
  });

  it('rejects a wrong answer', () => {
    const { token } = issueChallenge();
    expect(verifyChallenge(token, 'AAAAA').ok).toBe(false);
  });

  it('cannot be answered twice', () => {
    // The replay this exists to stop: one solved challenge, a thousand attempts.
    const { token, svg } = issueChallenge();
    const answer = solve(svg);
    expect(verifyChallenge(token, answer)).toEqual({ ok: true });
    expect(verifyChallenge(token, answer)).toEqual({ ok: false, reason: 'reused' });
  });

  it('does not spend the challenge on a wrong answer', () => {
    // Otherwise a typo forces a new image, and a mistyped captcha becomes
    // indistinguishable from a broken one.
    const { token, svg } = issueChallenge();
    expect(verifyChallenge(token, 'WRONG').reason).toBe('wrong');
    expect(verifyChallenge(token, solve(svg))).toEqual({ ok: true });
  });

  it('expires', () => {
    const now = Date.now();
    const { token, svg } = issueChallenge(now);
    const later = now + captcha.CHALLENGE_TTL_MS + 1;
    expect(verifyChallenge(token, solve(svg), later)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a token whose payload has been edited', () => {
    const { token, svg } = issueChallenge();
    const answer = solve(svg);
    const [payload, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));

    // Push the expiry out by a year and keep the original signature.
    claims.e += 365 * 24 * 60 * 60 * 1000;
    const forged = `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;
    expect(verifyChallenge(forged, answer)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a token signed with the wrong key', () => {
    const { token, svg } = issueChallenge();
    const answer = solve(svg);
    const original = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'a-different-secret';
    try {
      expect(verifyChallenge(token, answer).ok).toBe(false);
    } finally {
      process.env.JWT_SECRET = original;
    }
  });

  it('rejects malformed tokens without throwing', () => {
    // All caller-controlled bytes; none of them may reach JSON.parse before the
    // signature has been checked.
    ['', 'no-dot', '.', 'a.b', '{}.{}', null, undefined, 42, {}].forEach((value) => {
      expect(verifyChallenge(value, 'AAAAA').ok).toBe(false);
    });
  });

  it('does not treat an empty answer as correct', () => {
    const { token } = issueChallenge();
    expect(verifyChallenge(token, '').ok).toBe(false);
    expect(verifyChallenge(token, null).ok).toBe(false);
    expect(verifyChallenge(token, undefined).ok).toBe(false);
  });

  it('draws only unambiguous characters', () => {
    // A captcha a human cannot read is a lockout, not a control.
    expect(ALPHABET).not.toMatch(/[0O1Il5S2Z8B]/);
    for (let i = 0; i < 40; i += 1) {
      const { svg } = issueChallenge();
      expect(solve(svg)).toMatch(new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`));
    }
  });

  it('does not repeat itself', () => {
    const seen = new Set();
    for (let i = 0; i < 50; i += 1) seen.add(solve(issueChallenge().svg));
    // 25^5 possibilities; 50 draws colliding more than a couple of times would
    // mean the source is not really random.
    expect(seen.size).toBeGreaterThan(45);
  });

  it('emits an image with no script in it', () => {
    const { svg } = issueChallenge();
    expect(svg).not.toMatch(/<script|onload|javascript:/i);
    expect(svg.startsWith('<svg')).toBe(true);
  });
});

describe('when a captcha is asked for', () => {
  it('is not asked for on a first failure', () => {
    // The common case is a typo. Making that person read an image would be the
    // whole institute's experience of this feature.
    captchaGate.noteFailure('asha@nitj.ac.in');
    expect(captchaGate.captchaRequired('asha@nitj.ac.in')).toBe(false);
  });

  it('is asked for after repeated failures on one address', () => {
    for (let i = 0; i < captchaGate.ACCOUNT_FAILURES_BEFORE_CAPTCHA; i += 1) {
      captchaGate.noteFailure('asha@nitj.ac.in');
    }
    expect(captchaGate.captchaRequired('asha@nitj.ac.in')).toBe(true);
  });

  it('does not follow one address to another', () => {
    for (let i = 0; i < 5; i += 1) captchaGate.noteFailure('victim@nitj.ac.in');
    expect(captchaGate.captchaRequired('bystander@nitj.ac.in')).toBe(false);
  });

  it('treats case and padding as the same address', () => {
    for (let i = 0; i < 3; i += 1) captchaGate.noteFailure('  Asha@NITJ.ac.in ');
    expect(captchaGate.captchaRequired('asha@nitj.ac.in')).toBe(true);
  });

  it('forgets an address once it signs in', () => {
    for (let i = 0; i < 3; i += 1) captchaGate.noteFailure('asha@nitj.ac.in');
    captchaGate.noteSuccess('asha@nitj.ac.in');
    expect(captchaGate.captchaRequired('asha@nitj.ac.in')).toBe(false);
  });

  it('lapses on its own', () => {
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) captchaGate.noteFailure('asha@nitj.ac.in', now);
    expect(captchaGate.captchaRequired('asha@nitj.ac.in', now)).toBe(true);
    const later = now + captchaGate.ACCOUNT_WINDOW_MS + 1;
    expect(captchaGate.captchaRequired('asha@nitj.ac.in', later)).toBe(false);
  });

  it('catches spraying, which the per-account counter cannot', () => {
    // One guess each against many addresses: no address is over its own
    // threshold, but the install-wide failure rate is.
    const now = Date.now();
    for (let i = 0; i < captchaGate.GLOBAL_FAILURES_BEFORE_CAPTCHA; i += 1) {
      captchaGate.noteFailure(`victim${i}@nitj.ac.in`, now);
    }
    // An address that has never failed at all is now asked too — the accepted
    // cost of stopping a spray without locking anybody out.
    expect(captchaGate.captchaRequired('untouched@nitj.ac.in', now)).toBe(true);
  });

  it('does not let one success call off an install-wide captcha', () => {
    const now = Date.now();
    for (let i = 0; i < captchaGate.GLOBAL_FAILURES_BEFORE_CAPTCHA; i += 1) {
      captchaGate.noteFailure(`victim${i}@nitj.ac.in`, now);
    }
    captchaGate.noteSuccess('asha@nitj.ac.in', now);
    expect(captchaGate.captchaRequired('asha@nitj.ac.in', now)).toBe(true);
  });

  it('lets an install-wide captcha lapse', () => {
    const now = Date.now();
    for (let i = 0; i < captchaGate.GLOBAL_FAILURES_BEFORE_CAPTCHA; i += 1) {
      captchaGate.noteFailure(`victim${i}@nitj.ac.in`, now);
    }
    const later = now + captchaGate.GLOBAL_WINDOW_MS + 1;
    expect(captchaGate.captchaRequired('untouched@nitj.ac.in', later)).toBe(false);
  });

  it('caps how many addresses it will remember', () => {
    // The login endpoint is unauthenticated, so an uncapped map of every address
    // ever submitted is a memory-growth lever.
    const now = Date.now();
    for (let i = 0; i < captchaGate.MAX_TRACKED_ACCOUNTS + 500; i += 1) {
      captchaGate.noteFailure(`flood${i}@nitj.ac.in`, now);
    }
    expect(captchaGate.failureRate(now).trackedAccounts)
      .toBeLessThanOrEqual(captchaGate.MAX_TRACKED_ACCOUNTS);
  });

  it('reports the failure rate for somebody looking into it', () => {
    const now = Date.now();
    captchaGate.noteFailure('asha@nitj.ac.in', now);
    const rate = captchaGate.failureRate(now);
    expect(rate.recentFailures).toBe(1);
    expect(rate.installWideCaptcha).toBe(false);
  });
});

describe('login with a captcha in play', () => {
  it('says nothing about the captcha on the first failure', async () => {
    stubLookup(null);
    const res = await request(makeApp()).post('/auth/login')
      .send({ email: 'asha@nitj.ac.in', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.captchaRequired).toBe(false);
  });

  it('tells the client once one is needed', async () => {
    // Rather than letting it discover the requirement by being refused again.
    stubLookup(null);
    const app = makeApp();
    let res;
    for (let i = 0; i < captchaGate.ACCOUNT_FAILURES_BEFORE_CAPTCHA; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      res = await request(app).post('/auth/login')
        .send({ email: 'asha@nitj.ac.in', password: 'wrong' });
    }
    expect(res.body.captchaRequired).toBe(true);
  });

  it('refuses the right password when the captcha is missing', async () => {
    // The captcha is a precondition, not a hint. If a correct password got
    // through without it, the whole thing would be decoration.
    const app = makeApp();
    stubLookup(null);
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await request(app).post('/auth/login').send({ email: 'asha@nitj.ac.in', password: 'wrong' });
    }

    stubLookup(userDoc());
    const res = await request(app).post('/auth/login')
      .send({ email: 'asha@nitj.ac.in', password: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.captchaRequired).toBe(true);
    expect(res.body.token).toBeUndefined();
  });

  it('never reaches the database when the captcha is missing', async () => {
    // Refusing before bcrypt is what makes an automated attempt cost something.
    const app = makeApp();
    stubLookup(null);
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await request(app).post('/auth/login').send({ email: 'asha@nitj.ac.in', password: 'wrong' });
    }

    const findOne = jest.spyOn(User, 'findOne');
    findOne.mockClear();
    await request(app).post('/auth/login').send({ email: 'asha@nitj.ac.in', password: 'x' });
    expect(findOne).not.toHaveBeenCalled();
  });

  it('lets a solved captcha through', async () => {
    const app = makeApp();
    stubLookup(null);
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await request(app).post('/auth/login').send({ email: 'asha@nitj.ac.in', password: 'wrong' });
    }

    const challenge = await request(app).get('/auth/captcha');
    expect(challenge.status).toBe(200);

    stubLookup(userDoc());
    const res = await request(app).post('/auth/login').send({
      email: 'asha@nitj.ac.in',
      password: PASSWORD,
      captchaToken: challenge.body.token,
      captchaAnswer: solve(challenge.body.svg),
    });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it('does not count a failed captcha as a failed sign-in', async () => {
    // Otherwise anybody could push a colleague over the rate limit by posting
    // nonsense with their address in it.
    const app = makeApp();
    stubLookup(null);
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await request(app).post('/auth/login').send({ email: 'asha@nitj.ac.in', password: 'wrong' });
    }
    const before = captchaGate.failureRate().recentFailures;

    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await request(app).post('/auth/login').send({
        email: 'asha@nitj.ac.in',
        password: 'wrong',
        captchaToken: 'rubbish',
        captchaAnswer: 'nope',
      });
    }
    expect(captchaGate.failureRate().recentFailures).toBe(before);
  });

  it('asks for a new image only when the old one cannot be reused', async () => {
    const app = makeApp();
    stubLookup(null);
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await request(app).post('/auth/login').send({ email: 'asha@nitj.ac.in', password: 'wrong' });
    }
    const challenge = await request(app).get('/auth/captcha');

    // A typo: same image stays.
    const typo = await request(app).post('/auth/login').send({
      email: 'asha@nitj.ac.in',
      password: 'wrong',
      captchaToken: challenge.body.token,
      captchaAnswer: 'AAAAA',
    });
    expect(typo.body.captchaStale).toBe(false);

    // A token that is not one of ours: new image.
    const junk = await request(app).post('/auth/login').send({
      email: 'asha@nitj.ac.in',
      password: 'wrong',
      captchaToken: 'not-a-token',
      captchaAnswer: 'AAAAA',
    });
    expect(junk.body.captchaStale).toBe(true);
  });

  it('does not let a solved captcha be replayed for a second attempt', async () => {
    const app = makeApp();
    stubLookup(null);
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await request(app).post('/auth/login').send({ email: 'asha@nitj.ac.in', password: 'wrong' });
    }
    const challenge = await request(app).get('/auth/captcha');
    const answer = solve(challenge.body.svg);
    const payload = {
      email: 'asha@nitj.ac.in',
      password: 'wrong',
      captchaToken: challenge.body.token,
      captchaAnswer: answer,
    };

    // First use gets as far as the password, and fails on that.
    const first = await request(app).post('/auth/login').send(payload);
    expect(first.status).toBe(401);

    // Second use of the same token is refused by the captcha, not the password.
    const second = await request(app).post('/auth/login').send(payload);
    expect(second.status).toBe(400);
    expect(second.body.captchaStale).toBe(true);
  });

  it('serves the challenge uncached', async () => {
    // A cached challenge is one somebody else has already solved.
    const res = await request(makeApp()).get('/auth/captcha');
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  it('does not reveal whether the address is registered', async () => {
    // The captcha requirement is keyed on the submitted address whether or not
    // an account exists, so it cannot be used to enumerate accounts — which is
    // the same property the uniform failure message protects.
    const app = makeApp();
    stubLookup(null);

    const responses = [];
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      responses.push(await request(app).post('/auth/login')
        .send({ email: 'nobody-at-all@nitj.ac.in', password: 'wrong' }));
    }
    expect(responses.at(-1).body.captchaRequired).toBe(true);
    expect(responses.at(-1).body.message).toBe('Invalid email or password.');
  });
});
