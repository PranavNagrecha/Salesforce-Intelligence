/**
 * Handler for the `sfi.test_coverage_gaps` MCP tool.
 *
 * The v2.1 test-coverage-gap surface. Combines three signals to
 * classify every non-test ApexClass into one of three coverage
 * statuses — `'uncovered'`, `'fake-coverage'`, or
 * `'low-quality-coverage'` — and surfaces the test classes that
 * reach the class via `callsApex` edges (transitively, capped at
 * depth 3).
 *
 * **Three-signal composition:**
 *   1. Test-class identity. `properties.isTest === true` (from the
 *      v0.3 / v1.4 extractor) identifies a class as `@isTest`. Test
 *      classes are never themselves a "coverage gap" — they're
 *      excluded from the scan.
 *   2. Reachability. A non-test class C is "covered" when at least
 *      one test class T reaches it via `callsApex` edges within
 *      `MAX_COVERAGE_DEPTH` hops. This BFS over the `callsApex`
 *      edges (incoming to C) walks one direction only and bounds the
 *      depth — long-chain coverage (T → A → B → C) is acceptable up
 *      to the cap.
 *   3. Assertion meaningfulness. For each covering test class T, we
 *      inspect T's `qualityIssues[]` for the `fake-assertion`
 *      finding (the v2.1 recognizer's tautology / self-equals /
 *      literal-equals detector). When EVERY covering test class is
 *      flagged with `fake-assertion`, the class's
 *      `coverageStatus` is `'fake-coverage'` (covered, but the
 *      coverage is meaningless). When SOME covering test class has
 *      fake-assertion findings but at least one doesn't, the status
 *      is `'low-quality-coverage'`. When no covering test class has
 *      any fake-assertion findings and the coverage chain exists,
 *      the class is omitted from the response (it's NOT a gap).
 *
 * **Honesty axis** (per `ApexQualitySemantics.md` § 13 and the
 * v2.1 R3 §5 disclosure language for `sfi.test_coverage_gaps`):
 *
 *   - The meaningful-assertion heuristic recognizes
 *     `System.assert(condition)` with a non-literal condition and
 *     `System.assertEquals(expected, actual)` patterns with distinct
 *     expected/actual tokens. Assertions via helper methods
 *     (`Assert.assertField(record, ...)`) or framework wrappers are
 *     invisible. A class flagged `fake-coverage` may actually have
 *     meaningful tests via a custom assertion helper.
 *
 *   - Reachability via `callsApex` does NOT cover dynamic dispatch
 *     (`Type.forName('...').newInstance().method(...)`) or
 *     reflective invocation. A class genuinely tested via dynamic
 *     dispatch will surface as `'uncovered'` by this heuristic.
 *
 *   - The depth-3 cap matches the v0.3 `find_apex_usages` BFS cap
 *     and the v2.0g `domain_clusters` depth budget. Coverage chains
 *     longer than 3 hops surface as `'uncovered'` even when they
 *     exist.
 *
 * Both disclosures are surfaced verbatim in `boundaries[]` when at
 * least one gap is returned.
 *
 * Implementation notes:
 *   - Walks every `ApexClass` node, filters out `properties.isTest
 *     === true`, then for each remaining class runs an incoming
 *     `callsApex` BFS over the test-class subset.
 *   - `classFilter` optionally narrows the scan to a specific subset
 *     of ApexClass ids (typically chosen by the user after running
 *     `sfi.code_quality_audit` or similar). Unknown ids in the
 *     filter are silently dropped — the tool reports on classes the
 *     graph actually carries.
 *   - The `coveringTestClassIds` list emits BFS-reached test class
 *     ids sorted ASC; `fakeAssertions` enumerates the fake-assertion
 *     locations from those test classes (also id-sorted ASC).
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listEdges, listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

/** Per-type cap matching `listNodesByType`'s default. */
const LIST_PAGE_SIZE = 500;

/** Inclusive upper bound on `classFilter` array length. */
const CLASS_FILTER_MAX_SIZE = 500;
/** Inclusive upper bound on `limit`. */
const TEST_COVERAGE_GAPS_MAX_LIMIT = 500;
/** Default `limit` when the caller omits it. */
const TEST_COVERAGE_GAPS_DEFAULT_LIMIT = 200;
/**
 * Per-response byte budget for the `gaps` array. Sits below the global
 * `MAX_RESPONSE_BYTES` (~45 KB) dispatch guard with headroom for the summary
 * counters, `boundaries`, the envelope, and pagination fields, so a
 * default-`limit` page can never trip that guard.
 */
const TEST_COVERAGE_GAPS_PAYLOAD_BUDGET_BYTES = 38_000;

/**
 * BFS depth cap for the test-class coverage walk. Matches the v0.3
 * `find_apex_usages` BFS cap and the v2.0g `domain_clusters` depth
 * budget; coverage chains longer than three hops are heuristically
 * uncovered.
 */
