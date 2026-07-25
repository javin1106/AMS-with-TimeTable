const RejectedSamplesCleanupSettings = require('../../../models/attendanceModule/rejectedSamplesCleanupSettings');
const { runRejectedSamplesCleanupNow } = require('./rejectedSamplesCleanupScheduler');

class RejectedSamplesCleanupSettingsController {
  async getSettings(req, res) {
    try {
      const settings = await RejectedSamplesCleanupSettings.getSettings();
      res.json({ settings });
    } catch (error) {
      console.error('[RejectedSamplesCleanupSettings] getSettings error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async updateEnabled(req, res) {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be a boolean' });
      }
      const settings = await RejectedSamplesCleanupSettings.getSettings();
      settings.enabled = enabled;
      await settings.save();
      res.json({ message: 'Updated', settings });
    } catch (error) {
      console.error('[RejectedSamplesCleanupSettings] updateEnabled error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async runNow(req, res) {
    try {
      const stats = await runRejectedSamplesCleanupNow();
      const settings = await RejectedSamplesCleanupSettings.getSettings();
      res.json({ message: 'Cleanup run complete', stats, settings });
    } catch (error) {
      console.error('[RejectedSamplesCleanupSettings] runNow error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}

module.exports = RejectedSamplesCleanupSettingsController;
