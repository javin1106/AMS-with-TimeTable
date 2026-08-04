const mongoose = require("mongoose");

/**
 * A topic a student opened for the class to talk about.
 *
 * Separate from the stream on purpose. The stream is the teacher broadcasting —
 * posts, classwork, announcements — and a student question dropped into it
 * competes with the homework and is gone by the next post. A forum is the other
 * direction: the class talks, and staff join in.
 *
 * Replies are `lm_comment` rows with `targetType: "discussion"`, so threading,
 * notification and moderation all behave exactly as they do everywhere else in
 * the module rather than being reimplemented here.
 */
const lmDiscussionSchema = new mongoose.Schema({
  classId: { type: mongoose.Schema.Types.ObjectId, ref: "lm_class", required: true, index: true },

  title: { type: String, required: true, trim: true },
  body: { type: String, default: "" },

  authorId: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true, index: true },
  authorName: { type: String, default: "" },
  authorRole: { type: String, enum: ["teacher", "co-teacher", "student"], default: "student" },

  /**
   * The ISO week the topic was opened in, e.g. "2026-W31".
   *
   * Stored so the one-a-week rule can be an index rather than a check. A
   * read-then-write would let a double-tapped button through, and "how many
   * have I posted this week" is exactly the question two simultaneous requests
   * both answer with "none".
   */
  weekKey: { type: String, required: true },

  // Denormalised for the list, which would otherwise need a count per row.
  replyCount: { type: Number, default: 0 },
  lastReplyAt: { type: Date, default: null },
  lastReplyBy: { type: String, default: "" },

  // Staff can pin something worth keeping at the top, and close a thread that
  // has run its course. Neither deletes anything.
  pinned: { type: Boolean, default: false },
  closed: { type: Boolean, default: false },

  /**
   * Removal is a flag, not a delete, and the row stays either way.
   *
   * If the row went, so would the week's rate-limit entry — post, delete, post
   * again, indefinitely. Keeping it is what makes one-a-week mean one a week.
   *
   * `removedByStaff` additionally decides whether the class sees a tombstone: a
   * thread taken down by a teacher leaves a visible mark, because moderation
   * that looks like the post never existed is worse than moderation.
   */
  removed: { type: Boolean, default: false },
  removedByStaff: { type: Boolean, default: false },
  removedByName: { type: String, default: "" },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

/**
 * One new topic per student per week.
 *
 * Partial, so it binds students only: staff open threads as part of running the
 * class and are not rationed. The limit exists because an unlimited forum in a
 * class of two hundred becomes unreadable within a week, and because a topic
 * somebody had to choose is a better topic.
 */
lmDiscussionSchema.index(
  { classId: 1, authorId: 1, weekKey: 1 },
  { unique: true, partialFilterExpression: { authorRole: "student" } },
);
lmDiscussionSchema.index({ classId: 1, pinned: -1, lastReplyAt: -1 });

module.exports = mongoose.model("lm_discussion", lmDiscussionSchema);
