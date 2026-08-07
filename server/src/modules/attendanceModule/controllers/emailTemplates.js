// emailTemplates.js
// All HTML email templates for iLEED alert notifications.
//
// Every template is wrapped in a shared colorful card layout (banner + body +
// footer) that mirrors the OTP email and the other XCEED modules
// (timetableModule/helper/emailLayout.js), so all iLEED notifications share
// one consistent look. Accent colour is chosen per template by severity:
//   red  #dc2626  → outages / bunks / critical alerts
//   amber #d97706 → warnings needing attention
//   green #16a34a → recoveries / healthy
//   teal  #0e7490 → informational digests & summaries

// ---- Shared style tokens ----
const P = "margin:0 0 16px;font-size:14px;color:#444;line-height:1.6;";
const TABLE = "border-collapse:collapse;font-size:14px;width:100%;margin:0 0 16px;";
const TH =
  "padding:8px 12px;text-align:left;background:#f0f4fa;color:#5b6472;font-size:12px;font-weight:700;border-bottom:2px solid #e4e8f5;";
const TD =
  "padding:8px 12px;border-bottom:1px solid #eef1f7;font-size:13px;color:#1a1f3c;";

// The iLEED wordmark, email-safe: serif italic "i" + bold "LEED" (Georgia /
// Times fall back to the same style family as the frontend's STIX wordmark —
// web fonts are unreliable in email clients, so we use the stack every
// client ships with).
const ILEED_MARK =
  `<span style="font-family:Georgia,'Times New Roman',serif;"><i>i</i><b>LEED</b></span>`;
const ILEED_FULL_FORM = "Intelligent Learning Engagement and Entity Detection";

// Automated alerts go out from an unattended mailbox, so the default footer
// says so. The faculty attendance summary is the exception — it asks for a
// reply — and overrides this via `footerHtml`.
const DEFAULT_FOOTER = `<span style="font-size:11px;color:#999;">This is an automated alert from ${ILEED_MARK} on the XCEED platform — please do not reply.</span>`;

/**
 * Wrap inner HTML in the colorful iLEED email card.
 * @param {string} title      Heading shown at the top of the card body.
 * @param {string} accent     Banner / accent colour.
 * @param {string} bodyHtml   Inner HTML for the message body.
 * @param {string} [footerHtml] Replaces the default "do not reply" footer.
 */
function renderAlert({ title, accent = "#0e7490", bodyHtml, footerHtml }) {
  return `
<div style="background:#f4f6fb;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e4e8f5;overflow:hidden;">
    <div style="background:${accent};padding:22px 28px;">
      <div style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:.02em;">${title}</div>
      <div style="color:rgba(255,255,255,.85);font-size:12px;margin-top:4px;">${ILEED_MARK} — ${ILEED_FULL_FORM} · NIT Jalandhar</div>
    </div>
    <div style="padding:28px;">
      ${bodyHtml}
    </div>
    <div style="padding:14px 28px;border-top:1px solid #e4e8f5;background:#fafbfe;">
      ${footerHtml || DEFAULT_FOOTER}
    </div>
  </div>
</div>`;
}

/**
 * A tinted key/value card with an accent bar on the left.
 * @param {string} accent
 * @param {Array<[string, string]>} rows  [label, value] pairs.
 */
function infoCard(accent, rows) {
  const trs = rows
    .map(
      ([k, v]) => `
        <tr>
          <td style="padding:6px 16px 6px 0;color:#888;font-size:13px;white-space:nowrap;vertical-align:top;">${k}</td>
          <td style="padding:6px 0;font-size:14px;color:#1a1f3c;">${v}</td>
        </tr>`,
    )
    .join("");
  return `
      <div style="background:#f7f9fc;border:1px solid #e4e8f5;border-left:4px solid ${accent};border-radius:10px;padding:8px 18px;margin:0 0 16px;">
        <table style="border-collapse:collapse;width:100%;">${trs}</table>
      </div>`;
}

function serverDownTemplate(serviceName, details = "") {
  const body = `
      <p style="${P}">The <strong style="color:#dc2626;">${serviceName}</strong> service is currently unreachable.</p>
      ${infoCard(
        "#dc2626",
        [
          ...(details ? [["Details", details]] : []),
          ["Time", new Date().toLocaleString()],
        ],
      )}`;
  return renderAlert({
    title: `⚠️ ${serviceName} is Down`,
    accent: "#dc2626",
    bodyHtml: body,
  });
}

