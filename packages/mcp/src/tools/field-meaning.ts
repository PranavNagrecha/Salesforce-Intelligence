/**
 * Handler for the `sfi.field_meaning` MCP tool.
 *
 * v2.9 R4 — the "what does this field actually mean in our org?"
 * surface (PLAN-v2.9 §4). Given a CustomField canonical id, returns
 * the field's declared shape (apiName, label, description, type,
 * picklist values, parent object), its v2.9 vocabulary classifications
 * (`sourceOfTruth`, `semanticCategory`), usage frequency (asymmetric
 * read/write incoming counts to reveal scratch-field patterns), and
 * top-3 similar fields by label/apiName token overlap.
 *
 * Composition (PLAN-v2.9 §14):
 *   - Reads the CustomField node and its `properties.sourceOfTruth` +
 *     `properties.semanticCategory` (populated by v2.9 R3 at extraction
 *     time; absent on pre-v2.9 vaults → tool reports `unknown` and
 *     surfaces a boundary).
 *   - Walks incoming `readsFrom` / `writesTo` edges to count usage.
 *   - For similar-fields: best-effort label/apiName token overlap.
 *     v2.2's full TF-IDF index is the canonical similarity source per
 *     PLAN-v2.9 §3; the token-overlap fallback ships here so the tool
 *     produces non-trivial output regardless of whether v2.2 search
 *     infrastructure is present in the vault. The skill surfaces the
 *     boundary verbatim.
 *
 * Honesty axis (PLAN-v2.9 §4):
 *   - `vocabulary is org-specific` — always surfaced.
 *   - `classification is heuristic on writes-fabric inference` —
 *     surfaced when classification confidence is `'heuristic'`.
 *   - `semantic category is name-pattern, not type-semantic` —
 *     surfaced whenever `semanticCategory !== 'unknown'`.
 *   - `usage frequency is static analysis only` — always surfaced.
 *
 * Implementation notes:
 *   - Input validation: `fieldId` must start with `CustomField:`. Any
 *     other prefix surfaces as `invalid-query` from the handler
 *     (mirrors `explain-field` / `why-field-changed` convention).
 *   - Unknown ids surface as `component-not-found`.
 *   - Similar-fields enumerates every other CustomField in the graph
 *     and scores by shared tokens; the top 3 are returned, ranked by
 *     score DESC then id ASC. Token extraction strips `__c` / `__r`
 *     suffixes and splits on underscores / camelCase boundaries.
 *   - sourceOfTruth / semanticCategory may be absent on pre-v2.9
 *     vaults: tool returns `{ value: 'unknown', confidence: 'heuristic' }`
 *     in both cases. The boundary list mentions classification when
 *     this fallback fires.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  FIELD_VALUE_CONSUMING_EDGE_TYPES,
  FIELD_VALUE_WRITING_EDGE_TYPES,
} from './coverage-trust.js';
import { fieldNotFoundError } from './field-not-found-suggest.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import {
  normalizePicklistValues,
  resolveGlobalValueSetValues,
} from './picklist-values.js';
import { resolveToFieldOrSuggest } from './resolve-field-or-suggest.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';

/** Canonical id prefix for the CustomField node type. */
const CUSTOM_FIELD_PREFIX = 'CustomField:';

/** Maximum similarFields returned. PLAN-v2.9 §4 specifies "top-3". */
const SIMILAR_FIELDS_LIMIT = 3;

/**
 * The picklist-family dataTypes whose declared value set the custom-field
 * extractor records under `properties.picklistValues` (or leaves inline-null
 * for a GlobalValueSet reference). Mirrors `explain-field.ts`'s
 * `PICKLIST_DATA_TYPES` / the extractor's own `PICKLIST_TYPES` gate — for
 * every other dataType `picklistValues` is `null` by construction, so it is
 * never worth following `usesValueSet` off-node.
 */
const PICKLIST_DATA_TYPES: readonly string[] = ['Picklist', 'MultiselectPicklist'];

