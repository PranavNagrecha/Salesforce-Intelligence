/**
 * Handler for the `sfi.method_reachability` MCP tool.
 *
 * Answers "is this class reachable from an entry point — or is it
 * likely dead code?". Walks upstream USAGE edges from `classApiName`
 * (every edge type except `parentOf` and `grantedBy` — see
 * `apex-reachability.ts` D-1; `callsApex` alone could never learn about
 * `dispatchesAsync` or the Apex scanner's `references`) and inspects each
 * reached node for entry-point classifiers:
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
 *   - the ROOT itself with `properties.isTest === true` — the TEST RUNNER is
 *     its entry point. Nothing calls a test class, which is why the
 *     `callsApex`-only walk read almost every test class as dead code.
 *     `find_dead_code` has always said so verbatim. This fires at depth 0
 *     ONLY: a test class UPSTREAM of the root is coverage, not an entry
 *     point, and stays in `reachingTestClasses` so `test-only-reachable`
 *     survives.
 *   - a class reached by a `references` edge from a VisualforcePage /
 *     VisualforceComponent / AuraDefinitionBundle — the `controller=`
 *     binding, an edge-derived kind rather than a node property.
 *   - `ApexClass` with `properties.superclass` containing a `.` (a base class
 *     from another namespace) — a managed-package or platform framework that
 *     owns the base class instantiates the subclass outside this vault, so the
 *     subclass is built to be invoked from outside.
 *   - `ApexClass` with `properties.implements` including `Callable` — the
 *     loosely-typed dynamic-invocation interface, a signal that the class is
 *     built for dynamic dispatch from outside this vault's metadata.
 *
 * The same walk classifies reached ApexClass nodes with
 * `properties.isTest === true` as test coverage. The combined verdict:
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
 * `likely-dead-code` UNLESS it matches a dynamic-registration classifier
 * (framework-subclass, namespaced-interface, or callable-dispatch). A class
 * that extends a base-class from another namespace is presumed live, not
 * dead. The
 * disclosure surfaces the blind spot for everything else verbatim.
 *
 * Implementation notes:
 *   - One BFS walks upstream USAGE edges from the target, bounded by
 *     the v2.1 depth-3 cap. Visited set is global; cycles are detected
 *     automatically.
 *   - The walk visits each id at most once. Cycles do not loop.
 *   - The root itself is also checked for entry-point classifiers
 *     (a class can be both the input AND its own entry point).
 */

import type {
  ComponentId,
  ConfidenceLevel,
  EdgeType,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listNodesByIds } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  entryKindsFor,
  isTestClassNode,
  isUnprovenRegistrationKind,
  UNPROVEN_REGISTRATION_DISCLOSURE,
  USAGE_EDGE_TYPES,
  walkUpstreamUsage,
  type EntryPointKind,
} from './apex-reachability.js';
import { coercePrefix } from './coerce-id.js';
import { firstNonEmpty } from './input-aliases.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import { soundnessForReachabilityWalk, type Soundness } from './soundness.js';

/** BFS depth cap. Matches `sfi.test_coverage_gaps`. */
const REACHABILITY_BFS_DEPTH = 3;

/** Canonical id prefixes the tool accepts. */
const APEX_CLASS_PREFIX = 'ApexClass:';
const APEX_TRIGGER_PREFIX = 'ApexTrigger:';

/** Verbatim v2.7 honesty disclosure. */
const REACHABILITY_DISCLOSURE =
  'v2.7 method_reachability ships CLASS granularity (method-level promised in v2.7.1). Dynamic dispatch (Type.forName) and reflective invocation are invisible — a class genuinely invoked at runtime via reflection or framework wiring will surface as likely-dead-code. Trigger framework base classes (TriggerHandler, fflib) may be partially invisible. BFS is capped at depth 3.';

/**
 * Attached ONLY to a residual `likely-dead-code` verdict. This tool walks graph
 * edges; `find_dead_code` additionally greps production source for static-field
 * and type-name usages that are never modelled as an inbound edge, and
 * downgrades what it finds. Verbatim product copy; do not reword.
 */
