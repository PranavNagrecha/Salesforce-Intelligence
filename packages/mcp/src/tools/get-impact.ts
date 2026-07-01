/**
 * Handler for the `sfi.get_impact` MCP tool.
 *
 * Answers the architect's "what breaks if I change this component?"
 * question. Walks BFS from `componentId`, following INCOMING edges only
 * — the OPPOSITE direction from `getSubgraph`, which walks both. The
 * result is the slice of nodes and edges that *depend on* the target.
 *
 * Implementation notes:
 *   - Each hop expands the frontier with ONE batched
 *     `listEdgesForNodes(frontier, { direction: 'in', edgeTypes })`
 *     query (CR-17 — was one `listEdges` call per node × edgeType, an
 *     N+1 loop). The returned per-node buckets are then replayed in the
 *     SAME visit order the row-at-a-time loop used (frontier order, then
 *     `edgeTypes ?? [null]` order) so the cap/dedup/next-frontier logic
 *     is byte-for-byte preserved. The graph layer has no direct
 *     multi-hop incoming-only traversal, so the dispatcher composes the
 *     walk here.
 *   - On a cap hit the surviving prefix is the lowest edges by
 *     `(toId, edgeType, fromId, source)` within each `(node, edgeType)`
 *     group — `listEdgesForNodes` pins that total order, whereas the old
 *     per-`listEdges` path left the intra-group order DuckDB-unspecified.
 *     The cap-identity test in `get-impact.test.ts` is the contract for
 *     this pinned prefix.
 *   - Unknown `componentId` resolves to `ok({ impact: { nodes: [],
 *     edges: [] }, traversedEdgeTypes: [] })`. The graph cannot
 *     distinguish "missing component" from "component with no incoming
 *     edges", and either is a valid empty impact set.
 *   - Sort: nodes by id ASC, edges by `(fromId, toId, edgeType,
 *     source)` — matches `getSubgraph`'s deterministic output so
 *     consumer fixtures can share comparison logic across tools.
 */

import {
  EDGE_TYPES,
  type ComponentId,
  type Edge,
  type EdgeType,
  type McpError,
  type McpResponse,
  type Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  getNodeById,
  listEdgesForNodes,
  listNodesByIds,
} from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { isUnresolvedApexCallTarget, isUnresolvedFieldReceiver } from './apex-receiver.js';
import {
  buildEmptyTraversalCoverageCaveat,
  type CoverageCaveat,
  GRAPH_TRAVERSAL_REQUIRED_COVERAGE,
} from './coverage-trust.js';
import {
  enforceGraphPayloadBudget,
  estimateGraphPayloadBytes,
  GRAPH_MAX_PAYLOAD_BYTES,
  slimGraphNodes,
} from './graph-payload-bounds.js';
import { soundnessFromNodes, type Soundness } from './soundness.js';

/**
 * Inclusive upper bound on `hops`. Mirrors `getSubgraph`'s ceiling so
 * the two architect-facing traversal tools share the same blast-radius
 * cap; drift between this constant and `SUBGRAPH_MAX_HOPS` in
 * `get-subgraph.ts` is a code-review concern.
 */
const IMPACT_MAX_HOPS = 3;

/**
 * Default `hops` when the caller omits the parameter. Set to 2 (not 1,
 * like `get_subgraph`) because the architect persona almost always
 * wants to see the transitive dependents — a flow that references a
 * validation rule that reads a field, for example.
 */
const IMPACT_DEFAULT_HOPS = 2;

/** Mirrors `getSubgraph` caps so architect-facing traversal tools share blast-radius limits. */
const IMPACT_MAX_NODES = 200;
const IMPACT_MAX_EDGES = 400;

/**
 * Payload-size comfort threshold mirrored from `graph.getSubgraph`'s design
 * note (~200 nodes + ~400 edges ≈ ~250 KB). Count caps alone do not bound
 * JSON size when Profile/PermissionSet grantedBy edges dominate.
 */
