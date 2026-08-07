const {
  rollSetsEqual,
  buildErpPayload,
  parseErpResponse,
  semMatches,
  deptAliasPatterns,
  diffRollNos,
  erpGroupMeta,
  dedupeErpRows,
  isClassIdentityError,
} = require("../../src/modules/attendanceModule/controllers/erpSyncController");

describe("isClassIdentityError (unmappable class vs empty group)", () => {
  // Decides whether a failure is reported as "the ERP has no mapping for this
  // class" or left as the ERP's raw message.
  it("recognizes the ERP's class-not-matched messages", () => {
    expect(isClassIdentityError("Subject mapping not found.")).toBe(true);
    expect(isClassIdentityError("subject match not found")).toBe(true);
  });

  it("does not treat a transport or empty-group failure as one", () => {
    expect(isClassIdentityError("timeout of 20000ms exceeded")).toBe(false);
    expect(isClassIdentityError("ERP returned a non-JSON response (HTTP 500)")).toBe(false);
    expect(isClassIdentityError("")).toBe(false);
  });
});

describe("diffRollNos (what a sync changed — the faculty approval gate)", () => {
  it("reports added and removed rolls against the previous roster", () => {
    expect(diffRollNos(["21CS001", "21CS002"], ["21CS002", "21CS003"])).toEqual({
      added: ["21CS003"],
      removed: ["21CS001"],
      unchangedCount: 1,
      previousCount: 2,
    });
  });

  it("normalizes case and whitespace on both sides before comparing", () => {
    const out = diffRollNos([" 21cs001 "], ["21CS001"]);
    expect(out.added).toEqual([]);
    expect(out.removed).toEqual([]);
    expect(out.unchangedCount).toBe(1);
  });

  it("treats a first sync as all-added, nothing removed", () => {
    expect(diffRollNos([], ["21CS001", "21CS002"])).toEqual({
      added: ["21CS001", "21CS002"],
      removed: [],
      unchangedCount: 0,
      previousCount: 0,
    });
  });

  it("reports an unchanged roster as no change at all", () => {
    const out = diffRollNos(["21CS001"], ["21CS001"]);
    expect(out.added).toEqual([]);
    expect(out.removed).toEqual([]);
  });

  // A class that gains five students and loses five others has the same size
  // as before — a count alone would call that "no change".
  it("catches an equal-sized swap", () => {
    const out = diffRollNos(["21CS001", "21CS002"], ["21CS003", "21CS004"]);
    expect(out.added).toEqual(["21CS003", "21CS004"]);
    expect(out.removed).toEqual(["21CS001", "21CS002"]);
  });
});

describe("erpGroupMeta (what the ERP says about the group it answered for)", () => {
  it("keeps the group's own subject code, name and department", () => {
    expect(erpGroupMeta({
      status: "success",
      degree: "B.Tech",
      department: "Electronics and Communication Engineering",
      semester: "B.Tech-ECE-5",
      abbreviation: "FPGA(DE/GE)",
      subject_code: "ECDC0301",
      subject_name: "FPGA Design",
      total_students: 12,
      rollnos: [],
    })).toEqual({
      subjectCode: "ECDC0301",
      subjectName: "FPGA Design",
      department: "Electronics and Communication Engineering",
      degree: "B.Tech",
      semester: "B.Tech-ECE-5",
      abbreviation: "FPGA(DE/GE)",
      claimedTotal: 12,
    });
  });

  it("returns nulls rather than throwing when the ERP omits them", () => {
    expect(erpGroupMeta({ status: "success", rollnos: [] })).toEqual({
      subjectCode: null, subjectName: null, department: null,
      degree: null, semester: null, abbreviation: null, claimedTotal: null,
    });
  });

  it("returns an empty object for a bare array response", () => {
    expect(erpGroupMeta(["21CS001"])).toEqual({});
  });
});

