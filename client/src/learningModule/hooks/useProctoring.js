import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Client half of the quiz proctoring options.
 *
 * Everything here is a deterrent, not a guarantee — a determined student can
 * defeat any of it with devtools. What makes it useful is that every event is
 * **reported to the server and recorded on the attempt**, so the teacher sees
 * who left the window. The enforcement decision is the server's, not this
 * hook's: leaving the tab, the window or fullscreen submits the attempt on the
 * first offence, and the reply comes back `terminated`.
 *
 * @param {object} options
 * @param {object} options.settings   the quiz's proctoring settings
 * @param {boolean} options.active    only watch while a sitting is in progress
 * @param {string} [options.attemptId] keys the offline queue below; without it
 *        a report that cannot be sent is simply lost.
 * @param {(type: string, at: string) => Promise<object>} [options.onViolation]
 *        reports to the server; its response may ask us to stop (terminated).
 *        `at` is when the event actually happened, which is not when it is sent
 *        — see the queue below. Omitting the callback leaves the deterrents in
 *        place and reports nothing, which is what the pre-test brief wants: the
 *        same locked-down screen, with nothing yet to record it against.
 * @param {() => void} [options.onTerminated]
 * @param {() => Promise<object>} [options.onHeartbeat]
 *        called on a timer while the paper is open. Unlike the violation
 *        reports, this one matters by its *absence*: a client whose reporting
 *        has been blocked in devtools stops sending it, and the server records
 *        the silence. It also lets the server end a paper whose time ran out
 *        while the student sat looking at it.
 */
// Three of these may be missed before the server notes the silence, so a brief
// hiccup costs nothing while a blocked client is visible within a couple of
// minutes.
const HEARTBEAT_MS = 30 * 1000;

/**
 * Departures that could not be reported when they happened.
 *
 * The case this exists for: a student drops their connection, leaves fullscreen
 * "to check the wifi", and comes back. The exit fired locally, but the POST that
 * would have ended their attempt failed, and nothing ever retried it — so
 * pulling the network cable before switching windows was a free pass. Queued
 * here instead, and flushed the moment anything reaches the server again.
 *
 * sessionStorage so it survives a reload of the same tab, which is the cheap
 * version of the same trick. It does not survive clearing storage in devtools,
 * and it is not meant to: a client that has been tampered with is what the
 * server's heartbeat gap is for. This closes the accident-shaped hole, not the
 * determined one.
 */
const QUEUE_KEY = (attemptId) => `lmProctorQueue:${attemptId}`;
// Far more than a real sitting produces; a bound only so a pathological loop
// cannot fill storage.
const QUEUE_MAX = 50;

