// server/src/modules/attendanceModule/controllers/cumulativeAttendanceController.js
//
// Dual cumulative attendance — XCEED's own figure next to ERP's, semester-wise
// and subject-wise, with the divergence between them.
//
// Every ERP surface before this one was per-period: you could see that a
// single class was overridden, never that a subject or a student has been
// drifting all semester. This aggregates both sides and reports the gap.
//
// STRICTLY READ-ONLY. XCEED's numbers come from AttendanceReport.finalReport
// (finalStatus), ERP's from the separate ErpAttendanceRecord collection.
// Nothing here writes to either.
//
// ── Two comparisons, and why both are reported ──────────────────────────────
// ERP only knows about periods it has actually finalised, so its roster of
// periods is a subset of ours. Comparing our all-periods percentage against
// ERP's fewer-periods percentage would report a "divergence" that is really
// just coverage. So each row carries:
//   xceed   — our figure over every period we recorded
//   erp     — ERP's figure over the periods ERP has spoken about
//   comparable — both figures restricted to the ERP-covered periods only
// divergencePct is computed from `comparable`, which is the only apples-to-
// apples pair. `periods.erpCovered / periods.total` shows how much of the
// semester that comparison actually rests on.
//
// ── Status mapping ──────────────────────────────────────────────────────────
// ERP has no equivalent of our 'review' state, and erpAttendancePushController
// posts 'R' to ERP as ABSENT. To avoid counting that known, systematic mapping
// as disagreement, both sides are normalised to present / not-present before
// comparison — the same definition each percentage already uses. Review volume
// is reported separately as `reviewMarks` so it stays visible.

const AttendanceReport = require('../../../models/attendanceReport');
const ErpAttendanceRecord = require('../../../models/attendanceModule/erpAttendanceRecord');
const Subject = require('../../../models/subject');

const escapeRegex = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Department values appear as both "COMPUTER SCIENCE" and "COMPUTER_SCIENCE"
// across collections — same matcher the other report endpoints use.
const deptRegex = (value) => {
    const norm = escapeRegex(String(value).trim().replace(/\s+/g, '_'));
    return new RegExp(`^${norm.replace(/_/g, '[ _]')}$`, 'i');
};

// Present vs not-present — the single definition used for both sides.
const isPresent = (status) => status === 'P';

const pct = (present, marks) =>
    (marks > 0 ? Math.round((present / marks) * 1000) / 10 : 0);

// One row per (semester, subject). Subject identity prefers the resolved
// subject code, since the free-text timetable `subject` string is not stable
// enough to group a whole semester on.
const rowKey = (semester, subCode, subName, subject) =>
    `${semester}||${subCode || subName || subject || 'UNKNOWN'}`;

function emptyRow(report, subCode, subName) {
    return {
        semester: report.semester || '',
        subject: report.subject || '',
        subCode: subCode || '',
        subName: subName || '',
        faculty: report.faculty || '',
        department: report.department || '',
        batch: report.batch || '',
        periods: { total: 0, erpCovered: 0 },
        xceed: { present: 0, marks: 0, pct: 0 },
        erp: { present: 0, marks: 0, pct: 0 },
        comparable: { xceedPresent: 0, erpPresent: 0, marks: 0, xceedPct: 0, erpPct: 0 },
        reviewMarks: 0,
        studentMismatches: 0,
        divergencePct: 0,
        mismatchPct: 0,
    };
}

// Reports carry subjectMeta only if they were saved after that field existed.
// Fill the gaps with one bulk Subject lookup keyed on abbreviation + semester
// rather than leaving the subject-code column blank on older data.
async function resolveMissingSubjectCodes(reports) {
    const needing = reports.filter((r) => !r.subjectMeta?.subCode);
    if (!needing.length) return new Map();

    const names = [...new Set(needing.map((r) => r.subject).filter(Boolean))];
    if (!names.length) return new Map();

    const subjects = await Subject.find(
        { $or: [{ subName: { $in: names } }, { subjectFullName: { $in: names } }] },
        { subName: 1, subjectFullName: 1, subCode: 1, sem: 1 },
    ).lean();

    const bySubjectSem = new Map();
    for (const s of subjects) {
        for (const name of [s.subName, s.subjectFullName].filter(Boolean)) {
            bySubjectSem.set(`${name}||${s.sem ?? ''}`, s);
        }
    }
    return bySubjectSem;
}

