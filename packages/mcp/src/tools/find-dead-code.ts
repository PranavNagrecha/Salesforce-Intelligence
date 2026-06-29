/**
 * Handler for the `sfi.find_dead_code` MCP tool.
 *
 * The v2.2 cross-cutting dead-code surface — composes v2.7's
 * `method_reachability` verdict, entry-point taxonomy, zero-usage
 * classes, and unused CustomField (no incoming edges) into a single
 * cascade verdict per candidate. Answers "what code in this org has
 * no callers?".
 *
 * **Three verdicts:**
 *
 *   - `definitely_dead`: an ApexClass / ApexTrigger with ZERO incoming
 *     USAGE edges (no callers, no triggers, no listeners). For
 *     CustomField, no incoming references at all (no formula refs, no
 *     Apex reads/writes, no Flow record-ops, no layout placements).
 *     For a Flow, ONLY when its status is `Obsolete` / `InvalidDraft`
 *     (R2-12): an Active / Draft / unknown-status Flow is NEVER
 *     definitely_dead — Flow edges are all OUTGOING (triggersOn /
 *     listensTo / callsApex / writesTo), so a live flow has ~0 incoming
 *     edges by nature and fires on its own trigger; flagging it dead
 *     would delete running automation. `parentOf` (structural) and
 *     `grantedBy` (Profile / PermissionSet access grants) are NOT usage
 *     and do not keep a component alive — access is not usage, the same
 *     split the field / what-if tools make.
 *   - `likely_dead`: a code component reached only by test classes
 *     (`isTest === true`) or via heuristic-only edges that may be
 *     stripped by dynamic SOQL / reflective access. The v2.7
 *     `method_reachability` `test-only-reachable` verdict cascades
 *     here.
 *   - `uncertain`: reached by at least one entry point (REST resource,
 *     AuraEnabled, InvocableMethod, Queueable, Batchable, Schedulable,
 *     or ApexTrigger) — OR an Active / Draft / unknown-status Flow,
 *     which is its OWN entry point (R2-12). Surfaced for completeness in
 *     the result set when `includeUncertain: true`; suppressed by
 *     default.
 *
 * **Entry-point taxonomy** (matches `method-reachability.ts`):
 *   - `ApexTrigger`: triggers ARE entry points.
 *   - `ApexClass` with `isRestResource: true`.
 *   - `ApexClass` with `hasAuraEnabledMethod: true`.
 *   - `ApexClass` with `hasInvocableMethod: true`.
 *   - `ApexClass` with `isQueueable: true` / `isBatchable: true` /
 *     `isSchedulable: true`.
 *
 * **Filter by type:** optional `types` narrows the dead-code scan to
 * one or more ComponentTypes. Default is `['ApexClass', 'ApexTrigger',
 * 'Flow', 'CustomField']` — the four scope-relevant types.
 *
 * **Honesty axis (v2.7 inherited):** dynamic dispatch
 * (`Type.forName(...)`), reflective invocation, framework wiring
 * (TriggerHandler / fflib base classes), and managed-package callers
 * are INVISIBLE to the graph edges this tool walks. A class genuinely
 * invoked at runtime via one of these mechanisms will surface as
 * `definitely_dead` or `likely_dead`. The `boundaries` array surfaces
 * the verbatim disclosure.
 *
 * **Performance (v3.2):** the original implementation issued one
 * `listEdges` plus one `getNodeById` per incoming edge — an N+1
 * pattern that ran ~14000 SQL queries on the Acme fixture
 * (1539 candidates, ~12600 referrer-lookups). v3.2 collapses the
 * cascade into a single CTE that LEFT JOINs candidates to incoming
 * edges and referrers in one round-trip, pushing the entry-point
 * and `isTest` classification into SQL via DuckDB's
 * `json_extract_string`. The result is logically identical to the
 * per-node walk but executes in ~500ms on Acme (down from ~3700ms,
 * a ~7x speedup) and scales linearly with edge count rather than
 * per-edge round-trip cost.
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import type { GraphStore } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { buildCoverageCaveat, type CoverageCaveat } from './coverage-trust.js';
import {
  mergeInputAliases,
  resolveObjectScopeParentId,
  toCustomObjectId,
} from './input-aliases.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import { REPORT_DASHBOARD_USAGE_CAVEAT } from './report-dashboard-usage.js';
import { soundnessFromIds, type Soundness } from './soundness.js';

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

const FIND_DEAD_CODE_TOOL = 'sfi.find_dead_code';

const DEAD_CODE_DISCLOSURE =
  'dead-code detection is heuristic: dynamic dispatch (`Type.forName(...)`), reflective invocation, framework wiring (TriggerHandler / fflib base classes), and managed-package callers are invisible to the graph edges this tool walks. A class genuinely invoked at runtime via one of these mechanisms will surface as `definitely_dead` or `likely_dead`. Verify before deleting.';
const TEST_DISCLOSURE =
  'test classes (properties.isTest === true) are NEVER flagged as dead — they ARE entry points for the test-runner.';
const MANAGED_PACKAGE_DISCLOSURE =
  'managed-package code is not vaulted; callers from managed packages are invisible. A class only called by managed-package code will surface as dead.';
const FLOW_DISCLOSURE =
  'Flow dead-detection (R2-12): a Flow is flagged definitely_dead ONLY when its status is Obsolete or InvalidDraft. An Active, Draft, or unknown-status Flow is NEVER definitely_dead — Flow graph edges are all OUTGOING (triggersOn / listensTo / callsApex / writesTo), so a live flow has ~0 incoming edges by nature and fires on its own trigger/schedule; it surfaces as `uncertain` (suppressed unless includeUncertain). Note: subflow invocation (flow-calls-flow) is NOT modeled, so a subflow-only flow is treated as in-use via its active status, not via an invocation edge — verify a flow before deleting it.';
const CUSTOM_FIELD_DISCLOSURE =
  'CustomField dead-detection: Apex field reads/writes (incl. field-level SOQL in constant strings) are PARSED graph edges on vaults refreshed at 0.1.9+, and Flow assignments, formula references, and layout placements are modeled — so a field referenced only in Apex/Flow no longer reads dead (permission grants stay EXCLUDED: access is not usage). REMAINING blind spots an absence verdict cannot rule out: Flow formula-TEXT references, report columns beyond the usage-ranked pull, list-view filters, DYNAMIC SOQL built at runtime, and reflective access. Cross-check with `sfi.field_360` or `sfi.find_field_anywhere` before deleting any field.';

/** Verdict cascade. */
export type DeadCodeVerdict =
  | 'definitely_dead'
  | 'likely_dead'
  | 'uncertain';

