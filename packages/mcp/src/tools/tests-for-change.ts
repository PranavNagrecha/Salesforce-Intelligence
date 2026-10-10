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
 *   3. The shared walk (`findCoveringTests`, test-coverage-reach.ts): BFS
 *      upstream over INCOMING `TEST_REACH_EDGE_TYPES` (callsApex /
 *      dispatchesAsync / inheritsFrom / references) from Apex, depth-3
 *      capped, plus a heuristic trigger hop (a test that writes the object a
 *      reached trigger fires on). Every reached `isTest === true` node is a
 *      covering test; a test is a sink, never relayed through.
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
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { coercePrefix } from './coerce-id.js';
import { firstNonEmpty } from './input-aliases.js';
import { type CoverageVia, findCoveringTests } from './test-coverage-reach.js';

/** BFS depth cap. Matches `sfi.test_coverage_for_method` / `sfi.method_reachability`. */
const TESTS_FOR_CHANGE_BFS_DEPTH = 3;

/** Canonical id prefixes the tool analyses. */
const APEX_CLASS_PREFIX = 'ApexClass:';
const APEX_TRIGGER_PREFIX = 'ApexTrigger:';

/** Hard cap on the change-set size (matches `sfi.meaningful_test_audit`'s `classFilter`). */
const MAX_CHANGED_ITEMS = 500;

/** Verbatim honesty disclosure surfaced on every response. */
const TESTS_FOR_CHANGE_DISCLOSURE =
  'tests_for_change selects at CLASS granularity (a changed method on a covered class still selects that class’s tests; method-level resolution promised in v2.7.1). The upstream walk (shared with test_coverage_gaps and apex_test_coverage) follows callsApex, dispatchesAsync, inheritsFrom and references incoming edges from Apex, so async dispatch, instantiation and static references count; it also credits a test that writes an object whose trigger reaches the change (`via: via-trigger`, heuristic); when the test’s own source shows DML but none of that trigger’s events it is still credited, marked `eventMismatch` (code it calls can still fire the trigger). A test class is a coverage SINK: it is recorded as a covering test but the walk never traverses THROUGH it, so a test is never credited with covering a class its own production code never references. Dynamic dispatch (Type.forName) and reflective invocation are invisible — a test reaching the change only via reflection is missed. Managed-package test classes are invisible. BFS is capped at depth 3; coverage chains longer than 3 hops surface as uncovered even when they exist. SELECTION ≠ VALIDATION: a selected test that merely runs the changed code does NOT prove the change is correct. In particular, Apex tests run with FULL system-context FLS unless the method wraps the path in System.runAs with a restricted user, so .size()/row-count assertions will NOT detect a WITH SECURITY_ENFORCED / stripInaccessible field-access regression — no field is filtered in the test runtime. A changed component in uncoveredChanges is UNGUARDED — running the selected set will NOT exercise it; run the full suite when any change is uncovered or you suspect a deep chain.';

/**
 * Normalize a `review_change`-shaped component selector object to its canonical
 * `Type:ApiName` string id, or `null` when it names no component. A
 * `componentId` wins when both it and a `{ type, apiName }` pair are present
 * (mirrors `review_change`'s per-entry normalization). Any `changeKind` a host
 * forwards from its diff label is accepted but IGNORED — `tests_for_change`
 * selects the covering tests of a component regardless of HOW it changed.
 */
const objectSelectorToId = (val: {
  readonly componentId?: string | undefined;
  readonly type?: string | undefined;
  readonly apiName?: string | undefined;
}): string | null => {
  const cid = firstNonEmpty(val.componentId);
  if (cid !== undefined) return cid;
  const type = firstNonEmpty(val.type);
  const apiName = firstNonEmpty(val.apiName);
  return type !== undefined && apiName !== undefined ? `${type}:${apiName}` : null;
};

/** Named refusal for an entry that resolves to no component. */
const CHANGED_ITEM_ERROR =
  'each changed component needs a string id, a `componentId` (`Type:ApiName`), or a `{ type, apiName }` pair';

/**
 * One `changedComponents` entry: EITHER a bare string id (the canonical shape —
 * passed through untouched so an all-strings call is byte-identical) OR the
 * `review_change`-shaped selector object a router naturally forwards
 * (`{ componentId }` or `{ type, apiName }`, plus an ignored `changeKind`),
 * normalized to its `Type:ApiName` string in a preprocess step. An object that
 * names no component stays a non-string and fails the string schema with the
 * NAMED {@link CHANGED_ITEM_ERROR} message — surfaced verbatim as `invalid-query`
 * at the top-level issue (a `z.union` would bury it under a generic "Invalid
 * input"), not a bare "Expected string" Zod error
 * (TESTS-FOR-CHANGE-REJECTS-NATURAL-COMPONENT-ARGS).
 */
const changedComponentItemSchema = z.preprocess((item) => {
  if (typeof item === 'string') return item;
  if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
    const src = item as Record<string, unknown>;
    const resolved = objectSelectorToId({
      componentId: typeof src['componentId'] === 'string' ? src['componentId'] : undefined,
      type: typeof src['type'] === 'string' ? src['type'] : undefined,
      apiName: typeof src['apiName'] === 'string' ? src['apiName'] : undefined,
    });
    // Resolvable → the canonical string id; unresolvable → leave the object so
    // the string schema rejects it with the NAMED message.
    return resolved ?? item;
  }
  return item;
}, z.string({ invalid_type_error: CHANGED_ITEM_ERROR }).min(1));