const MAX_COVERAGE_DEPTH = 3;

/** Verbatim test-coverage honesty disclosures. */
const MEANINGFUL_ASSERTION_DISCLOSURE =
  'the meaningful-assertion heuristic recognizes System.assertEquals(expected, actual) patterns with distinct expected/actual tokens, plus System.assert(condition) with a non-literal condition. Assertions via helper methods or framework wrappers are invisible. A class flagged fake-coverage may actually have meaningful tests via a custom assertion helper.';

const DYNAMIC_DISPATCH_DISCLOSURE =
  'reachability via callsApex does NOT cover dynamic dispatch (Type.forName) or reflective invocation. A class genuinely tested via dynamic dispatch will surface as uncovered by this heuristic.';

const DEPTH_CAP_DISCLOSURE =
  `the coverage BFS is capped at depth ${MAX_COVERAGE_DEPTH}; coverage chains longer than ${MAX_COVERAGE_DEPTH} hops surface as uncovered even when they exist.`;

/**
 * Zod schema for the `sfi.test_coverage_gaps` tool input.
 *
 *   - `classFilter`: optional array of `ApexClass:` canonical ids to
 *     scope the scan. Capped at 500. Omitted means "every non-test
 *     ApexClass".
 *   - `limit`: optional integer in `[1, 500]`. Defaults to 200. The slice
 *     is over gap entries.
 *   - `offset`: optional integer (>= 0); defaults to 0. Page cursor for
 *     walking the full gap list when a response is `truncated` — advance by
 *     `nextOffset`.
 */
export const testCoverageGapsInputSchema = z.object({
  classFilter: z
    .array(z.string().min(1))
    .max(CLASS_FILTER_MAX_SIZE)
    .optional(),
  limit: z.number().int().min(1).max(TEST_COVERAGE_GAPS_MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
});

/** Parsed input shape. */
export type TestCoverageGapsInput = z.infer<
  typeof testCoverageGapsInputSchema
>;

/** Coverage status for one non-test class. */
export type CoverageStatus =
  | 'uncovered'
  | 'fake-coverage'
  | 'low-quality-coverage';

/** Per-test-class fake-assertion location. */
export interface FakeAssertionLocation {
  readonly testClassId: ComponentId;
  readonly location: string;
}

/** One per-class entry in the response. */
export interface TestCoverageGapEntry {
  readonly componentId: ComponentId;
  readonly apiName: string;
  readonly coverageStatus: CoverageStatus;
  /** Test classes reaching this class via callsApex (sorted ASC). */
  readonly coveringTestClassIds: readonly ComponentId[];
  /** Locations of `fake-assertion` findings in the covering test classes. */
  readonly fakeAssertions: readonly FakeAssertionLocation[];
  /** Per-status human-readable recommendation. */
  readonly recommendedAction: string;
}

/** Output payload. */
export interface TestCoverageGapsOutput {
  readonly gaps: readonly TestCoverageGapEntry[];
  readonly totalGapsCount: number;
  /** Per-status counter across the FULL matched set. */
  readonly byStatus: Readonly<Record<CoverageStatus, number>>;
  /** Verbatim honesty disclosures; empty when no gaps. */
  readonly boundaries: readonly string[];
  /** Page size applied to this response (echoes the request; default 200). */
  readonly limit: number;
  /** Zero-based offset of the first returned gap in the sorted set. */
  readonly offset: number;
  /** True when more gaps exist beyond this response's slice. */
  readonly truncated: boolean;
  /**
   * Offset to pass on the next call to fetch the following page. Present only
   * when `truncated`.
   */
  readonly nextOffset?: number;
  /**
   * Set when the page was byte-trimmed below the global ~45 KB response limit
   * (fewer gaps than `limit` despite more matching). Names the trim and how to
   * advance.
   */
  readonly note?: string;
}

/**
 * Trim a gap page to the largest sort-ordered prefix whose serialized size
 * fits `budgetBytes`. A gap with many covering tests / fake-assertion
 * locations is large, so a fixed `limit` cannot bound bytes — only a byte
 * budget guarantees the response clears the global guard. Always keeps at
 * least one gap.
 */
const fitGapsToBudget = (
  gaps: readonly TestCoverageGapEntry[],
  budgetBytes: number,
): {
  readonly kept: readonly TestCoverageGapEntry[];
  readonly trimmed: boolean;
} => {
  const kept: TestCoverageGapEntry[] = [];
  let used = 0;
  for (const gap of gaps) {
    const size = Buffer.byteLength(JSON.stringify(gap), 'utf8') + 1;
    if (kept.length > 0 && used + size > budgetBytes) {
      return { kept, trimmed: true };
    }
    kept.push(gap);
    used += size;
  }
  return { kept, trimmed: false };
};

/**
 * Locations of `fake-assertion` findings in a node's
 * `qualityIssues` array. Returns the locations sorted by their
 * recognizer-emitted position string ASC.
 */
const collectFakeAssertions = (node: Node): readonly string[] => {
  const raw = node.properties['qualityIssues'];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const r of raw) {
    if (r === null || typeof r !== 'object') continue;
    const obj = r as Record<string, unknown>;
    if (obj['rule'] !== 'fake-assertion') continue;
    const loc = obj['location'];
    if (typeof loc !== 'string') continue;
    out.push(loc);
  }
  return [...out].sort();
};