const findDeadCodeInputBaseSchema = z.object({
  objectId: z.string().min(1).optional(),
  objectApiName: z.string().min(1).optional(),
  types: z
    .array(
      z.enum([
        'ApexClass',
        'ApexTrigger',
        'Flow',
        'CustomField',
      ]),
    )
    .optional(),
  includeUncertain: z.boolean().optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  // CR-22: page cursor for walking the full candidate list when truncated.
  offset: z.number().int().min(0).optional(),
  cursor: z.string().min(1).optional(),
});

/** Zod schema for `sfi.find_dead_code`. */
export const findDeadCodeInputSchema = z.preprocess((raw) => {
  const merged = mergeInputAliases(raw, [
    { canonical: 'objectId', aliases: ['objectApiName'] },
  ]);
  if (merged !== null && typeof merged === 'object' && !Array.isArray(merged)) {
    const o = merged as Record<string, unknown>;
    const id = typeof o.objectId === 'string' ? o.objectId : '';
    if (id.length > 0 && !id.startsWith('CustomObject:')) {
      o.objectId = toCustomObjectId(id);
    }
  }
  return merged;
}, findDeadCodeInputBaseSchema);

/** Parsed input shape. */
export type FindDeadCodeInput = z.infer<typeof findDeadCodeInputSchema>;

