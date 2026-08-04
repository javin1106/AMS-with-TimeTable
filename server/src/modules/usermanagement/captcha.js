const crypto = require("crypto");

/**
 * A self-hosted captcha for the login form.
 *
 * ## Why not reCAPTCHA or Turnstile
 *
 * Both would be stronger against a determined solver. Both also mean a site key
 * and a secret to manage, an outbound call to a third party on every sign-in,
 * and a script from someone else's domain on the login page of an institute
 * system. This one is a few hundred lines of Node with no keys, no dependency
 * and no network call, and the thing it has to stop — automated password
 * spraying against this one application — is stopped by any challenge that
 * cannot be answered by an HTTP client on its own. Written down because the
 * trade is real: it will not survive somebody paying a solving service, and it
 * is not meant to.
 *
 * ## Stateless challenges
 *
 * The answer is never stored. A challenge is a signed token carrying a *hash*
 * of the answer, its expiry and a nonce; verification re-derives the hash from
 * what the user typed and checks the signature. That means no session, no
 * collection, and nothing to clean up if a user abandons the form — which
 * matters here because the login page is the one page anonymous traffic can
 * reach, so anything it can make the server remember is a memory-growth lever.
 *
 * The one thing that *is* remembered is which nonces have been spent, because a
 * signed token with no single-use check is worse than no captcha at all: solve
 * one, replay it a thousand times.
 */

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CODE_LENGTH = 5;

/**
 * No `0`/`O`, `1`/`I`/`l`, `5`/`S`, `2`/`Z`, `8`/`B`.
 *
 * A captcha whose answer is ambiguous to a human is not a security control, it
 * is a way of locking out the people it is supposed to let through — and the
 * distortion that stops a machine reading it makes every one of those pairs
 * worse, not better.
 */
const ALPHABET = "ACDEFGHJKMNPQRTUVWXY34679";

/** Rendering constants. Kept together so the SVG geometry is readable below. */
const WIDTH = 180;
const HEIGHT = 60;
const NOISE_LINES = 5;
const NOISE_DOTS = 28;

/**
 * Signing key.
 *
 * Reuses `JWT_SECRET` rather than adding a knob: the tokens are short-lived,
 * carry nothing secret, and are only meaningful to this application, so a second
 * secret would be one more thing to rotate for no gain. Read lazily so that
 * requiring this file does not depend on load order in `index.js`.
 */
const signingKey = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is required to sign captcha challenges");
  return secret;
};

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** Case-insensitive: reading case off a distorted glyph is not a useful test. */
const normalise = (answer) => String(answer ?? "").trim().toUpperCase();

const answerHash = (answer, nonce) =>
  crypto.createHmac("sha256", signingKey()).update(`${nonce}:${normalise(answer)}`).digest("base64url");

const sign = (payload) =>
  crypto.createHmac("sha256", signingKey()).update(payload).digest("base64url");

/**
 * Nonces already spent, and when each stops mattering.
 *
 * In memory on purpose — it holds at most a few minutes of login traffic, and
 * the entries are worthless the moment they expire. Two consequences, both
 * accepted: a restart forgets them (the outstanding challenges expire within
 * five minutes anyway), and across multiple app instances a token could be
 * spent once per instance rather than once. Neither gives an attacker a usable
 * multiplier; a shared store would, and would be the thing to add if this ever
 * runs behind a real cluster.
 */
const spent = new Map();

const sweepSpent = (now) => {
  for (const [nonce, expiry] of spent) {
    if (expiry <= now) spent.delete(nonce);
  }
};

/** Cryptographic randomness, so the code cannot be predicted from earlier ones. */
const randomCode = () => {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) code += ALPHABET[bytes[i] % ALPHABET.length];
  return code;
};

const randomInt = (min, max) => min + crypto.randomInt(max - min + 1);

/**
 * Draws the code as an SVG.
 *
 * Hand-rolled rather than pulled from a package: the distortion is a dozen
 * lines, and a captcha image generator is a lot of unaudited code to run on the
 * one endpoint an unauthenticated caller can reach.
 *
 * The characters are never emitted as selectable text — each is its own rotated
 * `<text>` element with a random baseline, so "read the image" cannot be
 * shortcut by reading the DOM. The noise strokes are drawn *over* the glyphs so
 * they cannot be filtered out by colour alone.
 */
