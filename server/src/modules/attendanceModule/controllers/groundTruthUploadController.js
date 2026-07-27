// server/src/modules/attendanceModule/controllers/groundTruthUploadController.js

const path       = require('path');
const fs         = require('fs');
const fsPromises = require('fs').promises;
const JSZip      = require('jszip');
const crypto     = require('crypto');
const Batch      = require('../../../models/attendanceModule/batch');
const erpSync    = require('./erpEmbeddingSyncHelper');

// ─── Constants ────────────────────────────────────────────────────────────────
const ERP_PHOTOS_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'ml-data', 'erp_photos');

const MAX_FILES_IN_ZIP  = 500;
const MAX_IMAGE_SIZE    = 10 * 1024 * 1024;   // 10 MB per image
const MAX_TOTAL_SIZE    = 100 * 1024 * 1024;  // 100 MB cumulative extracted

// ─── Magic byte signatures for image validation ──────────────────────────────
const IMAGE_SIGNATURES = {
    jpg:  [0xFF, 0xD8, 0xFF],
    jpeg: [0xFF, 0xD8, 0xFF],
    png:  [0x89, 0x50, 0x4E, 0x47],
    webp: [0x52, 0x49, 0x46, 0x46],  // RIFF header
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

ensureDir(ERP_PHOTOS_DIR);

/**
 * Sanitizes a batch name.
 * Strips whitespace; rejects empty values.
 * Path traversal is caught downstream by assertInsideRoot().
 */
function sanitizeBatch(batch) {
    if (!batch) throw new Error('Batch name is required');
    const normalized = String(batch).trim();
    if (!normalized) throw new Error('Batch name is required');
    return normalized;
}

/**
 * Sanitizes a roll number.
 * Trims and uppercases; rejects empty values.
 * Path traversal is caught downstream by assertInsideRoot().
 */
function sanitizeRollNo(rollNo) {
    const normalized = String(rollNo || '').trim().toUpperCase();
    if (!normalized) throw new Error('Invalid roll number');
    return normalized;
}

/**
 * Ensures a resolved path stays inside the ERP_PHOTOS_DIR root.
 * Prevents any path traversal that slips past sanitization.
 * Fixes: MED-3 / CRITICAL-1 (filesystem safety via resolve checks)
 */
function assertInsideRoot(targetPath) {
    const resolved = path.resolve(targetPath);
    const root     = path.resolve(ERP_PHOTOS_DIR);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
        throw new Error('Path escapes erp_photos directory');
    }
    return resolved;
}

/**
 * Validates that a buffer contains a real image by checking magic bytes.
 * Fixes: MED-1 (magic byte / MIME spoofing)
 */
function isValidImage(buffer, ext) {
    const key = ext.replace('.', '').toLowerCase();
    const signature = IMAGE_SIGNATURES[key];
    if (!signature) return false;
    if (buffer.length < signature.length) return false;
    return signature.every((byte, i) => buffer[i] === byte);
}

// ─── Find pkl path for a batch (saved under {dept}/{batch}/) ────────────────
// Delegates the path formula to erpEmbeddingSyncHelper so the Roll Assignment
// page's availability check and this one can never disagree.
// Was an open-coded copy of the same two candidates erpSync searches (dept-nested
// path, then the pre-department flat one). Delegating keeps this page and the
// Roll Assignment page from ever drifting on *which* pkl a batch resolves to.
const findEmbeddingPkl = (batchName) => erpSync.findErpPkl(batchName);

// ─── Background embedding jobs ────────────────────────────────────────────────
// Embedding generation runs after the HTTP response is sent — it calls the ML
// service per photo and can take minutes — so the POST's status code says only
// "queued", never "worked". Callers used to assume success and tell the
// operator "Embeddings created successfully" while the run was still going (or
// had already failed with nothing but a server log to show for it). Track each
// batch's run here and expose it via GET /embedding-status/:batch so the UI can
// report what actually happened.
const embeddingJobs = new Map();   // lower-cased batch → job

