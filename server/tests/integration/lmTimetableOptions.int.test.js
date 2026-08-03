// The create-class picker in the learning module reads branch/semester/subject
// out of the timetable collections. These tests pin that wiring: the right
// session is used, semesters come from subjects that actually exist, and the
// subject rows are flattened into the shape the modal renders.
const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const { connect, clearDatabase, disconnect } = require("../helpers/db");

const User = require("../../src/models/usermanagement/user");
const TimeTable = require("../../src/models/timetable");
const Subject = require("../../src/models/subject");

const BASE = "/api/v1/learningmodule/timetable";

let app;

function buildApp() {
  const application = express();
  application.use(express.json());
  application.use(cookieParser());
  application.use("/api/v1/learningmodule", require("../../src/modules/learningModule/routes/index"));
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
  return [`jwt=${token}`];
}

const subject = (overrides) => ({
  subjectFullName: "Digital Signal Processing",
  type: "theory",
  subCode: "ECPC-302",
  subName: "DSP",
  studentCount: 60,
  sem: "5",
  degree: "BTech",
  ...overrides,
});

beforeAll(async () => {
  await connect();
  app = buildApp();
});
afterEach(clearDatabase);
afterAll(disconnect);

describe("GET /timetable/branches", () => {
  it("requires authentication", async () => {
    const res = await request(app).get(`${BASE}/branches`);
    expect(res.status).toBe(401);
  });

  it("returns one entry per department of the current session", async () => {
    const cookie = await seedFaculty();
    await TimeTable.create([
      { name: "ECE", dept: "ECE", session: "2025-26", code: "ece2526", currentSession: true },
      { name: "CSE", dept: "CSE", session: "2025-26", code: "cse2526", currentSession: true },
      { name: "ECE old", dept: "ECE", session: "2024-25", code: "ece2425", currentSession: false },
    ]);

    const res = await request(app).get(`${BASE}/branches`).set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { dept: "CSE", code: "cse2526", session: "2025-26" },
      { dept: "ECE", code: "ece2526", session: "2025-26" },
    ]);
  });

  it("falls back to the newest session when none is marked current", async () => {
    const cookie = await seedFaculty();
    await TimeTable.create({
      name: "ECE",
      dept: "ECE",
      session: "2024-25",
      code: "ece2425",
      currentSession: false,
    });

    const res = await request(app).get(`${BASE}/branches`).set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ dept: "ECE", code: "ece2425", session: "2024-25" }]);
  });

  it("returns an empty list when no timetable exists at all", async () => {
    const cookie = await seedFaculty();
    const res = await request(app).get(`${BASE}/branches`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("GET /timetable/semesters", () => {
  it("rejects a missing branch code", async () => {
    const cookie = await seedFaculty();
    const res = await request(app).get(`${BASE}/semesters`).set("Cookie", cookie);
    expect(res.status).toBe(400);
  });

  it("lists the semesters that have subjects, numerically sorted", async () => {
    const cookie = await seedFaculty();
    await Subject.create([
      subject({ code: "ece2526", sem: "5" }),
      subject({ code: "ece2526", sem: "3", subName: "Networks" }),
      subject({ code: "ece2526", sem: "5", subName: "VLSI" }),
      // Another branch's subjects must not leak in.
      subject({ code: "cse2526", sem: "7", subName: "Compilers" }),
    ]);

    const res = await request(app)
      .get(`${BASE}/semesters`)
      .query({ code: "ece2526" })
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(["3", "5"]);
  });
});

describe("GET /timetable/subjects", () => {
  it("rejects a missing semester", async () => {
    const cookie = await seedFaculty();
    const res = await request(app)
      .get(`${BASE}/subjects`)
      .query({ code: "ece2526" })
      .set("Cookie", cookie);
    expect(res.status).toBe(400);
  });

  it("returns the subjects of one branch and semester, name-sorted", async () => {
    const cookie = await seedFaculty();
    await Subject.create([
      subject({ code: "ece2526", sem: "5", subjectFullName: "VLSI Design", subName: "VLSI", subCode: "ECPC-305" }),
      subject({ code: "ece2526", sem: "5", credits: 4 }),
      subject({ code: "ece2526", sem: "3", subName: "Networks" }),
      subject({ code: "cse2526", sem: "5", subName: "Compilers" }),
    ]);

    const res = await request(app)
      .get(`${BASE}/subjects`)
      .query({ code: "ece2526", sem: "5" })
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.map((item) => item.name)).toEqual(["Digital Signal Processing", "VLSI Design"]);
    expect(res.body[0]).toMatchObject({
      name: "Digital Signal Processing",
      subName: "DSP",
      subCode: "ECPC-302",
      type: "theory",
      credits: 4,
      sem: "5",
    });
    expect(res.body[0].id).toEqual(expect.any(String));
  });

  it("falls back to the short name when no full name is stored", async () => {
    const cookie = await seedFaculty();
    // subjectFullName is required by the schema today, but older rows predate
    // it — insert raw so the fallback is exercised the way real data hits it.
    const { subjectFullName, ...legacy } = subject({ code: "ece2526", sem: "5" });
    await Subject.collection.insertOne(legacy);

    const res = await request(app)
      .get(`${BASE}/subjects`)
      .query({ code: "ece2526", sem: "5" })
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body[0].name).toBe("DSP");
  });
});
