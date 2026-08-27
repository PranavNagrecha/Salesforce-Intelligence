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
import { USAGE_EDGE_TYPES } from '../../src/tools/apex-reachability.js';
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

/**
 * SOUNDNESS-UNSCANNED-READS-AS-CLEAN (fixture side).
 *
 * `soundness.ts` now distinguishes three states on an Apex node: carries the
 * `dynamic-apex` signal, was SCANNED and is clean (`qualityIssues: []`), and
 * was NEVER SCANNED (no such property). Absence means unscanned, because the
 * extractor's contract is that the property is always present on a scanned
 * node — so a result over unscanned Apex can no longer be reported `complete`.
 *
 * These fixtures predate that distinction and left `properties` empty, which
 * now reads as "never scanned" and correctly downgrades coverage. Every test
 * here means a CLEAN Apex component, so the fixture says so explicitly rather
 * than the assertions being relaxed. A test that wants the unscanned case sets
 * `properties` itself and this default steps aside.
 */
const withScanDefault = (node: Node): Node =>
  (node.type === 'ApexClass' || node.type === 'ApexTrigger') &&
  !('qualityIssues' in (node.properties as Record<string, unknown>))
    ? { ...node, properties: { ...node.properties, qualityIssues: [] } }
    : node;

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node =>
  withScanDefault({
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

  // GUARD (METHOD-REACHABILITY-REJECTS-COMPONENTID): pre-fix `componentId` /
  // `apiName` were Zod-stripped → `classApiName: Required`. Post-fix all three
  // resolve to the same target, echo `appliedScope`, and return byte-identical
  // verdict/entryPoints.
  it('componentId ≡ apiName ≡ classApiName (byte-equal + appliedScope)', async () => {
    const viaClassApiName = await methodReachabilityHandler(ctx, {
      classApiName: 'ApexClass:TriggerReachable',
    });
    const viaComponentId = await methodReachabilityHandler(ctx, {
      componentId: 'ApexClass:TriggerReachable',
    });
    const viaApiName = await methodReachabilityHandler(ctx, {
      apiName: 'TriggerReachable',
    });
    expect(viaClassApiName.ok && viaComponentId.ok && viaApiName.ok).toBe(true);
    if (!viaClassApiName.ok || !viaComponentId.ok || !viaApiName.ok) return;
    expect(viaClassApiName.value.data.appliedScope).toEqual({
      component: 'ApexClass:TriggerReachable',
      mode: 'component',
    });
    for (const alt of [viaComponentId, viaApiName]) {
      expect(alt.value.data).toEqual(viaClassApiName.value.data);
    }
  });

  it('disagreeing class selectors → invalid-query (never a silent pick)', async () => {
    const r = await methodReachabilityHandler(ctx, {
      classApiName: 'ApexClass:TriggerReachable',
      componentId: 'ApexClass:RestReachable',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
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

  it('accepts componentId / apiName as the target selector', () => {
    expect(
      methodReachabilityInputSchema.safeParse({ componentId: 'ApexClass:X' })
        .success,
    ).toBe(true);
    expect(
      methodReachabilityInputSchema.safeParse({ apiName: 'X' }).success,
    ).toBe(true);
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
    // Captured from the pre-batch handler on this exact fixture (+ appliedScope
    // echo added by METHOD-REACHABILITY-REJECTS-COMPONENTID). The verdict, the
    // entry-point SET, their kinds and depths, and the reaching test class are
    // the pre-batch values UNCHANGED — that is the invariant this golden
    // guards. `confidence` / `viaEdgeTypes` / `walkedEdgeTypes` are additive:
    // the walk now covers the full usage set instead of `callsApex` alone, and
    // says so per hit. Every fixture edge here is `callsApex` at `heuristic`,
    // so the WALK RESULT itself is identical — only the reporting is richer.
    expect(result.value.data).toEqual({
      appliedScope: { component: 'ApexClass:Target', mode: 'component' },
      classApiName: 'ApexClass:Target',
      verdict: 'entry-point-reachable',
      entryPoints: [
        {
          id: 'ApexTrigger:Trig',
          apiName: 'Trig',
          kind: 'apex-trigger',
          depth: 1,
          confidence: 'heuristic',
          viaEdgeTypes: ['callsApex'],
        },
        {
          id: 'ApexClass:RestTop',
          apiName: 'RestTop',
          kind: 'rest-resource',
          depth: 2,
          confidence: 'heuristic',
          viaEdgeTypes: ['callsApex'],
        },
      ],
      reachingTestClasses: [
        {
          id: 'ApexClass:TestClass',
          apiName: 'TestClass',
          depth: 1,
          confidence: 'heuristic',
          viaEdgeTypes: ['callsApex'],
        },
      ],
      walkedEdgeTypes: USAGE_EDGE_TYPES,
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

// =============================================================================
// D-1 / D-2 — the usage DENY-list and per-edge confidence. These are the
// fail-before/pass-after pins for the `edgeTypes: ['callsApex']` allow-list
// defect: 75 of this org's 77 @isTest classes had zero incoming callsApex and
// read as `likely-dead-code`, and 38 of the 42 non-test classes with no
// incoming callsApex had an incoming `references` or `dispatchesAsync`.
// =============================================================================
describe('methodReachabilityHandler — usage edge set (D-1) and path confidence (D-2)', () => {
  const withStore = async <T>(
    seedData: ExtractionResult,
    run: (ctx: Context) => Promise<T>,
  ): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-mr-usage-'));
    const opened = await openGraph(join(dir, 'mr.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    const s = opened.value;
    const imported = await importExtractionResults(s, [seedData]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    const out = await run({ vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s } as Context);
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });
    return out;
  };

  it('an @isTest class with ZERO in-edges is entry-point-reachable, not likely-dead-code', async () => {
    // The test RUNNER is its entry point. Nothing calls a test class, which is
    // why the callsApex-only walk called almost every one of them dead.
    const r = await withStore(
      {
        nodes: [
          makeNode({ id: 'ApexClass:WidgetServiceTest', apiName: 'WidgetServiceTest', properties: { isTest: true } }),
        ],
        edges: [],
      },
      (c) => methodReachabilityHandler(c, { classApiName: 'ApexClass:WidgetServiceTest' }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('entry-point-reachable');
    expect(r.value.data.entryPoints).toHaveLength(1);
    expect(r.value.data.entryPoints[0]?.kind).toBe('test-class');
    expect(r.value.data.entryPoints[0]?.depth).toBe(0);
  });

  it('a class reached ONLY by dispatchesAsync is entry-point-reachable, not dead', async () => {
    const r = await withStore(
      {
        nodes: [
          makeNode({ id: 'ApexClass:NightlyPurgeJob', apiName: 'NightlyPurgeJob', properties: { isTest: false, isBatchable: true } }),
          makeNode({ id: 'ApexClass:PurgeScheduler', apiName: 'PurgeScheduler', properties: { isTest: false, isSchedulable: true } }),
        ],
        edges: [
          makeEdge({
            fromId: 'ApexClass:PurgeScheduler',
            toId: 'ApexClass:NightlyPurgeJob',
            edgeType: 'dispatchesAsync',
            confidence: 'declared',
            properties: { dispatchMechanism: 'executeBatch' },
          }),
        ],
      },
      (c) => methodReachabilityHandler(c, { classApiName: 'ApexClass:NightlyPurgeJob' }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('entry-point-reachable');
    // Reached through a type the callsApex allow-list could never have learned about.
    expect(r.value.data.entryPoints.map((e) => e.viaEdgeTypes).flat()).toContain('dispatchesAsync');
  });

  it('a Visualforce controller= binding yields a ui-controller entry point at DECLARED confidence', async () => {
    const r = await withStore(
      {
        nodes: [
          makeNode({ id: 'ApexClass:WidgetPageController', apiName: 'WidgetPageController', properties: { isTest: false } }),
          makeNode({ id: 'VisualforcePage:WidgetOverview', type: 'VisualforcePage', apiName: 'WidgetOverview', properties: {} }),
        ],
        edges: [
          makeEdge({
            fromId: 'VisualforcePage:WidgetOverview',
            toId: 'ApexClass:WidgetPageController',
            edgeType: 'references',
            confidence: 'declared',
          }),
        ],
      },
      (c) => methodReachabilityHandler(c, { classApiName: 'ApexClass:WidgetPageController' }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('entry-point-reachable');
    const hit = r.value.data.entryPoints.find((e) => e.kind === 'ui-controller');
    expect(hit).toBeDefined();
    // D-2: a declared controller binding must NOT be demoted to match a regex guess.
    expect(hit?.confidence).toBe('declared');
  });

  it('D-2: a path confidence is the WEAKEST edge on it, never the strongest', async () => {
    // Trigger --declared--> Mid --heuristic--> Target. The trigger entry point
    // is real, but the second hop is a guess, so the PATH is heuristic.
    const r = await withStore(
      {
        nodes: [
          makeNode({ id: 'ApexClass:LedgerTarget', apiName: 'LedgerTarget', properties: { isTest: false } }),
          makeNode({ id: 'ApexClass:LedgerMid', apiName: 'LedgerMid', properties: { isTest: false } }),
          makeNode({ id: 'ApexTrigger:LedgerTrigger', type: 'ApexTrigger', apiName: 'LedgerTrigger', properties: {} }),
        ],
        edges: [
          makeEdge({ fromId: 'ApexClass:LedgerMid', toId: 'ApexClass:LedgerTarget', edgeType: 'references', confidence: 'heuristic' }),
          makeEdge({ fromId: 'ApexTrigger:LedgerTrigger', toId: 'ApexClass:LedgerMid', edgeType: 'callsApex', confidence: 'declared' }),
        ],
      },
      (c) => methodReachabilityHandler(c, { classApiName: 'ApexClass:LedgerTarget' }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const trig = r.value.data.entryPoints.find((e) => e.id === 'ApexTrigger:LedgerTrigger');
    expect(trig?.confidence).toBe('heuristic');
    expect(trig?.viaEdgeTypes).toEqual(['callsApex', 'references']);
  });

  it('a mutual references CYCLE terminates and does not loop', async () => {
    const r = await withStore(
      {
        nodes: [
          makeNode({ id: 'ApexClass:CycleA', apiName: 'CycleA', properties: { isTest: false } }),
          makeNode({ id: 'ApexClass:CycleB', apiName: 'CycleB', properties: { isTest: false } }),
        ],
        edges: [
          makeEdge({ fromId: 'ApexClass:CycleA', toId: 'ApexClass:CycleB', edgeType: 'references' }),
          makeEdge({ fromId: 'ApexClass:CycleB', toId: 'ApexClass:CycleA', edgeType: 'references' }),
        ],
      },
      (c) => methodReachabilityHandler(c, { classApiName: 'ApexClass:CycleA' }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('likely-dead-code');
  });

  it('a grantedBy permission grant is NOT usage — access is not usage', async () => {
    const r = await withStore(
      {
        nodes: [
          makeNode({ id: 'ApexClass:OrphanHelper', apiName: 'OrphanHelper', properties: { isTest: false } }),
          makeNode({ id: 'PermissionSet:WidgetAdmin', type: 'PermissionSet', apiName: 'WidgetAdmin', properties: {} }),
        ],
        edges: [
          makeEdge({ fromId: 'PermissionSet:WidgetAdmin', toId: 'ApexClass:OrphanHelper', edgeType: 'grantedBy', confidence: 'declared' }),
        ],
      },
      (c) => methodReachabilityHandler(c, { classApiName: 'ApexClass:OrphanHelper' }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('likely-dead-code');
    expect(r.value.data.entryPoints).toEqual([]);
  });

  it('a residual likely-dead-code verdict CROSS-REFERENCES find_dead_code; a live one does not', async () => {
    const dead = await withStore(
      { nodes: [makeNode({ id: 'ApexClass:OrphanHelper', apiName: 'OrphanHelper', properties: { isTest: false } })], edges: [] },
      (c) => methodReachabilityHandler(c, { classApiName: 'ApexClass:OrphanHelper' }),
    );
    expect(dead.ok).toBe(true);
    if (!dead.ok) return;
    expect(dead.value.data.disclosure).toContain('Run sfi.find_dead_code on this class before treating it as dead.');

    const live = await withStore(
      { nodes: [makeNode({ id: 'ApexClass:WidgetServiceTest', apiName: 'WidgetServiceTest', properties: { isTest: true } })], edges: [] },
      (c) => methodReachabilityHandler(c, { classApiName: 'ApexClass:WidgetServiceTest' }),
    );
    expect(live.ok).toBe(true);
    if (!live.ok) return;
    expect(live.value.data.disclosure).not.toContain('Run sfi.find_dead_code');
  });

  it('walkedEdgeTypes is on EVERY response and soundness is complete over the full usage set', async () => {
    const r = await withStore(
      { nodes: [makeNode({ id: 'ApexClass:OrphanHelper', apiName: 'OrphanHelper', properties: { isTest: false } })], edges: [] },
      (c) => methodReachabilityHandler(c, { classApiName: 'ApexClass:OrphanHelper' }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.walkedEdgeTypes).toEqual(USAGE_EDGE_TYPES);
    expect(r.value.data.walkedEdgeTypes).not.toContain('parentOf');
    expect(r.value.data.walkedEdgeTypes).not.toContain('grantedBy');
    expect(r.value.data.soundness.complete).toBe(true);
  });
});

// =============================================================================
// DYNAMIC-REGISTRATION ENTRY POINTS. After the usage-set fix, 4 of 186 classes
// still read `likely-dead-code` and find_dead_code independently agreed at
// `definitely_dead`. All four are live: two extend a managed trigger-framework
// base class registered only as a STRING LITERAL, two `implements Callable` and
// are dispatched from a Custom Metadata record. Unifying the walk turned a
// disagreement (actionable) into a corroboration (trusted) — of a wrong answer.
// =============================================================================
describe('methodReachabilityHandler — unproven dynamic registration', () => {
  const withStore = async <T>(
    seedData: ExtractionResult,
    run: (ctx: Context) => Promise<T>,
  ): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-mr-dyn-'));
    const opened = await openGraph(join(dir, 'mr.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    const s = opened.value;
    const imported = await importExtractionResults(s, [seedData]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    const out = await run({ vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s } as Context);
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });
    return out;
  };

  it('a namespaced-superclass subclass with ZERO in-edges is not dead', async () => {
    const r = await withStore(
      {
        nodes: [
          makeNode({
            id: 'ApexClass:WidgetAffiliationHandler',
            apiName: 'WidgetAffiliationHandler',
            properties: { isTest: false, superclass: 'pkg.TriggerRunnable' },
          }),
        ],
        edges: [],
      },
      (c) => methodReachabilityHandler(c, { classApiName: 'ApexClass:WidgetAffiliationHandler' }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('entry-point-reachable');
    const hit = r.value.data.entryPoints.find((e) => e.kind === 'framework-subclass');
    expect(hit).toBeDefined();
    // FLOORED at heuristic. A string-literal registration is a pattern match,
    // never a modelled call, so it must not borrow `declared`.
    expect(hit?.confidence).toBe('heuristic');
  });

  it('a Callable implementor with ZERO in-edges is not dead', async () => {
    const r = await withStore(
      {
        nodes: [
          makeNode({
            id: 'ApexClass:WidgetAddressHelper',
            apiName: 'WidgetAddressHelper',
            properties: { isTest: false, implements: ['Callable'] },
          }),
        ],
        edges: [],
      },
      (c) => methodReachabilityHandler(c, { classApiName: 'ApexClass:WidgetAddressHelper' }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('entry-point-reachable');
    expect(r.value.data.entryPoints.find((e) => e.kind === 'callable-dispatch')?.confidence).toBe(
      'heuristic',
    );
  });

  it('an all-unproven result SAYS it is unproven, and a real entry point does NOT', async () => {
    const unproven = await withStore(
      {
        nodes: [
          makeNode({
            id: 'ApexClass:WidgetAddressHelper',
            apiName: 'WidgetAddressHelper',
            properties: { isTest: false, implements: ['Callable'] },
          }),
        ],
        edges: [],
      },
      (c) => methodReachabilityHandler(c, { classApiName: 'ApexClass:WidgetAddressHelper' }),
    );
    if (!unproven.ok) throw new Error('handler failed');
    expect(unproven.value.data.disclosure).toContain(
      'Every entry point found here is an UNPROVEN dynamic registration',
    );

    // A REST resource is a proven platform entry point — no hedge.
    const proven = await withStore(
      {
        nodes: [
          makeNode({
            id: 'ApexClass:WidgetRestApi',
            apiName: 'WidgetRestApi',
            properties: { isTest: false, isRestResource: true },
          }),
        ],
        edges: [],
      },
      (c) => methodReachabilityHandler(c, { classApiName: 'ApexClass:WidgetRestApi' }),
    );
    if (!proven.ok) throw new Error('handler failed');
    expect(proven.value.data.disclosure).not.toContain('UNPROVEN dynamic registration');
  });

  it('CONTROL: a LOCAL superclass is NOT a framework registration and stays dead', async () => {
    // The predicate keys on a DOTTED superclass (another namespace). A local
    // base class is ordinary inheritance and must not buy an amnesty.
    const r = await withStore(
      {
        nodes: [
          makeNode({
            id: 'ApexClass:LocalBaseSubclass',
            apiName: 'LocalBaseSubclass',
            properties: { isTest: false, superclass: 'LocalBase' },
          }),
        ],
        edges: [],
      },
      (c) => methodReachabilityHandler(c, { classApiName: 'ApexClass:LocalBaseSubclass' }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('likely-dead-code');
  });

  it('a framework subclass UPSTREAM of a class makes that class reachable too', async () => {
    // Unlike `test-class`, these fire at any depth: a framework-dispatched
    // class that calls X really does make X reachable.
    const r = await withStore(
      {
        nodes: [
          makeNode({ id: 'ApexClass:WidgetService', apiName: 'WidgetService', properties: { isTest: false } }),
          makeNode({
            id: 'ApexClass:WidgetAffiliationHandler',
            apiName: 'WidgetAffiliationHandler',
            properties: { isTest: false, superclass: 'pkg.TriggerRunnable' },
          }),
        ],
        edges: [
          makeEdge({
            fromId: 'ApexClass:WidgetAffiliationHandler',
            toId: 'ApexClass:WidgetService',
            edgeType: 'callsApex',
          }),
        ],
      },
      (c) => methodReachabilityHandler(c, { classApiName: 'ApexClass:WidgetService' }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('entry-point-reachable');
    expect(r.value.data.entryPoints.some((e) => e.kind === 'framework-subclass' && e.depth === 1)).toBe(true);
  });
});
