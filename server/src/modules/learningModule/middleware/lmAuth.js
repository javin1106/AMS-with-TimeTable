const jwt = require("jsonwebtoken");

const getUserDetails = require("../../usermanagement/controllers/dto");
// dto.js deliberately returns only email/role/id/department; the display name
// is read straight off the shared user collection rather than widening that
// DTO, which other modules depend on.
const User = require("../../../models/usermanagement/user");
const LmClass = require("../models/lmClass");
const LmMembership = require("../models/lmMembership");
// Cookie first, then Authorization: Bearer — shared with the rest of the
// platform's middlewares.
const readAuthToken = require("../../readAuthToken");

const PLATFORM_ADMIN_ROLES = ["admin", "iams-admin", "lm-admin"];
const TEACHER_PLATFORM_ROLES = ["FACULTY", "ITTC", "TTADMIN", "iams-dept-admin"];
const STUDENT_PLATFORM_ROLES = ["STUDENT"];

const rolesOf = (value) => (Array.isArray(value) ? value : [value].filter(Boolean));

const isPlatformAdmin = (roles) => rolesOf(roles).some((r) => PLATFORM_ADMIN_ROLES.includes(r));

// The platform roles this module is for at all. It is deliberately *not* an
// authorisation check — membership still decides everything inside a class (a
// teacher may invite an existing account without granting it STUDENT, see
// memberController.inviteMembers) — it only tells the two reasons for a refusal
// apart: an account that could never open these pages, versus a student who is
// simply not on this class's roll. Case-insensitive, because these strings are
// typed by hand in user management.
const hasLearningRole = (roles) => {
  const known = [...STUDENT_PLATFORM_ROLES, ...TEACHER_PLATFORM_ROLES, ...PLATFORM_ADMIN_ROLES].map(
    (role) => role.toUpperCase(),
  );
  return rolesOf(roles).some((role) => known.includes(String(role).toUpperCase()));
};

// Name the class the way the student knows it — by subject, with its code when
// there is one — so "you are not enrolled" points at something recognisable.
const subjectLabel = (klass) => {
  const subject = klass.subject || klass.name;
  return klass.subjectCode ? `${subject} (${klass.subjectCode})` : subject;
};

// Returns the lmUser a token stands for, or null if it stands for nobody.
async function resolveUser(token) {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const details = await getUserDetails(decoded.id);
    if (!details) return null;

    const emails = rolesOf(details.email);
    const profile = await User.findById(decoded.id).select("name").lean();
    const lmUser = {
      id: String(decoded.id),
      email: emails[0] || "",
      emails: emails.map((e) => String(e).toLowerCase()),
      name: profile?.name || emails[0] || "User",
      roles: rolesOf(decoded.role || details.role),
      department: details.department || "",
    };
    lmUser.isAdmin = isPlatformAdmin(lmUser.roles);
    return lmUser;
  } catch (err) {
    return null;
  }
}

async function authenticate(req, res, next) {
  const lmUser = await resolveUser(readAuthToken(req));
  if (!lmUser) return res.status(401).json({ message: "Unauthorized" });
  req.lmUser = lmUser;
  return next();
}

/**
 * Authenticates when it can and shrugs when it cannot: no token, or a bad one,
 * leaves `req.lmUser` undefined and the request continues.
 *
 * Only for endpoints that decide the question themselves — the Shorts
 * participant routes, where whether a sign-in is required is a property of the
 * deck being joined, and is not knowable until the join code resolves.
 */
async function authenticateOptional(req, res, next) {
  const lmUser = await resolveUser(readAuthToken(req));
  if (lmUser) req.lmUser = lmUser;
  return next();
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

    // Three different problems, three different answers. One flat "you are not a
    // member" left a student unable to tell a missing role from a missing
    // enrolment from an unapproved join request, and so unable to fix any of it.
    if (!role) {
      if (!hasLearningRole(req.lmUser.roles)) {
        return res.status(403).json({
          code: "ROLE_REQUIRED",
          message:
            "You do not have the necessary role to open these pages. Classes, quizzes and tests are available to student and teaching-staff accounts only — ask your administrator to grant your account the right role.",
        });
      }

      if (membership?.status === "pending") {
        return res.status(403).json({
          code: "JOIN_PENDING",
          subject: subjectLabel(klass),
          message: `Your request to join ${subjectLabel(klass)} has not been approved yet. You will be able to open this subject once the teacher accepts it.`,
        });
      }

      return res.status(403).json({
        code: "NOT_ENROLLED",
        subject: subjectLabel(klass),
        message: `You do not have the necessary access to ${subjectLabel(klass)} because you are not enrolled in this subject. Ask your teacher to add you, or join with the class code.`,
      });
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

/**
 * Sitting a test is for this class's students and nobody else.
 *
 * `loadClass` has already turned away everyone with no standing here at all;
 * this is the other half of the rule — an *active student enrolment*, not
 * merely access. Teaching staff, collaborators and platform admins reach a
 * class through roles rather than the roll, and an attempt from one of them
 * would land in the same results table as the cohort's, skewing every average
 * the teacher then reads. So they are refused the paper rather than quietly
 * scored alongside it.
 *
 * Membership is re-read from the request rather than trusted from the client:
 * a student removed from the class mid-sitting fails the very next call.
 */
function requireClassStudent(req, res, next) {
  const enrolled = req.lmMembership?.status === "active" && req.lmMembership.role === "student";
  if (enrolled) return next();

  return res.status(403).json({
    code: req.lmIsTeacher ? "STAFF_CANNOT_SIT" : "NOT_ENROLLED",
    message: req.lmIsTeacher
      ? "Only students enrolled in this class can take the test. Staff accounts can read the paper in the quiz editor instead."
      : "Only students enrolled in this class can take the test. Ask your teacher to add you to the class.",
  });
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
  authenticateOptional,
  requireClassCreator,
  loadClass,
  requireTeacher,
  requireClassStudent,
  requireOwner,
  asyncRoute,
  isPlatformAdmin,
  hasLearningRole,
  PLATFORM_ADMIN_ROLES,
  TEACHER_PLATFORM_ROLES,
  STUDENT_PLATFORM_ROLES,
};
