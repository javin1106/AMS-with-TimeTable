/**
 * Per-student variant generation. The properties that matter for fairness and
 * for not confusing students: the same student always sees the same numbers,
 * different students generally do not, constraints are honoured, and marking
 * is tolerant in the way the teacher configured.
 */

const variants = require('../../src/modules/learningModule/services/variantGenerator');

const OHMS_LAW = {
  _id: 'tutorial-1',
  questions: [
    {
      _id: 'q1',
      prompt: 'A resistor of {{R}} Ω carries {{I}} A. Find the voltage and the power.',
      constraint: 'R > 0',
      solutionSteps: 'V = IR = {{I}} × {{R}}',
      hint: 'Ohm’s law relates V, I and R.',
      variables: [
        { name: 'R', type: 'integer', min: 10, max: 100, step: 5 },
        { name: 'I', type: 'range', min: 0.5, max: 3, step: 0.5, decimals: 1 },
      ],
      answers: [
        { key: 'v', label: 'Voltage', formula: 'I*R', unit: 'V', marks: 2, tolerancePercent: 1 },
        { key: 'p', label: 'Power', formula: 'I^2*R', unit: 'W', marks: 3, tolerancePercent: 1 },
      ],
    },
  ],
};

describe('learningModule variantGenerator — determinism', () => {
  it('gives the same student the same paper every time', () => {
    const first = variants.generateVariant(OHMS_LAW, 'student-a', 1);
    const second = variants.generateVariant(OHMS_LAW, 'student-a', 1);
    expect(second.questions[0].values).toEqual(first.questions[0].values);
    expect(second.questions[0].prompt).toBe(first.questions[0].prompt);
    expect(second.seed).toBe(first.seed);
  });

  it('gives different students different papers', () => {
    const seen = new Set();
    for (let i = 0; i < 40; i += 1) {
      const variant = variants.generateVariant(OHMS_LAW, `student-${i}`, 1);
      seen.add(JSON.stringify(variant.questions[0].values));
    }
    // 19 R values × 6 I values = 114 combinations, so 40 students should land
    // on well over a handful of distinct papers.
    expect(seen.size).toBeGreaterThan(10);
  });

  it('re-rolls on a later attempt', () => {
    const first = variants.generateVariant(OHMS_LAW, 'student-a', 1);
    const second = variants.generateVariant(OHMS_LAW, 'student-a', 2);
    expect(second.seed).not.toBe(first.seed);
  });
});

describe('learningModule variantGenerator — value drawing', () => {
  it('keeps integers on the step grid and inside the range', () => {
    const rng = variants.makeRng(12345);
    for (let i = 0; i < 200; i += 1) {
      const value = variants.drawValue({ name: 'R', type: 'integer', min: 10, max: 100, step: 5 }, rng);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(10);
      expect(value).toBeLessThanOrEqual(100);
      expect((value - 10) % 5).toBe(0);
    }
  });

  it('rounds range values to the requested decimals', () => {
    const rng = variants.makeRng(999);
    for (let i = 0; i < 200; i += 1) {
      const value = variants.drawValue(
        { name: 'I', type: 'range', min: 0.5, max: 3, step: 0.5, decimals: 1 },
        rng,
      );
      expect(value).toBeGreaterThanOrEqual(0.5);
      expect(value).toBeLessThanOrEqual(3);
      // No 0.5000000000000001 nonsense reaching a student's screen.
      expect(String(value).replace('-', '').split('.')[1]?.length ?? 0).toBeLessThanOrEqual(1);
    }
  });

  it('draws from an explicit set, coercing numeric strings', () => {
    const rng = variants.makeRng(7);
    const picked = new Set();
    for (let i = 0; i < 60; i += 1) {
      picked.add(variants.drawValue({ name: 'M', type: 'set', values: ['2', '4', '8'] }, rng));
    }
    expect([...picked].sort()).toEqual([2, 4, 8]);
  });

  it('rejects a variable that cannot produce a value', () => {
    const rng = variants.makeRng(1);
    expect(() => variants.drawValue({ name: 'X', type: 'set', values: [] }, rng)).toThrow(/no values/);
    expect(() => variants.drawValue({ name: 'X', type: 'range', min: 10, max: 1 }, rng)).toThrow(/max below min/);
  });
});

