/**
 * ONE reader (and one merger) for the value a field-write edge carries.
 *
 * Extractors stamp `assignedValue` + `assignedValueKind` on `writesTo` edges
 * (Flow assignments / record updates, workflow and approval field updates,
 * DLRS rollups). The graph keys edges on `(fromId, toId, edgeType, source)`,
 * first writer wins — so when ONE component writes a field in several places
 * (an approval process setting Status to `Submitted` on submit and `Approved`
 * on final approval; a Flow writing `Open` in a create and `Closed` in an
 * update) every edge but the first used to vanish at import, and a tool asking
 * "what sets Status to Approved?" saw only the first value and called the
 * writer unable to set it. {@link mergeWriteValueEdges} folds every value of a
 * key into the edge that survives, so no value is lost whichever extractor
 * emitted the duplicates.
 *
 * Value kinds (`assignedValueKind`):
 *   - `literal`   — a static value (`assignedValue` holds it).
 *   - `reference` — a Flow variable / formula / field (`assignedValue` names it).
 *   - `formula`   — a workflow/approval Formula field update (`assignedValue` holds the formula).
 *   - `relative`  — a picklist NextValue / PreviousValue update (depends on the current value).
 *   - `null`      — a field update that blanks the field.
 *   - `rollup`    — a DLRS rollup (an aggregate of child rows).
 */

import type { Edge } from '@sf-intelligence/contracts';

/** Every literal a field edge writes or compares (assigned, filter, merged). */
export const edgeLiteralValues = (edge: Edge): readonly string[] => {
  const p = edge.properties;
  const out = new Set<string>();
  if (p['assignedValueKind'] === 'literal' && typeof p['assignedValue'] === 'string') {
    out.add(p['assignedValue']);
  }
  if (p['filterValueKind'] === 'literal' && typeof p['filterValue'] === 'string') {
    out.add(p['filterValue']);
  }
  const merged = p['literalValues'];
  if (Array.isArray(merged)) {
    for (const v of merged) if (typeof v === 'string') out.add(v);
  }
  return [...out];
};

/**
 * Every non-literal source a write edge assigns from: a Flow variable /
 * formula (`reference`) or a workflow formula (`formula`), plus every merged
 * `referenceValues` entry.
 */
export const edgeReferenceValues = (edge: Edge): readonly string[] => {
  const p = edge.properties;
  const out = new Set<string>();
  if (
    (p['assignedValueKind'] === 'reference' || p['assignedValueKind'] === 'formula') &&
    typeof p['assignedValue'] === 'string'
  ) {
    out.add(p['assignedValue']);
  }
  const merged = p['referenceValues'];
  if (Array.isArray(merged)) {
    for (const v of merged) if (typeof v === 'string') out.add(v);
  }
  return [...out];
};

/**
 * Every value kind a write edge carries: the merged `valueKinds` when present,
 * else its own `assignedValueKind`. Empty = the extractor stated no value.
 */
export const edgeValueKinds = (edge: Edge): readonly string[] => {
  const merged = edge.properties['valueKinds'];
  if (Array.isArray(merged)) return merged.filter((k): k is string => typeof k === 'string');
  const kind = edge.properties['assignedValueKind'];
  return typeof kind === 'string' ? [kind] : [];
};

const pushUnique = (list: string[], values: readonly string[]): void => {
  for (const v of values) if (!list.includes(v)) list.push(v);
};

/**
 * When a write edge's values are written relative to the save. `all` = a
 * time trigger writes them (later, not in the save); `partly` = the key folded
 * an in-the-save write AND a time-triggered one, and the two value lists say
 * which literal is written when; `none` = in the save (or timing not stated).
 */
export interface WriteValueTiming {
  readonly timeTriggered: 'all' | 'partly' | 'none';
  /** `partly` only: literals the time-triggered write(s) set. */
  readonly timeTriggeredValues: readonly string[];
  /** `partly` only: literals the in-the-save write(s) set. */
  readonly immediateValues: readonly string[];
}

const stringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export const edgeValueTiming = (edge: Edge): WriteValueTiming => {
  const p = edge.properties;
  if (p['partlyTimeTriggered'] === true) {
    return {
      timeTriggered: 'partly',
      timeTriggeredValues: stringList(p['timeTriggeredValues']),
      immediateValues: stringList(p['immediateValues']),
    };
  }
  return {
    timeTriggered: p['timeTriggered'] === true ? 'all' : 'none',
    timeTriggeredValues: [],
    immediateValues: [],
  };
};

/**
 * Fold every `writesTo` edge sharing a graph key into the FIRST one (the edge
 * the first-writer-wins import keeps): it gains `literalValues`,
 * `referenceValues` and `valueKinds` covering all of them, and — when the key
 * mixes an in-the-save write with a time-triggered one — `partlyTimeTriggered`
 * plus `timeTriggeredValues` / `immediateValues` (so a delayed value is never
 * reported as written in the save). Mutates `edges` in place (replaces the
 * first edge object); the later duplicates are left for the import to drop. A
 * key with one edge, or whose edges state no value and share one timing, is
 * untouched.
 */
export const mergeWriteValueEdges = (edges: Edge[]): void => {
  const groups = new Map<string, number[]>();
  for (let i = 0; i < edges.length; i += 1) {
    const e = edges[i] as Edge;
    if (e.edgeType !== 'writesTo') continue;
    const key = `${e.fromId}|${e.toId}|${e.edgeType}|${e.source}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [i]);
    else list.push(i);
  }
  for (const indices of groups.values()) {
    if (indices.length < 2) continue;
    const first = edges[indices[0] as number] as Edge;
    const literals: string[] = [];
    const references: string[] = [];
    const kinds: string[] = [];
    const timedLiterals: string[] = [];
    const immediateLiterals: string[] = [];
    let stated = false;
    let timed = 0;
    for (const i of indices) {
      const e = edges[i] as Edge;
      const own = edgeLiteralValues(e);
      pushUnique(literals, own);
      pushUnique(references, edgeReferenceValues(e));
      const k = edgeValueKinds(e);
      if (k.length > 0) stated = true;
      pushUnique(kinds, k.length > 0 ? k : ['unstated']);
      if (e.properties['timeTriggered'] === true) {
        timed += 1;
        pushUnique(timedLiterals, own);
      } else pushUnique(immediateLiterals, own);
    }
    const mixedTiming = timed > 0 && timed < indices.length;
    if (!stated && literals.length === 0 && references.length === 0 && !mixedTiming) continue;
    const ownLiterals = edgeLiteralValues(first);
    const ownReferences = edgeReferenceValues(first);
    const ownKinds = edgeValueKinds(first);
    const props: Record<string, unknown> = { ...first.properties };
    if (literals.length > ownLiterals.length) props['literalValues'] = literals;
    if (references.length > ownReferences.length) props['referenceValues'] = references;
    if (stated && (kinds.length > 1 || kinds[0] !== ownKinds[0])) props['valueKinds'] = kinds;
    if (mixedTiming) {
      delete props['timeTriggered'];
      props['partlyTimeTriggered'] = true;
      props['timeTriggeredValues'] = timedLiterals;
      props['immediateValues'] = immediateLiterals;
    }
    edges[indices[0] as number] = { ...first, properties: props };
  }
};

/**
 * {@link mergeWriteValueEdges}, then drop the later duplicates: one `writesTo`
 * per graph key, carrying every value. For an extractor that dedupes its own
 * output (one edge per rule → field) without losing a second value.
 */
export const foldWriteValueEdges = (edges: readonly Edge[]): Edge[] => {
  const copy = [...edges];
  mergeWriteValueEdges(copy);
  const seen = new Set<string>();
  return copy.filter((e) => {
    if (e.edgeType !== 'writesTo') return true;
    const key = `${e.fromId}|${e.toId}|${e.edgeType}|${e.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
