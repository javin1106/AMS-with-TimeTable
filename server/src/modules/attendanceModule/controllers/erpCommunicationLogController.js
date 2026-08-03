// server/src/modules/attendanceModule/controllers/erpCommunicationLogController.js
//
// Read-only views over the append-only ERP communication log. There is no
// write handler here by design — entries are created only by the controllers
// that actually talk to ERP, through ErpCommunicationLog.record().

const ErpCommunicationLog = require('../../../models/attendanceModule/erpCommunicationLog');
const AttendanceReport = require('../../../models/attendanceReport');

const escapeRegex = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const deptRegex = (value) => {
    const norm = escapeRegex(String(value).trim().replace(/\s+/g, '_'));
    return new RegExp(`^${norm.replace(/_/g, '[ _]')}$`, 'i');
};

// Dept-scoped users must not see log entries for other departments. The log
// itself stores no department (it records the exchange, not the class), so the
// allowed periodIds are resolved from AttendanceReport first and the query is
// constrained to those.
async function periodScopeForUser(req) {
    if (req.attendanceFullAccess) return null;
    const ids = await AttendanceReport.find({ department: deptRegex(req.attendanceDepartment) })
        .distinct('periodId');
    return ids.filter(Boolean);
}

// GET /reports/erp-communications?periodId=&rollNo=&direction=&event=&changedOnly=&from=&to=&limit=&skip=
async function listCommunications(req, res) {
    try {
        const {
            periodId, rollNo, direction, event, changedOnly,
            from, to, limit = 100, skip = 0,
        } = req.query;

        const filter = {};
        if (periodId) filter.periodId = periodId;
        if (direction) filter.direction = direction;
        if (event) filter.event = event;
        if (rollNo) filter['changes.rollNo'] = rollNo;
        // "Only exchanges that actually moved attendance" — excludes no-op
        // syncs, retries and rejected calls, which are still stored.
        if (changedOnly === 'true' || changedOnly === '1') filter.changeCount = { $gt: 0 };
        if (from || to) {
            filter.occurredAt = {};
            if (from) filter.occurredAt.$gte = new Date(from);
            if (to) filter.occurredAt.$lte = new Date(to);
        }

        const scope = await periodScopeForUser(req);
        if (scope) {
            filter.periodId = periodId
                ? (scope.includes(periodId) ? periodId : '__no_access__')
                : { $in: scope };
        }

        const [items, total] = await Promise.all([
            ErpCommunicationLog.find(filter)
                .sort({ occurredAt: -1 })
                .skip(Number(skip))
                .limit(Math.min(Number(limit), 500))
                .lean(),
            ErpCommunicationLog.countDocuments(filter),
        ]);

        res.json({ items, total, skip: Number(skip), limit: Number(limit) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

// GET /reports/erp-communications/period/:periodId
// Full ERP history for one period, oldest first — the timeline shown on the
// ERP Override Analysis page.
async function getPeriodHistory(req, res) {
    try {
        const { periodId } = req.params;

        const scope = await periodScopeForUser(req);
        if (scope && !scope.includes(periodId)) {
            return res.status(403).json({ error: 'Department access denied.' });
        }

        const items = await ErpCommunicationLog.find({ periodId })
            .sort({ occurredAt: 1 })
            .lean();

        res.json({ periodId, items, total: items.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

module.exports = { listCommunications, getPeriodHistory };
