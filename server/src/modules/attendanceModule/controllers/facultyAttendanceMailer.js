// server/src/modules/attendanceModule/controllers/facultyAttendanceMailer.js
//
// End-of-class attendance summary, mailed to the faculty who taught the period.
//
// This is the only outbound mail in the module addressed to someone who is not
// in NotificationSettings.recipients — the address is resolved from the
// timetable's faculty name via the Faculty collection. It is therefore gated by
// its own switch (facultySummaryConfig.enabled) on top of the global
// NotificationSettings.enabled flag, and defaults to off.
//
// A period can be "ended" by two different paths — a live session being
// stopped, and the cron finishing its runs for the slot — so sending is
// idempotent: report.facultyEmail.sentAt is checked and set, and a second call
// for the same report is a no-op.

const AttendanceReport = require("../../../models/attendanceReport");
const StudentEmbedding = require("../../../models/attendanceModule/studentEmbedding");
const NotificationSettings = require("../../../models/attendanceModule/notificationSettings");
const { findFacultyByExactName } = require("../../timetableModule/helper/facultyLookup");
const { findDepartmentCoordinator } = require("../../usermanagement/controllers/facultyDepartment");
const { sendMailWithRetry } = require("../../mailerModule/transport");
const templates = require("./emailTemplates");
const { resolveSubjectRoster, rosterMembers, normRoll } = require("./subjectRoster");

/**
 * Ascending roll-number order, digit-aware.
 *
 * Roll numbers are strings but read as numbers, so a plain sort puts "21103010"
 * before "21103009"... only by luck of equal length. `numeric: true` orders the
 * digit runs by value, so mixed-width and prefixed forms ("21103009",
 * "21103010", "ECE-7") all come out in the order a human would write them.
 */
