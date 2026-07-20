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
  testsForChangeHandler,
  testsForChangeInputSchema,
} from '../../src/tools/tests-for-change.js';

import { measureGraphQueries } from './_graph-query-budget.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-29T10:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-tfc',
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

// OrderServiceTest + SharedHelperTest call OrderService directly (depth 1).
// SharedHelperTest also calls PricingEngine (so it covers TWO changes).
// PricingEngineTest -> Mid -> PricingEngine (depth 2). RefundService has no
// covering test. OrderBatch is covered only via dispatchesAsync by BatchTest.
const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: 'ApexClass:OrderService', apiName: 'OrderService', properties: { isTest: false } }),
    makeNode({ id: 'ApexClass:PricingEngine', apiName: 'PricingEngine', properties: { isTest: false } }),
    makeNode({ id: 'ApexClass:Mid', apiName: 'Mid', properties: { isTest: false } }),
    makeNode({ id: 'ApexClass:RefundService', apiName: 'RefundService', properties: { isTest: false } }),
    makeNode({ id: 'ApexClass:OrderBatch', apiName: 'OrderBatch', properties: { isTest: false } }),
    makeNode({ id: 'ApexClass:OrderServiceTest', apiName: 'OrderServiceTest', properties: { isTest: true } }),
    makeNode({ id: 'ApexClass:SharedHelperTest', apiName: 'SharedHelperTest', properties: { isTest: true } }),
    makeNode({ id: 'ApexClass:PricingEngineTest', apiName: 'PricingEngineTest', properties: { isTest: true } }),
    makeNode({ id: 'ApexClass:BatchTest', apiName: 'BatchTest', properties: { isTest: true } }),
    // A test with a spurious edge INTO OrderServiceTest — must never be credited
    // with covering OrderService (it does not reference it).
    makeNode({ id: 'ApexClass:FabricatedTest', apiName: 'FabricatedTest', properties: { isTest: true } }),
  ],
  edges: [
    makeEdge({ fromId: 'ApexClass:OrderServiceTest', toId: 'ApexClass:OrderService', edgeType: 'callsApex' }),
    makeEdge({ fromId: 'ApexClass:SharedHelperTest', toId: 'ApexClass:OrderService', edgeType: 'callsApex' }),
    makeEdge({ fromId: 'ApexClass:SharedHelperTest', toId: 'ApexClass:PricingEngine', edgeType: 'callsApex' }),
    makeEdge({ fromId: 'ApexClass:Mid', toId: 'ApexClass:PricingEngine', edgeType: 'callsApex' }),
    makeEdge({ fromId: 'ApexClass:PricingEngineTest', toId: 'ApexClass:Mid', edgeType: 'callsApex' }),
    makeEdge({ fromId: 'ApexClass:BatchTest', toId: 'ApexClass:OrderBatch', edgeType: 'dispatchesAsync' }),
    // FABRICATION GUARD: a spurious incoming edge INTO a test node. OrderServiceTest
    // legitimately covers OrderService (depth 1). FabricatedTest has an edge into
    // OrderServiceTest — nothing legitimately calls a test, so the walk must NOT
    // traverse THROUGH OrderServiceTest and credit FabricatedTest with covering
    // OrderService. This mirrors the real ApplicationFormControllerTest ->
    // ApplicationSelector fabrication.
    makeEdge({ fromId: 'ApexClass:FabricatedTest', toId: 'ApexClass:OrderServiceTest', edgeType: 'callsApex' }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-tfc-'));
  const opened = await openGraph(join(tempDir, 'tfc.db'));
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

describe('testsForChangeHandler', () => {
  it('selects the direct covering tests for a single change', async () => {
    const r = await testsForChangeHandler(ctx, {
      changedComponents: ['ApexClass:OrderService'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.selectedTests.map((t) => t.id);
    expect(ids).toContain('ApexClass:OrderServiceTest');
    expect(ids).toContain('ApexClass:SharedHelperTest');
    const perChange = r.value.data.perChange.find((p) => p.id === 'ApexClass:OrderService');
    expect(perChange?.covered).toBe(true);
    expect(perChange?.isTest).toBe(false);
  });

  it('reaches a transitive test via the depth-3 walk', async () => {
    const r = await testsForChangeHandler(ctx, {
      changedComponents: ['ApexClass:PricingEngine'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const pet = r.value.data.selectedTests.find((t) => t.id === 'ApexClass:PricingEngineTest');
    expect(pet).toBeDefined();
    expect(pet?.minDepth).toBe(2);
  });

  it('selects a test that covers a batch class via dispatchesAsync', async () => {
    const r = await testsForChangeHandler(ctx, {
      changedComponents: ['ApexClass:OrderBatch'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.selectedTests.map((t) => t.id);
    expect(ids).toContain('ApexClass:BatchTest');
  });

  it('flags a changed class no test reaches as uncovered (unguarded)', async () => {
    const r = await testsForChangeHandler(ctx, {
      changedComponents: ['ApexClass:RefundService'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.uncoveredChanges).toContain('ApexClass:RefundService');
    expect(r.value.data.selectedTests.length).toBe(0);
    expect(r.value.data.summary.uncoveredCount).toBe(1);
    const perChange = r.value.data.perChange.find((p) => p.id === 'ApexClass:RefundService');
    expect(perChange?.covered).toBe(false);
  });

  it('dedupes a test covering multiple changes and records every change it covers', async () => {
    const r = await testsForChangeHandler(ctx, {
      changedComponents: ['ApexClass:OrderService', 'ApexClass:PricingEngine'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const shared = r.value.data.selectedTests.filter((t) => t.id === 'ApexClass:SharedHelperTest');
    expect(shared.length).toBe(1);
    expect(shared[0]?.coversChanges).toEqual([
      'ApexClass:OrderService',
      'ApexClass:PricingEngine',
    ]);
  });

  it('treats a changed test class as run-it-directly (depth 0, never uncovered)', async () => {
    const r = await testsForChangeHandler(ctx, {
      changedComponents: ['ApexClass:OrderServiceTest'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const perChange = r.value.data.perChange.find((p) => p.id === 'ApexClass:OrderServiceTest');
    expect(perChange?.isTest).toBe(true);
    expect(perChange?.covered).toBe(true);
    const sel = r.value.data.selectedTests.find((t) => t.id === 'ApexClass:OrderServiceTest');
    expect(sel?.minDepth).toBe(0);
    expect(r.value.data.uncoveredChanges).not.toContain('ApexClass:OrderServiceTest');
  });

  it('buckets a non-Apex id into unsupportedChanges without failing the batch', async () => {
    const r = await testsForChangeHandler(ctx, {
      changedComponents: ['CustomField:Account.Industry__c', 'ApexClass:OrderService'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.unsupportedChanges.map((u) => u.input)).toContain(
      'CustomField:Account.Industry__c',
    );
    // The Apex item is still analysed.
    expect(r.value.data.summary.apexAnalyzed).toBe(1);
    expect(r.value.data.selectedTests.length).toBeGreaterThan(0);
  });

  it('buckets a well-formed-but-absent Apex id into notFoundChanges', async () => {
    const r = await testsForChangeHandler(ctx, {
      changedComponents: ['ApexClass:GhostClass'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.notFoundChanges.map((n) => n.id)).toContain('ApexClass:GhostClass');
    expect(r.value.data.summary.notFoundCount).toBe(1);
  });

  it('dedupes a bare name against its prefixed id', async () => {
    const r = await testsForChangeHandler(ctx, {
      changedComponents: ['OrderService', 'ApexClass:OrderService'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.summary.apexAnalyzed).toBe(1);
  });

  it('returns selectedTests sorted by id ASC', async () => {
    const r = await testsForChangeHandler(ctx, {
      changedComponents: ['ApexClass:OrderService', 'ApexClass:PricingEngine', 'ApexClass:OrderBatch'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.selectedTests.map((t) => t.id);
    expect(ids).toEqual([...ids].sort());
  });

  it('does NOT credit a test reachable only by walking THROUGH another test (no fabricated path)', async () => {
    const r = await testsForChangeHandler(ctx, {
      changedComponents: ['ApexClass:OrderService'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.selectedTests.map((t) => t.id);
    // Legit direct covering tests are present...
    expect(ids).toContain('ApexClass:OrderServiceTest');
    expect(ids).toContain('ApexClass:SharedHelperTest');
    // ...but FabricatedTest, reachable only via a spurious edge INTO
    // OrderServiceTest, must NOT be counted (a test is a coverage sink).
    expect(ids).not.toContain('ApexClass:FabricatedTest');
    const perChange = r.value.data.perChange.find((p) => p.id === 'ApexClass:OrderService');
    expect(perChange?.coveringTests.map((c) => c.id)).not.toContain('ApexClass:FabricatedTest');
  });

  it('surfaces the verbatim honesty disclosure including the system-FLS / SECURITY_ENFORCED caveat', async () => {
    const r = await testsForChangeHandler(ctx, {
      changedComponents: ['ApexClass:OrderService'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disclosure).toMatch(/CLASS granularity/);
    expect(r.value.data.disclosure).toMatch(/depth 3/);
    expect(r.value.data.disclosure).toMatch(/UNGUARDED/);
    // Golden: selection ≠ validation, and .size() assertions cannot catch a
    // WITH SECURITY_ENFORCED regression because tests run with system FLS.
    expect(r.value.data.disclosure).toMatch(/SECURITY_ENFORCED/);
    expect(r.value.data.disclosure).toMatch(/system-context FLS/);
  });
});

// =============================================================================
// TESTS-FOR-CHANGE-REJECTS-NATURAL-COMPONENT-ARGS — the router ranks this tool
// #1 for change-impact NL but produced the natural single-component shape
// (`componentId` / `{ type, apiName }`) or a `review_change`-shaped object array,
// which the string[]-only schema hard-failed. The tool now accepts those and
// normalizes to the canonical string ids; the all-strings path is byte-identical
// and an object naming no component is a NAMED invalid-query.
// =============================================================================
describe('testsForChangeHandler — natural component selectors', () => {
  // Golden: the canonical string-array call — every alternate shape must produce
  // byte-identical `data` to this.
  const canonicalData = async () => {
    const parsed = testsForChangeInputSchema.parse({
      changedComponents: ['ApexClass:OrderService'],
    });
    const r = await testsForChangeHandler(ctx, parsed);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('canonical call failed');
    return r.value.data;
  };

  it('accepts a TOP-LEVEL componentId (folded into a one-item set), byte-identical to the array call', async () => {
    const parsed = testsForChangeInputSchema.parse({
      componentId: 'ApexClass:OrderService',
    });
    const r = await testsForChangeHandler(ctx, parsed);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data).toEqual(await canonicalData());
  });

  it('accepts a TOP-LEVEL { type, apiName } selector', async () => {
    const parsed = testsForChangeInputSchema.parse({
      type: 'ApexClass',
      apiName: 'OrderService',
    });
    const r = await testsForChangeHandler(ctx, parsed);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data).toEqual(await canonicalData());
  });

  it('accepts a review_change-shaped object array item ({ componentId, changeKind })', async () => {
    const parsed = testsForChangeInputSchema.parse({
      changedComponents: [
        { componentId: 'ApexClass:OrderService', changeKind: 'modified' },
      ],
    });
    const r = await testsForChangeHandler(ctx, parsed);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data).toEqual(await canonicalData());
  });

  it('accepts a { type, apiName, changeKind } object array item (changeKind ignored)', async () => {
    const parsed = testsForChangeInputSchema.parse({
      changedComponents: [
        { type: 'ApexClass', apiName: 'OrderService', changeKind: 'deleted' },
      ],
    });
    const r = await testsForChangeHandler(ctx, parsed);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data).toEqual(await canonicalData());
  });

  it('mixes string and object entries in one change set', async () => {
    const parsed = testsForChangeInputSchema.parse({
      changedComponents: [
        'ApexClass:OrderService',
        { componentId: 'ApexClass:PricingEngine' },
      ],
    });
    const r = await testsForChangeHandler(ctx, parsed);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.summary.apexAnalyzed).toBe(2);
  });
});

describe('testsForChangeInputSchema — natural selector normalization', () => {
  it('leaves an all-strings change set byte-identical (canonical path)', () => {
    const parsed = testsForChangeInputSchema.parse({
      changedComponents: ['ApexClass:OrderService', 'PricingEngine'],
    });
    expect(parsed).toEqual({
      changedComponents: ['ApexClass:OrderService', 'PricingEngine'],
    });
  });

  it('normalizes an object array item to its Type:ApiName string id', () => {
    const parsed = testsForChangeInputSchema.parse({
      changedComponents: [{ type: 'ApexClass', apiName: 'OrderService' }],
    });
    expect(parsed).toEqual({ changedComponents: ['ApexClass:OrderService'] });
  });

  it('componentId wins over { type, apiName } in a single object entry', () => {
    const parsed = testsForChangeInputSchema.parse({
      changedComponents: [
        { componentId: 'ApexClass:Winner', type: 'ApexClass', apiName: 'Loser' },
      ],
    });
    expect(parsed).toEqual({ changedComponents: ['ApexClass:Winner'] });
  });

  it('folds a top-level componentId into a one-item change set', () => {
    const parsed = testsForChangeInputSchema.parse({
      componentId: 'ApexTrigger:AccountTrigger',
    });
    expect(parsed).toEqual({ changedComponents: ['ApexTrigger:AccountTrigger'] });
  });

  it('rejects an object entry that names no component with a NAMED message', () => {
    const parsed = testsForChangeInputSchema.safeParse({
      changedComponents: [{ changeKind: 'modified' }],
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const joined = parsed.error.issues.map((i) => i.message).join(' ');
    expect(joined).toMatch(/componentId|type.*apiName/);
  });

  it('rejects a call with neither changedComponents nor a top-level selector', () => {
    expect(testsForChangeInputSchema.safeParse({}).success).toBe(false);
  });
});

describe('testsForChangeInputSchema', () => {
  it('accepts a well-formed change set', () => {
    expect(
      testsForChangeInputSchema.safeParse({ changedComponents: ['ApexClass:X'] }).success,
    ).toBe(true);
  });

  it('rejects an empty array', () => {
    expect(
      testsForChangeInputSchema.safeParse({ changedComponents: [] }).success,
    ).toBe(false);
  });

  it('rejects an empty-string item', () => {
    expect(
      testsForChangeInputSchema.safeParse({ changedComponents: [''] }).success,
    ).toBe(false);
  });
});

// =============================================================================
// N+1 query budget (finding C-1). upstreamWalk issued one `listEdges` per
// (frontier node x edge type); it now issues ONE `listEdgesForNodes` (both
// COVERAGE_EDGE_TYPES) per DEPTH LEVEL. The edge-query count must scale with
// DEPTH, never frontier WIDTH. Plus a golden-output assertion over a multi-
// level coverage tree with a test-sink and a dispatchesAsync relay — the
// edge-type ordering + test-sink + visited dedup are exactly where a silent
// output shift could hide.
// =============================================================================
describe('testsForChangeHandler — bounded graph queries (BFS)', () => {
  const withStore = async <T>(
    seed: ExtractionResult,
    run: (ctx: Context, s: GraphStore) => Promise<T>,
  ): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-tfc-budget-'));
    const opened = await openGraph(join(dir, 'tfc.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    const s = opened.value;
    const imported = await importExtractionResults(s, [seed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    const localCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s } as Context;
    const out = await run(localCtx, s);
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });
    return out;
  };

  // Coverage tree upstream of Service:
  //   Controller --callsApex--> Service         (relay, depth 1)
  //   Helper     --dispatchesAsync--> Service    (async relay, depth 1)
  //   ServiceTest --callsApex--> Service (isTest) (sink, depth 1)
  //   ControllerTest --callsApex--> Controller (isTest) (sink, depth 2)
  //   HelperTest --callsApex--> Helper (isTest)  (sink, depth 2)
  const goldenSeed: ExtractionResult = {
    nodes: [
      makeNode({ id: 'ApexClass:Service', apiName: 'Service' }),
      makeNode({ id: 'ApexClass:Controller', apiName: 'Controller' }),
      makeNode({ id: 'ApexClass:Helper', apiName: 'Helper' }),
      makeNode({ id: 'ApexClass:ServiceTest', apiName: 'ServiceTest', properties: { isTest: true } }),
      makeNode({ id: 'ApexClass:ControllerTest', apiName: 'ControllerTest', properties: { isTest: true } }),
      makeNode({ id: 'ApexClass:HelperTest', apiName: 'HelperTest', properties: { isTest: true } }),
    ],
    edges: [
      makeEdge({ fromId: 'ApexClass:Controller', toId: 'ApexClass:Service', edgeType: 'callsApex' }),
      makeEdge({ fromId: 'ApexClass:Helper', toId: 'ApexClass:Service', edgeType: 'dispatchesAsync' }),
      makeEdge({ fromId: 'ApexClass:ServiceTest', toId: 'ApexClass:Service', edgeType: 'callsApex' }),
      makeEdge({ fromId: 'ApexClass:ControllerTest', toId: 'ApexClass:Controller', edgeType: 'callsApex' }),
      makeEdge({ fromId: 'ApexClass:HelperTest', toId: 'ApexClass:Helper', edgeType: 'callsApex' }),
    ],
  };

  it('golden: the coverage-tree selection is unchanged by batching', async () => {
    const result = await withStore(goldenSeed, (localCtx) =>
      testsForChangeHandler(localCtx, { changedComponents: ['ApexClass:Service'] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.selectedTests).toEqual([
      { id: 'ApexClass:ControllerTest', apiName: 'ControllerTest', minDepth: 2, coversChanges: ['ApexClass:Service'] },
      { id: 'ApexClass:HelperTest', apiName: 'HelperTest', minDepth: 2, coversChanges: ['ApexClass:Service'] },
      { id: 'ApexClass:ServiceTest', apiName: 'ServiceTest', minDepth: 1, coversChanges: ['ApexClass:Service'] },
    ]);
    expect(d.uncoveredChanges).toEqual([]);
    expect(d.perChange).toHaveLength(1);
    expect(d.perChange[0]?.id).toBe('ApexClass:Service');
    expect(d.perChange[0]?.covered).toBe(true);
    // coveringTests is sorted by (depth ASC, id ASC): the direct test first,
    // then the two depth-2 relayed tests.
    expect(d.perChange[0]?.coveringTests).toEqual([
      { id: 'ApexClass:ServiceTest', apiName: 'ServiceTest', depth: 1 },
      { id: 'ApexClass:ControllerTest', apiName: 'ControllerTest', depth: 2 },
      { id: 'ApexClass:HelperTest', apiName: 'HelperTest', depth: 2 },
    ]);
  });

  // Service has `width` direct non-test callers (a wide frontier at depth 1),
  // each of which has no further callers (depth 2 empty). Depth is fixed; the
  // edge-query count is one batched fetch per depth level, so it must be FLAT.
  const seedWideFrontier = (width: number): ExtractionResult => ({
    nodes: [
      makeNode({ id: 'ApexClass:Service', apiName: 'Service' }),
      ...Array.from({ length: width }, (_u, i) =>
        makeNode({ id: `ApexClass:Caller${i}`, apiName: `Caller${i}`, properties: { isTest: true } }),
      ),
    ],
    edges: Array.from({ length: width }, (_u, i) =>
      makeEdge({ fromId: `ApexClass:Caller${i}`, toId: 'ApexClass:Service', edgeType: 'callsApex' }),
    ),
  });

  it('edge-query count does NOT scale with frontier width', async () => {
    const measure = (width: number) =>
      withStore(seedWideFrontier(width), (localCtx, s) =>
        measureGraphQueries(s, () =>
          testsForChangeHandler(localCtx, { changedComponents: ['ApexClass:Service'] }),
        ),
      );
    const narrow = await measure(60);
    const wide = await measure(200);
    expect(narrow.result.ok).toBe(true);
    expect(wide.result.ok).toBe(true);
    // Flat: one listEdgesForNodes per depth level, NOT one per (node x edgeType).
    // An N+1 would be ~2 * width edge queries.
    expect(wide.edgeQueries).toBe(narrow.edgeQueries);
    expect(wide.edgeQueries).toBeLessThan(10);
  });
});
