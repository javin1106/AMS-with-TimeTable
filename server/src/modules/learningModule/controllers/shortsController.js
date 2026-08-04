const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const LmShort = require('../models/lmShort');
const LmShortSession = require('../models/lmShortSession');
const LmShortResponse = require('../models/lmShortResponse');
const LmMembership = require('../models/lmMembership');
const LmCoursework = require('../models/lmCoursework');
const LmSubmission = require('../models/lmSubmission');
const LmClass = require('../models/lmClass');
const { seedSubmissions } = require('./courseworkController');
const agg = require('../services/shortsAggregator');
const { notifyClass } = require('../services/notifyService');
const game = require('../services/gamification');

/* ─────────────────────────────── helpers ──────────────────────────────── */

// Digits only: it is read off a projector at the back of a lecture hall and
// typed on a phone keypad.
const CODE_LENGTH = 6;

async function mintJoinCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = Array.from(crypto.randomBytes(CODE_LENGTH))
      .map((byte) => String(byte % 10))
      .join('');
    // Only live sessions hold a code, so codes recycle naturally.
    // eslint-disable-next-line no-await-in-loop
    const clash = await LmShortSession.exists({ joinCode: code, status: 'live' });
    if (!clash) return code;
  }
  throw new Error('Could not allocate a join code, please try again.');
}

const slideOf = (short, index) => (short.slides || [])[index] || null;

/**
 * Closes a slide whose countdown has run out.
 *
 * The views derive the closed state themselves (see `effectiveSlideState`), so
 * this is not what makes the room correct — it is what stops the stored state
 * drifting away from what everybody can already see, so a later `reopen`, a
 * report or a restart all work from the same facts.
 *
 * The write is conditional on the row still being open, because the presenter's
 * stream and forty phones will all notice the same expiry within the same
 * second and only one of them should bump `revision`.
 */
async function settleExpiredSlide(session, short) {
  if (!session || session.status !== 'live') return session;
  if (session.slideState !== 'open' || !session.slideDeadline) return session;

  const next = agg.effectiveSlideState(session, short);
  if (next === 'open') return session;

  await LmShortSession.updateOne(
    { _id: session._id, slideState: 'open', slideDeadline: { $ne: null } },
    {
      $set: { slideState: next, slideDeadline: null, updated_at: new Date() },
      $inc: { revision: 1 },
    },
  );

  // Keep the in-memory document in step so the caller can render the new state
  // without a second read.
  session.slideState = next;
  session.slideDeadline = null;
  session.revision += 1;
  return session;
}

/* ─────────────────────────── guest participants ───────────────────────── */

// A guest's identity for the length of one session. Signed rather than stored,
// so a phone that reloads mid-deck keeps its answers without the server holding
// a session table — and so nobody can hand back somebody else's participant id
// and overwrite their answers.
const GUEST_TOKEN_TTL = '8h';
const GUEST_TOKEN_KIND = 'lm_short_guest';
const GUEST_NAME_MAX = 60;
const GUEST_HEADER = 'X-Short-Guest';

const signGuestToken = (sessionId, participantId, name) =>
  jwt.sign(
    { kind: GUEST_TOKEN_KIND, sid: String(sessionId), pid: String(participantId), name },
    process.env.JWT_SECRET,
    { expiresIn: GUEST_TOKEN_TTL },
  );

/** The guest this request carries a token for, if it is valid *for this session*. */
const readGuestToken = (req, sessionId) => {
  const raw = req.get(GUEST_HEADER);
  if (!raw) return null;
  try {
    const decoded = jwt.verify(raw, process.env.JWT_SECRET);
    if (decoded.kind !== GUEST_TOKEN_KIND) return null;
    // Scoped to one session: a token from this morning's lecture is not a way
    // into this afternoon's.
    if (String(decoded.sid) !== String(sessionId)) return null;
    return { id: String(decoded.pid), name: decoded.name || 'Guest' };
  } catch {
    return null;
  }
};

const guestsAllowedOn = (short) => short.settings?.requireLogin === false;

// Forwards `code` alongside the message: the join screen branches on it to
// decide between sending the visitor to log in and merely asking for a name.
// The internal `status` field stays out of the body.
const sendParticipantError = (res, error) =>
  res.status(error.status).json({
    message: error.message,
    ...(error.code ? { code: error.code } : {}),
  });

/**
 * Who is answering, and whether they are allowed to.
 *
 * Three ways in, in order of standing:
 *   - signed in and on the class roll   → a student; scores can be graded
 *   - signed in but not enrolled        → allowed only on an open deck, as a guest
 *   - not signed in, holding a token    → allowed only on an open deck, as a guest
 *
 * `isGuest` means "not on the roll of the class running this", which is exactly
 * the condition under which a score must not reach the gradebook.
 */
