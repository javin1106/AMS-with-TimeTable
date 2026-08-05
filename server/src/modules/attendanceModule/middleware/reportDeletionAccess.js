const ReportDeletionSettings = require('../../../models/attendanceModule/reportDeletionSettings');

async function requireReportDeletionAccess(req, res, next) {
  try {
    const roles = Array.isArray(req.user?.roles)
      ? req.user.roles
      : [req.user?.roles].filter(Boolean);

    // Platform and IAMS admins always have report-deletion access. The
    // feature flag is only the opt-in for department administrators.
    if (roles.includes('admin') || roles.includes('iams-admin')) return next();

    const settings = await ReportDeletionSettings.getSettings();
    if (!settings.enabled) {
      return res.status(403).json({
        error: 'Saved attendance report deletion is not enabled for department administrators.',
      });
    }
    next();
  } catch (error) {
    console.error('[ReportDeletionAccess]', error);
    res.status(500).json({ error: 'Failed to verify report deletion setting' });
  }
}

module.exports = { requireReportDeletionAccess };
