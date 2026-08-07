// server/src/modules/attendanceModule/routes/erpSyncRoutes.js
// ERP roster sync — fetch subject roll numbers from the external ERP server
// and persist them on Subject docs. See erpSyncController.js for the env
// configuration (ERP_PORTAL_KEY, optional ERP_STUDENTS_API_URL) and the
// expected ERP response shapes. Mounted under /erp-sync in routes/index.js
// behind attendanceRoleAccess + enforceAttendanceDepartment, same as the
// sibling attendance routers.

const express = require('express');
const router  = express.Router();
const { listSubjects, fetchRolls, fetchRollsBulk, getSettings, updateSettings, probeErp } = require('../controllers/erpSyncController');
const { runNow } = require('../controllers/erpAutoSyncScheduler');

router.get('/subjects', listSubjects);
router.post('/fetch-rolls', fetchRolls);
router.post('/fetch-rolls-bulk', fetchRollsBulk);
// Diagnostic: sends one roster request built from exactly the posted fields
// and returns the ERP's raw, uninterpreted response next to the request that
// produced it. Persists nothing — for comparing this server's request against
// one that is known to work by hand.
router.post('/probe', probeErp);
router.get('/settings', getSettings);
router.patch('/settings', updateSettings);
// Manual trigger for the nightly roster-sync job — same runErpAutoSync() the
// 02:00 cron calls, runs institute-wide (all subjects, not one department).
router.post('/run-now', runNow);

module.exports = router;
