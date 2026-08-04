jest.mock("axios");
jest.mock("../../src/modules/attendanceModule/controllers/mlServiceClient");

const request = require("supertest");
const { buildTestApp } = require("../helpers/testApp");
const { connect, clearDatabase, disconnect } = require("../helpers/db");
const { authCookie } = require("../helpers/auth");

const BASE = "/api/v1/attendancemodule/erp-sync";

let app;

beforeAll(async () => {
  await connect();
  app = buildTestApp();
});
afterEach(clearDatabase);
afterAll(disconnect);

describe("erp-sync settings singleton", () => {
  it("GET /settings creates the singleton on first access (enabled defaults true)", async () => {
    const res = await request(app).get(`${BASE}/settings`).set("Cookie", authCookie());
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
  });

  it("PATCH /settings toggles enabled", async () => {
    const res = await request(app)
      .patch(`${BASE}/settings`)
      .set("Cookie", authCookie())
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);

    const getRes = await request(app).get(`${BASE}/settings`).set("Cookie", authCookie());
    expect(getRes.body.enabled).toBe(false);
  });

  it("PATCH /settings rejects a non-boolean enabled value", async () => {
    const res = await request(app)
      .patch(`${BASE}/settings`)
      .set("Cookie", authCookie())
      .send({ enabled: "yes" });
    expect(res.status).toBe(400);
  });
});

describe("ERP not configured (ERP_PORTAL_KEY unset in test env)", () => {
  it("rejects /fetch-rolls with 503", async () => {
    const res = await request(app)
      .post(`${BASE}/fetch-rolls`)
      .set("Cookie", authCookie())
      .send({ subjectId: "64f000000000000000000000" });
    expect(res.status).toBe(503);
  });

  it("rejects /fetch-rolls-bulk with 503", async () => {
    const res = await request(app)
      .post(`${BASE}/fetch-rolls-bulk`)
      .set("Cookie", authCookie())
      .send({ dept: "CSE" });
    expect(res.status).toBe(503);
  });
});