const resolveParticipant = async (req, session, short) => {
  if (req.lmUser) {
    const membership = await LmMembership.findOne({
      classId: session.classId,
      userId: req.lmUser.id,
      status: 'active',
    }).lean();

    if (!membership && !guestsAllowedOn(short)) {
      return { error: { status: 403, message: 'You are not a member of the class running this short.' } };
    }

    return {
      identity: {
        id: String(req.lmUser.id),
        name: req.lmUser.name,
        email: req.lmUser.email || '',
        rollNumber: membership?.rollNumber || '',
        isGuest: !membership,
      },
    };
  }

  if (!guestsAllowedOn(short)) {
    return {
      error: { status: 401, message: 'Sign in to join this short.', code: 'LOGIN_REQUIRED' },
    };
  }

  const guest = readGuestToken(req, session._id);
  if (!guest) {
    return {
      error: { status: 401, message: 'Enter the code again to rejoin this short.', code: 'GUEST_TOKEN_REQUIRED' },
    };
  }

  return {
    identity: { id: guest.id, name: guest.name, email: '', rollNumber: '', isGuest: true },
  };
};

/** What the presenter's screen needs. */
const presenterView = (short, session, slideResults, responseCount) => {
  // Derived rather than read straight off the row: a slide whose countdown has
  // passed is closed even if nothing has written that yet. Evaluated once, so
  // a deadline falling between two calls cannot produce a payload that says
  // "open" while withholding the deadline, or the reverse.
  const slideState = agg.effectiveSlideState(session, short);
  const slide = slideOf(short, session.currentSlideIndex);

  return {
    sessionId: session._id,
    shortId: short._id,
    title: short.title,
    joinCode: session.joinCode,
    status: session.status,
    revision: session.revision,
    slideIndex: session.currentSlideIndex,
    slideCount: short.slides.length,
    slideState,
    slideDeadline: slideState === 'open' ? session.slideDeadline : null,
    slide: slide
      ? {
          _id: slide._id,
          type: slide.type,
          question: slide.question,
          options: slide.options,
          timeLimitSec: slide.timeLimitSec,
          marks: slide.marks,
          scaleMin: slide.scaleMin,
          scaleMax: slide.scaleMax,
          scaleMinLabel: slide.scaleMinLabel,
          scaleMaxLabel: slide.scaleMaxLabel,
          maxWords: slide.maxWords,
          maxLength: slide.maxLength,
          gradable: agg.slideIsGradable(slide),
        }
      : null,
    results: slideResults,
    participantCount: (session.participants || []).length,
    responseCount,
    settings: short.settings,
  };
};

/**
 * What a participant's phone needs. Deliberately narrower than the presenter
 * view: no answer key unless the slide has been revealed, and no results at all
 * unless the deck opts in.
 */
const participantView = (short, session, slideResults, myResponse) => {
  const slide = slideOf(short, session.currentSlideIndex);
  // Derived, so a phone stops offering an answer — and starts showing the key —
  // the moment the countdown passes, without waiting on the presenter.
  const slideState = agg.effectiveSlideState(session, short);
  const revealed = slideState === 'revealed';
  // A slide the presenter has not opened yet is withheld rather than merely
  // hidden by the phone: the question is on the projector seconds later anyway,
  // but one student reading it early out of the network tab is an unfair head
  // start on a graded short.
  const pending = slideState === 'waiting';

  return {
    sessionId: session._id,
    title: short.title,
    description: short.description,
    status: session.status,
    revision: session.revision,
    slideIndex: session.currentSlideIndex,
    slideCount: short.slides.length,
    slideState,
    slideDeadline: slideState === 'open' ? session.slideDeadline : null,
    // Shown on the hold screen so a student can tell they joined the right room.
    presentedByName: session.presentedByName,
    participantCount: (session.participants || []).length,
    slide: slide
      ? {
          _id: slide._id,
          type: slide.type,
          pending,
          ...(pending
            ? {}
            : {
                question: slide.question,
                options: slide.options,
                timeLimitSec: slide.timeLimitSec,
                scaleMin: slide.scaleMin,
                scaleMax: slide.scaleMax,
                scaleMinLabel: slide.scaleMinLabel,
                scaleMaxLabel: slide.scaleMaxLabel,
                maxWords: slide.maxWords,
                maxLength: slide.maxLength,
              }),
        }
      : null,
    // Only sent when the teacher chose to mirror the tally to phones, or once
    // the slide is revealed.
    results: short.settings?.showResultsToStudents || revealed ? slideResults : null,
    myAnswer: myResponse
      ? {
          selected: myResponse.selected,
          text: myResponse.text,
          number: myResponse.number,
          correct: revealed ? myResponse.correct : null,
          awarded: revealed ? myResponse.awarded : 0,
        }
      : null,
    canAnswer: session.status === 'live' && slideState === 'open',
    canChange: short.settings?.allowChangeAnswer !== false,
  };
};

