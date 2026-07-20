/**
 * Handler for the `sfi.method_reachability` MCP tool.
 *
 * Answers "is this class reachable from an entry point — or is it
 * likely dead code?". Walks upstream `callsApex` edges from
 * `classApiName` and inspects each reached node for entry-point
 * classifiers:
 *
 *   - `ApexTrigger` (any) — triggers are themselves entry points.
 *   - `ApexClass` with `properties.isRestResource === true` — REST
 *     endpoint (`@RestResource`).
 *   - `ApexClass` with `properties.hasAuraEnabledMethod === true` —
 *     Lightning / Aura `@AuraEnabled` method.
 *   - `ApexClass` with `properties.hasInvocableMethod === true` —
 *     `@InvocableMethod` for Flow / Process Builder dispatch.
 *   - `ApexClass` with any of `properties.isQueueable` /
 *     `properties.isBatchable` / `properties.isSchedulable` — async
 *     dispatch entry points (the scheduler / queueable system calls
 *     them, not user Apex).
 *
 * A SEPARATE upstream walk over INCOMING `callsApex` edges checks
 * for ApexClass nodes with `properties.isTest === true` — test
 * coverage. The combined verdict:
 *
 *   - `entry-point-reachable`: at least one reached upstream is an
 *     entry point (per the classifier set above).
 *   - `test-only-reachable`: no entry point reaches it, but at least
 *     one test class does.
 *   - `likely-dead-code`: NEITHER an entry point NOR a test class
 *     reaches it within the depth cap.
 *
 * **v2.7 honesty boundary**: dynamic dispatch (`Type.forName(...)`)
 * and reflective invocation are invisible to the heuristic; a class
 * genuinely invoked at runtime via reflection will surface as
 * `likely-dead-code`. The disclosure surfaces this verbatim.
 *
 * Implementation notes:
 *   - One BFS walks upstream `callsApex` edges from the target,
 *     bounded by the v2.1 depth-3 cap. Visited set is global; cycles
 *     are detected automatically.
 *   - The walk visits each id at most once. Cycles do not loop.
 *   - The root itself is also checked for entry-point classifiers
 *     (a class can be both the input AND its own entry point).
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  getNodeById,
  listEdgesForNodes,
  listNodesByIds,
} from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { coercePrefix } from './coerce-id.js';
import { firstNonEmpty } from './input-aliases.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import { soundnessFromIds, type Soundness } from './soundness.js';

/** BFS depth cap. Matches `sfi.test_coverage_gaps`. */
const REACHABILITY_BFS_DEPTH = 3;

/** Canonical id prefixes the tool accepts. */
const APEX_CLASS_PREFIX = 'ApexClass:';
const APEX_TRIGGER_PREFIX = 'ApexTrigger:';

/** Verbatim v2.7 honesty disclosure. */
const REACHABILITY_DISCLOSURE =
  'v2.7 method_reachability ships CLASS granularity (method-level promised in v2.7.1). Dynamic dispatch (Type.forName) and reflective invocation are invisible — a class genuinely invoked at runtime via reflection or framework wiring will surface as likely-dead-code. Trigger framework base classes (TriggerHandler, fflib) may be partially invisible. BFS is capped at depth 3.';

/**
 * Entry-point kinds the upstream walk recognises. Each value
 * indicates "the class reaches at least one of these kinds at
 * runtime".
 */
export type EntryPointKind =
  | 'apex-trigger'
  | 'rest-resource'
  | 'aura-enabled'
  | 'invocable'
  | 'queueable'
  | 'batchable'
  | 'schedulable';

/** Reachability verdict. */
export type ReachabilityVerdict =
  | 'entry-point-reachable'
  | 'test-only-reachable'
  | 'likely-dead-code';

/**
 * Zod schema for the `sfi.method_reachability` tool input.
 *
 *   - `classApiName` / `componentId` / `apiName`: the target ApexClass /
 *     ApexTrigger, interchangeable (a host naturally reaches for `componentId`
 *     as on the sibling Apex tools) — METHOD-REACHABILITY-REJECTS-COMPONENTID.
 *     Each accepts a bare name or a canonical `ApexClass:` / `ApexTrigger:` id;
 *     non-matching prefixes surface as `invalid-query`. Disagreeing selectors →
 *     `invalid-query` (never a silent pick); at least one is required.
 */
export const methodReachabilityInputSchema = z.object({
  classApiName: z.string().min(1).optional(),
  componentId: z.string().min(1).optional(),
  apiName: z.string().min(1).optional(),
});

/** Parsed input shape. */
export type MethodReachabilityInput = z.infer<
  typeof methodReachabilityInputSchema
>;

/** The Apex id prefixes this tool accepts as a target. */
const APEX_TARGET_PREFIXES: readonly string[] = [
  APEX_CLASS_PREFIX,
  APEX_TRIGGER_PREFIX,
];