const jobKey = (batch) => String(batch || '').trim().toLowerCase();

function peekEmbeddingJob(batch) {
    return embeddingJobs.get(jobKey(batch)) || null;
}

function getEmbeddingJob(batch) {
    const key = jobKey(batch);
    let job = embeddingJobs.get(key);
    if (!job) {
        job = {
            batch, state: 'idle', queued: 0, processed: 0, skipped: [],
            error: null, startedAt: null, finishedAt: null,
            chain: Promise.resolve(),
        };
        embeddingJobs.set(key, job);
    }
    return job;
}

// Every unit of work reads the current .pkl, merges, and writes it back, so two
// running at once each clobber the other's students. Callers used to fire one
// per 1000-roll chunk — and one per roll number on delete-all — all in
// parallel, leaving only the last writer's result on disk. Chaining them keeps
// the file consistent and gives the job a single well-defined finish.
function enqueueEmbeddingWork(batch, label, work) {
    const job = getEmbeddingJob(batch);

    if (job.state !== 'running') {
        job.state      = 'running';
        job.startedAt  = Date.now();
        job.finishedAt = null;
        job.processed  = 0;
        job.skipped    = [];
        job.error      = null;
    }
    job.queued++;

    job.chain = job.chain.then(async () => {
        const reqId = crypto.randomUUID();
        try {
            const result = await work();
            job.processed += result?.processed || 0;
            if (Array.isArray(result?.skipped)) {
                job.skipped.push(...result.skipped);
            }
        } catch (err) {
            job.error = err.message;
            console.error(`[GT Upload] [${reqId}] Embedding ${label} failed for batch=${batch}:`, err.message);
        } finally {
            job.queued--;
            if (job.queued === 0) {
                job.state      = job.error ? 'error' : 'done';
                job.finishedAt = Date.now();
            }
        }
    });

    return job;
}

// ─── Trigger Async Background Sync ────────────────────────────────────────────
// The ML service is stateless — it never reads erp_photos/ or writes the
// .pkl itself. This reads the relevant photo bytes (and the existing .pkl,
// for sync) here, sends them to Python, and persists whatever comes back.
// Still fire-and-forget from the caller's perspective (it returns as soon as
// the work is queued), but the returned job now records the outcome.
function triggerEmbeddingSync(action, payload) {
    const department = erpSync.departmentFromBatch(payload.batch);

    return enqueueEmbeddingWork(payload.batch, action, async () => {
        if (action === 'sync') {
            const result = await erpSync.syncErpEmbeddings(payload.batch, department, payload.roll_nos || []);
            // A missing photo folder means nothing can be embedded — that is a
            // failed run, not a no-op, so surface it instead of reporting done.
            if (result.status === 'skipped') {
                throw new Error(result.reason || 'ERP photos folder not found');
            }
            return result;
        }
        if (action === 'rename') {
            // rename/delete legitimately no-op when no .pkl exists yet.
            return erpSync.renameErpEmbedding(payload.batch, department, payload.old_roll_no, payload.new_roll_no);
        }
        if (action === 'delete') {
            return erpSync.deleteErpEmbedding(payload.batch, department, payload.roll_no);
        }
        return null;
    });
}

// Queues one sync per chunk. Chunks run one after another (see
// enqueueEmbeddingWork) and share a single job, so the caller can hand the
// returned startedAt to the client as a handle on the whole run.
function queueEmbeddingSync(batch, rollNos) {
    const CHUNK = 1000;
    if (!rollNos.length) {
        // Nothing to embed (e.g. the last photo was just deleted). Still record
        // a completed run so a client waiting on this batch isn't left hanging.
        return enqueueEmbeddingWork(batch, 'sync', async () => ({ processed: 0, skipped: [] }));
    }
    let job;
    for (let i = 0; i < rollNos.length; i += CHUNK) {
        job = triggerEmbeddingSync('sync', { batch, roll_nos: rollNos.slice(i, i + CHUNK) });
    }
    return job;
}

// ─── Controller ───────────────────────────────────────────────────────────────

