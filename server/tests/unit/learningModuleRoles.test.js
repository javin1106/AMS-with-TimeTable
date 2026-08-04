/**
 * Which platform roles can become a class teacher.
 *
 * `loadClass` grants `teacher` standing by exactly three routes, and the third
 * is the one worth pinning:
 *
 *   1. an active membership whose role is teacher or co-teacher
 *   2. being the class owner
 *   3. holding a platform admin role — an *implicit* teacher view of every
 *      class in the installation, so support can open a class without being
 *      enrolled in it
 *
 * Route 3 is deliberate and documented, but it is a standing grant over every
 * class's answer keys, gradebooks and student work, so which roles carry it is
 * a decision that should not drift by accident. Adding a role to
 * PLATFORM_ADMIN_ROLES hands it that; this test makes that a visible edit
 * rather than a one-word diff nobody reviews.
 */

const {
  isPlatformAdmin,
  hasLearningRole,
  TEACHER_PLATFORM_ROLES,
  STUDENT_PLATFORM_ROLES,
} = require('../../src/modules/learningModule/middleware/lmAuth');

describe('learningModule roles — implicit teacher over every class', () => {
  it('grants it to exactly the three platform admin roles', () => {
    expect(isPlatformAdmin(['admin'])).toBe(true);
    expect(isPlatformAdmin(['iams-admin'])).toBe(true);
    expect(isPlatformAdmin(['lm-admin'])).toBe(true);
  });

  it('does not grant it to any teaching role', () => {
    // FACULTY may *create* a class; that is not the same as being staff inside
    // somebody else's. `iams-dept-admin` sounds administrative and is the one
    // most likely to be added by mistake.
    TEACHER_PLATFORM_ROLES.forEach((role) => {
      expect(isPlatformAdmin([role])).toBe(false);
    });
    expect(isPlatformAdmin(['iams-dept-admin'])).toBe(false);
    expect(isPlatformAdmin(['TTADMIN'])).toBe(false);
  });

  it('does not grant it to students or to unknown roles', () => {
    expect(isPlatformAdmin(['STUDENT'])).toBe(false);
    expect(isPlatformAdmin(['dm-admin'])).toBe(false);
    expect(isPlatformAdmin([])).toBe(false);
    expect(isPlatformAdmin(undefined)).toBe(false);
  });

  it('is not fooled by a role that merely contains an admin name', () => {
    // Membership, not substring: a `not-admin` or `admin-assistant` role must
    // not inherit the whole installation.
    expect(isPlatformAdmin(['not-admin'])).toBe(false);
    expect(isPlatformAdmin(['admin-assistant'])).toBe(false);
    expect(isPlatformAdmin(['superadmin'])).toBe(false);
  });

  it('reads a single role as well as an array', () => {
    // The JWT carries either shape depending on which login issued it.
    expect(isPlatformAdmin('admin')).toBe(true);
    expect(isPlatformAdmin('STUDENT')).toBe(false);
  });
});

describe('learningModule roles — who may open the module at all', () => {
  it('admits students, teaching staff and admins', () => {
    [...STUDENT_PLATFORM_ROLES, ...TEACHER_PLATFORM_ROLES, 'admin'].forEach((role) => {
      expect(hasLearningRole([role])).toBe(true);
    });
  });

  it('turns away an account holding none of them', () => {
    // The refusal is what produces ROLE_REQUIRED rather than a flat 403, so a
    // user can tell a missing role from a missing enrolment.
    expect(hasLearningRole(['dm-doctor'])).toBe(false);
    expect(hasLearningRole([])).toBe(false);
  });

  it('is case-insensitive, because the platform is inconsistent about it', () => {
    expect(hasLearningRole(['student'])).toBe(true);
    expect(hasLearningRole(['faculty'])).toBe(true);
  });
});

describe('learningModule roles — the class-creation gate', () => {
  it('keeps students out of class creation', () => {
    expect(TEACHER_PLATFORM_ROLES).not.toContain('STUDENT');
    STUDENT_PLATFORM_ROLES.forEach((role) => {
      expect(TEACHER_PLATFORM_ROLES).not.toContain(role);
    });
  });
});