/**
 * Verbatim boundaries surfaced in every response. The skill may add
 * additional axis-specific boundaries; the four below are the v2.9-wide
 * anchor (PLAN-v2.9 §4 "Honesty axis").
 */
const BOUNDARY_VOCABULARY_ORG_SPECIFIC =
  "Vocabulary is org-specific — one org's term is another org's; the tool reports what THIS org's metadata declares, not industry convention.";
const BOUNDARY_USAGE_STATIC_ONLY =
  'Usage frequency is static analysis only — runtime usage (which fields users actually edit, which reports display) is invisible.';
const BOUNDARY_CLASSIFICATION_HEURISTIC =
  'Classification is heuristic on writes-fabric inference — dynamic SOQL, reflective field access, and integration-tagged Apex without a references edge may be misclassified.';
const BOUNDARY_SEMANTIC_NAME_PATTERN =
  'Semantic category is name-pattern, not type-semantic — a field named Status__c with type DateTime is still categorized as status by name; check type alongside category.';
const BOUNDARY_CLASSIFICATION_MISSING =
  'Vocabulary classifier has not run for this vault — sourceOfTruth and semanticCategory both default to unknown. Run `sfi refresh --rebuild-vocabulary` to populate them.';
/**
 * Verbatim `usageFrequency.note`. Always present — a reader must be able to
 * tell what a number counted without reading the source.
 */
const USAGE_FREQUENCY_NOTE =
  '`incomingReads` counts every inbound edge that CONSUMES this field\'s value: `readsFrom` (Apex, Flow, condition contexts) and `references` (formulas, validation rules, list views, report types, Lightning pages, quick actions, web links). `usedInLayout` (placement) and `grantedBy` (permission) are not reads and are excluded — their counts are in `excludedByEdgeType`.';
/** Extra boundary when `incomingReads` is zero — the zero must read as CHECKED. */
const BOUNDARY_ZERO_READS =
  'A zero here means no value-consuming edge was found among the metadata families this vault retrieved. It is not proof the field is unused — reports, dashboards, list-view filters, and dynamic Apex are named in `boundaries` where they are not covered.';
const BOUNDARY_INACTIVE_PICKLIST_VALUES =
  'This picklist has inactive value(s) (isActive: false) — they are RETAINED but not selectable for new records; existing records may still hold them. They are listed-and-marked, not dropped.';
/**
 * R1: fires when the field is picklist-typed, `picklistValues` has no inline
 * definition, AND the `usesValueSet` edge either does not exist or does not
 * resolve to a GlobalValueSet node this vault carries. Mirrors
 * `explain-field.ts`'s `NON_INLINE_VALUE_SET_NOTE` verbatim so the two
 * surfaces read identically for the same field — without it, `null` here is
 * indistinguishable from "this picklist truly has no values".
 */
const BOUNDARY_NON_INLINE_VALUE_SET =
  'This field is picklist-typed but its value set was not inline in the field metadata — ' +
  'commonly a GlobalValueSet reference. The declared values live on that GlobalValueSet ' +
  'component, and this vault carries no resolvable usesValueSet link (vaults refreshed at ' +
  '0.1.10+ resolve it automatically); `null` here means "not inline", NOT "no values".';
/**
 * R6: fires when the full CustomField corpus scan behind `similarFields`
 * stopped at the residual node cap with strictly more fields behind it — a
 * pathological-org disclosure, not a normal-org occurrence.
 */
const BOUNDARY_SIMILAR_FIELDS_SCAN_INCOMPLETE =
  'The similar-fields corpus scan stopped at a residual node cap before covering every CustomField in the vault — similarFields may miss a genuine match past the cap.';

/**
 * Zod schema for the `sfi.field_meaning` tool input.
 *
 *   - `fieldId`: required, non-empty string. The canonical CustomField
 *     id. Prefix is enforced at the handler boundary (Zod cannot
 *     express the constraint precisely).
 */
export const fieldMeaningInputSchema = z.object({
  fieldId: z.string().min(1),
});

/** Parsed input shape, inferred from `fieldMeaningInputSchema`. */
export type FieldMeaningInput = z.infer<typeof fieldMeaningInputSchema>;

