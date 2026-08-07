const templates = require("../../src/modules/attendanceModule/controllers/emailTemplates");
const {
  sortRolls,
  resolveNoGroundTruthRolls,
} = require("../../src/modules/attendanceModule/controllers/facultyAttendanceMailer");

jest.mock("../../src/models/attendanceModule/studentEmbedding", () => ({
  findOne: jest.fn(),
}));
const StudentEmbedding = require("../../src/models/attendanceModule/studentEmbedding");

// findOne(...).sort(...).lean()
function mockEmbeddingRecord(record) {
  StudentEmbedding.findOne.mockReturnValue({
    sort: () => ({ lean: async () => record }),
  });
}

describe("sortRolls", () => {
  it("orders roll numbers ascending, not lexicographically", () => {
    expect(sortRolls(["21103010", "21103009", "21103100", "21103002"])).toEqual([
      "21103002",
      "21103009",
      "21103010",
      "21103100",
    ]);
  });

  it("normalises case and drops duplicates and blanks", () => {
    expect(sortRolls(["ece-2", "", "ECE-2", null, "ece-1"])).toEqual(["ECE-1", "ECE-2"]);
  });
});

describe("resolveNoGroundTruthRolls", () => {
  const roster = ["21103001", "21103002", "21103003", "21103004"];

  beforeEach(() => {
    StudentEmbedding.findOne.mockReset();
  });

  it("returns nothing when there is no subject document", async () => {
    const missing = await resolveNoGroundTruthRolls(null, roster);
    expect([...missing]).toEqual([]);
  });

  it("reports roster students the .pkl was not built from", async () => {
    mockEmbeddingRecord({ rollNos: ["21103001", "21103002"], missedRollNos: [] });
    const missing = await resolveNoGroundTruthRolls(
      { embeddingFile: "X.pkl", missedGroundTruth: [] },
      roster,
    );
    expect([...missing].sort()).toEqual(["21103003", "21103004"]);
  });

  it("includes Subject.missedGroundTruth even with no embedding record", async () => {
    StudentEmbedding.findOne.mockReturnValue({ sort: () => ({ lean: async () => null }) });
    const missing = await resolveNoGroundTruthRolls(
      { embeddingFile: "X.pkl", missedGroundTruth: ["21103004"] },
      roster,
    );
    expect([...missing]).toEqual(["21103004"]);
  });

  it("includes the generation run's own missedRollNos", async () => {
    mockEmbeddingRecord({
      rollNos: roster,
      missedRollNos: [{ rollNo: "21103003", reason: "no photos" }],
    });
    const missing = await resolveNoGroundTruthRolls(
      { embeddingFile: "X.pkl", missedGroundTruth: [] },
      roster,
    );
    expect([...missing]).toEqual(["21103003"]);
  });

  it("never reports someone who is not on the roster", async () => {
    mockEmbeddingRecord({ rollNos: roster, missedRollNos: [] });
    const missing = await resolveNoGroundTruthRolls(
      { embeddingFile: "X.pkl", missedGroundTruth: ["99999999"] },
      roster,
    );
    expect([...missing]).toEqual([]);
  });

  it("does not declare the whole roster missing when no record exists", async () => {
    StudentEmbedding.findOne.mockReturnValue({ sort: () => ({ lean: async () => null }) });
    const missing = await resolveNoGroundTruthRolls(
      { embeddingFile: "X.pkl", missedGroundTruth: [] },
      roster,
    );
    expect([...missing]).toEqual([]);
  });
});

