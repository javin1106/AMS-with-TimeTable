// server/src/models/attendanceModule/schedulerLedger.js
// Durable record of which scheduler work has already been claimed for a given
// day, replacing autoAttendanceScheduler's in-memory `triggeredToday` Set.
//
// Why this exists:
//   • The Set lived in the process, so a restart lost it. It was rebuilt by
//     inferring "this period already fired" from the existence of a saved
//     report, which cannot distinguish a period that finished all its runs
//     from one that crashed after run 1 — the latter was written off.
//   • The Set is per-process, so two server instances would each fire every
//     period against the same cameras. A unique index plus an atomic claim is
//     the only thing that stops that.
//
// One row per (date, periodKey, room, task). Period-wide tasks that are not
// per-room — currently just the missed-class check — use room '*'.
//
// A claim is held with a heartbeat rather than a lock: a process that dies
// mid-run leaves its row in state 'claimed' forever, so a row whose heartbeat
// has gone stale is reclaimable by whoever notices first. That single rule
// covers both "the server restarted" and "another instance died".

const mongoose = require('mongoose');
const { commonFields, updateTimestamps } = require('../commonFields');

// One line of a run's own narration. runSlotAttendance already builds this
// trail for the manual trigger's response — every pre-flight check it makes
// (timetable context, subject roster, embeddings, camera, enrollment gate,
// finalized-report guard, the run plan) announces itself through it. Storing
// it is what turns "the period produced no report" into an answer.
const stepSchema = new mongoose.Schema({
    at:   { type: Date,    default: Date.now },
    msg:  { type: String,  default: '' },
    // True for the steps that explain a skip or a failure — the ones worth
    // colouring in the UI.
    warn: { type: Boolean, default: false },
}, { _id: false });

// One invocation of runSlotAttendance for this room+period. There can be
// several: the cron's own run, a resume after a crash, and any number of
// manual "run this room" triggers, and the difference between them is exactly
// what an operator is trying to see.
const attemptSchema = new mongoose.Schema({
    trigger:    { type: String, enum: ['cron', 'manual', 'resume'], default: 'cron' },
    startedAt:  { type: Date,   default: Date.now },
    finishedAt: { type: Date,   default: null },

    // Mirrors runSlotAttendance's own return: done | skipped | error, plus
    // 'interrupted' for an attempt whose process died before it could finish.
    status:     { type: String, default: 'running' },
    reason:     { type: String, default: null },

    // Resolved class context, denormalised so the page can show what the
    // scheduler thought was happening in that room without a second lookup.
    batch:      { type: String, default: null },
    subject:    { type: String, default: null },
    faculty:    { type: String, default: null },
    semester:   { type: String, default: null },

    reportId:      { type: mongoose.Schema.Types.ObjectId, ref: 'AttendanceReport', default: null },
    runsCompleted: { type: Number, default: 0 },
    targetRuns:    { type: Number, default: 0 },
    // Index of the first check this attempt ran — >1 means it picked up after
    // an interruption rather than starting the period.
    startedAtCheck:{ type: Number, default: 1 },

    summary: {
        present:       { type: Number, default: null },
        absent:        { type: Number, default: null },
        review:        { type: Number, default: null },
        totalStudents: { type: Number, default: null },
    },

    steps: { type: [stepSchema], default: [] },
}, { _id: false });

const schedulerLedgerSchema = new mongoose.Schema({
    // IST calendar date, 'YYYY-MM-DD' — the same string the scheduler and
    // AttendanceReport already key on (see timeWindowGuard.todayIST).
    date:       { type: String, required: true },

    // AcquisitionControl period key, e.g. 'P1'.
    periodKey:  { type: String, required: true },

    // Uppercased room id for task 'run'; '*' for period-wide tasks.
    room:       { type: String, required: true, default: '*' },

    // run       — the cron's own acquisition for this room+period (claimable)
    // manualRun — an operator pressing "run this room". Deliberately a
    //             separate row so it can never satisfy or block the cron's
    //             claim: the operator asked for an extra run, not to cancel
    //             the scheduled one.
    // bunkCheck — the period-wide missed-class check (room '*')
    task:       { type: String, enum: ['run', 'manualRun', 'bunkCheck'], default: 'run' },

    // claimed     — someone is working on it right now (see heartbeatAt)
    // done        — finished; never claimed again for this date
    // interrupted — a previous holder died and the work was not resumable
    //               (period already over); kept as the record that it happened
    state: {
        type:    String,
        enum:    ['claimed', 'done', 'interrupted'],
        default: 'claimed',
    },

    // Identifies the holder for diagnostics only — claims are decided by the
    // heartbeat, not by matching this back.
    owner:       { type: String,  default: null },
    claimedAt:   { type: Date,    default: null },
    // Refreshed as the run progresses. A claim is considered abandoned once
    // this is older than the staleness window (see claimSchedulerWork).
    heartbeatAt: { type: Date,    default: null },
    finishedAt:  { type: Date,    default: null },

    // How far the run got, for the operator-facing log and for diagnosing a
    // resume. The report's own slotResults remain the source of truth for
    // which check index to run next.
    checksSaved: { type: Number, default: 0 },
    targetRuns:  { type: Number, default: 0 },

    // Set when a resumed run picked up after a crash, so the day's history
    // shows the interruption rather than looking like an ordinary run.
    resumedCount: { type: Number, default: 0 },

    lastError:   { type: String, default: null },

    // Period window as configured when the work was claimed, so the page can
    // render a timeline without re-reading AcquisitionControl (which may have
    // been edited since).
    startTime:  { type: String, default: null },
    endTime:    { type: String, default: null },

    attempts: { type: [attemptSchema], default: [] },
});

schedulerLedgerSchema.add(commonFields);

// The claim. Upsert relies on this to reject a second inserter.
schedulerLedgerSchema.index(
    { date: 1, periodKey: 1, room: 1, task: 1 },
    { unique: true },
);
// Ledger rows are operational history, not records — 30 days is plenty to
// answer "did last month's outage skip a class?" without growing forever.
schedulerLedgerSchema.index({ created_at: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

schedulerLedgerSchema.pre('save', updateTimestamps);

module.exports = mongoose.model('SchedulerLedger', schedulerLedgerSchema);
