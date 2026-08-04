const crypto = require("crypto");

/**
 * Progress ticker for an in-flight invite's background mail send — see
 * memberController.inviteMembers. In-memory only, and deliberately so: a
 * batch is nothing but a progress bar for the teacher who is still looking at
 * the modal. The durable outcome (LmMembership rows, in-app LmNotification
 * rows) is already written before a batch is created; losing one on a
 * restart just stalls a progress bar, it never loses an invite.
 */
const batches = new Map();

const TTL_MS = 15 * 60 * 1000;

function sweep() {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, batch] of batches) {
    if (batch.createdAt < cutoff) batches.delete(id);
  }
}
const sweepTimer = setInterval(sweep, 60 * 1000);
sweepTimer.unref();

function createBatch(classId, total) {
  const id = crypto.randomBytes(12).toString("hex");
  batches.set(id, {
    classId: String(classId),
    total,
    updates: [],
    done: total === 0,
    createdAt: Date.now(),
  });
  return id;
}

function recordResult(batchId, update) {
  const batch = batches.get(batchId);
  if (!batch) return;
  batch.updates.push(update);
  if (batch.updates.length >= batch.total) batch.done = true;
}

function getBatch(batchId) {
  return batches.get(batchId) || null;
}

module.exports = { createBatch, recordResult, getBatch };
