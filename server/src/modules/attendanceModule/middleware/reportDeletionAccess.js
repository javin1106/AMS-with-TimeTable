const ReportDeletionSettings = require('../../../models/attendanceModule/reportDeletionSettings');

async function requireReportDeletionEnabled(req, res, next) {
  try {
    const settings = await ReportDeletionSettings.getSettings();
    if (!settings.enabled) {
      return res.status(403).json({
        error: 'Saved attendance report deletion is disabled by the administrator.',
      });
    }
    next();
  } catch (error) {
    console.error('[ReportDeletionAccess]', error);
    res.status(500).json({ error: 'Failed to verify report deletion setting' });
  }
}

module.exports = { requireReportDeletionEnabled };
