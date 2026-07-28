/**
 * The formula engine evaluates teacher-authored expressions on the server, so
 * these tests cover two things with equal weight: that the maths is right, and
 * that a formula cannot reach anything outside the whitelist.
 */

const engine = require('../../src/modules/learningModule/services/formulaEngine');

describe('learningModule formulaEngine — arithmetic', () => {
  it('respects operator precedence', () => {
    expect(engine.evaluate('2 + 3 * 4')).toBe(14);
    expect(engine.evaluate('(2 + 3) * 4')).toBe(20);
    expect(engine.evaluate('10 - 4 - 3')).toBe(3); // left-associative
  });

  it('treats ^ as right-associative, like a maths textbook', () => {
    expect(engine.evaluate('2^3^2')).toBe(512);
    expect(engine.evaluate('(2^3)^2')).toBe(64);
  });

  it('handles unary minus, including in an exponent', () => {
    expect(engine.evaluate('-5 + 2')).toBe(-3);
    expect(engine.evaluate('2^-1')).toBe(0.5);
    expect(engine.evaluate('-(3 * 2)')).toBe(-6);
  });

  it('parses decimals and scientific notation', () => {
    expect(engine.evaluate('.5 * 4')).toBe(2);
    expect(engine.evaluate('1.6e-19 * 2')).toBeCloseTo(3.2e-19, 25);
  });

  it('substitutes variables', () => {
    expect(engine.evaluate('0.5*m*v^2', { m: 2, v: 3 })).toBe(9);
    expect(engine.evaluate('V/R', { V: 12, R: 4 })).toBe(3);
  });

  it('lets a variable shadow a built-in constant', () => {
    // A circuits question may legitimately call a variable "e".
    expect(engine.evaluate('e * 2', { e: 10 })).toBe(20);
    expect(engine.evaluate('e')).toBeCloseTo(Math.E, 10);
  });

  it('supports the whitelisted functions', () => {
    expect(engine.evaluate('sqrt(16)')).toBe(4);
    expect(engine.evaluate('max(3, 7, 5)')).toBe(7);
    expect(engine.evaluate('round(3.14159, 2)')).toBe(3.14);
    expect(engine.evaluate('log(1000)')).toBeCloseTo(3, 10);
    expect(engine.evaluate('ln(e)')).toBeCloseTo(1, 10);
    expect(engine.evaluate('hypot(3, 4)')).toBe(5);
    expect(engine.evaluate('if(x > 5, 100, 200)', { x: 9 })).toBe(100);
    expect(engine.evaluate('if(x > 5, 100, 200)', { x: 1 })).toBe(200);
  });

  it('evaluates comparisons and logic, for constraints', () => {
    expect(engine.evaluateRaw('R > 0', { R: 5 })).toBe(1);
    expect(engine.evaluateRaw('R > 0 && R < 10', { R: 5 })).toBe(1);
    expect(engine.evaluateRaw('R > 0 && R < 10', { R: 50 })).toBe(0);
    expect(engine.evaluateRaw('a != b', { a: 1, b: 1 })).toBe(0);
  });
});

describe('learningModule formulaEngine — rejection', () => {
  it('refuses a non-finite result rather than storing NaN as an answer', () => {
    expect(() => engine.evaluate('1/0')).toThrow(/finite/i);
    expect(() => engine.evaluate('sqrt(-4)')).toThrow(/finite/i);
    expect(() => engine.evaluate('0/0')).toThrow(/finite/i);
  });

  it('rejects unknown variables and functions by name', () => {
    expect(() => engine.evaluate('a + b', { a: 1 })).toThrow(/Unknown variable "b"/);
    expect(() => engine.evaluate('frobnicate(2)')).toThrow(/Unknown function/);
  });

  it('rejects malformed expressions', () => {
    expect(() => engine.evaluate('2 +')).toThrow();
    expect(() => engine.evaluate('(2 + 3')).toThrow(/Expected "\)"/);
    expect(() => engine.evaluate('2 3')).toThrow();
    expect(() => engine.evaluate('')).toThrow();
  });

  it('gives a targeted message when a teacher pastes the whole equation', () => {
    expect(() => engine.evaluate('P = I^2*R', { I: 1, R: 1 })).toThrow(/right-hand side/);
  });

  it('checks function arity', () => {
    expect(() => engine.evaluate('sqrt(1, 2)')).toThrow(/takes 1 argument/);
    expect(() => engine.evaluate('atan2(1)')).toThrow(/takes 2 arguments/);
  });

  // The security-critical set: none of these may reach the JS runtime.
  it.each([
    ['property access', 'process.exit(1)'],
    ['bracket access', 'this["constructor"]'],
    ['prototype walk', 'constructor.constructor'],
    ['global reference', 'global'],
    ['require', 'require("fs")'],
    ['assignment', 'x = 5'],
    ['semicolon sequencing', '1; 2'],
    ['string literal', '"abc"'],
    ['template literal', '`abc`'],
    ['arrow function', '() => 1'],
  ])('blocks %s', (_label, expression) => {
    expect(() => engine.evaluate(expression, {})).toThrow();
  });

  it('does not expose Math or its members as callable names', () => {
    expect(() => engine.evaluate('Math')).toThrow(/Unknown variable/);
    expect(() => engine.evaluate('random()')).toThrow(/Unknown function/);
  });

  it('caps expression length and complexity', () => {
    expect(() => engine.evaluate('1+'.repeat(3000) + '1')).toThrow(/too long|too complex/i);
  });
});

describe('learningModule formulaEngine — validate()', () => {
  it('accepts a formula whose variables are all declared', () => {
    const result = engine.validate('I^2 * R', ['I', 'R']);
    expect(result.ok).toBe(true);
    expect(result.variables.sort()).toEqual(['I', 'R']);
  });

  it('names the undeclared variable instead of just failing', () => {
    const result = engine.validate('I^2 * Rr', ['I', 'R']);
    expect(result.ok).toBe(false);
    expect(result.unknown).toEqual(['Rr']);
    expect(result.error).toMatch(/Rr/);
  });

  it('does not count built-in constants as undeclared', () => {
    expect(engine.validate('2*pi*r', ['r']).ok).toBe(true);
  });

  it('reports a syntax error without throwing', () => {
    const result = engine.validate('2 * (3', ['x']);
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
  });

  it('flags an empty formula', () => {
    expect(engine.validate('', []).ok).toBe(false);
  });
});

describe('learningModule formulaEngine — parseStudentValue()', () => {
  it('accepts a plain number', () => {
    expect(engine.parseStudentValue('42')).toBe(42);
    expect(engine.parseStudentValue(' -3.5 ')).toBe(-3.5);
    expect(engine.parseStudentValue('1.6e-19')).toBeCloseTo(1.6e-19, 25);
  });

  it('accepts an arithmetic expression, so students need not pre-compute', () => {
    expect(engine.parseStudentValue('2*pi*3')).toBeCloseTo(18.8496, 3);
    expect(engine.parseStudentValue('sqrt(2)')).toBeCloseTo(1.41421, 4);
  });

  it('returns null for blank or unusable input rather than throwing', () => {
    expect(engine.parseStudentValue('')).toBeNull();
    expect(engine.parseStudentValue('   ')).toBeNull();
    expect(engine.parseStudentValue(null)).toBeNull();
    expect(engine.parseStudentValue('about twelve')).toBeNull();
    expect(engine.parseStudentValue('1/0')).toBeNull();
  });

  it('cannot read the question variables', () => {
    // Students must not be able to type the variable name to dodge the maths.
    expect(engine.parseStudentValue('R')).toBeNull();
  });
});
