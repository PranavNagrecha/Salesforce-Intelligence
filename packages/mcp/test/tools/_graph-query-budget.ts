/// <reference types="vitest/globals" />

/**
 * Shared query-count budget harness for the N+1 regression guard (finding C-1).
 *
 * A whole class of MCP tools used to issue one DuckDB round-trip PER item in a
 * loop (`await getNodeById` / `await listEdges` inside a `for`), which turned a
 * hub object or a whole-type scan into thousands of serial queries. Those loops
 * were routed through the batched primitives `listNodesByIds` /
 * `listEdgesForNodes` (`packages/graph/src/queries.ts`) so a batch issues O(1)
 * queries regardless of item count.
 *
 * `measureGraphQueries` is the deterministic, in-gate guard that keeps the class
 * from re-entering: it counts the DuckDB round-trips a handler issues against a
 * caller-seeded store, partitioned by table, so a fixture with N ≫ budget items
 * makes a reintroduced per-item loop (~N queries) fail hard while a correct
 * batch stays a small constant. No live org, no wall-clock flakiness — the
 * synthetic fixture makes N controllable and the assertion deterministic.
 *
 * This generalizes the copy-pasted `vi.spyOn(store.connection, 'runAndReadAll')`
 * spy that first shipped inline in `synthesis-reports.test.ts` /
 * `unused-components.test.ts` / `unused-fields-deep.test.ts` /
 * `pii-inventory.test.ts` (commit `5d5ca02` and neighbors).
 */

import type { GraphStore } from '@sf-intelligence/graph';

/**
 * Run `run()` while spying on the store's DuckDB connection and return its
 * result plus the number of round-trips that touched the `edges` / `nodes`
 * tables. The SQL-substring filters mirror the batched primitives' emitted SQL
 * (`SELECT ... FROM edges ...`, `SELECT ... FROM nodes ...`).
 *
 * @example
 *   const { result, edgeQueries, nodeQueries } = await measureGraphQueries(
 *     store,
 *     () => someHandler(ctx, { limit: 500 }),
 *   );
 *   expect(edgeQueries + nodeQueries).toBeLessThanOrEqual(4);
 */
export async function measureGraphQueries<T>(
  store: GraphStore,
  run: () => Promise<T>,
): Promise<{ result: T; edgeQueries: number; nodeQueries: number }> {
  const spy = vi.spyOn(store.connection, 'runAndReadAll');
  const result = await run();
  const sqls = spy.mock.calls.map(([sql]) => String(sql));
  spy.mockRestore();
  return {
    result,
    edgeQueries: sqls.filter((s) => s.includes('FROM edges')).length,
    nodeQueries: sqls.filter((s) => s.includes('FROM nodes')).length,
  };
}

/**
 * A tool under the standing query-budget contract.
 *
 * `class`:
 *   - `'constant'` — a constant-fan-out tool: `edgeQueries + nodeQueries` must
 *     stay at or below a small K (default 4) independent of item count.
 *   - `'bfs'` — a depth-bounded BFS/transitive tool: the count is bounded by
 *     `MAX_DEPTH * edgeTypeCount + C`, must NOT scale with frontier WIDTH, and
 *     the converted handler additionally carries a golden-output assertion.
 *
 * `testFile` is the `packages/mcp/test/tools/` basename that owns the assertion;
 * the coverage test (`_graph-query-budget.test.ts`) fails if that file lacks a
 * query-count guard, making the budget a standing contract rather than a set of
 * easily-deleted unit tests.
 */
export interface QueryBudgetTool {
  readonly testFile: string;
  readonly class: 'constant' | 'bfs';
  /** Short note for auditors — e.g. what the loop used to range over. */
  readonly note?: string;
}

/**
 * Roster of tools whose per-item DB loops were batched under finding C-1, plus
 * the already-fixed reference tools. Every entry MUST have a query-count guard
 * in its `testFile` (verified by `_graph-query-budget.test.ts`). Add a row when
 * routing a new loop through the batched primitives.
 */
