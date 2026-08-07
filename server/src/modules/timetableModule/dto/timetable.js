const ClassTable = require("../../../models/classtimetable");
const TimeTable = require('../../../models/timetable'); // Import the TimeTable model

class TimeTabledto {
    async getSessionByCode(code) {
        try {
          const timetable = await TimeTable.findOne({ code: code }).exec();
      
          if (timetable) {
            return timetable.session;
          } else {
            return null;
          }
        } catch (err) {
          throw err; // Re-throw the error to propagate it to the calling function
        }
      }
      async getTTdetailsByCode(code) {
        try {
          const timetable = await TimeTable.findOne({ code: code }).exec();
      
          if (timetable) {
            return timetable;
          } else {
            return null;
          }
        } catch (err) {
          throw err; // Re-throw the error to propagate it to the calling function
        }
      }


      async getAllCodesOfSession(session) {
        try {
          const timetable = await TimeTable.find({ session: session }).exec();
          
          if (timetable.length > 0) {
            // Use map to extract 'code' from each document
            const codes = timetable.map(item => item.code);
            return codes;
          } else {
            return [];
          }
        } catch (err) {
          throw err; // Re-throw the error to propagate it to the calling function
        }
      }
      
    }

module.exports = TimeTabledto;