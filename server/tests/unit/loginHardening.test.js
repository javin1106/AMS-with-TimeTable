/**
 * The login endpoint's protections.
 *
 * Driven through a real Express app with the real middleware and the real
 * handler; only Mongo is stubbed, because none of what is asserted here depends
 * on the database — it depends on what the handler says, how long it takes to
 * say it, and whether the throttle counted the attempt.
 *
 * The rate-limit assertions matter more than they look. The previous limiter was
 * registered on `/api/v1/users/login`, a path that matches no route in this
 * application, so login was unthrottled while appearing to be protected. A test
 * that drives the real path is the only kind that would have caught that.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-login-tests';

const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');

const User = require('../../src/models/usermanagement/user');
const { applyAuthRateLimits, accountKey } = require('../../src/modules/usermanagement/loginRateLimit');
const { login } = require('../../src/modules/usermanagement/controllers/usercontroller');

const PASSWORD = 'correct-horse-battery-staple';
let passwordHash;

/** A user document as `findOne(...).select('+password')` would return one. */
const userDoc = (overrides = {}) => ({
  _id: '507f1f77bcf86cd799439011',
  name: 'Asha Rao',
  email: ['asha@nitj.ac.in'],
  role: ['FACULTY'],
  password: passwordHash,
  dept: 'CSE',
  attendanceDepartments: ['CSE'],
  ...overrides,
});

/** Stubs findOne().select() to resolve to whatever the test wants. */
const stubLookup = (result) => {
  jest.spyOn(User, 'findOne').mockReturnValue({ select: () => Promise.resolve(result) });
};

/** A fresh app each time so rate-limit counters never leak between tests. */
const makeApp = ({ throttled = false } = {}) => {
  const app = express();
  app.use(express.json());
  if (throttled) applyAuthRateLimits(app);
  app.post('/auth/login', login);
  app.post('/api/v1/auth/login', login);
  return app;
};

beforeAll(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 10);
});

afterEach(() => jest.restoreAllMocks());

