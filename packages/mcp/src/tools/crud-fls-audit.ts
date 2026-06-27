/**
 * Handler for the `sfi.crud_fls_audit` MCP tool.
 *
 * The v2.1 CRUD / FLS enforcement audit — Apex classes that perform
 * DML or SOQL without the relevant security check. Composes over the
 * `properties.qualityIssues[]` array the v2.1 `code-quality-patterns`
 * recognizer family populates for ApexClass / ApexTrigger nodes,
 * narrows to the two CRUD/FLS rules, groups by class, and emits the
 * verbatim Q80 false-positive disclosure inherited from
 * `ApexQualitySemantics.md` §§ 6-7.
 *
 * **CRUD/FLS rule subset:**
 *   - `missing-crud-check` — DML (`insert`/`update`/`delete`/`upsert`/
 *     `merge` or `Database.*(...)`) without a preceding
 *     `Schema.sObjectType.X.isCreateable()` (or matching) check or a
 *     `WITH SECURITY_ENFORCED` / `USER_MODE` clause on the source
 *     query.
 *   - `missing-fls-check` — SOQL inline query without
 *     `WITH SECURITY_ENFORCED` / `WITH USER_MODE`. The naive heuristic
 *     flags every inline `[SELECT ... FROM ...]` that omits the
 *     clause.
 *
 * Both rules are skipped for test classes (`properties.isTest:
 * true`) — the v2.1 recognizer's own honesty boundary.
 *
 * **Honesty axis — Q80 verbatim disclosure** (per
 * `ApexQualitySemantics.md` §§ 6-7 and the v2.1 R3 §4 disclosure
 * language). The CRUD/FLS recognizer has a HIGH false-positive rate
 * because:
 *
 *   - Custom security utility helpers (e.g.
 *     `SecurityUtils.canCreate(account)`) are invisible — the
 *     recognizer recognizes only the standard `Schema.sObjectType...`
 *     patterns. If the org uses a custom helper, the recognizer flags
 *     every DML as missing-CRUD.
 *   - Cross-method dataflow is invisible — a method that delegates
 *     the dangerous operation to a helper is analyzed in isolation;
 *     the helper's behavior is invisible.
 *   - Dynamic SOQL (`Database.query(...)`) strings are stripped
 *     before pattern passes; the embedded SQL is invisible to the
 *     FLS recognizer.
 *
 * The tool surfaces the Q80 disclosure VERBATIM in `boundaries[]`
 * when the response carries at least one finding. The skill must
 * surface it.
 *
 * Implementation notes:
 *   - The tool inspects every `ApexClass` / `ApexTrigger` node; both
 *     emit CRUD/FLS findings (a trigger that does DML on
 *     `Trigger.new` records is the textbook case).
 *   - `limit` defaults to 100 and is capped at 500 by Zod. The slice
 *     is over CLASSES, not individual findings — a single class with
 *     8 missing-FLS-check findings counts as 1 entry in the budget.
 *   - The sort is per-class id ASC; per-finding ordering inside a
 *     class follows the recognizer's source-position sort.
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

import { partitionByBaseline } from './finding-suppression.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { clampedNodeScanLimit, scanTruncationNote } from './scan-cap.js';

const CRUD_FLS_TOOL = 'sfi.crud_fls_audit';

/** Inclusive upper bound on `limit`. */
const CRUD_FLS_MAX_LIMIT = 500;
/** Default `limit`. */
const CRUD_FLS_DEFAULT_LIMIT = 100;

/** The two rule ids in the CRUD/FLS subset. */
const CRUD_FLS_RULES: ReadonlySet<string> = new Set([
  'missing-crud-check',
  'missing-fls-check',
]);

/** ComponentTypes the CRUD/FLS recognizer fires on. */
const SCANNED_TYPES: readonly ComponentType[] = [
  'ApexClass',
  'ApexTrigger',
];

type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

const SEVERITY_SET: ReadonlySet<string> = new Set([
  'critical',
  'high',
  'medium',
  'low',
  'info',
]);

