const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const axios = require("axios");
const mlClient = require("../controllers/mlServiceClient");
const alertNotifier = require("../controllers/alertNotifier");
const nodeLogBuffer = require("../../../nodeLogBuffer");
const { erpConfigured, ERP_STUDENTS_API_URL } = require("../controllers/erpSyncController");

let prevMlStatus = "online";
let mlAlertInProgress = false;
let prevErpStatus = "online";
let erpAlertInProgress = false;
let consecutiveMlFailures = 0;
let consecutiveMlSuccesses = 0;
const ML_ALERT_THRESHOLD = 3;

let consecutiveErpFailures = 0;
let consecutiveErpSuccesses = 0;
const ERP_ALERT_THRESHOLD = 3;

let cachedHealthStatus = null;
let lastHealthCheckTime = 0;
let healthCheckPromise = null;

async function performHealthCheck() {
  const mlTarget = mlClient.getTargetInfo();
  const response = {
    timestamp: new Date().toISOString(),
    services: {
      server: {
        status: "online",
        uptime: Math.floor(process.uptime()),
      },
      database: {
        status: "offline",
      },
      ml: {
        status: "offline",
        latency: null,
        target: mlTarget,
      },
      tunnel: {
        status: mlTarget.kind === "h100" ? "checking" : "not_configured",
        target: mlTarget,
      },
      erp: {
        status: "not_configured",
        latency: null,
      },
    },
  };

  // Database check
  if (mongoose.connection.readyState === 1) {
    response.services.database.status = "online";
  }

  // ML Service check
  const mlStart = Date.now();
  try {
    const mlHealth = await mlClient.healthCheck();
    response.services.ml.status = "online";
    consecutiveMlFailures = 0;
    consecutiveMlSuccesses++;

    // Recovery: only mail if we had previously alerted that it went down,
    // and it has been stable for a few checks.
    if (prevMlStatus === "offline" && !mlAlertInProgress && consecutiveMlSuccesses >= ML_ALERT_THRESHOLD) {
      mlAlertInProgress = true;
      await alertNotifier.notifyServerRecovered("ML Service");
      mlAlertInProgress = false;
      prevMlStatus = "online";
    } else if (prevMlStatus === "offline" && consecutiveMlSuccesses >= ML_ALERT_THRESHOLD) {
      // Just in case it was recovering while alert was in progress
      prevMlStatus = "online";
    }

    // Always set prevMlStatus to online if it was already online, to reset state if it didn't fully trigger down
    if (prevMlStatus === "online") {
        consecutiveMlSuccesses = Math.min(consecutiveMlSuccesses, ML_ALERT_THRESHOLD);
    }

    response.services.ml.latency = Date.now() - mlStart;
    response.services.ml.models = mlHealth.models || null;
    response.services.ml.activeDetector = mlHealth.active_detector || null;
    response.services.ml.studentsEnrolled = mlHealth.students_enrolled ?? null;
    response.services.tunnel.status =
      mlTarget.kind === "h100" ? "online" : "not_configured";
  } catch (error) {
    response.services.ml.status = "offline";
    response.services.tunnel.status =
      mlTarget.kind === "h100" ? "offline" : "not_configured";
    
    consecutiveMlSuccesses = 0;
    consecutiveMlFailures++;

    if (prevMlStatus === "online" && !mlAlertInProgress && consecutiveMlFailures >= ML_ALERT_THRESHOLD) {
      mlAlertInProgress = true;
      prevMlStatus = "offline";
      await alertNotifier.notifyServerDown("ML Service", error.message);
      mlAlertInProgress = false;
    }
  }

  // ERP reachability check — a plain HTTP reachability probe, not an
  // auth/data check. Any HTTP response (even 404/401) means the ERP server
  // process answered, so it counts as online; only a network-level failure
  // (timeout, DNS, connection refused) counts as offline. The roster endpoint
  // only serves POST, so this GET is expected to come back as an error status
  // — that is fine, validateStatus accepts anything.
  if (erpConfigured()) {
    const erpStart = Date.now();
    try {
      await axios.get(ERP_STUDENTS_API_URL, { timeout: 5000, validateStatus: () => true });
      response.services.erp.status = "online";
      response.services.erp.latency = Date.now() - erpStart;
      
      consecutiveErpFailures = 0;
      consecutiveErpSuccesses++;

      if (prevErpStatus === "offline" && !erpAlertInProgress && consecutiveErpSuccesses >= ERP_ALERT_THRESHOLD) {
        erpAlertInProgress = true;
        await alertNotifier.notifyErpRecovered();
        erpAlertInProgress = false;
        prevErpStatus = "online";
      } else if (prevErpStatus === "offline" && consecutiveErpSuccesses >= ERP_ALERT_THRESHOLD) {
        prevErpStatus = "online";
      }

      if (prevErpStatus === "online") {
          consecutiveErpSuccesses = Math.min(consecutiveErpSuccesses, ERP_ALERT_THRESHOLD);
      }

    } catch (error) {
      response.services.erp.status = "offline";
      
      consecutiveErpSuccesses = 0;
      consecutiveErpFailures++;

      if (prevErpStatus === "online" && !erpAlertInProgress && consecutiveErpFailures >= ERP_ALERT_THRESHOLD) {
        erpAlertInProgress = true;
        prevErpStatus = "offline";
        await alertNotifier.notifyErpDown(error.message);
        erpAlertInProgress = false;
      }
    }
  }

  return response;
}

async function getHealthStatus() {
  const now = Date.now();
  if (cachedHealthStatus && (now - lastHealthCheckTime < 1500)) {
    return cachedHealthStatus;
  }
  if (healthCheckPromise) {
    return healthCheckPromise;
  }

  healthCheckPromise = (async () => {
    try {
      cachedHealthStatus = await performHealthCheck();
      lastHealthCheckTime = Date.now();
      return cachedHealthStatus;
    } finally {
      healthCheckPromise = null;
    }
  })();
  return healthCheckPromise;
}

router.get("/status", async (req, res) => {
  res.json(await getHealthStatus());
});

// Node's own console output, mirroring the Python ML service's /logs endpoint
router.get("/node-logs", (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 200;
  res.json(nodeLogBuffer.getLogs(limit));
});

// Stream endpoint for real-time auto-updates via SSE
router.get("/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Initial push
  getHealthStatus().then((status) => {
    res.write(`data: ${JSON.stringify(status)}\n\n`);
  });

  // Poll every 2 seconds and push updates
  const intervalId = setInterval(async () => {
    const status = await getHealthStatus();
    res.write(`data: ${JSON.stringify(status)}\n\n`);
  }, 2000);

  req.on("close", () => {
    clearInterval(intervalId);
    res.end();
  });
});

// Background health monitor (skipped under test — module-load timers leak
// into test runners; unref'd so it never keeps the process alive on its own)
if (process.env.NODE_ENV !== "test") {
  setInterval(() => {
    getHealthStatus().catch((err) =>
      console.error("[HealthMonitor] check failed:", err.message),
    );
  }, 30 * 1000).unref();
} else {
  router._resetState = () => {
    cachedHealthStatus = null;
    lastHealthCheckTime = 0;
    healthCheckPromise = null;
    consecutiveMlFailures = 0;
    consecutiveMlSuccesses = 0;
    prevMlStatus = "online";
    mlAlertInProgress = false;
    consecutiveErpFailures = 0;
    consecutiveErpSuccesses = 0;
    prevErpStatus = "online";
    erpAlertInProgress = false;
  };
}

module.exports = router;
