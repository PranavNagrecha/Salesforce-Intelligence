/**
 * Handler for the `sfi.call_graph` MCP tool.
 *
 * The v2.7 R2 call-graph walker. Answers the developer's "what does
 * this class call (or who calls it)?" question by walking `callsApex`
 * edges from a root ApexClass / ApexTrigger node out to `maxDepth`
 * hops in the requested direction.
 *
 * **Direction semantics**:
 *   - `'downstream'`: walk OUTGOING `callsApex` edges. Answers "what
 *     does X call?" — the targets of the root's `callsApex` edges, and
 *     their targets, recursively.
 *   - `'upstream'`: walk INCOMING `callsApex` edges. Answers "what
 *     calls X?" — the sources of incoming `callsApex` edges, and their
 *     sources, recursively.
 *   - `'both'`: union of the two walks. Each direction is bounded by
 *     `maxDepth` independently, and the merged result deduplicates
 *     nodes/edges that one direction's walk reproduced via the other.
 *
 * **Granularity (v2.7 honesty boundary)**: this is a CLASS-level walk.
 * If `ApexClass:A.foo()` calls `ApexClass:B.bar()` and `A.baz()` calls
 * `B.qux()`, the graph sees one `A -> B` edge. The TARGET methods are
 * partitioned via `methods` (B.bar + B.qux). CR-CAP-06: AST-extracted edges
 * ALSO carry `callerMethods` — the SOURCE-class method(s) holding the
 * call-site (here `A.foo` + `A.baz`), as a class-level UNION (it is NOT
 * narrowed to a specific target method even when the `method` filter is
 * applied). Edges without `callerMethods` (the heuristic Apex scanner,
 * Flow/declared callers, or a pre-upgrade vault) leave the caller method
 * UNKNOWN — absent is never "no caller". The `disclosure` field carries the
 * verbatim wording.
 *
 * **Cycle detection**: the visited set is keyed by node id, so a
 * cycle `A -> B -> A` is detected when the second hop tries to
 * re-enter `A`. The output's `cycleDetected: boolean` reports whether
 * the BFS observed any back-edge during the walk.
 *
 * Implementation notes:
 *   - BFS over `callsApex` edges only — other edge types are not
 *     walked. The caller wants the call chain, not the dependency
 *     surface; `sfi.get_impact` and `sfi.get_subgraph` cover the
 *     broader query.
 *   - Node identity is established at insertion time; the `depth`
 *     label is the first depth at which a node was discovered (the
 *     shortest-path distance from the root in hop count).
 *   - Edge identity is `(fromId, toId, edgeType, source)` to dedupe
 *     edges that both the upstream and downstream walks observed.
 *   - A rootId with NO node row is not answered as an empty walk. Two
 *     different truths hide behind "no row", and they are told apart:
 *     with NO incident edge either, the id names nothing in this vault and
 *     surfaces as `component-not-found` (worded by the shared
 *     `phantomAwareNotFoundMessage`, so a standard / managed-package id is
 *     not reported absent from the ORG); with incident edges, it is a
 *     PHANTOM — referenced here but never retrieved — which still answers,
 *     with `disclosure` saying the definition is missing (mirroring
 *     `sfi.get_subgraph`'s rootPhantomNote). Without that split, a typo
 *     ("who calls DeprecatedSevice?") returned `edges: []` beside an
 *     `otherUsageInEdges` count of 0 that this payload's own contract calls
 *     a CHECKED zero — i.e. it asserted that nothing calls a class that does
 *     not exist.
 *   - The prefix validation only rejects ids that are NEITHER
 *     `ApexClass:` NOR `ApexTrigger:` — those are not call-graph
 *     candidates by construction. CustomObject / Flow / etc. surface
 *     as `invalid-query`.
 */

