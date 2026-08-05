/**
 * Timestamps on proctoring reports that arrive late.
 *
 * The hole this closes: a student who dropped their connection *before* leaving
 * fullscreen had the report fail, and nothing ever retried it — pulling the
 * network cable was a free pass. The client now queues what it could not send
 * and replays it, which means a report can arrive minutes after the event it
 * describes, carrying the client's own timestamp.
 *
 * That timestamp is the client's, so it is not trusted; it is clamped. These
 * tests are about the clamp, because the whole value of the queue is that a
 * late report is still judged, and the whole risk of it is a timestamp used for
 * anything more than saying how late.
 */

const { violationTime } = require('../../src/modules/learningModule/controllers/quizController');

const MINUTE = 60 * 1000;
const NOW = new Date('2026-03-01T10:00:00Z');
const ago = (ms) => new Date(NOW.getTime() - ms);

const attempt = { startedAt: ago(30 * MINUTE) };

describe('learningModule violationTime', () => {
  it('keeps a plausible client timestamp, so a queued report says when it happened', () => {
    const left = ago(4 * MINUTE);
    expect(violationTime(left.toISOString(), attempt, NOW)).toEqual(left);
  });

  it('falls back to now when there is no timestamp — the ordinary live report', () => {
    expect(violationTime(undefined, attempt, NOW)).toEqual(NOW);
    expect(violationTime('', attempt, NOW)).toEqual(NOW);
  });

  it('falls back to now on a timestamp it cannot read', () => {
    expect(violationTime('not a date', attempt, NOW)).toEqual(NOW);
  });

  /**
   * The two clamps. Neither buys a student anything — the attempt is terminated
   * on arrival whatever this says — but an unclamped value would let a modified
   * client write a violation outside the sitting it belongs to, which is a
   * record a teacher would then have to explain.
   */
  it('refuses a future timestamp', () => {
    expect(violationTime(new Date(NOW.getTime() + 10 * MINUTE).toISOString(), attempt, NOW)).toEqual(NOW);
  });

  it('refuses a timestamp from before the paper started', () => {
    expect(violationTime(ago(90 * MINUTE).toISOString(), attempt, NOW)).toEqual(attempt.startedAt);
  });
});
