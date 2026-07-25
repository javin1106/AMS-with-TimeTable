'use strict';

const path = require('path');
const fs   = require('fs').promises;
const cron = require('node-cron');

const RejectedSamplesCleanupSettings = require('../../../models/attendanceModule/rejectedSamplesCleanupSettings');

const REJECTED_DIR  = path.join(__dirname, '..', '..', '..', '..', 'ml-data', 'liveness_rejected');
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const FILENAME_RE   = /^([0-9]{10,17})[A-Za-z0-9_.\-]*\.jpg$/;

// age comes from ts_ms in the filename, not mtime — mtime can drift if the
// file is ever touched by another process, ts_ms in the name can't.
async function runCleanup() {
    let files;
    try {
        files = await fs.readdir(REJECTED_DIR);
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        files = [];
    }

    const now = Date.now();
    let deleted = 0;
    for (const f of files) {
        const m = FILENAME_RE.exec(f);
        if (!m) continue;
        if (now - Number(m[1]) > SEVEN_DAYS_MS) {
            await fs.unlink(path.join(REJECTED_DIR, f)).catch(() => {});
            deleted += 1;
        }
    }

    const stats = { scanned: files.length, deleted };
    console.log(`[RejectedSamplesCleanup] Scanned ${stats.scanned}, deleted ${stats.deleted} crop(s) older than 7 days.`);

    try {
        const settings = await RejectedSamplesCleanupSettings.getSettings();
        settings.lastRunAt = new Date();
        settings.lastRunStats = stats;
        await settings.save();
    } catch (err) {
        console.warn('[RejectedSamplesCleanup] Could not persist lastRunStats:', err.message);
    }

    return stats;
}

// job fires nightly; whether it actually deletes anything is gated by the
// enabled flag so the settings-tab toggle takes effect without a restart
function startRejectedSamplesCleanupScheduler() {
    cron.schedule('15 2 * * *', async () => {
        try {
            const settings = await RejectedSamplesCleanupSettings.getSettings();
            if (!settings.enabled) {
                console.log('[RejectedSamplesCleanup] Skipped — disabled via settings.');
                return;
            }
        } catch (err) {
            console.error('[RejectedSamplesCleanup] Could not read settings, skipping this run:', err.message);
            return;
        }
        runCleanup().catch((err) => console.error('[RejectedSamplesCleanup] Failed:', err.message));
    });
}

// manual "run now" — bypasses the enabled flag on purpose, same as frame cleanup's admin trigger
async function runRejectedSamplesCleanupNow() {
    return runCleanup();
}

module.exports = { startRejectedSamplesCleanupScheduler, runRejectedSamplesCleanupNow };
