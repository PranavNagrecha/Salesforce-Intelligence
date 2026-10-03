import { type MergeRef, scanPercentRefs } from './merge.js';
import { type Tri, triAnd, triNot, triOr } from './rules.js';

/**
 * A small, conservative, three-valued evaluator for Integration Procedure
 * `executionConditionalFormula` / `failureConditionalFormula` strings such as
 *
 *   %step% == 2 && ISNOTBLANK(%HousingDetails%)
 *
 * It understands literals, `%path%` references, comparison operators
 * (`== = != <> < > <= >=`), `&&` / `||` / `!` and the `AND` / `OR` / `NOT`
 * keywords and functions, `ISBLANK`, `ISNOTBLANK`, `IF` and `CONTAINS`.
 * Anything else — an unknown function, arithmetic, a parse error — evaluates
 * to UNKNOWN, never to a guess. The evaluator never throws.
 *
 * `CONTAINS(haystack, needle)` is true when a list holds the needle as an
 * element, or a text (including a `;`-joined multi-select value) holds it as a
 * substring. The four-argument form `CONTAINS(haystack, needle, ifTrue,
 * ifFalse)` returns `ifTrue` / `ifFalse`.
 */

/** A value the evaluator knows, or does not. */
export type FormulaValue =
  | { readonly known: true; readonly value: unknown }
  | { readonly known: false };

const UNKNOWN: FormulaValue = { known: false };

type Token =
  | { readonly t: 'num'; readonly v: number }
  | { readonly t: 'str'; readonly v: string }
  | { readonly t: 'ref'; readonly v: string }
  | { readonly t: 'id'; readonly v: string }
  | { readonly t: 'op'; readonly v: string }
  | { readonly t: '('; }
  | { readonly t: ')'; }
  | { readonly t: ','; };

const tokenize = (src: string): Token[] | null => {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === '%') {
      const q = src.indexOf('%', i + 1);
      if (q === -1) return null;
      out.push({ t: 'ref', v: src.slice(i + 1, q) });
      i = q + 1;
      continue;
    }
    if (c === "'" || c === '"') {
      const q = src.indexOf(c, i + 1);
      if (q === -1) return null;
      out.push({ t: 'str', v: src.slice(i + 1, q) });
      i = q + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i));
      const s = m?.[0] ?? c;
      out.push({ t: 'num', v: Number(s) });
      i += s.length;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
      const s = m?.[0] ?? c;
      out.push({ t: 'id', v: s });
      i += s.length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<>', '<=', '>=', '&&', '||'].includes(two)) {
      out.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if (['=', '<', '>', '!', '+', '-', '*', '/'].includes(c)) {
      out.push({ t: 'op', v: c });
      i += 1;
      continue;
    }
    if (c === '(' || c === ')' || c === ',') {
      out.push({ t: c });
      i += 1;
      continue;
    }
    return null;
  }
  return out;
};

/** The result of evaluating a formula. */
export interface FormulaResult {
  /** The formula's truth value (non-boolean results map through truthiness). */
  readonly truth: Tri;
  /** The computed value (a number, text, boolean, …), or unknown. */
  readonly value: FormulaValue;
  /** The `%path%` references the formula reads, in order. */
  readonly refs: readonly MergeRef[];
  /** Set when the formula could not be parsed. */
  readonly parseError: string | null;
}

const truthOf = (v: FormulaValue): Tri => {
  if (!v.known) return 'unknown';
  const x = v.value;
  if (typeof x === 'boolean') return x ? 'true' : 'false';
  if (x === null || x === undefined || x === '' || x === 0) return 'false';
  if (typeof x === 'string' && x.toLowerCase() === 'false') return 'false';
  return 'true';
};

const fromTri = (t: Tri): FormulaValue =>
  t === 'unknown' ? UNKNOWN : { known: true, value: t === 'true' };

const isBlank = (v: unknown): boolean =>
  v === undefined ||
  v === null ||
  (typeof v === 'string' && v.trim().length === 0) ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

const looseEquals = (a: unknown, b: unknown): boolean => {
  if (typeof a === 'number' || typeof b === 'number') {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  }
  const sa = a === null || a === undefined ? '' : String(a);
  const sb = b === null || b === undefined ? '' : String(b);
  return sa === sb;
};

/**
 * Evaluate `formula`. `lookup` resolves a `%path%` reference (raw inner text)
 * to a known or unknown value.
 */
