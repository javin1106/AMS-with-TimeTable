const mongoose = require("mongoose");
const TimeTable = require("../../../models/timetable");
const addRoom = require("../../../models/addroom");

const User = require("../../../models/usermanagement/user");

const generateUniqueLink = require("../helper/createlink");
const HttpException = require("../../../models/http-exception");
const getRoomByDepartment = require("./masterroomprofile");
const masterroomprofile = require("./masterroomprofile");
const AddAllotment = require("../../../models/allotment");
const FacultyController = require("./facultyprofile");
const getEnvironmentURL = require("../../../getEnvironmentURL");
const addFaculty = require("../../../models/addfaculty");
const facultyControllerInstance = new FacultyController();
const MasterRoomProfile = new masterroomprofile();
const mailSender = require("../../mailsender");
const { getTimetableEmailContent } = require("../helper/timetableEmails");

// Timetable ids currently mid-publish, so overlapping requests for the same
// timetable can't both run the notification loop.
const publishInFlight = new Set();

class TableController {
  async createTable(req, res) {
    const data = req.body;
    const userId = req.user.id;
    const existingTimeTable = await TimeTable.findOne({
      user: userId,
      session: data.session,
    });
     const sessionstatus = await TimeTable.findOne({
      session: data.session,
    });

    if (existingTimeTable) {
      // If a timetable already exists, you can choose to return an error or update the existing one
      // In this example, we return an error
      return res
        .status(400)
        .json({ error: "Timetable already exists for this session" });
    }
    try {
      const newCode = await generateUniqueLink();
      // console.log(newCode);
      //const userObject = await User.findById(userId)
      if (sessionstatus && sessionstatus.currentSession == true) {
        data.currentSession = true;
      } else {
        data.currentSession = false;
      }
        console.log("seesionstatus",data.currentSession);
      const newTimeTable = new TimeTable({
        ...data,
        code: newCode,
        user: userId,
      });
      const createdTT = await newTimeTable.save();
      const deptrooms = await MasterRoomProfile.getRoomByDepartment(data.dept);
      if (deptrooms) {
        for (const room of deptrooms) {
          await addRoom.create({
            room: room.room,
            code: newCode,
            type: room.type,
          });
        }
      }

      const roomdata = await AddAllotment.find({ session: data.session });
      console.log(roomdata);
      const centralisedAllotments = roomdata[0]?.centralisedAllotments || [];
      const openElectiveAllotments = roomdata[0]?.openElectiveAllotments || [];

      // Search in centralised allotments
      const centralisedDept = centralisedAllotments.find(
        (item) => item.dept === data.dept
      ) || { rooms: [] };

      // Search in open elective allotments
      const electiveDept = openElectiveAllotments.find(
        (item) => item.dept === data.dept
      ) || { rooms: [] };

      // Combine rooms from both allotments
      const combinedRooms = [...centralisedDept.rooms, ...electiveDept.rooms];
      if (combinedRooms) {
        for (const room of combinedRooms) {
          await addRoom.create({
            room: room.room,
            code: newCode,
            type: "Centralised Classroom",
          });
        }
      }

      res.json(createdTT);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Internal server error" });
    }
  }

  async savett(req, res) {
    const timetableData = req.body;
    // console.log(timetableData);
    try {
      for (const day of Object.keys(timetableData.timetableData)) {
        const dayData = timetableData.timetableData[day];

        // Iterate through the periods (e.g., "period1", "period2", etc.) for each day
        for (const slot of Object.keys(dayData)) {
          const slotData = dayData[slot];

          // Create a new ClassTable instance with the data from the JSON
          const classTableInstance = new ClassTable({
            day, // Set the day from the JSON
            slot, // Set the slot from the JSON
            sub: slotData.subject, // Set subject from the JSON
            faculty: slotData.faculty, // Set faculty from the JSON
            room: slotData.room, // Set room from the JSON
            code: timetableData.code || "", // Set code from the JSON (optional)
          });

          // Save the ClassTable instance to the MongoDB database
          classTableInstance.save((err) => {
            if (err) {
              console.error(`Error saving class table data: ${err}`);
            } else {
              console.log(`Saved class table data for ${day} - ${slot}`);
            }
          });
        }
      }
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Internal server error" });
    }
  }

  async getUserTable(req, res) {
    const userId = req.user.id;
    try {
      const TableField = await TimeTable.find({ user: userId });
      res.json(TableField);
      return;
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Internal server error" });
    }
  }

