/**
 * The arithmetic behind the on-screen scientific calculator.
 *
 * Hand-written tokeniser and recursive-descent parser rather than `eval` or
 * `new Function`. The keypad is not the only way text gets in here — the
 * display is an editable field, so a student can type anything at all — and a
 * calculator is no reason to hand a student's string to the JS engine.
 *
 * The grammar, loosest binding first:
 *
 *   expression := term (('+' | '-') term)*
 *   term       := unary (('*' | '/' | <implicit>) unary)*
 *   unary      := ('-' | '+') unary | power
 *   power      := postfix ('^' unary)?          right-associative
 *   postfix    := primary ('!' | '%')*
 *   primary    := number | constant | 'ans' | function operand | '(' expression ')'
 */

const CONSTANTS = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

const toRadians = (value, degrees) => (degrees ? (value * Math.PI) / 180 : value);
const fromRadians = (value, degrees) => (degrees ? (value * 180) / Math.PI : value);

/**
 * sin(180°) is 1.22e-16 in floating point, which is arithmetically honest and
 * useless to a student checking their working. Only the degree path snaps: in
 * radians the argument is never exact either, so there is nothing to round to.
 */
const snap = (value, degrees) => (degrees && Math.abs(value) < 1e-12 ? 0 : value);

const FUNCTIONS = {
  sin: (x, deg) => snap(Math.sin(toRadians(x, deg)), deg),
  cos: (x, deg) => snap(Math.cos(toRadians(x, deg)), deg),
  // In degrees the poles are exactly representable, so tan(90) is reported as
  // undefined rather than as the 1.6e16 the radian conversion happens to land on.
  tan: (x, deg) => {
    if (deg && Math.abs(((x % 180) + 180) % 180) === 90) return Infinity;
    return snap(Math.tan(toRadians(x, deg)), deg);
  },
  asin: (x, deg) => fromRadians(Math.asin(x), deg),
  acos: (x, deg) => fromRadians(Math.acos(x), deg),
  atan: (x, deg) => fromRadians(Math.atan(x), deg),
  sinh: (x) => Math.sinh(x),
  cosh: (x) => Math.cosh(x),
  tanh: (x) => Math.tanh(x),
  ln: (x) => Math.log(x),
  log: (x) => Math.log10(x),
  log2: (x) => Math.log2(x),
  exp: (x) => Math.exp(x),
  sqrt: (x) => Math.sqrt(x),
  cbrt: (x) => Math.cbrt(x),
  abs: (x) => Math.abs(x),
  sign: (x) => Math.sign(x),
  round: (x) => Math.round(x),
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
};

const factorial = (value) => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('Factorial only works on whole numbers of 0 or more');
  }
  if (value > 170) return Infinity; // 171! overflows a double
  let out = 1;
  for (let i = 2; i <= value; i += 1) out *= i;
  return out;
};

/**
 * Folds the symbols the keypad draws onto the ones the parser reads, so what a
 * student sees (√, π, ×) and what is parsed (sqrt, pi, *) never drift apart.
 */
export const normalise = (input) =>
  String(input ?? '')
    .replace(/[×✕⋅·]/g, '*')
    .replace(/[÷∕]/g, '/')
    .replace(/[−–—]/g, '-')
    .replace(/π/g, 'pi')
    .replace(/√/g, 'sqrt')
    .replace(/,/g, '') // thousands separators; no function here takes two arguments
    .trim();

const NUMBER = /^\d*\.?\d*(?:[eE][+-]?\d+)?/;
const NAME = /^[A-Za-z]+\d*/;
const LETTERS = /^[A-Za-z]+/;
const OPERATORS = '+-*/^()!%';

const isKnownName = (raw) => {
  const name = raw.toLowerCase();
  return name === 'ans' || name in CONSTANTS || name in FUNCTIONS;
};

function tokenise(text) {
  const tokens = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    if (char === ' ') {
      index += 1;
    } else if (/[0-9.]/.test(char)) {
      const raw = NUMBER.exec(text.slice(index))[0];
      const value = Number(raw);
      if (!raw || Number.isNaN(value)) throw new Error(`"${raw || char}" is not a number`);
      tokens.push({ type: 'number', value });
      index += raw.length;
    } else if (/[A-Za-z]/.test(char)) {
      const matched = NAME.exec(text.slice(index))[0];
      // A name may carry digits — `log2` is one word — but only if that is
      // really a name here. Otherwise the digits are an argument: `sqrt9`.
      const raw = isKnownName(matched) ? matched : LETTERS.exec(matched)[0];
      tokens.push({ type: 'name', value: raw });
      index += raw.length;
    } else if (OPERATORS.includes(char)) {
      tokens.push({ type: 'operator', value: char });
      index += 1;
    } else {
      throw new Error(`"${char}" is not something this calculator understands`);
    }
  }
  return tokens;
}

