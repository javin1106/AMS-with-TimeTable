const express = require('express');
const router = express.Router();
const RejectedSamplesCleanupSettingsController = require('../controllers/rejectedSamplesCleanupSettingsController');
const controller = new RejectedSamplesCleanupSettingsController();

router.get('/', async (req, res) => await controller.getSettings(req, res));
router.put('/', async (req, res) => await controller.updateEnabled(req, res));
router.post('/run-now', async (req, res) => await controller.runNow(req, res));

module.exports = router;