const ALL_ENTRY_POINTS_UNPROVEN_DISCLOSURE =
  'Every entry point found here is an UNPROVEN dynamic registration. ' +
  UNPROVEN_REGISTRATION_DISCLOSURE;

/**
 * Cap on the PUBLISHED `depthCapBoundaryIds` list. The DETECTION is uncapped —
 * `depthCapBoundaryCount` always carries the true size of the residual
 * frontier — but the list itself must not be, or an honesty field would eat
 * the answer it exists to qualify: measured on a 300-wide frontier, an
 * unbounded id list plus its unbounded prose echo put `data` at ~33.8 KB
 * against the 45 000-byte hard ceiling `response-budget.ts` publishes as
 * `MAX_RESPONSE_BYTES`, where the global reducer is free to drop the
 * `verdict` and `entryPoints` this tool exists to report. Same truncated-list-plus-true-total shape as `sfi.synthesize_answer`
 * (`citations` / `citationsTotal` / `citationsTruncated`), and the same reason
 * `sfi.downstream_effects` publishes `unexploredClassCount` rather than the
 * ids.
 */
const MAX_DEPTH_CAP_BOUNDARY_IDS = 20;

/** How many boundary ids the PROSE disclosure names inline. */
const DEPTH_CAP_PROSE_EXAMPLES = 3;

/**
 * R1 (depth axis) — attached whenever the BFS hit `REACHABILITY_BFS_DEPTH`
 * with its frontier still non-empty. `walkUpstreamUsage` exits its loop on
 * `depth < opts.maxDepth`, so a node discovered exactly AT the cap is left
 * with its own upstream callers never queried — the walk cannot tell whether
 * an entry point sits one hop past it. This is the depth-axis twin of
 * `walkedEdgeTypes` (line ~248): that field lets an empty `entryPoints` read
 * as "checked these edge types and found none" instead of an unbounded
 * absence claim; `depthTruncated` / `depthCapBoundaryCount` do the same for
 * the DEPTH the walk actually reached, so a walk that exhausted the graph and
 * a walk that was cut off mid-frontier are no longer byte-identical.
 *
 * The prose leads with the COUNT and names at most
 * {@link DEPTH_CAP_PROSE_EXAMPLES} ids: a boundary is unbounded in width, and
 * a disclosure that grows with it is a payload bug wearing an honesty label.
 */
const depthCapDisclosure = (
  boundaryCount: number,
  publishedIds: readonly ComponentId[],
): string => {
  const examples = publishedIds.slice(0, DEPTH_CAP_PROSE_EXAMPLES);
  const listNote =
    boundaryCount > publishedIds.length
      ? `\`depthCapBoundaryIds\` lists the first ${publishedIds.length} in id order; ` +
        '`depthCapBoundaryCount` is the true total'
      : '`depthCapBoundaryIds` lists all of them';
  return (
    `This walk hit the depth-${REACHABILITY_BFS_DEPTH} cap while its frontier was still ` +
    `non-empty: ${boundaryCount} node(s) were discovered at the boundary and their own ` +
    `upstream callers were never queried (e.g. ${examples.join(', ')}; ${listNote}). An entry ` +
    `point or test class beyond depth ${REACHABILITY_BFS_DEPTH} would not appear in this ` +
    'response. This is DIFFERENT from a walk whose frontier ran out on its own before the cap.'
  );
};

const LIKELY_DEAD_CODE_CROSS_REFERENCE =
  'likely-dead-code here means NO usage in-edge and NO entry-point classifier within depth 3. ' +
  'It is NOT the org\'s dead-code verdict: sfi.find_dead_code runs an additional whole-word ' +
  'source grep for static-field and type-name references that are never modelled as an inbound ' +
  'edge, and downgrades a class it finds to uncertain. Run sfi.find_dead_code on this class ' +
  'before treating it as dead.';

/**
 * Entry-point kinds the upstream walk recognises. Each value indicates "the
 * class reaches at least one of these kinds at runtime". Defined ONCE in
 * `apex-reachability.ts` and re-exported here for the tools that imported it
 * from this module.
 */