const renderSvg = (code) => {
  const parts = [];

  parts.push(
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="#f7fafc" rx="6"/>`,
  );

  const step = (WIDTH - 30) / code.length;
  [...code].forEach((char, index) => {
    const x = 18 + index * step + randomInt(-3, 3);
    const y = HEIGHT / 2 + randomInt(4, 12);
    const rotate = randomInt(-28, 28);
    const size = randomInt(26, 34);
    const grey = randomInt(30, 90);
    parts.push(
      `<text x="${x}" y="${y}" font-family="Georgia, serif" font-size="${size}" ` +
        `font-weight="700" fill="rgb(${grey},${grey},${grey + 20})" ` +
        `transform="rotate(${rotate} ${x} ${y})">${char}</text>`,
    );
  });

  for (let i = 0; i < NOISE_LINES; i += 1) {
    const x1 = randomInt(0, WIDTH);
    const y1 = randomInt(0, HEIGHT);
    const x2 = randomInt(0, WIDTH);
    const y2 = randomInt(0, HEIGHT);
    const curve = randomInt(-30, 30);
    parts.push(
      `<path d="M${x1} ${y1} Q ${(x1 + x2) / 2} ${(y1 + y2) / 2 + curve} ${x2} ${y2}" ` +
        `stroke="rgba(45,55,72,0.45)" stroke-width="${randomInt(1, 2)}" fill="none"/>`,
    );
  }

  for (let i = 0; i < NOISE_DOTS; i += 1) {
    parts.push(
      `<circle cx="${randomInt(0, WIDTH)}" cy="${randomInt(0, HEIGHT)}" ` +
        `r="${randomInt(1, 2)}" fill="rgba(45,55,72,0.35)"/>`,
    );
  }

  // No width/height attributes: the page scales it with CSS, and a fixed size
  // here would make it the one element that ignores the layout.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" ` +
    `role="img" aria-label="Captcha image">${parts.join("")}</svg>`
  );
};

/**
 * Issues a challenge.
 *
 * @returns {{token: string, svg: string, expiresIn: number}}
 */
function issueChallenge(now = Date.now()) {
  const code = randomCode();
  const nonce = crypto.randomBytes(12).toString("base64url");
  const expiry = now + CHALLENGE_TTL_MS;

  // The answer is not in here — only a keyed hash of it, so the token can be
  // handed to the browser that has to solve it.
  const payload = b64url(
    JSON.stringify({ h: answerHash(code, nonce), n: nonce, e: expiry }),
  );

  return {
    token: `${payload}.${sign(payload)}`,
    svg: renderSvg(code),
    expiresIn: Math.floor(CHALLENGE_TTL_MS / 1000),
  };
}

/** Constant-time compare that tolerates length differences without throwing. */
const sameSignature = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
};

/**
 * Checks an answer against its token.
 *
 * Returns a reason rather than throwing, because the caller shows some of these
 * to the user ("that challenge has expired, here is a new one") and treats
 * others as a plain wrong answer.
 *
 * @returns {{ok: boolean, reason?: 'malformed'|'bad_signature'|'expired'|'reused'|'wrong'}}
 */
function verifyChallenge(token, answer, now = Date.now()) {
  if (typeof token !== "string" || !token.includes(".")) return { ok: false, reason: "malformed" };

  const index = token.lastIndexOf(".");
  const payload = token.slice(0, index);
  const signature = token.slice(index + 1);

  // Signature before anything else: until it checks out the payload is just
  // bytes a caller chose, and parsing it would be reading attacker input.
  if (!sameSignature(signature, sign(payload))) return { ok: false, reason: "bad_signature" };

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (!claims || typeof claims.h !== "string" || typeof claims.n !== "string") {
    return { ok: false, reason: "malformed" };
  }
  if (!Number.isFinite(claims.e) || claims.e <= now) return { ok: false, reason: "expired" };

  sweepSpent(now);
  if (spent.has(claims.n)) return { ok: false, reason: "reused" };

  if (!sameSignature(claims.h, answerHash(answer, claims.n))) {
    // A wrong answer does *not* spend the nonce: the image is still on screen,
    // and forcing a reload after every typo would make a mistyped captcha
    // indistinguishable from a broken one.
    return { ok: false, reason: "wrong" };
  }

  // Spent only once it has been answered correctly — that is the replay this
  // exists to stop.
  spent.set(claims.n, claims.e);
  return { ok: true };
}

/** Test seam: drops the spent-nonce table. */
const resetSpent = () => spent.clear();

module.exports = {
  issueChallenge,
  verifyChallenge,
  resetSpent,
  CHALLENGE_TTL_MS,
  CODE_LENGTH,
  ALPHABET,
};
