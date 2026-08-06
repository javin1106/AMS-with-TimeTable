// autoAttendanceScheduler.js
// 5-step requirement: (1) fetch rooms from DB, (2) check working day,
// (3) check slot data, (4) check embeddings for the subject, (5) acquire —
// all enabled rooms in parallel. No hardcoded room map, no hardcoded slot
// times, no roll-number/ground-truth embedding building.

const axios = require("axios");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

const AcquisitionControl = require("../../../models/acquisitionControl");
const Allotment = require("../../../models/allotment");
const Camera = require("../../../models/attendanceModule/camera");
const Subject = require("../../../models/subject");
const AttendanceReport = require("../../../models/attendanceReport");
const { saveAttendanceDailyData } = require("./attendanceDailyDataSaver");
const { saveUnknownFaces } = require("./unknownFaceWriter");
const { saveFrameSnapshots } = require("./frameSnapshotWriter");
const {
  buildEnrolledEmbeddings,
  buildEnrolledEmbeddingsTopK,
  buildEnrolledEmbeddingsAdaface,
  buildEnrolledEmbeddingsAdafaceTopK,
} = require("./embeddingSyncHelper");
const alertNotifier = require("./alertNotifier");
const { sendFacultyAttendanceSummary } = require("./facultyAttendanceMailer");
const { pushAttendanceToErp } = require("./erpAttendancePushController");
const {
  checkAttendanceRunAllowed,
  nowMinIST,
  todayIST,
} = require("./timeWindowGuard");
const { resolveClassContext, escapeRegex } = require("./classContextResolver");
const { resolveEmbeddingFile } = require("./embeddingPathResolver");
const {
  rosterFromSubject,
  reconcileFinalReport,
  rosterMembers,
  membership,
} = require("./subjectRoster");

const ML_URL = process.env.ML_SERVICE_URL || "http://localhost:8500";
// Embedding .pkl paths are resolved by embeddingPathResolver — see that file
// for why the dept folder cannot be joined naively.
const GROUND_TRUTH_DIR = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "ml-data",
  "ground_truth",
);

// ── Helpers ──────────────────────────────────────────────────────────────────
// Period times in AcquisitionControl are campus wall-clock (IST), so the
// scheduler's own clock and date must be IST too — not the server's timezone
// (local) and not UTC (what toISOString gives). On a UTC-hosted server the old
// pair fired every period 5h30m late and rolled the date over at 05:30 IST.
function todayStr() {
  return todayIST();
}
function nowMin() {
  return nowMinIST();
}
function timeStrToMin(hhmm) {
  if (!hhmm || typeof hhmm !== "string" || !hhmm.includes(":")) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
function safeSubject(raw) {
  return (raw || "")
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_|_$/, "");
}
function currentSession() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const start = month >= 8 ? year : year - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}

// ── Step 1: rooms from DB (Camera Registry + optional AcquisitionControl override) ──
async function getEnabledRooms(config) {
  const roomIds = await Camera.distinct("roomId", { isActive: true });
  const overrideMap = {};
  (config.includedRooms || []).forEach((r) => {
    if (r.room) overrideMap[r.room.toUpperCase()] = r;
  });

  return roomIds
    .filter(Boolean)
    .map((room) => {
      const ov = overrideMap[room.toUpperCase()];
      return {
        room,
        enabled: ov ? ov.enabled !== false : true,
        rtspUrl1: ov?.rtspUrl1 || "",
        rtspUrl2: ov?.rtspUrl2 || "",
      };
    })
    .filter((r) => r.enabled !== false);
}

