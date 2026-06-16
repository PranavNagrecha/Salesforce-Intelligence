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
import { getNodeById, listEdges, listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { fieldNotFoundError } from './field-not-found-suggest.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import { resolveToFieldOrSuggest } from './resolve-field-or-suggest.js';

/** Canonical id prefix for the CustomField node type. */
const CUSTOM_FIELD_PREFIX = 'CustomField:';

/** Maximum similarFields returned. PLAN-v2.9 §4 specifies "top-3". */
const SIMILAR_FIELDS_LIMIT = 3;

/**
 * Page size for the full-corpus CustomField scan. `listNodesByType` caps a
 * page at 500 (LIST_MAX_LIMIT) and DEFAULTS to 50 when no limit is passed —
 * so the similarity scan must page through every field with an explicit
 * limit + offset or it silently considers only the first 50 fields by id.
 */
const SIMILAR_FIELDS_PAGE_SIZE = 500;

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
}

/** Asymmetric incoming-edge counts per PLAN-v2.9 §4 output schema. */
export interface FieldMeaningUsageFrequency {
  readonly incomingReads: number;
  readonly incomingWrites: number;
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
 * Project picklist values from `properties.picklistValues`. Each entry
 * may be a plain string or `{ value, label }`; both shapes normalize
 * to the contract output. Returns `null` when no picklist data exists,
 * preserving the "this is not a picklist" signal.
 */
const readPicklistValues = (
  node: Node,
): readonly FieldMeaningPicklistValue[] | null => {
  const raw = node.properties['picklistValues'];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: FieldMeaningPicklistValue[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      out.push({ value: entry, label: entry });
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    const value =
      typeof obj['value'] === 'string'
        ? obj['value']
        : typeof obj['fullName'] === 'string'
          ? (obj['fullName'] as string)
          : '';
    if (value.length === 0) continue;
    const label = typeof obj['label'] === 'string' ? obj['label'] : value;
    out.push({ value, label });
  }
  return out.length === 0 ? null : out;
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

/**
 * Find similar fields by token overlap. Enumerates every CustomField
 * in the graph and scores by overlap of label-tokens + apiName-tokens.
 * Returns the top `SIMILAR_FIELDS_LIMIT` ranked by score DESC then
 * id ASC. Excludes the seed field itself.
 */
const findSimilarFields = async (
  ctx: Context,
  seed: Node,
): Promise<Result<readonly FieldMeaningSimilarField[], string>> => {
  const seedTokens = new Set<string>();
  for (const tok of tokenize(seed.apiName)) seedTokens.add(tok);
  for (const tok of tokenize(readFieldLabel(seed))) seedTokens.add(tok);
  if (seedTokens.size === 0) return ok([]);

  // Page through EVERY CustomField — a single unbounded listNodesByType
  // defaults to 50 rows, truncating the similarity corpus to the first 50
  // fields by id (so the top-N is drawn from a tiny alphabetical prefix and
  // misses genuine matches like an identical-name field on a later object).
  const allFields: Node[] = [];
  for (let offset = 0; ; offset += SIMILAR_FIELDS_PAGE_SIZE) {
    const page = await listNodesByType(ctx.graph, 'CustomField', {
      limit: SIMILAR_FIELDS_PAGE_SIZE,
      offset,
    });
    if (!page.ok) {
      return err(page.error.message);
    }
    allFields.push(...page.value);
    if (page.value.length < SIMILAR_FIELDS_PAGE_SIZE) break;
  }

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
  return ok(scored.slice(0, SIMILAR_FIELDS_LIMIT));
};

/** Count incoming `readsFrom` and `writesTo` edges separately. */
const countUsage = async (
  ctx: Context,
  fieldId: ComponentId,
): Promise<Result<FieldMeaningUsageFrequency, string>> => {
  const readsResult = await listEdges(ctx.graph, fieldId, {
    direction: 'in',
    edgeType: 'readsFrom',
  });
  if (!readsResult.ok) return err(readsResult.error.message);
  const writesResult = await listEdges(ctx.graph, fieldId, {
    direction: 'in',
    edgeType: 'writesTo',
  });
  if (!writesResult.ok) return err(writesResult.error.message);
  return ok({
    incomingReads: readsResult.value.length,
    incomingWrites: writesResult.value.length,
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

  return ok({
    data: {
      fieldId,
      apiName: node.apiName,
      label: readFieldLabel(node),
      description: readFieldDescription(node),
      type: readFieldType(node),
      parentObjectId: node.parentId,
      parentObjectApiName: parentTypeApiName(node),
      picklistValues: readPicklistValues(node),
      usageFrequency: usageResult.value,
      sourceOfTruth: sourceOfTruthRead.classification,
      semanticCategory: semanticCategoryRead.classification,
      similarFields: similarResult.value,
      boundaries,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
