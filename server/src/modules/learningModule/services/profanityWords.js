/**
 * The blocklist behind `profanityFilter.js`.
 *
 * Kept apart from the matching logic so that adding a term is a one-line diff
 * nobody has to read a regex to review, and so the filter's unit test can talk
 * about behaviour rather than vocabulary.
 *
 * Two lists, because they need different match rules (see profanityFilter):
 *
 *  - `BLOCKED` — the ordinary case. Matched with word boundaries, tolerant of
 *    leetspeak, doubled letters and characters padded apart ("f.u.c.k").
 *
 *  - `BLOCKED_EXACT` — short terms that are also fragments of innocent words.
 *    Boundaries only, no padding tolerance, so "class", "assignment" and
 *    "Scunthorpe" survive.
 *
 * Hinglish as well as English: this is an NIT Jalandhar deployment, and abuse in
 * a feedback box arrives in whichever language it was thought in.
 * Transliterations vary, so the common spellings are listed rather than left to
 * the matcher to guess.
 *
 * What is deliberately *not* here: harsh but honest adjectives — "useless",
 * "boring", "unclear", "waste of time", "disorganised". The box exists to carry
 * criticism a student would not sign their name to, and a filter that swallowed
 * criticism would have defeated the feature. Only abuse aimed at a person is
 * blocked.
 */

// English profanity, slurs and name-calling.
const BLOCKED = [
  "fuck",
  "fucker",
  "fucking",
  "motherfucker",
  "mofo",
  "shit",
  "bullshit",
  "bitch",
  "bastard",
  "asshole",
  "arsehole",
  "dumbass",
  "jackass",
  "dickhead",
  "prick",
  "cunt",
  "whore",
  "slut",
  "wanker",
  "bollocks",
  "douchebag",
  "twat",
  "pussy",
  "dildo",
  "blowjob",
  "rape",
  "rapist",
  "molest",
  "porn",
  "horny",
  "retard",
  "retarded",
  "idiot",
  "moron",
  "imbecile",
  "scoundrel",
  "swine",
  "nigger",
  "chink",
  "faggot",
  "tranny",
  "kike",
  "spic",
  "wetback",
  "raghead",
  "kill yourself",
  "kys",
  "shut up",
];

// Hindi / Punjabi / Hinglish abuse, in the spellings people actually type.
const BLOCKED_HINGLISH = [
  "chutiya",
  "chutiye",
  "chutia",
  "chutya",
  "chutiyapa",
  "bhosdi",
  "bhosdike",
  "bhosadike",
  "bhosda",
  "bhenchod",
  "bhenchodh",
  "behenchod",
  "behnchod",
  "bsdk",
  "bkl",
  "madarchod",
  "madarchodh",
  "maderchod",
  "penchod",
  "pencho",
  "gandu",
  "gaandu",
  "gaand",
  "gandmasti",
  "lund",
  "loda",
  "lawda",
  "lauda",
  "lodu",
  "jhaant",
  "jhatu",
  "jhaatu",
  "harami",
  "haramkhor",
  "haramzada",
  "haramzade",
  "kamina",
  "kamine",
  "kutta",
  "kutte",
  "kutti",
  "kuttiya",
  "kutiya",
  "suvar",
  "randi",
  "raand",
  "chinal",
  "tatti",
  "gadha",
  "gadhe",
  "ullu ka pattha",
  "nalayak",
  "bakchod",
  "bakchodi",
  "chomu",
  "teri maa",
  "teri ma",
  "teri behen",
  "maa ki",
  "maa ka",
  "phudi",
];

/**
 * Whole-token matches only. Padding tolerance on a three-letter term would turn
 * "class assignment" into a hit, and a substring match would turn "passed",
 * "analysis" and "Dickens" into hits.
 */
const BLOCKED_EXACT = [
  "ass",
  "arse",
  "dick",
  "crap",
  "piss",
  "slag",
  "fag",
  "wtf",
  "stfu",
  "gtfo",
  "chod",
  "saala",
  "saale",
  "randa",
];

// A deployment can extend the list without a code change — one comma-separated
// env var, read once at require time.
const fromEnv = String(process.env.LM_EXTRA_BLOCKED_WORDS || "")
  .split(",")
  .map((word) => word.trim().toLowerCase())
  .filter(Boolean);

module.exports = {
  BLOCKED: [...new Set([...BLOCKED, ...BLOCKED_HINGLISH, ...fromEnv])],
  BLOCKED_EXACT: [...new Set(BLOCKED_EXACT)],
};
