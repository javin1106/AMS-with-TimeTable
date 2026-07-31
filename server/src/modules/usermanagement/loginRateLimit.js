const rateLimit = require("express-rate-limit");

/**
 * Throttling for the credential endpoints.
 *
 * Two limiters rather than one, because a single per-IP limit is the wrong
 * shape for this deployment. The whole campus sits behind NAT, so thousands of
 * students share a handful of source addresses: a per-IP budget tight enough to
 * stop a brute force locks out a lecture theatre, and one loose enough not to is
 * not stopping anything. Keying the strict limit on the *account* fixes that —
 * an attacker grinding one mailbox is throttled without the person next to them
 * paying for it.
 *
 * `skipSuccessfulRequests` is what makes the account limit usable: only failures
 * count, so somebody who signs in correctly ten times in a morning never sees
 * it, while ten wrong passwords do.
 */

const FIFTEEN_MINUTES = 15 * 60 * 1000;

const tooMany = (message) => ({ message });

/**
 * The account key.
 *
 * Lower-cased and trimmed so `Admin@nitj.ac.in` and `admin@nitj.ac.in ` cannot
 * be used as two separate budgets against the same mailbox. This normalisation
 * is for counting only — the login lookup itself is left exactly as it was, so
 * no existing account changes how it signs in.
 *
 * A request with no email in the body falls into one shared bucket. It cannot
 * succeed anyway (the handler 400s), and bucketing them together stops an
 * attacker minting unlimited keys by omitting the field.
 */
const accountKey = (req) => {
  const email = req.body?.email;
  if (typeof email !== "string" || !email.trim()) return "__no_email__";
  return email.trim().toLowerCase();
};

/**
 * Per-account: five failed sign-ins per quarter hour.
 *
 * Deliberately not an account *lockout*. A lockout that persists is itself a
 * denial of service — anyone who knows a colleague's address can keep them
 * signed out all day. A window that lapses on its own gives the same protection
 * against grinding without handing anybody that lever.
 */
const loginAccountLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  max: 5,
  keyGenerator: accountKey,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: tooMany(
    "Too many failed sign-in attempts for this account. Please wait fifteen minutes and try again.",
  ),
});

/**
 * Per-IP: a backstop, set loose enough to survive a shared campus address.
 *
 * This is the layer that catches one host spraying many different accounts,
 * which the per-account limiter cannot see.
 */
const authIpLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: tooMany("Too many requests from this network. Please try again later."),
});

/**
 * Per-account limit on the endpoints that send mail.
 *
 * Without it, either endpoint is a free way to post someone a hundred emails.
 */
const emailDispatchLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  max: 5,
  keyGenerator: accountKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: tooMany("Too many requests for this account. Please wait before asking again."),
});

/**
 * Where the credential endpoints actually live.
 *
 * `src/index.js` mounts the v1 router twice — at `/api/v1` and at the root, for
 * frontends that predate the prefix — so both spellings have to be listed or
 * the throttle is trivially sidestepped by dropping the prefix. The previous
 * limiter was registered on `/api/v1/users/login` and `/users/login`, which
 * match no route in this application at all, so login was in practice
 * unthrottled.
 */
const withBothMounts = (suffix) => [`/api/v1${suffix}`, suffix];

const LOGIN_PATHS = withBothMounts("/auth/login");
const REGISTER_PATHS = withBothMounts("/auth/register");
const OTP_PATHS = withBothMounts("/auth/otp");
const FORGOT_PASSWORD_PATHS = withBothMounts("/auth/forgot-password");

/** Registers every credential-endpoint limiter on the app. */
function applyAuthRateLimits(app) {
  LOGIN_PATHS.forEach((path) => {
    app.use(path, authIpLimiter);
    app.use(path, loginAccountLimiter);
  });

  REGISTER_PATHS.forEach((path) => app.use(path, authIpLimiter));

  [...OTP_PATHS, ...FORGOT_PASSWORD_PATHS].forEach((path) => {
    app.use(path, authIpLimiter);
    app.use(path, emailDispatchLimiter);
  });
}

module.exports = {
  applyAuthRateLimits,
  accountKey,
  loginAccountLimiter,
  authIpLimiter,
  emailDispatchLimiter,
  LOGIN_PATHS,
  REGISTER_PATHS,
  OTP_PATHS,
  FORGOT_PASSWORD_PATHS,
};
