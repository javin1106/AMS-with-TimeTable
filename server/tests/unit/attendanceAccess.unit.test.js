const {
  normalizeDepartment,
  batchBelongsToDepartment,
  batchBelongsToAnyDepartment,
  departmentIsAllowed,
  uniqueDepartments,
} = require("../../src/modules/attendanceModule/middleware/attendanceAccess");

describe("normalizeDepartment", () => {
  it("strips spaces, dashes and underscores and uppercases", () => {
    expect(normalizeDepartment("computer science")).toBe(normalizeDepartment("Computer-Science"));
    expect(normalizeDepartment("cse")).toBe("CSE");
    expect(normalizeDepartment("C S E")).toBe("CSE");
    expect(normalizeDepartment("c-s-e")).toBe("CSE");
    expect(normalizeDepartment("c_s_e")).toBe("CSE");
  });

  it("treats null/undefined as empty string", () => {
    expect(normalizeDepartment(null)).toBe("");
    expect(normalizeDepartment(undefined)).toBe("");
  });
});

describe("batchBelongsToDepartment", () => {
  it("matches a batch whose middle segment is the department", () => {
    expect(batchBelongsToDepartment("BTECH_CSE_2027", "CSE")).toBe(true);
    expect(batchBelongsToDepartment("BTECH_CSE_2027", "cse")).toBe(true);
  });

  it("rejects a batch whose middle segment is a different department", () => {
    expect(batchBelongsToDepartment("BTECH_ECE_2027", "CSE")).toBe(false);
  });

  it("escapes regex metacharacters in the department", () => {
    // A department containing regex-special chars must not be treated as a pattern
    expect(batchBelongsToDepartment("BTECH_A.B_2027", "A.B")).toBe(true);
    expect(batchBelongsToDepartment("BTECH_AXB_2027", "A.B")).toBe(false);
  });

  it("handles missing batch/department gracefully", () => {
    expect(batchBelongsToDepartment("", "CSE")).toBe(false);
    expect(batchBelongsToDepartment("BTECH_CSE_2027", "")).toBe(false);
  });
});

describe("assigned Ground Truth / Roll Assignment departments", () => {
  const assigned = ["ECE", "VLSI"];

  it("accepts explicitly assigned departments and rejects every other department", () => {
    expect(departmentIsAllowed("ece", assigned)).toBe(true);
    expect(departmentIsAllowed("V L S I", assigned)).toBe(true);
    expect(departmentIsAllowed("CSE", assigned)).toBe(false);
  });

  it("accepts batches belonging to any assigned department", () => {
    expect(batchBelongsToAnyDepartment("BTECH_ECE_2027", assigned)).toBe(true);
    expect(batchBelongsToAnyDepartment("BTECH_VLSI_2027", assigned)).toBe(true);
    expect(batchBelongsToAnyDepartment("BTECH_CSE_2027", assigned)).toBe(false);
  });

  it("deduplicates equivalent department spellings", () => {
    expect(uniqueDepartments(["VLSI", "v l s i", "V_L_S_I", "ECE"])).toEqual([
      "VLSI",
      "ECE",
    ]);
  });
});
