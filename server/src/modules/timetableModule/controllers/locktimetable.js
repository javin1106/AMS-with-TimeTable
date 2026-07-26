const ClassTable = require("../../../models/classtimetable");
const LockSem = require("../../../models/locksem");

const HttpException = require("../../../models/http-exception");

const LockTimeTabledto = require("../dto/locktimetable");
const LockTimeTableDto = new LockTimeTabledto();
const TimeTabledto = require("../dto/timetable");
const TimeTableDto = new TimeTabledto();

const ClassTimeTabledto = require("../dto/classtimetable");
const ClassTimeTableDto = new ClassTimeTabledto();

const NoteController = require("./noteprofile");
const Notecontroller = new NoteController();

const MasterclasstableController = require("./masterclasstable");
const MasterClassTableController = new MasterclasstableController();

const getIndianTime = require("../helper/getIndianTime");
const mailSender = require("../../mailsender");
const { findFacultyByExactName } = require("../helper/facultyLookup");
const getEnvironmentURL = require("../../../getEnvironmentURL");
const TimetableChangeLog = require("../../../models/timetableChangeLogs");
const TimeTable = require("../../../models/timetable");
const { generateChangeEmail } = require("../helper/timetableEmails");

function indexBySubjectAndSem(entries) {
  const map = {};
  for (const e of entries) {
    const key = `${e.subject}][${e.sem}`;
    if (!map[key]) {
      map[key] = [];
    }
    map[key].push(e);
  }
  return map;
}
const SLOT_TIME_MAP = {
  period1: "08:30 AM",
  period2: "09:30 AM",
  period3: "10:30 AM",
  period4: "11:30 AM",
  period5: "01:30 PM",
  period6: "02:30 PM",
  period7: "03:30 PM",
  period8: "04:30 PM",
};
function formatSlot(slot) {
  return `${slot} (${SLOT_TIME_MAP[slot] || "Unknown Time"})`;
}

function formatDaySlot(entry) {
  return `${entry.day}, ${formatSlot(entry.slot)}`;
}

function detectChangesForFaculty(oldEntries, newEntries) {
  const oldMap = indexBySubjectAndSem(oldEntries);
  const newMap = indexBySubjectAndSem(newEntries);

  const addedSubjects = [];
  const removedSubjects = [];
  const updatedSubjects = [];

  const allSubjectKeys = new Set([
    ...Object.keys(oldMap),
    ...Object.keys(newMap),
  ]);

  for (const subjectKey of allSubjectKeys) {
    const [subject, sem] = subjectKey.split("][");
    const oldList = oldMap[subjectKey];
    const newList = newMap[subjectKey];

    // 🟢 Subject Added
    if (!oldList && newList) {
      addedSubjects.push({
        subject,
        entries: newList,
        sem,
      });
      continue;
    }

    // 🔴 Subject Removed
    if (oldList && !newList) {
      removedSubjects.push({
        subject,
        entries: oldList,
        sem,
      });
      continue;
    }

    // 🟡 Subject Exists → Check changes
    const changes = {};

    /* ---------- ROOM CHANGE ---------- */
    const oldRooms = [...new Set(oldList.map((e) => e.room))];
    const newRooms = [...new Set(newList.map((e) => e.room))];

    if (JSON.stringify(oldRooms) !== JSON.stringify(newRooms)) {
      changes.room = { from: oldRooms, to: newRooms };
    }

    /* ---------- SLOT / DAY CHANGE ---------- */
    const normalizeSlots = (list) =>
      list
        .map((e) => ({
          raw: `${e.day}-${e.slot}`,
          label: `${e.day}, ${formatSlot(e.slot)}`,
        }))
        .sort((a, b) => a.raw.localeCompare(b.raw));

    const oldSlots = normalizeSlots(oldList);
    const newSlots = normalizeSlots(newList);

    // Convert to maps for easy lookup
    const oldSlotMap = new Map(oldSlots.map((s) => [s.raw, s.label]));
    const newSlotMap = new Map(newSlots.map((s) => [s.raw, s.label]));

    // Diff
    const removed = [];
    const added = [];

    for (const [raw, label] of oldSlotMap) {
      if (!newSlotMap.has(raw)) {
        removed.push(label);
      }
    }

    for (const [raw, label] of newSlotMap) {
      if (!oldSlotMap.has(raw)) {
        added.push(label);
      }
    }

    if (added.length > 0 || removed.length > 0) {
      changes.slots = { added, removed };
      updatedSubjects;
    }

    if (Object.keys(changes).length > 0) {
      updatedSubjects.push({
        subject,
        changes,
        sem,
      });
    }
  }

  return {
    addedSubjects,
    removedSubjects,
    updatedSubjects,
  };
}

