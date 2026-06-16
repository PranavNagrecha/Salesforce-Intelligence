/**
 * Handler for the `sfi.code_quality_audit` MCP tool.
 *
 * The v2.1 general-purpose entry point over the
 * `properties.qualityIssues[]` array that the v2.1
 * `code-quality-patterns` recognizer family populates at extraction
 * time. Composes one `listNodesByType` call per relevant
 * ComponentType (today: `ApexClass`; tomorrow's v2.1+ recognizer
 * extensions could add `ApexTrigger` and `Flow` so the scan walks
 * each family by default), reads each node's `qualityIssues[]`
 * property, applies optional severity / rule / per-class filters,
 * sorts the slice by severity DESC then id ASC, and returns the
 * limited list along with a per-severity / per-rule summary.
 *
 * **Composition recipe** — pure read-side composition over existing
 * graph queries and the recognizer's property mirror. No graph edges
 * are walked: every quality observation rides in the parent node's
 * `properties.qualityIssues` array. The tool itself does NOT call the
 * recognizer at request time; it surfaces what extraction has already
 * persisted. A vault refreshed before v2.1 ships will return an empty
 * `issues` list with all-zero summary counts — the honest "nothing to
 * report" answer rather than a fabricated one.
 *
 * **Severity ordering** — the v2.1 catalog defines a five-tier scale
 * `critical > high > medium > low > info`. The default sort is
 * severity DESC then `componentId` ASC then `rule` ASC, so the
 * highest-priority findings surface first in the slice the response
 * carries.
 *
 * **Honesty axis** (per the v2.1 spec and `ApexQualitySemantics.md`):
 *   - Pattern recognition is heuristic — every finding carries
 *     `confidence: 'heuristic'`. The recognizer cannot verify the
 *     developer's intent; false positives are expected. The
 *     `boundaries` array makes this verbatim.
 *   - Static recognition has dynamic blind spots. Dynamic SOQL,
 *     reflective field access, and dynamic method dispatch are
 *     invisible. The `boundaries` array surfaces this verbatim.
 *   - Severity is industry-consensus, not user-tuned in v2.1. Per-org
 *     overrides are deferred. Surfaced verbatim in `boundaries` when
 *     the response carries at least one finding.
 *
 * Implementation notes:
 *   - `severityFilter: 'all'` and an absent filter behave identically.
 *     The literal `'all'` is preserved in the input contract so the
 *     advertised JSON Schema can document the sentinel explicitly.
 *   - The per-type scan caps at `LIST_PAGE_SIZE` (500) per
 *     `ComponentType` — matches the graph layer's default. A truly
 *     enormous org (more than 500 ApexClasses) will only see the first
 *     page; that's a v2.1 honesty boundary mirroring v2.0b
 *     `unused_components`.
 *   - `limit` defaults to 100 and is capped at 500 by Zod. The
 *     `totalCount` in the response reports the FULL unsorted matched
 *     count, not the trimmed slice — callers can render "showing X of
 *     Y findings" without a re-query.
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

/** Inclusive upper bound on `limit`. Mirrors the enumeration-style tools. */
const CODE_QUALITY_AUDIT_MAX_LIMIT = 500;

/** Default `limit` when the caller omits it. */
const CODE_QUALITY_AUDIT_DEFAULT_LIMIT = 100;

/** Per-type cap matching `listNodesByType`'s default. */
const LIST_PAGE_SIZE = 500;

/**
 * The ComponentTypes the v2.1 quality recognizers populate. v2.1 R2
 * wires `ApexClass`; future recognizer extensions can append
 * `ApexTrigger` / `Flow` without changing the tool surface (the
 * `properties.qualityIssues` mirror is per-node, not per-type).
 * Keeping the array centralized makes the additional-type onboarding
 * a one-line diff.
 */
const QUALITY_SCANNED_TYPES: readonly ComponentType[] = [
  'ApexClass',
  'ApexTrigger',
  'Flow',
];

/** The five-tier severity scale, ordered HIGHEST → LOWEST. */
const SEVERITY_ORDER = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
] as const;

