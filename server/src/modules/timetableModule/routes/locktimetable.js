const express = require("express");
const LockTimeTableRouter = express.Router();
const LockTimeTableController = require("../controllers/locktimetable");
const locktimetableController = new LockTimeTableController();
const protectRoute = require("../../usermanagement/privateroute");
const { checkRole } = require("../../checkRole.middleware");
const deleteAccess = checkRole(['ITTC', 'DTTI']);
const LockSem = require('../../../models/locksem');
const TimeTable = require('../../../models/timetable');
const AcquisitionControl = require('../../../models/acquisitionControl');
const { resolveClassContext } = require('../../attendanceModule/controllers/classContextResolver');

LockTimeTableRouter.post("/locktt", protectRoute, async (req, res) => {
    try { await locktimetableController.locktt(req, res); }
    catch (e) { res.status(e?.status || 500).json({ error: e?.message || "Internal Server Error" }); }
});

LockTimeTableRouter.get("/lockclasstt/:code/:sem", async (req, res) => {
    try { await locktimetableController.classtt(req, res); }
    catch (e) { res.status(e?.status || 500).json({ error: e?.message || "Internal Server Error" }); }
});

LockTimeTableRouter.get("/lockfacultytt/:code/:faculty", async (req, res) => {
    try { await locktimetableController.facultytt(req, res); }
    catch (e) { res.status(e?.status || 500).json({ error: e?.message || "Internal Server Error" }); }
});

LockTimeTableRouter.get("/lockroomtt/:code/:room", async (req, res) => {
    try { await locktimetableController.roomtt(req, res); }
    catch (e) { res.status(e?.status || 500).json({ error: e?.message || "Internal Server Error" }); }
});

LockTimeTableRouter.get("/viewsem/:degree/:dept/:sem", async (req, res) => {
    try { await locktimetableController.classtt(req, res); }
    catch (e) { res.status(e?.status || 500).json({ error: e?.message || "Internal Server Error" }); }
});

LockTimeTableRouter.get("/viewfaculty/:session/:faculty", async (req, res) => {
    try { await locktimetableController.facultytt(req, res); }
    catch (e) { res.status(e?.status || 500).json({ error: e?.message || "Internal Server Error" }); }
});

LockTimeTableRouter.get("/viewroom/:session/:room", async (req, res) => {
    try { await locktimetableController.roomtt(req, res); }
    catch (e) { res.status(e?.status || 500).json({ error: e?.message || "Internal Server Error" }); }
});

LockTimeTableRouter.get("/viewsem/:code", async (req, res) => {
    try {
        const code = req.params.code;
        const updatedTime = await locktimetableController.getLastUpdatedTimeByCode(code);
        res.json({ updatedTime });
    } catch (e) { res.status(e?.status || 500).json({ error: e?.message || "Internal Server Error" }); }
});

LockTimeTableRouter.delete("/deletebycode/:code", deleteAccess, async (req, res) => {
    try {
        const code = req.params.code;
        await locktimetableController.deleteLockedTableByCode(code);
        res.status(200).json({ response: `Locked Time Table with code ${code} deleted successfully` });
    } catch (error) { res.status(500).json({ error: 'Internal Server Error' }); }
});

