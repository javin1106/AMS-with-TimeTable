// server/src/modules/attendanceModule/controllers/erpOverrideSyncController.js
//
// Inbound faculty-override sync (spec §13): ERP calls us once every time
// faculty finalises or re-finalises a period, carrying the complete
// roll-by-roll final status and remarks. We NEVER overwrite our own
// attendance data (finalStatus/summary) — the correction lands in the same
// separate erpOverriddenStatus/erpOverriddenAt/facultyRemark fields the
// single-student override endpoint uses (see applyErpOverride in
// attendanceReportController.js). Remarks are stored exactly as ERP sends
// them — no vocabulary validation against our own coordinatorRemark enum.
//
// Alongside that, every call also writes:
//   • ErpAttendanceRecord — ERP's full view of the period, in its own
//     collection (models/attendanceModule/erpAttendanceRecord.js), which is
//     what the cumulative XCEED-vs-ERP divergence view reads from.
//   • ErpCommunicationLog — an append-only entry for the exchange, including
//     the roll-by-roll diff of what ERP changed. Rejected calls are logged too.
//
// POST /attendancemodule/erp/faculty-override-sync
// Body: { periodId, facultyLockedAt, finalAttendance: [{ rollNo, finalStatus: 'PRESENT'|'ABSENT', remarks: string|null }] }
// Protected by verifyErpSignature/ipAllowlist/rate limiters (see
// middleware/erpInboundSecurity.js) — NOT by the cookie-based role check,
// since the caller is ERP itself, not a logged-in browser session.

const AttendanceReport = require('../../../models/attendanceReport');
const ErpCommunicationLog = require('../../../models/attendanceModule/erpCommunicationLog');
const { recordErpPeriodAttendance } = require('./erpAttendanceStore');

const ENDPOINT = 'POST /attendancemodule/erp/faculty-override-sync';

function mapErpStatus(finalStatus) {
    if (finalStatus === 'PRESENT') return 'P';
    if (finalStatus === 'ABSENT') return 'A';
    return null;
}

// Every exit from this handler goes through here, so the audit trail covers
// the calls we REJECTED as well as the ones we applied. Logging never throws
// (see ErpCommunicationLog.record) — a failed audit write must not turn a
// successful sync into an error response.
async function respond(req, res, httpStatus, body, extra = {}) {
    await ErpCommunicationLog.record({
        direction: 'inbound',
        event: 'faculty-override-sync',
        endpoint: ENDPOINT,
        periodId: req.body?.periodId || null,
        ok: httpStatus < 400 || body.status === 'SUCCESS',
        httpStatus,
        responseCode: body.responseCode || null,
        requestBody: req.body ?? null,
        responseBody: body,
        sourceIp: req.ip || '',
        ...extra,
    });
    return res.status(httpStatus).json(body);
}

async function facultyOverrideSync(req, res) {
    const { periodId, facultyLockedAt, finalAttendance } = req.body || {};

    if (!periodId || !facultyLockedAt || !Array.isArray(finalAttendance)) {
        return respond(req, res, 400, {
            status: 'FAILURE',
            responseCode: 'INVALID_PAYLOAD',
            message: 'periodId, facultyLockedAt and finalAttendance[] are required.',
        });
    }
    const lockedAt = new Date(facultyLockedAt);
    if (Number.isNaN(lockedAt.getTime())) {
        return respond(req, res, 400, {
            status: 'FAILURE',
            responseCode: 'INVALID_PAYLOAD',
            message: 'facultyLockedAt is not a valid timestamp.',
        });
    }
    for (const entry of finalAttendance) {
        if (!entry || typeof entry.rollNo !== 'string' || !mapErpStatus(entry.finalStatus)) {
            return respond(req, res, 400, {
                status: 'FAILURE',
                responseCode: 'INVALID_PAYLOAD',
                message: `Malformed finalAttendance entry for rollNo ${entry?.rollNo ?? '(missing)'}.`,
            });
        }
    }

    const report = await AttendanceReport.findOne({ periodId });
    if (!report) {
        return respond(req, res, 404, {
            status: 'FAILURE',
            responseCode: 'PERIOD_NOT_FOUND',
            periodId,
            message: 'No report found for this periodId.',
        });
    }

    // Exact same lock timestamp already applied — duplicate push racing a
    // manual pull, or a plain retry. Safe no-op (spec §13.2).
    if (report.facultyLockedAt && report.facultyLockedAt.getTime() === lockedAt.getTime()) {
        return respond(req, res, 409, {
            status: 'SUCCESS',
            responseCode: 'SYNC_ALREADY_APPLIED',
            periodId,
            facultyLockedAt,
        }, { reportId: report._id });
    }

    for (const entry of finalAttendance) {
        const student = report.finalReport.find((s) => s.rollNo === entry.rollNo);
        if (!student) continue; // not in our roster for this period — nothing to record

        const mapped = mapErpStatus(entry.finalStatus);
        if (mapped !== student.finalStatus) {
            student.erpOverriddenStatus = mapped;
            student.erpOverriddenAt = new Date();
            student.isOverridden = true;
        }
        // Stored verbatim — remarks null (faculty left the value unchanged)
        // clears any stale remark rather than being coerced to a string.
        if (entry.remarks != null) {
            student.facultyRemark = String(entry.remarks);
        }
    }

    report.facultyLockedAt = lockedAt;
    report.erpLockState = 'faculty_finalized';
    await report.save();

    // ERP's own view of this period, stored in its own collection. This is a
    // full finalisation, so it replaces whatever ERP previously said —
    // `changes` is the roll-by-roll diff against that previous state, which
    // goes onto the audit trail below with a timestamp.
    const { changes } = await recordErpPeriodAttendance({
        report,
        entries: finalAttendance.map((e) => ({
            rollNo: e.rollNo,
            status: mapErpStatus(e.finalStatus),
            remarks: e.remarks,
        })),
        source: 'faculty-override-sync',
        facultyLockedAt: lockedAt,
        mode: 'replace',
    });

    return respond(req, res, 200, {
        status: 'SUCCESS',
        responseCode: 'SYNC_ACCEPTED',
        periodId,
        facultyLockedAt,
    }, { reportId: report._id, changes });
}

module.exports = { facultyOverrideSync, mapErpStatus };