// ── Step 3: slot/timetable context for a room ────────────────────────────────
// Delegates to the shared resolver so the cron run, the manual "run all rooms"
// trigger, and the developer lookup page always agree on which class is in a
// room. `config` carries extraClasses (alterations / extra classes).
async function resolveContext(room, slot, date, config = {}) {
  const { ctx, reason } = await resolveClassContext(room, slot, date, config);

  if (!ctx) {
    if (reason) console.log(`[AutoScheduler] ${reason} — skipping`);
    return null;
  }
  if (ctx.altered) {
    console.log(
      `[AutoScheduler] Extra-class override applied for room=${room} slot=${slot} date=${date} — subject=${ctx.subject} faculty=${ctx.faculty}`,
    );
  }
  return ctx;
}

// ── Step 4: embeddings + roster for the subject ──────────────────────────────
// The PKL is the batch's embedding store; the roster (Subject.enrolledRollNos)
// is what says which of those students actually sit in this period. Both are
// read from the same Subject document — see subjectRoster.js for why the
// roster has to travel with the request.
async function resolveSubjectAndPkl(subjectText, sem, dept, session) {
  // escapeRegex is not optional here: a subject like "FPGA(DE/GE)" used raw as
  // a $regex reads "(DE/GE)" as a capture group, so the pattern matches
  // "FPGADE/GE" and never the subject's own name. That returned null and the
  // room was skipped as "No Subject.embeddingFile set" — blaming the embedding
  // file for a lookup that never found the subject at all.
  const subj = await Subject.findOne({
    subjectFullName: { $regex: escapeRegex((subjectText || "").trim()), $options: "i" },
    sem,
  }).lean();

  if (!subj) {
    return {
      subjectMeta: null,
      roster: [],
      pkl: null,
      pklMissingReason:
        `No Subject matches subjectFullName "${subjectText}" with sem "${sem}" — ` +
        `check the Subject exists and its sem matches the timetable exactly`,
    };
  }

  const subjectMeta = {
    subName: subj.subName || "",
    subCode: subj.subCode || "",
    subjectFullName: subj.subjectFullName || "",
    credits: subj.credits ?? null,
  };

  const roster = rosterFromSubject(subj);
  if (roster.length === 0) {
    console.warn(
      `[AutoScheduler] Subject "${subj.subjectFullName || subjectText}" (sem ${sem}) has no enrolledRollNos — ` +
        `falling back to every student in the batch's embedding store; present/absent will cover the whole batch.`,
    );
  }

  if (!subj.embeddingFile) {
    return {
      subjectMeta,
      roster,
      pkl: null,
      pklMissingReason:
        `Subject "${subj.subjectFullName}" has no embeddingFile — generate embeddings for it`,
    };
  }

  const { path: fullPath, reason } = resolveEmbeddingFile({
    session: session || currentSession(),
    dept: dept || subj.dept,
    filename: subj.embeddingFile,
  });
  if (!fullPath) {
    return { subjectMeta, roster, pkl: null, pklMissingReason: reason };
  }

  try {
    const pklData = fs.readFileSync(fullPath).toString("base64");
    return { subjectMeta, roster, pkl: { filename: subj.embeddingFile, pklData } };
  } catch (err) {
    return {
      subjectMeta,
      roster,
      pkl: null,
      pklMissingReason: `Failed to read PKL: ${err.message}`,
    };
  }
}

// ── Cameras for a room (Camera Registry + optional override) ────────────────
async function resolveCameras(room, roomOverride) {
  if (roomOverride?.rtspUrl1) {
    return {
      cam1: roomOverride.rtspUrl1,
      cam2: roomOverride.rtspUrl2 || "",
      source: "override",
    };
  }
  const cams = await Camera.find({
    roomId: room.toUpperCase(),
    isActive: true,
  }).lean();
  const front = cams.find((c) => c.position === "front-left");
  const back = cams.find((c) => c.position === "front-right");
  return {
    cam1: front?.streamUrl || "",
    cam2: back?.streamUrl || "",
    source: "cameraDb",
  };
}

