// server/src/modules/attendanceModule/controllers/classContextResolver.js
//
// Single source of truth for "which class is in room R, slot S, on date D?".
//
// This used to be copy-pasted in three places (autoAttendanceScheduler's
// resolveContext, schedulerController's resolveRoomContext, and the
// /timetablemodule/lock/attendance-lookup route) and the copies had drifted:
// two of them never filtered LockSem by weekday, so they returned whichever
// day's class happened to sort first — the automatic run and the developer
// page could show different subjects for the same room and slot. Everything
// resolves through here now so they cannot disagree again.
//
// Resolution order:
//   1. LockSem for this weekday + slot + room, on a currentSession timetable.
//   2. An active AcquisitionControl extraClass for this exact date + slot +
//      room overrides the subject/faculty from (1) — that's the faculty-swap
//      / alteration flow.
//   3. If there is no LockSem row at all, an extraClass for this exact date
//      stands on its own (a genuine extra / lunch-hour class).
// A slot that resolves with no subject is a free period — no attendance.

const LockSem = require("../../../models/locksem");

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function escapeRegex(str) {
  return String(str == null ? "" : str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Weekday for a "YYYY-MM-DD" string, independent of the server's timezone.
// `new Date('2026-08-05').getDay()` parses as UTC midnight but reports in
// local time, so it names the previous day anywhere west of UTC.
function dayOfWeek(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || "").trim());
  if (!m) return DAY_NAMES[new Date().getDay()];
  return DAY_NAMES[
    new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()
  ];
}

function currentSession() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const start = month >= 8 ? year : year - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}

// Batch code (e.g. BTECH_CSE_2024) from the timetable doc + the LockSem sem.
function deriveBatch(tt, rec) {
  const session = tt.session || currentSession();
  const sessionStartYear =
    parseInt(session.split("-")[0]) || new Date().getFullYear();
  const semNum = parseInt((rec.sem || "").match(/\d+/)?.[0] || "0");
  const yearOfStudy = semNum > 0 ? Math.ceil(semNum / 2) : 1;
  const batchYear = String(sessionStartYear - (yearOfStudy - 1));
  const ttName = (tt.name || "").toUpperCase();
  let degree = "BTECH";
  for (const d of ["MTECH", "PHD", "BSC", "MSC", "MBA", "MCA", "BTECH"]) {
    if (ttName.includes(d)) {
      degree = d;
      break;
    }
  }
  const dept = (tt.dept || "").trim().toUpperCase().replace(/\s+/g, "_");
  return { batch: `${degree}_${dept}_${batchYear}`, dept, session, degree };
}

// Batch for a standalone extra class, from its subject + semester. Department
// and degree both come from the Subject record (degree falls back to BTECH,
// matching deriveBatch's own default).
async function deriveBatchForExtraClass(extra) {
  try {
    const Subject = require("../../../models/subject");
    const flexSubject = escapeRegex(String(extra.subject).trim())
      .replace(/\\\(/g, "\\s*\\(\\s*")
      .replace(/\\\)/g, "\\s*\\)\\s*")
      .replace(/-/g, "\\s*-\\s*")
      .replace(/\s+/g, "\\s+");

    let query = {
      subjectFullName: { $regex: new RegExp(flexSubject, "i") },
    };
    if (extra.semester) {
      const flexSem = escapeRegex(String(extra.semester).trim())
        .replace(/-/g, "\\s*-\\s*")
        .replace(/\s+/g, "\\s+");
      query.sem = { $regex: new RegExp(`^${flexSem}$`, "i") };
    }

    const subj = await Subject.findOne(query).lean();
    const dept = (subj?.dept || "").trim().toUpperCase().replace(/\s+/g, "_");
    if (!dept) return { batch: "", dept: "" };

    const session = currentSession();
    const sessionStartYear =
      parseInt(session.split("-")[0]) || new Date().getFullYear();
    const semNum = parseInt(String(extra.semester || "").match(/\d+/)?.[0] || "0");
    const yearOfStudy = semNum > 0 ? Math.ceil(semNum / 2) : 1;
    const batchYear = String(sessionStartYear - (yearOfStudy - 1));
    const degree = (subj.degree || "BTECH").trim().toUpperCase().replace(/\s+/g, "_");
    return { batch: `${degree}_${dept}_${batchYear}`, dept };
  } catch (err) {
    console.error("[ClassContext] extra-class batch derivation failed:", err.message);
    return { batch: "", dept: "" };
  }
}

function findExtraClass(config, room, slot, date) {
  return (
    (config?.extraClasses || []).find(
      (ec) =>
        ec.active &&
        ec.date === date &&
        ec.periodKey === slot &&
        ec.room?.toLowerCase().trim() === String(room).toLowerCase().trim(),
    ) || null
  );
}