import type {
  ComponentId,
  ComponentType,
  ConfidenceLevel,
  EdgeType,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  isHiddenUnresolved,
  listEdges,
  listEdgesForNodes,
  listNodesByIds,
} from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  countUnwalkedUsageInEdges,
  USAGE_EDGE_TYPES,
} from './apex-reachability.js';
import { coercePrefix } from './coerce-id.js';
import { mergeInputAliases } from './input-aliases.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import { soundnessForReachabilityWalk, type Soundness } from './soundness.js';

/** Inclusive upper bound on `maxDepth`. */
const CALL_GRAPH_MAX_DEPTH = 5;
/** Default `maxDepth` when the caller omits it. */
const CALL_GRAPH_DEFAULT_DEPTH = 3;

/** Canonical id prefixes the tool accepts. */
const APEX_CLASS_PREFIX = 'ApexClass:';
const APEX_TRIGGER_PREFIX = 'ApexTrigger:';

/**
 * Verbatim honesty-axis disclosure surfaced in every response. Frozen so the
 * test suite can assert the exact string. P4-C5: each `callsApex` edge carries
 * `methods` — the target-class methods the source invokes — and the optional
 * `method` filter uses them. CR-CAP-06: AST-extracted edges ALSO carry
 * `callerMethods` — the SOURCE-class method(s) that contain the call-site, as a
 * class-level UNION (the source methods that call ANY method of the target;
 * NOT partitioned to the specific target method even when `method` is set).
 * Edges without it (the heuristic Apex scanner, Flow/declared callers, or a
 * pre-upgrade vault) leave the caller method UNKNOWN — absence is not
 * "no caller".
 */
const CALL_GRAPH_DISCLOSURE =
  'call_graph surfaces method-level call TARGETS: each callsApex edge lists `methods` — the methods of the target class the source invokes (heuristic, from the Apex scanner) — and the optional `method` filter narrows the root\'s direct callers/callees to edges involving that target method. Each callsApex edge MAY carry `callerMethods` — the method(s) of the SOURCE class that contain the call-site, available ONLY on AST-extracted edges (`source: \'apex-ast\'`); it is a class-level UNION (the source methods that call ANY method of the target, NOT partitioned to the specific target method even when the `method` filter is applied — so do not read it as "the methods that call the filtered target method"). Edges WITHOUT it (the heuristic Apex scanner, Flow/declared callers, or a pre-upgrade vault) leave the caller method UNKNOWN — absence is not "no caller". Edges remain at-least-one-call between two classes.';

/**
 * CALL-GRAPH-EMPTY-IS-NOT-NO-CALLERS. Appended to every response. `call_graph`
 * DELIBERATELY keeps `callsApex` as its default: a `references` edge is not a
 * call, and rendering one as a call in a *call* graph misrepresents control
 * flow. The honest fix is to say what was not followed, and to count it.
 * Verbatim product copy; do not reword.
 */
const CALL_GRAPH_UNWALKED_DISCLOSURE =
  'This graph walks callsApex ONLY. Async dispatch (Database.executeBatch / System.enqueueJob / ' +
  'System.schedule) mints a dispatchesAsync edge, and a static-field or type-name reference mints ' +
  'a references edge; NEITHER is traversed here. An empty edges array therefore means "no callsApex ' +
  'call was modelled", NEVER "no callers" — read otherUsageInEdges for the count this walk did not ' +
  'follow, or pass edgeTypes to widen it.';

/**
 * Zod schema for the `sfi.call_graph` tool input.
 *
 *   - `rootId`: required, non-empty string. Must start with
 *     `ApexClass:` or `ApexTrigger:`; non-matching prefixes surface
 *     as `invalid-query` at the handler boundary.
 *   - `direction`: optional enum (`downstream` / `upstream` / `both`). Defaults to `'both'`.
 *   - `maxDepth`: optional integer in `[1, 5]`. Defaults to 3.
 *   - `method`: optional. When set, the root's DIRECT edges are narrowed to
 *     those whose `methods` include it — e.g. `direction: 'upstream'` +
 *     `method: 'deleteRecord'` answers "who calls Root.deleteRecord". Applies
 *     only at the root hop; deeper hops are unfiltered (their methods belong
 *     to a different target).
 */
