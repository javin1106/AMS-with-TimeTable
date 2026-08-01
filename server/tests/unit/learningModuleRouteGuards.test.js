/**
 * Pins which learning-module endpoints require class staff.
 *
 * The guards themselves live in `routes/index.js` as `requireTeacher`, and the
 * failure mode this file exists for is quiet: somebody adds a route next to a
 * guarded one, forgets the middleware, and every student in the class can read
 * an answer key. Nothing else in the suite would notice, because the handler
 * works perfectly — it just answers the wrong people.
 *
 * So the manifest below is the contract. Adding an endpoint means adding a line
 * here and saying which side of the line it is on, which is exactly the moment
 * to think about it.
 *
 * Read off the live Express router rather than the source text, so a guard that
 * is present but wired in the wrong order still fails.
 */

/**
 * Rebuilds a mount path from an Express layer.
 *
 * Express discards the string passed to `router.use`, keeping only a regexp and
 * an ordered list of param names. Reconstructing from `layer.keys` rather than
 * unpicking the regexp source means this keeps working when Express changes how
 * it compiles paths.
 */
function mountPath(layer) {
  const keys = layer.keys || [];
  let index = 0;
  return (layer.regexp?.source || '')
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\?\/\|\$\)$/, '')
    .replace(/\(\?:\\?\/\(\[\^[/\\]+\]\+\?\)\)/g, () => `/:${keys[index++]?.name ?? 'param'}`)
    .replace(/\\\//g, '/')
    .replace(/\$$/, '');
}

/** Walks an Express router and returns `{ 'GET /path': [middlewareNames] }`. */
function collectRoutes(router, prefix = '') {
  const found = {};

  (router.stack || []).forEach((layer) => {
    if (layer.route) {
      const path = prefix + layer.route.path;
      const names = layer.route.stack.map((entry) => entry.name);
      Object.keys(layer.route.methods).forEach((method) => {
        found[`${method.toUpperCase()} ${path}`] = names;
      });
      return;
    }

    if (layer.name === 'router' && layer.handle?.stack) {
      Object.assign(found, collectRoutes(layer.handle, prefix + mountPath(layer)));
    }
  });

  return found;
}

const learningRouter = require('../../src/modules/learningModule/routes/index');
// A route mounted at the router root reads as `…/classes/:classId/` with a
// trailing slash; trim it so the keys match how the endpoints are written.
const table = Object.fromEntries(
  Object.entries(collectRoutes(learningRouter)).map(([key, value]) => [
    key.length > 1 && key.endsWith('/') ? key.slice(0, -1) : key,
    value,
  ]),
);

const guarded = (key) => (table[key] || []).includes('requireTeacher');
const exists = (key) => Object.prototype.hasOwnProperty.call(table, key);

const C = '/classes/:classId';

// Endpoints that expose an answer key, another student's work, or the ability to
// change what the class sees.
const TEACHER_ONLY = [
  `POST ${C}/notebooks`,
  `PATCH ${C}/notebooks/:notebookId`,
  `DELETE ${C}/notebooks/:notebookId`,
  `GET ${C}/notebooks/:notebookId`,
  `POST ${C}/notebooks/:notebookId/publish`,
  `GET ${C}/notebooks/:notebookId/attempts`,
  `POST ${C}/notebook-attempts/:attemptId/reopen`,
  `PATCH ${C}/notebook-attempts/:attemptId/grade`,

  `POST ${C}/shorts`,
  `PATCH ${C}/shorts/:shortId`,
  `DELETE ${C}/shorts/:shortId`,
  `POST ${C}/shorts/:shortId/present`,
  `GET ${C}/shorts/:shortId/sessions`,
  `POST ${C}/short-sessions/:sessionId/control`,
  `POST ${C}/short-sessions/:sessionId/end`,
  `GET ${C}/short-sessions/:sessionId/stream`,
  `GET ${C}/short-sessions/:sessionId/report`,
  `GET ${C}/short-sessions/:sessionId/report.csv`,

  `POST ${C}/quizzes`,
  `POST ${C}/attempts/:attemptId/reopen`,
  `DELETE ${C}/attempts/:attemptId`,
  `GET ${C}/quizzes/:quizId/results`,
  `GET ${C}/quizzes/:quizId/results.csv`,

  `POST ${C}/tutorials`,
  `PATCH ${C}/tutorials/:tutorialId`,
  `DELETE ${C}/tutorials/:tutorialId`,
  `POST ${C}/tutorials/:tutorialId/publish`,
  `GET ${C}/tutorials/:tutorialId/results`,
  `POST ${C}/tutorial-attempts/:attemptId/adjust`,

  `POST ${C}/coursework`,
  `PATCH ${C}/coursework/:courseworkId`,
  `DELETE ${C}/coursework/:courseworkId`,
  `GET ${C}/coursework/:courseworkId/submissions`,

  `PATCH ${C}/submissions/:submissionId/grade`,
  `POST ${C}/submissions/return`,
  `GET ${C}/gradebook.csv`,
  `POST ${C}/gradebook/bulk`,

  `POST ${C}/members/invite`,
  `PATCH ${C}/members/:membershipId`,
  `DELETE ${C}/members/:membershipId`,
  `GET ${C}/members/:membershipId/progress`,

  `GET ${C}/analytics`,

  `PATCH ${C}/feedback/:feedbackId`,

  `POST ${C}/archive`,
  `POST ${C}/code/regenerate`,
  `POST ${C}/topics`,
  `PATCH ${C}/topics/:topicId`,
  `DELETE ${C}/topics/:topicId`,
  `POST ${C}/members/:membershipId/decide`,
  `POST ${C}/submissions/:submissionId/reclaim`,
  `POST ${C}/quizzes/:quizId/collaborators`,
  `GET ${C}/short-sessions/:sessionId/state`,
  `POST ${C}/tutorials/validate-formula`,
  `POST ${C}/tutorials/:tutorialId/preview`,

  `GET ${C}/studio/status`,
  `GET ${C}/studio/recordings`,
  `GET ${C}/studio/recordings/:filename/audio`,
  `POST ${C}/studio/sessions`,
  `PATCH ${C}/studio/sessions/:sessionId`,
  `DELETE ${C}/studio/sessions/:sessionId`,
  `POST ${C}/studio/sessions/:sessionId/transcribe`,
  `POST ${C}/studio/sessions/:sessionId/generate`,
  `POST ${C}/studio/sessions/:sessionId/publish/notes`,
  `POST ${C}/studio/sessions/:sessionId/publish/tutorial`,
  `POST ${C}/studio/sessions/:sessionId/publish/quiz`,
];

