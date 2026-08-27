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
 *   - `classification` (`'pii' | 'sensitive' | 'protected' | 'all'`,
 *     default `'all'`): narrow to fields whose detected classification
 *     matches. `'protected'` is the highest tier (protected-class
 *     attributes such as race / ethnicity / disability / citizenship).
 *     When `'all'`, the tool emits every classified field — including
 *     `public`-classified fields — so callers can see the full
 *     inventory and the per-classification counts in `summary`.
 *
 *   - `category` (`'identifier' | 'contact' | 'financial' | 'health' |
 *     'protected-class' | 'all'`, default `'all'`): narrow to fields
 *     whose detected category matches. Same `'all'`-emits-everything
 *     semantics.
 *
 *   - `limit` (`1..500`, default `200`): cap the response size. The
 *     response is sorted globally by `(classification, category, id)`
 *     ASC; the slice is truncated at `limit`. `summary.total` carries
 *     the full count even when truncated so the caller knows how much
 *     is hidden.
 *
 *   - `format` (R6-21, `'json' | 'csv'`, default `'json'`): `'csv'`
 *     returns `csv` instead of `fields` (`fields` is `[]` on that page —
 *     the row data lives in `csv`, not duplicated in both encodings) —
 *     one row per matched field, with the heuristic-recognizer and
 *     freshness disclosures embedded as `#`-prefixed comment lines so
 *     they survive even if only the `.csv` text is saved. `summary` /
 *     `truncated` / `nextOffset` / pagination fields are unchanged.
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
  Edge,
  McpError,
  McpResponse,
  Node,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listEdgesForNodes, listNodesByType } from '@sf-intelligence/graph';
import {
  detectPiiClassificationWithReason,
  isRegulatedPiiClassification,
  type PiiCategory,
  type PiiClassification,
} from '@sf-intelligence/patterns';
import { fitCsvRowsToBudget, type CsvCell } from '@sf-intelligence/renderers';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  fieldMatchesObjectScope,
  mergeInputAliases,
  resolveExistingObjectScope,
  toCustomObjectId,
  type ResolvedObjectScope,
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
const CLASSIFICATION_FILTER_VALUES = [
  'pii',
  'sensitive',
  'protected',
  'all',
] as const;

/**
 * The category axis values the input accepts. `'all'` is the
 * sentinel for "no filter".
 */
const CATEGORY_FILTER_VALUES = [
  'identifier',
  'contact',
  'financial',
  'health',
  'protected-class',
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
  // R6-21: 'csv' returns `csv` (rows serialized as CSV) instead of `fields`.
  format: z.enum(['json', 'csv']).optional(),
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
  /**
   * PII-INVENTORY-ANSWERS-A-NONEXISTENT-OBJECT: present ONLY on an
   * object-scoped call — echoes the object the inventory was narrowed to, in
   * the VAULT's exact casing, so a scoped answer can never be read as the
   * org-wide one. Absent on a bare call, keeping that response byte-identical
   * to the pre-fix shape. `mode` is always `component` when present (a bare
   * call omits the whole block, i.e. the `all` reading).
   */
  readonly appliedScope?: {
    readonly object: string;
    readonly mode: 'component';
  };
  /**
   * The matched fields. Empty (`[]`) when `format: 'csv'` was requested —
   * the same rows are then carried in `csv` instead, so the response does
   * not pay for both encodings of the same data.
   */
  readonly fields: readonly PiiField[];
  /**
   * A CSV rendering of `fields` (with the freshness + heuristic-recognizer
   * disclosures embedded as `#`-prefixed comment lines). Present only when
   * the caller passed `format: 'csv'`.
   */
  readonly csv?: string;
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
  protected: 0,
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
  'protected-class': 0,
  unknown: 0,
});

/**
 * Check the classification filter; `'all'` always matches.
 */
const classificationMatches = (
  filter: (typeof CLASSIFICATION_FILTER_VALUES)[number],
  detected: PiiClassification,
): boolean => filter === 'all' || filter === detected;

/**
 * Check the category filter; `'all'` always matches.
 */
