/**
 * Handler for the `sfi.disambiguate_concepts` MCP tool.
 *
 * v2.9 R4 — the "is `Status` the same as `Stage` here?" surface
 * (PLAN-v2.9 §4). Given two org-specific concept tokens, finds every
 * CustomField whose tokenized apiName or label overlaps each concept,
 * partitions them into two buckets, and computes per-axis differences
 * (parent-object distribution, declared types, picklist values,
 * usage patterns).
 *
 * Concept matching rules (PLAN-v2.9 §4):
 *   1. apiName tokenized form overlaps the concept's tokens, OR
 *   2. label tokenized form overlaps the concept's tokens, OR
 *   3. `properties.semanticCategory.value` equals the concept,
 *      lowercased (e.g., `'status'` matches `Status`).
 *
 * Honesty anchor (PLAN-v2.9 §4 / Q155):
 *   Every result carries the verbatim "vocabulary is org-specific"
 *   disclosure in `boundaries`. The skill SHOULD surface this anchor
 *   to the user unconditionally.
 *
 * Implementation notes:
 *   - When `conceptA === conceptB` (case-insensitive trimmed), the
 *     tool returns identical buckets and an empty `differences` array.
 *     The skill detects this and explains there is no distinction
 *     (PLAN-v2.9 §5 refusal pattern, Q150).
 *   - `suggestedWhenToUseEach` is `null` when bucket parent-object
 *     distributions overlap heavily; only set when distributions are
 *     distinct enough to recommend.
 *   - Tokenization is the lightweight fallback (matches
 *     field-meaning.ts) — v2.2's full tokenizer is the canonical
 *     source per PLAN-v2.9 §3.
 *   - `limit` caps each bucket's `matchingFields` count to keep
 *     payloads bounded; default 50, max 200.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

/**
 * Verbatim Q155 honesty anchor (PLAN-v2.9 §7). Frozen here so the test
 * suite can assert the exact string and so caller-facing rephrasing
 * during rendering is a code-review concern, not silent drift.
 */
const BOUNDARY_Q155 =
  "Vocabulary is org-specific — one org's 'Status' is another org's 'Stage'; the tool reports what THIS org's metadata declares, not industry convention. Verify each field's label, description, and usage before treating the disambiguation as authoritative.";

/** Default and ceiling for the per-bucket `matchingFields` slice. */
const MATCHING_FIELDS_DEFAULT_LIMIT = 50;
const MATCHING_FIELDS_MAX_LIMIT = 200;

/**
 * Page size for the full CustomField corpus scan. Equal to the graph layer's
 * `LIST_MAX_LIMIT` so each page round-trips the maximum allowed; we page with
 * `offset` until exhausted. Disambiguation compares concepts across EVERY
 * field, so a single default-50 page (or even a single 500 page) silently
 * under-counts on real orgs (acme has 1034 CustomFields).
 */
const CUSTOM_FIELD_PAGE_SIZE = 500;

/**
 * Zod schema for the `sfi.disambiguate_concepts` tool input.
 *
 *   - `conceptA`, `conceptB`: required, non-empty strings.
 *   - `limit`: optional cap on each bucket's matchingFields count.
 */
export const disambiguateConceptsInputSchema = z.object({
  conceptA: z.string().min(1),
  conceptB: z.string().min(1),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MATCHING_FIELDS_MAX_LIMIT)
    .optional(),
});

/** Parsed input shape, inferred from the Zod schema. */
export type DisambiguateConceptsInput = z.infer<
  typeof disambiguateConceptsInputSchema
>;

/**
 * One field matching a concept. `matchedOn` records WHY the field
 * matched (apiName-tokens / label-tokens / semantic-category) so the
 * caller can show evidence. `parentObjectApiName` is the parent
 * CustomObject for the parent-object difference axis.
 */
export interface ConceptFieldMatch {
  readonly fieldId: ComponentId;
  readonly apiName: string;
  readonly label: string;
  readonly type: string;
  readonly parentObjectApiName: string;
  readonly matchedOn: readonly ('apiName' | 'label' | 'semantic-category')[];
}

/** One concept bucket: the tokenized form + the matching fields. */
export interface ConceptBucket {
  readonly name: string;
  readonly tokenizedForm: string;
  readonly matchingFields: readonly ConceptFieldMatch[];
}

