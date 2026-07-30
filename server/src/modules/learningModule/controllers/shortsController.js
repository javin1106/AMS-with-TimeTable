const crypto = require('crypto');

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

/** What the presenter's screen needs. */
const presenterView = (short, session, slideResults, responseCount) => ({
  sessionId: session._id,
  shortId: short._id,
  title: short.title,
  joinCode: session.joinCode,
  status: session.status,
  revision: session.revision,
  slideIndex: session.currentSlideIndex,
  slideCount: short.slides.length,
  slideState: session.slideState,
  slideDeadline: session.slideDeadline,
  slide: (() => {
    const slide = slideOf(short, session.currentSlideIndex);
    if (!slide) return null;
    return {
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
    };
  })(),
  results: slideResults,
  participantCount: (session.participants || []).length,
  responseCount,
  settings: short.settings,
});

/**
 * What a participant's phone needs. Deliberately narrower than the presenter
 * view: no answer key unless the slide has been revealed, and no results at all
 * unless the deck opts in.
 */
const participantView = (short, session, slideResults, myResponse) => {
  const slide = slideOf(short, session.currentSlideIndex);
  const revealed = session.slideState === 'revealed';

  return {
    sessionId: session._id,
    title: short.title,
    status: session.status,
    revision: session.revision,
    slideIndex: session.currentSlideIndex,
    slideCount: short.slides.length,
    slideState: session.slideState,
    slideDeadline: session.slideDeadline,
    slide: slide
      ? {
          _id: slide._id,
          type: slide.type,
          question: slide.question,
          options: slide.options,
          timeLimitSec: slide.timeLimitSec,
          scaleMin: slide.scaleMin,
          scaleMax: slide.scaleMax,
          scaleMinLabel: slide.scaleMinLabel,
          scaleMaxLabel: slide.scaleMaxLabel,
          maxWords: slide.maxWords,
          maxLength: slide.maxLength,
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
    canAnswer: session.status === 'live' && session.slideState === 'open',
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
    reveal: session.slideState === 'revealed',
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
        if (!entry.userId) continue;
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
 * Resolves a join code to a live session. Class membership is enforced here
 * rather than by the router, because the participant only has a code — they do
 * not know the classId yet.
 */
exports.joinByCode = async (req, res) => {
  const code = String(req.params.code || '').trim();
  const session = await LmShortSession.findOne({ joinCode: code, status: 'live' });
  if (!session) {
    return res.status(404).json({ message: 'No live short matches that code.', code: 'NO_SESSION' });
  }

  const membership = await LmMembership.findOne({
    classId: session.classId,
    userId: req.lmUser.id,
    status: 'active',
  }).lean();
  if (!membership) {
    return res.status(403).json({ message: 'You are not a member of the class running this short.' });
  }

  const short = await LmShort.findById(session.shortId);
  if (!short) return res.status(404).json({ message: 'Short not found.' });

  if (!short.settings?.allowLateJoin && session.currentSlideIndex > 0) {
    return res.status(403).json({ message: 'This short has already moved on and is not accepting new joiners.' });
  }

  const already = (session.participants || []).some(
    (participant) => String(participant.userId) === req.lmUser.id,
  );
  if (!already) {
    session.participants.push({
      userId: req.lmUser.id,
      name: req.lmUser.name,
      email: req.lmUser.email,
      rollNumber: membership.rollNumber || '',
    });
    touchRevision(session);
    await session.save();
  }

  return res.json({
    sessionId: session._id,
    classId: session.classId,
    title: short.title,
    joined: true,
  });
};

const loadSessionForParticipant = async (req) => {
  const session = await LmShortSession.findById(req.params.sessionId);
  if (!session) return { error: { status: 404, message: 'Session not found.' } };

  const membership = await LmMembership.findOne({
    classId: session.classId,
    userId: req.lmUser.id,
    status: 'active',
  }).lean();
  if (!membership) return { error: { status: 403, message: 'Forbidden' } };

  const short = await LmShort.findById(session.shortId);
  if (!short) return { error: { status: 404, message: 'Short not found.' } };
  return { session, short, membership };
};

exports.getParticipantState = async (req, res) => {
  const { session, short, error } = await loadSessionForParticipant(req);
  if (error) return res.status(error.status).json({ message: error.message });

  const slide = slideOf(short, session.currentSlideIndex);
  const [results, mine] = await Promise.all([
    currentResults(short, session),
    slide
      ? LmShortResponse.findOne({
          sessionId: session._id,
          slideId: slide._id,
          participantId: req.lmUser.id,
        }).lean()
      : null,
  ]);

  return res.json(participantView(short, session, results, mine));
};

exports.submitResponse = async (req, res) => {
  const { session, short, membership, error } = await loadSessionForParticipant(req);
  if (error) return res.status(error.status).json({ message: error.message });

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
  // paused tab must not be able to answer after time.
  if (session.slideDeadline && new Date() > new Date(session.slideDeadline)) {
    return res.status(400).json({ message: 'Time is up for this slide.', code: 'EXPIRED' });
  }

  const normalised = agg.normaliseAnswer(slide, req.body);
  if (normalised.error) return res.status(400).json({ message: normalised.error });

  const existing = await LmShortResponse.findOne({
    sessionId: session._id,
    slideId: slide._id,
    participantId: req.lmUser.id,
  });
  if (existing && short.settings?.allowChangeAnswer === false) {
    return res.status(400).json({ message: 'You have already answered this slide.', code: 'ALREADY_ANSWERED' });
  }

  const marked = agg.markResponse(slide, normalised);
  const responseMs = session.slideOpenedAt
    ? Math.max(0, Date.now() - new Date(session.slideOpenedAt).getTime())
    : null;

  await LmShortResponse.findOneAndUpdate(
    { sessionId: session._id, slideId: slide._id, participantId: req.lmUser.id },
    {
      $set: {
        shortId: short._id,
        classId: session.classId,
        slideIndex: session.currentSlideIndex,
        slideType: slide.type,
        participantName: req.lmUser.name,
        rollNumber: membership.rollNumber || '',
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
    { _id: session._id, 'participants.userId': req.lmUser.id },
    { $set: { 'participants.$.lastSeenAt': new Date() } },
  );

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

    const [results, responseCount] = await Promise.all([
      currentResults(short, session),
      LmShortResponse.countDocuments({ sessionId: session._id }),
    ]);
    return presenterView(short, session, results, responseCount);
  });
};

exports.streamParticipant = async (req, res) => {
  // Membership is checked once up front rather than on every tick — the class
  // roster is not going to change mid-slide, and re-querying it 40 times a
  // minute per student would be the most expensive part of the loop.
  const { session, short, error } = await loadSessionForParticipant(req);
  if (error) return res.status(error.status).json({ message: error.message });

  const sessionId = session._id;
  const shortId = short._id;

  await streamLoop(req, res, async () => {
    const live = await LmShortSession.findById(sessionId);
    if (!live) return null;
    const deck = await LmShort.findById(shortId);
    if (!deck) return null;

    const slide = slideOf(deck, live.currentSlideIndex);
    const [results, mine] = await Promise.all([
      currentResults(deck, live),
      slide
        ? LmShortResponse.findOne({
            sessionId: live._id,
            slideId: slide._id,
            participantId: req.lmUser.id,
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
        entry.name,
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