describe("facultyAttendanceSummaryTemplate", () => {
  const base = {
    facultyName: "Dr. A Sharma",
    subject: "FPGA(DE/GE)",
    subjectCode: "ECDE0353",
    batch: "BTECH_ECE_2023",
    semester: "B.Tech-ECE-5",
    room: "LT103",
    date: "2026-08-06",
    timeSlot: "period3",
    totalStudents: 6,
    presentRolls: ["21103001", "21103002", "21103003"],
    absentRolls: ["21103004", "21103005"],
    noGroundTruthRolls: ["21103006"],
  };

  it("shows the class identity the faculty needs", () => {
    const html = templates.facultyAttendanceSummaryTemplate(base);
    expect(html).toContain("Dr. A Sharma");
    expect(html).toContain("FPGA(DE/GE)");
    expect(html).toContain("ECDE0353");
    expect(html).toContain("2026-08-06");
    expect(html).toContain("period3");
    expect(html).toContain("LT103");
  });

  it("counts every absent student in the tile, including the no-photo ones", () => {
    const html = templates.facultyAttendanceSummaryTemplate(base);
    // 2 plain absent + 1 with no ground truth
    expect(html).toContain(">3</div>");
  });

  it("lists every roll number", () => {
    const html = templates.facultyAttendanceSummaryTemplate(base);
    for (const roll of [...base.presentRolls, ...base.absentRolls, ...base.noGroundTruthRolls]) {
      expect(html).toContain(roll);
    }
  });

  it("tells students with no ground truth to contact the coordinator", () => {
    const html = templates.facultyAttendanceSummaryTemplate(base);
    expect(html).toContain("Department Faculty Coordinator");
    expect(html).toContain("no photos on record");
  });

  it("omits the no-ground-truth block entirely when everyone has photos", () => {
    const html = templates.facultyAttendanceSummaryTemplate({
      ...base,
      noGroundTruthRolls: [],
    });
    expect(html).not.toContain("Department Faculty Coordinator");
  });

  it("omits the review block unless there are review students", () => {
    expect(templates.facultyAttendanceSummaryTemplate(base)).not.toContain("Needs review");
    expect(
      templates.facultyAttendanceSummaryTemplate({ ...base, reviewRolls: ["21103007"] }),
    ).toContain("Needs review");
  });

  it("asks for a reply and says it reaches both parties", () => {
    const html = templates.facultyAttendanceSummaryTemplate({
      ...base,
      coordinatorEmail: "ece.coordinator@nitj.ac.in",
    });
    expect(html).toContain("reply to this email");
    expect(html).toContain("ece.coordinator@nitj.ac.in");
    expect(html).toContain("your reply reaches both");
    expect(html).toContain("also copied on this message");
  });

  it("still asks for a reply when no coordinator could be resolved", () => {
    const html = templates.facultyAttendanceSummaryTemplate(base);
    expect(html).toContain("reply to this email");
    expect(html).toContain("copy your Department Coordinator");
  });

  it("thanks the faculty and says their feedback matters", () => {
    const html = templates.facultyAttendanceSummaryTemplate(base);
    expect(html).toContain("Your feedback is crucial in improving the system");
    expect(html).toContain("thank you in advance");
  });

  it("never tells the faculty not to reply", () => {
    const html = templates.facultyAttendanceSummaryTemplate({
      ...base,
      coordinatorEmail: "ece.coordinator@nitj.ac.in",
    });
    expect(html).not.toContain("do not reply");
  });

  it("leaves the do-not-reply footer on every other alert", () => {
    // The footer is shared; only the faculty summary overrides it.
    expect(templates.serverDownTemplate("ML Service")).toContain("do not reply");
    expect(
      templates.classBunkTemplate({
        batch: "B", subject: "S", faculty: "F", room: "R",
        date: "2026-08-06", timeSlot: "period1", totalStudents: 1,
      }),
    ).toContain("do not reply");
  });

  it("survives an empty class without dividing by zero", () => {
    const html = templates.facultyAttendanceSummaryTemplate({
      ...base,
      totalStudents: 0,
      presentRolls: [],
      absentRolls: [],
      noGroundTruthRolls: [],
    });
    expect(html).toContain("0%");
    expect(html).toContain("None");
  });
});
