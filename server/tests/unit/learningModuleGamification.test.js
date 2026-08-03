/**
 * The pure half of points and badges: which week an award lands in, and what a
 * score is worth.
 *
 * The week key is the part worth pinning hardest. Every weekly leaderboard is a
 * plain match on it, so a key that disagrees with the calendar at the turn of
 * the year silently splits or merges two weeks' tables — and it would be found
 * in January, by a student whose points had gone missing.
 */

const game = require("../../src/modules/learningModule/services/gamification");

describe("learningModule gamification — weekKeyOf", () => {
  it("puts a Monday and the Sunday that follows it in the same week", () => {
    const monday = new Date(Date.UTC(2026, 6, 27));
    const sunday = new Date(Date.UTC(2026, 7, 2));
    expect(game.weekKeyOf(monday)).toBe(game.weekKeyOf(sunday));
  });

  it("starts a new week on Monday, not Sunday", () => {
    const sunday = new Date(Date.UTC(2026, 7, 2));
    const nextMonday = new Date(Date.UTC(2026, 7, 3));
    expect(game.weekKeyOf(nextMonday)).not.toBe(game.weekKeyOf(sunday));
  });

  // ISO's rule: a week belongs to the year holding its Thursday. 1 Jan 2027 is
  // a Friday, so it falls in the last week of 2026 — the case a naive
  // "week number within this year" gets wrong.
  it("keeps the days either side of new year in one week", () => {
    const dec31 = new Date(Date.UTC(2026, 11, 31)); // Thursday
    const jan1 = new Date(Date.UTC(2027, 0, 1)); // Friday
    expect(game.weekKeyOf(jan1)).toBe(game.weekKeyOf(dec31));
    expect(game.weekKeyOf(jan1)).toBe("2026-W53");
  });

  it("formats the week with a padded number so keys sort as strings", () => {
    // The leaderboard sorts and compares these as plain strings.
    expect(game.weekKeyOf(new Date(Date.UTC(2026, 0, 8)))).toBe("2026-W02");
  });

  it("resolves a key back to the Monday it names", () => {
    const monday = game.weekStartOf("2026-W31");
    expect(monday.getUTCDay()).toBe(1);
    expect(game.weekKeyOf(monday)).toBe("2026-W31");
  });
});

describe("learningModule gamification — what a score is worth", () => {
  it("pays a point per five percent, on top of the points for sitting it", () => {
    expect(game.POINTS.quizScoreBonus(100)).toBe(20);
    expect(game.POINTS.quizScoreBonus(55)).toBe(11);
    expect(game.POINTS.quizScoreBonus(0)).toBe(0);
  });

  // Sitting the paper is at least half of it however well it went. If the bonus
  // could beat the attempt, points would become a second grade — which the
  // class already has, and better.
  it("never lets the score bonus outweigh sitting the paper at all", () => {
    expect(game.POINTS.quizScoreBonus(100)).toBeLessThanOrEqual(game.POINTS.quizAttempt);
  });

  it("survives a missing or absurd percentage rather than paying nonsense", () => {
    expect(game.POINTS.quizScoreBonus(undefined)).toBe(0);
    expect(game.POINTS.quizScoreBonus(-20)).toBe(0);
    expect(game.POINTS.quizScoreBonus(1000)).toBe(20);
  });

  /**
   * The ladder, heaviest first. Pinned as an ordering rather than as numbers so
   * the values can be tuned without rewriting the test — what must not change
   * is that an evening on a coding exercise beats an afternoon of comments.
   */
  it("pays heavier work more than lighter work", () => {
    const { POINTS: p } = game;
    // A coding exercise still pays the most of anything on the ladder, but it
    // pays it for finishing: the base alone must not out-earn an assignment.
    expect(p.notebookOnTime + p.notebookCompleted).toBeGreaterThan(p.submissionOnTime);
    expect(p.submissionOnTime).toBeGreaterThan(p.notebookOnTime);
    expect(p.notebookOnTime).toBeGreaterThanOrEqual(p.quizAttempt);
    expect(p.submissionOnTime).toBeGreaterThan(p.quizAttempt);
    expect(p.quizAttempt).toBeGreaterThanOrEqual(p.tutorial);
    expect(p.tutorial).toBeGreaterThan(p.feedback);
    expect(p.feedback).toBeGreaterThan(p.shortAnswer);
    expect(p.shortAnswer).toBeGreaterThan(p.comment);
  });

  it("pays less for late work, but still pays", () => {
    // Nothing at all for a late submission teaches "do not bother", which is
    // the opposite of what a participation score is for.
    expect(game.POINTS.submissionLate).toBeGreaterThan(0);
    expect(game.POINTS.submissionLate).toBeLessThan(game.POINTS.submissionOnTime);
  });
});

describe("learningModule gamification — the badge catalogue", () => {
  it("gives every badge a name, an emoji and a plain description", () => {
    // The hint is not decoration: a name that lands with one person is a shrug
    // to another, and nobody should have to guess what they did to earn it.
    // Collected rather than asserted per badge, so a failure names the badges
    // that are wrong instead of stopping at the first.
    const incomplete = Object.entries(game.BADGES)
      .filter(([, badge]) => !badge.name || !badge.emoji || !/\w/.test(badge.hint || ''))
      .map(([id]) => id);
    expect(incomplete).toEqual([]);
  });

  it("describes an unknown badge instead of rendering a blank", () => {
    // Slang moves and badges get renamed; somebody holding the old id should
    // still see something.
    expect(game.describeBadge("retired-badge")).toMatchObject({ id: "retired-badge", emoji: "🏅" });
  });
});
