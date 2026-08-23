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
 *     `hardcoded-sandbox-test-data`). When `category` is `email` or
 *     `value` contains `@`, ALSO scans raw `.cls`/`.trigger` source
 *     files directly as a fallback so emails added after the vault was
 *     built are never silently missed (CR-07 honesty-gap fix).
 *   - **Formula** (CustomField formula expressions): scans the
 *     `properties.formula` string for ID-shape, email-shape, date-
 *     shape, and (when `value` is specified) exact-substring matches.
 *   - **ValidationRule**: scans the
 *     `properties.errorConditionFormula` string for the same
 *     pattern catalog.
 *   - **WorkflowRule**: scans the optional `properties.formula`
 *     string for the same pattern catalog.
 *   - **RestrictionRule / ScopingRule**: scans `properties.userCriteria`
 *     and `properties.recordFilter` — where an active rule bakes a
 *     hardcoded `$User.ProfileId='00e…'` gate or a RecordType/Profile Id
 *     into its SOQL filter (HARDCODED-ID-SCAN-OMITS-RESTRICTION-RULE-AND-
 *     CUSTOMLABEL). These bodies are NOT comment-stripped.
 *   - **CustomLabel**: scans `properties.value` — where admins stash a
 *     RecordType/Profile Id as a configurable string (same finding).
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
 *     For `email` category or an `@`-bearing `value`, additionally
 *     scans raw source files so the graph's pre-computed findings do
 *     not create a blind spot for production classes updated after the
 *     last vault refresh.
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

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  Node,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  isKnownSalesforceIdLiteral,
  KNOWN_KEY_PREFIXES,
} from '@sf-intelligence/patterns';
import { collectVaultSourceFiles } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { mergeInputAliases } from './input-aliases.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import {
  buildUnscannedNodesNote,
  censusQualityScanCoverage,
  type QualityScanTypeCoverage,
} from './quality-scan-coverage.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { fullScanTruncationNote } from './scan-cap.js';

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

const FIND_HARDCODED_ANYWHERE_TOOL = 'sfi.find_hardcoded_values_anywhere';

/**
 * Salesforce ID regex per `SemanticSearchSemantics.md` § "Salesforce ID pattern".
 *
 * SHAPE ONLY. The prefix decision belongs to `isKnownSalesforceIdLiteral`, which
 * is shared with the Apex-side recognizer in `@sf-intelligence/patterns` — see
 * the filter in {@link scanText}.
 *
 * This pattern used to be `/\b0[0-9a-zA-Z]{14}.../` and that leading `0` was a
 * check that could not fire for 12 of the 35 recognized key prefixes: Case
 * (`500`), Campaign (`701`), Contract (`800`), Order/OrderItem (`801`/`802`/
 * `300`), and every custom-object prefix (`a00`-`a05`). A hardcoded custom-object
 * id in a validation rule — the single most likely thing this tool is asked to
 * find — was structurally invisible, and the tool reported the resulting zero as
 * a clean scan. `\b` made it worse: every character of an id is a word
 * character, so the `0` could only ever anchor at the START of the token, and an
 * id merely CONTAINING a zero was no help.
 */
const SALESFORCE_ID_REGEX = /\b[0-9a-zA-Z]{15}([0-9a-zA-Z]{3})?\b/g;
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

/** Apex source file suffixes for the CR-07 email fallback source scan. */
const APEX_SOURCE_SUFFIXES = ['.cls', '.trigger'] as const;

/**
 * CR-07: source-file email fallback. Scans raw `.cls`/`.trigger` files
 * for email-shaped string literals. This catches emails in production
 * classes that were added AFTER the last vault refresh (so their
 * `qualityIssues` in the graph are stale / missing the `hardcoded-email`
 * finding). Called only when `category === 'email'` or the `value` filter
 * contains `@` — the two cases where the caller is explicitly hunting emails.
 *
 * De-duplication against graph-sourced findings is not performed here;
 * the comparator on the output sort ({@link compareMatches}) is a STRICT
 * TOTAL order over (componentId, source, location, category, matchedValue,
 * contextSnippet), so duplicate rows from a stale-graph/fresh-source race
 * are possible but rare and clearly labelled.
 *
 * Returns an empty array on any I/O failure (fire-and-forget fallback).
 */
