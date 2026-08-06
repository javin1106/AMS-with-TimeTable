// server/src/modules/attendanceModule/controllers/schedulerController.js
//
// Manual "Run All Rooms" trigger — mirrors autoAttendanceScheduler.js's per-room
// flow but runs every enabled room for a chosen slot in parallel (Promise.allSettled)
// and returns a full per-room status array instead of running silently via cron.

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const AcquisitionControl = require('../../../models/acquisitionControl');
const Allotment = require('../../../models/allotment');
const Camera = require('../../../models/attendanceModule/camera');
const Subject = require('../../../models/subject');
const AttendanceReport = require('../../../models/attendanceReport');
const {
  buildEnrolledEmbeddings,
  buildEnrolledEmbeddingsTopK,
  buildEnrolledEmbeddingsAdaface,
  buildEnrolledEmbeddingsAdafaceTopK,
} = require('./embeddingSyncHelper');
const { checkAttendanceRunAllowed, nowMinIST, todayIST } = require('./timeWindowGuard');
const { resolveClassContext } = require('./classContextResolver');

const ML_URL = process.env.ML_SERVICE_URL || 'http://localhost:8500';
const EMBEDDINGS_DIR = path.join(__dirname, '..', '..', '..', '..', 'ml-data', 'embeddings');
const GROUND_TRUTH_DIR = path.join(__dirname, '..', '..', '..', '..', 'ml-data', 'ground_truth');

// Campus wall-clock date (IST), not UTC. `toISOString()` names the previous
// day between 00:00 and 05:30 IST, so a dashboard using it looked for reports
// under yesterday's date while autoAttendanceScheduler (which uses todayIST)
// wrote them under today's — the card then showed "Waiting" for a period that
// had already run.
function todayStr() {
  return todayIST();
}

function safeSubject(raw) {
  return (raw || '').trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/, '');
}

function currentSession() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const start = month >= 8 ? year : year - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}

// Merge per-student status across multiple ML runs. A student is Present if
// detected as present in at least minRunsPresent of the runs (out of the
// total runs actually completed). Returns { attendance, summary }.
function mergeRunResults(runResults, minRunsPresent) {
  const rollMap = {};
  for (const r of runResults) {
    for (const [rollNo, data] of Object.entries(r.attendance || {})) {
      (rollMap[rollNo] ||= []).push(data);
    }
  }
  const mlResult = {
    attendance: Object.fromEntries(
      Object.entries(rollMap).map(([rollNo, entries]) => {
        const presentCount = entries.filter((e) => e.status === 'present').length;
        const isPresent = presentCount >= minRunsPresent;
        const best = entries.reduce((p, c) => (c.avg_confidence > p.avg_confidence ? c : p), entries[0]);
        return [rollNo, { ...best, status: isPresent ? 'present' : (entries.some(e => e.status === 'review') ? 'review' : 'absent') }];
      }),
    ),
    summary: {
      present: 0, absent: 0, review: 0, // recomputed below from merged attendance
    },
  };
  mlResult.summary.present = Object.values(mlResult.attendance).filter((s) => s.status === 'present').length;
  mlResult.summary.absent  = Object.values(mlResult.attendance).filter((s) => s.status === 'absent').length;
  mlResult.summary.review  = Object.values(mlResult.attendance).filter((s) => s.status === 'review').length;
  return mlResult;
}

function timeStrToMin(t) {
  if (!t) return 0;
  const [h, m] = (t || '').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// ── Step: resolve slot context for a room ──────────────────────────────────
// Shared with the cron scheduler and the developer lookup page — see
// classContextResolver.js. Returns null when nothing should run; callers that
// want the "why" can call resolveClassContext directly.
async function resolveRoomContext(room, slot, date, config) {
  const { ctx } = await resolveClassContext(room, slot, date, config);
  return ctx;
}

// ── Step: resolve cameras for a room ──────────────────────────────────────
async function resolveCameras(room, roomOverride) {
  if (roomOverride?.rtspUrl1) {
    return { cam1: roomOverride.rtspUrl1, cam2: roomOverride.rtspUrl2 || '', source: 'override' };
  }
  const cams = await Camera.find({ roomId: room.toUpperCase(), isActive: true }).lean();
  const front = cams.find((c) => c.position === 'front-left');
  const back = cams.find((c) => c.position === 'front-right');
  return {
    cam1: front?.streamUrl || '',
    cam2: back?.streamUrl || '',
    source: 'cameraDb',
    count: cams.length,
  };
}
// Rooms now come from the Camera registry (one row per roomId with an active
// camera) — AcquisitionControl's old room-management tab was removed, so
// config.includedRooms is no longer maintained by anyone. We keep reading
// includedRooms only as an *optional* per-room override (disable a room,
// or override its RTSP URL) layered on top of the Camera-sourced list.
async function getEnabledRooms(config) {
  const roomIds = await Camera.distinct('roomId', { isActive: true });
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
        rtspUrl1: ov?.rtspUrl1 || '',
        rtspUrl2: ov?.rtspUrl2 || '',
        note: ov?.note || '',
      };
    })
    .filter((r) => r.enabled !== false)
    .sort((a, b) => a.room.localeCompare(b.room));
}

