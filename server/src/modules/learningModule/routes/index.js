const express = require("express");

const {
  authenticate,
  authenticateOptional,
  requireClassCreator,
  loadClass,
  requireTeacher,
  requireClassStudent,
  requireOwner,
  asyncRoute,
} = require("../middleware/lmAuth");

const classController = require("../controllers/classController");
const memberController = require("../controllers/memberController");
const streamController = require("../controllers/streamController");
const commentController = require("../controllers/commentController");
const feedbackController = require("../controllers/feedbackController");
const courseworkController = require("../controllers/courseworkController");
const submissionController = require("../controllers/submissionController");
const quizController = require("../controllers/quizController");
const shortsController = require("../controllers/shortsController");
const tutorialController = require("../controllers/tutorialController");
const notebookController = require("../controllers/notebookController");
const audioStudioController = require("../controllers/audioStudioController");
const notificationController = require("../controllers/notificationController");
const dashboardController = require("../controllers/dashboardController");
const uploadController = require("../controllers/uploadController");
const timetableOptionsController = require("../controllers/timetableOptionsController");
const leaderboardController = require("../controllers/leaderboardController");
const discussionController = require("../controllers/discussionController");
const bugReportController = require("../controllers/bugReportController");
const profileController = require("../controllers/profileController");
const adminController = require("../controllers/adminController");

const router = express.Router();

// Shorts — the live participant side. These sit outside classRouter on purpose:
// somebody joining from a phone has a six-digit code and nothing else, so there
// is no classId to put in the path.
//
// They are also the module's only routes registered *above* the blanket
// `authenticate` below, and they take the optional variant instead. Whether a
// sign-in is required is a per-deck setting the teacher controls, and it cannot
// be known until the join code has been resolved to a short — so the check
// belongs in the controller, not in front of it.
router.post("/shorts/join/:code", authenticateOptional, asyncRoute(shortsController.joinByCode));
router.get("/shorts/live/:sessionId", authenticateOptional, asyncRoute(shortsController.getParticipantState));
router.get("/shorts/live/:sessionId/stream", authenticateOptional, asyncRoute(shortsController.streamParticipant));
router.post("/shorts/live/:sessionId/answer", authenticateOptional, asyncRoute(shortsController.submitResponse));

// Every other endpoint in the module requires a signed-in platform user;
// per-class authorisation is layered on top by loadClass/requireTeacher.
router.use(authenticate);

/* ─────────────────────── account-level (no classId) ───────────────────── */

router.get("/me", (req, res) => res.json(req.lmUser));
router.get("/overview", asyncRoute(dashboardController.getOverview));
router.get("/todo", asyncRoute(dashboardController.getTodo));
router.get("/calendar", asyncRoute(dashboardController.getCalendar));

router.get("/notifications", asyncRoute(notificationController.list));
router.post("/notifications/read", asyncRoute(notificationController.markRead));
router.delete("/notifications/read", asyncRoute(notificationController.clearAll));
router.delete("/notifications/:notificationId", asyncRoute(notificationController.remove));

// Timetable-sourced pickers for the create-class form.
router.get("/timetable/branches", asyncRoute(timetableOptionsController.listBranches));
router.get("/timetable/semesters", asyncRoute(timetableOptionsController.listSemesters));
router.get("/timetable/subjects", asyncRoute(timetableOptionsController.listSubjects));

router.get("/classes", asyncRoute(classController.listMyClasses));
router.post("/classes", requireClassCreator, asyncRoute(classController.createClass));
router.get("/classes/all", asyncRoute(classController.listAllClasses));

/* ── bug reports and the profile ────────────────────────────────────────
   Outside the class router on purpose: most bugs are not about a class, and
   making somebody navigate into one first is how a bug goes unreported. The
   admin-only endpoints check `isPlatformAdmin` in the handler — there is no
   class to hang a `requireTeacher` off. */
router.post("/bugs", asyncRoute(bugReportController.createBugReport));
router.get("/bugs/mine", asyncRoute(bugReportController.listMyBugReports));
router.get("/bugs", asyncRoute(bugReportController.listAllBugReports));
router.patch("/bugs/:reportId", asyncRoute(bugReportController.reviewBugReport));

router.get("/me/profile", asyncRoute(profileController.getMyProfile));

