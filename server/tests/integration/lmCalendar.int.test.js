// The learning module's month calendar pulls from four places at once:
// coursework, quizzes, presented Shorts, and the *attendance* module's
// non-working days. These tests pin that the four feeds come back separately,
// that only the caller's own classes are visible, and that the holiday join
// reaches across module boundaries into the Allotment record.
const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const { connect, clearDatabase, disconnect } = require("../helpers/db");

const User = require("../../src/models/usermanagement/user");
const Allotment = require("../../src/models/allotment");
const LmClass = require("../../src/modules/learningModule/models/lmClass");
const LmMembership = require("../../src/modules/learningModule/models/lmMembership");
const LmCoursework = require("../../src/modules/learningModule/models/lmCoursework");
const LmQuiz = require("../../src/modules/learningModule/models/lmQuiz");
const LmShortSession = require("../../src/modules/learningModule/models/lmShortSession");

const BASE = "/api/v1/learningmodule";

// A fixed window so the fixtures never drift with the wall clock.
const FROM = "2026-03-01T00:00:00.000Z";
const TO = "2026-03-31T23:59:59.000Z";
const inMarch = (day, hour = 9) => new Date(Date.UTC(2026, 2, day, hour));

let app;

function buildApp() {
  const application = express();
  application.use(express.json());
  application.use(cookieParser());
  application.use(BASE, require("../../src/modules/learningModule/routes/index"));
  return application;
}

async function seedFaculty() {
  const user = await User.create({
    name: "Test Faculty",
    role: ["FACULTY"],
    password: "hashed",
    dept: "Electronics and Communication Engineering",
    email: ["faculty@example.com"],
  });
  const token = jwt.sign({ id: user.id, role: ["FACULTY"] }, process.env.JWT_SECRET);
  return { user, cookie: [`jwt=${token}`] };
}

async function seedClass(user, overrides = {}) {
  const klass = await LmClass.create({
    name: "Digital Signal Processing",
    code: `c${Math.random().toString(36).slice(2, 8)}`,
    ownerId: user._id,
    coverColor: "#1967d2",
    ...overrides,
  });
  await LmMembership.create({
    classId: klass._id,
    userId: user._id,
    role: "teacher",
    status: "active",
  });
  return klass;
}

const getCalendar = (cookie) =>
  request(app).get(`${BASE}/calendar`).query({ from: FROM, to: TO }).set("Cookie", cookie);

beforeAll(async () => {
  await connect();
  app = buildApp();
});
afterEach(clearDatabase);
afterAll(disconnect);

