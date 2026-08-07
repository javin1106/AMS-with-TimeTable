// server/src/modules/attendanceModule/controllers/subjectLookup.js
//
// One way to turn a timetable's subject string into its Subject document.
//
// Everything that writes a subject into a slot writes `subName` — the
// abbreviation:
//   • the timetable load screens (departmentloadallocation.jsx resolves slots
//     back with `item.subName === subject`, and TTManual documents subName as
//     "the abbreviation — must be unique within a semester")
//   • the Extra Class / Alter Class forms (`<option value={s.subName}>`)
//
// The readers, however, all queried `subjectFullName` with an UNANCHORED
// case-insensitive regex built from that abbreviation. Two failures came out
// of that:
//
//   1. A miss whenever the abbreviation is not literally a substring of the
//      full name — "DSP" finds "Digital Signal Processing (DSP)" but not
//      "Digital Signal Processing". The room was then skipped as
//      "No Subject matches subjectFullName …" even though the subject and its
//      .pkl both existed.
//   2. Worse, a silent WRONG match: an unanchored substring plus findOne with
//      no sort means a short abbreviation like "DS" can match several subjects
//      and return an arbitrary one — wrong embeddingFile, wrong roster, and
//      attendance recorded against the wrong class with no error raised.
//
// Since the same field is written on both sides, it is matched exactly here
// rather than approximately. Order is deliberate:
//
//   1. subName, exact          — what every writer actually stores
//   2. subjectFullName, exact  — older/hand-entered slots holding a full name
//
// Both are anchored, so neither can match more than the whole field. The old
// substring behaviour is deliberately NOT kept as a third step: it is the
// mechanism behind failure 2, and preserving it would leave the silent
// wrong-subject case exactly as it was.
//
// Matching stays case-insensitive and trim-tolerant only — differences that
// come from hand-editing the same controlled value, never from it being a
// different value.

const Subject = require("../../../models/subject");

// Anchored, case-insensitive, literal. No metacharacter in a subject name
// ("FPGA(DE/GE)", "C++") may act as regex syntax.
function exactCI(value) {
  const literal = String(value || "")
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${literal}$`, "i");
}

/**
 * Resolve the Subject document a timetable slot refers to.
 *
 * @param {object}  args
 * @param {string}  args.subject   slot subject text (normally the subName)
 * @param {string} [args.sem]      semester; when given, it must match exactly
 * @returns {Promise<{subject: object|null, matchedBy: string|null, reason: string|null}>}
 *          `matchedBy` is 'subName' or 'subjectFullName', for logging which
 *          field carried the match.
 */
async function findSubjectForSlot({ subject, sem }) {
  const text = String(subject || "").trim();
  if (!text) {
    return { subject: null, matchedBy: null, reason: "No subject given for this slot" };
  }

  // A subName is unique only within a semester, so sem is part of the key
  // whenever the caller knows it.
  const semClause = String(sem || "").trim() ? { sem: exactCI(sem) } : {};

  for (const [field, matchedBy] of [
    ["subName", "subName"],
    ["subjectFullName", "subjectFullName"],
  ]) {
    const found = await Subject.findOne({
      [field]: exactCI(text),
      ...semClause,
    }).lean();
    if (found) return { subject: found, matchedBy, reason: null };
  }

  return {
    subject: null,
    matchedBy: null,
    reason:
      `No Subject matches "${text}"` +
      (sem ? ` in sem "${sem}"` : "") +
      ` — the timetable stores the subject abbreviation (subName), so a Subject ` +
      `with that exact subName (or subjectFullName) must exist for this semester`,
  };
}

module.exports = { findSubjectForSlot, exactCI };
