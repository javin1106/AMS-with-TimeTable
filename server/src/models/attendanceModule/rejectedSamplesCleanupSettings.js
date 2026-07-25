const mongoose = require("mongoose");

const rejectedSamplesCleanupSettingsSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: true },
    lastRunAt: { type: Date, default: null },
    lastRunStats: {
      scanned: { type: Number, default: 0 },
      deleted: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

rejectedSamplesCleanupSettingsSchema.statics.getSettings = async function () {
  let settings = await this.findOne({});
  if (!settings) {
    settings = await this.create({ enabled: true });
  }
  return settings;
};

const RejectedSamplesCleanupSettings = mongoose.model(
  "RejectedSamplesCleanupSettings",
  rejectedSamplesCleanupSettingsSchema
);
module.exports = RejectedSamplesCleanupSettings;
