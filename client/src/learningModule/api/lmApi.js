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

async function request(path, { method = 'GET', body, raw = false, signal } = {}) {
  const options = {
    method,
    credentials: 'include',
    headers: {},
    signal,
  };

  const token = localStorage.getItem('token');
  if (token) options.headers.Authorization = `Bearer ${token}`;

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
  inviteMembers: (classId, emails, role) =>
    request(`/classes/${classId}/members/invite`, { method: 'POST', body: { emails, role } }),
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

  /* quizzes */
  listQuizzes: (classId) => request(`/classes/${classId}/quizzes`),
  createQuiz: (classId, body) => request(`/classes/${classId}/quizzes`, { method: 'POST', body }),
  getQuiz: (classId, quizId) => request(`/classes/${classId}/quizzes/${quizId}`),
  updateQuiz: (classId, quizId, body) => request(`/classes/${classId}/quizzes/${quizId}`, { method: 'PATCH', body }),
  deleteQuiz: (classId, quizId) => request(`/classes/${classId}/quizzes/${quizId}`, { method: 'DELETE' }),
  publishQuiz: (classId, quizId, body) =>
    request(`/classes/${classId}/quizzes/${quizId}/publish`, { method: 'POST', body: body || {} }),
  quizResults: (classId, quizId) => request(`/classes/${classId}/quizzes/${quizId}/results`),
  startAttempt: (classId, quizId) =>
    request(`/classes/${classId}/quizzes/${quizId}/attempts`, { method: 'POST', body: {} }),
  submitAttempt: (classId, attemptId, answers) =>
    request(`/classes/${classId}/attempts/${attemptId}/submit`, { method: 'POST', body: { answers } }),
  getAttempt: (classId, attemptId) => request(`/classes/${classId}/attempts/${attemptId}`),

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
  publishTutorial: (classId, sessionId, body) =>
    request(`/classes/${classId}/studio/sessions/${sessionId}/publish/tutorial`, { method: 'POST', body: body || {} }),
  publishQuizDraft: (classId, sessionId, body) =>
    request(`/classes/${classId}/studio/sessions/${sessionId}/publish/quiz`, { method: 'POST', body: body || {} }),

  /* analytics + uploads */
  analytics: (classId) => request(`/classes/${classId}/analytics`),
  uploadFiles: (files) => {
    const form = new FormData();
    Array.from(files).forEach((file) => form.append('files', file));
    return request('/uploads', { method: 'POST', body: form });
  },
};

export default lmApi;