/**
 * Q80 verbatim disclosure (per ApexQualitySemantics.md §§ 6-7). The
 * CRUD/FLS recognizer has a HIGH false-positive rate because custom
 * security utility methods are invisible. Surfaced verbatim in
 * `boundaries[]` when at least one finding is returned.
 */
const Q80_FALSE_POSITIVE_DISCLOSURE =
  'custom security utility methods are invisible to the recognizer; this finding may be a false positive if your org uses a helper like SecurityUtils.canCreate(account). The recognizer recognizes only the standard Schema.sObjectType.X.is{Createable|Updateable|Deletable|Accessible}() patterns and WITH SECURITY_ENFORCED / USER_MODE clauses.';

/** Cross-method dataflow boundary. */
const CROSS_METHOD_DATAFLOW_DISCLOSURE =
  'cross-method dataflow is invisible — a method that delegates the dangerous operation to a helper is analyzed in isolation; the helper behavior is invisible. Spot-check the call chain before treating a finding as a bug.';

/** Dynamic SOQL boundary. */
const DYNAMIC_SOQL_DISCLOSURE =
  'dynamic SOQL (Database.query) strings are stripped before pattern passes; the embedded SQL is invisible to the FLS recognizer.';

/**
 * Zod schema for the `sfi.crud_fls_audit` tool input.
 *
 *   - `limit`: optional integer in `[1, 500]`. Defaults to 100 in
 *     the handler. The slice is over classes, not findings.
 *   - `offset`: optional integer (>= 0); defaults to 0. Class-level page
 *     cursor for walking the full audit when a response is `truncated` —
 *     advance by `nextOffset`.
 */
export const crudFlsAuditInputSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(CRUD_FLS_MAX_LIMIT)
    .optional(),
  offset: z.number().int().min(0).optional(),
  // CR-22 continuation cursor: opaque token from a prior truncated page's
  // nextCursor; supplies the resume offset. Omit for today's behavior.
  cursor: z.string().min(1).optional(),
});

/** Parsed input shape. */
export type CrudFlsAuditInput = z.infer<typeof crudFlsAuditInputSchema>;

/** One finding inside a per-class entry. */
export interface CrudFlsAuditFinding {
  readonly rule: 'missing-crud-check' | 'missing-fls-check';
  readonly severity: Severity;
  readonly location: string;
  readonly explanation: string;
}

/** One per-class entry. */
export interface CrudFlsAuditClassEntry {
  readonly componentId: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  readonly findings: readonly CrudFlsAuditFinding[];
  /**
   * Set only when this single class's findings alone exceeded the response
   * byte budget and were trimmed (pathological). The class's true finding
   * count is still reflected in the top-level `totalFindingCount`.
   */
  readonly findingsTruncated?: boolean;
}

/** Output payload. */
export interface CrudFlsAuditOutput {
  readonly classes: readonly CrudFlsAuditClassEntry[];
  /** Per-class entry count BEFORE the `limit` slice. */
  readonly totalClassCount: number;
  /** Total findings across all classes (FULL, pre-slice). */
  readonly totalFindingCount: number;
  /** Findings acknowledged in org-kb/meta/baseline.json (excluded from classes). */
  readonly suppressedFindingCount: number;
  /** Per-rule counter across the FULL matched set. */
  readonly byRule: Readonly<Record<string, number>>;
  /** Verbatim Q80 + dataflow + dynamic-SOQL disclosures. */
  readonly boundaries: readonly string[];
  /** Page size applied to this response (echoes the request; default 100). */
  readonly limit: number;
  /** Zero-based offset of the first returned class in the sorted set. */
  readonly offset: number;
  /** True when more classes exist beyond this response's slice. */
  readonly truncated: boolean;
  /**
   * Offset to pass on the next call to fetch the following page of classes.
   * Present only when `truncated`.
   */
  readonly nextOffset?: number;
  /**
   * CR-22 opaque continuation token, present ONLY when this page is truncated
   * (more classes remain — over `limit` OR byte-trimmed). Echo it back as
   * `cursor` to resume. Absent on a complete page so an in-budget response is
   * byte-identical to the pre-CR-22 shape.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
  /**
   * Set when the class page was byte-trimmed below the global ~45 KB response
   * limit (fewer classes than `limit` despite more matching). Names the trim
   * and how to advance.
   */
  readonly note?: string;
}