export const evaluateFormula = (
  formula: string,
  lookup: (rawPath: string) => FormulaValue,
): FormulaResult => {
  const refs = scanPercentRefs(formula).refs;
  const tokens = tokenize(formula);
  if (tokens === null) return { truth: 'unknown', value: UNKNOWN, refs, parseError: 'unrecognised token' };
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const isOp = (v: string): boolean => {
    const t = peek();
    return t !== undefined && t.t === 'op' && t.v === v;
  };
  const isId = (v: string): boolean => {
    const t = peek();
    return t !== undefined && t.t === 'id' && t.v.toUpperCase() === v;
  };
  let failed: string | null = null;
  const fail = (msg: string): FormulaValue => {
    failed ??= msg;
    return UNKNOWN;
  };

  const parseOr = (): FormulaValue => {
    let left = parseAnd();
    while (isOp('||') || (isId('OR') && tokens[pos + 1]?.t !== '(')) {
      pos += 1;
      const right = parseAnd();
      left = fromTri(triOr([truthOf(left), truthOf(right)]));
    }
    return left;
  };
  const parseAnd = (): FormulaValue => {
    let left = parseCmp();
    while (isOp('&&') || (isId('AND') && tokens[pos + 1]?.t !== '(')) {
      pos += 1;
      const right = parseCmp();
      left = fromTri(triAnd([truthOf(left), truthOf(right)]));
    }
    return left;
  };
  const parseCmp = (): FormulaValue => {
    const left = parseUnary();
    const t = peek();
    if (t !== undefined && t.t === 'op' && ['==', '=', '!=', '<>', '<', '>', '<=', '>='].includes(t.v)) {
      pos += 1;
      const right = parseUnary();
      if (!left.known || !right.known) return UNKNOWN;
      const a = left.value;
      const b = right.value;
      switch (t.v) {
        case '==':
        case '=':
          return { known: true, value: looseEquals(a, b) };
        case '!=':
        case '<>':
          return { known: true, value: !looseEquals(a, b) };
        default: {
          const na = Number(a);
          const nb = Number(b);
          if (!Number.isFinite(na) || !Number.isFinite(nb)) return UNKNOWN;
          const r = t.v === '<' ? na < nb : t.v === '>' ? na > nb : t.v === '<=' ? na <= nb : na >= nb;
          return { known: true, value: r };
        }
      }
    }
    if (t !== undefined && t.t === 'op' && ['+', '-', '*', '/'].includes(t.v)) {
      return fail(`arithmetic operator ${t.v} is not evaluated`);
    }
    return left;
  };
  const parseUnary = (): FormulaValue => {
    if (isOp('!') || (isId('NOT') && tokens[pos + 1]?.t !== '(')) {
      pos += 1;
      return fromTri(triNot(truthOf(parseUnary())));
    }
    return parsePrimary();
  };
  const parseArgs = (): FormulaValue[] => {
    const args: FormulaValue[] = [];
    if (peek()?.t !== '(') {
      fail('expected (');
      return args;
    }
    pos += 1;
    if (peek()?.t === ')') {
      pos += 1;
      return args;
    }
    for (;;) {
      args.push(parseOr());
      const t = peek();
      if (t?.t === ',') {
        pos += 1;
        continue;
      }
      if (t?.t === ')') {
        pos += 1;
        break;
      }
      fail('expected , or )');
      break;
    }
    return args;
  };
  const parsePrimary = (): FormulaValue => {
    const t = peek();
    if (t === undefined) return fail('unexpected end');
    pos += 1;
    switch (t.t) {
      case 'num':
        return { known: true, value: t.v };
      case 'str':
        return { known: true, value: t.v };
      case 'ref':
        return lookup(t.v);
      case '(': {
        const v = parseOr();
        if (peek()?.t !== ')') return fail('expected )');
        pos += 1;
        return v;
      }
      case 'id': {
        const name = t.v.toUpperCase();
        if (name === 'TRUE') return { known: true, value: true };
        if (name === 'FALSE') return { known: true, value: false };
        if (name === 'NULL') return { known: true, value: null };
        if (peek()?.t !== '(') return fail(`bare identifier ${t.v}`);
        const args = parseArgs();
        switch (name) {
          case 'ISBLANK':
          case 'ISNOTBLANK': {
            const a = args[0];
            if (a === undefined || !a.known) return UNKNOWN;
            const blank = isBlank(a.value);
            return { known: true, value: name === 'ISBLANK' ? blank : !blank };
          }
          case 'AND':
            return fromTri(triAnd(args.map(truthOf)));
          case 'OR':
            return fromTri(triOr(args.map(truthOf)));
          case 'NOT':
            return fromTri(triNot(truthOf(args[0] ?? UNKNOWN)));
          case 'IF': {
            const c = truthOf(args[0] ?? UNKNOWN);
            if (c === 'true') return args[1] ?? UNKNOWN;
            if (c === 'false') return args[2] ?? UNKNOWN;
            return UNKNOWN;
          }
          case 'CONTAINS': {
            const hay = args[0];
            const needle = args[1];
            if (hay === undefined || needle === undefined || !hay.known || !needle.known) return UNKNOWN;
            const n = needle.value === null || needle.value === undefined ? '' : String(needle.value);
            const h = hay.value;
            const found = Array.isArray(h)
              ? h.some((x) => looseEquals(x, n))
              : h === null || h === undefined
                ? false
                : n.length > 0 && String(h).includes(n);
            if (args.length >= 4) return (found ? args[2] : args[3]) ?? UNKNOWN;
            return { known: true, value: found };
          }
          default:
            return fail(`function ${t.v} is not evaluated`);
        }
      }
      default:
        return fail(`unexpected ${t.t}`);
    }
  };

  const value = tokens.length === 0 ? fail('empty formula') : parseOr();
  if (failed === null && pos < tokens.length) failed = 'trailing tokens';
  return {
    truth: failed === null ? truthOf(value) : 'unknown',
    value: failed === null ? value : UNKNOWN,
    refs,
    parseError: failed,
  };
};
