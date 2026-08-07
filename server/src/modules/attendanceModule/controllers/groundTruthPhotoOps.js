// server/src/modules/attendanceModule/controllers/groundTruthPhotoOps.js
//
// Shared reconciliation for removing a single photo from a ground-truth student
// folder. Three routes do this — the Ground Truth page
// (groundTruthController.deletePhoto), the cluster card on Roll Assignment /
// Flagged (flagController.deleteClusterPhoto) and roll-assign's by-ObjectId
// variant — and each had grown its own partial version: one rebuilt the subject
// PKLs but left the photo's `scores` entry behind, one cleaned `scores` but left
// the deleted photo's contribution inside `mean_embedding` (and therefore inside
// every subject PKL built from it), and one touched _info.json not at all.
// Keeping the whole sequence here is the only way the three stay in agreement.

const path       = require('path');
const fs         = require('fs');
const fsPromises = require('fs').promises;
const axios      = require('axios');

const {
    updateStudentEmbedding,
    buildBatchEmbeddingsPkl,
} = require('./embeddingSyncHelper');

const ML_SERVICE_URL   = process.env.ML_SERVICE_URL || 'http://localhost:8500';
const GROUND_TRUTH_DIR = path.join(__dirname, '..', '..', '..', '..', 'ml-data', 'ground_truth');
const EMBEDDINGS_DIR   = path.join(__dirname, '..', '..', '..', '..', 'ml-data', 'embeddings');

// How many photos feed a student's mean embedding. Mirrors the ML service's
// gt-config `embed_n`, and the 1..5 range the Ground Truth / Roll Assignment
// UIs enforce when promoting and demoting photos by hand.
const EMBED_N    = 5;
const IMG_EXT_RE = /\.(jpg|jpeg|png|webp)$/i;

// Where a StudentEmbedding record's .pkl actually is.
//
// Prefers the path recorded when it was generated. The recursive
// filename hunt below is a fallback for records written before that field
// existed, and it is genuinely ambiguous now: files are named after the
// Subject _id, so the same subject's 2025-26 and 2026-27 builds are both
// "{id}.pkl" and differ only by folder. findFileInDir returns whichever it
// reaches first, which could be a stale session's copy — rebuilding that one
// leaves the live file untouched.
function resolvePklForRecord(record) {
    if (record.embeddingRelPath) {
        const direct = path.join(EMBEDDINGS_DIR, ...String(record.embeddingRelPath).split('/').filter(Boolean));
        if (fs.existsSync(direct)) return direct;
    }
    if (!record.embeddingFile) return null;
    return findFileInDir(EMBEDDINGS_DIR, record.embeddingFile);
}

// Recursively locate a PKL by filename anywhere under ml-data/embeddings —
// subject PKLs live in per-department subfolders.
function findFileInDir(dir, filename) {
    if (!fs.existsSync(dir)) return null;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const found = findFileInDir(full, filename);
            if (found) return found;
        } else if (entry.name === filename) {
            return full;
        }
    }
    return null;
}

// Rebuild every subject PKL this student appears in, then hand the new bytes to
// the ML service so the running process picks them up.
async function rebuildSubjectPklsForStudent(rollNo, batch) {
    const StudentEmbedding = require('../../../models/attendanceModule/studentEmbedding');
    const subjectRecords = await StudentEmbedding.find({
        rollNos: rollNo,
        status: 'done',
    }).lean();

    console.log(`[rebuildSubjectPkls] ${rollNo} → ${subjectRecords.length} subject PKL(s) to rebuild`);

    // Deduplicate: group records by their resolved pklPath so the same file is only rebuilt once
    const pklGroups = new Map(); // pklPath → { record, rollNos: Set }
    for (const record of subjectRecords) {
        const pklPath = resolvePklForRecord(record);
        if (!pklPath) {
            console.warn(`[rebuildSubjectPkls] PKL not found on disk: ${record.embeddingRelPath || record.embeddingFile}`);
            continue;
        }
        if (!pklGroups.has(pklPath)) {
            pklGroups.set(pklPath, { record, rollNos: new Set(record.rollNos) });
        } else {
            // merge rollNos from duplicate records pointing to the same file
            for (const r of record.rollNos) pklGroups.get(pklPath).rollNos.add(r);
        }
    }

    const batchDir = path.join(GROUND_TRUTH_DIR, batch);
    if (!fs.existsSync(batchDir)) return;

    for (const [pklPath, { record }] of pklGroups) {
        try {
            console.log(`[rebuildSubjectPkls] Rebuilding ${record.embeddingFile} …`);
            const buildResult = await buildBatchEmbeddingsPkl(batchDir, pklPath);
            if (buildResult.adaface_written) {
                const StudentEmbedding = require('../../../models/attendanceModule/studentEmbedding');
                await StudentEmbedding.updateMany(
                    { embeddingFile: record.embeddingFile },
                    { adafaceEmbeddingFile: record.embeddingFile },
                );
            }
            // Bytes, not a path — the ML service may run on a separate machine.
            const pklBytes = fs.readFileSync(pklPath);
            await axios.post(`${ML_SERVICE_URL}/reload-embeddings`, {
                pkl_data: pklBytes.toString('base64'),
            }, { timeout: 30000 });
            console.log(`[rebuildSubjectPkls] ✓ Done ${record.embeddingFile}`);
        } catch (err) {
            console.warn(`[rebuildSubjectPkls] Failed ${record.embeddingFile}:`, err.message);
        }
    }
}