function serverRecoveredTemplate(serviceName) {
  const body = `
      <p style="${P}">The <strong style="color:#16a34a;">${serviceName}</strong> service is reachable again and has recovered.</p>
      ${infoCard("#16a34a", [["Time", new Date().toLocaleString()]])}`;
  return renderAlert({
    title: `✅ ${serviceName} is Back Up`,
    accent: "#16a34a",
    bodyHtml: body,
  });
}

function noReportSavedTemplate({ batch, subject, faculty, room, date, timeSlot }) {
  const body = `
      <p style="${P}">A scheduled class has no attendance report saved. The camera or recognition system may not have run for this session.</p>
      ${infoCard("#d97706", [
        ["Batch", `<strong>${batch}</strong>`],
        ["Subject", `<strong>${subject || "N/A"}</strong>`],
        ["Faculty", faculty || "N/A"],
        ["Room", room || "N/A"],
        ["Date", date],
        ["Time Slot", timeSlot],
      ])}
      <p style="${P}">No attendance report was generated for this scheduled session. Please verify the camera feed and system status.</p>`;
  return renderAlert({
    title: "⚠️ No Report Saved",
    accent: "#d97706",
    bodyHtml: body,
  });
}

function classBunkTemplate({ batch, subject, faculty, room, date, timeSlot, totalStudents }) {
  const body = `
      <p style="${P}">The attendance system ran for this session but <strong>no faces were detected and all students are marked absent</strong>. The entire class may have bunked.</p>
      ${infoCard("#dc2626", [
        ["Batch", `<strong>${batch}</strong>`],
        ["Subject", `<strong>${subject || "N/A"}</strong>`],
        ["Faculty", faculty || "N/A"],
        ["Room", room || "N/A"],
        ["Date", date],
        ["Time Slot", timeSlot],
        ["Total Students", `<strong>${totalStudents}</strong> — all absent`],
      ])}
      <p style="${P}">No student faces were recognised and no faces appeared in review. This indicates the class was not attended.</p>`;
  return renderAlert({
    title: "🚨 Class Bunked",
    accent: "#dc2626",
    bodyHtml: body,
  });
}

function lowConfidenceTemplate({ batch, rollNo, avgConfidence }) {
  const body = `
      <p style="${P}">A student's face match confidence is below the acceptable threshold.</p>
      ${infoCard("#d97706", [
        ["Batch", `<strong>${batch}</strong>`],
        ["Roll No", `<strong>${rollNo}</strong>`],
        ["Avg Confidence", `<strong>${(avgConfidence * 100).toFixed(0)}%</strong>`],
      ])}
      <p style="${P}">This student's ground truth photos may need to be re-captured.</p>`;
  return renderAlert({
    title: "⚠️ Low Confidence Face Detection",
    accent: "#d97706",
    bodyHtml: body,
  });
}

function duplicateAttendanceTemplate({ rollNo, date, sessions }) {
  const sessionList = sessions
    .map(
      (s) =>
        `<li style="margin:2px 0;">${s.batch} — ${s.timeSlot} — Room: ${s.room || "N/A"}</li>`,
    )
    .join("");
  const body = `
      <p style="${P}">A student has been marked present in multiple sessions at the same time.</p>
      ${infoCard("#d97706", [
        ["Roll No", `<strong>${rollNo}</strong>`],
        ["Date", date],
      ])}
      <p style="margin:0 0 6px;font-size:14px;color:#444;"><strong>Sessions:</strong></p>
      <ul style="margin:0 0 16px;padding-left:18px;font-size:14px;color:#444;line-height:1.7;">${sessionList}</ul>
      <p style="${P}">This may indicate a system error or attendance fraud — please investigate.</p>`;
  return renderAlert({
    title: "⚠️ Duplicate Attendance Detected",
    accent: "#d97706",
    bodyHtml: body,
  });
}

