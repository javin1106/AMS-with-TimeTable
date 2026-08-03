// Runs before any module is required (jest setupFiles).
// checkRole.middleware.js and erpSyncController.js read env at module load,
// so these must be in place before the first require.
const path = require("path");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret";
process.env.ML_SERVICE_SECRET = "test-ml-service-secret";
process.env.ATTENDANCE_DAILY_DATA_DIR = path.join(__dirname, ".tmp-daily-data");

// Default to the "unconfigured" branches; suites that need a configured ERP
// set the var inside jest.isolateModules. ERP_STUDENTS_API_URL has a built-in
// default, so the portal key is what actually gates the ERP.
delete process.env.ERP_PORTAL_KEY;
delete process.env.PORTAL_KEY;
delete process.env.ERP_STUDENTS_API_URL;
delete process.env.ML_SERVICE_URL;