/**
 * Recompute a student's vectors from their current file lists and push the
 * result into every subject PKL they appear in.
 *
 * Writing embedding_files into _info.json is only half the job: live
 * attendance reads `mean_embedding` (see buildEnrolledEmbeddings), never the
 * file list, so a caller that reshuffles the lists without coming through here
 * leaves the UI showing five embedding photos while matching still runs on the
 * old vector — or on none at all.
 *
 * Backgrounded via setImmediate: the PKL rebuild round-trips the ML service
 * once per subject the student is enrolled in, which is far too slow to hold a
 * photo-delete or cluster-assign response open for.
 */
function syncStudentEmbedding({ batch, rollNo, studentDir, embeddingFiles, backupFiles }) {
    if (!Array.isArray(embeddingFiles) || embeddingFiles.length === 0) return;
    setImmediate(async () => {
        try {
            await updateStudentEmbedding(studentDir, rollNo, embeddingFiles, backupFiles);
            await rebuildSubjectPklsForStudent(rollNo, batch);
        } catch (err) {
            console.warn(`[syncStudentEmbedding] failed for ${rollNo}:`, err.message);
        }
    });
}

/**
 * Choose the best `count` candidates to promote into free embedding slots.
 * _info.json already carries the ML service's per-photo quality `scores`, so
 * this costs nothing; files with no score sort last rather than being excluded,
 * since photos added outside the scoring path are still better than an empty
 * slot.
 */
function pickBestPhotos(candidates, scores = {}, count) {
    if (count <= 0) return [];
    return [...candidates]
        .sort((a, b) => (scores[b] ?? -1) - (scores[a] ?? -1))
        .slice(0, count);
}

/**
 * Drop every reference to `filename` from a student's _info.json.
 * Returns what the caller needs to decide whether the cached embedding is now
 * stale: { wasEmbedding, embeddingFiles, backupFiles, scores }.
 */
async function removePhotoReferences(studentDir, filename) {
    const empty = { wasEmbedding: false, embeddingFiles: [], backupFiles: [], scores: {} };
    const infoPath = path.join(studentDir, '_info.json');
    if (!fs.existsSync(infoPath)) return empty;

    try {
        const info = JSON.parse(await fsPromises.readFile(infoPath, 'utf8'));
        const without = (arr) => (arr || []).filter(f => f !== filename);

        const wasEmbedding = (info.embedding_files || []).includes(filename);
        info.embedding_files = without(info.embedding_files);
        info.backup_files    = without(info.backup_files);
        info.approved_files  = without(info.approved_files);
        if (info.scores) delete info.scores[filename];

        // Only when the folder is genuinely exhausted. While backups remain the
        // caller promotes one and recomputes, and a stale vector is a better
        // thing to leave behind than none if that recompute fails — a student
        // with no mean_embedding drops out of live matching entirely.
        if (wasEmbedding && info.embedding_files.length === 0 && info.backup_files.length === 0) {
            delete info.mean_embedding;
            delete info.top_k_embeddings;
            delete info.adaface_mean_embedding;
            delete info.adaface_top_k_embeddings;
        }

        await fsPromises.writeFile(infoPath, JSON.stringify(info, null, 2));
        return {
            wasEmbedding,
            embeddingFiles: info.embedding_files,
            backupFiles:    info.backup_files,
            scores:         info.scores || {},
        };
    } catch (_) {
        return empty;
    }
}

