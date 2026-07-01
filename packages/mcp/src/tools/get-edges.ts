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
  type PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  buildEmptyTraversalCoverageCaveat,
  type CoverageCaveat,
  GRAPH_TRAVERSAL_REQUIRED_COVERAGE,
} from './coverage-trust.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';

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
  // CR-22 continuation cursor: an OPAQUE token echoed back from a prior
  // truncated page's `nextCursor`. When present it supplies the resume offset;
  // omitting it = today's behavior (offset 0 / explicit `offset`).
  cursor: z.string().min(1).optional(),
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
  /** Approximate next offset (legacy), or `null` when the list is exhausted. */
  readonly nextOffset: number | null;
  /**
   * CR-22 opaque continuation token, present ONLY when this page was truncated
   * (over `limit` OR over the byte budget). Echo it back as `cursor` to resume.
   * Absent on a whole-fits page so an in-budget response stays byte-identical.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
  /** Present only when the page was byte-trimmed below `limit` to fit the budget. */
  readonly note?: string;
  /**
   * I3b (empty ≠ none): present ONLY when the WHOLE edge set is empty
   * (`totalCount === 0`) AND a dependency family that would incident an edge on
   * this node is NOT fully covered by the vault. Names the not-checked families
   * so an empty edge list reads "not retrieved", not a proven "no edges". Absent
   * when edges exist or the vault is fully covered (byte-identical to before).
   */
  readonly coverageCaveat?: CoverageCaveat;
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

  // Resolve the resume offset: an echoed CR-22 cursor wins over an explicit
  // `offset`; ANY stale/forged cursor (wrong tool/vault/filters) is rejected
  // with `invalid-query` rather than silently paging the wrong result set.
  const fingerprint = argsFingerprint({
    nodeId: input.nodeId,
    ...(input.direction !== undefined ? { direction: input.direction } : {}),
    ...(input.edgeType !== undefined ? { edgeType: input.edgeType } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
  });
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: 'sfi.get_edges',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  // Page the result so a hub node can't overflow the response. `listEdges`
  // returns the full (filtered) list (now in a stable total order) — capping it
  // there would starve the analysis tools that depend on the complete edge set;
  // the paging is a presentation concern, so it lives here.
  const limit = input.limit ?? GET_EDGES_DEFAULT_LIMIT;
  const paged = paginateLegacy(queryResult.value, {
    offset,
    limit,
    byteBudget: GET_EDGES_BYTE_BUDGET,
    binding: {
      tool: 'sfi.get_edges',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });

  // The `note` (and `nextCursor`/`pageInfo`) are emitted ONLY on a byte-trimmed
  // page, so an in-budget response is byte-identical to the pre-CR-22 shape.
  const note = paged.byteTrimmed
    ? `Page byte-trimmed to ${paged.items.length} of the requested ${limit} edge(s) to ` +
      `stay under the ~45 KB MCP response limit. Advance with the returned nextCursor ` +
      `(or offset=${paged.nextOffset ?? paged.totalCount}), ` +
      `or narrow with edgeType/direction/confidence.`
    : undefined;
  // Emit the cursor block only when truncated (byte-trim OR over limit), i.e.
  // exactly when `paginateLegacy` produced a non-null nextCursor.
  const emitCursor = paged.nextCursor !== null;

  // I3b (empty ≠ none): only when the WHOLE edge set is empty do we risk the
  // host reading "no edges" as a proven "nothing depends on this" — attach a
  // coverage caveat naming the dependency families the vault did NOT fully
  // retrieve. Non-empty pages are untouched.
  const coverageCaveat =
    paged.totalCount === 0
      ? buildEmptyTraversalCoverageCaveat(ctx, GRAPH_TRAVERSAL_REQUIRED_COVERAGE)
      : undefined;

  return ok({
    data: {
      edges: paged.items,
      totalCount: paged.totalCount,
      hasMore: paged.hasMore,
      nextOffset: paged.nextOffset,
      ...(emitCursor ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo } : {}),
      ...(note !== undefined ? { note } : {}),
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