// ── Step: resolve Subject doc + its pre-generated embedding PKL together ──
// Subject.embeddingFile is set once embeddings are generated for that
// subject (via the existing EmbeddingGeneration page) — that's the
// authoritative pointer. We read it directly rather than fuzzy-guessing a
// filename, and never touch ground_truth/ or roll numbers from here at all.
async function resolveSubjectAndPkl(subjectText, sem, dept, session) {
  const subj = await Subject.findOne({
    subjectFullName: { $regex: (subjectText || '').trim(), $options: 'i' },
    sem,
  }).lean();

  const subjectMeta = subj ? {
    subName: subj.subName || '',
    subCode: subj.subCode || '',
    subjectFullName: subj.subjectFullName || '',
    credits: subj.credits ?? null,
  } : null;

  if (!subj || !subj.embeddingFile) {
    return { subjectMeta, pkl: null };
  }

  const fs = require('fs');
  const deptSafe = safeSubject(dept || subj.dept || 'UNKNOWN');
  const sessionToUse = session || currentSession();
  const fullPath = path.join(EMBEDDINGS_DIR, sessionToUse, deptSafe, subj.embeddingFile);

  if (!fs.existsSync(fullPath)) {
    return { subjectMeta, pkl: null, pklMissingReason: `Subject.embeddingFile (${subj.embeddingFile}) not found on disk at expected path` };
  }

  let pklData;
  try {
    pklData = fs.readFileSync(fullPath).toString('base64');
  } catch (err) {
    return { subjectMeta, pkl: null, pklMissingReason: `Failed to read PKL: ${err.message}` };
  }

  return { subjectMeta, pkl: { filename: subj.embeddingFile, pklData } };
}

