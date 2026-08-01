const nodemailer = require('nodemailer');

/**
 * The one SMTP connection pool for the whole process.
 *
 * Both mail entry points (`mailerModule/mailer` and `modules/mailsender`) used
 * to build a fresh transporter per message. With `pool: true` that meant a new
 * set of sockets on every send, none of them ever closed, plus — in mailer.js —
 * a `verify()` handshake before each one, so a single message cost two
 * authenticated connections to Gmail.
 *
 * Inviting a class walks that loop once per address. Gmail caps concurrent
 * connections and login attempts per account, and answers the overflow with
 * `421`/`454 Too many login attempts` or a dropped socket. The early addresses
 * in a batch went out and the later ones did not, which is what "sometimes the
 * mail does not go" looks like from the teacher's side.
 *
 * One pooled transporter, reused and rate-limited, is what nodemailer's pool is
 * for: a handful of authenticated connections carry every message on the box.
 */

let transporter = null;
let signature = '';

const config = () => ({
  host: process.env.MAIL_HOST || '',
  port: parseInt(process.env.MAIL_PORT, 10) || 587,
  user: process.env.MAIL_USER || '',
  pass: process.env.MAIL_PASS || '',
});

function getTransport() {
  const { host, port, user, pass } = config();
  // Rebuild if the credentials changed under us (tests, config reload). The
  // password is not part of the key — no need to hold a copy of it around.
  const key = `${host}:${port}:${user}`;

  if (transporter && signature === key) return transporter;
  if (transporter) transporter.close();

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: port === 587,
    auth: { user, pass },
    tls: { rejectUnauthorized: false, minVersion: 'TLSv1.2' },

    connectionTimeout: 60000,
    greetingTimeout: 30000,
    socketTimeout: 60000,

    // The pool is the point: connections are opened once and kept, rather than
    // re-authenticated per message. `rateLimit` keeps a large invite batch from
    // tripping the provider's flood protection.
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    rateDelta: 1000,
    rateLimit: 5,

    logger: process.env.NODE_ENV === 'development',
    debug: process.env.NODE_ENV === 'development',
  });

  // A pooled transporter emits on a broken idle connection. Unhandled, that is
  // an EventEmitter 'error' — which takes the process down over a socket the
  // pool is perfectly able to replace.
  transporter.on('error', (err) => {
    console.error('[mailer] SMTP pool error:', err.message);
  });

  signature = key;
  return transporter;
}

/**
 * Whether a failed send is worth trying again.
 *
 * SMTP says 4xx is "try later" and 5xx is "never"; a rejected recipient or a
 * refused login is not improved by repetition, and hammering the login is how
 * an account gets locked out. Everything without a response code got no further
 * than the socket, which is exactly the transient case.
 */
function isTransient(err) {
  if (!err) return false;
  if (err.code === 'EAUTH') return false;
  if (err.responseCode) return err.responseCode >= 400 && err.responseCode < 500;
  return ['ETIMEDOUT', 'ECONNECTION', 'ECONNRESET', 'ESOCKET', 'EPIPE', 'EDNS'].includes(err.code);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Send one message, retrying the failures that are worth retrying.
 *
 * @param {object} mailOptions  nodemailer message (from/to/subject/html/…)
 * @param {number} [attempts]   total tries, including the first
 * @returns {Promise<object>}   nodemailer info; throws when it never went
 */
async function sendMailWithRetry(mailOptions, attempts = 3) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await getTransport().sendMail(mailOptions);
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !isTransient(err)) break;
      console.warn(
        `[mailer] send to ${mailOptions.to} failed (${err.code || err.responseCode || 'unknown'}), retrying ${attempt}/${attempts - 1}`,
      );
      // eslint-disable-next-line no-await-in-loop
      await wait(1000 * 2 ** (attempt - 1));
    }
  }

  throw lastError;
}

/** Checks the SMTP settings once, for startup logging. Never throws. */
async function verifyTransport() {
  try {
    await getTransport().verify();
    console.log('[mailer] SMTP connection verified');
    return true;
  } catch (err) {
    console.error('[mailer] SMTP verification failed:', err.message);
    return false;
  }
}

module.exports = { getTransport, sendMailWithRetry, verifyTransport };
