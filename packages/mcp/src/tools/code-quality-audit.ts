/**
 * Handler for the `sfi.code_quality_audit` MCP tool.
 *
 * The v2.1 general-purpose entry point over the
 * `properties.qualityIssues[]` array that the v2.1
 * `code-quality-patterns` recognizer family populates at extraction
 * time. CR-22 B3: scans EVERY node of each relevant ComponentType
 * (`ApexClass` / `ApexTrigger` / `Flow`) by paging the graph SQL
 * `OFFSET` forward window-by-window (`scanAllNodesOfTypes`), so
 * findings on a node past the per-page scan cap (501+) are reachable
 * rather than dropped, reads each node's `qualityIssues[]` property,
 * applies optional severity / rule filters, sorts the FULL set by
 * severity DESC then id ASC (then location / explanation tiebreaks
 * for a strict total order), pages it on the output axis via the
 * shared continuation cursor, and returns the page along with a
 * per-severity / per-rule summary computed over the full matched set.
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
 * **Honesty axis** (each recognizer's own declared boundary, in
 * `packages/patterns/src/code-quality-patterns.ts`):
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
 *   - CR-22 B3: the per-type scan WINDOWS the graph SQL `OFFSET` at
 *     `clampedNodeScanLimit()` (≤500) per page until each type is
 *     exhausted, so an org with more than 500 ApexClasses is scanned
 *     in full (no dropped tail). `scanTruncated` / a `fullScanTruncationNote`
 *     fire only for a pathological type past `FULL_SCAN_MAX_NODES`.
 *     An operator setting `SFI_NODE_SCAN_LIMIT > 500` is clamped (no
 *     hard error — CR-RV10).
 *   - `limit` defaults to 100 and is capped at 500 by Zod. The
 *     `totalCount` in the response reports the FULL unsorted matched
 *     count, not the paged slice — callers can render "showing X of Y
 *     findings" without a re-query. A truncated page emits a `nextCursor`
 *     to walk the rest; a whole-fits no-cursor page omits the paging
 *     fields entirely (byte-identical to pre-CR-22).
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
import { getNodeById } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import {
  buildNotCheckedTypesNote,
  buildUnscannedNodesNote,
  censusQualityScanCoverage,
  NOT_APEX_TYPES,
  type NotCheckedType,
  type QualityScanTypeCoverage,
} from './quality-scan-coverage.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { fullScanTruncationNote } from './scan-cap.js';

/** Inclusive upper bound on `limit`. Mirrors the enumeration-style tools. */
const CODE_QUALITY_AUDIT_MAX_LIMIT = 500;

/** Default `limit` when the caller omits it. */
const CODE_QUALITY_AUDIT_DEFAULT_LIMIT = 100;

/**
 * The ComponentTypes the quality recognizers actually populate.
 *
 * QUALITY-SCAN-SKIPS-TRIGGERS-AND-FLOWS. This list used to carry `Flow` as an
 * aspiration ("future recognizer extensions can append it") and the tool
 * advertised the coverage as fact, while `Flow` contributed 0 of 275 nodes on a
 * real vault — because every recognizer reads APEX syntax and a Flow has none.
 * `Flow` is not a pending gap a refresh closes; it is structurally out of
 * reach, so it moved to {@link NOT_APEX_TYPES} where it is NAMED on every
 * org-wide response instead of silently scanned for a property that cannot
 * exist. `ApexTrigger` is genuinely covered now that the trigger extractor runs
 * the recognizers.
 */
