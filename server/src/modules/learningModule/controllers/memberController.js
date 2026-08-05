const LmClass = require("../models/lmClass");
const LmMembership = require("../models/lmMembership");
const LmSubmission = require("../models/lmSubmission");
const User = require("../../../models/usermanagement/user");
const { notifyUser, sendInviteMail } = require("../services/notifyService");
const { provisionAccounts, roleForClassRole, sendWelcomeMailFor } = require("../services/accountProvisioning");
const { resolveFrontendBase } = require("../../usermanagement/controllers/welcomeMailer");
const { createBatch, recordResult, getBatch } = require("../services/inviteBatches");

// A few authenticated connections carry the whole invite, same reasoning as
// mailerModule's sendBulkMail: wide enough that a class of sixty does not
// wait in a strict queue, narrow enough not to trip the provider's flood
// protection.
const MAX_PARALLEL_MAIL = 4;

const refreshStudentCount = async (classId) => {
  const studentCount = await LmMembership.countDocuments({
    classId,
    role: "student",
    status: "active",
  });
  await LmClass.updateOne({ _id: classId }, { $set: { "stats.studentCount": studentCount } });
  return studentCount;
};

/** Join by code. Honours the class's approval setting. */
exports.joinByCode = async (req, res) => {
  const code = String(req.body.code || "").trim().toLowerCase();
  if (!code) return res.status(400).json({ message: "A class code is required." });

  const klass = await LmClass.findOne({ code });
  if (!klass) return res.status(404).json({ message: "No class matches that code." });
  if (klass.status === "archived") {
    return res.status(400).json({ message: "That class has been archived." });
  }
  if (!klass.settings.allowJoinByCode) {
    return res.status(403).json({ message: "This class is not accepting new members by code." });
  }

  const existing = await LmMembership.findOne({ classId: klass._id, userId: req.lmUser.id });
  if (existing && existing.status === "active") {
    return res.status(200).json({ classId: klass._id, status: "active", alreadyMember: true });
  }
  if (existing && existing.status === "pending") {
    return res.status(200).json({ classId: klass._id, status: "pending", alreadyMember: false });
  }

  const status = klass.settings.requireApproval ? "pending" : "active";

  if (existing) {
    // Re-joining after removal, or claiming an emailed invite.
    existing.status = existing.status === "invited" ? "active" : status;
    existing.removedAt = null;
    existing.joinedAt = new Date();
    existing.name = existing.name || req.lmUser.name;
    existing.email = existing.email || req.lmUser.email;
    await existing.save();
  } else {
    await LmMembership.create({
      classId: klass._id,
      userId: req.lmUser.id,
      email: req.lmUser.email,
      name: req.lmUser.name,
      role: "student",
      status,
    });
  }

  if (status === "pending") {
    await notifyUser({
      userId: klass.ownerId,
      klass,
      type: "join_request",
      title: "New join request",
      body: `${req.lmUser.name} asked to join ${klass.name}.`,
      link: `/learning/class/${klass._id}/people`,
      actorName: req.lmUser.name,
    });
  } else {
    await refreshStudentCount(klass._id);
  }

  return res.status(201).json({ classId: klass._id, status, className: klass.name });
};

/** Preview a class from its code before committing to join. */
exports.previewByCode = async (req, res) => {
  const code = String(req.params.code || "").trim().toLowerCase();
  const klass = await LmClass.findOne({ code })
    .select("name section subject ownerName coverColor status settings.allowJoinByCode")
    .lean();
  if (!klass) return res.status(404).json({ message: "No class matches that code." });
  return res.json(klass);
};

/**
 * A student's view of another member.
 *
 * A roster is a list of names, not a contact export. Handing a student the full
 * membership row gave them every classmate's email address — a class of two
 * hundred is two hundred addresses to anyone enrolled — plus `invitedBy`,
 * `lastSeenAt` and `muted`, which are staff bookkeeping and nobody else's
 * business. Their own row keeps its email, since that is their own.
 */
const memberForStudent = (member, viewerId) => ({
  _id: member._id,
  userId: member.userId,
  name: member.name,
  role: member.role,
  status: member.status,
  rollNumber: member.rollNumber,
  email: String(member.userId) === String(viewerId) ? member.email : undefined,
});

exports.listMembers = async (req, res) => {
  const members = await LmMembership.find({
    classId: req.lmClass._id,
    status: { $ne: "removed" },
  })
    .sort({ role: 1, name: 1 })
    .lean();

  // Students see a roster; they must not see pending requests or invites.
  const visible = req.lmIsTeacher
    ? members
    : members
        .filter((m) => m.status === "active")
        .map((m) => memberForStudent(m, req.lmUser.id));

  return res.json({
    teachers: visible.filter((m) => m.role === "teacher" || m.role === "co-teacher"),
    students: visible.filter((m) => m.role === "student"),
  });
};

