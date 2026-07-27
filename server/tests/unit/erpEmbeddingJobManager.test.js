const {
    startEmbeddingJob,
    getEmbeddingJob,
    clearEmbeddingJobs,
} = require('../../src/modules/attendanceModule/controllers/erpEmbeddingJobManager');

async function waitForTerminalJob(jobId) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const job = getEmbeddingJob(jobId);
        if (job?.status === 'done' || job?.status === 'error') return job;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Embedding job did not finish');
}

afterEach(() => {
    clearEmbeddingJobs();
});

describe('ERP embedding job manager', () => {
    it('tracks real progress and preserves roll numbers whose faces were not detected', async () => {
        const failed = new Set(['22BCE002', '22BCE004']);
        const syncFn = jest.fn(async (_batch, _department, rollNos) => ({
            processed: rollNos.filter((rollNo) => !failed.has(rollNo)).length,
            skipped: rollNos.filter((rollNo) => failed.has(rollNo)),
        }));

        const initial = startEmbeddingJob({
            batch: 'BTECH_CSE_2022',
            department: 'CSE',
            rollNos: ['22BCE001', '22BCE002', '22BCE003', '22BCE004'],
        }, { syncFn });

        expect(initial).toMatchObject({
            status: 'queued',
            total: 4,
            processed: 0,
            completed: 0,
            failed: 0,
            progressPercent: 0,
        });

        const completed = await waitForTerminalJob(initial.jobId);

        expect(completed).toMatchObject({
            status: 'done',
            total: 4,
            processed: 4,
            completed: 2,
            failed: 2,
            progressPercent: 100,
            successPercent: 50,
            failedRollNos: ['22BCE002', '22BCE004'],
        });
        expect(syncFn).toHaveBeenCalledTimes(4);
    });

    it('marks the job as failed when the ML result cannot account for every photo', async () => {
        const initial = startEmbeddingJob({
            batch: 'BTECH_CSE_2022',
            department: 'CSE',
            rollNos: ['22BCE001'],
        }, {
            syncFn: async () => ({ processed: 0, skipped: [] }),
        });

        const failed = await waitForTerminalJob(initial.jobId);

        expect(failed.status).toBe('error');
        expect(failed.error).toBe('Embedding service returned an incomplete progress result');
    });
});
