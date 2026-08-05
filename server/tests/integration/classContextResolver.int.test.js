const { connect, clearDatabase, disconnect } = require("../helpers/db");
const {
  resolveClassContext,
  dayOfWeek,
} = require("../../src/modules/attendanceModule/controllers/classContextResolver");
const LockSem = require("../../src/models/locksem");
const TimeTable = require("../../src/models/timetable");
const Subject = require("../../src/models/subject");

beforeAll(connect);
afterEach(clearDatabase);
afterAll(disconnect);

const ROOM = "R101";
const SLOT = "period1";
const THURSDAY = "2026-07-09";
const FRIDAY = "2026-07-10";

async function seedWeek() {
  const tt = await TimeTable.create({
    name: "BTECH CSE",
    dept: "CSE",
    session: "2026-27",
    currentSession: true,
  });
  await LockSem.create({
    day: "Thursday",
    slot: SLOT,
    slotData: [{ subject: "DBMS", faculty: "Dr. X", room: ROOM }],
    sem: "5",
    code: "CSE5",
    timetable: tt._id,
  });
  await LockSem.create({
    day: "Friday",
    slot: SLOT,
    slotData: [{ subject: "Operating Systems", faculty: "Dr. Y", room: ROOM }],
    sem: "5",
    code: "CSE5",
    timetable: tt._id,
  });
  return tt;
}

describe("dayOfWeek", () => {
  it("names the weekday of an ISO date regardless of server timezone", () => {
    expect(dayOfWeek("2026-07-09")).toBe("Thursday");
    expect(dayOfWeek("2026-07-10")).toBe("Friday");
  });
});

describe("resolveClassContext — weekday mapping", () => {
  it("returns the class scheduled for that specific weekday", async () => {
    await seedWeek();

    const thu = await resolveClassContext(ROOM, SLOT, THURSDAY, {});
    expect(thu.day).toBe("Thursday");
    expect(thu.ctx.subject).toBe("DBMS");
    expect(thu.ctx.faculty).toBe("Dr. X");

    const fri = await resolveClassContext(ROOM, SLOT, FRIDAY, {});
    expect(fri.day).toBe("Friday");
    expect(fri.ctx.subject).toBe("Operating Systems");
    expect(fri.ctx.faculty).toBe("Dr. Y");
  });

  it("resolves no class on a weekday the room is not booked", async () => {
    await seedWeek();
    // 2026-07-11 is a Saturday — nothing scheduled.
    const res = await resolveClassContext(ROOM, SLOT, "2026-07-11", {});
    expect(res.ctx).toBeNull();
    expect(res.reason).toMatch(/No class scheduled/i);
  });

  it("derives the batch from session and semester", async () => {
    await seedWeek();
    const { ctx } = await resolveClassContext(ROOM, SLOT, THURSDAY, {});
    // session 2026-27, sem 5 -> year of study 3 -> 2026 - 2 = 2024
    expect(ctx.batch).toBe("BTECH_CSE_2024");
    expect(ctx.dept).toBe("CSE");
    expect(ctx.source).toBe("locksem");
  });

  it("ignores timetables that are not the current session", async () => {
    const old = await TimeTable.create({
      name: "BTECH CSE",
      dept: "CSE",
      session: "2025-26",
      currentSession: false,
    });
    await LockSem.create({
      day: "Thursday",
      slot: SLOT,
      slotData: [{ subject: "Stale Subject", faculty: "Dr. Z", room: ROOM }],
      sem: "5",
      code: "CSE5",
      timetable: old._id,
    });

    const res = await resolveClassContext(ROOM, SLOT, THURSDAY, {});
    expect(res.ctx).toBeNull();
  });

  it("treats a slot with no subject as a free period", async () => {
    const tt = await TimeTable.create({
      name: "BTECH CSE",
      dept: "CSE",
      session: "2026-27",
      currentSession: true,
    });
    await LockSem.create({
      day: "Thursday",
      slot: SLOT,
      slotData: [{ subject: "", faculty: "", room: ROOM }],
      sem: "5",
      code: "CSE5",
      timetable: tt._id,
    });

    const res = await resolveClassContext(ROOM, SLOT, THURSDAY, {});
    expect(res.ctx).toBeNull();
    expect(res.reason).toMatch(/Free slot/i);
  });
});

describe("resolveClassContext — extra classes and alterations", () => {
  it("applies an alteration for that exact date on top of the regular class", async () => {
    await seedWeek();
    const config = {
      extraClasses: [
        {
          active: true,
          date: THURSDAY,
          periodKey: SLOT,
          room: ROOM,
          subject: "Computer Networks",
          faculty: "Dr. Swap",
          isAlteration: true,
        },
      ],
    };

    const { ctx } = await resolveClassContext(ROOM, SLOT, THURSDAY, config);
    expect(ctx.subject).toBe("Computer Networks");
    expect(ctx.faculty).toBe("Dr. Swap");
    expect(ctx.altered).toBe(true);
    expect(ctx.originalSubject).toBe("DBMS");
    // The batch still comes from the timetable, so the report files correctly.
    expect(ctx.batch).toBe("BTECH_CSE_2024");
  });

  it("does not apply an alteration booked for a different date", async () => {
    await seedWeek();
    const config = {
      extraClasses: [
        {
          active: true,
          date: FRIDAY,
          periodKey: SLOT,
          room: ROOM,
          subject: "Computer Networks",
          faculty: "Dr. Swap",
        },
      ],
    };

    const { ctx } = await resolveClassContext(ROOM, SLOT, THURSDAY, config);
    expect(ctx.subject).toBe("DBMS");
    expect(ctx.altered).toBe(false);
  });

  it("runs a standalone extra class where no regular class exists", async () => {
    await Subject.create({
      subName: "ML",
      subCode: "CS501",
      subjectFullName: "Machine Learning",
      sem: "5",
      dept: "CSE",
      degree: "BTECH",
      type: "theory",
      studentCount: 60,
    });
    const config = {
      extraClasses: [
        {
          active: true,
          date: THURSDAY,
          periodKey: SLOT,
          room: ROOM,
          subject: "Machine Learning",
          semester: "5",
          faculty: "Dr. New",
        },
      ],
    };

    const { ctx } = await resolveClassContext(ROOM, SLOT, THURSDAY, config);
    expect(ctx.source).toBe("extraClass");
    expect(ctx.subject).toBe("Machine Learning");
    expect(ctx.batch).toBe("BTECH_CSE_2024");
  });

  it("prefers an explicit batch on the extra class over a derived one", async () => {
    const config = {
      extraClasses: [
        {
          active: true,
          date: THURSDAY,
          periodKey: SLOT,
          room: ROOM,
          subject: "Machine Learning",
          semester: "5",
          batch: "MTECH_CSE_2025",
        },
      ],
    };

    const { ctx } = await resolveClassContext(ROOM, SLOT, THURSDAY, config);
    expect(ctx.batch).toBe("MTECH_CSE_2025");
  });

  it("ignores inactive extra classes", async () => {
    const config = {
      extraClasses: [
        {
          active: false,
          date: THURSDAY,
          periodKey: SLOT,
          room: ROOM,
          subject: "Machine Learning",
          semester: "5",
          batch: "BTECH_CSE_2024",
        },
      ],
    };

    const res = await resolveClassContext(ROOM, SLOT, THURSDAY, config);
    expect(res.ctx).toBeNull();
  });
});
