import { useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * `useNavigate` lists the current pathname among its dependencies, so it hands
 * back a brand-new function after every navigation. Anything that keeps it in a
 * `useCallback`/`useEffect` dependency list therefore re-runs on each route
 * change — which made the layouts refetch (and blank out) every time a tab was
 * clicked. This wrapper keeps one identity for the life of the component.
 */
export default function useStableNavigate() {
  const navigate = useNavigate();
  const ref = useRef(navigate);

  useEffect(() => {
    ref.current = navigate;
  }, [navigate]);

  return useCallback((...args) => ref.current(...args), []);
}
