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
        const pklPath = findFileInDir(EMBEDDINGS_DIR, record.embeddingFile);
        if (!pklPath) {
            console.warn(`[rebuildSubjectPkls] PKL not found on disk: ${record.embeddingFile}`);
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
 * Drop every reference to `filename` from a student's _info.json.
 * Returns what the caller needs to decide whether the cached embedding is now
 * stale: { wasEmbedding, embeddingFiles, backupFiles }.
 */
async function removePhotoReferences(studentDir, filename) {
    const infoPath = path.join(studentDir, '_info.json');
    if (!fs.existsSync(infoPath)) {
        return { wasEmbedding: false, embeddingFiles: [], backupFiles: [] };
    }

    try {
        const info = JSON.parse(await fsPromises.readFile(infoPath, 'utf8'));
        const without = (arr) => (arr || []).filter(f => f !== filename);

        const wasEmbedding = (info.embedding_files || []).includes(filename);
        info.embedding_files = without(info.embedding_files);
        info.backup_files    = without(info.backup_files);
        info.approved_files  = without(info.approved_files);
        if (info.scores) delete info.scores[filename];

        // Nothing left to average — drop the cached vectors outright rather than
        // leaving ones that still carry the deleted photo.
        if (wasEmbedding && info.embedding_files.length === 0) {
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
        };
    } catch (_) {
        return { wasEmbedding: false, embeddingFiles: [], backupFiles: [] };
    }
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
    const { wasEmbedding, embeddingFiles, backupFiles } =
        await removePhotoReferences(studentDir, filename);

    try {
        if (wasEmbedding && embeddingFiles.length > 0) {
            // Pass backupFiles explicitly: called without them,
            // updateStudentEmbedding rewrites backup_files to "every image that
            // isn't an embedding file", which would quietly promote unapproved
            // photos sitting in the folder into the backup set.
            await updateStudentEmbedding(studentDir, rollNo, embeddingFiles, backupFiles);
        }
        await rebuildSubjectPklsForStudent(rollNo, batch);
    } catch (err) {
        console.warn(`[reconcileAfterPhotoDelete] rebuild failed for ${rollNo}/${filename}:`, err.message);
    }
}

module.exports = {
    findFileInDir,
    rebuildSubjectPklsForStudent,
    removePhotoReferences,
    reconcileAfterPhotoDelete,
};