exports.memberForStudent = memberForStudent;

/**
 * Teacher-side add by email.
 *
 * Three outcomes per address, depending on `createAccounts`:
 *  - the address already has a platform account  → enrolled immediately
 *  - no account, createAccounts on               → an account is provisioned
 *      with the matching platform role (STUDENT / FACULTY) and the person is
 *      enrolled straight away; they set their own password from the email
 *  - no account, createAccounts off              → an "invited" row is stored
 *      and claimed on their first sign-in (see claimInvites)
 */
exports.inviteMembers = async (req, res) => {
  const role = req.body.role === "co-teacher" ? "co-teacher" : "student";
  const emails = (Array.isArray(req.body.emails) ? req.body.emails : String(req.body.emails || "").split(/[\s,;]+/))
    .map((e) => String(e || "").trim().toLowerCase())
    .filter(Boolean);

  if (!emails.length) return res.status(400).json({ message: "At least one email is required." });
  if (emails.length > 500) return res.status(400).json({ message: "Invite at most 500 people at a time." });

  const createAccounts = req.body.createAccounts !== false;
  const grantRoleToExisting = Boolean(req.body.grantRoleToExisting);

  const users = await User.find({ email: { $in: emails } }).select("name email").lean();
  const userByEmail = new Map();
  users.forEach((u) => {
    (Array.isArray(u.email) ? u.email : [u.email]).forEach((e) => {
      if (e) userByEmail.set(String(e).toLowerCase(), u);
    });
  });

  // Shared by the provisioning welcome mail and the invite mail, so both link
  // back to the origin the teacher is actually using.
  const frontendBase = resolveFrontendBase(req);

  // Provision in one batch before the enrolment loop, so a newly created
  // account is enrolled as "active" rather than left as a pending invite.
  let provisioned = new Map();
  if (createAccounts) {
    provisioned = await provisionAccounts({
      emails,
      classRole: role,
      klass: req.lmClass,
      invitedByName: req.lmUser.name,
      frontendBase,
      grantRoleToExisting,
    });
    provisioned.forEach((result, email) => {
      if (result.user) userByEmail.set(email, result.user);
    });
  }

  const results = [];
  // Every entry that owes a mail send is queued here instead of sent inline —
  // see the comment above the loop this replaced. The membership rows and
  // in-app notifications below are all that has to be true before the
  // teacher's "invite" click can return; the mail is reported through
  // /members/invite-status/:batchId as it actually goes out.
  const pendingMail = [];

  for (const email of emails) {
    const user = userByEmail.get(email);
    const provisionResult = provisioned.get(email);

    if (provisionResult?.error && !user) {
      results.push({ email, status: "error", message: provisionResult.error });
      continue;
    }
    const query = user
      ? { classId: req.lmClass._id, userId: user._id }
      : { classId: req.lmClass._id, email, userId: null };

    // eslint-disable-next-line no-await-in-loop
    const existing = await LmMembership.findOne(query);
    if (existing && existing.status === "active") {
      results.push({ email, status: "already_member" });
      continue;
    }

    const payload = {
      classId: req.lmClass._id,
      userId: user?._id || null,
      email,
      name: user?.name || "",
      role,
      status: user ? "active" : "invited",
      invitedBy: req.lmUser.id,
      joinedAt: new Date(),
      removedAt: null,
    };

    if (existing) {
      Object.assign(existing, payload);
      // eslint-disable-next-line no-await-in-loop
      await existing.save();
    } else {
      // eslint-disable-next-line no-await-in-loop
      await LmMembership.create(payload);
    }

    if (user) {
      // eslint-disable-next-line no-await-in-loop
      await notifyUser({
        userId: user._id,
        klass: req.lmClass,
        type: "invite",
        title: `Added to ${req.lmClass.name}`,
        body: `${req.lmUser.name} added you to ${req.lmClass.name}.`,
        link: `/learning/class/${req.lmClass._id}`,
        actorName: req.lmUser.name,
      });
    }

    const entry = {
      email,
      status: provisionResult?.created ? "account_created" : user ? "added" : "invited",
      platformRole: provisionResult?.created || provisionResult?.roleAdded ? roleForClassRole(role) : null,
      roleAdded: Boolean(provisionResult?.roleAdded && !provisionResult?.created),
      // Filled in once the background send for this address finishes — see
      // /members/invite-status/:batchId.
      mailed: null,
    };
    results.push(entry);

    // A freshly provisioned account gets the welcome mail, which names the
    // class and carries the set-password link — a second "you were invited"
    // mail on top of it is just noise.
    //
    // Deliberately *not* gated on settings.emailNotifications: that setting is
    // "email the class when something is posted", and a teacher who turns off
    // post digests has not asked for their invitations to go out silently.
    // Sending the invite is an explicit, one-off action they just took.
    pendingMail.push({
      email,
      // `user` truthy means the row above was written as "active", so the
      // invite mail drops the class code — there is nothing left to join.
      enrolled: Boolean(user),
      kind: provisionResult?.created ? "welcome" : "invite",
    });
  }

  await refreshStudentCount(req.lmClass._id);

  const batchId = pendingMail.length ? createBatch(req.lmClass._id, pendingMail.length) : null;
  if (batchId) {
    sendPendingInviteMail({
      batchId,
      pendingMail,
      klass: req.lmClass,
      inviterName: req.lmUser.name,
      frontendBase,
      platformRole: roleForClassRole(role),
    }).catch((error) => console.error("[LearningModule] invite mail batch failed:", error.message));
  }

  return res.status(201).json({ results, batchId, mailPending: pendingMail.length });
};