// ── Preflight checklist for the Live page ──────────────────────────────────
// The Live page used to show only the outcome ("Waiting for attendance run to
// start…") with no way to tell a period that hadn't started yet from one that
// could never start. These are the same five conditions autoAttendanceScheduler
// evaluates before it calls the ML service, in the same order, each reported
// with the values that were actually compared — so a failing check names the
// field to fix rather than just saying "skipped".
//
// Read-only and deliberately cheap: the PKL is stat'd, never read into memory
// (the live page polls every 15s), and the ML service is not contacted.
async function buildPreflight({ room, slot, date, config, cameraInfo, runsCompleted, resolved }) {
  const checks = [];
  const add = (key, label, ok, detail) => checks.push({ key, label, ok, detail });

  // 1. Timetable — is a class scheduled here at all? The caller has usually
  //    resolved this already; reuse it rather than repeating the LockSem
  //    aggregate for every room on every 15s poll.
  const { ctx, reason, day, ambiguous } =
    resolved || (await resolveClassContext(room, slot, date, config));
  if (!ctx) {
    add('class', 'Class scheduled', false, reason || `No class for ${room} in ${slot} on ${day}`);
    return { ctx: null, checks };
  }
  add(
    'class',
    'Class scheduled',
    true,
    `${ctx.subject} · ${ctx.batch}${ctx.sem ? ` · Sem ${ctx.sem}` : ''} (${ctx.source})` +
      (ambiguous ? ' — WARNING: more than one timetable claims this slot' : ''),
  );

  // 2. Subject — matched on name AND semester. A sem mismatch between the
  //    timetable row and the Subject document is the most common silent skip,
  //    so both values are named when it fails.
  const subj = await Subject.findOne({
    subjectFullName: { $regex: (ctx.subject || '').trim(), $options: 'i' },
    sem: ctx.sem,
  }).lean();

  if (!subj) {
    const byNameOnly = await Subject.findOne({
      subjectFullName: { $regex: (ctx.subject || '').trim(), $options: 'i' },
    }).lean();
    add(
      'subject',
      'Subject matched',
      false,
      byNameOnly
        ? `Semester mismatch — timetable says sem "${ctx.sem}", Subject "${byNameOnly.subjectFullName}" is sem "${byNameOnly.sem}"`
        : `No Subject whose subjectFullName matches "${ctx.subject}"`,
    );
    return { ctx, checks };
  }
  add('subject', 'Subject matched', true, `${subj.subjectFullName}${subj.subCode ? ` (${subj.subCode})` : ''}`);
  add('sem', 'Semester matched', true, `sem ${subj.sem} — matches the timetable`);

  // 3. Roster — empty is not fatal, but it silently widens the run to the
  //    whole batch, so it is surfaced as a warning-shaped pass.
  const rollCount = (subj.enrolledRollNos || []).length;
  add(
    'roster',
    'Roster loaded',
    true,
    rollCount > 0
      ? `${rollCount} enrolled roll number(s)`
      : 'No enrolledRollNos — the run will cover the whole batch’s embedding store',
  );

  // 4. Embeddings — the pointer must be set AND the file must be on disk.
  if (!subj.embeddingFile) {
    add('embeddings', 'Embedding file found', false,
      'Subject.embeddingFile is not set — generate embeddings for this subject');
    return { ctx, checks };
  }
  const pklPath = path.join(
    EMBEDDINGS_DIR,
    ctx.session || currentSession(),
    safeSubject(ctx.dept || subj.dept || 'UNKNOWN'),
    subj.embeddingFile,
  );
  let stat = null;
  try { stat = fs.statSync(pklPath); } catch { /* missing — reported below */ }
  if (!stat) {
    add('embeddings', 'Embedding file found', false, `${subj.embeddingFile} not on disk at ${pklPath}`);
    return { ctx, checks };
  }
  add('embeddings', 'Embedding file found', true,
    `${subj.embeddingFile} (${Math.round(stat.size / 1024)} KB)`);

  // 5. Camera — resolveCameras needs a "front-left" camera (or an RTSP
  //    override) for cam1; anything else and the scheduler skips the room.
  const roomOverride = (config.includedRooms || []).find(
    (r) => r.room && r.room.toUpperCase() === room.toUpperCase(),
  );
  const cams = await resolveCameras(room, roomOverride);
  if (!cams.cam1) {
    add('camera', 'Camera ready', false,
      cameraInfo?.total ? `${cameraInfo.total} active camera(s) but none at position "front-left"`
                        : 'No active camera registered for this room');
    return { ctx, checks };
  }
  add('camera', 'Camera ready', true,
    `cam1 via ${cams.source === 'override' ? 'RTSP override' : 'camera registry'}` +
      (cameraInfo?.status === 'offline' ? ' — but the camera is offline' : '') +
      (cams.cam2 ? ' · cam2 present' : ''));

  // 6. Outcome.
  add('running', 'Attendance running', runsCompleted > 0,
    runsCompleted > 0 ? `${runsCompleted} run(s) recorded`
                      : 'No run recorded yet for this period');

  return { ctx, checks };
}