/**
 * Reconcile _info.json after a cluster folder is assigned to a roll number,
 * then recompute the student's vectors.
 *
 * Roll Assignment and Flagged both ran their own byte-for-byte copy of this
 * bookkeeping and neither recomputed anything afterwards, so the refilled
 * embedding_files never reached live matching.
 *
 * @param {string[]} newFiles  images just copied in by a merge (merged only)
 * @param {boolean}  merged    true when photos were merged into an existing
 *                             folder, false for a plain rename/first assign
 * @param {string[]} dbEmbeddingFiles  ClusterMatch.embeddingFiles, used to
 *                             recover a folder whose list came back empty
 */
async function reconcileAfterFolderAssign({ batch, rollNo, folderPath, newFiles = [], merged = false, dbEmbeddingFiles = [] }) {
    if (!fs.existsSync(folderPath)) return null;

    const infoPath = path.join(folderPath, '_info.json');
    const allFiles = (await fsPromises.readdir(folderPath)).filter(f => IMG_EXT_RE.test(f));

    let info = { embedding_files: [], backup_files: [], approved_files: [], scores: {} };
    if (fs.existsSync(infoPath)) {
        try { info = JSON.parse(await fsPromises.readFile(infoPath, 'utf8')); } catch (_) {}
    }

    if (merged) {
        const approvedSet = new Set(info.approved_files || []);
        newFiles.forEach(f => approvedSet.add(f));
        info.approved_files = [...approvedSet];

        // Filtering against disk matters here: a merge can land on a folder
        // whose list still names photos an earlier delete removed, and those
        // stale names would otherwise occupy slots the new photos should fill.
        const existingEmbeds  = (info.embedding_files || []).filter(f => allFiles.includes(f));
        const existingBackups = (info.backup_files    || []).filter(f => allFiles.includes(f));
        const promoted        = newFiles.slice(0, Math.max(0, EMBED_N - existingEmbeds.length));

        info.embedding_files = [...existingEmbeds, ...promoted];
        info.backup_files    = [...existingBackups, ...newFiles.slice(promoted.length)];
    } else {
        if (!info.embedding_files?.length) {
            const dbEmbeds = (dbEmbeddingFiles || []).filter(f => allFiles.includes(f));
            info.embedding_files = dbEmbeds.length > 0 ? dbEmbeds : allFiles.slice(0, EMBED_N);
            info.backup_files    = allFiles.filter(f => !info.embedding_files.includes(f));
        }
        if (!info.approved_files?.length) info.approved_files = [...allFiles];
    }

    await fsPromises.writeFile(infoPath, JSON.stringify(info, null, 2));

    syncStudentEmbedding({
        batch,
        rollNo,
        studentDir:     folderPath,
        embeddingFiles: info.embedding_files,
        backupFiles:    info.backup_files,
    });

    return info;
}

/**
 * Full post-delete reconciliation: clean _info.json, recompute the student's
 * mean embedding if the deleted photo fed it, then rebuild the subject PKLs.
 * Assumes the file is already gone from disk.
 *
 * `rollNo` is a label for the ML payload and the subject-PKL lookup — passing a
 * person_NNN folder name is safe, it simply matches no StudentEmbedding record.
 */
async function reconcileAfterPhotoDelete({ batch, rollNo, studentDir, filename }) {
    const { wasEmbedding, embeddingFiles, backupFiles, scores } =
        await removePhotoReferences(studentDir, filename);

    try {
        if (wasEmbedding) {
            // Refill the freed slot from the backup set — this is what makes
            // backup photos actually act as backups. Without it the count only
            // ever decays: nothing else promotes them, so deleting photos one at
            // a time walks a student 5 → 4 → … → 0, and at 0 they vanish from
            // live matching entirely.
            const promoted = pickBestPhotos(backupFiles, scores, EMBED_N - embeddingFiles.length);
            const nextEmbedding = [...embeddingFiles, ...promoted];
            const nextBackup    = backupFiles.filter(f => !promoted.includes(f));

            if (nextEmbedding.length > 0) {
                // Pass nextBackup explicitly: called without it,
                // updateStudentEmbedding rewrites backup_files to "every image
                // that isn't an embedding file", which would quietly promote
                // unapproved photos sitting in the folder into the backup set.
                await updateStudentEmbedding(studentDir, rollNo, nextEmbedding, nextBackup);
            }
        }
        await rebuildSubjectPklsForStudent(rollNo, batch);
    } catch (err) {
        console.warn(`[reconcileAfterPhotoDelete] rebuild failed for ${rollNo}/${filename}:`, err.message);
    }
}

module.exports = {
    EMBED_N,
    findFileInDir,
    rebuildSubjectPklsForStudent,
    removePhotoReferences,
    reconcileAfterPhotoDelete,
    reconcileAfterFolderAssign,
    syncStudentEmbedding,
};
