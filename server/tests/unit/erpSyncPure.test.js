const {
  rollSetsEqual,
  buildErpPayload,
  parseErpResponse,
  semMatches,
  deptAliasPatterns,
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

describe("parseErpResponse (ERP response shapes)", () => {
  // The shape the NITJ portal actually returns. The roster key is all
  // lowercase `rollnos` — camelCase `rollNos` is a different key in JS and
  // reading the wrong one yields an empty roster, so this is pinned.
  it("reads the portal's real payload", () => {
    const out = parseErpResponse({
      status: "success",
      degree: "B.Tech",
      department: "Electronics and Communication Engineering",
      semester: "B.Tech-ECE-5",
      abbreviation: "AWP(ECE)",
      subject_code: "ECDC0301",
      subject_name: "Antenna and Wave Propagation",
      total_students: 3,
      rollnos: ["23104006", "24104001", "24104002"],
    });
    expect(out.rollNos).toEqual(["23104006", "24104001", "24104002"]);
    expect(out.faculty).toBeNull();
  });

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

describe("deptAliasPatterns (dropdown department → Subject.dept spellings)", () => {
  // The dropdown always sends the timetable's full department name, while
  // Subject.dept holds abbreviations and truncations. A department matches
  // when ANY of the returned patterns does.
  const matches = (dept, stored) =>
    deptAliasPatterns(dept).some((re) => re.test(stored));

  it("matches the full name, in either underscore or space spelling", () => {
    expect(matches("Computer_Science_and_Engineering", "Computer Science and Engineering")).toBe(true);
    expect(matches("Computer Science and Engineering", "Computer_Science_and_Engineering")).toBe(true);
  });

  it("matches the initials, skipping stopwords", () => {
    expect(matches("Computer_Science_and_Engineering", "CSE")).toBe(true);
    expect(matches("Electronics_and_Communication_Engineering", "ECE")).toBe(true);
    expect(matches("Instrumentation_and_Control_Engineering", "ICE")).toBe(true);
    expect(matches("Information_Technology", "IT")).toBe(true);
  });

  it("matches a truncated department name", () => {
    expect(matches("Mechanical_Engineering", "Mechanical")).toBe(true);
    expect(matches("Civil_Engineering", "Civil")).toBe(true);
    expect(matches("Industrial_and_Production_Engineering", "Industrial and Production")).toBe(true);
    expect(matches("Mathematics_&_Computing", "Mathematics")).toBe(true);
  });

  it("tolerates surrounding whitespace and case in the stored value", () => {
    expect(matches("Chemistry", " chemistry ")).toBe(true);
    expect(matches("Computer_Science_and_Engineering", "Computer Science and Engineering ")).toBe(true);
  });

  it("does not match a different department", () => {
    expect(matches("Computer_Science_and_Engineering", "Civil Engineering")).toBe(false);
    expect(matches("Civil_Engineering", "CSE")).toBe(false);
    expect(matches("Mechanical_Engineering", "Mechatronics")).toBe(false);
  });

  it("does not produce a prefix ending on a stopword", () => {
    expect(matches("Industrial_and_Production_Engineering", "Industrial and")).toBe(false);
  });

  it("returns nothing for a blank department", () => {
    expect(deptAliasPatterns("")).toEqual([]);
  });
});

describe("semMatches (Semester dropdown value → Subject.sem)", () => {
  it("accepts every subject when no semester is selected", () => {
    expect(semMatches("B.Tech-ECE-5", "")).toBe(true);
    expect(semMatches("B.Tech-ECE-5", undefined)).toBe(true);
  });

  it("matches the same string regardless of case and padding", () => {
    expect(semMatches(" B.Tech-ECE-5 ", "b.tech-ece-5")).toBe(true);
  });

  it("matches a bare-number dropdown value against an ERP-formatted sem", () => {
    expect(semMatches("B.Tech-ECE-5", "5")).toBe(true);
    expect(semMatches("5", "B.Tech-ECE-5")).toBe(true);
  });

  it("does not collapse two differently-formatted sems sharing a number", () => {
    expect(semMatches("B.Tech-ECE-5", "M.Tech-ECE-5")).toBe(false);
    expect(semMatches("B.Tech-ECE-5", "B.Tech-CSE-5")).toBe(false);
  });

  it("rejects a different semester number", () => {
    expect(semMatches("B.Tech-ECE-5", "6")).toBe(false);
    expect(semMatches("5", "6")).toBe(false);
  });

  it("rejects a subject with no semester at all", () => {
    expect(semMatches("", "5")).toBe(false);
    expect(semMatches("B.Tech-CH+VLSI-SectionB6", "5")).toBe(false);
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
