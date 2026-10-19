/**
 * P12-soundness-envelope — a uniform soundness block for static-analysis tools.
 *
 * Static dependency analysis is blind to references built at RUNTIME. The
 * `dynamic-apex` recognizer already flags the Apex classes/triggers that use
 * such constructs (dynamic SOQL, reflective describe, `Type.forName`, untyped
 * JSON) and persists the signal on each node's `properties.qualityIssues[]`.
 * This helper reads that persisted signal (NO runtime, NO re-scan) for the
 * components a finding touches and returns whether the result is COMPLETE or
 * carries a named blind spot — so an analysis tool never implies a completeness
 * it cannot have. `get_impact`, `find_dead_code`, `method_reachability`,
 * `governor_limit_risks`, and `test_coverage_for_method` all carry it.
 *
 * D3-soundness-overclaim — the `dynamic-apex` blind spot is NOT the only thing a
 * graph-edge impact walk is blind to. Some REFERRER KINDS of a root type are not
 * modeled as incoming graph edges on a given vault, so an edge-walking analysis
 * (`get_impact`) never sees them and must not report `complete: true` /
 * `staticCoverage: 'full'` on their absence. Which kinds, for which root type,
 * on which builder version, is decided ONCE in `referrer-coverage.ts`; this file
 * only reads that table. `soundnessForImpactWalk` layers a named
 * `unwalked-referrer-class` blind spot on top of the dynamic-Apex one so "no
 * referrers found" is never presented as certainty.
 */
import type { ComponentId, ComponentType, EdgeType, Node } from '@sf-intelligence/contracts';
import { getNodeById, type GraphStore } from '@sf-intelligence/graph';

import { verdictHedgingReferrerKinds } from './referrer-coverage.js';

/** A named static-analysis blind spot affecting a result. */
export interface SoundnessBlindSpot {
  /**
   * The blind-spot kind. `dynamic-apex` is the runtime-reference blind spot
   * (data-backed by `properties.qualityIssues[]`); `unwalked-referrer-class` is
   * the STRUCTURAL blind spot for referrer kinds not modeled as incoming
   * edges on this vault (from `referrer-coverage.ts`); `unwalked-edge-type` is the STRUCTURAL blind spot for a
   * reachability walk that traversed a strict SUBSET of the usage edge types,
   * so a component reachable only through an un-walked type is absent from the
   * result. Extensible.
   */
  readonly kind:
    | 'dynamic-apex'
    | 'quality-scan-not-run'
    | 'unwalked-referrer-class'
    | 'unwalked-edge-type';
  /**
   * Canonical ids carrying the blind spot (e.g. the dynamic-Apex classes).
   * EMPTY for `unwalked-referrer-class`: the blind spot is structural (no edge
   * was walked, so there are no specific ids to name) — `referrerClasses` names
   * the un-walked classes instead.
   */
  readonly componentIds: readonly ComponentId[];
  /** Why the result may be incomplete. */
  readonly note: string;
  /**
   * For `kind: 'unwalked-referrer-class'`: the VERBATIM names of the referrer
   * kinds NOT walked (from `unmodeledReferrerKinds`). Absent for `dynamic-apex`.
   */
  readonly referrerClasses?: readonly string[];
  /**
   * For `kind: 'unwalked-edge-type'`: the edge types the walk DID traverse.
   * Absent for the other kinds.
   */
  readonly walkedEdgeTypes?: readonly EdgeType[];
  /**
   * For `kind: 'unwalked-edge-type'`: the usage edge types the walk did NOT
   * traverse. A component reachable ONLY through one of these is absent from
   * the result. Absent for the other kinds.
   */
  readonly unwalkedEdgeTypes?: readonly EdgeType[];
}

/** Uniform soundness envelope returned by static-analysis tools. */
export interface Soundness {
  /** True only when no blind spot applies to the components in scope. */
  readonly complete: boolean;
  /** Named blind spots; empty when `complete`. */
  readonly blindSpots: readonly SoundnessBlindSpot[];
  /** `'full'` when complete, `'partial'` when a blind spot applies. */
  readonly staticCoverage: 'full' | 'partial';
}