/**
 * Fold a single TOP-LEVEL component selector the router emits — `{ componentId:
 * "ApexClass:X" }` or `{ type, apiName }` — into a one-item `changedComponents`
 * set, so a host that forwards the natural single-component shape no longer
 * hard-fails on `changedComponents: Required`
 * (TESTS-FOR-CHANGE-REJECTS-NATURAL-COMPONENT-ARGS). An explicit
 * `changedComponents` (of any shape) wins untouched, so the canonical array call
 * is byte-identical.
 */
const foldTopLevelChangeSelector = (raw: unknown): unknown => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const src = raw as Record<string, unknown>;
  if (src['changedComponents'] !== undefined) return raw;
  const componentId = firstNonEmpty(
    typeof src['componentId'] === 'string' ? src['componentId'] : undefined,
  );
  const type = firstNonEmpty(typeof src['type'] === 'string' ? src['type'] : undefined);
  const apiName = firstNonEmpty(
    typeof src['apiName'] === 'string' ? src['apiName'] : undefined,
  );
  if (componentId === undefined && !(type !== undefined && apiName !== undefined)) {
    // No foldable top-level selector — leave the input alone so the base schema
    // reports the missing `changedComponents` (never silently invent one).
    return raw;
  }
  const selector: Record<string, unknown> = {};
  if (componentId !== undefined) selector['componentId'] = componentId;
  if (type !== undefined) selector['type'] = type;
  if (apiName !== undefined) selector['apiName'] = apiName;
  return { changedComponents: [selector] };
};

/**
 * Zod schema for the `sfi.tests_for_change` tool input.
 *
 *   - `changedComponents`: 1..500 entries. Each is an `ApexClass:` /
 *     `ApexTrigger:` canonical id or a bare class name (coerced to an
 *     `ApexClass:` id), OR a `review_change`-shaped selector object
 *     (`{ componentId }` / `{ type, apiName }`, plus an ignored `changeKind`)
 *     normalized to that string id. Non-Apex `Type:` prefixes are bucketed into
 *     `unsupportedChanges`, not rejected batch-wide.
 *   - A single TOP-LEVEL `componentId` / `{ type, apiName }` (the shape a router
 *     forwards for one component) is folded into a one-item change set. An
 *     explicit `changedComponents` array is passed through untouched, so the
 *     canonical string-array call is byte-identical.
 */
export const testsForChangeInputSchema = z.preprocess(
  foldTopLevelChangeSelector,
  z.object({
    changedComponents: z
      .array(changedComponentItemSchema)
      .min(1)
      .max(MAX_CHANGED_ITEMS),
  }),
);

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
  /**
   * The changes this test reaches ONLY through an `eventMismatch` trigger hop
   * (its own DML shows none of the trigger's events): weaker evidence, so a
   * host reading only the selection still sees it. Omitted when none.
   */
  readonly eventMismatchFor?: readonly ComponentId[];
}

/** A single covering-test reference under a per-change entry. */
export interface CoveringTestRef {
  readonly id: ComponentId;
  readonly apiName: string;
  readonly depth: number;
  /** How the test reaches the change; `via-trigger` = it writes the object whose trigger does (heuristic). */
  readonly via?: CoverageVia;
  /** `via-trigger` only: its own DML shows none of the trigger's events — weaker evidence, still selected. */
  readonly eventMismatch?: true;
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
    { apiName: string; minDepth: number; covers: Set<ComponentId>; mismatched: Set<ComponentId> }
  >();
  const uncovered: ComponentId[] = [];

  const recordSelected = (
    test: Pick<Node, 'id' | 'apiName'>,
    changeId: ComponentId,
    depth: number,
    eventMismatch = false,
  ): void => {
    const existing = selected.get(test.id);
    if (existing === undefined) {
      selected.set(test.id, {
        apiName: test.apiName,
        minDepth: depth,
        covers: new Set([changeId]),
        mismatched: new Set(eventMismatch ? [changeId] : []),
      });
      return;
    }
    existing.covers.add(changeId);
    if (eventMismatch) existing.mismatched.add(changeId);
    if (depth < existing.minDepth) existing.minDepth = depth;
  };

  // One read of each candidate test's source per request (trigger-hop event filter).
  const verbCache = new Map<ComponentId, ReadonlySet<string> | null>();
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

    // DEV-05 / ARCH-04: the ONE shared coverage walk (test-coverage-reach.ts),
    // so this selection agrees with test_coverage_gaps / apex_test_coverage —
    // including tests that reach the change through a trigger's DML.
    const walkRes = await findCoveringTests(ctx.graph, targetId, {
      maxDepth: TESTS_FOR_CHANGE_BFS_DEPTH,
      vaultRoot: ctx.vaultRoot,
      verbCache,
    });
    if (!walkRes.ok) return err({ kind: 'internal', message: walkRes.error });

    const coveringTests: CoveringTestRef[] = [];
    for (const hit of walkRes.value.values()) {
      coveringTests.push({
        id: hit.testId,
        apiName: hit.apiName,
        depth: hit.depth,
        via: hit.via,
        ...(hit.eventMismatch === true ? { eventMismatch: true as const } : {}),
      });
      recordSelected({ id: hit.testId, apiName: hit.apiName }, targetId, hit.depth, hit.eventMismatch === true);
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
      ...(v.mismatched.size > 0 ? { eventMismatchFor: sortIds([...v.mismatched]) } : {}),
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
