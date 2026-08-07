const mongoose = require('mongoose');

// Singleton feature flag controlling whether iams-dept-admin may delete saved
// reports. Platform admins and iams-admin have deletion access by default.
const reportDeletionSettingsSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
  },
  { timestamps: true },
);

reportDeletionSettingsSchema.statics.getSettings = async function getSettings() {
  let settings = await this.findOne({});
  if (!settings) settings = await this.create({ enabled: false });
  return settings;
};

module.exports = mongoose.model(
  'ReportDeletionSettings',
  reportDeletionSettingsSchema,
);