describe("dedupeErpRows (same ERP class listed more than once)", () => {
  const base = {
    degree: "B.Tech", dept: "Computer Science Engineering",
    sem: "B.Tech-CSE-5", subName: "OS(CSE)", subCode: "CSPC-501",
  };

  it("collapses rows that would send the identical ERP request", () => {
    const out = dedupeErpRows([
      { ...base, _id: "a", code: "CSE25", __hasRecord: true, __inTimetable: false },
      { ...base, _id: "b", code: "CSE26", __hasRecord: true, __inTimetable: true },
    ], new Set(["CSE26"]));
    expect(out).toHaveLength(1);
    expect(out[0]._id).toBe("b");
    expect(out[0].__duplicates).toEqual([
      { _id: "a", subCode: "CSPC-501", sem: "B.Tech-CSE-5", code: "CSE25" },
    ]);
  });

  it("prefers the current session's copy when neither matched the timetable", () => {
    const out = dedupeErpRows([
      { ...base, _id: "a", code: "CSE24", __hasRecord: true, __inTimetable: false },
      { ...base, _id: "b", code: "CSE26", __hasRecord: true, __inTimetable: false },
    ], new Set(["CSE26"]));
    expect(out[0]._id).toBe("b");
  });

  it("prefers a real Subject record over a timetable-only row", () => {
    const out = dedupeErpRows([
      { ...base, _id: null, code: "", __hasRecord: false, __inTimetable: true },
      { ...base, _id: "b", code: "CSE26", __hasRecord: true, __inTimetable: true },
    ], new Set(["CSE26"]));
    expect(out[0]._id).toBe("b");
  });

  // Different semesters are different classes to the ERP, so they must not
  // collapse into each other however alike their names are.
  it("keeps the same abbreviation in different semesters apart", () => {
    const out = dedupeErpRows([
      { ...base, _id: "a", sem: "B.Tech-CSE-5", __hasRecord: true },
      { ...base, _id: "b", sem: "B.Tech-CSE-7", __hasRecord: true },
    ], new Set());
    expect(out).toHaveLength(2);
  });

  it("leaves a single row untouched apart from an empty duplicates list", () => {
    const out = dedupeErpRows([{ ...base, _id: "a", __hasRecord: true }], new Set());
    expect(out).toHaveLength(1);
    expect(out[0].__duplicates).toEqual([]);
  });
});

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

  it("is false when no attendance group is configured to sweep", () => {
    // att_group is required by the ERP, so an empty sweep list leaves every
    // request unanswerable — the same practical state as a missing key.
    jest.isolateModules(() => {
      process.env.ERP_PORTAL_KEY = "test-portal-key";
      process.env.ERP_ATT_GROUPS = " , ";
      const { erpConfigured } = require("../../src/modules/attendanceModule/controllers/erpSyncController");
      expect(erpConfigured()).toBe(false);
      delete process.env.ERP_PORTAL_KEY;
      delete process.env.ERP_ATT_GROUPS;
    });
  });
});

describe("ERP_PORTAL_KEY_FIELD (the JSON field the key is sent under)", () => {
  // Two different names: PORTAL_KEY / ERP_PORTAL_KEY is the ENV VAR (ours),
  // this is the field the ERP reads out of the request body (theirs). A key
  // sent under a field the portal ignores looks exactly like no key.
  it("defaults to the camelCase portalKey the previous endpoint took", () => {
    jest.isolateModules(() => {
      delete process.env.ERP_PORTAL_KEY_FIELD;
      const { ERP_PORTAL_KEY_FIELD } = require("../../src/modules/attendanceModule/controllers/erpSyncController");
      expect(ERP_PORTAL_KEY_FIELD).toBe("portalKey");
    });
  });

  it("can be switched to snake_case without a code change", () => {
    jest.isolateModules(() => {
      process.env.ERP_PORTAL_KEY_FIELD = "portal_key";
      const { ERP_PORTAL_KEY_FIELD } = require("../../src/modules/attendanceModule/controllers/erpSyncController");
      expect(ERP_PORTAL_KEY_FIELD).toBe("portal_key");
      delete process.env.ERP_PORTAL_KEY_FIELD;
    });
  });

  it("falls back to the default when set to blank", () => {
    jest.isolateModules(() => {
      process.env.ERP_PORTAL_KEY_FIELD = "   ";
      const { ERP_PORTAL_KEY_FIELD } = require("../../src/modules/attendanceModule/controllers/erpSyncController");
      expect(ERP_PORTAL_KEY_FIELD).toBe("portalKey");
      delete process.env.ERP_PORTAL_KEY_FIELD;
    });
  });
});