const callGraphInputBaseSchema = z.object({
  rootId: z.string().min(1),
  direction: z.enum(['downstream', 'upstream', 'both']).optional().default('both'),
  maxDepth: z.number().int().min(1).max(CALL_GRAPH_MAX_DEPTH).optional(),
  method: z.string().min(1).optional(),
  /**
   * Widen the walk beyond `callsApex`. Defaults to `['callsApex']` — a call
   * graph is about CALLS, so static-type `references` are counted (see
   * `otherUsageInEdges`) but not rendered as call edges unless asked for.
   * Only usage edge types are accepted; `parentOf` / `grantedBy` are not usage.
   */
  edgeTypes: z
    .array(z.enum(USAGE_EDGE_TYPES as unknown as [EdgeType, ...EdgeType[]]))
    .min(1)
    .optional(),
});

export const callGraphInputSchema = z.preprocess(
  (raw) => mergeInputAliases(raw, [{ canonical: 'rootId', aliases: ['componentId'] }]),
  callGraphInputBaseSchema,
);

/** Parsed input shape. */
export type CallGraphInput = z.infer<typeof callGraphInputSchema>;

/** One node in the walk result. `depth` is the shortest-path hop count from root. */
export interface CallGraphNode {
  readonly id: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  readonly depth: number;
}

/**
 * One edge in the walk result. `fromDepth` is the depth at which the
 * edge was traversed (the depth of the `fromId` for downstream walks,
 * or the depth of the `toId` for upstream walks).
 */