const DYNAMIC_APEX_NOTE =
  'Uses dynamic Apex (dynamic SOQL / reflective describe / Type.forName / untyped JSON) — ' +
  'object, field, and type references built at runtime are invisible to static dependency ' +
  'analysis, so this result may be incomplete. Verify the flagged classes by reading the source.';

const QUALITY_SCAN_NOT_RUN_NOTE =
  'The code-quality recognizer never ran over these Apex components, so the dynamic-Apex signal ' +
  'is UNKNOWN for them rather than absent. A vault built before the recognizer shipped, or a ' +
  'refresh that did not retrieve this family, produces exactly this state. Their references may ' +
  'be built at runtime and invisible to static analysis; this result is NOT proof they are clean. ' +
  'Re-run `sfi refresh` to populate the signal.';

/**
 * The referrer kinds structurally not walked for a given root type on a vault
 * built by `builtBy`; `[]` when every applicable kind is an edge (no false
 * disclosure on an Apex/Flow root, nor on a field whose layout, roll-up and
 * condition referrers ARE edges).
 */
const unwalkedReferrerClassesFor = (
  rootType: ComponentType | null,
  root?: Node | null,
  builtBy?: string | null,
): readonly string[] =>
  // Generic kinds (reflection) are part of every tool's standing disclosure and
  // the `dynamic-apex` signal; only root-specific unmodeled kinds block `complete`.
  verdictHedgingReferrerKinds(rootType, root, builtBy);

/**
 * The blind-spot note, built from the shared referrer-coverage table (A04 /
 * A05 / C02 / C07) for whatever kinds apply to THIS root on THIS vault's
 * builder — never a fixed list, which is how "layout placement" stayed in the
 * note after `usedInLayout` edges existed.
 */
const referrerNoteFor = (rootType: ComponentType, kinds: readonly string[]): string =>
  `Not every way a ${rootType} can be referenced is modeled as a graph edge. Not walked here: ` +
  `${kinds.join('; ')}. Treat "no referrers found" for these kinds as "not checked", never ` +
  `as "nothing references this" — search the source (sfi.find_component_usages runs a text ` +
  `supplement) before changing or deleting it.`;

/**
 * The component types the code-quality recognizer family actually runs over.
 * Only these can be "not scanned" — a CustomField has no `qualityIssues` and
 * never should, so treating its absence as a gap would be noise, not honesty.
 */
const QUALITY_SCANNED_TYPES: ReadonlySet<ComponentType> = new Set([
  'ApexClass',
  'ApexTrigger',
] as const);

/**
 * Three states, not two. SOUNDNESS-UNSCANNED-READS-AS-CLEAN.
 *
 * The recognizer's contract is that `qualityIssues` is ALWAYS PRESENT on a
 * scanned node — `packages/extractors/src/apex-class.ts` states it: "the output
 * is always-present (empty array on the clean path) so consumers can filter by
 * `qualityIssues.length > 0` without threading an absent-vs-empty distinction."
 * Absence therefore means the scan did NOT RUN for that node, never that it ran
 * and found nothing.
 *
 * This read was `Array.isArray(raw) ? … : false`, which collapsed those two
 * into one answer, so a corpus the recognizer never touched produced
 * `complete: true` / `staticCoverage: 'full'` — in the module whose entire
 * stated purpose is that "an analysis tool never implies a completeness it
 * cannot have", and which backs `find_dead_code`, `method_reachability` and
 * `get_impact`: the tools consulted before deleting things.
 *
 * This is not hypothetical drift. The identical mistake already SHIPPED against
 * this same property: `QUALITY-SCAN-SKIPS-TRIGGERS` in
 * `packages/extractors/src/apex-trigger.ts` records that every ApexTrigger node
 * shipped without `qualityIssues`, so `sfi.crud_fls_audit` answered CLEAN for
 * triggers — "which is exactly where CRUD/FLS bugs live". That consumer was
 * fixed by making the extractor scan triggers. This consumer was not, and a
 * pre-recognizer vault reproduces it for every Apex node at once.
 */
type QualitySignal = 'dynamic-apex' | 'scanned-clean' | 'not-scanned';

