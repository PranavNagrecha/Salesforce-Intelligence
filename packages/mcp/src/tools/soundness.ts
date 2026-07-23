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
import type { ComponentId, ComponentType, Node } from '@sf-intelligence/contracts';
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
   * membership). Extensible.
   */
  readonly kind: 'dynamic-apex' | 'unwalked-referrer-class';
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

/** True when a node carries the persisted `dynamic-apex` quality signal. */
const nodeHasDynamicApex = (node: Node): boolean => {
  const raw = (node.properties as Record<string, unknown>)['qualityIssues'];
  if (!Array.isArray(raw)) return false;
  return raw.some(
    (issue) =>
      issue !== null &&
      typeof issue === 'object' &&
      (issue as { rule?: unknown }).rule === 'dynamic-apex',
  );
};

/** Build the envelope from the dynamic-Apex class ids already identified. */
const fromDynamicIds = (dynamicIds: readonly ComponentId[]): Soundness => {
  if (dynamicIds.length === 0) {
    return { complete: true, blindSpots: [], staticCoverage: 'full' };
  }
  const componentIds = [...new Set(dynamicIds)].sort();
  return {
    complete: false,
    blindSpots: [{ kind: 'dynamic-apex', componentIds, note: DYNAMIC_APEX_NOTE }],
    staticCoverage: 'partial',
  };
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
  for (const node of nodes) {
    if (nodeHasDynamicApex(node)) dynamicIds.push(node.id);
  }
  return fromDynamicIds(dynamicIds);
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
  for (const id of new Set(ids)) {
    const res = await getNodeById(graph, id);
    if (res.ok && res.value !== null && nodeHasDynamicApex(res.value)) {
      dynamicIds.push(id);
    }
  }
  return fromDynamicIds(dynamicIds);
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
