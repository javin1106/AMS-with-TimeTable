import getEnvironment from '../../getenvironment';

// Every learning-module call goes through here so auth, error shape and the
// base URL are decided in exactly one place.
const BASE = () => `${getEnvironment()}/api/v1/learningmodule`;

class LmApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'LmApiError';
    this.status = status;
    this.payload = payload;
  }
}

/**
 * A guest's identity for one live Short — see the `requireLogin` setting. Kept
 * in sessionStorage rather than localStorage: it belongs to this tab and this
 * lecture, and should not outlive either. Private windows allow it, which is
 * rather the point when the whole feature exists for people without accounts.
 */
const GUEST_KEY = 'lmShortGuest';

export const shortGuest = {
  save: (sessionId, token) => {
    try {
      sessionStorage.setItem(GUEST_KEY, JSON.stringify({ sessionId: String(sessionId), token }));
    } catch {
      // A browser refusing storage is not a reason to fail the join; the
      // participant simply cannot survive a reload.
    }
  },
  token: () => {
    try {
      return JSON.parse(sessionStorage.getItem(GUEST_KEY) || 'null')?.token || null;
    } catch {
      return null;
    }
  },
  clear: () => {
    try {
      sessionStorage.removeItem(GUEST_KEY);
    } catch {
      /* nothing to clear */
    }
  },
};

/**
 * The token naming this browser as the one sitting a given quiz attempt.
 *
 * Minted server-side when the attempt starts and echoed on every request that
 * drives the sitting, so the server can tell one student's two screens apart —
 * the phone reading the paper beside the laptop breaks no browser-side rule, and
 * this is the only angle from which it is visible at all.
 *
 * sessionStorage, so it belongs to this tab: a reload keeps it and carries on,
 * while a genuinely new browser has to earn the binding through the server's
 * rule (allowed only once the first has stopped checking in). Keyed by attempt
 * so two quizzes in two tabs do not overwrite each other.
 */
const QUIZ_SESSION_KEY = (attemptId) => `lmQuizSession:${attemptId}`;

export const quizSession = {
  save: (attemptId, token) => {
    if (!attemptId || !token) return;
    try {
      sessionStorage.setItem(QUIZ_SESSION_KEY(attemptId), token);
    } catch {
      // Without storage the sitting still works; it just cannot prove it is the
      // same browser after a reload, and rebinds once the old one goes quiet.
    }
  },
  token: (attemptId) => {
    try {
      return sessionStorage.getItem(QUIZ_SESSION_KEY(attemptId)) || null;
    } catch {
      return null;
    }
  },
  clear: (attemptId) => {
    try {
      sessionStorage.removeItem(QUIZ_SESSION_KEY(attemptId));
    } catch {
      /* nothing to clear */
    }
  },
};

/** `/classes/:classId/attempts/:attemptId/...` → the attempt id, or null. */
const attemptIdIn = (path) => path.match(/\/attempts\/([a-f\d]{24})(?:\/|$)/i)?.[1] || null;

