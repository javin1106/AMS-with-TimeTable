// server/src/modules/attendanceModule/controllers/embeddingPathResolver.js
//
// Where does a subject's embedding .pkl live on disk?
//
// embeddingController writes to  ml-data/embeddings/{session}/{safeSubject(dept)}/{file}
// using whatever casing the generation request supplied for `dept`, while the
// scheduler derives its dept from the timetable, where deriveBatch() upper-cases
// it. So the same department can be written as
//   Electronics_and_Communication_Engineering
// and looked up as
//   ELECTRONICS_AND_COMMUNICATION_ENGINEERING
// On Windows that is the same directory and everything works; on a Linux server
// it is not, fs.existsSync returns false, and the scheduler skips the room with
// "embeddingFile not found on disk". Resolution is case-insensitive here so both
// hosts behave the same.

const fs = require("fs");
const path = require("path");

const EMBEDDINGS_DIR = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "ml-data",
  "embeddings",
);

// "Digital Electronics (3rd Yr)" -> "Digital_Electronics_3rd_Yr"
// Same rule embeddingController.buildEmbeddingPath uses to create the folder.
function safeSubject(raw) {
  return (raw || "")
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_|_$/, "");
}

// Real on-disk name for `name` inside `parent`, ignoring case. Returns the full
// path, or null when nothing matches.
function resolveEntry(parent, name, wantDir) {
  const direct = path.join(parent, name);
  // Fast path — also the only path that ever runs on a case-insensitive FS.
  if (fs.existsSync(direct)) return direct;

  let entries;
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return null; // parent itself is missing
  }
  const wanted = name.toLowerCase();
  const hit = entries.find(
    (e) => (wantDir ? e.isDirectory() : e.isFile()) && e.name.toLowerCase() === wanted,
  );
  return hit ? path.join(parent, hit.name) : null;
}

/**
 * Locate a subject's embedding .pkl.
 *
 * @param {object} args
 * @param {string} args.session   academic session, e.g. "2026-27"
 * @param {string} args.dept      department as stored on the timetable/Subject
 * @param {string} args.filename  Subject.embeddingFile, e.g. "ECDE0353_FPGA_DE_GE_2026-27.pkl"
 * @returns {{path: string|null, reason: string}} `reason` is set only on failure
 *   and names the directory that was actually searched.
 */
function resolveEmbeddingFile({ session, dept, filename }) {
  const deptSafe = safeSubject(dept || "UNKNOWN");
  const sessionDir = path.join(EMBEDDINGS_DIR, String(session || ""));

  const deptDir = resolveEntry(sessionDir, deptSafe, true);
  if (!deptDir) {
    return {
      path: null,
      reason: `no embeddings folder for dept "${deptSafe}" in session "${session}" (looked in ${sessionDir})`,
    };
  }

  const filePath = resolveEntry(deptDir, filename, false);
  if (!filePath) {
    return {
      path: null,
      reason: `embeddingFile "${filename}" is not in ${deptDir}`,
    };
  }

  return { path: filePath, reason: "" };
}

module.exports = {
  EMBEDDINGS_DIR,
  safeSubject,
  resolveEmbeddingFile,
};