// Platform-wide stats for the lm-admin dashboard. Admin-only, checked in the
// handler for the same reason the bug queue is — there is no class to hang a
// requireTeacher off.
router.get("/admin/summary", asyncRoute(adminController.getSummary));

router.post("/join", asyncRoute(memberController.joinByCode));
router.post("/claim-invites", asyncRoute(memberController.claimInvites));
router.get("/preview/:code", asyncRoute(memberController.previewByCode));

router.post(
  "/uploads",
  uploadController.uploadMiddleware,
  uploadController.uploadErrorHandler,
  asyncRoute(uploadController.handleUpload),
);
router.get("/files/:filename", asyncRoute(uploadController.serveFile));

/* ─────────────────────────── class-scoped ─────────────────────────────── */

const classRouter = express.Router({ mergeParams: true });
router.use("/classes/:classId", asyncRoute(loadClass), classRouter);

// class itself
classRouter.get("/", asyncRoute(classController.getClass));
classRouter.patch("/", requireTeacher, asyncRoute(classController.updateClass));
classRouter.post("/archive", requireTeacher, asyncRoute(classController.archiveClass));
classRouter.post("/code/regenerate", requireTeacher, asyncRoute(classController.regenerateCode));
classRouter.delete("/", requireOwner, asyncRoute(classController.deleteClass));

// topics
classRouter.get("/topics", asyncRoute(classController.listTopics));
classRouter.post("/topics", requireTeacher, asyncRoute(classController.createTopic));
classRouter.patch("/topics/:topicId", requireTeacher, asyncRoute(classController.updateTopic));
classRouter.delete("/topics/:topicId", requireTeacher, asyncRoute(classController.deleteTopic));

// people
classRouter.get("/members", asyncRoute(memberController.listMembers));
classRouter.post("/members/invite", requireTeacher, asyncRoute(memberController.inviteMembers));
classRouter.get("/members/invite-status/:batchId", requireTeacher, asyncRoute(memberController.inviteStatus));
classRouter.post("/members/:membershipId/decide", requireTeacher, asyncRoute(memberController.decideJoinRequest));
classRouter.patch("/members/:membershipId", requireTeacher, asyncRoute(memberController.updateMember));
classRouter.delete("/members/:membershipId", requireTeacher, asyncRoute(memberController.removeMember));
classRouter.get("/members/:membershipId/progress", requireTeacher, asyncRoute(memberController.getMemberProgress));
classRouter.post("/members/:membershipId/transfer-ownership", requireOwner, asyncRoute(memberController.transferOwnership));
classRouter.post("/leave", asyncRoute(memberController.leaveClass));

// stream
classRouter.get("/stream", asyncRoute(streamController.getStream));
classRouter.post("/announcements", asyncRoute(streamController.createAnnouncement));
classRouter.patch("/announcements/:announcementId", asyncRoute(streamController.updateAnnouncement));
classRouter.delete("/announcements/:announcementId", asyncRoute(streamController.deleteAnnouncement));
classRouter.post("/announcements/:announcementId/react", asyncRoute(streamController.reactToAnnouncement));

// comments (polymorphic)
classRouter.get("/comments/:targetType/:targetId", asyncRoute(commentController.listComments));
classRouter.post("/comments/:targetType/:targetId", asyncRoute(commentController.createComment));
classRouter.patch("/comments/:commentId", asyncRoute(commentController.updateComment));
classRouter.delete("/comments/:commentId", asyncRoute(commentController.deleteComment));

// anonymous feedback — student → teaching staff, name withheld from staff and
// kept for the administrator.
//
// The list is one endpoint rather than two because who is asking decides what
// comes back: a student gets their own notes, staff get the class's with every
// identifying field stripped, and a platform admin gets the same list with the
// names put back. Sending is gated on an active *student* enrolment for the
// same reason quiz attempts are — staff feedback in a student channel would be
// indistinguishable from the cohort's once anonymised.
//
// DELETE is platform-admin-only, and deliberately *not* requireTeacher — that
// guard would hand the member of staff a complaint is about the power to delete
// it. The check is in the controller because "platform admin" is the one
// standing this module has no route middleware for: `loadClass` folds admins
// into the teacher role, so there is nothing here to test against.
classRouter.get("/feedback", asyncRoute(feedbackController.listFeedback));
classRouter.post("/feedback", requireClassStudent, asyncRoute(feedbackController.createFeedback));
classRouter.patch("/feedback/:feedbackId", requireTeacher, asyncRoute(feedbackController.updateFeedback));
classRouter.delete("/feedback/:feedbackId", asyncRoute(feedbackController.deleteFeedback));