/** One of the recognized severity levels. */
type Severity = (typeof SEVERITY_ORDER)[number];

/** Sentinel `'all'` means "no severity filter". */
type SeverityFilter = Severity | 'all';

/** Numeric rank used by the severity-DESC sort. Lower is more severe. */
const SEVERITY_RANK: Readonly<Record<Severity, number>> = Object.freeze({
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
});

/**
 * Verbatim boundary disclosures surfaced when the response carries at
 * least one finding. The three-axis honesty disclosure parallels the
 * v2.0 three-axis pattern.
 */
const HEURISTIC_CONFIDENCE_DISCLOSURE =
  'pattern recognition is heuristic — every finding carries confidence: heuristic. The recognizer cannot verify the developer intent; false positives are expected. Review the cited location before treating as a bug.';
const DYNAMIC_BLIND_SPOT_DISCLOSURE =
  'static recognition has dynamic blind spots — dynamic SOQL strings, reflective field access, and dynamic method dispatch are invisible to the recognizer. The list above is what the recognizer SAW; what it missed is harder to enumerate.';
const SEVERITY_CONSENSUS_DISCLOSURE =
  'severity assignments are industry-consensus mappings per ApexQualitySemantics.md; v2.1 does not support per-organization severity overrides.';

/**
 * Zod schema for the `sfi.code_quality_audit` tool input.
 *
 *   - `severityFilter`: optional. `'all'` (default) surfaces every
 *     severity tier; any specific tier narrows to that level.
 *   - `ruleFilter`: optional array of rule ids (e.g.
 *     `['soql-in-loop', 'dml-in-loop']`). Omitted means no rule
 *     filter.
 *   - `limit`: optional integer in `[1, 500]`. Defaults to 100 in the
 *     handler.
 */
export const codeQualityAuditInputSchema = z.object({
  severityFilter: z
    .enum(['critical', 'high', 'medium', 'low', 'info', 'all'])
    .optional(),
  ruleFilter: z.array(z.string().min(1)).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(CODE_QUALITY_AUDIT_MAX_LIMIT)
    .optional(),
});

/** Parsed input shape. */
export type CodeQualityAuditInput = z.infer<typeof codeQualityAuditInputSchema>;

/**
 * One entry in the response's `issues` array. Carries both the
 * recognizer's per-issue fields (`rule`, `severity`, `location`,
 * `explanation`, `confidence`) and the parent component's identity
 * (`componentId`, `type`, `apiName`) so the renderer can show the
 * finding without a follow-up `getNodeById` call.
 */
export interface CodeQualityAuditIssue {
  readonly componentId: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  readonly rule: string;
  readonly severity: Severity;
  readonly location: string;
  readonly explanation: string;
  readonly confidence: 'heuristic';
}