function generateFacultyChangeEmails(oldData, newData) {
  const oldMap = Object.fromEntries(oldData.map((f) => [f._id, f.entries]));
  const newMap = Object.fromEntries(newData.map((f) => [f._id, f.entries]));

  const results = [];
  const allFaculty = new Set([...Object.keys(oldMap), ...Object.keys(newMap)]);

  for (const faculty of allFaculty) {
    const oldEntries = oldMap[faculty] || [];
    const newEntries = newMap[faculty] || [];

    const changes = detectChangesForFaculty(oldEntries, newEntries);
    if (
      !(
        changes.addedSubjects.length === 0 &&
        changes.removedSubjects.length === 0 &&
        changes.updatedSubjects.length === 0
      )
    ) {
      results.push({
        faculty,
        changes,
      });
    }
  }

  return results;
}

async function sendFacultyChangeEmails(facultyChanges) {
  const today = new Date();
  const day = String(today.getDate()).padStart(2, "0");
  const month = today.toLocaleString("en-US", { month: "short" }).toUpperCase();
  const year = today.getFullYear();
  const emailTitle = `Timetable Update Notification [${day} ${month} ${year}]`;
  const base_url = getEnvironmentURL();
  const results = [];

  // Resolve every name to a faculty record first, then group by EMAIL ADDRESS.
  // Timetable slots hold free-text names, so one person can appear as both
  // "Mohan" and "Mohan Kumar" and produce two change-sets. Mailing per name
  // sends them two notifications; instead we merge the change-sets and send a
  // single email per address.
  const groups = new Map();

  for (const change of facultyChanges) {
    const facultyDoc = await findFacultyByExactName(change.faculty);
    const email = (facultyDoc?.email || "").trim();

    if (!facultyDoc || !email) {
      console.warn(`No email found for faculty: ${change.faculty}`);
      results.push({
        email: null,
        faculty: change.faculty,
        success: false,
        error: facultyDoc ? "Email not found" : "Faculty record not found",
      });
      continue;
    }

    const key = email.toLowerCase();
    const group = groups.get(key);
    if (group) {
      group.names.push(change.faculty);
      group.changes.addedSubjects.push(...change.changes.addedSubjects);
      group.changes.removedSubjects.push(...change.changes.removedSubjects);
      group.changes.updatedSubjects.push(...change.changes.updatedSubjects);
    } else {
      groups.set(key, {
        email,
        doc: facultyDoc,
        names: [change.faculty],
        changes: {
          addedSubjects: [...change.changes.addedSubjects],
          removedSubjects: [...change.changes.removedSubjects],
          updatedSubjects: [...change.changes.updatedSubjects],
        },
      });
    }
  }

  for (const group of groups.values()) {
    const facultyLabel = group.names.join(", ");
    try {
      await mailSender(
        group.email,
        emailTitle,
        generateChangeEmail(
          group.doc.name,
          group.changes,
          `${base_url}/timetable/faculty/${group.doc._id.toString()}`
        )
      );
      results.push({
        email: group.email,
        faculty: facultyLabel,
        success: true,
      });
    } catch (err) {
      console.error(`Failed to send email to ${group.email}:`, err);
      results.push({
        email: group.email,
        faculty: facultyLabel,
        success: false,
        error: err.message || "Unknown error",
      });
    }
  }

  return results;
}

const aggregateConfig = (code) => [
  {
    $match: { code },
  },
  {
    $unwind: "$slotData",
  },
  {
    $match: {
      "slotData.faculty": { $exists: true, $ne: "" },
    },
  },
  {
    $group: {
      _id: "$slotData.faculty",
      entries: {
        $push: {
          day: "$day",
          slot: "$slot",
          subject: "$slotData.subject",
          faculty: "$slotData.faculty",
          room: "$slotData.room",
          sem: "$sem",
          code: "$code",
        },
      },
    },
  },
];

// Codes currently mid-lock. The change diff is computed from LockSem *before*
// LockSem is rewritten, so two overlapping requests for the same code would
// both read the same pre-change snapshot and both mail the identical update.
const lockInFlight = new Set();