// ── Run one room end-to-end ────────────────────────────────────────────────
async function runRoom({ room, roomOverride, slot, date, config }) {
  const log = [];
  const push = (msg) => log.push({ t: Date.now(), msg });

  // 1. Working day check
  if (!config.active) {
    return { room, status: 'skipped', reason: 'Acquisition Off (global)', log };
  }
  if ((config.stoppedDays || []).includes(date)) {
    return { room, status: 'skipped', reason: 'Stopped Day', log };
  }
  const allotmentEntry = await Allotment.findOne({ 'nonWorkingDays.date': date }).lean();
  if (allotmentEntry) {
    const nwd = allotmentEntry.nonWorkingDays.find(d => d.date === date);
    return { room, status: 'skipped', reason: `Non-working day: ${nwd?.remark || 'Holiday'}`, log };
  }
  if (roomOverride && roomOverride.enabled === false) {
    return { room, status: 'skipped', reason: 'Room disabled', log };
  }

  push('Working day check passed');

  // 2. Slot data
  const { ctx, reason: ctxReason, day } = await resolveClassContext(room, slot, date, config);
  if (!ctx) {
    return { room, status: 'skipped', reason: ctxReason || 'No Class Scheduled', log };
  }
  push(`Class resolved (${day}): ${ctx.batch} — ${ctx.subject} (${ctx.source})`);
  if (ctx.altered) {
    push(`Alteration applied: was "${ctx.originalSubject}" / ${ctx.originalFaculty}`);
  }

  // 3. Cameras
  const cameras = await resolveCameras(room, roomOverride);
  if (!cameras.cam1) {
    push('⚠ No active camera found — proceeding anyway (will likely fail at ML step)');
  } else {
    push(`Camera resolved (${cameras.source}): cam1=${!!cameras.cam1} cam2=${!!cameras.cam2}`);
  }

  // 4. Embedding check
 // 4. Subject + embeddings (one lookup gives us both)
  const { subjectMeta, pkl, pklMissingReason } = await resolveSubjectAndPkl(ctx.subject, ctx.sem, ctx.dept, ctx.session);
  if (!pkl) {
    return {
      room, status: 'skipped',
      reason: pklMissingReason || 'No Embeddings for Subject — generate embeddings for this subject first',
      ctx, cameras, log,
    };
  }
  push(`Embeddings found: ${pkl.filename}`);

 // 5. Run settings — use global params; interval computed from period timing (like auto-scheduler)
  const periodCfg = (config.periods || []).find((p) => p.periodKey === slot) || {};
  const numRuns = config.globalNumRuns ?? 1;
  const runDurationSec = config.globalRunDurationSec ?? 120;
  // Clamp to numRuns — a stale/higher setting can't require more runs than
  // will actually happen this period.
  const minRunsPresent = Math.min(config.globalMinRunsPresent ?? 1, numRuns);
  const startMin = timeStrToMin(periodCfg.startTime);
  const endMin   = timeStrToMin(periodCfg.endTime);
  const periodDurationMin = endMin > startMin ? endMin - startMin : 50;
  const checkIntervalMin = numRuns > 1 ? Math.max(1, Math.floor(periodDurationMin / numRuns)) : 0;

  // 6. Call Python ML service — numRuns times, checkIntervalMin apart
  push(`Plan: ${numRuns} run(s), ${runDurationSec}s each, ${checkIntervalMin}min apart, present if seen in >=${minRunsPresent}/${numRuns} runs`);
  // Shadow comparisons (diagnostic only) fire once per period — on the run
  // nearest the middle of the numRuns runs. Which models run (and which is
  // the PRIMARY decision-maker) is decided Python-side by
  // state.pipeline_config (Model Pipeline card, ML Fine Tuning page).
  const middleRunIndex = Math.ceil(numRuns / 2);
  // All enrolled dicts ship on every run — Node can't know which primary
  // Python's pipeline_config selects. Built once per room, reused per run.
  const enrolledDicts = {
    enrolledEmbeddings:            buildEnrolledEmbeddings(GROUND_TRUTH_DIR, ctx.batch),
    enrolledEmbeddingsTopK:        buildEnrolledEmbeddingsTopK(GROUND_TRUTH_DIR, ctx.batch),
    enrolledEmbeddingsAdaface:     buildEnrolledEmbeddingsAdaface(GROUND_TRUTH_DIR, ctx.batch),
    enrolledEmbeddingsAdafaceTopK: buildEnrolledEmbeddingsAdafaceTopK(GROUND_TRUTH_DIR, ctx.batch),
  };
  const runResults = [];
  let middleRunComparison = null;
  let middleRunFaissComparison = null;
  let middleRunAdafaceComparison = null;
  let middleRunMeanComparison = null;
  let runPrimaryModel = null;
  let runPrimaryFallback = false;
  for (let i = 1; i <= numRuns; i++) {
    if (i > 1) {
      push(`Waiting ${checkIntervalMin} min before run ${i}/${numRuns}`);
      await new Promise((r) => setTimeout(r, checkIntervalMin * 60 * 1000));
    }
    push(`Starting run ${i}/${numRuns}`);
    try {
      const payload = {
        rtspUrl: cameras.cam1,
        rtspUrl2: cameras.cam2 || '',
        batch: ctx.batch,
        room, slot, date,
        durationSec: runDurationSec,
        subject: ctx.subject,
        faculty: ctx.faculty,
        semester: ctx.sem,
        locksemId: ctx.locksemId,
        embeddingsPklData: pkl.pklData,
        cameraSwitchSec: config.attendanceThresholds?.camera_switch_sec ?? 30,
        ...enrolledDicts,
      };
      if (i === middleRunIndex) {
        payload.runShadows = true;
      }
      const res = await axios.post(`${ML_URL}/run-attendance-rtsp-sync`, payload, { timeout: 300000 });
      runResults.push(res.data);
      runPrimaryModel = res.data.metadata?.primary_model || runPrimaryModel;
      runPrimaryFallback = runPrimaryFallback || !!res.data.metadata?.primary_fallback;
      if (i === middleRunIndex) {
        middleRunComparison = res.data.matching_comparison || null;
        middleRunFaissComparison = res.data.faiss_comparison || null;
        middleRunAdafaceComparison = res.data.adaface_comparison || null;
        middleRunMeanComparison = res.data.mean_comparison || null;
      }
      push(`Run ${i} done: P:${res.data.summary?.present} A:${res.data.summary?.absent} R:${res.data.summary?.review}`);
    } catch (err) {
      push(`Run ${i} failed: ${err.response?.data?.detail || err.message}`);
    }
  }

  if (!runResults.length) {
    return { room, status: 'error', reason: 'All ML runs failed', ctx, cameras, pkl, log };
  }

  // Merge per-student status across runs according to minRunsPresent
  const mlResult = mergeRunResults(runResults, minRunsPresent);


  // 8. Save report
  const attendance = mlResult.attendance || {};
  const students = Object.entries(attendance).map(([rollNo, data]) => ({
    rollNo,
    status: data.status || 'absent',
    avgConfidence: data.avg_confidence || 0,
    confidenceZone: data.confidence_zone || 'low',
    firstSeenSec: data.first_seen_sec || null,
    finalStatus: data.status === 'present' ? 'P' : data.status === 'review' ? 'R' : 'A',
  }));

  const slotResult = {
    slot,
    videoLink: '',
    processedAt: new Date(),
    students,
    summary: {
      present: mlResult.summary?.present || 0,
      absent: mlResult.summary?.absent || 0,
      review: mlResult.summary?.review || 0,
      total: students.length,
      processingTimeSec: mlResult.summary?.processing_time || 0,
    },
    matchingComparison: middleRunComparison,
    faissComparison: middleRunFaissComparison,
    adafaceComparison: middleRunAdafaceComparison,
    meanComparison: middleRunMeanComparison,
    primaryModel: runPrimaryModel || 'mean',
    primaryFallback: runPrimaryFallback,
  };

  let report = await AttendanceReport.findOne({ batch: ctx.batch, date, timeSlot: slot });
  if (report) {
    if (report.status === 'finalized') {
      return { room, status: 'error', reason: 'Report already finalized', ctx, log };
    }
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
      locksemId: ctx.locksemId,
      subjectMeta: subjectMeta || undefined,
      slotResults: [slotResult],
      status: 'draft',
    });
  }
  if (subjectMeta) report.subjectMeta = subjectMeta;
  report.finalReport = students.map((s) => ({ ...s }));
  report.summary = {
    totalStudents: students.length,
    present: students.filter((s) => s.finalStatus === 'P').length,
    absent: students.filter((s) => s.finalStatus === 'A').length,
    review: students.filter((s) => s.finalStatus === 'R').length,
    attendancePct: students.length
      ? Math.round((students.filter((s) => s.finalStatus === 'P').length / students.length) * 100)
      : 0,
  };
  await report.save();
  push('Report saved');

  return {
    room,
    status: 'done',
    ctx,
    cameras,
    pkl,
    subjectMeta,
    reportId: report._id,
    summary: report.summary,
    log,
  };
}

