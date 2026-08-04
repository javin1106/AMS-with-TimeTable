// Bug reports, and the profile that adds a whole career up.
//
// The rule with money on it: points are paid on *acknowledgement*, once. Paying
// on submission would make "report a bug" a button worth pressing for its own
// sake, and an admin flipping a ticket acknowledged → fixed → acknowledged must
// not pay twice.
//
// The other thing worth pinning is that a platform bug earns points with **no
// class**. Crediting it to one would put it on that class's leaderboard, where
// finding a defect in the software has no business being.
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
const LmBugReport = require("../../src/modules/learningModule/models/lmBugReport");
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

const cookieFor = (user, roles) => [
  `jwt=${jwt.sign({ id: user.id, role: roles }, process.env.JWT_SECRET)}`,
];

async function seedStudentInClass({ session = "2026-27 Odd" } = {}) {
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
    session,
  });
  const student = await User.create({
    name: "asha",
    role: ["STUDENT"],
    password: "hashed",
    email: ["asha@example.com"],
  });
  await LmMembership.create({
    classId: klass._id,
    userId: student._id,
    email: "asha@example.com",
    role: "student",
    status: "active",
  });
  return { klass, student };
}

const seedAdmin = () =>
  User.create({
    name: "Admin",
    role: ["admin"],
    password: "hashed",
    email: ["admin@example.com"],
  });

const report = (user, body) =>
  request(app).post(`${BASE}/bugs`).set("Cookie", cookieFor(user, ["STUDENT"])).send(body);

const review = (admin, id, body) =>
  request(app).patch(`${BASE}/bugs/${id}`).set("Cookie", cookieFor(admin, ["admin"])).send(body);

beforeAll(async () => {
  await connect();
  await Promise.all([LmPoints.init(), LmBadge.init()]);
  app = buildApp();
});
afterEach(clearDatabase);
afterAll(disconnect);

describe("reporting a bug", () => {
  it("pays nothing until an admin says it is real", async () => {
    const { student } = await seedStudentInClass();

    const created = await report(student, { title: "The timer keeps running after submit" });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("open");

    // Paying on submission would make this a button worth pressing for its own
    // sake, and the queue would fill faster than anyone could read it.
    expect(await LmPoints.countDocuments({})).toBe(0);
  });

  it("pays once the admin acknowledges it, and only once", async () => {
    const { student } = await seedStudentInClass();
    const admin = await seedAdmin();
    const created = await report(student, { title: "Timer keeps running" });

    await review(admin, created.body._id, { status: "acknowledged" });
    // acknowledged → fixed → acknowledged must not pay a second time.
    await review(admin, created.body._id, { status: "fixed" });
    await review(admin, created.body._id, { status: "acknowledged" });

    const rows = await LmPoints.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].points).toBe(game.POINTS.bugReport);
  });

  it("pays nothing for a report the admin rejects", async () => {
    const { student } = await seedStudentInClass();
    const admin = await seedAdmin();
    const created = await report(student, { title: "Not actually broken" });

    await review(admin, created.body._id, { status: "rejected", adminNote: "Working as intended" });
    expect(await LmPoints.countDocuments({})).toBe(0);
  });

  it("refuses a verdict from anyone who is not a platform admin", async () => {
    const { student } = await seedStudentInClass();
    const created = await report(student, { title: "Mine" });

    // Not even their own — otherwise a report is a self-service payout.
    const res = await request(app)
      .patch(`${BASE}/bugs/${created.body._id}`)
      .set("Cookie", cookieFor(student, ["STUDENT"]))
      .send({ status: "acknowledged" });

    expect(res.status).toBe(403);
    expect(await LmPoints.countDocuments({})).toBe(0);
  });
});