/**
 * The five-value sourceOfTruth classification per PLAN-v2.9 §3.
 * `manual` (no writers, no formula), `derived` (declared via formula
 * or auto-number), `integration-synced` (all writers integration-
 * tagged), `manual-and-coded` (mixed writers), `unknown` (cascade
 * failed or classifier not run).
 */
export type SourceOfTruthClassification =
  | 'manual'
  | 'derived'
  | 'integration-synced'
  | 'manual-and-coded'
  | 'unknown';

/**
 * The seven-value semanticCategory classification per PLAN-v2.9 §3.
 * Name-pattern + type matching; every emission is `'heuristic'`
 * confidence because patterns are conventions, not declarations.
 */
export type SemanticCategoryClassification =
  | 'identifier'
  | 'status'
  | 'amount'
  | 'date'
  | 'reference'
  | 'descriptor'
  | 'unknown';

/** One classification with its confidence label per PLAN-v2.9 §3. */
export interface FieldMeaningClassification<T extends string> {
  readonly value: T;
  readonly confidence: 'declared' | 'heuristic';
}

/** One picklist value entry, when the field is a picklist. */
export interface FieldMeaningPicklistValue {
  readonly value: string;
  readonly label: string;
  /**
   * H10: `false` marks a DEACTIVATED value — retained but not selectable for
   * new records; existing records may still hold it. Bare-string entries on
   * old vaults, and object entries with no `isActive`, normalize to `true`
   * (active). Inactive values are LISTED-and-marked, never dropped.
   */
  readonly isActive: boolean;
}

/**
 * Asymmetric incoming-edge counts per PLAN-v2.9 §4 output schema.
 *
 * `incomingReads` counts EVERY inbound edge that consumes the field's value —
 * not only `readsFrom`. It previously counted `readsFrom` alone, so a field
 * read by twelve formulas, validation rules and list views reported
 * `incomingReads: 0`, which is the number an admin deletes a field on. On the
 * reference vault that was wrong for 2,911 fields.
 *
 * `readsByEdgeType` is what lets a caller who wanted the OLD number recover it
 * exactly (`readsByEdgeType.readsFrom`), and `excludedByEdgeType` shows the
 * inbound edges that were SEEN and rejected rather than missed.
 *
 * This is an EDGE count, not a referrer count: one source component can hold
 * several `references` edges to the same field (the edge PK includes `source`),
 * so this number and `find_formula_references`'s `totalCount` — which counts
 * referencers — legitimately differ.
 */
export interface FieldMeaningUsageFrequency {
  /** `readsFrom` + `references` — every inbound edge consuming the value. */
  readonly incomingReads: number;
  /** `writesTo`. Unchanged. */
  readonly incomingWrites: number;
  /** Per-edge-type breakdown of what `incomingReads` summed. */
  readonly readsByEdgeType: Readonly<Record<string, number>>;
  /** The edge-type vocabulary `incomingReads` counted, in order. */
  readonly countedEdgeTypes: readonly string[];
  /** Inbound edge types seen and deliberately NOT counted as reads. */
  readonly excludedByEdgeType: Readonly<Record<string, number>>;
  /** Verbatim; always present. States what was counted and what was not. */
  readonly note: string;
}

/**
 * One similar-field entry. `similarityScore` is the shared-token count
 * over the union of tokens (Jaccard-like). v2.2's TF-IDF cosine is the
 * canonical source per PLAN-v2.9 §3; the token-overlap fallback ships
 * here so the tool produces output regardless of v2.2 presence.
 */