/** One per-axis difference between the two buckets. */
export interface ConceptDifference {
  readonly axis: 'parent-object' | 'type' | 'picklist-values' | 'usage-pattern';
  readonly summary: string;
}

/**
 * Optional "when to use each" inference. `null` when bucket
 * distributions overlap heavily — the tool refuses to fabricate
 * distinction (PLAN-v2.9 §4).
 */
export interface SuggestedWhenToUseEach {
  readonly conceptA: string;
  readonly conceptB: string;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface DisambiguateConceptsOutput {
  readonly conceptA: ConceptBucket;
  readonly conceptB: ConceptBucket;
  readonly differences: readonly ConceptDifference[];
  readonly suggestedWhenToUseEach: SuggestedWhenToUseEach | null;
  readonly boundaries: readonly string[];
}

/**
 * Tokenize a concept or field-name into lowercase tokens. Strips
 * `__c` / `__r` suffixes, splits on underscores, splits on camelCase
 * boundaries. Tokens of length < 2 are dropped to suppress noise. The
 * `tokenizedForm` returned alongside each bucket is the sorted
 * space-joined token list — deterministic + user-readable.
 */
const tokenize = (raw: string): Set<string> => {
  const stripped = raw.replace(/__[cr]$/i, '');
  const underscoreSplit = stripped.split('_');
  const tokens = new Set<string>();
  for (const part of underscoreSplit) {
    const camelSplit = part.replace(/([a-z])([A-Z])/g, '$1 $2').split(' ');
    for (const tok of camelSplit) {
      const lower = tok.toLowerCase();
      if (lower.length >= 2) tokens.add(lower);
    }
  }
  return tokens;
};

/** Render the tokenized form as a deterministic space-joined string. */
const renderTokenizedForm = (tokens: Set<string>): string =>
  [...tokens].sort().join(' ');

/** Read a field's label, falling back to the node label or empty. */
const readFieldLabel = (node: Node): string => {
  const raw = node.properties['label'];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return node.label ?? '';
};

/** Read a field's type from `properties.type` or `properties.dataType`. */
const readFieldType = (node: Node): string => {
  const direct = node.properties['type'];
  if (typeof direct === 'string') return direct;
  const dataType = node.properties['dataType'];
  return typeof dataType === 'string' ? dataType : '';
};

/** Pull the parent CustomObject ApiName from the field's parentId. */
const parentTypeApiName = (node: Node): string => {
  if (node.parentId === null) return '';
  const colonIdx = node.parentId.indexOf(':');
  if (colonIdx < 0) return '';
  return node.parentId.slice(colonIdx + 1);
};

/**
 * Pull the v2.9 semanticCategory value from the field's properties.
 * Returns the empty string when the property is absent or malformed
 * (the concept-match step then can't fire on the semantic-category
 * axis, which is the correct degradation).
 */
const readSemanticCategoryValue = (node: Node): string => {
  const raw = node.properties['semanticCategory'];
  if (typeof raw !== 'object' || raw === null) return '';
  const obj = raw as Record<string, unknown>;
  const value = obj['value'];
  return typeof value === 'string' ? value : '';
};

/**
 * Decide whether a field matches a concept's token set. Returns the
 * list of axes that fired (empty when no match). Multi-axis matches
 * are kept as evidence so the caller can show why.
 */
const matchAxes = (
  node: Node,
  conceptTokens: Set<string>,
  conceptValueLower: string,
): readonly ('apiName' | 'label' | 'semantic-category')[] => {
  const axes: ('apiName' | 'label' | 'semantic-category')[] = [];
  const apiTokens = tokenize(node.apiName);
  for (const tok of conceptTokens) {
    if (apiTokens.has(tok)) {
      axes.push('apiName');
      break;
    }
  }
  const labelTokens = tokenize(readFieldLabel(node));
  for (const tok of conceptTokens) {
    if (labelTokens.has(tok)) {
      axes.push('label');
      break;
    }
  }
  const semanticValue = readSemanticCategoryValue(node);
  if (
    semanticValue.length > 0 &&
    conceptValueLower === semanticValue.toLowerCase()
  ) {
    axes.push('semantic-category');
  }
  return axes;
};

/**
 * Build one concept bucket: enumerate every CustomField, score each
 * for a match against the concept's tokens, return the matching set
 * (capped to `limit`). The fields are sorted by id ASC for stable
 * output.
 */
const buildBucket = (
  conceptName: string,
  fields: readonly Node[],
  limit: number,
): ConceptBucket => {
  const tokens = tokenize(conceptName);
  const conceptValueLower = conceptName.trim().toLowerCase();
  const matchingFields: ConceptFieldMatch[] = [];
  for (const field of fields) {
    const axes = matchAxes(field, tokens, conceptValueLower);
    if (axes.length === 0) continue;
    matchingFields.push({
      fieldId: field.id,
      apiName: field.apiName,
      label: readFieldLabel(field),
      type: readFieldType(field),
      parentObjectApiName: parentTypeApiName(field),
      matchedOn: axes,
    });
  }
  matchingFields.sort((a, b) =>
    a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0,
  );
  return {
    name: conceptName,
    tokenizedForm: renderTokenizedForm(tokens),
    matchingFields: matchingFields.slice(0, limit),
  };
};

/**
 * Collect distinct parent-object ApiNames from a bucket's matching
 * fields. Empty string parents are filtered out.
 */
const distinctParents = (bucket: ConceptBucket): Set<string> => {
  const out = new Set<string>();
  for (const m of bucket.matchingFields) {
    if (m.parentObjectApiName.length > 0) out.add(m.parentObjectApiName);
  }
  return out;
};

/** Collect distinct field types from a bucket's matching fields. */
const distinctTypes = (bucket: ConceptBucket): Set<string> => {
  const out = new Set<string>();
  for (const m of bucket.matchingFields) {
    if (m.type.length > 0) out.add(m.type);
  }
  return out;
};

/** Render a sorted comma-joined list for difference summaries. */
const renderList = (s: Set<string>): string =>
  [...s].sort().join(', ');

/**
 * Compute per-axis differences between two buckets. Each axis emits
 * 0 or 1 summary; the order is fixed per the contract (parent-object,
 * type, picklist-values, usage-pattern).
 */
const computeDifferences = (
  a: ConceptBucket,
  b: ConceptBucket,
): readonly ConceptDifference[] => {
  const out: ConceptDifference[] = [];

  // parent-object axis: list parents distinct to each bucket.
  const parentsA = distinctParents(a);
  const parentsB = distinctParents(b);
  const onlyA = [...parentsA].filter((p) => !parentsB.has(p));
  const onlyB = [...parentsB].filter((p) => !parentsA.has(p));
  if (onlyA.length > 0 || onlyB.length > 0) {
    const summary = `${a.name} appears on ${renderList(parentsA) || '(none)'}; ${b.name} appears on ${renderList(parentsB) || '(none)'}.`;
    out.push({ axis: 'parent-object', summary });
  }

  // type axis: list distinct types per bucket; emit when sets differ.
  const typesA = distinctTypes(a);
  const typesB = distinctTypes(b);
  const typesAStr = renderList(typesA);
  const typesBStr = renderList(typesB);
  if (typesAStr !== typesBStr) {
    const summary = `${a.name} types: ${typesAStr || '(none)'}; ${b.name} types: ${typesBStr || '(none)'}.`;
    out.push({ axis: 'type', summary });
  }

  // picklist-values axis: best-effort signal. Without v2.2 TF-IDF and
  // a full per-field picklist enumeration, the axis only fires when
  // the two buckets disagree on whether any picklist fields are
  // present at all (heuristic; the skill surfaces the boundary).
  const aHasPicklist = a.matchingFields.some(
    (m) => m.type === 'Picklist' || m.type === 'MultiselectPicklist',
  );
  const bHasPicklist = b.matchingFields.some(
    (m) => m.type === 'Picklist' || m.type === 'MultiselectPicklist',
  );
  if (aHasPicklist !== bHasPicklist) {
    const summary = `${a.name} ${aHasPicklist ? 'includes' : 'does not include'} picklist fields; ${b.name} ${bHasPicklist ? 'includes' : 'does not include'} picklist fields.`;
    out.push({ axis: 'picklist-values', summary });
  }

  // usage-pattern axis: matchingFields count per bucket. Emit when
  // counts differ by >= 2 — the threshold avoids false signals when
  // bucket sizes happen to be 4 vs 5.
  const countDiff = Math.abs(
    a.matchingFields.length - b.matchingFields.length,
  );
  if (countDiff >= 2) {
    const summary = `${a.name} matches ${a.matchingFields.length} field(s); ${b.name} matches ${b.matchingFields.length} field(s).`;
    out.push({ axis: 'usage-pattern', summary });
  }

  return out;
};

/**
 * Decide whether to emit a "when to use each" inference. Heuristic:
 * fires only when the parent-object distributions are entirely
 * disjoint AND both buckets have at least one match. Otherwise null —
 * the tool refuses to fabricate distinction (PLAN-v2.9 §4).
 */
const inferWhenToUseEach = (
  a: ConceptBucket,
  b: ConceptBucket,
): SuggestedWhenToUseEach | null => {
  if (a.matchingFields.length === 0 || b.matchingFields.length === 0) {
    return null;
  }
  const parentsA = distinctParents(a);
  const parentsB = distinctParents(b);
  if (parentsA.size === 0 || parentsB.size === 0) return null;
  for (const p of parentsA) {
    if (parentsB.has(p)) return null;
  }
  return {
    conceptA: `Use ${a.name} when working with: ${renderList(parentsA)}.`,
    conceptB: `Use ${b.name} when working with: ${renderList(parentsB)}.`,
  };
};

/**
 * Detect "same concept twice" — case-insensitive trimmed equality.
 * When detected the tool returns mirror buckets + empty differences;
 * the skill is responsible for refusing to fabricate a distinction
 * (PLAN-v2.9 §5 refusal pattern; Q150).
 */
const isSameConcept = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The `sfi.disambiguate_concepts` MCP tool. Returns per-concept
 * matching-field buckets, per-axis differences, an optional
 * "when to use each" inference, and the Q155 honesty disclosure.
 * See module JSDoc for the matching rules and the same-concept refusal.
 *
 * @example
 *   const r = await disambiguateConceptsHandler(ctx, {
 *     conceptA: 'Status',
 *     conceptB: 'Stage',
 *   });
 *   if (r.ok) console.log(r.value.data.differences.length);
 */
export const disambiguateConceptsHandler = async (
  ctx: Context,
  input: DisambiguateConceptsInput,
): Promise<Result<McpResponse<DisambiguateConceptsOutput>, McpError>> => {
  const limit = input.limit ?? MATCHING_FIELDS_DEFAULT_LIMIT;

  // Scan the ENTIRE CustomField corpus, not just the graph layer's default
  // first page (50 rows): disambiguation compares concepts across all of the
  // org's fields. `listNodesByType` caps a single call at 500, so page through
  // with `offset` until a short page signals exhaustion.
  const fields: Node[] = [];
  for (let offset = 0; ; offset += CUSTOM_FIELD_PAGE_SIZE) {
    const fieldsResult = await listNodesByType(ctx.graph, 'CustomField', {
      limit: CUSTOM_FIELD_PAGE_SIZE,
      offset,
    });
    if (!fieldsResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${fieldsResult.error.message}`,
      });
    }
    fields.push(...fieldsResult.value);
    if (fieldsResult.value.length < CUSTOM_FIELD_PAGE_SIZE) break;
  }

  const bucketA = buildBucket(input.conceptA, fields, limit);
  const bucketB = buildBucket(input.conceptB, fields, limit);

  // Same-concept short-circuit. Return mirror buckets + empty
  // differences + null suggested-when-to-use; skill refuses upstream.
  if (isSameConcept(input.conceptA, input.conceptB)) {
    return ok({
      data: {
        conceptA: bucketA,
        conceptB: bucketB,
        differences: [],
        suggestedWhenToUseEach: null,
        boundaries: [BOUNDARY_Q155],
      },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  }

  const differences = computeDifferences(bucketA, bucketB);
  const suggested = inferWhenToUseEach(bucketA, bucketB);

  return ok({
    data: {
      conceptA: bucketA,
      conceptB: bucketB,
      differences,
      suggestedWhenToUseEach: suggested,
      boundaries: [BOUNDARY_Q155],
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
