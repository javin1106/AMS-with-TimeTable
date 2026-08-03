// Invitation mail. The regression these pin: the invite used to be gated on
// `settings.emailNotifications` — the "email the class when something is
// posted" preference — so a teacher who turned post digests off silently sent
// no invitations at all. An invitation is transactional, not a digest.
//
// The mailer is mocked throughout; nothing here touches SMTP.
const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const jwt = require("jsonwebtoken");

jest.mock("../../src/modules/mailerModule/mailer", () => ({ sendMail: jest.fn() }));
jest.mock("../../src/modules/mailsender", () => jest.fn());

const { connect, clearDatabase, disconnect } = require("../helpers/db");
const { sendMail } = require("../../src/modules/mailerModule/mailer");
const mailSender = require("../../src/modules/mailsender");

const User = require("../../src/models/usermanagement/user");
const LmClass = require("../../src/modules/learningModule/models/lmClass");
const LmMembership = require("../../src/modules/learningModule/models/lmMembership");

const BASE = "/api/v1/learningmodule";

let app;

function buildApp() {
  const application = express();
  application.use(express.json());
  application.use(cookieParser());
  application.use(BASE, require("../../src/modules/learningModule/routes/index"));
  return application;
}

async function seedTeacher() {
  const user = await User.create({
    name: "Prof. Rao",
    role: ["FACULTY"],
    password: "hashed",
    dept: "Electronics and Communication Engineering",
    email: ["rao@example.com"],
  });
  const token = jwt.sign({ id: user.id, role: ["FACULTY"] }, process.env.JWT_SECRET);
  return { user, cookie: [`jwt=${token}`] };
}

async function seedClass(user, settings = {}) {
  const klass = await LmClass.create({
    name: "Digital Signal Processing",
    section: "EC-5A",
    code: `c${Math.random().toString(36).slice(2, 8)}`,
    ownerId: user._id,
    coverColor: "#1967d2",
    settings,
  });
  await LmMembership.create({
    classId: klass._id,
    userId: user._id,
    role: "teacher",
    status: "active",
  });
  return klass;
}

const invite = (klass, cookie, body) =>
  request(app)
    .post(`${BASE}/classes/${klass._id}/members/invite`)
    .set("Cookie", cookie)
    .send(body);

beforeAll(async () => {
  await connect();
  app = buildApp();
});
beforeEach(() => {
  sendMail.mockReset().mockResolvedValue({ messageId: "ok" });
  mailSender.mockReset().mockResolvedValue({ messageId: "ok" });
});
afterEach(clearDatabase);
afterAll(disconnect);

