// Mirrors the platform-role rules the server enforces in
// server/src/modules/learningModule/middleware/lmAuth.js. The API stays the
// authority — this only decides what the UI bothers to render.
const TEACHER_PLATFORM_ROLES = ['FACULTY', 'ITTC', 'TTADMIN', 'iams-dept-admin'];
const ADMIN_PLATFORM_ROLES = ['admin', 'iams-admin', 'lm-admin'];

export const rolesOf = (value) =>
  (Array.isArray(value) ? value : [value]).filter(Boolean).map((role) => String(role));

/** Faculty and platform admins open classes; students join existing ones. */
export const canCreateClass = (value) =>
  rolesOf(value).some(
    (role) => TEACHER_PLATFORM_ROLES.includes(role) || ADMIN_PLATFORM_ROLES.includes(role),
  );

/**
 * A pure student: their whole surface is the learning module, so it carries
 * its own header instead of sitting under the platform-wide one.
 */
export const isStudentOnly = (value) => {
  const roles = rolesOf(value);
  return roles.some((role) => role.toUpperCase() === 'STUDENT') && !canCreateClass(roles);
};
