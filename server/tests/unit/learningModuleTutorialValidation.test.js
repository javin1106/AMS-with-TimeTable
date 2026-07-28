/**
 * prepareQuestions() gates every tutorial write. If it lets a bad question
 * through, the failure surfaces to a student mid-assessment rather than to the
 * teacher at save time, so its rules are worth pinning down.
 *
 * Pure function — no database needed.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { prepareQuestions } = require('../../src/modules/learningModule/controllers/tutorialController');
const variants = require('../../src/modules/learningModule/services/variantGenerator');

const validQuestion = (overrides = {}) => ({
  prompt: '<p>A resistor of {{R}} Ω carries {{I}} A. Find the power.</p>',
  variables: [
    { name: 'R', type: 'integer', min: 10, max: 100, step: 5 },
    { name: 'I', type: 'range', min: 0.5, max: 3, step: 0.5, decimals: 1 },
  ],
  answers: [{ key: 'p', label: 'Power', formula: 'I^2*R', unit: 'W', marks: 5 }],
  ...overrides,
});

describe('learningModule prepareQuestions — accepts good input', () => {
  it('passes a well-formed question', () => {
    const { questions, errors } = prepareQuestions([validQuestion()]);
    expect(errors).toEqual([]);
    expect(questions).toHaveLength(1);
    expect(questions[0].variables).toHaveLength(2);
    expect(questions[0].answers[0].formula).toBe('I^2*R');
  });

  it('allocates a stable answer key when none is supplied', () => {
    const { questions } = prepareQuestions([
      validQuestion({ answers: [{ label: 'Power', formula: 'I^2*R', marks: 5 }] }),
    ]);
    expect(questions[0].answers[0].key).toMatch(/^[a-f0-9]{12}$/);
  });

  it('keeps an existing key so a saved student response still matches', () => {
    const { questions } = prepareQuestions([
      validQuestion({ answers: [{ key: 'keepme', label: 'Renamed', formula: 'R', marks: 1 }] }),
    ]);
    expect(questions[0].answers[0].key).toBe('keepme');
  });

  it('applies sensible defaults for tolerance and marks', () => {
    const { questions } = prepareQuestions([
      validQuestion({ answers: [{ key: 'a', label: 'A', formula: 'R' }] }),
    ]);
    expect(questions[0].answers[0].tolerancePercent).toBe(1);
    expect(questions[0].answers[0].toleranceAbs).toBe(0);
    expect(questions[0].answers[0].marks).toBe(1);
  });

  it('accepts a valid constraint', () => {
    const { errors } = prepareQuestions([validQuestion({ constraint: 'R > 0 && I > 0' })]);
    expect(errors).toEqual([]);
  });
});

describe('learningModule prepareQuestions — rejects bad input', () => {
  it('rejects an empty prompt, including an empty rich-text document', () => {
    // Quill sends this for a blank editor; a naive truthiness check passes it.
    expect(prepareQuestions([validQuestion({ prompt: '<p><br></p>' })]).errors.join(' ')).toMatch(
      /prompt is empty/,
    );
    expect(prepareQuestions([validQuestion({ prompt: '' })]).errors.join(' ')).toMatch(/prompt is empty/);
    expect(prepareQuestions([validQuestion({ prompt: '<p>&nbsp;</p>' })]).errors.join(' ')).toMatch(
      /prompt is empty/,
    );
  });

  it('rejects a placeholder with no matching variable', () => {
    const { errors } = prepareQuestions([
      validQuestion({ prompt: '<p>Find P for {{R}} and {{Q}}.</p>' }),
    ]);
    expect(errors.join(' ')).toMatch(/\{\{Q\}\}/);
  });

  it('rejects a placeholder split by markup, which would never substitute', () => {
    // A teacher bolding half of {{R}} in the editor produces exactly this.
    const { errors } = prepareQuestions([
      validQuestion({ prompt: '<p>Resistance is {{<strong>R</strong>}} ohms and {{I}} A.</p>' }),
    ]);
    expect(errors.join(' ')).toMatch(/formatting inside the braces/);
  });

  it('checks placeholders in the worked solution too', () => {
    const { errors } = prepareQuestions([
      validQuestion({ solutionSteps: '<p>P = {{I}}² × {{Z}}</p>' }),
    ]);
    expect(errors.join(' ')).toMatch(/\{\{Z\}\}/);
  });

  it('rejects a formula referencing an undeclared variable', () => {
    const { errors } = prepareQuestions([
      validQuestion({ answers: [{ key: 'p', label: 'Power', formula: 'I^2*Rr', marks: 5 }] }),
    ]);
    expect(errors.join(' ')).toMatch(/Rr/);
  });

  it('rejects a syntactically broken formula', () => {
    const { errors } = prepareQuestions([
      validQuestion({ answers: [{ key: 'p', label: 'Power', formula: 'I^2*(R', marks: 5 }] }),
    ]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a question with no answers', () => {
    expect(prepareQuestions([validQuestion({ answers: [] })]).errors.join(' ')).toMatch(
      /at least one answer/,
    );
  });

  it('rejects invalid and duplicate variable names', () => {
    expect(
      prepareQuestions([
        validQuestion({
          prompt: '<p>x</p>',
          variables: [{ name: '2bad', type: 'integer', min: 1, max: 2 }],
          answers: [{ key: 'a', label: 'A', formula: '1', marks: 1 }],
        }),
      ]).errors.join(' '),
    ).toMatch(/not a valid variable name/);

    expect(
      prepareQuestions([
        validQuestion({
          prompt: '<p>x</p>',
          variables: [
            { name: 'R', type: 'integer', min: 1, max: 2 },
            { name: 'R', type: 'integer', min: 1, max: 2 },
          ],
          answers: [{ key: 'a', label: 'A', formula: 'R', marks: 1 }],
        }),
      ]).errors.join(' '),
    ).toMatch(/declared twice/);
  });

  it('rejects an impossible range and an empty value set', () => {
    expect(
      prepareQuestions([
        validQuestion({
          prompt: '<p>x</p>',
          variables: [{ name: 'R', type: 'integer', min: 100, max: 10 }],
          answers: [{ key: 'a', label: 'A', formula: 'R', marks: 1 }],
        }),
      ]).errors.join(' '),
    ).toMatch(/max below min/);

    expect(
      prepareQuestions([
        validQuestion({
          prompt: '<p>x</p>',
          variables: [{ name: 'M', type: 'set', values: [] }],
          answers: [{ key: 'a', label: 'A', formula: 'M', marks: 1 }],
        }),
      ]).errors.join(' '),
    ).toMatch(/set with no values/);
  });

  it('rejects a constraint that references an undeclared variable', () => {
    const { errors } = prepareQuestions([validQuestion({ constraint: 'Z > 0' })]);
    expect(errors.join(' ')).toMatch(/constraint/);
  });

  it('reports the question number so the teacher knows where to look', () => {
    const { errors } = prepareQuestions([validQuestion(), validQuestion({ answers: [] })]);
    expect(errors.join(' ')).toMatch(/Question 2/);
  });

  it('tolerates a non-array payload instead of throwing', () => {
    expect(prepareQuestions(undefined)).toEqual({ questions: [], errors: [] });
    expect(prepareQuestions(null)).toEqual({ questions: [], errors: [] });
  });
});

describe('learningModule rich text placeholders in generation', () => {
  it('substitutes placeholders inside HTML prompts', () => {
    const tutorial = {
      _id: 't1',
      questions: [
        {
          _id: 'q1',
          prompt: '<p>A resistor of <strong>{{R}}</strong> Ω carries {{I}} A.</p>',
          variables: [
            { name: 'R', type: 'integer', min: 10, max: 10 },
            { name: 'I', type: 'integer', min: 2, max: 2 },
          ],
          answers: [{ key: 'p', label: 'Power', formula: 'I^2*R', marks: 1 }],
        },
      ],
    };
    const variant = variants.generateVariant(tutorial, 'student-a', 1);
    // Markup survives; only the placeholders are replaced.
    expect(variant.questions[0].prompt).toBe(
      '<p>A resistor of <strong>10</strong> Ω carries 2 A.</p>',
    );
    expect(variant.questions[0].expected[0].value).toBe(40);
  });

  it('detects placeholders broken apart by markup', () => {
    expect(variants.splitPlaceholders('<p>{{<strong>R</strong>}}</p>')).toEqual(['R']);
    expect(variants.splitPlaceholders('<p>{{R}} and <strong>{{I}}</strong></p>')).toEqual([]);
    expect(variants.splitPlaceholders('plain {{R}}')).toEqual([]);
  });

  it('strips tags for emptiness checks', () => {
    expect(variants.stripTags('<p><br></p>').trim()).toBe('');
    expect(variants.stripTags('<p>Hello <b>there</b></p>')).toBe('Hello there');
  });
});
