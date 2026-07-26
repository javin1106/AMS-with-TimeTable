/**
 * Regression tests for duplicate timetable notification emails.
 *
 * Two independent causes were fixed:
 *   1. recipients were de-duplicated by free-text faculty NAME, so one person
 *      listed under two spellings got two copies of the same mail;
 *   2. publishing was not idempotent, so a repeat publish re-mailed everyone.
 */
const db = require("../helpers/db");

const mailSenderPath = require.resolve(
  "../../src/modules/mailsender"
);
jest.mock("../../src/modules/mailsender");
const mailSender = require(mailSenderPath);

const Faculty = require("../../src/models/faculty");
const TimeTable = require("../../src/models/timetable");
const addFaculty = require("../../src/models/addfaculty");
const {
  findFacultyByExactName,
} = require("../../src/modules/timetableModule/helper/facultyLookup");
const TableController = require("../../src/modules/timetableModule/controllers/timetableprofile");

const controller = new TableController();

function mockRes() {
  return {
    statusCode: 200,
    payload: undefined,
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.payload = body;
      this.headersSent = true;
      return this;
    },
  };
}

const baseFaculty = {
  facultyID: "F1",
  designation: "Professor",
  dept: "CSE",
};

beforeAll(async () => {
  await db.connect();
});

afterAll(async () => {
  await db.disconnect();
});

beforeEach(async () => {
  await db.clearDatabase();
  mailSender.mockReset();
  mailSender.mockResolvedValue({ messageId: "stub" });
});

describe("findFacultyByExactName", () => {
  beforeEach(async () => {
    await Faculty.create({ ...baseFaculty, name: "Mohan Kumar", email: "mohan@nitj.ac.in" });
  });

  it("matches the same name exactly", async () => {
    const doc = await findFacultyByExactName("Mohan Kumar");
    expect(doc?.email).toBe("mohan@nitj.ac.in");
  });

  it("matches case- and whitespace-insensitively", async () => {
    expect((await findFacultyByExactName("mohan kumar"))?.email).toBe("mohan@nitj.ac.in");
    expect((await findFacultyByExactName("  MOHAN   KUMAR "))?.email).toBe("mohan@nitj.ac.in");
  });

  it("does NOT match a prefix — the old substring search did, and mailed the wrong person", async () => {
    expect(await findFacultyByExactName("Mohan")).toBeNull();
  });

  it("does not fall back to a department match", async () => {
    expect(await findFacultyByExactName("CSE")).toBeNull();
  });
});

describe("publishTimetable notifications", () => {
  async function seedTimetable() {
    const tt = await TimeTable.create({
      name: "CSE TT",
      dept: "CSE",
      session: "2025-26",
      code: "CSE101",
    });
    return tt;
  }

  it("sends one mail per address when a person is listed under two spellings", async () => {
    const tt = await seedTimetable();
    await Faculty.create({ ...baseFaculty, name: "Mohan Kumar", email: "mohan@nitj.ac.in" });
    await Faculty.create({
      ...baseFaculty,
      facultyID: "F2",
      name: "MOHAN  KUMAR", // same person, different spelling in another sem
      email: "Mohan@NITJ.ac.in", // same inbox, different casing
    });
    await Faculty.create({ ...baseFaculty, facultyID: "F3", name: "Asha Rao", email: "asha@nitj.ac.in" });

    await addFaculty.create({ sem: "3", code: "CSE101", faculty: ["Mohan Kumar", "Asha Rao"] });
    await addFaculty.create({ sem: "5", code: "CSE101", faculty: ["MOHAN  KUMAR"] });

    const res = mockRes();
    await controller.publishTimetable({ params: { id: tt._id.toString() }, query: {}, body: {} }, res);

    const recipients = mailSender.mock.calls.map((c) => c[0].toLowerCase());
    expect(recipients.sort()).toEqual(["asha@nitj.ac.in", "mohan@nitj.ac.in"]);
    expect(res.payload.mailsSent).toBe(2);
  });

  it("does not re-mail anyone when an already-published timetable is published again", async () => {
    const tt = await seedTimetable();
    await Faculty.create({ ...baseFaculty, name: "Asha Rao", email: "asha@nitj.ac.in" });
    await addFaculty.create({ sem: "3", code: "CSE101", faculty: ["Asha Rao"] });

    const first = mockRes();
    await controller.publishTimetable({ params: { id: tt._id.toString() }, query: {}, body: {} }, first);
    expect(mailSender).toHaveBeenCalledTimes(1);

    const second = mockRes();
    await controller.publishTimetable({ params: { id: tt._id.toString() }, query: {}, body: {} }, second);
    expect(mailSender).toHaveBeenCalledTimes(1); // still 1 — no duplicate
    expect(second.payload.alreadyPublished).toBe(true);
    expect(second.payload.mailsSent).toBe(0);
  });

  it("re-sends only when force is explicitly requested", async () => {
    const tt = await seedTimetable();
    await Faculty.create({ ...baseFaculty, name: "Asha Rao", email: "asha@nitj.ac.in" });
    await addFaculty.create({ sem: "3", code: "CSE101", faculty: ["Asha Rao"] });

    await controller.publishTimetable({ params: { id: tt._id.toString() }, query: {}, body: {} }, mockRes());
    await controller.publishTimetable(
      { params: { id: tt._id.toString() }, query: { force: "true" }, body: {} },
      mockRes()
    );

    expect(mailSender).toHaveBeenCalledTimes(2);
  });

  it("keeps the original datePublished on a forced re-publish", async () => {
    const tt = await seedTimetable();
    await addFaculty.create({ sem: "3", code: "CSE101", faculty: [] });

    await controller.publishTimetable({ params: { id: tt._id.toString() }, query: {}, body: {} }, mockRes());
    const firstDate = (await TimeTable.findById(tt._id)).datePublished;

    await controller.publishTimetable(
      { params: { id: tt._id.toString() }, query: { force: "true" }, body: {} },
      mockRes()
    );
    const secondDate = (await TimeTable.findById(tt._id)).datePublished;

    expect(secondDate.getTime()).toBe(firstDate.getTime());
  });

  it("reports faculty with no email instead of mailing undefined", async () => {
    const tt = await seedTimetable();
    await Faculty.create({ ...baseFaculty, name: "No Mail", email: "" });
    await addFaculty.create({ sem: "3", code: "CSE101", faculty: ["No Mail", "Ghost Faculty"] });

    const res = mockRes();
    await controller.publishTimetable({ params: { id: tt._id.toString() }, query: {}, body: {} }, res);

    expect(mailSender).not.toHaveBeenCalled();
    const errors = res.payload.results.map((r) => r.error).sort();
    expect(errors).toEqual(["Email not found", "Faculty record not found"]);
  });

  it("rejects a malformed timetable id without touching the mailer", async () => {
    const res = mockRes();
    await controller.publishTimetable({ params: { id: "not-an-id" }, query: {}, body: {} }, res);

    expect(res.statusCode).toBe(400);
    expect(mailSender).not.toHaveBeenCalled();
  });
});
