const mongoose = require('mongoose');

/**
 * One participant's answer to one slide of one session.
 *
 * Kept as its own collection rather than an array on the session because these
 * arrive in bursts — sixty rows within a couple of seconds of a slide opening —
 * and the aggregation reads them by (sessionId, slideId). Appending to an array
 * on a single hot document would serialise those writes.
 */

const lmShortResponseSchema = new mongoose.Schema({
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'lm_short_session', required: true, index: true },
  shortId: { type: mongoose.Schema.Types.ObjectId, ref: 'lm_short', required: true },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'lm_class', required: true, index: true },
  slideId: { type: mongoose.Schema.Types.ObjectId, required: true },
  slideIndex: { type: Number, default: 0 },
  slideType: { type: String, default: '' },

  participantId: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
  // Copied at answer time so results survive the person leaving the class, and
  // so aggregation never needs a join.
  participantName: { type: String, default: '' },
  rollNumber: { type: String, default: '' },
  // Answered without being on the class roll — see lmShortSession. Copied here
  // as well so a roll-up can tell a guest from a student even for a response
  // whose participant row went missing.
  isGuest: { type: Boolean, default: false },

  /* ---- the answer, by type ---- */
  // mcq / msq / truefalse / ranking: option indices. For ranking the array
  // order *is* the ranking.
  selected: [{ type: String }],
  // wordcloud / open
  text: { type: String, default: '' },
  // scale / numeric
  number: { type: Number, default: null },

  /* ---- marking, only for slides that carry a key ---- */
  correct: { type: Boolean, default: null },
  awarded: { type: Number, default: 0 },
  // Milliseconds from the slide opening to this answer landing. Measured
  // server-side; useful for "who buzzed in first" and for spotting a slide
  // everyone found slow.
  responseMs: { type: Number, default: null },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

// One answer per person per slide; re-answering updates the row in place when
// the deck allows it.
lmShortResponseSchema.index({ sessionId: 1, slideId: 1, participantId: 1 }, { unique: true });
lmShortResponseSchema.index({ sessionId: 1, slideId: 1 });

module.exports = mongoose.model('lm_short_response', lmShortResponseSchema);
