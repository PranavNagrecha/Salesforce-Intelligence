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
 * **Honesty axis** (the `fake-assertion` recognizer's own boundary — see
 * `packages/patterns/src/code-quality-patterns.ts`):
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
 *   - Walks every `ApexClass` node via `scanAllNodesOfTypes` (windows
 *     the SQL `OFFSET` forward past the 500-row per-page cap), filters
 *     out `properties.isTest === true`, then for each remaining class
 *     runs an incoming usage BFS over the test-class subset. The
 *     corpus is COMPLETE: a test class sorting past position 500 by
 *     id ASC is now visible to the BFS filter, so it no longer
 *     produces a false `uncovered` verdict.
 *   - `classFilter` optionally narrows the scan to a specific subset
 *     of ApexClass ids (typically chosen by the user after running
 *     `sfi.code_quality_audit` or similar). Ids the graph carries no
 *     ApexClass for are reported in `notFoundClassIds` plus a
 *     boundary — never silently dropped as "clean".
 *   - The `coveringTestClassIds` list emits BFS-reached test class
 *     ids sorted ASC; `fakeAssertions` enumerates the fake-assertion
 *     locations from those test classes (also id-sorted ASC).
 */

import type {
  ComponentId,
  ConfidenceLevel,
  EdgeType,
  McpError,
  McpResponse,
  Node,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { z } from 'zod';

import type { Context } from '../server.js';

import { USAGE_EDGE_TYPES, walkUpstreamUsage } from './apex-reachability.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import {
  buildUnscannedNodesNote,
  censusQualityScanCoverage,
  type QualityScanTypeCoverage,
} from './quality-scan-coverage.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { fullScanTruncationNote } from './scan-cap.js';

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

/**
 * TEST-COVERAGE-UNCOVERED-RECOMMENDATION. Verbatim product copy; do not reword.
 * Names the edge types actually walked, so "uncovered" is readable as a checked
 * absence rather than an unbounded one.
 */
const UNCOVERED_RECOMMENDATION =
  `No test class reaches this class through any usage edge within depth ${MAX_COVERAGE_DEPTH} ` +
  `(walked: ${USAGE_EDGE_TYPES.join(', ')}). Coverage via dynamic dispatch (Type.forName) or a ` +
  `chain longer than ${MAX_COVERAGE_DEPTH} hops is still invisible — confirm against a real test ` +
  'run before writing a new test.';

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
  // CR-22 continuation cursor: opaque token from a prior truncated page's
  // nextCursor; supplies the resume offset. Omit for today's behavior.
  cursor: z.string().min(1).optional(),
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
/**
 * One test class that reaches the audited class, with the evidence behind the
 * reach. `confidence` and `viaEdgeTypes` exist so a caller can see that a
 * "covering" test reaches the class through a `declared` `dispatchesAsync`
 * (`Database.executeBatch`) rather than a direct call — the same claim, but a
 * reader can now weigh it.
 */
export interface CoveringTestClass {
  readonly id: ComponentId;
  /** Shortest-path hop count from the audited class. */
  readonly depth: number;
  /** D-2: the WEAKEST per-edge confidence along that path. */
  readonly confidence: ConfidenceLevel;
  /** The edge types traversed on that path, de-duplicated and sorted. */
  readonly viaEdgeTypes: readonly EdgeType[];
}

