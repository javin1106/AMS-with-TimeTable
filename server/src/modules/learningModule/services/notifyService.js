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

// Links in a notification are stored as in-app paths ("/learning/class/…"),
// which a mail client cannot resolve. Absolutise them against the deployed
// frontend, the same base welcomeMailer falls back to.
const frontendBase = (base) =>
  String(base || process.env.FRONTEND_URL || "https://xceed.nitj.ac.in").replace(/\/+$/, "");

const absoluteLink = (link, base) => {
  const value = String(link || "");
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `${frontendBase(base)}/${value.replace(/^\/+/, "")}`;
};

/**
 * The platform's mail frame — same 480px card, teal banner, "Dear User,"
 * greeting and footer as the forgot-password OTP mail (otpbody.ejs) and the
 * welcome mail (usermanagement/welcomeMailer). Learning module mail used to
 * carry its own lighter markup, which read as coming from somewhere else
 * entirely.
 *
 * `banner` defaults to the platform wordmark the other mails use; the invite
 * greets the person instead, since for many of them it is the first XCEED
 * Learning mail they have ever received.
 *
 * `bodyHtml` is trusted HTML — every caller escapes its own interpolations.
 */
const emailShell = ({
  heading,
  bodyHtml,
  banner = "XCEED — NIT Jalandhar",
  ctaLabel = "",
  ctaHref = "",
  chipLabel = "",
  chip = "",
  footnote = "",
}) => `
<div style="background:#f4f6fb;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e4e8f5;overflow:hidden;">
    <div style="background:#0e7490;padding:20px 28px;">
      <div style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.02em;">${escapeHtml(banner)}</div>
    </div>
    <div style="padding:28px;">
      <h1 style="margin:0 0 12px;font-size:20px;color:#1a1f3c;">${escapeHtml(heading)}</h1>
      <p style="margin:0 0 8px;font-size:14px;color:#444;line-height:1.6;">Dear User,</p>
      <div style="margin:0 0 20px;font-size:14px;color:#444;line-height:1.6;">${bodyHtml}</div>
      ${
        ctaHref
          ? `<div style="text-align:center;margin:0 0 20px;">
        <a href="${escapeHtml(ctaHref)}"
           style="display:inline-block;padding:12px 32px;background:#0e7490;color:#ffffff;
                  text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">
          ${escapeHtml(ctaLabel || "Open in XCEED")}</a>
      </div>`
          : ""
      }
      ${
        chip
          ? `${chipLabel ? `<p style="margin:0 0 8px;font-size:14px;color:#444;line-height:1.6;text-align:center;">${escapeHtml(chipLabel)}</p>` : ""}
      <div style="text-align:center;margin:0 0 20px;">
        <span style="display:inline-block;background:#f0f9ff;border:1px dashed #0e7490;border-radius:10px;padding:12px 28px;font-size:22px;font-weight:700;letter-spacing:6px;color:#0e7490;font-family:'Courier New',monospace;">${escapeHtml(chip)}</span>
      </div>`
          : ""
      }
      ${footnote ? `<p style="margin:0;font-size:12px;color:#888;line-height:1.6;">${footnote}</p>` : ""}
    </div>
    <div style="padding:14px 28px;border-top:1px solid #e4e8f5;background:#fafbfe;">
      <span style="font-size:11px;color:#999;">Automated email from the XCEED platform — please do not reply.</span>
    </div>
  </div>
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
      const href = absoluteLink(link);
      await sendMail(
        emailAddresses.join(","),
        `[${klass.name}] ${title}`,
        emailShell({
          heading: title,
          bodyHtml: `<p style="margin:0;">${escapeHtml(plainBody)}</p>`,
          ctaLabel: "Open in XCEED Learning",
          ctaHref: href,
          footnote: `Posted in <strong>${escapeHtml(klass.name)}</strong>. You can turn these emails off in the class settings.`,
        }),
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

/**
 * Mail sent to someone a teacher just added to a class.
 *
 * Resolves to `true` only when the mail actually left, so the invite response
 * can tell the teacher which addresses were not reached — this used to swallow
 * every failure and report a clean success.
 *
 * @param {string} to
 * @param {object} klass
 * @param {string} inviterName
 * @param {string} [base]  frontend origin, for the "Open the class" link
 * @param {boolean} [enrolled]
 *        True when the recipient already has a platform account and was
 *        enrolled as an active member in this same request. Such a person has
 *        nothing to join manually, so the class code is omitted — it only
 *        raises "do I need to enter this?".
 *
 *        False means the invite is waiting on an address with no account yet.
 *        `claimInvites` matches on email, so it enrols them automatically *if*
 *        they register with this same address; the code is the fallback for
 *        when they sign up under a different one, and is the only case where
 *        it earns its place.
 * @returns {Promise<boolean>}
 */
async function sendInviteMail(to, klass, inviterName, base, enrolled = false) {
  if (!sendMail || !to) return false;

  const heading = `You have been added to ${klass.name}`;
  // The class name, section, code and the inviter's name are all user-supplied,
  // so they are escaped before landing in the email markup.
  const bodyHtml = `<p style="margin:0 0 12px;">${escapeHtml(inviterName || "A teacher")} added you to the class
      <strong>${escapeHtml(klass.name)}</strong>${klass.section ? ` (${escapeHtml(klass.section)})` : ""}
      on the XCEED platform (NIT Jalandhar).</p>
    <p style="margin:0;">Sign in and open the <strong>Learning</strong> module to see the class, its
      classwork and its schedule.</p>`;

  const showCode = !enrolled && Boolean(klass.code);

  try {
    await sendMail(
      to,
      `${heading} — XCEED NITJ`,
      emailShell({
        heading,
        bodyHtml,
        banner: "Welcome to XCEED Learning!",
        ctaLabel: "Open the class",
        ctaHref: absoluteLink(`/learning/class/${klass._id}`, base),
        chipLabel: showCode ? "Signing up with a different address? Join with this class code:" : "",
        chip: showCode ? klass.code : "",
        footnote: enrolled
          ? ""
          : "If you do not have an XCEED account for this address yet, the class will be waiting for you the first time you sign in with it.",
      }),
    );
    return true;
  } catch (err) {
    console.error("[LearningModule] invite mail failed:", to, err.message);
    return false;
  }
}

module.exports = { notifyClass, notifyUser, sendInviteMail };