const isTestClass = (node: Node): boolean =>
  node.properties['isTest'] === true;

/**
 * BFS from `targetId` over INCOMING `callsApex` edges. Returns the
 * subset of test-class ids that reach `targetId` within
 * `MAX_COVERAGE_DEPTH` hops. The walk visits each id at most once.
 *
 * @param ctx Server context with the open graph.
 * @param targetId The non-test class whose coverage we're auditing.
 * @param testClassIds The full set of test classes in the org, used
 *                    to filter the BFS frontier — we only count a
 *                    reach when the frontier is itself a test class.
 *                    Non-test reach paths are followed so a long
 *                    chain `T → A → B → targetId` still surfaces T.
 */
const collectCoveringTestClasses = async (
  ctx: Context,
  targetId: ComponentId,
  testClassIds: ReadonlySet<ComponentId>,
): Promise<Result<readonly ComponentId[], string>> => {
  const visited = new Set<ComponentId>();
  const covering = new Set<ComponentId>();
  let frontier: ComponentId[] = [targetId];
  visited.add(targetId);
  for (let depth = 0; depth < MAX_COVERAGE_DEPTH; depth += 1) {
    const next: ComponentId[] = [];
    for (const id of frontier) {
      const r = await listEdges(ctx.graph, id, {
        direction: 'in',
        edgeType: 'callsApex',
      });
      if (!r.ok) return err(r.error.message);
      for (const edge of r.value) {
        if (visited.has(edge.fromId)) continue;
        visited.add(edge.fromId);
        if (testClassIds.has(edge.fromId)) {
          covering.add(edge.fromId);
        }
        next.push(edge.fromId);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return ok([...covering].sort());
};

/** Per-status recommendation text surfaced verbatim. */
const recommendationFor = (
  status: CoverageStatus,
  coveringCount: number,
): string => {
  if (status === 'uncovered') {
    return 'no test class reaches this class via callsApex within depth 3. Add a test class that exercises the class via direct or transitive invocation. The recognizer cannot see dynamic dispatch — if the class is exercised via Type.forName(...), it may already have runtime coverage.';
  }
  if (status === 'fake-coverage') {
    return `${coveringCount} test class(es) reach this class but every reaching test has at least one fake-assertion finding (tautology, self-equals, or literal-equals shape). Replace the fake assertions with System.assertEquals(expected, actual) using distinct expected/actual tokens, or assert on observable side effects.`;
  }
  return `${coveringCount} test class(es) reach this class; at least one is flagged with fake-assertion findings. Audit the covering test classes for assertion meaningfulness; this is a lower-priority gap than 'fake-coverage' but still worth a review.`;
};

/** Comparator for the gap slice: id ASC. */
const compareGapById = (
  a: TestCoverageGapEntry,
  b: TestCoverageGapEntry,
): number =>
  a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0;

/** Build an empty per-status counter. */
const emptyByStatus = (): Record<CoverageStatus, number> => ({
  uncovered: 0,
  'fake-coverage': 0,
  'low-quality-coverage': 0,
});

/**
 * The `sfi.test_coverage_gaps` MCP tool. Returns the per-class
 * coverage gap report across every non-test ApexClass (or the
 * subset named in `classFilter`). See the module JSDoc for the
 * three-signal composition (`isTest`, `callsApex` BFS,
 * `fake-assertion` qualityIssues) and the verbatim honesty
 * disclosures.
 *
 * @example
 *   const r = await testCoverageGapsHandler(ctx, {});
 *   if (r.ok) console.log(r.value.data.byStatus.uncovered);
 */
export const testCoverageGapsHandler = async (
  ctx: Context,
  input: TestCoverageGapsInput,
): Promise<Result<McpResponse<TestCoverageGapsOutput>, McpError>> => {
  // Refuse `classFilter: []` up front. Zod's `.optional()` accepts the
  // empty array, but the empty-array case is ambiguous: did the caller
  // mean "no filter" (omit the field) or "filter to nothing" (an error
  // they want to know about)? Surfacing it as `invalid-query` forces
  // explicit intent and prevents the silent-accept smoke-test finding
  // from journal 0160.
  if (input.classFilter !== undefined && input.classFilter.length === 0) {
    return err({
      kind: 'invalid-query',
      message:
        'classFilter is an empty array; omit the field to scan all classes, or supply at least one ApexClass: id',
      path: 'classFilter',
    });
  }

  const classesRes = await listNodesByType(ctx.graph, 'ApexClass', {
    limit: LIST_PAGE_SIZE,
  });
  if (!classesRes.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${classesRes.error.message}`,
    });
  }

  // Split into test vs. non-test buckets.
  const testClassIds = new Set<ComponentId>();
  const testFakeAssertionsByClass = new Map<ComponentId, readonly string[]>();
  const nonTestClassNodes: Node[] = [];
  for (const node of classesRes.value) {
    if (isTestClass(node)) {
      testClassIds.add(node.id);
      const fakes = collectFakeAssertions(node);
      if (fakes.length > 0) {
        testFakeAssertionsByClass.set(node.id, fakes);
      }
    } else {
      nonTestClassNodes.push(node);
    }
  }

  // Optional class filter.
  let candidates = nonTestClassNodes;
  if (input.classFilter !== undefined && input.classFilter.length > 0) {
    const filterSet = new Set<string>(input.classFilter);
    candidates = nonTestClassNodes.filter((n) => filterSet.has(n.id));
  }

  const gaps: TestCoverageGapEntry[] = [];

  for (const node of candidates) {
    const coveringRes = await collectCoveringTestClasses(
      ctx,
      node.id,
      testClassIds,
    );
    if (!coveringRes.ok) {
      return err({ kind: 'internal', message: coveringRes.error });
    }
    const covering = coveringRes.value;

    if (covering.length === 0) {
      gaps.push({
        componentId: node.id,
        apiName: node.apiName,
        coverageStatus: 'uncovered',
        coveringTestClassIds: [],
        fakeAssertions: [],
        recommendedAction: recommendationFor('uncovered', 0),
      });
      continue;
    }

    // Partition covering test classes into "has fake-assertion" vs.
    // "clean". The status follows from the partition.
    const withFakes: { id: ComponentId; locations: readonly string[] }[] = [];
    let cleanCount = 0;
    for (const testId of covering) {
      const locs = testFakeAssertionsByClass.get(testId);
      if (locs !== undefined && locs.length > 0) {
        withFakes.push({ id: testId, locations: locs });
      } else {
        cleanCount += 1;
      }
    }

    if (withFakes.length === 0) {
      // Every covering test class is clean — not a gap.
      continue;
    }

    const status: CoverageStatus =
      cleanCount === 0 ? 'fake-coverage' : 'low-quality-coverage';

    // Flatten fake-assertion locations across the covering tests.
    const fakeAssertions: FakeAssertionLocation[] = [];
    for (const t of withFakes) {
      for (const loc of t.locations) {
        fakeAssertions.push({ testClassId: t.id, location: loc });
      }
    }
    // Stable order: test class id ASC then location ASC.
    fakeAssertions.sort((a, b) => {
      if (a.testClassId !== b.testClassId) {
        return a.testClassId < b.testClassId ? -1 : 1;
      }
      return a.location < b.location ? -1 : a.location > b.location ? 1 : 0;
    });

    gaps.push({
      componentId: node.id,
      apiName: node.apiName,
      coverageStatus: status,
      coveringTestClassIds: covering,
      fakeAssertions,
      recommendedAction: recommendationFor(status, covering.length),
    });
  }

  const sorted = [...gaps].sort(compareGapById);
  const byStatus = emptyByStatus();
  for (const g of sorted) {
    byStatus[g.coverageStatus] += 1;
  }

  const limit = input.limit ?? TEST_COVERAGE_GAPS_DEFAULT_LIMIT;
  const offset = input.offset ?? 0;
  const page = sorted.slice(offset, offset + limit);
  const { kept, trimmed } = fitGapsToBudget(
    page,
    TEST_COVERAGE_GAPS_PAYLOAD_BUDGET_BYTES,
  );
  const returnedEnd = offset + kept.length;
  const truncated = returnedEnd < sorted.length;

  const boundaries: string[] =
    sorted.length === 0
      ? []
      : [
          MEANINGFUL_ASSERTION_DISCLOSURE,
          DYNAMIC_DISPATCH_DISCLOSURE,
          DEPTH_CAP_DISCLOSURE,
        ];

  return ok({
    data: {
      gaps: kept,
      totalGapsCount: sorted.length,
      byStatus,
      boundaries,
      limit,
      offset,
      truncated,
      ...(truncated ? { nextOffset: returnedEnd } : {}),
      ...(trimmed
        ? {
            note:
              `Response trimmed to ${kept.length} of ${page.length} gaps ` +
              `(${sorted.length} total) to stay under the ~45 KB MCP response ` +
              `limit. Advance with offset += ${kept.length} for the rest.`,
          }
        : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
