// Points, badges and the two leaderboards.
//
// The behaviours worth pinning are the ones a student would try to break:
// re-submitting the same work for a second helping, and farming the cheapest
// award available. Both are held by the unique index on the ledger rather than
// by a read-then-write check, which is what these exercise.
const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const jwt = require("jsonwebtoken");

jest.mock("../../src/modules/mailerModule/mailer", () => ({
  sendMail: jest.fn(),
  sendBulkMail: jest.fn().mockResolvedValue({ sent: 0, failed: 0 }),
}));

const { connect, clearDatabase, disconnect } = require("../helpers/db");

const User = require("../../src/models/usermanagement/user");
const LmClass = require("../../src/modules/learningModule/models/lmClass");
const LmMembership = require("../../src/modules/learningModule/models/lmMembership");
const LmPoints = require("../../src/modules/learningModule/models/lmPoints");
const LmBadge = require("../../src/modules/learningModule/models/lmBadge");
const game = require("../../src/modules/learningModule/services/gamification");

const BASE = "/api/v1/learningmodule";

let app;

function buildApp() {
  const application = express();
  application.use(express.json());
  application.use(cookieParser());
  application.use(BASE, require("../../src/modules/learningModule/routes/index"));
  return application;
}

const cookieFor = (user, role) => [
  `jwt=${jwt.sign({ id: user.id, role: [role] }, process.env.JWT_SECRET)}`,
];

async function seedClass() {
  const teacher = await User.create({
    name: "Prof. Rao",
    role: ["FACULTY"],
    password: "hashed",
    dept: "Electronics and Communication Engineering",
    email: ["rao@example.com"],
  });
  const klass = await LmClass.create({
    name: "Digital Signal Processing",
    code: `c${Math.random().toString(36).slice(2, 8)}`,
    ownerId: teacher._id,
    coverColor: "#1967d2",
  });
  await LmMembership.create({ classId: klass._id, userId: teacher._id, role: "teacher", status: "active" });
  return { teacher, klass };
}

async function seedStudent(klass, name) {
  const student = await User.create({
    name,
    role: ["STUDENT"],
    password: "hashed",
    email: [`${name}@example.com`],
  });
  await LmMembership.create({
    classId: klass._id,
    userId: student._id,
    email: `${name}@example.com`,
    role: "student",
    status: "active",
  });
  return student;
}

const mongoose = require("mongoose");
const oid = (value) => new mongoose.Types.ObjectId(String(value));

beforeAll(async () => {
  await connect();
  // Not incidental setup. Both "award once" rules *are* the unique indexes —
  // the code inserts and lets a duplicate-key error tell it the award already
  // existed, rather than reading first and racing itself. Mongoose builds
  // indexes in the background, so without waiting for them here the tests race
  // the very mechanism they are checking, and pass or fail on timing.
  await Promise.all([LmPoints.init(), LmBadge.init()]);
  app = buildApp();
});
afterEach(clearDatabase);
afterAll(disconnect);

describe("points ledger", () => {
  it("pays once for the same piece of work, however many times it is submitted", async () => {
    const { klass } = await seedClass();
    const student = await seedStudent(klass, "asha");
    const work = oid(new mongoose.Types.ObjectId());

    const first = await game.award({
      classId: klass._id,
      studentId: student._id,
      studentName: student.name,
      kind: "submission",
      points: 10,
      reason: "Turned in a thing",
      refId: work,
    });
    const second = await game.award({
      classId: klass._id,
      studentId: student._id,
      studentName: student.name,
      kind: "submission",
      points: 10,
      reason: "Turned in a thing",
      refId: work,
    });

    expect(first).toBe(true);
    expect(second).toBe(false); // the index refused it, not a check
    expect(await LmPoints.countDocuments({ classId: klass._id })).toBe(1);
  });

  it("allows several bonuses, which carry no reference to collide on", async () => {
    const { klass } = await seedClass();
    const student = await seedStudent(klass, "asha");
    const bonus = () =>
      game.award({
        classId: klass._id,
        studentId: student._id,
        studentName: student.name,
        kind: "bonus",
        points: 5,
        reason: "Helped in the lab",
      });

    expect(await bonus()).toBe(true);
    expect(await bonus()).toBe(true);
    expect(await LmPoints.countDocuments({ classId: klass._id })).toBe(2);
  });

  it("stamps the week so the same award lands on the right table", async () => {
    const { klass } = await seedClass();
    const student = await seedStudent(klass, "asha");
    const lastYear = new Date(Date.UTC(2026, 0, 8));

    await game.award({
      classId: klass._id,
      studentId: student._id,
      studentName: student.name,
      kind: "bonus",
      points: 5,
      reason: "Backdated",
      at: lastYear,
    });

    const [row] = await LmPoints.find({ classId: klass._id }).lean();
    expect(row.weekKey).toBe("2026-W02");
  });
});