// ── POST /attendancemodule/scheduler/run-all ──────────────────────────────
// Body: { slot, date? }
exports.mergeRunResults = mergeRunResults;

exports.runAll = async (req, res) => {
  try {
    const { slot } = req.body;
    const date = req.body.date || todayStr();
    if (!slot) return res.status(400).json({ error: 'slot is required' });

    // Optional 08:30–17:30 IST restriction (admin toggle, default off).
    const runGate = await checkAttendanceRunAllowed();
    if (!runGate.allowed) return res.status(403).json({ error: runGate.reason });

    const config = await AcquisitionControl.findOne({ profileName: 'default' }).lean();
    if (!config) return res.status(404).json({ error: 'AcquisitionControl config not found' });

    const enabledRooms = await getEnabledRooms(config);
    if (!enabledRooms.length) {
      return res.status(400).json({
        error: 'No active cameras found in the Camera Registry. Add a camera for a room before running the scheduler.',
      });
    }

    const results = await Promise.allSettled(
      enabledRooms.map((roomOverride) =>
        runRoom({ room: roomOverride.room, roomOverride, slot, date, config })),
    );

    const rooms = results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { room: enabledRooms[i].room, status: 'error', reason: r.reason?.message || 'Unknown error' });

    const summary = {
      total: rooms.length,
      done: rooms.filter((r) => r.status === 'done').length,
      skipped: rooms.filter((r) => r.status === 'skipped').length,
      error: rooms.filter((r) => r.status === 'error').length,
    };

    res.json({ slot, date, summary, rooms });
  } catch (err) {
    console.error('[SchedulerController] runAll error:', err);
    res.status(500).json({ error: err.message });
  }
};

