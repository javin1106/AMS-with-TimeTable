/**
 * A small, safe mathematical expression engine.
 *
 * Parameterised tutorials let a teacher type an answer formula ("0.5*m*v^2")
 * that the server then evaluates against per-student variable values. That
 * makes the formula *untrusted input executed on the server*, so `eval`,
 * `new Function` and any library that compiles to them are out of the
 * question — a teacher account (or anyone who compromises one) would
 * otherwise have remote code execution.
 *
 * This is a hand-written tokeniser + recursive-descent parser producing an
 * AST, evaluated with an explicit whitelist of functions and constants.
 * Nothing outside that whitelist is reachable: there is no property access,
 * no assignment, no function references, no loops.
 *
 * Grammar (lowest precedence first):
 *
 *   or         := and ( '||' and )*
 *   and        := compare ( '&&' compare )*
 *   compare    := additive ( ('=='|'!='|'<'|'<='|'>'|'>=') additive )?
 *   additive   := multiply ( ('+'|'-') multiply )*
 *   multiply   := unary ( ('*'|'/'|'%') unary )*
 *   unary      := ('-'|'+'|'!') unary | power
 *   power      := primary ( '^' unary )?          // right-associative
 *   primary    := NUMBER | NAME | NAME '(' args ')' | '(' or ')'
 */

// Guards against a pathological formula burning CPU or memory. A real
// tutorial formula is a few dozen tokens; these limits are far above that
// and well below anything that could hurt the event loop.
const MAX_EXPRESSION_LENGTH = 2000;
const MAX_TOKENS = 500;
const MAX_NODES = 500;

const CONSTANTS = {
  pi: Math.PI,
  e: Math.E,
};

// Every callable name, with its arity. `null` arity means variadic.
const FUNCTIONS = {
  abs: { arity: 1, fn: Math.abs },
  sqrt: { arity: 1, fn: Math.sqrt },
  cbrt: { arity: 1, fn: Math.cbrt },
  exp: { arity: 1, fn: Math.exp },
  ln: { arity: 1, fn: Math.log },
  log: { arity: 1, fn: Math.log10 },
  log10: { arity: 1, fn: Math.log10 },
  log2: { arity: 1, fn: Math.log2 },
  sin: { arity: 1, fn: Math.sin },
  cos: { arity: 1, fn: Math.cos },
  tan: { arity: 1, fn: Math.tan },
  asin: { arity: 1, fn: Math.asin },
  acos: { arity: 1, fn: Math.acos },
  atan: { arity: 1, fn: Math.atan },
  sinh: { arity: 1, fn: Math.sinh },
  cosh: { arity: 1, fn: Math.cosh },
  tanh: { arity: 1, fn: Math.tanh },
  sign: { arity: 1, fn: Math.sign },
  floor: { arity: 1, fn: Math.floor },
  ceil: { arity: 1, fn: Math.ceil },
  deg: { arity: 1, fn: (x) => (x * 180) / Math.PI },
  rad: { arity: 1, fn: (x) => (x * Math.PI) / 180 },
  atan2: { arity: 2, fn: Math.atan2 },
  pow: { arity: 2, fn: Math.pow },
  mod: { arity: 2, fn: (a, b) => a % b },
  // round(x) or round(x, decimals)
  round: {
    arity: null,
    fn: (...args) => {
      const [value, decimals = 0] = args;
      const factor = 10 ** Math.trunc(decimals);
      return Math.round(value * factor) / factor;
    },
  },
  min: { arity: null, fn: (...args) => Math.min(...args) },
  max: { arity: null, fn: (...args) => Math.max(...args) },
  hypot: { arity: null, fn: (...args) => Math.hypot(...args) },
  // if(condition, then, else) — lets a teacher express a piecewise answer.
  if: { arity: 3, fn: (cond, a, b) => (cond ? a : b) },
};

class FormulaError extends Error {
  constructor(message, position) {
    super(message);
    this.name = 'FormulaError';
    this.position = position ?? null;
  }
}

/* ─────────────────────────────── tokeniser ─────────────────────────────── */

