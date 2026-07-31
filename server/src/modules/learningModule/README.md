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
│                     lmTutorial, lmTutorialAttempt, lmAudioSession,
│                     lmNotification, lmShort, lmShortSession, lmShortResponse
├── middleware/       lmAuth.js — authenticate, loadClass, requireTeacher…
├── services/         aiService, recordingService, notifyService, formulaEngine,
│                     variantGenerator, examEngine, shortsAggregator
├── controllers/      class, member, stream, comment, coursework, submission,
│                     quiz, tutorial, shorts, audioStudio, notification,
│                     dashboard, upload
├── routes/index.js   the whole API surface
└── uploads/          attachment storage (git-ignored)
```

```
client/src/learningModule/
├── api/lmApi.js      one request() helper; every endpoint
├── components/       common, Markdown, RichText, RichTextEditor, Attachments,
│                     CommentThread, LearningLayout, NotificationBell,
│                     QuizReview, ShortResults
├── hooks/            useProctoring, useShortStream
├── pages/            dashboard, class tabs, quiz, tutorial and shorts screens
└── LearningRoutes.jsx  everything under /learning/*
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

**Shorts** — live in-class polling: a deck of instant questions, a six-digit
join code on the projector, and the room's answers on screen within seconds.
See below.

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

## Quiz / online-test options

The option set matches the aim2Crack exam engine, so a placement-style test can
be run from this module. Everything below is per-quiz.

### Delivery methodology

| Mode | Behaviour |
| --- | --- |
| `all_at_once` (default) | every question on one page, free navigation, one clock |
| `one_at_a_time` | the server hands out one question at a time and keeps the cursor |

In `one_at_a_time`, `allowBacktracking` decides whether a delivered question can
be revisited (off = placement-test behaviour). The cursor, the dealt paper and
every answer live on the attempt document, so **a refresh, a crashed tab or a
dropped connection resumes exactly where it left off** rather than restarting or
losing the sitting.

### Timing

- `perQuestionTiming` — each question gets its own countdown and auto-submits on
  expiry; otherwise one clock covers the paper.
- `timeLimitMinutes` — whole-paper limit, also the fallback for any question
  without its own clock.
- `marginMinutes` — late-entry window. The test stays open for those already
  sitting it while turning away anyone arriving after it; that separation is the
  whole point of the setting.
- `availableFrom` / `availableTo` — the open window.
- `resultReleaseAt` — scores stay hidden after submitting until this moment, so a
  cohort is released together.

The effective deadline for a question is the *earliest* of its own clock, the
paper clock and the close time — and it is computed server-side from when the
question was served, so reloading cannot reset it.

### Question types and marking

Five types: `mcq` (single), `msq` (multiple), `truefalse`, `numerical`, `short`.
The aim2Crack names `single` / `multiple` / `integer` are accepted on input and
translated, so questions can be imported without rewriting.

- Per-question `marks`, `difficulty`, `topic`, `timeLimitSec`, `sectionId`.
- Per-question `negativeMarks`, falling back to the quiz-wide `negativeMarking`.
  **An unattempted question is never penalised** — that is what makes leaving one
  blank a real choice.
- `numerical` answers are marked against a relative *and* absolute tolerance
  (the larger wins), because a percentage alone cannot mark an answer near zero.
- A negatively-marked wipeout clamps to zero in the gradebook, while the raw
  figure is kept for the teacher.

### Sections

Named sections with their own notes. Question order is only ever shuffled
*within* a section — moving a question across sections would break the section
timings and the student's mental model of the paper.

### Randomisation

- `shuffleQuestions` — per-student order, deterministic from
  `(quizId, studentId, attemptNumber)`.
- `shuffleOptions` — per-student option order. Stored answers always refer to the
  *original* indices, so marking is unaffected; True/False is left alone.
- `questionsPerAttempt` — draw N at random from the bank per student, with
  `totalMarks` scaled to the drawn paper.

### Proctoring

Deterrents, not guarantees — a determined student defeats any of them with
devtools. What makes them useful is that **every event is recorded on the
attempt** for the teacher to review, and the enforcement decision is the
server's, not the browser's.

- `preventMobile` — checked server-side from the User-Agent when starting.
- `allowTabChange` / `maxTabSwitches` / `autoSubmitOnTabLimit` — tab and window
  blur is counted; passing the budget warns, or ends the attempt if configured.
- `requireFullscreen` — the sitting is gated behind fullscreen, and exits are
  recorded.
- `disableCopyPaste`, `disableRightClick`.

Every event lands in `attempt.violations` with a timestamp, and terminated
attempts carry a `terminationReason`.

### Collaborators

A quiz may name co-authors by email who can edit *that quiz* without being class
teachers. Only a class teacher can change the collaborator list.

### Analytics

- Per attempt: score, percent, pass/fail, correct / wrong / unattempted, marks
  lost to negatives, duration, tab switches, flags, device.
- Per question: success rate **over students who attempted it**, with skip rate
  reported separately so a widely-skipped question does not masquerade as a hard
  one; plus average time spent.
- Per section: score, correct/wrong/skipped, average time per student.
- Score distribution in five bands, median / highest / lowest.
- Full CSV export: one row per attempt, with a column per section and per
  question.
- `DELETE …/responses` clears every attempt so the same cohort can re-sit,
  resetting their gradebook rows too.

### Student flow

```
/quiz/:quizId                        brief — rules, timings, eligibility, countdowns
      │  Start (blocked by window, margin, device, attempts)
      ▼
/quiz/:quizId/attempt/:attemptId     the sitting (either delivery mode)
      │  submit, auto-submit on expiry, or termination
      ▼                              score + per-question review (if released)
```

## Shorts — live in-class polling

A **Short** is a deck of instant questions a teacher runs from the front of the
room while students answer on their phones. It is deliberately *not* a quiz: no
availability window, no attempt cap, no gradebook row unless asked for. The
point is the room seeing its own answers within seconds.

### Why it is separate from quizzes

A quiz is an assessment — window, attempts, proctoring, marks. A temperature
check in the middle of a lecture has none of that, and folding the two together
would mean every warm-up poll asking the teacher to pick a due date and a pass
mark. Shorts share the module's auth, membership and rich-text authoring, and
nothing else.

### Slide types

| Type | Answer | Aggregated as | Can be marked |
|---|---|---|---|
| `mcq` | one option | bar chart | yes |
| `msq` | any options | bar chart (bars can exceed 100% — the denominator is people, not selections) | yes |
| `truefalse` | one of two fixed options | bar chart | yes |
| `wordcloud` | a word or three | frequency-sized cloud, stop words dropped | no |
| `scale` | a value on min..max | histogram + mean and median | no |
| `open` | a sentence or two | cards | no |
| `ranking` | the options in order | Borda count | yes (exact sequence) |
| `numeric` | a number | mean, median, spread over 10 buckets | yes, with ± tolerance |

A slide with no answer key is a poll and is never marked. Word clouds, scales
and open text are opinions, so they are never markable at all.

### The state machine

One `lm_short` (the reusable deck) has many `lm_short_session`s (one per run).
Sessions exist because the same warm-up gets presented to two sections on the
same morning; without a per-run record the second class's answers would pile on
top of the first's, and the join code would stay live long after the lecture.

The presenter drives a single endpoint (`POST …/control`) rather than several,
because the controls *are* one state machine and splitting them invites the
client into an inconsistent intermediate state:

```
waiting ──open──▶ open ──lock──▶ locked ──reveal──▶ revealed
   ▲                                 │                  │
   └──── next / previous / goto ◀─────┴──── reopen ◀─────┘
```

- `waiting` — the slide is up, answers are not accepted yet
- `open` — accepting answers; a countdown runs if the slide has a time limit
- `locked` — closed, tally shown, answer key withheld
- `revealed` — closed, tally plus the correct answer and explanation

`autoRevealOnClose` (default on) makes `lock` land straight on `revealed`.

**A slide with a countdown closes itself.** When `slideDeadline` passes, the
slide moves to `revealed` (or `locked` if the deck turned auto-reveal off)
without the teacher pressing anything — so a 30-second question shows its answer
at zero, which is what the countdown implies.

Nothing polls a timer to make this happen. `services/shortsAggregator.js`
exposes `effectiveSlideState(session, short, now)`, and **every read derives the
state from the stored deadline**: a server-side timer would have to survive a
restart, and a timer in the presenter's browser stops when the laptop sleeps,
whereas a stored timestamp is right regardless of who is awake. Deriving it on
read is also what makes a student's phone stop offering an answer at the instant
the clock passes rather than whenever the next write lands.

`settleExpiredSlide` then persists the transition so the stored state does not
drift from what the room can already see. It is called from every path that
loads a live session, including each SSE tick — which is what pushes the reveal
out to the room. The write is conditional on the row still being `open`, so when
the presenter's stream and forty phones all notice the same expiry within the
same second, exactly one of them bumps `revision`.

The client applies the same rule locally (`ShortPlay` trips an `expired` flag on
a timer) because the stream can be up to a tick behind, and offering a Send
button that is going to come back rejected is worse than disabling it early. The
server still has the final say.

### Join codes

Six digits, because the code is read off a projector at the back of a lecture
hall and typed on a phone keypad. It lives on the *session*, not the deck, so it
only works while something is actually being presented, and it is unique only
among live sessions — a partial index on `{ joinCode: 1 }` filtered to
`status: 'live'` — so codes recycle naturally instead of the space filling up.

`POST /shorts/join/:code` and the participant endpoints sit **outside** the
`/classes/:classId` router: somebody who just scanned the QR has a code and
nothing else. Class membership is enforced inside the controller once the code
resolves to a session.

### What the room sees vs. what a phone sees

The participant payload is deliberately narrower than the presenter's. No answer
key unless `slideState === 'revealed'`, and no tally at all unless the deck sets
`showResultsToStudents`. Both come from the same aggregator, so the projector
and the phones can never disagree about the numbers.

### Timing and cheat resistance

- The deadline is stored on the session (`slideDeadline`) and checked
  server-side. A phone with a slow clock, a paused tab or a patched countdown
  cannot answer after time. The boundary is *strictly after*, matching
  `effectiveSlideState`, so an answer landing on the exact deadline millisecond
  cannot be accepted by one check and refused by the other.
- `responseMs` is measured from the server's `slideOpenedAt`, not sent by the
  client, so "who buzzed in first" is not something a fast script can win.
- Answering a slide the presenter has already left returns `409 STALE_SLIDE`
  rather than silently landing on the wrong slide.
- One response row per `(sessionId, slideId, participantId)`, enforced by a
  unique index. Re-answering updates in place when `allowChangeAnswer` is on and
  is refused with `ALREADY_ANSWERED` when it is not.

### Live updates

Server-sent events, matching the pattern used elsewhere in the platform. The
loop polls Mongo every 1.5s (`LM_SHORTS_STREAM_MS`) and **only writes when the
serialised payload changed**, sending a `: keep-alive` comment frame otherwise —
an idle slide costs one query per tick and no bytes. The stream closes itself at
9 minutes, under the 10-minute socket timeout in `index.js`, and the client
reconnects; that same path recovers a dropped projector connection.

Client-side, `hooks/useShortStream` reads the stream with `fetch` +
`ReadableStream` rather than `EventSource`, because `EventSource` cannot attach
the `Authorization` header this module uses and the alternative — the JWT in a
query string — would write it into every access log on the way. If the stream
cannot be established at all (a buffering proxy, a captive network) it falls
back to polling `GET …/state`. A projector that has silently stopped updating is
the failure worth engineering against here.

Participant membership is checked **once** when the stream opens rather than on
every tick: the class roster is not going to change mid-slide, and re-querying it
forty times a minute per student would be the most expensive part of the loop.

### Grading

Off by default. With `settings.graded` on, ending the session creates (or
updates) an `lm_coursework` row titled `Short: <title>` and writes a returned
`lm_submission` per participant. A warm-up poll should not silently become an
assessment, which is why this is opt-in rather than inferred from the presence
of an answer key.

### Reports

Per session, not merged across sessions — the same deck run in two sections is
two different rooms, and averaging them would hide that one cohort understood it
and the other did not. Each report gives per-slide participation and correctness,
average response time, a leaderboard, the slides under 60% correct, the people
who joined and never answered, and a CSV of every answer.

Leaderboard ordering is score, then **how much was attempted**, then speed. The
middle term is not decoration: someone who answered nothing has accumulated 0 ms
and on a pure time tie-break would outrank a classmate who answered and was
merely slower.

### Screens

```
/learning/class/:classId/shorts                          deck list (staff see all, students see live)
/learning/class/:classId/short/:id/edit                  slide editor, all eight types
/learning/class/:classId/short/:id/present/:sessionId    projector — join code, QR, live charts
/learning/class/:classId/short/:id/sessions              every run of this deck
/learning/class/:classId/short/:id/report/:sessionId     one run, in full

/learning/short/join            ┐ outside the class routes: a phone has a code,
/learning/short/join/:code      │ not a classId
/learning/short/live/:sessionId ┘ answering
```

The presenter view is keyboard-driven (`←` `→` to move, space to
open/close/reveal) because the teacher is usually holding a presenter remote that
sends arrow keys and nothing else.

---

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
POST   /shorts/join/:code        join a live short by its six-digit code
GET    /shorts/live/:sessionId   current slide + my answer (participant view)
GET    /shorts/live/:sessionId/stream    SSE: the participant view, live
POST   /shorts/live/:sessionId/answer    submit an answer to the open slide
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
POST   /quizzes                  T
GET    /quizzes/:quizId
PATCH  /quizzes/:quizId          *   teacher or a named collaborator
DELETE /quizzes/:quizId          *
POST   /quizzes/:quizId/publish  *   also creates/updates the Classwork item
POST   /quizzes/:quizId/collaborators  T   set co-authors by email
DELETE /quizzes/:quizId/responses      *   wipe every attempt

GET    /quizzes/:quizId/brief        pre-test screen: rules, timings, eligibility
POST   /quizzes/:quizId/attempts     start (resumes an in-progress attempt)
GET    /attempts/:id/paper           all_at_once: the whole paper in this
                                     student's order and option permutation
GET    /attempts/:id/current         one_at_a_time: current question + deadline
POST   /attempts/:id/answer          save the answer and advance (or go back)
POST   /attempts/:id/save            save an all_at_once draft
POST   /attempts/:id/violation       record a proctoring event
POST   /attempts/:id/submit          auto-grade and mirror into the gradebook
GET    /attempts/:id

GET    /quizzes/:quizId/results      T   attempts, question/section analysis
GET    /quizzes/:quizId/results.csv  T   full export

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

GET    /shorts                               decks; students get no slides or keys
POST   /shorts                           T   create
GET    /shorts/:id                           teachers get slides, students get the title
PATCH  /shorts/:id                       T   validates the deck before saving
DELETE /shorts/:id                       T   also drops every session and response
POST   /shorts/:id/present               T   start (or resume) a live session
GET    /shorts/:id/sessions              T   every run of this deck
GET    /short-sessions/:id/state         T   presenter view — the stream's fallback
POST   /short-sessions/:id/control       T   goto | next | previous | open | lock | reveal | reopen
POST   /short-sessions/:id/end           T   stops the code; mirrors marks if graded
GET    /short-sessions/:id/stream        T   SSE: the presenter view, live
GET    /short-sessions/:id/report        T   per-slide analysis + leaderboard
GET    /short-sessions/:id/report.csv    T   every answer, one row per participant

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