function dailySummaryTemplate({ dept, date, frequencyLabel, mode, threshold, rows }) {
  // Group by semester — one table per semester in the email body, rather
  // than a single table with a Batch column.
  const bySemester = {};
  for (const r of rows) {
    const sem = r.semester || "Unknown";
    if (!bySemester[sem]) bySemester[sem] = [];
    bySemester[sem].push(r);
  }
  const semesters = Object.keys(bySemester).sort((a, b) =>
    String(a).localeCompare(String(b), undefined, { numeric: true }),
  );

  const tablesHtml = semesters
    .map((sem) => {
      // Sorted by period so a subject taught multiple times in the range
      // reads as distinct chronological rows — never averaged together.
      const sortedRows = [...bySemester[sem]].sort((a, b) =>
        String(a.period || "").localeCompare(String(b.period || "")),
      );
      const rowsHtml = sortedRows
        .map(
          (r) => `
      <tr>
        <td style="${TD}">${r.subject || "N/A"}</td>
        <td style="${TD}">${r.faculty || "N/A"}</td>
        <td style="${TD}">${r.period || "N/A"}</td>
        <td style="${TD}">${r.room || "N/A"}</td>
        <td style="${TD}">${r.present}/${r.totalStudents}</td>
        <td style="${TD}"><strong>${r.attendancePct}%</strong></td>
      </tr>`,
        )
        .join("");

      return `
    <h4 style="margin:18px 0 6px;color:#0e7490;">Semester ${sem}</h4>
    <table style="${TABLE}">
      <thead>
        <tr>
          <th style="${TH}">Subject</th>
          <th style="${TH}">Faculty</th>
          <th style="${TH}">Period</th>
          <th style="${TH}">Room</th>
          <th style="${TH}">Present</th>
          <th style="${TH}">%</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
    })
    .join("");

  const introText =
    mode === "threshold"
      ? `The following classes in <strong>${dept}</strong> had attendance below <strong>${threshold}%</strong> for this ${frequencyLabel === "weekly" ? "week" : "day"}.`
      : `Attendance summary for all classes in <strong>${dept}</strong> for this ${frequencyLabel === "weekly" ? "week" : "day"}.`;

  const body = `
      <p style="${P}">${introText}</p>
      ${tablesHtml}
      <p style="margin:16px 0 0;color:#888;font-size:12px;">Report date: ${date}</p>`;
  return renderAlert({
    title: `📊 ${frequencyLabel === "weekly" ? "Weekly" : "Daily"} Attendance Summary — ${dept}`,
    accent: "#0e7490",
    bodyHtml: body,
  });
}

const STATUS_COLORS = {
  Completed: "#16a34a",
  Pending: "#d97706",
  "Not Started": "#dc2626",
};

function embeddingProgressTemplate({ dept, semesterGroups }) {
  const tablesHtml = semesterGroups
    .map(({ sem, rows }) => {
      const rowsHtml = rows
        .map((r) => {
          const color = STATUS_COLORS[r.status] || "#888";
          return `
      <tr>
        <td style="${TD}">${r.subject || "N/A"}</td>
        <td style="${TD}">${r.faculty || "N/A"}</td>
        <td style="${TD}">${r.submitted ?? "—"}</td>
        <td style="${TD}">${r.groundTruthReady ?? "—"}</td>
        <td style="${TD}">${r.missing ?? "—"}</td>
        <td style="${TD}"><strong style="color:${color};">${r.status}</strong></td>
      </tr>`;
        })
        .join("");

      return `
    <h4 style="margin:18px 0 6px;color:#0e7490;">Semester ${sem}</h4>
    <table style="${TABLE}">
      <thead>
        <tr>
          <th style="${TH}">Subject</th>
          <th style="${TH}">Faculty</th>
          <th style="${TH}">Submitted</th>
          <th style="${TH}">Ground Truth Ready</th>
          <th style="${TH}">Missing</th>
          <th style="${TH}">Status</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
    })
    .join("");

  const body = `
      <p style="${P}">Per-subject embedding status across all semesters in <strong>${dept}</strong>, as of this week. "Not Started" means no roll numbers have been submitted for that subject yet.</p>
      ${tablesHtml}`;
  return renderAlert({
    title: `📸 Weekly Embedding/Ground-Truth Progress — ${dept}`,
    accent: "#0e7490",
    bodyHtml: body,
  });
}

// Scheduled uptime digest (8:30 / 13:30 IST on working days) — one table
// covering every probed service, unlike serverDownTemplate which is a single
// transition alert for one service. `results` rows: { name, target, status
// ('up'|'down'|'not_configured'), error }.
function uptimeDigestTemplate({ checkedAt, results }) {
  const rowsHtml = results
    .map((r) => {
      const statusHtml =
        r.status === "up"
          ? '<strong style="color:#16a34a;">✅ Online</strong>'
          : r.status === "not_configured"
            ? '<span style="color:#888;">Not configured</span>'
            : '<strong style="color:#dc2626;">⚠️ DOWN</strong>';
      return `
      <tr>
        <td style="${TD}"><strong>${r.name}</strong></td>
        <td style="${TD}">${r.target || "—"}</td>
        <td style="${TD}">${statusHtml}</td>
        <td style="${TD}color:#888;">${r.error || ""}</td>
      </tr>`;
    })
    .join("");

  const body = `
      <p style="${P}">The twice-daily scheduled status check (8:30 AM / 1:30 PM on working days) found one or more services unreachable.</p>
      <table style="${TABLE}">
        <thead>
          <tr>
            <th style="${TH}">Service</th>
            <th style="${TH}">Target</th>
            <th style="${TH}">Status</th>
            <th style="${TH}">Details</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <p style="margin:0;font-size:14px;color:#444;"><strong>Checked at:</strong> ${checkedAt}</p>`;
  return renderAlert({
    title: "⚠️ Scheduled Status Check — Service(s) Down",
    accent: "#dc2626",
    bodyHtml: body,
  });
}