export interface CallGraphEdge {
  readonly fromId: ComponentId;
  readonly toId: ComponentId;
  readonly fromDepth: number;
  readonly source: string;
  readonly confidence: ConfidenceLevel;
  /**
   * P4-C5: the methods of the TARGET class (`toId`) the source (`fromId`)
   * invokes, sorted. Empty when the edge carries no method evidence (a Flow/
   * declared caller, or a pre-P4-C5 vault with neither `methods` nor
   * `methodName`). This is target-method granularity, not caller-method.
   */
  readonly methods: readonly string[];
  /**
   * CR-CAP-06: the method(s) of the SOURCE class (`fromId`) that contain the
   * call-site(s) to `toId`, as a class-level UNION (the source methods that
   * call ANY method of the target — NOT partitioned to a specific target
   * method, even when the `method` filter is applied). AST-path edges
   * (`source: 'apex-ast'`) only; ABSENT on scanner-path / declared / Flow
   * callers and pre-fix vaults — treat absent as "caller method unknown",
   * never as "no caller".
   */
  readonly callerMethods?: readonly string[];
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface CallGraphOutput {
  readonly rootId: ComponentId;
  readonly direction: 'downstream' | 'upstream' | 'both';
  readonly nodes: readonly CallGraphNode[];
  readonly edges: readonly CallGraphEdge[];
  readonly cycleDetected: boolean;
  readonly maxDepthReached: number;
  /**
   * The edge types this walk traversed. Echoed on EVERY response, not only
   * when widened, so `edges: []` is readable as "checked these types" rather
   * than an unbounded absence claim.
   */
  readonly walkedEdgeTypes: readonly EdgeType[];
  /**
   * The root's incoming USAGE edges this walk did NOT traverse, with a per-type
   * breakdown. This is the field that stops `edges: []` reading as "no
   * callers": a `count` of 0 is a CHECKED zero, and a non-zero count names
   * exactly what was left unfollowed. ALWAYS present — a `count` of 0 next to
   * `walkedEdgeTypes` is a CHECKED zero, whereas an absent field would be
   * UNCHECKED-shaped.
   */
  readonly otherUsageInEdges: {
    readonly count: number;
    readonly byType: Readonly<Record<string, number>>;
  };
  /**
   * Blind spots DERIVED from the walk: `complete: false` naming `references` /
   * `dispatchesAsync` whenever a strict subset of the usage set was traversed.
   */
  readonly soundness: Soundness;
  readonly disclosure: string;
}

/**
 * Validate the prefix. Returns `true` when the id starts with
 * `ApexClass:` or `ApexTrigger:`.
 */
const isApexCallable = (id: string): boolean =>
  id.startsWith(APEX_CLASS_PREFIX) || id.startsWith(APEX_TRIGGER_PREFIX);

/** Composite key for edge deduplication across walk directions. */
const edgeKey = (e: CallGraphEdge): string =>
  `${e.fromId}\0${e.toId}\0${e.source}`;

/**
 * Read the target methods a `callsApex` edge represents (P4-C5). Prefers the
 * `methods` array; falls back to the scalar `methodName` for vaults refreshed
 * before P4-C5. Returns `[]` when the edge carries no method evidence (a
 * Flow/declared caller, or an old vault with neither). Always sorted + deduped.
 */
const edgeMethods = (edge: {
  readonly properties: Readonly<Record<string, unknown>>;
}): readonly string[] => {
  const m = edge.properties['methods'];
  if (Array.isArray(m)) {
    const strs = m.filter((x): x is string => typeof x === 'string');
    return [...new Set(strs)].sort();
  }
  const scalar = edge.properties['methodName'];
  return typeof scalar === 'string' && scalar.length > 0 ? [scalar] : [];
};

/**
 * CR-CAP-06: read the SOURCE-class caller method(s) labelled on an AST edge
 * (`properties.callerMethods`, a class-level union). Returns `undefined` when
 * the key is absent or empty so the optional field is OMITTED — preserving the
 * "absent === unknown caller method" honesty distinction (never coerce to `[]`,
 * which would falsely imply "no caller method"). Always sorted + deduped.
 */
const edgeCallerMethods = (edge: {
  readonly properties: Readonly<Record<string, unknown>>;
}): readonly string[] | undefined => {
  const m = edge.properties['callerMethods'];
  if (!Array.isArray(m)) return undefined;
  const strs = m.filter((x): x is string => typeof x === 'string');
  return strs.length === 0 ? undefined : [...new Set(strs)].sort();
};

/**
 * Detect a directed cycle in the bounded subgraph the BFS collected.
 *
 * The BFS labels nodes by shortest-path depth, so a node reached by two
 * distinct paths (a diamond / shared callee — e.g. two batch classes that
 * both call one helper) is *re-discovered*. Re-discovery is NOT a cycle: a
 * cycle requires a back-edge into a node still on the active path. Flagging
 * every re-discovery is a false positive (the same bug fixed in
 * `async-chain-depth`).
 *
 * This runs an iterative gray/black DFS over the collected edges in the
 * direction the walk traversed (`out`: follow `fromId → toId`; `in`: follow
 * `toId → fromId`, the reverse graph — whose cycles correspond one-to-one
 * with the forward graph's), flagging a cycle only on a back-edge into a
 * GRAY (on-stack) ancestor. BLACK (fully-explored) targets are
 * cross/forward edges, not cycles. Bounded naturally: only edges the
 * depth-limited BFS collected are considered.
 */
const detectCycle = (
  rootId: ComponentId,
  edges: readonly CallGraphEdge[],
  direction: 'in' | 'out',
): boolean => {
  const adjacency = new Map<ComponentId, ComponentId[]>();
  for (const edge of edges) {
    const from = direction === 'out' ? edge.fromId : edge.toId;
    const to = direction === 'out' ? edge.toId : edge.fromId;
    const list = adjacency.get(from);
    if (list) list.push(to);
    else adjacency.set(from, [to]);
  }
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<ComponentId, number>([[rootId, GRAY]]);
  const stack: { node: ComponentId; neighbors: ComponentId[]; index: number }[] =
    [{ node: rootId, neighbors: adjacency.get(rootId) ?? [], index: 0 }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame === undefined) break;
    if (frame.index >= frame.neighbors.length) {
      color.set(frame.node, BLACK);
      stack.pop();
      continue;
    }
    const next = frame.neighbors[frame.index];
    frame.index += 1;
    if (next === undefined) continue;
    const c = color.get(next);
    if (c === GRAY) return true; // back-edge into on-stack ancestor → cycle
    if (c === undefined) {
      color.set(next, GRAY);
      stack.push({
        node: next,
        neighbors: adjacency.get(next) ?? [],
        index: 0,
      });
    }
    // c === BLACK → already fully explored; cross/forward edge, not a cycle.
  }
  return false;
};

