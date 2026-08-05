const express = require('express');
const { checkRole } = require('../../checkRole.middleware');
const ReportDeletionSettingsController = require('../controllers/reportDeletionSettingsController');

const router = express.Router();
const controller = new ReportDeletionSettingsController();

// Attendance admins may read the flag so the UI can decide whether a
// department administrator gets the optional Delete action. Only the platform
// admin may change it.
const reportAdminsOnly = checkRole(['iams-admin', 'iams-dept-admin']);
const platformAdminsOnly = checkRole(['admin']);

router.get('/', reportAdminsOnly, (req, res) => controller.getSettings(req, res));
router.patch('/', platformAdminsOnly, (req, res) => controller.updateSettings(req, res));

module.exports = router;
