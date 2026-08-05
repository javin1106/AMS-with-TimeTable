// server/src/modules/attendanceModule/routes/groundTruthRoutes.js

const express = require('express');
const router = express.Router();
const path = require('path');
const mongoose = require('mongoose');
const GroundTruthController = require('../controllers/groundTruthController');
const TimeTable = require('../../../models/timetable');
const ClusterMatch = require('../../../models/attendanceModule/clusterMatch');
const {
    uniqueDepartments,
} = require('../middleware/attendanceAccess');

const controller = new GroundTruthController();

const escapeRegex = (value) =>
    String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const assignedDepartments = (req) => uniqueDepartments([
    req.attendanceDepartment,
    ...(Array.isArray(req.attendanceDepartments) ? req.attendanceDepartments : []),
]);

const batchDepartmentRegexes = (req) => assignedDepartments(req).map(
    (department) => new RegExp(
        `^[^_]+_${escapeRegex(department.trim().replace(/[\s-]+/g, '_'))}_`,
        'i',
    ),
);

const departmentFromBatch = (batch) => {
    const parts = String(batch || '').split('_').filter(Boolean);
    return parts.length >= 3 ? parts.slice(1, -1).join('_') : '';
};


// ─── Ground Truth Management ──────────────────────────────────────

// ─── Fetch departments from timetable/addsem routes ─────────────────
// Returns list of { dept, session, code } from TimeTable collection
// Used by ground truth generation page so batch folder names always match
router.get('/departments', async (req, res) => {
    try {
        const timetableFilter = req.attendanceFullAccess
            ? {}
            : {
                dept: {
                    $in: assignedDepartments(req).map(
                        (department) => new RegExp(`^${escapeRegex(department)}$`, 'i'),
                    ),
                },
            };
        const timetables = await TimeTable.find(timetableFilter, 'dept session code currentSession').lean();
        // Deduplicate by dept (case-insensitive)
        const seen = new Set();
        const depts = [];
        for (const tt of timetables) {
            const key = (tt.dept || '').toUpperCase();
            if (key && !seen.has(key)) {
                seen.add(key);
                depts.push({ dept: tt.dept, session: tt.session, code: tt.code, currentSession: tt.currentSession });
            }
        }
        res.json({ departments: depts });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Ground truth dashboard stats (aggregated from ClusterMatch)
router.get('/stats', async (req, res) => {
    try {
        const match = req.attendanceFullAccess
            ? {}
            : { batch: { $in: batchDepartmentRegexes(req) } };
        const agg = await ClusterMatch.aggregate([{ $match: match }, { $facet: {
            total:     [{ $count: 'n' }],
            approved:  [{ $match: { status: 'approved' } }, { $count: 'n' }],
            matched:   [{ $match: { status: { $in: ['matched', 'approved'] } } }, { $count: 'n' }],
            withEmb:   [{ $match: { 'embeddingFiles.0': { $exists: true } } }, { $count: 'n' }],
            imgSum:    [{ $group: { _id: null, total: { $sum: '$imageCount' } } }],
        }}]);
        const f = agg[0];
        res.json({
            totalClusters: f.total[0]?.n    ?? 0,
            approved:      f.approved[0]?.n  ?? 0,
            matched:       f.matched[0]?.n   ?? 0,
            withEmbedding: f.withEmb[0]?.n   ?? 0,
            totalImages:   f.imgSum[0]?.total ?? 0,
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// List all batches
router.get('/batches', async (req, res) => {
    try { await controller.listBatches(req, res); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// Create a new batch folder
router.post('/create-batch', async (req, res) => {
    try { await controller.createBatch(req, res); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// List students in a batch
router.get('/batches/:batch/students', async (req, res) => {
    try { await controller.listStudents(req, res); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// Serve a photo
router.get('/photo/:batch/:rollNo/:filename', async (req, res) => {
    try { await controller.servePhoto(req, res); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Edit & Delete ────────────────────────────────────────────────

router.delete('/student/:batch/:rollNo', async (req, res) => {
    try { await controller.deleteStudent(req, res); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/photo/:batch/:rollNo/:filename', async (req, res) => {
    try { await controller.deletePhoto(req, res); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Ground Truth Images & Embedding Management ───────────────────

// Get student images split into embedding / backup / untracked
router.get('/student-ground-truth/:batch/:rollNo', async (req, res) => {
    try { await controller.getStudentGroundTruth(req, res); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// Rebuild embedding from manually selected files
router.post('/update-embedding', async (req, res) => {
    try { await controller.updateStudentEmbedding(req, res); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// Approve new photos for a student (adds to approved_files + embedding)
router.post('/approve-photos', async (req, res) => {
    try { await controller.approvePhotos(req, res); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Embeddings & Attendance (Page 4) ─────────────────────────────

router.post('/generate-embeddings', async (req, res) => {
    try { await controller.generateEmbeddings(req, res); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/run-attendance', async (req, res) => {
    try { await controller.runAttendance(req, res); }
    catch (e) { res.status(500).json({ error: e.message }); }
});



// ─── Live RTSP Ground Truth (SSE streaming) ───────────────────────

const axios = require('axios');
const fs    = require('fs');
const { buildExistingFoldersPayload } = require('../controllers/embeddingSyncHelper');
const { checkGroundTruthAllowed } = require('../controllers/timeWindowGuard');

// The ML service may run on a separate machine (e.g. the H100 GPU box) —
// always resolve it from ML_SERVICE_URL, same as every other integration
// point (mlServiceClient.js, mlRoutes.js, cameraController.js, etc.).
// Previously these routes hardcoded hostname/port to 127.0.0.1:8500, which
// silently ignored ML_SERVICE_URL and broke as soon as the service moved
// off the Node host.
const rawMlUrl = process.env.ML_SERVICE_URL || 'http://localhost:8500';
const ML_SERVICE_URL = /^https?:\/\//i.test(rawMlUrl) ? rawMlUrl : `http://${rawMlUrl}`;

const GT_BASE_DIR = path.join(__dirname, '..', '..', '..', '..', 'ml-data', 'ground_truth');

// The disk writer and the set of internally-handled SSE event types now live
// in the acquisition manager, shared between the legacy browser-driven
// /extract-rtsp-stream path (below) and the server-persistent gt-acquisition/*
// jobs — so both write ground-truth files identically.
const gtManager = require('../controllers/gtAcquisitionManager');
const { handleGroundTruthEvent, GT_INTERNAL } = gtManager;
const getUserDetails = require('../../usermanagement/controllers/dto');

router.post('/extract-rtsp-stream', async (req, res) => {
    // Optional 08:30–17:30 IST restriction (admin toggle, default off).
    const gate = await checkGroundTruthAllowed();
    if (!gate.allowed) {
        return res.status(403).json({ error: gate.reason });
    }

    const batch           = req.body.batch || '';
    const existingFolders = buildExistingFoldersPayload(path.join(GT_BASE_DIR, batch));
    const body            = { ...req.body, existingFolders };
    const pythonFolderMap = {};   // person_XXX → ObjectId string, scoped to this stream

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let proxyRes;
    try {
        proxyRes = await axios.post(`${ML_SERVICE_URL}/extract-rtsp-stream`, body, {
            responseType: 'stream',
            timeout: 0,   // long-lived stream — runs until the client stops it
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (err) {
        console.error('RTSP proxy error:', err.message);
        if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ type: 'error', message: 'ML service unavailable' })}\n\n`);
            res.end();
        }
        return;
    }

    let buffer = '';

    proxyRes.data.on('data', (chunk) => {
        buffer += chunk.toString();

        // Process complete SSE events (each terminated by \n\n)
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const eventText = buffer.substring(0, boundary + 2);
            buffer = buffer.substring(boundary + 2);

            const dataLine = eventText.trimEnd();
            if (!dataLine.startsWith('data: ')) {
                if (!res.writableEnded) res.write(eventText);
                continue;
            }

            let event = null;
            try { event = JSON.parse(dataLine.slice(6)); } catch {}

            if (event && GT_INTERNAL.has(event.type)) {
                handleGroundTruthEvent(event, batch, pythonFolderMap);
            } else {
                if (!res.writableEnded) res.write(eventText);
            }
        }
    });

    proxyRes.data.on('end', () => {
        if (buffer && !res.writableEnded) res.write(buffer);
        if (!res.writableEnded) res.end();
    });

    proxyRes.data.on('error', (err) => {
        console.error('ML stream error:', err.message);
        if (!res.writableEnded) res.end();
    });

    // Only destroy the upstream stream when the response is closed
    res.on('close', () => {
        console.log('Response closed — aborting ML stream');
        proxyRes.data.destroy();
    });
});

router.post('/stop-rtsp-stream', async (req, res) => {
    try {
        const result = await axios.post(`${ML_SERVICE_URL}/stop-rtsp-stream`, req.body || {}, { timeout: 10000 });
        res.json(result.data);
    } catch (err) {
        console.error('Stop proxy error:', err.message);
        res.status(502).json({ error: 'ML service unavailable' });
    }
});

router.get('/rtsp-preview', async (req, res) => {
    const jobId = req.query.jobId;
    try {
        // Must hit the ML service's /gt-acquisition-preview, not /rtsp-preview —
        // that path is a *different* preview system (Camera Live Preview,
        // ground_truth_routes.py's own _previews dict) which happens to shadow
        // this module's route since it's registered first in ml_service.py.
        // This jobId only exists in rtsp_routes.py's _jobs registry, so hitting
        // the shadowed /rtsp-preview always 404/503'd against the wrong dict.
        const result = await axios.get(`${ML_SERVICE_URL}/gt-acquisition-preview`, {
            params: jobId ? { jobId } : undefined,
            responseType: 'stream',
            timeout: 0,   // long-lived MJPEG stream
        });
        res.setHeader('Content-Type', result.headers['content-type'] || 'multipart/x-mixed-replace; boundary=frame');
        res.setHeader('Cache-Control', 'no-cache');
        result.data.pipe(res);
        result.data.on('error', () => { if (!res.writableEnded) res.end(); });
        req.on('close', () => result.data.destroy());
    } catch (err) {
        if (!res.writableEnded) res.status(502).end();
    }
});

router.post('/start-preview', async (req, res) => {
    try {
        const result = await axios.post(`${ML_SERVICE_URL}/start-preview`, req.body, { timeout: 15000 });
        res.json(result.data);
    } catch (err) {
        console.error('start-preview proxy error:', err.message);
        res.status(502).json({ error: 'ML service unavailable' });
    }
});

// ─── Server-persistent Ground Truth acquisition (gtAcquisitionManager) ────────
// Unlike /extract-rtsp-stream (which dies when the browser tab closes), these
// jobs run on the server until Stop or the 60-minute ceiling. The browser
// starts a job, attaches to observe it, and can reattach after a reload.

async function resolveStartedByName(req) {
    if (req.user?.email) return req.user.email;
    try {
        const u = await getUserDetails(req.user.id);
        return u?.email || String(req.user.id);
    } catch (_) {
        return String(req.user?.id || 'user');
    }
}

// The route-specific guard mounted on /ground-truth accepts only departments
// assigned to this user's Ground Truth / Roll Assignment dropdown.
router.post('/gt-acquisition/start', async (req, res) => {
    const gate = await checkGroundTruthAllowed();
    if (!gate.allowed) return res.status(403).json({ error: gate.reason });

    const {
        mode = 'single', batch, cameras,
        detSize, frameSkip, targetImgsPerPerson, minSamples, clusterThreshold,
    } = req.body || {};

    if (!batch) return res.status(400).json({ error: 'batch is required' });
    if (!Array.isArray(cameras) || cameras.length === 0)
        return res.status(400).json({ error: 'cameras[] is required' });
    if (!cameras.every(c => c && c.url))
        return res.status(400).json({ error: 'every camera needs a url' });

    const { acquisitionId } = gtManager.startAcquisition({
        mode,
        batch,
        cameras,
        // Omitted values stay undefined (dropped from the JSON body) so the
        // ML service seeds them from the GT Acquisition config (ML Fine
        // Tuning page) and reports the fallback via a gt_config_seeded event.
        params: {
            detSize:             Number(detSize)             || undefined,
            frameSkip:           Number(frameSkip)           || undefined,
            targetImgsPerPerson: Number(targetImgsPerPerson) || undefined,
            minSamples:          Number(minSamples)          || undefined,
            clusterThreshold:    Number(clusterThreshold)    || undefined,
        },
        startedByName: await resolveStartedByName(req),
        department:    departmentFromBatch(batch),
    });

    res.json({ acquisitionId });
});

// List running/recent jobs the caller may see — used on page load to show
// active acquisitions (elapsed time + per-person counts) and reattach.
router.get('/gt-acquisition/status', (req, res) => {
    res.json({
        jobs: gtManager.listJobs({
            departments: assignedDepartments(req),
            fullAccess:  req.attendanceFullAccess,
        }),
    });
});

// Live SSE feed for one job: emits a `snapshot` immediately, then streams
// updates. Detaching (tab close/reload) never affects the job.
router.get('/gt-acquisition/stream', (req, res) => {
    const { acquisitionId } = req.query;
    if (!acquisitionId) return res.status(400).json({ error: 'acquisitionId is required' });

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    gtManager.attachStream(acquisitionId, res);
});

// Live MJPEG preview for one acquisition. Unlike /rtsp-preview (bound to a
// single Python sub-run jobId that dies on every camera switch), this follows
// job.pythonJobId across sub-runs: when a camera's stream ends, it silently
// reconnects to the next camera's Python job and keeps piping into the SAME
// response — the browser <img> never breaks, so no flicker on switches and
// the preview always shows the camera currently acquiring.
router.get('/gt-acquisition/preview', async (req, res) => {
    const { acquisitionId } = req.query;
    if (!acquisitionId) return res.status(400).json({ error: 'acquisitionId is required' });
    if (!gtManager.getJob(acquisitionId))
        return res.status(404).json({ error: 'Acquisition not found or expired' });

    res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    let closed       = false;
    let upstream     = null;
    let pipedAny     = false;   // did we ever forward a single byte to the browser?
    let failStreak   = 0;       // consecutive upstream failures with no bytes since
    let drainedJobId = null;    // sub-run whose preview has already run dry
    req.on('close', () => {
        closed = true;
        if (upstream) upstream.destroy();
    });

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // A sub-run needs a moment to register its Python jobId, so a few early
    // failures are normal. But a *persistent* failure (e.g. the ML service being
    // unreachable, or serving code without /gt-acquisition-preview) must not loop
    // silently forever — it presents to the user as an eternal "Connecting to
    // stream…". After this many consecutive failures without ever having streamed
    // a byte, give up so the browser <img> fires onError and the UI can surface it.
    const MAX_FAIL_STREAK = 8;

    while (!closed) {
        const job = gtManager.getJob(acquisitionId);
        if (!job || (job.status !== 'running' && job.status !== 'stopping')) break;

        // Between sub-runs there is no Python job yet — wait for the next one.
        const pyJobId = job.pythonJobId;
        if (!pyJobId) { await sleep(500); continue; }

        // Python sets its job's stop flag when the *capture* loop ends, but Node
        // clears job.pythonJobId only when the SSE stream ends — and that stays
        // open through the clustering/save phase that follows. So for the whole
        // tail of every sub-run this id still points at a preview that hands back
        // an empty stream. Reconnecting to it just spins (~3 req/s until the ML
        // service drops the entry, then 404s); wait for the next camera's id.
        if (pyJobId === drainedJobId) { await sleep(500); continue; }

        let bytesThisRun = 0;
        try {
            // /gt-acquisition-preview, NOT /rtsp-preview: the latter resolves to
            // ground_truth_routes.py's camera-preview streams (its router is
            // registered first) and knows nothing about acquisition jobIds.
            const result = await axios.get(`${ML_SERVICE_URL}/gt-acquisition-preview`, {
                params:       { jobId: pyJobId },
                responseType: 'stream',
                timeout:      0,
            });
            upstream = result.data;
            failStreak = 0;
            await new Promise((resolve) => {
                upstream.on('data', (chunk) => {
                    if (closed) return;
                    res.write(chunk);
                    bytesThisRun += chunk.length;
                    pipedAny = true;
                });
                upstream.on('end',   resolve);
                upstream.on('error', resolve);
            });
            upstream = null;
            // Ended without a single frame → Python's generator exited straight
            // away because this sub-run is already stopping. Nothing more will
            // ever come from this id.
            if (bytesThisRun === 0) drainedJobId = pyJobId;
            // Brief pause so we don't hammer the ML service while the next
            // sub-run's jobId is being set up.
            await sleep(300);
        } catch (err) {
            upstream = null;
            const status = err.response?.status;
            // A 404 once frames have been flowing just means the ML service has
            // dropped this sub-run's entry — routine at the tail of a camera
            // switch, not an error worth logging. Before the first frame it is a
            // real problem, so let it fall through to the give-up path below.
            if (status === 404 && pipedAny) { drainedJobId = pyJobId; continue; }

            console.warn(
                `[gt-acquisition/preview] upstream error for pyJobId=${pyJobId} ` +
                `(acquisition ${acquisitionId}): ${status || err.code || err.message}`
            );
            if (!pipedAny && ++failStreak >= MAX_FAIL_STREAK) {
                console.error(
                    `[gt-acquisition/preview] giving up after ${failStreak} consecutive ` +
                    `failures with no frames streamed (acquisition ${acquisitionId}). ` +
                    `Check that python-ml-service is reachable at ${ML_SERVICE_URL} and ` +
                    `serves /gt-acquisition-preview.`
                );
                break;
            }
            await sleep(1000);
        }
    }
    if (!res.writableEnded) res.end();
});

router.post('/gt-acquisition/stop', async (req, res) => {
    const { acquisitionId } = req.body || {};
    if (!acquisitionId) return res.status(400).json({ error: 'acquisitionId is required' });
    const result = await gtManager.stopAcquisition(acquisitionId);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
});

module.exports = router;
