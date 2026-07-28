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

const emailShell = (title, body, link) => `
  <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:auto">
    <h2 style="color:#1967d2;margin-bottom:4px">${title}</h2>
    <p style="color:#3c4043;line-height:1.6">${body}</p>
    ${link ? `<p><a href="${link}" style="color:#1967d2">Open in XCEED Learning</a></p>` : ""}
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

    await LmNotification.insertMany(
      finalRecipients.map((userId) => ({
        userId,
        classId: klass._id,
        className: klass.name,
        type,
        title,
        body,
        link,
        actorName,
      })),
    );

    if (email && sendMail && klass.settings?.emailNotifications && emailAddresses.length) {
      // Digest-style single send rather than one mail per member — the SMTP
      // pool in mailer.js is shared with the rest of the platform.
      await sendMail(emailAddresses.join(","), `[${klass.name}] ${title}`, emailShell(title, body, link)).catch(
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
      body,
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
  const body = `${inviterName} added you to the class <b>${klass.name}</b>${
    klass.section ? ` (${klass.section})` : ""
  }. Sign in to XCEED and open the Learning module, or join manually with the class code <b>${klass.code}</b>.`;
  await sendMail(to, `[XCEED Learning] ${title}`, emailShell(title, body, "")).catch((err) =>
    console.error("[LearningModule] invite mail failed:", err.message),
  );
}

module.exports = { notifyClass, notifyUser, sendInviteMail };
