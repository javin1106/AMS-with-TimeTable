const {
  rollSetsEqual,
  buildErpPayload,
  parseErpResponse,
} = require("../../src/modules/attendanceModule/controllers/erpSyncController");

describe("rollSetsEqual", () => {
  it("treats identical sets as equal regardless of order", () => {
    expect(rollSetsEqual(["21CS001", "21CS002"], ["21CS002", "21CS001"])).toBe(true);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(rollSetsEqual([" 21cs001 "], ["21CS001"])).toBe(true);
  });

  it("returns false on length mismatch", () => {
    expect(rollSetsEqual(["21CS001"], ["21CS001", "21CS002"])).toBe(false);
  });

  it("returns false when contents differ", () => {
    expect(rollSetsEqual(["21CS001"], ["21CS002"])).toBe(false);
  });

  it("treats two empty lists as equal", () => {
    expect(rollSetsEqual([], [])).toBe(true);
  });
});

describe("erpConfigured / ERP_PORTAL_KEY (module-load env capture)", () => {
  it("is false when no portal key is set", () => {
    jest.isolateModules(() => {
      delete process.env.ERP_PORTAL_KEY;
      delete process.env.PORTAL_KEY;
      const { erpConfigured } = require("../../src/modules/attendanceModule/controllers/erpSyncController");
      expect(erpConfigured()).toBe(false);
    });
  });

  it("is true when ERP_PORTAL_KEY is set before the module is required", () => {
    jest.isolateModules(() => {
      process.env.ERP_PORTAL_KEY = "test-portal-key";
      const { erpConfigured } = require("../../src/modules/attendanceModule/controllers/erpSyncController");
      expect(erpConfigured()).toBe(true);
      delete process.env.ERP_PORTAL_KEY;
    });
  });

  it("accepts PORTAL_KEY as an alias", () => {
    jest.isolateModules(() => {
      process.env.PORTAL_KEY = "test-portal-key";
      const { erpConfigured } = require("../../src/modules/attendanceModule/controllers/erpSyncController");
      expect(erpConfigured()).toBe(true);
      delete process.env.PORTAL_KEY;
    });
  });

  it("defaults the endpoint URL to the NITJ roster API", () => {
    jest.isolateModules(() => {
      delete process.env.ERP_STUDENTS_API_URL;
      const { ERP_STUDENTS_API_URL } = require("../../src/modules/attendanceModule/controllers/erpSyncController");
      expect(ERP_STUDENTS_API_URL).toContain("get_students_api.php");
    });
  });
});

describe("buildErpPayload (Subject → ERP request fields)", () => {
  const subject = {
    degree: "B.Tech",
    dept: "Electronics_and_Communication_Engineering",
    sem: "B.Tech-ECE-5",
    subName: "AWP(ECE)",
    subCode: "ECPC-501",
  };

  it("maps a complete subject onto the four ERP fields", () => {
    expect(buildErpPayload(subject)).toEqual({
      degree: "B.Tech",
      department: "Electronics and Communication Engineering",
      semester: "B.Tech-ECE-5",
      abbreviation: "AWP(ECE)",
    });
  });

  it("lets an explicit degree override the subject's own", () => {
    expect(buildErpPayload(subject, "M.Tech").degree).toBe("M.Tech");
  });

  it("ignores a blank degree override", () => {
    expect(buildErpPayload(subject, "").degree).toBe("B.Tech");
  });

  it("derives the degree from the sem prefix when the subject has none", () => {
    expect(buildErpPayload({ ...subject, degree: "" }).degree).toBe("B.Tech");
  });

  it("falls back to subCode when the abbreviation is missing", () => {
    expect(buildErpPayload({ ...subject, subName: "" }).abbreviation).toBe("ECPC-501");
  });

  it("does not invent values for an empty subject", () => {
    expect(buildErpPayload({})).toEqual({
      degree: "", department: "", semester: "", abbreviation: "",
    });
  });
});

describe("parseErpResponse (undocumented ERP response shapes)", () => {
  it("reads a bare array of roll strings", () => {
    expect(parseErpResponse(["21ECE001", "21ECE002"]).rollNos)
      .toEqual(["21ECE001", "21ECE002"]);
  });

  it("reads students[] objects and the faculty name", () => {
    const out = parseErpResponse({
      students: [{ roll_number: "21ECE001" }, { RollNo: "21ece002" }],
      faculty: " Dr. X ",
    });
    expect(out.rollNos).toEqual(["21ECE001", "21ECE002"]);
    expect(out.faculty).toBe("Dr. X");
  });

  it("reads the student_list / rows / result containers", () => {
    for (const key of ["student_list", "rows", "result"]) {
      expect(parseErpResponse({ [key]: ["21ECE001"] }).rollNos).toEqual(["21ECE001"]);
    }
  });

  it("falls back to any roll-like key on a student object", () => {
    expect(parseErpResponse({ data: [{ student_rollno: "21ECE003" }] }).rollNos)
      .toEqual(["21ECE003"]);
  });

  it("uppercases, dedupes and drops values of 3 characters or fewer", () => {
    expect(parseErpResponse(["21ece001", " 21ECE001 ", "N/A", ""]).rollNos)
      .toEqual(["21ECE001"]);
  });

  it("returns an empty roster rather than throwing on an unexpected shape", () => {
    expect(parseErpResponse({ status: "error", message: "bad key" }))
      .toEqual({ rollNos: [], faculty: null });
  });
});

describe("firstYearStudentSem", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns 1 for months August–December", () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-09-15"));
    const { firstYearStudentSem } = require("../../src/modules/attendanceModule/controllers/erpSyncController");
    expect(firstYearStudentSem()).toBe(1);
  });

  it("returns 2 for months January–July", () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-03-15"));
    const { firstYearStudentSem } = require("../../src/modules/attendanceModule/controllers/erpSyncController");
    expect(firstYearStudentSem()).toBe(2);
  });
});
