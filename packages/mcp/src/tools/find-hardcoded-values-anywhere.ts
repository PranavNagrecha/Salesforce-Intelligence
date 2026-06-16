/**
 * Handler for the `sfi.find_hardcoded_values_anywhere` MCP tool.
 *
 * The v2.2 cross-component-type hardcoded-value scan — broader than
 * v2.1's `sfi.find_hardcoded_values` (which scopes to Apex recognizer
 * findings only). v2.2's tool extends the Apex `qualityIssues` surface
 * with cross-corpus scans:
 *
 *   - **Apex**: composes the existing v2.1
 *     `properties.qualityIssues[]` array on ApexClass / ApexTrigger
 *     nodes for the four hardcoded-literal rules (`hardcoded-id`,
 *     `hardcoded-email`, `hardcoded-username`,
 *     `hardcoded-sandbox-test-data`).
 *   - **Formula** (CustomField formula expressions): scans the
 *     `properties.formula` string for ID-shape, email-shape, date-
 *     shape, and (when `value` is specified) exact-substring matches.
 *   - **ValidationRule**: scans the
 *     `properties.errorConditionFormula` string for the same
 *     pattern catalog.
 *   - **WorkflowRule**: scans the optional `properties.formula`
 *     string for the same pattern catalog.
 *
 * **Match modes** (per `SemanticSearchSemantics.md` § "Hardcoded-
 * value detection patterns"):
 *
 *   - Exact-value mode: `value` is specified; the tool searches for
 *     the literal across all corpora. `confidence: 'declared'`.
 *   - Shape mode: `category` is specified and `value` is omitted; the
 *     tool applies the per-category regex (`id`, `email`, `date`).
 *     `confidence: 'heuristic'`.
 *   - Combined mode: both `value` and `category` specified; the
 *     `category` filters the matches and `value` narrows further.
 *
 * **v2.2 honesty axis:** the numeric category is intentionally
 * suppressed from the default search — its false-positive rate is so
 * high (loop counters, array indices, arithmetic constants all match)
 * that surfacing every match is noise. The verbatim disclosure is
 * surfaced when the user requests `category: 'numeric'`.
 *
 * **Composition recipe:**
 *   - For Apex scope: walks ApexClass and ApexTrigger nodes,
 *     composes their existing v2.1 `qualityIssues[]` findings for the
 *     four hardcoded-literal rules. When `value` is specified, also
 *     filters the `explanation` field to substring-match the value.
 *   - For formula scope: walks CustomField nodes whose
 *     `properties.formula` is non-null, applies the per-category
 *     regex (or substring match when `value` is specified).
 *   - For validation-rule scope: walks ValidationRule nodes whose
 *     `properties.errorConditionFormula` is non-null, applies the
 *     same pattern catalog.
 *   - For workflow-rule scope: walks WorkflowRule nodes whose
 *     `properties.formula` is non-null, applies the same pattern
 *     catalog.
 *
 * Implementation notes:
 *   - The four hardcoded-rule names match v2.1's
 *     `find-hardcoded-values` mapping; the v2.2 tool extends NOT
 *     replaces.
 *   - Per `SemanticSearchSemantics.md` § "Salesforce ID pattern", the
 *     ID regex is `\b0[0-9a-zA-Z]{14}([0-9a-zA-Z]{3})?\b`.
 *   - Per § "Email pattern", the email regex is the RFC-5321 strict
 *     form `\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b`.
 *   - Per § "Date pattern", multiple shapes are matched.
 *   - `limit` defaults to 100 and is capped at 500.
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { mergeInputAliases } from './input-aliases.js';

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;
const PAGE_SIZE = 500;
const MAX_PAGES = 20;

/** Salesforce ID regex per `SemanticSearchSemantics.md` § "Salesforce ID pattern". */
const SALESFORCE_ID_REGEX = /\b0[0-9a-zA-Z]{14}([0-9a-zA-Z]{3})?\b/g;
/** Email regex per § "Email pattern". */
const EMAIL_REGEX = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;
/** Date regex (union of ISO/US/EU/SF shapes) per § "Date pattern". */
const DATE_REGEX =
  /\b(\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})?)?|\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}\.\d{1,2}\.\d{4}|\d{4}\/\d{2}\/\d{2})\b/g;
