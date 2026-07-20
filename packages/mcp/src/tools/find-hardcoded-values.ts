/**
 * Handler for the `sfi.find_hardcoded_values` MCP tool.
 *
 * The v2.1 "find me hardcoded IDs / emails / usernames / sandbox-test-
 * data" surface — narrows the v2.1 quality recognizer catalog to the
 * four hardcoded-literal rules and returns each match's location plus
 * (where the recognizer extracts it) the literal value the recognizer
 * saw. Composes over the `properties.qualityIssues[]` array the
 * `code-quality-patterns` recognizer family populates at extraction
 * time for ApexClass / ApexTrigger nodes.
 *
 * **Hardcoded-value rule subset** — the four rules below are the
 * hardcoded-literal slice of the v2.1 catalog
 * (`ApexQualitySemantics.md` §§ 3, 4, 5, 14):
 *   - `hardcoded-id` — 15- or 18-character Salesforce ID literal with
 *     a recognized key prefix. Sandbox/production IDs differ.
 *   - `hardcoded-email` — strict email-shaped literal. Move to Custom
 *     Setting / Custom Metadata.
 *   - `hardcoded-username` — Salesforce username-shaped literal (the
 *     `.sandbox` / `.dev` / `.uat` / `.fullcopy` / `.qa` suffix
 *     family). Move to a runtime lookup.
 *   - `hardcoded-sandbox-test-data` — sandbox-specific literal inside
 *     a test class (`.sandbox.salesforce.com`, `--sandbox`, etc.).
 *     Tests should run against any org.
 *
 * **Category filter** — the `category` input optionally narrows to one
 * literal family. The mapping is:
 *   - `'id'` → `hardcoded-id`
 *   - `'email'` → `hardcoded-email`
 *   - `'username'` → `hardcoded-username`
 *   - `'sandbox-data'` → `hardcoded-sandbox-test-data`
 *
 * Omitted means "all four rules"; an unrecognized category falls
 * through the schema's enum so the handler never sees one.
 *
 * **Refusal-pattern axis** (per `ApexQualitySemantics.md` §3 and the
 * v2.1 R3 §5 disclosure language): hardcoded IDs inside `@isTest`
 * classes are often intentional fixtures — the recognizer flags them,
 * but the skill must surface the refusal-pattern disclosure verbatim
 * so the user knows the finding may be a false positive. The
 * `boundaries` array on the response carries this disclosure when at
 * least one finding's parent ApexClass has `isTest: true`.
 *
 * Implementation notes:
 *   - The v2.1 recognizer's `location` string carries
 *     `line {N}` for raw-line matches; the `explanation` carries the
 *     quoted literal value (e.g., `Hardcoded Salesforce ID literal
 *     '0015g00000Abc' — IDs differ between sandbox/production. ...`).
 *     We do NOT separately extract the literal into a `matchedValue`
 *     field — the explanation already names it, and the recognizer's
 *     v2.1 output contract does not expose a separate "matched
 *     substring" field on every rule.
 *   - `limit` defaults to 100 and is capped at 500 by Zod. The slice
 *     is over individual matches, not classes.
 *   - The sort is `componentId ASC, location ASC, rule ASC` so the
 *     response is deterministic across runs.
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  Node,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { z } from 'zod';

import type { Context } from '../server.js';

import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { clampedNodeScanLimit, scanTruncationNote } from './scan-cap.js';

/** Inclusive upper bound on `limit`. */
const FIND_HARDCODED_MAX_LIMIT = 500;
/** Default `limit`. */
const FIND_HARDCODED_DEFAULT_LIMIT = 100;

/** Category-to-rule mapping for the hardcoded-literal rules. */
const CATEGORY_TO_RULE: Readonly<
  Record<'id' | 'email' | 'username' | 'url' | 'sandbox-data', string>
> = Object.freeze({
  id: 'hardcoded-id',
  email: 'hardcoded-email',
  username: 'hardcoded-username',
  url: 'hardcoded-url',
  'sandbox-data': 'hardcoded-sandbox-test-data',
});

/** The full rule set the tool walks when no category filter is set. */
const ALL_HARDCODED_RULES: ReadonlySet<string> = new Set(
  Object.values(CATEGORY_TO_RULE),
);

/** ComponentTypes the hardcoded-value recognizers fire on. */
const SCANNED_TYPES: readonly ComponentType[] = [
  'ApexClass',
  'ApexTrigger',
];

/** The five-tier severity scale used by the v2.1 catalog. */
type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