const scanApexSourceForEmails = async (
  vaultRoot: string,
  valueFilter: string | undefined,
): Promise<HardcodedValueAnywhereMatch[]> => {
  // Inline email regex — same shape as EMAIL_REGEX but as a new instance
  // so `lastIndex` reset is isolated from the formula-scope scan.
  const EMAIL_RE = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;
  let files: Awaited<ReturnType<typeof collectVaultSourceFiles>>;
  try {
    files = await collectVaultSourceFiles(vaultRoot, { suffixes: APEX_SOURCE_SUFFIXES });
  } catch {
    return [];
  }
  const hits: HardcodedValueAnywhereMatch[] = [];
  for (const file of files) {
    let source: string;
    try {
      source = await readFile(file.absolutePath, 'utf-8');
    } catch {
      continue;
    }
    // Derive apiName from the file's basename (strip suffix).
    const name = basename(file.absolutePath);
    const apiName = name.endsWith('.trigger')
      ? name.slice(0, -'.trigger'.length)
      : name.slice(0, -'.cls'.length);
    const componentType: 'ApexClass' | 'ApexTrigger' = name.endsWith('.trigger')
      ? 'ApexTrigger'
      : 'ApexClass';
    const componentId: ComponentId = `${componentType}:${apiName}` as ComponentId;

    // Strip line comments and block comments to avoid matching email-shaped
    // text in /* ... */ or // comments; keep string literals (we want them).
    const stripped = source.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
      .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));

    EMAIL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EMAIL_RE.exec(stripped)) !== null) {
      const email = m[0];
      // Apply value filter if present.
      if (valueFilter !== undefined && !email.includes(valueFilter)) continue;
      const lineNum = source.slice(0, m.index).split('\n').length;
      const snippet = snippetAround(source, m.index, email.length);
      hits.push({
        componentId,
        componentType,
        apiName,
        source: 'apex',
        location: `line ${lineNum}`,
        matchedValue: email,
        confidence: 'heuristic',
        category: 'email',
        contextSnippet: snippet,
        inTestClass: false,
      });
    }
  }
  return hits;
};

const NUMERIC_FP_DISCLOSURE =
  'the numeric category has very high false-positive rate — loop counters, array indices, and arithmetic constants all match. The category is suppressed from default searches; opt in explicitly only when looking for specific hardcoded numbers.';
const ID_FP_DISCLOSURE =
  `the ID-shape search matches 15- or 18-character alphanumeric strings filtered to a known-key-prefix allowlist (${KNOWN_KEY_PREFIXES.size} prefixes), the same allowlist the Apex-side hardcoded-id recognizer applies. Arbitrary alphanumeric strings outside the allowlist are not returned. Strings shaped like an ID that aren't actually IDs (e.g., session keys, hashes) may still match if they happen to start with a known key prefix. An id whose object's key prefix is not in that list is NOT reported — the list covers the standard objects and the custom-object range, not every prefix Salesforce issues.`;
const TEST_CLASS_REFUSAL_DISCLOSURE =
  'matches in `@isTest`-annotated classes may be intentional test fixtures rather than production hardcoded values; verify the context before treating as a bug.';
/**
 * CR-07: source-scan fallback disclosure. Surfaces when the email/value-with-@
 * scan also ran the raw source-file pass (supplementing the graph qualityIssues).
 * The source scan is comment-stripped but not string-isolated — it will surface
 * email-shaped tokens inside multi-line string concatenations or Javadoc-style
 * param annotations. Treat as heuristic, not authoritative.
 */