/**
 * Resolve the single target class / trigger from the interchangeable
 * `classApiName` / `componentId` / `apiName` selectors — the alias residual this
 * closes (a host naturally passes `componentId` as on the sibling Apex tools).
 * Each value is coerced through `coercePrefix` so a bare name, an `ApexClass:`
 * id, and an `ApexTrigger:` id all resolve while a WRONG-type prefix
 * (`CustomField:…`) still reaches the handler's precise `invalid-query`.
 * Disagreeing selectors → `invalid-query` (never a silent pick); none →
 * `invalid-query`.
 */
const resolveTargetId = (
  input: MethodReachabilityInput,
): Result<string, McpError> => {
  const distinct = [
    ...new Set(
      [input.classApiName, input.componentId, input.apiName]
        .map((v) => firstNonEmpty(v))
        .filter((v): v is string => v !== undefined)
        .map((v) => coercePrefix(v, APEX_TARGET_PREFIXES)),
    ),
  ];
  if (distinct.length === 0) {
    return err({
      kind: 'invalid-query',
      message:
        'name the Apex class — pass `classApiName` (e.g. "LegacyService"), `componentId` (`ApexClass:LegacyService`), or `apiName`',
      path: 'classApiName',
    });
  }
  if (distinct.length > 1) {
    return err({
      kind: 'invalid-query',
      message: `class selectors name different targets (${distinct.join(', ')}); pass exactly one of classApiName / componentId / apiName`,
      path: 'classApiName',
    });
  }
  return ok(distinct[0] as string);
};

/** One entry-point hit found in the upstream walk. */
export interface EntryPointHit {
  readonly id: ComponentId;
  readonly apiName: string;
  readonly kind: EntryPointKind;
  /** The shortest-path BFS depth at which the entry point was reached. */
  readonly depth: number;
}

/** One test class that reaches the target. */
export interface ReachingTestClass {
  readonly id: ComponentId;
  readonly apiName: string;
  readonly depth: number;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface MethodReachabilityOutput {
  /**
   * Echoes the class scope ACTUALLY resolved so a host that passed a
   * `componentId` / `apiName` alias sees it was honored, not silently rejected
   * (METHOD-REACHABILITY-REJECTS-COMPONENTID). Always `component` mode — the
   * tool is single-class by contract.
   */
  readonly appliedScope: {
    readonly component: ComponentId;
    readonly mode: 'component';
  };
  readonly classApiName: ComponentId;
  readonly verdict: ReachabilityVerdict;
  readonly entryPoints: readonly EntryPointHit[];
  readonly reachingTestClasses: readonly ReachingTestClass[];
  /** Static-analysis blind spots: `complete: false` when the analyzed class uses dynamic Apex. */
  readonly soundness: Soundness;
  readonly disclosure: string;
}

const isApexCallable = (id: string): boolean =>
  id.startsWith(APEX_CLASS_PREFIX) || id.startsWith(APEX_TRIGGER_PREFIX);

const isTestClass = (node: Node): boolean =>
  node.properties['isTest'] === true;

/**
 * Categorise a single node into the set of entry-point kinds it
 * exposes. A class with multiple classifiers (e.g., both REST and
 * Aura) emits multiple hit entries — one per kind — so the caller
 * can render the full surface.
 */
const entryKindsFor = (node: Node): readonly EntryPointKind[] => {
  const kinds: EntryPointKind[] = [];
  if (node.type === 'ApexTrigger') kinds.push('apex-trigger');
  if (node.properties['isRestResource'] === true) kinds.push('rest-resource');
  if (node.properties['hasAuraEnabledMethod'] === true)
    kinds.push('aura-enabled');
  if (node.properties['hasInvocableMethod'] === true) kinds.push('invocable');
  if (node.properties['isQueueable'] === true) kinds.push('queueable');
  if (node.properties['isBatchable'] === true) kinds.push('batchable');
  if (node.properties['isSchedulable'] === true) kinds.push('schedulable');
  return kinds;
};

/**
 * BFS upstream from `targetId` over INCOMING `callsApex` edges.
 * Returns the map of discovered id → depth (the shortest-path hop
 * count from the root).
 */
const upstreamWalk = async (
  ctx: Context,
  targetId: ComponentId,
  maxDepth: number,
): Promise<Result<Map<ComponentId, number>, string>> => {
  const discovered = new Map<ComponentId, number>();
  discovered.set(targetId, 0);
  let frontier: ComponentId[] = [targetId];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: ComponentId[] = [];
    // ONE batched fetch of the WHOLE frontier's INCOMING `callsApex` edges,
    // replacing the per-frontier-node `listEdges` N+1 (~frontier-width serial
    // DuckDB queries per hop). Iterating `frontier` in order and reading each
    // node's bucket (sorted by the FULL (to_id, edge_type, from_id, source)
    // order — the same order `listEdges` returned, and here to_id + edge_type
    // are fixed per bucket) reproduces the exact `discovered` insertion order
    // and next-frontier order. Query count is now one per DEPTH LEVEL,
    // independent of frontier WIDTH.
    const edgeBatch = await listEdgesForNodes(ctx.graph, frontier, {
      direction: 'in',
      edgeTypes: ['callsApex'],
    });
    if (!edgeBatch.ok) return err(edgeBatch.error.message);
    for (const id of frontier) {
      for (const edge of edgeBatch.value.get(id) ?? []) {
        if (discovered.has(edge.fromId)) continue;
        discovered.set(edge.fromId, depth + 1);
        next.push(edge.fromId);
      }
    }
    frontier = next;
  }
  return ok(discovered);
};

