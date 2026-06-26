/**
 * Handler for the `sfi.find_formula_references` MCP tool.
 *
 * Sharp-focus variant of `sfi.get_impact`. Answers "which formulas (and
 * other formula-tokenizer-emitted references) point at this field?" by
 * listing the incoming `references` edges to `fieldId` and surfacing
 * each referencer's identity along with the edge's properties (which
 * include `tokenizedFromField`, `formulaLength`, etc.).
 *
 * Implementation notes:
 *   - One `listEdges(fieldId, { direction: 'in', edgeType: 'references' })`
 *     call retrieves every candidate edge; `getNodeById` then resolves
 *     each `fromId` to a `Node`. The graph cannot distinguish "field
 *     does not exist" from "field has no incoming references", and
 *     either is a valid empty result.
 *   - The output's `source` and `properties` come from the EDGE, not
 *     the referencer node. That is the architect's intent: the edge
 *     carries the tokenizer's per-reference metadata
 *     (`tokenizedFromField`, `formulaLength`) that distinguishes a
 *     formula reference from a metadata-dependency reference.
 *   - Sort: by `id` ASC for deterministic output. `limit` is applied
 *     after sorting so the truncation is stable across runs.
 */

import type {
  ComponentId,
  ComponentType,
  Edge,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { resolveToFieldOrSuggest } from './resolve-field-or-suggest.js';

/**
 * Inclusive upper bound on `limit`. Mirrors the `LIST_MAX_LIMIT`
 * convention from `graph.listNodesByType` so all enumeration-style
 * tools share the same ceiling.
 */
const FORMULA_REFS_MAX_LIMIT = 500;

/**
 * Default `limit` when the caller omits it. Set to 50 because real
 * fields rarely have more than a handful of formula references, and
 * the architect almost always wants the full list rather than a
 * paginated slice.
 */
const FORMULA_REFS_DEFAULT_LIMIT = 50;

/**
 * Zod schema for the `sfi.find_formula_references` tool input.
 *
 *   - `fieldId`: required, non-empty string. Unknown ids surface as
 *     an empty referencers list, not a Zod-level rejection.
 *   - `limit`: optional integer in `[1, 500]`. Defaults to 50 inside
 *     the handler when omitted.
 */
export const findFormulaReferencesInputSchema = z.object({
  fieldId: z.string().min(1),
  limit: z.number().int().min(1).max(FORMULA_REFS_MAX_LIMIT).optional(),
  /**
   * Zero-based page offset (CR-13). Defaults to 0. Paired with `limit` so the
   * caller can walk the FULL referencer set when the result is truncated — a
   * blast-radius tool must never silently drop referencers.
   */
  offset: z.number().int().nonnegative().optional(),
});

/** Parsed input shape, inferred from `findFormulaReferencesInputSchema`. */
export type FindFormulaReferencesInput = z.infer<
  typeof findFormulaReferencesInputSchema
>;

/**
 * One referencer in the output list. Combines the source node's
 * identity (`id`, `type`, `apiName`) with the edge's metadata
 * (`source`, `properties`). The edge metadata is what differentiates a
 * formula-tokenizer reference from, say, a metadata-dependency
 * reference of the same edge type.
 */
export interface FormulaReferencer {
  readonly id: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  readonly source: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

/**
 * Payload wrapped inside the `McpResponse` envelope on success.
 *
 * The pagination counters (`totalCount`/`offset`/`limit`/`hasMore`/
 * `nextOffset`) and the truncation `note` are OPTIONAL because the
 * graceful object→field suggestion early-return (`resolveToFieldOrSuggest`)
 * casts a DIFFERENT suggestion envelope onto this type — it has no
 * referencer list to page, so it carries none of these fields. The
 * normal path always populates the counters; the suggestion path never
 * does.
 */
export interface FindFormulaReferencesOutput {
  /** The requested page of referencers (after sort + `offset`/`limit`). */
  readonly referencers: readonly FormulaReferencer[];
  /**
   * CR-13 truncation honesty: the TRUE total number of referencers BEFORE
   * `offset`/`limit` paging (post sparse-graph-miss filtering — every
   * returnable referencer, not a raw edge count). Greater than
   * `referencers.length` means the page is a partial slice; `note` discloses it.
   */
  readonly totalCount?: number;
  /** Zero-based offset of this page. */
  readonly offset?: number;
  /** Page size applied (the effective `limit`). */
  readonly limit?: number;
  /** True when more referencers remain past this page. */
  readonly hasMore?: boolean;
  /** Cursor for the next page, or `null` when the list is exhausted. */
  readonly nextOffset?: number | null;
  /** Present only when the page is truncated below the true total. */
  readonly note?: string;
}

/**
 * Resolve one incoming references edge into a `FormulaReferencer`.
 * Returns `null` when the edge points at a node that is not present
 * in the graph (sparse-graph case); the caller drops those rather
 * than erroring, matching `get_impact`'s tolerance for half-extracted
 * components.
 */
const resolveReferencer = async (
  ctx: Context,
  edge: Edge,
): Promise<Result<FormulaReferencer | null, string>> => {
  const nodeResult = await getNodeById(ctx.graph, edge.fromId);
  if (!nodeResult.ok) {
    return err(nodeResult.error.message);
  }
  if (nodeResult.value === null) {
    return ok(null);
  }
  const node = nodeResult.value;
  return ok({
    id: node.id,
    type: node.type,
    apiName: node.apiName,
    source: edge.source,
    properties: edge.properties,
  });
};

/**
 * The `sfi.find_formula_references` MCP tool. Returns the source nodes
 * of every incoming `references` edge to `fieldId`, enriched with the
 * edge's `source` and `properties`. Sorted by id ASC; PAGED by
 * `offset`/`limit` (default limit 50, max 500) with
 * `totalCount`/`hasMore`/`nextOffset` so a heavily-referenced field's
 * full set is reachable rather than silently clipped — when the page is
 * partial a truncation `note` is added (CR-13).
 *
 * @example
 *   const r = await findFormulaReferencesHandler(ctx, {
 *     fieldId: 'CustomField:Account.Industry__c',
 *   });
 *   if (r.ok) console.log(r.value.data.referencers.length);
 */
export const findFormulaReferencesHandler = async (
  ctx: Context,
  input: FindFormulaReferencesInput,
): Promise<Result<McpResponse<FindFormulaReferencesOutput>, McpError>> => {
  // FLD-02: graceful object→field routing.
  const suggestionResult = await resolveToFieldOrSuggest(ctx, input.fieldId);
  if (!suggestionResult.ok) return suggestionResult;
  if (suggestionResult.value !== null) {
    return ok(
      suggestionResult.value as unknown as McpResponse<FindFormulaReferencesOutput>,
    );
  }

  const limit = input.limit ?? FORMULA_REFS_DEFAULT_LIMIT;

  const edgesResult = await listEdges(ctx.graph, input.fieldId, {
    direction: 'in',
    edgeType: 'references',
  });
  if (!edgesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${edgesResult.error.message}`,
    });
  }

  const referencers: FormulaReferencer[] = [];
  for (const edge of edgesResult.value) {
    const resolved = await resolveReferencer(ctx, edge);
    if (!resolved.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${resolved.error}`,
      });
    }
    if (resolved.value !== null) {
      referencers.push(resolved.value);
    }
  }

  // CR-13: page after sorting so truncation is stable AND disclosed. `total`
  // is the full pre-slice count of returnable referencers; the `note` (omitted
  // when the page is complete, mirroring get_edges) discloses an incomplete page.
  const ordered = referencers.sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const total = ordered.length;
  const offset = input.offset ?? 0;
  const page = ordered.slice(offset, offset + limit);
  const returned = offset + page.length;
  const hasMore = returned < total;
  const note = hasMore
    ? `Showing ${page.length} of ${total} formula reference(s) (offset=${offset}). ` +
      `MORE remain — advance with offset=${returned}. This list is INCOMPLETE; ` +
      `do not treat it as the full blast radius.`
    : undefined;

  return ok({
    data: {
      referencers: page,
      totalCount: total,
      offset,
      limit,
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
