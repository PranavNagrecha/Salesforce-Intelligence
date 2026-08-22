/**
 * ONE reachability primitive for the Apex family.
 *
 * `method_reachability`, `test_coverage_gaps`, and `call_graph` each walked
 * `edgeTypes: ['callsApex']` and each drew a conclusion from the absence of a
 * hit. `find_dead_code` — the fourth tool asking the same question — has always
 * defined usage as a DENY-list in SQL, and it is the one that gets the answer
 * right. This module lifts that definition out of the SQL so the four tools
 * cannot disagree about what "used" means.
 *
 * **D-1 — usage is a DENY-list, never an allow-list.** `['callsApex']` was
 * written before `dispatchesAsync` (v1.5) and before the Apex scanner's
 * `references` edge existed, and an allow-list cannot learn about an edge type
 * added after it. A deny-list is wrong-by-default in the SAFE direction — a new
 * edge type counts as usage until someone argues it should not — whereas an
 * allow-list is wrong-by-default in the direction that calls live code dead.
 * Do not reintroduce an allow-list here.
 *
 * **D-2 — confidence is per EDGE, never per edge type.** `references` is not
 * one thing: a Visualforce/Aura `controller=` binding IS a declaration
 * (`declared`), while a static-field or type-name scan is a regex guess
 * (`heuristic`). A blanket "references counts less" would demote the former to
 * match the latter and promote the latter to sit beside `callsApex`. The graph
 * already carries the correct answer per edge, so a path's confidence is the
 * WEAKEST `edge.confidence` along it, reported per hit.
 */

import type {
  ComponentId,
  ConfidenceLevel,
  Edge,
  EdgeType,
  Node,
} from '@sf-intelligence/contracts';
import { EDGE_TYPES } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { isHiddenUnresolved, listEdgesForNodes } from '@sf-intelligence/graph';

import type { Context } from '../server.js';

/**
 * Edge types that are NOT usage.
 *
 *   `parentOf`   structural containment, not a reference.
 *   `grantedBy`  a Profile / PermissionSet ACCESS grant. Access is not usage:
 *                a class nobody calls is dead even when profiles grant access
 *                to it.
 *
 * Kept in ONE place. `find_dead_code`'s CTE exclusion list is pinned equal to
 * this by a drift test — that test is what stops the next allow-list.
 */
export const NOT_USAGE_EDGE_TYPES = ['parentOf', 'grantedBy'] as const;

/**
 * D-1: usage = every `EdgeType` minus {@link NOT_USAGE_EDGE_TYPES}. DERIVED
 * from the contracts `EDGE_TYPES` tuple, never hand-copied — a hand-copied list
 * is the exact drift that produced this bug.
 */
export const USAGE_EDGE_TYPES: readonly EdgeType[] = EDGE_TYPES.filter(
  (t): t is EdgeType => !(NOT_USAGE_EDGE_TYPES as readonly string[]).includes(t),
);

/**
 * Entry-point kinds the upstream walk recognises.
 *
 * `test-class` and `ui-controller` are the two the family was missing.
 * `test-class` is not a new rule: `find_dead_code` already states it verbatim —
 * *"test classes (properties.isTest === true) are NEVER flagged as dead — they
 * ARE entry points for the test-runner"*. `ui-controller` is derived from the
 * IN-EDGE rather than a node property, because a Visualforce page's
 * `controller=` attribute is a declaration held by the page, not by the class.
 */
export type EntryPointKind =
  | 'apex-trigger'
  | 'rest-resource'
  | 'aura-enabled'
  | 'invocable'
  | 'queueable'
  | 'batchable'
  | 'schedulable'
  | 'test-class'
  | 'ui-controller'
  | 'framework-subclass'
  | 'callable-dispatch';

