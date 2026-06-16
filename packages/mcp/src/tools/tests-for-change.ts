/**
 * Handler for the `sfi.tests_for_change` MCP tool.
 *
 * Answers the developer's "given the Apex I changed, which tests must I
 * run?" — smart test selection (a.k.a. test-impact analysis). Generalises
 * `sfi.test_coverage_for_method` from ONE target to a CHANGE SET, and adds
 * the load-bearing inverse signal: which changed components have NO test
 * that reaches them (the unguarded changes — the actual risk).
 *
 * **Composition model** (per changed Apex component):
 *   1. Coerce each input to an `ApexClass:` / `ApexTrigger:` id
 *      (`coercePrefix`); a bare name becomes an `ApexClass:` id. Items that
 *      resolve to a different `Type:` prefix (a Flow id, a CustomField id)
 *      are NOT analysable here — they land in `unsupportedChanges` rather
 *      than failing the whole batch.
 *   2. `getNodeById` the target — a well-formed Apex id absent from the
 *      vault lands in `notFoundChanges` (again, no batch-wide failure).
 *   3. BFS upstream over INCOMING `callsApex` AND `dispatchesAsync` edges,
 *      depth-3 capped (matching `sfi.test_coverage_for_method`). Every
 *      reached node with `properties.isTest === true` is a covering test.
 *      Following `dispatchesAsync` catches tests that exercise a
 *      batch/queueable/schedulable class via async dispatch
 *      (`Database.executeBatch(new XBatch())`).
 *   4. A changed component that is ITSELF a test class is added to the
 *      selected set directly at depth 0 — you changed the test, so run it —
 *      and is never counted as "uncovered".
 *
 * The union of every covering test across the change set is the minimal set
 * to run. `uncoveredChanges` is the complementary risk surface: changed
 * non-test classes that no test reaches within the depth cap. Running only
 * the selected set will NOT exercise those — the disclosure says so loudly.
 *
 * **Honesty boundary (verbatim in `disclosure`)**: CLASS granularity (a
 * changed method on an otherwise-covered class still selects that class's
 * tests, even if no test exercises the specific method). Dynamic dispatch
 * (`Type.forName`) and reflective invocation are invisible — a test that
 * reaches the change only via reflection is missed. Managed-package test
 * classes are invisible. BFS is depth-3 capped; coverage chains longer than
 * 3 hops surface as uncovered even when they exist. When any change is
 * uncovered (or you suspect a deep chain), run the full suite.
 */

import type {
  ComponentId,
  EdgeType,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { coercePrefix } from './coerce-id.js';

/** BFS depth cap. Matches `sfi.test_coverage_for_method` / `sfi.method_reachability`. */
const TESTS_FOR_CHANGE_BFS_DEPTH = 3;

/**
 * Incoming edge types the upstream coverage walk follows — identical to
 * `sfi.test_coverage_for_method`. `callsApex` is direct invocation;
 * `dispatchesAsync` captures async dispatch a batch/queueable/schedulable
 * test exercises (`Database.executeBatch`, `System.enqueueJob`,
 * `System.schedule`), which links through `dispatchesAsync`, not `callsApex`.
 */
const COVERAGE_EDGE_TYPES: readonly EdgeType[] = ['callsApex', 'dispatchesAsync'];

/** Canonical id prefixes the tool analyses. */
const APEX_CLASS_PREFIX = 'ApexClass:';
const APEX_TRIGGER_PREFIX = 'ApexTrigger:';

/** Hard cap on the change-set size (matches `sfi.meaningful_test_audit`'s `classFilter`). */
const MAX_CHANGED_ITEMS = 500;

/** Verbatim honesty disclosure surfaced on every response. */
const TESTS_FOR_CHANGE_DISCLOSURE =
  'tests_for_change selects at CLASS granularity (a changed method on a covered class still selects that class’s tests; method-level resolution promised in v2.7.1). The upstream walk follows both callsApex and dispatchesAsync incoming edges, so coverage via async dispatch (Database.executeBatch, System.enqueueJob, System.schedule) is included. Dynamic dispatch (Type.forName) and reflective invocation are invisible — a test reaching the change only via reflection is missed. Managed-package test classes are invisible. BFS is capped at depth 3; coverage chains longer than 3 hops surface as uncovered even when they exist. A changed component in uncoveredChanges is UNGUARDED — running the selected set will NOT exercise it; run the full suite when any change is uncovered or you suspect a deep chain.';

/**
 * Zod schema for the `sfi.tests_for_change` tool input.
 *
 *   - `changedComponents`: 1..500 non-empty strings. Each is an
 *     `ApexClass:` / `ApexTrigger:` canonical id or a bare class name
 *     (coerced to an `ApexClass:` id). Non-Apex `Type:` prefixes are
 *     bucketed into `unsupportedChanges`, not rejected batch-wide.
 */
export const testsForChangeInputSchema = z.object({
  changedComponents: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_CHANGED_ITEMS),
});