export interface FieldMeaningSimilarField {
  readonly fieldId: ComponentId;
  readonly apiName: string;
  readonly parentObjectApiName: string;
  readonly similarityScore: number;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface FieldMeaningOutput {
  readonly fieldId: ComponentId;
  readonly apiName: string;
  readonly label: string;
  readonly description: string | null;
  readonly type: string;
  readonly parentObjectId: ComponentId | null;
  readonly parentObjectApiName: string;
  readonly picklistValues: readonly FieldMeaningPicklistValue[] | null;
  readonly usageFrequency: FieldMeaningUsageFrequency;
  readonly sourceOfTruth: FieldMeaningClassification<SourceOfTruthClassification>;
  readonly semanticCategory: FieldMeaningClassification<SemanticCategoryClassification>;
  readonly similarFields: readonly FieldMeaningSimilarField[];
  readonly boundaries: readonly string[];
}

/** Allowed sourceOfTruth values for the property-shape guard. */
const SOURCE_OF_TRUTH_VALUES: ReadonlySet<string> = new Set([
  'manual',
  'derived',
  'integration-synced',
  'manual-and-coded',
  'unknown',
]);

/** Allowed semanticCategory values for the property-shape guard. */
const SEMANTIC_CATEGORY_VALUES: ReadonlySet<string> = new Set([
  'identifier',
  'status',
  'amount',
  'date',
  'reference',
  'descriptor',
  'unknown',
]);

/** Pull the field type from `properties.type` or `properties.dataType`. */
const readFieldType = (node: Node): string => {
  const direct = node.properties['type'];
  if (typeof direct === 'string') return direct;
  const dataType = node.properties['dataType'];
  return typeof dataType === 'string' ? dataType : '';
};

/** Pull the field label from properties, falling back to the node label. */
const readFieldLabel = (node: Node): string => {
  const raw = node.properties['label'];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return node.label ?? '';
};

/** Pull the field description; null when absent or non-string. */
const readFieldDescription = (node: Node): string | null => {
  const raw = node.properties['description'];
  return typeof raw === 'string' ? raw : null;
};

/**
 * Pull the parent CustomObject ApiName from the field's parentId
 * (`CustomObject:{ApiName}`). Returns the empty string for malformed
 * parents — callers display as "(unknown parent)".
 */
const parentTypeApiName = (node: Node): string => {
  if (node.parentId === null) return '';
  const colonIdx = node.parentId.indexOf(':');
  if (colonIdx < 0) return '';
  return node.parentId.slice(colonIdx + 1);
};

/**
 * Project picklist values from `properties.picklistValues` via the shared H10
 * normalizer. Each entry may be a plain string (old vault ⇒ active value) or
 * the object shape `{ value, isActive, label?, default? }` (re-extracted
 * vault); both normalize to the contract output, carrying `isActive` honestly
 * (absent / bare-string ⇒ `true`). Inactive values are LISTED-and-marked, not
 * dropped — existing records may hold them. Returns `null` only when
 * `properties.picklistValues` is not an array at all — that covers BOTH
 * "not a picklist" and "picklist, but the value set is not inline" (the
 * GlobalValueSet case; the caller resolves that separately via
 * `usesValueSet`). An empty array is preserved AS an empty array — a real
 * zero-value inline definition is a different, checked fact from "unknown"
 * and must not read the same as either (R1: the two used to collapse into
 * the same `null`).
 */
const readPicklistValues = (
  node: Node,
): readonly FieldMeaningPicklistValue[] | null => {
  const normalized = normalizePicklistValues(node.properties['picklistValues']);
  if (normalized === null) return null;
  return normalized.map((entry) => ({
    value: entry.value,
    label: entry.label ?? entry.value,
    isActive: entry.isActive,
  }));
};

/**
 * Pull the sourceOfTruth classification from `properties.sourceOfTruth`.
 * Expects `{ value, confidence }`. Returns `{ value: 'unknown',
 * confidence: 'heuristic' }` when the property is absent or malformed —
 * the v2.9 R3 classifier may not have run; the boundary list surfaces
 * this fallback.
 */
const readSourceOfTruth = (
  node: Node,
): {
  classification: FieldMeaningClassification<SourceOfTruthClassification>;
  populated: boolean;
} => {
  const raw = node.properties['sourceOfTruth'];
  if (typeof raw === 'object' && raw !== null) {
    const obj = raw as Record<string, unknown>;
    const value = obj['value'];
    const confidence = obj['confidence'];
    if (
      typeof value === 'string' &&
      SOURCE_OF_TRUTH_VALUES.has(value) &&
      (confidence === 'declared' || confidence === 'heuristic')
    ) {
      return {
        classification: {
          value: value as SourceOfTruthClassification,
          confidence,
        },
        populated: true,
      };
    }
  }
  return {
    classification: { value: 'unknown', confidence: 'heuristic' },
    populated: false,
  };
};

/**
 * Pull the semanticCategory classification from
 * `properties.semanticCategory`. Same fallback shape as sourceOfTruth.
 */
const readSemanticCategory = (
  node: Node,
): {
  classification: FieldMeaningClassification<SemanticCategoryClassification>;
  populated: boolean;
} => {
  const raw = node.properties['semanticCategory'];
  if (typeof raw === 'object' && raw !== null) {
    const obj = raw as Record<string, unknown>;
    const value = obj['value'];
    const confidence = obj['confidence'];
    if (
      typeof value === 'string' &&
      SEMANTIC_CATEGORY_VALUES.has(value) &&
      confidence === 'heuristic'
    ) {
      return {
        classification: {
          value: value as SemanticCategoryClassification,
          confidence,
        },
        populated: true,
      };
    }
  }
  return {
    classification: { value: 'unknown', confidence: 'heuristic' },
    populated: false,
  };
};

/**
 * Tokenize an apiName or label into lowercase tokens for similarity.
 * Strips `__c` / `__r` suffixes, splits on underscores, splits on
 * camelCase boundaries. v2.2's tokenizer is the canonical version
 * per PLAN-v2.9 §3; this lightweight fallback ships so similarFields
 * produces output without the v2.2 dependency.
 */
const tokenize = (raw: string): Set<string> => {
  const stripped = raw.replace(/__[cr]$/i, '');
  const underscoreSplit = stripped.split('_');
  const tokens = new Set<string>();
  for (const part of underscoreSplit) {
    // Split on camelCase: insert a space before a capital that follows
    // a lowercase, then lowercase the lot.
    const camelSplit = part.replace(/([a-z])([A-Z])/g, '$1 $2').split(' ');
    for (const tok of camelSplit) {
      const lower = tok.toLowerCase();
      if (lower.length >= 2) tokens.add(lower);
    }
  }
  return tokens;
};

/** Jaccard-like overlap: |intersection| / |union|, range [0.0, 1.0]. */
const tokenOverlap = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const tok of a) {
    if (b.has(tok)) shared += 1;
  }
  const unionSize = a.size + b.size - shared;
  return unionSize === 0 ? 0 : shared / unionSize;
};

