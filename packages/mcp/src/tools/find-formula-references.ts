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

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface FindFormulaReferencesOutput {
  readonly referencers: readonly FormulaReferencer[];
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
 * edge's `source` and `properties`. Sorted by id ASC; truncated to
 * `limit` (default 50, max 500).
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

  const sorted = referencers
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, limit);

  return ok({
    data: { referencers: sorted },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
