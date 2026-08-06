const mongoose = require("mongoose");
const { commonFields, updateTimestamps } = require('./commonFields');


// Define your Mongoose schema based on the interface
const subjectSchema = new mongoose.Schema({
  subjectFullName:{
    type:String,
    required:true,
  },
  type: {
    type: String,
    // enum:["theory","tutorial","Project","others"], // Example: "class", "lab", "tut"
    required: true,
  },
  subCode: {
    type: String,
    required: true,
  },
  subName:{
    type:String,
    required:true,
  },
  studentCount:{
    type:Number,
    required:true,
  },
  sem: {
    type: String,
    required: true,
  },
  degree:{
    type:String,
    required:true,
  },
  dept: {
    type: String,
    required: false,
  },
  credits: {
    type: Number,
    required: false,
  },
  code:{
    type: String,
    required: false,
  },
  // ── Attendance / Embedding fields ──────────────────────────────────────────
  // THE roster: the single place a subject's roll numbers are stored, and the
  // only place attendance reads them from. Everything that establishes a
  // roster writes here — the .xlsx upload, the ERP roster sync, and embedding
  // generation when the caller supplied the roll list (see
  // attendanceModule/controllers/embeddingController.js). Read it through
  // attendanceModule/controllers/subjectRoster.js, never by querying directly,
  // so normalisation and the subject lookup stay in one place.
  //
  // StudentEmbedding.rollNos is NOT a second copy of this — it records which
  // roll numbers a particular .pkl was built from, which is a different
  // question and legitimately differs (students with no ground-truth photos
  // are on the roster but not in the file).
  enrolledRollNos: {
    type: [String],
    default: [],
  },
  missedGroundTruth: {        // roll nos in the xlsx that have no GT folder
    type: [String],
    default: [],
  },
  embeddingFile: {            // e.g. "6_Digital_Electronics.pkl"
    type: String,
    default: null,
  },
  embeddingUpdatedAt: {
    type: Date,
    default: null,
  },
  // ── ERP roster sync (ERP Embedding Generation tab) ─────────────────────────
  erpSyncedAt: {              // when enrolledRollNos was last fetched from the ERP
    type: Date,
    default: null,
  },
  erpFaculty: {               // faculty name as reported by the ERP for this subject
    type: String,
    default: null,
  },
  timetableFaculty: {         // faculty found in the timetable module (LockSem) for sem+abbreviation
    type: String,
    default: null,
  },
  facultyMatch: {             // erpFaculty vs timetableFaculty (case/space-insensitive)
    type: Boolean,
    default: null,
  },
});



// subjectSchema.add(commonFields);

// // Apply the pre-save middleware
// subjectSchema.pre('save', updateTimestamps);

// Create the Mongoose model
const Subject= mongoose.model("Subject", subjectSchema);

module.exports = Subject;