/**
 * Endpoints a student legitimately reaches. Each one narrows its own response —
 * the note says what the controller is relied on to withhold, because the route
 * table alone cannot express it.
 */
const STUDENT_REACHABLE = [
  [`GET ${C}/notebooks`, 'unpublished notebooks filtered out of the query'],
  [`GET ${C}/notebooks/:notebookId/attempt`, '403 unless published; seeds the caller their own copy'],
  [`GET ${C}/notebook-attempts/:attemptId`, 'ownership checked in the handler'],
  [`POST ${C}/notebook-attempts/:attemptId/save`, 'ownership checked in the handler'],
  [`GET ${C}/shorts`, 'slides and answer key stripped for non-staff'],
  [`GET ${C}/shorts/:shortId`, 'returns title only for non-staff'],
  [`GET ${C}/quizzes`, 'filtered to published'],
  [`GET ${C}/quizzes/:quizId`, '404 on unpublished; forStudent() drops the key'],
  [`GET ${C}/attempts/:attemptId`, 'ownership checked; review withheld until released'],
  [`GET ${C}/tutorials/:tutorialId`, 'formulas — the answer key — withheld from students'],
  [`GET ${C}/gradebook`, 'scoped to the caller, and 403 when the class hides grades'],
  [`GET ${C}/members`, 'roster only; classmates’ emails withheld'],
  [`GET ${C}/coursework/:courseworkId`, '404 on drafts; audience enforced'],
  [`GET ${C}/studio/sessions/:sessionId`, 'transcript and quiz draft withheld'],
  [`GET ${C}/studio/sessions`, 'filtered to lectures whose material was published'],
  [`POST ${C}/studio/sessions/:sessionId/ask`, '403 unless the lecture was published to them'],

  [
    `GET ${C}/feedback`,
    'students get only their own notes; staff get the class’s with every identifying field stripped by forTeacher()',
  ],
  [`POST ${C}/feedback`, 'requireClassStudent; the word filter and the strike ladder run before anything is written'],
  [
    `DELETE ${C}/feedback/:feedbackId`,
    'platform-admin-only, checked in the handler — requireTeacher here would let the staff member a complaint is about delete it',
  ],

  [`GET ${C}/topics`, 'topic names are not sensitive'],
  [`POST ${C}/leave`, 'acts on the caller’s own membership'],
  [`GET ${C}/stream`, 'drafts and scheduled posts filtered out; audience enforced'],
  [`POST ${C}/announcements`, 'canPost() honours the class’s allowStudentPosts setting'],
  [`PATCH ${C}/announcements/:announcementId`, 'author-or-staff checked in the handler'],
  [`DELETE ${C}/announcements/:announcementId`, 'author-or-staff checked in the handler'],
  [`POST ${C}/announcements/:announcementId/react`, 'a reaction is the caller’s own'],
  [`GET ${C}/comments/:targetType/:targetId`, 'private threads scoped to the caller'],
  [`POST ${C}/comments/:targetType/:targetId`, 'posts as the caller'],
  [`PATCH ${C}/comments/:commentId`, 'author-only, checked in the handler'],
  [`DELETE ${C}/comments/:commentId`, 'author-or-staff, checked in the handler'],
  [`GET ${C}/coursework`, 'filtered to published, and to the caller’s audience'],
  [`POST ${C}/coursework/:courseworkId/draft`, 'writes the caller’s own submission'],
  [`POST ${C}/coursework/:courseworkId/turn-in`, 'writes the caller’s own submission'],
  [`POST ${C}/coursework/:courseworkId/unsubmit`, 'writes the caller’s own submission'],

  // Quiz authoring is open at the router because a named collaborator may edit
  // a quiz without being class staff. `canManage` is the real check.
  [`PATCH ${C}/quizzes/:quizId`, 'canManage(): staff or a named collaborator'],
  [`DELETE ${C}/quizzes/:quizId`, 'canManage(): staff or a named collaborator'],
  [`POST ${C}/quizzes/:quizId/publish`, 'canManage(): staff or a named collaborator'],
  [`DELETE ${C}/quizzes/:quizId/responses`, 'canManage(): staff or a named collaborator'],

  [`GET ${C}/quizzes/:quizId/brief`, 'rules and timings only, no questions'],
  [`POST ${C}/quizzes/:quizId/attempts`, 'starts the caller’s own attempt'],
  [`GET ${C}/attempts/:attemptId/paper`, 'ownership checked in the handler'],
  [`GET ${C}/attempts/:attemptId/current`, 'ownership checked in the handler'],
  [`POST ${C}/attempts/:attemptId/answer`, 'ownership checked in the handler'],
  [`POST ${C}/attempts/:attemptId/save`, 'ownership checked in the handler'],
  [`POST ${C}/attempts/:attemptId/violation`, 'the caller reporting on their own sitting'],
  [`POST ${C}/attempts/:attemptId/submit`, 'ownership checked in the handler'],

  [`POST ${C}/notebook-attempts/:attemptId/submit`, 'ownership checked in the handler'],
  [`GET ${C}/tutorials`, 'filtered to published'],
  [`GET ${C}/tutorials/formula-reference`, 'the whitelist of functions, not any answer'],
  [`GET ${C}/tutorials/:tutorialId/attempt`, 'seeds the caller their own variant'],
  [`POST ${C}/tutorial-attempts/:attemptId/save`, 'query is scoped to the caller’s studentId'],
  [`POST ${C}/tutorial-attempts/:attemptId/submit`, 'query is scoped to the caller’s studentId'],
];