/**
 * Per-response byte budget for the `classes` array. Sits below the global
 * `MAX_RESPONSE_BYTES` (~45 KB) dispatch guard with headroom for the summary
 * counters, `boundaries` disclosures, the envelope, and pagination fields, so
 * a default-`limit` page can never trip that guard (which would reject the
 * whole result outright).
 */
const CRUD_FLS_PAYLOAD_BUDGET_BYTES = 36_000;

/**
 * Byte-trim a single oversized class's findings so the enumeration still
 * answers. Pathological — only reached when ONE class's findings alone exceed
 * the whole budget. Flags `findingsTruncated`; `totalFindingCount` still
 * carries the true count.
 */
const trimEntryFindings = (
  entry: CrudFlsAuditClassEntry,
  budgetBytes: number,
): CrudFlsAuditClassEntry => {
  const kept: CrudFlsAuditFinding[] = [];
  let used = Buffer.byteLength(
    JSON.stringify({ ...entry, findings: [] as CrudFlsAuditFinding[] }),
    'utf8',
  );
  for (const finding of entry.findings) {
    const size = Buffer.byteLength(JSON.stringify(finding), 'utf8') + 1;
    if (kept.length > 0 && used + size > budgetBytes) break;
    kept.push(finding);
    used += size;
  }
  return { ...entry, findings: kept, findingsTruncated: true };
};

/**
 * NOTE: the per-page class byte-trim is now done by the shared `paginate()`
 * pager (CR-22). `trimEntryFindings` is still used directly as the pager's
 * `slimItem` forward-progress hook so a single oversized class has its nested
 * `findings` trimmed (and `findingsTruncated` flagged) — behaviorally identical
 * to the previous open-coded `fitClassesToBudget`.
 */

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

/** Comparator for the per-class slice: id ASC. */
const compareClassById = (
  a: CrudFlsAuditClassEntry,
  b: CrudFlsAuditClassEntry,
): number =>
  a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0;

/**
 * The `sfi.crud_fls_audit` MCP tool. Composes over the v2.1
 * `qualityIssues` property mirror for ApexClass / ApexTrigger nodes
 * and narrows to the two CRUD/FLS rules. See the module JSDoc for
 * the Q80 verbatim false-positive disclosure surfaced in
 * `boundaries[]`.
 *
 * @example
 *   const r = await crudFlsAuditHandler(ctx, {});
 *   if (r.ok) console.log(r.value.data.totalFindingCount);
 */