const QUALITY_SCANNED_TYPES: readonly ComponentType[] = [
  'ApexClass',
  'ApexTrigger',
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
  'severity assignments are fixed industry-consensus mappings declared by the recognizer that raised the finding; per-organization severity overrides are not supported.';

/**
 * Zod schema for the `sfi.code_quality_audit` tool input.
 *
 *   - `componentId` (`ApexClass:{name}` / `ApexTrigger:{name}`) /
 *     `classApiName` / `apiName` / `componentFilter`: optional CLASS SCOPE. When
 *     supplied the audit returns ONLY that class's quality issues (+
 *     `appliedScope`); an unresolved id is `component-not-found` and a non-Apex
 *     type prefix is `invalid-query` — never a silent org-wide fallback
 *     (CODE-QUALITY-AUDIT-IGNORES-CLASS-SCOPE). Omit all four for the org-wide
 *     audit. `componentFilter` is the ADR-007 alias residual: hosts (and this
 *     repo's own `developer-code-quality` skill) reached for that name, and a
 *     bare `z.object` DROPPED it — turning a one-class audit into a silently
 *     org-wide sweep the caller then read as that one class's findings. It is
 *     now honored, not stripped (CODE-QUALITY-AUDIT-COMPONENTFILTER-ALIAS).
 *   - The schema is `.strict()`: any OTHER unknown key is `invalid-query`, never
 *     a silent drop. A dropped scope key is indistinguishable from "no scope
 *     requested", and the org-wide answer that follows is confidently wrong.
 *   - `severityFilter`: optional. `'all'` (default) surfaces every
 *     severity tier; any specific tier narrows to that level.
 *   - `ruleFilter`: optional array of rule ids (e.g.
 *     `['soql-in-loop', 'dml-in-loop']`). Omitted means no rule
 *     filter.
 *   - `limit`: optional integer in `[1, 500]`. Defaults to 100 in the
 *     handler.
 */
export const codeQualityAuditInputSchema = z
  .object({
    componentId: z.string().min(1).optional(),
    classApiName: z.string().min(1).optional(),
    apiName: z.string().min(1).optional(),
    componentFilter: z.string().min(1).optional(),
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
    // CR-22: page cursor for walking the full issue list when truncated.
    offset: z.number().int().min(0).optional(),
    cursor: z.string().min(1).optional(),
  })
  // An unknown key on a SCOPING tool is never benign: Zod's default strip turns
  // a mis-spelled scope selector into an org-wide sweep the caller reads as the
  // scoped result. Fail closed with `invalid-query` instead.
  .strict();

const CODE_QUALITY_AUDIT_TOOL = 'sfi.code_quality_audit';

const APEX_CLASS_PREFIX = 'ApexClass:';
const APEX_TRIGGER_PREFIX = 'ApexTrigger:';

/** The Apex ComponentTypes a CLASS SCOPE may resolve to. */
const CLASS_SCOPE_TYPES: readonly ComponentType[] = [
  'ApexClass',
  'ApexTrigger',
];

/** Parsed input shape. */
export type CodeQualityAuditInput = z.infer<typeof codeQualityAuditInputSchema>;

/**
 * Resolve the optional CLASS SCOPE from `componentId` / `classApiName` /
 * `apiName` / `componentFilter` (precedence in that order). `componentId` may be an
 * `ApexClass:`/`ApexTrigger:` id; bare `classApiName`/`apiName` coerce to
 * `ApexClass:{name}`. A value carrying a non-Apex type prefix (e.g. `Flow:`,
 * `CustomObject:`) is `invalid-query` — a class scope is Apex-only.
 * `undefined` (no selector) → org-wide (returns `null`).
 */
const resolveScopeId = (
  input: CodeQualityAuditInput,
): Result<ComponentId | null, McpError> => {
  const raw =
    input.componentId ??
    input.classApiName ??
    input.apiName ??
    input.componentFilter;
  if (raw === undefined) return ok(null);
  if (raw.startsWith(APEX_CLASS_PREFIX) || raw.startsWith(APEX_TRIGGER_PREFIX)) {
    return ok(raw as ComponentId);
  }
  if (raw.includes(':')) {
    return err({
      kind: 'invalid-query',
      message: `'${raw}' is not an ApexClass / ApexTrigger — pass a bare class api name or an 'ApexClass:{name}' / 'ApexTrigger:{name}' id`,
      path: 'componentId',
    });
  }
  return ok(`${APEX_CLASS_PREFIX}${raw}` as ComponentId);
};

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
  /**
   * The CLASS SCOPE actually applied. Present ONLY when the caller passed a
   * `componentId` / `classApiName` / `apiName` scope — an unscoped org-wide call
   * omits it entirely so its response stays byte-identical to the pre-scope
   * shape. `component` is the resolved `ApexClass:`/`ApexTrigger:` id; a host
   * that sees no `appliedScope` MUST treat the result as the full org-wide audit.
   */
  readonly appliedScope?: {
    readonly component: string | null;
    readonly mode: 'component';
  };
  readonly issues: readonly CodeQualityAuditIssue[];
  /** FULL count of matched findings before slicing to `limit`. */
  readonly totalCount: number;
  readonly summary: CodeQualityAuditSummary;
  /**
   * QUALITY-SCAN-SKIPS-TRIGGERS-AND-FLOWS. Per-type count of nodes read vs
   * nodes that actually carry a `qualityIssues` scan. Present ONLY on the
   * org-wide path (a class-scoped call is about one named node, and its own
   * unscanned state is already in `boundaries`). A type whose `scanned` is
   * below its `nodes` returned "not checked", never "clean".
   */
  readonly qualityScanCoverage?: readonly QualityScanTypeCoverage[];
  /**
   * Types this audit structurally cannot cover on any vault after any refresh —
   * currently `Flow`, because the recognizers read Apex syntax. Present ONLY on
   * the org-wide path, where a reader could otherwise assume the audit spans
   * every automation surface.
   */
  readonly notCheckedTypes?: readonly NotCheckedType[];
  /** Verbatim honesty disclosures; empty when the response has no findings. */
  readonly boundaries: readonly string[];
  /** True when the matched count exceeded `limit` and `issues` was sliced. */
  readonly truncated: boolean;
  /**
   * Page size applied. Present only on a PAGED response (`truncated` or a
   * resumed `offset > 0`); omitted on a whole-fits no-cursor call so that
   * response stays byte-identical to the pre-CR-22 shape.
   */
  readonly limit?: number;
  /** Zero-based offset of the first returned issue. Present only when paged. */
  readonly offset?: number;
  /** Offset to pass on the next call to fetch the following page. Present only when `truncated`. */
  readonly nextOffset?: number;
  /**
   * CR-22 opaque continuation token, present ONLY when this page is truncated.
   * Echo it back as `cursor` to resume. Absent on a complete page.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
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
 * Comparator: severity DESC (critical first), then componentId ASC, then rule
 * ASC, then location ASC, then explanation ASC. Stable across runs so fixtures
 * don't flap.
 *
 * CR-22: the trailing `location` + `explanation` tiebreaks make the order a
 * STRICT TOTAL order. A single class can carry MULTIPLE issues with the SAME
 * rule + SAME severity (e.g. two `soql-in-loop` findings at different lines), so
 * (severity, componentId, rule) alone returned 0 for them — an offset resume
 * could dup or skip within that tie cluster. `location` distinguishes same-rule
 * findings; `explanation` is the final distinguishing key. Because the FULL
 * issue set is scanned and sorted BEFORE paging, the severity-first order is a
 * complete total order over a fixed set (no incremental-scan merge), so paging
 * it is dup/skip-proof.
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
  if (a.location !== b.location) return a.location < b.location ? -1 : 1;
  if (a.explanation !== b.explanation) return a.explanation < b.explanation ? -1 : 1;
  return 0;
};

/** Stable total-order key for the cursor `k` field. */
const issueKey = (i: CodeQualityAuditIssue): string =>
  `${i.severity}|${i.componentId}|${i.rule}|${i.location}|${i.explanation}`;

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

  // Optional CLASS SCOPE. When supplied, audit ONLY that class (skip the org
  // scan); an unresolved id is `component-not-found`, a non-Apex type prefix is
  // `invalid-query` — never a silent org-wide fallback
  // (CODE-QUALITY-AUDIT-IGNORES-CLASS-SCOPE).
  const scopeResult = resolveScopeId(input);
  if (!scopeResult.ok) return scopeResult;
  const scopeId = scopeResult.value;

  const collected: CodeQualityAuditIssue[] = [];

  // Class-scope: read just the one node; org-wide: scan EVERY quality type by
  // paging the SQL OFFSET forward (CR-22 B3 — window-by-window at the clamped
  // cap) so findings on node 501+ are reachable rather than dropped. The FULL
  // issue set is then sorted (severity-first) and paged on the output axis
  // below. Because the complete set is sorted BEFORE paging, the severity-first
  // order is a true total order over a fixed set (no incremental-scan merge), so
  // it is safe to page even though the sort is not scan-order.
  let nodesToProcess: readonly Node[];
  let scanIncomplete = false;
  let incompleteTypes: readonly string[] = [];
  if (scopeId !== null) {
    const nodeRes = await getNodeById(ctx.graph, scopeId);
    if (!nodeRes.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${nodeRes.error.message}` });
    }
    if (nodeRes.value === null) {
      return err({
        kind: 'component-not-found',
        message: `no ApexClass / ApexTrigger matches \`${scopeId}\` in this vault`,
        path: scopeId,
      });
    }
    if (!CLASS_SCOPE_TYPES.includes(nodeRes.value.type)) {
      return err({
        kind: 'invalid-query',
        message: `\`${scopeId}\` is a ${nodeRes.value.type}, not an ApexClass / ApexTrigger — the code_quality_audit class scope is Apex-only`,
        path: 'componentId',
      });
    }
    nodesToProcess = [nodeRes.value];
  } else {
    const scan = await scanAllNodesOfTypes(ctx.graph, QUALITY_SCANNED_TYPES);
    if (!scan.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${scan.error.message}` });
    }
    nodesToProcess = scan.value.nodes;
    scanIncomplete = scan.value.scanIncomplete;
    incompleteTypes = scan.value.incompleteTypes;
  }
  for (const node of nodesToProcess) {
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

  const sorted = [...collected].sort(compareIssues);

  // Build summary aggregates from the FULL matched set, not the slice.
  const bySeverity = emptyBySeverity();
  const byRule: Record<string, number> = {};
  const byType: Partial<Record<ComponentType, number>> = {};
  for (const issue of sorted) {
    bySeverity[issue.severity] += 1;
    byRule[issue.rule] = (byRule[issue.rule] ?? 0) + 1;
    byType[issue.type] = (byType[issue.type] ?? 0) + 1;
  }

  // CR-22: resolve the resume offset (echoed cursor wins over explicit offset).
  // The fingerprint covers the narrowing args (severityFilter / ruleFilter) so a
  // token can't be replayed against a different filter.
  const fingerprintArgs: Record<string, unknown> = {};
  if (scopeId !== null) fingerprintArgs['componentId'] = scopeId;
  if (input.severityFilter !== undefined) fingerprintArgs['severityFilter'] = input.severityFilter;
  if (input.ruleFilter !== undefined) fingerprintArgs['ruleFilter'] = input.ruleFilter;
  const fingerprint = argsFingerprint(fingerprintArgs);
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: CODE_QUALITY_AUDIT_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  const paged = paginateLegacy(sorted, {
    offset,
    limit,
    keyOf: issueKey,
    binding: {
      tool: CODE_QUALITY_AUDIT_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const slice = paged.items;
  const truncated = paged.hasMore;
  const emitCursor = paged.nextCursor !== null;

  const boundaries: string[] =
    sorted.length === 0
      ? []
      : [
          HEURISTIC_CONFIDENCE_DISCLOSURE,
          DYNAMIC_BLIND_SPOT_DISCLOSURE,
          SEVERITY_CONSENSUS_DISCLOSURE,
        ];

  // QUALITY-SCAN-SKIPS-TRIGGERS-AND-FLOWS. Both notes live OUTSIDE the
  // zero-findings gate on purpose: a zero-finding response IS the false-clean
  // shape, so it is the one that most needs to say what was not scanned.
  const qualityScanCoverage = censusQualityScanCoverage(nodesToProcess);
  const unscannedNote = buildUnscannedNodesNote(qualityScanCoverage);
  if (unscannedNote !== undefined) boundaries.push(unscannedNote);
  // The permanent, refresh-proof half. Only on the org-wide path: a caller who
  // named one Apex class did not ask about Flows, and its response stays
  // byte-identical.
  const notCheckedNote =
    scopeId === null ? buildNotCheckedTypesNote(NOT_APEX_TYPES) : undefined;
  if (notCheckedNote !== undefined) boundaries.push(notCheckedNote);

  // Residual scan-incompleteness only fires for a PATHOLOGICAL type past
  // FULL_SCAN_MAX_NODES — the normal full scan reaches node 501+ and completes.
  // Lives OUTSIDE the zero-findings gate because findings could be among the
  // unscanned residual tail. Never fires in class scope (single node, no scan).
  if (scanIncomplete) {
    boundaries.push(fullScanTruncationNote(incompleteTypes));
  }

  // Emit paging fields ONLY on a paged response (truncated OR resumed offset>0).
  const isPaged = truncated || offset > 0;

  return ok({
    data: {
      // Emit appliedScope ONLY when a class scope was passed, so a bare org-wide
      // call stays byte-identical to the pre-scope golden.
      ...(scopeId !== null
        ? { appliedScope: { component: scopeId, mode: 'component' as const } }
        : {}),
      issues: slice,
      totalCount: sorted.length,
      summary: { bySeverity, byRule, byType },
      ...(scopeId === null
        ? { qualityScanCoverage, notCheckedTypes: NOT_APEX_TYPES }
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
