// server/src/modules/attendanceModule/controllers/schedulerRecovery.js
// One-shot sweep at boot, finishing what an interrupted process left half-done.
//
// Two things do not survive a crash, because both live only in the process:
//
//   • attendanceSessionController's activeSessions map. A live session sets its
//     report to status 'live' and only stopSession puts it back to 'draft', so
//     a report left 'live' after a restart is stranded — it cannot be reviewed
//     or finalized, and it is waiting on a timer that no longer exists.
//   • The end-of-period faculty summary. Both run paths send it only after
//     their last check, so a period interrupted anywhere before that never
//     mails, and nothing ever revisits the decision.
//
// Deliberately NOT here: the ERP push. erpAttendancePushController already runs
// a per-minute sweep plus a nightly pass over every pending/failed report, so
// anything this could retry is retried within a minute of boot anyway.
//
// Nothing here can recapture a class that ended during the outage — the source
// is a live RTSP stream. What it can do is make sure the record of that class
// is consistent, and that the humans who were waiting on an email get one.

const AttendanceReport = require('../../../models/attendanceReport');
const AcquisitionControl = require('../../../models/acquisitionControl');
const { sendFacultyAttendanceSummary } = require('./facultyAttendanceMailer');
const { nowMinIST, todayIST } = require('./timeWindowGuard');

// How far back to look for periods whose mail never went. A weekend-long
// outage should still send Friday's summaries when the server comes back;
// beyond that the mail is stale enough that sending it is noise.
const LOOKBACK_DAYS = 3;

function timeStrToMin(t) {
    if (!t || typeof t !== 'string' || !t.includes(':')) return null;
    const [h, m] = t.split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return h * 60 + m;
}

function datesBack(days) {
    const out = [];
    const today = new Date(`${todayIST()}T00:00:00Z`);
    for (let i = 0; i < days; i++) {
        const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
        out.push(d.toISOString().slice(0, 10));
    }
    return out;
}

/**
 * @returns {Promise<{unstuck: number, mailed: number, skipped: number}>}
 */
async function reconcileAfterRestart() {
    const result = { unstuck: 0, mailed: 0, skipped: 0 };

    let periodEndMin = {};
    try {
        const config = await AcquisitionControl.findOne({ profileName: 'default' }).lean();
        for (const p of config?.periods || []) {
            const m = timeStrToMin(p.endTime);
            if (m != null) periodEndMin[p.periodKey] = m;
        }
    } catch (err) {
        console.warn(`[SchedulerRecovery] Could not read period times: ${err.message}`);
    }

    const dates = datesBack(LOOKBACK_DAYS);
    const today = todayIST();
    const curMin = nowMinIST();

    // A period is over if its date is in the past, or its configured end time
    // has passed today. A period with no configured end time is treated as
    // over only on a past date — today it may still be running, and mailing
    // a summary mid-class would be worse than mailing it late.
    const isOver = (date, timeSlot) => {
        if (date !== today) return true;
        const endMin = periodEndMin[timeSlot];
        return endMin != null && curMin > endMin;
    };

    // ── 1. Reports stranded in 'live' ────────────────────────────────────────
    // activeSessions is empty in a process that just started, so every 'live'
    // report is by definition orphaned — there is no timer anywhere that will
    // ever advance it.
    let live = [];
    try {
        live = await AttendanceReport.find({ status: 'live' })
            .select('_id date timeSlot batch room')
            .lean();
    } catch (err) {
        console.error(`[SchedulerRecovery] Could not scan for live reports: ${err.message}`);
    }

    for (const r of live) {
        // A session started seconds before this boot, in a period still
        // running, is left alone: the operator can stop it themselves, and
        // flipping it to draft underneath them would look like data loss.
        if (!isOver(r.date, r.timeSlot)) {
            result.skipped++;
            continue;
        }
        try {
            await AttendanceReport.updateOne({ _id: r._id }, { $set: { status: 'draft' } });
            result.unstuck++;
            console.log(
                `[SchedulerRecovery] Report ${r._id} (${r.batch} ${r.timeSlot} ${r.date}) was stuck 'live' — set to draft`,
            );
        } catch (err) {
            console.error(`[SchedulerRecovery] Could not unstick ${r._id}: ${err.message}`);
        }
    }

    // ── 2. Periods that ran but never mailed ─────────────────────────────────
    // sendFacultyAttendanceSummary is idempotent on facultyEmail.sentAt and
    // gated by the Email Notifications toggles, so this cannot double-send and
    // cannot send anything the operator has switched off. A report whose mail
    // is disabled simply comes back {sent:false} on every boot, harmlessly.
    let unmailed = [];
    try {
        unmailed = await AttendanceReport.find({
            date: { $in: dates },
            'slotResults.0': { $exists: true },
            'facultyEmail.sentAt': null,
        })
            .select('_id date timeSlot batch room')
            .lean();
    } catch (err) {
        console.error(`[SchedulerRecovery] Could not scan for unmailed reports: ${err.message}`);
    }

    for (const r of unmailed) {
        if (!isOver(r.date, r.timeSlot)) {
            result.skipped++;
            continue;
        }
        try {
            // Re-read as a document: the mailer writes facultyEmail back onto it.
            const report = await AttendanceReport.findById(r._id);
            if (!report) continue;
            const outcome = await sendFacultyAttendanceSummary(report);
            if (outcome.sent) {
                result.mailed++;
                console.log(
                    `[SchedulerRecovery] Sent missed faculty summary for ${r.batch} ${r.timeSlot} ${r.date}`,
                );
            }
        } catch (err) {
            console.error(
                `[SchedulerRecovery] Faculty summary failed for ${r._id}: ${err.message}`,
            );
        }
    }

    console.log(
        `[SchedulerRecovery] Done — ${result.unstuck} report(s) unstuck from 'live', ` +
        `${result.mailed} missed faculty summary/summaries sent, ${result.skipped} left alone (period still running)`,
    );
    return result;
}

module.exports = { reconcileAfterRestart, LOOKBACK_DAYS };
