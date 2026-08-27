/**
 * P12-soundness-envelope — a uniform soundness block for static-analysis tools.
 *
 * Static dependency analysis is blind to references built at RUNTIME. The v2.1
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
 * graph-edge impact walk is blind to. Whole classes of REFERRERS to a
 * `CustomField` / `CustomObject` are structurally NOT modeled as incoming graph
 * edges, so an edge-walking analysis (`get_impact`) never sees them and must not
 * report `complete: true` / `staticCoverage: 'full'` on their absence:
 *   - ROLL-UP SOURCE COUPLING — a roll-up summary field's `summaryForeignKey`
 *     is stored as a field PROPERTY, no edge (`custom-field.ts`).
 *   - LAYOUT PLACEMENT — Layout sections / related-lists are not incoming edges
 *     onto the placed field (`layout.ts`).
 *   - FLOW DECISION/FILTER READS — a Flow decision or record-trigger filter that
 *     references a field becomes a `firesWhen` edge to a `ConditionalContext`
 *     (with the field on the context's `fieldRefs` PROPERTY), NEVER a `readsFrom`
 *     edge onto the field (`condition-extractor.ts`).
 *   - TAB/APP MEMBERSHIP — `CustomTab` / `CustomApplication` are not traversed.
 * `soundnessForImpactWalk` layers a named `unwalked-referrer-class` blind spot on
 * top of the dynamic-Apex one for field/object roots so "no referrers found" is
 * never presented as certainty.
 */
import type { ComponentId, ComponentType, EdgeType, Node } from '@sf-intelligence/contracts';
import { getNodeById, type GraphStore } from '@sf-intelligence/graph';

/**
 * The referrer classes that CAN reference a `CustomField` / `CustomObject` but
 * are NOT modeled as incoming graph edges — so an edge-walking impact analysis
 * is structurally blind to them. Named VERBATIM (D3-soundness-overclaim) in the
 * `unwalked-referrer-class` blind spot so a caller sees exactly what was not
 * walked. Order is fixed for determinism.
 */
export const UNWALKED_REFERRER_CLASSES = [
  'roll-up source coupling',
  'layout placement',
  'flow decision/filter reads',
  'tab/app membership',
] as const;

/** A named static-analysis blind spot affecting a result. */
export interface SoundnessBlindSpot {
  /**
   * The blind-spot kind. `dynamic-apex` is the runtime-reference blind spot
   * (data-backed by `properties.qualityIssues[]`); `unwalked-referrer-class` is
   * the STRUCTURAL blind spot for referrer classes not modeled as incoming
   * edges (roll-ups, layout placement, flow decision/filter reads, tab/app
   * membership); `unwalked-edge-type` is the STRUCTURAL blind spot for a
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
   * classes NOT walked (a subset of {@link UNWALKED_REFERRER_CLASSES}). Absent
   * for `dynamic-apex`.
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

const UNWALKED_REFERRER_NOTE =
  'This impact analysis follows only referrers modeled as incoming graph edges. Whole classes of ' +
  'referrer are NOT modeled as edges and were therefore NOT walked: roll-up source coupling (a ' +
  'roll-up summary field whose summaryForeignKey targets this component — stored as a field ' +
  'property, no edge), layout placement (Layout sections / related-lists are not incoming edges), ' +
  'flow decision/filter reads (a Flow decision or record-trigger filter referencing this field ' +
  'becomes a firesWhen edge to a ConditionalContext, never a readsFrom onto the field), and ' +
  'tab/app membership (CustomTab / CustomApplication are not traversed). Treat "no referrers ' +
  'found" as "these classes were not checked", NOT a proven "nothing references this".';

/**
 * The referrer classes structurally not walked for a given root type. Only
 * `CustomField` / `CustomObject` roots are subject to them (the four classes
 * reference fields/objects); every other root type returns `[]` (no false
 * disclosure on an Apex/Flow root).
 */
const unwalkedReferrerClassesFor = (
  rootType: ComponentType | null,
): readonly string[] =>
  rootType === 'CustomField' || rootType === 'CustomObject'
    ? UNWALKED_REFERRER_CLASSES
    : [];

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
 * top of the `dynamic-apex` one: when the root is a `CustomField` /
 * `CustomObject`, whole classes of referrer (roll-up source coupling, layout
 * placement, flow decision/filter reads, tab/app membership) are NOT modeled as
 * incoming graph edges, so the walk is BLIND to them. Reporting `complete: true`
 * / `staticCoverage: 'full'` on their absence is a false certainty — this
 * function downgrades to `complete: false` / `staticCoverage: 'partial'` and
 * names the un-walked classes verbatim in `referrerClasses`.
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
): Soundness => {
  const base = soundnessFromNodes(nodes);
  const referrerClasses = unwalkedReferrerClassesFor(rootType);
  if (referrerClasses.length === 0) return base;
  const referrerBlindSpot: SoundnessBlindSpot = {
    kind: 'unwalked-referrer-class',
    componentIds: [],
    note: UNWALKED_REFERRER_NOTE,
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
