const crypto = require('crypto');

const { evaluate, evaluateRaw, FormulaError } = require('./formulaEngine');

/**
 * Builds each student's personal variant of a parameterised tutorial.
 *
 * Two properties matter and drive the whole design:
 *
 * 1. **Determinism.** A student who reloads the page, or comes back tomorrow,
 *    must see the same numbers. So values are not drawn from Math.random()
 *    but from a PRNG seeded by (tutorialId, studentId, attemptNumber). The
 *    generated values are still persisted on the attempt — the seed is a
 *    reproducibility aid, not the source of truth, so editing a question
 *    later cannot silently change what an already-started student sees.
 *
 * 2. **Validity.** Random values can produce a division by zero or the root
 *    of a negative. A question may declare a `constraint` expression that
 *    must hold; generation re-rolls until it does.
 */

const MAX_CONSTRAINT_ATTEMPTS = 200;

/** mulberry32 — small, fast, good enough for spreading question values. */
function makeRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit seed from the identifiers, so it survives a restart. */
function seedFor(...parts) {
  const digest = crypto.createHash('sha256').update(parts.join('|')).digest();
  return digest.readUInt32BE(0);
}

const roundTo = (value, decimals) => {
  const factor = 10 ** Math.max(0, Math.min(10, Math.trunc(decimals || 0)));
  return Math.round(value * factor) / factor;
};

/**
 * Draws one variable's value.
 *
 * - `set`     → one of an explicit list (values may be non-numeric labels)
 * - `integer` → a whole number in [min, max] on the step grid
 * - `range`   → a decimal in [min, max] on the step grid, rounded to `decimals`
 *
 * Stepping onto a grid rather than taking a raw float keeps the numbers
 * human — students get 4.5 Ω, not 4.5137829 Ω.
 */
function drawValue(variable, rng) {
  const type = variable.type || 'range';

  if (type === 'set') {
    const values = Array.isArray(variable.values) ? variable.values.filter((v) => v !== '') : [];
    if (!values.length) {
      throw new FormulaError(`Variable "${variable.name}" is a set but has no values.`);
    }
    const picked = values[Math.floor(rng() * values.length)];
    const asNumber = Number(picked);
    return Number.isFinite(asNumber) ? asNumber : picked;
  }

  const min = Number(variable.min);
  const max = Number(variable.max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new FormulaError(`Variable "${variable.name}" needs a numeric min and max.`);
  }
  if (max < min) {
    throw new FormulaError(`Variable "${variable.name}" has max below min.`);
  }

  if (type === 'integer') {
    const step = Math.max(1, Math.trunc(Number(variable.step) || 1));
    const steps = Math.floor((max - min) / step);
    return min + step * Math.floor(rng() * (steps + 1));
  }

  const decimals = Number.isFinite(Number(variable.decimals)) ? Number(variable.decimals) : 2;
  const step = Number(variable.step) > 0 ? Number(variable.step) : 10 ** -decimals;
  const steps = Math.floor((max - min) / step);
  const raw = steps > 0 ? min + step * Math.floor(rng() * (steps + 1)) : min;
  return roundTo(raw, decimals);
}

/** True when the question's constraint (if any) holds for these values. */
function constraintHolds(question, values) {
  const constraint = String(question.constraint || '').trim();
  if (!constraint) return true;
  try {
    return Boolean(evaluateRaw(constraint, values));
  } catch {
    // A constraint that cannot even be evaluated for this draw is treated as
    // "not satisfied" so generation re-rolls rather than throwing.
    return false;
  }
}

/**
 * Generates values + expected answers for one question.
 * @returns {{values: object, expected: Array, warnings: string[]}}
 */
function generateQuestion(question, rng) {
  const variables = Array.isArray(question.variables) ? question.variables : [];
  const warnings = [];

  let values = {};
  let satisfied = false;
  for (let attempt = 0; attempt < MAX_CONSTRAINT_ATTEMPTS; attempt += 1) {
    values = {};
    variables.forEach((variable) => {
      values[variable.name] = drawValue(variable, rng);
    });
    if (constraintHolds(question, values)) {
      satisfied = true;
      break;
    }
  }
  if (!satisfied && String(question.constraint || '').trim()) {
    // Better to hand out a slightly awkward variant than to fail the whole
    // tutorial — but the teacher needs to know their constraint is too tight.
    warnings.push(
      `Could not satisfy the constraint for "${question.prompt?.slice(0, 40) || 'question'}" after ${MAX_CONSTRAINT_ATTEMPTS} tries — widen the variable ranges or relax the constraint.`,
    );
  }

  const expected = (question.answers || []).map((answer) => {
    try {
      const value = evaluate(answer.formula, values);
      return {
        key: String(answer.key || answer.label || ''),
        label: answer.label || '',
        unit: answer.unit || '',
        value: Number.isFinite(Number(answer.decimals)) ? roundTo(value, answer.decimals) : value,
        marks: Number(answer.marks) || 0,
        error: null,
      };
    } catch (error) {
      warnings.push(`${answer.label || 'Answer'}: ${error.message}`);
      return {
        key: String(answer.key || answer.label || ''),
        label: answer.label || '',
        unit: answer.unit || '',
        value: null,
        marks: Number(answer.marks) || 0,
        error: error.message,
      };
    }
  });

  return { values, expected, warnings };
}

