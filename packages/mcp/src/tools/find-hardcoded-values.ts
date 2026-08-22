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
 * hardcoded-literal slice of the recognizer catalog in
 * `packages/patterns/src/code-quality-patterns.ts`:
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
 * **Refusal-pattern axis** (the `hardcoded-id` recognizer's own
 * boundary): hardcoded IDs inside `@isTest`
 * classes are often intentional fixtures — the recognizer flags them,
 * but the skill must surface the refusal-pattern disclosure verbatim
 * so the user knows the finding may be a false positive. The
 * `boundaries` array on the response carries this disclosure when at
 * least one finding's parent ApexClass has `isTest: true`.
 *
 * **Test-fixture split** (FIX 13) — the refusal axis above is per-match, but
 * the AGGREGATE used to hide it: measured on a real org, 110 of 116 matches sat
 * inside `@isTest` classes, so `totalCount: 116` overstated the actionable work
 * ~19x. `productionCount` / `testFixtureCount` / `byCategoryProduction` split
 * the headline (emitted whenever the set holds a test-class row);
 * `totalCount` and `byCategory` are UNCHANGED and still span everything.
 * `excludeTestClasses: true` drops the fixture rows before the sort and the
 * page, echoes itself in `appliedScope`, and is folded into the cursor
 * fingerprint so a page cannot be replayed across the boundary. Scoping to an
 * `@isTest` class AND excluding test classes is refused as `invalid-query`
 * rather than answered with an empty scan of the class the caller named.
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

import {
  argsFingerprint,
  decodeCursor,
  DEFAULT_PAGE_BYTE_BUDGET,
  paginateLegacy,
} from './page-cursor.js';
import {
  buildUnscannedNodesNote,
  censusQualityScanCoverage,
  type QualityScanTypeCoverage,
} from './quality-scan-coverage.js';
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
/**
 * FIX 13. Emitted whenever the matched set holds at least one `@isTest` row, so
 * a caller reading `totalCount` learns immediately how much of it is fixture
 * noise rather than shipping code.
 */
const buildTestFixtureSplitDisclosure = (
  testFixtureCount: number,
  totalCount: number,
  productionCount: number,
): string =>
  `${testFixtureCount.toString()} of ${totalCount.toString()} matches are inside @isTest classes, where a hardcoded id or email is usually a deliberate fixture. The actionable production count is ${productionCount.toString()}. Pass excludeTestClasses: true to scan production only.`;

/**
 * FIX 13. A filter that removes rows must say how many it removed, or the
 * shrunken `totalCount` reads as a smaller org rather than a narrower question.
 */
