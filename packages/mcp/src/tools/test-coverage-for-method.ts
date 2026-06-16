/**
 * Handler for the `sfi.test_coverage_for_method` MCP tool.
 *
 * Answers the developer's "which test classes cover this Apex class?"
 * (or, when v2.7.1 ships, this method) question. Composes an upstream
 * BFS from `classApiName` over incoming `callsApex` AND
 * `dispatchesAsync` edges and filters the BFS-reached set to nodes with
 * `properties.isTest === true`.
 *
 * **Granularity (v2.7 honesty boundary, load-bearing)**: v2.7 ships
 * CLASS-level coverage. A class is "covered" when at least one test
 * class can reach it via incoming `callsApex` / `dispatchesAsync` edges
 * within the depth cap. The `methodName` input is ACCEPTED and echoed
 * verbatim into the response so callers can pipeline through a future
 * v2.7.1 method-scoped resolution — but v2.7 does NOT subset coverage
 * by method.
 *
 * **Composition model**:
 *   1. Validate the `ApexClass:` / `ApexTrigger:` prefix; reject
 *      other prefixes as `invalid-query`.
 *   2. `getNodeById` against the target — unknown surfaces as
 *      `component-not-found`.
 *   3. BFS upstream over incoming `callsApex` AND `dispatchesAsync`
 *      edges, bounded by the v2.1 depth-3 cap inherited from
 *      `sfi.test_coverage_gaps`. Following `dispatchesAsync` catches
 *      tests that exercise a batch/queueable/schedulable class via
 *      async dispatch (`Database.executeBatch(new XBatch())`), which
 *      links through `dispatchesAsync` rather than `callsApex`.
 *      A class genuinely tested via dynamic dispatch
 *      (`Type.forName('...').newInstance().method(...)`) is invisible
 *      to the heuristic — surfaced in the disclosure verbatim.
 *   4. Resolve each upstream node; emit those with
 *      `properties.isTest === true` as `coveringTestClasses[]`.
 *
 * Implementation notes:
 *   - The walk visits each id at most once. Cycles do not loop.
 *   - Test classes are SORTED by id ASC so the response is
 *     deterministic across runs.
 *   - When the target is itself a test class, the response carries
 *     an empty list and the disclosure (it can't "cover itself").
 */