class LockTimeTableController {
  async locktt(req, res) {
    const { code, toInform } = req.body;

    if (!code) {
      return res.status(400).json({ error: "Code is required" });
    }

    if (lockInFlight.has(code)) {
      return res
        .status(409)
        .json({ error: "This timetable is already being locked. Please wait." });
    }
    lockInFlight.add(code);

    try {
      var results = [];

      // Delete all existing records in 'LockSem' for the given code
      const oldData = await LockSem.aggregate(aggregateConfig(code));
      const newData = await ClassTable.aggregate(aggregateConfig(code));
      const facultyChanges = generateFacultyChangeEmails(oldData, newData);
      if (toInform) results = await sendFacultyChangeEmails(facultyChanges);
      if (facultyChanges.length > 0) {
        // enrich log with dept and session at creation time to avoid later lookups
        let dept = 'Unknown';
        let session = '';
        try {
          const tt = await TimeTable.findOne({ code }).select('dept session').lean();
          if (tt) {
            dept = tt.dept || dept;
            session = tt.session || '';
          }
        } catch (err) {
          console.warn('Failed to fetch timetable for log enrichment:', err.message || err);
        }

        await TimetableChangeLog.create({
          userId: req.user.id,
          userEmail: JSON.stringify(req.user.email),
          changes: JSON.stringify(facultyChanges),
          code,
          dept,
          session,
        });
      }

      await LockSem.deleteMany({ code });

      const classTableData = await ClassTable.find({ code });
      if (!classTableData.length) {
        return res
          .status(404)
          .json({ error: "No data found for the provided code." });
      }

      // Prepare bulk insert operations
      const bulkOperations = classTableData.map((dataItem) => ({
        insertOne: { document: dataItem.toObject() },
      }));

      // Perform bulk insert
      if (bulkOperations.length > 0) {
        await LockSem.bulkWrite(bulkOperations);
      }

      // Get the current Indian time
      const timenow = Date.now();
      const formattedtime = getIndianTime(timenow);

      // Send response first to avoid UI delay
      res.status(200).json({
        message: "Data Locked successfully!",
        updatedTime: formattedtime,
        results,
      });

      // Execute MasterTable logic asynchronously (fire-and-forget)
      MasterClassTableController.createMasterTable(req.body).catch((err) => {
        console.error("Background MasterTable creation failed:", err);
        // Optionally: Send to error monitoring service (e.g., Sentry)
      });
    } catch (err) {
      console.error("Error in locktt:", err);
      // Only send error response if headers haven't been sent yet
      if (!res.headersSent) {
        res.status(500).json({ error: "An error occurred" });
      }
    } finally {
      lockInFlight.delete(code);
    }
  }

  async classtt(req, res) {
    try {
      const code = req.params.code;
      const sem = req.params.sem;

      const records = await LockSem.find({ sem, code });
      const timetableData = {};
      records.forEach((record) => {
        const { day, slot, slotData } = record;
        if (!timetableData[day]) {
          timetableData[day] = {};
        }

        if (!timetableData[day][slot]) {
          timetableData[day][slot] = [];
        }

        const formattedSlotData = slotData.map(
          ({ subject, faculty, room }) => ({
            subject,
            faculty,
            room,
          })
        );

        timetableData[day][slot].push(formattedSlotData);
        timetableData.sem = sem;
        timetableData.code = code;
      });
      const notes = await Notecontroller.getNoteByCode(code, "sem", sem);
      res.status(200).json({ timetableData, notes });
    } catch (error) {
      console.error(error);
      throw new Error("Error fetching and formatting data from the database");
    }
  }

