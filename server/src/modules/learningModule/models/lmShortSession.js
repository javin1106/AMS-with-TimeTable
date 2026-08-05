const mongoose = require('mongoose');

/**
 * One run of a Short.
 *
 * Sessions exist rather than putting the live state on the deck itself because
 * a teacher runs the same warm-up in two sections on the same morning. Without
 * a per-run record the second class's answers would pile on top of the first's,
 * and the join code would stay live long after the lecture ended.
 *
 * The join code lives here too, so it only works while a session is actually
 * being presented.
 */

const lmShortSessionSchema = new mongoose.Schema({
  shortId: { type: mongoose.Schema.Types.ObjectId, ref: 'lm_short', required: true, index: true },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'lm_class', required: true, index: true },
  title: { type: String, default: '' },
  // The class's academic session, copied when the deck is presented. The
  // participant route has no class loaded — someone can join by code with no
  // membership at all — so points earned here would otherwise have no session
  // to file themselves under.
  classSession: { type: String, default: '' },

  // Numeric and short, because it gets read off a projector and typed on a
  // phone. Only unique among *live* sessions — see the partial index below.
  joinCode: { type: String, required: true, index: true },

  status: { type: String, enum: ['live', 'ended'], default: 'live', index: true },

  /* ---- what the room is looking at right now ---- */
  currentSlideIndex: { type: Number, default: 0 },
  // waiting  → slide shown, not accepting answers yet
  // open     → accepting answers
  // locked   → closed, results shown, answer key hidden
  // revealed → closed, results plus the correct answer
  slideState: {
    type: String,
    enum: ['waiting', 'open', 'locked', 'revealed'],
    default: 'waiting',
  },
  slideOpenedAt: { type: Date, default: null },
  // Cached so the presenter and participant streams agree on the countdown
  // without each recomputing it.
  slideDeadline: { type: Date, default: null },

  participants: [
    {
      // For a guest this is a minted id that refs no user document — it exists
      // so one phone keeps one identity for the length of the session.
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
      name: { type: String, default: '' },
      email: { type: String, default: '' },
      rollNumber: { type: String, default: '' },
      // Not on the class roll: either a signed-out visitor who typed a name, or
      // an account that is not enrolled here. Either way their score cannot go
      // to the gradebook, and the report says so rather than implying a student.
      isGuest: { type: Boolean, default: false },
      joinedAt: { type: Date, default: Date.now },
      lastSeenAt: { type: Date, default: Date.now },
      _id: false,
    },
  ],

  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date, default: null },
  presentedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
  presentedByName: { type: String, default: '' },

  // Bumped on every state change so a polling client can tell "nothing new"
  // from "you missed a slide" without diffing the whole payload.
  revision: { type: Number, default: 0 },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

// A code only has to be unique among sessions that are still live, so codes
// stay short and are recycled naturally once a session ends.
lmShortSessionSchema.index(
  { joinCode: 1 },
  { unique: true, partialFilterExpression: { status: 'live' } },
);

module.exports = mongoose.model('lm_short_session', lmShortSessionSchema);
