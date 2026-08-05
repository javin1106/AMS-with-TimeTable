// server/src/models/attendanceModule/erpCommunicationLog.js
//
// Append-only record of EVERY communication with ERP, in both directions,
// including the ones we rejected — plus, for anything that changed attendance
// on the ERP side, the exact roll-by-roll before/after with a timestamp.
//
// Why this exists: until now the ERP side was last-write-wins. If ERP sent
// PRESENT for a roll and later ABSENT, the first value was overwritten with no
// trace, so we could not prove what ERP actually sent us or when. The model's
// own original call has always been preserved (autoFinalStatus on
// attendanceReport.js) — this gives the ERP side the same accountability.
//
// Append-only is enforced, not just documented: the update/delete paths below
// throw. Write through ErpCommunicationLog.record() only. Nothing in this
// collection ever feeds back into attendance — it is evidence, not state.

const mongoose = require('mongoose');

// One roll's before → after, for communications that changed something.
// from/to are ERP's OWN previous and new value (from is null the first time
// ERP speaks about a roll) — this answers "what did ERP change, and when".
// xceedStatus is our model's finalStatus at that moment, captured alongside so
// the divergence at the time of the change is preserved even if the cumulative
// view is recomputed later. It is copied, never written back.
const changeSchema = new mongoose.Schema({
    rollNo:      { type: String, required: true },
    field:       { type: String, default: 'erpStatus' },
    from:        { type: String, default: null },
    to:          { type: String, default: null },
    xceedStatus: { type: String, default: null },
}, { _id: false });

const erpCommunicationLogSchema = new mongoose.Schema({
    // inbound  — ERP called us
    // outbound — we called ERP
    direction: { type: String, enum: ['inbound', 'outbound'], required: true },
    // Which call this was. Kept as a plain string rather than an enum so a new
    // ERP endpoint can be logged without a schema migration — an audit trail
    // that refuses to record an unrecognised event is worse than useless.
    event:     { type: String, required: true },
    endpoint:  { type: String, default: '' },

    periodId:  { type: String, default: null },
    reportId:  { type: mongoose.Schema.Types.ObjectId, ref: 'AttendanceReport', default: null },

    // Did this exchange succeed, from our side's point of view. Rejected
    // inbound calls (bad payload, unknown period) are logged with ok:false —
    // "all communications" includes the ones we refused.
    ok:           { type: Boolean, default: true },
    httpStatus:   { type: Number, default: null },
    // Business-level code from the spec envelope, e.g. ATTENDANCE_ACCEPTED,
    // SYNC_ALREADY_APPLIED, PERIOD_NOT_FOUND.
    responseCode: { type: String, default: null },
    error:        { type: String, default: null },

    // Payloads stored as sent/received. Schemaless because the shape differs
    // per endpoint and we want the raw evidence, not a normalised summary.
    requestBody:  { type: mongoose.Schema.Types.Mixed, default: null },
    responseBody: { type: mongoose.Schema.Types.Mixed, default: null },

    // Populated only when this communication actually changed ERP's recorded
    // attendance for one or more students. Empty for no-op syncs, reads and
    // rejected calls — changeCount is the cheap "did anything move" filter.
    changes:     { type: [changeSchema], default: [] },
    changeCount: { type: Number, default: 0 },

    // Our clock, when the exchange happened. Explicit rather than relying on
    // createdAt so it reads unambiguously in an audit context.
    occurredAt: { type: Date, default: Date.now },
    sourceIp:   { type: String, default: '' },
}, { timestamps: true });

erpCommunicationLogSchema.index({ periodId: 1, occurredAt: -1 });
erpCommunicationLogSchema.index({ occurredAt: -1 });
erpCommunicationLogSchema.index({ direction: 1, event: 1, occurredAt: -1 });
// Supports "show me every ERP change that touched this roll number".
erpCommunicationLogSchema.index({ 'changes.rollNo': 1, occurredAt: -1 });

// ── Append-only enforcement ─────────────────────────────────────────────────
// Mongoose routes these through different hooks depending on the call, so all
// the mutating entry points are blocked individually. Document.save() on an
// already-persisted doc is caught by the isNew check.
const BLOCKED = 'ErpCommunicationLog is append-only — entries cannot be modified or removed.';

for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne',
    'deleteOne', 'deleteMany', 'findOneAndDelete', 'findOneAndRemove']) {
    erpCommunicationLogSchema.pre(op, function blockMutation(next) {
        next(new Error(BLOCKED));
    });
}
erpCommunicationLogSchema.pre('save', function blockResave(next) {
    if (!this.isNew) return next(new Error(BLOCKED));
    next();
});

// The only supported write path. Never throws: an audit write must not be able
// to fail the ERP exchange it is describing, so callers can await this without
// a try/catch of their own. A failure is logged to the console and swallowed —
// losing one audit row is bad, rejecting ERP's attendance push because the
// audit row failed is worse.
erpCommunicationLogSchema.statics.record = async function record(entry) {
    try {
        const changes = Array.isArray(entry.changes) ? entry.changes : [];
        return await this.create({
            ...entry,
            changes,
            changeCount: changes.length,
            occurredAt: entry.occurredAt || new Date(),
        });
    } catch (err) {
        console.error('[ErpCommLog] failed to record entry:', err.message);
        return null;
    }
};

module.exports = mongoose.model('ErpCommunicationLog', erpCommunicationLogSchema);