export const QUERY_BUDGET_TOOLS: Readonly<Record<string, QueryBudgetTool>> =
  Object.freeze({
    // --- Already-fixed reference tools (inline spy predates this helper). ---
    'sfi.org_risk_report': {
      testFile: 'synthesis-reports.test.ts',
      class: 'constant',
      note: 'analyzeOverPrivilege grantedBy scan (reference fix 5d5ca02)',
    },
    'sfi.unused_components': {
      testFile: 'unused-components.test.ts',
      class: 'constant',
      note: 'per-type reference-edge scan (d7a3b8f)',
    },
    'sfi.unused_fields_deep': {
      testFile: 'unused-fields-deep.test.ts',
      class: 'constant',
      note: 'per-field reference scan (d7a3b8f)',
    },
    'sfi.pii_inventory': {
      testFile: 'pii-inventory.test.ts',
      class: 'constant',
      note: 'per-field node+edge scan (d7a3b8f)',
    },
    // --- Converted under finding C-1 (this branch). Registered per-unit. ---
    'sfi.find_dependency_cycles': {
      testFile: 'find-dependency-cycles.test.ts',
      class: 'constant',
      note: 'buildAdjacency callsApex scan over ALL Apex ids',
    },
    'sfi.order_of_execution': {
      testFile: 'order-of-execution.test.ts',
      class: 'constant',
      note: 'firer resolution + async dispatch + flow partition over object fan-out',
    },
    'sfi.what_happens_on_save': {
      testFile: 'what-happens-on-save.test.ts',
      class: 'constant',
      note: 'mirror of order_of_execution',
    },
    'sfi.automation_build_advisor': {
      testFile: 'automation-build-advisor.test.ts',
      class: 'constant',
      note: 'perObjectHandler triggersOn sources + parented ValidationRules',
    },
    'sfi.object_access_audit': {
      testFile: 'object-access-audit.test.ts',
      class: 'constant',
      note: 'grantor resolution over inbound grantedBy edges',
    },
    'sfi.explain_flow': {
      testFile: 'explain-flow.test.ts',
      class: 'constant',
      note: 'trigger-condition / action-call / subflow-call edge-target resolution',
    },
    'sfi.what_if_make_field_required': {
      testFile: 'what-if-make-field-required.test.ts',
      class: 'constant',
      note: 'fieldPopulators writesTo sources + ListView reference walk',
    },
    'sfi.what_if_deactivate_flow': {
      testFile: 'what-if-deactivate-flow.test.ts',
      class: 'constant',
      note: 'outgoing-impact walk + firing conditions + broken callers + platform-event subscribers',
    },
    'sfi.why_cant_user_see_record': {
      testFile: 'why-cant-user-see-record.test.ts',
      class: 'constant',
      note: 'container/granter resolution, sharing rules, owner-rule sharedWith walk',
    },
    'sfi.async_chain_depth': {
      testFile: 'async-chain-depth.test.ts',
      class: 'bfs',
      note: 'walkDispatchesAsync BFS — one listEdgesForNodes per depth level',
    },
    'sfi.tests_for_change': {
      testFile: 'tests-for-change.test.ts',
      class: 'bfs',
      note: 'upstreamWalk BFS — one listEdgesForNodes (both coverage edge types) per depth',
    },
    'sfi.downstream_effects': {
      testFile: 'downstream-effects.test.ts',
      class: 'bfs',
      note: 'reachability BFS per depth + closure effects batch + automation/apiName batches',
    },
    'sfi.event_subscribers': {
      testFile: 'event-subscribers.test.ts',
      class: 'constant',
      note: 'catalog listensTo/writesTo batches + single-event subscriber/publisher/channel batches',
    },
    // --- Finding #6a: two N+1 tools MISSED by the initial C-1 sweep. ---
    'sfi.call_graph': {
      testFile: 'call-graph.test.ts',
      class: 'bfs',
      note: 'walkOneDirection callsApex BFS (one listEdgesForNodes per depth × direction) + resolveNodes listNodesByIds resolve',
    },
    'sfi.method_reachability': {
      testFile: 'method-reachability.test.ts',
      class: 'bfs',
      note: 'upstreamWalk callsApex BFS (one listEdgesForNodes per depth) + per-discovered-node classifier listNodesByIds resolve',
    },
  });
