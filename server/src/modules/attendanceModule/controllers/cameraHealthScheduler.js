// server/src/modules/attendanceModule/controllers/cameraHealthScheduler.js
//
// Background job that keeps Camera.status / Camera.lastHeartbeat in sync with reality, without touching the attendance/recording pipeline at all.
//
// Design (scales to 50+ cameras)

const cron = require("node-cron");
const net = require("net");
const { spawn } = require("child_process");
const Camera = require("../../../models/attendanceModule/camera.js");

const CRON_SCHEDULE = process.env.CAMERA_HEALTH_CRON || "*/30 * * * * *"; // every 30s
const CONCURRENCY = parseInt(process.env.CAMERA_HEALTH_CONCURRENCY, 10) || 10;
const TCP_TIMEOUT_MS = parseInt(process.env.CAMERA_TCP_TIMEOUT_MS, 10) || 1200;
const FFPROBE_TIMEOUT_MS =
  parseInt(process.env.CAMERA_PROBE_TIMEOUT_MS, 10) || 12000;
// Only re-confirm a TCP-failed camera with the heavier ffprobe check this
// often (per camera), not on every 30s cycle.
const FFPROBE_CONFIRM_EVERY_MS =
  parseInt(process.env.CAMERA_FFPROBE_CONFIRM_MS, 10) || 5 * 60 * 1000;

let running = false; // guards against overlapping cycles
const lastFfprobeConfirmAt = new Map(); // cameraId -> timestamp

// ── Fast check: plain TCP connect, no video involved ───────────────────────
function probeTcpReachability(host, port, timeoutMs = TCP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!host || !Number.isFinite(Number(port))) {
      resolve(false);
      return;
    }
    const socket = new net.Socket();
    let settled = false;
    const finish = (online) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(Boolean(online));
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    try {
      socket.connect(Number(port), String(host));
    } catch (_) {
      finish(false);
    }
  });
}

// ── Slow, definitive check: is there an actual video stream? ───────────────
// Only used to confirm cameras that failed the fast TCP check, and only
// once every FFPROBE_CONFIRM_EVERY_MS per camera.
function probeRtsp(rtspUrl, timeoutMs = FFPROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const ffprobe = spawn("ffprobe", [
      "-v",
      "error",
      "-rtsp_transport",
      "tcp",
      "-timeout",
      "8000000",
      "-show_entries",
      "stream=codec_type",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      rtspUrl,
    ]);
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      ffprobe.kill("SIGKILL");
      resolve(false);
    }, timeoutMs);
    ffprobe.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(code === 0);
    });
    ffprobe.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(err && err.code === "ENOENT" ? null : false); // null = ffprobe missing on host
    });
  });
}

// ── Concurrency-capped runner: never more than `limit` promises in flight ──
async function runWithConcurrencyLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runNext() {
    const i = nextIndex++;
    if (i >= items.length) return;
    results[i] = await worker(items[i], i);
    await runNext();
  }

  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    runNext,
  );
  await Promise.all(runners);
  return results;
}

async function checkOneCamera(camera) {
  const fastOnline = await probeTcpReachability(camera.ipAddress, camera.port);

  if (fastOnline) {
    return { online: true, viaFfprobe: false };
  }

  // TCP failed — only spend the heavier ffprobe check if we haven't
  // recently confirmed this camera already.
  const last = lastFfprobeConfirmAt.get(String(camera._id)) || 0;
  if (Date.now() - last < FFPROBE_CONFIRM_EVERY_MS) {
    return { online: false, viaFfprobe: false };
  }

  lastFfprobeConfirmAt.set(String(camera._id), Date.now());
  const confirmed = await probeRtsp(camera.streamUrl);
  // confirmed === null means ffprobe isn't installed on this host — treat
  // the TCP failure as the final answer in that case.
  return { online: confirmed === true, viaFfprobe: confirmed !== null };
}

async function runProbeCycle() {
  if (running) return; // never overlap cycles
  running = true;
  try {
    const cameras = await Camera.find({ isActive: true }).lean();
    if (!cameras.length) return;

    await runWithConcurrencyLimit(cameras, CONCURRENCY, async (camera) => {
      try {
        const { online } = await checkOneCamera(camera);
        const newStatus = online ? "online" : "offline";
        if (camera.status !== newStatus || online) {
          await Camera.updateOne(
            { _id: camera._id },
            {
              $set: {
                status: newStatus,
                ...(online ? { lastHeartbeat: new Date() } : {}),
              },
            },
          );
        }
      } catch (err) {
        console.error(
          `[CameraHealthScheduler] Check failed for ${camera.cameraId}:`,
          err.message,
        );
      }
    });
  } catch (err) {
    console.error("[CameraHealthScheduler] Cycle failed:", err.message);
  } finally {
    running = false;
  }
}

function start() {
  console.log(
    `[CameraHealthScheduler] Starting: schedule=${CRON_SCHEDULE} concurrency=${CONCURRENCY}`,
  );
  cron.schedule(CRON_SCHEDULE, runProbeCycle);
  runProbeCycle(); // run once immediately on boot
}

module.exports = { start, runProbeCycle };
