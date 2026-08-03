const crypto = require('crypto');
const erpSync = require('./erpEmbeddingSyncHelper');

const jobs = new Map();
const batchChains = new Map();
const JOB_TTL_MS = 30 * 60 * 1000;
const TARGET_PROGRESS_UPDATES = 20;

function normalizeRollNos(rollNos = []) {
    return [...new Set(
        rollNos
            .map((rollNo) => String(rollNo || '').trim().toUpperCase())
            .filter(Boolean)
    )];
}

function progressPercent(processed, total) {
    return total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 100;
}

function successPercent(completed, total) {
    return total > 0 ? Math.round((completed / total) * 100) : 0;
}

function snapshot(job) {
    return {
        jobId: job.jobId,
        batch: job.batch,
        department: job.department,
        status: job.status,
        total: job.total,
        processed: job.processed,
        completed: job.completed,
        failed: job.failedRollNos.length,
        progressPercent: progressPercent(job.processed, job.total),
        successPercent: successPercent(job.completed, job.total),
        failedRollNos: [...job.failedRollNos],
        error: job.error,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
    };
}

function scheduleCleanup(jobId) {
    const timer = setTimeout(() => jobs.delete(jobId), JOB_TTL_MS);
    if (typeof timer.unref === 'function') timer.unref();
}

async function runJob(job, syncFn, onComplete) {
    job.status = 'running';
    job.startedAt = new Date().toISOString();

    try {
        const chunkSize = Math.max(1, Math.ceil(job.rollNos.length / TARGET_PROGRESS_UPDATES));

        for (let index = 0; index < job.rollNos.length; index += chunkSize) {
            const chunk = job.rollNos.slice(index, index + chunkSize);
            const result = await syncFn(job.batch, job.department, chunk);
            const failedRollNos = normalizeRollNos(result?.skipped || []);
            const completed = Number(result?.processed);

            if (
                !Number.isInteger(completed)
                || completed < 0
                || completed + failedRollNos.length !== chunk.length
            ) {
                throw new Error('Embedding service returned an incomplete progress result');
            }

            job.processed += chunk.length;
            job.completed += completed;
            job.failedRollNos.push(...failedRollNos);
        }

        if (onComplete) {
            try {
                await onComplete({
                    batch: job.batch,
                    department: job.department,
                    rollNos: [...job.rollNos],
                    failedRollNos: [...job.failedRollNos],
                });
            } catch (error) {
                console.error(`[ERP] Failed to save embedding summary for ${job.batch}:`, error.message);
            }
        }
        job.status = 'done';
    } catch (error) {
        job.status = 'error';
        job.error = error.message || 'Embedding generation failed';
    } finally {
        job.finishedAt = new Date().toISOString();
        scheduleCleanup(job.jobId);
    }
}

function startEmbeddingJob({ batch, department, rollNos }, options = {}) {
    const normalizedRollNos = normalizeRollNos(rollNos);
    const job = {
        jobId: crypto.randomUUID(),
        batch,
        department,
        rollNos: normalizedRollNos,
        total: normalizedRollNos.length,
        processed: 0,
        completed: 0,
        failedRollNos: [],
        status: normalizedRollNos.length ? 'queued' : 'done',
        error: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: normalizedRollNos.length ? null : new Date().toISOString(),
    };

    jobs.set(job.jobId, job);

    if (!normalizedRollNos.length) {
        scheduleCleanup(job.jobId);
        return snapshot(job);
    }

    const syncFn = options.syncFn || erpSync.syncErpEmbeddings;
    const previous = batchChains.get(batch) || Promise.resolve();
    const current = previous
        .catch(() => {})
        .then(() => runJob(job, syncFn, options.onComplete));

    batchChains.set(batch, current);
    current.finally(() => {
        if (batchChains.get(batch) === current) batchChains.delete(batch);
    });

    return snapshot(job);
}

function getEmbeddingJob(jobId) {
    const job = jobs.get(jobId);
    return job ? snapshot(job) : null;
}

function clearEmbeddingJobs() {
    jobs.clear();
    batchChains.clear();
}

module.exports = {
    startEmbeddingJob,
    getEmbeddingJob,
    clearEmbeddingJobs,
};