/**
 * DYNAMIC-REGISTRATION ENTRY POINTS — the blind spot that unifying the walk
 * amplified rather than removed.
 *
 * Measured on the FRESH vault: after the usage-set fix, 4 of 186 classes still
 * read `likely-dead-code`, and `find_dead_code` independently agreed at
 * `definitely_dead`. All four are live. Two extend a managed trigger-framework
 * base class and are registered ONLY as a string literal
 * (`hed.TDTM_Global_API.TdtmToken('<ClassName>', 'Contact', 'BeforeUpdate', 10.0)`);
 * two `implements Callable` and are dispatched from a Custom Metadata record via
 * a `$$Class.method$$` template. Neither shape produces an edge, and no refresh
 * would create one.
 *
 * Two tools agreeing on a wrong verdict is WORSE than two tools disagreeing:
 * disagreement is a signal a reader can act on, corroboration is one they trust.
 *
 * These two predicates are DECLARED facts about the class taken from node
 * properties — no cross-node scan, no extra query — so the same definition can
 * be evaluated in TypeScript here and in SQL inside `find_dead_code`'s CTE, and
 * a behavioural drift test pins the two to agree.
 *
 * They establish that a class is BUILT to be invoked from outside the vault.
 * They NEVER establish that the registration is live, so:
 *   - the entry-point hit is floored at `heuristic` confidence, never higher
 *   - `find_dead_code` maps them to `uncertain`, never to a live verdict
 * An unproven-but-named class is uncertain. It is not dead, and it is not
 * proven reachable.
 */
export const UNPROVEN_REGISTRATION_KINDS: readonly EntryPointKind[] = [
  'framework-subclass',
  'callable-dispatch',
];

/**
 * The Apex interface whose entire purpose is loosely-typed dynamic invocation
 * (`Object call(String action, Map<String, Object> args)`). A class implementing
 * it is declaring that something outside its own compilation unit will invoke it
 * by name — a managed package, a Flow, or a Custom Metadata-driven dispatcher.
 */
export const CALLABLE_INTERFACE = 'Callable';

/**
 * True when the class extends a base class from ANOTHER NAMESPACE — a managed
 * package (`hed.TDTM_Runnable`) or a platform namespace
 * (`VisualEditor.DynamicPickList`). The owner of that namespace instantiates the
 * subclass; local Apex never does, so no `callsApex` edge can exist.
 *
 * A dotted superclass is the whole signal, and it is deliberately general: it
 * fires for any framework that dispatches its own subclasses, not just the ones
 * this org happens to use.
 */
export const isFrameworkSubclass = (node: Node): boolean => {
  const superclass = node.properties['superclass'];
  return typeof superclass === 'string' && superclass.includes('.');
};

/** True when the class declares the `Callable` dynamic-invocation interface. */
export const isCallableDispatch = (node: Node): boolean => {
  const impl = node.properties['implements'];
  return Array.isArray(impl) && impl.includes(CALLABLE_INTERFACE);
};

/** Node types whose incoming `references` edge is a `controller=` binding. */
const UI_CONTROLLER_SOURCE_PREFIXES: readonly string[] = [
  'VisualforcePage:',
  'VisualforceComponent:',
  'VfComponent:',
  'AuraDefinitionBundle:',
];

/** True when a node carries the persisted `isTest` signal. */
export const isTestClassNode = (node: Node): boolean =>
  node.properties['isTest'] === true;

/**
 * The entry-point kinds a single node exposes, from NODE PROPERTIES alone.
 * A class with several classifiers emits several kinds so a caller can render
 * the full surface. `ui-controller` is NOT here — it is an edge-derived kind,
 * supplied separately by the walk.
 *
 * `isRoot` gates the `test-class` kind, and the gate is load-bearing.
 * `test-class` means "the TEST RUNNER is this component's entry point", which
 * is a statement about the component being ASKED ABOUT, never about something
 * upstream of it. `find_dead_code` draws exactly this line in SQL: the
 * candidate's OWN `is_test` exempts it from the dead cascade
 * (`if (row.is_test) continue;`), while a test REACHER is explicitly excluded
 * from entry-point reach (`NOT i.from_is_test AND i.from_is_entry`). Firing
 * `test-class` on a reached node instead would collapse the
 * `test-only-reachable` verdict into `entry-point-reachable` and lose the
 * distinction between "production reaches this" and "only a test does".
 */