// ── Merge per-student status across runs ─────────────────────────────────────
// No "Review" outcome — a student present in at least minRunsPresent of the
// runs made so far is Present; otherwise Absent. minRunsPresent defaults to 1
// (i.e. "any run"), matching the pre-existing behavior when unset.
function mergeStudentStatus(slotResults, minRunsPresent = 1) {
  const rollMap = {};
  for (const sr of slotResults) {
    for (const s of sr.students) {
      (rollMap[s.rollNo] ||= []).push(s);
    }
  }
  return Object.entries(rollMap).map(([rollNo, entries]) => {
    const best = entries.reduce(
      (p, c) => (c.avgConfidence > p.avgConfidence ? c : p),
      entries[0],
    );
    const presentCount = entries.filter((e) => e.status === "present").length;

    const finalStatus = presentCount >= minRunsPresent ? "P" : "A";
    // Model's original call, captured at merge time — updateStudentStatus()
    // (manual/ERP override) only ever touches finalStatus, so this stays the
    // pre-override value for later before/after comparisons.
    return { rollNo, ...best, finalStatus, autoFinalStatus: finalStatus };
  });
}

// Counts cover the subject's roster only. A student the model recognised who
// is not enrolled in this subject stays in finalReport (flagged) but must not
// move present/absent — that is exactly what made these numbers drift.
function buildSummary(finalReport) {
  const members = rosterMembers(finalReport);
  const total = members.length;
  const present = members.filter((s) => s.finalStatus === "P").length;
  const absent = members.filter((s) => s.finalStatus === "A").length;
  const review = members.filter((s) => s.finalStatus === "R").length;
  return {
    totalStudents: total,
    present,
    absent,
    review,
    attendancePct: total > 0 ? Math.round((present / total) * 100) : 0,
    unknownFaceCount: 0,
  };
}