/** Loads the current slide's aggregate, honouring the reveal state. */
async function currentResults(short, session) {
  const slide = slideOf(short, session.currentSlideIndex);
  if (!slide) return null;
  const responses = await LmShortResponse.find({
    sessionId: session._id,
    slideId: slide._id,
  }).lean();

  return agg.aggregateSlide(slide, responses, {
    reveal: agg.effectiveSlideState(session, short) === 'revealed',
    anonymous: short.settings?.anonymous !== false,
  });
}

const touchRevision = (session) => {
  session.revision += 1;
  session.updated_at = new Date();
};

/* ─────────────────────────── deck CRUD (teacher) ──────────────────────── */

const prepareSlides = (input) =>
  (Array.isArray(input) ? input : []).map((slide, index) => {
    const type = LmShort.SLIDE_TYPES.includes(slide.type) ? slide.type : 'mcq';
    const options = Array.isArray(slide.options) ? slide.options.map(String) : [];

    return {
      _id: slide._id || undefined,
      type,
      question: String(slide.question || ''),
      options: type === 'truefalse' ? ['True', 'False'] : options,
      correctAnswers: Array.isArray(slide.correctAnswers) ? slide.correctAnswers.map(String) : [],
      explanation: String(slide.explanation || ''),
      timeLimitSec: Math.max(0, Math.min(Number(slide.timeLimitSec) || 0, 3600)),
      marks: Number(slide.marks) || 1,
      scaleMin: Number.isFinite(Number(slide.scaleMin)) ? Number(slide.scaleMin) : 1,
      scaleMax: Number.isFinite(Number(slide.scaleMax)) ? Number(slide.scaleMax) : 5,
      scaleMinLabel: String(slide.scaleMinLabel || ''),
      scaleMaxLabel: String(slide.scaleMaxLabel || ''),
      correctNumber:
        slide.correctNumber === null || slide.correctNumber === undefined || slide.correctNumber === ''
          ? null
          : Number(slide.correctNumber),
      tolerancePercent: Number(slide.tolerancePercent) || 0,
      toleranceAbs: Number(slide.toleranceAbs) || 0,
      maxWords: Math.max(1, Math.min(Number(slide.maxWords) || 3, 10)),
      maxLength: Math.max(1, Math.min(Number(slide.maxLength) || 200, 2000)),
      order: Number.isFinite(Number(slide.order)) ? Number(slide.order) : index,
      imageUrl: String(slide.imageUrl || ''),
    };
  });

/** Rejects a deck that cannot be presented, before the room is watching. */
const validateSlides = (slides) => {
  const errors = [];
  slides.forEach((slide, index) => {
    const where = `Slide ${index + 1}`;
    if (!String(slide.question || '').replace(/<[^>]*>/g, '').trim()) {
      errors.push(`${where}: the question is empty.`);
    }
    if (['mcq', 'msq', 'ranking'].includes(slide.type) && slide.options.filter((o) => o.trim()).length < 2) {
      errors.push(`${where}: add at least two options.`);
    }
    if (slide.type === 'scale' && slide.scaleMax <= slide.scaleMin) {
      errors.push(`${where}: the scale maximum must be above the minimum.`);
    }
    // A key that points past the end of the option list would mark everyone
    // wrong with no way to tell why.
    (slide.correctAnswers || []).forEach((value) => {
      if (Number(value) >= slide.options.length) {
        errors.push(`${where}: the correct answer refers to an option that no longer exists.`);
      }
    });
  });
  return errors;
};

exports.listShorts = async (req, res) => {
  const shorts = await LmShort.find({ classId: req.lmClass._id }).sort({ created_at: -1 }).lean();

  const sessions = await LmShortSession.find({ classId: req.lmClass._id })
    .select('shortId status joinCode startedAt endedAt participants')
    .sort({ startedAt: -1 })
    .lean();

  const byShort = new Map();
  sessions.forEach((session) => {
    const key = String(session.shortId);
    if (!byShort.has(key)) byShort.set(key, []);
    byShort.get(key).push(session);
  });

  return res.json(
    shorts.map((short) => {
      const runs = byShort.get(String(short._id)) || [];
      return {
        ...short,
        slideCount: short.slides.length,
        // Students only need to know a session is live and how to join it.
        ...(req.lmIsTeacher ? { slides: short.slides } : { slides: undefined }),
        liveSession: runs.find((session) => session.status === 'live') || null,
        runCount: runs.length,
        lastRunAt: runs[0]?.startedAt || null,
      };
    }),
  );
};

exports.createShort = async (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ message: 'Give the short a title.' });

  const slides = prepareSlides(req.body.slides);
  const short = new LmShort({
    classId: req.lmClass._id,
    title,
    description: req.body.description || '',
    slides,
    createdBy: req.lmUser.id,
    createdByName: req.lmUser.name,
  });
  if (req.body.settings) Object.assign(short.settings, req.body.settings);
  await short.save();
  return res.status(201).json(short);
};

exports.getShort = async (req, res) => {
  const short = await LmShort.findOne({ _id: req.params.shortId, classId: req.lmClass._id }).lean();
  if (!short) return res.status(404).json({ message: 'Short not found.' });
  if (!req.lmIsTeacher) {
    // A student browsing the list must not be able to read the answer key.
    return res.json({ _id: short._id, title: short.title, description: short.description });
  }
  return res.json(short);
};

