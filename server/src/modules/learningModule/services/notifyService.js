const LmMembership = require("../models/lmMembership");
const LmNotification = require("../models/lmNotification");
// Bug reports go to whoever is a platform admin *now*, so the roles that mean
// "admin" are read from the middleware that already defines them rather than
// copied — a role added there must not need a second edit here.
const { PLATFORM_ADMIN_ROLES } = require("../middleware/lmAuth");
const User = require("../../../models/usermanagement/user");

// Reuses the platform's existing nodemailer transport rather than configuring
// a second one — same SMTP credentials, same "from" identity.
let sendMail = null;
let sendBulkMail = null;
try {
  ({ sendMail, sendBulkMail } = require("../../mailerModule/mailer"));
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
 * `banner` names the product inside the frame — this is Learning module mail,
 * and "XCEED Learning" is what a student recognises on the class stream they
 * were just posted to. The invite greets the person instead, since for many of
 * them it is the first XCEED Learning mail they have ever received.
 *
 * `bodyHtml` is trusted HTML — every caller escapes its own interpolations.
 */
const emailShell = ({
  heading,
  bodyHtml,
  banner = "XCEED Learning",
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
 * Addresses to mail for a set of membership rows.
 *
 * The row carries a denormalised `email`, but it is only ever as good as the
 * path that wrote it — a row enrolled before that field was populated, or one
 * whose address was cleared, carries none. Such a student was simply absent
 * from every class mail, with nothing anywhere to say so. Anything missing is
 * resolved once, in bulk, from the account itself.
 */
async function addressesFor(members) {
  const addresses = [];
  const missing = [];

  members.forEach((member) => {
    if (member.email) addresses.push(member.email);
    else if (member.userId) missing.push(member.userId);
  });

  if (missing.length) {
    try {
      const rows = await User.find({ _id: { $in: missing } }).select("email").lean();
      rows.forEach((row) => {
        // `email` is an array on the user schema; the first one is the primary.
        const [primary] = (Array.isArray(row.email) ? row.email : [row.email]).filter(Boolean);
        if (primary) addresses.push(primary);
      });
    } catch (error) {
      console.error("[LearningModule] could not resolve member addresses:", error.message);
    }
  }

  return [...new Set(addresses.map((a) => String(a).trim().toLowerCase()).filter(Boolean))];
}

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

  let audience = [];
  try {
    // One query, one filter, for both halves. These used to be derived
    // separately: the targeted branch skipped `status`/`muted` entirely, so a
    // removed or muted member still got the mail, and the actor was dropped
    // from the in-app list but not the mail list — so the teacher who posted
    // was emailed about their own post.
    const members = await LmMembership.find({
      classId: klass._id,
      status: "active",
      // Not `muted: false`. Mongo does not match a missing field against
      // `false`, so every membership row written before `muted` existed was
      // read as muted and dropped here — no notification, no mail, no trace.
      muted: { $ne: true },
      ...(userIds ? { userId: { $in: userIds } } : {}),
    })
      .select("userId email")
      .lean();

    audience = members.filter(
      (member) => member.userId && String(member.userId) !== String(excludeUserId),
    );
  } catch (error) {
    console.error("[LearningModule] could not resolve notification audience:", error.message);
    return;
  }

  if (!audience.length) return;
  const plainBody = toPlainExcerpt(body);

  // The in-app write and the mail are separate failures. They used to share one
  // try block with the insert first, so a single rejected notification row —
  // one bad classId, one validation slip — silently cancelled the whole class's
  // email for that post.
  try {
    await LmNotification.insertMany(
      audience.map((member) => ({
        userId: member.userId,
        classId: klass._id,
        className: klass.name,
        type,
        title,
        body: plainBody,
        link,
        actorName,
      })),
    );
  } catch (error) {
    console.error("[LearningModule] in-app notification failed:", error.message);
  }

  if (!email) return;

  try {
    if (!sendBulkMail) {
      console.warn(`[LearningModule] no mailer: "${title}" not emailed to ${klass.name}`);
      return;
    }
    // Checked against `false`, not for truthiness. A class document written
    // before this preference existed — or read through a projection that did
    // not ask for it — has no `settings.emailNotifications` at all, and every
    // one of those classes had its mail silently switched off by the old
    // truthy test. Absent means "never turned off", which means send.
    if (klass.settings?.emailNotifications === false) return;

    const emailAddresses = await addressesFor(audience);
    if (!emailAddresses.length) {
      console.warn(
        `[LearningModule] "${title}" in ${klass.name}: ${audience.length} members, no address on any of them`,
      );
      return;
    }

    const { sent, failed } = await sendBulkMail(
      emailAddresses,
      `[${klass.name}] ${title}`,
      emailShell({
        heading: title,
        bodyHtml: `<p style="margin:0;">${escapeHtml(plainBody)}</p>`,
        ctaLabel: "Open in XCEED Learning",
        ctaHref: absoluteLink(link),
        footnote: `Posted in <strong>${escapeHtml(klass.name)}</strong>. You can turn these emails off in the class settings.`,
      }),
    );

    console.log(`[LearningModule] "${title}" in ${klass.name}: mailed ${sent}, failed ${failed}`);
    if (failed) {
      console.error(
        `[LearningModule] notification mail: ${failed}/${emailAddresses.length} recipients not reached in ${klass.name}`,
      );
    }
  } catch (error) {
    // Notifications are best-effort: never fail the originating request.
    console.error("[LearningModule] notification mail failed:", error.message);
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

/**
 * Who hears about a new bug report or suggestion.
 *
 * Read from the user collection rather than a hard-coded list, so an account
 * promoted to admin in user management starts receiving these without a deploy.
 * `BUG_REPORT_EMAIL` (comma-separated) is added on top for the shared inbox
 * that no single account owns — it is an addition, not an override, because a
 * mistyped env var must not silently stop the whole queue being seen.
 */
async function bugReportRecipients() {
  const extra = String(process.env.BUG_REPORT_EMAIL || "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);

  let admins = [];
  try {
    const rows = await User.find({ role: { $in: PLATFORM_ADMIN_ROLES } })
      .select("email")
      .lean();
    // `email` is an array on the user schema; an account may hold more than one.
    admins = rows.flatMap((row) => (Array.isArray(row.email) ? row.email : [row.email]));
  } catch (error) {
    console.error("[LearningModule] could not resolve bug report admins:", error.message);
  }

  return [...new Set([...admins, ...extra].map((a) => String(a || "").trim()).filter(Boolean))];
}

/**
 * Mail every platform admin the moment something is reported.
 *
 * The whole report travels in the body — title, description, page, reporter —
 * so a defect can be read, and often understood, without signing in. The link
 * is for acting on it, not for finding out what it says.
 *
 * Best-effort, like every other notification here: a report that was written
 * down must never fail because the SMTP box was unreachable.
 */
async function sendBugReportMail(report) {
  try {
    if (!sendBulkMail) return;

    const recipients = await bugReportRecipients();
    if (!recipients.length) {
      console.warn("[LearningModule] new bug report but no admin address to send it to");
      return;
    }

    const isSuggestion = report.kind === "suggestion";
    const label = isSuggestion ? "Suggestion" : "Bug report";
    const heading = `New ${label.toLowerCase()}: ${report.title}`;

    // Every value below is user-supplied — the description is plain text from a
    // textarea, but it still gets escaped before it lands in email markup.
    const row = (name, value) =>
      value
        ? `<p style="margin:0 0 6px;"><strong>${escapeHtml(name)}:</strong> ${escapeHtml(value)}</p>`
        : "";

    const bodyHtml = `
      ${row("Reported by", `${report.reporterName || "Unknown"} (${report.reporterEmail || "no address"})`)}
      ${row("Acting as", report.reporterRole || "user")}
      ${row("Class", report.className || "not class-specific")}
      ${row("Page", report.pageUrl)}
      <p style="margin:16px 0 6px;"><strong>What they said:</strong></p>
      <div style="white-space:pre-wrap;background:#f7f9fc;border:1px solid #e4e8f5;border-radius:8px;padding:12px;font-size:13px;color:#333;">${
        escapeHtml(report.description) || "<em style=\"color:#888;\">No further detail given.</em>"
      }</div>`;

    const { failed } = await sendBulkMail(
      recipients,
      `[XCEED ${label}] ${toPlainExcerpt(report.title, 120)}`,
      emailShell({
        heading,
        bodyHtml,
        ctaLabel: "Review in Super Admin",
        ctaHref: absoluteLink("/superadmin/bugs"),
        footnote: isSuggestion
          ? "Adopting a suggestion awards the person who sent it."
          : "Confirming a report awards the reporter, once.",
      }),
    );

    if (failed) {
      console.error(
        `[LearningModule] bug report mail: ${failed}/${recipients.length} admins not reached`,
      );
    }
  } catch (error) {
    console.error("[LearningModule] sendBugReportMail failed:", error.message);
  }
}

module.exports = { notifyClass, notifyUser, sendInviteMail, sendBugReportMail };
