const {
    collectGpuMetric,
    downsampleSamples,
    normalizeGpuMetric,
    getGpuMetricsCollectorInfo,
    startGpuMetricsCollector,
    stopGpuMetricsCollector,
    toPublicSample,
} = require('../../src/modules/attendanceModule/controllers/gpuMetricsCollector');
const GpuMetric = require('../../src/models/attendanceModule/gpuMetric');

describe('GPU metrics background collector', () => {
    afterEach(() => {
        stopGpuMetricsCollector();
        jest.useRealTimers();
    });

    it('expires persisted samples after the bounded retention window', () => {
        const timestampIndex = GpuMetric.schema.indexes().find(
            ([fields]) => fields.timestamp === 1
        );

        expect(timestampIndex).toBeDefined();
        expect(timestampIndex[1].expireAfterSeconds).toBe(24 * 60 * 60);
    });

    it('normalizes and persists an available GPU sample', async () => {
        const timestamp = new Date('2026-07-28T08:00:00.000Z');
        const persist = jest.fn().mockResolvedValue(undefined);

        const sample = await collectGpuMetric({
            now: () => timestamp,
            request: async () => ({
                utilPercent: 73,
                memUsedMiB: 2048,
                memTotalMiB: 8192,
                memPercent: 25,
                tempC: 61,
                powerW: 220,
                available: true,
            }),
            persist,
        });

        expect(persist).toHaveBeenCalledWith({
            timestamp,
            utilPercent: 73,
            memUsedMiB: 2048,
            memTotalMiB: 8192,
            memPercent: 25,
            tempC: 61,
            powerW: 220,
            available: true,
            error: null,
        });
        expect(sample).toEqual({
            timestamp: timestamp.getTime(),
            utilPercent: 73,
            memUsedMiB: 2048,
            memTotalMiB: 8192,
            memPercent: 25,
            tempC: 61,
            powerW: 220,
            available: true,
            error: null,
        });
    });

    it('continues collecting on the backend timer without a page request', async () => {
        jest.useFakeTimers();
        const request = jest.fn().mockResolvedValue({
            utilPercent: 10,
            memUsedMiB: 100,
            memTotalMiB: 1000,
            memPercent: 10,
            tempC: 45,
            powerW: 90,
            available: true,
        });
        const persist = jest.fn().mockResolvedValue(undefined);

        startGpuMetricsCollector({
            request,
            persist,
            now: () => new Date('2026-07-28T08:00:00.000Z'),
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(request).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(getGpuMetricsCollectorInfo().pollMs);
        expect(request).toHaveBeenCalledTimes(2);
        expect(persist).toHaveBeenCalledTimes(2);
    });

    it('records an unavailable sample when the GPU service cannot be reached', async () => {
        const timestamp = new Date('2026-07-28T08:00:03.000Z');
        const persist = jest.fn().mockResolvedValue(undefined);
        const requestError = new Error('connect ETIMEDOUT');

        const sample = await collectGpuMetric({
            now: () => timestamp,
            request: async () => { throw requestError; },
            persist,
        });

        expect(sample).toMatchObject({
            timestamp: timestamp.getTime(),
            available: false,
            error: 'connect ETIMEDOUT',
        });
        expect(persist).toHaveBeenCalledWith(expect.objectContaining({
            timestamp,
            available: false,
            error: 'connect ETIMEDOUT',
        }));
    });

    it('rejects malformed upstream payloads and preserves null metric values', () => {
        expect(normalizeGpuMetric({ available: true }).available).toBe(false);
        expect(toPublicSample({
            timestamp: new Date('2026-07-28T08:00:00.000Z'),
            utilPercent: null,
            memUsedMiB: null,
            memTotalMiB: null,
            memPercent: null,
            tempC: null,
            powerW: null,
            available: false,
            error: 'unavailable',
        })).toMatchObject({
            utilPercent: null,
            memUsedMiB: null,
            available: false,
        });
    });

    it('bounds graph history while preserving the first and latest samples', () => {
        const samples = Array.from({ length: 20 }, (_, timestamp) => ({ timestamp }));
        const result = downsampleSamples(samples, 5);

        expect(result).toHaveLength(5);
        expect(result[0]).toBe(samples[0]);
        expect(result[result.length - 1]).toBe(samples[samples.length - 1]);
    });
});