export interface TestCoverageGapEntry {
  readonly componentId: ComponentId;
  readonly apiName: string;
  readonly coverageStatus: CoverageStatus;
  /** Test classes reaching this class through a usage edge (sorted ASC). */
  readonly coveringTestClassIds: readonly ComponentId[];
  /**
   * The same reaches, with per-reach depth / confidence / edge types. Parallel
   * to `coveringTestClassIds` and in the same order.
   */
  readonly coveringTestClasses: readonly CoveringTestClass[];
  /**
   * The edge types the coverage walk traversed. Present on every entry so an
   * `uncovered` verdict is readable as a CHECKED absence.
   */
  readonly walkedEdgeTypes: readonly EdgeType[];
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
  /**
   * QUALITY-SCAN-SKIPS-TRIGGERS-AND-FLOWS. Nodes read vs nodes that actually
   * carry a `qualityIssues` scan, over the TEST classes whose `fake-assertion`
   * findings drive the `fake-coverage` / `low-quality-coverage` verdicts.
   * D-3: emitted UNCONDITIONALLY. It used to appear only when some test class
   * was never scanned, so the answer that most needed it — `gaps: []`, the very
   * shape an unscanned test roster produces — was the one that carried no
   * census at all.
   */
  readonly qualityScanCoverage: readonly QualityScanTypeCoverage[];
  /**
   * `classFilter` ids the graph carries no ApexClass for (sorted ASC). Empty
   * when every filtered id resolved, and absent-shaped only when no filter was
   * supplied. Without it a typo'd or deleted id returned `gaps: []` /
   * `totalGapsCount: 0` — indistinguishable from a genuinely clean class.
   */
  readonly notFoundClassIds: readonly string[];
  /**
   * Verbatim honesty disclosures. Never empty: the three scanner-behaviour
   * disclosures describe HOW coverage is judged and are true whether or not a
   * gap was found, so they live OUTSIDE the zero-gaps gate.
   */
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
   * CR-22 opaque continuation token, present ONLY when this page is truncated
   * (more gaps remain — over `limit` OR byte-trimmed). Echo it back as `cursor`
   * to resume. Absent on a complete page so an in-budget response is
   * byte-identical to the pre-CR-22 shape.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
  /**
   * Set when the page was byte-trimmed below the global ~45 KB response limit
   * (fewer gaps than `limit` despite more matching). Names the trim and how to
   * advance.
   */
  readonly note?: string;
}

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
): Promise<Result<readonly CoveringTestClass[], string>> => {
  // The shared usage walk (D-1): every edge type EXCEPT `parentOf` and
  // `grantedBy`, not `callsApex` alone. Measured on this org, 20 of the 46
  // classes reported `uncovered` had an incoming edge from an @isTest class,
  // 11 of them a `declared` `dispatchesAsync` — a batch class enqueued by its
  // own test. It also replaces the per-frontier-node `listEdges` N+1 with one
  // query per DEPTH LEVEL.
  const walk = await walkUpstreamUsage(ctx, targetId, {
    maxDepth: MAX_COVERAGE_DEPTH,
    edgeTypes: USAGE_EDGE_TYPES,
  });
  if (!walk.ok) return err(walk.error);
  const covering: CoveringTestClass[] = [];
  for (const [id, hit] of walk.value) {
    if (id === targetId) continue;
    if (!testClassIds.has(id)) continue;
    covering.push({
      id,
      depth: hit.depth,
      confidence: hit.confidence,
      viaEdgeTypes: hit.viaEdgeTypes,
    });
  }
  covering.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return ok(covering);
};

