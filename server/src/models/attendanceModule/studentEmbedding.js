// server/src/models/attendanceModule/studentEmbedding.js
const mongoose = require('mongoose');
const { commonFields, updateTimestamps } = require('../commonFields');

const studentEmbeddingSchema = new mongoose.Schema({
    // batch is kept for backward compatibility but is no longer required
    // new records use sem + subject + dept instead
    batch:           { type: String, default: '' },
    dept:            { type: String, default: '' },
    degree:          { type: String, default: '' },
    sem:             { type: String, default: '' },
    subject:         { type: String, default: '' },
    subjectCode:     { type: String, default: '' },
    embeddingFile:   { type: String, default: null },
    // AdaFace's independent embedding .pkl for this subject (separate folder,
    // server/ml-data/embeddings_adaface/...) — null until an AdaFace ONNX
    // model is loaded and generation produces AdaFace data for at least one
    // student. Never affects embeddingFile (InsightFace) above.
    adafaceEmbeddingFile: { type: String, default: null },
    // Manifest of one build: which roll numbers this .pkl was generated from.
    // NOT a roster — do not read it to answer "who is enrolled in this
    // subject?". Subject.enrolledRollNos is the single roster of record, and
    // attendanceModule/controllers/subjectRoster.js is the only way to read it.
    // The two legitimately differ: a student on the roster with no ground-truth
    // photos never makes it into the .pkl (that's `missedRollNos`), and a .pkl
    // is a point-in-time artifact while the roster keeps changing.
    // The consumers that want this — rebuildSubjectPklsForStudent() and
    // /ml/enrolled-students — are asking about file contents, which is exactly
    // what this records.
    rollNos:         { type: [String], default: [] },
    missedRollNos: [{
        rollNo:  { type: String },
        reason:  { type: String },
    }],
    photoFiles:      { type: [String], default: [] },
    generatedAt:     { type: Date, default: Date.now },
    status:          { type: String, enum: ['pending', 'done', 'failed'], default: 'pending' },
    error:           { type: String, default: null },
    studentsTotal:   { type: Number, default: 0 },
    studentsSuccess: { type: Number, default: 0 },
    studentsFailed:  { type: Number, default: 0 },
    uploadedDirect:  { type: Boolean, default: false },
    session:         { type: String, default: '' },
    lastUpdatedAt:   { type: Date, default: null },
});

studentEmbeddingSchema.add(commonFields);
// Index on sem+subject for the new query pattern, keep batch+subject for legacy
studentEmbeddingSchema.index({ sem: 1, subject: 1 });
studentEmbeddingSchema.index({ batch: 1, subject: 1 });
studentEmbeddingSchema.index({ embeddingFile: 1 });
studentEmbeddingSchema.pre('save', updateTimestamps);

module.exports = mongoose.model('StudentEmbedding', studentEmbeddingSchema);