exports.updateShort = async (req, res) => {
  const short = await LmShort.findOne({ _id: req.params.shortId, classId: req.lmClass._id });
  if (!short) return res.status(404).json({ message: 'Short not found.' });

  if (req.body.title !== undefined) short.title = String(req.body.title).trim();
  if (req.body.description !== undefined) short.description = String(req.body.description);
  if (req.body.slides !== undefined) {
    const slides = prepareSlides(req.body.slides);
    const errors = validateSlides(slides);
    if (errors.length) return res.status(400).json({ message: errors[0], errors });
    short.slides = slides;
  }
  if (req.body.settings) Object.assign(short.settings, req.body.settings);

  short.updated_at = new Date();
  await short.save();
  return res.json(short);
};

exports.deleteShort = async (req, res) => {
  const short = await LmShort.findOne({ _id: req.params.shortId, classId: req.lmClass._id });
  if (!short) return res.status(404).json({ message: 'Short not found.' });

  const sessions = await LmShortSession.find({ shortId: short._id }).select('_id').lean();
  await LmShortResponse.deleteMany({ sessionId: { $in: sessions.map((session) => session._id) } });
  await LmShortSession.deleteMany({ shortId: short._id });
  if (short.courseworkId) {
    await LmSubmission.deleteMany({ courseworkId: short.courseworkId });
    await LmCoursework.deleteOne({ _id: short.courseworkId });
  }
  await LmShort.deleteOne({ _id: short._id });
  return res.json({ deleted: true });
};

/* ────────────────────────── presenting (teacher) ──────────────────────── */

exports.startSession = async (req, res) => {
  const short = await LmShort.findOne({ _id: req.params.shortId, classId: req.lmClass._id });
  if (!short) return res.status(404).json({ message: 'Short not found.' });
  if (!short.slides.length) {
    return res.status(400).json({ message: 'Add at least one slide before presenting.' });
  }

  const errors = validateSlides(short.slides);
  if (errors.length) {
    return res.status(400).json({ message: 'Fix these before presenting.', errors });
  }

  // Only one live session per short — two codes for the same deck in the same
  // class would split the room's answers.
  const existing = await LmShortSession.findOne({ shortId: short._id, status: 'live' });
  if (existing) {
    // Resuming after the laptop slept: the countdown almost certainly ran out
    // while nobody was connected.
    await settleExpiredSlide(existing, short);
    const results = await currentResults(short, existing);
    const responseCount = await LmShortResponse.countDocuments({ sessionId: existing._id });
    return res.json({ session: presenterView(short, existing, results, responseCount), resumed: true });
  }

  const session = await LmShortSession.create({
    shortId: short._id,
    classId: req.lmClass._id,
    title: short.title,
    joinCode: await mintJoinCode(),
    currentSlideIndex: 0,
    slideState: 'waiting',
    presentedBy: req.lmUser.id,
    presentedByName: req.lmUser.name,
  });

  await notifyClass({
    klass: req.lmClass,
    excludeUserId: req.lmUser.id,
    type: 'quiz',
    title: `${req.lmClass.name}: a live Short has started`,
    body: `Join with code ${session.joinCode}.`,
    link: `/learning/short/join/${session.joinCode}`,
    actorName: req.lmUser.name,
    // The one notification in this module with a deadline attached — the
    // session is running now — so it goes by mail too, not only in-app.
    email: true,
  });

  return res.status(201).json({
    session: presenterView(short, session, null, 0),
    resumed: false,
  });
};

const loadSessionForPresenter = async (req) => {
  const session = await LmShortSession.findOne({
    _id: req.params.sessionId,
    classId: req.lmClass._id,
  });
  if (!session) return { error: { status: 404, message: 'Session not found.' } };
  const short = await LmShort.findById(session.shortId);
  if (!short) return { error: { status: 404, message: 'Short not found.' } };
  return { session, short };
};

/**
 * Read-only presenter state.
 *
 * Exists so the projector has a polling fallback when the event-stream cannot be
 * established — a buffering proxy, a captive network. Driving a lecture from a
 * screen that has silently stopped updating is the failure worth engineering
 * against here.
 */
exports.getPresenterState = async (req, res) => {
  const { session, short, error } = await loadSessionForPresenter(req);
  if (error) return res.status(error.status).json({ message: error.message });

  await settleExpiredSlide(session, short);
  const [results, responseCount] = await Promise.all([
    currentResults(short, session),
    LmShortResponse.countDocuments({ sessionId: session._id }),
  ]);
  return res.json({ session: presenterView(short, session, results, responseCount) });
};

/**
 * Drives the room: move slide, open/lock/reveal.
 * One endpoint because the presenter's controls are a single state machine and
 * splitting them invites the client into an inconsistent intermediate state.
 */