describe("GET /calendar", () => {
  it("requires authentication", async () => {
    const res = await request(app).get(`${BASE}/calendar`);
    expect(res.status).toBe(401);
  });

  it("returns the four feeds, empty, for a user with no classes", async () => {
    const { cookie } = await seedFaculty();
    const res = await getCalendar(cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ coursework: [], quizzes: [], shorts: [], nonWorkingDays: [] });
  });

  it("places coursework on its due date and undated coursework on its posted date", async () => {
    const { user, cookie } = await seedFaculty();
    const klass = await seedClass(user);
    await LmCoursework.create([
      {
        classId: klass._id,
        title: "Lab report 2",
        workType: "assignment",
        dueDate: inMarch(20),
        createdBy: user._id,
      },
      {
        classId: klass._id,
        title: "Reference notes",
        workType: "material",
        dueDate: null,
        publishedAt: inMarch(5),
        createdBy: user._id,
      },
      // Drafts are not on anybody's calendar.
      {
        classId: klass._id,
        title: "Unfinished",
        status: "draft",
        dueDate: inMarch(10),
        createdBy: user._id,
      },
      // Outside the window.
      {
        classId: klass._id,
        title: "April work",
        dueDate: new Date(Date.UTC(2026, 3, 12)),
        createdBy: user._id,
      },
    ]);

    const res = await getCalendar(cookie);

    expect(res.status).toBe(200);
    expect(res.body.coursework.map((item) => [item.title, item.dateKind])).toEqual([
      ["Reference notes", "posted"],
      ["Lab report 2", "due"],
    ]);
    expect(res.body.coursework[1].class).toMatchObject({ name: "Digital Signal Processing" });
    expect(res.body.coursework[1].myRole).toBe("teacher");
  });

  it("dates a quiz by its window, falling back to when it was created", async () => {
    const { user, cookie } = await seedFaculty();
    const klass = await seedClass(user);
    await LmQuiz.create([
      {
        classId: klass._id,
        title: "Unit test 1",
        published: true,
        createdBy: user._id,
        settings: { availableFrom: inMarch(18, 10), availableTo: inMarch(18, 11), timeLimitMinutes: 45 },
      },
      {
        classId: klass._id,
        title: "Pop quiz",
        published: true,
        createdBy: user._id,
        created_at: inMarch(3),
      },
      // Unpublished papers are not "conducted".
      { classId: klass._id, title: "Draft paper", published: false, createdBy: user._id, created_at: inMarch(4) },
    ]);

    const res = await getCalendar(cookie);

    expect(res.status).toBe(200);
    expect(res.body.quizzes.map((q) => q.title)).toEqual(["Pop quiz", "Unit test 1"]);
    expect(new Date(res.body.quizzes[1].conductedAt)).toEqual(inMarch(18, 10));
    expect(res.body.quizzes[1].timeLimitMinutes).toBe(45);
    expect(new Date(res.body.quizzes[0].conductedAt)).toEqual(inMarch(3));
  });

  it("carries the class subject code so a chip can be labelled with it", async () => {
    const { user, cookie } = await seedFaculty();
    const klass = await seedClass(user, { subject: "Digital Signal Processing", subjectCode: "EC8553" });
    await LmQuiz.create({
      classId: klass._id,
      title: "Unit test 1",
      published: true,
      createdBy: user._id,
      settings: { availableFrom: inMarch(18, 10) },
    });

    const res = await getCalendar(cookie);

    expect(res.status).toBe(200);
    expect(res.body.quizzes[0].class).toMatchObject({
      subject: "Digital Signal Processing",
      subjectCode: "EC8553",
    });
  });

  it("lists Short sessions on the day they were presented", async () => {
    const { user, cookie } = await seedFaculty();
    const klass = await seedClass(user);
    const shortId = new mongoose.Types.ObjectId();
    await LmShortSession.create([
      {
        shortId,
        classId: klass._id,
        title: "Warm-up poll",
        joinCode: "111111",
        status: "ended",
        startedAt: inMarch(11),
        endedAt: inMarch(11, 10),
        participants: [{ name: "A" }, { name: "B" }],
        presentedBy: user._id,
        presentedByName: "Test Faculty",
      },
      {
        shortId,
        classId: klass._id,
        title: "February run",
        joinCode: "222222",
        status: "ended",
        startedAt: new Date(Date.UTC(2026, 1, 11)),
        presentedBy: user._id,
      },
    ]);

    const res = await getCalendar(cookie);

    expect(res.status).toBe(200);
    expect(res.body.shorts).toHaveLength(1);
    expect(res.body.shorts[0]).toMatchObject({
      title: "Warm-up poll",
      status: "ended",
      participantCount: 2,
      presentedByName: "Test Faculty",
    });
  });

  it("reads non-working days out of the attendance module's allotment record", async () => {
    const { cookie } = await seedFaculty();
    await Allotment.create({
      session: "2025-26",
      nonWorkingDays: [
        { date: "2026-03-14", remark: "Saturday" },
        { date: "2026-03-25", remark: "Holi" },
        { date: "2026-04-02", remark: "Next month" },
      ],
    });

    const res = await getCalendar(cookie);

    expect(res.status).toBe(200);
    expect(res.body.nonWorkingDays).toEqual([
      { date: "2026-03-14", remark: "Saturday", session: "2025-26" },
      { date: "2026-03-25", remark: "Holi", session: "2025-26" },
    ]);
  });

  it("does not leak another teacher's classes", async () => {
    const { cookie } = await seedFaculty();
    const other = await User.create({
      name: "Someone Else",
      role: ["FACULTY"],
      password: "hashed",
      email: ["other@example.com"],
    });
    const theirClass = await seedClass(other);
    await LmCoursework.create({
      classId: theirClass._id,
      title: "Their assignment",
      dueDate: inMarch(9),
      createdBy: other._id,
    });

    const res = await getCalendar(cookie);

    expect(res.status).toBe(200);
    expect(res.body.coursework).toEqual([]);
  });
});