/** Numeric regex per § "Numeric pattern" — opt-in only. */
const NUMERIC_REGEX = /\b\d+(\.\d+)?\b/g;

/** Apex quality rules that count as hardcoded-literal findings (v2.1). */
const HARDCODED_APEX_RULES: ReadonlySet<string> = new Set([
  'hardcoded-id',
  'hardcoded-email',
  'hardcoded-username',
  'hardcoded-url',
  'hardcoded-sandbox-test-data',
]);

const NUMERIC_FP_DISCLOSURE =
  'the numeric category has very high false-positive rate — loop counters, array indices, and arithmetic constants all match. The category is suppressed from default searches; opt in explicitly only when looking for specific hardcoded numbers.';
const ID_FP_DISCLOSURE =
  'the ID-shape search matches Salesforce-id-shaped strings filtered to a known-key-prefix allowlist (~40 prefixes). Arbitrary 15-character alphanumeric strings outside the allowlist are not returned. Strings shaped like an ID that aren\'t actually IDs (e.g., session keys, hashes) may still match if they happen to start with a known key prefix.';
const TEST_CLASS_REFUSAL_DISCLOSURE =
  'matches in `@isTest`-annotated classes may be intentional test fixtures rather than production hardcoded values; verify the context before treating as a bug.';

/**
 * Zod schema for the `sfi.find_hardcoded_values_anywhere` tool input.
 *
 *   - `value`: optional exact substring to match across all corpora.
 *     When supplied alongside `category`, both filters apply.
 *   - `category`: optional one of `id` / `email` / `date` / `numeric`.
 *     When supplied without `value`, the tool emits every match of the
 *     category's shape regex.
 *   - `scope`: optional array narrowing the corpora searched. Default
 *     is `['apex', 'formula', 'validation-rule', 'workflow-rule']`
 *     (excludes layout, permission-set which are non-textual / non-
 *     useful in v2.2 R2 graph storage).
 *   - `limit`: optional integer in `[1, 500]`. Defaults to 100.
 */
const findHardcodedValuesAnywhereInputBaseSchema = z.object({
  value: z.string().min(1).optional(),
  category: z.enum(['id', 'email', 'date', 'numeric']).optional(),
  scope: z
    .array(
      z.enum(['apex', 'formula', 'validation-rule', 'workflow-rule']),
    )
    .optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
});

export const findHardcodedValuesAnywhereInputSchema = z.preprocess(
  (raw) => mergeInputAliases(raw, [{ canonical: 'value', aliases: ['query'] }]),
  findHardcodedValuesAnywhereInputBaseSchema,
);

/** Parsed input shape. */
export type FindHardcodedValuesAnywhereInput = z.infer<
  typeof findHardcodedValuesAnywhereInputSchema
>;