const SEVERITY_SET: ReadonlySet<string> = new Set([
  'critical',
  'high',
  'medium',
  'low',
  'info',
]);

/** Verbatim refusal-pattern disclosure for test-class hardcoded IDs. */
const TEST_CLASS_REFUSAL_DISCLOSURE =
  'string literals inside @isTest classes that look like IDs may be intentional test fixtures. Verify before treating as a bug.';
const HEURISTIC_CONFIDENCE_DISCLOSURE =
  'pattern recognition is heuristic — every finding carries confidence: heuristic. The recognizer matches on literal-shape (key prefixes for IDs, strict email regex for emails); managed-package literals embedded in installed code may surface as false positives.';

/**
 * Zod schema for the `sfi.find_hardcoded_values` tool input.
 *
 *   - `category`: optional. Narrows to one of `'id' | 'email' |
 *     'username' | 'sandbox-data'`. Omitted means all four rules.
 *   - `limit`: optional integer in `[1, 500]`. Defaults to 100 in
 *     the handler. The slice is over individual matches.
 */
export const findHardcodedValuesInputSchema = z.object({
  category: z.enum(['id', 'email', 'username', 'url', 'sandbox-data']).optional(),
  // FIND-HARDCODED-VALUES-IGNORES-SCOPE: honor a caller scope instead of
  // silently stripping it. `componentId` scopes to ONE `ApexClass:{name}` /
  // `ApexTrigger:{name}`; `nameContains` narrows the scanned roster to
  // components whose api name contains the substring (case-insensitive). The
  // two are mutually exclusive. The response echoes `appliedScope` so a host
  // never mistakes an unfiltered org-wide roster for a scoped answer.
  componentId: z.string().min(1).optional(),
  nameContains: z.string().min(1).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(FIND_HARDCODED_MAX_LIMIT)
    .optional(),
  // CR-22: page cursor for walking the full match list when truncated.
  offset: z.number().int().min(0).optional(),
  cursor: z.string().min(1).optional(),
});

/** Parsed input shape. */
export type FindHardcodedValuesInput = z.infer<
  typeof findHardcodedValuesInputSchema
>;

/** One entry in the response's `matches` array. */
export interface HardcodedValueMatch {
  readonly componentId: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  /**
   * The recognizer rule id; one of `hardcoded-id`, `hardcoded-email`,
   * `hardcoded-username`, or `hardcoded-sandbox-test-data`.
   */
  readonly rule: string;
  readonly severity: Severity;
  readonly location: string;
  readonly explanation: string;
  /**
   * True when the parent ApexClass is `@isTest` (per the v2.1
   * extractor's `properties.isTest` mirror). Surfaces alongside the
   * `boundaries` refusal-pattern disclosure so consumers can render
   * the test-class caveat per-match.
   */
  readonly inTestClass: boolean;
}