const readQueue = (key) => {
  if (!key) return [];
  try {
    const parsed = JSON.parse(sessionStorage.getItem(key) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writeQueue = (key, items) => {
  if (!key) return;
  try {
    if (items.length) sessionStorage.setItem(key, JSON.stringify(items.slice(-QUEUE_MAX)));
    else sessionStorage.removeItem(key);
  } catch {
    // A browser refusing storage costs us the queue, not the sitting.
  }
};

export default function useProctoring({
  settings = {},
  active,
  attemptId,
  onViolation,
  onTerminated,
  onHeartbeat,
}) {
  const [tabSwitches, setTabSwitches] = useState(0);
  const [warning, setWarning] = useState(null);
  const [remaining, setRemaining] = useState(null);
  // Seeded from the document rather than `false`: the quiz stage is already
  // fullscreen by the time a sitting mounts, and starting at false would flash
  // the "fullscreen required" gate for a frame before the watcher corrected it.
  const [isFullscreen, setIsFullscreen] = useState(() => Boolean(document.fullscreenElement));
  const terminatedRef = useRef(false);
  const flushingRef = useRef(false);

  const queueKey = attemptId ? QUEUE_KEY(attemptId) : null;

  /** What the server said about a report, whenever it was sent. */
  const applyResult = useCallback(
    (result) => {
      if (result?.tabSwitches !== undefined) setTabSwitches(result.tabSwitches);
      if (result?.remaining !== undefined) setRemaining(result.remaining);
      if (result?.warning) setWarning(result.warning);
      if (result?.terminated) {
        terminatedRef.current = true;
        setWarning(result.message || 'Your test was submitted automatically.');
        onTerminated?.();
      }
    },
    [onTerminated],
  );

  /**
   * Sends everything that was queued while the connection was down.
   *
   * In order, and stopping at the first failure, so a still-broken connection
   * leaves the queue intact rather than dropping the rest of it. A report that
   * lands here can still end the attempt — arriving late is not the same as
   * being forgiven, and the server judges it by the timestamp it carries.
   */
  const flush = useCallback(async () => {
    if (flushingRef.current || terminatedRef.current || !onViolation || !queueKey) return;
    const pending = readQueue(queueKey);
    if (!pending.length) return;

    flushingRef.current = true;
    try {
      while (pending.length) {
        let result;
        try {
          // eslint-disable-next-line no-await-in-loop
          result = await onViolation(pending[0].type, pending[0].at);
        } catch {
          break; // still unreachable — keep what is left for the next attempt
        }
        pending.shift();
        applyResult(result);
        if (terminatedRef.current) {
          // The paper is closed. Anything still queued would be a no-op against
          // a finished attempt, so it goes rather than outliving the sitting.
          pending.length = 0;
        }
      }
    } finally {
      writeQueue(queueKey, pending);
      flushingRef.current = false;
    }
  }, [onViolation, applyResult, queueKey]);

  const report = useCallback(
    async (type) => {
      if (terminatedRef.current || !onViolation) return;
      // Stamped here, not on arrival: the whole point of the queue is that these
      // two moments can be minutes apart.
      const at = new Date().toISOString();
      try {
        applyResult(await onViolation(type, at));
      } catch {
        // A failed report must not interrupt the test, but it must not vanish
        // either. The local counter still moves so the on-screen warning stays
        // honest, and the event waits for a connection.
        writeQueue(queueKey, [...readQueue(queueKey), { type, at }]);
        setTabSwitches((count) => count + 1);
      }
    },
    [onViolation, applyResult, queueKey],
  );

  /* ---- still-here ping ---- */
  useEffect(() => {
    if (!active || !onHeartbeat) return undefined;

    let cancelled = false;
    const beat = async () => {
      if (cancelled || terminatedRef.current) return;
      try {
        const result = await onHeartbeat();
        if (cancelled) return;
        // The server may have finalised the paper on its own clock — a tab left
        // open past the deadline finds out here rather than on the next click.
        if (result?.finished) {
          terminatedRef.current = true;
          if (result.expired) setWarning('Time is up — your test has been submitted.');
          onTerminated?.();
          return;
        }
      } catch {
        // Offline, or the request was blocked. Either way the server sees the
        // gap, and anything we could not report is already queued.
        return;
      }
      // A heartbeat got through, so the connection is back: this is the first
      // and most reliable moment to hand over what was missed. Also covers the
      // mount case, where the immediate beat below drains a queue left behind
      // by a reload.
      if (!cancelled) flush();
    };

    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);
    // Fires well before the next beat is due, which is what shortens the window
    // in which a student is back online and still sitting on an unreported exit.
    window.addEventListener('online', flush);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('online', flush);
    };
  }, [active, onHeartbeat, onTerminated, flush]);

  /* ---- leaving the window ----
     Watched on every paper, with nothing to switch it off: leaving the test is
     no longer counted against a budget, it ends the sitting, and the brief says
     so before the student starts. */
  useEffect(() => {
    if (!active) return undefined;

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') report('tab_switch');
    };
    const onBlur = () => report('blur');

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
    };
  }, [active, report]);

  /* ---- copy / paste ---- */
  useEffect(() => {
    if (!active || !settings.disableCopyPaste) return undefined;

    const block = (event) => {
      event.preventDefault();
      report(event.type === 'copy' ? 'copy' : 'paste');
    };
    document.addEventListener('copy', block);
    document.addEventListener('paste', block);
    document.addEventListener('cut', block);
    return () => {
      document.removeEventListener('copy', block);
      document.removeEventListener('paste', block);
      document.removeEventListener('cut', block);
    };
  }, [active, settings.disableCopyPaste, report]);

  /* ---- right click ---- */
  useEffect(() => {
    if (!active || !settings.disableRightClick) return undefined;

    const block = (event) => {
      event.preventDefault();
      report('right_click');
    };
    document.addEventListener('contextmenu', block);
    return () => document.removeEventListener('contextmenu', block);
  }, [active, settings.disableRightClick, report]);

  /* ---- fullscreen ----
     Every paper is sat in fullscreen, so an exit is always reportable and always
     ends the sitting. The watching is not gated on `active` either: a state
     seeded at mount and then never updated reads "still fullscreen" for the rest
     of the sitting, which is exactly how a fullscreen gate comes to never fire.
     Only the report is gated, on `active` — the brief has no attempt to end. */
  useEffect(() => {
    const onChange = () => {
      const inFullscreen = Boolean(document.fullscreenElement);
      setIsFullscreen(inFullscreen);
      if (!inFullscreen && active) report('fullscreen_exit');
    };
    document.addEventListener('fullscreenchange', onChange);
    setIsFullscreen(Boolean(document.fullscreenElement));
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [active, report]);

  // Entering and leaving fullscreen belongs to the quiz stage, not here: it
  // owns an element that outlives both quiz screens, so one fullscreen covers
  // the brief and the sitting. This hook only watches and reports.
  return {
    tabSwitches,
    warning,
    remaining,
    isFullscreen,
    // Exposed so the sitting can drain the queue before it banks an answer or
    // submits: a queued departure has to be judged before the work it might
    // have bought, not after.
    flushViolations: flush,
    dismissWarning: () => setWarning(null),
  };
}

/** Same UA test the server uses, for the pre-test device check. */
export const isMobileDevice = () =>
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(navigator.userAgent);
