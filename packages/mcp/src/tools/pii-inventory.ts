/**
 * Handler for the `sfi.pii_inventory` MCP tool.
 *
 * The v2.0d sub-milestone headline tool — the buyer-facing answer to
 * compliance/privacy priority #5 on the top-10 questions list: "which
 * fields contain PII and who can see/export them?". This tool answers
 * the first half ("which fields contain PII"); the field-access cross-
 * walk (`sfi.field_access_audit`) answers the second half.
 *
 * The tool is a pure composition over the patterns layer: enumerate
 * every CustomField in the vault, run the `pii-detection` recognizer
 * over each, filter by the caller's input parameters, and emit a
 * structured `(fields, summary)` pair.
 *
 * Input scope:
 *
 *   - `classification` (`'pii' | 'sensitive' | 'all'`, default
 *     `'all'`): narrow to fields whose detected classification matches.
 *     When `'all'`, the tool emits every classified field — including
 *     `public`-classified fields — so callers can see the full
 *     inventory and the per-classification counts in `summary`.
 *
 *   - `category` (`'identifier' | 'contact' | 'financial' | 'health' |
 *     'all'`, default `'all'`): narrow to fields whose detected
 *     category matches. Same `'all'`-emits-everything semantics.
 *
 *   - `limit` (`1..500`, default `200`): cap the response size. The
 *     response is sorted globally by `(classification, category, id)`
 *     ASC; the slice is truncated at `limit`. `summary.total` carries
 *     the full count even when truncated so the caller knows how much
 *     is hidden.
 *
 * Honesty axis (per the v2.0d spec): the recognizer is heuristic.
 *
 *   - A field name without any PII token classifies as `public` —
 *     even if the field is, in fact, holding PII at runtime. The
 *     recognizer cannot read record-level data.
 *
 *   - A field name with a PII token (e.g. `Notes_SSN__c`) classifies
 *     as PII even if the field is empty at runtime.
 *
 *   - The `EncryptedText` data type ALWAYS classifies as `pii`.
 *     The encryption type IS the declaration.
 *
 *   - Description-keyword matching is sub-string-based; a field whose
 *     description merely mentions "PII" in a context unrelated to its
 *     value will still classify as `pii`. Callers should treat the
 *     output as a starting point for a compliance audit, not as the
 *     final word.
 *
 * Implementation notes:
 *
 *   - `listNodesByType(store, 'CustomField')` paginates at 500
 *     internally; the tool walks the offset cursor itself so very
 *     large orgs (>500 custom fields) are fully enumerated.
 *
 *   - The reason text surfaced in each `PiiField` is the recognizer's
 *     own reason string (see `detectPiiClassificationWithReason`).
 *
 *   - The summary counts are computed over the FULL classified set,
 *     not over the truncated slice — `byClassification`/`byCategory`
 *     stay stable across pagination calls.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listEdges, listNodesByType } from '@sf-intelligence/graph';
import {
  detectPiiClassificationWithReason,
  type PiiCategory,
  type PiiClassification,
} from '@sf-intelligence/patterns';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  fieldMatchesObjectScope,
  mergeInputAliases,
  resolveObjectScopeParentId,
  toCustomObjectId,
} from './input-aliases.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';

/**
 * Inclusive upper bound on `limit`. Mirrors the `LIST_MAX_LIMIT`
 * convention from the graph layer.
 */
const PII_INVENTORY_MAX_LIMIT = 500;

/** Default `limit` when the caller omits it. */
const PII_INVENTORY_DEFAULT_LIMIT = 200;

/**
 * Page size used when walking `listNodesByType` for the CustomField
 * scan. The graph layer caps at 500 internally; matching that here
 * keeps the round-trip count minimal.
 */
const SCAN_PAGE_SIZE = 500;

/**
 * The classification axis values the input accepts. `'all'` is the
 * sentinel for "no filter".
 */
const CLASSIFICATION_FILTER_VALUES = ['pii', 'sensitive', 'all'] as const;

/**
 * The category axis values the input accepts. `'all'` is the
 * sentinel for "no filter".
 */
const CATEGORY_FILTER_VALUES = [
  'identifier',
  'contact',
  'financial',
  'health',
  'all',
] as const;

/**
 * Zod schema for the `sfi.pii_inventory` tool input.
 *
 *   - `classification` optional; defaults to `'all'` in the handler.
 *   - `category` optional; defaults to `'all'` in the handler.
 *   - `limit` optional; defaults to 200 in the handler.
 *   - `offset` optional (>= 0); defaults to 0. Page cursor for walking the
 *     full inventory when a response is `truncated` — advance by `nextOffset`.
 */
