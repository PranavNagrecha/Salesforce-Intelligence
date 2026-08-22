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
 *     each `fromId` to a `Node`. An id that names NO node, or a node
 *     that is not a CustomField, is REFUSED with `component-not-found`
 *     (plus typo-tolerant `resolveSuggestions`) — an empty referencer
 *     list is reserved for a real field that genuinely has none.
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
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  buildEmptyTraversalCoverageCaveat,
  type CoverageCaveat,
  FORMULA_REFERENCE_REQUIRED_COVERAGE,
} from './coverage-trust.js';
import { fieldNotFoundError } from './field-not-found-suggest.js';
import { firstNonEmpty } from './input-aliases.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import { resolveToFieldOrSuggest } from './resolve-field-or-suggest.js';

const CUSTOM_FIELD_PREFIX = 'CustomField:';
const CUSTOM_OBJECT_PREFIX = 'CustomObject:';

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
 *   - `fieldId`: the canonical `CustomField:{Object}.{Field}` id. An id that
 *     names no CustomField node surfaces as `component-not-found` from the
 *     handler (with resolve suggestions), not a Zod-level rejection.
 *   - `componentId` / `fieldApiName`: interchangeable field selectors a host
 *     naturally forwards from `sfi.resolve`
 *     (FIND-FORMULA-REFERENCES-REJECTS-COMPONENTID). `componentId` is the
 *     `CustomField:` id; `fieldApiName` also accepts a dotted `<Object>.<Field>`
 *     (coerced). Resolved to the SAME field through {@link resolveFieldRef}; the
 *     canonical `fieldId` wins, disagreeing selectors or a non-field id →
 *     `invalid-query`, at least one is required.
 *   - `limit`: optional integer in `[1, 500]`. Defaults to 50 inside
 *     the handler when omitted.
 */
export const findFormulaReferencesInputSchema = z.object({
  fieldId: z.string().min(1).optional(),
  componentId: z.string().min(1).optional(),
  fieldApiName: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(FORMULA_REFS_MAX_LIMIT).optional(),
  /**
   * Zero-based page offset (CR-13). Defaults to 0. Paired with `limit` so the
   * caller can walk the FULL referencer set when the result is truncated — a
   * blast-radius tool must never silently drop referencers.
   */
  offset: z.number().int().nonnegative().optional(),
  /**
   * CR-22 continuation cursor: opaque token from a prior truncated page's
   * `nextCursor`; supplies the resume offset. Omit for today's behavior.
   */
  cursor: z.string().min(1).optional(),
});

/** Parsed input shape, inferred from `findFormulaReferencesInputSchema`. */
export type FindFormulaReferencesInput = z.infer<
  typeof findFormulaReferencesInputSchema
>;

/**
 * Coerce a dotted `<Object>.<Field>` selector to the canonical CustomField id;
 * leave an already-prefixed id (`CustomField:` / any other `Type:`) or a bare
 * token unchanged — the latter reaches `resolveToFieldOrSuggest`'s object-name
 * probe just as a bare `fieldId` does today.
 */
const toFieldRef = (raw: string): string =>
  !raw.includes(':') && raw.includes('.') ? `${CUSTOM_FIELD_PREFIX}${raw}` : raw;

/**
 * Reconcile the interchangeable field selectors a host reaches for — `fieldId`
 * (canonical), `componentId` (`CustomField:{Object}.{Field}`), and
 * `fieldApiName` (a `CustomField:` id or a dotted `<Object>.<Field>`) —
 * FIND-FORMULA-REFERENCES-REJECTS-COMPONENTID. All coerce to the same
 * `CustomField:` id, so `sfi.resolve`'s CustomField id works without renaming.
 * Disagreeing selectors → `invalid-query` (never a silent pick); none →
 * `invalid-query`. A wrong-type id (an `ApexClass:` / `Flow:` / … selector) is
 * NAMED rather than silently returning an empty referencer list; a
 * `CustomObject:` id is allowed through so the handler's object→field suggestion
 * still fires. The resolved value is byte-identical to a bare `{ fieldId }` call
 * for a canonical `CustomField:` id (coercion is a no-op on it).
 */