const TWO_CHAR_OPERATORS = new Set(['==', '!=', '<=', '>=', '&&', '||']);
const ONE_CHAR_OPERATORS = new Set(['+', '-', '*', '/', '%', '^', '(', ')', ',', '<', '>', '!']);

function tokenize(input) {
  const source = String(input ?? '');
  if (source.length > MAX_EXPRESSION_LENGTH) {
    throw new FormulaError(`Formula is too long (limit ${MAX_EXPRESSION_LENGTH} characters).`);
  }

  const tokens = [];
  let i = 0;

  while (i < source.length) {
    const char = source[i];

    if (/\s/.test(char)) {
      i += 1;
      continue;
    }

    // Number, including 1.5, .5 and 1.2e-3
    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(source[i + 1] || ''))) {
      const match = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(source.slice(i));
      if (!match) throw new FormulaError(`Malformed number at position ${i}.`, i);
      tokens.push({ type: 'number', value: Number(match[0]), position: i });
      i += match[0].length;
      continue;
    }

    // Identifier: variable, constant or function name
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
      tokens.push({ type: 'name', value: match[0], position: i });
      i += match[0].length;
      continue;
    }

    const twoChar = source.slice(i, i + 2);
    if (TWO_CHAR_OPERATORS.has(twoChar)) {
      tokens.push({ type: 'op', value: twoChar, position: i });
      i += 2;
      continue;
    }

    if (ONE_CHAR_OPERATORS.has(char)) {
      tokens.push({ type: 'op', value: char, position: i });
      i += 1;
      continue;
    }

    // A single '=' is almost always a teacher typing "P = I^2*R" into the
    // formula box, so say that rather than "unexpected character".
    if (char === '=') {
      throw new FormulaError(
        `Unexpected "=" at position ${i}. Enter only the right-hand side of the formula, e.g. "I^2*R".`,
        i,
      );
    }

    throw new FormulaError(`Unexpected character "${char}" at position ${i}.`, i);
  }

  if (tokens.length > MAX_TOKENS) {
    throw new FormulaError(`Formula is too complex (limit ${MAX_TOKENS} tokens).`);
  }
  return tokens;
}

/* ──────────────────────────────── parser ───────────────────────────────── */

