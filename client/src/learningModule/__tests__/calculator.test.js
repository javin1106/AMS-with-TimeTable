import { describe, expect, it } from 'vitest';

import { evaluate, formatResult } from '../calculator';

/**
 * The calculator is offered during a graded sitting, so a wrong answer here is
 * a wrong answer on a paper. These cover the three things that would actually
 * go wrong: precedence read differently from how a maths paper is written,
 * degrees quietly evaluated as radians, and a typo evaluated as *something*
 * instead of being refused.
 */

const value = (input, options) => evaluate(input, options);

describe('learningModule calculator', () => {
  it('follows the precedence a maths paper is written with', () => {
    expect(value('2+3*4')).toBe(14);
    expect(value('(2+3)*4')).toBe(20);
    expect(value('2^3^2')).toBe(512); // right-associative, not 64
    expect(value('-2^2')).toBe(-4); // the power binds tighter than the sign
    expect(value('10-2-3')).toBe(5);
  });

  it('reads the symbols the keypad draws', () => {
    expect(value('6×7')).toBe(42);
    expect(value('84÷2')).toBe(42);
    expect(value('7−5')).toBe(2);
    expect(value('√(16)')).toBe(4);
    expect(value('π', { degrees: true })).toBeCloseTo(Math.PI, 12);
  });

  it('treats a number beside a bracket or constant as multiplication', () => {
    expect(value('2(3+4)')).toBe(14);
    expect(value('3√(4)')).toBe(6);
    expect(value('sqrt9')).toBe(3);
  });

  it('honours the angle mode', () => {
    expect(value('sin(30)', { degrees: true })).toBeCloseTo(0.5, 12);
    expect(value('sin(30)', { degrees: false })).toBeCloseTo(Math.sin(30), 12);
    expect(value('asin(0.5)', { degrees: true })).toBeCloseTo(30, 12);
    // The floating-point dust that makes sin(180°) 1.2e-16 is swept up: a
    // student checking their working should read 0.
    expect(value('sin(180)', { degrees: true })).toBe(0);
    expect(value('cos(90)', { degrees: true })).toBe(0);
    expect(value('tan(90)', { degrees: true })).toBe(Infinity);
  });

  it('computes the scientific functions', () => {
    expect(value('log(1000)')).toBeCloseTo(3, 12);
    expect(value('ln(e)')).toBeCloseTo(1, 12);
    expect(value('5!')).toBe(120);
    expect(value('50%')).toBe(0.5);
    expect(value('abs(-3)+ceil(1.2)')).toBe(5);
  });

  it('carries Ans and rejects an empty expression', () => {
    expect(value('Ans*2', { ans: 21 })).toBe(42);
    expect(() => value('   ')).toThrow(/Nothing to calculate/);
  });

  it('refuses what it cannot work out, rather than guessing', () => {
    expect(() => value('2+')).toThrow(/unfinished/);
    expect(() => value('(2+3')).toThrow(/bracket/);
    expect(() => value('1/0')).toThrow(/divide by zero/);
    expect(() => value('sqrt(-4)')).toThrow(/not a real number/);
    expect(() => value('foo(2)')).toThrow(/not a function/);
    expect(() => value('2 $ 3')).toThrow(/understands/);
    expect(() => value('2.5!')).toThrow(/whole numbers/);
  });

  it('never reaches the JS engine with what it was given', () => {
    // Whatever a student types into the display is data, not code.
    expect(() => value('window.alert(1)')).toThrow();
    expect(() => value('[].constructor')).toThrow();
  });

  it('formats a result at a width worth copying down', () => {
    expect(formatResult(1 / 3)).toBe('0.333333333333');
    expect(formatResult(0.1 + 0.2)).toBe('0.3'); // not 0.30000000000000004
    expect(formatResult(-0)).toBe('0');
    expect(formatResult(2 ** 80)).toBe('1.20892582e+24');
    expect(formatResult(Infinity)).toBe('∞');
  });
});
