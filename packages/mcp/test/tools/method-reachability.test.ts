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
  methodReachabilityHandler,
  methodReachabilityInputSchema,
} from '../../src/tools/method-reachability.js';

import { measureGraphQueries } from './_graph-query-budget.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-28T09:12:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-mr',
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
  confidence: 'heuristic',
  source: 'apex-scanner',
  properties: {},
  ...overrides,
});

const seed: ExtractionResult = {
  nodes: [
    // Trigger-reachable target (entry-point-reachable).
    makeNode({
      id: 'ApexClass:TriggerReachable',
      apiName: 'TriggerReachable',
      properties: { isTest: false },
    }),
    makeNode({
      id: 'ApexTrigger:AccountTrigger',
      type: 'ApexTrigger',
      apiName: 'AccountTrigger',
      properties: {},
    }),
    // REST-reachable target.
    makeNode({
      id: 'ApexClass:RestReachable',
      apiName: 'RestReachable',
      properties: { isTest: false },
    }),
    makeNode({
      id: 'ApexClass:MyRestEndpoint',
      apiName: 'MyRestEndpoint',
      properties: { isRestResource: true, isTest: false },
    }),
    // Aura-reachable target.
    makeNode({
      id: 'ApexClass:AuraReachable',
      apiName: 'AuraReachable',
      properties: { isTest: false },
    }),
    makeNode({
      id: 'ApexClass:MyAuraController',
      apiName: 'MyAuraController',
      properties: { hasAuraEnabledMethod: true, isTest: false },
    }),
    // Invocable-reachable target.
    makeNode({
      id: 'ApexClass:InvocableReachable',
      apiName: 'InvocableReachable',
      properties: { isTest: false },
    }),
    makeNode({
      id: 'ApexClass:MyInvocable',
      apiName: 'MyInvocable',
      properties: { hasInvocableMethod: true, isTest: false },
    }),
    // Queueable-reachable target.
    makeNode({
      id: 'ApexClass:QueueableReachable',
      apiName: 'QueueableReachable',
      properties: { isTest: false },
    }),
    makeNode({
      id: 'ApexClass:MyQueueable',
      apiName: 'MyQueueable',
      properties: { isQueueable: true, isTest: false },
    }),
    // Test-only reachable.
    makeNode({
      id: 'ApexClass:TestOnlyReachable',
      apiName: 'TestOnlyReachable',
      properties: { isTest: false },
    }),
    makeNode({
      id: 'ApexClass:OnlyMyTest',
      apiName: 'OnlyMyTest',
      properties: { isTest: true },
    }),
    // Dead code — no callers at all.
    makeNode({
      id: 'ApexClass:LikelyDead',
      apiName: 'LikelyDead',
      properties: { isTest: false },
    }),
    // The target itself is the entry point.
    makeNode({
      id: 'ApexClass:SelfRest',
      apiName: 'SelfRest',
      properties: { isRestResource: true, isTest: false },
    }),
  ],
  edges: [
    makeEdge({
      fromId: 'ApexTrigger:AccountTrigger',
      toId: 'ApexClass:TriggerReachable',
      edgeType: 'callsApex',
    }),
    makeEdge({
      fromId: 'ApexClass:MyRestEndpoint',
      toId: 'ApexClass:RestReachable',
      edgeType: 'callsApex',
    }),
    makeEdge({
      fromId: 'ApexClass:MyAuraController',
      toId: 'ApexClass:AuraReachable',
      edgeType: 'callsApex',
    }),
    makeEdge({
      fromId: 'ApexClass:MyInvocable',
      toId: 'ApexClass:InvocableReachable',
      edgeType: 'callsApex',
    }),
    makeEdge({
      fromId: 'ApexClass:MyQueueable',
      toId: 'ApexClass:QueueableReachable',
      edgeType: 'callsApex',
    }),
    makeEdge({
      fromId: 'ApexClass:OnlyMyTest',
      toId: 'ApexClass:TestOnlyReachable',
      edgeType: 'callsApex',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-mr-'));
  const opened = await openGraph(join(tempDir, 'mr.db'));
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

describe('methodReachabilityHandler', () => {
  it('classifies a trigger-reachable class as entry-point-reachable', async () => {
    const r = await methodReachabilityHandler(ctx, {
      classApiName: 'ApexClass:TriggerReachable',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('entry-point-reachable');
    const kinds = r.value.data.entryPoints.map((e) => e.kind);
    expect(kinds).toContain('apex-trigger');
  });

  it('classifies a REST-reachable class as entry-point-reachable with rest-resource kind', async () => {
    const r = await methodReachabilityHandler(ctx, {
      classApiName: 'ApexClass:RestReachable',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('entry-point-reachable');
    expect(r.value.data.entryPoints.map((e) => e.kind)).toContain(
      'rest-resource',
    );
  });

  it('classifies an Aura-reachable class as entry-point-reachable with aura-enabled kind', async () => {
    const r = await methodReachabilityHandler(ctx, {
      classApiName: 'ApexClass:AuraReachable',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('entry-point-reachable');
    expect(r.value.data.entryPoints.map((e) => e.kind)).toContain(
      'aura-enabled',
    );
  });

  it('classifies an invocable-reachable class with invocable kind', async () => {
    const r = await methodReachabilityHandler(ctx, {
      classApiName: 'ApexClass:InvocableReachable',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('entry-point-reachable');
    expect(r.value.data.entryPoints.map((e) => e.kind)).toContain('invocable');
  });

  it('classifies a queueable-reachable class with queueable kind', async () => {
    const r = await methodReachabilityHandler(ctx, {
      classApiName: 'ApexClass:QueueableReachable',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('entry-point-reachable');
    expect(r.value.data.entryPoints.map((e) => e.kind)).toContain('queueable');
  });

  it('classifies a test-only-reachable class accordingly', async () => {
    const r = await methodReachabilityHandler(ctx, {
      classApiName: 'ApexClass:TestOnlyReachable',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('test-only-reachable');
    expect(r.value.data.entryPoints.length).toBe(0);
    expect(r.value.data.reachingTestClasses.length).toBe(1);
    expect(r.value.data.reachingTestClasses[0]?.id).toBe(
      'ApexClass:OnlyMyTest',
    );
  });

  it('classifies a class with no callers as likely-dead-code', async () => {
    const r = await methodReachabilityHandler(ctx, {
      classApiName: 'ApexClass:LikelyDead',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('likely-dead-code');
    expect(r.value.data.entryPoints.length).toBe(0);
    expect(r.value.data.reachingTestClasses.length).toBe(0);
  });

  it('recognises the root itself as an entry point when its classifiers fire', async () => {
    const r = await methodReachabilityHandler(ctx, {
      classApiName: 'ApexClass:SelfRest',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('entry-point-reachable');
    const selfHit = r.value.data.entryPoints.find(
      (e) => e.id === 'ApexClass:SelfRest',
    );
    expect(selfHit).toBeDefined();
    expect(selfHit?.depth).toBe(0);
    expect(selfHit?.kind).toBe('rest-resource');
  });

  it('surfaces the verbatim disclosure', async () => {
    const r = await methodReachabilityHandler(ctx, {
      classApiName: 'ApexClass:TriggerReachable',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disclosure).toMatch(/Type\.forName/);
    expect(r.value.data.disclosure).toMatch(/CLASS granularity/);
  });

  it('rejects a non-Apex prefix with invalid-query', async () => {
    const r = await methodReachabilityHandler(ctx, {
      classApiName: 'CustomField:Account.Industry__c',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('returns component-not-found for an unknown class', async () => {
    const r = await methodReachabilityHandler(ctx, {
      classApiName: 'ApexClass:NotInGraph',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });
});

describe('methodReachabilityInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    expect(
      methodReachabilityInputSchema.safeParse({ classApiName: 'ApexClass:X' })
        .success,
    ).toBe(true);
  });

  it('rejects empty classApiName', () => {
    expect(
      methodReachabilityInputSchema.safeParse({ classApiName: '' }).success,
    ).toBe(false);
  });
});

// =============================================================================
// N+1 query budget (finding #6a). `upstreamWalk`'s per-frontier-node
// `listEdges` AND the per-discovered-node `getNodeById` classifier loop were
// batched through `listEdgesForNodes` / `listNodesByIds`. The query count must
// scale with the walk DEPTH, NEVER frontier WIDTH. A golden-output assertion
// over a two-hop upstream fixture (trigger + REST entry point at different
// depths, plus a reaching test class) locks the batched result byte-for-byte
// against the pre-batch output captured before the change.
// =============================================================================
describe('methodReachabilityHandler — bounded graph queries (transitive)', () => {
  const withStore = async <T>(
    seedData: ExtractionResult,
    run: (ctx: Context, s: GraphStore) => Promise<T>,
  ): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-mr-budget-'));
    const opened = await openGraph(join(dir, 'mr.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    const s = opened.value;
    const imported = await importExtractionResults(s, [seedData]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    const localCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s } as Context;
    const out = await run(localCtx, s);
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });
    return out;
  };

  // RestTop --calls--> MidCaller --calls--> Target (two-hop upstream), a
  // Trigger directly into Target (entry point at depth 1), and a TestClass
  // directly into Target. Exercises multi-hop discovery, entry points at
  // different depths, and a reaching test class in one shot.
  const goldenSeed: ExtractionResult = {
    nodes: [
      makeNode({ id: 'ApexClass:Target', apiName: 'Target', properties: { isTest: false } }),
      makeNode({ id: 'ApexClass:MidCaller', apiName: 'MidCaller', properties: { isTest: false } }),
      makeNode({
        id: 'ApexClass:RestTop',
        apiName: 'RestTop',
        properties: { isRestResource: true, isTest: false },
      }),
      makeNode({ id: 'ApexClass:TestClass', apiName: 'TestClass', properties: { isTest: true } }),
      makeNode({ id: 'ApexTrigger:Trig', type: 'ApexTrigger', apiName: 'Trig', properties: {} }),
    ],
    edges: [
      makeEdge({ fromId: 'ApexClass:MidCaller', toId: 'ApexClass:Target', edgeType: 'callsApex' }),
      makeEdge({ fromId: 'ApexClass:RestTop', toId: 'ApexClass:MidCaller', edgeType: 'callsApex' }),
      makeEdge({ fromId: 'ApexTrigger:Trig', toId: 'ApexClass:Target', edgeType: 'callsApex' }),
      makeEdge({ fromId: 'ApexClass:TestClass', toId: 'ApexClass:Target', edgeType: 'callsApex' }),
    ],
  };

  it('golden: the batched upstream reachability is byte-identical to the pre-batch output', async () => {
    const result = await withStore(goldenSeed, (localCtx) =>
      methodReachabilityHandler(localCtx, { classApiName: 'ApexClass:Target' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Captured from the pre-batch handler on this exact fixture.
    expect(result.value.data).toEqual({
      classApiName: 'ApexClass:Target',
      verdict: 'entry-point-reachable',
      entryPoints: [
        { id: 'ApexTrigger:Trig', apiName: 'Trig', kind: 'apex-trigger', depth: 1 },
        { id: 'ApexClass:RestTop', apiName: 'RestTop', kind: 'rest-resource', depth: 2 },
      ],
      reachingTestClasses: [{ id: 'ApexClass:TestClass', apiName: 'TestClass', depth: 1 }],
      soundness: { complete: true, blindSpots: [], staticCoverage: 'full' },
      disclosure: result.value.data.disclosure,
    });
  });

  // Target has `width` direct callers (a wide frontier at depth 1); none are
  // entry points or tests. Depth is fixed; the query count is bounded by depth
  // (one listEdgesForNodes per BFS level + one listNodesByIds classifier
  // resolve + the target/soundness single-id fetches), not the caller count.
  const seedWideFrontier = (width: number): ExtractionResult => ({
    nodes: [
      makeNode({ id: 'ApexClass:Target', apiName: 'Target', properties: { isTest: false } }),
      ...Array.from({ length: width }, (_u, i) =>
        makeNode({ id: `ApexClass:Caller${i}`, apiName: `Caller${i}`, properties: { isTest: false } }),
      ),
    ],
    edges: Array.from({ length: width }, (_u, i) =>
      makeEdge({ fromId: `ApexClass:Caller${i}`, toId: 'ApexClass:Target', edgeType: 'callsApex' }),
    ),
  });

  it('query count is depth-bounded, NOT frontier-width-scaled (N=60 vs N=200)', async () => {
    const measure = (width: number) =>
      withStore(seedWideFrontier(width), (localCtx, s) =>
        measureGraphQueries(s, () =>
          methodReachabilityHandler(localCtx, { classApiName: 'ApexClass:Target' }),
        ),
      );
    const narrow = await measure(60);
    const wide = await measure(200);
    expect(narrow.result.ok).toBe(true);
    expect(wide.result.ok).toBe(true);
    // Flat: one listEdgesForNodes per BFS depth level + one listNodesByIds
    // classifier resolve + the single-id target/soundness fetches, NOT one
    // listEdges/getNodeById per caller. An N+1 would be ~2*width queries.
    expect(wide.edgeQueries).toBe(narrow.edgeQueries);
    expect(wide.nodeQueries).toBe(narrow.nodeQueries);
    expect(wide.edgeQueries + wide.nodeQueries).toBeLessThan(15);
  });
});
