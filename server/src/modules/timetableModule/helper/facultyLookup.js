const Faculty = require("../../../models/faculty");

/**
 * Resolve a timetable's free-text faculty name to exactly one Faculty document.
 *
 * Matching is anchored and case-insensitive, and collapses runs of whitespace,
 * so "ravi  kumar" and "Ravi Kumar" both hit the same record while "Ravi" does
 * NOT match "Ravi Kumar".
 *
 * Deliberately not a substring search: the department search helper
 * (`FacultyController.getFacultyByName`) matches on name OR dept and returns up
 * to 10 rows, which makes two spellings of one person resolve to the same
 * document and mail them twice — the cause of duplicate timetable emails.
 *
 * @param {string} name
 * @returns {Promise<Object|null>} lean Faculty doc, or null if no exact match.
 */
async function findFacultyByExactName(name) {
  if (!name || !String(name).trim()) return null;

  const escaped = String(name)
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");

  return Faculty.findOne({ name: new RegExp(`^${escaped}$`, "i") }).lean();
}

module.exports = { findFacultyByExactName };