describe('learningModule route guards — staff-only endpoints', () => {
  TEACHER_ONLY.forEach((key) => {
    it(`${key} requires class staff`, () => {
      expect(exists(key)).toBe(true);
      expect(guarded(key)).toBe(true);
    });
  });
});

describe('learningModule route guards — student-reachable endpoints', () => {
  STUDENT_REACHABLE.forEach(([key, why]) => {
    it(`${key} is open to students — ${why}`, () => {
      expect(exists(key)).toBe(true);
      expect(guarded(key)).toBe(false);
    });
  });
});

describe('learningModule route guards — the manifest is complete', () => {
  it('accounts for every class-scoped route', () => {
    // The point of the suite: a new endpoint fails here until somebody has
    // decided, in writing, who may call it.
    const classScoped = Object.keys(table).filter((key) => key.includes('/classes/:classId/'));
    const accounted = new Set([...TEACHER_ONLY, ...STUDENT_REACHABLE.map(([key]) => key)]);

    // Routes guarded by requireOwner are staff-by-construction and need no
    // separate entry.
    const unaccounted = classScoped.filter(
      (key) => !accounted.has(key) && !(table[key] || []).includes('requireOwner'),
    );

    const guardedButUnlisted = unaccounted.filter((key) => guarded(key));
    const openAndUnlisted = unaccounted.filter((key) => !guarded(key));

    // Reported separately: an unlisted *open* route is the dangerous kind.
    expect({ openAndUnlisted, guardedButUnlisted }).toEqual({
      openAndUnlisted: [],
      guardedButUnlisted: [],
    });
  });
});

describe('learningModule route guards — the participant routes', () => {
  it('keeps the Shorts join/answer endpoints outside the class router', () => {
    // They take a join code, not a classId, so `loadClass` cannot run and the
    // membership check has to live in the controller. If one of these ever
    // appears under /classes/:classId, that reasoning has silently changed.
    ['POST /shorts/join/:code', 'GET /shorts/live/:sessionId', 'POST /shorts/live/:sessionId/answer'].forEach(
      (key) => {
        expect(exists(key)).toBe(true);
        expect(table[key]).toContain('authenticateOptional');
      },
    );
  });
});
