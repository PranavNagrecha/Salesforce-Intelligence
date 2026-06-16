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
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { partitionByBaseline } from './finding-suppression.js';

const CRUD_FLS_TOOL = 'sfi.crud_fls_audit';

/** Inclusive upper bound on `limit`. */
const CRUD_FLS_MAX_LIMIT = 500;
/** Default `limit`. */
const CRUD_FLS_DEFAULT_LIMIT = 100;
/** Per-type cap matching `listNodesByType`'s default. */
const LIST_PAGE_SIZE = 500;

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
 * Trim a class page to the largest sort-ordered prefix whose serialized size
 * fits `budgetBytes`. A fixed `limit` cannot bound bytes — a class with many
 * findings is large — so only a byte budget guarantees the response clears the
 * global guard. Always keeps at least one class (byte-trimming its findings if
 * that single class is itself oversized).
 */
const fitClassesToBudget = (
  classes: readonly CrudFlsAuditClassEntry[],
  budgetBytes: number,
): {
  readonly kept: readonly CrudFlsAuditClassEntry[];
  readonly trimmed: boolean;
} => {
  const kept: CrudFlsAuditClassEntry[] = [];
  let used = 0;
  for (const entry of classes) {
    const size = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
    if (kept.length === 0 && size > budgetBytes) {
      kept.push(trimEntryFindings(entry, budgetBytes));
      return { kept, trimmed: true };
    }
    if (kept.length > 0 && used + size > budgetBytes) {
      return { kept, trimmed: true };
    }
    kept.push(entry);
    used += size;
  }
  return { kept, trimmed: false };
};

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

  for (const type of SCANNED_TYPES) {
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
  }

  const classes = [...perClass.values()].sort(compareClassById);
  const offset = input.offset ?? 0;
  const page = classes.slice(offset, offset + limit);
  const { kept, trimmed } = fitClassesToBudget(
    page,
    CRUD_FLS_PAYLOAD_BUDGET_BYTES,
  );
  const returnedEnd = offset + kept.length;
  const truncated = returnedEnd < classes.length;

  const boundaries: string[] =
    classes.length === 0
      ? []
      : [
          Q80_FALSE_POSITIVE_DISCLOSURE,
          CROSS_METHOD_DATAFLOW_DISCLOSURE,
          DYNAMIC_SOQL_DISCLOSURE,
        ];

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
      ...(truncated ? { nextOffset: returnedEnd } : {}),
      ...(trimmed
        ? {
            note:
              `Response trimmed to ${kept.length} of ${page.length} classes ` +
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
