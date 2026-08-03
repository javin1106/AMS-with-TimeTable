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
│                     lmNotification, lmShort, lmShortSession, lmShortResponse,
│                     lmNotebook, lmNotebookAttempt
├── middleware/       lmAuth.js — authenticate, loadClass, requireTeacher…
├── services/         aiService, recordingService, notifyService, formulaEngine,
│                     variantGenerator, examEngine, shortsAggregator,
│                     notebookService
├── controllers/      class, member, stream, comment, coursework, submission,
│                     quiz, tutorial, shorts, notebook, audioStudio,
│                     notification, dashboard, upload
├── routes/index.js   the whole API surface
└── uploads/          attachment storage (git-ignored)
```

```
client/src/learningModule/
├── api/lmApi.js      one request() helper; every endpoint
├── components/       common, Markdown, RichText, RichTextEditor, Attachments,
│                     CommentThread, LearningLayout, NotificationBell,
│                     QuizReview, ShortResults, NotebookCell
├── hooks/            useProctoring, useShortStream, usePyodide
├── notebookImport.js .ipynb / .py → notebook cells
├── pages/            dashboard, class tabs, quiz, tutorial, shorts and
│                     notebook screens
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

When `loadClass` turns somebody away it says *which* of the two is missing,
because the fixes are unrelated. The 403 carries a `code` the UI keys off:

| `code` | Meaning | What the user is told to do |
| --- | --- | --- |
| `ROLE_REQUIRED` | The account holds none of the student/teaching/admin platform roles | Ask an administrator for the right role |
| `NOT_ENROLLED` | The role is fine; they are not on this class's roll | Ask the teacher to add them, or join with the class code |
| `JOIN_PENDING` | They used the join code on a class that requires approval | Wait for the teacher to accept |

