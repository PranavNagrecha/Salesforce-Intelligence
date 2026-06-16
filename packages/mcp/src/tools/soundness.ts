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
 */
import type { ComponentId, Node } from '@sf-intelligence/contracts';
import { getNodeById, type GraphStore } from '@sf-intelligence/graph';

/** A named static-analysis blind spot affecting a result. */
export interface SoundnessBlindSpot {
  /** The blind-spot kind. Extensible; `dynamic-apex` is the data-backed one. */
  readonly kind: 'dynamic-apex';
  /** Canonical ids carrying the blind spot (e.g. the dynamic-Apex classes). */
  readonly componentIds: readonly ComponentId[];
  /** Why the result may be incomplete. */
  readonly note: string;
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
