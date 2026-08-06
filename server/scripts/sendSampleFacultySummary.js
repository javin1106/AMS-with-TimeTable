/**
 * Send (and/or preview) one sample faculty attendance summary email.
 *
 *   node scripts/sendSampleFacultySummary.js --to=someone@example.com
 *   node scripts/sendSampleFacultySummary.js --to=x@y.com --report=<reportId>
 *   node scripts/sendSampleFacultySummary.js --preview-only
 *
 * With no --report it uses representative sample data and needs no database —
 * useful for checking the layout when Mongo is not reachable. With --report it
 * connects to Mongo and renders that real report (still without marking the
 * period as mailed).
 *
 * Always writes the rendered HTML to scripts/out/faculty-summary-sample.html so
 * the email can be opened in a browser even if SMTP is blocked.
 *
 * --to            recipient (default: none — preview only)
 * --cc            also CC this address, to see the CC header a live send sets
 *                 (a sample never CCs a real coordinator by itself)
 * --coordinator   coordinator address shown in the body (default: placeholder)
 * --report        an AttendanceReport _id to render instead of the sample
 * --preview-only  render the file, never send
 */
require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");

const templates = require("../src/modules/attendanceModule/controllers/emailTemplates");
const { sendMailWithRetry } = require("../src/modules/mailerModule/transport");

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : null;
};
const flag = (name) => process.argv.includes(`--${name}`);

// A class that exercises every section: present, plainly absent, and absent
// only because the system has no photographs of them.
const SAMPLE = {
  facultyName: "Dr. A. Sharma",
  subject: "FPGA(DE/GE)",
  subjectCode: "ECDE0353",
  batch: "BTECH_ELECTRONICS_AND_COMMUNICATION_ENGINEERING_2023",
  semester: "B.Tech-ECE-5",
  room: "LT103",
  date: "2026-08-06",
  timeSlot: "period3",
  totalStudents: 14,
  presentRolls: [
    "21103001", "21103002", "21103004", "21103005", "21103007",
    "21103008", "21103010", "21103011", "21103013",
  ],
  absentRolls: ["21103003", "21103006", "21103012", "21103014"],
  noGroundTruthRolls: ["21103009"],
  // In a real send this is resolved from the department's admin user and the
  // message is actually CC'd to them; a sample only shows the address.
  coordinatorEmail: "ece.coordinator@nitj.ac.in",
};

async function loadReportData(reportId) {
  const mongoose = require("mongoose");
  if (!process.env.MONGO_URL) throw new Error("MONGO_URL is not set");
  await mongoose.connect(process.env.MONGO_URL);
  try {
    const AttendanceReport = require("../src/models/attendanceReport");
    const {
      buildSummaryData,
    } = require("../src/modules/attendanceModule/controllers/facultyAttendanceMailer");
    const report = await AttendanceReport.findById(reportId);
    if (!report) throw new Error(`no AttendanceReport with _id ${reportId}`);
    return await buildSummaryData(report);
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

async function main() {
  const to = arg("to");
  const reportId = arg("report");
  const previewOnly = flag("preview-only");

  const data = reportId ? await loadReportData(reportId) : SAMPLE;
  const coordinatorOverride = arg("coordinator");
  if (coordinatorOverride) data.coordinatorEmail = coordinatorOverride;
  if (reportId) console.log(`Rendering real report ${reportId}`);
  else console.log("Rendering built-in sample data (no database needed)");

  const html = templates.facultyAttendanceSummaryTemplate(data);
  const absentTotal = data.absentRolls.length + data.noGroundTruthRolls.length;
  const subject =
    `Attendance — ${data.subject} · ${data.date} · ${data.timeSlot}` +
    ` — P:${data.presentRolls.length} A:${absentTotal}`;

  const outDir = path.join(__dirname, "out");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "faculty-summary-sample.html");
  fs.writeFileSync(outFile, html);
  console.log(`Preview written to ${outFile}`);
  console.log(`Subject line: ${subject}`);

  if (previewOnly || !to) {
    console.log(previewOnly ? "--preview-only: not sending." : "No --to given: not sending.");
    return;
  }

  // Two samples with the same subject and near-identical bodies get threaded by
  // Gmail, which then collapses the repeated part behind "..." — it reads as if
  // most of the email had been deleted. A per-send marker keeps each sample its
  // own conversation. Real sends never collide like this (different class,
  // date and period every time), so they carry no marker.
  const marker = new Date().toLocaleTimeString("en-GB", { hour12: false });
  const sampleSubject = `[Sample ${marker}] ${subject}`;

  console.log(`Sending to ${to} via ${process.env.MAIL_HOST}:${process.env.MAIL_PORT}…`);
  // A sample never CCs a resolved coordinator on its own — that would mail a
  // real person about a class that is not theirs. Pass --cc= to demonstrate the
  // CC header with an address you control.
  const cc = arg("cc");
  // Replies go to the system mailbox AND the coordinator, exactly as a live
  // send does.
  const replyTo = [process.env.MAIL_USER, data.coordinatorEmail]
    .map((e) => String(e || "").trim())
    .filter(Boolean)
    .join(", ");

  const info = await sendMailWithRetry({
    from: `XCEED NITJ <${process.env.MAIL_USER}>`,
    to,
    ...(cc ? { cc } : {}),
    ...(replyTo ? { replyTo } : {}),
    subject: sampleSubject,
    html,
  });
  console.log("Reply-To:", replyTo);
  if (cc) console.log("Cc:", cc);
  console.log("Sent:", info.messageId || "(no message id)");
  console.log("Accepted:", info.accepted, "Rejected:", info.rejected);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nFailed:", err.message);
    process.exit(1);
  });