const dynamicApexSignal = (node: Node): QualitySignal => {
  const raw = (node.properties as Record<string, unknown>)['qualityIssues'];
  if (!Array.isArray(raw)) {
    // Decided by whether the property is CARRIED AT ALL, never by its length —
    // the same law `absence-disclosure.ts` states for extracted families.
    return QUALITY_SCANNED_TYPES.has(node.type) ? 'not-scanned' : 'scanned-clean';
  }
  return raw.some(
    (issue) =>
      issue !== null &&
      typeof issue === 'object' &&
      (issue as { rule?: unknown }).rule === 'dynamic-apex',
  )
    ? 'dynamic-apex'
    : 'scanned-clean';
};

/**
 * Build the envelope from the ids already classified. `unscannedIds` are Apex
 * components carrying NO `qualityIssues` property: the recognizer did not run
 * for them, so their dynamic-Apex status is unknown and the result cannot be
 * called complete on their behalf.
 */
const fromDynamicIds = (
  dynamicIds: readonly ComponentId[],
  unscannedIds: readonly ComponentId[] = [],
): Soundness => {
  const blindSpots: SoundnessBlindSpot[] = [];
  if (dynamicIds.length > 0) {
    blindSpots.push({
      kind: 'dynamic-apex',
      componentIds: [...new Set(dynamicIds)].sort(),
      note: DYNAMIC_APEX_NOTE,
    });
  }
  if (unscannedIds.length > 0) {
    blindSpots.push({
      kind: 'quality-scan-not-run',
      componentIds: [...new Set(unscannedIds)].sort(),
      note: QUALITY_SCAN_NOT_RUN_NOTE,
    });
  }
  if (blindSpots.length === 0) {
    return { complete: true, blindSpots: [], staticCoverage: 'full' };
  }
  return { complete: false, blindSpots, staticCoverage: 'partial' };
};

/**
 * Build the envelope from class ids ALREADY KNOWN to carry the dynamic-Apex
 * signal (e.g. a tool that read `qualityIssues` itself while scanning, so it
 * need not re-fetch). Empty input → complete.
 */
export const soundnessFromDynamicApexIds = (dynamicIds: readonly ComponentId[]): Soundness =>
  fromDynamicIds(dynamicIds);

/**
 * Compute soundness from nodes already in hand (zero re-query). Pass the nodes
 * a result touches; any that carries the `dynamic-apex` signal becomes a
 * blind spot.
 */
export const soundnessFromNodes = (nodes: Iterable<Node>): Soundness => {
  const dynamicIds: ComponentId[] = [];
  const unscannedIds: ComponentId[] = [];
  for (const node of nodes) {
    const signal = dynamicApexSignal(node);
    if (signal === 'dynamic-apex') dynamicIds.push(node.id);
    else if (signal === 'not-scanned') unscannedIds.push(node.id);
  }
  return fromDynamicIds(dynamicIds, unscannedIds);
};

/**
 * Compute soundness for a set of component ids by fetching each node (used when
 * the tool holds ids, not full nodes). Unknown ids are ignored. Best-effort:
 * a fetch error for one id does not fail the whole envelope.
 */
export const soundnessFromIds = async (
  graph: GraphStore,
  ids: Iterable<ComponentId>,
): Promise<Soundness> => {
  const dynamicIds: ComponentId[] = [];
  const unscannedIds: ComponentId[] = [];
  for (const id of new Set(ids)) {
    const res = await getNodeById(graph, id);
    if (!res.ok || res.value === null) continue;
    const signal = dynamicApexSignal(res.value);
    if (signal === 'dynamic-apex') dynamicIds.push(id);
    else if (signal === 'not-scanned') unscannedIds.push(id);
  }
  return fromDynamicIds(dynamicIds, unscannedIds);
};

