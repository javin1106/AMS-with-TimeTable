const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const User = require('../../../models/usermanagement/user');
const { sendWelcomeEmail } = require('../../usermanagement/controllers/welcomeMailer');
const { notifyUserCreated } = require('../../usermanagement/controllers/adminNotifier');

/**
 * Creates platform accounts for people a teacher invites to a class.
 *
 * There is deliberately **no new login system here**. The platform already
 * has one — bcrypt-hashed passwords, a JWT cookie, and an OTP-backed
 * "set your password" flow at /forgot-password. A second one would be a
 * second thing to keep secure. So a provisioned account is an ordinary
 * platform account that happens to be created by a teacher instead of an
 * admin, and the invitee completes it through the existing flow.
 *
 * The account is created with a random password nobody ever learns: the
 * welcome email sends them to the OTP page to choose their own. That avoids
 * mailing a plaintext password, and means an unclaimed account cannot be
 * signed into.
 */

// The only two roles a class teacher may hand out. Anything else — admin,
// iams-admin, ITTC — stays an administrator's decision; a compromised or
// careless teacher account must not be able to escalate anyone.
const GRANTABLE_ROLES = { student: 'STUDENT', 'co-teacher': 'FACULTY', teacher: 'FACULTY' };

const roleForClassRole = (classRole) => GRANTABLE_ROLES[classRole] || 'STUDENT';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isValidEmail = (email) => EMAIL_PATTERN.test(String(email || '').trim());

/** A password no one knows, so the account is unusable until claimed. */
const unguessablePassword = () => crypto.randomBytes(32).toString('base64url');

// The class name, section and the inviter's name are user-supplied and land in
// email markup, so they are escaped first — same reasoning as notifyService.
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));

/**
 * @param {object} options
 * @param {string[]} options.emails       lowercase addresses to provision
 * @param {string}   options.classRole    'student' | 'co-teacher'
 * @param {object}   options.klass        the class, for the email copy and dept
 * @param {string}   options.invitedByName
 * @param {string}   options.frontendBase used to build the set-password link
 * @param {boolean}  options.grantRoleToExisting
 *        Whether an account that already exists but lacks the role should
 *        gain it. Off by default: silently changing an existing user's roles
 *        because someone added them to a class is a surprise.
 *
 * @returns {Promise<Map<string, {user: object, created: boolean, roleAdded: boolean, error?: string}>>}
 */
async function provisionAccounts({
  emails,
  classRole = 'student',
  klass,
  invitedByName = 'A teacher',
  frontendBase,
  grantRoleToExisting = false,
}) {
  const platformRole = roleForClassRole(classRole);
  const results = new Map();

  const clean = [...new Set((emails || []).map((email) => String(email || '').trim().toLowerCase()))]
    .filter(Boolean);

  // One query for the whole batch — `email` is an array field on the user
  // schema, so $in matches any address on the account.
  const existing = await User.find({ email: { $in: clean } });
  const byEmail = new Map();
  existing.forEach((user) => {
    (Array.isArray(user.email) ? user.email : [user.email]).forEach((address) => {
      if (address) byEmail.set(String(address).toLowerCase(), user);
    });
  });

  for (const email of clean) {
    if (!isValidEmail(email)) {
      results.set(email, { user: null, created: false, roleAdded: false, error: 'Not a valid email address.' });
      continue;
    }

    const found = byEmail.get(email);

    if (found) {
      let roleAdded = false;
      if (grantRoleToExisting && !(found.role || []).includes(platformRole)) {
        found.role = [...(found.role || []), platformRole];
        // eslint-disable-next-line no-await-in-loop
        await found.save();
        roleAdded = true;
      }
      results.set(email, { user: found, created: false, roleAdded });
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const hash = await bcrypt.hash(unguessablePassword(), 10);
      // eslint-disable-next-line no-await-in-loop
      const user = await User.create({
        name: email,
        email: [email],
        password: hash,
        role: [platformRole],
        dept: klass?.dept || '',
        isEmailVerified: false,
        // Marks the account as never signed in, matching what the admin
        // registration path sets.
        isFirstLogin: false,
      });

      notifyUserCreated(user);

      sendWelcomeEmail({
        email,
        frontendBase,
        // Matches the banner on the invite mail (notifyService), so both routes
        // into a class are topped identically.
        banner: 'Welcome to XCEED Learning!',
        heading: `You have been added to ${klass?.name || 'a class'}`,
        // No class code here on purpose: this account was created for this
        // exact address and enrolled as active in the same request, so there is
        // nothing left to join manually. Offering a code only prompts "do I
        // need to enter this?".
        intro: `<p>${esc(invitedByName)} added you to the class
                  <strong>${esc(klass?.name || '')}</strong>${klass?.section ? ` (${esc(klass.section)})` : ''}
                  on the XCEED platform (NIT Jalandhar), and created an account for you with the
                  role <strong>${platformRole}</strong>.</p>
                <p>Once you have set your password, open the <strong>Learning</strong> module —
                  the class is already on your dashboard.</p>`,
        accountCreated: true,
      });

      results.set(email, { user, created: true, roleAdded: true });
    } catch (error) {
      // A duplicate here means a concurrent invite won the race — re-read
      // rather than reporting a failure the teacher can do nothing about.
      if (error.code === 11000) {
        // eslint-disable-next-line no-await-in-loop
        const raced = await User.findOne({ email });
        if (raced) {
          results.set(email, { user: raced, created: false, roleAdded: false });
          continue;
        }
      }
      console.error('[LearningModule] provisionAccounts', email, error.message);
      results.set(email, { user: null, created: false, roleAdded: false, error: error.message });
    }
  }

  return results;
}

module.exports = { provisionAccounts, roleForClassRole, isValidEmail, GRANTABLE_ROLES };
