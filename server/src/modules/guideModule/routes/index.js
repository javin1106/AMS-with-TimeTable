const express = require("express");
const router = express.Router();
const { getGuide, updateGuide } = require("../controller/guide");
const { checkRole } = require("../../checkRole.middleware");

// Reading is as sensitive as writing here. The guide is internal developer
// documentation: it maps every backend route (including ML process control and
// the classroom camera registry), the on-disk ml-data layout, and the shape of
// the server's configuration. GET used to be entirely unauthenticated and PUT
// accepted any logged-in account, so a student could both read the whole
// attack map and rewrite it for everyone else. Both verbs are now
// administrators only — checkRole lets `admin` through unconditionally.
const guideAdmin = checkRole(["iams-admin"]);

router.get("/", guideAdmin, getGuide);
router.put("/", guideAdmin, updateGuide);

module.exports = router;