/**
 * One BFS walk over `callsApex` edges in a fixed direction. Returns the
 * map of discovered nodes (id → depth), the list of traversed edges, and
 * whether a cycle (back-edge into a visited id) was observed.
 *
 * `direction === 'in'` walks INCOMING edges (upstream); the `fromId` of
 * each edge is the unvisited frontier candidate. `direction === 'out'`
 * walks OUTGOING edges (downstream); the `toId` is the frontier
 * candidate.
 */
const walkOneDirection = async (
  ctx: Context,
  rootId: ComponentId,
  direction: 'in' | 'out',
  maxDepth: number,
  /** P4-C5: when set, filter the root's DIRECT edges to those calling it. */
  method: string | undefined,
  /** The edge types to traverse. Defaults to `['callsApex']` at the caller. */
  edgeTypes: readonly EdgeType[],
): Promise<
  Result<
    {
      discovered: Map<ComponentId, number>;
      edges: CallGraphEdge[];
      cycleDetected: boolean;
      depthReached: number;
    },
    string
  >
> => {
  const discovered = new Map<ComponentId, number>();
  discovered.set(rootId, 0);
  const edges: CallGraphEdge[] = [];
  let depthReached = 0;

  let frontier: ComponentId[] = [rootId];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: ComponentId[] = [];
    // ONE batched fetch of the WHOLE frontier's `callsApex` edges in the walk
    // direction, replacing the per-frontier-node `listEdges` N+1 (~frontier-
    // width serial DuckDB queries per hop). Iterating `frontier` in order and
    // reading each node's bucket (sorted by the FULL (to_id, edge_type, from_id,
    // source) order — the same order `listEdges` returned, and here edge_type is
    // fixed to `callsApex` per bucket) reproduces the exact `edges` push order,
    // `discovered` insertion order, and next-frontier order. The query count is
    // now one per DEPTH LEVEL, independent of frontier WIDTH.
    const edgeBatch = await listEdgesForNodes(ctx.graph, frontier, {
      direction,
      edgeTypes,
    });
    if (!edgeBatch.ok) return err(edgeBatch.error.message);
    for (const nodeId of frontier) {
      for (const edge of edgeBatch.value.get(nodeId) ?? []) {
        // Phantom heuristic edge: `to_id` was tagged `targetMissing` at import
        // because it resolves to no real node — e.g. the Apex scanner minting
        // `ApexClass:{PascalCaseLocalVar}` from a `Map<Id,Foo> Foo = …` local
        // that `LOCAL_DECL_PATTERN` (lowercase-initial only) never registered.
        // Skip it entirely so it never enters `edges`/`discovered`, extends the
        // frontier, or inflates `depthReached`/`cycleDetected`. Mirrors
        // getSubgraph's default `bfsExpand` skip (queries.ts `isHiddenUnresolved`);
        // call_graph has no `includeUnresolved` opt-in, so the skip is
        // unconditional — a phantom target is a false-positive "call", never a
        // real callee to surface in a call graph.
        if (isHiddenUnresolved(edge)) continue;
        const methods = edgeMethods(edge);
        // P4-C5 method filter: narrow ONLY the root's direct edges to those
        // whose target methods include the queried method (e.g. "who calls
        // Root.deleteRecord"). Deeper hops are unfiltered — their methods
        // belong to a different target class, so the root method is irrelevant.
        if (nodeId === rootId && method !== undefined && !methods.includes(method)) {
          continue;
        }
        const neighbor =
          direction === 'out' ? edge.toId : edge.fromId;
        // For downstream, fromDepth is the depth of `fromId` (current).
        // For upstream, fromDepth is still the depth of the edge's
        // source `fromId`. Since upstream walks INCOMING edges, the
        // depth of `fromId` is `depth + 1` (one hop further from the
        // root than the current node). The depth label is on the
        // edge's origin in both cases — preserves "edge originates at
        // fromDepth" semantics regardless of walk direction.
        const fromDepth =
          direction === 'out' ? depth : depth + 1;
        const callerMethods = edgeCallerMethods(edge);
        edges.push({
          fromId: edge.fromId,
          toId: edge.toId,
          fromDepth,
          source: edge.source,
          confidence: edge.confidence,
          methods,
          // CR-CAP-06: label the edge with the source-class caller method(s)
          // when the AST extracted them; OMIT when absent (unknown). Intrinsic
          // to the (from, to, source) edge, so correct for both directions.
          ...(callerMethods !== undefined ? { callerMethods } : {}),
        });
        // Re-discovering an already-seen node means it was reached by a
        // second path (a diamond / shared callee) — NOT a cycle. Skip
        // re-expansion; cycle detection runs once below over the collected
        // edges, distinguishing a back-edge from a re-convergence.
        if (discovered.has(neighbor)) {
          continue;
        }
        discovered.set(neighbor, depth + 1);
        depthReached = Math.max(depthReached, depth + 1);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  const cycleDetected = detectCycle(rootId, edges, direction);
  return ok({ discovered, edges, cycleDetected, depthReached });
};

/**
 * Resolve every discovered id into a `CallGraphNode`. Missing rows are
 * dropped silently (sparse-graph tolerance, same as `find-code-usages`).
 */
const resolveNodes = async (
  ctx: Context,
  discovered: ReadonlyMap<ComponentId, number>,
): Promise<Result<{ nodes: CallGraphNode[]; raw: readonly Node[] }, string>> => {
  // ONE batched `listNodesByIds` over every discovered id, replacing the
  // per-node `getNodeById` N+1 (~#discovered serial DuckDB queries). Ids with
  // no matching row are dropped by `listNodesByIds` exactly like the old
  // per-id null-skip. Iterating `discovered` in its insertion order and looking
  // each id up by-id reproduces the byte-identical `out` push order (and the
  // caller re-sorts by `compareNodes` regardless).
  const nodesRes = await listNodesByIds(ctx.graph, [...discovered.keys()]);
  if (!nodesRes.ok) return err(nodesRes.error.message);
  const nodeById = new Map(nodesRes.value.map((n) => [n.id, n]));
  const out: CallGraphNode[] = [];
  for (const [id, depth] of discovered) {
    const node = nodeById.get(id);
    if (node === undefined) continue;
    out.push({
      id,
      type: node.type,
      apiName: node.apiName,
      depth,
    });
  }
  // The RAW nodes go back too: `soundnessForReachabilityWalk` reads
  // `properties.qualityIssues` for the dynamic-Apex signal, which the trimmed
  // CallGraphNode does not carry. Reusing this fetch keeps the query count flat.
  return ok({ nodes: out, raw: nodesRes.value });
};

/** Deterministic comparator: depth ASC then id ASC. */
const compareNodes = (a: CallGraphNode, b: CallGraphNode): number => {
  if (a.depth !== b.depth) return a.depth - b.depth;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** Deterministic edge comparator: fromDepth ASC, fromId, toId, source. */
const compareEdges = (a: CallGraphEdge, b: CallGraphEdge): number => {
  if (a.fromDepth !== b.fromDepth) return a.fromDepth - b.fromDepth;
  if (a.fromId !== b.fromId) return a.fromId < b.fromId ? -1 : 1;
  if (a.toId !== b.toId) return a.toId < b.toId ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return 0;
};

/**
 * The `sfi.call_graph` MCP tool. Walks `callsApex` edges from a root
 * ApexClass / ApexTrigger up to `maxDepth` hops in the requested
 * direction; returns the structured tree with depth labels per node
 * plus a class-granularity disclosure.
 *
 * @example
 *   const r = await callGraphHandler(ctx, {
 *     rootId: 'ApexClass:OrderService',
 *     direction: 'downstream',
 *     maxDepth: 3,
 *   });
 *   if (r.ok) console.log(r.value.data.nodes.length);
 */
export const callGraphHandler = async (
  ctx: Context,
  input: CallGraphInput,
): Promise<Result<McpResponse<CallGraphOutput>, McpError>> => {
  const coercedRootId = coercePrefix(input.rootId, [
    APEX_CLASS_PREFIX,
    APEX_TRIGGER_PREFIX,
  ]);
  if (!isApexCallable(coercedRootId)) {
    return err({
      kind: 'invalid-query',
      message: `rootId must be an ApexClass/ApexTrigger id (e.g. '${APEX_CLASS_PREFIX}Foo') or a bare class name (e.g. 'Foo'); got '${input.rootId}'`,
      path: 'rootId',
    });
  }
  const rootId = coercedRootId as ComponentId;
  const maxDepth = input.maxDepth ?? CALL_GRAPH_DEFAULT_DEPTH;
  // DELIBERATE default. See CALL_GRAPH_UNWALKED_DISCLOSURE: widening this
  // silently would put static-type references into a graph whose contract is
  // about calls. The zero is made honest by `otherUsageInEdges` + `soundness`.
  const walkedEdgeTypes: readonly EdgeType[] =
    input.edgeTypes !== undefined
      ? ([...input.edgeTypes] as EdgeType[])
      : (['callsApex'] as EdgeType[]);

  const directions: ('in' | 'out')[] =
    input.direction === 'downstream'
      ? ['out']
      : input.direction === 'upstream'
        ? ['in']
        : ['out', 'in'];

  const mergedDiscovered = new Map<ComponentId, number>();
  mergedDiscovered.set(rootId, 0);
  const seenEdges = new Set<string>();
  const mergedEdges: CallGraphEdge[] = [];
  let cycleDetected = false;
  let maxDepthReached = 0;

  for (const dir of directions) {
    const res = await walkOneDirection(ctx, rootId, dir, maxDepth, input.method, walkedEdgeTypes);
    if (!res.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${res.error}`,
      });
    }
    if (res.value.cycleDetected) cycleDetected = true;
    maxDepthReached = Math.max(maxDepthReached, res.value.depthReached);
    for (const [id, depth] of res.value.discovered) {
      const existing = mergedDiscovered.get(id);
      if (existing === undefined || depth < existing) {
        mergedDiscovered.set(id, depth);
      }
    }
    for (const edge of res.value.edges) {
      const key = edgeKey(edge);
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        mergedEdges.push(edge);
      }
    }
  }

  const nodesRes = await resolveNodes(ctx, mergedDiscovered);
  if (!nodesRes.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodesRes.error}`,
    });
  }

  const sortedNodes = [...nodesRes.value.nodes].sort(compareNodes);
  // Self-contained-slice invariant (CR-13, mirrors getSubgraph's returnedIds
  // filter in queries.ts): every emitted edge must have BOTH endpoints present
  // in `nodes`. `resolveNodes` drops ids with no real node row, so an edge
  // whose endpoint didn't resolve — a heuristic `targetMissing` phantom (the
  // `ApexClass:{PascalCaseLocalVar}` case, already skipped at walk time above)
  // OR a `declared`/`parsed` reference to an out-of-vault class — is dropped
  // here rather than emitted as an edge pointing at a node that isn't in
  // `nodes`. Belt-and-braces: layer 1 (walk-time) handles the reported phantom;
  // this final filter guarantees the invariant against any remaining dangler.
  const nodeIds = new Set(sortedNodes.map((n) => n.id));
  // ROOT-NOT-FOUND-IS-NOT-A-CHECKED-ZERO. `resolveNodes` drops any id with no
  // row, and `coercePrefix` above promotes ANY bare word to `ApexClass:<word>`,
  // so a misspelled root used to answer `nodes: [] / edges: [] /
  // otherUsageInEdges: { count: 0 }` — a shape this payload's own contract
  // reads as a CHECKED zero. Split the two truths hiding behind "no row":
  //   - no node AND no incident edge → the id names nothing here. Refuse with
  //     `component-not-found`, worded by the SHARED
  //     `phantomAwareNotFoundMessage` (phantom-node.ts) so a standard-object /
  //     managed-package id is not reported absent from the ORG.
  //   - no node BUT incident edges → a PHANTOM: referenced by this vault, its
  //     own definition never retrieved. Those edges are real evidence, so this
  //     still answers — and says so in `disclosure`, mirroring get_subgraph's
  //     rootPhantomNote. (The edges themselves are dropped just below by the
  //     self-contained-slice filter, which is exactly why the sentence is
  //     needed: the empty result must not read as "nothing calls it".)
  let rootPhantomNote = '';
  if (!nodeIds.has(rootId)) {
    const incident = await listEdges(ctx.graph, rootId, { direction: 'both' });
    if (!incident.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${incident.error.message}`,
      });
    }
    if (incident.value.length === 0) {
      return err({
        kind: 'component-not-found',
        message: await phantomAwareNotFoundMessage(
          ctx,
          rootId,
          'ApexClass or ApexTrigger',
        ),
        path: rootId,
      });
    }
    rootPhantomNote =
      ` ROOT DEFINITION MISSING: \`${rootId}\` is a PHANTOM — ` +
      `${incident.value.length.toString()} edge(s) in this vault reference it, but its own ` +
      `ApexClass/ApexTrigger definition was never retrieved here (typically a ` +
      `managed-package class, or one outside the retrieve scope), so this walk had ` +
      `no root node to start from. An empty nodes/edges result therefore means ` +
      `"the root's definition is missing", NEVER "nothing calls it" — run ` +
      `\`sfi refresh\` if it should be retrievable, or read \`sfi.get_edges\` on the ` +
      `same id for the references themselves.`;
  }
  const sortedEdges = mergedEdges
    .filter((e) => nodeIds.has(e.fromId) && nodeIds.has(e.toId))
    .sort(compareEdges);

  // ONE extra query: the root's usage in-edges this walk did NOT follow.
  const unwalkedRes = await countUnwalkedUsageInEdges(ctx, rootId, walkedEdgeTypes);
  if (!unwalkedRes.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${unwalkedRes.error}` });
  }
  const soundness = soundnessForReachabilityWalk(
    nodesRes.value.raw,
    walkedEdgeTypes,
    USAGE_EDGE_TYPES,
  );

  return ok({
    data: {
      rootId,
      direction: input.direction,
      nodes: sortedNodes,
      edges: sortedEdges,
      cycleDetected,
      maxDepthReached,
      walkedEdgeTypes,
      // ALWAYS emitted, including as `{count: 0, byType: {}}`. An absent field
      // is UNCHECKED-shaped; a zero here alongside walkedEdgeTypes is a CHECKED
      // zero, which is the whole point of the field.
      otherUsageInEdges: unwalkedRes.value,
      soundness,
      disclosure: `${CALL_GRAPH_DISCLOSURE} ${CALL_GRAPH_UNWALKED_DISCLOSURE}${rootPhantomNote}`,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