function parse(tokens, degrees, ans) {
  let position = 0;

  const peek = () => tokens[position];
  const eat = (value) => {
    const token = peek();
    if (token && token.type === 'operator' && token.value === value) {
      position += 1;
      return true;
    }
    return false;
  };
  // 2(3+4), 2pi and 3sqrt(2) all mean multiplication, so anything that could
  // begin an operand where an operator was expected is one.
  const startsOperand = () => {
    const token = peek();
    if (!token) return false;
    return token.type !== 'operator' || token.value === '(';
  };

  const expression = () => {
    let value = term();
    for (;;) {
      if (eat('+')) value += term();
      else if (eat('-')) value -= term();
      else return value;
    }
  };

  const term = () => {
    let value = unary();
    for (;;) {
      if (eat('*')) {
        value *= unary();
      } else if (eat('/')) {
        const divisor = unary();
        if (divisor === 0) throw new Error('Cannot divide by zero');
        value /= divisor;
      } else if (startsOperand()) {
        value *= unary();
      } else {
        return value;
      }
    }
  };

  const unary = () => {
    if (eat('-')) return -unary();
    if (eat('+')) return unary();
    return power();
  };

  // Right-associative, and below unary minus, so -2^2 is -4 and 2^3^2 is 2^9 —
  // both the conventions a maths paper is written with.
  const power = () => {
    const base = postfix();
    if (!eat('^')) return base;
    return base ** unary();
  };

  const postfix = () => {
    let value = primary();
    for (;;) {
      if (eat('!')) value = factorial(value);
      else if (eat('%')) value /= 100;
      else return value;
    }
  };

  const primary = () => {
    const token = peek();
    if (!token) throw new Error('The expression is unfinished');

    if (token.type === 'number') {
      position += 1;
      return token.value;
    }

    if (token.type === 'operator') {
      if (token.value !== '(') throw new Error(`"${token.value}" has nothing to work on`);
      position += 1;
      const value = expression();
      if (!eat(')')) throw new Error('A bracket was never closed');
      return value;
    }

    position += 1;
    const name = token.value.toLowerCase();
    if (name === 'ans') return ans;
    if (name in CONSTANTS) return CONSTANTS[name];

    const fn = FUNCTIONS[name];
    if (!fn) throw new Error(`"${token.value}" is not a function this calculator knows`);
    // `sqrt9` reads as clearly as `sqrt(9)`; the keypad writes the second form,
    // a student typing quickly writes the first.
    const argument = postfix();
    const value = fn(argument, degrees);
    if (Number.isNaN(value)) throw new Error(`${name}(${argument}) is not a real number`);
    return value;
  };

  const value = expression();
  if (position < tokens.length) {
    throw new Error(`"${tokens[position].value}" is unexpected here`);
  }
  return value;
}

/**
 * Evaluates one expression.
 *
 * @param {string} input
 * @param {object} [options]
 * @param {boolean} [options.degrees]  interpret trig arguments as degrees
 * @param {number}  [options.ans]      what `Ans` stands for
 * @returns {number} — may be ±Infinity (1/0 is refused, but 200! overflows)
 * @throws {Error} with wording meant to be shown to the student as-is
 */
export function evaluate(input, { degrees = true, ans = 0 } = {}) {
  const tokens = tokenise(normalise(input));
  if (!tokens.length) throw new Error('Nothing to calculate');

  const value = parse(tokens, degrees, ans);
  if (Number.isNaN(value)) throw new Error('That does not work out to a number');
  return value;
}

/**
 * Renders a result at a width a student can read and copy down: full precision
 * is a lie about accuracy after a dozen floating-point operations, so results
 * are cut to 12 significant figures — enough that 1/3 * 3 comes back as 1.
 */
export function formatResult(value) {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? 'Error' : value > 0 ? '∞' : '−∞';
  if (value === 0) return '0'; // never "-0"

  const magnitude = Math.abs(value);
  if (magnitude >= 1e12 || magnitude < 1e-9) return String(Number(value.toExponential(9)));
  return String(Number(value.toPrecision(12)));
}
