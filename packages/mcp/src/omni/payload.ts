import { omnistudio } from '@sf-intelligence/extractors';

/**
 * A payload map — an OmniScript action's `extraPayload`, an Edit Block's
 * `saveIPExtraPayload` / `deleteIPExtraPayload`, an IP step's
 * `additionalInput`, a Set Values `elementValueMap` — classified entry by
 * entry. The classification decides whether a traced answer SURVIVES the hop:
 *
 *   - move     — the value is exactly one `%path%`: whatever lives at `path`
 *                (a key, or a whole container and everything in it) now also
 *                lives at the entry's key.
 *   - derived  — the value mixes merge fields with text or a formula: the
 *                entry carries something computed FROM those keys.
 *   - literal  — a constant (`"step": "2"`) — no key flows, but the constant is
 *                known, so conditions over it can be evaluated.
 *   - other    — a non-string value (object, number, boolean), kept as-is.
 */
export type PayloadEntryKind = 'move' | 'derived' | 'literal' | 'other';

/** One classified payload entry. */
export interface PayloadEntry {
  /** The receiving key exactly as written (a stray space is a defect). */
  readonly key: string;
  readonly kind: PayloadEntryKind;
  /** The raw value. */
  readonly value: unknown;
  /** For `move`: the path whose value moves. */
  readonly from: omnistudio.KeyPath | null;
  /** Every `%path%` the value reads. */
  readonly refs: readonly omnistudio.MergeRef[];
  /** Malformed merge openers in the value. */
  readonly malformed: readonly omnistudio.MalformedMerge[];
}

/** Classify every entry of a payload map (keys visited in sorted order). */
export const classifyPayload = (map: unknown): readonly PayloadEntry[] => {
  if (typeof map !== 'object' || map === null || Array.isArray(map)) return [];
  const out: PayloadEntry[] = [];
  for (const key of Object.keys(map).sort()) {
    const value = (map as Record<string, unknown>)[key];
    if (typeof value !== 'string') {
      out.push({ key, kind: 'other', value, from: null, refs: [], malformed: [] });
      continue;
    }
    const { refs, malformed } = omnistudio.scanPercentRefs(value);
    const sole = omnistudio.soleMergeRef(value);
    if (sole !== null) {
      out.push({ key, kind: 'move', value, from: sole.path, refs, malformed });
    } else if (refs.length > 0 || malformed.length > 0) {
      out.push({ key, kind: 'derived', value, from: null, refs, malformed });
    } else {
      out.push({ key, kind: 'literal', value, from: null, refs, malformed });
    }
  }
  return out;
};

/**
 * A path rewrite: values under `from` (names, row markers stripped) appear
 * under `to`. A chain of these maps a screen key to the key a mapper reads.
 */
export interface PrefixRule {
  readonly from: readonly string[];
  readonly to: readonly string[];
}

/** Apply prefix rules to a path; one result per matching rule. */
export const applyPrefixRules = (
  rules: readonly PrefixRule[],
  path: readonly string[],
): readonly (readonly string[])[] => {
  const out: string[][] = [];
  for (const r of rules) {
    if (omnistudio.isPrefixOf(r.from, path)) out.push([...r.to, ...path.slice(r.from.length)]);
  }
  return out;
};

/** Invert prefix rules (map a downstream path back upstream). */
export const invertPrefixRules = (rules: readonly PrefixRule[]): readonly PrefixRule[] =>
  rules.map((r) => ({ from: r.to, to: r.from }));