const APEX_SOURCE_EMAIL_SCAN_DISCLOSURE =
  'For the email category, Apex source files were also scanned directly (CR-07 fallback) to catch addresses in classes updated after the last vault refresh. Source-scan matches are comment-stripped but not string-boundary-isolated — email-shaped tokens in @param JavaDoc or string-concatenation expressions may surface as false positives. Confidence: heuristic.';

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
      z.enum([
        'apex',
        'formula',
        'validation-rule',
        'workflow-rule',
        // HARDCODED-ID-SCAN-OMITS-RESTRICTION-RULE-AND-CUSTOMLABEL.
        'restriction-rule',
        'custom-label',
      ]),
    )
    .optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  // CR-22: page cursor for walking the full match list when truncated.
  offset: z.number().int().min(0).optional(),
  cursor: z.string().min(1).optional(),
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
  readonly source:
    | 'apex'
    | 'formula'
    | 'validation-rule'
    | 'workflow-rule'
    // HARDCODED-ID-SCAN-OMITS-RESTRICTION-RULE-AND-CUSTOMLABEL: RestrictionRule /
    // ScopingRule `userCriteria` + `recordFilter`, and CustomLabel `value`.
    | 'restriction-rule'
    | 'custom-label';
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
    'restriction-rule': number;
    'custom-label': number;
  }>;
  /**
   * QUALITY-SCAN-SKIPS-TRIGGERS-AND-FLOWS. Per-type count of the Apex nodes
   * read vs the ones that actually carry a `qualityIssues` scan. Present ONLY
   * when the `apex` scope ran AND some node in it was never scanned — the path
   * where a missing `apex` row means "not checked", not "nothing hardcoded in
   * Apex". Absent when the caller excluded the `apex` scope, and absent on a
   * fully-scanned vault, whose response is unchanged.
   */
  readonly qualityScanCoverage?: readonly QualityScanTypeCoverage[];
  readonly boundaries: readonly string[];
  readonly truncated: boolean;
  /**
   * Page size applied to this response. Present ONLY on a PAGED response
   * (`truncated` or a resumed `offset > 0`); omitted on a whole-fits no-cursor
   * call so that response stays byte-identical to the pre-CR-22 shape.
   */
  readonly limit?: number;
  /** Zero-based offset of the first returned match. Present only when paged (see `limit`). */
  readonly offset?: number;
  /** Offset to pass on the next call to fetch the following page. Present only when `truncated`. */
  readonly nextOffset?: number;
  /**
   * CR-22 opaque continuation token, present ONLY when this page is truncated
   * (more matches remain). Echo it back as `cursor` to resume. Absent on a
   * complete page so an in-budget response is byte-identical to pre-CR-22.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
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
    // The `id` shape regex deliberately matches ANY 15/18-char alphanumeric;
    // the key-prefix allowlist is what makes it an id rather than a hash. This
    // is the filter `ID_FP_DISCLOSURE` promises the caller, and it lives here
    // rather than in the pattern so both halves of the rule stay in one place
    // and stay shared with the Apex-side recognizer.
    if (category === 'id' && !isKnownSalesforceIdLiteral(m[0])) {
      if (m.index === regex.lastIndex) regex.lastIndex += 1;
      continue;
    }
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

/**
 * Comparator: componentId ASC, source ASC, location ASC, then (CR-22) category
 * ASC, matchedValue ASC, contextSnippet ASC.
 *
 * The (componentId, source, location) prefix collides for the formula / VR / WF
 * corpora because `location` there is per-NODE constant (`field:${id}` /
 * `rule:${id}`, not position-aware) — so EVERY multi-hit formula node is a tie
 * cluster, and an offset resume across such a cluster could dup or skip. Adding
 * category, matchedValue, and the position-bearing `contextSnippet` (the
 * formula-offset window) makes the order a STRICT TOTAL order so resume is
 * dup-free / skip-free. (Two rows byte-identical in all six keys are genuine
 * duplicates and ordering between them is immaterial.)
 */
