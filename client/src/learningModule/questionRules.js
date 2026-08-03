// Authoring rules shared by the quiz editor and the AI Studio draft editor.
//
// The server enforces the same rules in services/questionRules.js — this copy
// exists so a teacher is told which option is the repeat while they are still
// looking at it, rather than by a toast after a failed save. Keep the two in
// step; the server one is the authority.

const CHOICE_TYPES = ['mcq', 'msq', 'truefalse'];

/**
 * The comparable text of an option. Options are rich text, so "Ohm" and
 * "<b>Ohm</b>" are the same answer to the student reading them. Image sources
 * are folded in so that a picture-only option is not treated as blank.
 */
export function optionKey(option) {
  const html = String(option ?? '');
  const images = (html.match(/<img[^>]+src=["']([^"']+)["']/gi) || []).join(' ');
  return `${html.replace(/<[^>]*>/g, ' ')} ${images}`
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Indices of options that repeat an earlier one. Blanks are ignored: a
 * half-typed option is a different complaint, and marking every empty row while
 * the teacher is still filling them in is noise.
 */
export function duplicateOptionIndexes(options) {
  const seen = new Set();
  const duplicates = new Set();
  (options || []).forEach((option, index) => {
    const key = optionKey(option);
    if (!key) return;
    if (seen.has(key)) duplicates.add(index);
    else seen.add(key);
  });
  return duplicates;
}

/** 1-based numbers of the questions that repeat an option. */
export function questionsWithDuplicateOptions(questions) {
  return (questions || [])
    .map((question, index) =>
      CHOICE_TYPES.includes(question?.type) && duplicateOptionIndexes(question.options).size
        ? index + 1
        : null,
    )
    .filter(Boolean);
}

export { CHOICE_TYPES };
