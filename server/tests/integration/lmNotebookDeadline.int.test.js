// The deadline on a coding exercise, and the two questions it exists to answer:
// who submitted before it, and who actually worked through the notebook rather
// than opening it and pressing submit.
//
// Lateness is deliberately *derived* rather than frozen at submit time, so
// extending a deadline forgives the people it was extended for. That is the
// behaviour most worth pinning here — freezing it is the obvious implementation
// and the wrong one.
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
const LmNotebook = require("../../src/modules/learningModule/models/lmNotebook");
const LmNotebookAttempt = require("../../src/modules/learningModule/models/lmNotebookAttempt");

const BASE = "/api/v1/learningmodule";
const HOUR = 60 * 60 * 1000;

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

async function seed({ dueDate = null } = {}) {
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
    role: "teacher",
    status: "active",
  });

  const notebook = await LmNotebook.create({
    classId: klass._id,
    title: "Gradient descent",
    published: true,
    dueDate,
    cells: [
      { type: "code", source: "x = 1", order: 0 },
      { type: "code", source: "print(x)", order: 1 },
    ],
    createdBy: teacher._id,
    createdByName: teacher.name,
  });

  return { teacher, klass, notebook };
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

// Writes an already-submitted attempt directly: the submit endpoint stamps
// `submittedAt` as "now", and these tests need submissions either side of a
// deadline.
const submittedAttempt = ({ notebook, klass, student, at, cells }) =>
  LmNotebookAttempt.create({
    notebookId: notebook._id,
    classId: klass._id,
    studentId: student._id,
    studentName: student.name,
    submittedAt: at,
    cells,
    summary: require("../../src/modules/learningModule/services/notebookService").summariseAttempt(cells),
  });

const ranCell = (overrides = {}) => ({
  type: "code",
  source: "x = 1",
  executedAt: new Date(),
  runCount: 1,
  outputs: [],
  ...overrides,
});

const listAttempts = (klass, notebook, cookie) =>
  request(app)
    .get(`${BASE}/classes/${klass._id}/notebooks/${notebook._id}/attempts`)
    .set("Cookie", cookie);

beforeAll(async () => {
  await connect();
  app = buildApp();
});
afterEach(clearDatabase);
afterAll(disconnect);

describe("coding exercise deadline", () => {
  it("counts who submitted before the deadline and who did not", async () => {
    const due = new Date(Date.now() - 2 * HOUR);
    const { teacher, klass, notebook } = await seed({ dueDate: due });

    const early = await seedStudent(klass, "asha");
    const late = await seedStudent(klass, "bala");
    await submittedAttempt({
      notebook,
      klass,
      student: early,
      at: new Date(due.getTime() - HOUR),
      cells: [ranCell(), ranCell()],
    });
    await submittedAttempt({
      notebook,
      klass,
      student: late,
      at: new Date(due.getTime() + HOUR),
      cells: [ranCell(), ranCell()],
    });

    const res = await listAttempts(klass, notebook, cookieFor(teacher, "FACULTY"));

    expect(res.status).toBe(200);
    expect(res.body.dueDate).toBeTruthy();
    expect(res.body.tally).toMatchObject({ started: 2, submitted: 2, onTime: 1, late: 1 });
    const byName = Object.fromEntries(res.body.attempts.map((row) => [row.studentName, row]));
    expect(byName.asha.late).toBe(false);
    expect(byName.bala.late).toBe(true);
  });

  // The point of deriving lateness rather than stamping it at submit time.
  it("forgives a late submission when the deadline is extended past it", async () => {
    const due = new Date(Date.now() - 2 * HOUR);
    const { teacher, klass, notebook } = await seed({ dueDate: due });
    const student = await seedStudent(klass, "asha");
    await submittedAttempt({
      notebook,
      klass,
      student,
      at: new Date(due.getTime() + HOUR),
      cells: [ranCell(), ranCell()],
    });

    let res = await listAttempts(klass, notebook, cookieFor(teacher, "FACULTY"));
    expect(res.body.tally.late).toBe(1);

    notebook.dueDate = new Date(Date.now() + HOUR);
    await notebook.save();

    res = await listAttempts(klass, notebook, cookieFor(teacher, "FACULTY"));
    expect(res.body.tally).toMatchObject({ onTime: 1, late: 0 });
    expect(res.body.attempts[0].late).toBe(false);
  });

  it("separates working through the notebook from merely submitting it", async () => {
    const { teacher, klass, notebook } = await seed();

    const worker = await seedStudent(klass, "asha");
    const skipper = await seedStudent(klass, "bala");
    await submittedAttempt({
      notebook,
      klass,
      student: worker,
      at: new Date(),
      cells: [ranCell(), ranCell()],
    });
    await submittedAttempt({
      notebook,
      klass,
      student: skipper,
      at: new Date(),
      // Opened it, ran nothing, pressed submit.
      cells: [{ type: "code", source: "x = 1", runCount: 0, outputs: [] }, ranCell()],
    });

    const res = await listAttempts(klass, notebook, cookieFor(teacher, "FACULTY"));

    expect(res.body.tally).toMatchObject({ submitted: 2, completed: 1 });
    // No deadline set, so there is nothing to be on time for.
    expect(res.body.tally.onTime).toBeNull();
    const byName = Object.fromEntries(res.body.attempts.map((row) => [row.studentName, row]));
    expect(byName.asha).toMatchObject({ completed: true, cellsRun: 2, codeCells: 2 });
    expect(byName.bala).toMatchObject({ completed: false, cellsRun: 1 });
  });

  it("leaves completion blank for work still in progress", async () => {
    const { teacher, klass, notebook } = await seed();
    const student = await seedStudent(klass, "asha");
    await LmNotebookAttempt.create({
      notebookId: notebook._id,
      classId: klass._id,
      studentId: student._id,
      studentName: student.name,
      lastSavedAt: new Date(),
      cells: [ranCell()],
    });

    const res = await listAttempts(klass, notebook, cookieFor(teacher, "FACULTY"));

    // Unsubmitted is not "incomplete" — they are still working on it.
    expect(res.body.attempts[0].completed).toBeNull();
    expect(res.body.tally).toMatchObject({ started: 1, submitted: 0, completed: 0 });
  });
});
