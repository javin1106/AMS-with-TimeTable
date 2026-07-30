const express = require("express");

const {
  authenticate,
  requireClassCreator,
  loadClass,
  requireTeacher,
  requireOwner,
  asyncRoute,
} = require("../middleware/lmAuth");

const classController = require("../controllers/classController");
const memberController = require("../controllers/memberController");
const streamController = require("../controllers/streamController");
const commentController = require("../controllers/commentController");
const courseworkController = require("../controllers/courseworkController");
const submissionController = require("../controllers/submissionController");
const quizController = require("../controllers/quizController");
const shortsController = require("../controllers/shortsController");
const tutorialController = require("../controllers/tutorialController");
const audioStudioController = require("../controllers/audioStudioController");
const notificationController = require("../controllers/notificationController");
const dashboardController = require("../controllers/dashboardController");
const uploadController = require("../controllers/uploadController");

const router = express.Router();

// Every endpoint in the module requires a signed-in platform user; per-class
// authorisation is layered on top by loadClass/requireTeacher.
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

router.get("/classes", asyncRoute(classController.listMyClasses));
router.post("/classes", requireClassCreator, asyncRoute(classController.createClass));
router.get("/classes/all", asyncRoute(classController.listAllClasses));

router.post("/join", asyncRoute(memberController.joinByCode));
router.post("/claim-invites", asyncRoute(memberController.claimInvites));
router.get("/preview/:code", asyncRoute(memberController.previewByCode));

// Shorts — the live participant side. These sit outside classRouter on purpose:
// somebody joining from a phone has a six-digit code and nothing else, so there
// is no classId to put in the path. Class membership is checked inside the
// controller once the code resolves to a session.
router.post("/shorts/join/:code", asyncRoute(shortsController.joinByCode));
router.get("/shorts/live/:sessionId", asyncRoute(shortsController.getParticipantState));
router.get("/shorts/live/:sessionId/stream", asyncRoute(shortsController.streamParticipant));
router.post("/shorts/live/:sessionId/answer", asyncRoute(shortsController.submitResponse));

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

// quizzes — sitting
classRouter.get("/quizzes/:quizId/brief", asyncRoute(quizController.getQuizBrief));
classRouter.post("/quizzes/:quizId/attempts", asyncRoute(quizController.startAttempt));
classRouter.get("/attempts/:attemptId/paper", asyncRoute(quizController.getAttemptPaper));
classRouter.get("/attempts/:attemptId/current", asyncRoute(quizController.getCurrentQuestion));
classRouter.post("/attempts/:attemptId/answer", asyncRoute(quizController.answerAndAdvance));
classRouter.post("/attempts/:attemptId/save", asyncRoute(quizController.saveAttemptDraft));
classRouter.post("/attempts/:attemptId/violation", asyncRoute(quizController.recordViolation));
classRouter.post("/attempts/:attemptId/submit", asyncRoute(quizController.submitAttempt));
classRouter.get("/attempts/:attemptId", asyncRoute(quizController.getAttempt));

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