/**
 * Sends every mail a just-finished invite owes, a few connections wide, and
 * records each outcome on the batch as it lands. Never awaited by the route —
 * this is exactly the work that used to hold the response open.
 */
async function sendPendingInviteMail({ batchId, pendingMail, klass, inviterName, frontendBase, platformRole }) {
  const queue = [...pendingMail];

  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();
      // eslint-disable-next-line no-await-in-loop
      const mailed =
        item.kind === "welcome"
          ? await sendWelcomeMailFor({ email: item.email, klass, invitedByName: inviterName, frontendBase, platformRole })
          : await sendInviteMail(item.email, klass, inviterName, frontendBase, item.enrolled);

      recordResult(batchId, { email: item.email, mailed });
    }
  };

  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_MAIL, queue.length) }, () => worker()));
}

/**
 * Polled by the invite modal while a batch's mail is still going out — see
 * lmApi.inviteStatus. `batchId` is opaque and short-lived (in-memory,
 * ~15 minutes), so an unknown or expired one is reported as already done
 * rather than a 404 the UI would have to special-case.
 */
exports.inviteStatus = async (req, res) => {
  const batch = getBatch(req.params.batchId);
  if (!batch || batch.classId !== String(req.lmClass._id)) {
    return res.json({ total: 0, completed: 0, done: true, updates: [] });
  }
  return res.json({
    total: batch.total,
    completed: batch.updates.length,
    done: batch.done,
    updates: batch.updates,
  });
};

/** Approve or decline a pending join request. */
exports.decideJoinRequest = async (req, res) => {
  const membership = await LmMembership.findOne({
    _id: req.params.membershipId,
    classId: req.lmClass._id,
  });
  if (!membership) return res.status(404).json({ message: "Request not found." });
  if (membership.status !== "pending") {
    return res.status(400).json({ message: "That request has already been handled." });
  }

  const approve = req.body.approve !== false;
  membership.status = approve ? "active" : "removed";
  membership.removedAt = approve ? null : new Date();
  await membership.save();
  await refreshStudentCount(req.lmClass._id);

  await notifyUser({
    userId: membership.userId,
    klass: req.lmClass,
    type: "invite",
    title: approve ? `You joined ${req.lmClass.name}` : `Join request declined`,
    body: approve
      ? `Your request to join ${req.lmClass.name} was approved.`
      : `Your request to join ${req.lmClass.name} was declined.`,
    link: approve ? `/learning/class/${req.lmClass._id}` : "/learning",
    actorName: req.lmUser.name,
  });

  return res.json({ status: membership.status });
};

exports.updateMember = async (req, res) => {
  const membership = await LmMembership.findOne({
    _id: req.params.membershipId,
    classId: req.lmClass._id,
  });
  if (!membership) return res.status(404).json({ message: "Member not found." });

  // The owner's own teacher row must stay a teacher row, or the class becomes
  // unmanageable.
  if (String(membership.userId) === String(req.lmClass.ownerId) && req.body.role) {
    return res.status(400).json({ message: "The class owner's role cannot be changed." });
  }

  if (req.body.role && ["teacher", "co-teacher", "student"].includes(req.body.role)) {
    membership.role = req.body.role === "teacher" ? "co-teacher" : req.body.role;
  }
  if (req.body.muted !== undefined) membership.muted = Boolean(req.body.muted);
  if (req.body.rollNumber !== undefined) membership.rollNumber = String(req.body.rollNumber);

  await membership.save();
  await refreshStudentCount(req.lmClass._id);
  return res.json(membership);
};

