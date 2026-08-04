/**
 * When the login form asks for a captcha.
 *
 * A captcha on every sign-in would work and nobody would use the system: this is
 * a page thousands of students hit between lectures. So it turns on in response
 * to what the failures look like, and the two triggers are deliberately
 * different shapes because they catch different attacks.
 *
 * **Per-account** — three failures against one address. Catches somebody
 * grinding a single mailbox, before the five-failure rate limit closes it. Note
 * that the counter is keyed on the *submitted* address whether or not an account
 * exists, so being asked for a captcha says only "somebody recently failed
 * signing in as this address" — never whether the address is registered. That
 * matters: the whole point of the uniform failure message in `login` is that the
 * form is not a directory of who holds an account here, and a captcha that
 * appeared only for real accounts would give that back.
 *
 * **Install-wide** — thirty failures across all accounts in five minutes. This
 * is the one that closes password spraying, which neither rate limiter can see:
 * one guess against each of two thousand addresses trips no per-account budget,
 * and behind campus NAT no per-IP budget can tell it from a busy morning. What
 * it *does* do is raise the aggregate failure rate, which on a normal morning is
 * low. When it trips, everybody gets a captcha for a few minutes. That is real
 * friction, and it is the right trade: a spray is stopped dead, nobody is locked
 * out, and it lapses on its own.
 *
 * Both counters live in memory. They are a few minutes of failure timestamps,
 * worthless once expired, and a restart forgetting them costs nothing an
 * attacker can use — they would have to still be mid-spray, and the counter
 * refills in seconds.
 */

const ACCOUNT_FAILURES_BEFORE_CAPTCHA = 3;
const ACCOUNT_WINDOW_MS = 15 * 60 * 1000;

const GLOBAL_FAILURES_BEFORE_CAPTCHA = 30;
const GLOBAL_WINDOW_MS = 5 * 60 * 1000;

/**
 * Cap on how many addresses are tracked at once.
 *
 * Without it the login endpoint is an unauthenticated way to make the server
 * remember an arbitrary number of strings. When the cap is hit the oldest entry
 * goes; the global counter is unaffected, so a spray wide enough to evict its
 * own per-account entries still trips the trigger that is meant to catch it.
 */
const MAX_TRACKED_ACCOUNTS = 10_000;

/** email → array of failure timestamps, oldest first. */
const accountFailures = new Map();
/** Failure timestamps across every account, oldest first. */
let globalFailures = [];

const prune = (times, since) => {
  // Oldest first, so the first kept index is the whole answer.
  let i = 0;
  while (i < times.length && times[i] < since) i += 1;
  return i === 0 ? times : times.slice(i);
};

const normalise = (email) =>
  typeof email === "string" && email.trim() ? email.trim().toLowerCase() : "__no_email__";

/** Records a failed sign-in. Call this for *every* failure, including 404s. */
function noteFailure(email, now = Date.now()) {
  const key = normalise(email);

  const times = prune(accountFailures.get(key) || [], now - ACCOUNT_WINDOW_MS);
  times.push(now);
  accountFailures.set(key, times);

  if (accountFailures.size > MAX_TRACKED_ACCOUNTS) {
    // Map iteration is insertion-ordered, so this is the least recently added.
    accountFailures.delete(accountFailures.keys().next().value);
  }

  globalFailures = prune(globalFailures, now - GLOBAL_WINDOW_MS);
  globalFailures.push(now);
}

/** Forgets an address's failures. Called on a successful sign-in. */
function noteSuccess(email, now = Date.now()) {
  accountFailures.delete(normalise(email));
  // The global counter is deliberately *not* cleared: one person signing in
  // correctly says nothing about the spray running alongside them.
  globalFailures = prune(globalFailures, now - GLOBAL_WINDOW_MS);
}

/** Whether this address needs to solve a captcha on its next attempt. */
function captchaRequired(email, now = Date.now()) {
  const forAccount = prune(accountFailures.get(normalise(email)) || [], now - ACCOUNT_WINDOW_MS);
  if (forAccount.length >= ACCOUNT_FAILURES_BEFORE_CAPTCHA) return true;

  globalFailures = prune(globalFailures, now - GLOBAL_WINDOW_MS);
  return globalFailures.length >= GLOBAL_FAILURES_BEFORE_CAPTCHA;
}

/** For an operator staring at a login page that suddenly wants captchas. */
function failureRate(now = Date.now()) {
  globalFailures = prune(globalFailures, now - GLOBAL_WINDOW_MS);
  return {
    recentFailures: globalFailures.length,
    windowMinutes: GLOBAL_WINDOW_MS / 60_000,
    trackedAccounts: accountFailures.size,
    installWideCaptcha: globalFailures.length >= GLOBAL_FAILURES_BEFORE_CAPTCHA,
  };
}

/** Test seam. */
function reset() {
  accountFailures.clear();
  globalFailures = [];
}

module.exports = {
  noteFailure,
  noteSuccess,
  captchaRequired,
  failureRate,
  reset,
  ACCOUNT_FAILURES_BEFORE_CAPTCHA,
  GLOBAL_FAILURES_BEFORE_CAPTCHA,
  ACCOUNT_WINDOW_MS,
  GLOBAL_WINDOW_MS,
  MAX_TRACKED_ACCOUNTS,
};
