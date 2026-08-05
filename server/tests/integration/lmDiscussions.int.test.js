// The class forum.
//
// The rule with teeth is one new topic per student per week, and it is a unique
// index rather than a count — a read-then-write would let a double-tapped
// button through, and "how many have I posted this week" is exactly the
// question two simultaneous requests both answer with "none".
//
// The other thing worth pinning is that removing a thread does *not* hand the
// week back. Post → delete → post would otherwise make the limit no limit at
// all, which is the obvious implementation and the wrong one.
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
const LmDiscussion = require("../../src/modules/learningModule/models/lmDiscussion");
const LmComment = require("../../src/modules/learningModule/models/lmComment");
const LmPoints = require("../../src/modules/learningModule/models/lmPoints");
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

async function seed() {
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

  return { teacher, klass, student };
}

const start = (klass, cookie, body) =>
  request(app).post(`${BASE}/classes/${klass._id}/discussions`).set("Cookie", cookie).send(body);

const list = (klass, cookie) =>
  request(app).get(`${BASE}/classes/${klass._id}/discussions`).set("Cookie", cookie);

beforeAll(async () => {
  await connect();
  // The weekly limit *is* this index — see the file header.
  await LmDiscussion.init();
  app = buildApp();
});
afterEach(clearDatabase);
afterAll(disconnect);

describe("starting a discussion", () => {
  it("lets a student open a topic and pays them for it", async () => {
    const { klass, student } = await seed();

    const res = await start(klass, cookieFor(student, "STUDENT"), {
      title: "Why does the FFT need a power of two?",
      body: "Struggling with the radix-2 bit.",
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ title: "Why does the FFT need a power of two?", replyCount: 0 });

    const [award] = await LmPoints.find({ classId: klass._id }).lean();
    expect(award.points).toBe(game.POINTS.discussion);
  });

  it("allows one a week and says so before they start typing", async () => {
    const { klass, student } = await seed();
    const cookie = cookieFor(student, "STUDENT");

    await start(klass, cookie, { title: "First topic" });
    const second = await start(klass, cookie, { title: "Second topic" });

    expect(second.status).toBe(429);
    expect(second.body.code).toBe("WEEKLY_LIMIT");
    expect(await LmDiscussion.countDocuments({})).toBe(1);

    // The client can grey the button out rather than letting them write a post
    // that will be refused.
    const after = await list(klass, cookie);
    expect(after.body).toMatchObject({ canStart: false, remainingThisWeek: 0 });
  });

  it("does not ration staff, who open threads to run the class", async () => {
    const { klass, teacher } = await seed();
    const cookie = cookieFor(teacher, "FACULTY");

    expect((await start(klass, cookie, { title: "Week 1 reading" })).status).toBe(201);
    expect((await start(klass, cookie, { title: "Week 2 reading" })).status).toBe(201);

    const after = await list(klass, cookie);
    expect(after.body).toMatchObject({ canStart: true, remainingThisWeek: null });
  });

  it("does not pay staff for their own threads", async () => {
    const { klass, teacher } = await seed();
    await start(klass, cookieFor(teacher, "FACULTY"), { title: "Week 1 reading" });
    expect(await LmPoints.countDocuments({})).toBe(0);
  });
});

describe("removing a discussion", () => {
  it("does not give the week back when a student withdraws their own", async () => {
    const { klass, student } = await seed();
    const cookie = cookieFor(student, "STUDENT");

    const created = await start(klass, cookie, { title: "Posted in the wrong class" });
    const removed = await request(app)
      .delete(`${BASE}/classes/${klass._id}/discussions/${created.body._id}`)
      .set("Cookie", cookie);
    expect(removed.status).toBe(200);

    // The row survives as a flag precisely so this stays refused.
    const again = await start(klass, cookie, { title: "Trying again" });
    expect(again.status).toBe(429);

    // …and it stays in the forum as a tombstone. Every removal leaves one,
    // whoever did it — see the note on the model — but a withdrawal is not
    // moderation, so the label does not say staff took it down.
    const after = await list(klass, cookie);
    expect(after.body.discussions).toHaveLength(1);
    expect(after.body.discussions[0]).toMatchObject({ removed: true, title: "Removed" });
  });

  it("leaves a visible tombstone when staff take one down", async () => {
    const { klass, teacher, student } = await seed();
    const created = await start(klass, cookieFor(student, "STUDENT"), { title: "Off topic" });

    await request(app)
      .delete(`${BASE}/classes/${klass._id}/discussions/${created.body._id}`)
      .set("Cookie", cookieFor(teacher, "FACULTY"));

    // Moderation that looks like the post never existed is worse than
    // moderation, so the class sees that something was removed.
    const after = await list(klass, cookieFor(student, "STUDENT"));
    expect(after.body.discussions).toHaveLength(1);
    expect(after.body.discussions[0]).toMatchObject({ removed: true, title: "Removed by staff" });
  });

  it("stops a student deleting a thread once somebody has replied", async () => {
    const { klass, student } = await seed();
    const cookie = cookieFor(student, "STUDENT");
    const created = await start(klass, cookie, { title: "Has answers" });

    await LmDiscussion.updateOne({ _id: created.body._id }, { $set: { replyCount: 2 } });

    const removed = await request(app)
      .delete(`${BASE}/classes/${klass._id}/discussions/${created.body._id}`)
      .set("Cookie", cookie);

    // Once a conversation exists it is not theirs alone to end.
    expect(removed.status).toBe(403);
  });
});

describe("replies", () => {
  it("counts a reply against the thread and pays the replier", async () => {
    const { klass, teacher, student } = await seed();
    const created = await start(klass, cookieFor(teacher, "FACULTY"), { title: "Week 1 reading" });

    const reply = await request(app)
      .post(`${BASE}/classes/${klass._id}/comments/discussion/${created.body._id}`)
      .set("Cookie", cookieFor(student, "STUDENT"))
      .send({ text: "This helped, thanks." });

    expect(reply.status).toBe(201);

    const discussion = await LmDiscussion.findById(created.body._id).lean();
    expect(discussion.replyCount).toBe(1);
    expect(discussion.lastReplyBy).toBe("asha");

    const award = await LmPoints.findOne({ classId: klass._id, kind: "comment" }).lean();
    expect(award.points).toBe(game.POINTS.comment);
  });

  it("takes the count back down when a reply is deleted", async () => {
    const { klass, teacher, student } = await seed();
    const created = await start(klass, cookieFor(teacher, "FACULTY"), { title: "Week 1 reading" });

    const reply = await request(app)
      .post(`${BASE}/classes/${klass._id}/comments/discussion/${created.body._id}`)
      .set("Cookie", cookieFor(student, "STUDENT"))
      .send({ text: "Never mind" });

    await request(app)
      .delete(`${BASE}/classes/${klass._id}/comments/${reply.body._id}`)
      .set("Cookie", cookieFor(student, "STUDENT"));

    // A discussion counts replies in `replyCount`, not `commentCount` — the
    // generic decrement would otherwise miss it and the list would lie.
    const discussion = await LmDiscussion.findById(created.body._id).lean();
    expect(discussion.replyCount).toBe(0);
    expect(await LmComment.countDocuments({ deleted: false })).toBe(0);
  });
});