const IMPACT_COMFORT_PAYLOAD_BYTES = 250_000;

/**
 * Zod schema for the `sfi.get_impact` tool input.
 *
 *   - `componentId`: required, non-empty string. Unknown ids surface
 *     as an empty impact set, not a Zod-level rejection.
 *   - `hops`: optional integer in `[1, 3]`. Defaults to 2 inside the
 *     handler when omitted. Values outside the range are rejected here.
 *   - `edgeTypes`: optional array of `EdgeType` values. When set, the
 *     walk only follows incoming edges whose type is in the array.
 */
export const getImpactInputSchema = z.object({
  componentId: z.string().min(1),
  hops: z.number().int().min(1).max(IMPACT_MAX_HOPS).optional(),
  edgeTypes: z.array(z.enum(EDGE_TYPES)).optional(),
});

/** Parsed input shape, inferred from `getImpactInputSchema`. */
export type GetImpactInput = z.infer<typeof getImpactInputSchema>;

/**
 * Payload wrapped inside the `McpResponse` envelope on success.
 *
 *   - `impact.nodes`: every node touched by the walk, including the
 *     root if it exists. Sorted by id ASC.
 *   - `impact.edges`: every incoming edge visited during the walk,
 *     deduped on `(fromId, toId, edgeType, source)`. Sorted by the same
 *     tuple.
 *   - `traversedEdgeTypes`: the distinct edge types that actually
 *     contributed to the impact set. Lets callers cite which kinds of
 *     dependencies the answer rests on. Sorted alphabetically.
 */
export interface GetImpactOutput {
  readonly impact: {
    readonly nodes: readonly Node[];
    readonly edges: readonly Edge[];
  };
  readonly traversedEdgeTypes: readonly EdgeType[];
  readonly truncated: boolean;
  /**
   * Structured truncation detail — present iff `truncated`. Promotes the
   * caveat out of the prose `disclosure` so a caller reading the summary
   * (not the disclosure string) still learns the impact slice is partial,
   * why, and how to widen it.
   */
  readonly truncationReason?: {
    readonly reason: 'node-cap' | 'edge-cap' | 'payload-budget';
    readonly nodeCap: number;
    readonly edgeCap: number;
    readonly payloadByteBudget: number;
    readonly returnedNodes: number;
    readonly returnedEdges: number;
    readonly remedy: string;
  };
  /** True when ≥1 node had an oversized property value summarised to bound payload. */
  readonly payloadSlimmed: boolean;
  /** UTF-8 byte length of `JSON.stringify(impact)` — the slice the caller receives. */
  readonly estimatedPayloadBytes: number;
  /** Static-analysis blind spots: `complete: false` when an impacted class uses dynamic Apex. */
  readonly soundness: Soundness;
  /**
   * I3b (empty ≠ none): present ONLY when the impact slice found NO dependents
   * (`impact.edges` is empty) AND a dependency family that would produce an
   * inbound edge is NOT fully covered by the vault. Names the not-checked
   * families so an empty impact reads "not retrieved", not a proven "nothing
   * depends on this". Absent when dependents exist or the vault is fully covered
   * (byte-identical to before).
   */
  readonly coverageCaveat?: CoverageCaveat;
  readonly disclosure: string;
}

/**
 * Comparator for the deterministic edge sort. Lifted from
 * `get-subgraph.ts`'s shape so the two tools emit byte-identical edge
 * orderings for overlapping inputs.
 */
const compareEdges = (a: Edge, b: Edge): number => {
  if (a.fromId !== b.fromId) return a.fromId < b.fromId ? -1 : 1;
  if (a.toId !== b.toId) return a.toId < b.toId ? -1 : 1;
  if (a.edgeType !== b.edgeType) return a.edgeType < b.edgeType ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return 0;
};

/**
 * Composite key for edge deduplication. `\0` never appears in any
 * `ComponentId` (which uses only `:` and `.`), so the join is
 * unambiguous.
 */
