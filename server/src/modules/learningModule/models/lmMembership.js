const mongoose = require("mongoose");

// One row per (class, user). The platform-level role (FACULTY / STUDENT) only
// decides who may *create* a class; inside a class the role below is what all
// permission checks read, so a faculty member can legitimately be a student of
// someone else's class.
const lmMembershipSchema = new mongoose.Schema({
  classId: { type: mongoose.Schema.Types.ObjectId, ref: "lm_class", required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "user", default: null, index: true },

  email: { type: String, default: "", lowercase: true, trim: true, index: true },
  name: { type: String, default: "" },
  rollNumber: { type: String, default: "" },

  role: { type: String, enum: ["teacher", "co-teacher", "student"], default: "student", index: true },

  // invited  → teacher added the email, user has not signed in / accepted yet
  // pending  → student used the join code on a class requiring approval
  // active   → full member
  // removed  → kept for audit so past grades still resolve to a name
  status: {
    type: String,
    enum: ["invited", "pending", "active", "removed"],
    default: "active",
    index: true,
  },

  muted: { type: Boolean, default: false },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: "user", default: null },
  joinedAt: { type: Date, default: Date.now },
  removedAt: { type: Date, default: null },
  lastSeenAt: { type: Date, default: null },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

// A user may hold only one membership per class. This must be a *partial*
// index, not a sparse one: the invite path writes email-only rows with
// userId: null, and a compound sparse index still indexes those (classId is
// present), so a second invite to the same class would collide on
// (classId, null). The partial filter skips them entirely.
lmMembershipSchema.index(
  { classId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { userId: { $type: "objectId" } } },
);
lmMembershipSchema.index({ classId: 1, email: 1 });

module.exports = mongoose.model("lm_membership", lmMembershipSchema);
