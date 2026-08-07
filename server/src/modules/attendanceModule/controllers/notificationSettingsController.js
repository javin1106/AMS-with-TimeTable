const NotificationSettings = require('../../../models/attendanceModule/notificationSettings');
const { sendFacultyAttendanceSummary } = require('./facultyAttendanceMailer');

const ALERT_KEYS = ['serverDown', 'erpDown', 'lowConfidence', 'noReportSaved', 'classBunk', 'duplicateAttendance', 'dailySummary', 'embeddingProgress', 'scheduleCheck'];
const VALID_ROLES = ['admin', 'coordinator', 'head'];
const VALID_FREQUENCIES = ['daily', 'weekly'];
const VALID_MODES = ['all', 'threshold'];

function normalizeAlertTypes(input = {}) {
  const result = {};
  for (const key of ALERT_KEYS) result[key] = !!input[key];
  return result;
}

class NotificationSettingsController {
  async getSettings(req, res) {
    try {
      const settings = await NotificationSettings.getSettings();
      res.json({ settings });
    } catch (error) {
      console.error('[NotificationSettings] getSettings error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async updateEnabled(req, res) {
    try {
      const { enabled } = req.body;
      const settings = await NotificationSettings.getSettings();
      if (typeof enabled === 'boolean') settings.enabled = enabled;
      await settings.save();
      res.json({ message: 'Updated', settings });
    } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  // Update alertTypes for a specific role
  async updateRoleAlertTypes(req, res) {
    try {
      const { role } = req.params;
      const { alertTypes } = req.body;
      if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
      const settings = await NotificationSettings.getSettings();
      const roleDoc = settings.roles.find((r) => r.role === role);
      if (!roleDoc) return res.status(404).json({ error: 'Role not found' });
      roleDoc.alertTypes = normalizeAlertTypes(alertTypes);
      await settings.save();
      res.json({ message: 'Role updated', settings });
    } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async addRecipient(req, res) {
    try {
      const { email, role, dept } = req.body;
      if (!email || !role) return res.status(400).json({ error: 'email and role required' });
      if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
      if ((role === 'coordinator' || role === 'head') && !dept)
        return res.status(400).json({ error: 'dept required for coordinator/head' });
      const settings = await NotificationSettings.getSettings();
      const exists = settings.recipients.some(
        (r) => r.email === email && r.role === role && r.dept === (dept || '')
      );
      if (exists) return res.status(409).json({ error: 'Recipient already exists' });
      settings.recipients.push({ email, role, dept: dept || '' });
      await settings.save();
      res.json({ message: 'Recipient added', settings });
    } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  // Update the daily/weekly HOD attendance-summary config (what/when it sends —
  // separate from alertTypes.dailySummary, which controls who receives it)
  async updateDailySummaryConfig(req, res) {
    try {
      const { enabled, frequency, mode, threshold } = req.body;
      const settings = await NotificationSettings.getSettings();
      const cfg = settings.dailySummaryConfig;
      if (typeof enabled === 'boolean') cfg.enabled = enabled;
      if (frequency !== undefined) {
        if (!VALID_FREQUENCIES.includes(frequency)) return res.status(400).json({ error: 'Invalid frequency' });
        cfg.frequency = frequency;
      }
      if (mode !== undefined) {
        if (!VALID_MODES.includes(mode)) return res.status(400).json({ error: 'Invalid mode' });
        cfg.mode = mode;
      }
      if (threshold !== undefined) {
        const num = Number(threshold);
        if (!Number.isFinite(num) || num < 0 || num > 100) return res.status(400).json({ error: 'threshold must be 0-100' });
        cfg.threshold = num;
      }
      await settings.save();
      res.json({ message: 'Updated', settings });
    } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  // Update the end-of-class faculty attendance summary config. Only an on/off
  // switch plus optional BCC addresses — there is no per-role opt-in because
  // the recipient is the faculty named on the timetable, not a configured role.
  async updateFacultySummaryConfig(req, res) {
    try {
      const { enabled, bccEmails } = req.body;
      const settings = await NotificationSettings.getSettings();
      const cfg = settings.facultySummaryConfig;
      if (typeof enabled === 'boolean') cfg.enabled = enabled;
      if (bccEmails !== undefined) {
        if (!Array.isArray(bccEmails)) return res.status(400).json({ error: 'bccEmails must be an array' });
        const cleaned = bccEmails.map((e) => String(e).trim()).filter(Boolean);
        const bad = cleaned.find((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
        if (bad) return res.status(400).json({ error: `Invalid email address: ${bad}` });
        cfg.bccEmails = cleaned;
      }
      await settings.save();
      res.json({ message: 'Updated', settings });
    } catch (error) {
      console.error('[NotificationSettings] updateFacultySummaryConfig error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  // POST — send one sample faculty summary to an arbitrary address, so the
  // toggle can be checked without waiting for a class to end. Uses the most
  // recent report with a finalReport when none is named; falls back to
  // representative sample data when the database has no reports yet.
  async sendFacultySummarySample(req, res) {
    try {
      const { email, reportId } = req.body;
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
        return res.status(400).json({ error: 'A valid email is required' });
      }

      const AttendanceReport = require('../../../models/attendanceReport');
      const report = reportId
        ? await AttendanceReport.findById(reportId)
        : await AttendanceReport.findOne({ 'finalReport.0': { $exists: true } }).sort({ date: -1 });

      if (!report) {
        return res.status(404).json({
          error: 'No attendance report with a finalReport exists yet — run a class first, or pass reportId',
        });
      }

      // force: bypass the toggles and the already-sent guard; toOverride keeps
      // it off the faculty's inbox and stops it consuming this period's send.
      const outcome = await sendFacultyAttendanceSummary(report, {
        force: true,
        toOverride: String(email).trim(),
      });
      if (!outcome.sent) return res.status(502).json({ error: outcome.reason });

      res.json({
        message: `Sample sent to ${outcome.to}`,
        reportId: report._id,
        date: report.date,
        timeSlot: report.timeSlot,
        subject: report.subject,
      });
    } catch (error) {
      console.error('[NotificationSettings] sendFacultySummarySample error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async removeRecipient(req, res) {
    try {
      const { id } = req.params;
      const settings = await NotificationSettings.getSettings();
      settings.recipients = settings.recipients.filter((r) => r._id.toString() !== id);
      await settings.save();
      res.json({ message: 'Recipient removed', settings });
    } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}

module.exports = NotificationSettingsController;
// Exposed for unit tests (static on the class; `new` callers unaffected)
module.exports.normalizeAlertTypes = normalizeAlertTypes;