// classwork
classRouter.get("/coursework", asyncRoute(courseworkController.listCoursework));
classRouter.post("/coursework", requireTeacher, asyncRoute(courseworkController.createCoursework));
classRouter.get("/coursework/:courseworkId", asyncRoute(courseworkController.getCoursework));
classRouter.patch("/coursework/:courseworkId", requireTeacher, asyncRoute(courseworkController.updateCoursework));
classRouter.delete("/coursework/:courseworkId", requireTeacher, asyncRoute(courseworkController.deleteCoursework));
classRouter.get("/coursework/:courseworkId/submissions", requireTeacher, asyncRoute(courseworkController.getSubmissionGrid));

// student submissions
classRouter.post("/coursework/:courseworkId/draft", asyncRoute(submissionController.saveDraft));
classRouter.post("/coursework/:courseworkId/turn-in", asyncRoute(submissionController.turnIn));
classRouter.post("/coursework/:courseworkId/unsubmit", asyncRoute(submissionController.unsubmit));

// grading
classRouter.patch("/submissions/:submissionId/grade", requireTeacher, asyncRoute(submissionController.gradeSubmission));
classRouter.post("/submissions/return", requireTeacher, asyncRoute(submissionController.returnSubmissions));
classRouter.post("/submissions/:submissionId/reclaim", requireTeacher, asyncRoute(submissionController.reclaimSubmission));
classRouter.get("/gradebook", asyncRoute(submissionController.getGradebook));
classRouter.get("/gradebook.csv", requireTeacher, asyncRoute(submissionController.exportGradebookCsv));
classRouter.post("/gradebook/bulk", requireTeacher, asyncRoute(submissionController.bulkGrade));

// quizzes — authoring. PATCH/DELETE/publish are not requireTeacher because a
// named collaborator may edit a quiz without being class staff; the controller
// checks that itself (canManage).
classRouter.get("/quizzes", asyncRoute(quizController.listQuizzes));
classRouter.post("/quizzes", requireTeacher, asyncRoute(quizController.createQuiz));
classRouter.get("/quizzes/:quizId", asyncRoute(quizController.getQuiz));
classRouter.patch("/quizzes/:quizId", asyncRoute(quizController.updateQuiz));
classRouter.delete("/quizzes/:quizId", asyncRoute(quizController.deleteQuiz));
classRouter.post("/quizzes/:quizId/publish", asyncRoute(quizController.publishQuiz));
classRouter.post("/quizzes/:quizId/collaborators", requireTeacher, asyncRoute(quizController.setCollaborators));
classRouter.delete("/quizzes/:quizId/responses", asyncRoute(quizController.deleteResponses));

// quizzes — sitting.
//
// Every step of actually taking the paper is gated on an active *student*
// enrolment, not merely on being able to open the class: staff and platform
// admins have standing here through their role, and an attempt from one of them
// would be scored into the cohort's results. The brief is deliberately left
// open to staff — it is the page they hand out, and being able to read it is
// how they check what the class will see.
classRouter.get("/quizzes/:quizId/brief", asyncRoute(quizController.getQuizBrief));
classRouter.post("/quizzes/:quizId/attempts", requireClassStudent, asyncRoute(quizController.startAttempt));
classRouter.get("/attempts/:attemptId/paper", requireClassStudent, asyncRoute(quizController.getAttemptPaper));
classRouter.get("/attempts/:attemptId/current", requireClassStudent, asyncRoute(quizController.getCurrentQuestion));
classRouter.post("/attempts/:attemptId/answer", requireClassStudent, asyncRoute(quizController.answerAndAdvance));
classRouter.post("/attempts/:attemptId/save", requireClassStudent, asyncRoute(quizController.saveAttemptDraft));
classRouter.post("/attempts/:attemptId/violation", requireClassStudent, asyncRoute(quizController.recordViolation));
classRouter.post("/attempts/:attemptId/submit", requireClassStudent, asyncRoute(quizController.submitAttempt));
classRouter.get("/attempts/:attemptId", asyncRoute(quizController.getAttempt));

