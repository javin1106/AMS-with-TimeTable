const mongoose = require("mongoose");

// Attachments are embedded everywhere (announcements, coursework, submissions,
// materials) rather than living in their own collection — they are never
// queried on their own and always read together with their parent document.
const attachmentSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["file", "link", "video", "audio", "note"], default: "file" },
    name: { type: String, default: "" },
    url: { type: String, default: "" },
    mimeType: { type: String, default: "" },
    sizeBytes: { type: Number, default: 0 },
  },
  { _id: true },
);

const topicSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    order: { type: Number, default: 0 },
    created_at: { type: Date, default: Date.now },
  },
  { _id: true },
);

const lmClassSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  section: { type: String, default: "", trim: true },
  subject: { type: String, default: "", trim: true },
  subjectCode: { type: String, default: "", trim: true },
  room: { type: String, default: "", trim: true },
  description: { type: String, default: "" },

  // Join code, Google-Classroom style: short, unguessable enough for a
  // classroom, and regenerable from class settings if it leaks.
  code: { type: String, required: true, unique: true, index: true },

  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true, index: true },
  ownerName: { type: String, default: "" },
  ownerEmail: { type: String, default: "" },

  dept: { type: String, default: "", trim: true },
  academicYear: { type: String, default: "" },
  semester: { type: String, default: "" },
  batch: { type: String, default: "" },

  /**
   * The academic session this class belongs to, e.g. "2026-27 Odd".
   *
   * Stamped at creation from the timetable's current session — the same one the
   * subject picker drew from — and never changed afterwards. A class is taught
   * once, in one session, and moving it later would silently re-file every
   * point and badge earned in it.
   *
   * This is what makes points session-scoped for free: a class belongs to
   * exactly one session, so anything already scoped per class is already scoped
   * per session. The field exists so a student's profile can *group* by it
   * without joining every class they have ever been in.
   *
   * Blank on classes created before this was recorded, which reads as
   * "unrecorded" rather than being guessed at.
   */
  session: { type: String, default: "", index: true },

  coverColor: { type: String, default: "#1967d2" },
  coverImage: { type: String, default: "" },
  meetLink: { type: String, default: "" },

  status: { type: String, enum: ["active", "archived"], default: "active", index: true },
  archivedAt: { type: Date, default: null },

  settings: {
    whoCanPost: {
      type: String,
      enum: ["teachers_only", "students_can_post", "students_can_comment"],
      default: "students_can_post",
    },
    allowJoinByCode: { type: Boolean, default: true },
    requireApproval: { type: Boolean, default: false },
    showGradesToStudents: { type: Boolean, default: true },
    emailNotifications: { type: Boolean, default: true },
    defaultPoints: { type: Number, default: 100 },
  },

  topics: [topicSchema],

  // Denormalised counters so the dashboard grid does not need an aggregate
  // per class card.
  stats: {
    studentCount: { type: Number, default: 0 },
    courseworkCount: { type: Number, default: 0 },
    announcementCount: { type: Number, default: 0 },
  },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

lmClassSchema.index({ name: "text", subject: "text", description: "text" });

module.exports = mongoose.model("lm_class", lmClassSchema);
module.exports.attachmentSchema = attachmentSchema;