// ── GET /attendancemodule/scheduler/preview?slot=period1&date=2026-06-22 ──
// "Would-run" dry preview — does steps 1-4 only, no ML call, no save.
// Used when acquisition is globally off, or just to check before running.
exports.preview = async (req, res) => {
  try {
    const { slot } = req.query;
    const date = req.query.date || todayStr();
    if (!slot) return res.status(400).json({ error: 'slot is required' });

    const config = await AcquisitionControl.findOne({ profileName: 'default' }).lean();
    if (!config) return res.status(404).json({ error: 'AcquisitionControl config not found' });

    const enabledRooms = await getEnabledRooms(config);

    const isStopped = (config.stoppedDays || []).includes(date);
    const allotEntry = await Allotment.findOne({ 'nonWorkingDays.date': date }).lean();
    const nwdRemark = allotEntry
      ? (allotEntry.nonWorkingDays.find(d => d.date === date)?.remark || 'Holiday')
      : null;

    const rooms = await Promise.all(
      enabledRooms.map(async (roomOverride) => {
        const room = roomOverride.room;
        if (isStopped) return { room, status: 'skipped', reason: 'Stopped Day' };
        if (nwdRemark) return { room, status: 'skipped', reason: `Non-working day: ${nwdRemark}` };
        const ctx = await resolveRoomContext(room, slot, date, config);
        if (!ctx) return { room, status: 'skipped', reason: 'No Class Scheduled' };
        const cameras = await resolveCameras(room, roomOverride);
        const pkl = resolveEmbeddingPkl(ctx.dept, ctx.subject, ctx.session);
        return {
          room,
          status: pkl ? 'would-run' : 'skipped',
          reason: pkl ? null : 'No Embeddings for Subject',
          ctx,
          cameras: { hasCam1: !!cameras.cam1, hasCam2: !!cameras.cam2 },
          pkl: pkl ? pkl.filename : null,
        };
      }),
    );

    res.json({ slot, date, acquisitionActive: config.active, rooms });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── GET /attendancemodule/scheduler/live-status ────────────────────────────
// Fetch real-time progress for classrooms without triggering ML runs.
// Includes camera status, working day flag, and all configured periods.
exports.liveStatus = async (req, res) => {
  try {
    const config = await AcquisitionControl.findOne({ profileName: 'default' }).lean();
    if (!config) return res.status(404).json({ error: 'AcquisitionControl config not found' });

    let { slot } = req.query;
    let date = req.query.date;
    if (!date) date = todayStr();

    // ── Working day check ──────────────────────────────────────────────────
    const isStopped = (config.stoppedDays || []).includes(date);
    const allotEntry = await Allotment.findOne({ 'nonWorkingDays.date': date }).lean();
    const nwd = (allotEntry?.nonWorkingDays || []).find(d => d.date === date);
    const isWorkingDay = !isStopped && !nwd;
    const workingDayReason = isStopped
      ? 'Manually stopped'
      : nwd ? (nwd.remark || 'Non-working day') : null;
    const workingDaySource = isStopped ? 'stoppedDays' : nwd ? 'allotment' : null;

    // ── Auto-detect current period ─────────────────────────────────────────
    if (!slot) {
      // Period times in AcquisitionControl are campus wall-clock (IST). Using
      // the server's local clock here picked a different period than the one
      // autoAttendanceScheduler was actually running (5h30m out on a UTC host),
      // so the header showed a period as live while its card sat on "Waiting
      // for attendance run to start…" — the run belonged to another period.
      const currentMinutes = nowMinIST();
      const activePeriod = (config.periods || []).find(p => {
        if (!p.startTime || !p.endTime) return false;
        const [sH, sM] = p.startTime.split(':').map(Number);
        const [eH, eM] = p.endTime.split(':').map(Number);
        return currentMinutes >= sH * 60 + sM && currentMinutes <= eH * 60 + eM;
      });
      if (activePeriod) {
        slot = activePeriod.periodKey;
      } else {
        return res.json({
          slot: null,
          date,
          isWorkingDay,
          workingDayReason,
          workingDaySource,
          acquisitionActive: config.active,
          periods: config.periods || [],
          rooms: [],
        });
      }
    }

    const enabledRooms = await getEnabledRooms(config);
    const periodCfg = (config.periods || []).find((p) => p.periodKey === slot) || {};
    const targetRuns = periodCfg.numRuns ?? config.globalNumRuns ?? 1;

    // ── Period window, in campus (IST) minutes ─────────────────────────────
    // Sent to the client so the card can say when the period starts and ends
    // without re-deriving it from the browser's clock, which is what let the
    // header and the card disagree about whether a period was live.
    const curMin = nowMinIST();
    const pStart = periodCfg.startTime ? timeStrToMin(periodCfg.startTime) : null;
    const pEnd = periodCfg.endTime ? timeStrToMin(periodCfg.endTime) : null;
    const runDurationMin = Math.ceil((config.globalRunDurationSec ?? 120) / 60);
    const timing = pStart == null || pEnd == null ? null : {
      startTime: periodCfg.startTime,
      endTime: periodCfg.endTime,
      startMin: pStart,
      endMin: pEnd,
      nowMin: curMin,
      // Same predicate autoAttendanceScheduler uses to decide whether to fire,
      // so "would fire now" on the page means exactly what the cron means.
      state: curMin < pStart ? 'upcoming' : curMin > pEnd ? 'over' : 'live',
      minsToStart: Math.max(0, pStart - curMin),
      minsToEnd: Math.max(0, pEnd - curMin),
      runDurationMin,
      wouldFireNow:
        (curMin >= pStart && curMin <= pStart + 1) ||
        (curMin > pStart && curMin + runDurationMin <= pEnd),
      tooLateToStart: curMin > pStart && curMin <= pEnd && curMin + runDurationMin > pEnd,
    };

    // Global gates — shown once above the cards, because when one of these
    // blocks, every room is "waiting" for the same reason.
    const runGate = await checkAttendanceRunAllowed();
    const gates = [
      { key: 'active', label: 'Acquisition enabled', ok: !!config.active,
        detail: config.active ? 'AcquisitionControl.active is on' : 'AcquisitionControl.active is OFF — no period will run' },
      { key: 'workingDay', label: 'Working day', ok: isWorkingDay,
        detail: isWorkingDay ? date : `${date} — ${workingDayReason}` },
      { key: 'timeWindow', label: 'Within run window', ok: runGate.allowed,
        detail: runGate.allowed ? 'Allowed at this time' : runGate.reason },
      { key: 'period', label: 'Period configured', ok: timing != null,
        detail: timing ? `${timing.startTime}–${timing.endTime} IST` : `No start/end time set for ${slot}` },
    ];

    // ── Bulk camera fetch ──────────────────────────────────────────────────
    const allRoomIds = enabledRooms.map(r => r.room.toUpperCase());
    const allCameras = await Camera.find({ roomId: { $in: allRoomIds } }).lean();
    const camerasByRoom = {};
    for (const c of allCameras) {
      const rid = (c.roomId || '').toUpperCase();
      if (!camerasByRoom[rid]) camerasByRoom[rid] = [];
      camerasByRoom[rid].push(c);
    }

    const rooms = await Promise.all(
      enabledRooms.map(async (roomOverride) => {
        const room = roomOverride.room;

        // Camera info
        const cams = camerasByRoom[room.toUpperCase()] || [];
        const activeCams = cams.filter(c => c.isActive !== false);
        const onlineCams = activeCams.filter(c => c.status === 'online');
        const cameraInfo = {
          total: activeCams.length,
          online: onlineCams.length,
          status: activeCams.length === 0 ? 'no_camera' : onlineCams.length > 0 ? 'online' : 'offline',
        };

        if (!isWorkingDay) {
          return { room, status: 'skipped', reason: workingDayReason || 'Non-working day', cameraInfo };
        }

        const resolved = await resolveClassContext(room, slot, date, config);
        const ctx = resolved.ctx;
        if (!ctx) {
          // Still run the checklist — its first line names *why* no class
          // resolved (free period, wrong weekday, room not in the slot data).
          const { checks } = await buildPreflight({
            room, slot, date, config, cameraInfo, runsCompleted: 0, resolved,
          });
          return { room, status: 'skipped', reason: 'No Class Scheduled', cameraInfo, preflight: checks };
        }

        // Find report for this batch + date + slot
        const report = await AttendanceReport.findOne({ batch: ctx.batch, date, timeSlot: slot }).lean();

        let runsCompleted = 0;
        let lastRecord = null;
        let reportStatus = 'pending';
        let reportId = null;

        if (report) {
          runsCompleted = (report.slotResults || []).length;
          reportStatus = report.status || 'draft';
          reportId = report._id;

          if (reportStatus === 'draft' && report.slotResults && report.slotResults.length > 0) {
            const lastCheck = report.slotResults[report.slotResults.length - 1].summary;
            lastRecord = lastCheck ? {
              present: lastCheck.present || 0,
              absent: lastCheck.absent || 0,
              review: lastCheck.review || 0,
              totalStudents: lastCheck.total || 0,
              attendancePct: lastCheck.total > 0
                ? Math.round(((lastCheck.present || 0) / lastCheck.total) * 100) : 0,
            } : null;
          } else {
            lastRecord = report.summary || null;
          }
        }

        const { checks } = await buildPreflight({
          room, slot, date, config, cameraInfo, runsCompleted, resolved,
        });

        return {
          room,
          status: reportStatus,
          runsCompleted,
          targetRuns,
          ctx,
          reportId,
          lastRecord,
          cameraInfo,
          reason: null,
          preflight: checks,
        };
      })
    );

    res.json({
      slot,
      date,
      isWorkingDay,
      workingDayReason,
      workingDaySource,
      acquisitionActive: config.active,
      periods: config.periods || [],
      timing,
      gates,
      rooms,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── GET /attendancemodule/scheduler/working-day?date=YYYY-MM-DD ──────────────
// Returns whether the given date (defaults to today) is a working day.
// Checks: (1) AcquisitionControl.stoppedDays (manual), (2) Allotment.nonWorkingDays (institutional).
exports.workingDayCheck = async (req, res) => {
  try {
    const date = req.query.date || todayStr();

    const config = await AcquisitionControl.findOne({ profileName: 'default' }).lean();
    if (!config) return res.status(404).json({ error: 'Config not found' });

    if ((config.stoppedDays || []).includes(date)) {
      return res.json({ date, isWorkingDay: false, reason: 'Manually stopped', source: 'stoppedDays', acquisitionActive: config.active });
    }

    const allotmentEntry = await Allotment.findOne({ 'nonWorkingDays.date': date }).lean();
    if (allotmentEntry) {
      const nwd = allotmentEntry.nonWorkingDays.find(d => d.date === date);
      return res.json({ date, isWorkingDay: false, reason: nwd?.remark || 'Non-working day', source: 'allotment', acquisitionActive: config.active });
    }

    res.json({ date, isWorkingDay: true, reason: null, source: null, acquisitionActive: config.active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── GET /attendancemodule/scheduler/non-working-days ─────────────────────────
// All non-working days from the Allotment DB (read-only, institutional calendar).
exports.nonWorkingDaysList = async (req, res) => {
  try {
    const allotments = await Allotment.find(
      { 'nonWorkingDays.0': { $exists: true } },
      { nonWorkingDays: 1, session: 1 }
    ).lean();
    const days = [];
    for (const a of allotments) {
      for (const nwd of (a.nonWorkingDays || [])) {
        days.push({ date: nwd.date, remark: nwd.remark || '', session: a.session || '' });
      }
    }
    days.sort((a, b) => a.date.localeCompare(b.date));
    res.json({ days });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
