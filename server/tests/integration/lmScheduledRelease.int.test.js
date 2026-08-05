// Scheduled posts and quizzes go live lazily, on the first stream read after
// their time passes. The regression these pin: that release used to be a bare
// `updateMany`, so a scheduled item appeared with no notification and no email
// while the same item published by hand announced itself — and the teacher who
// scheduled it had no way to tell the difference.
//
// The other half is that announcing from a read path must survive concurrent
// readers: two students opening the stream at the same moment must not produce
// two notifications each.
//
// The mailer is mocked throughout; nothing here touches SMTP.
const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const jwt = require("jsonwebtoken");

jest.mock("../../src/modules/mailerModule/mailer", () => ({
  sendMail: jest.fn(),
  sendBulkMail: jest.fn(),
}));

const { connect, clearDatabase, disconnect } = require("../helpers/db");
const { sendBulkMail } = require("../../src/modules/mailerModule/mailer");

const User = require("../../src/models/usermanagement/user");
const LmClass = require("../../src/modules/learningModule/models/lmClass");
const LmMembership = require("../../src/modules/learningModule/models/lmMembership");
const LmAnnouncement = require("../../src/modules/learningModule/models/lmAnnouncement");
const LmCoursework = require("../../src/modules/learningModule/models/lmCoursework");
const LmQuiz = require("../../src/modules/learningModule/models/lmQuiz");
const LmNotification = require("../../src/modules/learningModule/models/lmNotification");

const BASE = "/api/v1/learningmodule";
const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000);

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

async function seedClassWithStudents() {
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
  await LmMembership.create({
    classId: klass._id,
    userId: teacher._id,
    email: "rao@example.com",
    role: "teacher",
    status: "active",
  });

  const students = [];
  for (const name of ["asha", "bala"]) {
    // eslint-disable-next-line no-await-in-loop
    const student = await User.create({
      name,
      role: ["STUDENT"],
      password: "hashed",
      email: [`${name}@example.com`],
    });
    // eslint-disable-next-line no-await-in-loop
    await LmMembership.create({
      classId: klass._id,
      userId: student._id,
      email: `${name}@example.com`,
      role: "student",
      status: "active",
    });
    students.push(student);
  }

  return { teacher, klass, students };
}

const readStream = (klass, cookie) =>
  request(app).get(`${BASE}/classes/${klass._id}/stream`).set("Cookie", cookie);

// Announcing is deliberately not awaited by the request — a student's stream
// read must not wait on SMTP — so the assertions have to, or they race the very
// thing they are checking.
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function settledNotifications(classId, expected) {
  const deadline = Date.now() + 3000;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await LmNotification.find({ classId }).lean();
    if (rows.length >= expected || Date.now() > deadline) return rows;
    // eslint-disable-next-line no-await-in-loop
    await pause(25);
  }
}

beforeAll(async () => {
  await connect();
  app = buildApp();
});
beforeEach(() => {
  sendBulkMail.mockReset().mockResolvedValue({ sent: 2, failed: 0 });
});
afterEach(clearDatabase);
afterAll(disconnect);

describe("scheduled release announces the item", () => {
  it("notifies the class when a scheduled post goes live", async () => {
    const { teacher, klass, students } = await seedClassWithStudents();
    await LmAnnouncement.create({
      classId: klass._id,
      authorId: teacher._id,
      authorName: teacher.name,
      authorRole: "teacher",
      text: "Lab moved to Thursday.",
      status: "scheduled",
      scheduledFor: YESTERDAY,
      publishedAt: YESTERDAY,
    });

    const res = await readStream(klass, cookieFor(students[0], "STUDENT"));
    expect(res.status).toBe(200);

    const notifications = await settledNotifications(klass._id, 2);
    // Both students, and not the teacher who wrote it.
    expect(notifications).toHaveLength(2);
    expect(notifications.every((n) => n.type === "announcement")).toBe(true);
    expect(notifications.map((n) => String(n.userId)).sort()).toEqual(
      students.map((s) => String(s._id)).sort(),
    );
    expect(sendBulkMail).toHaveBeenCalledTimes(1);
  });

  it("points a released quiz at the paper, not the gradebook row", async () => {
    const { teacher, klass, students } = await seedClassWithStudents();
    const quiz = await LmQuiz.create({
      classId: klass._id,
      title: "Sampling and aliasing",
      published: true,
      publishAt: YESTERDAY,
      createdBy: teacher._id,
      createdByName: teacher.name,
    });
    await LmCoursework.create({
      classId: klass._id,
      workType: "quiz",
      title: quiz.title,
      quizId: quiz._id,
      status: "scheduled",
      scheduledFor: YESTERDAY,
      publishedAt: YESTERDAY,
      createdBy: teacher._id,
      createdByName: teacher.name,
    });

    await readStream(klass, cookieFor(students[0], "STUDENT"));

    const notifications = await settledNotifications(klass._id, 2);
    expect(notifications).toHaveLength(2);
    expect(notifications[0].type).toBe("quiz");
    expect(notifications[0].link).toBe(`/learning/class/${klass._id}/quiz/${quiz._id}`);

    // The quiz's own once-only marker is stamped, so bringing it forward later
    // is not treated as a fresh quiz.
    await pause(100);
    const stamped = await LmQuiz.findById(quiz._id).lean();
    expect(stamped.announcedAt).toBeTruthy();
  });

  // The claim is what makes announcing from a read path safe: whichever caller
  // flips the row announces, and the rest find nothing left to flip.
  it("announces once even when the whole class opens the stream together", async () => {
    const { teacher, klass, students } = await seedClassWithStudents();
    await LmCoursework.create({
      classId: klass._id,
      workType: "material",
      title: "Week 4 notes",
      status: "scheduled",
      scheduledFor: YESTERDAY,
      publishedAt: YESTERDAY,
      createdBy: teacher._id,
      createdByName: teacher.name,
    });

    await Promise.all([
      readStream(klass, cookieFor(students[0], "STUDENT")),
      readStream(klass, cookieFor(students[1], "STUDENT")),
      readStream(klass, cookieFor(teacher, "FACULTY")),
    ]);

    const notifications = await settledNotifications(klass._id, 2);
    // A second announcement would arrive late rather than never, so give the
    // losing readers room to be wrong before calling this settled.
    await pause(150);
    const after = await LmNotification.find({ classId: klass._id }).lean();

    expect(notifications).toHaveLength(2); // one per student, not per reader
    expect(after).toHaveLength(2);
    expect(after.every((n) => n.type === "material")).toBe(true);
    expect(sendBulkMail).toHaveBeenCalledTimes(1);
  });

  it("leaves an item whose time has not come alone", async () => {
    const { teacher, klass, students } = await seedClassWithStudents();
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await LmAnnouncement.create({
      classId: klass._id,
      authorId: teacher._id,
      authorName: teacher.name,
      authorRole: "teacher",
      text: "Not yet.",
      status: "scheduled",
      scheduledFor: tomorrow,
      publishedAt: tomorrow,
    });

    await readStream(klass, cookieFor(students[0], "STUDENT"));
    // Proving an absence: give a notification that should not exist time to
    // turn up before concluding it did not.
    await pause(150);

    expect(await LmNotification.countDocuments({ classId: klass._id })).toBe(0);
    expect(sendBulkMail).not.toHaveBeenCalled();
    const still = await LmAnnouncement.findOne({ classId: klass._id }).lean();
    expect(still.status).toBe("scheduled");
  });
});