/**
 * D3-soundness-overclaim — soundness for an edge-walking IMPACT analysis
 * (`get_impact`). Layers the STRUCTURAL `unwalked-referrer-class` blind spot on
 * top of the `dynamic-apex` one: when the root type has referrer kinds that are
 * NOT modeled as incoming graph edges on this vault (a `CustomObject`'s layouts,
 * tabs, roll-ups and conditions; a pre-0.3.0 vault's field roll-ups and
 * conditions; a label's email-template references), the walk is BLIND to them.
 * Reporting `complete: true` / `staticCoverage: 'full'` on their absence is a
 * false certainty — this function downgrades to `complete: false` /
 * `staticCoverage: 'partial'` and names the un-walked kinds verbatim in
 * `referrerClasses`.
 *
 * `rootType` is the ComponentType of the impact root (derive from the id prefix
 * or the fetched node). A `null` root type — or any non field/object root —
 * yields the base `dynamic-apex`-only soundness UNCHANGED (byte-identical to
 * `soundnessFromNodes`), so Apex/Flow impact walks are not touched.
 *
 * Deterministic and offline: reads the same persisted signals `soundnessFromNodes`
 * reads, plus the root type; no runtime, no live org read. Never weakens a TRUE
 * positive — the dynamic-Apex blind spots (if any) are preserved and the
 * referrer blind spot is ADDED, never substituted.
 */
export const soundnessForImpactWalk = (
  nodes: Iterable<Node>,
  rootType: ComponentType | null,
  root?: Node | null,
  builtBy?: string | null,
): Soundness => {
  const base = soundnessFromNodes(nodes);
  const referrerClasses = unwalkedReferrerClassesFor(rootType, root, builtBy);
  if (referrerClasses.length === 0 || rootType === null) return base;
  const referrerBlindSpot: SoundnessBlindSpot = {
    kind: 'unwalked-referrer-class',
    componentIds: [],
    note: referrerNoteFor(rootType, referrerClasses),
    referrerClasses,
  };
  return {
    complete: false,
    blindSpots: [...base.blindSpots, referrerBlindSpot],
    staticCoverage: 'partial',
  };
};

/**
 * REACH-WALK-EDGE-TYPE-BLIND-SPOT — the note attached to an
 * `unwalked-edge-type` blind spot. Verbatim product copy; do not reword.
 */
export const UNWALKED_EDGE_TYPE_NOTE =
  'This walk traversed only the edge types named in walkedEdgeTypes. The usage edge types ' +
  'listed in unwalkedEdgeTypes were NOT traversed, so a component reachable ONLY through one ' +
  'of them is absent from this result. An empty result means "not found among the edge types ' +
  'walked", never "nothing reaches this".';

/**
 * Soundness for a REACHABILITY walk, where completeness is DERIVED from what the
 * walk actually traversed rather than read off an unrelated signal. Layers an
 * `unwalked-edge-type` blind spot on top of the `dynamic-apex` one whenever
 * `walkedEdgeTypes` is a strict subset of `usageEdgeTypes`.
 *
 * `usageEdgeTypes` is passed in rather than imported so this shared helper keeps
 * ZERO dependencies on any one tool module — callers pass the single
 * `USAGE_EDGE_TYPES` derivation from `apex-reachability.ts`, so the definition
 * still lives in exactly one place.
 *
 * When the walk covered the FULL usage set the envelope is byte-identical to
 * `soundnessFromNodes(nodes)` — this is not a permanent downgrade, it is a
 * downgrade exactly when one is warranted.
 */
export const soundnessForReachabilityWalk = (
  nodes: Iterable<Node>,
  walkedEdgeTypes: readonly EdgeType[],
  usageEdgeTypes: readonly EdgeType[],
): Soundness => {
  const base = soundnessFromNodes(nodes);
  const walked = new Set<EdgeType>(walkedEdgeTypes);
  const unwalkedEdgeTypes = usageEdgeTypes.filter((t) => !walked.has(t));
  if (unwalkedEdgeTypes.length === 0) return base;
  const blindSpot: SoundnessBlindSpot = {
    kind: 'unwalked-edge-type',
    componentIds: [],
    note: UNWALKED_EDGE_TYPE_NOTE,
    walkedEdgeTypes: [...walkedEdgeTypes],
    unwalkedEdgeTypes,
  };
  return {
    complete: false,
    blindSpots: [...base.blindSpots, blindSpot],
    staticCoverage: 'partial',
  };
};