/** Parsed input shape. */
export type TestsForChangeInput = z.infer<typeof testsForChangeInputSchema>;

/** One test class in the minimal selected set. */
export interface SelectedTest {
  readonly id: ComponentId;
  readonly apiName: string;
  /** Shallowest depth at which this test reaches ANY changed component (0 = the test itself was changed). */
  readonly minDepth: number;
  /** Which changed components this test exercises (sorted ASC). */
  readonly coversChanges: readonly ComponentId[];
}

/** A single covering-test reference under a per-change entry. */
export interface CoveringTestRef {
  readonly id: ComponentId;
  readonly apiName: string;
  readonly depth: number;
}

/** Coverage outcome for one analysed (existing, Apex) changed component. */
export interface PerChangeCoverage {
  readonly id: ComponentId;
  readonly apiName: string;
  /** True when the changed component is itself a test class. */
  readonly isTest: boolean;
  /** True when at least one test reaches it (or it is itself a test). */
  readonly covered: boolean;
  readonly coveringTests: readonly CoveringTestRef[];
}

/** An input that resolved to a non-Apex id — outside this tool's analysis. */
export interface UnsupportedChange {
  readonly input: string;
  readonly resolvedId: string;
  readonly reason: string;
}

/** A well-formed Apex id with no matching node in the vault. */
export interface NotFoundChange {
  readonly id: ComponentId;
}

/** Roll-up tallies across the full request. */
export interface TestsForChangeSummary {
  readonly changedInput: number;
  readonly apexAnalyzed: number;
  readonly selectedTestCount: number;
  readonly uncoveredCount: number;
  readonly unsupportedCount: number;
  readonly notFoundCount: number;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface TestsForChangeOutput {
  readonly selectedTests: readonly SelectedTest[];
  readonly perChange: readonly PerChangeCoverage[];
  /** Changed non-test Apex components no test reaches — the unguarded risk surface. */
  readonly uncoveredChanges: readonly ComponentId[];
  readonly unsupportedChanges: readonly UnsupportedChange[];
  readonly notFoundChanges: readonly NotFoundChange[];
  readonly summary: TestsForChangeSummary;
  readonly disclosure: string;
}

const isApexCallable = (id: string): boolean =>
  id.startsWith(APEX_CLASS_PREFIX) || id.startsWith(APEX_TRIGGER_PREFIX);

const isTestClass = (node: Node): boolean =>
  node.properties['isTest'] === true;

/**
 * BFS upstream from `targetId` over INCOMING coverage edges (`callsApex`
 * AND `dispatchesAsync`). Returns the depth at which each upstream id was
 * first discovered. Visited set is global to the walk; a node reachable via
 * both edge types is recorded once at its shortest depth.
 */
const upstreamWalk = async (
  ctx: Context,
  targetId: ComponentId,
  maxDepth: number,
): Promise<Result<Map<ComponentId, number>, string>> => {
  const discovered = new Map<ComponentId, number>();
  let frontier: ComponentId[] = [targetId];
  const visited = new Set<ComponentId>([targetId]);
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: ComponentId[] = [];
    for (const id of frontier) {
      for (const edgeType of COVERAGE_EDGE_TYPES) {
        const r = await listEdges(ctx.graph, id, { direction: 'in', edgeType });
        if (!r.ok) return err(r.error.message);
        for (const edge of r.value) {
          if (visited.has(edge.fromId)) continue;
          visited.add(edge.fromId);
          discovered.set(edge.fromId, depth + 1);
          next.push(edge.fromId);
        }
      }
    }
    frontier = next;
  }
  return ok(discovered);
};

