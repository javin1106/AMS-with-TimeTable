// server/src/models/attendanceModule/erpAttendanceRecord.js
//
// ERP's own view of a period's attendance, kept in its own collection —
// deliberately NOT as fields on AttendanceReport.
//
// Why a separate collection: AttendanceReport holds attendance our ML pipeline
// produced, and that data is never mutated by anything ERP sends (see the
// finalStatus / erpOverriddenStatus split in models/attendanceReport.js). Two
// numbers that mean different things must not live side by side in one
// document, or a future query/export will blend them and quietly erode that
// guarantee. "Our data" and "their data" are physically distinct here.
//
// One doc per periodId, holding ERP's CURRENT view. It is upserted whenever
// ERP tells us something new (faculty re-finalisation, single-student
// override); each revision bumps `revision`. The full history of what ERP sent
// and when lives in erpCommunicationLog.js, which is append-only — this
// collection is the latest state, that one is the audit trail.

const mongoose = require('mongoose');

const erpStudentSchema = new mongoose.Schema({
    rollNo:  { type: String, required: true },
    // ERP speaks PRESENT/ABSENT; callers map to our P/A/R letters before
    // storing so the cumulative view can compare like with like. 'R' only
    // ever arrives from our own single-student override endpoint — ERP itself
    // has no review state.
    status:  { type: String, enum: ['P', 'A', 'R'], required: true },
    remarks: { type: String, default: '' },
}, { _id: false });

const erpAttendanceRecordSchema = new mongoose.Schema({
    // Same structured periodId AttendanceReport mints (batch+room+date+slot) —
    // the join key between the two collections.
    periodId: { type: String, required: true, unique: true },
    reportId: { type: mongoose.Schema.Types.ObjectId, ref: 'AttendanceReport', default: null },

    // Context denormalised at write time so the cumulative/divergence view can
    // group by semester + subject without joining back to AttendanceReport for
    // every row. Copied from the matching report, never from ERP's payload.
    batch:      { type: String, default: '' },
    department: { type: String, default: '' },
    semester:   { type: String, default: '' },
    subject:    { type: String, default: '' },   // timetable free text
    subCode:    { type: String, default: '' },   // e.g. "ECPC_306"
    subName:    { type: String, default: '' },   // abbreviation, e.g. "DSP"
    faculty:    { type: String, default: '' },
    date:       { type: String, default: '' },   // "YYYY-MM-DD"
    timeSlot:   { type: String, default: '' },

    students: { type: [erpStudentSchema], default: [] },

    summary: {
        present: { type: Number, default: 0 },
        absent:  { type: Number, default: 0 },
        review:  { type: Number, default: 0 },
        total:   { type: Number, default: 0 },
    },

    // Which ERP call produced this state.
    //   faculty-override-sync — ERP's roll-by-roll finalisation callback
    //   single-student-override — the per-student PATCH ERP makes
    source: {
        type: String,
        enum: ['faculty-override-sync', 'single-student-override'],
        required: true,
    },
    // ERP's own finalisation timestamp, echoed as-is (null for single-student
    // overrides, which carry no lock timestamp).
    facultyLockedAt: { type: Date, default: null },
    // When WE received it — distinct from facultyLockedAt, which is ERP's clock.
    receivedAt: { type: Date, default: Date.now },
    // Bumped on every ERP-driven change to this period; 1 on first write.
    revision:   { type: Number, default: 1 },
}, { timestamps: true });

// Cumulative view groups by batch+semester and filters by date range.
erpAttendanceRecordSchema.index({ batch: 1, semester: 1 });
erpAttendanceRecordSchema.index({ date: -1 });

module.exports = mongoose.model('ErpAttendanceRecord', erpAttendanceRecordSchema);
