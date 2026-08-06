// server/src/modules/attendanceModule/controllers/subjectRoster.js
//
// Single source of truth for "which roll numbers belong to this class?".
//
// The roster is Subject.enrolledRollNos — the list uploaded for that subject.
// It is NOT the set of students who happen to have ground-truth embeddings on
// disk: that set is per *batch*, so it contains every student in the year,
// including ones who don't take this subject at all. When the roster is not
// supplied, the ML service falls back to the embedding store and reports on
// whoever it finds there, which is why an elective's report used to list the
// whole batch — and why present/absent counts (and the percentage derived from
// them) moved every time the embedding store changed.
//
// Two things follow from that, and both live here so every caller does them
// the same way:
//   • the roster is sent to the ML service as `enrolledRollNos`, so matching
//     and the returned attendance map are scoped to this subject; and
//   • the saved report is reconciled against it — a roster student the model
//     never saw is Absent (not missing), and a non-roster student the model
//     recognised is kept but flagged, and never counted in the summary.

const Subject = require("../../../models/subject");

const escapeRegex = (v) => String(v == null ? "" : v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Roll numbers are compared upper-cased and trimmed everywhere. */
const normRoll = (v) => String(v == null ? "" : v).trim().toUpperCase();

/** Dept strings drift between "CSE", "cse" and "Computer_Science" — match loosely. */
function deptRegex(dept) {
  const norm = escapeRegex(String(dept).trim().replace(/\s+/g, "_"));
  return new RegExp(`^${norm.replace(/_/g, "[ _]")}$`, "i");
}

/** Unique, normalised roll numbers from a Subject document. */
function rosterFromSubject(subj) {
  const seen = new Set();
  const rollNos = [];
  for (const raw of subj?.enrolledRollNos || []) {
    const roll = normRoll(raw);
    if (roll && !seen.has(roll)) {
      seen.add(roll);
      rollNos.push(roll);
    }
  }
  return rollNos;
}

/**
 * Look up the roster for the class in front of the camera.
 *
 * `subject` is timetable free text, so it is matched against both the full
 * name and the abbreviation. Department is used to disambiguate when given,
 * but a mismatch there falls back to the name+semester match rather than
 * returning nothing — a stale dept string must not silently empty the roster.
 *
 * @returns {Promise<{rollNos: string[], subjectDoc: object|null}>}
 */
async function resolveSubjectRoster({ subject, sem, dept } = {}) {
  const text = String(subject || "").trim();
  if (!text) return { rollNos: [], subjectDoc: null };

  const nameMatch = { $regex: new RegExp(escapeRegex(text), "i") };
  const base = {
    $or: [{ subjectFullName: nameMatch }, { subName: nameMatch }],
    ...(sem ? { sem: String(sem) } : {}),
  };

  try {
    let subj = null;
    if (dept) {
      subj = await Subject.findOne({ ...base, dept: deptRegex(dept) }).lean();
    }
    if (!subj) subj = await Subject.findOne(base).lean();
    return { rollNos: rosterFromSubject(subj), subjectDoc: subj || null };
  } catch (err) {
    console.error("[SubjectRoster] lookup failed:", err.message);
    return { rollNos: [], subjectDoc: null };
  }
}

/**
 * Tag one ML attendance record with its roster membership.
 *
 * The ML service already says so via `in_list`/`flagged` when it was given a
 * roster; roster membership is recomputed here anyway so a run made without
 * one (or by an older ML build) still lands in the same shape.
 */
function membership(rollNo, data, rosterSet) {
  if (!rosterSet || rosterSet.size === 0) {
    // No roster on file — everything the model returned counts, which is the
    // old behaviour. Better than reporting on an empty class.
    return { inList: true, flagged: false };
  }
  const inList = rosterSet.has(normRoll(rollNo)) && data?.in_list !== false;
  return { inList, flagged: !inList };
}

/**
 * Bring a merged finalReport in line with the roster:
 *   • every entry is tagged inList/flagged;
 *   • roster students missing from the model's output are added as Absent.
 * Non-roster entries are deliberately kept — a recognised face from another
 * class is worth seeing — but `rosterMembers` excludes them from the counts.
 */
function reconcileFinalReport(finalReport, roster = []) {
  const rosterSet = new Set(roster);
  const out = (finalReport || []).map((entry) => {
    const plain = entry && typeof entry.toObject === "function" ? entry.toObject() : { ...entry };
    const { inList, flagged } = membership(plain.rollNo, plain, rosterSet);
    return { ...plain, inList, flagged };
  });

  if (rosterSet.size > 0) {
    const seen = new Set(out.map((s) => normRoll(s.rollNo)));
    for (const rollNo of roster) {
      if (seen.has(rollNo)) continue;
      // On the roster, never seen by the model — an absence, not a gap.
      out.push({
        rollNo,
        status: "absent",
        avgConfidence: 0,
        confidenceZone: "low",
        firstSeenSec: null,
        clusterFolder: null,
        finalStatus: "A",
        autoFinalStatus: "A",
        inList: true,
        flagged: false,
      });
    }
  }

  return out;
}

/** The students a summary may count — the roster, never the flagged extras. */
const rosterMembers = (finalReport) => (finalReport || []).filter((s) => s.inList !== false);

module.exports = {
  resolveSubjectRoster,
  rosterFromSubject,
  reconcileFinalReport,
  rosterMembers,
  membership,
  normRoll,
};
