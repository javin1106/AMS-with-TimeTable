// server/src/modules/attendanceModule/controllers/schedulerClaims.js
// Claim/heartbeat/release helpers over the SchedulerLedger collection.
//
// The scheduler asks "may I run period P in room R today?" once a minute while
// the period is live. Exactly one caller — across restarts and across server
// instances — must get 'true', and a caller that dies mid-run must not block
// the work forever. Both fall out of one rule: a row is claimable if it does
// not exist, or if it exists in state 'claimed' with a stale heartbeat.

const os = require('os');
const SchedulerLedger = require('../../../models/attendanceModule/schedulerLedger');

// How long a claim survives without a heartbeat before someone else may take
// it over. Two opposing pressures: too short and a live run gets stolen from
// itself mid-check; too long and a crashed run cannot be resumed before its
// period ends, which is the whole point of resuming.
//
// A run beats during the waits between checks as well as after each check (see
// sleepWithHeartbeat in autoAttendanceScheduler), so the longest possible gap
// is one check — bounded by the ML service's own 5-minute request timeout, not
// by the period's check interval, which can be 25 minutes on a 2-run period.
// 10 minutes clears that with room to spare and still allows a resume inside
// almost any period.
const STALE_CLAIM_MS = 10 * 60 * 1000;

const OWNER = `${os.hostname()}:${process.pid}`;

// Canonical row key. `room` is uppercased everywhere so a camera registered as
// "lh-101" and a timetable saying "LH-101" cannot claim the same period twice.
const ledgerKey = ({ date, periodKey, room = '*', task = 'run' }) => ({
    date,
    periodKey,
    room: String(room || '*').toUpperCase(),
    task,
});

/**
 * Atomically claim a unit of scheduler work for the day.
 *
 * @returns {Promise<{claimed: boolean, doc?: object, reason?: string, resumed?: boolean}>}
 *   `resumed` is true when the row already existed in state 'claimed' — i.e.
 *   this is a takeover from a holder that died, not a fresh start.
 */
async function claimSchedulerWork({
    date,
    periodKey,
    room = '*',
    task = 'run',
    targetRuns = 0,
    staleMs = STALE_CLAIM_MS,
}) {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - staleMs);
    const key = ledgerKey({ date, periodKey, room, task });

    // Read first, purely so the caller can be told whether this is a takeover.
    // The claim itself is decided by the update below, not by this read — a
    // racing instance between the two is rejected by the unique index.
    const before = await SchedulerLedger.findOne(key).lean();
    if (before && (before.state === 'done' || before.state === 'interrupted')) {
        return { claimed: false, reason: `already ${before.state}`, doc: before };
    }
    if (before && before.state === 'claimed' && before.heartbeatAt > staleBefore) {
        return { claimed: false, reason: 'held by a live run', doc: before };
    }

    try {
        const doc = await SchedulerLedger.findOneAndUpdate(
            {
                ...key,
                // Absent, or abandoned. Never steals a live claim, and never
                // reopens finished work.
                $or: [
                    { state: 'claimed', heartbeatAt: { $lt: staleBefore } },
                    { state: 'claimed', heartbeatAt: null },
                ],
            },
            {
                $set: {
                    state: 'claimed',
                    owner: OWNER,
                    claimedAt: now,
                    heartbeatAt: now,
                    targetRuns,
                    lastError: null,
                },
                ...(before ? { $inc: { resumedCount: 1 } } : {}),
            },
            { new: true, upsert: true, setDefaultsOnInsert: true },
        );
        return { claimed: true, doc, resumed: !!before };
    } catch (err) {
        // The unique index doing its job: another instance inserted the same
        // row in the gap above, or the row exists and the $or did not match it
        // (a live claim). Either way this caller does not have the work.
        if (err.code === 11000) {
            return { claimed: false, reason: 'claimed concurrently by another run' };
        }
        throw err;
    }
}

/** Keep a held claim alive, and record how far the run has got. */
async function heartbeatSchedulerWork({ date, periodKey, room = '*', task = 'run', checksSaved }) {
    const $set = { heartbeatAt: new Date() };
    if (typeof checksSaved === 'number') $set.checksSaved = checksSaved;
    await SchedulerLedger.updateOne(
        ledgerKey({ date, periodKey, room, task }),
        { $set },
    ).catch((err) =>
        // A missed heartbeat only risks the claim going stale early; it must
        // never take down the run that is otherwise succeeding.
        console.warn(`[SchedulerLedger] heartbeat failed for ${date} ${periodKey} ${room}: ${err.message}`),
    );
}

