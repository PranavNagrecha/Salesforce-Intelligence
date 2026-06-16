/**
 * Handler for the `sfi.get_subgraph` MCP tool.
 *
 * Surfaces the graph layer's `getSubgraph` BFS through the MCP envelope.
 * Returns the connected slice of nodes and edges reachable from `rootId`
 * within `hops` traversals (default 1, max 3). Unknown rootIds resolve to
 * an empty subgraph (`truncated: false`) — `graph.getSubgraph` cannot
 * distinguish "missing root" from "root with no incident edges", and either
 * is a valid empty subgraph for this tool. Out-of-range `hops` values
 * (`<1` or `>3`) are rejected at the Zod boundary so callers learn
 * `invalid-query` rather than receiving an unexpectedly truncated or
 * over-broad slice. Output is size-bounded independently of `hops`: a hub
 * node is clipped to a deterministic prefix with `truncated: true` and a
 * `disclosure` explaining the partial result, rather than returning a
 * multi-megabyte response.
 */

import type {
  ComponentId,
  Edge,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getSubgraph } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  enforceGraphPayloadBudget,
  estimateGraphPayloadBytes,
  GRAPH_MAX_PAYLOAD_BYTES,
  slimGraphNodes,
} from './graph-payload-bounds.js';

/**
 * Inclusive upper bound on `hops`. Mirrored from
 * `graph.getSubgraph`'s `SUBGRAPH_MAX_HOPS` so the Zod boundary rejects
 * the request before the graph layer has to. Drift between the two is a
 * code-review concern.
 */
const SUBGRAPH_MAX_HOPS = 3;

/**
 * Default `hops` value when the caller omits it. Applied in the handler
 * rather than via `z.default()` so the parsed input type stays
 * `hops?: number | undefined` — keeping the optional-property contract
 * consistent with the other tools in this package.
 */
const SUBGRAPH_DEFAULT_HOPS = 1;

/**
 * Mirrored from `graph.getSubgraph`'s `SUBGRAPH_MAX_NODES` /
 * `SUBGRAPH_MAX_EDGES` for the disclosure wording only — enforcement lives in
 * the graph layer. Drift here makes the disclosure text wrong (not the
 * behavior); a code-review concern.
 */
const SUBGRAPH_MAX_NODES = 200;
const SUBGRAPH_MAX_EDGES = 400;

/**
 * Zod schema for the `sfi.get_subgraph` tool input.
 *
 *   - `rootId`: required, non-empty string. Unknown ids surface as an
 *     empty subgraph, not a Zod-level rejection.
 *   - `hops`: optional integer in `[1, 3]`. Defaults to 1 inside the
 *     handler when omitted. Values outside the range are rejected here.
 */
export const getSubgraphInputSchema = z.object({
  rootId: z.string().min(1),
  hops: z.number().int().min(1).max(SUBGRAPH_MAX_HOPS).optional(),
});

/** Parsed input shape, inferred from `getSubgraphInputSchema`. */
export type GetSubgraphInput = z.infer<typeof getSubgraphInputSchema>;

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface GetSubgraphOutput {
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
  /**
   * True when the graph layer's node/edge caps clipped the slice (the root is
   * a hub). The nodes/edges are then a deterministic prefix, not the full
   * neighbourhood — see `disclosure`.
   */
  readonly truncated: boolean;
  /** Verbatim honesty note about the size caps and, when truncated, the clipping. */
  readonly disclosure: string;
}

/**
 * The `sfi.get_subgraph` MCP tool. Returns the BFS-reachable slice of the
 * graph from `rootId`, capped at `hops` traversals (default 1, max 3).
 * Sort order is inherited from `graph.getSubgraph` (nodes by id ascending,
 * edges by `(fromId, toId, edgeType, source)`); this handler does not
 * re-sort.
 *
 * @example
 *   const r = await getSubgraphHandler(ctx, {
 *     rootId: 'CustomObject:Account',
 *     hops: 2,
 *   });
 *   if (r.ok) console.log(r.value.data.nodes.length, r.value.data.edges.length);
 */
export const getSubgraphHandler = async (
  ctx: Context,
  input: GetSubgraphInput,
): Promise<Result<McpResponse<GetSubgraphOutput>, McpError>> => {
  const hops = input.hops ?? SUBGRAPH_DEFAULT_HOPS;

  const queryResult = await getSubgraph(
    ctx.graph,
    input.rootId as ComponentId,
    hops,
  );

  if (!queryResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${queryResult.error.message}`,
    });
  }

  // `queryResult.value` is the graph layer's `Subgraph` (nodes + edges +
  // truncated). The count caps live in the graph layer; this handler adds the
  // per-node slim + hard BYTE budget (count caps bound node/edge COUNT, not
  // serialized bytes — a 200-node hub of fat grant matrices is ~500 KB, which
  // the MCP client rejects outright) plus the human-facing `disclosure`.
  const sub = queryResult.value;
  const { nodes: slimmed, slimmedCount } = slimGraphNodes(sub.nodes);
  const budgeted = enforceGraphPayloadBudget(
    input.rootId as ComponentId,
    slimmed,
    sub.edges,
  );
  const truncated = sub.truncated || budgeted.trimmed;
  const payloadBytes = estimateGraphPayloadBytes({
    nodes: budgeted.nodes,
    edges: budgeted.edges,
  });
  const slimNote =
    slimmedCount > 0
      ? ` ${slimmedCount} node(s) had an oversized property value (e.g. Profile/PermissionSet grant matrices) summarised to an \`{__omitted}\` marker — fetch the full node with \`sfi.get_component\`.`
      : '';
  const disclosure = budgeted.trimmed
    ? `Subgraph trimmed to fit the ~${Math.round(GRAPH_MAX_PAYLOAD_BYTES / 1000)} KB response budget and TRUNCATED: \`${input.rootId}\` is a hub (estimated JSON payload ~${Math.round(payloadBytes / 1000)} KB after slimming), so this is a partial, deterministic slice (lowest ids first), NOT its full neighbourhood.${slimNote} Re-query with a smaller \`hops\` or a more specific root for a complete view.`
    : sub.truncated
      ? `Subgraph capped at ${SUBGRAPH_MAX_NODES} nodes / ${SUBGRAPH_MAX_EDGES} edges and TRUNCATED: \`${input.rootId}\` is a hub, so this is a partial, deterministic slice (lowest ids first), NOT its full neighbourhood.${slimNote} Re-query with a smaller \`hops\` or a more specific root for a complete view.`
      : `Complete subgraph within ${hops} hop(s); under the ${SUBGRAPH_MAX_NODES}-node / ${SUBGRAPH_MAX_EDGES}-edge cap.${slimNote}`;

  return ok({
    data: {
      nodes: budgeted.nodes,
      edges: budgeted.edges,
      truncated,
      disclosure,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