describe("badges", () => {
  it("grants a badge once", async () => {
    const { klass } = await seedClass();
    const student = await seedStudent(klass, "asha");
    const grant = () =>
      game.grantBadge({
        classId: klass._id,
        studentId: student._id,
        studentName: student.name,
        badge: "full-send",
      });

    expect(await grant()).toBe(true);
    expect(await grant()).toBe(false);
    expect(await LmBadge.countDocuments({})).toBe(1);
  });

  it("refuses a badge that is not in the catalogue", async () => {
    const { klass } = await seedClass();
    const student = await seedStudent(klass, "asha");
    expect(
      await game.grantBadge({
        classId: klass._id,
        studentId: student._id,
        studentName: student.name,
        badge: "not-a-badge",
      }),
    ).toBe(false);
    expect(await LmBadge.countDocuments({})).toBe(0);
  });
});

describe("leaderboard", () => {
  const pay = (klass, student, points, at = new Date()) =>
    LmPoints.create({
      classId: klass._id,
      studentId: student._id,
      studentName: student.name,
      kind: "bonus",
      points,
      reason: "test",
      weekKey: game.weekKeyOf(at),
      created_at: at,
    });

  it("ranks by points, and breaks a tie on who got there first", async () => {
    const { klass } = await seedClass();
    const early = await seedStudent(klass, "asha");
    const later = await seedStudent(klass, "bala");

    await pay(klass, later, 30, new Date(Date.now() - 1000));
    await pay(klass, early, 30, new Date(Date.now() - 60_000));

    const rows = await game.leaderboard({ classId: klass._id });
    expect(rows.map((row) => row.studentName)).toEqual(["asha", "bala"]);
    expect(rows[0].rank).toBe(1);
  });

  it("counts only this week on the weekly board", async () => {
    const { klass } = await seedClass();
    const student = await seedStudent(klass, "asha");

    await pay(klass, student, 40, new Date(Date.now() - 21 * 864e5));
    await pay(klass, student, 7);

    const [weekly] = await game.leaderboard({ classId: klass._id, weekKey: game.weekKeyOf() });
    const [overall] = await game.leaderboard({ classId: klass._id });
    expect(weekly.points).toBe(7);
    expect(overall.points).toBe(47);
  });

  it("serves both boards and the caller's own standing over the API", async () => {
    const { klass } = await seedClass();
    const student = await seedStudent(klass, "asha");
    await pay(klass, student, 12);
    await game.grantBadge({
      classId: klass._id,
      studentId: student._id,
      studentName: student.name,
      badge: "full-send",
    });

    const res = await request(app)
      .get(`${BASE}/classes/${klass._id}/leaderboard?scope=week`)
      .set("Cookie", cookieFor(student, "STUDENT"));

    expect(res.status).toBe(200);
    expect(res.body.rows[0]).toMatchObject({ studentName: "asha", points: 12, badges: 1, isMe: true });
    expect(res.body.me).toMatchObject({ points: 12, weeklyPoints: 12, rank: 1 });
    // The whole catalogue ships with it, so unearned badges can be shown dimmed
    // rather than hidden — a badge nobody knows about cannot be aimed at.
    expect(res.body.catalogue.length).toBe(Object.keys(game.BADGES).length);
  });

  it("lets a student read their own points and where they came from", async () => {
    const { klass } = await seedClass();
    const student = await seedStudent(klass, "asha");
    await pay(klass, student, 9);

    const res = await request(app)
      .get(`${BASE}/classes/${klass._id}/my-points`)
      .set("Cookie", cookieFor(student, "STUDENT"));

    expect(res.status).toBe(200);
    expect(res.body.points).toBe(9);
    // "You have 9 points" is not much use without the why.
    expect(res.body.history).toHaveLength(1);
    expect(res.body.history[0]).toMatchObject({ points: 9, reason: "test" });
  });
});

/**
 * The hard tier.
 *
 * These are meant to be rare, so the risk runs the other way from the easy
 * badges: a criterion that is accidentally loose hands out a "rare" badge in
 * week one and it is worth nothing thereafter. Each of these checks the badge
 * is *withheld* as well as granted.
 */