// A room that fails is worth retrying inside its own period — the camera may
// come back, the ML service may recover. It is not worth retrying every minute
// until the bell: each attempt costs a full runDurationSec of acquisition, and
// a camera that is unplugged will not be fixed by asking it 40 more times.
const MAX_RUN_ATTEMPTS = 3;

/**
 * Close out a claim.
 *
 * `state: 'done'` finishes the work for the day. `state: 'claimed'` means the
 * holder is giving it back unfinished — the heartbeat is cleared so the next
 * tick can pick it up immediately rather than waiting out the staleness
 * window, up to MAX_RUN_ATTEMPTS attempts.
 */
async function releaseSchedulerWork({
    date,
    periodKey,
    room = '*',
    task = 'run',
    state = 'done',
    checksSaved,
    error = null,
    maxAttempts = MAX_RUN_ATTEMPTS,
}) {
    const key = ledgerKey({ date, periodKey, room, task });
    try {
        let finalState = state;
        if (state === 'claimed') {
            const doc = await SchedulerLedger.findOne(key).select('attempts').lean();
            if ((doc?.attempts?.length || 0) >= maxAttempts) {
                finalState = 'interrupted';
                console.warn(
                    `[SchedulerLedger] ${date} ${periodKey} ${room}: giving up after ` +
                    `${doc.attempts.length} attempt(s) — last error: ${error || 'unknown'}`,
                );
            }
        }

        const $set = { state: finalState, lastError: error };
        if (finalState === 'claimed') {
            // Immediately reclaimable — see the claim filter's null-heartbeat arm.
            $set.heartbeatAt = null;
        } else {
            $set.finishedAt = new Date();
            $set.heartbeatAt = new Date();
        }
        if (typeof checksSaved === 'number') $set.checksSaved = checksSaved;

        await SchedulerLedger.updateOne(key, { $set });
    } catch (err) {
        console.warn(`[SchedulerLedger] release failed for ${date} ${periodKey} ${room}: ${err.message}`);
    }
}

// ── Attempt recording ───────────────────────────────────────────────────────
// Every invocation of runSlotAttendance appends one attempt and then keeps its
// step trail up to date as it goes. Written incrementally rather than once at
// the end for the case that matters most: a run that never reaches its end.
// Without the incremental write, the crash that this whole mechanism exists to
// explain would take its own explanation down with it.

/**
 * Open a new attempt on this row, creating the row if it does not exist.
 * @returns {Promise<number|null>} index of the new attempt, for updateAttempt.
 */
async function beginAttempt(key, attempt = {}) {
    try {
        const doc = await SchedulerLedger.findOneAndUpdate(
            ledgerKey(key),
            {
                $push: { attempts: { startedAt: new Date(), status: 'running', ...attempt } },
                $setOnInsert: { owner: OWNER, claimedAt: new Date() },
                $set: { heartbeatAt: new Date() },
            },
            { new: true, upsert: true, setDefaultsOnInsert: true },
        );
        return (doc?.attempts?.length || 1) - 1;
    } catch (err) {
        // The ledger is a record of what happened, never a precondition for it
        // happening. A failure here must not stop the attendance run.
        console.warn(`[SchedulerLedger] beginAttempt failed: ${err.message}`);
        return null;
    }
}

/** Patch fields on an open attempt. `patch` keys are attempt-relative. */
async function updateAttempt(key, index, patch = {}) {
    if (index == null) return;
    const $set = { heartbeatAt: new Date() };
    for (const [k, v] of Object.entries(patch)) $set[`attempts.${index}.${k}`] = v;
    await SchedulerLedger.updateOne(ledgerKey(key), { $set }).catch((err) =>
        console.warn(`[SchedulerLedger] updateAttempt failed: ${err.message}`),
    );
}

module.exports = {
    claimSchedulerWork,
    heartbeatSchedulerWork,
    releaseSchedulerWork,
    beginAttempt,
    updateAttempt,
    STALE_CLAIM_MS,
    OWNER,
};