const resolveFieldRef = (
  input: FindFormulaReferencesInput,
): Result<string, McpError> => {
  const candidates = [input.fieldId, input.componentId, input.fieldApiName]
    .map((v) => firstNonEmpty(v))
    .filter((v): v is string => v !== undefined)
    .map(toFieldRef);
  const distinct = [...new Set(candidates)];
  if (distinct.length === 0) {
    return err({
      kind: 'invalid-query',
      message:
        'name the field — pass `fieldId` or `componentId` (e.g. "CustomField:Account.Industry__c"), or a dotted `fieldApiName` (`Object.Field`)',
      path: 'fieldId',
    });
  }
  if (distinct.length > 1) {
    return err({
      kind: 'invalid-query',
      message: `field selectors name different targets (${distinct.join(', ')}); pass exactly one of fieldId / componentId / fieldApiName`,
      path: 'fieldId',
    });
  }
  const ref = distinct[0] as string;
  if (
    ref.includes(':') &&
    !ref.startsWith(CUSTOM_FIELD_PREFIX) &&
    !ref.startsWith(CUSTOM_OBJECT_PREFIX)
  ) {
    return err({
      kind: 'invalid-query',
      message: `'${ref}' is not a CustomField — find_formula_references lists references to ONE field; pass a 'CustomField:{Object}.{Field}' id (or a dotted 'Object.Field')`,
      path: 'fieldId',
    });
  }
  return ok(ref);
};

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
  /** Approximate next offset (legacy), or `null` when the list is exhausted. */
  readonly nextOffset?: number | null;
  /**
   * CR-22 opaque continuation token, present ONLY when this page is truncated
   * (more referencers remain). Echo it back as `cursor` to resume. Absent on a
   * complete page so an in-budget response is byte-identical to pre-CR-22.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
  /** Present only when the page is truncated below the true total. */
  readonly note?: string;
  /**
   * I3b (empty ≠ none): present ONLY when the FULL result is empty AND a family
   * that produces formula `references` edges (`CustomField` / `ValidationRule`)
   * is NOT fully covered by the vault. Names the not-checked families so an
   * empty referencer list reads "not retrieved", not a proven "none". Absent on
   * a non-empty result and on a fully-covered vault (byte-identical to before).
   */
  readonly coverageCaveat?: CoverageCaveat;
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
  // FIND-FORMULA-REFERENCES-REJECTS-COMPONENTID: accept componentId /
  // fieldApiName as aliases for fieldId, resolved to the same CustomField id.
  const fieldRefResult = resolveFieldRef(input);
  if (!fieldRefResult.ok) return fieldRefResult;
  const fieldId = fieldRefResult.value;

  // FLD-02: graceful object→field routing.
  const suggestionResult = await resolveToFieldOrSuggest(ctx, fieldId);
  if (!suggestionResult.ok) return suggestionResult;
  if (suggestionResult.value !== null) {
    return ok(
      suggestionResult.value as unknown as McpResponse<FindFormulaReferencesOutput>,
    );
  }

  // EXISTENCE GATE. Without it, four distinct causes produced a byte-identical
  // `{referencers: [], totalCount: 0}` and three of them were lies: a miscased
  // id, a nonexistent field, a non-CustomField node, and a real field that
  // genuinely has no formula references. Ask the graph whether the thing being
  // named exists before answering a zero about it — the same gate nine sibling
  // field tools already pay for (copied from `field-meaning.ts`).
  const nodeResult = await getNodeById(ctx.graph, fieldId);
  if (!nodeResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodeResult.error.message}`,
    });
  }
  if (nodeResult.value === null) {
    return err(
      await fieldNotFoundError(
        ctx,
        fieldId,
        await phantomAwareNotFoundMessage(ctx, fieldId, 'CustomField'),
      ),
    );
  }
  if (nodeResult.value.type !== 'CustomField') {
    return err({
      kind: 'component-not-found',
      message: `node ${fieldId} is not a CustomField (type=${nodeResult.value.type})`,
      path: fieldId,
    });
  }

  const limit = input.limit ?? FORMULA_REFS_DEFAULT_LIMIT;

  const edgesResult = await listEdges(ctx.graph, fieldId, {
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
  // TOTAL ORDER: `id` ASC then `source` ASC — a single `fromId` (= `id`) can
  // hold more than one `references` edge to the same field, differing only by
  // `source` (edge PK is (from_id,to_id,edge_type,source) with to_id/edge_type
  // fixed here), so `source` is the unique final tiebreak CR-22 resume needs.
  const ordered = referencers.sort((a, b) => {
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    return 0;
  });

  // CR-22: resolve the resume offset (echoed cursor wins over explicit offset);
  // a stale/forged cursor (changed fieldId, different tool, refreshed vault) is
  // rejected with invalid-query.
  const fingerprint = argsFingerprint({ fieldId });
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: 'sfi.find_formula_references',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  // No per-handler byte budget (offset/limit only) — set an effectively-
  // unbounded byteBudget so `paginate()` truncates only on `limit`, keeping the
  // output byte-identical to the prior open-coded slice. Global guard backstops.
  const paged = paginateLegacy(ordered, {
    offset,
    limit,
    byteBudget: Number.MAX_SAFE_INTEGER,
    binding: {
      tool: 'sfi.find_formula_references',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const page = paged.items;
  const total = paged.totalCount;
  const hasMore = paged.hasMore;
  const returned = offset + page.length;
  const note = hasMore
    ? `Showing ${page.length} of ${total} formula reference(s) (offset=${offset}). ` +
      `MORE remain — advance with offset=${returned}. This list is INCOMPLETE; ` +
      `do not treat it as the full blast radius.`
    : undefined;
  const emitCursor = paged.nextCursor !== null;
  // I3b (empty ≠ none): only when the WHOLE referencer set is empty do we risk
  // the host narrating absence as fact — attach a coverage caveat naming the
  // formula-source families the vault did NOT fully retrieve, so "no formula
  // references this" carries "…among the families the vault covers". Non-empty
  // output is untouched.
  const coverageCaveat =
    total === 0
      ? buildEmptyTraversalCoverageCaveat(ctx, FORMULA_REFERENCE_REQUIRED_COVERAGE)
      : undefined;

  return ok({
    data: {
      referencers: page,
      totalCount: total,
      offset,
      limit,
      hasMore,
      nextOffset: hasMore ? returned : null,
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
