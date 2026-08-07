/**
 * Why is the auto attendance scheduler not running?
 *
 *   node scripts/diagnoseAutoScheduler.js
 *   node scripts/diagnoseAutoScheduler.js --time=10:15 --date=2026-08-06
 *   node scripts/diagnoseAutoScheduler.js --period=period3 --room=LT103
 *
 * Read-only. Walks exactly the same five steps as autoAttendanceScheduler's
 * cron tick — (1) rooms from DB, (2) working-day gates, (3) timetable slot,
 * (4) subject roster + embeddings PKL, (5) camera + ML service reachability —
 * and prints PASS/FAIL for each, so the first FAIL is the reason nothing ran.
 *
 * It does NOT call the ML service's attendance endpoint or write anything.
 *
 * --time  pretend it is this IST wall-clock time (default: now, IST)
 * --date  pretend it is this date, YYYY-MM-DD (default: today, IST)
 * --period  only check this periodKey (default: whichever period --time is in)
 * --room    only check this room (default: every enabled room)
 */
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const mongoose = require("mongoose");

const AcquisitionControl = require("../src/models/acquisitionControl");
const Allotment = require("../src/models/allotment");
const Camera = require("../src/models/attendanceModule/camera");
const Subject = require("../src/models/subject");
const {
  resolveClassContext,
  escapeRegex,
} = require("../src/modules/attendanceModule/controllers/classContextResolver");
const {
  resolveEmbeddingFile,
} = require("../src/modules/attendanceModule/controllers/embeddingPathResolver");
const {
  rosterFromSubject,
} = require("../src/modules/attendanceModule/controllers/subjectRoster");
const {
  checkAttendanceRunAllowed,
  nowMinIST,
  todayIST,
} = require("../src/modules/attendanceModule/controllers/timeWindowGuard");

const ML_URL = process.env.ML_SERVICE_URL || "http://localhost:8500";

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : null;
};

const ok = (msg) => console.log(`  PASS  ${msg}`);
const bad = (msg) => console.log(`  FAIL  ${msg}`);
const note = (msg) => console.log(`        ${msg}`);
const head = (msg) => console.log(`\n${msg}`);

let failures = 0;
const fail = (msg) => {
  failures += 1;
  bad(msg);
};

function timeStrToMin(hhmm) {
  if (!hhmm || typeof hhmm !== "string" || !hhmm.includes(":")) return null;
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}
const hhmm = (min) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

function currentSession() {
  const now = new Date();
  const year = now.getFullYear();
  const start = now.getMonth() + 1 >= 8 ? year : year - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}

