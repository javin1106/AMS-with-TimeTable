require("./nodeLogBuffer"); // must load first to capture all subsequent console output

const path = require("path");
const dotenv = require("dotenv");
dotenv.config({ path: path.join(__dirname, "../.env") });

const express = require("express");
const app = express();
const mongoose = require("mongoose");

const cors = require("cors");
const cookieParser = require("cookie-parser");

const axios = require("axios");
const helmet = require("helmet");
const { applyAuthRateLimits } = require("./modules/usermanagement/loginRateLimit");
// Must load before any route module makes its first request to the ML
// service — registers the axios interceptor that attaches the shared-secret
// header (see mlServiceAuth.js).
require("./modules/attendanceModule/controllers/mlServiceAuth");
const v1router = require("./routes");
const { startAutoScheduler } = require('./modules/attendanceModule/controllers/autoAttendanceScheduler');
const { startGpuMetricsCollector } = require('./modules/attendanceModule/controllers/gpuMetricsCollector');
const alertNotifier = require("./modules/attendanceModule/controllers/alertNotifier");
const cameraHealthScheduler = require("./modules/attendanceModule/controllers/cameraHealthScheduler");

// Log and DIE, rather than log and limp on. After an uncaught throw the
// process state is undefined — a half-finished attendance run, a mongoose
// connection mid-operation, timers whose callbacks will never fire — and a
// process that stays up in that state is worse than one that exits, because
// the supervisor (pm2 / systemd Restart=always / Docker restart policy) never
// learns it needs restarting and the scheduler quietly stops firing periods
// while the health check still says the server is up.
//
// The exit is delayed a beat so the log line actually reaches the transports
// in nodeLogBuffer before the process goes.
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION — exiting for the supervisor to restart:', err);
  setTimeout(() => process.exit(1), 500).unref();
});
process.on('unhandledRejection', (err) => console.error('UNHANDLED REJECTION:', err));


// NOTE: never print env values here — MONGO_URL/JWT_SECRET are secrets and
// the console output is surfaced in the Node Console page / log buffers.
if (!process.env.MONGO_URL || !process.env.JWT_SECRET) {
  console.warn('ENV CHECK: MONGO_URL and/or JWT_SECRET are NOT set — check the server .env');
}

// Security headers
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginEmbedderPolicy: false,
}));

// CORS configuration
app.use(
  cors({
    origin: [
      "http://localhost:5173",  "http://localhost:5174","https://chemcon2024.com",
      "http://127.0.0.1:5173",
      "https://nitjtt.netlify.app",
      "http://localhost:8010",
      "http://xceed.learning.app",
      "capacitor://xceed.learning.app",
      //for chemcon
      "http://localhost:5174","https://chemcon2024.com",
  //for eaic2025
  "https://eaicnitj.com",
"https://eaic2025.netlify.app",
  //for civil site
  "https://igcnitj2025.netlify.app",
  "https://igc2025nitj.com",
      //for diabetics work
  "https://t1dixpert.netlify.app",
"https://it1dxpert.org",
  //for physics site
 "https://amsdt2025.com",
      //for ece site
"https://cipher2026.com",
"https://vistanitj.com",
"https://vistaece.netlify.app",
"https://projectipecon.netlify.app",
      "https://glogift2026.com",
      "https://mac2027.com",
      "https://nitjtt.vercel.app"

    ], // Change this to your allowed origins or '*' to allow all origins
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
    optionsSuccessStatus: 204,
    // X-Short-Guest carries a live Short's guest identity for participants with
    // no account. Omitting it here makes the browser fail the preflight, so an
    // open Short would be unjoinable from any deployed origin.

    // X-Quiz-Session names the one browser allowed to drive a quiz sitting. Same
    // rule: leave it out and every deployed origin fails the preflight, which
    // fails the whole sitting rather than only the proctoring.
    allowedHeaders: "Content-Type, Authorization, X-Short-Guest, X-Quiz-Session , X-App-Name",
    credentials: true, // Set to true if you need to allow credentials (e.g., cookies)
  })
);