// ── Save one check's result into the slot's AttendanceReport ────────────────
async function saveCheckResult({
  ctx,
  subjectMeta,
  roster = [],
  date,
  slot,
  checkIndex,
  mlResult,
  room,
  alertConfidence = 0.6,
  minRunsPresent = 1,
}) {
  try {
    saveFrameSnapshots(mlResult.frame_files || []);
  } catch (snapErr) {
    console.warn(
      "[AutoScheduler] Could not save frame snapshots:",
      snapErr.message,
    );
  }

  const attendance = mlResult.attendance || {};
  const rosterSet = new Set(roster);
  const students = Object.entries(attendance).map(([rollNo, data]) => ({
    rollNo,
    status: data.status || "absent",
    avgConfidence: data.avg_confidence || 0,
    confidenceZone: data.confidence_zone || "low",
    firstSeenSec: data.first_seen_sec || null,
    clusterFolder: null,
    finalStatus:
      data.status === "present" ? "P" : data.status === "review" ? "R" : "A",
    ...membership(rollNo, data, rosterSet),
  }));

  const slotResult = {
    slot: `${slot}-check${checkIndex}`,
    videoLink: "",
    frameSnapshot: mlResult.snapshot_folder || "",
    processedAt: new Date(),
    students,
    summary: {
      present: mlResult.summary?.present || 0,
      absent: mlResult.summary?.absent || 0,
      review: mlResult.summary?.review || 0,
      total: students.length,
      processingTimeSec: mlResult.summary?.processing_time || 0,
    },
    matchingComparison: mlResult.matching_comparison || null,
    faissComparison: mlResult.faiss_comparison || null,
    adafaceComparison: mlResult.adaface_comparison || null,
    meanComparison: mlResult.mean_comparison || null,
    primaryModel: mlResult.metadata?.primary_model || "mean",
    primaryFallback: !!mlResult.metadata?.primary_fallback,
  };

  let report = await AttendanceReport.findOne({
    batch: ctx.batch,
    date,
    timeSlot: slot,
  });
  if (report) {
    report.slotResults.push(slotResult);
  } else {
    report = new AttendanceReport({
      batch: ctx.batch,
      department: ctx.dept,
      semester: ctx.sem,
      subject: ctx.subject,
      faculty: ctx.faculty,
      room,
      date,
      timeSlot: slot,
      locksemId: ctx.locksemId || null,
      subjectMeta: subjectMeta || undefined,
      slotResults: [slotResult],
      status: "draft",
    });
  }
  if (subjectMeta) report.subjectMeta = subjectMeta;

  // Merge across runs, then pin the result to the subject's roster: roster
  // students the model never saw become Absent, and anyone else it recognised
  // is kept but flagged out of the counts.
  report.finalReport = reconcileFinalReport(
    mergeStudentStatus(report.slotResults, minRunsPresent),
    roster,
  );

  for (const s of rosterMembers(report.finalReport)) {
    if (
      s.confidenceZone === "low" ||
      (s.avgConfidence || 0) < alertConfidence
    ) {
      alertNotifier
        .notifyLowConfidence({
          batch: ctx.batch,
          rollNo: s.rollNo,
          avgConfidence: s.avgConfidence || 0,
          dept: ctx.dept,
        })
        .catch((err) =>
          console.error("[AutoScheduler] alert failed:", err.message),
        );
    }
  }

  const presentRolls = rosterMembers(report.finalReport)
    .filter((s) => s.finalStatus === "P")
    .map((s) => s.rollNo);
  if (presentRolls.length > 0) {
    const otherReports = await AttendanceReport.find({
      date,
      timeSlot: slot,
      batch: { $ne: ctx.batch },
      "finalReport.rollNo": { $in: presentRolls },
      "finalReport.finalStatus": "P",
    });
    for (const rollNo of presentRolls) {
      const dupReports = otherReports.filter((r) =>
        r.finalReport.some((s) => s.rollNo === rollNo && s.finalStatus === "P"),
      );
      if (dupReports.length > 0) {
        const sessions = [
          { batch: ctx.batch, timeSlot: slot, room },
          ...dupReports.map((r) => ({
            batch: r.batch,
            timeSlot: r.timeSlot,
            room: r.room,
          })),
        ];
        try {
          await alertNotifier.notifyDuplicateAttendance({
            rollNo,
            date,
            sessions,
          });
        } catch (err) {
          console.error("[AutoScheduler] dup alert failed:", err.message);
        }
      }
    }
  }

  const currentUnknownCount = report.summary?.unknownFaceCount || 0;
  report.summary = buildSummary(report.finalReport);
  report.summary.unknownFaceCount = currentUnknownCount;

  await report.save();

  // Push the just-recomputed finalReport (roll no + finalStatus) to ERP —
  // fires after every completed run, not just at finalize. Never throws;
  // failures are recorded on report.erpPush and picked up by the retry sweep.
  await pushAttendanceToErp(report);

  saveAttendanceDailyData(
    {
      batch: ctx.batch,
      date,
      slot,
      room,
      subject: ctx.subject,
      faculty: ctx.faculty,
      semester: ctx.sem,
      locksemId: ctx.locksemId,
    },
    mlResult,
    checkIndex,
  );

  const unmatched = mlResult.unmatched_clusters || [];
  if (unmatched.length > 0) {
    console.warn(
      `[AutoScheduler] ⚠️ UNMATCHED FACES in check ${checkIndex} for ${ctx.batch} ${slot}: ${unmatched.length}`,
    );
    saveUnknownFaces(
      unmatched,
      {
        batch: ctx.batch,
        date,
        slot,
        room,
        subject: ctx.subject,
        faculty: ctx.faculty,
        semester: ctx.sem,
      },
      report._id.toString(),
    );
  }

  console.log(
    `[AutoScheduler] ✅ Check ${checkIndex} saved — ${ctx.batch} ${slot} — P:${slotResult.summary.present} A:${slotResult.summary.absent} R:${slotResult.summary.review}`,
  );
  return report;
}

