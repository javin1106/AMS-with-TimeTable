const TimeTable = require("../../../models/timetable");
const Subject = require("../../../models/subject");

// Branch/semester/subject are owned by the timetable module, not this one.
// The create-class picker reads them through here so the client makes one call
// per step instead of chaining the timetable endpoints itself (session → dept
// code → semesters → subjects) and so the list is always narrowed to the
// session the institute is currently running.

/** Timetables of the session marked current, or of the newest one if none is. */
async function currentSessionTables() {
  const current = await TimeTable.find({ currentSession: true }).lean();
  if (current.length) return current;

  const latest = await TimeTable.findOne().sort({ created_at: -1 }).lean();
  if (!latest) return [];
  return TimeTable.find({ session: latest.session }).lean();
}

/**
 * The session the institute is currently running, e.g. "2026-27 Odd".
 *
 * The one authority for it, so a class is stamped with the same session the
 * picker drew its subjects from. Deliberately not taken from the request: a
 * client that sent its own would let a class be filed under a session it was
 * never taught in, and every points table for that session would be wrong.
 *
 * Returns "" when the timetable module has nothing set up, which reads as
 * "unrecorded" everywhere downstream rather than inventing a session.
 */
async function currentSession() {
  const [table] = await currentSessionTables();
  return table?.session || "";
}

// Semesters are stored as strings ("3", "5", "M1"), so sort numerically where
// both sides are numbers and fall back to text otherwise.
const bySemester = (a, b) => {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a).localeCompare(String(b));
};

exports.listBranches = async (req, res) => {
  const tables = await currentSessionTables();

  const byDept = new Map();
  tables.forEach((table) => {
    if (!table.dept || !table.code || byDept.has(table.dept)) return;
    byDept.set(table.dept, { dept: table.dept, code: table.code, session: table.session });
  });

  const branches = [...byDept.values()].sort((a, b) => a.dept.localeCompare(b.dept));
  return res.json(branches);
};

exports.listSemesters = async (req, res) => {
  const code = String(req.query.code || "").trim();
  if (!code) return res.status(400).json({ message: "A branch code is required." });

  // Read the semesters off the subjects themselves so the picker never offers a
  // semester that has no subjects to choose from.
  const semesters = await Subject.distinct("sem", { code });
  return res.json(semesters.filter(Boolean).map(String).sort(bySemester));
};

exports.listSubjects = async (req, res) => {
  const code = String(req.query.code || "").trim();
  const sem = String(req.query.sem || "").trim();
  if (!code || !sem) {
    return res.status(400).json({ message: "A branch code and semester are required." });
  }

  const subjects = await Subject.find({ code, sem })
    .select("subName subCode subjectFullName type credits sem")
    .lean();

  const mapped = subjects.map((subject) => ({
    id: String(subject._id),
    name: subject.subjectFullName || subject.subName || "",
    subName: subject.subName || "",
    subCode: subject.subCode || "",
    type: subject.type || "",
    credits: subject.credits ?? null,
    sem: subject.sem || sem,
  }));

  return res.json(mapped.sort((a, b) => a.name.localeCompare(b.name)));
};

// Exported for classController, which stamps a new class with the session it
// was created in — see the note on `currentSession`.
exports.currentSession = currentSession;