// ── End-of-class attendance summary, mailed to the faculty ──────────────────
// The only template addressed to someone outside the recipients list, so it
// leads with the class it is about and keeps the counts above the fold.
// Roll numbers arrive already sorted (see facultyAttendanceMailer) — this
// renders them, it does not order them.
//
// `presentRolls` / `absentRolls` are plain roll-number strings.
function facultyAttendanceSummaryTemplate({
  facultyName,
  subject,
  subjectCode,
  batch,
  semester,
  room,
  date,
  timeSlot,
  totalStudents,
  presentRolls = [],
  absentRolls = [],
  // Absent, but only because the system has no ground-truth photos for them —
  // they are not in the subject's embedding store, so the cameras cannot
  // recognise them and they can never be marked present. Counted as absent
  // (they are), but listed apart so the faculty can see the difference between
  // a student who skipped the class and one the system is unable to see.
  noGroundTruthRolls = [],
  // Recognised but below the auto-present threshold. The cron path never
  // produces these (it merges to P or A), so this section is usually absent —
  // it exists so a manual session's "review" students are never silently
  // reported to the faculty as one of the other two.
  reviewRolls = [],
  // Department coordinator, resolved from the department's admin user. Copied
  // on the message itself, so a Reply-All from the faculty reaches them.
  coordinatorEmail = "",
}) {
  const present = presentRolls.length;
  const noGt = noGroundTruthRolls.length;
  // The tile shows every absent student; the lists below split them by cause.
  const absent = absentRolls.length + noGt;
  const pct = totalStudents > 0 ? Math.round((present / totalStudents) * 100) : 0;

  // Three stat tiles side by side. A table (not flexbox) because Outlook
  // ignores display:flex entirely and would stack these as full-width blocks.
  const tile = (label, value, color, bg) => `
        <td width="33%" style="padding:4px;">
          <div style="background:${bg};border:1px solid ${color}33;border-radius:10px;padding:14px 10px;text-align:center;">
            <div style="font-size:28px;font-weight:700;color:${color};line-height:1.1;">${value}</div>
            <div style="font-size:11px;color:#5b6472;text-transform:uppercase;letter-spacing:.06em;margin-top:4px;">${label}</div>
          </div>
        </td>`;

  const statTiles = `
      <table style="border-collapse:collapse;width:100%;margin:0 0 20px;">
        <tr>
          ${tile("Total", totalStudents, "#0e7490", "#ecfeff")}
          ${tile("Present", present, "#16a34a", "#f0fdf4")}
          ${tile("Absent", absent, "#dc2626", "#fef2f2")}
        </tr>
      </table>`;

  // Roll numbers as wrapping chips — a 40-student list stays readable on a
  // phone, which a 40-row table does not.
  const chips = (rolls, color, bg) =>
    rolls.length === 0
      ? `<p style="margin:0 0 16px;font-size:13px;color:#888;font-style:italic;">None</p>`
      : `<p style="margin:0 0 16px;line-height:2.1;">${rolls
          .map(
            (r) =>
              `<span style="background:${bg};color:${color};border:1px solid ${color}33;border-radius:6px;padding:4px 9px;font-size:13px;font-weight:600;margin:0 6px 6px 0;white-space:nowrap;">${r}</span>`,
          )
          .join(" ")}</p>`;

  const body = `
      <p style="${P}">Dear <strong>${facultyName || "Faculty"}</strong>, here is the attendance recorded for your class.</p>
      ${infoCard("#0e7490", [
        ["Subject", `<strong>${subject || "N/A"}</strong>${subjectCode ? ` (${subjectCode})` : ""}`],
        ["Date", `<strong>${date}</strong>`],
        ["Period", `<strong>${timeSlot}</strong>`],
        ...(room ? [["Room", room]] : []),
        ...(batch ? [["Batch", batch]] : []),
        ...(semester ? [["Semester", semester]] : []),
      ])}
      ${statTiles}
      <div style="text-align:center;margin:0 0 22px;">
        <span style="font-size:13px;color:#5b6472;">Attendance</span>
        <span style="font-size:22px;font-weight:700;color:${pct >= 75 ? "#16a34a" : pct >= 50 ? "#d97706" : "#dc2626"};margin-left:8px;">${pct}%</span>
      </div>

      <h4 style="margin:0 0 8px;color:#16a34a;font-size:14px;">✅ Present — ${present} student${present === 1 ? "" : "s"}</h4>
      ${chips(presentRolls, "#15803d", "#f0fdf4")}

      <h4 style="margin:0 0 8px;color:#dc2626;font-size:14px;">❌ Absent — ${absentRolls.length} student${absentRolls.length === 1 ? "" : "s"}</h4>
      ${chips(absentRolls, "#b91c1c", "#fef2f2")}

      ${
        reviewRolls.length > 0
          ? `<h4 style="margin:0 0 8px;color:#d97706;font-size:14px;">🔍 Needs review — ${reviewRolls.length} student${reviewRolls.length === 1 ? "" : "s"}</h4>
      <p style="margin:0 0 10px;font-size:12px;color:#888;">Recognised, but below the confidence threshold for an automatic Present. Please confirm these manually.</p>
      ${chips(reviewRolls, "#b45309", "#fffbeb")}`
          : ""
      }

      ${
        noGt > 0
          ? `<div style="background:#fffbeb;border:1px solid #d9770633;border-left:4px solid #d97706;border-radius:10px;padding:16px 18px;margin:0 0 16px;">
        <h4 style="margin:0 0 6px;color:#b45309;font-size:14px;">⚠️ Marked absent — no photos on record (${noGt} student${noGt === 1 ? "" : "s"})</h4>
        <p style="margin:0 0 10px;font-size:13px;color:#5b6472;line-height:1.6;">
          The system has no ground-truth photographs for these students, so the classroom cameras
          <strong>cannot recognise them and they will be marked absent in every class</strong> until this is fixed.
          This is a records problem, not an attendance one.
        </p>
        ${chips(noGroundTruthRolls, "#b45309", "#fef3c7")}
        <p style="margin:0;font-size:13px;color:#b45309;line-height:1.6;">
          <strong>Please ask these students to contact the Department Faculty Coordinator</strong>
          to get their photographs registered.
        </p>
      </div>`
          : ""
      }

      <div style="background:#f7f9fc;border:1px solid #e4e8f5;border-left:4px solid #0e7490;border-radius:10px;padding:14px 18px;margin:20px 0 0;">
        <p style="margin:0 0 10px;font-size:13px;color:#1a1f3c;line-height:1.7;">
          <strong>If there is any problem with this attendance, simply reply to this email</strong>${
            coordinatorEmail
              ? ` — your reply reaches both the ${ILEED_MARK} team and the Department Coordinator (<a href="mailto:${coordinatorEmail}" style="color:#0e7490;">${coordinatorEmail}</a>), who is also copied on this message.`
              : `. Please also copy your Department Coordinator.`
          }
        </p>
        <p style="margin:0;font-size:13px;color:#0e7490;line-height:1.7;">
          Your feedback is crucial in improving the system — <strong>thank you in advance</strong>.
        </p>
      </div>
      <p style="margin:16px 0 0;font-size:12px;color:#888;line-height:1.6;">
        Attendance was captured automatically by the ${ILEED_MARK} classroom cameras.
        We are in the process of merging with the ERP once the system gets stabilised.
      </p>`;

  return renderAlert({
    title: `📋 Attendance — ${subject || "Class"} · ${timeSlot}`,
    accent: "#0e7490",
    bodyHtml: body,
    // No "do not reply" here — this message asks for exactly that.
    footerHtml: `<span style="font-size:11px;color:#999;">Sent by ${ILEED_MARK} — ${ILEED_FULL_FORM}, NIT Jalandhar. Replies to this message are read by the ${ILEED_MARK} team${
      coordinatorEmail ? ` and the Department Coordinator` : ""
    }.</span>`,
  });
}

module.exports = {
  facultyAttendanceSummaryTemplate,
  serverDownTemplate,
  serverRecoveredTemplate,
  noReportSavedTemplate,
  classBunkTemplate,
  lowConfidenceTemplate,
  duplicateAttendanceTemplate,
  dailySummaryTemplate,
  embeddingProgressTemplate,
  uptimeDigestTemplate,
};