async function main() {
  if (!process.env.MONGO_URL) {
    console.error("MONGO_URL is not set — run this from server/ with a .env present.");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URL);

  const date = arg("date") || todayIST();
  const curMin = arg("time") != null ? timeStrToMin(arg("time")) : nowMinIST();
  if (curMin == null) {
    console.error(`--time must look like 10:15 (got "${arg("time")}")`);
    process.exit(1);
  }
  const roomFilter = arg("room");
  const periodFilter = arg("period");

  console.log(
    `Auto scheduler diagnostic — pretending it is ${hhmm(curMin)} IST on ${date}`,
  );
  console.log(`ML service: ${ML_URL}`);

  // ── Step 2a: the config document ──────────────────────────────────────────
  head("Step 2 — acquisition config and working-day gates");
  const config = await AcquisitionControl.findOne({ profileName: "default" }).lean();
  if (!config) {
    fail('no AcquisitionControl document with profileName "default" — the cron tick returns immediately every minute');
    return done();
  }
  ok("AcquisitionControl profile \"default\" found");

  if (!config.active) fail("config.active is false — acquisition is switched OFF");
  else ok("config.active is true");

  if ((config.stoppedDays || []).includes(date)) {
    fail(`${date} is listed in config.stoppedDays`);
  } else ok(`${date} is not in config.stoppedDays`);

  const gate = await checkAttendanceRunAllowed();
  if (!gate.allowed) fail(`time-window guard blocks runs: ${gate.reason}`);
  else ok("attendance run time-window guard allows this time");

  const allotmentEntry = await Allotment.findOne({ "nonWorkingDays.date": date })
    .lean()
    .catch(() => null);
  if (allotmentEntry) {
    const nwd = allotmentEntry.nonWorkingDays.find((d) => d.date === date);
    fail(`${date} is a non-working day in Allotment: ${nwd?.remark || "Holiday"}`);
  } else ok(`${date} is not a non-working day in Allotment`);

  // ── Periods ───────────────────────────────────────────────────────────────
  head("Step 2b — periods");
  const periods = (config.periods || []).filter(
    (p) => !periodFilter || p.periodKey === periodFilter,
  );
  if (periods.length === 0) {
    fail(
      periodFilter
        ? `no period with periodKey "${periodFilter}" in config.periods`
        : "config.periods is empty — no period times configured",
    );
    return done();
  }

  const live = [];
  const runDurationMin = Math.ceil((config.globalRunDurationSec ?? 120) / 60);
  for (const p of periods) {
    const startMin = timeStrToMin(p.startTime);
    const endMin = timeStrToMin(p.endTime);
    if (!p.enabled) {
      note(`${p.periodKey}: disabled (enabled=false)`);
      continue;
    }
    if (startMin == null || endMin == null) {
      fail(`${p.periodKey}: unparseable times "${p.startTime}"–"${p.endTime}"`);
      continue;
    }
    const atStart = curMin >= startMin && curMin <= startMin + 1;
    const inside = curMin > startMin && curMin + runDurationMin <= endMin;
    if (atStart || inside) {
      ok(`${p.periodKey} (${p.startTime}–${p.endTime}) would fire now${inside && !atStart ? " (catch-up)" : ""}`);
      live.push({ ...p, startMin, endMin });
    } else {
      note(
        `${p.periodKey} (${p.startTime}–${p.endTime}): ` +
          (curMin > endMin
            ? "already over"
            : curMin > startMin
              ? `under ${runDurationMin} min left — too late to start a run`
              : "not started yet"),
      );
    }
  }
  if (live.length === 0) {
    fail(
      `no period is live at ${hhmm(curMin)} IST — pass --time=HH:MM to test a period's own start time`,
    );
    return done();
  }

  // ── Step 1: rooms ─────────────────────────────────────────────────────────
  head("Step 1 — rooms");
  const roomIds = await Camera.distinct("roomId", { isActive: true });
  if (roomIds.filter(Boolean).length === 0) {
    fail("no active camera in the Camera registry — Camera.distinct('roomId', {isActive:true}) is empty");
    return done();
  }
  ok(`${roomIds.filter(Boolean).length} room(s) with an active camera: ${roomIds.filter(Boolean).join(", ")}`);

  const overrideMap = {};
  (config.includedRooms || []).forEach((r) => {
    if (r.room) overrideMap[r.room.toUpperCase()] = r;
  });
  let rooms = roomIds
    .filter(Boolean)
    .filter((room) => {
      const ov = overrideMap[room.toUpperCase()];
      if (ov && ov.enabled === false) {
        note(`${room}: disabled in AcquisitionControl.includedRooms`);
        return false;
      }
      return true;
    })
    .filter((room) => !roomFilter || room.toUpperCase() === roomFilter.toUpperCase());

  if (rooms.length === 0) {
    fail("every room with a camera is disabled in AcquisitionControl.includedRooms (or filtered out by --room)");
    return done();
  }
  ok(`${rooms.length} enabled room(s): ${rooms.join(", ")}`);

  // ── Steps 3–5, per live period per room ───────────────────────────────────
  for (const period of live) {
    for (const room of rooms) {
      head(`Steps 3–5 — room ${room}, ${period.periodKey}, ${date}`);

      const { ctx, reason, day, ambiguous } = await resolveClassContext(
        room,
        period.periodKey,
        date,
        config,
      );
      if (!ctx) {
        fail(`no class context (${day}): ${reason}`);
        continue;
      }
      ok(
        `class resolved via ${ctx.source}: batch=${ctx.batch} sem=${ctx.sem} subject="${ctx.subject}" faculty="${ctx.faculty}"`,
      );
      if (ambiguous) note("WARNING: more than one current-session timetable claims this room+slot");

      // Step 4 — subject document, roster, PKL
      const subj = await Subject.findOne({
        subjectFullName: { $regex: escapeRegex((ctx.subject || "").trim()), $options: "i" },
        sem: ctx.sem,
      }).lean();
      if (!subj) {
        fail(
          `no Subject matches subjectFullName ~ "${ctx.subject}" AND sem === "${ctx.sem}" — ` +
            `the run is skipped with "No Subject.embeddingFile set for this subject". ` +
            `Check the Subject's sem value matches the LockSem sem exactly.`,
        );
        continue;
      }
      ok(`Subject found: "${subj.subjectFullName}" (${subj.subCode || "no code"}) sem=${subj.sem} dept=${subj.dept}`);

      const roster = rosterFromSubject(subj);
      if (roster.length === 0) {
        note(
          "Subject.enrolledRollNos is empty — the run still happens, but matching falls back to the whole batch's embedding store",
        );
      } else ok(`roster: ${roster.length} roll number(s)`);

      if (!subj.embeddingFile) {
        fail("Subject.embeddingFile is not set — the scheduler skips this room+slot");
        continue;
      }
      const { path: pklPath, reason: pklReason } = resolveEmbeddingFile({
        session: ctx.session || currentSession(),
        dept: ctx.dept || subj.dept,
        filename: subj.embeddingFile,
      });
      if (!pklPath) {
        fail(`embeddings PKL missing on disk — ${pklReason}`);
        continue;
      }
      ok(`embeddings PKL present: ${pklPath} (${(fs.statSync(pklPath).size / 1024).toFixed(0)} KB)`);

      // Step 5 — cameras
      const ov = overrideMap[room.toUpperCase()];
      let cam1 = ov?.rtspUrl1 || "";
      let source = "AcquisitionControl override";
      if (!cam1) {
        const cams = await Camera.find({ roomId: room.toUpperCase(), isActive: true }).lean();
        source = "Camera registry";
        cam1 = cams.find((c) => c.position === "front-left")?.streamUrl || "";
        if (!cam1 && cams.length > 0) {
          fail(
            `room ${room} has ${cams.length} active camera(s) but none with position "front-left" — ` +
              `resolveCameras returns no cam1 and the run is skipped. Positions present: ${cams.map((c) => c.position).join(", ")}`,
          );
          continue;
        }
        if (cams.length === 0) {
          fail(
            `Camera.find({roomId: "${room.toUpperCase()}", isActive: true}) returned nothing — ` +
              `roomId is stored as "${room}", so the upper-cased lookup does not match`,
          );
          continue;
        }
      }
      ok(`camera 1 (${source}): ${cam1}`);
    }
  }

  // ── ML service ────────────────────────────────────────────────────────────
  head("Step 5 — ML service");
  try {
    const res = await axios.get(`${ML_URL}/health`, { timeout: 5000 });
    ok(`${ML_URL}/health responded ${res.status}`);
    if (res.data && res.data.face_model_loaded === false) {
      fail("face model is NOT loaded — /run-attendance-rtsp-sync returns 503 and every check fails");
    }
  } catch (err) {
    fail(`${ML_URL} unreachable: ${err.message} — every check would fail with this error`);
  }

  return done();
}

function done() {
  head(
    failures === 0
      ? "No blocking problem found — the scheduler should run for the case above."
      : `${failures} blocking problem(s) found — see the FAIL lines above.`,
  );
  return mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("\nDiagnostic crashed:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