/** One dead-code candidate in the response. */
export interface DeadCodeCandidate {
  readonly componentId: ComponentId;
  readonly componentType: ComponentType;
  readonly apiName: string;
  readonly verdict: DeadCodeVerdict;
  readonly incomingEdgeCount: number;
  readonly reachedByTestClassOnly: boolean;
  readonly isOwnEntryPoint: boolean;
  readonly reasoning: string;
  readonly confidence: 'heuristic';
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface FindDeadCodeOutput {
  readonly candidates: readonly DeadCodeCandidate[];
  readonly totalCount: number;
  readonly byVerdict: Readonly<{
    definitely_dead: number;
    likely_dead: number;
    uncertain: number;
  }>;
  readonly byType: Readonly<Record<string, number>>;
  readonly boundaries: readonly string[];
  readonly truncated: boolean;
  /**
   * Page size applied to this response. Present ONLY on a PAGED response
   * (`truncated` or a resumed `offset > 0`); omitted on a whole-fits no-cursor
   * call so that response stays byte-identical to the pre-CR-22 shape.
   */
  readonly limit?: number;
  /** Zero-based offset of the first returned candidate. Present only when paged (see `limit`). */
  readonly offset?: number;
  /** Offset to pass on the next call to fetch the following page. Present only when `truncated`. */
  readonly nextOffset?: number;
  /**
   * CR-22 opaque continuation token, present ONLY when this page is truncated
   * (more candidates remain). Echo it back as `cursor` to resume. Absent on a
   * complete page so an in-budget response is byte-identical to pre-CR-22.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
  /** Static-analysis blind spots: `complete: false` when a candidate class uses dynamic Apex. */
  readonly soundness: Soundness;
  /**
   * Present when a CALLER family this dead-code claim depends on has
   * incomplete coverage (errored retrieve, scoped refresh, or a staged build
   * whose tier has not reached it). "Dead" only means "no retrieved caller
   * references it" — an un-retrieved LWC's `@AuraEnabled` call would fake
   * death. Distinct from `soundness`, which covers dynamic-dispatch blind
   * spots WITHIN retrieved code.
   */
  readonly coverageCaveat?: CoverageCaveat;
}

/**
 * Caller families whose absence can FAKE a dead-code verdict: Apex entry
 * points are invoked from these surfaces, so incomplete coverage of any of
 * them must qualify the claim (P13-STAGED-absence-battery).
 */
const DEAD_CODE_REQUIRED_COVERAGE: readonly string[] = [
  'ApexClass',
  'ApexTrigger',
  'AuraDefinitionBundle',
  'FlexiPage',
  'Flow',
  'LightningComponentBundle',
  'QuickAction',
  'VisualforceComponent',
  'VisualforcePage',
];

const DEFAULT_TYPES: readonly ComponentType[] = [
  'ApexClass',
  'ApexTrigger',
  'Flow',
  'CustomField',
];

/**
 * One row returned by the dead-code CTE — a candidate plus the
 * aggregated counts/flags computed across its incoming non-parentOf
 * edges. The booleans collapse the per-edge JS-side cascade into
 * SQL-side aggregations: `incoming_count` is the total non-parentOf
 * in-degree; `has_non_test_reach` is true iff at least one referrer
 * is non-test (or the referrer node is missing entirely, mirroring
 * the original's sparse-graph fall-through); `has_entry_point_reach`
 * is true iff at least one non-test referrer is itself a recognized
 * entry-point class. `is_test` and `is_own_entry_point` describe the
 * candidate itself.
 */
interface DeadCodeRow {
  readonly id: string;
  readonly type: string;
  readonly api_name: string;
  readonly is_test: boolean;
  readonly is_own_entry_point: boolean;
  /** Flow only (R2-12): TRUE when the Flow's status is NOT Obsolete/InvalidDraft
   *  (active, Draft, or unknown/missing status — all treated as in-use). An
   *  active flow fires on its own trigger and has ~0 incoming edges by nature,
   *  so this guards against deleting live automation. FALSE for non-Flow. */
  readonly is_active_entry_point: boolean;
  readonly incoming_count: bigint | number;
  readonly has_non_test_reach: boolean;
  readonly has_entry_point_reach: boolean;
  /** CustomField only: folded `--with-reports` report/dashboard usage. A field
   *  used by a report column/filter or dashboard component is NOT dead even with
   *  zero incoming edges (the usage is a node property, not a graph edge). */
  readonly used_in_analytics: boolean;
}

/**
 * Run the single CTE that drives the v3.2 dead-code scan. Returns
 * one row per candidate in `types`, with the entry-point and
 * test-reach classifiers already aggregated SQL-side. Empty `types`
 * is handled at the caller boundary (`DEFAULT_TYPES` substitution),
 * so this helper assumes at least one type.
 *
 * The CTE shape:
 *   - `candidates` selects the requested types and resolves the
 *     candidate-level `is_test` / `is_own_entry_point` flags from
 *     `properties_json` via `json_extract_string` — no parse step,
 *     no JSON-vs-string ambiguity (DuckDB extracts JSON booleans as
 *     the strings `'true'` / `'false'`).
 *   - `incoming` LEFT JOINs every non-parentOf inbound edge against
 *     the referrer node, resolving the referrer's `from_is_test`
 *     and `from_is_entry` flags. `from_is_null` distinguishes
 *     orphan edges (referrer node deleted) from real referrers; the
 *     original walk treats them as non-test reach, which the
 *     outer aggregation preserves.
 *   - The outer SELECT LEFT JOINs candidates → incoming and
 *     aggregates: `COUNT(i.cid)` returns 0 for candidates with no
 *     incoming edges; `BOOL_OR` collapses the per-edge classifier
 *     to the per-candidate booleans the JS cascade consumes.
 */
const fetchDeadCodeRows = async (
  store: GraphStore,
  types: readonly ComponentType[],
  objectScopeParentId?: string,
): Promise<Result<readonly DeadCodeRow[], string>> => {
  const placeholders = types.map(() => '?').join(', ');
  const objectScopeClause =
    objectScopeParentId !== undefined
      ? `AND (type <> 'CustomField' OR parent_id = ?)`
      : '';
  const sql = `
    WITH candidates AS (
      SELECT id, type, api_name,
             COALESCE(
               type = 'ApexClass'
                 AND json_extract_string(properties_json, '$.isTest') = 'true',
               FALSE) AS is_test,
             COALESCE(
               type = 'ApexTrigger'
                 OR (type = 'ApexClass' AND (
                     COALESCE(json_extract_string(properties_json, '$.isRestResource') = 'true', FALSE)
                     OR COALESCE(json_extract_string(properties_json, '$.hasAuraEnabledMethod') = 'true', FALSE)
                     OR COALESCE(json_extract_string(properties_json, '$.hasInvocableMethod') = 'true', FALSE)
                     OR COALESCE(json_extract_string(properties_json, '$.isQueueable') = 'true', FALSE)
                     OR COALESCE(json_extract_string(properties_json, '$.isBatchable') = 'true', FALSE)
                     OR COALESCE(json_extract_string(properties_json, '$.isSchedulable') = 'true', FALSE)
                   )),
               FALSE) AS is_own_entry_point,
             -- Flow only (R2-12): a Flow is its OWN entry point when its status
             -- is NOT inactive. Flow edges are all OUTGOING (triggersOn /
             -- listensTo / callsApex / writesTo), so a live flow naturally has
             -- ~0 incoming edges — counting that as definitely_dead deletes
             -- running automation. Only Obsolete / InvalidDraft flows are dead.
             -- COALESCE the missing/NULL status to '' so an unknown-status flow
             -- PASSES the NOT IN test (=> TRUE => uncertain), NEVER falls
             -- through to incomingCount===0 => definitely_dead. Mirrors
             -- unused-components.ts isInactiveEntryPoint (unknown => in-use).
             COALESCE(
               type = 'Flow'
                 AND COALESCE(json_extract_string(properties_json, '$.status'), '')
                     NOT IN ('Obsolete', 'InvalidDraft'),
               FALSE) AS is_active_entry_point,
             -- CustomField only: folded report/dashboard usage (--with-reports).
             -- Stored as a node property (not an edge), so the in-degree count
             -- below can't see it; a report-only field would read as dead.
             COALESCE(
               type = 'CustomField' AND (
                 json_extract_string(properties_json, '$.usedInReport') = 'true'
                 OR json_extract_string(properties_json, '$.usedInDashboard') = 'true'
               ),
               FALSE) AS used_in_analytics
      FROM nodes
      WHERE type IN (${placeholders})
        -- Standard fields (api name has no __c suffix) are platform fields:
        -- not deletable and not "dead code". Only custom / managed-package
        -- fields (which end in __c) are valid CustomField dead-code candidates
        -- (NI-6: stops IsPartner/IsCustomerPortal/etc. being flagged dead).
        AND NOT (type = 'CustomField' AND api_name NOT LIKE '%\\_\\_c' ESCAPE '\\')
        ${objectScopeClause}
    ),
    incoming AS (
      SELECT e.to_id AS cid,
             COALESCE(
               r.type = 'ApexClass'
                 AND json_extract_string(r.properties_json, '$.isTest') = 'true',
               FALSE) AS from_is_test,
             COALESCE(
               r.type = 'ApexTrigger'
                 OR (r.type = 'ApexClass' AND (
                     COALESCE(json_extract_string(r.properties_json, '$.isRestResource') = 'true', FALSE)
                     OR COALESCE(json_extract_string(r.properties_json, '$.hasAuraEnabledMethod') = 'true', FALSE)
                     OR COALESCE(json_extract_string(r.properties_json, '$.hasInvocableMethod') = 'true', FALSE)
                     OR COALESCE(json_extract_string(r.properties_json, '$.isQueueable') = 'true', FALSE)
                     OR COALESCE(json_extract_string(r.properties_json, '$.isBatchable') = 'true', FALSE)
                     OR COALESCE(json_extract_string(r.properties_json, '$.isSchedulable') = 'true', FALSE)
                   )),
               FALSE) AS from_is_entry,
             r.id IS NULL AS from_is_null
      FROM edges e
      LEFT JOIN nodes r ON r.id = e.from_id
      WHERE e.to_id IN (SELECT id FROM candidates)
        AND e.edge_type <> 'parentOf'
        -- grantedBy = a Profile / PermissionSet ACCESS grant (Apex class access,
        -- field FLS). Access is not USAGE: a class nobody calls or a field
        -- nothing references is dead even when profiles grant access to it.
        -- Counting grants as reach hid test-only classes (reached only by their
        -- own test + profile grants) as uncertain, and kept grant-only-but-unused
        -- components out of definitely_dead. Same access-vs-usage split the
        -- field / what-if tools make.
        AND e.edge_type <> 'grantedBy'
    )
    SELECT c.id, c.type, c.api_name, c.is_test, c.is_own_entry_point,
           c.is_active_entry_point, c.used_in_analytics,
           COUNT(i.cid) AS incoming_count,
           COALESCE(BOOL_OR(i.from_is_null OR NOT i.from_is_test), FALSE) AS has_non_test_reach,
           COALESCE(BOOL_OR(NOT i.from_is_test AND i.from_is_entry), FALSE) AS has_entry_point_reach
    FROM candidates c
    LEFT JOIN incoming i ON i.cid = c.id
    GROUP BY c.id, c.type, c.api_name, c.is_test, c.is_own_entry_point, c.is_active_entry_point, c.used_in_analytics
  `;
  try {
    const params =
      objectScopeParentId !== undefined
        ? [...types, objectScopeParentId]
        : [...types];
    const reader = await store.connection.runAndReadAll(sql, params);
    const rows = reader.getRowObjectsJS() as unknown as readonly DeadCodeRow[];
    return ok(rows);
  } catch (e) {
    return err((e as Error).message);
  }
};

/**
 * Comparator: verdict rank ASC, componentType ASC, then componentId ASC.
 *
 * This is already a STRICT TOTAL order (CR-22): `componentId` is the node `id`
 * the dead-code CTE groups by (`GROUP BY c.id` — one row per distinct node id),
 * so every candidate has a unique componentId and the final key resolves all
 * ties uniquely. The earlier verdict / componentType keys only coarsen. No
 * additional tiebreak is required for a dup-free / skip-free offset resume.
 */
const compareCandidates = (
  a: DeadCodeCandidate,
  b: DeadCodeCandidate,
): number => {
  // Verdict order: definitely_dead first, then likely_dead, then uncertain.
  const verdictRank = (v: DeadCodeVerdict): number =>
    v === 'definitely_dead' ? 0 : v === 'likely_dead' ? 1 : 2;
  const av = verdictRank(a.verdict);
  const bv = verdictRank(b.verdict);
  if (av !== bv) return av - bv;
  if (a.componentType !== b.componentType)
    return a.componentType < b.componentType ? -1 : 1;
  return a.componentId < b.componentId ? -1 : 1;
};

/**
 * The `sfi.find_dead_code` MCP tool. Scans the requested ComponentTypes
 * for components with zero non-parentOf incoming edges (definitely
 * dead), test-only reach (likely dead), or entry-point reach
 * (uncertain). Test classes and own-entry-point classes are excluded
 * from the dead set.
 *
 * @example
 *   const r = await findDeadCodeHandler(ctx, {});
 *   if (r.ok) console.log(r.value.data.byVerdict.definitely_dead);
 */
export const findDeadCodeHandler = async (
  ctx: Context,
  input: FindDeadCodeInput,
): Promise<Result<McpResponse<FindDeadCodeOutput>, McpError>> => {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const includeUncertain = input.includeUncertain ?? false;
  const types =
    input.types !== undefined && input.types.length > 0
      ? input.types
      : DEFAULT_TYPES;
  const objectScopeParentId = resolveObjectScopeParentId(input);

  const rowsResult = await fetchDeadCodeRows(
    ctx.graph,
    types,
    objectScopeParentId,
  );
  if (!rowsResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${rowsResult.error}`,
    });
  }

  const candidates: DeadCodeCandidate[] = [];
  for (const row of rowsResult.value) {
    // Tests are NEVER flagged as dead.
    if (row.is_test) continue;
    // A CustomField used by a report column/filter or dashboard component is in
    // use, even with zero incoming edges — its usage is a folded node property,
    // not a graph edge (only present when refreshed with `--with-reports`).
    // Excluding it here matches `unused_fields_deep` / `safe_to_delete_field`.
    if (row.type === 'CustomField' && row.used_in_analytics) continue;

    const ownEntryPoint = row.is_own_entry_point;
    // The SQL CTE COALESCEs both aggregates and the per-row entry-point
    // flag to FALSE so zero-row aggregations and missing-property nodes
    // both surface as actual booleans rather than nulls.
    const hasNonTestReach = row.has_non_test_reach;
    const hasEntryPointReach = row.has_entry_point_reach;
    // DuckDB returns COUNT as bigint; the v3.2 caller compares
    // against zero and surfaces the value as a number in the
    // candidate payload, so the cast is safe (no overflow risk for
    // in-degree counts).
    const incomingCount = Number(row.incoming_count);

    let verdict: DeadCodeVerdict;
    let reasoning: string;
    if (row.is_active_entry_point) {
      // R2-12: an active/Draft/unknown-status Flow is its OWN entry point — it
      // fires on its own trigger/schedule and has ~0 incoming edges by nature.
      // Treat exactly like an own-entry-point Apex class: `uncertain`,
      // suppressed unless includeUncertain. NEVER definitely_dead/likely_dead.
      // (Only Obsolete/InvalidDraft flows have is_active_entry_point=FALSE and
      // fall through to the incomingCount===0 => definitely_dead path.)
      verdict = 'uncertain';
      reasoning =
        'Flow fires on its own trigger and is active (or Draft/unknown status); not dead despite no incoming references';
    } else if (ownEntryPoint || hasEntryPointReach) {
      verdict = 'uncertain';
      reasoning = ownEntryPoint
        ? 'component is its own entry point (REST/Aura/Invocable/Queueable/Batchable/Schedulable or trigger); platform invokes it'
        : 'reached by an entry-point class (REST resource / AuraEnabled / InvocableMethod / async-dispatch)';
    } else if (incomingCount === 0) {
      verdict = 'definitely_dead';
      reasoning =
        'no incoming non-parentOf edges; no callers, no triggers, no listeners visible to the graph';
    } else if (!hasNonTestReach) {
      verdict = 'likely_dead';
      reasoning =
        'incoming edges only from test classes (isTest === true); not used in production paths visible to the graph';
    } else {
      verdict = 'uncertain';
      reasoning =
        'reached by non-test components but no recognized entry point';
    }

    if (verdict === 'uncertain' && !includeUncertain) continue;

    candidates.push({
      componentId: row.id as ComponentId,
      componentType: row.type as ComponentType,
      apiName: row.api_name,
      verdict,
      incomingEdgeCount: incomingCount,
      reachedByTestClassOnly: incomingCount > 0 && !hasNonTestReach,
      isOwnEntryPoint: ownEntryPoint,
      reasoning,
      confidence: 'heuristic',
    });
  }

  candidates.sort(compareCandidates);

  // CR-22: resolve the resume offset (echoed cursor wins over explicit offset).
  // The fingerprint covers every NARROWING arg — includeUncertain (it filters
  // which candidates are in the list, line below `verdict === 'uncertain'`), the
  // canonical objectId scope, and types — so a token minted for one narrowing
  // set can't be replayed against another.
  const fingerprint = argsFingerprint({
    ...(objectScopeParentId !== undefined
      ? { objectId: objectScopeParentId }
      : {}),
    types,
    includeUncertain,
  });
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: FIND_DEAD_CODE_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  const paged = paginateLegacy(candidates, {
    offset,
    limit,
    keyOf: (c) => c.componentId,
    binding: {
      tool: FIND_DEAD_CODE_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const slice = paged.items;
  const truncated = paged.hasMore;
  const emitCursor = paged.nextCursor !== null;
  // Paged when truncated OR resumed past 0; only then do we add paging fields,
  // so a whole-fits no-cursor response stays byte-identical to pre-CR-22.
  const isPaged = truncated || offset > 0;

  const byVerdict = {
    definitely_dead: 0,
    likely_dead: 0,
    uncertain: 0,
  };
  const byType: Record<string, number> = {};
  for (const c of candidates) {
    byVerdict[c.verdict] += 1;
    byType[c.componentType] = (byType[c.componentType] ?? 0) + 1;
  }

  const boundaries: string[] = [DEAD_CODE_DISCLOSURE];
  // R2-12: whenever Flow is in scope, disclose the status-gated Flow rule
  // (active/Draft/unknown flows are never definitely_dead) and the unmodeled
  // subflow-invocation caveat — surfaced regardless of whether any flow landed
  // in the (suppressed) result set, so the honesty is never silently dropped.
  if (types.includes('Flow' as ComponentType)) {
    boundaries.push(FLOW_DISCLOSURE);
  }
  if (candidates.length > 0) {
    boundaries.push(TEST_DISCLOSURE);
    boundaries.push(MANAGED_PACKAGE_DISCLOSURE);
  }
  // A CustomField flagged dead is the weakest verdict: Apex/Flow/SOQL field
  // reads are not graph edges, so an in-use field can surface as dead.
  if (
    candidates.some(
      (c) =>
        c.componentType === 'CustomField' &&
        (c.verdict === 'definitely_dead' || c.verdict === 'likely_dead'),
    )
  ) {
    boundaries.push(CUSTOM_FIELD_DISCLOSURE);
    boundaries.push(REPORT_DASHBOARD_USAGE_CAVEAT);
  }

  // A "dead" class that uses dynamic Apex may actually be reached reflectively
  // — flag those candidates as a static-analysis blind spot, never silently.
  const soundness = await soundnessFromIds(
    ctx.graph,
    candidates.map((c) => c.componentId),
  );

  // Dead-code is an absence claim about CALLERS: incomplete coverage of any
  // calling surface (errored retrieve, scoped refresh, mid-staged-build
  // pending tiers) must qualify the verdicts.
  const coverageCaveat = buildCoverageCaveat(
    ctx,
    DEAD_CODE_REQUIRED_COVERAGE,
    'Dead-code status',
  );

  return ok({
    data: {
      candidates: slice,
      totalCount: candidates.length,
      byVerdict,
      byType,
      boundaries,
      truncated,
      ...(isPaged ? { limit, offset } : {}),
      ...(truncated ? { nextOffset: offset + slice.length } : {}),
      ...(emitCursor
        ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo }
        : {}),
      soundness,
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