// ── Step 5: one acquisition call to Python (stateless PKL bytes) ────────────
async function runOneCheck({
  room,
  slot,
  date,
  ctx,
  subjectMeta,
  roster = [],
  cameras,
  pkl,
  runConfig,
  checkIndex,
}) {
  try {
    const payload = {
      rtspUrl: cameras.cam1,
      rtspUrl2: cameras.cam2 || "",
      batch: ctx.batch,
      room,
      slot,
      date,
      durationSec: runConfig.runDurationSec,
      subject: ctx.subject,
      faculty: ctx.faculty,
      semester: ctx.sem,
      locksemId: ctx.locksemId,
      // The subject's own roll numbers. Without this the ML service scopes
      // the run to whoever is in the batch's embedding store — every student
      // in the year, not this class (see subjectRoster.js).
      enrolledRollNos: roster,
      embeddingsPklData: pkl.pklData, // stateless — see resolveSubjectAndPkl; decoded
      // Python-side as a fallback enrollment source
      // when enrolledEmbeddings is empty (see rtsp_routes.py)
      autoThreshold: runConfig.auto_present_threshold,
      reviewThreshold: runConfig.review_threshold,
      cameraSwitchSec: runConfig.camera_switch_sec,
      // All enrolled dicts ship on EVERY run — which model uses them is
      // decided Python-side by state.pipeline_config (Model Pipeline card),
      // and Node can't know which primary is selected there. ~100-200KB per
      // 60 students — trivial.
      enrolledEmbeddings: buildEnrolledEmbeddings(GROUND_TRUTH_DIR, ctx.batch),
      enrolledEmbeddingsTopK: buildEnrolledEmbeddingsTopK(
        GROUND_TRUTH_DIR,
        ctx.batch,
      ),
      enrolledEmbeddingsAdaface: buildEnrolledEmbeddingsAdaface(
        GROUND_TRUTH_DIR,
        ctx.batch,
      ),
      enrolledEmbeddingsAdafaceTopK: buildEnrolledEmbeddingsAdafaceTopK(
        GROUND_TRUTH_DIR,
        ctx.batch,
      ),
    };
    // Shadow comparisons fire only on the one check nearest the middle of
    // this period — which models actually run is decided Python-side by the
    // pipeline_config shadow toggles.
    if (checkIndex === runConfig.middleRunIndex) {
      payload.runShadows = true;
    }

    const res = await axios.post(
      `${ML_URL}/run-attendance-rtsp-sync`,
      payload,
      { timeout: 300000 },
    );

    await saveCheckResult({
      ctx,
      subjectMeta,
      roster,
      date,
      slot,
      checkIndex,
      mlResult: res.data,
      room,
      alertConfidence: runConfig.alertConfidence,
      minRunsPresent: runConfig.minRunsPresent,
    });
  } catch (err) {
    console.error(
      `[AutoScheduler] Check ${checkIndex} failed for ${slot} room ${room}: ${err.message}`,
    );
  }
}