describe('learningModule variantGenerator — constraints', () => {
  const DIVIDER = {
    _id: 't2',
    questions: [
      {
        _id: 'q1',
        prompt: 'Compute a/(b-c) for a={{a}}, b={{b}}, c={{c}}.',
        // Without this the formula divides by zero whenever b === c.
        constraint: 'b != c',
        variables: [
          { name: 'a', type: 'integer', min: 1, max: 5 },
          { name: 'b', type: 'integer', min: 1, max: 3 },
          { name: 'c', type: 'integer', min: 1, max: 3 },
        ],
        answers: [{ key: 'r', label: 'Result', formula: 'a/(b-c)', marks: 1 }],
      },
    ],
  };

  it('never hands out values that violate the constraint', () => {
    for (let i = 0; i < 60; i += 1) {
      const variant = variants.generateVariant(DIVIDER, `student-${i}`, 1);
      const { b, c } = variant.questions[0].values;
      expect(b).not.toBe(c);
      expect(variant.questions[0].expected[0].value).not.toBeNull();
      expect(variant.warnings).toEqual([]);
    }
  });

  it('warns rather than throwing when a constraint is unsatisfiable', () => {
    const impossible = {
      _id: 't3',
      questions: [
        {
          _id: 'q1',
          prompt: 'x = {{x}}',
          constraint: 'x > 1000',
          variables: [{ name: 'x', type: 'integer', min: 1, max: 5 }],
          answers: [{ key: 'a', label: 'A', formula: 'x', marks: 1 }],
        },
      ],
    };
    const variant = variants.generateVariant(impossible, 'student-a', 1);
    expect(variant.warnings.join(' ')).toMatch(/constraint/i);
    // Still produces a usable paper instead of failing the whole tutorial.
    expect(variant.questions[0].expected[0].value).not.toBeNull();
  });

  it('records a warning when a formula cannot be evaluated', () => {
    const broken = {
      _id: 't4',
      questions: [
        {
          _id: 'q1',
          prompt: 'x = {{x}}',
          variables: [{ name: 'x', type: 'integer', min: 1, max: 5 }],
          answers: [{ key: 'a', label: 'A', formula: 'x / 0', marks: 1 }],
        },
      ],
    };
    const variant = variants.generateVariant(broken, 'student-a', 1);
    expect(variant.warnings.length).toBeGreaterThan(0);
    expect(variant.questions[0].expected[0].value).toBeNull();
    expect(variant.questions[0].expected[0].error).toBeTruthy();
  });
});

describe('learningModule variantGenerator — templates', () => {
  it('substitutes placeholders into the prompt and solution', () => {
    const variant = variants.generateVariant(OHMS_LAW, 'student-a', 1);
    const { R, I } = variant.questions[0].values;
    expect(variant.questions[0].prompt).toBe(
      `A resistor of ${R} Ω carries ${I} A. Find the voltage and the power.`,
    );
    expect(variant.questions[0].solution).toContain(String(R));
    expect(variant.questions[0].prompt).not.toMatch(/\{\{/);
  });

  it('leaves an unknown placeholder visible so the typo is obvious', () => {
    expect(variants.renderTemplate('Value {{Q}} here', { R: 5 })).toBe('Value {{Q}} here');
  });

  it('lists the placeholders a template uses', () => {
    expect(variants.templateVariables('{{a}} and {{b}} and {{a}}').sort()).toEqual(['a', 'b']);
    expect(variants.templateVariables('no placeholders')).toEqual([]);
  });

  it('computes expected answers from the drawn values', () => {
    const variant = variants.generateVariant(OHMS_LAW, 'student-x', 1);
    const { R, I } = variant.questions[0].values;
    const [voltage, power] = variant.questions[0].expected;
    expect(voltage.value).toBeCloseTo(I * R, 6);
    expect(power.value).toBeCloseTo(I * I * R, 6);
    expect(power.marks).toBe(3);
  });
});

describe('learningModule variantGenerator — gradeAnswer()', () => {
  it('accepts an answer inside the relative tolerance', () => {
    expect(variants.gradeAnswer(100.5, 100, { tolerancePercent: 1 }).correct).toBe(true);
    expect(variants.gradeAnswer(102, 100, { tolerancePercent: 1 }).correct).toBe(false);
  });

  it('honours an absolute tolerance, which matters near zero', () => {
    // 1% of 0.0001 is hopeless to hit; the absolute floor makes it markable.
    expect(variants.gradeAnswer(0.00011, 0.0001, { tolerancePercent: 1, toleranceAbs: 0.00005 }).correct).toBe(true);
    expect(variants.gradeAnswer(0.001, 0.0001, { tolerancePercent: 1, toleranceAbs: 0.00005 }).correct).toBe(false);
  });

  it('marks an exact match correct even with zero tolerance', () => {
    expect(variants.gradeAnswer(42, 42, { tolerancePercent: 0, toleranceAbs: 0 }).correct).toBe(true);
  });

  it('handles negative expected values', () => {
    expect(variants.gradeAnswer(-9.95, -10, { tolerancePercent: 1 }).correct).toBe(true);
    expect(variants.gradeAnswer(10, -10, { tolerancePercent: 1 }).correct).toBe(false);
  });

  it('treats a blank answer as wrong, not as an error', () => {
    expect(variants.gradeAnswer(null, 10, {})).toEqual(expect.objectContaining({ correct: false, reason: 'blank' }));
  });

  it('does not award marks when the expected value could not be computed', () => {
    expect(variants.gradeAnswer(5, null, {})).toEqual(
      expect.objectContaining({ correct: false, reason: 'no_expected_value' }),
    );
  });
});
