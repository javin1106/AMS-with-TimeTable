// Signing in normally lands a user on /userroles, but when they arrived at the
// login page because a gate bounced them off a page they actually wanted, that
// page is where they expect to end up. The gates stash the interrupted location
// in the login URL rather than in router state, so it survives the full page
// reload the login form performs after authenticating.

export const REDIRECT_PARAM = 'redirect';

// Only same-origin paths are honoured: `//evil.com` and `/\evil.com` are read
// by browsers as protocol-relative URLs, so letting either through would turn
// the login page into an open redirect.
const isInternalPath = (path) =>
  typeof path === 'string' &&
  path.startsWith('/') &&
  !path.startsWith('//') &&
  !path.startsWith('/\\');

// Paths that are either the login page itself or the natural post-login
// destination anyway — carrying them adds a query string for no benefit.
const NOT_WORTH_RETURNING_TO = ['/', '/login', '/userroles'];

/**
 * The login URL to send an unauthenticated visitor to, remembering where they
 * were. Pass the `useLocation()` object (or `window.location`).
 */
export const loginPathFor = (location) => {
  if (!location) return '/login';
  const { pathname = '', search = '', hash = '' } = location;
  if (NOT_WORTH_RETURNING_TO.includes(pathname)) return '/login';
  const from = `${pathname}${search}${hash}`;
  if (!isInternalPath(from)) return '/login';
  return `/login?${REDIRECT_PARAM}=${encodeURIComponent(from)}`;
};

/**
 * Where to go once login succeeds: the remembered page if there is a safe one,
 * otherwise the roles picker.
 */
export const redirectTargetFrom = (search, fallback = '/userroles') => {
  const raw = new URLSearchParams(search || '').get(REDIRECT_PARAM);
  if (!raw || !isInternalPath(raw)) return fallback;
  return raw;
};