exports.controlSession = async (req, res) => {
  const { session, short, error } = await loadSessionForPresenter(req);
  if (error) return res.status(error.status).json({ message: error.message });
  if (session.status !== 'live') {
    return res.status(400).json({ message: 'This session has ended.' });
  }

  // Bank an expired countdown before applying the teacher's action, so the two
  // cannot fight: pressing "reopen" on a slide that has just timed out reopens
  // it rather than being overwritten by the expiry a moment later.
  await settleExpiredSlide(session, short);

  const action = req.body.action;
  const now = new Date();

  switch (action) {
    case 'goto': {
      const index = Number(req.body.slideIndex);
      if (!Number.isInteger(index) || index < 0 || index >= short.slides.length) {
        return res.status(400).json({ message: 'No such slide.' });
      }
      session.currentSlideIndex = index;
      session.slideState = 'waiting';
      session.slideOpenedAt = null;
      session.slideDeadline = null;
      break;
    }

    case 'next':
    case 'previous': {
      const delta = action === 'next' ? 1 : -1;
      const index = session.currentSlideIndex + delta;
      if (index < 0 || index >= short.slides.length) {
        return res.status(400).json({ message: action === 'next' ? 'Already on the last slide.' : 'Already on the first slide.' });
      }
      session.currentSlideIndex = index;
      session.slideState = 'waiting';
      session.slideOpenedAt = null;
      session.slideDeadline = null;
      break;
    }

    case 'open': {
      const slide = slideOf(short, session.currentSlideIndex);
      if (!slide) return res.status(400).json({ message: 'No slide to open.' });
      session.slideState = 'open';
      session.slideOpenedAt = now;
      session.slideDeadline = slide.timeLimitSec
        ? new Date(now.getTime() + slide.timeLimitSec * 1000)
        : null;
      break;
    }

    case 'lock':
      session.slideState = short.settings?.autoRevealOnClose ? 'revealed' : 'locked';
      session.slideDeadline = null;
      break;

    case 'reveal':
      session.slideState = 'revealed';
      session.slideDeadline = null;
      break;

    case 'reopen':
      session.slideState = 'open';
      session.slideOpenedAt = now;
      session.slideDeadline = null;
      break;

    default:
      return res.status(400).json({ message: 'Unknown action.' });
  }

  touchRevision(session);
  await session.save();

  const results = await currentResults(short, session);
  const responseCount = await LmShortResponse.countDocuments({ sessionId: session._id });
  return res.json({ session: presenterView(short, session, results, responseCount) });
};

exports.endSession = async (req, res) => {
  const { session, short, error } = await loadSessionForPresenter(req);
  if (error) return res.status(error.status).json({ message: error.message });

  session.status = 'ended';
  session.endedAt = new Date();
  session.slideState = 'revealed';
  session.slideDeadline = null;
  touchRevision(session);
  await session.save();

  // Only a graded deck writes to the gradebook. A warm-up poll should not
  // silently become an assessment.
  if (short.settings?.graded) {
    const responses = await LmShortResponse.find({ sessionId: session._id }).lean();
    const rollup = agg.aggregateSession(short.toObject(), session.toObject(), responses);

    if (rollup.hasGradableSlides) {
      let coursework = short.courseworkId ? await LmCoursework.findById(short.courseworkId) : null;
      if (!coursework) {
        coursework = await LmCoursework.create({
          classId: req.lmClass._id,
          workType: 'quiz',
          title: `Short: ${short.title}`,
          instructions: short.description,
          points: rollup.maxScore,
          createdBy: req.lmUser.id,
          createdByName: req.lmUser.name,
        });
        short.courseworkId = coursework._id;
        await short.save();
        await LmClass.updateOne({ _id: req.lmClass._id }, { $inc: { 'stats.courseworkCount': 1 } });
      } else {
        coursework.points = rollup.maxScore;
        await coursework.save();
      }
      await seedSubmissions(coursework, req.lmClass);

      const now = new Date();
      for (const entry of rollup.leaderboard) {
        // Guests have no place in the gradebook: a signed-out visitor's id
        // refs no user, and an enrolled-elsewhere account is not a student of
        // this class. Their answers still count in the room's results.
        if (!entry.userId || entry.isGuest) continue;
        // eslint-disable-next-line no-await-in-loop
        await LmSubmission.findOneAndUpdate(
          { courseworkId: coursework._id, studentId: entry.userId },
          {
            $set: {
              classId: req.lmClass._id,
              studentName: entry.name,
              studentEmail: entry.email,
              state: 'returned',
              grade: entry.score,
              maxPoints: rollup.maxScore,
              turnedInAt: now,
              returnedAt: now,
              gradedAt: now,
              gradedByName: 'Live short',
              feedback: `Live short: ${entry.score}/${rollup.maxScore} · ${entry.correct} correct of ${entry.answered} answered`,
            },
          },
          { upsert: true },
        );
      }
    }
  }

  return res.json({ ended: true, sessionId: session._id });
};

