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

**Parameterised tutorials** — see below.

**AI Studio** — see below.

**Everywhere else** — cross-class to-do list, month calendar of due dates,
in-app notification feed with email fan-out, and a per-class insights page
(submission rate, late rate, averages, at-risk students).

---

## Parameterised tutorials

A teacher authors a numerical question **once**, with variables and ranges, and
every student is given their own figures. Answers are marked against a formula
rather than a fixed key, so copying a classmate's final number is useless while
comparing method still works.

```
lm_tutorial (authored once)
  question
    prompt      "A resistor of {{R}} Ω carries {{I}} A. Find the power."
    variables   R: integer 10–100 step 5     I: decimal 0.5–3 step 0.5
    constraint  R > 0                        ← re-draws until true
    answers     Power = I^2*R   ±1%   5 marks
    solution    "P = I²R = {{I}}² × {{R}}"
        │
        ▼   generateVariant(tutorial, studentId, attemptNumber)
lm_tutorial_attempt (one per student per attempt)
    seed        sha256(tutorialId|studentId|attemptNumber) → mulberry32
    values      { R: 45, I: 1.5 }
    prompt      "A resistor of 45 Ω carries 1.5 A. Find the power."
    expected    [{ key: 'p', value: 101.25, marks: 5 }]
        │
        ▼   student types an answer (a number, or "45*1.5^2")
    responses   [{ raw: '101.3', value: 101.3, correct: true, awarded: 5 }]
        │
        └──►  mirrored into lm_submission, so it lands in the gradebook
              alongside every other piece of classwork
```

### Design decisions worth knowing

**Formulas are never `eval`'d.** A teacher-authored formula is untrusted input
executed on the server, so `services/formulaEngine.js` is a hand-written
tokeniser + recursive-descent parser with an explicit function whitelist.
There is no property access, no assignment and no way to reach the JS runtime;
the test suite asserts that for `process.exit(1)`, `require("fs")`,
`constructor.constructor`, arrow functions and eight other escape shapes.

**Values are deterministic, and also persisted.** The seed is derived from
`(tutorialId, studentId, attemptNumber)`, so a reload gives the same paper. But
the drawn values, the rendered prompt and the computed expected answers are all
*stored on the attempt* — the seed is only a reproducibility aid. That means a
teacher editing a question or its formula afterwards cannot retroactively change
what an in-progress student was asked, nor silently re-mark submitted work.

**Constraints prevent unanswerable papers.** Random values can produce a
divide-by-zero or the root of a negative. A question may declare a constraint
(`b != c`, `R > 0`) which generation re-rolls until satisfied. Publishing samples
five variants first and **refuses** to publish if any of them fails, so the
failure surfaces to the teacher rather than to a student. If a constraint proves
unsatisfiable at generation time the student still gets a usable paper and the
teacher gets a warning on the results page.

**Marking is tolerance-based, on two axes.** Each answer carries a relative
tolerance (default 1%) and an absolute one; the allowance is the larger of the
two. The absolute floor matters because 1% of `0.0001` is impossible to hit.
Students may type an expression (`2*pi*3`) rather than pre-computing, parsed by
the same safe engine.

**Method analysis, not answer analysis.** Since no two students share figures,
the teacher's results page reports the success rate *per answer slot* across the
class — a low percentage means the method needs revisiting, which a single
correct value could never tell you. Manual mark adjustment with feedback sits on
top of auto-marking for partial credit.

## Rich text authoring

Every authoring surface uses a Quill-based editor (`components/RichTextEditor`):
question stems, MCQ options, explanations, tutorial prompts, hints and worked
solutions, announcements, and assignment/material content. react-quill was
chosen because the quiz module already uses it, so staff meet one editor rather
than three. Formatting, sub/superscripts, lists, tables, links and inline
images (including pasted diagrams) are supported.

**Sanitisation happens at render time, not on save.** `components/RichText`
runs DOMPurify with an explicit tag/attribute allowlist every time content is
displayed. That is the correct boundary: the client cannot be trusted, since
anyone can POST raw HTML straight to the API, so validating on the way in would
not actually protect a reader. Scripts, inline handlers, iframes, forms and
`javascript:` URLs are all stripped — asserted by tests.

`RichText` handles three content shapes, because the module predates the editor
and AI generation emits Markdown:

| Shape | Route | Where it comes from |
| --- | --- | --- |
| HTML | sanitised and rendered | anything the editor produced |
| Markdown | `<Markdown>` | AI-generated notes and tutorials |
| plain text | rendered with newlines kept | older posts, pasted text |

Two consequences worth knowing:

- **Empty checks must not use `.trim()`.** Quill's empty document is
  `<p><br></p>`, which is truthy. Use `isRichTextEmpty()` from
  `richTextUtils.js`; the server applies the same rule via `stripTags`.
- **Placeholders can be broken by formatting.** Bolding half of `{{R}}` stores
  `{{<strong>R</strong>}}`, which the substitution regex will never match. The
  editor's variable buttons insert placeholders as plain text to avoid this, and
  the server rejects a split placeholder at save time with a message telling the
  teacher to re-insert it.

Notification and email bodies are flattened to plain text and HTML-escaped
before being stored or mailed, so a rich-text excerpt cannot corrupt (or inject
into) an email body.

## Account provisioning on invite

Inviting an unknown email address can create the platform account for it. There
is deliberately **no second login system**: a provisioned account is an ordinary
platform account (bcrypt password, JWT cookie, same `/login`), created by a
teacher instead of an admin.

- The account is created with a **random 32-byte password nobody ever learns**,
  so it cannot be signed into until claimed. No password is ever emailed.
- The invitee receives the platform's existing welcome email and sets their own
  password through the existing OTP flow at `/forgot-password`.
- A teacher may only grant `STUDENT` (for students) or `FACULTY` (for
  co-teachers). Anything above that stays an administrator's decision, so a
  compromised teacher account cannot escalate anyone.
- Roles are **not** added to accounts that already exist unless the teacher
  explicitly ticks that option — silently changing someone's platform roles
  because they were added to a class is a surprise.
- Provisioning is idempotent and race-safe: a duplicate-key collision from a
  concurrent invite re-reads the winner rather than reporting a failure.

Turn it off per-invite and the old behaviour applies: an `invited` membership row
is stored and claimed on that person's first sign-in.

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
POST   /members/invite       T   bulk invite by email; `createAccounts` (default
                                 true) provisions platform accounts for unknown
                                 addresses, `grantRoleToExisting` (default false)
                                 adds the role to accounts that lack it
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

GET    /tutorials                            parameterised tutorials
POST   /tutorials                        T   create
GET    /tutorials/formula-reference           whitelisted functions/constants
POST   /tutorials/validate-formula       T   authoring-time formula check
GET    /tutorials/:id                        teachers get formulas, students do not
PATCH  /tutorials/:id                    T
DELETE /tutorials/:id                    T
POST   /tutorials/:id/preview            T   roll sample papers
POST   /tutorials/:id/publish            T   validates generation first
GET    /tutorials/:id/results            T   per-answer method analysis
GET    /tutorials/:id/attempt                get-or-create the caller's variant
POST   /tutorial-attempts/:id/save           save a draft
POST   /tutorial-attempts/:id/submit         auto-mark against stored expected values
POST   /tutorial-attempts/:id/adjust     T   manual override + feedback

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
