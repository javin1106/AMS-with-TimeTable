// server/src/modules/attendanceModule/controllers/erpAttendanceStore.js
//
// Single write path into the ErpAttendanceRecord collection, shared by every
// inbound ERP call that asserts attendance (the faculty-override-sync
// callback and the single-student override endpoint).
//
// Two rules this file exists to keep in one place:
//   1. Nothing here ever touches AttendanceReport.finalReport[].finalStatus or
//      report.summary. ERP's view is written to its own collection; our ML
//      attendance is read-only to this module.
//   2. Every write returns the roll-by-roll diff against what ERP previously
//      said, so the caller can hand it straight to ErpCommunicationLog and the
//      change is on the record with a timestamp.

const ErpAttendanceRecord = require('../../../models/attendanceModule/erpAttendanceRecord');

// Context copied from OUR report, never from ERP's payload — ERP tells us
// statuses, it does not get to redefine which subject/semester a period was.
function contextFromReport(report) {
    return {
        reportId:   report._id,
        batch:      report.batch || '',
        department: report.department || '',
        semester:   report.semester || '',
        subject:    report.subject || '',
        subCode:    report.subjectMeta?.subCode || '',
        subName:    report.subjectMeta?.subName || '',
        faculty:    report.faculty || '',
        date:       report.date || '',
        timeSlot:   report.timeSlot || '',
    };
}

function buildSummary(students) {
    const summary = { present: 0, absent: 0, review: 0, total: students.length };
    for (const s of students) {
        if (s.status === 'P') summary.present += 1;
        else if (s.status === 'R') summary.review += 1;
        else summary.absent += 1;
    }
    return summary;
}

/**
 * Upsert ERP's view of one period and return what changed.
 *
 * @param {object}   report            the AttendanceReport for this period (read-only here)
 * @param {Array}    entries           [{ rollNo, status: 'P'|'A'|'R', remarks? }]
 * @param {string}   source            'faculty-override-sync' | 'single-student-override'
 * @param {Date|null} facultyLockedAt  ERP's own finalisation timestamp, if it sent one
 * @param {string}   mode              'replace' — entries are the period's full roster (a
 *                                     full sync); 'merge' — entries touch only the rolls named
 * @returns {{ record: object, changes: Array }}
 */
async function recordErpPeriodAttendance({
    report,
    entries,
    source,
    facultyLockedAt = null,
    mode = 'replace',
}) {
    const existing = await ErpAttendanceRecord.findOne({ periodId: report.periodId });

    // What ERP said about each roll before this call — the `from` side of the diff.
    const previousByRoll = new Map(
        (existing?.students || []).map((s) => [s.rollNo, s]),
    );
    // Our model's call, captured alongside each change for later divergence review.
    const xceedByRoll = new Map(
        (report.finalReport || []).map((s) => [s.rollNo, s.finalStatus]),
    );

    // 'replace' starts from an empty roster so rolls ERP dropped disappear;
    // 'merge' starts from what's already stored and overlays the named rolls.
    const merged = mode === 'merge'
        ? new Map(previousByRoll)
        : new Map();

    const changes = [];
    for (const entry of entries) {
        const rollNo = String(entry.rollNo);
        const prev = previousByRoll.get(rollNo);
        const next = {
            rollNo,
            status: entry.status,
            remarks: entry.remarks == null ? (prev?.remarks || '') : String(entry.remarks),
        };
        merged.set(rollNo, next);

        if (!prev || prev.status !== next.status) {
            changes.push({
                rollNo,
                field: 'erpStatus',
                from: prev ? prev.status : null,
                to: next.status,
                xceedStatus: xceedByRoll.get(rollNo) ?? null,
            });
        }
    }

    const students = Array.from(merged.values());
    const doc = {
        ...contextFromReport(report),
        periodId: report.periodId,
        students,
        summary: buildSummary(students),
        source,
        facultyLockedAt,
        receivedAt: new Date(),
        revision: (existing?.revision || 0) + 1,
    };

    const record = await ErpAttendanceRecord.findOneAndUpdate(
        { periodId: report.periodId },
        { $set: doc },
        { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    return { record, changes };
}

module.exports = { recordErpPeriodAttendance, contextFromReport, buildSummary };