/** Output payload. */
export interface FindHardcodedValuesOutput {
  readonly matches: readonly HardcodedValueMatch[];
  readonly totalCount: number;
  /**
   * The scope ACTUALLY applied to this scan. Present ONLY when the caller
   * passed a `componentId` or `nameContains` scope — an unscoped org-wide call
   * omits it entirely so its response stays byte-identical to the pre-scope
   * shape (mirrors the paging-field convention below). `mode` is `component`
   * (single-id scope), `nameContains` (substring roster filter), or — never
   * emitted — `all`; a host that sees no `appliedScope` MUST treat the result
   * as the full org-wide roster, not a scoped answer.
   */
  readonly appliedScope?: {
    readonly component: string | null;
    readonly nameContains: string | null;
    readonly mode: 'component' | 'nameContains';
  };
  /** Per-category counter across the FULL matched set. */
  readonly byCategory: Readonly<{
    readonly id: number;
    readonly email: number;
    readonly username: number;
    readonly url: number;
    readonly 'sandbox-data': number;
  }>;
  /** Verbatim honesty disclosures. */
  readonly boundaries: readonly string[];
  /** True when the matched count exceeded `limit` (more matches behind this page). */
  readonly truncated: boolean;
  /**
   * Page size applied to this response. Present only on a PAGED response
   * (`truncated` or a resumed `offset > 0`); omitted on a whole-fits no-cursor
   * call so that response stays byte-identical to the pre-CR-22 shape.
   */
  readonly limit?: number;
  /** Zero-based offset of the first returned match. Present only when paged (see `limit`). */
  readonly offset?: number;
  /**
   * Offset to pass on the next call to fetch the following page of matches.
   * Present only when `truncated`.
   */
  readonly nextOffset?: number;
  /**
   * CR-22 opaque continuation token, present ONLY when this page is truncated
   * (more matches remain). Echo it back as `cursor` to resume. Absent on a
   * complete page so an in-budget response is byte-identical to the pre-CR-22
   * shape.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
}

interface QualityIssueLike {
  readonly rule: string;
  readonly severity: Severity;
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
  if (!SEVERITY_SET.has(severity)) return null;
  return {
    rule,
    severity: severity as Severity,
    location,
    explanation,
  };
};

/** Map a rule id back to its category enum value for the byCategory tally. */
const ruleToCategory = (
  rule: string,
): 'id' | 'email' | 'username' | 'url' | 'sandbox-data' | null => {
  if (rule === 'hardcoded-id') return 'id';
  if (rule === 'hardcoded-email') return 'email';
  if (rule === 'hardcoded-username') return 'username';
  if (rule === 'hardcoded-url') return 'url';
  if (rule === 'hardcoded-sandbox-test-data') return 'sandbox-data';
  return null;
};

/**
 * Comparator: componentId ASC, location ASC, rule ASC, explanation ASC.
 *
 * componentId-first matches the scan/id order so the sort is scan-consistent
 * (a deeper scan window only appends rows that sort AFTER earlier ones). The
 * `explanation` tiebreak (CR-22) makes the order a STRICT TOTAL order: two
 * qualityIssues with the SAME rule at the SAME line in one class (line-granular
 * locations collide) previously compared equal (returned 0), so an offset
 * resume could dup or skip at that tie cluster. `explanation` carries the
 * distinguishing literal value, so equal-everything-else rows now get a
 * deterministic order. (If two rows are byte-identical in all four keys they
 * are genuine duplicates and ordering between them is immaterial.)
 */
const compareMatches = (
  a: HardcodedValueMatch,
  b: HardcodedValueMatch,
): number => {
  if (a.componentId !== b.componentId) {
    return a.componentId < b.componentId ? -1 : 1;
  }
  if (a.location !== b.location) return a.location < b.location ? -1 : 1;
  if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
  if (a.explanation !== b.explanation) return a.explanation < b.explanation ? -1 : 1;
  return 0;
};

/** Stable total-order key for the cursor `k` field. */
const matchKey = (m: HardcodedValueMatch): string =>
  `${m.componentId}|${m.location}|${m.rule}|${m.explanation}`;

const FIND_HARDCODED_TOOL = 'sfi.find_hardcoded_values';

const isTestClass = (node: Node): boolean =>
  node.type === 'ApexClass' && node.properties['isTest'] === true;

/**
 * The `sfi.find_hardcoded_values` MCP tool. Returns every hardcoded-
 * literal finding across the v2.1-scanned Apex types, optionally
 * narrowed by literal category. See the module JSDoc for the
 * category-to-rule mapping and the test-class refusal-pattern axis.
 *
 * @example
 *   const r = await findHardcodedValuesHandler(ctx, { category: 'id' });
 *   if (r.ok) console.log(r.value.data.totalCount);
 */
export const findHardcodedValuesHandler = async (
  ctx: Context,
  input: FindHardcodedValuesInput,
): Promise<Result<McpResponse<FindHardcodedValuesOutput>, McpError>> => {
  // FIND-HARDCODED-VALUES-IGNORES-SCOPE: a caller may scope by exactly ONE of
  // componentId / nameContains — never both (a single id can't be further
  // narrowed by a substring, and honoring one while dropping the other would be
  // the same silent-strip this fixes).
  if (input.componentId !== undefined && input.nameContains !== undefined) {
    return err({
      kind: 'invalid-query',
      message:
        'pass `componentId` OR `nameContains`, not both — a component id already identifies a single component',
      path: 'nameContains',
    });
  }
  const nameNeedle =
    input.nameContains !== undefined ? input.nameContains.toLowerCase() : null;

  const limit = input.limit ?? FIND_HARDCODED_DEFAULT_LIMIT;
  const ruleSet: ReadonlySet<string> =
    input.category === undefined
      ? ALL_HARDCODED_RULES
      : new Set([CATEGORY_TO_RULE[input.category]]);

  const collected: HardcodedValueMatch[] = [];
  let sawTestClassFinding = false;

  // CR-22 B3: scan EVERY node of each Apex type by paging the SQL OFFSET forward
  // (window-by-window at the clamped cap) so findings on node 501+ are reachable
  // — the single capped page used to drop the scan TAIL silently. The output is
  // then the COMPLETE match list, paged on the output axis below; no second `s`
  // scan cursor is needed because the scan completes inside this call.
  const scan = await scanAllNodesOfTypes(ctx.graph, SCANNED_TYPES);
  if (!scan.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${scan.error.message}`,
    });
  }
  let componentIdMatched = false;
  for (const node of scan.value.nodes) {
    // Apply the caller scope BEFORE reading findings so a scoped call reports
    // only its target's matches (and an empty result honestly means "no
    // hardcoded values in this scope", not "unscanned").
    if (input.componentId !== undefined) {
      if (node.id !== input.componentId) continue;
      componentIdMatched = true;
    }
    if (nameNeedle !== null && !node.apiName.toLowerCase().includes(nameNeedle)) {
      continue;
    }
    const raw = (node as Node).properties['qualityIssues'];
    if (!Array.isArray(raw)) continue;
    const inTest = isTestClass(node);
    for (const rawIssue of raw) {
      const issue = coerceIssue(rawIssue);
      if (issue === null) continue;
      if (!ruleSet.has(issue.rule)) continue;
      if (inTest) sawTestClassFinding = true;
      collected.push({
        componentId: node.id,
        type: node.type,
        apiName: node.apiName,
        rule: issue.rule,
        severity: issue.severity,
        location: issue.location,
        explanation: issue.explanation,
        inTestClass: inTest,
      });
    }
  }

  // A componentId scope that matched no scanned node is "not found", NOT "no
  // hardcoded values" — surface it rather than returning an empty payload a
  // host could mistake for a clean class.
  if (input.componentId !== undefined && !componentIdMatched) {
    return err({
      kind: 'invalid-query',
      message: `no ApexClass / ApexTrigger matches \`${input.componentId}\` in this vault — find_hardcoded_values scans Apex only`,
      path: 'componentId',
    });
  }

  const sorted = [...collected].sort(compareMatches);

  const byCategory = {
    id: 0,
    email: 0,
    username: 0,
    url: 0,
    'sandbox-data': 0,
  };
  for (const m of sorted) {
    const cat = ruleToCategory(m.rule);
    if (cat !== null) byCategory[cat] += 1;
  }

  // CR-22: resolve the resume offset (echoed cursor wins over explicit offset).
  // The fingerprint covers the one narrowing arg `category` so a token minted
  // for one category can't be replayed against another.
  const fingerprint = argsFingerprint({
    ...(input.category !== undefined ? { category: input.category } : {}),
    ...(input.componentId !== undefined
      ? { componentId: input.componentId }
      : {}),
    ...(input.nameContains !== undefined
      ? { nameContains: input.nameContains }
      : {}),
  });
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: FIND_HARDCODED_TOOL,
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
      tool: FIND_HARDCODED_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const slice = paged.items;
  const truncated = paged.hasMore;
  const emitCursor = paged.nextCursor !== null;

  const boundaries: string[] = [];
  if (sorted.length > 0) {
    boundaries.push(HEURISTIC_CONFIDENCE_DISCLOSURE);
    if (sawTestClassFinding) {
      boundaries.push(TEST_CLASS_REFUSAL_DISCLOSURE);
    }
  }
  // Residual scan-incompleteness only fires for a PATHOLOGICAL type past
  // FULL_SCAN_MAX_NODES — the normal full scan reaches node 501+ and completes,
  // so this is honestly false for any real org (strictly better than the old
  // per-page cap, which truncated at 500). Lives OUTSIDE the zero-findings gate
  // because risky classes could be among the unscanned residual tail.
  if (scan.value.scanIncomplete) {
    boundaries.push(
      scanTruncationNote(scan.value.incompleteTypes, clampedNodeScanLimit()),
    );
  }

  // Emit the paging fields ONLY on a paged response (truncated OR a resumed
  // offset>0). A whole-fits no-cursor call omits limit/offset/nextOffset/
  // nextCursor/pageInfo entirely, so its data shape is byte-identical to the
  // pre-CR-22 output (golden does not move).
  const isPaged = truncated || offset > 0;

  return ok({
    data: {
      matches: slice,
      totalCount: sorted.length,
      byCategory,
      boundaries,
      truncated,
      ...(input.componentId !== undefined || input.nameContains !== undefined
        ? {
            appliedScope: {
              component: input.componentId ?? null,
              nameContains: input.nameContains ?? null,
              mode:
                input.componentId !== undefined
                  ? ('component' as const)
                  : ('nameContains' as const),
            },
          }
        : {}),
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
