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
});
