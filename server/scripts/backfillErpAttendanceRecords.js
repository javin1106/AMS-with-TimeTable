/**
 * One-off backfill: reconstruct ErpAttendanceRecord documents for periods ERP
 * already spoke about BEFORE that collection existed.
 *
 *   node scripts/backfillErpAttendanceRecords.js [--commit] [--batch=BTECH_ECE_2023]
 *
 * Runs as a dry run by default and prints what it would write. Pass --commit
 * to actually write.
 *
 * ── Why this is needed ──────────────────────────────────────────────────────
 * Until now, ERP's view of a period was recorded only as erpOverriddenStatus
 * on individual students inside AttendanceReport. The cumulative XCEED-vs-ERP
 * view reads the separate ErpAttendanceRecord collection, so without this
 * backfill every historical period would show as "not covered by ERP" and the
 * divergence column would be empty for the whole term to date.
 *
 * ── How ERP's view is reconstructed ─────────────────────────────────────────
 * Two cases, distinguished by whether ERP ever finalised the period:
 *
 *   facultyLockedAt set — ERP sent the FULL roster for this period
 *     (erpOverrideSyncController). It only stored erpOverriddenStatus where
 *     ERP's value DIFFERED from ours, so for every other student ERP's value
 *     was, by definition, the same as our finalStatus. ERP's view is therefore
 *     `erpOverriddenStatus ?? finalStatus` across the whole roster. Note this
 *     is exact, not approximate: any student we marked 'R' necessarily differs
 *     from ERP's P/A vocabulary, so an R always has an explicit override.
 *
 *   facultyLockedAt unset — only single-student overrides ever arrived, so ERP
 *     never expressed a view on the rest of the roster. Only the students with
 *     isOverridden are reconstructed; the rest are left out rather than
 *     invented, which keeps the ERP percentage honest.
 *
 * Reconstructed docs are written with revision 0, which is what distinguishes
 * them from records produced by a live ERP call (those start at 1 and
 * increment). `source` still records which of the two cases above applied.
 * Existing records are never overwritten. This script does
 * NOT write to the communication log — those entries are evidence of real
 * exchanges and must not be fabricated after the fact. It also never touches
 * AttendanceReport.
 */
require('dotenv').config();

const mongoose = require('mongoose');
const AttendanceReport = require('../src/models/attendanceReport');
const ErpAttendanceRecord = require('../src/models/attendanceModule/erpAttendanceRecord');

const COMMIT = process.argv.includes('--commit');
const batchArg = process.argv.find((a) => a.startsWith('--batch='));
const BATCH = batchArg ? batchArg.split('=')[1] : null;

function buildSummary(students) {
    const summary = { present: 0, absent: 0, review: 0, total: students.length };
    for (const s of students) {
        if (s.status === 'P') summary.present += 1;
        else if (s.status === 'R') summary.review += 1;
        else summary.absent += 1;
    }
    return summary;
}

(async () => {
    if (!process.env.MONGO_URL) {
        console.error('MONGO_URL is not set — check the server .env');
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGO_URL);
    console.log(`Connected. Mode: ${COMMIT ? 'COMMIT' : 'DRY RUN'}${BATCH ? ` · batch=${BATCH}` : ''}`);

    const filter = {
        $or: [
            { facultyLockedAt: { $ne: null } },
            { 'finalReport.isOverridden': true },
        ],
    };
    if (BATCH) filter.batch = BATCH;

    const reports = await AttendanceReport.find(filter)
        .select('periodId batch department semester subject subjectMeta faculty date timeSlot facultyLockedAt finalReport')
        .lean();

    console.log(`${reports.length} candidate report(s) found.`);

    let written = 0;
    let skippedExisting = 0;
    let skippedEmpty = 0;
    let skippedNoPeriodId = 0;

    for (const report of reports) {
        if (!report.periodId) { skippedNoPeriodId += 1; continue; }

        // Never overwrite a record a real ERP call produced.
        const existing = await ErpAttendanceRecord.findOne({ periodId: report.periodId })
            .select('_id source').lean();
        if (existing) { skippedExisting += 1; continue; }

        const wasFinalised = Boolean(report.facultyLockedAt);
        const roster = report.finalReport || [];

        const students = roster
            .filter((s) => (wasFinalised ? true : s.isOverridden))
            .map((s) => ({
                rollNo: s.rollNo,
                status: s.erpOverriddenStatus || s.finalStatus || 'A',
                remarks: s.facultyRemark || '',
            }));

        if (!students.length) { skippedEmpty += 1; continue; }

        const doc = {
            periodId: report.periodId,
            reportId: report._id,
            batch: report.batch || '',
            department: report.department || '',
            semester: report.semester || '',
            subject: report.subject || '',
            subCode: report.subjectMeta?.subCode || '',
            subName: report.subjectMeta?.subName || '',
            faculty: report.faculty || '',
            date: report.date || '',
            timeSlot: report.timeSlot || '',
            students,
            summary: buildSummary(students),
            source: wasFinalised ? 'faculty-override-sync' : 'single-student-override',
            facultyLockedAt: report.facultyLockedAt || null,
            receivedAt: report.facultyLockedAt || null,
            // 0 marks this as reconstructed rather than received live — a real
            // ERP call starts at 1 and increments from there.
            revision: 0,
        };

        if (COMMIT) {
            await ErpAttendanceRecord.create(doc);
        } else if (written < 5) {
            console.log(`  would write ${doc.periodId}: ${students.length} students, `
                + `${doc.summary.present}P/${doc.summary.absent}A, `
                + `${wasFinalised ? 'full roster (finalised)' : 'overridden students only'}`);
        }
        written += 1;
    }

    console.log('\n── Summary ──');
    console.log(`  ${COMMIT ? 'written' : 'would write'} : ${written}`);
    console.log(`  skipped (record already exists) : ${skippedExisting}`);
    console.log(`  skipped (nothing ERP said)      : ${skippedEmpty}`);
    console.log(`  skipped (no periodId)           : ${skippedNoPeriodId}`);
    if (!COMMIT) console.log('\nDry run — re-run with --commit to write.');

    await mongoose.disconnect();
})().catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
});