exports.removeMember = async (req, res) => {
  const membership = await LmMembership.findOne({
    _id: req.params.membershipId,
    classId: req.lmClass._id,
  });
  if (!membership) return res.status(404).json({ message: "Member not found." });
  if (String(membership.userId) === String(req.lmClass.ownerId)) {
    return res.status(400).json({ message: "The class owner cannot be removed." });
  }

  membership.status = "removed";
  membership.removedAt = new Date();
  await membership.save();
  await refreshStudentCount(req.lmClass._id);
  return res.json({ removed: true });
};

/** A student leaving of their own accord. */
exports.leaveClass = async (req, res) => {
  if (String(req.lmClass.ownerId) === req.lmUser.id) {
    return res.status(400).json({ message: "Transfer ownership before leaving your own class." });
  }
  await LmMembership.updateOne(
    { classId: req.lmClass._id, userId: req.lmUser.id },
    { $set: { status: "removed", removedAt: new Date() } },
  );
  await refreshStudentCount(req.lmClass._id);
  return res.json({ left: true });
};

exports.transferOwnership = async (req, res) => {
  const target = await LmMembership.findOne({
    _id: req.params.membershipId,
    classId: req.lmClass._id,
    status: "active",
  });
  if (!target) return res.status(404).json({ message: "Member not found." });

  const previousOwnerId = req.lmClass.ownerId;
  req.lmClass.ownerId = target.userId;
  req.lmClass.ownerName = target.name;
  req.lmClass.ownerEmail = target.email;
  await req.lmClass.save();

  target.role = "teacher";
  await target.save();
  await LmMembership.updateOne(
    { classId: req.lmClass._id, userId: previousOwnerId },
    { $set: { role: "co-teacher" } },
  );

  return res.json({ ownerId: target.userId, ownerName: target.name });
};

/**
 * Claims every email-only invite waiting for the caller. Called by the client
 * when the Learning dashboard loads, so an invited student who had no account
 * at invite time is enrolled the moment they first sign in.
 */
exports.claimInvites = async (req, res) => {
  const emails = req.lmUser.emails || [];
  if (!emails.length) return res.json({ claimed: 0 });

  const pending = await LmMembership.find({
    userId: null,
    email: { $in: emails },
    status: "invited",
  });

  let claimed = 0;
  for (const membership of pending) {
    // A row may already exist for this user in the same class if they joined
    // by code before the invite landed — drop the duplicate instead of
    // tripping the unique index.
    // eslint-disable-next-line no-await-in-loop
    const clash = await LmMembership.findOne({
      classId: membership.classId,
      userId: req.lmUser.id,
    });
    if (clash) {
      // eslint-disable-next-line no-await-in-loop
      await LmMembership.deleteOne({ _id: membership._id });
      continue;
    }
    membership.userId = req.lmUser.id;
    membership.name = membership.name || req.lmUser.name;
    membership.status = "active";
    membership.joinedAt = new Date();
    // eslint-disable-next-line no-await-in-loop
    await membership.save();
    // eslint-disable-next-line no-await-in-loop
    await refreshStudentCount(membership.classId);
    claimed += 1;
  }

  return res.json({ claimed });
};

/** Per-student roll-up used by the People page and the teacher's student view. */
exports.getMemberProgress = async (req, res) => {
  const membership = await LmMembership.findOne({
    _id: req.params.membershipId,
    classId: req.lmClass._id,
  }).lean();
  if (!membership) return res.status(404).json({ message: "Member not found." });

  const submissions = await LmSubmission.find({
    classId: req.lmClass._id,
    studentId: membership.userId,
  })
    .populate("courseworkId", "title points dueDate workType")
    .lean();

  const graded = submissions.filter((s) => s.grade !== null && s.grade !== undefined);
  const earned = graded.reduce((sum, s) => sum + (s.grade || 0), 0);
  const possible = graded.reduce((sum, s) => sum + (s.maxPoints || 0), 0);

  return res.json({
    member: membership,
    submissions,
    summary: {
      turnedIn: submissions.filter((s) => s.state === "turned_in" || s.state === "returned").length,
      late: submissions.filter((s) => s.late).length,
      graded: graded.length,
      earned,
      possible,
      percent: possible ? Math.round((earned / possible) * 1000) / 10 : null,
    },
  });
};

exports.refreshStudentCount = refreshStudentCount;
