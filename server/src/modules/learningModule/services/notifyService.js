const LmMembership = require("../models/lmMembership");
const LmNotification = require("../models/lmNotification");

// Reuses the platform's existing nodemailer transport rather than configuring
// a second one — same SMTP credentials, same "from" identity.
let sendMail = null;
try {
  ({ sendMail } = require("../../mailerModule/mailer"));
} catch (err) {
  console.warn("[LearningModule] mailer unavailable, notifications will be in-app only");
}

/**
 * Notification and email bodies are excerpts of user-authored content, which is
 * now rich text. Two reasons to flatten it here rather than pass it through:
 * a half-open `<p` from `.slice(0, 200)` would corrupt the surrounding email
 * markup, and interpolating author-controlled HTML into an email body is a
 * needless injection surface. Notifications are a one-line summary anyway.
 */
const toPlainExcerpt = (value, limit = 200) => {
  const text = String(value ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6])>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
};

// Escaped before interpolation so a stray < or & from the excerpt cannot break
// (or inject into) the email markup.
const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));

// `body` may already be trusted HTML (the invite mail composes its own), so
// callers pass pre-escaped content; `title` is always plain and is escaped here.
const emailShell = (title, body, link) => `
  <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:auto">
    <h2 style="color:#1967d2;margin-bottom:4px">${escapeHtml(title)}</h2>
    <p style="color:#3c4043;line-height:1.6">${body}</p>
    ${link ? `<p><a href="${escapeHtml(link)}" style="color:#1967d2">Open in XCEED Learning</a></p>` : ""}
    <hr style="border:none;border-top:1px solid #e0e0e0;margin:24px 0" />
    <p style="color:#80868b;font-size:12px">XCEED Learning Module — NIT Jalandhar</p>
  </div>`;

/**
 * Fan a notification out to class members.
 *
 * @param {object} opts
 * @param {object} opts.klass          the lm_class document
 * @param {string[]} [opts.userIds]    explicit recipients; defaults to every
 *                                     active member except the actor
 * @param {string} [opts.excludeUserId] actor, so nobody is notified of their
 *                                     own action
 * @param {boolean} [opts.email]       also send mail (respects class settings)
 */
async function notifyClass(opts) {
  const {
    klass,
    userIds = null,
    excludeUserId = null,
    type,
    title,
    body = "",
    link = "",
    actorName = "",
    email = false,
  } = opts;

  try {
    let recipients = userIds;
    let emailAddresses = [];

    if (!recipients) {
      const members = await LmMembership.find({
        classId: klass._id,
        status: "active",
        muted: false,
      })
        .select("userId email")
        .lean();
      recipients = members.map((m) => m.userId).filter(Boolean);
      emailAddresses = members.map((m) => m.email).filter(Boolean);
    } else {
      const members = await LmMembership.find({
        classId: klass._id,
        userId: { $in: recipients },
      })
        .select("userId email")
        .lean();
      emailAddresses = members.map((m) => m.email).filter(Boolean);
    }

    const finalRecipients = recipients.filter((id) => String(id) !== String(excludeUserId));
    if (!finalRecipients.length) return;

    const plainBody = toPlainExcerpt(body);

    await LmNotification.insertMany(
      finalRecipients.map((userId) => ({
        userId,
        classId: klass._id,
        className: klass.name,
        type,
        title,
        body: plainBody,
        link,
        actorName,
      })),
    );

    if (email && sendMail && klass.settings?.emailNotifications && emailAddresses.length) {
      // Digest-style single send rather than one mail per member — the SMTP
      // pool in mailer.js is shared with the rest of the platform.
      await sendMail(
        emailAddresses.join(","),
        `[${klass.name}] ${title}`,
        emailShell(title, escapeHtml(plainBody), link),
      ).catch(
        (err) => console.error("[LearningModule] notification mail failed:", err.message),
      );
    }
  } catch (error) {
    // Notifications are best-effort: never fail the originating request.
    console.error("[LearningModule] notifyClass failed:", error.message);
  }
}

async function notifyUser({ userId, klass, type, title, body = "", link = "", actorName = "" }) {
  try {
    if (!userId) return;
    await LmNotification.create({
      userId,
      classId: klass?._id || null,
      className: klass?.name || "",
      type,
      title,
      body: toPlainExcerpt(body),
      link,
      actorName,
    });
  } catch (error) {
    console.error("[LearningModule] notifyUser failed:", error.message);
  }
}

async function sendInviteMail(to, klass, inviterName) {
  if (!sendMail || !to) return;
  const title = `You have been added to ${klass.name}`;
  // A class name, section and the inviter's name are all user-supplied, so they
  // are escaped before landing in the email markup.
  const body = `${escapeHtml(inviterName)} added you to the class <b>${escapeHtml(klass.name)}</b>${
    klass.section ? ` (${escapeHtml(klass.section)})` : ""
  }. Sign in to XCEED and open the Learning module, or join manually with the class code <b>${escapeHtml(klass.code)}</b>.`;
  await sendMail(to, `[XCEED Learning] ${title}`, emailShell(title, body, "")).catch((err) =>
    console.error("[LearningModule] invite mail failed:", err.message),
  );
}

module.exports = { notifyClass, notifyUser, sendInviteMail };