const compareMatches = (
  a: HardcodedValueAnywhereMatch,
  b: HardcodedValueAnywhereMatch,
): number => {
  if (a.componentId !== b.componentId)
    return a.componentId < b.componentId ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  if (a.location !== b.location) return a.location < b.location ? -1 : 1;
  if (a.category !== b.category) return a.category < b.category ? -1 : 1;
  if (a.matchedValue !== b.matchedValue)
    return a.matchedValue < b.matchedValue ? -1 : 1;
  if (a.contextSnippet !== b.contextSnippet)
    return a.contextSnippet < b.contextSnippet ? -1 : 1;
  return 0;
};

/** Stable total-order key for the cursor `k` field. */
const matchKey = (m: HardcodedValueAnywhereMatch): string =>
  `${m.componentId}|${m.source}|${m.location}|${m.category}|${m.matchedValue}|${m.contextSnippet}`;

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
    input.scope ?? [
      'apex',
      'formula',
      'validation-rule',
      'workflow-rule',
      // HARDCODED-ID-SCAN-OMITS-RESTRICTION-RULE-AND-CUSTOMLABEL: RestrictionRule /
      // ScopingRule user-criteria + record-filter and CustomLabel values are in
      // the default scan set so hardcoded Profile / RecordType Ids there are no
      // longer invisible to Id-hygiene queries.
      'restriction-rule',
      'custom-label',
    ],
  );
  const valueFilter = input.value;
  const categoryFilter = input.category;

  const collected: HardcodedValueAnywhereMatch[] = [];
  let sawTestClass = false;
  // CR-22 B4: track types whose full multi-window scan stopped at the pathological
  // FULL_SCAN_MAX_NODES cap so the residual incompleteness is disclosed honestly.
  const incompleteTypes: string[] = [];

  // CR-07: true when the email source-scan fallback was triggered. Set here
  // so the boundary disclosure fires after the scan completes.
  let ranApexSourceEmailScan = false;

  // QUALITY-SCAN-SKIPS-TRIGGERS-AND-FLOWS. Per-type coverage of the Apex nodes
  // this call actually read, populated only when the `apex` scope runs.
  let apexQualityScanCoverage: readonly QualityScanTypeCoverage[] = [];

  // --- Apex scope: compose v2.1 qualityIssues[] for hardcoded rules. ---
  // CR-22 B4: scan EVERY ApexClass / ApexTrigger by paging the SQL OFFSET forward
  // (window-by-window) so findings on node 501+ are reachable — the old MAX_PAGES
  // (20) x PAGE_SIZE (500) loop SILENTLY broke at 10k nodes with no disclosure.
  if (scope.has('apex')) {
    const scan = await scanAllNodesOfTypes(ctx.graph, ['ApexClass', 'ApexTrigger']);
    if (!scan.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${scan.error.message}`,
      });
    }
    incompleteTypes.push(...scan.value.incompleteTypes);
    // QUALITY-SCAN-SKIPS-TRIGGERS-AND-FLOWS. The `continue` below skips every
    // node with no `qualityIssues` key — silently, and on a vault built before
    // the trigger extractor ran the recognizers that is all 22 ApexTriggers.
    // Census the set BEFORE the skip so the response can name what it did not
    // read instead of implying the Apex corpus came back clean.
    apexQualityScanCoverage = censusQualityScanCoverage(scan.value.nodes);
    for (const node of scan.value.nodes) {
      const raw = node.properties['qualityIssues'];
      if (!Array.isArray(raw)) continue;
      const inTest = isTestClass(node);
      for (const rawIssue of raw) {
        const issue = coerceIssue(rawIssue);
        if (issue === null) continue;
        if (!HARDCODED_APEX_RULES.has(issue.rule)) continue;
        const cat = RULE_TO_CATEGORY[issue.rule] ?? 'string';
        // Apply category filter on the apex side too.
        if (categoryFilter !== undefined && cat !== categoryFilter) {
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

    // CR-07: email source-scan fallback — supplement the graph findings with a
    // direct source-file scan whenever the caller is hunting email addresses.
    // This catches hardcoded emails in production classes whose `qualityIssues`
    // were not populated by the extractor (vault built before the email recognizer
    // was added, or the class was modified after the last refresh).
    const needEmailSourceScan =
      categoryFilter === 'email' ||
      (valueFilter !== undefined && valueFilter.includes('@'));
    if (needEmailSourceScan) {
      ranApexSourceEmailScan = true;
      const sourceHits = await scanApexSourceForEmails(ctx.vaultRoot, valueFilter);
      // De-dup against graph-sourced findings by (componentId, location, matchedValue).
      const graphKeys = new Set<string>(
        collected
          .filter((m) => m.source === 'apex' && m.category === 'email')
          .map((m) => `${m.componentId}|${m.location}|${m.matchedValue}`),
      );
      for (const hit of sourceHits) {
        const key = `${hit.componentId}|${hit.location}|${hit.matchedValue}`;
        if (!graphKeys.has(key)) {
          collected.push(hit);
          graphKeys.add(key);
        }
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
    const scan = await scanAllNodesOfTypes(ctx.graph, ['CustomField']);
    if (!scan.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${scan.error.message}`,
      });
    }
    incompleteTypes.push(...scan.value.incompleteTypes);
    for (const node of scan.value.nodes) {
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
          contextSnippet: snippetAround(formula, hit.index, hit.value.length),
          inTestClass: false,
        });
      }
    }
  }

  // --- ValidationRule scope: scan errorConditionFormula. ---
  if (scope.has('validation-rule')) {
    const scan = await scanAllNodesOfTypes(ctx.graph, ['ValidationRule']);
    if (!scan.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${scan.error.message}`,
      });
    }
    incompleteTypes.push(...scan.value.incompleteTypes);
    for (const node of scan.value.nodes) {
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
          contextSnippet: snippetAround(formula, hit.index, hit.value.length),
          inTestClass: false,
        });
      }
    }
  }

  // --- WorkflowRule scope: scan optional formula. ---
  if (scope.has('workflow-rule')) {
    const scan = await scanAllNodesOfTypes(ctx.graph, ['WorkflowRule']);
    if (!scan.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${scan.error.message}`,
      });
    }
    incompleteTypes.push(...scan.value.incompleteTypes);
    for (const node of scan.value.nodes) {
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
          contextSnippet: snippetAround(formula, hit.index, hit.value.length),
          inTestClass: false,
        });
      }
    }
  }

  // HARDCODED-ID-SCAN-OMITS-RESTRICTION-RULE-AND-CUSTOMLABEL: scan one string
  // property of a node for hardcoded literals. Unlike the formula corpora, the
  // text is NOT comment-stripped — an Id baked into a RestrictionRule filter or
  // a CustomLabel value is a hygiene finding wherever it sits, and neither
  // property uses the formula `/* */` comment convention. `location` carries the
  // property name so a rule scanned on two properties yields distinct rows.
  const scanNodeProperty = (
    node: Node,
    source: HardcodedValueAnywhereMatch['source'],
    componentType: ComponentType,
    propName: string,
  ): void => {
    const raw = node.properties[propName];
    if (typeof raw !== 'string' || raw.length === 0) return;
    for (const hit of scanText(raw, categoryFilter, valueFilter)) {
      collected.push({
        componentId: node.id,
        componentType,
        apiName: node.apiName,
        source,
        location: `${propName}:${node.id}`,
        matchedValue: hit.value,
        confidence: valueFilter !== undefined ? 'declared' : 'heuristic',
        category: hit.matchedCategory,
        contextSnippet: snippetAround(raw, hit.index, hit.value.length),
        inTestClass: false,
      });
    }
  };

  // --- RestrictionRule / ScopingRule scope: scan userCriteria + recordFilter. ---
  if (scope.has('restriction-rule')) {
    const scan = await scanAllNodesOfTypes(ctx.graph, [
      'RestrictionRule',
      'ScopingRule',
    ]);
    if (!scan.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${scan.error.message}`,
      });
    }
    incompleteTypes.push(...scan.value.incompleteTypes);
    for (const node of scan.value.nodes) {
      scanNodeProperty(node, 'restriction-rule', node.type, 'userCriteria');
      scanNodeProperty(node, 'restriction-rule', node.type, 'recordFilter');
    }
  }

  // --- CustomLabel scope: scan the label's value string. ---
  if (scope.has('custom-label')) {
    const scan = await scanAllNodesOfTypes(ctx.graph, ['CustomLabel']);
    if (!scan.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${scan.error.message}`,
      });
    }
    incompleteTypes.push(...scan.value.incompleteTypes);
    for (const node of scan.value.nodes) {
      scanNodeProperty(node, 'custom-label', 'CustomLabel', 'value');
    }
  }

  const sorted = collected.sort(compareMatches);

  const byCategory = { id: 0, email: 0, date: 0, numeric: 0, string: 0 };
  const bySource = {
    apex: 0,
    formula: 0,
    'validation-rule': 0,
    'workflow-rule': 0,
    'restriction-rule': 0,
    'custom-label': 0,
  };
  for (const m of sorted) {
    byCategory[m.category] += 1;
    bySource[m.source] += 1;
  }

  // CR-22: resolve the resume offset (echoed cursor wins over explicit offset).
  // The fingerprint covers the NARROWING args — value, category, scope — so a
  // token minted for one query can't be replayed against another.
  const fingerprint = argsFingerprint({
    ...(input.value !== undefined ? { value: input.value } : {}),
    ...(input.category !== undefined ? { category: input.category } : {}),
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
  });
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: FIND_HARDCODED_ANYWHERE_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  const paged = paginateLegacy(sorted, {
    offset,
    limit,
    keyOf: matchKey,
    binding: {
      tool: FIND_HARDCODED_ANYWHERE_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const slice = paged.items;
  const truncated = paged.hasMore;
  const emitCursor = paged.nextCursor !== null;
  const isPaged = truncated || offset > 0;

  const boundaries: string[] = [];
  if (sorted.length > 0 || categoryFilter !== undefined) {
    if (categoryFilter === 'numeric') boundaries.push(NUMERIC_FP_DISCLOSURE);
    if (categoryFilter === 'id') boundaries.push(ID_FP_DISCLOSURE);
    if (sawTestClass) boundaries.push(TEST_CLASS_REFUSAL_DISCLOSURE);
    if (ranApexSourceEmailScan) boundaries.push(APEX_SOURCE_EMAIL_SCAN_DISCLOSURE);
  }
  // QUALITY-SCAN-SKIPS-TRIGGERS-AND-FLOWS. Lives OUTSIDE the
  // `sorted.length > 0` gate above because the zero-match response IS the
  // false-clean one.
  const unscannedApexNote = buildUnscannedNodesNote(apexQualityScanCoverage);
  if (unscannedApexNote !== undefined) boundaries.push(unscannedApexNote);

  // Residual scan-incompleteness only fires for a PATHOLOGICAL type past
  // FULL_SCAN_MAX_NODES — the normal full scan reaches node 501+ and completes.
  if (incompleteTypes.length > 0) {
    boundaries.push(fullScanTruncationNote(incompleteTypes));
  }

  return ok({
    data: {
      matches: slice,
      totalCount: sorted.length,
      byCategory,
      bySource,
      ...(unscannedApexNote !== undefined
        ? { qualityScanCoverage: apexQualityScanCoverage }
        : {}),
      boundaries,
      truncated,
      ...(isPaged ? { limit, offset } : {}),
      ...(truncated ? { nextOffset: offset + slice.length } : {}),
      ...(emitCursor
        ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo }
        : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
