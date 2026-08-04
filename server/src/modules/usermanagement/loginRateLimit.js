const rateLimit = require("express-rate-limit");

/**
 * Throttling for the credential endpoints.
 *
 * ## Why the account, not the address
 *
 * Everyone who signs in here is on the institute network, so the source address
 * is close to worthless as an identity: thousands of students leave through a
 * handful of NAT addresses, and the app sits behind a proxy. A per-IP budget
 * tight enough to stop a brute force therefore locks out a lecture theatre, and
 * one loose enough to survive a lecture theatre is not stopping anything.
 * **The per-account limiter is the real defence; the per-IP limiters below are
 * coarse safety valves and are written to be survivable, not tight.**
 *
 * `skipSuccessfulRequests` is what makes both usable. Sixty students signing in
 * at the start of a lab produce sixty *successes*, which are not counted at all.
 * Sixty *failures* from one address in a quarter of an hour is a different event.
 *
 * ## `req.ip` is the socket peer
 *
 * `trust proxy` is not set, so behind a reverse proxy `req.ip` is the proxy —
 * one value for every request. That is *why* nothing load-bearing is keyed on
 * it, and why the ceilings here are high: an IP limit in this deployment is
 * closer to a global cap than a per-client one. The express-rate-limit
 * `X-Forwarded-For` validator is switched off on each limiter for the same
 * reason: it is right that the addresses are unreliable, but that is a fact
 * about the deployment and not something worth logging once per request.
 *
 * ## What throttling cannot do — and what does
 *
 * It cannot stop password spraying: one guess against each of two thousand
 * accounts trips neither limiter, and behind shared NAT nothing IP-based can
 * tell that traffic apart from a busy morning. That gap is closed by the
 * captcha in `captcha.js`, which is required once the failure rate says
 * something is grinding — see `captchaGate.js` for when it turns on.
 */

const FIFTEEN_MINUTES = 15 * 60 * 1000;

/**
 * Five failed sign-ins per account per quarter hour.
 *
 * Deliberately not an account *lockout*. A lockout that persists is itself a
 * denial of service — anyone who knows a colleague's address could keep them
 * signed out all day. A window that lapses on its own gives the same protection
 * against grinding without handing anybody that lever.
 */
const ACCOUNT_FAILURES = 5;

/**
 * Two hundred *failures* per address per quarter hour.
 *
 * High on purpose. Successes are not counted, so a class arriving together is
 * invisible to this limiter and the ceiling only has to accommodate genuine
 * mistyping across the whole institute. What it catches is one host grinding
 * many different accounts, which the per-account limiter cannot see.
 */
const IP_FAILURES = 200;

/** Per-address ceiling on the endpoints that send mail. See `authIpLimiter`. */
const IP_REQUESTS = 300;

/**
 * Ceiling on captcha challenges.
 *
 * Very high, because when the install-wide captcha trips *everybody* is asking
 * for one at once and they arrive from a handful of NAT addresses — throttling
 * that would take the login page down at the exact moment the captcha is doing
 * its job. Issuing a challenge is a few hundred bytes of string building and one
 * HMAC, so the only thing this ceiling defends is CPU against a single host
 * looping the endpoint.
 */
const CAPTCHA_REQUESTS = 1000;

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
 * What counts against a login budget: a rejected credential, and nothing else.
 *
 * `skipSuccessfulRequests` alone means "skip anything under 400", which would
 * charge the budget for a missing field, an unsolved captcha and a 500. The
 * captcha one matters: a refused captcha never got as far as testing a password,
 * and counting it would let anybody spend a colleague's five attempts by posting
 * nonsense with their address in it — the exact lever `captchaGate` is careful
 * not to hand over.
 */
const onlyCredentialRejections = (req, res) => res.statusCode !== 401;

const loginAccountLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  max: ACCOUNT_FAILURES,
  keyGenerator: accountKey,
  skipSuccessfulRequests: true,
  requestWasSuccessful: onlyCredentialRejections,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: tooMany(
    "Too many failed sign-in attempts for this account. Please wait fifteen minutes and try again.",
  ),
});

const loginIpFailureLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  max: IP_FAILURES,
  skipSuccessfulRequests: true,
  requestWasSuccessful: onlyCredentialRejections,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: tooMany(
    "Too many failed sign-in attempts from this network. Please try again in fifteen minutes.",
  ),
});

/**
 * Per-address on the mail and registration endpoints.
 *
 * This one cannot skip successes — a delivered message *is* the cost being
 * rationed — so it leans on `emailDispatchLimiter` below for the real limit and
 * stays deliberately blunt.
 */
const authIpLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  max: IP_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: tooMany("Too many requests from this network. Please try again later."),
});

const captchaLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  max: CAPTCHA_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: tooMany("Too many challenge requests. Please try again later."),
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
  validate: { xForwardedForHeader: false },
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
const CAPTCHA_PATHS = withBothMounts("/auth/captcha");

/** Registers every credential-endpoint limiter on the app. */
function applyAuthRateLimits(app) {
  LOGIN_PATHS.forEach((path) => {
    // Account first: it is the limit that is meant to fire, and putting it
    // ahead means a genuine brute force is answered by the message about the
    // account rather than one blaming the student's network.
    app.use(path, loginAccountLimiter);
    app.use(path, loginIpFailureLimiter);
  });

  REGISTER_PATHS.forEach((path) => app.use(path, authIpLimiter));

  CAPTCHA_PATHS.forEach((path) => app.use(path, captchaLimiter));

  [...OTP_PATHS, ...FORGOT_PASSWORD_PATHS].forEach((path) => {
    app.use(path, emailDispatchLimiter);
    app.use(path, authIpLimiter);
  });
}

module.exports = {
  applyAuthRateLimits,
  accountKey,
  loginAccountLimiter,
  loginIpFailureLimiter,
  authIpLimiter,
  captchaLimiter,
  emailDispatchLimiter,
  LOGIN_PATHS,
  REGISTER_PATHS,
  OTP_PATHS,
  FORGOT_PASSWORD_PATHS,
  CAPTCHA_PATHS,
  ACCOUNT_FAILURES,
  IP_FAILURES,
  IP_REQUESTS,
  CAPTCHA_REQUESTS,
};