export type { EntryPointKind };

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
  /**
   * D-2: the WEAKEST per-edge confidence along the shortest path to this hit.
   * `declared` at depth 0 (no edge was traversed). A `declared` Visualforce
   * `controller=` binding and a `heuristic` type-name scan are BOTH `references`
   * edges and must not be conflated — this is the field that separates them.
   */
  readonly confidence: ConfidenceLevel;
  /** The edge types traversed on that path, de-duplicated and sorted. */
  readonly viaEdgeTypes: readonly EdgeType[];
}

/** One test class that reaches the target. */
export interface ReachingTestClass {
  readonly id: ComponentId;
  readonly apiName: string;
  readonly depth: number;
  /** D-2: the weakest per-edge confidence along the path from this test class. */
  readonly confidence: ConfidenceLevel;
  /** The edge types traversed on that path, de-duplicated and sorted. */
  readonly viaEdgeTypes: readonly EdgeType[];
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
  /**
   * The edge types this walk actually traversed. Emitted on EVERY response, so
   * an empty `entryPoints` is readable as "checked these types and found none"
   * rather than an unbounded absence claim.
   */
  readonly walkedEdgeTypes: readonly EdgeType[];
  /**
   * R1 (depth axis): true when the BFS hit `REACHABILITY_BFS_DEPTH` with one
   * or more nodes discovered exactly at the cap whose own upstream callers
   * were never queried. False when the walk's frontier emptied on its own
   * before reaching the cap — nothing was left unexplored. Emitted on EVERY
   * response, the same way `walkedEdgeTypes` is, so a `likely-dead-code`
   * verdict from a walk that ran out of graph is distinguishable from one
   * that was cut off mid-frontier.
   *
   * Named for `sfi.downstream_effects`'s `depthTruncated`, which is this same
   * rule on the outgoing axis — one name for one rule, not a third spelling.
   */
  readonly depthTruncated: boolean;
  /**
   * How many nodes sat at the cap unexpanded — the TRUE size of the residual
   * frontier, never a length of the list below. 0 when `depthTruncated` is
   * false. The `unexploredClassCount` of this tool.
   */
  readonly depthCapBoundaryCount: number;
  /**
   * A capped prefix (id order) of the boundary ids, at most
   * {@link MAX_DEPTH_CAP_BOUNDARY_IDS}. Empty when `depthTruncated` is false.
   * Read the COUNT for the size of the frontier: a short list here is a
   * publishing cap, NOT evidence that the frontier was small.
   */
  readonly depthCapBoundaryIds: readonly ComponentId[];
  /**
   * Static-analysis blind spots. `complete: false` when a class on a reach path
   * uses dynamic Apex, or when the walk covered less than the full usage set.
   */
  readonly soundness: Soundness;
  readonly disclosure: string;
}