/** {@link findSimilarFields}'s result: the ranked top-N plus the shared scan's residual-cap disclosure. */
interface SimilarFieldsResult {
  readonly fields: readonly FieldMeaningSimilarField[];
  /** True only when the corpus scan hit `FULL_SCAN_MAX_NODES` with strictly more CustomFields behind it. */
  readonly scanIncomplete: boolean;
}

/**
 * Find similar fields by token overlap. Enumerates every CustomField in the
 * graph via the shared {@link scanAllNodesOfTypes} multi-window walk (R6 —
 * this used to be a private copy of that same offset-windowing loop, with
 * `500` hardcoded in place of the shared `NODE_SCAN_HARD_CAP`) and scores by
 * overlap of label-tokens + apiName-tokens. Returns the top
 * `SIMILAR_FIELDS_LIMIT` ranked by score DESC then id ASC, plus whether the
 * corpus scan itself was left incomplete by a pathological-org residual cap.
 * Excludes the seed field itself.
 */
const findSimilarFields = async (
  ctx: Context,
  seed: Node,
): Promise<Result<SimilarFieldsResult, string>> => {
  const seedTokens = new Set<string>();
  for (const tok of tokenize(seed.apiName)) seedTokens.add(tok);
  for (const tok of tokenize(readFieldLabel(seed))) seedTokens.add(tok);
  if (seedTokens.size === 0) return ok({ fields: [], scanIncomplete: false });

  const scanResult = await scanAllNodesOfTypes(ctx.graph, ['CustomField']);
  if (!scanResult.ok) {
    return err(scanResult.error.message);
  }
  const allFields = scanResult.value.nodes;

  const scored: FieldMeaningSimilarField[] = [];
  for (const candidate of allFields) {
    if (candidate.id === seed.id) continue;
    const candTokens = new Set<string>();
    for (const tok of tokenize(candidate.apiName)) candTokens.add(tok);
    for (const tok of tokenize(readFieldLabel(candidate))) candTokens.add(tok);
    const score = tokenOverlap(seedTokens, candTokens);
    if (score <= 0) continue;
    scored.push({
      fieldId: candidate.id,
      apiName: candidate.apiName,
      parentObjectApiName: parentTypeApiName(candidate),
      similarityScore: score,
    });
  }

  scored.sort((a, b) => {
    if (a.similarityScore !== b.similarityScore) {
      return b.similarityScore - a.similarityScore;
    }
    return a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0;
  });
  return ok({
    fields: scored.slice(0, SIMILAR_FIELDS_LIMIT),
    scanIncomplete: scanResult.value.scanIncomplete,
  });
};