/* ───────────────────────── joining (participant) ──────────────────────── */

/**
 * Resolves a join code to a live session. Who may join is settled here rather
 * than by the router, because the participant only has a code — they do not
 * know the classId, and the deck's own settings decide whether a sign-in is
 * needed at all.
 */
exports.joinByCode = async (req, res) => {
  const code = String(req.params.code || '').trim();
  const session = await LmShortSession.findOne({ joinCode: code, status: 'live' });
  if (!session) {
    return res.status(404).json({ message: 'No live short matches that code.', code: 'NO_SESSION' });
  }

  const short = await LmShort.findById(session.shortId);
  if (!short) return res.status(404).json({ message: 'Short not found.' });

  if (!short.settings?.allowLateJoin && session.currentSlideIndex > 0) {
    return res.status(403).json({ message: 'This short has already moved on and is not accepting new joiners.' });
  }

  let identity;
  let guestToken = null;

  if (req.lmUser || !guestsAllowedOn(short)) {
    // Signed in, or a deck that insists on it — the standing rules apply and
    // produce the 401/403 when they are not met.
    const resolved = await resolveParticipant(req, session, short);
    if (resolved.error) {
      return sendParticipantError(res, resolved.error);
    }
    identity = resolved.identity;
  } else {
    // An open deck, joined by somebody with no account. A phone that still
    // holds a valid token for *this* session keeps the identity it had, so a
    // re-join after a reload does not orphan the answers already given.
    const existing = readGuestToken(req, session._id);
    const name = String(req.body?.name || '').trim().slice(0, GUEST_NAME_MAX);
    if (!existing && !name) {
      return res.status(400).json({
        message: 'Enter the name the room should see.',
        code: 'NAME_REQUIRED',
      });
    }
    const participantId = existing ? existing.id : new mongoose.Types.ObjectId();
    identity = {
      id: String(participantId),
      name: name || existing.name,
      email: '',
      rollNumber: '',
      isGuest: true,
    };
    guestToken = signGuestToken(session._id, participantId, identity.name);
  }

  const already = (session.participants || []).some(
    (participant) => String(participant.userId) === String(identity.id),
  );
  if (!already) {
    session.participants.push({
      userId: identity.id,
      name: identity.name,
      email: identity.email,
      rollNumber: identity.rollNumber,
      isGuest: identity.isGuest,
    });
    touchRevision(session);
    await session.save();
  }

  return res.json({
    sessionId: session._id,
    classId: session.classId,
    title: short.title,
    joined: true,
    displayName: identity.name,
    isGuest: identity.isGuest,
    // Only ever issued to a signed-out joiner; the client keeps it for the rest
    // of the session and sends it back on every participant call.
    ...(guestToken ? { guestToken } : {}),
  });
};

const loadSessionForParticipant = async (req) => {
  const session = await LmShortSession.findById(req.params.sessionId);
  if (!session) return { error: { status: 404, message: 'Session not found.' } };

  const short = await LmShort.findById(session.shortId);
  if (!short) return { error: { status: 404, message: 'Short not found.' } };

  const resolved = await resolveParticipant(req, session, short);
  if (resolved.error) return { error: resolved.error };

  return { session, short, identity: resolved.identity };
};

exports.getParticipantState = async (req, res) => {
  const { session, short, identity, error } = await loadSessionForParticipant(req);
  if (error) return sendParticipantError(res, error);

  await settleExpiredSlide(session, short);
  const slide = slideOf(short, session.currentSlideIndex);
  const [results, mine] = await Promise.all([
    currentResults(short, session),
    slide
      ? LmShortResponse.findOne({
          sessionId: session._id,
          slideId: slide._id,
          participantId: identity.id,
        }).lean()
      : null,
  ]);

  return res.json(participantView(short, session, results, mine));
};