describe("POST /classes/:classId/members/invite — invitation mail", () => {
  it("mails an existing account even when class post-notification email is off", async () => {
    const { user, cookie } = await seedTeacher();
    const klass = await seedClass(user, { emailNotifications: false });
    await User.create({
      name: "Asha",
      role: ["STUDENT"],
      password: "hashed",
      email: ["asha@example.com"],
    });

    const res = await invite(klass, cookie, { emails: ["asha@example.com"], role: "student" });

    expect(res.status).toBe(201);
    expect(res.body.results[0]).toMatchObject({ status: "added", mailed: true });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0]).toBe("asha@example.com");
  });

  it("uses the platform mail frame and an absolute class link", async () => {
    const { user, cookie } = await seedTeacher();
    const klass = await seedClass(user);
    await User.create({
      name: "Asha",
      role: ["STUDENT"],
      password: "hashed",
      email: ["asha@example.com"],
    });

    await invite(klass, cookie, { emails: ["asha@example.com"], role: "student" });

    const [, subject, html] = sendMail.mock.calls[0];
    expect(subject).toBe(`You have been added to ${klass.name} — XCEED NITJ`);
    expect(html).toContain("Welcome to XCEED Learning!");
    expect(html).toContain("#0e7490");
    expect(html).toContain("Dear User,");
    // Absolute, or the mail client cannot follow it.
    expect(html).toMatch(new RegExp(`href="https?://[^"]+/learning/class/${klass._id}"`));
  });

  // The class code is a fallback for people who cannot be auto-enrolled. Anyone
  // already sitting on the roster has nothing to join, so showing them a code
  // only invites "do I need to enter this?".
  it("omits the class code for someone enrolled as active straight away", async () => {
    const { user, cookie } = await seedTeacher();
    const klass = await seedClass(user);
    await User.create({
      name: "Asha",
      role: ["STUDENT"],
      password: "hashed",
      email: ["asha@example.com"],
    });

    const res = await invite(klass, cookie, { emails: ["asha@example.com"], role: "student" });

    expect(res.body.results[0].status).toBe("added");
    const html = sendMail.mock.calls[0][2];
    expect(html).not.toContain(klass.code);
    expect(html).not.toMatch(/join it manually|class code/i);
    // …but the deep link to the class is still there.
    expect(html).toContain("Open the class");
  });

  it("keeps the class code when the invite is waiting on an unregistered address", async () => {
    const { user, cookie } = await seedTeacher();
    const klass = await seedClass(user);

    const res = await invite(klass, cookie, {
      emails: ["nobody@example.com"],
      role: "student",
      createAccounts: false,
    });

    expect(res.body.results[0].status).toBe("invited");
    const html = sendMail.mock.calls[0][2];
    // claimInvites matches on email, so this only helps if they register under
    // a different address — which is exactly what the copy now says.
    expect(html).toContain(klass.code);
    expect(html).toMatch(/different address/i);
  });

  it("escapes user-supplied class and inviter text", async () => {
    const { user, cookie } = await seedTeacher();
    user.name = 'Prof <script>alert("x")</script>';
    await user.save();
    const klass = await seedClass(user);
    klass.name = "DSP & <b>Filters</b>";
    await klass.save();
    await User.create({
      name: "Asha",
      role: ["STUDENT"],
      password: "hashed",
      email: ["asha@example.com"],
    });

    await invite(klass, cookie, { emails: ["asha@example.com"], role: "student" });

    const html = sendMail.mock.calls[0][2];
    expect(html).not.toContain("<script>");
    expect(html).toContain("DSP &amp; &lt;b&gt;Filters&lt;/b&gt;");
  });

  it("sends only the welcome mail for a freshly provisioned account", async () => {
    const { user, cookie } = await seedTeacher();
    const klass = await seedClass(user);

    const res = await invite(klass, cookie, {
      emails: ["newcomer@example.com"],
      role: "student",
      createAccounts: true,
    });

    expect(res.body.results[0]).toMatchObject({ status: "account_created", mailed: true });
    // The welcome mail carries the set-password link (the other mailSender call
    // is the admin's "user created" notice).
    const welcome = mailSender.mock.calls.filter((call) => call[0] === "newcomer@example.com");
    expect(welcome).toHaveLength(1);
    expect(welcome[0][2]).toContain(klass.name);
    expect(sendMail).not.toHaveBeenCalled(); // no duplicate invite mail
  });

  // The welcome mail is the only thing carrying the set-password link, so an
  // account whose welcome mail never left is an account nobody can sign in to.
  // Reporting `account_created` on its own would read as complete success.
  it("reports a failed welcome mail for a provisioned account", async () => {
    const { user, cookie } = await seedTeacher();
    const klass = await seedClass(user);
    // mailSender swallows its own failures and resolves undefined.
    mailSender.mockResolvedValue(undefined);

    const res = await invite(klass, cookie, {
      emails: ["newcomer@example.com"],
      role: "student",
      createAccounts: true,
    });

    expect(res.body.results[0]).toMatchObject({ status: "account_created", mailed: false });
    // The account and the enrolment still stand — only the mail failed.
    const membership = await LmMembership.findOne({ classId: klass._id, email: "newcomer@example.com" });
    expect(membership.status).toBe("active");
  });

  it("still mails an address with no account when account creation is off", async () => {
    const { user, cookie } = await seedTeacher();
    const klass = await seedClass(user);

    const res = await invite(klass, cookie, {
      emails: ["newcomer@example.com"],
      role: "student",
      createAccounts: false,
    });

    expect(res.body.results[0]).toMatchObject({ status: "invited", mailed: true });
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("reports a delivery failure instead of a clean success, and still enrols", async () => {
    const { user, cookie } = await seedTeacher();
    const klass = await seedClass(user);
    await User.create({
      name: "Asha",
      role: ["STUDENT"],
      password: "hashed",
      email: ["asha@example.com"],
    });
    sendMail.mockRejectedValue(new Error("smtp down"));

    const res = await invite(klass, cookie, { emails: ["asha@example.com"], role: "student" });

    expect(res.status).toBe(201);
    expect(res.body.results[0]).toMatchObject({ status: "added", mailed: false });
    const membership = await LmMembership.findOne({ classId: klass._id, email: "asha@example.com" });
    expect(membership.status).toBe("active");
  });
});
