const express = require("express");
const router = express.Router();
const protectRoute = require("../../usermanagement/privateroute");
const { checkRole } = require("../../checkRole.middleware");

// Roles allowed to change timetable data: the institute time-table incharge,
// the department time-table incharge, and platform admins. `checkRole` lets
// `admin` through on its own, so naming it here is documentation rather than
// mechanism.
const TIMETABLE_EDITORS = ["ITTC", "DTTI", "admin"];
const requireTimetableEditor = checkRole(TIMETABLE_EDITORS);

/**
 * Every PUT in this module needs an editing role.
 *
 * Applied once here rather than route by route on purpose. The module has ~90
 * endpoints across 25 files and several PUTs had no guard at all — an
 * unauthenticated `PUT /subject/:id` could rewrite any subject, and
 * `PUT /addfaculty/deletefirstyearfaculty/...` could unassign any faculty
 * member. Annotating each one would leave the same gap open for the next route
 * somebody adds; a blanket rule covers those too, and cannot be forgotten.
 *
 * Scoped to PUT because that is what was asked for and what was exposed. GET
 * and POST keep whatever guard they already carry — several are deliberately
 * public reads used by the timetable display.
 */
router.use((req, res, next) => {
  if (req.method !== "PUT") return next();
  return requireTimetableEditor(req, res, next);
});

router.use("/timetable", require("./timetable"));
router.use("/faculty", require("./faculty"));
router.use("/subject", require("./subject"));
router.use("/semester", require("./semesterAbbreviation"));
router.use("/tt", protectRoute, require("./classtimetable"));
router.use("/addfaculty", require("./addfaculty"));
router.use("/lock", require("./locktimetable"));
router.use("/masterroom", require("./masterroom"));
router.use("/mastersem", protectRoute, require("./mastersem"));
router.use("/addroom", require("./addroom"));
router.use("/addsem", require("./addsem"));
router.use("/allotment", require("./allotment"));
router.use("/import", protectRoute, require("./importdata"));
router.use("/lockfaculty", protectRoute, require("./lockfaculty"));
router.use("/note", require("./note"));
router.use("/commonLoad", require("./commonLoad"));
router.use("/instituteLoad", require("./instituteLoad"));
router.use("/mastertable", require("./masterclasstable"));
router.use("/message", require("./message"));
router.use("/adminclash", require("./adminClash"));
router.use("/logs", require("./logs"));

module.exports = router;