const sortIds = (ids: readonly ComponentId[]): ComponentId[] =>
  [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * The `sfi.tests_for_change` MCP tool. Selects the minimal test set that
 * exercises a change set and surfaces the changed components no test
 * reaches.
 *
 * @example
 *   const r = await testsForChangeHandler(ctx, {
 *     changedComponents: ['ApexClass:OrderService', 'PricingEngine'],
 *   });
 *   if (r.ok) console.log(r.value.data.summary.selectedTestCount);
 */
export const testsForChangeHandler = async (
  ctx: Context,
  input: TestsForChangeInput,
): Promise<Result<McpResponse<TestsForChangeOutput>, McpError>> => {
  // Dedupe inputs after coercion so `Foo` and `ApexClass:Foo` collapse.
  const unsupportedChanges: UnsupportedChange[] = [];
  const apexTargets = new Map<ComponentId, string>(); // id -> original input (first seen)
  for (const raw of input.changedComponents) {
    const coerced = coercePrefix(raw, [APEX_CLASS_PREFIX, APEX_TRIGGER_PREFIX]);
    if (!isApexCallable(coerced)) {
      unsupportedChanges.push({
        input: raw,
        resolvedId: coerced,
        reason:
          'tests_for_change analyses ApexClass / ApexTrigger components only; this id is a different metadata type.',
      });
      continue;
    }
    if (!apexTargets.has(coerced as ComponentId)) {
      apexTargets.set(coerced as ComponentId, raw);
    }
  }

  // Per-id node cache so a test reached from several changed targets is
  // fetched once.
  const nodeCache = new Map<ComponentId, Node | null>();
  const loadNode = async (id: ComponentId): Promise<Result<Node | null, McpError>> => {
    const cached = nodeCache.get(id);
    if (cached !== undefined) return ok(cached);
    const r = await getNodeById(ctx.graph, id);
    if (!r.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${r.error.message}` });
    }
    nodeCache.set(id, r.value);
    return ok(r.value);
  };

  const notFoundChanges: NotFoundChange[] = [];
  const perChange: PerChangeCoverage[] = [];
  // testId -> { apiName, minDepth, coversChanges:Set }
  const selected = new Map<
    ComponentId,
    { apiName: string; minDepth: number; covers: Set<ComponentId> }
  >();
  const uncovered: ComponentId[] = [];

  const recordSelected = (
    test: Node,
    changeId: ComponentId,
    depth: number,
  ): void => {
    const existing = selected.get(test.id);
    if (existing === undefined) {
      selected.set(test.id, {
        apiName: test.apiName,
        minDepth: depth,
        covers: new Set([changeId]),
      });
      return;
    }
    existing.covers.add(changeId);
    if (depth < existing.minDepth) existing.minDepth = depth;
  };

  for (const [targetId] of apexTargets) {
    const targetRes = await loadNode(targetId);
    if (!targetRes.ok) return targetRes;
    const targetNode = targetRes.value;
    if (targetNode === null) {
      notFoundChanges.push({ id: targetId });
      continue;
    }

    // A changed test class: run it directly. It covers itself at depth 0 and
    // is never "uncovered".
    if (isTestClass(targetNode)) {
      recordSelected(targetNode, targetId, 0);
      perChange.push({
        id: targetId,
        apiName: targetNode.apiName,
        isTest: true,
        covered: true,
        coveringTests: [{ id: targetId, apiName: targetNode.apiName, depth: 0 }],
      });
      continue;
    }

    const walkRes = await upstreamWalk(ctx, targetId, TESTS_FOR_CHANGE_BFS_DEPTH);
    if (!walkRes.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${walkRes.error}` });
    }

    const coveringTests: CoveringTestRef[] = [];
    for (const [id, depth] of walkRes.value) {
      const r = await loadNode(id);
      if (!r.ok) return r;
      const node = r.value;
      if (node === null || !isTestClass(node)) continue;
      coveringTests.push({ id: node.id, apiName: node.apiName, depth });
      recordSelected(node, targetId, depth);
    }
    coveringTests.sort((a, b) =>
      a.depth !== b.depth ? a.depth - b.depth : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );

    const covered = coveringTests.length > 0;
    if (!covered) uncovered.push(targetId);
    perChange.push({
      id: targetId,
      apiName: targetNode.apiName,
      isTest: false,
      covered,
      coveringTests,
    });
  }

  const selectedTests: SelectedTest[] = [...selected.entries()].map(
    ([id, v]) => ({
      id,
      apiName: v.apiName,
      minDepth: v.minDepth,
      coversChanges: sortIds([...v.covers]),
    }),
  );
  selectedTests.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  perChange.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  notFoundChanges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  unsupportedChanges.sort((a, b) => (a.input < b.input ? -1 : a.input > b.input ? 1 : 0));
  const uncoveredChanges = sortIds(uncovered);

  return ok({
    data: {
      selectedTests,
      perChange,
      uncoveredChanges,
      unsupportedChanges,
      notFoundChanges,
      summary: {
        changedInput: input.changedComponents.length,
        apexAnalyzed: apexTargets.size,
        selectedTestCount: selectedTests.length,
        uncoveredCount: uncoveredChanges.length,
        unsupportedCount: unsupportedChanges.length,
        notFoundCount: notFoundChanges.length,
      },
      disclosure: TESTS_FOR_CHANGE_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