const isApexCallable = (id: string): boolean =>
  id.startsWith(APEX_CLASS_PREFIX) || id.startsWith(APEX_TRIGGER_PREFIX);

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

  const walkRes = await walkUpstreamUsage(ctx, targetId, {
    maxDepth: REACHABILITY_BFS_DEPTH,
    edgeTypes: USAGE_EDGE_TYPES,
  });
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

  for (const [id, hit] of walkRes.value) {
    const node = nodeById.get(id);
    if (node === undefined) continue;
    const { depth, confidence, viaEdgeTypes } = hit;

    const kinds: EntryPointKind[] = [...entryKindsFor(node, { isRoot: id === targetId })];
    // `ui-controller` is derived from the IN-EDGE (a VisualforcePage /
    // VisualforceComponent / Aura bundle whose markup names this class as its
    // `controller=`), not from any node property, so the walk supplies it.
    if (hit.viaUiControllerBinding) kinds.push('ui-controller');
    for (const kind of kinds) {
      entryPoints.push({
        id: node.id,
        apiName: node.apiName,
        kind,
        depth,
        // An unproven dynamic registration is a PATTERN MATCH on a declared
        // property, never a modelled call, so its hit is floored at the weakest
        // tier no matter how strong the edges leading to it were. Reporting a
        // string-literal framework registration at `declared` would be the same
        // overclaim as rating a regex guess beside a real call.
        confidence: isUnprovenRegistrationKind(kind) ? 'heuristic' : confidence,
        viaEdgeTypes,
      });
    }
    // Test classes reaching this target (excluding the root itself, so a test
    // class never lists itself as its own coverage).
    if (id !== targetId && isTestClassNode(node)) {
      reachingTests.push({
        id: node.id,
        apiName: node.apiName,
        depth,
        confidence,
        viaEdgeTypes,
      });
    }
  }

  entryPoints.sort(compareEntryHits);
  reachingTests.sort(compareReachingTests);

  // R1 (depth axis): `walkUpstreamUsage`'s loop runs `depth < maxDepth` and
  // discovers each frontier's successors at `depth + 1` before checking the
  // loop bound again, so a node discovered exactly at `REACHABILITY_BFS_DEPTH`
  // is the walk's UNPROCESSED final frontier — its own incoming edges were
  // never queried. A non-empty set here means the walk was cut off mid-graph,
  // never that the graph itself ended there. No extra query: the depths are
  // already on every hit the walk returned.
  const boundaryIds: ComponentId[] = [...walkRes.value.values()]
    .filter((hit) => hit.depth === REACHABILITY_BFS_DEPTH)
    .map((hit) => hit.id)
    .sort();
  // The COUNT is the honest quantity and is never capped; the published LIST
  // is (see {@link MAX_DEPTH_CAP_BOUNDARY_IDS}) so a wide boundary cannot
  // crowd `verdict` / `entryPoints` out of the response budget.
  const depthCapBoundaryCount = boundaryIds.length;
  const depthTruncated = depthCapBoundaryCount > 0;
  const depthCapBoundaryIds = boundaryIds.slice(0, MAX_DEPTH_CAP_BOUNDARY_IDS);

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

  // Soundness is DERIVED from the walk, so it can never again report
  // `complete: true` over an un-walked edge type. The dynamic-Apex check WIDENS
  // from "the root class" to "every class on a reach path" — a REFLECTIVE
  // CALLER is what makes a reachability walk unsound, and the caller is not the
  // root.
  const soundness = soundnessForReachabilityWalk(
    nodesRes.value,
    USAGE_EDGE_TYPES,
    USAGE_EDGE_TYPES,
  );

  // When the ONLY thing keeping a class off `likely-dead-code` is an unproven
  // registration, say so. A bare `entry-point-reachable` here would read as
  // certainty the walk does not have.
  const allEntryPointsUnproven =
    entryPoints.length > 0 && entryPoints.every((e) => isUnprovenRegistrationKind(e.kind));
  const baseDisclosure =
    verdict === 'likely-dead-code'
      ? `${REACHABILITY_DISCLOSURE} ${LIKELY_DEAD_CODE_CROSS_REFERENCE}`
      : allEntryPointsUnproven
        ? `${REACHABILITY_DISCLOSURE} ${ALL_ENTRY_POINTS_UNPROVEN_DISCLOSURE}`
        : REACHABILITY_DISCLOSURE;
  // R1 (depth axis): appended independent of verdict — the residual-frontier
  // fact is orthogonal to which verdict cascade fired, exactly like
  // `walkedEdgeTypes` is emitted regardless of verdict.
  const disclosure = depthTruncated
    ? `${baseDisclosure} ${depthCapDisclosure(depthCapBoundaryCount, depthCapBoundaryIds)}`
    : baseDisclosure;

  return ok({
    data: {
      appliedScope: { component: targetId, mode: 'component' },
      classApiName: targetId,
      verdict,
      entryPoints,
      reachingTestClasses: reachingTests,
      walkedEdgeTypes: USAGE_EDGE_TYPES,
      depthTruncated,
      depthCapBoundaryCount,
      depthCapBoundaryIds,
      soundness,
      disclosure,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