const edgeKey = (e: Edge): string =>
  `${e.fromId}\0${e.toId}\0${e.edgeType}\0${e.source}`;

/** Human-readable payload size for disclosure text. */
const formatPayloadSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `~${Math.round(bytes / 1024)} KB`;
  return `~${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * Name the dominant payload contributors when security-grant edges or
 * permission-container nodes inflate an otherwise count-capped slice.
 */
const describePayloadHeavyContributors = (
  nodes: readonly Node[],
  edges: readonly Edge[],
): string | null => {
  let grantedByCount = 0;
  let profileCount = 0;
  let permSetCount = 0;
  for (const edge of edges) {
    if (edge.edgeType === 'grantedBy') grantedByCount++;
  }
  for (const node of nodes) {
    if (node.type === 'Profile') profileCount++;
    else if (node.type === 'PermissionSet') permSetCount++;
  }
  const parts: string[] = [];
  if (grantedByCount > 0) {
    parts.push(
      `${grantedByCount} grantedBy edge(s) (Profile/PermissionSet permission matrices)`,
    );
  }
  if (profileCount > 0 && grantedByCount === 0) {
    parts.push(`${profileCount} Profile node(s)`);
  }
  if (permSetCount > 0 && grantedByCount === 0) {
    parts.push(`${permSetCount} PermissionSet node(s)`);
  }
  return parts.length > 0 ? parts.join('; ') : null;
};

/** Verbatim honesty note combining count caps, truncation, and payload size. */
const buildImpactDisclosure = (params: {
  readonly componentId: string;
  readonly hops: number;
  readonly truncated: boolean;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly payloadBytes: number;
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
  readonly slimmedCount: number;
  readonly byteTrimmed: boolean;
  readonly rootIsObject: boolean;
}): string => {
  const payloadLabel = formatPayloadSize(params.payloadBytes);
  const countSummary = `${params.nodeCount} node(s) / ${params.edgeCount} edge(s)`;
  const heavy = describePayloadHeavyContributors(params.nodes, params.edges);
  const payloadLarge = params.payloadBytes > IMPACT_COMFORT_PAYLOAD_BYTES;
  const slimNote =
    params.slimmedCount > 0
      ? ` ${params.slimmedCount} node(s) had an oversized property value (e.g. Profile/PermissionSet grant matrices) summarised to an \`{__omitted}\` marker to bound response size — fetch the full node with \`sfi.get_component\`.`
      : '';
  // Lookup / master-detail relationships ARE modeled as `lookupTo` edges
  // (extraction-time, since 0.1.7). They point from the field to the referenced
  // object, so an impact walk over INCOMING edges to a CustomObject includes the
  // inbound lookup fields that point AT it. On a vault refreshed before that edge
  // existed the slice would miss them, so the note is freshness-aware rather than
  // claiming the slice is exhaustive.
  const lookupCaveat = params.rootIsObject
    ? ' Lookup / master-detail relationships are modeled as `lookupTo` edges' +
      ' (extraction-time): inbound lookup fields that point at this object appear' +
      ' in this slice when the vault has them. If you expected inbound' +
      ' relationships and see none, the vault may predate `lookupTo` — re-run' +
      ' `/sfi-refresh`; the field-level `referenceTo` is also surfaced by' +
      ' `sfi.field_360` / `sfi.generate_data_dictionary`.'
    : '';

  if (params.truncated) {
    const cap = params.byteTrimmed
      ? `trimmed to fit the ~${Math.round(GRAPH_MAX_PAYLOAD_BYTES / 1000)} KB response budget`
      : `capped at ${IMPACT_MAX_NODES} nodes / ${IMPACT_MAX_EDGES} edges`;
    return (
      `Impact slice ${cap} and TRUNCATED: ` +
      `\`${params.componentId}\` is a hub or has a wide dependency fan-in (${countSummary}; ` +
      `estimated JSON payload ${payloadLabel}).${slimNote} ` +
      `Re-query with fewer hops or a narrower edgeTypes filter for a complete view.` +
      lookupCaveat
    );
  }

  if (payloadLarge) {
    const heavyNote = heavy !== null ? ` Dominated by ${heavy}.` : '';
    return (
      `Impact slice within ${params.hops} hop(s): ${countSummary} (within count cap), ` +
      `but estimated JSON payload is still ${payloadLabel} after per-node slimming.${heavyNote}${slimNote} ` +
      `Re-query with fewer hops or edgeTypes excluding grantedBy to shrink the response.` +
      lookupCaveat
    );
  }

  return (
    `Complete impact slice within ${params.hops} hop(s): ${countSummary} under the ` +
    `${IMPACT_MAX_NODES}-node / ${IMPACT_MAX_EDGES}-edge cap; estimated JSON payload ${payloadLabel}.${slimNote}` +
    lookupCaveat
  );
};

