const express = require('express');
const { checkRole } = require('../../checkRole.middleware');
const ReportDeletionSettingsController = require('../controllers/reportDeletionSettingsController');

const router = express.Router();
const controller = new ReportDeletionSettingsController();

// Both roles may read the flag because iams-admin needs it to decide whether
// to render Delete. Only the platform admin may change it.
const reportAdminsOnly = checkRole(['iams-admin']);
const platformAdminsOnly = checkRole(['admin']);

router.get('/', reportAdminsOnly, (req, res) => controller.getSettings(req, res));
router.patch('/', platformAdminsOnly, (req, res) => controller.updateSettings(req, res));

module.exports = router;