// ── Run all checks for one room+slot — steps 2–5 for that room ──────────────
async function runSlotAttendance({
  room,
  roomOverride,
  slot,
  date,
  periodInfo,
  config,
}) {
  console.log(
    `[AutoScheduler] Starting slot=${slot} room=${room} date=${date}`,
  );

  // Step 3: slot data
  const ctx = await resolveContext(room, slot, date, config);
  if (!ctx) {
    console.warn(
      `[AutoScheduler] No timetable context for room=${room} slot=${slot} — skipping`,
    );
    return;
  }

  // Step 4: embeddings for the subject
  const { subjectMeta, roster, pkl, pklMissingReason } = await resolveSubjectAndPkl(
    ctx.subject,
    ctx.sem,
    ctx.dept,
    ctx.session,
  );
  if (!pkl) {
    console.warn(
      `[AutoScheduler] Skipping room=${room} slot=${slot} — ${pklMissingReason}`,
    );
    return;
  }

  const cameras = await resolveCameras(room, roomOverride);
  if (!cameras.cam1) {
    console.warn(
      `[AutoScheduler] No active camera for room=${room} — skipping`,
    );
    return;
  }

  const numRuns = config.globalNumRuns ?? 1;
  const runDurationSec = config.globalRunDurationSec ?? 120;
  // Space the runs over the time *left* in the period, not its nominal length —
  // on a mid-period catch-up the two differ, and using the nominal length would
  // push the last runs past the end of the class.
  const minutesLeft = Math.max(
    1,
    periodInfo.endMin - Math.max(nowMin(), periodInfo.startMin),
  );
  const checkIntervalMin =
    numRuns > 1 ? Math.max(1, Math.floor(minutesLeft / numRuns)) : 0;

  const t = config.attendanceThresholds || {};
  // Clamp to numRuns — a stale/higher setting can't require more runs than
  // will actually happen this period.
  const minRunsPresent = Math.min(config.globalMinRunsPresent ?? 1, numRuns);
  const runConfig = {
    runDurationSec,
    auto_present_threshold: t.auto_present_threshold ?? 0.6,
    review_threshold: t.review_threshold ?? 0.4,
    alertConfidence: t.alert_confidence ?? 0.6,
    camera_switch_sec: t.camera_switch_sec ?? 30,
    minRunsPresent,
    // Max-of-K shadow comparison (diagnostic only) fires once per period —
    // on the check nearest the middle of the numRuns checks — not every run.
    middleRunIndex: Math.ceil(numRuns / 2),
  };

  for (let i = 1; i <= numRuns; i++) {
    if (i > 1) {
      console.log(
        `[AutoScheduler] Waiting ${checkIntervalMin} min before check ${i}/${numRuns} (room=${room})`,
      );
      await new Promise((r) => setTimeout(r, checkIntervalMin * 60 * 1000));
    }
    await runOneCheck({
      room,
      slot,
      date,
      ctx,
      subjectMeta,
      roster,
      cameras,
      pkl,
      runConfig,
      checkIndex: i,
    });
  }

  console.log(
    `[AutoScheduler] Slot ${slot} room ${room} — all ${numRuns} checks done`,
  );

  // The period is over for this room — mail the faculty their attendance.
  // Gated by the Email Notifications toggles and idempotent, so the manual
  // "stop session" path ending the same period cannot double-send.
  try {
    const report = await AttendanceReport.findOne({
      batch: ctx.batch,
      date,
      timeSlot: slot,
    });
    if (report) {
      const outcome = await sendFacultyAttendanceSummary(report);
      if (!outcome.sent) {
        console.log(
          `[AutoScheduler] Faculty summary not sent for ${slot} room ${room}: ${outcome.reason}`,
        );
      }
    }
  } catch (err) {
    console.error("[AutoScheduler] Faculty summary failed:", err.message);
  }
}

// ── Missed/bunked class check, ~5 min after a slot ends ──────────────────────
async function checkMissedClasses(slotKey, date, config) {
  try {
    const enabledRooms = await getEnabledRooms(config);
    if (!enabledRooms.length) return;

    for (const { room } of enabledRooms) {
      const ctx = await resolveContext(room, slotKey, date, config);
      if (!ctx) continue;

      const report = await AttendanceReport.findOne({
        batch: ctx.batch,
        date,
        timeSlot: slotKey,
      });

      if (!report) {
        try {
          await alertNotifier.notifyNoReportSaved({
            batch: ctx.batch,
            subject: ctx.subject,
            faculty: ctx.faculty,
            room,
            date,
            timeSlot: slotKey,
            dept: ctx.dept,
          });
        } catch (err) {
          console.error(
            "[ClassBunkCheck] no-report alert failed:",
            err.message,
          );
        }
      } else {
        const allAbsent =
          (report.summary.present || 0) === 0 &&
          (report.summary.review || 0) === 0;
        const hasStudents = (report.finalReport || []).length > 0;
        if (allAbsent && hasStudents) {
          try {
            await alertNotifier.notifyClassBunk({
              batch: ctx.batch,
              subject: ctx.subject,
              faculty: ctx.faculty,
              room,
              date,
              timeSlot: slotKey,
              dept: ctx.dept,
              totalStudents: report.finalReport.length,
            });
          } catch (err) {
            console.error("[ClassBunkCheck] bunk alert failed:", err.message);
          }
        }
      }
    }
  } catch (err) {
    console.error("[ClassBunkCheck] error:", err.message);
  }
}