import type {
  ComponentId,
  EdgeType,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { coercePrefix } from './coerce-id.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import { soundnessFromIds, type Soundness } from './soundness.js';

/**
 * BFS depth cap. Matches the v2.1 `sfi.test_coverage_gaps`
 * `MAX_COVERAGE_DEPTH` and the v0.3 `find_apex_usages` BFS budget.
 */
const COVERAGE_BFS_DEPTH = 3;

/**
 * Incoming edge types the upstream coverage walk follows. `callsApex`
 * is the direct invocation edge; `dispatchesAsync` captures async
 * dispatch (`Database.executeBatch(new XBatch())`,
 * `System.enqueueJob(new MyQueueable())`, `System.schedule(...)`),
 * which a test exercising a batch/queueable/schedulable class links
 * through INSTEAD of `callsApex`. Without it, batch-tested classes
 * surface as a false-negative "uncovered".
 */
const COVERAGE_EDGE_TYPES: readonly EdgeType[] = [
  'callsApex',
  'dispatchesAsync',
];

/** Canonical id prefixes the tool accepts. */
const APEX_CLASS_PREFIX = 'ApexClass:';
const APEX_TRIGGER_PREFIX = 'ApexTrigger:';

/**
 * Verbatim v2.7 honesty disclosure. Method-level granularity promised
 * for v2.7.1; dynamic dispatch is invisible to the heuristic.
 */
const COVERAGE_DISCLOSURE =
  'test_coverage_for_method ships CLASS granularity for a class-level query (no methodName). The upstream walk follows both callsApex and dispatchesAsync incoming edges, so coverage exercised via async dispatch (Database.executeBatch, System.enqueueJob, System.schedule) is included. Dynamic dispatch (Type.forName) and reflective invocation are still invisible. BFS is capped at depth 3; coverage chains longer than 3 hops surface as uncovered even when they exist.';

const COVERAGE_METHOD_DISCLOSURE =
  'methodName given: each covering test carries `exercisesMethod` (P4-test-reachability) — true when its shortest reaching path enters the target via a callsApex edge whose methods[] (P4-C5) includes methodName, i.e. it actually exercises the changed method, not just the class. This is heuristic and shortest-path: a test reaching the method only via a longer alternate path may read false, and dispatchesAsync hops carry no method index (treated as not-method-specific). methods[] populates only on vaults refreshed after P4-C5; older vaults fall back to the scalar methodName. The upstream walk still follows callsApex + dispatchesAsync; dynamic/reflective dispatch invisible; BFS capped at depth 3.';

/**
 * Zod schema for the `sfi.test_coverage_for_method` tool input.
 *
 *   - `classApiName`: required, non-empty string. The canonical
 *     ApexClass / ApexTrigger id; non-matching prefixes surface as
 *     `invalid-query` at the handler boundary.
 *   - `methodName`: optional. v2.7 echoes the value verbatim into the
 *     response; v2.7.1 will use it to subset coverage at the method
 *     edge level.
 */
export const testCoverageForMethodInputSchema = z.object({
  classApiName: z.string().min(1),
  methodName: z.string().min(1).optional(),
});

/** Parsed input shape. */
export type TestCoverageForMethodInput = z.infer<
  typeof testCoverageForMethodInputSchema
>;

/** One covering test class entry in the response. */
export interface CoveringTestClass {
  readonly id: ComponentId;
  readonly apiName: string;
  /** The shortest-path BFS depth at which this test class was reached. */
  readonly depth: number;
  /**
   * P4-test-reachability: present ONLY when `methodName` was supplied. `true`
   * when this test's shortest reaching path enters the target via a `callsApex`
   * edge whose `methods[]` (P4-C5) includes `methodName` — i.e. the test
   * actually exercises the CHANGED method, not merely the class. `false` means
   * it reaches the class but (on its shortest path) not via that method.
   */
  readonly exercisesMethod?: boolean;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface TestCoverageForMethodOutput {
  readonly classApiName: ComponentId;
  readonly methodName: string | null;
  readonly coveringTestClasses: readonly CoveringTestClass[];
  readonly totalCoveringCount: number;
  /**
   * P4-test-reachability: count of covering tests with `exercisesMethod === true`.
   * `null` when no `methodName` was supplied (class-level query).
   */
  readonly methodCoveringCount: number | null;
  /** Static-analysis blind spots: `complete: false` when the analyzed class uses dynamic Apex. */
  readonly soundness: Soundness;
  readonly disclosure: string;
}

const isApexCallable = (id: string): boolean =>
  id.startsWith(APEX_CLASS_PREFIX) || id.startsWith(APEX_TRIGGER_PREFIX);

const isTestClass = (node: Node): boolean =>
  node.properties['isTest'] === true;

/**
 * Whether a `callsApex` edge invokes `methodName` on its target (P4-C5).
 * Prefers the complete `methods[]`; falls back to the scalar `methodName` for
 * pre-P4-C5 vaults. `dispatchesAsync` edges carry no method index → false.
 */
const edgeCallsMethod = (
  edge: { readonly edgeType: EdgeType; readonly properties: Readonly<Record<string, unknown>> },
  methodName: string,
): boolean => {
  if (edge.edgeType !== 'callsApex') return false;
  const methods = edge.properties['methods'];
  if (Array.isArray(methods)) return methods.includes(methodName);
  const scalar = edge.properties['methodName'];
  return typeof scalar === 'string' && scalar === methodName;
};

/**
 * BFS upstream from `targetId` over INCOMING coverage edges (both
 * `callsApex` and `dispatchesAsync` — see `COVERAGE_EDGE_TYPES`).
 * Returns the depth at which each upstream id was first discovered. The
 * walk visits each id at most once; the dedupe is edge-type-agnostic,
 * so a node reachable via both edge types is recorded once at its
 * first-discovered (shortest) depth.
 */
const upstreamWalk = async (
  ctx: Context,
  targetId: ComponentId,
  maxDepth: number,
  methodName: string | undefined,
): Promise<Result<Map<ComponentId, { depth: number; exercisesMethod: boolean }>, string>> => {
  const discovered = new Map<ComponentId, { depth: number; exercisesMethod: boolean }>();
  let frontier: { id: ComponentId; exercisesMethod: boolean }[] = [
    { id: targetId, exercisesMethod: false },
  ];
  const visited = new Set<ComponentId>([targetId]);
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: { id: ComponentId; exercisesMethod: boolean }[] = [];
    for (const { id, exercisesMethod: parentExercises } of frontier) {
      for (const edgeType of COVERAGE_EDGE_TYPES) {
        const r = await listEdges(ctx.graph, id, {
          direction: 'in',
          edgeType,
        });
        if (!r.ok) return err(r.error.message);
        for (const edge of r.value) {
          // The edge into the TARGET (depth 1) decides method exercise via its
          // methods[]; deeper nodes inherit (their path to target passes through
          // that method-calling edge). No methodName → flag is irrelevant.
          const edgeExercises =
            methodName === undefined
              ? false
              : id === targetId
                ? edgeCallsMethod(edge, methodName)
                : parentExercises;
          if (visited.has(edge.fromId)) {
            // A node reachable via BOTH a method-exercising and a non-exercising
            // path should report `true` — upgrade in place (no re-queue).
            const rec = discovered.get(edge.fromId);
            if (rec !== undefined && edgeExercises && !rec.exercisesMethod) {
              discovered.set(edge.fromId, { depth: rec.depth, exercisesMethod: true });
            }
            continue;
          }
          visited.add(edge.fromId);
          discovered.set(edge.fromId, { depth: depth + 1, exercisesMethod: edgeExercises });
          next.push({ id: edge.fromId, exercisesMethod: edgeExercises });
        }
      }
    }
    frontier = next;
  }
  return ok(discovered);
};

/**
 * The `sfi.test_coverage_for_method` MCP tool. Returns the list of
 * test classes that cover the target class (or method, in v2.7.1) via
 * upstream `callsApex` walks.
 *
 * @example
 *   const r = await testCoverageForMethodHandler(ctx, {
 *     classApiName: 'ApexClass:OrderService',
 *   });
 *   if (r.ok) console.log(r.value.data.totalCoveringCount);
 */
export const testCoverageForMethodHandler = async (
  ctx: Context,
  input: TestCoverageForMethodInput,
): Promise<Result<McpResponse<TestCoverageForMethodOutput>, McpError>> => {
  const classApiName = coercePrefix(input.classApiName, [
    APEX_CLASS_PREFIX,
    APEX_TRIGGER_PREFIX,
  ]);
  if (!isApexCallable(classApiName)) {
    return err({
      kind: 'invalid-query',
      message: `classApiName must be an ApexClass/ApexTrigger id (e.g. '${APEX_CLASS_PREFIX}Foo') or a bare class name (e.g. 'Foo'); got '${input.classApiName}'`,
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
    COVERAGE_BFS_DEPTH,
    input.methodName,
  );
  if (!walkRes.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${walkRes.error}`,
    });
  }

  const hasMethod = input.methodName !== undefined;
  const covering: CoveringTestClass[] = [];
  for (const [id, { depth, exercisesMethod }] of walkRes.value) {
    const r = await getNodeById(ctx.graph, id);
    if (!r.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${r.error.message}`,
      });
    }
    const node = r.value;
    if (node === null) continue;
    if (!isTestClass(node)) continue;
    covering.push({
      id: node.id,
      apiName: node.apiName,
      depth,
      ...(hasMethod ? { exercisesMethod } : {}),
    });
  }

  // Sort by id ASC for determinism.
  covering.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // If the covered class uses dynamic Apex, the mapping of tests → method may be
  // incomplete (reflective invocation is invisible) — flag it, never imply full.
  const soundness = await soundnessFromIds(ctx.graph, [targetId]);

  return ok({
    data: {
      classApiName: targetId,
      methodName: input.methodName ?? null,
      coveringTestClasses: covering,
      totalCoveringCount: covering.length,
      methodCoveringCount: hasMethod
        ? covering.filter((c) => c.exercisesMethod === true).length
        : null,
      soundness,
      disclosure: hasMethod ? COVERAGE_METHOD_DISCLOSURE : COVERAGE_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
