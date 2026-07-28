const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

// Files land in this module's own uploads folder, served read-only by the
// router. Kept separate from server/uploads so nothing here can collide with
// or overwrite another module's files.
const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_BYTES = Number(process.env.LM_MAX_UPLOAD_BYTES || 50 * 1024 * 1024);

// Deny-list of things that are executable on a server or a student's machine.
// Everything else (documents, images, audio, video, archives, code) is allowed
// because coursework attachments are genuinely open-ended.
const BLOCKED_EXTENSIONS = new Set([
  ".exe", ".bat", ".cmd", ".com", ".msi", ".scr", ".cpl", ".jar",
  ".sh", ".bash", ".ps1", ".vbs", ".js", ".mjs", ".php", ".jsp", ".asp", ".aspx",
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // Never trust the client's filename on disk: store a random name and keep
    // the original only as display metadata.
    const ext = path.extname(file.originalname).toLowerCase().slice(0, 12);
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_BYTES, files: 10 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (BLOCKED_EXTENSIONS.has(ext)) {
      return cb(new Error(`Files of type ${ext} cannot be uploaded.`));
    }
    return cb(null, true);
  },
});

const kindOf = (mimeType) => {
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "file";
};

exports.uploadMiddleware = upload.array("files", 10);

exports.handleUpload = async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ message: "No files received." });

  return res.status(201).json({
    attachments: req.files.map((file) => ({
      kind: kindOf(file.mimetype || ""),
      name: file.originalname,
      url: `/api/v1/learningmodule/files/${file.filename}`,
      mimeType: file.mimetype,
      sizeBytes: file.size,
    })),
  });
};

/** Streams a previously uploaded file back. */
exports.serveFile = async (req, res) => {
  const safe = path.basename(String(req.params.filename || ""));
  const target = path.join(UPLOAD_DIR, safe);

  // Defence in depth: basename() already strips traversal, but confirm the
  // resolved path really is inside the upload directory before opening it.
  if (!target.startsWith(UPLOAD_DIR + path.sep)) {
    return res.status(400).json({ message: "Invalid file name." });
  }
  if (!fs.existsSync(target)) return res.status(404).json({ message: "File not found." });

  // Attachments are user-supplied; never let the browser execute one inline.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  if (req.query.download === "1") {
    return res.download(target);
  }
  return res.sendFile(target);
};

/** Surfaces multer's own errors (size/type) as clean JSON. */
exports.uploadErrorHandler = (err, req, res, next) => {
  if (!err) return next();
  if (err instanceof multer.MulterError) {
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? `Files must be under ${Math.round(MAX_BYTES / 1024 / 1024)} MB.`
        : err.message;
    return res.status(400).json({ message });
  }
  return res.status(400).json({ message: err.message || "Upload failed." });
};
