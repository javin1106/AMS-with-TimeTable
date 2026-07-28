# Learning Module

A Google-Classroom-style learning platform for XCEED, plus an **AI Studio** that
turns the class audio already captured by the attendance module into lecture
notes, self-study tutorials and auto-graded quizzes.

The module is self-contained. Its only touch points with the rest of the
codebase are:

| What it reuses | Why |
| --- | --- |
| `models/usermanagement/user` | single source of truth for accounts — no parallel user table |
| `JWT_SECRET` cookie / Bearer token | same sign-in as every other module |
| `modules/mailerModule/mailer` | the platform's existing SMTP transport |
| ML service `/recordings*` endpoints | the class recordings live on the ML host, produced by the attendance module's RTSP recorder |

Everything else — models, middleware, controllers, uploads — lives under
`server/src/modules/learningModule/`. No existing module's code was modified;
the only edit outside this folder is the two-line mount in `server/src/routes.js`.

The client half is at `client/src/learningModule/`, mounted from `App.jsx` at
`/learning/*` (one import, one `<Route>`).

---

## Layout

```
server/src/modules/learningModule/
├── models/           lmClass, lmMembership, lmAnnouncement, lmCoursework,
│                     lmSubmission, lmComment, lmQuiz, lmQuizAttempt,
│                     lmAudioSession, lmNotification
├── middleware/       lmAuth.js — authenticate, loadClass, requireTeacher…
├── services/         aiService.js, recordingService.js, notifyService.js
├── controllers/      class, member, stream, comment, coursework, submission,
│                     quiz, audioStudio, notification, dashboard, upload
├── routes/index.js   the whole API surface
└── uploads/          attachment storage (git-ignored)
```

## Roles

Two layers, deliberately separate:

* **Platform role** (from the JWT: `FACULTY`, `STUDENT`, `admin`, …) decides
  only who may *create* a class.
* **Class role** (`lmMembership.role`: `teacher` / `co-teacher` / `student`)
  drives every permission check inside a class — so a faculty member can be a
  student in a colleague's class, and a `admin`/`iams-admin` gets an implicit
  teacher view for support without being enrolled.

## Feature set

**Classes** — create, edit, archive/restore, delete; unguessable 7-character
join code (regenerable); theme colour, section, subject, room, meeting link;
per-class settings for who can post, join approval, grade visibility and email.

**Enrollment** — join by code (with a pre-join preview), bulk invite by email
(existing accounts are enrolled instantly, unknown addresses become invites
claimed on first sign-in), approve/decline join requests, promote to
co-teacher, mute, remove, leave, transfer ownership.

**Stream** — announcements with attachments and links, scheduling, pinning,
targeting specific students, reactions, threaded class comments; classwork
posts interleave automatically.

**Classwork** — assignments, questions (short answer or MCQ), materials and
quizzes, organised into topics; drafts, scheduled release, rubrics, due dates
and late-submission policy.

**Submissions & grading** — per-student rows seeded on publish so nobody is
invisible; draft → turn in → grade → return → reclaim, with an append-only
history; private teacher⇄student comment threads; bulk return; gradebook grid
with class averages and CSV export.

**Quizzes** — manual or AI-generated; MCQ / multi-select / true-false / short
answer; time limit, attempt cap, shuffling, negative marking, pass mark,
availability window; auto-grading that writes straight into the gradebook;
per-question difficulty analysis for the teacher.

**AI Studio** — see below.

**Everywhere else** — cross-class to-do list, month calendar of due dates,
in-app notification feed with email fan-out, and a per-class insights page
(submission rate, late rate, averages, at-risk students).

---

## The AI Studio pipeline

```
attendance module RTSP recorder
        │  (mp4 + audio, on the ML service's disk)
        ▼
GET /recordings                     ← recordingService.listUsableRecordings()
        │
        ▼
lm_audio_session  (one per lecture)
        │
        ├── transcribe ─────────────► LM_TRANSCRIBE_URL   (or paste manually)
        │
        ├── generateNotes    ─┐
        ├── generateTutorial  ├──────► Claude API          (or heuristic fallback)
        └── generateQuiz     ─┘
                 │
                 ▼
        teacher reviews / edits
                 │
                 ├── publish notes    → lm_coursework (material)
                 ├── publish tutorial → lm_coursework (material)
                 └── create quiz      → lm_quiz → publish → lm_coursework (quiz)
                                                  → auto-graded into the gradebook
```

Every generated artefact keeps a `aiSourceSessionId` back-pointer, so a
published note or quiz is always traceable to the lecture it came from.

### Degradation, on purpose

Neither AI nor speech-to-text is required for the module to work:

* **No `LM_AI_API_KEY`** → generation falls back to a dependency-free extractive
  summariser that ranks transcript sentences by keyword weight. The output is
  rougher and is clearly banner-labelled as such, but notes, a tutorial and a
  cloze-style quiz draft are still produced. The UI shows which provider ran.
* **No `LM_TRANSCRIBE_URL`** → the "Transcribe automatically" button returns a
  clear 501 and the teacher pastes or uploads the transcript instead. Every
  downstream step is identical.
* **ML service unreachable** → the recording picker shows the error inline and
  the manual-transcript tab still works.

---

## Configuration