// quizzes — putting one student's sitting right. Staff only: both of these
// rewrite an exam record, and `reopen` hands out a fresh deadline that the quiz
// window would otherwise refuse.
classRouter.post("/attempts/:attemptId/reopen", requireTeacher, asyncRoute(quizController.reopenAttempt));
classRouter.delete("/attempts/:attemptId", requireTeacher, asyncRoute(quizController.deleteAttempt));

// quizzes — analytics
classRouter.get("/quizzes/:quizId/results", requireTeacher, asyncRoute(quizController.getQuizResults));
classRouter.get("/quizzes/:quizId/results.csv", requireTeacher, asyncRoute(quizController.exportResultsCsv));

// shorts — instant in-class polls. Authoring and presenting are staff-only;
// the answering side lives on the top-level router above.
// The list and the single-deck read are open to students so the class page can
// say "a short is live, here is the code"; the controller strips the slides and
// the answer key for anyone who is not staff.
classRouter.get("/shorts", asyncRoute(shortsController.listShorts));
classRouter.get("/shorts/:shortId", asyncRoute(shortsController.getShort));
classRouter.post("/shorts", requireTeacher, asyncRoute(shortsController.createShort));
classRouter.patch("/shorts/:shortId", requireTeacher, asyncRoute(shortsController.updateShort));
classRouter.delete("/shorts/:shortId", requireTeacher, asyncRoute(shortsController.deleteShort));
classRouter.post("/shorts/:shortId/present", requireTeacher, asyncRoute(shortsController.startSession));
classRouter.get("/shorts/:shortId/sessions", requireTeacher, asyncRoute(shortsController.listSessions));
classRouter.get("/short-sessions/:sessionId/state", requireTeacher, asyncRoute(shortsController.getPresenterState));
classRouter.post("/short-sessions/:sessionId/control", requireTeacher, asyncRoute(shortsController.controlSession));
classRouter.post("/short-sessions/:sessionId/end", requireTeacher, asyncRoute(shortsController.endSession));
classRouter.get("/short-sessions/:sessionId/stream", requireTeacher, asyncRoute(shortsController.streamPresenter));
classRouter.get("/short-sessions/:sessionId/report", requireTeacher, asyncRoute(shortsController.getSessionReport));
classRouter.get("/short-sessions/:sessionId/report.csv", requireTeacher, asyncRoute(shortsController.exportSessionCsv));

// coding notebooks — Python cells the student runs in their own browser
classRouter.get("/notebooks", asyncRoute(notebookController.listNotebooks));
classRouter.post("/notebooks", requireTeacher, asyncRoute(notebookController.createNotebook));
classRouter.get("/notebooks/:notebookId", requireTeacher, asyncRoute(notebookController.getNotebook));
classRouter.patch("/notebooks/:notebookId", requireTeacher, asyncRoute(notebookController.updateNotebook));
classRouter.delete("/notebooks/:notebookId", requireTeacher, asyncRoute(notebookController.deleteNotebook));
classRouter.post("/notebooks/:notebookId/publish", requireTeacher, asyncRoute(notebookController.publishNotebook));
classRouter.get("/notebooks/:notebookId/attempt", asyncRoute(notebookController.getMyAttempt));
classRouter.get("/notebooks/:notebookId/attempts", requireTeacher, asyncRoute(notebookController.listAttempts));

/* ── points and badges ──────────────────────────────────────────────────
   Open to the whole class, students included: a leaderboard only staff can
   read is a report, not a game. */
classRouter.get("/leaderboard", asyncRoute(leaderboardController.getLeaderboard));
classRouter.get("/my-points", asyncRoute(leaderboardController.getMyPoints));
// One student's badges and the split of their points. Not staff-gated at the
// router, because a student reading their own is the same request — the
// controller is where "mine, or anybody's if I am staff" is decided.
classRouter.get("/students/:studentId/points", asyncRoute(leaderboardController.getStudentPoints));
classRouter.get("/points-guide", asyncRoute(leaderboardController.getPointsGuide));

/* ── discussion forum ───────────────────────────────────────────────────
   Open to students by design — starting a topic is the point. The one-a-week
   limit is a unique index on the model, and staff moderate. */