export const crudFlsAuditHandler = async (
  ctx: Context,
  input: CrudFlsAuditInput,
): Promise<Result<McpResponse<CrudFlsAuditOutput>, McpError>> => {
  const limit = input.limit ?? CRUD_FLS_DEFAULT_LIMIT;

  const perClass = new Map<ComponentId, CrudFlsAuditClassEntry>();
  const byRule: Record<string, number> = {};
  let totalFindingCount = 0;
  let suppressedFindingCount = 0;

  // CR-22 B3: scan EVERY ApexClass / ApexTrigger by paging the SQL OFFSET
  // forward (window-by-window at the clamped cap) so unchecked-CRUD/FLS classes
  // on node 501+ are reachable — the single capped page used to drop the scan
  // TAIL silently. The output `classes` is then the COMPLETE list, paged by the
  // existing output cursor below; the scan completes inside this call.
  const scan = await scanAllNodesOfTypes(ctx.graph, SCANNED_TYPES);
  if (!scan.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${scan.error.message}` });
  }
  for (const node of scan.value.nodes) {
    const raw = (node as Node).properties['qualityIssues'];
    if (!Array.isArray(raw)) continue;
    const findings: CrudFlsAuditFinding[] = [];
    for (const rawIssue of raw) {
      const issue = coerceIssue(rawIssue);
      if (issue === null) continue;
      if (!CRUD_FLS_RULES.has(issue.rule)) continue;
      findings.push({
        rule: issue.rule as 'missing-crud-check' | 'missing-fls-check',
        severity: issue.severity,
        location: issue.location,
        explanation: issue.explanation,
      });
    }
    const partitioned = await partitionByBaseline(
      ctx,
      CRUD_FLS_TOOL,
      node.id,
      findings,
    );
    suppressedFindingCount += partitioned.suppressedCount;
    for (const issue of partitioned.active) {
      byRule[issue.rule] = (byRule[issue.rule] ?? 0) + 1;
      totalFindingCount += 1;
    }
    if (partitioned.active.length === 0) continue;
    perClass.set(node.id, {
      componentId: node.id,
      type: node.type,
      apiName: node.apiName,
      findings: [...partitioned.active],
    });
  }

  const classes = [...perClass.values()].sort(compareClassById);

  // CR-22: resolve the resume offset (echoed cursor wins over explicit offset);
  // crud_fls_audit has no narrowing args beyond paging, so the fingerprint is
  // over the empty arg set — a stale token (different tool / refreshed vault)
  // is still rejected via the tool+vaultHash bind-check.
  const fingerprint = argsFingerprint({});
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: 'sfi.crud_fls_audit',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  // The pre-byte-trim window size feeds the byte-identical note (`X of Y
  // classes`). `paginate()` applies the SAME largest-prefix byte-trim the
  // handler used to open-code (verified equivalent kept-set), and the
  // `slimItem` hook reuses `trimEntryFindings` so a single oversized class has
  // its nested `findings` trimmed (and `findingsTruncated` flagged) exactly as
  // before.
  const windowSize = classes.slice(offset, offset + limit).length;
  const paged = paginateLegacy(classes, {
    offset,
    limit,
    byteBudget: CRUD_FLS_PAYLOAD_BUDGET_BYTES,
    slimItem: (entry) => trimEntryFindings(entry, CRUD_FLS_PAYLOAD_BUDGET_BYTES),
    binding: {
      tool: 'sfi.crud_fls_audit',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const kept = paged.items;
  const trimmed = paged.byteTrimmed;
  const truncated = paged.hasMore;
  const emitCursor = paged.nextCursor !== null;

  const boundaries: string[] =
    classes.length === 0
      ? []
      : [
          Q80_FALSE_POSITIVE_DISCLOSURE,
          CROSS_METHOD_DATAFLOW_DISCLOSURE,
          DYNAMIC_SOQL_DISCLOSURE,
        ];

  // Residual scan-incompleteness only fires for a PATHOLOGICAL type past
  // FULL_SCAN_MAX_NODES — the normal full multi-window scan reaches node 501+
  // and completes. Lives OUTSIDE the zero-findings gate because risky classes
  // could be among the unscanned residual tail. (`truncated` is the OUTPUT
  // offset/limit cursor; this is the INPUT-scan saturation, a separate axis.)
  if (scan.value.scanIncomplete) {
    boundaries.push(
      scanTruncationNote(scan.value.incompleteTypes, clampedNodeScanLimit()),
    );
  }

  return ok({
    data: {
      classes: kept,
      totalClassCount: classes.length,
      totalFindingCount,
      suppressedFindingCount,
      byRule,
      boundaries,
      limit,
      offset,
      truncated,
      ...(truncated ? { nextOffset: offset + kept.length } : {}),
      ...(emitCursor ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo } : {}),
      ...(trimmed
        ? {
            note:
              `Response trimmed to ${kept.length} of ${windowSize} classes ` +
              `(${classes.length} total) to stay under the ~45 KB MCP ` +
              `response limit. Advance with offset += ${kept.length} for the rest.`,
          }
        : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
