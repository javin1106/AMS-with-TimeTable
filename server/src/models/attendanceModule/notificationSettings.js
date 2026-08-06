const mongoose = require("mongoose");

// Controls what each role receives — 3 fixed roles, always present
const roleSettingsSchema = new mongoose.Schema({
  role: { type: String, enum: ["admin", "coordinator", "head"], required: true },
  alertTypes: {
    serverDown:          { type: Boolean, default: false },
    erpDown:             { type: Boolean, default: false },
    lowConfidence:       { type: Boolean, default: false },
    noReportSaved:       { type: Boolean, default: false },
    classBunk:           { type: Boolean, default: false },
    duplicateAttendance: { type: Boolean, default: false },
    dailySummary:        { type: Boolean, default: false },
    embeddingProgress:   { type: Boolean, default: false },
    scheduleCheck:       { type: Boolean, default: false },
  },
}, { _id: false });

// Just email + role + dept — no alertTypes here
const recipientSchema = new mongoose.Schema({
  email:    { type: String, required: true, trim: true },
  role:     { type: String, enum: ["admin", "coordinator", "head"], required: true },
  dept:     { type: String, trim: true, default: "" },
}, { _id: true });

// Controls when/what the daily-or-weekly HOD attendance summary sends —
// distinct from alertTypes.dailySummary above (which controls WHO receives
// it, per role, same as the other 5 alert types).
const dailySummaryConfigSchema = new mongoose.Schema({
  enabled:   { type: Boolean, default: false },
  frequency: { type: String, enum: ["daily", "weekly"], default: "daily" },
  mode:      { type: String, enum: ["all", "threshold"], default: "all" },
  threshold: { type: Number, default: 75 }, // percent; only used when mode === "threshold"
}, { _id: false });

// End-of-class attendance summary mailed to the faculty who taught the period.
// Unlike every alertType above, the recipient is not a configured role — it is
// the faculty named on the timetable, resolved to their Faculty.email. So there
// is no per-role opt-in for it, just this on/off switch (plus the global
// `enabled` flag, which still gates it like everything else).
const facultySummaryConfigSchema = new mongoose.Schema({
  enabled: { type: Boolean, default: false },
  // Blind-copy every faculty summary to these addresses (HOD / office).
  // Empty by default — the faculty alone receives it.
  bccEmails: { type: [String], default: [] },
}, { _id: false });

const notificationSettingsSchema = new mongoose.Schema({
  enabled:              { type: Boolean, default: false },
  roles:                { type: [roleSettingsSchema], default: [] },
  recipients:           { type: [recipientSchema], default: [] },
  dailySummaryConfig:   { type: dailySummaryConfigSchema, default: () => ({}) },
  facultySummaryConfig: { type: facultySummaryConfigSchema, default: () => ({}) },
}, { timestamps: true });

const DEFAULT_ALERT_TYPES = { serverDown: false, erpDown: false, lowConfidence: false, noReportSaved: false, classBunk: false, duplicateAttendance: false, dailySummary: false, embeddingProgress: false, scheduleCheck: false };

const DEFAULT_ROLES = [
  { role: "admin",       alertTypes: { ...DEFAULT_ALERT_TYPES } },
  { role: "coordinator", alertTypes: { ...DEFAULT_ALERT_TYPES } },
  { role: "head",        alertTypes: { ...DEFAULT_ALERT_TYPES } },
];

notificationSettingsSchema.statics.getSettings = async function () {
  let settings = await this.findOne({});
  if (!settings) {
    settings = await this.create({ enabled: false, roles: DEFAULT_ROLES, recipients: [] });
  }
  // Ensure all 3 roles always exist (migration safety)
  for (const def of DEFAULT_ROLES) {
    if (!settings.roles.find((r) => r.role === def.role)) {
      settings.roles.push(def);
    }
  }
  // Migration safety for docs created before dailySummaryConfig existed
  if (!settings.dailySummaryConfig) {
    settings.dailySummaryConfig = { enabled: false, frequency: "daily", mode: "all", threshold: 75 };
  }
  // Same, for docs created before facultySummaryConfig existed. Defaults to
  // OFF: turning it on starts mailing people outside the recipients list, so
  // it must be an explicit choice, never something a deploy switches on.
  if (!settings.facultySummaryConfig) {
    settings.facultySummaryConfig = { enabled: false, bccEmails: [] };
  }
  return settings;
};

const NotificationSettings = mongoose.model("NotificationSettings", notificationSettingsSchema);
module.exports = NotificationSettings;