/**
 * Bucket every inbound edge against the shared value-consuming vocabulary.
 *
 * ONE unfiltered `listEdges` replaces the two filtered calls this used to make.
 * `listEdges` applies NO limit, so the bucket counts are exact and cannot
 * silently truncate; fan-in per CustomField on the reference vault peaks at 184
 * with a mean of 8.5, so one query for two is a net win.
 *
 * The vocabulary lives in `coverage-trust.ts`
 * ({@link FIELD_VALUE_CONSUMING_EDGE_TYPES} /
 * {@link FIELD_VALUE_WRITING_EDGE_TYPES}) rather than being implicit in what
 * this function did not ask for. `field_lineage` and `find_field_anywhere`
 * already walk all inbound edges and agree with it — this is the tool that
 * disagreed.
 */
const countUsage = async (
  ctx: Context,
  fieldId: ComponentId,
): Promise<Result<FieldMeaningUsageFrequency, string>> => {
  const inboundResult = await listEdges(ctx.graph, fieldId, {
    direction: 'in',
  });
  if (!inboundResult.ok) return err(inboundResult.error.message);

  const readsByEdgeType: Record<string, number> = {};
  const excludedByEdgeType: Record<string, number> = {};
  let incomingReads = 0;
  let incomingWrites = 0;
  for (const edge of inboundResult.value) {
    const type = edge.edgeType;
    if ((FIELD_VALUE_CONSUMING_EDGE_TYPES as readonly string[]).includes(type)) {
      incomingReads += 1;
      readsByEdgeType[type] = (readsByEdgeType[type] ?? 0) + 1;
      continue;
    }
    if ((FIELD_VALUE_WRITING_EDGE_TYPES as readonly string[]).includes(type)) {
      incomingWrites += 1;
      continue;
    }
    excludedByEdgeType[type] = (excludedByEdgeType[type] ?? 0) + 1;
  }

  return ok({
    incomingReads,
    incomingWrites,
    readsByEdgeType,
    countedEdgeTypes: [...FIELD_VALUE_CONSUMING_EDGE_TYPES],
    excludedByEdgeType,
    note: USAGE_FREQUENCY_NOTE,
  });
};

/**
 * The `sfi.field_meaning` MCP tool. Returns the field's declared
 * shape + v2.9 vocabulary classifications + usage frequency + top-3
 * similar fields + boundary disclosures. See module JSDoc for the
 * composition seams and the honesty axis.
 *
 * @example
 *   const r = await fieldMeaningHandler(ctx, {
 *     fieldId: 'CustomField:Account.Industry__c',
 *   });
 *   if (r.ok) console.log(r.value.data.semanticCategory.value);
 */
