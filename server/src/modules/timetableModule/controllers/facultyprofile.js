const HttpException = require("../../../models/http-exception");
const Faculty = require("../../../models/faculty");
const addFaculty = require("../../../models/addfaculty");
const { findFacultyByExactName } = require("../helper/facultyLookup");


class FacultyController {
    async createFaculty(req,res) {
        const newFaculty = req.body;
        try {
          const createdFaculty = await Faculty.create(newFaculty);
          res.json(createdFaculty)
          return;
        } catch (error) {
          console.error(error); 
          res.status(500).json({ error: "Internal server error" });
        }
      }

      async getDepartments() {
        try {
          const uniqueDepartments = await Faculty.distinct('dept');
          
          return uniqueDepartments;
        } catch (error) {
          throw error; 
        }
      }
      
      async getFaculty(req, res) {
        try {
          const facultyList = await Faculty.find();
          res.json(facultyList);
          return;
        } catch (error) {
          console.error(error);
          res.status(500).json({ error: "Internal server error" });
        }
      }
      
      
      async getFacultyById(id) {
        if (!id) {
          throw new HttpException(400, "Invalid Id");
        }
        try {
          const data = await Faculty.findById(id);
          if (!data) throw new HttpException(400, "data does not exists");
          return data;
        } catch (e) {
          throw new HttpException(500, e.message || "Internal Server Error");
        }
      }


      async getFacultyByName(query){
          if (!query) {
          throw new HttpException(400, "Invalid search query");
          }

        try {
        const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(escapedQuery, "i");
        const data = await Faculty.find({
         $or: [
         { name: regex },
         { dept: regex }
        ]
      }).limit(10);

       return data;
     } catch (e) {
      throw new HttpException(500, e.message || "Internal Server Error");
    }
  };

      /**
       * Exact (anchored, case- and whitespace-insensitive) name lookup.
       *
       * `getFacultyByName` above is the *search* helper: its regex is unanchored
       * and also matches `dept`, so "Mohan" happily matches "Mohan Kumar" and a
       * name that matches no faculty at all can still return a whole department.
       * Callers that mail people must never use it — resolving two spellings of
       * one person to the same document is how duplicate emails happen.
       */
      async getFacultyByExactName(name) {
        if (!name || !String(name).trim()) {
          throw new HttpException(400, "Invalid faculty name");
        }
        try {
          return await findFacultyByExactName(name);
        } catch (e) {
          throw new HttpException(500, e.message || "Internal Server Error");
        }
      }


     

      async getFacultyByDepartment(department) {
        if (!department) {
          throw new HttpException(400, "Invalid Department");
        }
        try {
          const data = await Faculty.find({ dept: department }).sort({ order:1});
          if (!data) throw new HttpException(400, "No faculty members found in this department");
          return data;
        } catch (e) {
          throw new HttpException(500, e.message || "Internal Server Error");
        }
      }
    
      async updateID(id, announcement) {
        if (!id) {
          throw new HttpException(400, "Invalid Id");
        }
        try {
          await Faculty.findByIdAndUpdate(id, announcement);
        } catch (e) {
          throw new HttpException(500, e.message || "Internal Server Error");
        }
      }

      async deleteId(id) {
        if (!id) {
          throw new HttpException(400, "Invalid Id");
        }
        try {
          await Faculty.findByIdAndDelete(id);
        } catch (e) {
          throw new HttpException(500, e.message || "Internal Server Error");
        }
      }
    


    }


module.exports = FacultyController;