/** Per-severity / per-rule / per-type aggregate summary. */
export interface CodeQualityAuditSummary {
  readonly bySeverity: Readonly<Record<Severity, number>>;
  readonly byRule: Readonly<Record<string, number>>;
  readonly byType: Readonly<Partial<Record<ComponentType, number>>>;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface CodeQualityAuditOutput {
  readonly issues: readonly CodeQualityAuditIssue[];
  /** FULL count of matched findings before slicing to `limit`. */
  readonly totalCount: number;
  readonly summary: CodeQualityAuditSummary;
  /** Verbatim honesty disclosures; empty when the response has no findings. */
  readonly boundaries: readonly string[];
  /** True when the matched count exceeded `limit` and `issues` was sliced. */
  readonly truncated: boolean;
}

/**
 * Narrowing guard for an unknown value pulled out of a `properties`
 * bag. Returns the value as a typed `QualityIssueLike` only when it
 * carries the four required fields with the expected primitive
 * shapes; everything else is dropped silently (forward-compatible
 * with future recognizer changes).
 */
interface QualityIssueLike {
  readonly rule: string;
  readonly severity: Severity;
  readonly location: string;
  readonly explanation: string;
}

const SEVERITY_SET: ReadonlySet<string> = new Set(SEVERITY_ORDER);

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

/**
 * Comparator: severity DESC (critical first), then componentId ASC,
 * then rule ASC. Stable across runs so fixtures don't flap.
 */
const compareIssues = (
  a: CodeQualityAuditIssue,
  b: CodeQualityAuditIssue,
): number => {
  const ra = SEVERITY_RANK[a.severity];
  const rb = SEVERITY_RANK[b.severity];
  if (ra !== rb) return ra - rb;
  if (a.componentId !== b.componentId) {
    return a.componentId < b.componentId ? -1 : 1;
  }
  if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
  return 0;
};

/** Build an empty per-severity counter. */
const emptyBySeverity = (): Record<Severity, number> => ({
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  info: 0,
});

/**
 * The `sfi.code_quality_audit` MCP tool. Returns every quality issue
 * across the v2.1-scanned ComponentTypes, optionally filtered by
 * severity and / or rule id, sorted by severity DESC then id ASC.
 * See the module JSDoc for the per-honesty-axis boundary text the
 * response carries when at least one finding qualifies.
 *
 * @example
 *   const r = await codeQualityAuditHandler(ctx, {
 *     severityFilter: 'critical',
 *   });
 *   if (r.ok) console.log(r.value.data.totalCount);
 */
export const codeQualityAuditHandler = async (
  ctx: Context,
  input: CodeQualityAuditInput,
): Promise<Result<McpResponse<CodeQualityAuditOutput>, McpError>> => {
  const limit = input.limit ?? CODE_QUALITY_AUDIT_DEFAULT_LIMIT;
  const severityFilter: SeverityFilter = input.severityFilter ?? 'all';
  const ruleFilter: ReadonlySet<string> | null =
    input.ruleFilter && input.ruleFilter.length > 0
      ? new Set(input.ruleFilter)
      : null;

  const collected: CodeQualityAuditIssue[] = [];

  for (const type of QUALITY_SCANNED_TYPES) {
    const nodesResult = await listNodesByType(ctx.graph, type, {
      limit: LIST_PAGE_SIZE,
    });
    if (!nodesResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${nodesResult.error.message}`,
      });
    }
    for (const node of nodesResult.value) {
      const raw = (node as Node).properties['qualityIssues'];
      if (!Array.isArray(raw)) continue;
      for (const rawIssue of raw) {
        const issue = coerceIssue(rawIssue);
        if (issue === null) continue;
        if (
          severityFilter !== 'all' &&
          issue.severity !== severityFilter
        ) {
          continue;
        }
        if (ruleFilter !== null && !ruleFilter.has(issue.rule)) {
          continue;
        }
        collected.push({
          componentId: node.id,
          type: node.type,
          apiName: node.apiName,
          rule: issue.rule,
          severity: issue.severity,
          location: issue.location,
          explanation: issue.explanation,
          confidence: 'heuristic',
        });
      }
    }
  }

  const sorted = [...collected].sort(compareIssues);
  const truncated = sorted.length > limit;
  const slice = sorted.slice(0, limit);

  // Build summary aggregates from the FULL matched set, not the slice.
  const bySeverity = emptyBySeverity();
  const byRule: Record<string, number> = {};
  const byType: Partial<Record<ComponentType, number>> = {};
  for (const issue of sorted) {
    bySeverity[issue.severity] += 1;
    byRule[issue.rule] = (byRule[issue.rule] ?? 0) + 1;
    byType[issue.type] = (byType[issue.type] ?? 0) + 1;
  }

  const boundaries: string[] =
    sorted.length === 0
      ? []
      : [
          HEURISTIC_CONFIDENCE_DISCLOSURE,
          DYNAMIC_BLIND_SPOT_DISCLOSURE,
          SEVERITY_CONSENSUS_DISCLOSURE,
        ];

  return ok({
    data: {
      issues: slice,
      totalCount: sorted.length,
      summary: { bySeverity, byRule, byType },
      boundaries,
      truncated,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