const piiInventoryInputBaseSchema = z.object({
  objectId: z.string().min(1).optional(),
  objectApiName: z.string().min(1).optional(),
  classification: z.enum(CLASSIFICATION_FILTER_VALUES).optional(),
  category: z.enum(CATEGORY_FILTER_VALUES).optional(),
  limit: z.number().int().min(1).max(PII_INVENTORY_MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
  // CR-22 continuation cursor: opaque token from a prior truncated page's
  // nextCursor; supplies the resume offset. Omit for today's behavior.
  cursor: z.string().min(1).optional(),
});

export const piiInventoryInputSchema = z.preprocess((raw) => {
  const merged = mergeInputAliases(raw, [
    { canonical: 'objectId', aliases: ['objectApiName'] },
  ]);
  if (merged !== null && typeof merged === 'object' && !Array.isArray(merged)) {
    const o = merged as Record<string, unknown>;
    const id = typeof o.objectId === 'string' ? o.objectId : '';
    if (id.length > 0 && !id.startsWith('CustomObject:')) {
      o.objectId = toCustomObjectId(id);
    }
  }
  return merged;
}, piiInventoryInputBaseSchema);

/** Parsed input shape, inferred from `piiInventoryInputSchema`. */
export type PiiInventoryInput = z.infer<typeof piiInventoryInputSchema>;

/**
 * One classified field in the inventory response. Carries the field's
 * identity, declared data type, and the recognizer-emitted
 * classification + category + reason.
 */
export interface PiiField {
  readonly id: ComponentId;
  readonly apiName: string;
  readonly label: string;
  /** Field data type (Text, Email, EncryptedText, etc.). */
  readonly type: string;
  readonly classification: PiiClassification;
  readonly category: PiiCategory;
  readonly description: string | null;
  /** Why this classification was assigned (the rule that fired). */
  readonly reason: string;
}

/**
 * Aggregated counts emitted alongside the per-field list. Counts are
 * computed over the FULL classified set BEFORE the global slice is
 * trimmed at `limit`, so `summary.total` is the true count and the
 * per-classification / per-category breakdowns stay stable across
 * pagination calls.
 */
export interface PiiInventorySummary {
  /** Total fields surfaced after classification/category filtering. */
  readonly total: number;
  /** Count of matching fields per `PiiClassification` value. */
  readonly byClassification: Readonly<Record<PiiClassification, number>>;
  /** Count of matching fields per `PiiCategory` value. */
  readonly byCategory: Readonly<Record<PiiCategory, number>>;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface PiiInventoryOutput {
  readonly fields: readonly PiiField[];
  readonly summary: PiiInventorySummary;
  /** Page size applied to this response (echoes the request; default 200). */
  readonly limit: number;
  /** Zero-based offset of the first returned field in the sorted set. */
  readonly offset: number;
  /** True when more matching fields exist beyond this response's slice. */
  readonly truncated: boolean;
  /**
   * Offset to pass on the next call to fetch the following page. Present only
   * when `truncated` — i.e. more fields remain after this slice.
   */
  readonly nextOffset?: number;
  /**
   * CR-22 opaque continuation token, present ONLY when this page is truncated
   * (more matching fields remain — over `limit` OR byte-trimmed). Echo it back
   * as `cursor` to resume. Absent on a complete page so an in-budget response
   * is byte-identical to the pre-CR-22 shape.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
  /**
   * Set only when the page was byte-trimmed below the global ~45 KB response
   * limit (fewer than `limit` rows despite more matching). Names the trim and
   * how to advance.
   */
  readonly note?: string;
}

/**
 * Per-response byte budget for the `fields` array. Sits below the global
 * `MAX_RESPONSE_BYTES` (~45 KB) dispatch guard with headroom for `summary`,
 * the envelope, `vaultState`, and the pagination fields, so a default-`limit`
 * page can NEVER trip that guard (which would reject the whole result
 * outright). When a page exceeds this budget the handler returns the largest
 * sort-ordered prefix that fits and flags `truncated` with a `nextOffset`.
 */
const PII_PAYLOAD_BUDGET_BYTES = 38_000;

/**
 * Build an empty per-classification counter; the handler increments
 * values per match. Pre-initialised so the output shape stays stable
 * across runs even when a key has zero matches.
 */
const emptyClassificationCounts = (): Record<PiiClassification, number> => ({
  pii: 0,
  sensitive: 0,
  public: 0,
  unknown: 0,
});

/**
 * Build an empty per-category counter; the handler increments values
 * per match. Pre-initialised for the same reason as
 * `emptyClassificationCounts`.
 */
const emptyCategoryCounts = (): Record<PiiCategory, number> => ({
  identifier: 0,
  contact: 0,
  financial: 0,
  health: 0,
  unknown: 0,
});

/**
 * Check the classification filter; `'all'` always matches.
 */
const classificationMatches = (
  filter: 'pii' | 'sensitive' | 'all',
  detected: PiiClassification,
): boolean => filter === 'all' || filter === detected;

/**
 * Check the category filter; `'all'` always matches.
 */
const categoryMatches = (
  filter: 'identifier' | 'contact' | 'financial' | 'health' | 'all',
  detected: PiiCategory,
): boolean => filter === 'all' || filter === detected;

/**
 * Read the field data type from `properties.dataType`. Falls back to
 * `'Unknown'` so the output shape stays stable; the recognizer itself
 * has its own data-type rules so missing values are not a fatal issue
 * for classification.
 */
const readDataType = (
  properties: Readonly<Record<string, unknown>>,
): string => {
  const dt = properties['dataType'];
  return typeof dt === 'string' ? dt : 'Unknown';
};

/**
 * Read the field description from `properties.description`. Returns
 * `null` when absent or empty so the response carries an explicit
 * null rather than an empty string.
 */
const readDescription = (
  properties: Readonly<Record<string, unknown>>,
): string | null => {
  const d = properties['description'];
  return typeof d === 'string' && d.length > 0 ? d : null;
};

/**
 * Comparator for the deterministic output sort. Orders by
 * `classification` ASC, then `category` ASC, then `id` ASC. Matches
 * the documentation in the module JSDoc.
 */
const compareFields = (a: PiiField, b: PiiField): number => {
  if (a.classification !== b.classification) {
    return a.classification < b.classification ? -1 : 1;
  }
  if (a.category !== b.category) {
    return a.category < b.category ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * Walk the CustomField type with offset-based pagination and return
 * the full list. The graph layer caps each call at 500 rows; the
 * handler keeps fetching until a short page signals end-of-list.
 */
const fetchAllCustomFields = async (
  ctx: Context,
): Promise<Result<readonly Node[], string>> => {
  const all: Node[] = [];
  let offset = 0;
  while (true) {
    const page = await listNodesByType(ctx.graph, 'CustomField', {
      limit: SCAN_PAGE_SIZE,
      offset,
    });
    if (!page.ok) {
      return err(page.error.message);
    }
    all.push(...page.value);
    if (page.value.length < SCAN_PAGE_SIZE) break;
    offset += SCAN_PAGE_SIZE;
  }
  return ok(all);
};

/**
 * The `sfi.pii_inventory` MCP tool. Returns the structured PII
 * inventory across every CustomField in the vault, filtered by the
 * caller's `classification` and `category` parameters. See the module
 * JSDoc for the honesty-axis caveats.
 *
 * @example
 *   const r = await piiInventoryHandler(ctx, { classification: 'pii' });
 *   if (r.ok) console.log(r.value.data.summary.total);
 */
export const piiInventoryHandler = async (
  ctx: Context,
  input: PiiInventoryInput,
): Promise<Result<McpResponse<PiiInventoryOutput>, McpError>> => {
  const classificationFilter = input.classification ?? 'all';
  const categoryFilter = input.category ?? 'all';
  const limit = input.limit ?? PII_INVENTORY_DEFAULT_LIMIT;
  const objectScopeParentId = resolveObjectScopeParentId(input);

  const allFieldsResult = await fetchAllCustomFields(ctx);
  if (!allFieldsResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${allFieldsResult.error}`,
    });
  }

  const matched: PiiField[] = [];
  const byClassification = emptyClassificationCounts();
  const byCategory = emptyCategoryCounts();

  // Id → field node map for formula-source PII propagation (bug 11). A formula
  // field that DERIVES its value from a regulated source (e.g. Masked_SSN__c =
  // a formula over Student_SSN__c) carries the same exposure, even though its
  // own name / type shows no direct PII signal.
  const fieldById = new Map<string, Node>(
    allFieldsResult.value.map((n) => [n.id, n]),
  );
  const isFormulaField = (node: Node): boolean => {
    const f = node.properties['formula'];
    return typeof f === 'string' && f.trim().length > 0;
  };
  const resolvePii = async (
    node: Node,
  ): Promise<ReturnType<typeof detectPiiClassificationWithReason>> => {
    const direct = detectPiiClassificationWithReason(node);
    // Only propagate when the field shows NO direct signal and is a formula —
    // a directly-classified field keeps its own (stronger or equal) verdict.
    if (direct.piiClassification !== 'public' || !isFormulaField(node)) {
      return direct;
    }
    const refs = await listEdges(ctx.graph, node.id, {
      direction: 'out',
      edgeType: 'references',
    });
    if (!refs.ok) return direct;
    for (const edge of refs.value) {
      const src = fieldById.get(edge.toId);
      if (src === undefined) continue;
      const srcDet = detectPiiClassificationWithReason(src);
      if (
        srcDet.piiClassification === 'pii' ||
        srcDet.piiClassification === 'sensitive'
      ) {
        return {
          piiClassification: srcDet.piiClassification,
          piiCategory: srcDet.piiCategory,
          reason: `formula derives from ${src.apiName} (${edge.toId}), classified ${srcDet.piiClassification}/${srcDet.piiCategory}; a formula-derived field inherits the source field's exposure`,
        };
      }
    }
    return direct;
  };

  for (const node of allFieldsResult.value) {
    if (
      objectScopeParentId !== undefined &&
      !fieldMatchesObjectScope(node, objectScopeParentId)
    ) {
      continue;
    }
    const detection = await resolvePii(node);
    if (
      !classificationMatches(classificationFilter, detection.piiClassification)
    ) {
      continue;
    }
    if (!categoryMatches(categoryFilter, detection.piiCategory)) {
      continue;
    }
    byClassification[detection.piiClassification] += 1;
    byCategory[detection.piiCategory] += 1;
    matched.push({
      id: node.id,
      apiName: node.apiName,
      label: node.label ?? '',
      type: readDataType(node.properties),
      classification: detection.piiClassification,
      category: detection.piiCategory,
      description: readDescription(node.properties),
      reason: detection.reason,
    });
  }

  const sorted = [...matched].sort(compareFields);

  // CR-22: resolve the resume offset (echoed cursor wins over explicit offset);
  // a stale/forged cursor (changed objectId/classification/category, different
  // tool, or refreshed vault) is rejected with invalid-query.
  const fingerprint = argsFingerprint({
    ...(input.objectId !== undefined ? { objectId: input.objectId } : {}),
    classification: classificationFilter,
    category: categoryFilter,
  });
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: 'sfi.pii_inventory',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  // The pre-byte-trim window size is needed for the byte-identical note text
  // (`X of Y matched fields`). `paginate()` then applies the same largest-prefix
  // byte-trim the handler used to open-code (verified equivalent kept-set).
  const windowSize = sorted.slice(offset, offset + limit).length;
  const paged = paginateLegacy(sorted, {
    offset,
    limit,
    byteBudget: PII_PAYLOAD_BUDGET_BYTES,
    binding: {
      tool: 'sfi.pii_inventory',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const kept = paged.items;
  const trimmed = paged.byteTrimmed;
  const truncated = paged.hasMore;
  const emitCursor = paged.nextCursor !== null;

  return ok({
    data: {
      fields: kept,
      summary: {
        total: matched.length,
        byClassification,
        byCategory,
      },
      limit,
      offset,
      truncated,
      ...(truncated ? { nextOffset: offset + kept.length } : {}),
      ...(emitCursor ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo } : {}),
      ...(trimmed
        ? {
            note:
              `Response trimmed to ${kept.length} of ${windowSize} matched ` +
              `fields to stay under the ~45 KB MCP response limit. Advance ` +
              `with offset += ${kept.length} for the rest.`,
          }
        : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

/**
 * Walk every page of `pii_inventory` and return the full classified field list.
 * Composers (e.g. `generate_compliance_report`) must use this instead of a
 * single handler call — the default page is capped at 200 rows.
 */
export const collectPiiInventoryFields = async (
  ctx: Context,
  input: Omit<PiiInventoryInput, 'limit' | 'offset'> = {},
): Promise<
  Result<{ readonly fields: readonly PiiField[]; readonly summary: PiiInventorySummary }, McpError>
> => {
  const all: PiiField[] = [];
  let offset = 0;
  let summary: PiiInventorySummary | undefined;
  for (;;) {
    const page = await piiInventoryHandler(ctx, {
      ...input,
      limit: PII_INVENTORY_MAX_LIMIT,
      offset,
    });
    if (!page.ok) return page;
    summary = page.value.data.summary;
    all.push(...page.value.data.fields);
    if (!page.value.data.truncated) break;
    const next = page.value.data.nextOffset;
    if (next === undefined || next <= offset) break;
    offset = next;
  }
  if (summary === undefined) {
    return err({ kind: 'internal', message: 'pii inventory produced no summary' });
  }
  return ok({ fields: all, summary });
};