/** Per-status recommendation text surfaced verbatim. */
const recommendationFor = (
  status: CoverageStatus,
  coveringCount: number,
): string => {
  if (status === 'uncovered') {
    return UNCOVERED_RECOMMENDATION;
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

  // Scan EVERY ApexClass (windows the SQL OFFSET past the 500 per-page cap).
  // The single capped page this replaced both truncated the corpus and produced
  // false `uncovered` verdicts: `testClassIds` below is built from the SAME
  // list, so a test class sorting past the page was invisible to the BFS filter.
  const scan = await scanAllNodesOfTypes(ctx.graph, ['ApexClass']);
  if (!scan.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${scan.error.message}`,
    });
  }

  // Split into test vs. non-test buckets.
  const testClassIds = new Set<ComponentId>();
  const testFakeAssertionsByClass = new Map<ComponentId, readonly string[]>();
  const nonTestClassNodes: Node[] = [];
  // QUALITY-SCAN-SKIPS-TRIGGERS-AND-FLOWS. The test classes whose
  // `qualityIssues` this tool actually reads — kept so the response can say how
  // many of them carry a scan at all. A test class with no `qualityIssues` KEY
  // can never produce a `fake-assertion`, so every class it covers is silently
  // classified as adequately covered.
  const testClassNodes: Node[] = [];
  for (const node of scan.value.nodes) {
    if (isTestClass(node)) {
      testClassIds.add(node.id);
      testClassNodes.push(node);
      const fakes = collectFakeAssertions(node);
      if (fakes.length > 0) {
        testFakeAssertionsByClass.set(node.id, fakes);
      }
    } else {
      nonTestClassNodes.push(node);
    }
  }

  // Optional class filter. Applied AFTER the (now complete) scan, so an id the
  // graph does not carry is a real not-found — not a silently-clean class the
  // corpus never reached. Named in `notFoundClassIds` + a boundary so
  // `classFilter: ['ApexClass:Nope']` can no longer read as "no gaps".
  let candidates = nonTestClassNodes;
  const notFoundClassIds: string[] = [];
  if (input.classFilter !== undefined && input.classFilter.length > 0) {
    const filterSet = new Set<string>(input.classFilter);
    candidates = nonTestClassNodes.filter((n) => filterSet.has(n.id));
    const known = new Set<string>(testClassIds);
    for (const n of nonTestClassNodes) known.add(n.id);
    for (const id of new Set(input.classFilter)) {
      if (!known.has(id)) notFoundClassIds.push(id);
    }
    notFoundClassIds.sort();
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
        coveringTestClasses: [],
        walkedEdgeTypes: USAGE_EDGE_TYPES,
        fakeAssertions: [],
        recommendedAction: recommendationFor('uncovered', 0),
      });
      continue;
    }

    // Partition covering test classes into "has fake-assertion" vs.
    // "clean". The status follows from the partition.
    const withFakes: { id: ComponentId; locations: readonly string[] }[] = [];
    let cleanCount = 0;
    for (const t of covering) {
      const locs = testFakeAssertionsByClass.get(t.id);
      if (locs !== undefined && locs.length > 0) {
        withFakes.push({ id: t.id, locations: locs });
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
      coveringTestClassIds: covering.map((t) => t.id),
      coveringTestClasses: covering,
      walkedEdgeTypes: USAGE_EDGE_TYPES,
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

  // CR-22: resolve the resume offset (echoed cursor wins over explicit offset);
  // a stale/forged cursor (changed classFilter, different tool, or refreshed
  // vault) is rejected with invalid-query.
  const fingerprint = argsFingerprint({
    ...(input.classFilter !== undefined ? { classFilter: input.classFilter } : {}),
  });
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: 'sfi.test_coverage_gaps',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  // The pre-byte-trim window size feeds the byte-identical note (`X of Y gaps`).
  // `paginate()` applies the same largest-prefix byte-trim the handler used to
  // open-code via `fitGapsToBudget` (verified equivalent kept-set).
  const windowSize = sorted.slice(offset, offset + limit).length;
  const paged = paginateLegacy(sorted, {
    offset,
    limit,
    byteBudget: TEST_COVERAGE_GAPS_PAYLOAD_BUDGET_BYTES,
    binding: {
      tool: 'sfi.test_coverage_gaps',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const kept = paged.items;
  const trimmed = paged.byteTrimmed;
  const truncated = paged.hasMore;
  const emitCursor = paged.nextCursor !== null;

  // D-3: all three describe HOW coverage is judged — what counts as a
  // meaningful assertion, that dynamic dispatch is invisible, that the walk
  // stops at depth 3 — and each is true whether or not a gap was found. Gating
  // them on `sorted.length > 0` silenced them on `gaps: []`, which is precisely
  // the answer an unscanned or shallow-walked roster produces.
  const boundaries: string[] = [
    MEANINGFUL_ASSERTION_DISCLOSURE,
    DYNAMIC_DISPATCH_DISCLOSURE,
    DEPTH_CAP_DISCLOSURE,
  ];

  // QUALITY-SCAN-SKIPS-TRIGGERS-AND-FLOWS. Lives OUTSIDE the zero-gaps gate:
  // "no gaps" is precisely the answer an unscanned test-class set produces, so
  // it is the one that most needs to say what was never read.
  const qualityScanCoverage = censusQualityScanCoverage(testClassNodes);
  const unscannedNote = buildUnscannedNodesNote(qualityScanCoverage);
  if (unscannedNote !== undefined) boundaries.push(unscannedNote);

  if (notFoundClassIds.length > 0) {
    boundaries.push(
      `${notFoundClassIds.length} classFilter id(s) matched no ApexClass in the vault and were NOT audited: ${notFoundClassIds.join(', ')} (see notFoundClassIds).`,
    );
  }

  // Residual full-scan cap (FULL_SCAN_MAX_NODES) — false in the normal case now
  // that the ApexClass type is walked to exhaustion.
  if (scan.value.scanIncomplete) {
    boundaries.push(fullScanTruncationNote(scan.value.incompleteTypes));
  }

  return ok({
    data: {
      gaps: kept,
      totalGapsCount: sorted.length,
      byStatus,
      qualityScanCoverage,
      notFoundClassIds,
      boundaries,
      limit,
      offset,
      truncated,
      ...(truncated ? { nextOffset: offset + kept.length } : {}),
      ...(emitCursor ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo } : {}),
      ...(trimmed
        ? {
            note:
              `Response trimmed to ${kept.length} of ${windowSize} gaps ` +
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
