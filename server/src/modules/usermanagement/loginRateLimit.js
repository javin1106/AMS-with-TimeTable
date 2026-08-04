const rateLimit = require("express-rate-limit");

/**
 * Throttling for the credential endpoints.
 *
 * ## Why the account, not the address
 *
 * Everyone who signs in here is on the institute network, so the source address
 * is close to worthless as an identity: thousands of students leave through a
 * handful of NAT addresses, and the app itself sits behind a reverse proxy. A
 * per-IP budget tight enough to stop a brute force therefore locks out a lecture
 * theatre, and one loose enough to survive a lecture theatre is not stopping
 * anything. **The per-account limiter is the real defence; the per-IP limiters
 * below are coarse safety valves and are written to be survivable, not tight.**
 *
 * `skipSuccessfulRequests` is what makes both usable. Sixty students signing in
 * at the start of a lab produce sixty *successes*, which are not counted at all.
 * Sixty *failures* from one address in a quarter of an hour is a different event.
 *
 * ## What this cannot do
 *
 * It cannot stop password spraying — one guess against each of two thousand
 * accounts trips neither limiter, and behind shared NAT nothing IP-based can
 * tell that traffic apart from a busy morning. What defends against spraying is
 * password quality, the uniform failure response in `usercontroller.login` (no
 * user enumeration, so an attacker cannot narrow the account list first), and
 * somebody watching the aggregate failure rate. Written down because the
 * limiters look like they cover it and do not.
 *
 * ## `req.ip` is only meaningful if the app is told about its proxy
 *
 * Express reports the socket peer unless `trust proxy` is set. Behind nginx or a
 * platform load balancer that peer is the proxy — *one value for every request
 * in the world* — so an IP limiter silently becomes a global cap on all auth
 * traffic. That is why the ceilings here are high and each one can be switched
 * off from the environment: see `TRUST_PROXY` in `index.js`, and set it before
 * relying on any of this.
 */

const FIFTEEN_MINUTES = 15 * 60 * 1000;

/** Defaults are deliberately loose. See the header. */
const DEFAULT_ACCOUNT_FAILURES = 5;
const DEFAULT_IP_FAILURES = 200;
const DEFAULT_IP_REQUESTS = 300;

const tooMany = (message) => ({ message });

/**
 * Reads a ceiling from the environment.
 *
 * `0` means "no limit" and returns null, which callers turn into a pass-through.
 * That escape hatch exists so that if one of these does bite the institute, ops
 * can lift it with an env change and a restart rather than a code deploy.
 */
const ceiling = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value === 0 ? null : value;
};

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
 * True once the deployment has told Express where its proxy is.
 *
 * Until then, express-rate-limit's `xForwardedForHeader` check fires on every
 * proxied request and writes a validation error to the console. The check is
 * right — the addresses really are meaningless in that state — but it is a
 * deployment fact, not something a request can fix, so it is reported once at
 * boot (see `index.js`) instead of per request.
 */
const proxyConfigured = () => Boolean(process.env.TRUST_PROXY);

const passThrough = (req, res, next) => next();

/**
 * A per-address limiter, or a pass-through when its ceiling is disabled.
 *
 * `failuresOnly` is the important flag. On login it is on: a class arriving
 * together is invisible to the limiter, so the ceiling only has to accommodate
 * genuine mistyping. On the endpoints that send mail it cannot be — a delivered
 * message is a "success" and is exactly what we are rationing — so those lean on
 * the per-account limiter and keep the address limit as a blunt backstop.
 */
const ipLimiter = ({ max, failuresOnly = false, message }) => {
  if (max === null) return passThrough;
  return rateLimit({
    windowMs: FIFTEEN_MINUTES,
    max,
    skipSuccessfulRequests: failuresOnly,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: proxyConfigured() },
    message: tooMany(message),
  });
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
  max: ceiling("AUTH_ACCOUNT_FAILURE_LIMIT", DEFAULT_ACCOUNT_FAILURES) ?? Infinity,
  keyGenerator: accountKey,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  // Keyed on the email, so the address is not consulted and the proxy warning
  // does not apply.
  validate: { xForwardedForHeader: false },
  message: tooMany(
    "Too many failed sign-in attempts for this account. Please wait fifteen minutes and try again.",
  ),
});

/**
 * Per-IP on login, counting *failures only*.
 *
 * This is the layer that catches one host grinding many different accounts,
 * which the per-account limiter cannot see. Two hundred failures from a single
 * campus address inside fifteen minutes is not a lecture theatre mistyping.
 */
const loginIpFailureLimiter = ipLimiter({
  max: ceiling("AUTH_IP_FAILURE_LIMIT", DEFAULT_IP_FAILURES),
  failuresOnly: true,
  message:
    "Too many failed sign-in attempts from this network. Please try again in fifteen minutes.",
});

/** Per-IP on the mail and registration endpoints. A blunt backstop; see above. */
const authIpLimiter = ipLimiter({
  max: ceiling("AUTH_IP_LIMIT", DEFAULT_IP_REQUESTS),
  message: "Too many requests from this network. Please try again later.",
});

/**
 * Per-account limit on the endpoints that send mail.
 *
 * Without it, either endpoint is a free way to post someone a hundred emails.
 * This one has to count successes, because a delivered message is the cost.
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

  [...OTP_PATHS, ...FORGOT_PASSWORD_PATHS].forEach((path) => {
    app.use(path, emailDispatchLimiter);
    app.use(path, authIpLimiter);
  });
}

module.exports = {
  applyAuthRateLimits,
  accountKey,
  ceiling,
  loginAccountLimiter,
  loginIpFailureLimiter,
  authIpLimiter,
  emailDispatchLimiter,
  LOGIN_PATHS,
  REGISTER_PATHS,
  OTP_PATHS,
  FORGOT_PASSWORD_PATHS,
  DEFAULT_ACCOUNT_FAILURES,
  DEFAULT_IP_FAILURES,
  DEFAULT_IP_REQUESTS,
};