/** One match in the response. */
export interface HardcodedValueAnywhereMatch {
  readonly componentId: ComponentId;
  readonly componentType: ComponentType;
  readonly apiName: string;
  readonly source: 'apex' | 'formula' | 'validation-rule' | 'workflow-rule';
  readonly location: string;
  readonly matchedValue: string;
  readonly confidence: 'declared' | 'heuristic';
  readonly category: 'id' | 'email' | 'date' | 'numeric' | 'string';
  readonly contextSnippet: string;
  readonly inTestClass: boolean;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface FindHardcodedValuesAnywhereOutput {
  readonly matches: readonly HardcodedValueAnywhereMatch[];
  readonly totalCount: number;
  readonly byCategory: Readonly<{
    id: number;
    email: number;
    date: number;
    numeric: number;
    string: number;
  }>;
  readonly bySource: Readonly<{
    apex: number;
    formula: number;
    'validation-rule': number;
    'workflow-rule': number;
  }>;
  readonly boundaries: readonly string[];
  readonly truncated: boolean;
}

const RULE_TO_CATEGORY: Readonly<
  Record<string, 'id' | 'email' | 'string' | 'date' | 'numeric'>
> = Object.freeze({
  'hardcoded-id': 'id',
  'hardcoded-email': 'email',
  'hardcoded-username': 'email',
  'hardcoded-sandbox-test-data': 'string',
});

interface QualityIssueLike {
  readonly rule: string;
  readonly severity: string;
  readonly location: string;
  readonly explanation: string;
}

const coerceIssue = (raw: unknown): QualityIssueLike | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const rule = obj['rule'];
  const severity = obj['severity'];
  const location = obj['location'];
  const explanation = obj['explanation'];
  if (
    typeof rule !== 'string' ||
    typeof severity !== 'string' ||
    typeof location !== 'string' ||
    typeof explanation !== 'string'
  ) {
    return null;
  }
  return { rule, severity, location, explanation };
};

/**
 * Pick the regex for the requested category. Returns null when the
 * category is `'string'` (no shape match — used as a fallback for
 * exact-value searches).
 */
const regexForCategory = (
  category: 'id' | 'email' | 'date' | 'numeric',
): RegExp => {
  switch (category) {
    case 'id':
      return SALESFORCE_ID_REGEX;
    case 'email':
      return EMAIL_REGEX;
    case 'date':
      return DATE_REGEX;
    case 'numeric':
      return NUMERIC_REGEX;
  }
};

/**
 * Build a snippet of up to 200 characters centered on the match's
 * start position.
 */
const snippetAround = (
  raw: string,
  matchIdx: number,
  matchLen: number,
): string => {
  const radius = 100;
  const start = Math.max(0, matchIdx - radius);
  const end = Math.min(raw.length, matchIdx + matchLen + radius);
  return raw.slice(start, end).replace(/\s+/g, ' ').trim();
};

/**
 * Scan one text body for matches of the chosen pattern. Emits one
 * entry per match position.
 */
const scanText = (
  text: string,
  category: 'id' | 'email' | 'date' | 'numeric' | 'string' | undefined,
  valueFilter: string | undefined,
): { value: string; index: number; matchedCategory: 'id' | 'email' | 'date' | 'numeric' | 'string' }[] => {
  const hits: {
    value: string;
    index: number;
    matchedCategory: 'id' | 'email' | 'date' | 'numeric' | 'string';
  }[] = [];

  if (valueFilter !== undefined && valueFilter.length > 0) {
    // Exact substring search across the text — case-sensitive by
    // default for v2.2 R2.
    const needle = valueFilter;
    let idx = 0;
    while (idx < text.length) {
      const found = text.indexOf(needle, idx);
      if (found < 0) break;
      hits.push({
        value: needle,
        index: found,
        matchedCategory: category ?? 'string',
      });
      idx = found + needle.length;
    }
    return hits;
  }

  if (category === undefined || category === 'string') {
    // Without value and without a category-shape, we can't scan text
    // (nothing to look for). Caller handles this — return empty.
    return hits;
  }

  const regex = new RegExp(regexForCategory(category).source, 'g');
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    hits.push({
      value: m[0],
      index: m.index,
      matchedCategory: category,
    });
    if (m.index === regex.lastIndex) regex.lastIndex += 1;
  }
  return hits;
};

const isTestClass = (node: Node): boolean =>
  node.type === 'ApexClass' && node.properties['isTest'] === true;

const compareMatches = (
  a: HardcodedValueAnywhereMatch,
  b: HardcodedValueAnywhereMatch,
): number => {
  if (a.componentId !== b.componentId)
    return a.componentId < b.componentId ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  if (a.location !== b.location) return a.location < b.location ? -1 : 1;
  return 0;
};

