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
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { nodeScanLimit, scanHitCap, scanTruncationNote } from './scan-cap.js';

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
  limit: z
    .number()
    .int()
    .min(1)
    .max(FIND_HARDCODED_MAX_LIMIT)
    .optional(),
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
  /** True when the matched count exceeded `limit`. */
  readonly truncated: boolean;
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

/** Comparator: componentId ASC, location ASC, rule ASC. */
const compareMatches = (
  a: HardcodedValueMatch,
  b: HardcodedValueMatch,
): number => {
  if (a.componentId !== b.componentId) {
    return a.componentId < b.componentId ? -1 : 1;
  }
  if (a.location !== b.location) return a.location < b.location ? -1 : 1;
  if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
  return 0;
};

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
  const limit = input.limit ?? FIND_HARDCODED_DEFAULT_LIMIT;
  const ruleSet: ReadonlySet<string> =
    input.category === undefined
      ? ALL_HARDCODED_RULES
      : new Set([CATEGORY_TO_RULE[input.category]]);

  const collected: HardcodedValueMatch[] = [];
  let sawTestClassFinding = false;

  // Per-type scan saturation. A type whose page came back AT the fetch cap may
  // have hardcoded-value findings BEHIND it that this scan never examined.
  // Fetch at `nodeScanLimit()` (not a hardcoded 500) so the disclosure tracks
  // the ACTUAL fetch, mirroring `app_access`; `SFI_NODE_SCAN_LIMIT` can drive
  // the truncated path in tests.
  const truncatedTypes: string[] = [];
  const scanLimit = nodeScanLimit();
  for (const type of SCANNED_TYPES) {
    const nodesResult = await listNodesByType(ctx.graph, type, {
      limit: scanLimit,
    });
    if (!nodesResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${nodesResult.error.message}`,
      });
    }
    if (scanHitCap(nodesResult.value.length, scanLimit)) truncatedTypes.push(type);
    for (const node of nodesResult.value) {
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
  }

  const sorted = [...collected].sort(compareMatches);
  const truncated = sorted.length > limit;
  const slice = sorted.slice(0, limit);

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

  const boundaries: string[] = [];
  if (sorted.length > 0) {
    boundaries.push(HEURISTIC_CONFIDENCE_DISCLOSURE);
    if (sawTestClassFinding) {
      boundaries.push(TEST_CLASS_REFUSAL_DISCLOSURE);
    }
  }
  // Truncation is meaningful EVEN with zero matched findings — findings may sit
  // past the scan cap — so this append lives OUTSIDE the `sorted.length > 0`
  // gate above. (`truncated` is the OUTPUT-slice cursor; this is the INPUT-scan
  // saturation, a separate honesty axis.)
  if (truncatedTypes.length > 0) {
    boundaries.push(scanTruncationNote(truncatedTypes));
  }

  return ok({
    data: {
      matches: slice,
      totalCount: sorted.length,
      byCategory,
      boundaries,
      truncated,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
