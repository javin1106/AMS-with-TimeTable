const {
  rosterFromSubject,
  reconcileFinalReport,
  rosterMembers,
  membership,
} = require("../../src/modules/attendanceModule/controllers/subjectRoster");

const {
  mergeStudentStatus,
  buildSummary,
} = require("../../src/modules/attendanceModule/controllers/attendanceReportController");

function student(overrides = {}) {
  return {
    rollNo: "R1",
    status: "present",
    avgConfidence: 0.9,
    confidenceZone: "high",
    ...overrides,
  };
}

describe("rosterFromSubject", () => {
  it("normalises, trims and de-duplicates enrolledRollNos", () => {
    expect(
      rosterFromSubject({ enrolledRollNos: [" r1 ", "R2", "r1", "", null, "R3"] }),
    ).toEqual(["R1", "R2", "R3"]);
  });

  it("returns an empty roster for a subject with none on file", () => {
    expect(rosterFromSubject(null)).toEqual([]);
    expect(rosterFromSubject({})).toEqual([]);
  });
});

describe("membership", () => {
  const roster = new Set(["R1", "R2"]);

  it("treats a roster roll number as in-list", () => {
    expect(membership("r1", {}, roster)).toEqual({ inList: true, flagged: false });
  });

  it("flags a roll number the model recognised from outside the subject", () => {
    expect(membership("R9", {}, roster)).toEqual({ inList: false, flagged: true });
  });

  it("keeps everything in-list when no roster is on file", () => {
    expect(membership("R9", {}, new Set())).toEqual({ inList: true, flagged: false });
  });

  it("honours the ML service's own in_list=false", () => {
    expect(membership("R1", { in_list: false }, roster)).toEqual({
      inList: false,
      flagged: true,
    });
  });
});

describe("reconcileFinalReport", () => {
  it("adds a roster student the model never saw, as absent", () => {
    const out = reconcileFinalReport([{ rollNo: "R1", finalStatus: "P" }], ["R1", "R2"]);
    const r2 = out.find((s) => s.rollNo === "R2");
    expect(r2).toMatchObject({ finalStatus: "A", status: "absent", inList: true });
  });

  it("keeps a non-roster match but flags it", () => {
    const out = reconcileFinalReport(
      [{ rollNo: "R1", finalStatus: "P" }, { rollNo: "R9", finalStatus: "P" }],
      ["R1"],
    );
    expect(out.find((s) => s.rollNo === "R9")).toMatchObject({
      inList: false,
      flagged: true,
    });
    // Still present in the report — it's evidence, not noise.
    expect(out).toHaveLength(2);
  });

  it("leaves the report untouched when there is no roster on file", () => {
    const out = reconcileFinalReport([{ rollNo: "R9", finalStatus: "P" }], []);
    expect(out).toHaveLength(1);
    expect(out[0].inList).toBe(true);
  });
});

describe("summary counts are scoped to the roster", () => {
  it("ignores a flagged non-roster student in present/absent/total", () => {
    const slots = [
      {
        slot: 1,
        students: [
          student({ rollNo: "R1", status: "present", confidenceZone: "high" }),
          student({ rollNo: "R9", status: "present", confidenceZone: "high" }),
        ],
      },
    ];

    const finalReport = mergeStudentStatus(slots, ["R1", "R2"]);
    const summary = buildSummary(finalReport);

    // R9 is recognised and kept, but the class is R1 + R2.
    expect(rosterMembers(finalReport).map((s) => s.rollNo).sort()).toEqual(["R1", "R2"]);
    expect(summary).toMatchObject({
      totalStudents: 2,
      present: 1,
      absent: 1,
      attendancePct: 50,
    });
  });

  it("counts the whole ML result when the subject has no roster", () => {
    const slots = [
      { slot: 1, students: [student({ rollNo: "R1" }), student({ rollNo: "R9" })] },
    ];
    expect(buildSummary(mergeStudentStatus(slots))).toMatchObject({
      totalStudents: 2,
      present: 2,
    });
  });
});
