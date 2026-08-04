import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Client half of the quiz proctoring options.
 *
 * Everything here is a deterrent, not a guarantee — a determined student can
 * defeat any of it with devtools. What makes it useful is that every event is
 * **reported to the server and recorded on the attempt**, so the teacher sees
 * who left the window and how often. The enforcement decision (warn vs
 * auto-submit) is also the server's, not this hook's.
 *
 * @param {object} options
 * @param {object} options.settings   the quiz's proctoring settings
 * @param {boolean} options.active    only watch while a sitting is in progress
 * @param {(type: string) => Promise<object>} options.onViolation
 *        reports to the server; its response may ask us to stop (terminated)
 * @param {() => void} options.onTerminated
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

export default function useProctoring({
  settings = {},
  active,
  onViolation,
  onTerminated,
  onHeartbeat,
}) {
  const [tabSwitches, setTabSwitches] = useState(0);
  const [warning, setWarning] = useState(null);
  const [remaining, setRemaining] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const terminatedRef = useRef(false);

  const report = useCallback(
    async (type) => {
      if (terminatedRef.current || !onViolation) return;
      try {
        const result = await onViolation(type);
        if (result?.tabSwitches !== undefined) setTabSwitches(result.tabSwitches);
        if (result?.remaining !== undefined) setRemaining(result.remaining);
        if (result?.warning) setWarning(result.warning);
        if (result?.terminated) {
          terminatedRef.current = true;
          setWarning(result.message || 'Your test was submitted automatically.');
          onTerminated?.();
        }
      } catch {
        // A failed report must not interrupt the test; the local counter still
        // moves so the on-screen warning stays honest.
        setTabSwitches((count) => count + 1);
      }
    },
    [onViolation, onTerminated],
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
        }
      } catch {
        // Offline, or the request was blocked. Either way the server sees the
        // gap; there is nothing useful to do here.
      }
    };

    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, onHeartbeat, onTerminated]);

  /* ---- leaving the window ---- */
  useEffect(() => {
    if (!active || settings.allowTabChange) return undefined;

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
  }, [active, settings.allowTabChange, report]);

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

  /* ---- fullscreen ---- */
  useEffect(() => {
    if (!active || !settings.requireFullscreen) return undefined;

    const onChange = () => {
      const inFullscreen = Boolean(document.fullscreenElement);
      setIsFullscreen(inFullscreen);
      if (!inFullscreen) report('fullscreen_exit');
    };
    document.addEventListener('fullscreenchange', onChange);
    setIsFullscreen(Boolean(document.fullscreenElement));
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [active, settings.requireFullscreen, report]);

  /**
   * Fullscreens `target` — the caller passes the quiz element itself, so the
   * surrounding app chrome (module header, class header, tabs) is left behind
   * rather than blown up to fill the screen with it.
   */
  const enterFullscreen = useCallback(async (target) => {
    const element = target instanceof Element ? target : document.documentElement;
    try {
      await element.requestFullscreen();
      setIsFullscreen(true);
      return true;
    } catch {
      // Browsers only grant this from a user gesture; the caller shows a prompt.
      return false;
    }
  }, []);

  const exitFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
    } catch {
      // Nothing useful to do if the browser refuses.
    }
  }, []);

  return {
    tabSwitches,
    warning,
    remaining,
    isFullscreen,
    enterFullscreen,
    exitFullscreen,
    dismissWarning: () => setWarning(null),
  };
}

/** Same UA test the server uses, for the pre-test device check. */
export const isMobileDevice = () =>
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(navigator.userAgent);