  async facultytt(req, res) {
    const code = req.params.code;
    let session = "";
    const facultyname = req.params.faculty;
    try {
      if (!req.params.session) {
        session = await TimeTableDto.getSessionByCode(req.params.code);
      } else {
        session = req.params.session;
        // const facultyId=req.params.facultyId;
        // facultyname = await findFacultyById(facultyId);
      }
      const records = await LockTimeTableDto.findFacultyDataWithSession(
        session,
        facultyname
      );
      const updatedTime = await ClassTimeTableDto.getLastUpdatedTime(records);
      // Create an empty timetable data object
      const timetableData = {};

      // Iterate through the records and format the data
      records.forEach((record) => {
        // Extract relevant data from the record
        const { day, slot, slotData, sem } = record;

        // Lunch is fetched separately below. The faculty/room views are built
        // from an aggregation that joins on the `timetable` reference; lunch
        // records that lack that link are dropped by the join, which is why
        // lunch shows in the semester view (a plain find) but not here.
        if (slot === "lunch") return;

        // Create or initialize the day in the timetableData
        if (!timetableData[day]) {
          timetableData[day] = {};
        }

        // Create or initialize the slot in the day
        if (!timetableData[day][slot]) {
          timetableData[day][slot] = [];
        }
        // Iterate through the slotData array and filter based on faculty name
        const matchingSlotData = slotData.filter(
          (slotItem) => slotItem.faculty === facultyname
        );

        // Access the matching values from the filtered slotData and push them
        const formattedSlotData = matchingSlotData.map(({ subject, room }) => ({
          subject,
          sem,
          room,
        }));

        timetableData[day][slot].push(formattedSlotData);
        // Set the sem and code for the timetable
      });

      // Add this faculty's lunch-slot classes. Fetched directly by code (like
      // the semester view) so they survive regardless of the `timetable` link,
      // then filtered to this faculty so only their own lunch class shows.
      const facultyLunchRecords = await LockSem.find({
        code,
        slot: "lunch",
        "slotData.0": { $exists: true },
      });
      facultyLunchRecords.forEach((record) => {
        const { day, sem, slotData } = record;
        const matching = slotData.filter(
          (slotItem) => slotItem.faculty === facultyname
        );
        if (!matching.length) return;
        if (!timetableData[day]) timetableData[day] = {};
        if (!timetableData[day].lunch) timetableData[day].lunch = [];
        timetableData[day].lunch.push(
          matching.map(({ subject, room }) => ({ subject, sem, room }))
        );
      });
      // console.log(timetableData)
      const notes = await Notecontroller.getNoteByCode(
        code,
        "faculty",
        facultyname
      );

      res.status(200).json({ timetableData, updatedTime, notes });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Internal server error" });
    }
  }

  async roomtt(req, res) {
    const roomno = req.params.room;
    const code = req.params.code;
    // console.log('room no:', roomno);
    try {
      let session = "";
      if (!req.params.session) {
        session = await TimeTableDto.getSessionByCode(code);
      } else {
        session = req.params.session;
      }

      const records = await LockTimeTableDto.findRoomDataWithSession(
        session,
        roomno
      );
      const updatedTime = await ClassTimeTableDto.getLastUpdatedTime(records);
      const timetableData = {};
      records.forEach((record) => {
        const { day, slot, slotData, sem } = record;

        // Lunch is fetched separately below (see facultytt): the aggregation's
        // `timetable` join drops lunch records that lack that link.
        if (slot === "lunch") return;

        if (!timetableData[day]) {
          timetableData[day] = {};
        }
        if (!timetableData[day][slot]) {
          timetableData[day][slot] = [];
        }

        // Iterate through the slotData array and filter based on faculty name
        const matchingSlotData = slotData.filter(
          (slotItem) => slotItem.room === roomno
        );

        const formattedSlotData = matchingSlotData.map(
          ({ subject, faculty }) => ({
            subject,
            faculty,
            sem,
          })
        );

        timetableData[day][slot].push(formattedSlotData);
        // Set the sem and code for the timetable
      });

      // Add this room's lunch-slot classes, fetched directly by code (like the
      // semester view) so they survive the aggregation's join, then filtered
      // to this room so only its own lunch class shows.
      const roomLunchRecords = await LockSem.find({
        code,
        slot: "lunch",
        "slotData.0": { $exists: true },
      });
      roomLunchRecords.forEach((record) => {
        const { day, sem, slotData } = record;
        const matching = slotData.filter((slotItem) => slotItem.room === roomno);
        if (!matching.length) return;
        if (!timetableData[day]) timetableData[day] = {};
        if (!timetableData[day].lunch) timetableData[day].lunch = [];
        timetableData[day].lunch.push(
          matching.map(({ subject, faculty }) => ({ subject, faculty, sem }))
        );
      });
      const notes = await Notecontroller.getNoteByCode(code, "room", roomno);

      // console.log('rooom data',timetableData)
      res.status(200).json({ timetableData, updatedTime, notes });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Internal server error" });
    }
  }

  async getLastUpdatedTimeByCode(code) {
    const lockTime = await LockSem.find({ code })
      .sort({ updated_at: -1 })
      .limit(1);
    const saveTime = await ClassTable.find({ code })
      .sort({ updated_at: -1 })
      .limit(1);

    const lockTimeIST =
      lockTime.length > 0
        ? await getIndianTime(new Date(lockTime[0].updated_at))
        : null;
    const saveTimeIST =
      saveTime.length > 0
        ? await getIndianTime(new Date(saveTime[0].updated_at))
        : null;

    console.log(lockTimeIST);
    console.log(saveTimeIST);

    return {
      lockTimeIST,
      saveTimeIST,
    };
  }

  async deleteLockedTableByCode(code) {
    try {
      await LockSem.deleteMany({ code });
    } catch (error) {
      throw new Error("Failed to delete by code");
    }
  }
}

module.exports = LockTimeTableController;