describe("GET /subjects", () => {
  it("requires a dept query param", async () => {
    const res = await request(app).get(`${BASE}/subjects`).set("Cookie", authCookie());
    expect(res.status).toBe(400);
  });

  it("reports erpConfigured:false in the response when ERP_PORTAL_KEY is unset", async () => {
    const res = await request(app)
      .get(`${BASE}/subjects?dept=CSE`)
      .set("Cookie", authCookie());
    expect(res.status).toBe(200);
    expect(res.body.erpConfigured).toBe(false);
    expect(res.body.subjects).toEqual([]);
  });

  // The ERP tab has no subject picker: dept + sem alone decides which subjects
  // get a roster request. Subject.dept is optional and often blank, so the
  // listing also resolves subjects through the department's own timetable
  // (Subject.code → TimeTable.code) — otherwise these subjects are invisible
  // to the tab and never reach the ERP.
  it("lists a subject with no dept of its own via the department's timetable", async () => {
    const TimeTable = require("../../src/models/timetable");
    const Subject = require("../../src/models/subject");

    await TimeTable.create({
      name: "CSE 2026", dept: "Computer_Science_Engineering",
      session: "2026-27", code: "CSE26", currentSession: true,
    });
    await Subject.create({
      subjectFullName: "Operating Systems", type: "theory", subCode: "CSPC-501",
      subName: "OS(CSE)", studentCount: 60, sem: "B.Tech-CSE-5",
      degree: "B.Tech", code: "CSE26",   // no dept field
    });

    const res = await request(app)
      .get(`${BASE}/subjects?dept=Computer_Science_Engineering`)
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.subjects).toHaveLength(1);
    const [subject] = res.body.subjects;
    expect(subject.subjectFullName).toBe("Operating Systems");
    // The listed department stands in for the blank Subject.dept, so the ERP
    // request this row would send is complete.
    expect(subject.erpLookup).toEqual({
      degree: "B.Tech",
      department: "Computer Science Engineering",
      semester: "B.Tech-CSE-5",
      abbreviation: "OS(CSE)",
    });
  });

  // Third resolution path: neither Subject.dept nor Subject.code links this
  // subject to the department, but the department's locked timetable schedules
  // it — the same source the Semester dropdown is fed from.
  it("lists a subject linked only by the department's locked timetable", async () => {
    const TimeTable = require("../../src/models/timetable");
    const LockSem = require("../../src/models/locksem");
    const Subject = require("../../src/models/subject");

    const tt = await TimeTable.create({
      name: "CSE 2026", dept: "Computer_Science_Engineering",
      session: "2026-27", code: "CSE26", currentSession: true,
    });
    await LockSem.create({
      day: "Monday", slot: "1", sem: "B.Tech-CSE-5", code: "CSE26", timetable: tt._id,
      slotData: [{ subject: "OS(CSE)", faculty: "Dr. A", room: "L1" }],
    });
    await Subject.create({
      subjectFullName: "Operating Systems", type: "theory", subCode: "CSPC-501",
      subName: "OS(CSE)", studentCount: 60, sem: "5", degree: "B.Tech",
      // no dept, and a code belonging to nothing
      code: "SOMETHING_ELSE",
    });

    const res = await request(app)
      .get(`${BASE}/subjects?dept=Computer_Science_Engineering&sem=B.Tech-CSE-5`)
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.subjects.map((s) => s.subjectFullName)).toEqual(["Operating Systems"]);
    expect(res.body.diagnostics.timetableSubjectNames).toEqual(["OS(CSE)"]);
  });

  // The ERP needs no Subject document — department + semester + abbreviation
  // fully specify a roster request, and the timetable supplies all three. So a
  // subject the timetable schedules is listed even when the Subject collection
  // has never heard of it; it is simply marked as unsaveable.
  it("lists a timetable subject that has no Subject record at all", async () => {
    const TimeTable = require("../../src/models/timetable");
    const LockSem = require("../../src/models/locksem");

    const tt = await TimeTable.create({
      name: "CSE 2026", dept: "Computer_Science_Engineering",
      session: "2026-27", code: "CSE26", currentSession: true,
    });
    await LockSem.create({
      day: "Monday", slot: "1", sem: "B.Tech-CSE-5", code: "CSE26", timetable: tt._id,
      slotData: [{ subject: "OS(CSE)", faculty: "Dr. A", room: "L1" }],
    });
    // No Subject document exists for OS(CSE) at all.

    const res = await request(app)
      .get(`${BASE}/subjects?dept=Computer_Science_Engineering&sem=B.Tech-CSE-5`)
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.subjects).toHaveLength(1);
    const [row] = res.body.subjects;
    expect(row._id).toBeNull();
    expect(row.hasSubjectRecord).toBe(false);
    expect(row.subName).toBe("OS(CSE)");
    // A complete ERP request, built entirely from timetable data.
    expect(row.erpLookup).toEqual({
      degree: "B.Tech",
      department: "Computer Science Engineering",
      semester: "B.Tech-CSE-5",
      abbreviation: "OS(CSE)",
    });
    expect(res.body.diagnostics.timetableCodes).toEqual(["CSE26"]);
  });

  it("rejects a fetch that names neither a subject nor a timetable class", async () => {
    const res = await request(app)
      .post(`${BASE}/fetch-rolls`)
      .set("Cookie", authCookie())
      .send({ dept: "Computer_Science_Engineering" });
    // 503 first (no portal key in the test env) — the point is that it does
    // not 500 on a body carrying no subjectId.
    expect([400, 503]).toContain(res.status);
  });

  it("keeps the semester filter working when the dropdown sends a bare number", async () => {
    const TimeTable = require("../../src/models/timetable");
    const Subject = require("../../src/models/subject");

    await TimeTable.create({
      name: "CSE 2026", dept: "Computer_Science_Engineering",
      session: "2026-27", code: "CSE26", currentSession: true,
    });
    const base = {
      type: "theory", studentCount: 60, degree: "B.Tech", code: "CSE26",
    };
    await Subject.create({
      ...base, subjectFullName: "Operating Systems", subCode: "CSPC-501",
      subName: "OS(CSE)", sem: "B.Tech-CSE-5",
    });
    await Subject.create({
      ...base, subjectFullName: "Compiler Design", subCode: "CSPC-601",
      subName: "CD(CSE)", sem: "B.Tech-CSE-6",
    });

    const res = await request(app)
      .get(`${BASE}/subjects?dept=Computer_Science_Engineering&sem=5`)
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.subjects.map((s) => s.subjectFullName)).toEqual(["Operating Systems"]);
  });
});
