/**
 * Blocks abuse in anonymous feedback.
 *
 * Anonymity is what makes this filter necessary. Everywhere else in the module
 * a message carries its author's name, and that is most of the moderation:
 * people rarely put their name to something they would be ashamed of. Strip the
 * name and the restraint goes with it — so the words are checked instead.
 *
 * The filter *rejects*; it does not mask. Replacing the word with asterisks and
 * storing the rest would leave the teacher reading an abusive sentence with a
 * hole in it, and would leave the student thinking their point had landed. A
 * refusal, naming the words at fault, is the only outcome that lets them rewrite
 * it and be heard.
 *
 * ## Matching
 *
 * Plain substring search is unusable here — the Scunthorpe problem — so every
 * match is anchored to token boundaries. On top of that, three normalisations,
 * each answering a specific way people get a word past a filter:
 *
 *  - **leet** — `f0ck`, `sh1t`, `@ss`, `$hit`. Digits and symbols fold to the
 *    letters they imitate.
 *  - **doubling** — `fuuuck`, `bitchhh`. Runs collapse to one character, and the
 *    terms collapse the same way, so "hell" ≠ "hello" still holds.
 *  - **padding** — `f.u.c.k`, `f u c k`, `f-u-c-k`. Each character of a term may
 *    be followed by up to two non-word characters.
 *
 * Padding tolerance is why `BLOCKED_EXACT` exists: applied to a three-letter
 * term it matches half the dictionary, so short terms opt out of it.
 *
 * None of this is a security boundary — a determined writer can always spell
 * around a word list. It is a speed bump in front of the impulsive case, which
 * is the case that actually occurs.
 */

const { BLOCKED, BLOCKED_EXACT } = require("./profanityWords");

// Symbols and digits people substitute for letters. Applied before matching, to
// both the text and (harmlessly) the terms.
const LEET = {
  0: "o",
  1: "i",
  3: "e",
  4: "a",
  5: "s",
  7: "t",
  8: "b",
  "@": "a",
  $: "s",
  "!": "i",
  "|": "i",
  "+": "t",
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Lower-cases and folds leetspeak. Length and positions are preserved. */
const foldLeet = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[0134578@$!|+]/g, (ch) => LEET[ch] ?? ch);

/** Collapses any run of the same character to a single one. */
const collapseRuns = (value) => value.replace(/(.)\1+/g, "$1");

/**
 * A term as a regex, boundary-anchored.
 *
 * The boundaries are lookarounds on `[a-z0-9]` rather than `\b`, because `\b`
 * would happily match inside "f*ck" once the star is treated as a boundary and
 * would not match at all against a term that begins with a padded character.
 *
 * `padded` inserts `[^a-z0-9]{0,2}` between characters — enough for "f.u.c.k"
 * and "f u c k", not enough to swallow a whole sentence. A space inside a term
 * ("teri maa") is always allowed to be any run of separators.
 */
function termPattern(term, { padded }) {
  const chars = [...term];
  const body = chars
    .map((ch, index) => {
      if (ch === " ") return "[^a-z0-9]{1,3}";
      const next = chars[index + 1];
      const separator = index === chars.length - 1 || next === " " ? "" : padded ? "[^a-z0-9]{0,2}" : "";
      return escapeRegex(ch) + separator;
    })
    .join("");
  return new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`);
}

/**
 * The doubling pass compares run-collapsed text against a run-collapsed term,
 * which is how "fuuuck" is caught without "hello" tripping on "hell".
 *
 * It is skipped for terms that collapse to three characters or fewer, and that
 * exclusion is the whole reason this is a separate function. "ass" collapses to
 * "as" — a word every second sentence of real feedback contains — and "piss" to
 * "pis". Below four characters the collapsed form stops being a rare string and
 * starts being English.
 */
function collapsedPatternFor(term) {
  const collapsed = collapseRuns(foldLeet(term));
  if (collapsed.replace(/[^a-z0-9]/g, "").length < 4) return null;
  return termPattern(collapsed, { padded: false });
}

// Built once at require time — this runs on every feedback submission.
const PATTERNS = [
  ...BLOCKED.map((term) => ({ term, padded: true })),
  ...BLOCKED_EXACT.map((term) => ({ term, padded: false })),
].map(({ term, padded }) => ({
  term,
  pattern: termPattern(foldLeet(term), { padded }),
  collapsed: collapsedPatternFor(term),
}));

/**
 * Every blocked term the text contains.
 *
 * @param {string} text
 * @returns {string[]} the canonical terms that matched, de-duplicated. Empty
 *   when the text is clean.
 */
function findProfanity(text) {
  const folded = foldLeet(text);
  if (!folded.trim()) return [];
  const collapsed = collapseRuns(folded);

  const hits = PATTERNS.filter(
    ({ pattern, collapsed: collapsedPattern }) =>
      pattern.test(folded) || (collapsedPattern && collapsedPattern.test(collapsed)),
  ).map(({ term }) => term);

  return [...new Set(hits)];
}

/** Convenience wrapper for the common `if (…) return 400` shape. */
const isClean = (text) => findProfanity(text).length === 0;

/**
 * The refusal a student reads. Names the words rather than saying "your message
 * was rejected", because a message rejected for reasons unstated is a message
 * the student will simply send again.
 */
function profanityMessage(terms) {
  const listed = terms.slice(0, 5).map((term) => `"${term}"`).join(", ");
  return `Your feedback contains language that is not allowed (${listed}). Feedback reaches your teacher without your name on it, but it still has to stay respectful — please rewrite the point without those words and send it again.`;
}

module.exports = { findProfanity, isClean, profanityMessage };