export const entryKindsFor = (
  node: Node,
  opts: { readonly isRoot: boolean } = { isRoot: false },
): readonly EntryPointKind[] => {
  const kinds: EntryPointKind[] = [];
  if (node.type === 'ApexTrigger') kinds.push('apex-trigger');
  if (node.properties['isRestResource'] === true) kinds.push('rest-resource');
  if (node.properties['hasAuraEnabledMethod'] === true) kinds.push('aura-enabled');
  if (node.properties['hasInvocableMethod'] === true) kinds.push('invocable');
  if (node.properties['isQueueable'] === true) kinds.push('queueable');
  if (node.properties['isBatchable'] === true) kinds.push('batchable');
  if (node.properties['isSchedulable'] === true) kinds.push('schedulable');
  // The single change that stops 75 of this org's 85 `likely-dead-code`
  // verdicts being wrong: nothing CALLS a test class, the test runner does.
  if (opts.isRoot && isTestClassNode(node)) kinds.push('test-class');
  // The two UNPROVEN registration kinds. Unlike `test-class` these fire at ANY
  // depth: a framework-dispatched class that calls X really does make X
  // reachable, exactly as a trigger or a REST resource would.
  if (isFrameworkSubclass(node)) kinds.push('framework-subclass');
  if (isCallableDispatch(node)) kinds.push('callable-dispatch');
  return kinds;
};

/** True when every kind in `kinds` is an unproven dynamic registration. */
export const isUnprovenRegistrationKind = (kind: EntryPointKind): boolean =>
  UNPROVEN_REGISTRATION_KINDS.includes(kind);

/**
 * True when this incoming edge is a UI `controller=` binding — a
 * VisualforcePage / VisualforceComponent / AuraDefinitionBundle referencing the
 * class. Those bindings are `declared` in the graph because the markup names
 * the controller outright.
 */
export const isUiControllerEdge = (edge: Edge): boolean =>
  edge.edgeType === 'references' &&
  UI_CONTROLLER_SOURCE_PREFIXES.some((p) => edge.fromId.startsWith(p));

/** Confidence ordering, strongest first. The fold below takes the WEAKEST. */
const CONFIDENCE_RANK: Readonly<Record<ConfidenceLevel, number>> = {
  declared: 0,
  parsed: 1,
  heuristic: 2,
};

/** D-2: the weaker of two per-edge confidences. */
const weakerConfidence = (
  a: ConfidenceLevel,
  b: ConfidenceLevel,
): ConfidenceLevel => (CONFIDENCE_RANK[b] > CONFIDENCE_RANK[a] ? b : a);

/** One node reached by the upstream usage walk. */
export interface ReachHit {
  readonly id: ComponentId;
  readonly apiName: string | null;
  /** Shortest-path hop count from the root. The root itself is `0`. */
  readonly depth: number;
  /**
   * D-2: the WEAKEST `edge.confidence` along the shortest path to this hit.
   * `declared` on the root (no edge was traversed to reach it).
   */
  readonly confidence: ConfidenceLevel;
  /** The edge types traversed on that path, de-duplicated and sorted. */
  readonly viaEdgeTypes: readonly EdgeType[];
  /**
   * True when this hit was reached by a UI `controller=` binding — the
   * `ui-controller` entry-point kind is derived from this, not from a node
   * property.
   */
  readonly viaUiControllerBinding: boolean;
}

/** Options for {@link walkUpstreamUsage}. */
export interface WalkUpstreamUsageOptions {
  readonly maxDepth: number;
  /** Defaults to {@link USAGE_EDGE_TYPES}. Pass a subset to narrow the walk. */
  readonly edgeTypes?: readonly EdgeType[];
}

