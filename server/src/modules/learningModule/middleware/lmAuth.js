const jwt = require("jsonwebtoken");

const getUserDetails = require("../../usermanagement/controllers/dto");
// dto.js deliberately returns only email/role/id/department; the display name
// is read straight off the shared user collection rather than widening that
// DTO, which other modules depend on.
const User = require("../../../models/usermanagement/user");
const LmClass = require("../models/lmClass");
const LmMembership = require("../models/lmMembership");

const PLATFORM_ADMIN_ROLES = ["admin", "iams-admin", "SUPERADMIN"];
const TEACHER_PLATFORM_ROLES = ["FACULTY", "ITTC", "TTADMIN", "iams-dept-admin"];

const rolesOf = (value) => (Array.isArray(value) ? value : [value].filter(Boolean));

const isPlatformAdmin = (roles) => rolesOf(roles).some((r) => PLATFORM_ADMIN_ROLES.includes(r));

// Accepts either the jwt cookie used by the rest of the platform or the
// Authorization: Bearer header that main.jsx also attaches — the same login
// issues both, and API clients hitting this module directly only have the
// header.
function readToken(req) {
  if (req.cookies?.jwt) return req.cookies.jwt;
  const header = req.get("Authorization") || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return null;
}

async function authenticate(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ message: "Unauthorized" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const details = await getUserDetails(decoded.id);
    if (!details) return res.status(401).json({ message: "Unauthorized" });

    const emails = rolesOf(details.email);
    const profile = await User.findById(decoded.id).select("name").lean();
    req.lmUser = {
      id: String(decoded.id),
      email: emails[0] || "",
      emails: emails.map((e) => String(e).toLowerCase()),
      name: profile?.name || emails[0] || "User",
      roles: rolesOf(decoded.role || details.role),
      department: details.department || "",
    };
    req.lmUser.isAdmin = isPlatformAdmin(req.lmUser.roles);
    return next();
  } catch (err) {
    return res.status(401).json({ message: "Unauthorized" });
  }
}

// Only faculty/admin accounts may open a class. Students join existing ones.
function requireClassCreator(req, res, next) {
  const roles = req.lmUser?.roles || [];
  const allowed = req.lmUser?.isAdmin || roles.some((r) => TEACHER_PLATFORM_ROLES.includes(r));
  if (!allowed) {
    return res.status(403).json({ message: "Only faculty accounts can create a class." });
  }
  return next();
}

// Resolves the caller's standing in :classId and hangs it off the request.
// Platform admins get an implicit teacher view so they can support a class
// without being enrolled in it.
async function loadClass(req, res, next) {
  try {
    const classId = req.params.classId || req.body.classId || req.query.classId;
    if (!classId || !/^[a-f\d]{24}$/i.test(String(classId))) {
      return res.status(400).json({ message: "A valid classId is required." });
    }

    const klass = await LmClass.findById(classId);
    if (!klass) return res.status(404).json({ message: "Class not found." });

    const membership = await LmMembership.findOne({
      classId: klass._id,
      userId: req.lmUser.id,
      status: { $in: ["active", "pending"] },
    });

    let role = membership?.status === "active" ? membership.role : null;
    if (!role && req.lmUser.isAdmin) role = "teacher";
    if (!role && String(klass.ownerId) === req.lmUser.id) role = "teacher";

    if (!role) {
      return res.status(403).json({ message: "You are not a member of this class." });
    }

    req.lmClass = klass;
    req.lmMembership = membership || null;
    req.lmRole = role;
    req.lmIsTeacher = role === "teacher" || role === "co-teacher";

    if (membership && membership.status === "active") {
      // Fire-and-forget: a failed presence write must never fail the request.
      LmMembership.updateOne({ _id: membership._id }, { $set: { lastSeenAt: new Date() } }).catch(
        () => {},
      );
    }

    return next();
  } catch (error) {
    console.error("[LearningModule] loadClass", error);
    return res.status(500).json({ message: "Failed to resolve class access." });
  }
}

function requireTeacher(req, res, next) {
  if (!req.lmIsTeacher) {
    return res.status(403).json({ message: "Only the class teacher can do that." });
  }
  return next();
}

function requireOwner(req, res, next) {
  const owns = String(req.lmClass.ownerId) === req.lmUser.id || req.lmUser.isAdmin;
  if (!owns) return res.status(403).json({ message: "Only the class owner can do that." });
  return next();
}

// Wraps an async handler so a rejected promise becomes a 500 instead of an
// unhandled rejection — every route in this module goes through it.
const asyncRoute = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch((error) => {
    console.error("[LearningModule]", req.method, req.originalUrl, error);
    if (res.headersSent) return;
    res.status(error?.status || 500).json({ message: error?.message || "Internal Server Error" });
  });

module.exports = {
  authenticate,
  requireClassCreator,
  loadClass,
  requireTeacher,
  requireOwner,
  asyncRoute,
  isPlatformAdmin,
  TEACHER_PLATFORM_ROLES,
};