// GET /reports/cumulative?batch=&semester=&department=&from=&to=
async function getCumulative(req, res) {
    try {
        const { batch, semester, department, from, to } = req.query;

        const filter = {};
        if (batch) filter.batch = batch;
        if (semester) filter.semester = String(semester);
        if (from || to) {
            filter.date = {};
            if (from) filter.date.$gte = from;
            if (to) filter.date.$lte = to;
        }
        // Dept-scoped users are pinned to their own department regardless of
        // what they ask for; full-access users may filter freely.
        if (!req.attendanceFullAccess) {
            filter.department = deptRegex(req.attendanceDepartment);
        } else if (department) {
            filter.department = deptRegex(department);
        }

        const reports = await AttendanceReport.find(filter)
            .select('batch department semester subject subjectMeta faculty date periodId finalReport.rollNo finalReport.finalStatus')
            .sort({ date: -1 })
            .lean();

        if (!reports.length) {
            return res.json({
                filters: { batch: batch || '', semester: semester || '', department: department || '', from: from || '', to: to || '' },
                rows: [],
                totals: emptyTotals(),
                ...(req.attendanceFullAccess ? { departments: await distinctDepartments() } : {}),
            });
        }

        const subjectLookup = await resolveMissingSubjectCodes(reports);

        // ERP's side, fetched once for every period in scope.
        const periodIds = reports.map((r) => r.periodId).filter(Boolean);
        const erpRecords = await ErpAttendanceRecord.find({ periodId: { $in: periodIds } })
            .select('periodId students summary revision receivedAt')
            .lean();
        const erpByPeriod = new Map(erpRecords.map((r) => [r.periodId, r]));

        const rows = new Map();

        for (const report of reports) {
            const subCode = report.subjectMeta?.subCode
                || subjectLookup.get(`${report.subject}||${report.semester ?? ''}`)?.subCode
                || '';
            const subName = report.subjectMeta?.subName || '';
            const key = rowKey(report.semester, subCode, subName, report.subject);

            if (!rows.has(key)) rows.set(key, emptyRow(report, subCode, subName));
            const row = rows.get(key);
            // Reports are date-desc, so the first row wins — most recent
            // faculty for a subject taught by more than one over the term.
            if (!row.faculty && report.faculty) row.faculty = report.faculty;
            if (!row.subCode && subCode) row.subCode = subCode;

            const finalReport = report.finalReport || [];
            row.periods.total += 1;
            for (const s of finalReport) {
                row.xceed.marks += 1;
                if (isPresent(s.finalStatus)) row.xceed.present += 1;
                if (s.finalStatus === 'R') row.reviewMarks += 1;
            }

            const erp = erpByPeriod.get(report.periodId);
            if (!erp) continue;

            row.periods.erpCovered += 1;
            const xceedByRoll = new Map(finalReport.map((s) => [s.rollNo, s.finalStatus]));

            for (const es of erp.students || []) {
                row.erp.marks += 1;
                if (isPresent(es.status)) row.erp.present += 1;

                // Comparable pair — only rolls present on BOTH sides, so a
                // roster difference doesn't masquerade as a status difference.
                if (!xceedByRoll.has(es.rollNo)) continue;
                const ours = xceedByRoll.get(es.rollNo);
                row.comparable.marks += 1;
                if (isPresent(ours)) row.comparable.xceedPresent += 1;
                if (isPresent(es.status)) row.comparable.erpPresent += 1;
                if (isPresent(ours) !== isPresent(es.status)) row.studentMismatches += 1;
            }
        }

        const out = [...rows.values()].map(finaliseRow)
            .sort((a, b) => String(a.semester).localeCompare(String(b.semester), undefined, { numeric: true })
                || (a.subCode || a.subject).localeCompare(b.subCode || b.subject));

        res.json({
            filters: { batch: batch || '', semester: semester || '', department: department || '', from: from || '', to: to || '' },
            rows: out,
            totals: buildTotals(out),
            ...(req.attendanceFullAccess ? { departments: await distinctDepartments() } : {}),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

function finaliseRow(row) {
    row.xceed.pct = pct(row.xceed.present, row.xceed.marks);
    row.erp.pct = pct(row.erp.present, row.erp.marks);
    row.comparable.xceedPct = pct(row.comparable.xceedPresent, row.comparable.marks);
    row.comparable.erpPct = pct(row.comparable.erpPresent, row.comparable.marks);
    // Signed: positive means ERP records MORE attendance than we did, which is
    // the direction that matters — it means marks were added after our run.
    row.divergencePct = Math.round((row.comparable.erpPct - row.comparable.xceedPct) * 10) / 10;
    row.mismatchPct = pct(row.studentMismatches, row.comparable.marks);
    return row;
}

function emptyTotals() {
    return {
        periods: { total: 0, erpCovered: 0 },
        xceedPct: 0,
        erpPct: 0,
        divergencePct: 0,
        studentMismatches: 0,
        comparableMarks: 0,
        coveragePct: 0,
    };
}

function buildTotals(rows) {
    const t = {
        periods: { total: 0, erpCovered: 0 },
        xceedPresent: 0, xceedMarks: 0,
        comparableXceedPresent: 0, comparableErpPresent: 0, comparableMarks: 0,
        studentMismatches: 0,
    };
    for (const r of rows) {
        t.periods.total += r.periods.total;
        t.periods.erpCovered += r.periods.erpCovered;
        t.xceedPresent += r.xceed.present;
        t.xceedMarks += r.xceed.marks;
        t.comparableXceedPresent += r.comparable.xceedPresent;
        t.comparableErpPresent += r.comparable.erpPresent;
        t.comparableMarks += r.comparable.marks;
        t.studentMismatches += r.studentMismatches;
    }
    const xceedPct = pct(t.comparableXceedPresent, t.comparableMarks);
    const erpPct = pct(t.comparableErpPresent, t.comparableMarks);
    return {
        periods: t.periods,
        xceedPct,
        erpPct,
        divergencePct: Math.round((erpPct - xceedPct) * 10) / 10,
        studentMismatches: t.studentMismatches,
        comparableMarks: t.comparableMarks,
        coveragePct: pct(t.periods.erpCovered, t.periods.total),
        overallXceedPct: pct(t.xceedPresent, t.xceedMarks),
    };
}

async function distinctDepartments() {
    return (await AttendanceReport.distinct('department'))
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
}

// GET /reports/cumulative/students?batch=&semester=&subCode=&subject=&from=&to=
// Per-student drill-down behind one row of the table above. A divergence
// figure with no way to see which students it came from isn't actionable.
async function getCumulativeStudents(req, res) {
    try {
        const { batch, semester, subCode, subject, from, to } = req.query;
        if (!batch) return res.status(400).json({ error: 'batch is required' });

        const filter = { batch };
        if (semester) filter.semester = String(semester);
        if (subject) filter.subject = subject;
        if (subCode) filter['subjectMeta.subCode'] = subCode;
        if (from || to) {
            filter.date = {};
            if (from) filter.date.$gte = from;
            if (to) filter.date.$lte = to;
        }
        if (!req.attendanceFullAccess) {
            filter.department = deptRegex(req.attendanceDepartment);
        }

        const reports = await AttendanceReport.find(filter)
            .select('periodId finalReport.rollNo finalReport.finalStatus')
            .lean();

        const erpRecords = await ErpAttendanceRecord.find({
            periodId: { $in: reports.map((r) => r.periodId).filter(Boolean) },
        }).select('periodId students').lean();
        const erpByPeriod = new Map(erpRecords.map((r) => [r.periodId, r]));

        const byRoll = new Map();
        const ensure = (rollNo) => {
            if (!byRoll.has(rollNo)) {
                byRoll.set(rollNo, {
                    rollNo,
                    xceed: { present: 0, marks: 0, pct: 0 },
                    erp: { present: 0, marks: 0, pct: 0 },
                    comparable: { xceedPresent: 0, erpPresent: 0, marks: 0 },
                    mismatches: 0,
                    divergencePct: 0,
                });
            }
            return byRoll.get(rollNo);
        };

        for (const report of reports) {
            const erp = erpByPeriod.get(report.periodId);
            const erpByRoll = new Map((erp?.students || []).map((s) => [s.rollNo, s.status]));

            for (const s of report.finalReport || []) {
                const rec = ensure(s.rollNo);
                rec.xceed.marks += 1;
                if (isPresent(s.finalStatus)) rec.xceed.present += 1;

                if (!erpByRoll.has(s.rollNo)) continue;
                const theirs = erpByRoll.get(s.rollNo);
                rec.erp.marks += 1;
                if (isPresent(theirs)) rec.erp.present += 1;
                rec.comparable.marks += 1;
                if (isPresent(s.finalStatus)) rec.comparable.xceedPresent += 1;
                if (isPresent(theirs)) rec.comparable.erpPresent += 1;
                if (isPresent(s.finalStatus) !== isPresent(theirs)) rec.mismatches += 1;
            }
        }

        const students = [...byRoll.values()].map((r) => {
            r.xceed.pct = pct(r.xceed.present, r.xceed.marks);
            r.erp.pct = pct(r.erp.present, r.erp.marks);
            const cx = pct(r.comparable.xceedPresent, r.comparable.marks);
            const ce = pct(r.comparable.erpPresent, r.comparable.marks);
            r.divergencePct = Math.round((ce - cx) * 10) / 10;
            return r;
        }).sort((a, b) => Math.abs(b.divergencePct) - Math.abs(a.divergencePct)
            || a.rollNo.localeCompare(b.rollNo));

        res.json({ batch, semester: semester || '', subCode: subCode || '', subject: subject || '', students });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

module.exports = { getCumulative, getCumulativeStudents };
