/**
 * Data-key paths and near-miss suggestions.
 *
 * An OmniScript keeps one data JSON; every input is stored under its element
 * NAME, nested by container: `Step:Block:Input`, and inside a repeating
 * container (an Edit Block, a repeating Block) one row per entry. Merge
 * expressions, show rules, payload maps and DataMapper items all address that
 * JSON with `:`-separated paths, where `|n` means "the current row" and `|0`
 * (or `[0]`) a fixed row.
 *
 * Matching is RAW. A key with a stray space, or one underscore too many, is
 * exactly the defect the model reports — so paths are compared as written, row
 * markers aside, and near-misses are only ever SUGGESTED, never matched.
 */

/** One path segment: a raw name plus an optional row marker. */
export interface KeySegment {
  /** The name exactly as written (untrimmed). */
  readonly name: string;
  /** `current` for `|n`, a number for `|0` / `[0]`, else `none`. */
  readonly row: 'none' | 'current' | number;
}

/** A parsed key path. */
export interface KeyPath {
  /** Exactly as written. */
  readonly raw: string;
  readonly segments: readonly KeySegment[];
}

const ROW_SUFFIX = /^(.*?)(?:\|(n|\d+)|\[(\d+)\])$/s;

/** Parse a `:`-separated key path, keeping every name raw. */
export const parseKeyPath = (raw: string): KeyPath => {
  const segments: KeySegment[] = [];
  for (const part of raw.split(':')) {
    const m = ROW_SUFFIX.exec(part);
    if (m === null) {
      segments.push({ name: part, row: 'none' });
      continue;
    }
    const name = m[1] ?? '';
    const marker = m[2] ?? m[3] ?? '';
    segments.push({ name, row: marker === 'n' ? 'current' : Number(marker) });
  }
  return { raw, segments };
};

/** The path's names joined by `:` with row markers stripped — the MATCH form. */
export const matchForm = (path: KeyPath | readonly KeySegment[]): string =>
  ('segments' in path ? path.segments : path).map((s) => s.name).join(':');

/** Segment names with row markers stripped. */
export const segmentNames = (path: KeyPath): readonly string[] =>
  path.segments.map((s) => s.name);

/** True when the string starts or ends with whitespace. */
export const hasEdgeWhitespace = (s: string): boolean => s.length > 0 && s !== s.trim();

/** True when any segment of the path starts or ends with whitespace. */
export const pathHasEdgeWhitespace = (path: KeyPath): boolean =>
  path.segments.some((s) => hasEdgeWhitespace(s.name));

/** True when `prefix` (names) is a prefix of `path` (names). */
export const isPrefixOf = (prefix: readonly string[], path: readonly string[]): boolean => {
  if (prefix.length > path.length) return false;
  for (let i = 0; i < prefix.length; i += 1) if (prefix[i] !== path[i]) return false;
  return true;
};

/** True when `suffix` (names) ends `path` (names). */
export const isSuffixOf = (suffix: readonly string[], path: readonly string[]): boolean => {
  if (suffix.length > path.length) return false;
  const off = path.length - suffix.length;
  for (let i = 0; i < suffix.length; i += 1) if (suffix[i] !== path[off + i]) return false;
  return true;
};

/** Why one name is a near-miss of another. */
export type NearMissRule =
  | 'whitespace'
  | 'case'
  | 'underscore'
  | `prefixVariant ${string}⇄${string}`;

/** A near-miss candidate. */
export interface NearMiss {
  readonly candidate: string;
  readonly rule: NearMissRule;
}

/** Options for near-miss matching. */
export interface NearMissOptions {
  /** Org-specific prefix pairs that are easy to confuse, e.g. `[['A_B_', 'AB_']]`. */
  readonly prefixVariants?: readonly (readonly [string, string])[];
}

/** True when deleting exactly one `_` from `longer` yields `shorter`. */
const oneUnderscoreApart = (longer: string, shorter: string): boolean => {
  if (longer.length !== shorter.length + 1) return false;
  for (let i = 0; i < longer.length; i += 1) {
    if (longer[i] !== '_') continue;
    if (longer.slice(0, i) + longer.slice(i + 1) === shorter) return true;
  }
  return false;
};

/** The rule under which name `a` is a near-miss of `b`, or null. */
export const nearMissRule = (
  a: string,
  b: string,
  options: NearMissOptions = {},
): NearMissRule | null => {
  if (a === b) return null;
  if (a.trim() === b.trim()) return 'whitespace';
  for (const [x, y] of options.prefixVariants ?? []) {
    if (x.length === 0 || y.length === 0) continue;
    if (a.startsWith(x) && `${y}${a.slice(x.length)}` === b) return `prefixVariant ${x}⇄${y}`;
    if (a.startsWith(y) && `${x}${a.slice(y.length)}` === b) return `prefixVariant ${y}⇄${x}`;
  }
  if (a.toLowerCase() === b.toLowerCase()) return 'case';
  if (oneUnderscoreApart(a, b) || oneUnderscoreApart(b, a)) return 'underscore';
  return null;
};

/**
 * Near-miss suggestions for a `:`-path among candidate paths: a candidate
 * qualifies when it has the same number of segments, every segment but one is
 * identical, and that one segment is a near-miss under {@link nearMissRule}.
 * Output is sorted (candidate, rule) and de-duplicated.
 */
export const nearMisses = (
  target: string,
  candidates: Iterable<string>,
  options: NearMissOptions = {},
): readonly NearMiss[] => {
  const t = target.split(':');
  const out = new Map<string, NearMiss>();
  for (const candidate of candidates) {
    if (candidate === target) continue;
    const c = candidate.split(':');
    if (c.length !== t.length) continue;
    let diff = -1;
    let ok = true;
    for (let i = 0; i < t.length; i += 1) {
      if (t[i] === c[i]) continue;
      if (diff !== -1) {
        ok = false;
        break;
      }
      diff = i;
    }
    if (!ok || diff === -1) continue;
    const rule = nearMissRule(t[diff] as string, c[diff] as string, options);
    if (rule !== null) out.set(`${candidate}\u0000${rule}`, { candidate, rule });
  }
  return [...out.values()].sort((a, b) =>
    a.candidate !== b.candidate ? (a.candidate < b.candidate ? -1 : 1) : a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0,
  );
};