exports.submitResponse = async (req, res) => {
  const { session, short, identity, error } = await loadSessionForParticipant(req);
  if (error) return sendParticipantError(res, error);

  if (session.status !== 'live') return res.status(400).json({ message: 'This short has ended.' });
  if (session.slideState !== 'open') {
    return res.status(400).json({ message: 'This slide is not accepting answers.', code: 'NOT_OPEN' });
  }

  const slide = slideOf(short, session.currentSlideIndex);
  if (!slide || String(slide._id) !== String(req.body.slideId)) {
    // The teacher moved on between the phone rendering and the answer landing.
    return res.status(409).json({ message: 'The presenter has moved to another slide.', code: 'STALE_SLIDE' });
  }

  // The server's own deadline is authoritative; a phone with a slow clock or a
  // paused tab must not be able to answer after time. Closing the slide here as
  // well means a room where nobody is watching the stream still gets the answer
  // revealed, off the back of whoever tapped last.
  if (session.slideDeadline && new Date() > new Date(session.slideDeadline)) {
    await settleExpiredSlide(session, short);
    return res.status(400).json({ message: 'Time is up for this slide.', code: 'EXPIRED' });
  }

  const normalised = agg.normaliseAnswer(slide, req.body);
  if (normalised.error) return res.status(400).json({ message: normalised.error });

  const existing = await LmShortResponse.findOne({
    sessionId: session._id,
    slideId: slide._id,
    participantId: identity.id,
  });
  if (existing && short.settings?.allowChangeAnswer === false) {
    return res.status(400).json({ message: 'You have already answered this slide.', code: 'ALREADY_ANSWERED' });
  }

  const marked = agg.markResponse(slide, normalised);
  const responseMs = session.slideOpenedAt
    ? Math.max(0, Date.now() - new Date(session.slideOpenedAt).getTime())
    : null;

  await LmShortResponse.findOneAndUpdate(
    { sessionId: session._id, slideId: slide._id, participantId: identity.id },
    {
      $set: {
        shortId: short._id,
        classId: session.classId,
        slideIndex: session.currentSlideIndex,
        slideType: slide.type,
        participantName: identity.name,
        rollNumber: identity.rollNumber,
        isGuest: identity.isGuest,
        selected: normalised.selected,
        text: normalised.text,
        number: normalised.number,
        correct: marked.correct,
        awarded: marked.awarded,
        responseMs,
        updated_at: new Date(),
      },
    },
    { upsert: true, new: true },
  );

  // Keep the presence timestamp fresh so the presenter's participant count
  // reflects who is actually in the room.
  await LmShortSession.updateOne(
    { _id: session._id, 'participants.userId': identity.id },
    { $set: { 'participants.$.lastSeenAt': new Date() } },
  );

  // Points for joining in, keyed on the session rather than the slide: a deck
  // of fifteen questions should be worth turning up for, not fifteen times an
  // assignment. Guests have no account to credit, and are skipped inside.
  await game.onShortAnswer({
    classId: session.classId,
    studentId: identity.isGuest ? null : identity.id,
    studentName: identity.name,
    shortSession: session,
    // A participant may have joined by code with no class loaded on the
    // request, so the academic session is read off the class rather than
    // `req.lmClass`, which is not there on this route.
    session: session.classSession || "",
  });

  return res.json({ saved: true, changed: Boolean(existing) });
};

/* ──────────────────────────── live streaming ──────────────────────────── */

const STREAM_INTERVAL_MS = Number(process.env.LM_SHORTS_STREAM_MS || 1500);
const STREAM_MAX_MS = 9 * 60 * 1000; // under the 10-minute server socket timeout

/**
 * Server-sent events for the presenter and the participants.
 *
 * SSE rather than WebSockets because the platform already uses it elsewhere and
 * the traffic is one-directional — answers go back over ordinary POSTs. The
 * loop polls Mongo and only writes when the payload actually changed, so an
 * idle slide costs one query per tick and no bytes on the wire.
 *
 * The stream closes itself just under the server's socket timeout; the client
 * reconnects, which also recovers from a dropped projector connection.
 */
function openStream(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  };
  return send;
}

const streamLoop = async (req, res, buildPayload) => {
  const send = openStream(req, res);
  let lastSerialised = null;
  let closed = false;
  const startedAt = Date.now();

  req.on('close', () => {
    closed = true;
  });

  const tick = async () => {
    if (closed || res.writableEnded) return false;
    try {
      const payload = await buildPayload();
      if (!payload) {
        send('gone', { message: 'Session no longer available.' });
        return false;
      }
      const serialised = JSON.stringify(payload);
      if (serialised !== lastSerialised) {
        lastSerialised = serialised;
        send('state', payload);
      } else {
        // A comment frame keeps proxies from timing the connection out without
        // pushing a redundant payload.
        res.write(': keep-alive\n\n');
      }
      return true;
    } catch (error) {
      console.error('[LearningModule] shorts stream', error.message);
      send('error', { message: 'Stream error, reconnecting.' });
      return false;
    }
  };

  if (!(await tick())) {
    if (!res.writableEnded) res.end();
    return;
  }

  const timer = setInterval(async () => {
    const alive = await tick();
    if (!alive || Date.now() - startedAt > STREAM_MAX_MS) {
      clearInterval(timer);
      if (!res.writableEnded) res.end();
    }
  }, STREAM_INTERVAL_MS);

  req.on('close', () => clearInterval(timer));
};

exports.streamPresenter = async (req, res) => {
  await streamLoop(req, res, async () => {
    const session = await LmShortSession.findOne({
      _id: req.params.sessionId,
      classId: req.lmClass._id,
    });
    if (!session) return null;
    const short = await LmShort.findById(session.shortId);
    if (!short) return null;

    // The tick is what turns a countdown reaching zero into a visible state
    // change for the whole room — nothing else is watching the clock.
    await settleExpiredSlide(session, short);

    const [results, responseCount] = await Promise.all([
      currentResults(short, session),
      LmShortResponse.countDocuments({ sessionId: session._id }),
    ]);
    return presenterView(short, session, results, responseCount);
  });
};