// Load environment variables from .env file


// Middleware

// Create a middleware to check the database connection
const checkDatabaseConnection = (req, res, next) => {
  // Check if the database connection is ready
  if (mongoose.connection.readyState === 1) {
    // 1 indicates the connection is open
    next(); // Proceed to the next middleware or route handler
  } else {
    res.status(500).json({ error: "Database connection is not established" });
  }
};

mongoose.connection.on("connected", () => {
  // Iterate through all models and apply the hook
  mongoose.modelNames().forEach((modelName) => {
    const model = mongoose.model(modelName);
    model.schema.pre("save", function (next) {
      const currentDate = new Date();

      if (!this.created_at) {
        this.created_at = currentDate;
      }

      this.updated_at = currentDate;
      next();
    });
  });
});



// default route
// app.get('/', (req, res) => {
//     res.send('Hello World!');
// })

// Logger
app.use((req, res, next) => {
  // console.log(req.method, req.path)
  next()
})

// Middleware to set base URL
app.use((req, res, next) => {
  const baseURL = `${req.protocol}://${req.get('host')}`;
  req.baseURL = baseURL;
  next();
});

// app.use(express.json());
// `verify` stashes the exact raw bytes on req.rawBody before JSON parsing —
// needed by inbound webhook-style endpoints (e.g. the ERP faculty-override
// sync callback) that must HMAC-verify the body exactly as sent, since a
// re-serialised JSON.stringify(req.body) can differ in key order/whitespace
// and would produce a false signature mismatch.
app.use(express.json({
  limit: '50mb',
  verify: (req, res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
// app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
// Throttling for the credential endpoints.
//
// Registered here, *after* express.json, and not up with the other top-of-file
// middleware: the per-account limiter keys on req.body.email, and before the
// body parser runs that is always undefined — every request would land in one
// shared bucket and five bad passwords anywhere would lock out the whole
// installation.
//
// See loginRateLimit.js for why the strict limit is keyed on the account rather
// than the IP, and for the paths the previous limiter was watching by mistake.
applyAuthRateLimits(app);

app.use(checkDatabaseConnection);
app.use(express.static(path.join(__dirname + "/../../client/dist")));
app.use("/uploads",express.static(path.join(__dirname ,"..","uploads")));

app.get('/proxy-image', async (req, res) => {
  try {
    const imageUrl = req.query.url

    // Make a request to the image URL
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' })

    // Set appropriate headers for the image
    res.set('Content-Type', response.headers['content-type'])
    res.send(response.data)
  } catch (error) {
    console.error('Error proxying image:', error.message)
    res.status(500).send('Internal Server Error')
  }
})

app.use(v1router); // TODO: Remove this line after frontend is updated to use /api/v1 prefix
app.use("/api/v1", v1router);

app.get("/*", (req, res) => {
  res.sendFile(path.join(__dirname + "/../../client/dist/index.html"));
});

// Connect to MongoDB and listen for events

mongoose
  .connect(process.env.MONGO_URL, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => {
    console.log("Connected to MongoDB");
    // Start the Express server once connected to MongoDB
    const PORT = process.env.PORT || 8010;
    const server = app.listen(PORT, () => {
      console.log(`Server started on port ${PORT}`);
      
      // Register lifecycle alerts (startup & shutdown)
      alertNotifier.setupServerLifecycleAlerts();

      // Checks the SMTP settings once, here, rather than per message — bad
      // credentials or an unreachable host now show up in the boot log instead
      // of as an invite that quietly went nowhere. Never throws.
      require("./modules/mailerModule/transport").verifyTransport();

      // ── Restart reconciliation ────────────────────────────────
      // Finishes what an interrupted process left behind: reports stranded in
      // status 'live' by a session whose timers died with the old process, and
      // end-of-period faculty summaries that never went because the run never
      // reached its last check. Idempotent and safe to run on every boot; runs
      // before the scheduler so a period it is about to resume is already in a
      // consistent state. Not awaited — a slow sweep must not delay listening.
      const { reconcileAfterRestart } = require('./modules/attendanceModule/controllers/schedulerRecovery');
      reconcileAfterRestart().catch((err) =>
        console.error('[SchedulerRecovery] Sweep failed:', err.message));

     // ── Auto Attendance Scheduler ─────────────────────────────
      // No args needed — rooms, periods, and run settings are now read
      // live from AcquisitionControl + the Camera Registry on every tick.
      startAutoScheduler();
      cameraHealthScheduler.start();
      console.log('[AutoScheduler] Scheduler started — DB-driven (rooms, periods, embeddings).'); 

      // ── Frame Cleanup Scheduler (Task #1544) ──────────────────
      // Deletes frames older than 7 days; keeps only the best
      // annotated frame (highest face count) per camera per period.
      const { startFrameCleanupScheduler } = require('./modules/attendanceModule/controllers/frameCleanupScheduler');
      if (process.env.NODE_ENV === 'production') {
        startFrameCleanupScheduler();
        console.log('[FrameCleanup] Production storage retention scheduler registered successfully.');
      } else {
        console.log('[FrameCleanup] Development environment detected — Scheduler paused to protect local assets.');
      }

      // ── Rejected Samples Cleanup Scheduler (Issue #1711) ──────
      // Deletes liveness-rejected crops older than 7 days.
      const { startRejectedSamplesCleanupScheduler } = require('./modules/attendanceModule/controllers/rejectedSamplesCleanupScheduler');
      if (process.env.NODE_ENV === 'production') {
        startRejectedSamplesCleanupScheduler();
        console.log('[RejectedSamplesCleanup] Production 7-day retention scheduler registered successfully.');
      } else {
        console.log('[RejectedSamplesCleanup] Development environment detected — Scheduler paused to protect local assets.');
      }

      // ── HOD Daily/Weekly Attendance Summary Scheduler ─────────
      // Actual enabled/frequency/threshold behavior is controlled from the
      // Email Notifications settings tab (NotificationSettings.dailySummaryConfig).
      const { startHodSummaryScheduler } = require('./modules/attendanceModule/controllers/hodSummaryScheduler');
      startHodSummaryScheduler();

      // ── Weekly Embedding Progress Scheduler ───────────────────
      // Emails head/coordinator recipients a per-subject embedding/ground-truth
      // readiness summary, gated by the same NotificationSettings.enabled flag
      // and the "Embedding Progress" per-role opt-in.
      const { startEmbeddingProgressScheduler } = require('./modules/attendanceModule/controllers/embeddingProgressScheduler');
      startEmbeddingProgressScheduler();

      // ── ERP Auto-Sync Scheduler ───────────────────────────────
      // Nightly: re-fetches every subject's ERP roster and regenerates
      // embeddings ONLY for subjects whose roster actually changed since
      // last sync (no-op until ERP_PORTAL_KEY is configured; toggle on/off
      // from the ERP Sync page — see ErpSyncSettings).
      const { startErpAutoSyncScheduler } = require('./modules/attendanceModule/controllers/erpAutoSyncScheduler');
      startErpAutoSyncScheduler();

      // ── ERP Attendance Push Retry Schedulers ───────────────────
      // Fast sweep: ticks every minute for reports whose push to ERP's
      // attendance-posting endpoint is pending/failed and due (attempt cap +
      // retry interval are both admin-editable — see the ERP Controls page's
      // Retry Policy card / ErpPushSettings). Nightly: a second, independent
      // evening pass that retries every still-failed period bypassing the
      // attempt cap — toggled separately via ErpPushSettings.nightlyRetryEnabled.
      // Both no-op until ERP_ATTENDANCE_PUSH_URL/ERP_PUSH_SECRET are configured.
      const { startErpPushRetryScheduler, startErpNightlyRetryScheduler } = require('./modules/attendanceModule/controllers/erpAttendancePushController');
      startErpPushRetryScheduler();
      startErpNightlyRetryScheduler();

      // ── Scheduled Uptime Digest ───────────────────────────────
      // Twice a day (08:30 & 13:30 IST, Mon–Fri) probes the Client,
      // Node server public URL, ERP, and H100 ML service, and emails one
      // consolidated Server Down digest if any are unreachable. Distinct
      // from the edge-triggered 30s health monitor in healthRoutes.js —
      // recipients come from the same serverDown opt-in. Probe targets are
      // CLIENT_HEALTH_URL / SERVER_HEALTH_URL (plus ML_SERVICE_URL / ERP_STUDENTS_API_URL).
      const { startUptimeDigestScheduler } = require('./modules/attendanceModule/controllers/uptimeDigestScheduler');
      startUptimeDigestScheduler();

      // ── Continuous GPU Metrics Collection (Issue #1739) ──────
      // Samples the ML/GPU service independently of the View Metrics page.
      // MongoDB TTL retention keeps the history bounded.
      startGpuMetricsCollector();

    });
    server.setTimeout(600000); // 10 min — prevents Node killing long SSE connections
    server.keepAliveTimeout = 620000;
    server.headersTimeout   = 620000;
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\n❌ Port ${PORT} is already in use.`);
        console.error(`   Run: netstat -ano | findstr :${PORT}`);
        console.error(`   Then: taskkill /PID <PID> /F`);
        process.exit(1);
      } else {
        throw err;
      }
    });

    // ── Graceful shutdown ───────────────────────────────────────
    // Most restarts are deploys, and a deploy used to cost exactly what a
    // crash costs: the in-flight period lost its remaining checks and, worse,
    // its faculty summary — that mail only fires after the last check, so
    // killing the process anywhere before it means the class is never mailed.
    //
    // Instead: stop claiming new periods, let each in-flight run finish the
    // check it is on and break out of its loop (it then takes its own normal
    // end-of-run path, mail included), and only then close the listener. The
    // ledger keeps whatever could not finish reclaimable, so the next process
    // resumes the period if there is still time in it.
    let shuttingDown = false;
    const gracefulShutdown = async (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[Shutdown] ${signal} received — draining in-flight attendance runs…`);

      // Hard ceiling. A run wedged on an unresponsive RTSP stream must not
      // hold a deploy open forever; the supervisor would SIGKILL us anyway,
      // and losing the drain is better than losing control of when we exit.
      const forceExit = setTimeout(() => {
        console.error('[Shutdown] Drain timed out — forcing exit');
        process.exit(1);
      }, 120000);
      forceExit.unref();

      try {
        const { shutdownAutoScheduler } = require('./modules/attendanceModule/controllers/autoAttendanceScheduler');
        const { drained, pending } = await shutdownAutoScheduler({ timeoutMs: 90000 });
        if (!drained) {
          console.warn(`[Shutdown] ${pending.length} run(s) did not drain in time — their periods stay resumable`);
        }
      } catch (err) {
        console.error('[Shutdown] Scheduler drain failed:', err.message);
      }

      server.close(() => console.log('[Shutdown] HTTP listener closed'));
      try {
        await mongoose.connection.close(false);
        console.log('[Shutdown] MongoDB connection closed');
      } catch (err) {
        console.error('[Shutdown] MongoDB close failed:', err.message);
      }
      clearTimeout(forceExit);
      process.exit(0);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
  })
  .catch((err) => {
    console.error("Error connecting to MongoDB:", err);
  });

// Handle MongoDB connection events
mongoose.connection.on("connected", () => {
  console.log("Mongoose connected to MongoDB");
});

mongoose.connection.on("error", (err) => {
  console.error("Mongoose connection error:", err);
});

mongoose.connection.on("disconnected", () => {
  console.log("Mongoose disconnected from MongoDB");
});