const categoryMatches = (
  filter: (typeof CATEGORY_FILTER_VALUES)[number],
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

/** CSV header for the R6-21 `format: 'csv'` export. Column order matches `PiiField`'s field order. */
const PII_CSV_HEADER: readonly string[] = [
  'id',
  'apiName',
  'label',
  'type',
  'classification',
  'category',
  'description',
  'reason',
];

/** Build one CSV row per `PiiField`, in the same column order as {@link PII_CSV_HEADER}. */
const csvRowForPiiField = (field: PiiField): readonly CsvCell[] => [
  field.id,
  field.apiName,
  field.label,
  field.type,
  field.classification,
  field.category,
  field.description,
  field.reason,
];

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

/** The full classified field set plus its stable per-axis breakdowns. */
interface ClassifiedPiiFields {
  /** Every matching field, sorted by `(classification, category, id)` ASC. */
  readonly sorted: readonly PiiField[];
  readonly byClassification: Readonly<Record<PiiClassification, number>>;
  readonly byCategory: Readonly<Record<PiiCategory, number>>;
  /**
   * The VERIFIED object scope this set was narrowed to, or `null` for a bare
   * org-wide call. Carries the vault's exact casing, so callers echo an id that
   * actually exists rather than the one the caller happened to type.
   */
  readonly scope: ResolvedObjectScope | null;
}

/**
 * Classify every CustomField in scope ONCE — fetch the corpus, batch the
 * formula-source `references` edges, run the recognizer, filter by the
 * classification/category axes, and sort. Both `piiInventoryHandler` (which
 * paginates this) and `collectPiiInventoryFields` (which returns all of it) call
 * this, so the full-org classification runs a SINGLE time per request instead of
 * once per output page — the page walk used to re-fetch and re-classify the
 * whole org on every page (the dominant residual cost in `org_risk_report`).
 */
const classifyPiiFields = async (
  ctx: Context,
  input: Pick<
    PiiInventoryInput,
    'classification' | 'category' | 'objectId' | 'objectApiName'
  >,
): Promise<Result<ClassifiedPiiFields, McpError>> => {
  const classificationFilter = input.classification ?? 'all';
  const categoryFilter = input.category ?? 'all';

  // PII-INVENTORY-ANSWERS-A-NONEXISTENT-OBJECT: resolve the optional object
  // scope AND verify it exists BEFORE scanning, via the same
  // `resolveExistingObjectScope` `unused_fields_deep` / `flow_fault_audit` /
  // `flow_bulkification_audit` use.
  //
  // What this replaced: `resolveObjectScopeParentId` did a pure STRING coercion
  // (`X` -> `CustomObject:X`) and `fieldMatchesObjectScope` then string-compared
  // it against every field's parent. The vault was never asked whether the
  // object existed. What a user saw: asking "what personal data does
  // Zzz_Nonexistent__c hold?" returned `{fields: [], summary: {total: 0}}` with
  // no boundary, no disclosure, nothing — an UNCHECKED zero wearing a CHECKED
  // zero's clothes. On a PRIVACY question that empty reads as "nothing
  // sensitive here", about an object the tool never found. The same string
  // compare also silently zeroed a REAL object typed in the wrong case
  // (`contact` never equals `Contact`), so an exactly-correct question got the
  // exactly-wrong "no PII" answer.
  //
  // `null` = bare org-wide call (byte-identical response); a resolved scope
  // narrows the scan and is echoed as `appliedScope`; an absent object is a
  // named `invalid-query`, never widened back to the org-wide inventory.
  const scopeResult = await resolveExistingObjectScope(ctx.graph, input);
  if (!scopeResult.ok) return err(scopeResult.error);
  const scope = scopeResult.value;

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

  // Formula-source PII propagation needs each formula field's OUTGOING
  // `references` edges. Fetch them for EVERY formula field in ONE batched
  // `listEdgesForNodes` round-trip up front instead of a per-formula-field
  // `listEdges` call inside the loop — that N+1 was the dominant cost in the
  // >60s org_risk_report timeout. A field whose direct classification is already
  // pii/sensitive never consults its bucket, so batching over all formula fields
  // (a superset of what's needed) is at worst a few unused map entries and stays
  // a single query.
  const formulaFieldIds = allFieldsResult.value
    .filter(isFormulaField)
    .map((n) => n.id);
  const referencesByField = new Map<string, readonly Edge[]>();
  if (formulaFieldIds.length > 0) {
    const batched = await listEdgesForNodes(ctx.graph, formulaFieldIds, {
      direction: 'out',
      edgeTypes: ['references'],
    });
    if (batched.ok) {
      for (const [id, edges] of batched.value) referencesByField.set(id, edges);
    }
  }

  const resolvePii = (
    node: Node,
  ): ReturnType<typeof detectPiiClassificationWithReason> => {
    const direct = detectPiiClassificationWithReason(node);
    // Only propagate when the field shows NO direct signal and is a formula —
    // a directly-classified field keeps its own (stronger or equal) verdict.
    if (direct.piiClassification !== 'public' || !isFormulaField(node)) {
      return direct;
    }
    // Same `(to_id, edge_type, from_id, source)` order the per-field
    // `listEdges` returned, so the first pii/sensitive source named in the
    // `reason` is unchanged.
    for (const edge of referencesByField.get(node.id) ?? []) {
      const src = fieldById.get(edge.toId);
      if (src === undefined) continue;
      const srcDet = detectPiiClassificationWithReason(src);
      if (isRegulatedPiiClassification(srcDet.piiClassification)) {
        return {
          piiClassification: srcDet.piiClassification,
          piiCategory: srcDet.piiCategory,
          // The inheritance is a heuristic inference over the formula's
          // `references` edges, even when the source itself was `declared`.
          confidence: 'heuristic',
          reason: `formula derives from ${src.apiName} (${edge.toId}), classified ${srcDet.piiClassification}/${srcDet.piiCategory}; a formula-derived field inherits the source field's exposure`,
        };
      }
    }
    return direct;
  };

  for (const node of allFieldsResult.value) {
    // Filter on the VAULT's id (`scope.componentId`), not the caller's string,
    // so a wrong-cased but real object matches the fields it actually owns.
    if (scope !== null && !fieldMatchesObjectScope(node, scope.componentId)) {
      continue;
    }
    const detection = resolvePii(node);
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

  return ok({
    sorted: [...matched].sort(compareFields),
    byClassification,
    byCategory,
    scope,
  });
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

  const classified = await classifyPiiFields(ctx, input);
  if (!classified.ok) return classified;
  const { sorted, byClassification, byCategory, scope } = classified.value;

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

  const vaultState = {
    sourceTreeHash: ctx.manifest.sourceTreeHash,
    refreshedAt: ctx.manifest.refreshedAt,
  };
  const dataWithoutCsv = {
    // appliedScope FIRST + only when scoped, so a bare call omits the whole
    // block and its serialized response stays byte-identical to pre-fix.
    ...(scope !== null
      ? { appliedScope: { object: scope.componentId, mode: 'component' as const } }
      : {}),
    fields: input.format === 'csv' ? [] : kept,
    summary: {
      total: sorted.length,
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
  };

  if (input.format !== 'csv') {
    return ok({ data: dataWithoutCsv, vaultState });
  }

  // R6-21: 'csv' carries this page's rows in `csv` instead of `fields` — the
  // pagination/byte-budget decisions above (kept/truncated/note) are already
  // final, so the csv is an alternate encoding of the SAME `kept` rows, not a
  // second independent row-selection pass. `fitCsvRowsToBudget` bounds the RAW
  // csv text, but JSON.stringify-ing it into the envelope escapes every `\n`
  // (inflating past the raw byte count) — measure the ACTUAL envelope and
  // shrink until it fits, mirroring `generate_data_dictionary`'s csv path.
  const csvDisclosures = [
    `generatedAt: ${ctx.manifest.refreshedAt}`,
    `sourceTreeHash: ${ctx.manifest.sourceTreeHash}`,
    'The pii-detection recognizer is heuristic: a field with no name-token or description signal classifies public even if it stores PII at runtime; EncryptedText always classifies sensitive.',
    `total matched: ${sorted.length}; this page: ${kept.length} (offset ${offset})`,
    ...(truncated ? [`truncated: more matching fields remain past offset ${offset + kept.length}`] : []),
  ];
  const csvRows = kept.map(csvRowForPiiField);
  const byteLenOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');
  const envelopeBytes = (csv: string): number =>
    byteLenOf({ data: { ...dataWithoutCsv, csv }, vaultState });
  let csvBudget = Math.max(200, PII_PAYLOAD_BUDGET_BYTES - byteLenOf({ data: dataWithoutCsv, vaultState }));
  let csvFit = fitCsvRowsToBudget(csvDisclosures, PII_CSV_HEADER, csvRows, csvBudget);
  while (envelopeBytes(csvFit.csv) > PII_PAYLOAD_BUDGET_BYTES && csvFit.keptRows > 0) {
    const overshoot = envelopeBytes(csvFit.csv) - PII_PAYLOAD_BUDGET_BYTES;
    csvBudget = Math.max(100, csvBudget - Math.max(256, overshoot));
    csvFit = fitCsvRowsToBudget(csvDisclosures, PII_CSV_HEADER, csvRows, csvBudget);
  }

  return ok({ data: { ...dataWithoutCsv, csv: csvFit.csv }, vaultState });
};

/**
 * Return the full classified field list. Composers (e.g.
 * `generate_compliance_report`, `org_risk_report`) must use this instead of a
 * single handler call — the default page is capped at 200 rows.
 *
 * Classifies the whole org ONCE via the shared {@link classifyPiiFields} rather
 * than re-invoking the paginated handler per page (which re-fetched and
 * re-classified every field on every page — with the response byte-trim shrinking
 * pages well below 500, that was tens of full org scans per call and the biggest
 * residual cost in `org_risk_report`). The returned set is the same complete,
 * sort-ordered field list the page walk accumulated.
 */
export const collectPiiInventoryFields = async (
  ctx: Context,
  input: Omit<PiiInventoryInput, 'limit' | 'offset'> = {},
): Promise<
  Result<{ readonly fields: readonly PiiField[]; readonly summary: PiiInventorySummary }, McpError>
> => {
  const classified = await classifyPiiFields(ctx, input);
  if (!classified.ok) return classified;
  const { sorted, byClassification, byCategory } = classified.value;
  return ok({
    fields: sorted,
    summary: { total: sorted.length, byClassification, byCategory },
  });
};
