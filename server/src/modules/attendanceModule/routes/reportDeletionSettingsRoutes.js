const express = require('express');
const { checkRole } = require('../../checkRole.middleware');
const ReportDeletionSettingsController = require('../controllers/reportDeletionSettingsController');

const router = express.Router();
const controller = new ReportDeletionSettingsController();

// checkRole deliberately grants the platform `admin` role a global bypass.
// This setting is an exception: only iams-admin owns the toggle, while
// iams-dept-admin may read its state to decide whether to render Delete.
const reportAdminsOnly = checkRole(['iams-admin', 'iams-dept-admin']);
const requireExactRole = (allowedRoles) => (req, res, next) => {
  const roles = Array.isArray(req.user?.roles)
    ? req.user.roles
    : [req.user?.roles].filter(Boolean);
  if (!allowedRoles.some((role) => roles.includes(role))) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  next();
};

router.get(
  '/',
  reportAdminsOnly,
  requireExactRole(['iams-admin', 'iams-dept-admin']),
  (req, res) => controller.getSettings(req, res),
);
router.patch(
  '/',
  reportAdminsOnly,
  requireExactRole(['iams-admin']),
  (req, res) => controller.updateSettings(req, res),
);

module.exports = router;
