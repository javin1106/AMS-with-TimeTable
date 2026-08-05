import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import useProctoring from '../hooks/useProctoring';

/**
 * The lockdown is only worth having if it is actually on, and both ways it can
 * silently fail are invisible from the outside: a hook that never becomes
 * active leaves right-click working, and a fullscreen flag that stops tracking
 * leaves the "you have left fullscreen" gate reading "still fullscreen" for the
 * rest of the sitting. Both are tested here rather than through the screen,
 * because both were shipped once with the screen looking perfectly correct.
 */

/** jsdom implements neither the property nor the request. */
const setFullscreen = (on) => {
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    value: on ? document.body : null,
  });
  act(() => {
    document.dispatchEvent(new Event('fullscreenchange'));
  });
};

const rightClick = () => {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  act(() => {
    document.dispatchEvent(event);
  });
  return event;
};

describe('learningModule useProctoring', () => {
  it('blocks right-click and reports it while a sitting is live', () => {
    const onViolation = vi.fn().mockResolvedValue({});
    renderHook(() =>
      useProctoring({ settings: { disableRightClick: true }, active: true, onViolation }),
    );

    expect(rightClick().defaultPrevented).toBe(true);
    expect(onViolation).toHaveBeenCalledWith('right_click', expect.any(String));
  });

  it('leaves right-click alone when the paper did not ask for it', () => {
    renderHook(() => useProctoring({ settings: {}, active: true }));

    expect(rightClick().defaultPrevented).toBe(false);
  });

  it('holds the restrictions on the brief, where there is nothing to report to', () => {
    // No `onViolation`: the pre-test screen is already on the fullscreen stage,
    // so a working right-click there reads as the lockdown not being on.
    renderHook(() => useProctoring({ settings: { disableRightClick: true }, active: true }));

    expect(rightClick().defaultPrevented).toBe(true);
  });

  it('tracks fullscreen even before a sitting is active', () => {
    setFullscreen(true);
    const { result } = renderHook(() =>
      useProctoring({ settings: {}, active: false }),
    );
    expect(result.current.isFullscreen).toBe(true);

    setFullscreen(false);
    expect(result.current.isFullscreen).toBe(false);
  });

  it('reports leaving fullscreen only once a sitting is live', () => {
    setFullscreen(true);
    const onViolation = vi.fn().mockResolvedValue({});
    const { rerender, result } = renderHook(
      ({ active }) =>
        useProctoring({ settings: {}, active, onViolation }),
      { initialProps: { active: false } },
    );

    setFullscreen(false);
    expect(result.current.isFullscreen).toBe(false);
    expect(onViolation).not.toHaveBeenCalled();

    setFullscreen(true);
    rerender({ active: true });
    setFullscreen(false);
    expect(onViolation).toHaveBeenCalledWith('fullscreen_exit', expect.any(String));
  });

  /**
   * Leaving is no longer a per-quiz option, so the empty settings object below
   * is the point of the test: a paper that configures nothing is still locked
   * down, because the server ends the attempt on the first departure and the
   * report is what tells it one happened.
   */
  it('reports leaving the tab and the window on a paper that configures nothing', () => {
    const onViolation = vi.fn().mockResolvedValue({});
    renderHook(() => useProctoring({ settings: {}, active: true, onViolation }));

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(onViolation).toHaveBeenCalledWith('tab_switch', expect.any(String));

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(onViolation).toHaveBeenCalledWith('blur', expect.any(String));
  });

  /**
   * The hole this closes: a student drops their connection *before* leaving
   * fullscreen, so the report that would have ended their attempt fails, and
   * nothing ever retried it. Pulling the network cable was a free pass.
   */
  describe('reports that could not be sent', () => {
    const attemptId = 'attempt-1';

    beforeEach(() => {
      sessionStorage.clear();
      setFullscreen(true);
    });

    it('keeps a failed report and replays it with the time it happened', async () => {
      const onViolation = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({});
      const onHeartbeat = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({});

      renderHook(() =>
        useProctoring({ settings: {}, active: true, attemptId, onViolation, onHeartbeat }),
      );
      await act(async () => {});

      setFullscreen(false);
      await act(async () => {});

      // Reported, refused, and not thrown away.
      expect(onViolation).toHaveBeenCalledTimes(1);
      const [, firstAt] = onViolation.mock.calls[0];
      expect(JSON.parse(sessionStorage.getItem(`lmProctorQueue:${attemptId}`))).toEqual([
        { type: 'fullscreen_exit', at: firstAt },
      ]);

      // Coming back online drains it, carrying the original timestamp rather
      // than the moment of reconnection.
      await act(async () => {
        window.dispatchEvent(new Event('online'));
      });

      expect(onViolation).toHaveBeenCalledTimes(2);
      expect(onViolation).toHaveBeenLastCalledWith('fullscreen_exit', firstAt);
      expect(sessionStorage.getItem(`lmProctorQueue:${attemptId}`)).toBeNull();
    });

    it('terminates on the replay, and drops what is left behind it', async () => {
      const onViolation = vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue({ terminated: true, message: 'Submitted automatically.' });
      const onTerminated = vi.fn();

      const { result } = renderHook(() =>
        useProctoring({ settings: {}, active: true, attemptId, onViolation, onTerminated }),
      );

      setFullscreen(false);
      await act(async () => {});
      act(() => {
        window.dispatchEvent(new Event('blur'));
      });
      await act(async () => {});
      expect(JSON.parse(sessionStorage.getItem(`lmProctorQueue:${attemptId}`))).toHaveLength(2);

      await act(async () => {
        await result.current.flushViolations();
      });

      // The first replay ended the attempt, so the second is not sent: it would
      // be a no-op against a finished sitting, and the queue must not outlive it.
      expect(onViolation).toHaveBeenCalledTimes(3);
      expect(onTerminated).toHaveBeenCalledTimes(1);
      expect(result.current.warning).toBe('Submitted automatically.');
      expect(sessionStorage.getItem(`lmProctorQueue:${attemptId}`)).toBeNull();
    });

    it('holds the queue when the connection is still down', async () => {
      const onViolation = vi.fn().mockRejectedValue(new Error('offline'));

      const { result } = renderHook(() =>
        useProctoring({ settings: {}, active: true, attemptId, onViolation }),
      );

      setFullscreen(false);
      await act(async () => {});
      await act(async () => {
        await result.current.flushViolations();
      });

      expect(JSON.parse(sessionStorage.getItem(`lmProctorQueue:${attemptId}`))).toHaveLength(1);
    });
  });
});