const buildExcludeTestClassesDisclosure = (excludedCount: number): string =>
  `excludeTestClasses: true — ${excludedCount.toString()} match(es) inside @isTest classes were filtered out BEFORE this count and are not represented in matches, totalCount or byCategory. Re-run without excludeTestClasses to see them.`;

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
  // FIX 13. `true` drops every match whose parent class is `@isTest` BEFORE the
  // sort and the page, so `matches` / `totalCount` / `byCategory` describe
  // production code only. Default `false` — the unfiltered response is
  // unchanged. Folded into the cursor fingerprint below: a page minted with the
  // filter on must never resume against the unfiltered list.
  excludeTestClasses: z.boolean().optional(),
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
    readonly mode: 'component' | 'nameContains' | 'all';
    /**
     * FIX 13. Echoed ONLY when the caller passed `excludeTestClasses: true`, so
     * a host can never mistake a production-only scan for the full one. Absent
     * means the scan covered test classes as well.
     */
    readonly excludeTestClasses?: true;
  };
  /** Per-category counter across the FULL matched set. */
  readonly byCategory: Readonly<{
    readonly id: number;
    readonly email: number;
    readonly username: number;
    readonly url: number;
    readonly 'sandbox-data': number;
  }>;
  /**
   * FIX 13. Of `totalCount`, how many matches sit in code that actually ships.
   * A hardcoded id or email inside an `@isTest` class is usually a deliberate
   * fixture, and on a real org they dominate the headline — 110 of 116 measured
   * — so `totalCount` alone overstates the actionable work by ~19x.
   *
   * ADDITIVE: `totalCount` is unchanged and still counts every match, and
   * `productionCount + testFixtureCount === totalCount` always. Both are
   * emitted exactly when `testFixtureCount > 0`, i.e. when the split carries
   * information; with no test-class match in the set `totalCount` IS the
   * production count and `byCategory` IS `byCategoryProduction`, and the
   * response stays byte-identical to the pre-split shape.
   */
  readonly productionCount?: number;
  /** FIX 13. Of `totalCount`, how many matches are inside an `@isTest` class. */
  readonly testFixtureCount?: number;
  /**
   * FIX 13. `byCategory` restricted to the production matches. `byCategory`
   * itself is untouched and still spans the FULL set. Emitted alongside
   * `productionCount`.
   */
  readonly byCategoryProduction?: Readonly<{
    readonly id: number;
    readonly email: number;
    readonly username: number;
    readonly url: number;
    readonly 'sandbox-data': number;
  }>;
  /**
   * QUALITY-SCAN-SKIPS-TRIGGERS-AND-FLOWS. Per-type count of nodes read vs
   * nodes that actually carry a `qualityIssues` scan.
   *
   * D-3: emitted UNCONDITIONALLY. It used to appear only when some node in
   * scope was never scanned, so `matches: []` on a fully-scanned scope carried
   * no census — indistinguishable from a scope nothing ever read.
   */
  readonly qualityScanCoverage: readonly QualityScanTypeCoverage[];
  /**
   * Verbatim honesty disclosures. Never empty: the heuristic-confidence
   * disclosure describes HOW the recognizers match and is true on a
   * zero-match response too.
   */
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
  const excludeTestClasses = input.excludeTestClasses === true;

  const limit = input.limit ?? FIND_HARDCODED_DEFAULT_LIMIT;
  const ruleSet: ReadonlySet<string> =
    input.category === undefined
      ? ALL_HARDCODED_RULES
      : new Set([CATEGORY_TO_RULE[input.category]]);

  const collected: HardcodedValueMatch[] = [];

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
  // QUALITY-SCAN-SKIPS-TRIGGERS-AND-FLOWS. The nodes the caller's scope
  // ACTUALLY selected, kept so the response can say how many of them carry a
  // quality scan at all. Without it an empty result read as "no hardcoded
  // values in this scope" even when the scope was never scanned.
  const nodesInScope: Node[] = [];
  for (const node of scan.value.nodes) {
    // Apply the caller scope BEFORE reading findings so a scoped call reports
    // only its target's matches.
    if (input.componentId !== undefined) {
      if (node.id !== input.componentId) continue;
      componentIdMatched = true;
      // FIX 13 edge case. Scoping to an @isTest class and excluding test
      // classes are contradictory instructions; honouring the second would
      // return an empty scan OF THE THING THE CALLER NAMED, which reads as
      // "that class is clean". Refuse instead of answering a question nobody
      // asked.
      if (excludeTestClasses && isTestClass(node)) {
        return err({
          kind: 'invalid-query',
          message:
            'You scoped to an @isTest class and also excluded test classes; those cannot both hold.',
          path: 'excludeTestClasses',
        });
      }
    }
    if (nameNeedle !== null && !node.apiName.toLowerCase().includes(nameNeedle)) {
      continue;
    }
    nodesInScope.push(node);
    const raw = (node as Node).properties['qualityIssues'];
    if (!Array.isArray(raw)) continue;
    const inTest = isTestClass(node);
    for (const rawIssue of raw) {
      const issue = coerceIssue(rawIssue);
      if (issue === null) continue;
      if (!ruleSet.has(issue.rule)) continue;
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

  // FIX 13. Filter BEFORE the sort and the page, so `totalCount`, `byCategory`
  // and every cursor offset describe the same list the caller asked for.
  const retained = excludeTestClasses
    ? collected.filter((m) => !m.inTestClass)
    : collected;
  const excludedTestFixtureCount = collected.length - retained.length;

  const sorted = [...retained].sort(compareMatches);

  const byCategory = {
    id: 0,
    email: 0,
    username: 0,
    url: 0,
    'sandbox-data': 0,
  };
  // FIX 13. `byCategory` stays the FULL set — replacing it would silently
  // change what every existing caller reads. The production-only tally rides
  // ALONGSIDE it.
  const byCategoryProduction = {
    id: 0,
    email: 0,
    username: 0,
    url: 0,
    'sandbox-data': 0,
  };
  let productionCount = 0;
  for (const m of sorted) {
    if (!m.inTestClass) productionCount += 1;
    const cat = ruleToCategory(m.rule);
    if (cat !== null) {
      byCategory[cat] += 1;
      if (!m.inTestClass) byCategoryProduction[cat] += 1;
    }
  }
  const testFixtureCount = sorted.length - productionCount;
  // The refusal-pattern disclosure is a claim about the rows THIS response
  // returns, so it follows the retained set: with the filter on there is no
  // test-class row to caveat.
  const sawTestClassFinding = testFixtureCount > 0;

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
    // FIX 13. Without this a cursor minted over the production-only list would
    // decode cleanly against the unfiltered one and resume at an offset that
    // points at a different row — a silent skip across the boundary. Added only
    // when the filter is ON so the default fingerprint (and therefore every
    // existing cursor) is unchanged.
    ...(excludeTestClasses ? { excludeTestClasses: true } : {}),
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

  // D-3: the heuristic-confidence disclosure describes HOW the recognizers
  // match (literal shape, key prefixes, a strict email regex) and is true
  // whether or not anything matched — so it is UNCONDITIONAL. It used to be
  // gated on `sorted.length > 0`, which silenced it on the zero-match response,
  // the one shape that most needs to say what the scanner actually did.
  //
  // TEST_CLASS_REFUSAL_DISCLOSURE stays gated on `sawTestClassFinding` on
  // purpose: it is a claim about ROWS THIS RESPONSE RETURNED ("some of these
  // may be deliberate fixtures"), not a claim about the scanner, so it is false
  // advertising on a response with no test-class row in it.
  const boundaries: string[] = [HEURISTIC_CONFIDENCE_DISCLOSURE];
  if (sawTestClassFinding) {
    boundaries.push(TEST_CLASS_REFUSAL_DISCLOSURE);
    boundaries.push(
      buildTestFixtureSplitDisclosure(
        testFixtureCount,
        sorted.length,
        productionCount,
      ),
    );
  }
  if (excludeTestClasses) {
    boundaries.push(
      buildExcludeTestClassesDisclosure(excludedTestFixtureCount),
    );
  }
  // QUALITY-SCAN-SKIPS-TRIGGERS-AND-FLOWS. `SCANNED_TYPES` includes
  // ApexTrigger, but `detectCodeQualityIssues` ran from the ApexClass extractor
  // ONLY — so on a vault built before the trigger extractor was wired, a
  // hardcoded-Id hunt over any trigger returned `matches: []`, `boundaries: []`,
  // indistinguishable from a clean trigger. Lives OUTSIDE the zero-findings
  // gate because the zero-finding response IS the false-clean one.
  const qualityScanCoverage = censusQualityScanCoverage(nodesInScope);
  const unscannedNote = buildUnscannedNodesNote(qualityScanCoverage);
  if (unscannedNote !== undefined) boundaries.push(unscannedNote);
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

  // The boundaries and `qualityScanCoverage` ride in the SAME envelope as the
  // paged `matches`, so charge them against the page budget. Built ABOVE the
  // pagination for exactly that reason — none of them depends on the page, only
  // on `sorted` / `nodesInScope` / `scan.value`.
  //
  // WHY: adding the NOT-SCANNED note took the default no-args response from
  // 39,701 to 40,115 bytes, past the global ~40 KB guard. The guard trims the
  // largest array, so `matches` came back with 50 rows while
  // `pageInfo.returnedCount` still said 100 and `nextCursor` resumed at offset
  // 100 — 50 of 112 findings unreachable through the tool's own pagination. A
  // disclosure added to stop a false-clean answer must not silently drop
  // findings to make room for itself.
  const disclosureBytes = Buffer.byteLength(
    JSON.stringify({ boundaries, qualityScanCoverage }),
    'utf8',
  );
  const matchesByteBudget = Math.max(
    12_000,
    DEFAULT_PAGE_BYTE_BUDGET - disclosureBytes,
  );

  const paged = paginateLegacy(sorted, {
    offset,
    limit,
    keyOf: matchKey,
    byteBudget: matchesByteBudget,
    binding: {
      tool: FIND_HARDCODED_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const slice = paged.items;
  const truncated = paged.hasMore;
  const emitCursor = paged.nextCursor !== null;

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
      // FIX 13. Emitted exactly when the split says something `totalCount` and
      // `byCategory` do not. With no test-class match in the set the two pairs
      // are equal by construction and the response stays byte-identical.
      ...(testFixtureCount > 0
        ? { productionCount, testFixtureCount, byCategoryProduction }
        : {}),
      qualityScanCoverage,
      boundaries,
      truncated,
      ...(input.componentId !== undefined ||
      input.nameContains !== undefined ||
      excludeTestClasses
        ? {
            appliedScope: {
              component: input.componentId ?? null,
              nameContains: input.nameContains ?? null,
              mode:
                input.componentId !== undefined
                  ? ('component' as const)
                  : input.nameContains !== undefined
                    ? ('nameContains' as const)
                    : ('all' as const),
              ...(excludeTestClasses
                ? { excludeTestClasses: true as const }
                : {}),
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
