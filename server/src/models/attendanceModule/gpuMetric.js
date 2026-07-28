const mongoose = require('mongoose');

const DEFAULT_RETENTION_HOURS = 24;
const configuredRetentionHours = Number(process.env.GPU_METRICS_RETENTION_HOURS);
const retentionHours = Number.isFinite(configuredRetentionHours) && configuredRetentionHours > 0
    ? configuredRetentionHours
    : DEFAULT_RETENTION_HOURS;

const gpuMetricSchema = new mongoose.Schema({
    timestamp:   { type: Date, required: true, default: Date.now },
    utilPercent: { type: Number, default: null },
    memUsedMiB:  { type: Number, default: null },
    memTotalMiB: { type: Number, default: null },
    memPercent:  { type: Number, default: null },
    tempC:       { type: Number, default: null },
    powerW:      { type: Number, default: null },
    available:   { type: Boolean, required: true, default: false },
    error:       { type: String, default: null, maxlength: 500 },
}, {
    versionKey: false,
});

// MongoDB's TTL monitor removes samples after the configured retention window,
// keeping continuous collection bounded without a separate cleanup scheduler.
gpuMetricSchema.index(
    { timestamp: 1 },
    { expireAfterSeconds: Math.round(retentionHours * 60 * 60) }
);

module.exports = mongoose.models.GpuMetric
    || mongoose.model('GpuMetric', gpuMetricSchema);
