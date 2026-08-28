/**
 * Handler for the `sfi.get_edges` MCP tool.
 *
 * Surfaces the graph layer's `listEdges` query through the MCP envelope.
 * Lists edges incident to a node, optionally narrowed by direction, edge
 * type, and confidence, and PAGED by `limit`/`offset` (with `totalCount` /
 * `hasMore` / `nextOffset`) so a hub node's edge set can't overflow the
 * response — the paging is applied here, NOT in `listEdges`, whose full result
 * the analysis tools depend on. A whole-empty result (`totalCount === 0`)
 * resolves the node ONCE (`getNodeById`) to tell "no node with this id"
 * apart from "node exists but is isolated" — the graph CAN distinguish the
 * two, so an unknown/mistyped/phantom id gets `nodeNotFound` (phantom-aware,
 * via `phantom-node.ts`) instead of a `coverageCaveat` that misattributes the
 * emptiness to a retrieve gap and points the caller at a refresh that can
 * never manufacture a node for a bad id. Malformed inputs (unknown
 * `edgeType`, unknown `direction`, unknown `confidence`) are rejected at the
 * Zod boundary, so callers learn `invalid-query` instead of receiving a
 * silently-empty list.
 */

import {
  EDGE_TYPES,
  UNPRODUCED_EDGE_TYPES,
  type ComponentId,
  type ConfidenceLevel,
  type Edge,
  type McpError,
  type McpResponse,
  type PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  buildEmptyTraversalCoverageCaveat,
  type CoverageCaveat,
  GRAPH_TRAVERSAL_REQUIRED_COVERAGE,
} from './coverage-trust.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';

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
 *     empty edge list (with `nodeNotFound` set), not a Zod-level rejection.
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

/**
 * Derive a human type label from a canonical id's `Type:` prefix, for
 * `phantomAwareNotFoundMessage`'s `kindLabel` argument. `get_edges` accepts
 * ANY node type (not one fixed kind like most `phantomAwareNotFoundMessage`
 * callers), so the label is read off the id itself; a malformed id with no
 * colon falls back to the generic `'component'`.
 */
const kindLabelFromNodeId = (id: string): string => {
  const colon = id.indexOf(':');
  return colon > 0 ? id.slice(0, colon) : 'component';
};

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
  /**
   * Present ONLY when the caller filtered on an edge type that NO extractor
   * produces (`UNPRODUCED_EDGE_TYPES`). Such a query is guaranteed to return
   * `[]`, and without this the empty result reads as a proven "nothing has
   * this relationship" when the truth is "this relationship is never recorded".
   *
   * Distinct from `coverageCaveat`, which reports a family this VAULT did not
   * retrieve — a gap a refresh can close. This one cannot be closed by any
   * refresh on any org, because the producer does not exist in the product.
   */
  readonly unproducedEdgeType?: string;
  /**
   * Present ONLY when `totalCount === 0` AND `nodeId` itself resolves to no
   * node in this vault — a typo, a wrong-case id, or a component this org
   * references but never retrieved (a managed-package phantom). Carries the
   * `phantomAwareNotFoundMessage` verdict, which distinguishes "genuinely
   * unknown" from "referenced but not retrieved" and names the reference
   * count for the latter. Mutually exclusive with `coverageCaveat`: when the
   * node itself is not found, blaming an un-retrieved dependency FAMILY for
   * the empty edge list would be wrong (no refresh manufactures a node for a
   * bad id), so this replaces it instead of stacking beside it. Absent when
   * the node resolves (whether it has edges or is legitimately isolated).
   */
  readonly nodeNotFound?: string;
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

  // I3b (empty ≠ none), split by WHICH kind of empty this is: only when the
  // whole edge set is empty do we risk the host reading "no edges" as a
  // proven "nothing depends on this" — but the graph CAN tell "node exists,
  // legitimately isolated" apart from "no such node", so resolve it once
  // here rather than blaming a retrieve-coverage gap for both alike.
  let coverageCaveat: CoverageCaveat | undefined;
  let nodeNotFound: string | undefined;
  if (paged.totalCount === 0) {
    const nodeLookup = await getNodeById(ctx.graph, input.nodeId as ComponentId);
    if (!nodeLookup.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${nodeLookup.error.message}`,
      });
    }
    if (nodeLookup.value === null) {
      // Not a node in this vault at all: typo, wrong case, or a phantom
      // (referenced but never retrieved). `phantomAwareNotFoundMessage`
      // tells the two apart and names the reference count for the latter —
      // strictly more honest than a generic "family wasn't retrieved"
      // caveat, which would send the caller to re-run a refresh that can
      // never produce a node for a bad id.
      nodeNotFound = await phantomAwareNotFoundMessage(
        ctx,
        input.nodeId as ComponentId,
        kindLabelFromNodeId(input.nodeId),
      );
    } else {
      // The node IS in the vault and genuinely has no incident edges — the
      // "isolated" read is legitimate, so the coverage caveat about
      // un-retrieved dependency families applies here as before.
      coverageCaveat = buildEmptyTraversalCoverageCaveat(ctx, GRAPH_TRAVERSAL_REQUIRED_COVERAGE);
    }
  }

  // Same "empty ≠ none" hazard, different and more absolute cause: the caller
  // asked for an edge type the product NEVER emits, so `[]` is structurally
  // guaranteed and no refresh can change it. Emitted only when that filter was
  // actually used, so every other response stays byte-identical.
  const unproducedEdgeType =
    input.edgeType !== undefined &&
    (UNPRODUCED_EDGE_TYPES as readonly string[]).includes(input.edgeType)
      ? `\`${input.edgeType}\` is a DECLARED edge type that NO extractor in this ` +
        `product emits, so this result is EMPTY BY CONSTRUCTION — it is not ` +
        `evidence that no such relationship exists. Read it as "this ` +
        `relationship is never recorded", never as "there is none". Unlike a ` +
        `coverage gap, re-running \`sfi refresh\` on any org cannot populate it.`
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
      ...(unproducedEdgeType !== undefined ? { unproducedEdgeType } : {}),
      ...(nodeNotFound !== undefined ? { nodeNotFound } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
