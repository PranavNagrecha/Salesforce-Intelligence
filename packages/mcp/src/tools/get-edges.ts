/**
 * Handler for the `sfi.get_edges` MCP tool.
 *
 * Surfaces the graph layer's `listEdges` query through the MCP envelope.
 * Lists edges incident to a node, optionally narrowed by direction, edge
 * type, and confidence, and PAGED by `limit`/`offset` (with `totalCount` /
 * `hasMore` / `nextOffset`) so a hub node's edge set can't overflow the
 * response — the paging is applied here, NOT in `listEdges`, whose full result
 * the analysis tools depend on. Unknown nodeIds resolve to `ok({ edges: [] })` —
 * the graph cannot distinguish "no node" from "node exists but is
 * isolated", and either is a valid empty result for this tool. Malformed
 * inputs (unknown `edgeType`, unknown `direction`, unknown `confidence`)
 * are rejected at the Zod boundary, so callers learn `invalid-query`
 * instead of receiving a silently-empty list.
 */

import {
  EDGE_TYPES,
  type ConfidenceLevel,
  type Edge,
  type McpError,
  type McpResponse,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

/**
 * The `ConfidenceLevel` values declared by `@sf-intelligence/contracts`.
 * Duplicated so Zod validates against a real enum rather than `z.string()`
 * (a typo earns `invalid-query` instead of an empty list). The `EdgeType`
 * enum is now sourced directly from the contracts `EDGE_TYPES` tuple (above,
 * imported) so it cannot drift; this small 3-value set is kept inline.
 */
const CONFIDENCE_LEVELS = [
  'declared',
  'parsed',
  'heuristic',
] as const satisfies readonly ConfidenceLevel[];

/**
 * Default page size for the edge list. A hub node (e.g. a standard object with
 * thousands of `grantedBy` FLS edges) has far more edges than fit in one MCP
 * response, so `get_edges` pages like the other enumerators rather than
 * returning everything and tripping the global ~45 KB guard with no recourse.
 */
const GET_EDGES_DEFAULT_LIMIT = 200;
/** Hard cap on a single page. */
const GET_EDGES_MAX_LIMIT = 1000;
/**
 * Per-response byte budget for the `edges` slice, leaving headroom under the
 * global `MAX_RESPONSE_BYTES` (~45 KB) for the envelope + counts. Even a
 * limited page can overflow when edges carry fat `properties_json`, so the
 * slice is trimmed to fit. Mirrors the budget the other paginated tools use.
 */
const GET_EDGES_BYTE_BUDGET = 38_000;

/**
 * Zod schema for the `sfi.get_edges` tool input.
 *
 *   - `nodeId`: required, non-empty string. Unknown ids surface as an
 *     empty edge list, not a Zod-level rejection.
 *   - `direction`: optional; one of `'in' | 'out' | 'both'`. The longer
 *     `'incoming'` / `'outgoing'` forms (used in some docs/clients) are
 *     accepted and normalized. Defaults to `'both'` inside
 *     `graph.listEdges` when omitted.
 *   - `edgeType`: optional; one of the `EdgeType` values (incl. `dispatchesOmniAction`).
 *   - `confidence`: optional; one of the 3 `ConfidenceLevel` values.
 */
export const getEdgesInputSchema = z.object({
  nodeId: z.string().min(1),
  direction: z
    .preprocess(
      (v) => (v === 'incoming' ? 'in' : v === 'outgoing' ? 'out' : v),
      z.enum(['in', 'out', 'both']),
    )
    .optional(),
  edgeType: z.enum(EDGE_TYPES).optional(),
  confidence: z.enum(CONFIDENCE_LEVELS).optional(),
  limit: z.number().int().positive().max(GET_EDGES_MAX_LIMIT).optional(),
  offset: z.number().int().nonnegative().optional(),
});

/** Parsed input shape, inferred from `getEdgesInputSchema`. */
export type GetEdgesInput = z.infer<typeof getEdgesInputSchema>;

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface GetEdgesOutput {
  /** The requested page of edges (after `direction`/`edgeType`/`confidence`). */
  readonly edges: readonly Edge[];
  /** Total edges matching the filters BEFORE `limit`/`offset` paging. */
  readonly totalCount: number;
  /** True when more edges remain past this page. */
  readonly hasMore: boolean;
  /** Cursor for the next page, or `null` when the list is exhausted. */
  readonly nextOffset: number | null;
  /** Present only when the page was byte-trimmed below `limit` to fit the budget. */
  readonly note?: string;
}

/**
 * The `sfi.get_edges` MCP tool. Returns the edges incident to a node,
 * filtered by the optional `direction`, `edgeType`, and `confidence`
 * arguments. Sort order is inherited from `graph.listEdges`
 * (`to_id ASC, edge_type ASC`); this handler does not re-sort.
 *
 * @example
 *   const r = await getEdgesHandler(ctx, {
 *     nodeId: 'CustomObject:Account',
 *     direction: 'out',
 *     edgeType: 'parentOf',
 *   });
 *   if (r.ok) console.log(r.value.data.edges.length);
 */
export const getEdgesHandler = async (
  ctx: Context,
  input: GetEdgesInput,
): Promise<Result<McpResponse<GetEdgesOutput>, McpError>> => {
  // Build the options object explicitly so `exactOptionalPropertyTypes`
  // does not see `undefined` assigned to optional fields.
  const queryResult = await listEdges(ctx.graph, input.nodeId, {
    ...(input.direction !== undefined ? { direction: input.direction } : {}),
    ...(input.edgeType !== undefined ? { edgeType: input.edgeType } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
  });

  if (!queryResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${queryResult.error.message}`,
    });
  }

  // Page the result so a hub node can't overflow the response. `listEdges`
  // returns the full (filtered) list — capping it there would starve the
  // analysis tools that depend on the complete edge set; the paging is a
  // presentation concern, so it lives here.
  const all = queryResult.value;
  const total = all.length;
  const offset = input.offset ?? 0;
  const limit = input.limit ?? GET_EDGES_DEFAULT_LIMIT;
  let page = all.slice(offset, offset + limit);

  // Byte-budget backstop: even a limited page can exceed the budget when edges
  // carry fat properties, so trim trailing edges until the slice fits.
  let trimmed = false;
  while (
    page.length > 1 &&
    Buffer.byteLength(JSON.stringify(page), 'utf8') > GET_EDGES_BYTE_BUDGET
  ) {
    page = page.slice(0, -1);
    trimmed = true;
  }

  const returned = offset + page.length;
  const hasMore = returned < total;
  const note = trimmed
    ? `Page byte-trimmed to ${page.length} of the requested ${limit} edge(s) to ` +
      `stay under the ~45 KB MCP response limit. Advance with offset=${returned}, ` +
      `or narrow with edgeType/direction/confidence.`
    : undefined;

  return ok({
    data: {
      edges: page,
      totalCount: total,
      hasMore,
      nextOffset: hasMore ? returned : null,
      ...(note !== undefined ? { note } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