describe('login — uniform failure', () => {
  it('answers the same for an unknown account and a wrong password', async () => {
    stubLookup(null);
    const unknown = await request(makeApp()).post('/auth/login')
      .send({ email: 'nobody@nitj.ac.in', password: 'whatever' });

    stubLookup(userDoc());
    const wrongPassword = await request(makeApp()).post('/auth/login')
      .send({ email: 'asha@nitj.ac.in', password: 'not-the-password' });

    expect(unknown.status).toBe(wrongPassword.status);
    expect(unknown.body).toEqual(wrongPassword.body);
    // Anything that names which half failed hands over a list of who has an
    // account here.
    expect(JSON.stringify(unknown.body)).not.toMatch(/not found|no such|unknown|exist/i);
  });

  it('does not leak the reason in an `error` field', async () => {
    stubLookup(null);
    const res = await request(makeApp()).post('/auth/login')
      .send({ email: 'nobody@nitj.ac.in', password: 'x' });
    expect(res.body.error).toBeUndefined();
  });

  it('uses 401 rather than 400 for bad credentials', async () => {
    stubLookup(userDoc());
    const res = await request(makeApp()).post('/auth/login')
      .send({ email: 'asha@nitj.ac.in', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('still rejects a missing field as a bad request', async () => {
    // A malformed call is not a credential failure and should not be counted or
    // reported as one.
    const res = await request(makeApp()).post('/auth/login').send({ email: 'asha@nitj.ac.in' });
    expect(res.status).toBe(400);
  });

  it('refuses a Mongo operator smuggled in as the email', async () => {
    // `{"email": {"$ne": null}}` reaches findOne as a query operator and would
    // match an arbitrary account. Not a bypass — the password still has to
    // verify — but it lets an unauthenticated caller choose which document the
    // server looks at.
    const findOne = jest.spyOn(User, 'findOne');
    const res = await request(makeApp()).post('/auth/login')
      .send({ email: { $ne: null }, password: 'x' });
    expect(res.status).toBe(400);
    expect(findOne).not.toHaveBeenCalled();
  });

  it('refuses a non-string password', async () => {
    const findOne = jest.spyOn(User, 'findOne');
    const res = await request(makeApp()).post('/auth/login')
      .send({ email: 'asha@nitj.ac.in', password: { $ne: null } });
    expect(res.status).toBe(400);
    expect(findOne).not.toHaveBeenCalled();
  });

  it('does the bcrypt work even when the account does not exist', async () => {
    // The timing defence. Asserted through bcrypt rather than by clocking the
    // response, because a wall-clock threshold is exactly the kind of test that
    // fails randomly on a loaded CI box.
    const compare = jest.spyOn(bcrypt, 'compare');
    stubLookup(null);
    await request(makeApp()).post('/auth/login').send({ email: 'ghost@nitj.ac.in', password: 'x' });
    expect(compare).toHaveBeenCalledTimes(1);
  });

  it('never echoes an internal error to the caller', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(User, 'findOne').mockImplementation(() => {
      throw new Error('E11000 duplicate key on cluster0-shard-00-02.mongodb.net');
    });
    const res = await request(makeApp()).post('/auth/login')
      .send({ email: 'asha@nitj.ac.in', password: 'x' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/mongodb|E11000|shard/i);
  });
});

describe('login — what comes back on success', () => {
  it('signs the user in', async () => {
    stubLookup(userDoc());
    const res = await request(makeApp()).post('/auth/login')
      .send({ email: 'asha@nitj.ac.in', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it('never returns the password hash', async () => {
    // The whole Mongoose document used to go back, hash included.
    stubLookup(userDoc());
    const res = await request(makeApp()).post('/auth/login')
      .send({ email: 'asha@nitj.ac.in', password: PASSWORD });
    expect(JSON.stringify(res.body)).not.toContain(passwordHash);
    expect(res.body.user.password).toBeUndefined();
  });

  it('returns only the fields the client needs', async () => {
    stubLookup(userDoc());
    const res = await request(makeApp()).post('/auth/login')
      .send({ email: 'asha@nitj.ac.in', password: PASSWORD });
    expect(Object.keys(res.body.user).sort()).toEqual(['email', 'id', 'name', 'role']);
    // Internal bookkeeping stays internal.
    expect(res.body.user.dept).toBeUndefined();
    expect(res.body.user.attendanceDepartments).toBeUndefined();
  });

  it('sets the session cookie httpOnly', async () => {
    stubLookup(userDoc());
    const res = await request(makeApp()).post('/auth/login')
      .send({ email: 'asha@nitj.ac.in', password: PASSWORD });
    expect(String(res.headers['set-cookie'])).toMatch(/HttpOnly/i);
  });
});

describe('login — the password field is not selectable by accident', () => {
  it('is select:false on the schema', () => {
    // What stops the next controller that returns a user document from shipping
    // the hash again.
    expect(User.schema.path('password').options.select).toBe(false);
  });
});

describe('login — throttling', () => {
  it('throttles the path login actually lives on', async () => {
    // The regression this file exists for.
    stubLookup(null);
    const app = makeApp({ throttled: true });

    const codes = [];
    for (let i = 0; i < 7; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).post('/auth/login')
        .send({ email: 'target@nitj.ac.in', password: 'guess' });
      codes.push(res.status);
    }

    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes.slice(5)).toEqual([429, 429]);
  });

  it('throttles the /api/v1 spelling too', async () => {
    // The router is mounted twice; a limiter on only one spelling is bypassed by
    // dropping the prefix.
    stubLookup(null);
    const app = makeApp({ throttled: true });
    const codes = [];
    for (let i = 0; i < 7; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).post('/api/v1/auth/login')
        .send({ email: 'target2@nitj.ac.in', password: 'guess' });
      codes.push(res.status);
    }
    expect(codes).toContain(429);
  });

  it('counts per account, so one victim does not lock out the campus', async () => {
    // Everyone here shares a source IP in the test, as they would behind campus
    // NAT. A second account must still be able to sign in after the first has
    // been ground into the ground.
    stubLookup(null);
    const app = makeApp({ throttled: true });

    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await request(app).post('/auth/login').send({ email: 'victim@nitj.ac.in', password: 'guess' });
    }

    stubLookup(userDoc());
    const bystander = await request(app).post('/auth/login')
      .send({ email: 'asha@nitj.ac.in', password: PASSWORD });
    expect(bystander.status).toBe(200);
  });

  it('does not count successful sign-ins against the account', async () => {
    // Otherwise a shared demo account signing in all morning locks itself out.
    stubLookup(userDoc());
    const app = makeApp({ throttled: true });
    const codes = [];
    for (let i = 0; i < 8; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).post('/auth/login')
        .send({ email: 'asha@nitj.ac.in', password: PASSWORD });
      codes.push(res.status);
    }
    expect(codes.every((code) => code === 200)).toBe(true);
  });
});

describe('login — the throttle key', () => {
  it('treats case and padding as the same account', () => {
    // Otherwise the budget is trivially multiplied by retyping the address.
    expect(accountKey({ body: { email: '  Asha@NITJ.ac.in ' } })).toBe('asha@nitj.ac.in');
  });

  it('buckets a missing email together rather than minting a fresh key', () => {
    expect(accountKey({ body: {} })).toBe('__no_email__');
    expect(accountKey({ body: { email: '   ' } })).toBe('__no_email__');
    expect(accountKey({})).toBe('__no_email__');
  });

  it('does not accept a non-string as a key', () => {
    // A JSON body can carry an object or an array where a string was expected.
    expect(accountKey({ body: { email: { $ne: null } } })).toBe('__no_email__');
    expect(accountKey({ body: { email: ['a@b.c'] } })).toBe('__no_email__');
  });
});