  // async getTableByCode(code)
  // {
  //   // const code=req.params.code;
  //   try {
  //       const TableField = await TimeTable.find({code});
  //       return TableField;
  //     } catch (error) {
  //       console.error(error);
  //       res.status(500).json({ error: "Internal server error" });
  //     }
  // }

  //newcode
  async getTableByCode(code) {
    try {
      if (typeof code !== "string") {
        console.error("Invalid code received:", code);
        throw new HttpException(400, "Invalid code format");
      }

      console.log("Fetching timetable details for code:", code);

      const TableField = await TimeTable.findOne({ code });
      console.log("Fetched timetable details:", TableField);

      if (!TableField) {
        throw new HttpException(404, "Timetable not found for the given code");
      }

      return TableField;
    } catch (error) {
      console.error("Error fetching timetable by code:", error);
      throw new HttpException(500, error.message || "Internal server error");
    }
  }

  async getTableById(id) {
    if (!id) {
      throw new HttpException(400, "Invalid Id");
    }
    try {
      const data = await TimeTable.findById(id);

      if (!data) throw new HttpException(400, "data does not exists");

      return data;
    } catch (e) {
      throw new HttpException(500, e.message || "Internal Server Error");
    }
  }

  async updateID(id, announcement) {
    if (!id) {
      throw new HttpException(400, "Invalid Id");
    }
    // if (!isValidAnnouncement(announcement)) {
    //   return res.status(400).json({ error: "Invalid Announcement data" });
    // }
    try {
      await TimeTable.findByIdAndUpdate(id, announcement);
    } catch (e) {
      throw new HttpException(500, e.message || "Internal Server Error");
    }
  }

  async deleteId(id) {
    if (!id) {
      throw new HttpException(400, "Invalid Id");
    }
    try {
      await TimeTable.findByIdAndDelete(id);
    } catch (e) {
      throw new HttpException(500, e.message || "Internal Server Error");
    }
  }

  async deleteTableByCode(code) {
    try {
      await TimeTable.deleteMany({ code });
    } catch (error) {
      throw new Error("Failed to delete by code");
    }
  }

  async getAllSessAndDept() {
    try {
      // Step 1: Get distinct sessions with their creation times
      const sessionsWithCreationTimes = await TimeTable.find(
        {},
        { session: 1, created_at: 1, currentSession: 1 }
      ).sort({ created_at: -1 });

      // Extract unique sessions and sort them by creation time
      // const uniqueSessions = sessionsWithCreationTimes.map(doc => ({
      //   session: doc.session,
      //   currentSession: doc.currentSession
      // }));

      //this will prevent duplicacy
      const uniqueSessions = Array.from(
        new Map(
          sessionsWithCreationTimes.map((doc) => [
            doc.session,
            {
              session: doc.session,
              currentSession: doc.currentSession,
            },
          ])
        ).values()
      );
      // console.log(uniqueSessions);

      // Step 2: Get distinct departments
      const uniqueDept = await TimeTable.distinct("dept");

      // Step 3: Sort departments alphabetically
      uniqueDept.sort((a, b) => a.localeCompare(b));

      return { uniqueSessions, uniqueDept };
    } catch (error) {
      throw error;
    }
  }

  async getCodeOfDept(dept, session) {
    try {
      const code = await TimeTable.findOne({ dept, session });
      return code;
    } catch (error) {
      throw error;
    }
  }

  async getAllCodes(session) {
    try {
      const codes = await TimeTable.find({ session });
      // console.log(codes);
      return codes;
    } catch (error) {
      throw error;
    }
  }

