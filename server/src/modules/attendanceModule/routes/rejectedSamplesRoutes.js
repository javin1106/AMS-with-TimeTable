'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs').promises;
const router  = express.Router();

const AcquisitionControl = require('../../../models/acquisitionControl');

const REJECTED_DIR = path.join(__dirname, '..', '..', '..', '..', 'ml-data', 'liveness_rejected');

// must match the whitelist in routes/index.js POST /liveness-rejected
const FILENAME_RE = /^([0-9]{10,17})[A-Za-z0-9_.\-]*\.jpg$/;

function timeStrToMin(t) {
    if (!t || typeof t !== 'string' || !t.includes(':')) return null;
    const [h, m] = t.split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return h * 60 + m;
}

// period isn't in the filename, so derive it from ts_ms + the timetable
function buildPeriodResolver(periods) {
    const table = (periods || [])
        .map((p) => ({ key: p.periodKey, start: timeStrToMin(p.startTime), end: timeStrToMin(p.endTime) }))
        .filter((p) => p.key && p.start != null && p.end != null);

    return (tsMs) => {
        const d = new Date(tsMs);
        const minOfDay = d.getHours() * 60 + d.getMinutes();
        const hit = table.find((p) => minOfDay >= p.start && minOfDay < p.end);
        return hit ? hit.key : 'unknown';
    };
}

async function listRejectedFiles() {
    try {
        return (await fs.readdir(REJECTED_DIR)).filter((f) => FILENAME_RE.test(f));
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
}

router.get('/summary', async (req, res) => {
    try {
        const cfg = await AcquisitionControl.findOne({ profileName: 'default' }).lean();
        const resolvePeriod = buildPeriodResolver(cfg?.periods);

        const files = await listRejectedFiles();
        const counts = new Map();
        for (const f of files) {
            const periodKey = resolvePeriod(Number(FILENAME_RE.exec(f)[1]));
            counts.set(periodKey, (counts.get(periodKey) || 0) + 1);
        }

        const summary = [...counts.entries()]
            .map(([periodKey, count]) => ({ periodKey, count }))
            .sort((a, b) => a.periodKey.localeCompare(b.periodKey));

        res.json(summary);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// periodKey === 'all' returns every crop, unfiltered (powers "View All")
router.get('/:periodKey/samples', async (req, res) => {
    try {
        const { periodKey } = req.params;
        const cfg = await AcquisitionControl.findOne({ profileName: 'default' }).lean();
        const resolvePeriod = buildPeriodResolver(cfg?.periods);

        const files = await listRejectedFiles();
        const matched = periodKey === 'all'
            ? files
            : files.filter((f) => resolvePeriod(Number(FILENAME_RE.exec(f)[1])) === periodKey);

        res.json(matched.map((f) => ({
            filename: f,
            periodKey: resolvePeriod(Number(FILENAME_RE.exec(f)[1])),
            url: `/api/v1/ml/rejected-samples/${periodKey}/image/${f}`,
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/:periodKey/image/:filename', async (req, res) => {
    const { filename } = req.params;
    if (!FILENAME_RE.test(filename) || filename.includes('..')) {
        return res.status(400).end();
    }
    const filePath = path.join(REJECTED_DIR, filename);
    if (!filePath.startsWith(REJECTED_DIR)) return res.status(400).end();
    res.sendFile(filePath, (err) => { if (err) res.status(404).end(); });
});

module.exports = router;