exports.streamParticipant = async (req, res) => {
  // Standing is checked once up front rather than on every tick — the class
  // roster is not going to change mid-slide, and re-querying it 40 times a
  // minute per student would be the most expensive part of the loop.
  const { session, short, identity, error } = await loadSessionForParticipant(req);
  if (error) return sendParticipantError(res, error);

  const sessionId = session._id;
  const shortId = short._id;
  const participantId = identity.id;

  await streamLoop(req, res, async () => {
    const live = await LmShortSession.findById(sessionId);
    if (!live) return null;
    const deck = await LmShort.findById(shortId);
    if (!deck) return null;

    await settleExpiredSlide(live, deck);

    const slide = slideOf(deck, live.currentSlideIndex);
    const [results, mine] = await Promise.all([
      currentResults(deck, live),
      slide
        ? LmShortResponse.findOne({
            sessionId: live._id,
            slideId: slide._id,
            participantId,
          }).lean()
        : null,
    ]);
    return participantView(deck, live, results, mine);
  });
};

/* ────────────────────────────── review ────────────────────────────────── */

exports.listSessions = async (req, res) => {
  const sessions = await LmShortSession.find({
    shortId: req.params.shortId,
    classId: req.lmClass._id,
  })
    .sort({ startedAt: -1 })
    .lean();

  const counts = await LmShortResponse.aggregate([
    { $match: { sessionId: { $in: sessions.map((session) => session._id) } } },
    { $group: { _id: '$sessionId', responses: { $sum: 1 } } },
  ]);
  const byId = new Map(counts.map((entry) => [String(entry._id), entry.responses]));

  return res.json(
    sessions.map((session) => ({
      _id: session._id,
      joinCode: session.status === 'live' ? session.joinCode : null,
      status: session.status,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      presentedByName: session.presentedByName,
      participantCount: (session.participants || []).length,
      responseCount: byId.get(String(session._id)) || 0,
    })),
  );
};

exports.getSessionReport = async (req, res) => {
  const session = await LmShortSession.findOne({
    _id: req.params.sessionId,
    classId: req.lmClass._id,
  }).lean();
  if (!session) return res.status(404).json({ message: 'Session not found.' });

  const short = await LmShort.findById(session.shortId).lean();
  if (!short) return res.status(404).json({ message: 'Short not found.' });

  const responses = await LmShortResponse.find({ sessionId: session._id }).lean();
  const rollup = agg.aggregateSession(short, session, responses);

  return res.json({
    short: { _id: short._id, title: short.title, settings: short.settings },
    session: {
      _id: session._id,
      status: session.status,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      presentedByName: session.presentedByName,
    },
    ...rollup,
  });
};

exports.exportSessionCsv = async (req, res) => {
  const session = await LmShortSession.findOne({
    _id: req.params.sessionId,
    classId: req.lmClass._id,
  }).lean();
  if (!session) return res.status(404).json({ message: 'Session not found.' });

  const short = await LmShort.findById(session.shortId).lean();
  const responses = await LmShortResponse.find({ sessionId: session._id }).lean();
  const rollup = agg.aggregateSession(short, session, responses);

  const byParticipant = new Map();
  responses.forEach((response) => {
    const key = String(response.participantId);
    if (!byParticipant.has(key)) byParticipant.set(key, new Map());
    byParticipant.get(key).set(String(response.slideId), response);
  });

  const answerText = (slide, response) => {
    if (!response) return '';
    if (slide.type === 'scale' || slide.type === 'numeric') return response.number ?? '';
    if (slide.type === 'wordcloud' || slide.type === 'open') return response.text || '';
    return (response.selected || [])
      .map((index) => (slide.options || [])[Number(index)] ?? index)
      .join(' | ');
  };

  const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const header = [
    'Roll No', 'Participant', 'Email', 'Answered', 'Correct', 'Score', 'Percent',
    ...short.slides.map((slide, index) => `S${index + 1} answer`),
  ];
  const lines = [header.map(escape).join(',')];

  rollup.leaderboard.forEach((entry) => {
    const mine = byParticipant.get(String(entry.userId)) || new Map();
    lines.push(
      [
        entry.rollNumber,
        // Marked inline rather than in a column of its own: a guest row has no
        // roll number or email, which on its own reads like a student whose
        // details are simply missing.
        entry.isGuest ? `${entry.name} (guest)` : entry.name,
        entry.email,
        entry.answered,
        entry.correct,
        `${entry.score}/${rollup.maxScore}`,
        entry.percent === null ? '' : `${entry.percent}%`,
        ...short.slides.map((slide) => answerText(slide, mine.get(String(slide._id)))),
      ]
        .map(escape)
        .join(','),
    );
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${String(short.title).replace(/[^a-z0-9]+/gi, '_')}_short.csv"`,
  );
  return res.send(lines.join('\n'));
};

exports.prepareSlides = prepareSlides;
exports.validateSlides = validateSlides;