async function request(path, { method = 'GET', body, raw = false, signal } = {}) {
  const options = {
    method,
    credentials: 'include',
    headers: {},
    signal,
  };

  const token = localStorage.getItem('token');
  if (token) options.headers.Authorization = `Bearer ${token}`;

  // Sent alongside, not instead of: a signed-in user who also holds a guest
  // token is resolved by their account, and the server ignores the header.
  const guestToken = shortGuest.token();
  if (guestToken) options.headers['X-Short-Guest'] = guestToken;

  // Attached by path rather than by each call site, so a sitting endpoint added
  // later cannot forget it and silently reopen the second-screen hole.
  const attemptId = attemptIdIn(path);
  const sessionToken = attemptId && quizSession.token(attemptId);
  if (sessionToken) options.headers['X-Quiz-Session'] = sessionToken;

  if (body instanceof FormData) {
    // Let the browser set the multipart boundary.
    options.body = body;
  } else if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${BASE()}${path}`, options);

  if (raw) {
    if (!response.ok) throw new LmApiError('Request failed', response.status, null);
    return response;
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { message: text };
  }

  if (!response.ok) {
    throw new LmApiError(payload?.message || `Request failed (${response.status})`, response.status, payload);
  }
  return payload;
}

const qs = (params = {}) => {
  const search = new URLSearchParams(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  ).toString();
  return search ? `?${search}` : '';
};

const lmApi = {
  LmApiError,
  fileUrl: (url) => (url?.startsWith('http') ? url : `${getEnvironment()}${url}`),

  /* account level */
  me: () => request('/me'),
  overview: () => request('/overview'),
  todo: () => request('/todo'),
  calendar: (params) => request(`/calendar${qs(params)}`),
  claimInvites: () => request('/claim-invites', { method: 'POST', body: {} }),

  notifications: (params) => request(`/notifications${qs(params)}`),
  markNotificationsRead: (ids) => request('/notifications/read', { method: 'POST', body: { ids } }),
  clearReadNotifications: () => request('/notifications/read', { method: 'DELETE' }),
  deleteNotification: (id) => request(`/notifications/${id}`, { method: 'DELETE' }),

  /* timetable-sourced pickers (create class) */
  ttBranches: () => request('/timetable/branches'),
  ttSemesters: (code) => request(`/timetable/semesters${qs({ code })}`),
  ttSubjects: (code, sem) => request(`/timetable/subjects${qs({ code, sem })}`),

  /* classes */
  listClasses: (status) => request(`/classes${qs({ status })}`),
  createClass: (body) => request('/classes', { method: 'POST', body }),
  getClass: (classId) => request(`/classes/${classId}`),
  updateClass: (classId, body) => request(`/classes/${classId}`, { method: 'PATCH', body }),
  archiveClass: (classId, archive) => request(`/classes/${classId}/archive`, { method: 'POST', body: { archive } }),
  regenerateCode: (classId) => request(`/classes/${classId}/code/regenerate`, { method: 'POST', body: {} }),
  deleteClass: (classId) => request(`/classes/${classId}`, { method: 'DELETE' }),
  joinByCode: (code) => request('/join', { method: 'POST', body: { code } }),
  previewCode: (code) => request(`/preview/${encodeURIComponent(code)}`),
  leaveClass: (classId) => request(`/classes/${classId}/leave`, { method: 'POST', body: {} }),

  /* topics */
  listTopics: (classId) => request(`/classes/${classId}/topics`),
  createTopic: (classId, name) => request(`/classes/${classId}/topics`, { method: 'POST', body: { name } }),
  updateTopic: (classId, topicId, body) => request(`/classes/${classId}/topics/${topicId}`, { method: 'PATCH', body }),
  deleteTopic: (classId, topicId) => request(`/classes/${classId}/topics/${topicId}`, { method: 'DELETE' }),

  /* people */
  listMembers: (classId) => request(`/classes/${classId}/members`),
  inviteMembers: (classId, emails, role, options = {}) =>
    request(`/classes/${classId}/members/invite`, {
      method: 'POST',
      body: {
        emails,
        role,
        createAccounts: options.createAccounts !== false,
        grantRoleToExisting: Boolean(options.grantRoleToExisting),
      },
    }),
  inviteStatus: (classId, batchId) => request(`/classes/${classId}/members/invite-status/${batchId}`),
  decideJoinRequest: (classId, membershipId, approve) =>
    request(`/classes/${classId}/members/${membershipId}/decide`, { method: 'POST', body: { approve } }),
  updateMember: (classId, membershipId, body) =>
    request(`/classes/${classId}/members/${membershipId}`, { method: 'PATCH', body }),
  removeMember: (classId, membershipId) =>
    request(`/classes/${classId}/members/${membershipId}`, { method: 'DELETE' }),
  memberProgress: (classId, membershipId) =>
    request(`/classes/${classId}/members/${membershipId}/progress`),
  transferOwnership: (classId, membershipId) =>
    request(`/classes/${classId}/members/${membershipId}/transfer-ownership`, { method: 'POST', body: {} }),

  /* stream */
  getStream: (classId, params) => request(`/classes/${classId}/stream${qs(params)}`),
  createAnnouncement: (classId, body) => request(`/classes/${classId}/announcements`, { method: 'POST', body }),
  updateAnnouncement: (classId, id, body) =>
    request(`/classes/${classId}/announcements/${id}`, { method: 'PATCH', body }),
  deleteAnnouncement: (classId, id) => request(`/classes/${classId}/announcements/${id}`, { method: 'DELETE' }),
  reactToAnnouncement: (classId, id, emoji) =>
    request(`/classes/${classId}/announcements/${id}/react`, { method: 'POST', body: { emoji } }),

  /* comments */
  listComments: (classId, targetType, targetId) =>
    request(`/classes/${classId}/comments/${targetType}/${targetId}`),
  createComment: (classId, targetType, targetId, text, parentId) =>
    request(`/classes/${classId}/comments/${targetType}/${targetId}`, {
      method: 'POST',
      body: { text, parentId },
    }),
  deleteComment: (classId, commentId) => request(`/classes/${classId}/comments/${commentId}`, { method: 'DELETE' }),

  /* anonymous feedback — the response shape depends on who is asking, see
     feedbackController.listFeedback: `view` is 'student' | 'teacher' | 'admin' */
  listFeedback: (classId) => request(`/classes/${classId}/feedback`),
  sendFeedback: (classId, body) => request(`/classes/${classId}/feedback`, { method: 'POST', body }),
  updateFeedback: (classId, feedbackId, body) =>
    request(`/classes/${classId}/feedback/${feedbackId}`, { method: 'PATCH', body }),
  deleteFeedback: (classId, feedbackId) =>
    request(`/classes/${classId}/feedback/${feedbackId}`, { method: 'DELETE' }),

  /* classwork */
  listCoursework: (classId, params) => request(`/classes/${classId}/coursework${qs(params)}`),
  createCoursework: (classId, body) => request(`/classes/${classId}/coursework`, { method: 'POST', body }),
  getCoursework: (classId, id) => request(`/classes/${classId}/coursework/${id}`),
  updateCoursework: (classId, id, body) => request(`/classes/${classId}/coursework/${id}`, { method: 'PATCH', body }),
  deleteCoursework: (classId, id) => request(`/classes/${classId}/coursework/${id}`, { method: 'DELETE' }),
  submissionGrid: (classId, id) => request(`/classes/${classId}/coursework/${id}/submissions`),

  /* submissions */
  saveDraft: (classId, courseworkId, body) =>
    request(`/classes/${classId}/coursework/${courseworkId}/draft`, { method: 'POST', body }),
  turnIn: (classId, courseworkId, body) =>
    request(`/classes/${classId}/coursework/${courseworkId}/turn-in`, { method: 'POST', body }),
  unsubmit: (classId, courseworkId) =>
    request(`/classes/${classId}/coursework/${courseworkId}/unsubmit`, { method: 'POST', body: {} }),
  gradeSubmission: (classId, submissionId, body) =>
    request(`/classes/${classId}/submissions/${submissionId}/grade`, { method: 'PATCH', body }),
  returnSubmissions: (classId, submissionIds) =>
    request(`/classes/${classId}/submissions/return`, { method: 'POST', body: { submissionIds } }),
  reclaimSubmission: (classId, submissionId) =>
    request(`/classes/${classId}/submissions/${submissionId}/reclaim`, { method: 'POST', body: {} }),

  /* grades */
  gradebook: (classId) => request(`/classes/${classId}/gradebook`),
  bulkGrade: (classId, grades) => request(`/classes/${classId}/gradebook/bulk`, { method: 'POST', body: { grades } }),
  gradebookCsvUrl: (classId) => `${BASE()}/classes/${classId}/gradebook.csv`,

  /* reusing questions from another class the same teacher staffs. `type` is one
     of quiz | short | tutorial | notebook, and never crosses: quiz questions go
     into a quiz, slides into a Short. */
  importSources: (classId, type) =>
    request(`/classes/${classId}/import/sources?type=${encodeURIComponent(type)}`),
  importItems: (classId, sourceClassId, type) =>
    request(`/classes/${classId}/import/sources/${sourceClassId}/items?type=${encodeURIComponent(type)}`),
  importParts: (classId, itemId, type) =>
    request(`/classes/${classId}/import/items/${itemId}/parts?type=${encodeURIComponent(type)}`),
  importTargets: (classId, type) =>
    request(`/classes/${classId}/import/targets?type=${encodeURIComponent(type)}`),
  importInto: (classId, body) => request(`/classes/${classId}/import`, { method: 'POST', body }),

  /* quizzes */
  listQuizzes: (classId) => request(`/classes/${classId}/quizzes`),
  createQuiz: (classId, body) => request(`/classes/${classId}/quizzes`, { method: 'POST', body }),
  getQuiz: (classId, quizId) => request(`/classes/${classId}/quizzes/${quizId}`),
  updateQuiz: (classId, quizId, body) => request(`/classes/${classId}/quizzes/${quizId}`, { method: 'PATCH', body }),
  deleteQuiz: (classId, quizId) => request(`/classes/${classId}/quizzes/${quizId}`, { method: 'DELETE' }),
  publishQuiz: (classId, quizId, body) =>
    request(`/classes/${classId}/quizzes/${quizId}/publish`, { method: 'POST', body: body || {} }),
  quizResults: (classId, quizId) => request(`/classes/${classId}/quizzes/${quizId}/results`),
  setQuizCollaborators: (classId, quizId, emails) =>
    request(`/classes/${classId}/quizzes/${quizId}/collaborators`, { method: 'POST', body: { emails } }),
  deleteQuizResponses: (classId, quizId) =>
    request(`/classes/${classId}/quizzes/${quizId}/responses`, { method: 'DELETE' }),
  quizResultsCsvUrl: (classId, quizId) => `${BASE()}/classes/${classId}/quizzes/${quizId}/results.csv`,

  /* quiz sitting */
  quizBrief: (classId, quizId) => request(`/classes/${classId}/quizzes/${quizId}/brief`),
  // The only call that mints a session token, so it is also the only one that
  // stores it. Everything else on the attempt picks it up from `request`.
  startAttempt: async (classId, quizId) => {
    const result = await request(`/classes/${classId}/quizzes/${quizId}/attempts`, {
      method: 'POST',
      body: {},
    });
    quizSession.save(result?.attempt?._id, result?.sessionToken);
    return result;
  },
  getAttemptPaper: (classId, attemptId) => request(`/classes/${classId}/attempts/${attemptId}/paper`),
  getCurrentQuestion: (classId, attemptId) => request(`/classes/${classId}/attempts/${attemptId}/current`),
  answerAndAdvance: (classId, attemptId, body) =>
    request(`/classes/${classId}/attempts/${attemptId}/answer`, { method: 'POST', body }),
  saveAttemptDraft: (classId, attemptId, answers) =>
    request(`/classes/${classId}/attempts/${attemptId}/save`, { method: 'POST', body: { answers } }),
  // `at` is when the event happened, which is not always when it is sent: a
  // report that failed offline is queued and replayed, and the server judges it
  // by this timestamp rather than by its arrival. Clamped server-side, so a
  // hand-written one buys nothing.
  recordViolation: (classId, attemptId, type, at) =>
    request(`/classes/${classId}/attempts/${attemptId}/violation`, {
      method: 'POST',
      body: at ? { type, at } : { type },
    }),
  // Sent on a timer while a paper is open. Its absence is the signal — a client
  // that has had its reporting blocked stops sending these, and the server notes
  // the silence.
  heartbeat: (classId, attemptId) =>
    request(`/classes/${classId}/attempts/${attemptId}/heartbeat`, { method: 'POST', body: {} }),
  submitAttempt: (classId, attemptId, answers, expired = false) =>
    request(`/classes/${classId}/attempts/${attemptId}/submit`, {
      method: 'POST',
      body: { answers, expired },
    }),
  getAttempt: (classId, attemptId) => request(`/classes/${classId}/attempts/${attemptId}`),

  /* staff putting one student's sitting right — see quizController.reopenAttempt.
     `mode` is 'continue' (keep their answers) or 'restart' (fresh paper). */
  reopenQuizAttempt: (classId, attemptId, body) =>
    request(`/classes/${classId}/attempts/${attemptId}/reopen`, { method: 'POST', body }),
  deleteQuizAttempt: (classId, attemptId) =>
    request(`/classes/${classId}/attempts/${attemptId}`, { method: 'DELETE' }),

  /* correcting the answer key of a paper the class has already sat.
     `questions` is [{ questionId, correctAnswers, marks, negativeMarks,
     tolerancePercent, toleranceAbs, explanation }] — only the fields sent are
     written, and the whole cohort is re-marked unless `regrade: false`. */
  updateAnswerKey: (classId, quizId, questions, regrade = true) =>
    request(`/classes/${classId}/quizzes/${quizId}/answer-key`, {
      method: 'PATCH',
      body: { questions, regrade },
    }),
  // Re-mark every finished sitting against the answer key as it stands now.
  regradeQuiz: (classId, quizId) =>
    request(`/classes/${classId}/quizzes/${quizId}/regrade`, { method: 'POST', body: {} }),
  // Marks out now, whatever the schedule said, and every student who sat the
  // paper is notified.
  releaseQuizResults: (classId, quizId) =>
    request(`/classes/${classId}/quizzes/${quizId}/release-results`, { method: 'POST', body: {} }),

  /* parameterised tutorials */
  listTutorials: (classId) => request(`/classes/${classId}/tutorials`),
  createTutorial: (classId, body) => request(`/classes/${classId}/tutorials`, { method: 'POST', body }),
  getTutorial: (classId, tutorialId) => request(`/classes/${classId}/tutorials/${tutorialId}`),
  updateTutorial: (classId, tutorialId, body) =>
    request(`/classes/${classId}/tutorials/${tutorialId}`, { method: 'PATCH', body }),
  deleteTutorial: (classId, tutorialId) =>
    request(`/classes/${classId}/tutorials/${tutorialId}`, { method: 'DELETE' }),
  previewTutorial: (classId, tutorialId, count) =>
    request(`/classes/${classId}/tutorials/${tutorialId}/preview`, { method: 'POST', body: { count } }),
  publishTutorial: (classId, tutorialId, body) =>
    request(`/classes/${classId}/tutorials/${tutorialId}/publish`, { method: 'POST', body: body || {} }),
  tutorialResults: (classId, tutorialId) =>
    request(`/classes/${classId}/tutorials/${tutorialId}/results`),
  validateFormula: (classId, formula, variables) =>
    request(`/classes/${classId}/tutorials/validate-formula`, {
      method: 'POST',
      body: { formula, variables },
    }),
  formulaReference: (classId) => request(`/classes/${classId}/tutorials/formula-reference`),
  myTutorialAttempt: (classId, tutorialId) =>
    request(`/classes/${classId}/tutorials/${tutorialId}/attempt`),
  saveTutorialAttempt: (classId, attemptId, responses) =>
    request(`/classes/${classId}/tutorial-attempts/${attemptId}/save`, {
      method: 'POST',
      body: { responses },
    }),
  submitTutorialAttempt: (classId, attemptId, responses) =>
    request(`/classes/${classId}/tutorial-attempts/${attemptId}/submit`, {
      method: 'POST',
      body: { responses },
    }),
  adjustTutorialAttempt: (classId, attemptId, adjustment, feedback) =>
    request(`/classes/${classId}/tutorial-attempts/${attemptId}/adjust`, {
      method: 'POST',
      body: { adjustment, feedback },
    }),

  /* AI studio */
  studioStatus: (classId) => request(`/classes/${classId}/studio/status`),
  studioRecordings: (classId) => request(`/classes/${classId}/studio/recordings`),
  studioAudioUrl: (classId, filename) =>
    `${BASE()}/classes/${classId}/studio/recordings/${encodeURIComponent(filename)}/audio`,
  listSessions: (classId) => request(`/classes/${classId}/studio/sessions`),
  createSession: (classId, body) => request(`/classes/${classId}/studio/sessions`, { method: 'POST', body }),
  getSession: (classId, sessionId) => request(`/classes/${classId}/studio/sessions/${sessionId}`),
  updateSession: (classId, sessionId, body) =>
    request(`/classes/${classId}/studio/sessions/${sessionId}`, { method: 'PATCH', body }),
  deleteSession: (classId, sessionId) =>
    request(`/classes/${classId}/studio/sessions/${sessionId}`, { method: 'DELETE' }),
  transcribeSession: (classId, sessionId, language) =>
    request(`/classes/${classId}/studio/sessions/${sessionId}/transcribe`, {
      method: 'POST',
      body: { language },
    }),
  generateFromSession: (classId, sessionId, body) =>
    request(`/classes/${classId}/studio/sessions/${sessionId}/generate`, { method: 'POST', body }),
  askSession: (classId, sessionId, question) =>
    request(`/classes/${classId}/studio/sessions/${sessionId}/ask`, { method: 'POST', body: { question } }),
  publishNotes: (classId, sessionId, body) =>
    request(`/classes/${classId}/studio/sessions/${sessionId}/publish/notes`, { method: 'POST', body: body || {} }),
  // Distinct from publishTutorial() above: this publishes an AI-generated
  // tutorial from a lecture session as class material, not a parameterised
  // tutorial. The two used to share a name and silently collided.
  publishSessionTutorial: (classId, sessionId, body) =>
    request(`/classes/${classId}/studio/sessions/${sessionId}/publish/tutorial`, { method: 'POST', body: body || {} }),
  publishQuizDraft: (classId, sessionId, body) =>
    request(`/classes/${classId}/studio/sessions/${sessionId}/publish/quiz`, { method: 'POST', body: body || {} }),

  /* coding notebooks — Python that runs in the student's browser */
  listNotebooks: (classId) => request(`/classes/${classId}/notebooks`),
  createNotebook: (classId, body) => request(`/classes/${classId}/notebooks`, { method: 'POST', body }),
  getNotebook: (classId, notebookId) => request(`/classes/${classId}/notebooks/${notebookId}`),
  updateNotebook: (classId, notebookId, body) =>
    request(`/classes/${classId}/notebooks/${notebookId}`, { method: 'PATCH', body }),
  deleteNotebook: (classId, notebookId) =>
    request(`/classes/${classId}/notebooks/${notebookId}`, { method: 'DELETE' }),
  /* ---- points and badges ---- */
  leaderboard: (classId, scope = 'week') =>
    request(`/classes/${classId}/leaderboard?scope=${scope}`),
  myPoints: (classId) => request(`/classes/${classId}/my-points`),
  // Staff may ask for anybody on the table; a student only for themselves.
  studentPoints: (classId, studentId) => request(`/classes/${classId}/students/${studentId}/points`),
  pointsGuide: (classId) => request(`/classes/${classId}/points-guide`),

  /* ---- profile and bugs/suggestions (outside any class) ---- */
  myProfile: () => request('/me/profile'),
  reportBug: (body) => request('/bugs', { method: 'POST', body }),
  myBugReports: () => request('/bugs/mine'),
  // 403s for anyone who is not a platform admin; the page uses that to decide
  // whether to show the queue at all.
  allBugReports: ({ status, kind } = {}) => request(`/bugs${qs({ status, kind })}`),
  reviewBug: (reportId, body) => request(`/bugs/${reportId}`, { method: 'PATCH', body }),

  /* lm-admin dashboard — platform-wide stats, 403 for anyone else */
  adminSummary: () => request('/admin/summary'),

  /* ---- discussion forum ---- */
  listDiscussions: (classId) => request(`/classes/${classId}/discussions`),
  createDiscussion: (classId, body) =>
    request(`/classes/${classId}/discussions`, { method: 'POST', body }),
  getDiscussion: (classId, discussionId) =>
    request(`/classes/${classId}/discussions/${discussionId}`),
  updateDiscussion: (classId, discussionId, body) =>
    request(`/classes/${classId}/discussions/${discussionId}`, { method: 'PATCH', body }),
  deleteDiscussion: (classId, discussionId) =>
    request(`/classes/${classId}/discussions/${discussionId}`, { method: 'DELETE' }),

  publishNotebook: (classId, notebookId, body) =>
    request(`/classes/${classId}/notebooks/${notebookId}/publish`, { method: 'POST', body: body || {} }),
  notebookAttempt: (classId, notebookId) =>
    request(`/classes/${classId}/notebooks/${notebookId}/attempt`),
  listNotebookAttempts: (classId, notebookId) =>
    request(`/classes/${classId}/notebooks/${notebookId}/attempts`),
  getNotebookAttempt: (classId, attemptId) => request(`/classes/${classId}/notebook-attempts/${attemptId}`),
  saveNotebookAttempt: (classId, attemptId, body) =>
    request(`/classes/${classId}/notebook-attempts/${attemptId}/save`, { method: 'POST', body }),
  submitNotebookAttempt: (classId, attemptId, body) =>
    request(`/classes/${classId}/notebook-attempts/${attemptId}/submit`, { method: 'POST', body: body || {} }),
  reopenNotebookAttempt: (classId, attemptId) =>
    request(`/classes/${classId}/notebook-attempts/${attemptId}/reopen`, { method: 'POST', body: {} }),
  gradeNotebookAttempt: (classId, attemptId, body) =>
    request(`/classes/${classId}/notebook-attempts/${attemptId}/grade`, { method: 'PATCH', body }),

  /* shorts — instant in-class polls */
  listShorts: (classId) => request(`/classes/${classId}/shorts`),
  createShort: (classId, body) => request(`/classes/${classId}/shorts`, { method: 'POST', body }),
  getShort: (classId, shortId) => request(`/classes/${classId}/shorts/${shortId}`),
  updateShort: (classId, shortId, body) =>
    request(`/classes/${classId}/shorts/${shortId}`, { method: 'PATCH', body }),
  deleteShort: (classId, shortId) =>
    request(`/classes/${classId}/shorts/${shortId}`, { method: 'DELETE' }),
  presentShort: (classId, shortId) =>
    request(`/classes/${classId}/shorts/${shortId}/present`, { method: 'POST', body: {} }),
  listShortSessions: (classId, shortId) => request(`/classes/${classId}/shorts/${shortId}/sessions`),
  shortPresenterState: (classId, sessionId) =>
    request(`/classes/${classId}/short-sessions/${sessionId}/state`),
  controlShortSession: (classId, sessionId, action, extra) =>
    request(`/classes/${classId}/short-sessions/${sessionId}/control`, {
      method: 'POST',
      body: { action, ...(extra || {}) },
    }),
  endShortSession: (classId, sessionId) =>
    request(`/classes/${classId}/short-sessions/${sessionId}/end`, { method: 'POST', body: {} }),
  shortSessionReport: (classId, sessionId) =>
    request(`/classes/${classId}/short-sessions/${sessionId}/report`),
  shortSessionCsvUrl: (classId, sessionId) =>
    `${BASE()}/classes/${classId}/short-sessions/${sessionId}/report.csv`,

  // The participant side is not class-scoped: a phone has the join code and
  // nothing else until the server resolves it.
  // `name` is only read by the server when the deck allows guests and nobody is
  // signed in; it is what the room and the report will show.
  joinShort: (code, { name } = {}) =>
    request(`/shorts/join/${encodeURIComponent(code)}`, {
      method: 'POST',
      body: name ? { name } : {},
    }),
  shortGuest,
  shortLiveState: (sessionId) => request(`/shorts/live/${sessionId}`),
  answerShort: (sessionId, body) =>
    request(`/shorts/live/${sessionId}/answer`, { method: 'POST', body }),

  // SSE endpoints are read by useShortStream, which uses fetch + ReadableStream
  // rather than EventSource. EventSource cannot set an Authorization header, and
  // the alternative — putting the JWT in the query string — would write it into
  // every access log between here and the server.
  shortPresenterStreamUrl: (classId, sessionId) =>
    `${BASE()}/classes/${classId}/short-sessions/${sessionId}/stream`,
  shortParticipantStreamUrl: (sessionId) => `${BASE()}/shorts/live/${sessionId}/stream`,

  /* analytics + uploads */
  analytics: (classId) => request(`/classes/${classId}/analytics`),
  uploadFiles: (files) => {
    const form = new FormData();
    Array.from(files).forEach((file) => form.append('files', file));
    return request('/uploads', { method: 'POST', body: form });
  },
};

export default lmApi;
