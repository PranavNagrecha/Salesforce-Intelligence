/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  Edge,
  ExtractionResult,
  Node,
  VaultManifest,
} from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  testCoverageGapsHandler,
  testCoverageGapsInputSchema,
} from '../../src/tools/test-coverage-gaps.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-tcg',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'ApexClass',
  apiName: 'Anon',
  label: null,
  parentId: null,
  sourcePath: 'unused.cls',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...overrides,
});

const seed: ExtractionResult = {
  nodes: [
    // Uncovered class — no test reaches it.
    makeNode({
      id: 'ApexClass:Uncovered',
      apiName: 'Uncovered',
      properties: { isTest: false, qualityIssues: [] },
    }),
    // Class covered ONLY by a fake-assertion test → fake-coverage.
    makeNode({
      id: 'ApexClass:FakelyCovered',
      apiName: 'FakelyCovered',
      properties: { isTest: false, qualityIssues: [] },
    }),
    // Class covered by both a clean test and a fake test → low-quality.
    makeNode({
      id: 'ApexClass:MixedCovered',
      apiName: 'MixedCovered',
      properties: { isTest: false, qualityIssues: [] },
    }),
    // Class covered by a clean test only — should NOT appear in gaps.
    makeNode({
      id: 'ApexClass:WellCovered',
      apiName: 'WellCovered',
      properties: { isTest: false, qualityIssues: [] },
    }),
    // Class reached transitively via a chain through another non-test class
    // → covered → should NOT appear if the chain test has no fake-asserts.
    makeNode({
      id: 'ApexClass:Chained',
      apiName: 'Chained',
      properties: { isTest: false, qualityIssues: [] },
    }),
    makeNode({
      id: 'ApexClass:ChainHelper',
      apiName: 'ChainHelper',
      properties: { isTest: false, qualityIssues: [] },
    }),
    // Test classes.
    makeNode({
      id: 'ApexClass:FakelyCoveredTest',
      apiName: 'FakelyCoveredTest',
      properties: {
        isTest: true,
        qualityIssues: [
          {
            rule: 'fake-assertion',
            severity: 'high',
            location: 'line 4',
            explanation: 'tautology assert',
            confidence: 'heuristic',
          },
        ],
      },
    }),
    makeNode({
      id: 'ApexClass:CleanTest',
      apiName: 'CleanTest',
      properties: { isTest: true, qualityIssues: [] },
    }),
    makeNode({
      id: 'ApexClass:FakeTest',
      apiName: 'FakeTest',
      properties: {
        isTest: true,
        qualityIssues: [
          {
            rule: 'fake-assertion',
            severity: 'high',
            location: 'line 10',
            explanation: 'self-equals',
            confidence: 'heuristic',
          },
        ],
      },
    }),
    makeNode({
      id: 'ApexClass:WellCoveredTest',
      apiName: 'WellCoveredTest',
      properties: { isTest: true, qualityIssues: [] },
    }),
    makeNode({
      id: 'ApexClass:ChainedTest',
      apiName: 'ChainedTest',
      properties: { isTest: true, qualityIssues: [] },
    }),
  ],
  edges: [
    // Test → FakelyCovered (fake assertions only)
    makeEdge({
      fromId: 'ApexClass:FakelyCoveredTest',
      toId: 'ApexClass:FakelyCovered',
      edgeType: 'callsApex',
    }),
    // Both tests → MixedCovered (mix of fake + clean)
    makeEdge({
      fromId: 'ApexClass:FakeTest',
      toId: 'ApexClass:MixedCovered',
      edgeType: 'callsApex',
    }),
    makeEdge({
      fromId: 'ApexClass:CleanTest',
      toId: 'ApexClass:MixedCovered',
      edgeType: 'callsApex',
    }),
    // Test → WellCovered (clean)
    makeEdge({
      fromId: 'ApexClass:WellCoveredTest',
      toId: 'ApexClass:WellCovered',
      edgeType: 'callsApex',
    }),
    // Transitive: ChainedTest → ChainHelper → Chained (depth 2 — within cap).
    makeEdge({
      fromId: 'ApexClass:ChainedTest',
      toId: 'ApexClass:ChainHelper',
      edgeType: 'callsApex',
    }),
    makeEdge({
      fromId: 'ApexClass:ChainHelper',
      toId: 'ApexClass:Chained',
      edgeType: 'callsApex',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-tcg-'));
  const opened = await openGraph(join(tempDir, 'tcg.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('testCoverageGapsHandler', () => {
  it('classifies an uncovered class as "uncovered" with empty coveringTestClassIds', async () => {
    const r = await testCoverageGapsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const uncovered = r.value.data.gaps.find(
      (g) => g.componentId === 'ApexClass:Uncovered',
    );
    expect(uncovered).toBeDefined();
    expect(uncovered?.coverageStatus).toBe('uncovered');
    expect(uncovered?.coveringTestClassIds).toEqual([]);
    expect(uncovered?.fakeAssertions).toEqual([]);
  });

  it('classifies a class covered only by fake tests as "fake-coverage"', async () => {
    const r = await testCoverageGapsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fakelyCovered = r.value.data.gaps.find(
      (g) => g.componentId === 'ApexClass:FakelyCovered',
    );
    expect(fakelyCovered).toBeDefined();
    expect(fakelyCovered?.coverageStatus).toBe('fake-coverage');
    expect(fakelyCovered?.coveringTestClassIds).toEqual([
      'ApexClass:FakelyCoveredTest',
    ]);
    expect(fakelyCovered?.fakeAssertions.length).toBe(1);
    expect(fakelyCovered?.fakeAssertions[0]?.testClassId).toBe(
      'ApexClass:FakelyCoveredTest',
    );
  });

  it('classifies a class covered by mixed tests as "low-quality-coverage"', async () => {
    const r = await testCoverageGapsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const mixed = r.value.data.gaps.find(
      (g) => g.componentId === 'ApexClass:MixedCovered',
    );
    expect(mixed).toBeDefined();
    expect(mixed?.coverageStatus).toBe('low-quality-coverage');
    // Both test classes reach MixedCovered.
    expect(mixed?.coveringTestClassIds.length).toBe(2);
    expect(mixed?.coveringTestClassIds).toContain('ApexClass:CleanTest');
    expect(mixed?.coveringTestClassIds).toContain('ApexClass:FakeTest');
    // Only the FakeTest fake-assertions surface.
    expect(mixed?.fakeAssertions.length).toBe(1);
    expect(mixed?.fakeAssertions[0]?.testClassId).toBe('ApexClass:FakeTest');
  });

  it('omits well-covered classes (no fake-asserts in any covering test) from gaps', async () => {
    const r = await testCoverageGapsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const wellCovered = r.value.data.gaps.find(
      (g) => g.componentId === 'ApexClass:WellCovered',
    );
    expect(wellCovered).toBeUndefined();
  });

  it('reaches a transitively-covered class via the depth-3 BFS', async () => {
    const r = await testCoverageGapsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Chained is reached at depth 2: ChainedTest → ChainHelper → Chained.
    // ChainedTest has no fake-asserts → Chained is well-covered → omitted.
    const chained = r.value.data.gaps.find(
      (g) => g.componentId === 'ApexClass:Chained',
    );
    expect(chained).toBeUndefined();
  });

  it('reports byStatus counts and sorts gaps by componentId ASC', async () => {
    const r = await testCoverageGapsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.byStatus.uncovered).toBeGreaterThanOrEqual(1);
    expect(r.value.data.byStatus['fake-coverage']).toBeGreaterThanOrEqual(1);
    expect(r.value.data.byStatus['low-quality-coverage']).toBeGreaterThanOrEqual(
      1,
    );
    const ids = r.value.data.gaps.map((g) => g.componentId);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it('excludes test classes from the scan (they are never gaps)', async () => {
    const r = await testCoverageGapsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.gaps.map((g) => g.componentId);
    expect(ids).not.toContain('ApexClass:FakelyCoveredTest');
    expect(ids).not.toContain('ApexClass:CleanTest');
    expect(ids).not.toContain('ApexClass:FakeTest');
    expect(ids).not.toContain('ApexClass:WellCoveredTest');
  });

  it('honors classFilter to narrow the scan', async () => {
    const r = await testCoverageGapsHandler(ctx, {
      classFilter: ['ApexClass:Uncovered'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.gaps.length).toBe(1);
    expect(r.value.data.gaps[0]?.componentId).toBe('ApexClass:Uncovered');
  });

  it('refuses an empty classFilter array with invalid-query', async () => {
    // Regression for journal 0160: an empty array is ambiguous (did the
    // caller mean "no filter" or "filter to nothing"?). Silent-accept
    // returning the full coverage data hid the typo, so we refuse and
    // ask the caller to clarify by omitting the field or supplying at
    // least one ApexClass: id.
    const r = await testCoverageGapsHandler(ctx, { classFilter: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toMatch(/classFilter is an empty array/);
    expect(r.error.path).toBe('classFilter');
  });

  it('surfaces verbatim honesty boundaries (meaningful-assertion + dynamic-dispatch + depth-cap)', async () => {
    const r = await testCoverageGapsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).toMatch(/meaningful-assertion|System\.assertEquals/i);
    expect(joined).toMatch(/dynamic dispatch|Type\.forName/i);
    expect(joined).toMatch(/depth 3|capped at depth/i);
  });

  it('provides a per-status recommendedAction string', async () => {
    const r = await testCoverageGapsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const g of r.value.data.gaps) {
      expect(g.recommendedAction.length).toBeGreaterThan(0);
    }
  });
});

describe('testCoverageGapsInputSchema', () => {
  it('accepts empty input', () => {
    expect(testCoverageGapsInputSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a non-empty classFilter array', () => {
    expect(
      testCoverageGapsInputSchema.safeParse({
        classFilter: ['ApexClass:X'],
      }).success,
    ).toBe(true);
  });

  it('rejects classFilter above maxItems', () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => `ApexClass:X${i}`);
    expect(
      testCoverageGapsInputSchema.safeParse({ classFilter: tooMany }).success,
    ).toBe(false);
  });

  it('rejects classFilter entries that are empty strings', () => {
    expect(
      testCoverageGapsInputSchema.safeParse({ classFilter: [''] }).success,
    ).toBe(false);
  });

  it('accepts offset and rejects a negative one', () => {
    expect(testCoverageGapsInputSchema.safeParse({ offset: 5 }).success).toBe(
      true,
    );
    expect(testCoverageGapsInputSchema.safeParse({ offset: -1 }).success).toBe(
      false,
    );
  });
});

// =============================================================================
// B25 — gap-list pagination + byte budget. test_coverage_gaps returned the full
// gap list unbounded; on a large org it serialized near the global ~45 KB
// dispatch guard. It now pages (limit/offset) and byte-trims with a nextOffset
// cursor so the response is always usable.
// =============================================================================

/** Mirrors `MAX_RESPONSE_BYTES` (the global dispatch guard in index.ts). */
const GLOBAL_RESPONSE_GUARD_BYTES = 45_000;

/** A non-test class with no covering test -> an `uncovered` gap entry. */
const makeUncoveredClass = (i: number): Node =>
  makeNode({
    id: `ApexClass:Uncov_${String(i).padStart(4, '0')}`,
    apiName: `UncoveredService_${i}`,
    properties: { isTest: false, qualityIssues: [] },
  });

describe('testCoverageGapsHandler — pagination + byte budget (B25)', () => {
  const BULK = 250;
  let bulkDir: string;
  let bulkStore: GraphStore;
  let bulkCtx: Context;

  beforeAll(async () => {
    bulkDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-tcg-bulk-'));
    const opened = await openGraph(join(bulkDir, 'bulk.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    bulkStore = opened.value;
    const imp = await importExtractionResults(bulkStore, [
      {
        nodes: Array.from({ length: BULK }, (_unused, i) =>
          makeUncoveredClass(i),
        ),
        edges: [],
      },
    ]);
    if (!imp.ok) throw new Error(`seed import failed: ${imp.error.message}`);
    bulkCtx = {
      vaultRoot: bulkDir,
      manifest: FIXTURE_MANIFEST,
      graph: bulkStore,
    };
  });

  afterAll(async () => {
    await closeGraph(bulkStore);
    rmSync(bulkDir, { recursive: true, force: true });
  });

  it('keeps a default (no-arg) response under the global ~45 KB guard', async () => {
    const r = await testCoverageGapsHandler(bulkCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bytes = Buffer.byteLength(JSON.stringify(r.value), 'utf8');
    expect(bytes).toBeLessThanOrEqual(GLOBAL_RESPONSE_GUARD_BYTES);
    const d = r.value.data;
    expect(d.totalGapsCount).toBe(BULK);
    expect(d.gaps.length).toBeGreaterThan(0);
    expect(d.gaps.length).toBeLessThan(BULK);
    expect(d.truncated).toBe(true);
    expect(d.nextOffset).toBe(d.gaps.length);
  });

  it('walks every gap once via the offset cursor and terminates', async () => {
    let offset = 0;
    let seen = 0;
    let guard = 0;
    for (;;) {
      const r = await testCoverageGapsHandler(bulkCtx, { offset });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.value.data;
      expect(d.offset).toBe(offset);
      seen += d.gaps.length;
      if (!d.truncated) break;
      expect(d.nextOffset).toBeGreaterThan(offset);
      offset = d.nextOffset as number;
      if (++guard > 5000) throw new Error('cursor did not terminate');
    }
    expect(seen).toBe(BULK);
  });

  it('honours an explicit small limit with a nextOffset cursor', async () => {
    const r = await testCoverageGapsHandler(bulkCtx, { limit: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.limit).toBe(5);
    expect(d.gaps.length).toBeLessThanOrEqual(5);
    expect(d.truncated).toBe(true);
    expect(d.nextOffset).toBe(d.gaps.length);
  });

  // CR-22: continuation cursor on the truncated page; walk it to cover all gaps.
  it('emits a nextCursor on the truncated page and walks every gap once via cursor', async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const r = await testCoverageGapsHandler(
        bulkCtx,
        cursor === undefined ? {} : { cursor },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.value.data;
      for (const g of d.gaps) seen.add(g.componentId);
      if (!d.truncated) {
        expect('nextCursor' in d).toBe(false);
        break;
      }
      expect(typeof d.nextCursor).toBe('string');
      expect(d.pageInfo?.nextCursor).toBe(d.nextCursor);
      cursor = d.nextCursor as string;
      if (++guard > 5000) throw new Error('cursor did not terminate');
    }
    expect(seen.size).toBe(BULK);
  });

  it('rejects a cursor replayed against a different query (added classFilter)', async () => {
    const first = await testCoverageGapsHandler(bulkCtx, { limit: 5 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cursor = first.value.data.nextCursor;
    expect(typeof cursor).toBe('string');
    const replay = await testCoverageGapsHandler(bulkCtx, {
      classFilter: ['ApexClass:Whatever'],
      cursor: cursor as string,
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.kind).toBe('invalid-query');
  });

  it('CR-22: in-budget whole-fits call emits NO cursor/pageInfo (byte-identical)', async () => {
    // The non-bulk small fixture (`ctx`) fits under the default limit.
    const r = await testCoverageGapsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.truncated).toBe(false);
    expect('nextCursor' in r.value.data).toBe(false);
    expect('pageInfo' in r.value.data).toBe(false);
  });
});

describe('testCoverageGapsHandler — QUALITY-SCAN-SKIPS-TRIGGERS-AND-FLOWS', () => {
  let localDir: string;
  let localStore: GraphStore;
  let localCtx: Context;

  beforeAll(async () => {
    localDir = mkdtempSync(join(tmpdir(), 'sfi-tcg-unscanned-'));
    const opened = await openGraph(join(localDir, 'graph.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    localStore = opened.value;
    const imported = await importExtractionResults(localStore, [
      {
        nodes: [
          // A production class, covered by a test class that was NEVER scanned.
          makeNode({ id: 'ApexClass:Prod', apiName: 'Prod' }),
          makeNode({
            id: 'ApexClass:ProdTest',
            apiName: 'ProdTest',
            // `isTest` but no `qualityIssues` KEY: the fake-assertion
            // recognizer never ran over it, so it can never raise a finding
            // and `Prod` is silently classified as adequately covered.
            properties: { isTest: true },
          }),
        ],
        edges: [
          makeEdge({
            fromId: 'ApexClass:ProdTest',
            toId: 'ApexClass:Prod',
            edgeType: 'callsApex',
          }),
        ],
      },
    ]);
    if (!imported.ok) throw new Error(imported.error.message);
    localCtx = {
      vaultRoot: localDir,
      manifest: FIXTURE_MANIFEST,
      graph: localStore,
    };
  });

  afterAll(async () => {
    await closeGraph(localStore);
    rmSync(localDir, { recursive: true, force: true });
  });

  it('a zero-gap answer built on UNSCANNED test classes says so', async () => {
    const r = await testCoverageGapsHandler(localCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // No gaps — which is exactly the shape the defect produced.
    expect(r.value.data.gaps).toEqual([]);
    expect(r.value.data.qualityScanCoverage).toEqual([
      { type: 'ApexClass', nodes: 1, scanned: 0 },
    ]);
    expect(r.value.data.boundaries.join(' ')).toContain(
      'NOT SCANNED IN THIS VAULT',
    );
  });
});

// =============================================================================
// D-1 — coverage is a USAGE walk, not a `callsApex` walk. Measured on this org,
// 20 of the 46 classes reported `uncovered` had an incoming edge from an
// @isTest class; 11 of those were `dispatchesAsync` at `declared` confidence —
// a batch class enqueued by its own test with `Database.executeBatch`.
// =============================================================================
describe('testCoverageGapsHandler — coverage through non-callsApex usage edges', () => {
  const withStore = async <T>(
    seedData: ExtractionResult,
    run: (ctx: Context) => Promise<T>,
  ): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-tcg-usage-'));
    const opened = await openGraph(join(dir, 'tcg.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    const st = opened.value;
    const imported = await importExtractionResults(st, [seedData]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    const out = await run({ vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: st } as Context);
    await closeGraph(st);
    rmSync(dir, { recursive: true, force: true });
    return out;
  };

  const FAKE = [
    { rule: 'fake-assertion', severity: 'medium', location: 'line 12', explanation: 'tautology', confidence: 'heuristic' },
  ];

  /**
   * NightlyPurgeJobTest --dispatchesAsync(declared, executeBatch)--> NightlyPurgeJob.
   * The test carries a fake assertion so the class is a REPORTED gap either way;
   * what changes is whether it is reported as `uncovered` (nothing reaches it)
   * or as a coverage-quality gap (a test does reach it).
   */
  const seedAsyncCoverage: ExtractionResult = {
    nodes: [
      makeNode({ id: 'ApexClass:NightlyPurgeJob', apiName: 'NightlyPurgeJob', properties: { isTest: false, isBatchable: true, qualityIssues: [] } }),
      makeNode({ id: 'ApexClass:NightlyPurgeJobTest', apiName: 'NightlyPurgeJobTest', properties: { isTest: true, qualityIssues: FAKE } }),
    ],
    edges: [
      makeEdge({
        fromId: 'ApexClass:NightlyPurgeJobTest',
        toId: 'ApexClass:NightlyPurgeJob',
        edgeType: 'dispatchesAsync',
        confidence: 'declared',
        properties: { dispatchMechanism: 'executeBatch' },
      }),
    ],
  };

  it('a class enqueued by its own test via dispatchesAsync is NOT uncovered', async () => {
    const r = await withStore(seedAsyncCoverage, (c) => testCoverageGapsHandler(c, {}));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const gap = r.value.data.gaps.find((g) => g.componentId === 'ApexClass:NightlyPurgeJob');
    expect(gap).toBeDefined();
    expect(gap?.coverageStatus).not.toBe('uncovered');
    expect(gap?.coveringTestClassIds).toContain('ApexClass:NightlyPurgeJobTest');
  });

  it('the covering entry carries the EVIDENCE — declared confidence via dispatchesAsync', async () => {
    const r = await withStore(seedAsyncCoverage, (c) => testCoverageGapsHandler(c, {}));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const gap = r.value.data.gaps.find((g) => g.componentId === 'ApexClass:NightlyPurgeJob');
    const cover = gap?.coveringTestClasses.find((t) => t.id === 'ApexClass:NightlyPurgeJobTest');
    expect(cover?.confidence).toBe('declared');
    expect(cover?.viaEdgeTypes).toEqual(['dispatchesAsync']);
    expect(cover?.depth).toBe(1);
  });

  it('an uncovered verdict names the edge types it WALKED, so the absence is checked', async () => {
    const r = await withStore(
      {
        nodes: [
          makeNode({ id: 'ApexClass:OrphanHelper', apiName: 'OrphanHelper', properties: { isTest: false, qualityIssues: [] } }),
          makeNode({ id: 'ApexClass:UnrelatedTest', apiName: 'UnrelatedTest', properties: { isTest: true, qualityIssues: FAKE } }),
        ],
        edges: [],
      },
      (c) => testCoverageGapsHandler(c, {}),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const gap = r.value.data.gaps.find((g) => g.componentId === 'ApexClass:OrphanHelper');
    expect(gap?.coverageStatus).toBe('uncovered');
    expect(gap?.walkedEdgeTypes).toContain('dispatchesAsync');
    expect(gap?.walkedEdgeTypes).not.toContain('grantedBy');
    expect(gap?.recommendedAction).toContain('through any usage edge within depth 3');
    expect(gap?.recommendedAction).not.toContain('via callsApex');
  });

  it('a grantedBy edge from a test class is NOT coverage — access is not usage', async () => {
    const r = await withStore(
      {
        nodes: [
          makeNode({ id: 'ApexClass:OrphanHelper', apiName: 'OrphanHelper', properties: { isTest: false, qualityIssues: [] } }),
          makeNode({ id: 'ApexClass:GrantingTest', apiName: 'GrantingTest', properties: { isTest: true, qualityIssues: FAKE } }),
        ],
        edges: [
          makeEdge({ fromId: 'ApexClass:GrantingTest', toId: 'ApexClass:OrphanHelper', edgeType: 'grantedBy', confidence: 'declared' }),
        ],
      },
      (c) => testCoverageGapsHandler(c, {}),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const gap = r.value.data.gaps.find((g) => g.componentId === 'ApexClass:OrphanHelper');
    expect(gap?.coverageStatus).toBe('uncovered');
  });
});

// =============================================================================
// FIX 6 / D-3 — `gaps: []` is the FALSE-CLEAN shape for this tool: it is what a
// genuinely well-tested org returns AND what a shallow walk, a dynamic-dispatch
// blind spot, or an unscanned test roster returns. Gating the three
// scanner-behaviour disclosures on `sorted.length > 0` silenced them exactly
// there. This fixture is the honest clean case: one production class, one
// SCANNED test class that calls it with no fake assertion → zero gaps.
// =============================================================================
describe('testCoverageGapsHandler — FIX 6 clean-scan disclosure', () => {
  let cleanDir: string;
  let cleanStore: GraphStore;
  let cleanCtx: Context;

  beforeAll(async () => {
    cleanDir = mkdtempSync(join(tmpdir(), 'sfi-tcg-clean-'));
    const opened = await openGraph(join(cleanDir, 'tcg-clean.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    cleanStore = opened.value;
    const imported = await importExtractionResults(cleanStore, [
      {
        nodes: [
          makeNode({
            id: 'ApexClass:WidgetService',
            apiName: 'WidgetService',
            properties: { isTest: false, qualityIssues: [] },
          }),
          makeNode({
            id: 'ApexClass:WidgetServiceTest',
            apiName: 'WidgetServiceTest',
            // SCANNED (`qualityIssues` KEY present) and free of
            // `fake-assertion` — so `WidgetService` is genuinely not a gap.
            properties: { isTest: true, qualityIssues: [] },
          }),
        ],
        edges: [
          makeEdge({
            fromId: 'ApexClass:WidgetServiceTest',
            toId: 'ApexClass:WidgetService',
            edgeType: 'callsApex',
          }),
        ],
      },
    ]);
    if (!imported.ok) throw new Error(imported.error.message);
    cleanCtx = {
      vaultRoot: cleanDir,
      manifest: FIXTURE_MANIFEST,
      graph: cleanStore,
    };
  });

  afterAll(async () => {
    await closeGraph(cleanStore);
    rmSync(cleanDir, { recursive: true, force: true });
  });

  it('FAIL-BEFORE/PASS-AFTER: a zero-gap scan comes back with populated boundaries', async () => {
    const r = await testCoverageGapsHandler(cleanCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.gaps).toEqual([]);
    expect(r.value.data.totalGapsCount).toBe(0);
    // PRE-FIX: `boundaries` was `[]` on exactly this shape.
    expect(r.value.data.boundaries.length).toBeGreaterThan(0);
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).toMatch(/meaningful-assertion|System\.assertEquals/i);
    expect(joined).toMatch(/dynamic dispatch|Type\.forName/i);
    expect(joined).toMatch(/depth 3|capped at depth/i);
  });

  it('a zero-gap scan proves the test roster was READ: census present, nodes === scanned', async () => {
    const r = await testCoverageGapsHandler(cleanCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.qualityScanCoverage).toEqual([
      { type: 'ApexClass', nodes: 1, scanned: 1 },
    ]);
    expect(r.value.data.boundaries.join(' ')).not.toContain(
      'NOT SCANNED IN THIS VAULT',
    );
  });
});
