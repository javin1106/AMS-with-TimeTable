import { useCallback, useEffect, useRef, useState } from 'react';

import { shortGuest } from '../api/lmApi';

/**
 * Subscribes to a Shorts SSE endpoint and hands back the latest state.
 *
 * Implemented over fetch + ReadableStream rather than EventSource for two
 * reasons: EventSource cannot attach the Authorization header this module's API
 * uses, and it silently retries forever with no way to distinguish "server
 * restarted" from "your session expired".
 *
 * Falls back to plain polling if streaming is unavailable — an old browser, a
 * proxy that buffers event-streams, or a network that drops long connections.
 * The presenter's screen going stale in front of a lecture theatre is the worst
 * outcome here, so there is always a path that works.
 */

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const POLL_INTERVAL_MS = 2500;

export default function useShortStream(url, { fetchState, enabled = true } = {}) {
  const [state, setState] = useState(null);
  const [connection, setConnection] = useState('connecting');
  const [error, setError] = useState('');

  // Kept in refs so the effect below does not re-subscribe whenever the parent
  // re-renders with a new inline callback.
  const fetchStateRef = useRef(fetchState);
  fetchStateRef.current = fetchState;

  const revisionRef = useRef(-1);

  const applyState = useCallback((next) => {
    if (!next) return;
    // Out-of-order frames are possible once a reconnect overlaps the tail of the
    // previous stream; the revision counter is the tie-break.
    const revision = Number(next.revision ?? 0);
    if (revision < revisionRef.current) return;
    revisionRef.current = revision;
    setState(next);
  }, []);

  useEffect(() => {
    if (!enabled || !url) return undefined;

    let cancelled = false;
    let controller = null;
    let timer = null;
    let pollTimer = null;
    let attempt = 0;

    const startPolling = () => {
      if (pollTimer || !fetchStateRef.current) return;
      setConnection('polling');
      const poll = async () => {
        if (cancelled) return;
        try {
          const next = await fetchStateRef.current();
          if (!cancelled) {
            applyState(next);
            setError('');
          }
        } catch (err) {
          if (!cancelled) setError(err.message || 'Lost contact with the server.');
        }
      };
      poll();
      pollTimer = setInterval(poll, POLL_INTERVAL_MS);
    };

    const stopPolling = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    };

    const scheduleReconnect = () => {
      if (cancelled) return;
      attempt += 1;
      // Back off, but never so far that the room is left staring at a stale
      // slide; polling covers the gap in the meantime.
      const delay = Math.min(RECONNECT_MIN_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
      if (attempt >= 2) startPolling();
      timer = setTimeout(connect, delay);
    };

    async function connect() {
      timer = null;
      if (cancelled) return;

      controller = new AbortController();
      const headers = { Accept: 'text/event-stream' };
      const token = localStorage.getItem('token');
      if (token) headers.Authorization = `Bearer ${token}`;
      // A guest watching an open Short has no account token — this is the whole
      // of their identity, and without it the stream 401s and gives up.
      const guestToken = shortGuest.token();
      if (guestToken) headers['X-Short-Guest'] = guestToken;

      let response;
      try {
        response = await fetch(url, {
          headers,
          credentials: 'include',
          signal: controller.signal,
          cache: 'no-store',
        });
      } catch (err) {
        if (!cancelled && err.name !== 'AbortError') scheduleReconnect();
        return;
      }

      if (cancelled) return;

      // 401/403/404 will not fix themselves by retrying.
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        setConnection('denied');
        setError(
          response.status === 404
            ? 'This session is no longer available.'
            : 'You are not allowed to watch this session.',
        );
        return;
      }

      if (!response.ok || !response.body) {
        // No streaming body (some proxies, some test environments) — polling is
        // the whole answer, not a stopgap.
        startPolling();
        scheduleReconnect();
        return;
      }

      attempt = 0;
      stopPolling();
      setConnection('live');
      setError('');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const handleFrame = (frame) => {
        // Comment frames (": keep-alive") carry no data.
        const lines = frame.split('\n');
        let event = 'message';
        const data = [];
        lines.forEach((line) => {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trim());
        });
        if (!data.length) return;

        let payload;
        try {
          payload = JSON.parse(data.join('\n'));
        } catch {
          return;
        }

        if (event === 'state') applyState(payload);
        else if (event === 'gone') {
          setConnection('ended');
          setError(payload.message || 'Session closed.');
          cancelled = true;
        } else if (event === 'error') {
          setError(payload.message || 'Stream error.');
        }
      };

      try {
        for (;;) {
          // eslint-disable-next-line no-await-in-loop
          const { value, done } = await reader.read();
          if (done || cancelled) break;
          buffer += decoder.decode(value, { stream: true });
          let split = buffer.indexOf('\n\n');
          while (split !== -1) {
            handleFrame(buffer.slice(0, split));
            buffer = buffer.slice(split + 2);
            split = buffer.indexOf('\n\n');
          }
        }
      } catch (err) {
        if (err.name !== 'AbortError' && !cancelled) setError('Reconnecting…');
      }

      if (cancelled) return;
      // The server closes the stream just short of its socket timeout, so a
      // clean end is the normal case and not worth surfacing to the user.
      setConnection('connecting');
      scheduleReconnect();
    }

    connect();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      stopPolling();
      if (controller) controller.abort();
    };
  }, [url, enabled, applyState]);

  // Lets a caller fold in the response of its own mutation (answering, moving a
  // slide) without waiting up to a tick for the stream to catch up.
  const merge = useCallback((next) => applyState(next), [applyState]);

  return { state, connection, error, merge };
}
