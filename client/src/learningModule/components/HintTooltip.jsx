import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Tooltip } from '@chakra-ui/react';

/**
 * A tooltip that closes when the pointer leaves, and gives up on its own if it
 * somehow does not.
 *
 * Chakra binds the two halves of hover to different places: `onPointerEnter`
 * goes on the cloned child's props, while the matching close is an event
 * listener on whatever the tooltip's *ref* resolved to. For most triggers those
 * are the same element. For a Checkbox they are not — Chakra's Checkbox spreads
 * unknown props onto its visible `<label>` but forwards its ref to the
 * visually-hidden 1px `<input>`. So hovering "Locked" opened the tooltip via
 * the label, and moving away never closed it, because the close listener was
 * sitting on an invisible element the pointer had never been over.
 *
 * Wrapping the trigger fixes that by construction: the span takes both the ref
 * and the handlers, so enter and leave are the same element again. The timer is
 * belt and braces — no hint should outlast the reason it appeared.
 */
export default function HintTooltip({ label, hideAfter = 4000, children, ...tooltipProps }) {
  const [isOpen, setIsOpen] = useState(false);
  const timer = useRef(null);

  const clearTimer = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const open = useCallback(() => {
    clearTimer();
    setIsOpen(true);
    timer.current = setTimeout(() => setIsOpen(false), hideAfter);
  }, [clearTimer, hideAfter]);

  const close = useCallback(() => {
    clearTimer();
    setIsOpen(false);
  }, [clearTimer]);

  // A tooltip whose trigger unmounts mid-countdown must not set state after it.
  useEffect(() => clearTimer, [clearTimer]);

  if (!label) return children;

  return (
    <Tooltip label={label} isOpen={isOpen} {...tooltipProps}>
      <Box
        as="span"
        display="inline-flex"
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
      >
        {children}
      </Box>
    </Tooltip>
  );
}