/**
 * Builds the whole variant for one student.
 *
 * @param {object} tutorial   the lm_tutorial document (or a plain object)
 * @param {string} studentId
 * @param {number} attemptNumber
 */
function generateVariant(tutorial, studentId, attemptNumber = 1) {
  const seed = seedFor(String(tutorial._id), String(studentId), String(attemptNumber));
  const rng = makeRng(seed);
  const warnings = [];

  const questions = (tutorial.questions || []).map((question) => {
    const result = generateQuestion(question, rng);
    warnings.push(...result.warnings);
    return {
      questionId: question._id,
      values: result.values,
      expected: result.expected,
      // The prompt is rendered here, once, and stored — so the student's paper
      // stays stable even if the teacher edits the wording afterwards.
      prompt: renderTemplate(question.prompt, result.values),
      hint: renderTemplate(question.hint, result.values),
      solution: renderTemplate(question.solutionSteps, result.values),
    };
  });

  return { seed, questions, warnings };
}

/**
 * Substitutes {{name}} placeholders with the drawn values.
 * Unknown placeholders are left visible rather than blanked, so a typo in a
 * variable name is obvious to the teacher in preview instead of silently
 * producing "A resistor of  ohms".
 */
function renderTemplate(template, values) {
  return String(template || '').replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) return match;
    const value = values[name];
    return typeof value === 'number' ? String(roundTo(value, 6)) : String(value);
  });
}

/** Placeholder names used in a template, for authoring-time validation. */
function templateVariables(template) {
  const found = new Set();
  String(template || '').replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (match, name) => {
    found.add(name);
    return match;
  });
  return [...found];
}

const stripTags = (value) => String(value ?? '').replace(/<[^>]+>/g, '');

/**
 * Finds placeholders that markup has broken apart.
 *
 * Prompts are authored in a rich text editor, so a teacher who selects part of
 * `{{R}}` and bolds it stores `{{<strong>R</strong>}}`. The substitution regex
 * would never match that, and the student would be shown literal braces. This
 * spots the case by comparing the placeholders visible in the raw HTML with
 * those visible once tags are removed.
 */
function splitPlaceholders(template) {
  const raw = new Set(templateVariables(template));
  return templateVariables(stripTags(template)).filter((name) => !raw.has(name));
}

/**
 * Marks one student answer against its expected value.
 *
 * Tolerance is the max of the absolute and relative allowances, so a teacher
 * can set 1% and still have near-zero answers accepted via a small absolute
 * floor — comparing a 0.0001 result on percentage alone is hopeless.
 */
function gradeAnswer(given, expectedValue, options = {}) {
  if (expectedValue === null || expectedValue === undefined) {
    return { correct: false, reason: 'no_expected_value' };
  }
  if (given === null || given === undefined) {
    return { correct: false, reason: 'blank' };
  }

  const tolerancePercent = Number.isFinite(Number(options.tolerancePercent))
    ? Number(options.tolerancePercent)
    : 1;
  const toleranceAbs = Number.isFinite(Number(options.toleranceAbs)) ? Number(options.toleranceAbs) : 0;

  const allowed = Math.max(toleranceAbs, Math.abs(expectedValue) * (tolerancePercent / 100));
  const difference = Math.abs(given - expectedValue);

  return {
    correct: difference <= allowed,
    difference,
    allowed,
    reason: difference <= allowed ? 'within_tolerance' : 'outside_tolerance',
  };
}

module.exports = {
  makeRng,
  seedFor,
  drawValue,
  generateQuestion,
  generateVariant,
  renderTemplate,
  templateVariables,
  splitPlaceholders,
  stripTags,
  gradeAnswer,
  roundTo,
  MAX_CONSTRAINT_ATTEMPTS,
};