  async setCurrentSession(req, res) {
    const { session } = req.body;

    try {
      await TimeTable.updateMany({}, { $set: { currentSession: false } });
      const updatedSessions = await TimeTable.updateMany(
        { session },
        { $set: { currentSession: true } }
      );
      if (!updatedSessions) {
        return res.status(404).json({ error: "Session not found" });
      }

      res.json({
        message: "Current session updated successfully",
        updatedSessions,
      });
    } catch (error) {
      console.error("Error updating current session:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
  async getCurrentSession(req, res) {
    try {
      const sessions = await TimeTable.find({ currentSession: true });

      if (!sessions || sessions.length === 0) {
        return res.status(404).json({ message: "No active sessions found" });
      }
      const codes = sessions.map((s) => s.code);
      res.json({ codes });
    } catch (error) {
      console.error("Error updating current session:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
 
async publishTimetable(req, res) {
  const { id } = req.params;
  // Explicit opt-in for re-notifying faculty about an already-published
  // timetable. Without it a repeat publish is a no-op mail-wise.
  const force =
    req.query?.force === "true" || req.body?.force === true;

  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid timetable id" });
  }

  // Guard against concurrent publishes of the same timetable (double-click,
  // client retry). Without this, two overlapping requests each run the full
  // mail loop before either marks the timetable published.
  if (publishInFlight.has(id)) {
    return res.status(409).json({
      error: "This timetable is already being published. Please wait.",
    });
  }
  publishInFlight.add(id);

  try {
    const timetable = await TimeTable.findById(id);

    if (!timetable) {
      return res.status(404).json({ error: "Timetable not found" });
    }

    const alreadyPublished = timetable.publish === true;

    // 1. Publish timetable (idempotent — keep the original publish date)
    const update = { publish: true };
    if (!alreadyPublished) update.datePublished = new Date();
    const updatedTimeTable = await TimeTable.findByIdAndUpdate(id, update, {
      new: true,
    });

    // 2. Already published and no explicit re-send requested → don't mail again.
    if (alreadyPublished && !force) {
      return res.json({
        success: true,
        alreadyPublished: true,
        mailsSent: 0,
        results: [],
        message:
          "Timetable was already published — no notification emails were re-sent.",
      });
    }

    // 3. Fetch all semester–faculty mappings for this timetable
    const allfaculties = await addFaculty.find({ code: updatedTimeTable.code });

    // 4. Build UNIQUE faculty name list across all semesters
    const facultySet = new Set();
    for (const record of allfaculties) {
      if (Array.isArray(record.faculty)) {
        for (const name of record.faculty) {
          if (typeof name === "string" && name.trim()) {
            facultySet.add(name.trim());
          }
        }
      }
    }

    const base_url = getEnvironmentURL();
    const results = [];
    // De-duplicate on the RESOLVED EMAIL, not the name. Timetable slots hold
    // free-text names, so one person can appear as "Mohan" and "Mohan Kumar"
    // and survive the name-based Set above — mailing per name sends them two
    // copies of the same notification.
    const mailedEmails = new Set();

    // 5. Send mail ONCE per faculty email address
    for (const facultyName of facultySet) {
      const faculty = await facultyControllerInstance.getFacultyByExactName(
        facultyName
      );

      if (!faculty) {
        console.warn(`Faculty not found: ${facultyName}`);
        results.push({
          faculty: facultyName,
          email: null,
          success: false,
          error: "Faculty record not found",
        });
        continue;
      }

      const email = (faculty.email || "").trim();
      if (!email) {
        console.warn(`No email on record for faculty: ${facultyName}`);
        results.push({
          faculty: facultyName,
          email: null,
          success: false,
          error: "Email not found",
        });
        continue;
      }

      const emailKey = email.toLowerCase();
      if (mailedEmails.has(emailKey)) {
        console.log(`Skipping duplicate recipient: ${email} (${facultyName})`);
        results.push({
          faculty: facultyName,
          email,
          success: true,
          skipped: "duplicate recipient",
        });
        continue;
      }
      mailedEmails.add(emailKey);

      const { subject, body } = getTimetableEmailContent({
        facultyName: faculty.name,
        departmentName: updatedTimeTable.dept,
        sessionName: updatedTimeTable.session,
        timetableUrl: `${base_url}/timetable/faculty/${faculty._id}`,
      });

      try {
        await mailSender(email, subject, body);
        results.push({ faculty: facultyName, email, success: true });
      } catch (err) {
        console.error(`Failed to send publish email to ${email}:`, err);
        results.push({
          faculty: facultyName,
          email,
          success: false,
          error: err.message || "Unknown error",
        });
      }
    }

    // 6. Respond only after all mails are sent
    res.json({
      success: true,
      alreadyPublished,
      mailsSent: mailedEmails.size,
      results,
      message: `Timetable published and ${mailedEmails.size} mail(s) sent`,
    });

  } catch (error) {
    console.error("Error publishing timetable:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal Server Error" });
    }
  } finally {
    publishInFlight.delete(id);
  }
}


  async publishSession(req, res) {
    const { session } = req.body;

    if (!session) {
      return res.status(400).json({ error: "Session is required" });
    }

    try {
      await TimeTable.updateMany(
        { session },
        {
          publish: true,
          datePublished: new Date(),
        }
      );

      res.json({ success: true });
    } catch (error) {
      console.error("Error publishing session timetables:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
}
module.exports = TableController;