describe("class-specific versus platform-wide", () => {
  it("badges a class bug in that class, and files the points there", async () => {
    const { klass, student } = await seedStudentInClass();
    const admin = await seedAdmin();

    const created = await report(student, { title: "Quiz timer wrong", classId: String(klass._id) });
    await review(admin, created.body._id, { status: "acknowledged" });

    const award = await LmPoints.findOne({}).lean();
    expect(String(award.classId)).toBe(String(klass._id));
    expect(award.session).toBe("2026-27 Odd");

    const badge = await LmBadge.findOne({}).lean();
    expect(badge.badge).toBe("bug-bounty");
    expect(String(badge.classId)).toBe(String(klass._id));
  });

  it("pays a platform bug with no class, so no leaderboard moves", async () => {
    const { klass, student } = await seedStudentInClass();
    const admin = await seedAdmin();

    const created = await report(student, { title: "Login page is broken on Firefox" });
    await review(admin, created.body._id, { status: "acknowledged" });

    const award = await LmPoints.findOne({}).lean();
    expect(award.classId).toBeNull();
    expect(award.points).toBe(game.POINTS.bugReport);

    // Finding a defect in the software is not participation in Digital Signal
    // Processing, and the class table must not move for it.
    const rows = await game.leaderboard({ classId: klass._id });
    expect(rows).toHaveLength(0);

    // …but it still counts on the reporter's own profile.
    const profile = await game.profileFor(student._id);
    expect(profile.totalPoints).toBe(game.POINTS.bugReport);

    // No class means no badge — badges live in a class — but the points stand.
    expect(await LmBadge.countDocuments({})).toBe(0);
  });

  it("ignores a class the reporter is not actually in", async () => {
    const { student } = await seedStudentInClass();
    const outsider = await LmClass.create({
      name: "Somebody else's class",
      code: `c${Math.random().toString(36).slice(2, 8)}`,
      ownerId: student._id,
      coverColor: "#1967d2",
    });
    const admin = await seedAdmin();

    const created = await report(student, { title: "Sneaky", classId: String(outsider._id) });
    await review(admin, created.body._id, { status: "acknowledged" });

    // Otherwise a report is a way to put a badge in a class you are not in.
    expect(await LmBadge.countDocuments({})).toBe(0);
    expect((await LmPoints.findOne({}).lean()).classId).toBeNull();
  });
});

describe("bugs versus suggestions", () => {
  it("defaults to a bug, and refuses to invent a third kind", async () => {
    const { student } = await seedStudentInClass();

    const plain = await report(student, { title: "No kind given" });
    expect(plain.body.kind).toBe("bug");

    // A defect miscategorised as a suggestion is the costlier mistake, so
    // anything unrecognised falls back to the queue that gets read first.
    const nonsense = await report(student, { title: "Nonsense kind", kind: "feature-request" });
    expect(nonsense.body.kind).toBe("bug");

    const wanted = await report(student, { title: "Dark mode please", kind: "suggestion" });
    expect(wanted.body.kind).toBe("suggestion");
  });

  it("counts legacy rows as bugs when the queue is filtered", async () => {
    const { student } = await seedStudentInClass();
    const admin = await seedAdmin();

    await report(student, { title: "Broken", kind: "bug" });
    await report(student, { title: "Could be better", kind: "suggestion" });
    // Written before `kind` existed: no value at all. Filtering to bugs has to
    // include it, or the queue would appear to empty itself on upgrade.
    await LmBugReport.collection.insertOne({
      reporterId: student._id,
      title: "From before the field existed",
      status: "open",
      created_at: new Date(),
    });

    const bugs = await request(app)
      .get(`${BASE}/bugs?kind=bug`)
      .set("Cookie", cookieFor(admin, ["admin"]));
    expect(bugs.body.reports.map((row) => row.title).sort()).toEqual([
      "Broken",
      "From before the field existed",
    ]);
    expect(bugs.body.kindCounts).toEqual({ bug: 2, suggestion: 1 });

    const ideas = await request(app)
      .get(`${BASE}/bugs?kind=suggestion`)
      .set("Cookie", cookieFor(admin, ["admin"]));
    expect(ideas.body.reports).toHaveLength(1);
  });
});

