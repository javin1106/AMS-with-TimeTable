const fs = require('fs');
const path = require('path');
const summaryStore = require('../../src/modules/attendanceModule/controllers/erpEmbeddingSummaryStore');

const department = 'SUMMARY_STORE_TEST';
const batch = `BTECH_SUMMARY_STORE_TEST_${process.pid}`;
const batchDirectory = path.dirname(summaryStore.summaryPath(batch, department));

afterEach(() => {
    fs.rmSync(batchDirectory, { recursive: true, force: true });
});

describe('ERP embedding summary store', () => {
    it('persists the failed roll numbers from a full embedding run', () => {
        summaryStore.replaceBatchSummary({
            batch,
            department,
            failedRollNos: ['22bce004', '22BCE002', '22BCE002'],
        });

        expect(summaryStore.readBatchSummary(batch, department)).toMatchObject({
            batch,
            failedRollNos: ['22BCE002', '22BCE004'],
        });
    });

    it('updates only the replaced photos after an individual embedding run', () => {
        summaryStore.replaceBatchSummary({
            batch,
            department,
            failedRollNos: ['22BCE002', '22BCE004'],
        });

        summaryStore.patchBatchSummary({
            batch,
            department,
            rollNos: ['22BCE002', '22BCE005'],
            failedRollNos: ['22BCE005'],
        });

        expect(summaryStore.readBatchSummary(batch, department).failedRollNos)
            .toEqual(['22BCE004', '22BCE005']);
    });

    it('keeps the failure list aligned with rename and delete operations', () => {
        summaryStore.replaceBatchSummary({
            batch,
            department,
            failedRollNos: ['22BCE002', '22BCE004'],
        });

        summaryStore.renameFailedRollNo(batch, '22BCE002', '22BCE012', department);
        summaryStore.removeFailedRollNos(batch, ['22BCE004'], department);

        expect(summaryStore.readBatchSummary(batch, department).failedRollNos)
            .toEqual(['22BCE012']);

        summaryStore.clearBatchSummary(batch, department);
        expect(summaryStore.readBatchSummary(batch, department)).toBeNull();
    });
});