/**
 * The `sfi.find_hardcoded_values_anywhere` MCP tool. Scans Apex
 * `qualityIssues[]`, CustomField `formula`, ValidationRule
 * `errorConditionFormula`, and WorkflowRule `formula` for hardcoded
 * literals by category, by exact value, or both. Surfaces per-category
 * and per-source counts plus the v2.2 boundary disclosures.
 *
 * @example
 *   const r = await findHardcodedValuesAnywhereHandler(ctx, {
 *     value: 'United States',
 *   });
 *   if (r.ok) console.log(r.value.data.totalCount);
 */
export const findHardcodedValuesAnywhereHandler = async (
  ctx: Context,
  input: FindHardcodedValuesAnywhereInput,
): Promise<
  Result<McpResponse<FindHardcodedValuesAnywhereOutput>, McpError>
> => {
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (input.value === undefined && input.category === undefined) {
    return err({
      kind: 'invalid-query',
      message: 'must specify at least one of `value` or `category`',
    });
  }

  const scope = new Set(
    input.scope ?? ['apex', 'formula', 'validation-rule', 'workflow-rule'],
  );
  const valueFilter = input.value;
  const categoryFilter = input.category;

  const collected: HardcodedValueAnywhereMatch[] = [];
  let sawTestClass = false;

  // --- Apex scope: compose v2.1 qualityIssues[] for hardcoded rules. ---
  if (scope.has('apex')) {
    for (const type of ['ApexClass', 'ApexTrigger'] as ComponentType[]) {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const r = await listNodesByType(ctx.graph, type, {
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        });
        if (!r.ok) {
          return err({
            kind: 'internal',
            message: `graph query failed: ${r.error.message}`,
          });
        }
        if (r.value.length === 0) break;
        for (const node of r.value) {
          const raw = node.properties['qualityIssues'];
          if (!Array.isArray(raw)) continue;
          const inTest = isTestClass(node);
          for (const rawIssue of raw) {
            const issue = coerceIssue(rawIssue);
            if (issue === null) continue;
            if (!HARDCODED_APEX_RULES.has(issue.rule)) continue;
            const cat = RULE_TO_CATEGORY[issue.rule] ?? 'string';
            // Apply category filter on the apex side too.
            if (
              categoryFilter !== undefined &&
              cat !== categoryFilter
            ) {
              continue;
            }
            // Apply value filter — substring in the explanation.
            if (
              valueFilter !== undefined &&
              !issue.explanation.includes(valueFilter)
            ) {
              continue;
            }
            if (inTest) sawTestClass = true;
            collected.push({
              componentId: node.id,
              componentType: node.type,
              apiName: node.apiName,
              source: 'apex',
              location: issue.location,
              matchedValue: valueFilter ?? issue.explanation,
              confidence: valueFilter !== undefined ? 'declared' : 'heuristic',
              category: cat,
              contextSnippet: issue.explanation,
              inTestClass: inTest,
            });
          }
        }
        if (r.value.length < PAGE_SIZE) break;
      }
    }
  }

  // Salesforce formula expressions (CustomField / ValidationRule /
  // WorkflowRule) support `/* ... */` block comments. Strip them before
  // scanning — replacing each with an equal-length run of spaces so
  // character offsets stay aligned for `snippetAround` — so a value that
  // appears ONLY in an explanatory comment (e.g. example dates beside a
  // TODAY()-based expression) is not reported as a hardcoded literal.
  const stripFormulaComments = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));

  // --- Formula scope: scan CustomField.properties.formula. ---
  if (scope.has('formula')) {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const r = await listNodesByType(ctx.graph, 'CustomField', {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      if (!r.ok) {
        return err({
          kind: 'internal',
          message: `graph query failed: ${r.error.message}`,
        });
      }
      if (r.value.length === 0) break;
      for (const node of r.value) {
        const formula = node.properties['formula'];
        if (typeof formula !== 'string' || formula.length === 0) continue;
        const hits = scanText(
          stripFormulaComments(formula),
          categoryFilter,
          valueFilter,
        );
        for (const hit of hits) {
          collected.push({
            componentId: node.id,
            componentType: 'CustomField',
            apiName: node.apiName,
            source: 'formula',
            location: `field:${node.id}`,
            matchedValue: hit.value,
            confidence: valueFilter !== undefined ? 'declared' : 'heuristic',
            category: hit.matchedCategory,
            contextSnippet: snippetAround(
              formula,
              hit.index,
              hit.value.length,
            ),
            inTestClass: false,
          });
        }
      }
      if (r.value.length < PAGE_SIZE) break;
    }
  }

  // --- ValidationRule scope: scan errorConditionFormula. ---
  if (scope.has('validation-rule')) {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const r = await listNodesByType(ctx.graph, 'ValidationRule', {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      if (!r.ok) {
        return err({
          kind: 'internal',
          message: `graph query failed: ${r.error.message}`,
        });
      }
      if (r.value.length === 0) break;
      for (const node of r.value) {
        const formula = node.properties['errorConditionFormula'];
        if (typeof formula !== 'string' || formula.length === 0) continue;
        const hits = scanText(
          stripFormulaComments(formula),
          categoryFilter,
          valueFilter,
        );
        for (const hit of hits) {
          collected.push({
            componentId: node.id,
            componentType: 'ValidationRule',
            apiName: node.apiName,
            source: 'validation-rule',
            location: `rule:${node.id}`,
            matchedValue: hit.value,
            confidence: valueFilter !== undefined ? 'declared' : 'heuristic',
            category: hit.matchedCategory,
            contextSnippet: snippetAround(
              formula,
              hit.index,
              hit.value.length,
            ),
            inTestClass: false,
          });
        }
      }
      if (r.value.length < PAGE_SIZE) break;
    }
  }

  // --- WorkflowRule scope: scan optional formula. ---
  if (scope.has('workflow-rule')) {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const r = await listNodesByType(ctx.graph, 'WorkflowRule', {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      if (!r.ok) {
        return err({
          kind: 'internal',
          message: `graph query failed: ${r.error.message}`,
        });
      }
      if (r.value.length === 0) break;
      for (const node of r.value) {
        const formula = node.properties['formula'];
        if (typeof formula !== 'string' || formula.length === 0) continue;
        const hits = scanText(
          stripFormulaComments(formula),
          categoryFilter,
          valueFilter,
        );
        for (const hit of hits) {
          collected.push({
            componentId: node.id,
            componentType: 'WorkflowRule',
            apiName: node.apiName,
            source: 'workflow-rule',
            location: `rule:${node.id}`,
            matchedValue: hit.value,
            confidence: valueFilter !== undefined ? 'declared' : 'heuristic',
            category: hit.matchedCategory,
            contextSnippet: snippetAround(
              formula,
              hit.index,
              hit.value.length,
            ),
            inTestClass: false,
          });
        }
      }
      if (r.value.length < PAGE_SIZE) break;
    }
  }

  const sorted = collected.sort(compareMatches);
  const truncated = sorted.length > limit;
  const slice = sorted.slice(0, limit);

  const byCategory = { id: 0, email: 0, date: 0, numeric: 0, string: 0 };
  const bySource = {
    apex: 0,
    formula: 0,
    'validation-rule': 0,
    'workflow-rule': 0,
  };
  for (const m of sorted) {
    byCategory[m.category] += 1;
    bySource[m.source] += 1;
  }

  const boundaries: string[] = [];
  if (sorted.length > 0 || categoryFilter !== undefined) {
    if (categoryFilter === 'numeric') boundaries.push(NUMERIC_FP_DISCLOSURE);
    if (categoryFilter === 'id') boundaries.push(ID_FP_DISCLOSURE);
    if (sawTestClass) boundaries.push(TEST_CLASS_REFUSAL_DISCLOSURE);
  }

  return ok({
    data: {
      matches: slice,
      totalCount: sorted.length,
      byCategory,
      bySource,
      boundaries,
      truncated,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