All optional — the module runs without any of them.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LM_AI_API_KEY` / `ANTHROPIC_API_KEY` | – | enables real AI generation |
| `LM_AI_MODEL` | `claude-sonnet-4-5` | model used for generation |
| `LM_AI_API_URL` | `https://api.anthropic.com/v1/messages` | override for a proxy |
| `LM_AI_MAX_CHARS` | `120000` | transcript truncation guard |
| `LM_AI_TIMEOUT_MS` | `120000` | per-request timeout |
| `LM_TRANSCRIBE_URL` | – | speech-to-text endpoint: takes `{filename, audioUrl, language}`, returns `{text, language?, segments?}` |
| `LM_TRANSCRIBE_TIMEOUT_MS` | `900000` | transcription can be slow |
| `LM_MAX_UPLOAD_BYTES` | `52428800` (50 MB) | attachment size cap |
| `ML_SERVICE_URL` | `http://localhost:8500` | already used by the attendance module |

---

## API

Base path: `/api/v1/learningmodule`. Every route requires a signed-in user.
Routes under `/classes/:classId/…` additionally resolve class membership; those
marked **T** require a teacher or co-teacher in that class.

### Account level

```
GET    /me                       current user as this module sees them
GET    /overview                 counts for the dashboard tiles
GET    /todo                     cross-class assigned / missing / done / to-review
GET    /calendar?from&to         due dates across all classes
GET    /notifications            feed + unread count
POST   /notifications/read       mark some or all read
DELETE /notifications/read       clear read notifications
DELETE /notifications/:id
GET    /classes?status=          classes the caller teaches or is in
POST   /classes                  create (faculty/admin only)
GET    /classes/all              admin-wide listing
POST   /join                     join by code
POST   /claim-invites            claim email-only invites for this account
GET    /preview/:code            pre-join class preview
POST   /uploads                  multipart attachment upload (max 10 × 50 MB)
GET    /files/:filename          serve an uploaded attachment
```

### Class level — `/classes/:classId`

```
GET    /                         class + my role + counts
PATCH  /                     T   edit details and settings
POST   /archive              T   archive / restore
POST   /code/regenerate      T   new join code
DELETE /                  owner  delete the class and everything in it
POST   /leave                    leave the class

GET    /topics                   list
POST   /topics               T   create
PATCH  /topics/:topicId      T   rename / reorder
DELETE /topics/:topicId      T   delete (items fall back to untopiced)

GET    /members                  roster (teachers see pending/invited too)
POST   /members/invite       T   bulk invite by email
POST   /members/:id/decide   T   approve / decline a join request
PATCH  /members/:id          T   role, mute, roll number
DELETE /members/:id          T   remove
GET    /members/:id/progress T   one student's submissions and totals
POST   /members/:id/transfer-ownership   owner only

GET    /stream                   announcements + classwork, newest first
POST   /announcements            post (respects whoCanPost)
PATCH  /announcements/:id        edit own post; teachers can pin
DELETE /announcements/:id
POST   /announcements/:id/react  toggle a reaction

GET    /comments/:targetType/:targetId    announcement | coursework | submission
POST   /comments/:targetType/:targetId
PATCH  /comments/:commentId
DELETE /comments/:commentId

GET    /coursework?workType&topicId
POST   /coursework           T   assignment | question | material | quiz
GET    /coursework/:id           detail (students get their own submission)
PATCH  /coursework/:id       T
DELETE /coursework/:id       T
GET    /coursework/:id/submissions   T   the grading grid

POST   /coursework/:id/draft     save without handing in
POST   /coursework/:id/turn-in
POST   /coursework/:id/unsubmit

PATCH  /submissions/:id/grade    T
POST   /submissions/return       T   bulk return (makes grades visible)
POST   /submissions/:id/reclaim  T   pull back for regrading
GET    /gradebook                    grid (students see only their row)
GET    /gradebook.csv            T   CSV export
POST   /gradebook/bulk           T   bulk grade entry

GET    /quizzes                      (students never receive the answer key)
POST   /quizzes              T
GET    /quizzes/:quizId
PATCH  /quizzes/:quizId      T
DELETE /quizzes/:quizId      T
POST   /quizzes/:quizId/publish  T   also creates/updates the Classwork item
GET    /quizzes/:quizId/results  T   attempts + per-question analysis
POST   /quizzes/:quizId/attempts     start (resumes an in-progress attempt)
POST   /attempts/:attemptId/submit   auto-grade and mirror into the gradebook
GET    /attempts/:attemptId

GET    /studio/status                    T   which providers are configured
GET    /studio/recordings                T   attendance-module recordings
GET    /studio/recordings/:file/audio    T   stream the extracted mp3
GET    /studio/sessions                      teachers: all; students: published only
POST   /studio/sessions                  T   create from a recording or a transcript
GET    /studio/sessions/:id
PATCH  /studio/sessions/:id              T   edit transcript / notes / tutorial / draft
DELETE /studio/sessions/:id              T
POST   /studio/sessions/:id/transcribe   T
POST   /studio/sessions/:id/generate     T   artefacts: notes | tutorial | quiz
POST   /studio/sessions/:id/ask              Q&A grounded in the transcript
POST   /studio/sessions/:id/publish/notes    T
POST   /studio/sessions/:id/publish/tutorial T
POST   /studio/sessions/:id/publish/quiz     T   draft → real quiz

GET    /analytics                T   class insights
```

## Notes on a few decisions

* **Scheduled posts** are released lazily on the next stream read rather than by
  a cron job — no scheduler to keep alive, and behaviour survives a restart.
* **Submission rows are seeded at publish time** so the gradebook shows students
  who have handed in nothing; a student who joins later gets a row on first view.
* **Grades only become visible when work is *returned***, matching Classroom, so
  a teacher can mark at their own pace.
* **Uploads are stored under a random filename** with the original kept only as
  display metadata, served with `nosniff` and a `sandbox` CSP, and executable
  extensions are rejected outright.
* **Quiz answer keys are stripped server-side** on every student-facing read —
  the client is never trusted to hide them.