/**
 * BFS upstream from `rootId` over INCOMING usage edges.
 *
 * One batched `listEdgesForNodes` per DEPTH LEVEL, independent of frontier
 * WIDTH — iterating `frontier` in order and reading each node's bucket
 * reproduces the BFS insertion order exactly, which is what keeps the callers'
 * output ordering stable.
 *
 * Phantom `targetMissing` heuristic edges are skipped here rather than in each
 * caller, so a scanner-minted `ApexClass:{PascalCaseLocal}` can never enter an
 * `entryPoints` list. The visited-set guard is here too, so a `references`
 * cycle between two classes terminates.
 */
export const walkUpstreamUsage = async (
  ctx: Context,
  rootId: ComponentId,
  opts: WalkUpstreamUsageOptions,
): Promise<Result<Map<ComponentId, ReachHit>, string>> => {
  const edgeTypes = opts.edgeTypes ?? USAGE_EDGE_TYPES;
  const discovered = new Map<ComponentId, ReachHit>();
  discovered.set(rootId, {
    id: rootId,
    apiName: null,
    depth: 0,
    confidence: 'declared',
    viaEdgeTypes: [],
    viaUiControllerBinding: false,
  });
  let frontier: ComponentId[] = [rootId];
  for (let depth = 0; depth < opts.maxDepth && frontier.length > 0; depth += 1) {
    const next: ComponentId[] = [];
    const edgeBatch = await listEdgesForNodes(ctx.graph, frontier, {
      direction: 'in',
      edgeTypes,
    });
    if (!edgeBatch.ok) return err(edgeBatch.error.message);
    for (const id of frontier) {
      const from = discovered.get(id);
      if (from === undefined) continue;
      for (const edge of edgeBatch.value.get(id) ?? []) {
        // A `targetMissing` phantom resolves to no real node; following it
        // would put a fabricated id into a caller's entry-point list.
        if (isHiddenUnresolved(edge)) continue;
        if (discovered.has(edge.fromId)) continue;
        discovered.set(edge.fromId, {
          id: edge.fromId,
          apiName: null,
          depth: depth + 1,
          // D-2: the path is only as strong as its weakest hop.
          confidence: weakerConfidence(from.confidence, edge.confidence),
          viaEdgeTypes: [...new Set([...from.viaEdgeTypes, edge.edgeType])].sort(),
          viaUiControllerBinding: isUiControllerEdge(edge),
        });
        next.push(edge.fromId);
      }
    }
    frontier = next;
  }
  return ok(discovered);
};

/**
 * The usage in-edges of `rootId` that a walk over `walkedEdgeTypes` did NOT
 * traverse, as a total and a per-type breakdown. ONE query.
 *
 * This is the field that stops `edges: []` reading as "no callers" — it is a
 * CHECKED zero when the count is 0 and a named gap when it is not.
 */
export const countUnwalkedUsageInEdges = async (
  ctx: Context,
  rootId: ComponentId,
  walkedEdgeTypes: readonly EdgeType[],
): Promise<
  Result<{ count: number; byType: Readonly<Record<string, number>> }, string>
> => {
  const walked = new Set<EdgeType>(walkedEdgeTypes);
  const notWalked = USAGE_EDGE_TYPES.filter((t) => !walked.has(t));
  if (notWalked.length === 0) return ok({ count: 0, byType: {} });
  const res = await listEdgesForNodes(ctx.graph, [rootId], {
    direction: 'in',
    edgeTypes: notWalked,
  });
  if (!res.ok) return err(res.error.message);
  const byType: Record<string, number> = {};
  let count = 0;
  for (const edge of res.value.get(rootId) ?? []) {
    if (isHiddenUnresolved(edge)) continue;
    byType[edge.edgeType] = (byType[edge.edgeType] ?? 0) + 1;
    count += 1;
  }
  return ok({ count, byType });
};
