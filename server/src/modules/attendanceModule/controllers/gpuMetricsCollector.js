const axios = require('axios');
const GpuMetric = require('../../../models/attendanceModule/gpuMetric');

const DEFAULT_POLL_MS = 3000;
const DEFAULT_RETENTION_HOURS = 24;
const MAX_HISTORY_POINTS = 5000;

const configuredPollMs = Number(process.env.GPU_METRICS_POLL_MS);
const POLL_MS = Number.isFinite(configuredPollMs) && configuredPollMs >= 1000
    ? configuredPollMs
    : DEFAULT_POLL_MS;

const configuredRetentionHours = Number(process.env.GPU_METRICS_RETENTION_HOURS);
const RETENTION_HOURS = Number.isFinite(configuredRetentionHours) && configuredRetentionHours > 0
    ? configuredRetentionHours
    : DEFAULT_RETENTION_HOURS;

const configuredMlUrl = process.env.ML_SERVICE_URL || 'http://localhost:8500';
const ML_SERVICE_URL = /^https?:\/\//i.test(configuredMlUrl)
    ? configuredMlUrl.replace(/\/+$/, '')
    : `http://${configuredMlUrl.replace(/\/+$/, '')}`;

let collectorTimer = null;
let collectionInFlight = false;
let latestSample = null;

function asFiniteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function errorMessage(error) {
    return String(
        error?.response?.data?.detail
        || error?.response?.data?.error
        || error?.message
        || 'GPU metrics unavailable'
    ).slice(0, 500);
}

function normalizeGpuMetric(data, timestamp = new Date()) {
    const validPayload = !!data
        && typeof data === 'object'
        && Object.prototype.hasOwnProperty.call(data, 'utilPercent');
    const available = validPayload && data.available !== false;
    return {
        timestamp,
        utilPercent: asFiniteNumber(data?.utilPercent),
        memUsedMiB: asFiniteNumber(data?.memUsedMiB),
        memTotalMiB: asFiniteNumber(data?.memTotalMiB),
        memPercent: asFiniteNumber(data?.memPercent),
        tempC: asFiniteNumber(data?.tempC),
        powerW: asFiniteNumber(data?.powerW),
        available,
        error: !available
            ? String(data?.error || 'GPU metrics unavailable').slice(0, 500)
            : null,
    };
}

function toPublicSample(sample) {
    if (!sample) return null;
    const raw = typeof sample.toObject === 'function' ? sample.toObject() : sample;
    return {
        timestamp: new Date(raw.timestamp).getTime(),
        utilPercent: asFiniteNumber(raw.utilPercent),
        memUsedMiB: asFiniteNumber(raw.memUsedMiB),
        memTotalMiB: asFiniteNumber(raw.memTotalMiB),
        memPercent: asFiniteNumber(raw.memPercent),
        tempC: asFiniteNumber(raw.tempC),
        powerW: asFiniteNumber(raw.powerW),
        available: raw.available !== false,
        error: raw.error || null,
    };
}

async function requestGpuMetrics() {
    const response = await axios.get(`${ML_SERVICE_URL}/metrics/gpu`, { timeout: 5000 });
    return response.data;
}

async function collectGpuMetric(options = {}) {
    const request = options.request || requestGpuMetrics;
    const persist = options.persist || ((sample) => GpuMetric.create(sample));
    const now = options.now || (() => new Date());

    let sample;
    try {
        sample = normalizeGpuMetric(await request(), now());
    } catch (error) {
        const timestamp = now();
        sample = {
            ...normalizeGpuMetric({ available: false, error: errorMessage(error) }, timestamp),
            available: false,
            error: errorMessage(error),
        };
    }

    latestSample = toPublicSample(sample);
    try {
        await persist(sample);
    } catch (error) {
        // Keep serving the live in-memory sample even if a transient database
        // write fails; the next scheduled sample retries persistence.
        console.error('[GpuMetricsCollector] Failed to persist sample:', error.message);
    }
    return latestSample;
}

async function collectTick(options) {
    if (collectionInFlight) return;
    collectionInFlight = true;
    try {
        await collectGpuMetric(options);
    } finally {
        collectionInFlight = false;
    }
}

function startGpuMetricsCollector(options = {}) {
    if (collectorTimer) return collectorTimer;

    void collectTick(options);
    collectorTimer = setInterval(() => {
        void collectTick(options);
    }, POLL_MS);
    if (typeof collectorTimer.unref === 'function') collectorTimer.unref();

    console.log(
        `[GpuMetricsCollector] Sampling every ${POLL_MS}ms; retaining ${RETENTION_HOURS} hour(s).`
    );
    return collectorTimer;
}

function stopGpuMetricsCollector() {
    if (collectorTimer) clearInterval(collectorTimer);
    collectorTimer = null;
    collectionInFlight = false;
}

function downsampleSamples(samples, maxPoints) {
    const safeLimit = Math.max(2, Math.min(Number(maxPoints) || 2000, MAX_HISTORY_POINTS));
    if (samples.length <= safeLimit) return samples;

    const lastIndex = samples.length - 1;
    const step = lastIndex / (safeLimit - 1);
    return Array.from({ length: safeLimit }, (_, index) => (
        samples[Math.min(lastIndex, Math.round(index * step))]
    ));
}

async function getLatestGpuMetric() {
    if (latestSample) return latestSample;
    const stored = await GpuMetric.findOne({}).sort({ timestamp: -1 }).lean();
    latestSample = toPublicSample(stored);
    return latestSample;
}

async function getGpuMetricHistory({ from, to, maxPoints = 2000 } = {}) {
    const now = new Date();
    const defaultFrom = new Date(now.getTime() - RETENTION_HOURS * 60 * 60 * 1000);
    const query = {
        timestamp: {
            $gte: from || defaultFrom,
            $lte: to || now,
        },
    };

    const stored = await GpuMetric.find(query).sort({ timestamp: 1 }).lean();
    const samples = stored.map(toPublicSample);
    return downsampleSamples(samples, maxPoints);
}

function getGpuMetricsCollectorInfo() {
    return {
        pollMs: POLL_MS,
        retentionHours: RETENTION_HOURS,
        running: !!collectorTimer,
    };
}

module.exports = {
    collectGpuMetric,
    downsampleSamples,
    getGpuMetricHistory,
    getGpuMetricsCollectorInfo,
    getLatestGpuMetric,
    normalizeGpuMetric,
    startGpuMetricsCollector,
    stopGpuMetricsCollector,
    toPublicSample,
};