function parse(expression) {
  const tokens = tokenize(expression);
  let index = 0;
  let nodeCount = 0;

  const peek = () => tokens[index] || null;
  const isOp = (value) => {
    const token = peek();
    return token && token.type === 'op' && token.value === value;
  };
  const eat = (value) => {
    if (!isOp(value)) return false;
    index += 1;
    return true;
  };
  const expect = (value) => {
    if (!eat(value)) {
      const token = peek();
      throw new FormulaError(
        `Expected "${value}"${token ? ` but found "${token.value}"` : ' but the formula ended'}.`,
        token?.position,
      );
    }
  };
  const node = (value) => {
    nodeCount += 1;
    if (nodeCount > MAX_NODES) throw new FormulaError('Formula is too complex.');
    return value;
  };

  function parseOr() {
    let left = parseAnd();
    while (isOp('||')) {
      index += 1;
      left = node({ kind: 'logical', op: '||', left, right: parseAnd() });
    }
    return left;
  }

  function parseAnd() {
    let left = parseCompare();
    while (isOp('&&')) {
      index += 1;
      left = node({ kind: 'logical', op: '&&', left, right: parseCompare() });
    }
    return left;
  }

  function parseCompare() {
    const left = parseAdditive();
    for (const op of ['==', '!=', '<=', '>=', '<', '>']) {
      if (isOp(op)) {
        index += 1;
        return node({ kind: 'compare', op, left, right: parseAdditive() });
      }
    }
    return left;
  }

  function parseAdditive() {
    let left = parseMultiply();
    for (;;) {
      if (isOp('+')) {
        index += 1;
        left = node({ kind: 'binary', op: '+', left, right: parseMultiply() });
      } else if (isOp('-')) {
        index += 1;
        left = node({ kind: 'binary', op: '-', left, right: parseMultiply() });
      } else {
        return left;
      }
    }
  }

  function parseMultiply() {
    let left = parseUnary();
    for (;;) {
      if (isOp('*')) {
        index += 1;
        left = node({ kind: 'binary', op: '*', left, right: parseUnary() });
      } else if (isOp('/')) {
        index += 1;
        left = node({ kind: 'binary', op: '/', left, right: parseUnary() });
      } else if (isOp('%')) {
        index += 1;
        left = node({ kind: 'binary', op: '%', left, right: parseUnary() });
      } else {
        return left;
      }
    }
  }

  function parseUnary() {
    if (isOp('-')) {
      index += 1;
      return node({ kind: 'unary', op: '-', operand: parseUnary() });
    }
    if (isOp('+')) {
      index += 1;
      return parseUnary();
    }
    if (isOp('!')) {
      index += 1;
      return node({ kind: 'unary', op: '!', operand: parseUnary() });
    }
    return parsePower();
  }

  function parsePower() {
    const base = parsePrimary();
    if (isOp('^')) {
      index += 1;
      // Right-associative, and the exponent may itself be unary ("2^-1").
      return node({ kind: 'binary', op: '^', left: base, right: parseUnary() });
    }
    return base;
  }

  function parsePrimary() {
    const token = peek();
    if (!token) throw new FormulaError('The formula ended unexpectedly.');

    if (token.type === 'number') {
      index += 1;
      return node({ kind: 'number', value: token.value });
    }

    if (token.type === 'name') {
      index += 1;
      const name = token.value;

      if (isOp('(')) {
        index += 1;
        const args = [];
        if (!isOp(')')) {
          do {
            args.push(parseOr());
          } while (eat(','));
        }
        expect(')');
        return node({ kind: 'call', name, args, position: token.position });
      }

      return node({ kind: 'name', name, position: token.position });
    }

    if (eat('(')) {
      const inner = parseOr();
      expect(')');
      return inner;
    }

    throw new FormulaError(`Unexpected "${token.value}".`, token.position);
  }

  const ast = parseOr();
  if (index < tokens.length) {
    const token = tokens[index];
    throw new FormulaError(`Unexpected "${token.value}" after the end of the formula.`, token.position);
  }
  return ast;
}

/* ────────────────────────────── evaluation ─────────────────────────────── */

function evaluateNode(ast, scope) {
  switch (ast.kind) {
    case 'number':
      return ast.value;

    case 'name': {
      const lower = ast.name.toLowerCase();
      // Variables win over constants, so a question may legitimately use a
      // variable called "e" without colliding with Euler's number.
      if (Object.prototype.hasOwnProperty.call(scope, ast.name)) {
        return Number(scope[ast.name]);
      }
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, lower)) {
        return CONSTANTS[lower];
      }
      throw new FormulaError(`Unknown variable "${ast.name}".`, ast.position);
    }

    case 'call': {
      const lower = ast.name.toLowerCase();
      const spec = Object.prototype.hasOwnProperty.call(FUNCTIONS, lower) ? FUNCTIONS[lower] : null;
      if (!spec) throw new FormulaError(`Unknown function "${ast.name}".`, ast.position);
      if (spec.arity !== null && ast.args.length !== spec.arity) {
        throw new FormulaError(
          `${ast.name}() takes ${spec.arity} argument${spec.arity === 1 ? '' : 's'}, got ${ast.args.length}.`,
          ast.position,
        );
      }
      if (spec.arity === null && ast.args.length === 0) {
        throw new FormulaError(`${ast.name}() needs at least one argument.`, ast.position);
      }
      const args = ast.args.map((arg) => evaluateNode(arg, scope));
      return spec.fn(...args);
    }

    case 'unary': {
      const value = evaluateNode(ast.operand, scope);
      if (ast.op === '-') return -value;
      return value ? 0 : 1;
    }

    case 'binary': {
      const left = evaluateNode(ast.left, scope);
      const right = evaluateNode(ast.right, scope);
      switch (ast.op) {
        case '+': return left + right;
        case '-': return left - right;
        case '*': return left * right;
        case '/': return left / right;
        case '%': return left % right;
        case '^': return left ** right;
        default: throw new FormulaError(`Unsupported operator "${ast.op}".`);
      }
    }

    case 'compare': {
      const left = evaluateNode(ast.left, scope);
      const right = evaluateNode(ast.right, scope);
      switch (ast.op) {
        case '==': return left === right ? 1 : 0;
        case '!=': return left !== right ? 1 : 0;
        case '<': return left < right ? 1 : 0;
        case '<=': return left <= right ? 1 : 0;
        case '>': return left > right ? 1 : 0;
        case '>=': return left >= right ? 1 : 0;
        default: throw new FormulaError(`Unsupported comparison "${ast.op}".`);
      }
    }

    case 'logical': {
      const left = evaluateNode(ast.left, scope);
      if (ast.op === '&&') return left && evaluateNode(ast.right, scope) ? 1 : 0;
      return left || evaluateNode(ast.right, scope) ? 1 : 0;
    }

    default:
      throw new FormulaError('Malformed formula.');
  }
}