/**
 * Expand one BFS level: for every node in `frontier`, fetch its
 * incoming edges (optionally filtered by `edgeTypes`) and return the
 * `fromId`s that have not yet been visited. Visited sets and edge
 * collector are mutated in place to keep the recursion cheap.
 *
 * CR-17: the per-node incoming edges are fetched in ONE batched
 * `listEdgesForNodes` query for the whole frontier (was an N+1 loop of
 * `listEdges` per node × edgeType). The returned buckets are then replayed in
 * the IDENTICAL visit order the row-at-a-time loop used — outer loop over
 * `frontier` in order, inner loop over `edgeTypes ?? [null]` in order, and
 * within each `(node, edgeType)` group the bucket's deterministic
 * `(toId, edgeType, fromId, source)` order — so the cap/dedup/next-push logic
 * produces the same visited set, the same `collectedEdges`, the same
 * `truncated` flag, and the same `next` frontier as before.
 */
const expandIncoming = async (
  ctx: Context,
  frontier: readonly ComponentId[],
  edgeTypes: readonly EdgeType[] | null,
  visitedNodes: Set<ComponentId>,
  visitedEdges: Set<string>,
  collectedEdges: Edge[],
  traversedTypes: Set<EdgeType>,
): Promise<{
  next: readonly ComponentId[];
  error: string | null;
  truncated: boolean;
}> => {
  // One round-trip fetches every frontier node's incoming edges; the helper
  // restricts to `edgeTypes` (a batched `edge_type IN (...)`) reproducing the
  // union of the old per-`(node, edgeType)` calls, and partitions per node so
  // the replay below can walk each node's bucket in the same admission order.
  const batched = await listEdgesForNodes(ctx.graph, frontier, {
    direction: 'in',
    ...(edgeTypes !== null ? { edgeTypes } : {}),
  });
  if (!batched.ok) {
    return { next: [], error: batched.error.message, truncated: false };
  }

  const next: ComponentId[] = [];
  let truncated = false;
  for (const nodeId of frontier) {
    if (visitedNodes.size >= IMPACT_MAX_NODES || collectedEdges.length >= IMPACT_MAX_EDGES) {
      truncated = true;
      break;
    }
    const bucket = batched.value.get(nodeId) ?? [];
    // Replay the old `edgeTypes ?? [null]` inner loop. `null` = a single pass
    // over the whole bucket (all types); otherwise one pass per requested type,
    // each filtered to that type — exactly as the per-call `listEdges(edgeType)`
    // loop decomposed it, and in the same order.
    const filters = edgeTypes ?? [null];
    for (const edgeType of filters) {
      const groupEdges =
        edgeType === null ? bucket : bucket.filter((e) => e.edgeType === edgeType);
      for (const edge of groupEdges) {
        if (collectedEdges.length >= IMPACT_MAX_EDGES) {
          truncated = true;
          break;
        }
        const key = edgeKey(edge);
        if (!visitedEdges.has(key)) {
          visitedEdges.add(key);
          collectedEdges.push(edge);
          traversedTypes.add(edge.edgeType);
        }
        if (!visitedNodes.has(edge.fromId)) {
          if (visitedNodes.size >= IMPACT_MAX_NODES) {
            truncated = true;
            break;
          }
          visitedNodes.add(edge.fromId);
          next.push(edge.fromId);
        }
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  return { next, error: null, truncated };
};

/**
 * Fetch the `Node` records for every id in `ids`. Missing rows are
 * dropped silently — the graph can be sparser than the edge table
 * (an edge can reference an id that does not have a corresponding
 * node row, e.g., when only one half of a dependency was extracted).
 *
 * CR-17: batched into ONE `listNodesByIds` query (was an N+1 loop of
 * `getNodeById` per id). This sub-change is PROVABLY identical to the old
 * loop: the inputs are pre-sorted + capped (`[...visitedNodes].sort().slice`),
 * the absent-id drop matches `WHERE id IN (...)` returning no row, and the
 * caller re-sorts the result by id — so output order is unaffected. Unlike the
 * order-sensitive BFS edge walk above, nothing here depends on row order.
 */
const fetchNodes = async (
  ctx: Context,
  ids: readonly ComponentId[],
): Promise<Result<readonly Node[], string>> => {
  const result = await listNodesByIds(ctx.graph, ids);
  if (!result.ok) {
    return err(result.error.message);
  }
  return ok(result.value);
};

/**
 * The `sfi.get_impact` MCP tool. Returns the BFS-reachable slice that
 * *depends on* `componentId`, walking INCOMING edges up to `hops`
 * traversals (default 2, max 3). Optional `edgeTypes` narrows the
 * walk to specific dependency kinds.
 *
 * @example
 *   const r = await getImpactHandler(ctx, {
 *     componentId: 'CustomField:Account.Industry__c',
 *     hops: 2,
 *     edgeTypes: ['references', 'readsFrom'],
 *   });
 *   if (r.ok) console.log(r.value.data.impact.nodes.length);
 */
export const getImpactHandler = async (
  ctx: Context,
  input: GetImpactInput,
): Promise<Result<McpResponse<GetImpactOutput>, McpError>> => {
  const hops = input.hops ?? IMPACT_DEFAULT_HOPS;
  const edgeTypes =
    input.edgeTypes !== undefined && input.edgeTypes.length > 0
      ? input.edgeTypes
      : null;

  const rootId = input.componentId as ComponentId;
  // P14-PHANTOM-edges: an un-type-resolved Apex receiver id
  // (`CustomField:app.Id`, `ApexClass:oldMap`) is a heuristic-scanner parse
  // artifact, not a component — walking "what depends on it" would dress the
  // artifact's incoming parse edges up as a real blast radius. Refuse with
  // the honest classification instead. GRF-01: when the vault holds a real
  // node at this id (e.g. `ApexClass:pkb_Controller`), allow the walk.
  if (isUnresolvedFieldReceiver(rootId) || isUnresolvedApexCallTarget(rootId)) {
    const rootProbe = await getNodeById(ctx.graph, rootId);
    if (!rootProbe.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${rootProbe.error.message}`,
      });
    }
    const vaulted =
      rootProbe.value !== null &&
      (rootProbe.value.type === 'ApexClass' ||
        rootProbe.value.type === 'ApexTrigger' ||
        rootProbe.value.type === 'CustomField');
    if (!vaulted) {
      return err({
        kind: 'invalid-query',
        message:
          `\`${rootId}\` is an un-type-resolved Apex receiver (a heuristic-scanner parse artifact keyed on a local variable / context handle), not a real component — impact analysis would be meaningless. Resolve the variable's declared type and ask about that component instead.`,
        path: 'componentId',
      });
    }
  }
  const visitedNodes = new Set<ComponentId>([rootId]);
  const visitedEdges = new Set<string>();
  const collectedEdges: Edge[] = [];
  const traversedTypes = new Set<EdgeType>();

  let frontier: readonly ComponentId[] = [rootId];
  let truncated = false;
  for (let hop = 0; hop < hops && frontier.length > 0 && !truncated; hop++) {
    const expanded = await expandIncoming(
      ctx,
      frontier,
      edgeTypes,
      visitedNodes,
      visitedEdges,
      collectedEdges,
      traversedTypes,
    );
    if (expanded.error !== null) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${expanded.error}`,
      });
    }
    if (expanded.truncated) {
      truncated = true;
      break;
    }
    frontier = expanded.next;
  }

  const nodeIds = [...visitedNodes].sort().slice(0, IMPACT_MAX_NODES);
  if (visitedNodes.size > IMPACT_MAX_NODES) {
    truncated = true;
  }
  const edgesCapped = [...collectedEdges].sort(compareEdges).slice(0, IMPACT_MAX_EDGES);
  if (collectedEdges.length > IMPACT_MAX_EDGES) {
    truncated = true;
  }

  const nodesResult = await fetchNodes(ctx, nodeIds);
  if (!nodesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodesResult.error}`,
    });
  }
  const sortedNodes = [...nodesResult.value].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  // Bound per-node payload (the node/edge count caps don't): summarise
  // any oversized property value (Profile grant matrices etc.).
  // Soundness from the FULL (pre-slim) nodes so the dynamic-apex signal in
  // properties.qualityIssues is read intact, before payload slimming.
  const soundness = soundnessFromNodes(sortedNodes);
  const { nodes: slimNodes, slimmedCount } = slimGraphNodes(sortedNodes);
  // Per-node slimming bounds fat properties but not the slice total; enforce a
  // hard byte budget so the response always fits the MCP client's token limit.
  const budgeted = enforceGraphPayloadBudget(rootId, slimNodes, edgesCapped);
  const finalTruncated = truncated || budgeted.trimmed;
  const sortedTypes = [...traversedTypes].sort();
  const impact = { nodes: budgeted.nodes, edges: budgeted.edges };
  const estimatedPayloadBytes = estimateGraphPayloadBytes(impact);
  const disclosure = buildImpactDisclosure({
    componentId: input.componentId,
    rootIsObject: rootId.startsWith('CustomObject:'),
    hops,
    truncated: finalTruncated,
    nodeCount: budgeted.nodes.length,
    edgeCount: budgeted.edges.length,
    payloadBytes: estimatedPayloadBytes,
    nodes: budgeted.nodes,
    edges: budgeted.edges,
    slimmedCount,
    byteTrimmed: budgeted.trimmed,
  });

  // I3b (empty ≠ none): an impact walk with NO dependent edges is exactly where
  // "nothing depends on this" is dangerous — name the dependency families the
  // vault did NOT fully retrieve so the host discloses the boundary. Keyed on
  // the edge set (the root node is always present, so node count is not the
  // emptiness signal). Non-empty impact slices are untouched.
  const coverageCaveat =
    budgeted.edges.length === 0
      ? buildEmptyTraversalCoverageCaveat(ctx, GRAPH_TRAVERSAL_REQUIRED_COVERAGE)
      : undefined;

  const truncationReason = finalTruncated
    ? {
        reason: budgeted.trimmed
          ? ('payload-budget' as const)
          : budgeted.edges.length >= IMPACT_MAX_EDGES
            ? ('edge-cap' as const)
            : ('node-cap' as const),
        nodeCap: IMPACT_MAX_NODES,
        edgeCap: IMPACT_MAX_EDGES,
        payloadByteBudget: GRAPH_MAX_PAYLOAD_BYTES,
        returnedNodes: budgeted.nodes.length,
        returnedEdges: budgeted.edges.length,
        remedy:
          'Impact slice is PARTIAL. Re-query with fewer `hops` or a narrower `edgeTypes` filter for a complete view of this hub.',
      }
    : undefined;

  return ok({
    data: {
      impact,
      traversedEdgeTypes: sortedTypes,
      truncated: finalTruncated,
      ...(truncationReason !== undefined ? { truncationReason } : {}),
      estimatedPayloadBytes,
      payloadSlimmed: slimmedCount > 0,
      soundness,
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
      disclosure,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
