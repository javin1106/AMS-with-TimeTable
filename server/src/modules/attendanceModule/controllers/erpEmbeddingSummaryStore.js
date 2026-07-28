const fs = require('fs');
const path = require('path');
const erpSync = require('./erpEmbeddingSyncHelper');

const SUMMARY_FILENAME = 'embedding_summary.json';

function normalizeRollNos(rollNos = []) {
    return [...new Set(
        rollNos
            .map((rollNo) => String(rollNo || '').trim().toUpperCase())
            .filter(Boolean)
    )].sort();
}

function summaryPath(batch, department) {
    return path.join(
        path.dirname(erpSync.pklPath(batch, department || erpSync.departmentFromBatch(batch))),
        SUMMARY_FILENAME
    );
}

function readBatchSummary(batch, department) {
    const filePath = summaryPath(batch, department);
    if (!fs.existsSync(filePath)) return null;

    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return {
            batch,
            failedRollNos: normalizeRollNos(data.failedRollNos),
            updatedAt: data.updatedAt || null,
        };
    } catch (error) {
        console.warn(`[ERP] Failed to read embedding summary for ${batch}:`, error.message);
        return null;
    }
}

function writeBatchSummary(batch, department, failedRollNos) {
    const filePath = summaryPath(batch, department);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const summary = {
        version: 1,
        batch,
        failedRollNos: normalizeRollNos(failedRollNos),
        updatedAt: new Date().toISOString(),
    };
    const tempPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(summary, null, 2));
    fs.renameSync(tempPath, filePath);
    return summary;
}

function replaceBatchSummary(job) {
    return writeBatchSummary(job.batch, job.department, job.failedRollNos);
}

function patchBatchSummary(job) {
    const previous = readBatchSummary(job.batch, job.department);
    const failures = new Set(previous?.failedRollNos || []);

    for (const rollNo of normalizeRollNos(job.rollNos)) failures.delete(rollNo);
    for (const rollNo of normalizeRollNos(job.failedRollNos)) failures.add(rollNo);

    return writeBatchSummary(job.batch, job.department, [...failures]);
}

function renameFailedRollNo(batch, oldRollNo, newRollNo, department) {
    const previous = readBatchSummary(batch, department);
    if (!previous) return null;

    const failures = new Set(previous.failedRollNos);
    const normalizedOld = normalizeRollNos([oldRollNo])[0];
    const normalizedNew = normalizeRollNos([newRollNo])[0];
    if (normalizedOld && failures.delete(normalizedOld) && normalizedNew) {
        failures.add(normalizedNew);
    }
    return writeBatchSummary(batch, department, [...failures]);
}

function removeFailedRollNos(batch, rollNos, department) {
    const previous = readBatchSummary(batch, department);
    if (!previous) return null;

    const failures = new Set(previous.failedRollNos);
    for (const rollNo of normalizeRollNos(rollNos)) failures.delete(rollNo);
    return writeBatchSummary(batch, department, [...failures]);
}

function clearBatchSummary(batch, department) {
    const filePath = summaryPath(batch, department);
    try {
        fs.unlinkSync(filePath);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}

module.exports = {
    readBatchSummary,
    replaceBatchSummary,
    patchBatchSummary,
    renameFailedRollNo,
    removeFailedRollNos,
    clearBatchSummary,
    summaryPath,
};
