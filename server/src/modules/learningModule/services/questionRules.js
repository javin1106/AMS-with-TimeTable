/**
 * Authoring rules that apply to a question wherever it is written — the quiz
 * editor, an AI-generated draft, or a raw API call.
 *
 * Kept out of the controllers because three of them (quiz create, quiz update,
 * studio draft → quiz) have to reach the same verdict; a rule enforced in only
 * two of the three is worse than no rule, because the one gap is the one that
 * gets used.
 */

const CHOICE_TYPES = ['mcq', 'msq', 'truefalse'];

/**
 * The comparable text of an option.
 *
 * Options are rich text, so "Ohm" and "<b>Ohm</b>" are the same answer as far
 * as a student reading them is concerned, and must count as a duplicate. Image
 * sources are folded in rather than stripped: an option that is only a picture
 * would otherwise normalise to the empty string, and two different diagrams
 * would look identical to this comparison.
 */
const optionKey = (option) => {
  const html = String(option ?? '');
  const images = (html.match(/<img[^>]+src=["']([^"']+)["']/gi) || []).join(' ');
  return `${html.replace(/<[^>]*>/g, ' ')} ${images}`
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
};

/**
 * Indices of options that repeat an earlier one, ignoring blanks — an
 * unfinished option is a different complaint, and flagging every empty row
 * while a teacher is still typing them is noise.
 *
 * @returns {number[]} the later index of each repeat, in order
 */
const duplicateOptionIndexes = (options) => {
  const seen = new Map();
  const duplicates = [];
  (options || []).forEach((option, index) => {
    const key = optionKey(option);
    if (!key) return;
    if (seen.has(key)) duplicates.push(index);
    else seen.set(key, index);
  });
  return duplicates;
};

/**
 * Checks a whole paper for repeated options.
 *
 * @returns {string|null} a message naming the offending questions, or null when
 *   the paper is clean.
 */
const duplicateOptionMessage = (questions) => {
  const offenders = (questions || [])
    .map((question, index) =>
      CHOICE_TYPES.includes(question?.type) && duplicateOptionIndexes(question.options).length
        ? index + 1
        : null,
    )
    .filter(Boolean);

  if (!offenders.length) return null;
  return `Question${offenders.length > 1 ? 's' : ''} ${offenders.join(', ')} repeat${
    offenders.length > 1 ? '' : 's'
  } the same option twice. Every choice must be distinct, otherwise a student can be right and wrong at once.`;
};

module.exports = { optionKey, duplicateOptionIndexes, duplicateOptionMessage, CHOICE_TYPES };
