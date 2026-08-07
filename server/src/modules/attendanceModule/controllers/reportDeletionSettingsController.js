const ReportDeletionSettings = require('../../../models/attendanceModule/reportDeletionSettings');

class ReportDeletionSettingsController {
  async getSettings(req, res) {
    try {
      const settings = await ReportDeletionSettings.getSettings();
      res.json({ enabled: settings.enabled });
    } catch (error) {
      console.error('[ReportDeletionSettings] getSettings error:', error);
      res.status(500).json({ error: 'Failed to load report deletion settings' });
    }
  }

  async updateSettings(req, res) {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be a boolean' });
      }

      const settings = await ReportDeletionSettings.getSettings();
      settings.enabled = enabled;
      await settings.save();

      res.json({ message: 'Report deletion setting updated', enabled });
    } catch (error) {
      console.error('[ReportDeletionSettings] updateSettings error:', error);
      res.status(500).json({ error: 'Failed to update report deletion settings' });
    }
  }
}

module.exports = ReportDeletionSettingsController;