function sortRolls(rolls) {
  return [...new Set(rolls.map(normRoll).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  );
}

/**
 * Roster students the cameras are physically unable to recognise, because the
 * subject's embedding store was built without them.
 *
 * Two independent records say this, and they catch different cases:
 *   • Subject.missedGroundTruth — roll numbers on the uploaded list that had no
 *     ground-truth photo folder at generation time.
 *   • StudentEmbedding.rollNos — who the .pkl was actually built FROM. A roster
 *     student missing from it has no vector in the file, whatever the reason
 *     (added to the roster after the last generation, photos rejected by
 *     liveness, generation failed for them — see missedRollNos).
 *
 * Both are used, unioned. When no StudentEmbedding record exists at all we fall
 * back to missedGroundTruth alone rather than declaring the whole roster
 * unrecognisable — absence of a record is not evidence of absence of photos.
 *
 * @returns {Promise<Set<string>>} normalised roll numbers
 */
async function resolveNoGroundTruthRolls(subjectDoc, roster) {
  const missing = new Set();
  if (!subjectDoc) return missing;

  const rosterSet = new Set(roster.map(normRoll));

  for (const raw of subjectDoc.missedGroundTruth || []) {
    const roll = normRoll(raw);
    if (rosterSet.has(roll)) missing.add(roll);
  }

  if (!subjectDoc.embeddingFile) return missing;

  let embRecord = null;
  try {
    embRecord = await StudentEmbedding.findOne({
      embeddingFile: subjectDoc.embeddingFile,
      status: "done",
    })
      .sort({ generatedAt: -1 })
      .lean();
  } catch (err) {
    console.warn("[FacultyMail] Could not read StudentEmbedding record:", err.message);
    return missing;
  }
  if (!embRecord) return missing;

  for (const entry of embRecord.missedRollNos || []) {
    const roll = normRoll(entry?.rollNo);
    if (rosterSet.has(roll)) missing.add(roll);
  }

  // Built-from list is authoritative for what is actually inside the .pkl.
  const built = new Set((embRecord.rollNos || []).map(normRoll));
  if (built.size > 0) {
    for (const roll of rosterSet) {
      if (!built.has(roll)) missing.add(roll);
    }
  }

  return missing;
}

/**
 * The department coordinator's address, from the department's admin user
 * (role "iams-dept-admin" — see usermanagement/controllers/facultyDepartment).
 * They are copied on the summary so a faculty Reply-All about a wrong mark
 * reaches a person who can act on it.
 *
 * User.email is an array; the first non-empty entry is the primary address.
 * Never throws — a missing coordinator degrades to a mail with no CC.
 *
 * @returns {Promise<string>} "" when none can be resolved
 */
async function resolveCoordinatorEmail(dept) {
  if (!dept || !String(dept).trim()) return "";
  try {
    const coordinator = await findDepartmentCoordinator(String(dept).trim());
    const emails = Array.isArray(coordinator?.email)
      ? coordinator.email
      : [coordinator?.email];
    return (emails || []).map((e) => String(e || "").trim()).find(Boolean) || "";
  } catch (err) {
    console.warn("[FacultyMail] Could not resolve department coordinator:", err.message);
    return "";
  }
}

/**
 * Everything the template needs, derived from a saved AttendanceReport.
 * Read-only — safe to call for a preview.
 *
 * Counts cover the subject's roster only (rosterMembers), matching the report's
 * own summary: a face recognised but not enrolled in this subject is never
 * reported to the faculty as one of their students.
 */
async function buildSummaryData(report) {
  const { rollNos: roster, subjectDoc } = await resolveSubjectRoster({
    subject: report.subject,
    sem: report.semester,
    dept: report.department,
  });

  const members = rosterMembers(report.finalReport || []);
  const noGtSet = await resolveNoGroundTruthRolls(subjectDoc, roster.length ? roster : members.map((s) => s.rollNo));
  const coordinatorEmail = await resolveCoordinatorEmail(report.department);

  const presentRolls = [];
  const absentRolls = [];
  const reviewRolls = [];
  const noGroundTruthRolls = [];

  for (const s of members) {
    const roll = normRoll(s.rollNo);
    if (s.finalStatus === "P") {
      // A manual override can mark a student present even with no photos on
      // file — believe the override and leave them out of the missing list.
      presentRolls.push(roll);
    } else if (s.finalStatus === "R") {
      reviewRolls.push(roll);
    } else if (noGtSet.has(roll)) {
      noGroundTruthRolls.push(roll);
    } else {
      absentRolls.push(roll);
    }
  }

  return {
    facultyName: report.faculty || "",
    subject: report.subject || "",
    subjectCode: report.subjectMeta?.subCode || "",
    batch: report.batch || "",
    semester: report.semester || "",
    room: report.room || "",
    date: report.date || "",
    timeSlot: report.timeSlot || "",
    totalStudents: members.length,
    presentRolls: sortRolls(presentRolls),
    absentRolls: sortRolls(absentRolls),
    noGroundTruthRolls: sortRolls(noGroundTruthRolls),
    reviewRolls: sortRolls(reviewRolls),
    coordinatorEmail,
  };
}

/** Renders the email body for a report without sending anything. */
async function renderSummaryForReport(report) {
  const data = await buildSummaryData(report);
  return { data, html: templates.facultyAttendanceSummaryTemplate(data) };
}

/**
 * Mail the end-of-class summary for one report.
 *
 * Never throws — attendance must not fail because SMTP did. Every outcome is
 * returned (and the failing ones recorded on the report) so the caller can log
 * a reason rather than silence.
 *
 * @param {object} report          a mongoose AttendanceReport document
 * @param {object} [opts]
 * @param {boolean} [opts.force]   ignore the toggles and the already-sent guard
 * @param {string} [opts.toOverride] send here instead of the faculty (samples)
 * @returns {Promise<{sent: boolean, reason: string, to?: string}>}
 */
async function sendFacultyAttendanceSummary(report, opts = {}) {
  const { force = false, toOverride = null } = opts;

  try {
    if (!report) return { sent: false, reason: "no report" };

    if (!force && report.facultyEmail?.sentAt) {
      return { sent: false, reason: "already sent for this period" };
    }

    if (!force) {
      const settings = await NotificationSettings.getSettings();
      if (!settings.enabled) {
        return { sent: false, reason: "email notifications are globally disabled" };
      }
      if (!settings.facultySummaryConfig?.enabled) {
        return { sent: false, reason: "faculty attendance summary is switched off" };
      }
    }

    const settings = await NotificationSettings.getSettings().catch(() => null);
    const bcc = (settings?.facultySummaryConfig?.bccEmails || []).filter(Boolean);

    let to = toOverride;
    if (!to) {
      const faculty = await findFacultyByExactName(report.faculty);
      to = faculty?.email || "";
      if (!to) {
        const reason = faculty
          ? `faculty "${report.faculty}" has no email address on record`
          : `no Faculty record matches the timetable name "${report.faculty}"`;
        await recordFailure(report, reason);
        return { sent: false, reason };
      }
    }

    const { data, html } = await renderSummaryForReport(report);
    const subjectLine =
      `Attendance — ${data.subject || "Class"} · ${data.date} · ${data.timeSlot}` +
      ` — P:${data.presentRolls.length} A:${data.absentRolls.length + data.noGroundTruthRolls.length}`;

    // A sample goes to one address and nowhere else — copying the real
    // coordinator (or the BCC list) on a test would mail people about a class
    // that is not theirs. The body still names the coordinator, so the layout
    // is fully verifiable. The header is set regardless: replyTo is what makes
    // "reply to this email" reach a person rather than the unattended sending
    // mailbox.
    const isSample = !!toOverride;
    // Replies must reach BOTH the system mailbox and the coordinator — a
    // Reply-To carrying only the coordinator meant the iLEED side never saw
    // the faculty's correction. RFC 5322 allows several addresses in Reply-To;
    // nodemailer takes them comma-separated.
    const replyTo = [process.env.MAIL_USER, data.coordinatorEmail]
      .map((e) => String(e || "").trim())
      .filter(Boolean)
      .join(", ");

    await sendMailWithRetry({
      from: `XCEED NITJ <${process.env.MAIL_USER}>`,
      to,
      // Copied, not blind-copied: the mail invites a reply about a wrong mark,
      // and the faculty needs to see who else is on it for Reply-All to be the
      // obvious action.
      ...(!isSample && data.coordinatorEmail ? { cc: data.coordinatorEmail } : {}),
      ...(!isSample && bcc.length ? { bcc } : {}),
      ...(replyTo ? { replyTo } : {}),
      subject: subjectLine,
      html,
    });

    // Preview sends must not consume the real one for this period.
    if (!toOverride) {
      report.facultyEmail = { sentAt: new Date(), toAddress: to, lastError: null };
      await persist(report);
    }

    console.log(
      `[FacultyMail] Sent ${data.date} ${data.timeSlot} "${data.subject}" → ${to}` +
        (!isSample && data.coordinatorEmail ? ` (cc ${data.coordinatorEmail})` : "") +
        (data.coordinatorEmail ? "" : " — no department coordinator resolved, no CC"),
    );
    return { sent: true, reason: "", to };
  } catch (err) {
    console.error("[FacultyMail] Failed:", err.message);
    await recordFailure(report, err.message);
    return { sent: false, reason: err.message };
  }
}

async function recordFailure(report, reason) {
  try {
    if (!report?._id) return;
    report.facultyEmail = {
      sentAt: report.facultyEmail?.sentAt || null,
      toAddress: report.facultyEmail?.toAddress || null,
      lastError: reason,
    };
    await persist(report);
  } catch (err) {
    console.warn("[FacultyMail] Could not record failure on the report:", err.message);
  }
}

// The report may arrive as a full document (cron path) or be identified only by
// id (session path), so write through whichever is available.
async function persist(report) {
  if (typeof report.save === "function") {
    await report.save();
    return;
  }
  await AttendanceReport.findByIdAndUpdate(report._id, {
    facultyEmail: report.facultyEmail,
  });
}

/** Convenience wrapper for the callers that only hold a report id. */
async function sendFacultyAttendanceSummaryById(reportId, opts = {}) {
  const report = await AttendanceReport.findById(reportId);
  if (!report) return { sent: false, reason: `report ${reportId} not found` };
  return sendFacultyAttendanceSummary(report, opts);
}

module.exports = {
  sendFacultyAttendanceSummary,
  sendFacultyAttendanceSummaryById,
  renderSummaryForReport,
  buildSummaryData,
  // Exposed for unit tests
  sortRolls,
  resolveNoGroundTruthRolls,
};