The role check runs *after* the membership lookup, never before: a teacher may
invite an existing account without granting it `STUDENT`
(`inviteMembers`'s `grantRoleToExisting`), so an active membership is always
sufficient on its own. The platform role only explains a refusal — it never
causes one.

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
answer; time limit, one sitting per student, shuffling, negative marking, pass mark,
availability window; auto-grading that writes straight into the gradebook;
per-question difficulty analysis for the teacher.

**Shorts** — live in-class polling: a deck of instant questions, a six-digit
join code on the projector, and the room's answers on screen within seconds.
See below.

**Coding notebooks** — Colab-style Python worksheets that run in the student's
own browser. See below.

**Anonymous feedback** — a per-class channel from students to teaching staff.
Anonymous to the teacher, attributed for the administrator, with a language
filter and an escalating warning in front of it. See below.

**Parameterised tutorials** — see below.

**AI Studio** — see below.

**Everywhere else** — cross-class to-do list, a month calendar (coursework due
dates, quizzes, presented Shorts, and the institute's non-working days read from
the attendance module's session record), in-app notification feed with email
fan-out, and a per-class insights page (submission rate, late rate, averages,
at-risk students).

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
be revisited (off = placement-test behaviour). The teacher is only offered that
choice **under the whole-paper clock** — re-serving a question restamps
`currentServedAt`, so under per-question timers a student could farm a fresh
countdown by stepping back and forward again. The controller forces it off for
that combination whatever a client sends. In `all_at_once` the setting is moot:
the whole paper is on one page, so navigation is free by construction.

The cursor, the dealt paper and every answer live on the attempt document, so
**a refresh, a crashed tab or a dropped connection resumes exactly where it left
off** rather than restarting or losing the sitting.

### Timing

The two methods are **exclusive**, and which one applies is asked when the quiz is
created rather than left to be discovered in the editor — a student watching two
countdowns cannot tell which will end their sitting.

- `perQuestionTiming` — each question gets its own countdown and auto-advances on
  expiry; otherwise one clock covers the paper. Only enforceable under
  `one_at_a_time`, so the controller clears it for an all-at-once paper, and the
  editor disables the per-question boxes whenever it is off.
- `timeLimitMinutes` — whole-paper limit. Held at 0 while `perQuestionTiming` is
  on, which is why publishing then requires a time on *every* question.
- `defaultQuestionSec` — seconds stamped on each newly added question, chosen
  once at creation so the teacher is not asked again per question.
- `marginMinutes` — late-entry window. The test stays open for those already
  sitting it while turning away anyone arriving after it; that separation is the
  whole point of the setting.
- `availableFrom` / `availableTo` — the open window.
- `resultReleaseAt` — scores stay hidden after submitting until this moment, so a
  cohort is released together.

The effective deadline for a question is the *earliest* of whichever clock is in
force and the close time — and it is computed server-side from when the question
was served, so reloading cannot reset it.

### Putting one student's sitting right

A test ends for the wrong reason often enough that the teacher needs a way back
in for one person: a dropped connection, a dead battery, a proctoring
termination, the window expiring mid-paper. Two staff-only endpoints on the
attempt, both in the results table's per-row menu:

| | What happens | When |
| --- | --- | --- |
| `POST /attempts/:id/reopen` `mode: continue` | Status back to `in_progress`, answers and cursor kept | The paper closed under them — what they had written is not their fault |
| `POST /attempts/:id/reopen` `mode: restart` | Old attempt deleted, fresh paper dealt, back to question 1 | The sitting is to be discarded and taken again |
| `DELETE /attempts/:id` | The attempt and its score are removed | Clearing one student's response, freeing their attempt slot |

Three things make this work, and each is easy to break by accident:

- **`deadlineOverride` on the attempt.** Both clocks that would otherwise apply
  — `startedAt + timeLimitMinutes`, and the quiz's `availableTo` — have already
  run out in exactly the situation being fixed, so a reopened sitting is given an
  absolute deadline of its own that supersedes both (`examEngine.questionDeadline`).
  Per-question timing is untouched: it runs from when *this* question was served,
  so it is still meaningful on a resumed paper.
- **An open attempt outranks a closed window.** `startAttempt` already resumed an
  in-progress attempt before testing `canStart`; `QuizBrief` now matches it, and
  suppresses the "this test closed" alert when a sitting is open. A closed window
  turning the student away at the door would defeat the whole endpoint.
- **A restart re-seeds the shuffle.** `buildPaper` derives its permutation from
  (quiz, student, attemptNumber), so reusing the number would deal the identical
  paper — and with `questionsPerAttempt` sampling, the identical *subset* they
  have already read. The stored `attemptNumber` stays truthful; only the seed
  varies.

The mirrored gradebook row is recomputed, never blanked (`remirrorGradebook`):
`finaliseAttempt` mirrors the *best* of a student's attempts, so clearing the row
would discard a legitimate earlier sitting while leaving it would show a mark for
an attempt that no longer exists. `reopenCount` / `reopenedByName` stay on the
record — including across a restart, so the fact that a student sat a paper twice
survives the wiping of what they wrote the first time.

### Question types and marking

Four types: `mcq` (single), `msq` (multiple), `truefalse`, `numerical`. Every
one of them auto-marks; there is deliberately no free-text type.
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

### On-screen calculator

`allowCalculator` (default **on**) offers a scientific calculator floating over
the paper for the length of the sitting. It is pure client work — the server
only carries the flag — and it holds nothing that outlives the attempt, so it
cannot double as a notepad between questions. Turn it off for a paper where the
arithmetic is the thing being marked.

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
      │  readable the moment the quiz is published, window open or not
      │  Start (blocked by window, margin, device, an attempt already used)
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

## Coding notebooks

A worksheet of prose and Python cells the student works through in the browser,
Colab-style: source on top, output underneath, one shared namespace, run in
order.

### Why not embed Google Colab

Asked for, and not possible. Three separate walls:

* **Colab cannot be iframed.** It sends frame-ancestors headers that permit only
  Google's own origins. Not a setting anyone can change for us.
* **There is no Colab API** to create a notebook, run one, or read a result
  back. Google Classroom's own integration is a shared link and nothing more.
* **The work would live in the student's Drive**, so there is no submission, no
  output to look at, no grade — none of what makes this a tutorial rather than a
  reading.

A link out to `colab.research.google.com/github/<owner>/<repo>/blob/…` remains a
perfectly good escape hatch for heavy work, and can be dropped into a markdown
cell. It just cannot be the tab.

### Python in the browser

[Pyodide](https://pyodide.org) — CPython compiled to WebAssembly — running in a
Web Worker. **Nothing executes on our servers.** That is the load-bearing
decision: running arbitrary student Python server-side is a remote-code-execution
surface, and this platform has no container sandboxing to put behind one. It also
means a run costs nothing and a class of two hundred needs no queue.

A worker rather than the main thread because Python here is blocking:
`while True: pass` on the main thread would freeze the tab *including the stop
button*; in a worker it freezes only the kernel, and the page can terminate it.

Consequences worth knowing:

| | |
| --- | --- |
| First start | Several MB of WebAssembly, fetched on demand — never on page load. The student presses **Start Python**. |
| Runtime source | `VITE_PYODIDE_URL`, defaulting to the jsDelivr CDN. Point it at a self-hosted copy for a campus network that blocks it. |
| Packages | numpy, pandas, matplotlib, scipy, sympy, scikit-learn have prebuilt wheels; pure-Python packages install via micropip. A C extension nobody has built for wasm will not install. |
| Stopping | A kernel **restart**, not an interrupt. Pyodide's cooperative interrupt needs `SharedArrayBuffer`, which needs cross-origin isolation headers this app does not send. The UI says so rather than pretending. |
| Plots | `matplotlib.pyplot.show` is redirected to hand back a base64 PNG (Agg backend). Without the shim a student's first plot silently does nothing, which reads as broken code. |

The worker lives at `client/public/pyodide-worker.js` rather than being bundled,
because it needs `importScripts` to pull the runtime and a module worker cannot
do that.

### Trust

**An output stored on an attempt is a claim by the client, not a fact the server
witnessed.** Pyodide runs in the student's tab; anyone willing to open devtools
can post whatever result they like. So:

* Outputs are stored **only** so the teacher can see what the student saw, and so
  reopening a notebook is not a blank page.
* There is **no auto-grading**. Notebooks are marked by hand, and the marking
  screen says why. The code is the reliable artefact, so the code is what is put
  in front of the teacher.

Trustworthy marks would need the server to re-run the work in a sandbox — real
infrastructure this repo does not have. That is a deliberate omission, not an
oversight.

### Cells

| Flag | Meaning |
| --- | --- |
| *(none)* | Ordinary cell: the student edits and runs it. |
| `locked` | Shown and runnable, not editable. Imports and scaffolding the rest of the sheet depends on. |
| `hidden` | Runs before the student's cells on every fresh kernel, never shown. Data setup without pasting forty lines into the page. |

Hidden cells are **not** copied into the attempt — they are replayed from the
authored notebook at kernel start. Note this is tidiness, not secrecy: the code
has to reach the browser to run at all, so nothing genuinely secret belongs in a
notebook that executes client-side.

`locked` is enforced server-side in `applyStudentCells`, not just by disabling
the editor. A quietly rewritten setup cell is exactly the sort of thing nobody
notices until the marks look strange, and the client is not a security boundary.

### Importing `.ipynb` and `.py`

The authoring screen takes either format. `client/learningModule/notebookImport.js`
holds both parsers, pure and separately tested — every interesting failure here is
a parsing one, and all of them produce a notebook that looks plausible and is
wrong.

**`.ipynb`** is read as nbformat JSON, so nothing is guessed. Two traps worth
knowing: `source` is either a string *or* a list of lines that already end in
`\n` (joining that list on `\n` double-spaces every cell in the file), and
nbformat 3 nests its cells under `worksheets` instead of at the top level. Cells
that are neither code nor markdown — `raw`, and v3's `heading` — are **counted**
rather than dropped quietly, and the count goes in the toast. The kernel language
is read from `metadata`, because an R or Julia notebook imports perfectly cleanly
and then fails on every cell against a Python kernel.

**`.py`** is split on the `# %%` convention rather than one invented here: it is
what VS Code, Spyder, PyCharm and jupytext all write, so a teacher who keeps
lecture code as a script can hand that file over unchanged. `# %% [markdown]`
becomes a text cell with the comment hashes stripped (`### Heading` keeps its
own — the heading level is content, not a comment marker), and the `# In[3]:`
markers `jupyter nbconvert --to script` emits are read too. The scan follows
triple-quoted strings, so a docstring quoting `# %%` does not split the file in
half.

A `.py` with **no** markers arrives as one cell rather than being chopped up on
blank lines — guessing the split wrong leaves a notebook to repair by hand, which
is worse than one cell the teacher can split themselves. The toast says which of
the two happened, so a single-cell import does not read as a failed split.

Stored outputs are never carried over: `lmNotebook` has no field for them, and a
student should meet the cell unrun. Imported cells are appended and left
**unsaved** — locked, hidden setup, and whether the split came out right are all
decisions the teacher should look at before any of it reaches a student.

#### Making an imported notebook actually run

A file out of Jupyter or Colab is not a Python file, and importing it verbatim
produces a notebook where nothing works:

* **IPython magics.** `%matplotlib inline`, `!pip install pandas`, `%%time` are
  rewritten by IPython before CPython sees them. The kernel here is plain Pyodide
  calling `runPythonAsync`, so a cell that opens with a magic dies on line 1 with
  a `SyntaxError`. `nbconvert` output has the same problem one step later: it
  turns magics into `get_ipython().run_line_magic(...)` calls, which parse and
  then raise `NameError`. Both forms are handled — installs become packages,
  `%matplotlib` is dropped as redundant against the worker's own Agg + `plt.show`
  shim, and anything else is **commented, not deleted**, with a count in the
  toast so the teacher knows what came out.
* **Dependencies.** The packages box is a separate field, so imported cells would
  otherwise all raise `ModuleNotFoundError`. Import statements and `pip install`
  lines are scanned and merged into it. Names are mapped where the import differs
  from the distribution (`sklearn` → `scikit-learn`, `cv2` → `opencv-python`, …)
  and the standard library is excluded — sending `os` to micropip fails an
  install for no reason.

Both scans respect triple-quoted strings, so a docstring containing `%` or an
`import` line is left alone.

### Storage

Each student gets a **copy**, not a diff against the authored cells: the teacher
will edit the notebook mid-term, and someone an hour into it should not find
their work re-based onto new prose overnight. `sourceCellId` keeps the link back
for the side-by-side view and survives the original cell being deleted.

Saves are debounced (2.5s) rather than per keystroke — a notebook is hundreds of
lines across dozens of cells, and per-character saving would post the whole
document on every key. A `revision` counter rejects a stale save with `409
STALE_REVISION`, so a second tab cannot silently overwrite the newer copy.

`services/notebookService.js` clamps everything arriving from a browser: source
length, outputs per cell, output size (with a far larger allowance for images,
since a PNG legitimately dwarfs a traceback), and cell count. Truncation says so
in the text — silently dropping the tail of a traceback is how a student spends
ten minutes debugging an error they cannot see the end of.

### Screens

```
/learning/class/:classId/notebooks                        list
/learning/class/:classId/notebook/:id                     the student's copy — run, edit, submit
/learning/class/:classId/notebook/:id/edit                authoring, with the same kernel to test against
/learning/class/:classId/notebook/:id/submissions         reading and marking
```

Output renders **below** each editor rather than beside it, despite the
"code one side, output the other" framing this was asked for as. Side-by-side
halves the width available to both, and Python output is overwhelmingly wide — a
pandas DataFrame or a traceback wraps into soup at half a screen. Stacked also
survives a phone.

---

## Anonymous feedback

One tab per class, `Anonymous Feedback`, shown to students and staff alike. A
student writes a note; the teaching staff read it with no name on it; a platform
admin reads the same list with the names restored.

### What "anonymous" means here, exactly

Anonymous **to the teacher**, not unattributed. `lm_feedback` stores the author's
id, name, email and roll number in full, and `feedbackController.forTeacher()` is
the single projection that strips them on the way out. Two reasons the identity
is kept rather than discarded: a channel nobody can be held to fills with abuse,
and an allegation about a member of staff has to be traceable to be actionable.

The cost is honesty at the margin, so the UI states **both halves before the box**
— "your teacher will not see who wrote this" and "your institute administrator
can" — at the same size. A student told only the first half writes something they
would not have written knowing the second, which is neither fair to them nor
useful to anyone.

Three things follow from the same reasoning and are easy to undo by accident:

- **The teacher's copy is dated, not timestamped.** `forTeacher()` rounds
  `created_at` down to the day. "17:42, four minutes after the lab ended" plus a
  room of laptops is a name, and hiding `studentId` does not help.
- **The notification carries no `actorName`.** Every other `notifyClass` call in
  the module names its actor; this one must not.
- **`DELETE /feedback/:id` is platform-admin-only**, and deliberately *not*
  `requireTeacher` — that guard would hand the staff member a complaint is about
  the power to delete it. `PATCH` (mark read, reply) is staff-only and cannot
  touch the text.

There is no withdraw button, and the student is told so before they send. A
withdraw button reads as a kindness but is a pressure point: it only has to
exist for a teacher who has guessed who wrote something to be able to ask for it
to be taken down, and for the student to have no answer except that they could.
Feedback that cannot be retracted cannot be retracted under pressure either. The
`deleted` flag stays on the model because an administrator can still remove a
note, which is a soft delete so the record survives it.

### The language filter

`services/profanityFilter.js`, backed by the list in `profanityWords.js`
(English + Hinglish, extendable per deployment via `LM_EXTRA_BLOCKED_WORDS`).
Anonymity is what makes it necessary: elsewhere a message carries its author's
name, and that is most of the moderation.

It **rejects rather than masks**. Storing an asterisked version would leave the
teacher reading an abusive sentence with a hole in it and the student thinking
the point had landed; a refusal naming the words is the only outcome that lets
them rewrite it and be heard.

Matching is anchored to token boundaries, then tolerant of the three ways people
get a word past a filter: leetspeak (`sh1t`, `$hit`), doubling (`fuuuck`) and
padding (`f.u.c.k`, `f u c k`). Short terms opt out of padding tolerance —
applied to a three-letter term it matches half the dictionary — which is what
`BLOCKED_EXACT` is for.

What is deliberately **not** on the list: harsh but honest adjectives — "useless",
"boring", "a waste of time", "the professor never answers questions". The box
exists to carry criticism a student would not sign their name to. A filter that
swallowed criticism would have defeated the feature, so only abuse aimed at a
person is blocked. `tests/unit/learningModuleProfanityFilter.test.js` pins both
directions, and the clean-text half is the half that matters.

### Warnings, and the block

A refused attempt is never stored as feedback — it never became feedback. It is
written to `lm_feedback_strike` instead, with the student's name and the verbatim
text, and the student is told: *warning N of 3, recorded against your account,
one more and it will be blocked and referred to the administrator.* At three,
`POST /feedback` returns 403 for that account, platform-wide.

Three warnings rather than one because the word list has false positives in it,
and a student whose honest complaint tripped on a surname should find that out
and rephrase rather than lose the channel. The count is per *student*, not per
class — the point is a pattern of behaviour, and a counter that reset on every
subject would not measure one.

Nothing deletes strike rows: they are the audit trail for a sanction. The admin
view shows them with the words intact, because "your account was blocked by a
regex" is not a decision anybody can defend — the person deciding reads what was
actually written. The sender's **email is masked behind an eye toggle** there:
judging whether the filter was right needs the message, not the address, and a
column of student emails is a column that gets read over a shoulder or left open
on a projector. It is a friction, not a control — the address is in the payload
either way — so that seeing it is something somebody chose to do.

---

## Who can reach what

Two independent layers, and only one of them is the boundary.

**The server is the boundary.** `requireTeacher` on the route, plus a narrowing
pass in the handler for anything a student legitimately reaches — a published
filter, an ownership check, or a projection that drops the answer key.
`tests/unit/learningModuleRouteGuards.test.js` reads the live Express router and
pins every class-scoped endpoint to one side of the line, with a note saying what
each student-reachable one relies on its handler to withhold. **A new route fails
that suite until somebody has written down who may call it** — which is the point,
because a missing guard is otherwise silent: the handler works perfectly, it just
answers the wrong people.

### Who can be a teacher

`loadClass` grants `teacher` standing by exactly three routes:

1. an active membership with role `teacher` or `co-teacher`
2. being the class owner
3. **holding a platform admin role** — `admin`, `iams-admin` or `SUPERADMIN`

Route 3 is deliberate: it lets support open a class without being enrolled. It is
also a standing grant over *every* class in the installation — answer keys,
gradebooks, student notebooks, quiz attempts — and `requireOwner` honours it too,
so an admin can delete any class. Worth knowing when deciding who gets
`iams-admin`.

No teaching role carries it. `FACULTY`, `ITTC`, `TTADMIN` and `iams-dept-admin`
may *create* a class, which is not the same as being staff inside somebody
else's. `learningModuleRoles.test.js` pins that split, so adding a role to
`PLATFORM_ADMIN_ROLES` is a visible edit rather than a one-word diff nobody
reviews.

There is no self-promotion path. Membership roles are only writable through
`PATCH /members/:id`, which is `requireTeacher`. Email invites can carry
`co-teacher` and are claimed by whoever signs in with that address — safe here
only because account creation is itself admin-only (`POST /auth/register` is
`checkRole(['admin'])`). If self-registration is ever opened up, that claim path
becomes an escalation and needs email verification in front of it.

**The client is a courtesy.** `components/RequireTeacher.jsx` wraps the staff
screens so a student who types a staff URL is sent to the class stream instead of
meeting a bare 403 where a page should be. It decides from context ClassLayout has
already resolved, so there is no flash of staff UI while a check is in flight.
Removing it would leak nothing; it exists so the app does not look broken.

### Withheld from students, by handler

| Endpoint | What is held back |
| --- | --- |
| `GET /quizzes/:id` | `forStudent()` drops correct answers and explanations; unpublished 404s |
| `GET /tutorials/:id` | the answer *formulas* |
| `GET /shorts`, `/shorts/:id` | slides and the answer key |
| `GET /gradebook` | scoped to the caller; 403 when the class hides grades; a grade appears only once returned |
| `GET /members` | classmates' email addresses, and `invitedBy` / `lastSeenAt` / `muted`. Their own row keeps its email |
| `GET /coursework/:id` | drafts 404; `audience` is enforced |
| `GET /studio/sessions/:id` | the raw transcript and the unreviewed quiz draft |
| `GET /notebooks/:id/attempt` | 403 until published; seeds the caller their own copy |
| attempt endpoints | ownership, on every quiz / tutorial / notebook attempt |
| `GET /feedback` | classmates' feedback entirely — a student sees only their own notes |

Withheld from *teachers*, uniquely in this module: `GET /feedback` drops the
sender's name, email, roll number and the time of day. See above.

Quiz authoring (`PATCH`/`DELETE`/`publish`) is deliberately **not** `requireTeacher`:
a named collaborator may edit one quiz without being class staff, so `canManage()`
in the controller is the real check.

---

## Injection

Every rich-text surface in the module — announcements, comments, question stems,
options, notebook prose — is authored by one user and rendered to others.

`components/RichText.jsx` sanitises **at render time, not on save**. The client
is not a security boundary: anyone can POST raw HTML to the API, so trusting
stored content would be unsafe whatever the editor sent. Sanitising on every
render is the guarantee that actually holds.

Three things beyond a stock DOMPurify config, each because the default was not
enough:

1. **A private DOMPurify instance.** Hooks are per-instance and the default
   export is shared with the conference, review and timetable modules. Adding
   this module's rules to it would silently change their sanitisation.

2. **An inline-CSS allowlist.** DOMPurify strips scripting but passes `style`
   through. A style attribute alone is enough without a line of JavaScript:
   `position:fixed;width:100vw;height:100vh;z-index:9999` on a class
   announcement covers the whole page, and wrapped in a link it is an in-page
   phishing overlay. Only the properties Quill actually emits survive, and
   `url()` is stripped even from those so that reading a comment cannot become a
   tracking beacon.

3. **A second look at `<img src>`.** `ALLOWED_URI_REGEXP` does not govern this:
   DOMPurify special-cases `data:` on its built-in `DATA_URI_TAGS`, `img` among
   them, and admits any media type. Narrowing the regexp is not on its own
   enough to keep `data:image/svg+xml` out — the hook is what excludes it.

Links with `target="_blank"` get `rel="noopener noreferrer"` added, or the opened
page can navigate the still-signed-in original.

`__tests__/RichTextInjection.test.jsx` throws 35 payloads at it — script tags,
every `on*` handler shape, `javascript:` in several encodings, `srcdoc`, mutation
XSS, `meta refresh`, `base`, and the style vectors above. The assertions are about
outcome (no script node, no handler attribute, no executable scheme, nothing that
can cover the page) rather than about DOMPurify's internals, so a future config
change that still passes them is fine.

**Not done, and worth knowing:** the app sets `contentSecurityPolicy: false` in
`server/src/index.js`. A CSP is the backstop that catches whatever the sanitiser
misses, and turning it on is an app-wide change affecting every module — out of
scope here, but the single highest-value hardening left.

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

## Outbound mail

Every mail this module sends uses the platform frame in `notifyService.emailShell`
— the same 480px card, teal banner, `Dear User,` greeting and footer as the
forgot-password OTP mail (`otpbody.ejs`) and the welcome mail
(`usermanagement/welcomeMailer`). The banner carries `XCEED Learning` by default
— this is Learning module mail, and that is the product the recipient is being
told about; the invitation overrides it with `Welcome to XCEED Learning!`, since
for most recipients it is their first mail from the module.
Links are absolutised against the request origin
(falling back to `FRONTEND_URL`, then `https://xceed.nitj.ac.in`): a stored
in-app path such as `/learning/class/:id` is not resolvable from a mail client.

Two distinct kinds of mail, gated differently:

| Mail | Trigger | Gate |
| --- | --- | --- |
| Post notification | anything is posted to the class | `settings.emailNotifications` |
| Invitation | a teacher adds someone by email | none — always sent |

**Every post type mails the class**: announcements (including a draft published
later), coursework, materials, quizzes, tutorials, notebooks, audio study
material, discussions and a live Short starting. Comments and anonymous feedback
do not — they are replies and staff traffic, not posts.

Post mail goes out **one message per recipient**, addressed to that student. It
used to be one message per fifty with the class in `bcc` and the `to:` pointing
back at the sending account, which the relay accepted and the receiving side
filed as junk — the failure mode being that nothing errored and no student got
anything. `sendBulkMail` reports `{ sent, failed }` and `notifyClass` logs both
per post, so a delivery problem is readable in the log instead of inferred from
students saying they never heard.

Three things used to suppress this mail silently, all of them fixed and all of
them worth not reintroducing: `muted: false` in the audience query (Mongo does
not match a missing field against `false`, so pre-`muted` rows were read as
muted), a truthy test on `settings.emailNotifications` (a class document without
the field read as opted out), and sharing one `try` block with the in-app
notification insert (one rejected row cancelled the whole class's mail). A
member whose membership row carries no denormalised `email` is now looked up
from their account rather than skipped.

The invitation is transactional, not a digest, so it is **not** gated on
`settings.emailNotifications` ("email the class when something is posted"). It
used to be, which meant a teacher who had turned post digests off — a common
thing to do — silently sent no invitations at all. `sendInviteMail` also reports
whether the mail actually left, and `POST /members/invite` returns that as
`mailed` per address so the teacher sees a delivery failure instead of a clean
success. An address whose account was just provisioned gets no invitation mail:
the welcome mail already names the class and carries the set-password link.

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
GET    /calendar?from&to         { coursework, quizzes, shorts, nonWorkingDays }
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
                                 adds the role to accounts that lack it. Each
                                 result carries `mailed` (true/false, or null
                                 when the welcome mail covered that address)
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

GET    /feedback                 anonymous feedback. Students get their own
                                 notes; staff get the class's with every
                                 identifying field stripped and the time blunted
                                 to a date; platform admins get the same list
                                 with senders restored, plus refused attempts
POST   /feedback                 send one (active student enrolment only). 400
                                 `PROFANITY` with the matched terms and the
                                 warning count; 403 `FEEDBACK_BLOCKED` after 3
PATCH  /feedback/:id         T   mark read / acted on, or reply to the sender
DELETE /feedback/:id             platform admins only — no withdraw path for the
                                 student, and never for the teacher the note is
                                 about

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
POST   /attempts/:id/reopen      T   let one student back in — `mode: continue`
                                     keeps their answers, `restart` deals a
                                     fresh paper; `minutes` gives the sitting
                                     its own clock, so a closed window does not
                                     shut them out again
DELETE /attempts/:id             T   delete one student's response and its score

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

GET    /notebooks                            coding notebooks; students see published only
POST   /notebooks                        T   create
GET    /notebooks/:id                    T   the authored notebook, including hidden cells
PATCH  /notebooks/:id                    T
DELETE /notebooks/:id                    T   also drops every student's copy
POST   /notebooks/:id/publish            T   mirrors into Classwork, notifies the class
GET    /notebooks/:id/attempt                get-or-create the caller's own copy
GET    /notebooks/:id/attempts           T   who has started, run and submitted
GET    /notebook-attempts/:id                one copy; own, or any if staff
POST   /notebook-attempts/:id/save           debounced autosave; 409 on a stale revision
POST   /notebook-attempts/:id/submit         turns in; no auto-grade, by design
POST   /notebook-attempts/:id/reopen     T   hand back for another go
PATCH  /notebook-attempts/:id/grade      T   marked by hand; writes to the gradebook

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