describe("the hard badges", () => {
  const pay = (klass, student, { points = 5, at = new Date(), kind = "bonus", reason = "test", refId } = {}) =>
    LmPoints.create({
      classId: klass._id,
      studentId: student._id,
      studentName: student.name,
      kind,
      points,
      reason,
      refId,
      weekKey: game.weekKeyOf(at),
      created_at: at,
    });

  it("holds GOATed back until five hundred points", async () => {
    const { klass } = await seedClass();
    const student = await seedStudent(klass, "asha");
    const who = { classId: klass._id, studentId: student._id, studentName: student.name };

    await pay(klass, student, { points: 499, refId: oid(new mongoose.Types.ObjectId()) });
    await game.checkStandingBadges(who);
    expect(await LmBadge.countDocuments({ badge: "goated" })).toBe(0);

    await pay(klass, student, { points: 1, refId: oid(new mongoose.Types.ObjectId()) });
    await game.checkStandingBadges(who);
    expect(await LmBadge.countDocuments({ badge: "goated" })).toBe(1);
  });

  it("needs ten separate weeks for No Off Season, not ten awards", async () => {
    const { klass } = await seedClass();
    const student = await seedStudent(klass, "asha");
    const who = { classId: klass._id, studentId: student._id, studentName: student.name };

    // Ten awards, all in one week: activity, but not persistence.
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await pay(klass, student, { refId: oid(new mongoose.Types.ObjectId()) });
    }
    await game.checkStandingBadges(who);
    expect(await LmBadge.countDocuments({ badge: "no-off-season" })).toBe(0);

    for (let i = 1; i <= 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await pay(klass, student, {
        at: new Date(Date.now() - i * 7 * 864e5),
        refId: oid(new mongoose.Types.ObjectId()),
      });
    }
    await game.checkStandingBadges(who);
    expect(await LmBadge.countDocuments({ badge: "no-off-season" })).toBe(1);
  });

  it("records a weekly win once however often the board is read", async () => {
    const { klass } = await seedClass();
    const student = await seedStudent(klass, "asha");
    await pay(klass, student, { points: 20, at: new Date(Date.now() - 7 * 864e5) });

    await game.crownLastWeek(klass._id);
    await game.crownLastWeek(klass._id);
    await game.crownLastWeek(klass._id);

    // Three reads, one win — otherwise Final Boss would arrive by refreshing.
    expect(await LmPoints.countDocuments({ reason: /^Won the week of / })).toBe(1);
    expect(await LmBadge.countDocuments({ badge: "final-boss" })).toBe(0);
    expect(await LmBadge.countDocuments({ badge: "main-character" })).toBe(1);
  });
});

/**
 * Session scoping.
 *
 * A class belongs to exactly one academic session, so anything already scoped
 * per class is already scoped per session. The stored `session` is what lets a
 * profile *group* a whole career without loading every class to read one string
 * off each — so what matters is that it is actually copied onto every award,
 * including from the routes that have no class on the request.
 */
describe("session scoping", () => {
  it("stamps the class's session onto points and badges", async () => {
    const { klass } = await seedClass();
    klass.session = "2026-27 Odd";
    await klass.save();
    const student = await seedStudent(klass, "asha");

    await game.award({
      classId: klass._id,
      studentId: student._id,
      studentName: student.name,
      kind: "bonus",
      points: 5,
      reason: "test",
      session: klass.session,
    });
    await game.grantBadge({
      classId: klass._id,
      studentId: student._id,
      studentName: student.name,
      badge: "full-send",
      session: klass.session,
    });

    expect((await LmPoints.findOne({}).lean()).session).toBe("2026-27 Odd");
    expect((await LmBadge.findOne({}).lean()).session).toBe("2026-27 Odd");
  });

  it("leaves the session blank rather than guessing when the class has none", async () => {
    // Classes created before this was recorded. "" reads as unrecorded
    // everywhere downstream; inventing a session would file real points under
    // a term that never happened.
    const { klass } = await seedClass();
    const student = await seedStudent(klass, "asha");

    await game.award({
      classId: klass._id,
      studentId: student._id,
      studentName: student.name,
      kind: "bonus",
      points: 5,
      reason: "test",
    });

    expect((await LmPoints.findOne({}).lean()).session).toBe("");
  });

  it("carries the session through the badge helpers, not just the direct calls", async () => {
    // `checkStandingBadges` is reached by spreading `...who`; it used to
    // destructure the session away and grant an unstamped badge.
    const { klass } = await seedClass();
    klass.session = "2026-27 Odd";
    await klass.save();
    const student = await seedStudent(klass, "asha");

    await LmPoints.create({
      classId: klass._id,
      studentId: student._id,
      studentName: student.name,
      kind: "bonus",
      points: 120,
      reason: "test",
      session: klass.session,
      weekKey: game.weekKeyOf(),
      refId: oid(new mongoose.Types.ObjectId()),
    });
    await game.checkStandingBadges({
      classId: klass._id,
      studentId: student._id,
      studentName: student.name,
      session: klass.session,
    });

    const badge = await LmBadge.findOne({ badge: "triple-digits" }).lean();
    expect(badge.session).toBe("2026-27 Odd");
  });
});