/** Every variable name a formula reads, for the authoring-time check. */
function collectVariables(ast, found = new Set()) {
  switch (ast.kind) {
    case 'name':
      if (!Object.prototype.hasOwnProperty.call(CONSTANTS, ast.name.toLowerCase())) {
        found.add(ast.name);
      }
      break;
    case 'call':
      ast.args.forEach((arg) => collectVariables(arg, found));
      break;
    case 'unary':
      collectVariables(ast.operand, found);
      break;
    case 'binary':
    case 'compare':
    case 'logical':
      collectVariables(ast.left, found);
      collectVariables(ast.right, found);
      break;
    default:
      break;
  }
  return found;
}

/**
 * Parse + evaluate in one step.
 * @throws {FormulaError} on a bad formula, an unknown name, or a
 *         non-finite result (NaN/Infinity — usually a divide by zero or the
 *         square root of a negative, both of which mean the question's
 *         variable ranges need a constraint).
 */
function evaluate(expression, scope = {}) {
  const value = evaluateNode(parse(expression), scope);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new FormulaError(
      'The formula did not produce a finite number for these values (check for division by zero or the root of a negative).',
    );
  }
  return value;
}

/** Like evaluate(), but a non-finite result is allowed — used for constraints. */
function evaluateRaw(expression, scope = {}) {
  return evaluateNode(parse(expression), scope);
}

/**
 * Authoring-time check. Never throws — returns a report the editor can show
 * inline while the teacher is still typing.
 *
 * @param {string} expression
 * @param {string[]} allowedVariables names declared on the question
 */
function validate(expression, allowedVariables = []) {
  if (!String(expression || '').trim()) {
    return { ok: false, error: 'Formula is empty.', variables: [], unknown: [] };
  }
  try {
    const ast = parse(expression);
    const used = [...collectVariables(ast)];
    const allowed = new Set(allowedVariables);
    const unknown = used.filter(
      (name) => !allowed.has(name) && !Object.prototype.hasOwnProperty.call(FUNCTIONS, name.toLowerCase()),
    );
    return {
      ok: unknown.length === 0,
      error: unknown.length
        ? `Undeclared variable${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. Declare ${
            unknown.length === 1 ? 'it' : 'them'
          } on the question, or check the spelling.`
        : null,
      variables: used,
      unknown,
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      position: error.position ?? null,
      variables: [],
      unknown: [],
    };
  }
}

/**
 * Parses a value a student typed. Accepts a plain number or a small
 * arithmetic expression ("2*pi*3", "1.6e-19"), which is friendlier than
 * forcing them to pre-compute — and it goes through the same safe parser.
 * Returns null when the input is blank or not a finite number.
 */
function parseStudentValue(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  try {
    const value = evaluateNode(parse(raw), {});
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

module.exports = {
  FormulaError,
  parse,
  evaluate,
  evaluateRaw,
  validate,
  collectVariables,
  parseStudentValue,
  FUNCTION_NAMES: Object.keys(FUNCTIONS).sort(),
  CONSTANT_NAMES: Object.keys(CONSTANTS),
};
