/**
 * Adds the common lunch break to a faculty/room timetable.
 *
 * Faculty and room timetables are built by filtering each slot's cells down to
 * the specific faculty/room being viewed. The lunch slot is a break shared
 * across the department and is not tied to a single faculty/room, so that
 * filtering drops it. The semester timetable does no such filtering, which is
 * why lunch shows there but not in the faculty/room views.
 *
 * This re-adds the lunch cells (unfiltered, deduplicated) so the break appears
 * once per day, matching the semester timetable. It mutates `timetableData`.
 *
 * @param {import('mongoose').Model} Model - ClassTable (live) or LockSem (locked)
 * @param {Object} timetableData - timetable object being built (mutated in place)
 * @param {String} code - timetable code
 * @param {'faculty'|'room'} type - which view is being built
 */
async function addCommonLunchSlots(Model, timetableData, code, type) {
  if (!code) return;

  const lunchRecords = await Model.find({
    code,
    slot: 'lunch',
    'slotData.0': { $exists: true },
  });

  // Collect the unique lunch cells for each day so the break shows once.
  const cellsByDay = {};
  lunchRecords.forEach((record) => {
    const { day, sem, slotData } = record;
    if (!day || !Array.isArray(slotData)) return;
    if (!cellsByDay[day]) cellsByDay[day] = { seen: new Set(), cells: [] };

    slotData.forEach(({ subject = '', faculty = '', room = '' }) => {
      // Match the cell shape the faculty/room views already emit.
      const cell =
        type === 'room'
          ? { subject, faculty, sem }
          : { subject, sem, room };
      const key = JSON.stringify(cell);
      if (!cellsByDay[day].seen.has(key)) {
        cellsByDay[day].seen.add(key);
        cellsByDay[day].cells.push(cell);
      }
    });
  });

  Object.entries(cellsByDay).forEach(([day, { cells }]) => {
    if (!cells.length) return;
    if (!timetableData[day]) timetableData[day] = {};
    if (!timetableData[day].lunch) timetableData[day].lunch = [];
    timetableData[day].lunch.push(cells);
  });
}

module.exports = addCommonLunchSlots;
