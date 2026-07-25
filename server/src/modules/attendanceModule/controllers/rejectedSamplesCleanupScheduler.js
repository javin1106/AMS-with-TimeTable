// server/src/modules/attendanceModule/controllers/rejectedSamplesCleanupScheduler.js
//
// delete liveness-rejected crops older than 7 days.
//

"use strict";

const path = require("path");
const fs = require("fs").promises;
const cron = require("node-cron");

const REJECTED_DIR = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "ml-data",
  "liveness_rejected",
);
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const FILENAME_RE = /^([0-9]{10,17})[A-Za-z0-9_.\-]*\.jpg$/;

async function runRejectedSamplesCleanupNow() {
  let files;
  try {
    files = await fs.readdir(REJECTED_DIR);
  } catch (err) {
    if (err.code === "ENOENT") return { deleted: 0, scanned: 0 };
    throw err;
  }

  const now = Date.now();
  let deleted = 0;
  for (const f of files) {
    const m = FILENAME_RE.exec(f);
    if (!m) continue;
    const tsMs = Number(m[1]);
    if (now - tsMs > SEVEN_DAYS_MS) {
      await fs.unlink(path.join(REJECTED_DIR, f)).catch(() => {});
      deleted += 1;
    }
  }
  console.log(
    `[RejectedSamplesCleanup] Scanned ${files.length}, deleted ${deleted} crop(s) older than 7 days.`,
  );
  return { deleted, scanned: files.length };
}

function startRejectedSamplesCleanupScheduler() {
  // daily at 2:15 AM — offset from frameCleanupScheduler's 2:00 AM so the two don't hit disk at the exact same moment.
  cron.schedule("15 2 * * *", () => {
    runRejectedSamplesCleanupNow().catch((err) =>
      console.error("[RejectedSamplesCleanup] Failed:", err.message),
    );
  });
}

module.exports = {
  startRejectedSamplesCleanupScheduler,
  runRejectedSamplesCleanupNow,
};
