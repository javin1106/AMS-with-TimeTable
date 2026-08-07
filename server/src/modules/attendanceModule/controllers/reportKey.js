// server/src/modules/attendanceModule/controllers/reportKey.js
//
// What identifies an attendance report: batch + date + timeSlot + ROOM.
//
// Room used to be absent from the key while being a single field on the
// document, so two rooms running the same batch in one slot — a split lab, an
// elective spread across rooms — resolved to the same report. The scheduler
// runs rooms in parallel, so both did findOne → push → save on that one
// document: one room's checks overwrote the other's (or the save died with a
// Mongoose VersionError, swallowed by the per-check catch), and the report's
// `room` field recorded whichever writer happened to land last.
//
// Room is upper-cased so "LT-103" and "lt-103" are one room rather than two
// reports. Callers should store the same normalised value they query with,
// which is what reportDoc() is for.

function roomKey(room) {
  return String(room ?? "").trim().toUpperCase();
}

// Query identifying exactly one report.
function reportQuery({ batch, date, timeSlot, room }) {
  return { batch, date, timeSlot, room: roomKey(room) };
}

module.exports = { roomKey, reportQuery };
