const {
  renderTimetableEmail,
  emailButton,
  emailSection,
} = require("./emailLayout");

/**
 * Body of the "your timetable changed" mail sent when a timetable is locked
 * with "inform the teachers" = yes.
 *
 * @param {string} faculty        Name used in the greeting.
 * @param {Object} changes        { addedSubjects, removedSubjects, updatedSubjects }
 * @param {string} timetableLink  Link to this faculty member's timetable.
 */
function generateChangeEmail(faculty, changes, timetableLink) {
  const listStyle =
    "margin:6px 0 0;padding-left:18px;font-size:14px;color:#444;line-height:1.7;";

  let bodyHtml = `
      <p style="margin:0 0 8px;font-size:14px;color:#444;line-height:1.6;">Dear ${faculty},</p>
      <p style="margin:0 0 20px;font-size:14px;color:#444;line-height:1.6;">
        This email is to notify you of updates to your teaching timetable.
        Please review the changes below:
      </p>`;

  /* 🟢 ADDED SUBJECTS */
  if (changes.addedSubjects.length > 0) {
    let inner = `<ul style="${listStyle}">`;
    changes.addedSubjects.forEach((s) => {
      inner += `<li><strong>${s.subject} (${s.sem})</strong><ul style="${listStyle}">`;
      s.entries.forEach((e) => {
        inner += `<li>${e.day}, ${e.slot} | Room: ${e.room}</li>`;
      });
      inner += `</ul></li>`;
    });
    inner += `</ul>`;
    bodyHtml += emailSection({
      heading: "🟢 New Subjects Assigned",
      bg: "#effaf3",
      border: "#c7ecd4",
      headingColor: "#16a34a",
      contentHtml: inner,
    });
  }

  /* 🔴 REMOVED SUBJECTS */
  if (changes.removedSubjects.length > 0) {
    let inner = `<ul style="${listStyle}">`;
    changes.removedSubjects.forEach((s) => {
      inner += `<li><strong>${s.subject} (${s.sem})</strong></li>`;
    });
    inner += `</ul>`;
    bodyHtml += emailSection({
      heading: "🔴 Subjects Removed",
      bg: "#fef2f2",
      border: "#f6cccc",
      headingColor: "#dc2626",
      contentHtml: inner,
    });
  }

  /* 🟡 UPDATED SUBJECTS */
  if (changes.updatedSubjects.length > 0) {
    let inner = `<ul style="${listStyle}">`;
    changes.updatedSubjects.forEach((u) => {
      inner += `<li><strong>${u.subject} (${u.sem})</strong><ul style="${listStyle}">`;
      if (u.changes.room) {
        inner += `<li>Room Changed: From ${u.changes.room.from.join(
          ", "
        )} to ${u.changes.room.to.join(", ")}</li>`;
      }
      if (u.changes.slots) {
        inner += `<li>Slot Changes:<ul style="${listStyle}">`;
        if (u.changes.slots.added.length > 0) {
          inner += `<li>Added: ${u.changes.slots.added.join(", ")}</li>`;
        }
        if (u.changes.slots.removed.length > 0) {
          inner += `<li>Removed: ${u.changes.slots.removed.join(", ")}</li>`;
        }
        inner += `</ul></li>`;
      }
      inner += `</ul></li>`;
    });
    inner += `</ul>`;
    bodyHtml += emailSection({
      heading: "🟡 Subject Updates",
      bg: "#fffbeb",
      border: "#f5e6b3",
      headingColor: "#d97706",
      contentHtml: inner,
    });
  }

  bodyHtml += emailButton(timetableLink, "View Updated Timetable");
  bodyHtml += `
      <p style="margin:0 0 16px;font-size:12px;color:#888;line-height:1.6;">
        This is an auto-generated email. If you have any questions, please contact
        the department timetable coordinator.
      </p>
      <p style="margin:0;font-size:14px;color:#444;line-height:1.6;">
        Regards,<br />
        <strong style="color:#0e7490;">Team XCEED</strong>
      </p>`;

  return renderTimetableEmail({
    title: "Timetable Update Notification",
    bodyHtml,
  });
}

/** Subject + body of the "timetable published" mail. */
function getTimetableEmailContent({
  facultyName,
  departmentName,
  sessionName,
  timetableUrl,
}) {
  const bodyHtml = `
      <p style="margin:0 0 8px;font-size:14px;color:#444;line-height:1.6;">Dear ${facultyName},</p>
      <p style="margin:0 0 16px;font-size:14px;color:#444;line-height:1.6;">
        We are pleased to inform you that the timetable for the
        <strong style="color:#0e7490;">${departmentName}</strong> department for the upcoming academic
        session <strong style="color:#0e7490;">${sessionName}</strong> has been published.
      </p>
      <div style="background:#f0f9ff;border:1px solid #cfe9f5;border-left:4px solid #0e7490;border-radius:10px;padding:14px 18px;margin:0 0 8px;">
        <p style="margin:0;font-size:14px;color:#444;line-height:1.6;">
          Your personalised timetable is now ready. Tap the button below to view it.
        </p>
      </div>
      ${emailButton(timetableUrl, "View Timetable")}
      <p style="margin:0 0 16px;font-size:12px;color:#888;line-height:1.6;">
        This is an auto-generated email. For any clarifications, kindly contact the
        timetable coordinator.
      </p>
      <p style="margin:0;font-size:14px;color:#444;line-height:1.6;">
        Regards,<br />
        <strong style="color:#0e7490;">Team XCEED</strong>
      </p>`;

  return {
    subject: "Timetable Published for the Upcoming Session",
    body: renderTimetableEmail({
      title: "Timetable Published",
      bodyHtml,
    }),
  };
}

module.exports = { generateChangeEmail, getTimetableEmailContent };