describe("mailing the admins", () => {
  const { sendBulkMail } = require("../../src/modules/mailerModule/mailer");

  beforeEach(() => sendBulkMail.mockClear());

  // The send is deliberately not awaited by the handler — the reporter should
  // not wait on SMTP — and resolving the recipients is a database round trip,
  // so there is no fixed number of ticks to drain. Poll for the call instead,
  // and give up quickly enough that "never sent" still fails fast.
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const settle = async () => {
    for (let waited = 0; waited < 2000; waited += 10) {
      if (sendBulkMail.mock.calls.length) return;
      // eslint-disable-next-line no-await-in-loop
      await pause(10);
    }
  };

  it("mails every platform admin the report itself", async () => {
    const { student } = await seedStudentInClass();
    await seedAdmin();
    await User.create({
      name: "Super",
      role: ["lm-admin"],
      password: "hashed",
      email: ["super@example.com"],
    });

    await report(student, {
      title: "Timer keeps running after submit",
      description: "Submitted the quiz and the clock carried on counting down.",
    });
    await settle();

    expect(sendBulkMail).toHaveBeenCalledTimes(1);
    const [recipients, subject, html] = sendBulkMail.mock.calls[0];
    expect(recipients.sort()).toEqual(["admin@example.com", "super@example.com"]);
    expect(subject).toContain("Timer keeps running after submit");
    // The whole report travels in the body: an admin should be able to read it
    // without signing in, and only follow the link to act on it.
    expect(html).toContain("Submitted the quiz and the clock carried on counting down.");
    expect(html).toContain("asha@example.com");
  });

  it("does not mail the teacher of the class, only administrators", async () => {
    const { klass, student } = await seedStudentInClass();
    await seedAdmin();

    await report(student, { title: "Class-specific", classId: String(klass._id) });
    await settle();

    // rao@example.com owns the class but is FACULTY, not a platform admin, and
    // cannot act on the queue — mailing them would be noise they cannot clear.
    expect(sendBulkMail.mock.calls[0][0]).toEqual(["admin@example.com"]);
  });

  it("still records the report when there is nobody to mail", async () => {
    const { student } = await seedStudentInClass();

    const created = await report(student, { title: "Nobody is listening" });
    // Nothing to poll for here — the point is that nothing happens — so give
    // the fire-and-forget path long enough to have sent if it were going to.
    await pause(300);

    // Mail is best-effort: a report that was written down must never be lost to
    // an empty recipient list or an unreachable mail box.
    expect(created.status).toBe(201);
    expect(await LmBugReport.countDocuments({})).toBe(1);
    expect(sendBulkMail).not.toHaveBeenCalled();
  });
});

describe("the profile", () => {
  it("groups a whole career by session, newest first", async () => {
    const { klass, student } = await seedStudentInClass({ session: "2026-27 Odd" });
    const older = await LmClass.create({
      name: "Signals and Systems",
      code: `c${Math.random().toString(36).slice(2, 8)}`,
      ownerId: klass.ownerId,
      coverColor: "#1967d2",
      session: "2025-26 Even",
    });

    const pay = (classId, session, points) =>
      LmPoints.create({
        classId,
        studentId: student._id,
        studentName: student.name,
        kind: "bonus",
        points,
        reason: "test",
        session,
        weekKey: game.weekKeyOf(),
      });

    await pay(klass._id, "2026-27 Odd", 40);
    await pay(older._id, "2025-26 Even", 25);
    await pay(null, "", 10); // earned outside any class

    const res = await request(app)
      .get(`${BASE}/me/profile`)
      .set("Cookie", cookieFor(student, ["STUDENT"]));

    expect(res.status).toBe(200);
    expect(res.body.totalPoints).toBe(75);
    // Current term first; the unrecorded bucket last rather than hidden.
    expect(res.body.sessions.map((entry) => entry.session)).toEqual([
      "2026-27 Odd",
      "2025-26 Even",
      "",
    ]);
    expect(res.body.sessions[0].classes[0]).toMatchObject({
      name: "Digital Signal Processing",
      points: 40,
    });
    expect(res.body.sessions[2].classes[0]).toMatchObject({ name: "Outside any class", points: 10 });
  });

  it("still counts points from a class that has since been deleted", async () => {
    const { student } = await seedStudentInClass();
    const gone = await LmClass.create({
      name: "Deleted later",
      code: `c${Math.random().toString(36).slice(2, 8)}`,
      ownerId: student._id,
      coverColor: "#1967d2",
      session: "2025-26 Even",
    });
    await LmPoints.create({
      classId: gone._id,
      studentId: student._id,
      studentName: student.name,
      kind: "bonus",
      points: 30,
      reason: "test",
      session: "2025-26 Even",
      weekKey: game.weekKeyOf(),
    });
    await LmClass.deleteOne({ _id: gone._id });

    const res = await request(app)
      .get(`${BASE}/me/profile`)
      .set("Cookie", cookieFor(student, ["STUDENT"]));

    // Dropping it would silently make the total wrong.
    expect(res.body.totalPoints).toBe(30);
    expect(res.body.sessions[0].classes[0].name).toBe("A class that no longer exists");
  });
});