// ─── Attendance lookup ────────────────────────────────────────────────────────
// A room+slot alone does not identify a class — the same room hosts a
// different subject each weekday. `date` (default: today) picks the weekday,
// and also lets extra classes / alterations for that date apply, so this
// returns exactly what the automatic scheduler would run.
LockTimeTableRouter.get('/attendance-lookup', async (req, res) => {
    try {
        const { room, slot } = req.query;
        const date = req.query.date || new Date().toISOString().split('T')[0];
        if (!room || !slot) return res.status(400).json({ error: 'room and slot are required' });

        const config = await AcquisitionControl.findOne({ profileName: 'default' }).lean();
        const { ctx, reason, day, ambiguous } = await resolveClassContext(room, slot, date, config || {});

        if (!ctx) {
            return res.status(404).json({ error: reason || 'No timetable entry found', day, date });
        }

        return res.json({
            batch: ctx.batch,
            subject: ctx.subject,
            faculty: ctx.faculty,
            sem: ctx.sem,
            dept: ctx.dept,
            session: ctx.session,
            locksemId: ctx.locksemId,
            date,
            day,
            source: ctx.source,
            altered: ctx.altered,
            originalSubject: ctx.originalSubject,
            originalFaculty: ctx.originalFaculty,
            ambiguous,
        });
    } catch (err) {
        console.error('[attendance-lookup] error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── sems-by-dept: used by EmbeddingGeneration (dept → available sems) ────────
// ─── sems-by-dept: used by EmbeddingGeneration (dept → available sems) ────────
LockTimeTableRouter.get('/sems-by-dept', async (req, res) => {
    // DEBUG: print raw LockSem + timetable data to understand what's in DB
    try {
        const rawLockSem = await LockSem.find({}).limit(3).lean();
        console.log('=== DEBUG: Sample LockSem records (first 3) ===');
        console.log(JSON.stringify(rawLockSem, null, 2));

        const allTimetables = await TimeTable.find({}, 'dept name code currentSession').lean();
        console.log('=== DEBUG: All Timetables ===');
        console.log(JSON.stringify(allTimetables, null, 2));

        const lockSemWithRef = await LockSem.countDocuments({ timetable: { $exists: true, $ne: null } });
        const lockSemTotal = await LockSem.countDocuments();
        console.log(`=== DEBUG: LockSem total=${lockSemTotal}, with timetable ref=${lockSemWithRef} ===`);

        const uniqueSems = await LockSem.distinct('sem');
        console.log('=== DEBUG: Unique sems in LockSem ===', uniqueSems);

        const uniqueCodes = await LockSem.distinct('code');
        console.log('=== DEBUG: Unique codes in LockSem ===', uniqueCodes);

        console.log('=== DEBUG: dept query param received ===', req.query.dept);
    } catch (debugErr) {
        console.error('DEBUG error:', debugErr.message);
    }
    // END DEBUG
    try {
        const { dept } = req.query;
        if (!dept) return res.status(400).json({ error: 'dept is required' });

        // dept arrives as "Chemical_Engineering" — match both spaces and underscores in DB
        const deptNorm = dept.replace(/_/g, '[_ ]');
        const deptFilter = [
            { 'timetableData.dept': { $regex: deptNorm, $options: 'i' } },
            { 'timetableData.name': { $regex: deptNorm, $options: 'i' } },
        ];

        const tailGroup = [{ $group: { _id: '$sem' } }, { $sort: { _id: 1 } }];

        // Strategy 1: join via timetable ObjectId ref
        const byRefPipeline = [
            { $lookup: { from: 'timetables', localField: 'timetable', foreignField: '_id', as: 'timetableData' } },
            { $unwind: { path: '$timetableData', preserveNullAndEmptyArrays: false } },
        ];
        // Strategy 2: join via code field (fallback when timetable ObjectId not set on LockSem)
        const byCodePipeline = [
            { $lookup: { from: 'timetables', localField: 'code', foreignField: 'code', as: 'timetableData' } },
            { $unwind: { path: '$timetableData', preserveNullAndEmptyArrays: false } },
        ];

        let records = await LockSem.aggregate([
            ...byRefPipeline,
            { $match: { 'timetableData.currentSession': true, $or: deptFilter } },
            ...tailGroup
        ]);
        if (!records.length) records = await LockSem.aggregate([
            ...byRefPipeline, { $match: { $or: deptFilter } }, ...tailGroup
        ]);
        if (!records.length) records = await LockSem.aggregate([
            ...byCodePipeline,
            { $match: { 'timetableData.currentSession': true, $or: deptFilter } },
            ...tailGroup
        ]);
        if (!records.length) records = await LockSem.aggregate([
            ...byCodePipeline, { $match: { $or: deptFilter } }, ...tailGroup
        ]);

        const sems = records.map(r => r._id).filter(Boolean);
        sems.sort((a, b) => {
            const na = parseInt(a), nb = parseInt(b);
            return (!isNaN(na) && !isNaN(nb)) ? na - nb : String(a).localeCompare(String(b));
        });
        console.log(`[sems-by-dept] dept=${dept} → ${sems.length} sems:`, sems);
        return res.json({ sems });
    } catch (err) {
        console.error('[sems-by-dept] error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── subjects-by-dept-sem: used by EmbeddingGeneration (dept+sem → subjects) ─
// ─── subjects-by-dept-sem: used by EmbeddingGeneration (dept+sem → subjects) ─
LockTimeTableRouter.get('/subjects-by-dept-sem', async (req, res) => {
    try {
        const { dept, sem } = req.query;
        if (!dept || !sem) return res.status(400).json({ error: 'dept and sem are required' });

        const deptNorm = dept.replace(/_/g, '[_ ]');
        const deptFilter = [
            { 'timetableData.dept': { $regex: deptNorm, $options: 'i' } },
            { 'timetableData.name': { $regex: deptNorm, $options: 'i' } },
        ];

        const semMatch = { $match: { sem: sem.toString() } };
        const byRefPipeline = [
            semMatch,
            { $lookup: { from: 'timetables', localField: 'timetable', foreignField: '_id', as: 'timetableData' } },
            { $unwind: { path: '$timetableData', preserveNullAndEmptyArrays: false } },
        ];
        const byCodePipeline = [
            semMatch,
            { $lookup: { from: 'timetables', localField: 'code', foreignField: 'code', as: 'timetableData' } },
            { $unwind: { path: '$timetableData', preserveNullAndEmptyArrays: false } },
        ];
        const subjectTail = [
            { $unwind: '$slotData' },
            { $match: { 'slotData.subject': { $exists: true, $ne: '' } } },
            { $group: { _id: '$slotData.subject' } }, { $sort: { _id: 1 } }
        ];

        let records = await LockSem.aggregate([
            ...byRefPipeline,
            { $match: { 'timetableData.currentSession': true, $or: deptFilter } },
            ...subjectTail
        ]);
        if (!records.length) records = await LockSem.aggregate([
            ...byRefPipeline, { $match: { $or: deptFilter } }, ...subjectTail
        ]);
        if (!records.length) records = await LockSem.aggregate([
            ...byCodePipeline,
            { $match: { 'timetableData.currentSession': true, $or: deptFilter } },
            ...subjectTail
        ]);
        if (!records.length) records = await LockSem.aggregate([
            ...byCodePipeline, { $match: { $or: deptFilter } }, ...subjectTail
        ]);

        const subjects = records.map(r => r._id).filter(Boolean);
        console.log(`[subjects-by-dept-sem] dept=${dept} sem=${sem} → ${subjects.length} subjects`);
        return res.json({ subjects });
    } catch (err) {
        console.error('[subjects-by-dept-sem] error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Debug: what depts exist in timetables, and are LockSem records linked? ────
// Call: GET /timetablemodule/lock/debug-depts
LockTimeTableRouter.get('/debug-depts', async (req, res) => {
    try {
        const timetables = await TimeTable.find({}, 'dept name code currentSession').lean();
        const lockSemCount = await LockSem.countDocuments();
        const lockSemWithTT = await LockSem.countDocuments({ timetable: { $exists: true, $ne: null } });
        const uniqueSems = await LockSem.distinct('sem');
        res.json({
            timetableCount: timetables.length,
            timetables: timetables.map(t => ({ dept: t.dept, name: t.name, code: t.code, currentSession: t.currentSession })),
            lockSemCount,
            lockSemWithTimetableRef: lockSemWithTT,
            uniqueSemsInLockSem: uniqueSems.sort(),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── All unique rooms in LockSem ──────────────────────────────────────────────
LockTimeTableRouter.get('/rooms', async (req, res) => {
    try {
        const rooms = await LockSem.aggregate([
            { $unwind: '$slotData' },
            { $match: { 'slotData.room': { $exists: true, $ne: '' } } },
            { $group: { _id: '$slotData.room' } },
            { $sort: { _id: 1 } }
        ]);
        res.json({ rooms: rooms.map(r => r._id).filter(Boolean) });
    } catch (err) {
        console.error('[rooms] error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = LockTimeTableRouter;