// ── Main scheduler — fires every minute, fully DB-driven ────────────────────
function startAutoScheduler() {
  console.log(
    "[AutoScheduler] Starting — running cron every minute (DB-driven: rooms, periods, embeddings)",
  );

  let triggeredToday = new Set();
  let triggeredForDate = null;

  // Every tick that decides "nothing to do" used to return silently, so a
  // scheduler that was switched off, holidayed out, or looking at periods that
  // had all already fired was indistinguishable from one that had crashed —
  // the log was empty either way. Log the reason, but only when it changes, so
  // a whole idle day costs one line per distinct cause rather than 1440.
  let lastSkip = null;
  const skip = (reason) => {
    if (lastSkip !== reason) {
      lastSkip = reason;
      console.log(`[AutoScheduler] Idle — ${reason}`);
    }
  };
  const active = (msg) => {
    lastSkip = null;
    if (msg) console.log(`[AutoScheduler] ${msg}`);
  };

  cron.schedule("* * * * *", async () => {
    const date = todayStr();
    const curMin = nowMin();

    // Reset on date change rather than on the tick that lands exactly at
    // 00:00 — a single missed or delayed tick used to keep yesterday's keys
    // forever, which silently suppressed every period the next day.
    if (triggeredForDate !== date) {
      triggeredToday = new Set();
      triggeredForDate = date;
    }

    let config;
    try {
      config = await AcquisitionControl.findOne({
        profileName: "default",
      }).lean();
    } catch (err) {
      console.error(
        "[AutoScheduler] Failed to load AcquisitionControl config:",
        err.message,
      );
      return;
    }
    if (!config) {
      skip('no AcquisitionControl profile named "default" exists');
      return;
    }

    // Step 2: working day check (global on/off + stopped days + allotment non-working days)
    if (!config.active) {
      skip("AcquisitionControl.active is false (acquisition switched off)");
      return;
    }
    if ((config.stoppedDays || []).includes(date)) {
      skip(`${date} is in AcquisitionControl.stoppedDays`);
      return;
    }

    // Optional 08:30–17:30 IST restriction (admin toggle, default off). Only
    // bites when the toggle is ON; when OFF, runs fire at any time as before.
    const runGate = await checkAttendanceRunAllowed();
    if (!runGate.allowed) {
      skip(runGate.reason);
      return;
    }
    const allotmentEntry = await Allotment.findOne({
      "nonWorkingDays.date": date,
    })
      .lean()
      .catch(() => null);
    if (allotmentEntry) {
      const nwd = allotmentEntry.nonWorkingDays.find((d) => d.date === date);
      skip(
        `${date} is a non-working day in Allotment: ${nwd?.remark || "Holiday"}`,
      );
      return;
    }

    const periods = config.periods || [];
    if (periods.length === 0) {
      skip("AcquisitionControl.periods is empty — no period times configured");
      return;
    }
    if (!periods.some((p) => p.enabled)) {
      skip(`all ${periods.length} configured period(s) have enabled=false`);
      return;
    }

    // Why this minute produced no run, when a period exists but none matched.
    const notes = [];

    for (const period of periods) {
      if (!period.enabled) continue;
      const startMin = timeStrToMin(period.startTime);
      const endMin = timeStrToMin(period.endTime);
      if (startMin == null || endMin == null) {
        notes.push(
          `${period.periodKey}: unparseable startTime/endTime ("${period.startTime}"–"${period.endTime}")`,
        );
        continue;
      }

      // Fire once per period. Normally that's at the period's start minute,
      // but we also catch up if we are already inside the period and have not
      // run it yet — that's the case when acquisition is switched on (or the
      // server restarts) part-way through a class. Requires enough of the
      // period left to complete one run, so we never start a run that would
      // outlast the class.
      const runDurationMin = Math.ceil((config.globalRunDurationSec ?? 120) / 60);
      const insideWithTimeLeft =
        curMin > startMin && curMin + runDurationMin <= endMin;

      if ((curMin >= startMin && curMin <= startMin + 1) || insideWithTimeLeft) {
        const key = `${date}_${period.periodKey}`;
        if (triggeredToday.has(key)) {
          notes.push(`${period.periodKey}: already fired today`);
          continue;
        }

        // Step 1: rooms from DB — resolved *before* the period is marked as
        // fired. With no enabled room there is nothing to run, and marking it
        // would burn the period for the rest of the day, so a camera enabled
        // mid-class could never be picked up.
        const enabledRooms = await getEnabledRooms(config);
        if (enabledRooms.length === 0) {
          skip(
            `${period.periodKey} is live but no enabled room resolved — ` +
              `Camera registry has no active camera, or every room is disabled in AcquisitionControl.includedRooms`,
          );
          continue;
        }

        triggeredToday.add(key);
        active();

        if (curMin > startMin + 1) {
          console.log(
            `[AutoScheduler] Catching up ${period.periodKey} — ${endMin - curMin} min left in the period`,
          );
        }

        const overrideMap = {};
        (config.includedRooms || []).forEach((r) => {
          if (r.room) overrideMap[r.room.toUpperCase()] = r;
        });

        console.log(
          `[AutoScheduler] Period ${period.periodKey} starting — firing ${enabledRooms.length} room(s) in parallel`,
        );

        // Step 5: acquire — all enabled rooms in parallel.
        // allSettled never rejects, so the old .catch() here could not fire and
        // every per-room throw was discarded unlogged — with the period already
        // marked as fired, that looked exactly like a scheduler that never ran.
        // Report each rejection instead.
        const roomsToRun = enabledRooms.map(({ room }) => room);
        Promise.allSettled(
          roomsToRun.map((room) =>
            runSlotAttendance({
              room,
              roomOverride: overrideMap[room.toUpperCase()],
              slot: period.periodKey,
              date,
              periodInfo: { startMin, endMin },
              config,
            }),
          ),
        ).then((results) => {
          results.forEach((r, i) => {
            if (r.status === "rejected") {
              console.error(
                `[AutoScheduler] Room ${roomsToRun[i]} threw during ${period.periodKey}:`,
                r.reason?.stack || r.reason?.message || r.reason,
              );
            }
          });
        });
      } else if (curMin > endMin) {
        notes.push(`${period.periodKey}: over (ended ${period.endTime})`);
      } else if (curMin > startMin) {
        notes.push(
          `${period.periodKey}: in progress but under ${runDurationMin} min left — too late to start a run`,
        );
      } else {
        notes.push(`${period.periodKey}: not started (starts ${period.startTime})`);
      }

      // Missed-class check ~5 min after period ends
      if (curMin === endMin + 5) {
        checkMissedClasses(period.periodKey, date, config).catch((err) =>
          console.error(`[ClassBunkCheck] Error: ${err.message}`),
        );
      }
    }

    // Nothing fired this minute and every enabled period said why. The notes
    // are deliberately free of the current time so the state only prints when
    // it actually changes, not once a minute.
    if (notes.length === periods.filter((p) => p.enabled).length) {
      skip(notes.join("; "));
    }
  });
}

module.exports = {
  startAutoScheduler,
  runSlotAttendance,
  checkMissedClasses,
  saveCheckResult,
  // Exposed for unit tests
  timeStrToMin,
  safeSubject,
  currentSession,
};
