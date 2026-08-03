import { describe, expect, it, vi } from 'vitest';
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
    expect(onViolation).toHaveBeenCalledWith('right_click');
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
      useProctoring({ settings: { requireFullscreen: true }, active: false }),
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
        useProctoring({ settings: { requireFullscreen: true }, active, onViolation }),
      { initialProps: { active: false } },
    );

    setFullscreen(false);
    expect(result.current.isFullscreen).toBe(false);
    expect(onViolation).not.toHaveBeenCalled();

    setFullscreen(true);
    rerender({ active: true });
    setFullscreen(false);
    expect(onViolation).toHaveBeenCalledWith('fullscreen_exit');
  });
});