classRouter.get("/discussions", asyncRoute(discussionController.listDiscussions));
classRouter.post("/discussions", asyncRoute(discussionController.createDiscussion));
classRouter.get("/discussions/:discussionId", asyncRoute(discussionController.getDiscussion));
classRouter.patch("/discussions/:discussionId", requireTeacher, asyncRoute(discussionController.updateDiscussion));
classRouter.delete("/discussions/:discussionId", asyncRoute(discussionController.deleteDiscussion));
classRouter.get("/notebook-attempts/:attemptId", asyncRoute(notebookController.getAttempt));
classRouter.post("/notebook-attempts/:attemptId/save", asyncRoute(notebookController.saveAttempt));
classRouter.post("/notebook-attempts/:attemptId/submit", asyncRoute(notebookController.submitAttempt));
classRouter.post("/notebook-attempts/:attemptId/reopen", requireTeacher, asyncRoute(notebookController.reopenAttempt));
classRouter.patch("/notebook-attempts/:attemptId/grade", requireTeacher, asyncRoute(notebookController.gradeAttempt));

// parameterised tutorials — every student gets their own numbers
classRouter.get("/tutorials", asyncRoute(tutorialController.listTutorials));
classRouter.post("/tutorials", requireTeacher, asyncRoute(tutorialController.createTutorial));
classRouter.get("/tutorials/formula-reference", asyncRoute(tutorialController.getFormulaReference));
classRouter.post("/tutorials/validate-formula", requireTeacher, asyncRoute(tutorialController.validateFormula));
classRouter.get("/tutorials/:tutorialId", asyncRoute(tutorialController.getTutorial));
classRouter.patch("/tutorials/:tutorialId", requireTeacher, asyncRoute(tutorialController.updateTutorial));
classRouter.delete("/tutorials/:tutorialId", requireTeacher, asyncRoute(tutorialController.deleteTutorial));
classRouter.post("/tutorials/:tutorialId/preview", requireTeacher, asyncRoute(tutorialController.previewTutorial));
classRouter.post("/tutorials/:tutorialId/publish", requireTeacher, asyncRoute(tutorialController.publishTutorial));
classRouter.get("/tutorials/:tutorialId/results", requireTeacher, asyncRoute(tutorialController.getTutorialResults));
classRouter.get("/tutorials/:tutorialId/attempt", asyncRoute(tutorialController.getMyAttempt));
classRouter.post("/tutorial-attempts/:attemptId/save", asyncRoute(tutorialController.saveAttempt));
classRouter.post("/tutorial-attempts/:attemptId/submit", asyncRoute(tutorialController.submitAttempt));
classRouter.post("/tutorial-attempts/:attemptId/adjust", requireTeacher, asyncRoute(tutorialController.adjustAttempt));

// AI studio — audio → transcript → notes / tutorial / quiz
classRouter.get("/studio/status", requireTeacher, asyncRoute(audioStudioController.getStudioStatus));
classRouter.get("/studio/recordings", requireTeacher, asyncRoute(audioStudioController.listAvailableRecordings));
classRouter.get("/studio/recordings/:filename/audio", requireTeacher, asyncRoute(audioStudioController.streamRecordingAudio));
classRouter.get("/studio/sessions", asyncRoute(audioStudioController.listSessions));
classRouter.post("/studio/sessions", requireTeacher, asyncRoute(audioStudioController.createSession));
classRouter.get("/studio/sessions/:sessionId", asyncRoute(audioStudioController.getSession));
classRouter.patch("/studio/sessions/:sessionId", requireTeacher, asyncRoute(audioStudioController.updateSession));
classRouter.delete("/studio/sessions/:sessionId", requireTeacher, asyncRoute(audioStudioController.deleteSession));
classRouter.post("/studio/sessions/:sessionId/transcribe", requireTeacher, asyncRoute(audioStudioController.transcribe));
classRouter.post("/studio/sessions/:sessionId/generate", requireTeacher, asyncRoute(audioStudioController.generate));
classRouter.post("/studio/sessions/:sessionId/ask", asyncRoute(audioStudioController.ask));
classRouter.post("/studio/sessions/:sessionId/publish/notes", requireTeacher, asyncRoute(audioStudioController.publishNotes));
classRouter.post("/studio/sessions/:sessionId/publish/tutorial", requireTeacher, asyncRoute(audioStudioController.publishTutorial));
classRouter.post("/studio/sessions/:sessionId/publish/quiz", requireTeacher, asyncRoute(audioStudioController.createQuizFromDraft));

// insights
classRouter.get("/analytics", requireTeacher, asyncRoute(dashboardController.getClassAnalytics));

module.exports = router;
