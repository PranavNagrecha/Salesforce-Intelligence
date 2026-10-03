import { type KeyPath, parseKeyPath } from './keys.js';

/**
 * Merge-expression scanning.
 *
 * OmniStudio reads data keys inside strings two ways:
 *   - `%path%` — the merge field (`%Step:Block:Input%`, `%HousingDetails%`,
 *     `%Block|n:Field%`), used in payload maps, formulas, conditions, labels;
 *   - `{path}` — a placeholder some surfaces (navigation parameters, card data
 *     sources) substitute; an unresolved one renders as literal text.
 *
 * A `%` that opens a key but never closes it (`ISNOTBLANK(%Details)`) is a
 * MALFORMED merge field — it never substitutes — and is reported as such.
 */

/** One `%…%` or `{…}` reference found in a string. */
export interface MergeRef {
  /** The inner text exactly as written. */
  readonly raw: string;
  readonly path: KeyPath;
  /** Index of the opening delimiter within the scanned string. */
  readonly start: number;
  readonly syntax: 'percent' | 'brace';
}

/** A merge field that opens but never closes. */
export interface MalformedMerge {
  readonly start: number;
  /** The text from the stray `%` to the end of its token. */
  readonly fragment: string;
}

/** Characters that cannot appear inside a merge-field path. */
const INVALID_IN_PATH = /[%(){}=&!<>"',+*;\n\r\t]/;
/** A path's first non-space character must start an identifier. */
const IDENT_START = /[A-Za-z_$]/;

const isValidInner = (inner: string): boolean => {
  const t = inner.trim();
  if (t.length === 0) return false;
  if (!IDENT_START.test(t[0] as string)) return false;
  if (INVALID_IN_PATH.test(inner)) return false;
  // Edge whitespace is allowed (and flagged elsewhere); interior whitespace is
  // never part of a key path.
  return !/\s/.test(t);
};

/** Scan `text` for `%path%` merge fields and malformed openers. */
export const scanPercentRefs = (
  text: string,
): { readonly refs: readonly MergeRef[]; readonly malformed: readonly MalformedMerge[] } => {
  const refs: MergeRef[] = [];
  const malformed: MalformedMerge[] = [];
  let i = 0;
  while (i < text.length) {
    const p = text.indexOf('%', i);
    if (p === -1) break;
    const next = text[p + 1];
    const opensKey = next !== undefined && IDENT_START.test(next);
    const q = text.indexOf('%', p + 1);
    if (q === -1) {
      if (opensKey) malformed.push({ start: p, fragment: tokenFrom(text, p) });
      break;
    }
    const inner = text.slice(p + 1, q);
    if (isValidInner(inner)) {
      refs.push({ raw: inner, path: parseKeyPath(inner), start: p, syntax: 'percent' });
      i = q + 1;
      continue;
    }
    if (opensKey) malformed.push({ start: p, fragment: tokenFrom(text, p) });
    i = q;
  }
  return { refs, malformed };
};

/** The `%` and the identifier-ish run that follows it, for a report. */
const tokenFrom = (text: string, p: number): string => {
  const m = /^%[A-Za-z_$][\w$:|.[\]-]*/.exec(text.slice(p));
  return m === null ? text.slice(p, p + 40) : m[0];
};

const BRACE = /\{\s*([A-Za-z_$][\w$.:|[\]-]*)\s*\}/g;

/** Scan `text` for `{path}` placeholders (the path uses `.` or `:`). */
export const scanBraceRefs = (text: string): readonly MergeRef[] => {
  const refs: MergeRef[] = [];
  for (const m of text.matchAll(BRACE)) {
    const raw = m[1] ?? '';
    refs.push({ raw, path: parseKeyPath(raw.replace(/\./g, ':')), start: m.index ?? 0, syntax: 'brace' });
  }
  return refs;
};

/** One string found inside a JSON blob, with the property path that holds it. */
export interface StringSite {
  /** `extraPayload.HousingDetails`, `show.group.rules[0].field`, … */
  readonly prop: string;
  readonly value: string;
}

/**
 * Every string inside a JSON value, with the dotted property path that holds
 * it. Object keys are visited in sorted order so the output is deterministic.
 */
export const stringSites = (value: unknown, prefix = ''): StringSite[] => {
  const out: StringSite[] = [];
  const walk = (v: unknown, prop: string): void => {
    if (typeof v === 'string') {
      out.push({ prop, value: v });
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${prop}[${i}]`));
      return;
    }
    if (typeof v === 'object' && v !== null) {
      for (const k of Object.keys(v).sort()) {
        walk((v as Record<string, unknown>)[k], prop.length === 0 ? k : `${prop}.${k}`);
      }
    }
  };
  walk(value, prefix);
  return out;
};

/**
 * Every object KEY inside a JSON value, with its property path — used to
 * find payload / map keys written with stray whitespace.
 */
export const keySites = (value: unknown, prefix = ''): { readonly prop: string; readonly key: string }[] => {
  const out: { prop: string; key: string }[] = [];
  const walk = (v: unknown, prop: string): void => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${prop}[${i}]`));
      return;
    }
    if (typeof v === 'object' && v !== null) {
      for (const k of Object.keys(v).sort()) {
        const p = prop.length === 0 ? k : `${prop}.${k}`;
        out.push({ prop: p, key: k });
        walk((v as Record<string, unknown>)[k], p);
      }
    }
  };
  walk(value, prefix);
  return out;
};

/**
 * If `expression` is EXACTLY one `%path%` merge field (surrounding whitespace
 * allowed), return that path — the value is MOVED, not derived. Otherwise null.
 */
export const soleMergeRef = (expression: string): MergeRef | null => {
  const t = expression.trim();
  if (!t.startsWith('%') || !t.endsWith('%')) return null;
  const { refs, malformed } = scanPercentRefs(t);
  if (refs.length !== 1 || malformed.length > 0) return null;
  const only = refs[0] as MergeRef;
  return only.start === 0 && only.raw.length + 2 === t.length ? only : null;
};