export const fieldMeaningHandler = async (
  ctx: Context,
  input: FieldMeaningInput,
): Promise<Result<McpResponse<FieldMeaningOutput>, McpError>> => {
  // FLD-02: graceful object→field routing.
  const suggestionResult = await resolveToFieldOrSuggest(ctx, input.fieldId);
  if (!suggestionResult.ok) return suggestionResult;
  if (suggestionResult.value !== null) {
    return ok(suggestionResult.value as unknown as McpResponse<FieldMeaningOutput>);
  }

  if (!input.fieldId.startsWith(CUSTOM_FIELD_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `fieldId must start with '${CUSTOM_FIELD_PREFIX}'; got '${input.fieldId}'`,
      path: 'fieldId',
    });
  }
  const fieldId = input.fieldId as ComponentId;

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
  const node = nodeResult.value;
  if (node.type !== 'CustomField') {
    return err({
      kind: 'component-not-found',
      message: `node ${fieldId} is not a CustomField (type=${node.type})`,
      path: fieldId,
    });
  }

  const sourceOfTruthRead = readSourceOfTruth(node);
  const semanticCategoryRead = readSemanticCategory(node);

  const usageResult = await countUsage(ctx, fieldId);
  if (!usageResult.ok) {
    return err({ kind: 'internal', message: usageResult.error });
  }

  const similarResult = await findSimilarFields(ctx, node);
  if (!similarResult.ok) {
    return err({ kind: 'internal', message: similarResult.error });
  }

  const fieldType = readFieldType(node);
  let picklistValues = readPicklistValues(node);
  // R1: a picklist-typed field whose inline `picklistValues` is null may be
  // GlobalValueSet-driven (0.1.10+ vaults resolve the usesValueSet edge) —
  // resolve it so the answer carries the real values instead of reading as
  // "no values" (see `explain-field.ts`, which already does this).
  if (picklistValues === null && PICKLIST_DATA_TYPES.includes(fieldType)) {
    const fromGvs = await resolveGlobalValueSetValues(ctx, fieldId);
    if (fromGvs !== null) {
      picklistValues = fromGvs.values.map((entry) => ({
        value: entry.value,
        label: entry.label ?? entry.value,
        isActive: entry.isActive,
      }));
    }
  }

  const boundaries: string[] = [
    BOUNDARY_VOCABULARY_ORG_SPECIFIC,
    BOUNDARY_USAGE_STATIC_ONLY,
  ];
  if (sourceOfTruthRead.classification.confidence === 'heuristic') {
    boundaries.push(BOUNDARY_CLASSIFICATION_HEURISTIC);
  }
  if (semanticCategoryRead.classification.value !== 'unknown') {
    boundaries.push(BOUNDARY_SEMANTIC_NAME_PATTERN);
  }
  if (!sourceOfTruthRead.populated && !semanticCategoryRead.populated) {
    boundaries.push(BOUNDARY_CLASSIFICATION_MISSING);
  }
  if (picklistValues !== null && picklistValues.some((v) => !v.isActive)) {
    boundaries.push(BOUNDARY_INACTIVE_PICKLIST_VALUES);
  }
  // R1: still null after the GVS resolution attempt above — the value set
  // is genuinely not reachable from this node, so say so instead of letting
  // `null` read like a checked-and-empty picklist.
  if (picklistValues === null && PICKLIST_DATA_TYPES.includes(fieldType)) {
    boundaries.push(BOUNDARY_NON_INLINE_VALUE_SET);
  }
  if (usageResult.value.incomingReads === 0) {
    boundaries.push(BOUNDARY_ZERO_READS);
  }
  if (similarResult.value.scanIncomplete) {
    boundaries.push(BOUNDARY_SIMILAR_FIELDS_SCAN_INCOMPLETE);
  }

  return ok({
    data: {
      fieldId,
      apiName: node.apiName,
      label: readFieldLabel(node),
      description: readFieldDescription(node),
      type: fieldType,
      parentObjectId: node.parentId,
      parentObjectApiName: parentTypeApiName(node),
      picklistValues,
      usageFrequency: usageResult.value,
      sourceOfTruth: sourceOfTruthRead.classification,
      semanticCategory: semanticCategoryRead.classification,
      similarFields: similarResult.value.fields,
      boundaries,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