const compareEntryHits = (a: EntryPointHit, b: EntryPointHit): number => {
  if (a.depth !== b.depth) return a.depth - b.depth;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
};

const compareReachingTests = (
  a: ReachingTestClass,
  b: ReachingTestClass,
): number => {
  if (a.depth !== b.depth) return a.depth - b.depth;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * The `sfi.method_reachability` MCP tool. Walks upstream `callsApex`
 * from the root and returns the structured reachability verdict.
 *
 * @example
 *   const r = await methodReachabilityHandler(ctx, {
 *     classApiName: 'ApexClass:LegacyService',
 *   });
 *   if (r.ok) console.log(r.value.data.verdict);
 */
export const methodReachabilityHandler = async (
  ctx: Context,
  input: MethodReachabilityInput,
): Promise<Result<McpResponse<MethodReachabilityOutput>, McpError>> => {
  const scopeRes = resolveTargetId(input);
  if (!scopeRes.ok) return scopeRes;
  const classApiName = scopeRes.value;
  if (!isApexCallable(classApiName)) {
    return err({
      kind: 'invalid-query',
      message: `classApiName must be an ApexClass/ApexTrigger id (e.g. '${APEX_CLASS_PREFIX}Foo') or a bare class name (e.g. 'Foo'); got '${classApiName}'`,
      path: 'classApiName',
    });
  }
  const targetId = classApiName as ComponentId;

  const targetRes = await getNodeById(ctx.graph, targetId);
  if (!targetRes.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${targetRes.error.message}`,
    });
  }
  if (targetRes.value === null) {
    return err({
      kind: 'component-not-found',
      message: await phantomAwareNotFoundMessage(ctx, targetId, 'ApexClass or ApexTrigger'),
      path: targetId,
    });
  }

  const walkRes = await upstreamWalk(
    ctx,
    targetId,
    REACHABILITY_BFS_DEPTH,
  );
  if (!walkRes.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${walkRes.error}`,
    });
  }

  const entryPoints: EntryPointHit[] = [];
  const reachingTests: ReachingTestClass[] = [];

  // ONE batched `listNodesByIds` over every discovered id, replacing the
  // per-node `getNodeById` N+1 (~#discovered serial DuckDB queries). Ids with
  // no matching row are dropped by `listNodesByIds` exactly like the old
  // per-id null-skip (`node === null` → `continue`). Iterating `walkRes.value`
  // in its BFS insertion order and looking each node up by-id reproduces the
  // byte-identical `entryPoints` / `reachingTests` push order (both re-sorted
  // by the caller regardless).
  const nodesRes = await listNodesByIds(ctx.graph, [...walkRes.value.keys()]);
  if (!nodesRes.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodesRes.error.message}`,
    });
  }
  const nodeById = new Map(nodesRes.value.map((n) => [n.id, n]));

  for (const [id, depth] of walkRes.value) {
    const node = nodeById.get(id);
    if (node === undefined) continue;

    for (const kind of entryKindsFor(node)) {
      entryPoints.push({ id: node.id, apiName: node.apiName, kind, depth });
    }
    // Test classes reaching this target (excluding the root itself).
    if (id !== targetId && isTestClass(node)) {
      reachingTests.push({ id: node.id, apiName: node.apiName, depth });
    }
  }

  entryPoints.sort(compareEntryHits);
  reachingTests.sort(compareReachingTests);

  // Verdict cascade: entry point first, then test-only, then dead.
  // The root's own entry-point classifiers count — they were
  // emitted in the loop above at depth 0.
  let verdict: ReachabilityVerdict;
  if (entryPoints.length > 0) {
    verdict = 'entry-point-reachable';
  } else if (reachingTests.length > 0) {
    verdict = 'test-only-reachable';
  } else {
    verdict = 'likely-dead-code';
  }

  // Reachability of a method whose class uses dynamic Apex may be wrong (a
  // reflective caller is invisible) — surface that as a machine-readable blind spot.
  const soundness = await soundnessFromIds(ctx.graph, [targetId]);

  return ok({
    data: {
      appliedScope: { component: targetId, mode: 'component' },
      classApiName: targetId,
      verdict,
      entryPoints,
      reachingTestClasses: reachingTests,
      soundness,
      disclosure: REACHABILITY_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