/**
 * Resolve the class scheduled in a room for a slot on a date.
 *
 * @param {string} room     room id, e.g. "LT103"
 * @param {string} slot     period key, e.g. "period1"
 * @param {string} date     "YYYY-MM-DD"
 * @param {object} config   AcquisitionControl doc (for extraClasses); optional
 * @returns {Promise<{ctx: object|null, reason: string, day: string, ambiguous: boolean}>}
 *   ctx is null when nothing should run; `reason` says why, for the caller's log.
 */
async function resolveClassContext(room, slot, date, config = {}) {
  const day = dayOfWeek(date);
  const result = { ctx: null, reason: "", day, ambiguous: false };

  let records = [];
  try {
    records = await LockSem.aggregate([
      {
        $match: {
          slot: { $regex: new RegExp(`^${escapeRegex(slot)}$`, "i") },
          day: { $regex: new RegExp(`^${escapeRegex(day)}$`, "i") },
          "slotData.room": { $regex: new RegExp(`^${escapeRegex(room)}$`, "i") },
        },
      },
      {
        $lookup: {
          from: "timetables",
          localField: "timetable",
          foreignField: "_id",
          as: "tt",
        },
      },
      { $unwind: { path: "$tt", preserveNullAndEmptyArrays: false } },
      { $match: { "tt.currentSession": true } },
      // Two is enough to detect an ambiguous booking without pulling the world.
      { $limit: 2 },
    ]);
  } catch (err) {
    console.error("[ClassContext] LockSem lookup failed:", err.message);
    result.reason = `Timetable lookup failed: ${err.message}`;
    return result;
  }

  const extra = findExtraClass(config, room, slot, date);

  if (records.length) {
    if (records.length > 1) {
      // Two current-session timetables book the same room in the same slot on
      // the same day. Whichever sorts first wins, which is arbitrary — surface
      // it rather than silently taking attendance for the wrong batch.
      result.ambiguous = true;
      console.warn(
        `[ClassContext] ⚠ Ambiguous booking — room=${room} slot=${slot} ${day}: ` +
          `${records.length}+ current-session timetables claim this slot ` +
          `(sems: ${records.map((r) => r.sem).join(", ")}). Using the first.`,
      );
    }

    const rec = records[0];
    const slotEntry = (rec.slotData || []).find(
      (s) => s.room && s.room.toLowerCase() === String(room).toLowerCase(),
    );
    if (!slotEntry) {
      result.reason = `Room ${room} not present in the matched slot data`;
      return result;
    }

    const { batch, dept, session } = deriveBatch(rec.tt, rec);
    let subject = slotEntry.subject || "";
    let faculty = slotEntry.faculty || "";
    let altered = false;

    if (extra) {
      if (extra.subject) subject = extra.subject;
      if (extra.faculty) faculty = extra.faculty;
      altered = true;
    }

    if (!String(subject).trim()) {
      result.reason = `Free slot — no subject scheduled for room=${room} slot=${slot} on ${day}`;
      return result;
    }

    result.ctx = {
      source: altered ? "locksem+extraClass" : "locksem",
      batch,
      subject,
      faculty,
      sem: rec.sem || "",
      dept,
      session,
      locksemId: rec._id.toString(),
      day,
      altered,
      originalSubject: altered ? slotEntry.subject || "" : "",
      originalFaculty: altered ? slotEntry.faculty || "" : "",
    };
    return result;
  }

  // No regular class — a standalone extra / lunch-hour class can still run.
  if (extra) {
    if (!String(extra.subject || "").trim()) {
      result.reason = `Extra class for room=${room} slot=${slot} has no subject`;
      return result;
    }
    // The extra-class form collects subject + semester, not a batch code, so
    // derive it the same way a timetable row would when it wasn't supplied.
    const derived = String(extra.batch || "").trim()
      ? { batch: extra.batch.trim(), dept: "" }
      : await deriveBatchForExtraClass(extra);
    if (!derived.batch) {
      // Without a batch we can't select embeddings or file the report.
      result.reason =
        `Extra class for room=${room} slot=${slot} has no batch, and one could not ` +
        `be derived (subject "${extra.subject}" sem "${extra.semester || ""}" not found in Subjects)`;
      return result;
    }
    result.ctx = {
      source: "extraClass",
      batch: derived.batch,
      subject: extra.subject,
      faculty: extra.faculty || "",
      sem: extra.semester || "",
      dept: derived.dept || "",
      session: currentSession(),
      locksemId: null,
      day,
      altered: false,
      originalSubject: "",
      originalFaculty: "",
    };
    return result;
  }

  result.reason = `No class scheduled for room=${room} slot=${slot} on ${day}`;
  return result;
}

module.exports = {
  resolveClassContext,
  dayOfWeek,
  currentSession,
  deriveBatch,
  escapeRegex,
  DAY_NAMES,
};