describe("encodeErpBody (request body encoding)", () => {
  const { encodeErpBody } = require("../../src/modules/attendanceModule/controllers/erpSyncController");
  const fields = { portalKey: "k", abbreviation: "FPGA(DE/GE)", att_group: "1" };

  it("sends a plain object as JSON by default", () => {
    const out = encodeErpBody(fields, "json");
    expect(out.contentType).toBe("application/json");
    expect(out.body).toEqual(fields);
  });

  // Only needed if the endpoint reads $_POST — PHP does not populate it from
  // an application/json body, which rejects a perfectly correct request.
  it("urlencodes the body when the form encoding is selected", () => {
    const out = encodeErpBody(fields, "form");
    expect(out.contentType).toBe("application/x-www-form-urlencoded");
    // Percent-encoded, so the parentheses and slash survive intact.
    expect(new URLSearchParams(out.body).get("abbreviation")).toBe("FPGA(DE/GE)");
    expect(new URLSearchParams(out.body).get("att_group")).toBe("1");
  });
});

describe("ERP_ATT_GROUPS (attendance groups swept per subject)", () => {
  // The ERP serves ONE attendance group per request, and nothing on our side
  // records which groups a subject uses — so all five are asked for and the
  // rolls unioned. Shrinking this default silently truncates rosters.
  it("defaults to groups 1 through 5", () => {
    jest.isolateModules(() => {
      delete process.env.ERP_ATT_GROUPS;
      const { ERP_ATT_GROUPS } = require("../../src/modules/attendanceModule/controllers/erpSyncController");
      expect(ERP_ATT_GROUPS).toEqual(["1", "2", "3", "4", "5"]);
    });
  });

  it("honours a comma-separated ERP_ATT_GROUPS override, trimming blanks", () => {
    jest.isolateModules(() => {
      process.env.ERP_ATT_GROUPS = " 1, 2 ,,3 ";
      const { ERP_ATT_GROUPS } = require("../../src/modules/attendanceModule/controllers/erpSyncController");
      expect(ERP_ATT_GROUPS).toEqual(["1", "2", "3"]);
      delete process.env.ERP_ATT_GROUPS;
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

  // att_group is deliberately NOT here: it names an attendance group, not a
  // class, is not recorded on the Subject, and is added per request by the
  // group sweep in fetchRollsFromErp.
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

describe("applyErpOverrides (caller's timetable fields beat the Subject's own)", () => {
  const { applyErpOverrides } = require("../../src/modules/attendanceModule/controllers/erpSyncController");

  // This is Manual Generation's long-standing rule, now shared. The ERP Sync
  // page used to ignore the posted abbreviation and prefer Subject.dept, so
  // "AWP(ECE)" fetched fine from the Manual tab and came back "Subject
  // mapping not found" from the ERP Sync page.
  const stored = {
    _id: "64f000000000000000000000",
    dept: "ECE",                 // an abbreviation — NOT what the ERP wants
    sem: "5",                    // a bare number — NOT the ERP's format
    subName: "AWP",              // differs from the timetable's abbreviation
    subjectFullName: "Antenna and Wave Propagation",
  };

  it("lets the caller's department, semester and abbreviation win", () => {
    const out = applyErpOverrides(stored, {
      dept: "Electronics and Communication Engineering",
      sem: "B.Tech-ECE-5",
      abbreviation: "AWP(ECE)",
    });
    expect(out.dept).toBe("Electronics and Communication Engineering");
    expect(out.sem).toBe("B.Tech-ECE-5");
    expect(out.subName).toBe("AWP(ECE)");
  });

  it("falls back to the Subject's own values when the caller sends none", () => {
    expect(applyErpOverrides(stored, {})).toMatchObject({
      dept: "ECE", sem: "5", subName: "AWP",
    });
    expect(applyErpOverrides(stored)).toMatchObject({ subName: "AWP" });
  });

  it("keeps _id intact so the roster still persists onto the right Subject", () => {
    const out = applyErpOverrides(stored, { abbreviation: "AWP(ECE)" });
    expect(out._id).toBe(stored._id);
    expect(out.subjectFullName).toBe("Antenna and Wave Propagation");
  });

  it("ignores a blank override rather than blanking the stored value", () => {
    const out = applyErpOverrides(stored, { dept: "", sem: "", abbreviation: "" });
    expect(out).toMatchObject({ dept: "ECE", sem: "5", subName: "AWP" });
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
