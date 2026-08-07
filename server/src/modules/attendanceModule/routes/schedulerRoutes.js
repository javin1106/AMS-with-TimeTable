// server/src/modules/attendanceModule/routes/schedulerRoutes.js

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/schedulerController');
const { attendanceRoleAccess } = require('../middleware/attendanceAccess');

// The two POSTs trigger real ML runs and write attendance, so they are gated.
// run-room in particular replaces POST /reports/start-session, which sat behind
// attendanceRoleAccess — leaving it open would have quietly widened access to
// the flow. The GETs below are read-only and stay as they were.
router.post('/run-all', ...attendanceRoleAccess, ctrl.runAll);
router.post('/run-room', ...attendanceRoleAccess, ctrl.runRoomOne);
router.get('/preview', ctrl.preview);
router.get('/live-status', ctrl.liveStatus);
router.get('/working-day', ctrl.workingDayCheck);
router.get('/non-working-days', ctrl.nonWorkingDaysList);

module.exports = router;