class GroundTruthUploadController {

    // ─── Upload Batch ZIP ─────────────────────────────────────────────────
    async uploadBatchZip(req, res) {
        try {
            // ── Input validation ──────────────────────────────────────────
            const batch = sanitizeBatch(req.params.batch);
            if (!req.file) return res.status(400).json({ error: 'ZIP file is required' });

            const batchPath = erpSync.erpPhotoDir(batch);
            assertInsideRoot(batchPath);
            ensureDir(batchPath);

            // ── Clear old contents if replacing ───────────────────────────
            if (req.query.replace === 'true') {
                const pklPath = findEmbeddingPkl(batch);
                if (pklPath) {
                    await fsPromises.unlink(pklPath);
                }
                console.log(`[GT Upload] Replaced existing embeddings database for batch=${batch}`);
            }

            // ── Parse ZIP ─────────────────────────────────────────────────
            const zip = await JSZip.loadAsync(req.file.buffer);

            // ── ZIP bomb protection: entry count ──────────────────────────
            const allEntries = Object.keys(zip.files).filter(k => !zip.files[k].dir);
            if (allEntries.length > MAX_FILES_IN_ZIP) {
                return res.status(400).json({
                    error: `ZIP contains too many files (${allEntries.length}). Maximum allowed: ${MAX_FILES_IN_ZIP}`
                });
            }

            let extractedImagesCount = 0;
            let totalExtractedBytes  = 0;
            let targetFolders   = new Set();
            let clearedFolders  = new Set();
            let errors          = [];

            // ── Extract images ────────────────────────────────────────────
            for (const relativePath of allEntries) {
                const zipEntry = zip.files[relativePath];

                // Skip macOS artifacts and hidden files
                const filenameRaw = relativePath.split('/').pop();
                if (relativePath.includes('__MACOSX') || filenameRaw.startsWith('.')) {
                    continue;
                }

                // Extension check
                if (!/\.(jpg|jpeg|png|webp)$/i.test(filenameRaw)) {
                    errors.push(`Skipped non-image file: ${filenameRaw}`);
                    continue;
                }

                // Extract roll number from filename
                const ext       = path.extname(filenameRaw);
                const rollNoRaw = path.basename(filenameRaw, ext);

                let rollNo;
                try {
                    rollNo = sanitizeRollNo(rollNoRaw);
                } catch (_) {
                    errors.push(`Invalid roll number in filename: ${filenameRaw}`);
                    continue;
                }

                // Enforce 1 photo per roll number
                if (clearedFolders.has(rollNo)) {
                    continue;
                }

                try {
                    // Decompress and validate size
                    const buffer = await zipEntry.async('nodebuffer');

                    if (buffer.length > MAX_IMAGE_SIZE) {
                        errors.push(`${filenameRaw} exceeds max size (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);
                        continue;
                    }

                    totalExtractedBytes += buffer.length;
                    if (totalExtractedBytes > MAX_TOTAL_SIZE) {
                        errors.push('ZIP total decompressed size exceeds limit. Stopping extraction.');
                        break;
                    }

                    // Magic byte validation
                    if (!isValidImage(buffer, ext)) {
                        errors.push(`${filenameRaw} is not a valid image file (failed signature check)`);
                        continue;
                    }

                    // Delete existing photos for this student
                    const existingFiles = await fsPromises.readdir(batchPath);
                    for (const f of existingFiles) {
                        const fExt = path.extname(f);
                        const fRollNo = path.basename(f, fExt);
                        if (fRollNo.toUpperCase() === rollNo) {
                            const filePath = path.join(batchPath, f);
                            try {
                                await fsPromises.unlink(filePath);
                            } catch (unlinkErr) {
                                if (unlinkErr.code === 'EBUSY' || unlinkErr.code === 'EPERM') {
                                    console.warn(`[GT Upload] File locked, retrying unlink: ${filePath}`);
                                    await new Promise(r => setTimeout(r, 200));
                                    try {
                                        await fsPromises.unlink(filePath);
                                    } catch (e2) {
                                        if (fExt.toLowerCase() !== ext) {
                                            throw new Error(`File locked by another process.`);
                                        }
                                    }
                                } else {
                                    throw unlinkErr;
                                }
                            }
                        }
                    }
                    clearedFolders.add(rollNo);

                    // Write the new photo
                    const targetFilename = `${rollNo}${ext.toLowerCase()}`;
                    const targetPath     = path.join(batchPath, targetFilename);
                    assertInsideRoot(targetPath);

                    await fsPromises.writeFile(targetPath, buffer);

                    targetFolders.add(rollNo);
                    extractedImagesCount++;
                } catch (e) {
                    errors.push(`Failed to extract ${filenameRaw}: processing error`);
                    console.error(`[GT Upload] ZIP entry error for ${filenameRaw}:`, e);
                }
            }

            console.log(`[GT Upload] ZIP processed for batch=${batch}: ${extractedImagesCount} images, ${targetFolders.size} students`);

            // Queue before responding — queueing is synchronous, the work still
            // runs in the background — so the client gets the job handle it
            // needs to wait for the real outcome.
            const job = queueEmbeddingSync(batch, Array.from(targetFolders));

            res.json({
                message: 'ZIP extraction complete',
                extractedFolders: targetFolders.size,
                extractedImages: extractedImagesCount,
                embeddingJobStartedAt: job.startedAt,
                errors: errors.length ? errors : undefined
            });

        } catch (err) {
            if (err.message === 'Invalid batch name' || err.message === 'Batch name is required') {
                return res.status(400).json({ error: err.message });
            }
            console.error('[GT Upload] ZIP extraction error:', err);
            res.status(500).json({ error: 'Failed to process ZIP file' });
        }
    }

    // ─── Upload Individual Student Photo ──────────────────────────────────
    async uploadStudentPhoto(req, res) {
        try {
            // ── Input validation ──────────────────────────────────────────
            const batch      = sanitizeBatch(req.params.batch);
            const safeRollNo = sanitizeRollNo(req.params.rollNo);

            if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });

            const batchPath = erpSync.erpPhotoDir(batch);
            assertInsideRoot(batchPath);
            ensureDir(batchPath);

            // ── Validate file content ─────────────────────────────────────
            const ext = path.extname(req.file.originalname).toLowerCase();
            if (!/^\.(jpg|jpeg|png|webp)$/.test(ext)) {
                return res.status(400).json({ error: 'Only JPG, PNG, and WEBP images are accepted' });
            }

            if (!isValidImage(req.file.buffer, ext)) {
                return res.status(400).json({ error: 'File does not appear to be a valid image' });
            }

            // ── Delete previous photos ────────────────────────────────────
            const existingFiles = await fsPromises.readdir(batchPath);
            for (const f of existingFiles) {
                const fExt = path.extname(f);
                const fRollNo = path.basename(f, fExt);
                if (fRollNo.toUpperCase() === safeRollNo) {
                    const filePath = path.join(batchPath, f);
                    try {
                        await fsPromises.unlink(filePath);
                    } catch (unlinkErr) {
                        if (unlinkErr.code === 'EBUSY' || unlinkErr.code === 'EPERM') {
                            console.warn(`[GT Upload] File locked, retrying unlink: ${filePath}`);
                            await new Promise(r => setTimeout(r, 200));
                            try {
                                await fsPromises.unlink(filePath);
                            } catch (e2) {
                                console.error(`[GT Upload] Unlink failed again for ${filePath}`);
                                if (fExt.toLowerCase() !== ext) {
                                    throw new Error(`File is locked by another process (e.g. ML Service) and cannot be replaced.`);
                                }
                            }
                        } else {
                            throw unlinkErr;
                        }
                    }
                }
            }

            // ── Write new photo ───────────────────────────────────────────
            const targetFilename = `${safeRollNo}${ext}`;
            const targetPath     = path.join(batchPath, targetFilename);
            assertInsideRoot(targetPath);

            await fsPromises.writeFile(targetPath, req.file.buffer);

            console.log(`[GT Upload] Photo uploaded: batch=${batch} rollNo=${safeRollNo} file=${targetFilename}`);

            const job = triggerEmbeddingSync('sync', {
                batch: batch,
                roll_nos: [safeRollNo]
            });

            res.json({
                message: 'Photo uploaded successfully',
                rollNo: safeRollNo,
                imagesAdded: 1,
                embeddingJobStartedAt: job.startedAt
            });

        } catch (err) {
            if (err.message === 'Invalid batch name' || err.message === 'Invalid roll number') {
                return res.status(400).json({ error: err.message });
            }
            console.error('[GT Upload] Photo upload error:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }

    // ─── Rename Student Folder ────────────────────────────────────────────
    async renameStudent(req, res) {
        try {
            // ── Input validation ──────────────────────────────────────────
            const batch         = sanitizeBatch(req.body.batch);
            const safeOldRollNo = sanitizeRollNo(req.body.oldRollNo);
            const safeNewRollNo = sanitizeRollNo(req.body.newRollNo);

            if (safeOldRollNo === safeNewRollNo) {
                return res.json({ message: 'Roll number is unchanged', rollNo: safeNewRollNo });
            }

            const batchPath = erpSync.erpPhotoDir(batch);
            assertInsideRoot(batchPath);
            
            if (!fs.existsSync(batchPath)) {
                return res.status(404).json({ error: 'Batch folder not found' });
            }

            const existingFiles = await fsPromises.readdir(batchPath);
            
            let oldPhotoFile = null;
            let oldExt = '';
            
            for (const f of existingFiles) {
                const ext = path.extname(f);
                const roll = path.basename(f, ext);
                if (roll.toUpperCase() === safeOldRollNo) {
                    oldPhotoFile = f;
                    oldExt = ext;
                    break;
                }
            }

            if (!oldPhotoFile) {
                return res.status(404).json({ error: 'Original student photo not found' });
            }

            for (const f of existingFiles) {
                const ext = path.extname(f);
                const roll = path.basename(f, ext);
                if (roll.toUpperCase() === safeNewRollNo) {
                    return res.status(409).json({ error: `Destination photo for ${safeNewRollNo} already exists` });
                }
            }

            const srcPath = path.join(batchPath, oldPhotoFile);
            const destPath = path.join(batchPath, `${safeNewRollNo}${oldExt.toLowerCase()}`);
            assertInsideRoot(srcPath);
            assertInsideRoot(destPath);

            await fsPromises.rename(srcPath, destPath);

            console.log(`[GT Upload] Rename: batch=${batch} ${oldPhotoFile} -> ${safeNewRollNo}${oldExt.toLowerCase()}`);

            const job = triggerEmbeddingSync('rename', {
                batch: batch,
                old_roll_no: safeOldRollNo,
                new_roll_no: safeNewRollNo
            });

            res.json({
                message: `Successfully renamed ${safeOldRollNo} to ${safeNewRollNo}`,
                oldRollNo: safeOldRollNo,
                newRollNo: safeNewRollNo,
                embeddingJobStartedAt: job.startedAt
            });

        } catch (err) {
            if (err.message === 'Invalid batch name' || err.message === 'Invalid roll number' ||
                err.message === 'Batch name is required') {
                return res.status(400).json({ error: err.message });
            }
            console.error('[GT Upload] Rename error:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }

    // ─── Delete Student Photo ───────────────────────────────────────────────
    async deletePhoto(req, res) {
        try {
            const batch = sanitizeBatch(req.params.batch);
            const safeRollNo = sanitizeRollNo(req.params.rollNo);

            const batchPath = erpSync.erpPhotoDir(batch);
            assertInsideRoot(batchPath);

            if (!fs.existsSync(batchPath)) {
                return res.status(404).json({ error: 'Batch folder not found' });
            }

            const existingFiles = await fsPromises.readdir(batchPath);
            let photoDeleted = false;

            for (const f of existingFiles) {
                const ext = path.extname(f);
                const roll = path.basename(f, ext);
                if (roll.toUpperCase() === safeRollNo) {
                    const filePath = path.join(batchPath, f);
                    assertInsideRoot(filePath);
                    await fsPromises.unlink(filePath);
                    photoDeleted = true;
                }
            }

            if (!photoDeleted) {
                return res.status(404).json({ error: 'Photo not found' });
            }

            console.log(`[GT Upload] Delete: batch=${batch} rollNo=${safeRollNo}`);

            const job = triggerEmbeddingSync('delete', {
                batch: batch,
                roll_no: safeRollNo
            });

            res.json({
                message: 'Photo deleted successfully',
                rollNo: safeRollNo,
                embeddingJobStartedAt: job.startedAt
            });

        } catch (err) {
            if (err.message === 'Invalid batch name' || err.message === 'Invalid roll number' || err.message === 'Batch name is required') {
                return res.status(400).json({ error: err.message });
            }
            console.error('[GT Upload] Delete error:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }

    // ─── Delete ALL photos in a batch ───────────────────────────────────
    async deleteAllPhotos(req, res) {
        try {
            const batch = sanitizeBatch(req.params.batch);
            const batchPath = erpSync.erpPhotoDir(batch);
            assertInsideRoot(batchPath);

            if (!fs.existsSync(batchPath)) {
                return res.status(404).json({ error: 'Batch folder not found' });
            }

            const existingFiles = await fsPromises.readdir(batchPath);
            const deletedRollNos = [];

            for (const f of existingFiles) {
                const ext = path.extname(f);
                if (!/^\.(jpg|jpeg|png|webp)$/i.test(ext)) continue;
                const roll = path.basename(f, ext);
                const filePath = path.join(batchPath, f);
                assertInsideRoot(filePath);
                await fsPromises.unlink(filePath);
                deletedRollNos.push(roll.toUpperCase());
            }

            if (deletedRollNos.length === 0) {
                return res.status(404).json({ error: 'No photos found for this batch' });
            }

            console.log(`[GT Upload] Delete ALL: batch=${batch} count=${deletedRollNos.length}`);

            let job;
            for (const roll_no of deletedRollNos) {
                job = triggerEmbeddingSync('delete', { batch, roll_no });
            }

            res.json({
                message: `Deleted ${deletedRollNos.length} photo(s)`,
                deletedCount: deletedRollNos.length,
                embeddingJobStartedAt: job?.startedAt || null,
            });

        } catch (err) {
            if (err.message === 'Invalid batch name' || err.message === 'Batch name is required') {
                return res.status(400).json({ error: err.message });
            }
            console.error('[GT Upload] Delete all error:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }

    // ─── Force Sync All ───────────────────────────────────────────────
    async syncAll(req, res) {
        try {
            const batch = sanitizeBatch(req.params.batch);
            const batchPath = erpSync.erpPhotoDir(batch);
            assertInsideRoot(batchPath);

            let roll_nos = [];
            if (fs.existsSync(batchPath)) {
                const existingFiles = await fsPromises.readdir(batchPath);
                for (const f of existingFiles) {
                    const ext = path.extname(f);
                    const roll = path.basename(f, ext);
                    if (/^\.(jpg|jpeg|png|webp)$/i.test(ext)) {
                        roll_nos.push(roll.toUpperCase());
                    }
                }
            }

            // Respond as soon as the work is queued — the run itself can take
            // minutes. startedAt is the client's handle for polling it.
            const job = queueEmbeddingSync(batch, roll_nos);

            res.json({
                message: `Triggered sync for ${roll_nos.length} photos`,
                photosCount: roll_nos.length,
                embeddingJobStartedAt: job.startedAt
            });

        } catch (err) {
            console.error('[GT Upload] syncAll error:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }

    // ─── List Photos in a Batch ───────────────────────────────────────
    async listPhotos(req, res) {
        try {
            const batch = sanitizeBatch(req.params.batch);
            const batchPath = erpSync.erpPhotoDir(batch);
            assertInsideRoot(batchPath);

            if (!fs.existsSync(batchPath)) {
                return res.json({ rollNos: [], count: 0, batch });
            }

            const files = await fsPromises.readdir(batchPath);
            const rollNos = files
                .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
                .map(f => ({ rollNo: path.basename(f, path.extname(f)).toUpperCase(), ext: path.extname(f).toLowerCase() }))
                .sort((a, b) => a.rollNo.localeCompare(b.rollNo));

            res.json({ rollNos, count: rollNos.length, batch });
        } catch (err) {
            if (err.message === 'Invalid batch name' || err.message === 'Batch name is required') {
                return res.status(400).json({ error: err.message });
            }
            console.error('[GT Upload] listPhotos error:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }

    // ─── Summary of All ERP Photo Batches ────────────────────────────
    async listAllBatches(req, res) {
        try {
            if (!fs.existsSync(ERP_PHOTOS_DIR)) {
                return res.json({ batches: [] });
            }

            const entries = await fsPromises.readdir(ERP_PHOTOS_DIR, { withFileTypes: true });
            const batches = [];

            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const batchPath = path.join(ERP_PHOTOS_DIR, entry.name);
                const files = await fsPromises.readdir(batchPath);
                const count = files.filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f)).length;
                const pklPath = findEmbeddingPkl(entry.name);
                let hasEmbedding = false, embeddingUpdatedAt = null;
                if (pklPath) {
                    hasEmbedding = true;
                    try { embeddingUpdatedAt = fs.statSync(pklPath).mtime; } catch (_) {}
                }
                batches.push({ batch: entry.name, count, hasEmbedding, embeddingUpdatedAt });
            }

            batches.sort((a, b) => a.batch.localeCompare(b.batch));
            res.json({ batches });
        } catch (err) {
            console.error('[GT Upload] listAllBatches error:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }

    // ─── Check if ERP pkl exists (filesystem only, no ML call) ───────
    async checkEmbedding(req, res) {
        try {
            const batch   = sanitizeBatch(req.params.batch);
            const pklPath = findEmbeddingPkl(batch);
            let updatedAt = null;
            if (pklPath) {
                try { updatedAt = fs.statSync(pklPath).mtime; } catch (_) {}
            }
            res.json({ available: !!pklPath, updatedAt });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    // ─── Live state of this batch's background embedding run ─────────
    // The bare "does a .pkl exist?" check above cannot answer "did my
    // regeneration finish?" — on a re-run the file is already there, so a
    // caller polling it reports success on the first tick, before any work
    // has happened. Callers wait on `state` instead, and compare `startedAt`
    // against the value the trigger returned so a previous run's result is
    // never mistaken for this one's.
    async embeddingStatus(req, res) {
        try {
            const batch   = sanitizeBatch(req.params.batch);
            const job     = peekEmbeddingJob(batch);
            const pklPath = findEmbeddingPkl(batch);

            let updatedAt = null;
            if (pklPath) {
                try { updatedAt = fs.statSync(pklPath).mtime; } catch (_) {}
            }

            res.json({
                batch,
                state:        job?.state      || 'idle',   // idle | running | done | error
                startedAt:    job?.startedAt  || null,
                finishedAt:   job?.finishedAt || null,
                queued:       job?.queued     || 0,
                processed:    job?.processed  || 0,
                skippedCount: job?.skipped.length || 0,
                skipped:      (job?.skipped || []).slice(0, 50),
                error:        job?.error      || null,
                available:    !!pklPath,
                updatedAt,
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    }

    // ─── Get Sync Status ───────────────────────────────────────────────
    async getStatus(req, res) {
        try {
            const batchString = sanitizeBatch(req.params.batch);
            const department  = erpSync.departmentFromBatch(batchString);

            const data = await erpSync.getErpStatus(batchString, department);
            res.json(data);
        } catch (e) {
            console.error('[GT Upload] status proxy error:', e.message);
            res.status(502).json({ error: 'Failed to fetch status from ML service' });
        }
    }
}

module.exports = GroundTruthUploadController;
