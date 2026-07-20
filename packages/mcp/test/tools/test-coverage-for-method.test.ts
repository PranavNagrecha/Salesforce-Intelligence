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
  testCoverageForMethodHandler,
  testCoverageForMethodInputSchema,
} from '../../src/tools/test-coverage-for-method.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-28T09:12:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-tcfm',
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

// Target class A. DirectTest calls A. ChainTest calls Mid which calls A.
// Uncovered class has no incoming calls.
const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: 'ApexClass:Target',
      apiName: 'Target',
      properties: { isTest: false },
    }),
    makeNode({
      id: 'ApexClass:Mid',
      apiName: 'Mid',
      properties: { isTest: false },
    }),
    makeNode({
      id: 'ApexClass:DirectTest',
      apiName: 'DirectTest',
      properties: { isTest: true },
    }),
    makeNode({
      id: 'ApexClass:ChainTest',
      apiName: 'ChainTest',
      properties: { isTest: true },
    }),
    makeNode({
      id: 'ApexClass:Uncovered',
      apiName: 'Uncovered',
      properties: { isTest: false },
    }),
    makeNode({
      id: 'ApexClass:NonTestCaller',
      apiName: 'NonTestCaller',
      properties: { isTest: false },
    }),
    // Batch class covered only via async dispatch (Database.executeBatch).
    makeNode({
      id: 'ApexClass:OrderBatch',
      apiName: 'OrderBatch',
      properties: { isTest: false },
    }),
    // Test that exercises OrderBatch via Database.executeBatch — links
    // through a dispatchesAsync edge, NOT callsApex.
    makeNode({
      id: 'ApexClass:BatchTest',
      apiName: 'BatchTest',
      properties: { isTest: true },
    }),
  ],
  edges: [
    makeEdge({
      fromId: 'ApexClass:DirectTest',
      toId: 'ApexClass:Target',
      edgeType: 'callsApex',
    }),
    makeEdge({
      fromId: 'ApexClass:Mid',
      toId: 'ApexClass:Target',
      edgeType: 'callsApex',
    }),
    makeEdge({
      fromId: 'ApexClass:ChainTest',
      toId: 'ApexClass:Mid',
      edgeType: 'callsApex',
    }),
    // Non-test caller of Target — must NOT be counted as covering test.
    makeEdge({
      fromId: 'ApexClass:NonTestCaller',
      toId: 'ApexClass:Target',
      edgeType: 'callsApex',
    }),
    // BatchTest covers OrderBatch ONLY via dispatchesAsync (the batch is
    // kicked off with Database.executeBatch(new OrderBatch()), so there
    // is no callsApex edge). The walk must follow dispatchesAsync to
    // count it.
    makeEdge({
      fromId: 'ApexClass:BatchTest',
      toId: 'ApexClass:OrderBatch',
      edgeType: 'dispatchesAsync',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-tcfm-'));
  const opened = await openGraph(join(tempDir, 'tcfm.db'));
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

describe('testCoverageForMethodHandler', () => {
  it('lists direct test class as covering with depth 1', async () => {
    const r = await testCoverageForMethodHandler(ctx, {
      classApiName: 'ApexClass:Target',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const direct = r.value.data.coveringTestClasses.find(
      (c) => c.id === 'ApexClass:DirectTest',
    );
    expect(direct).toBeDefined();
    expect(direct?.depth).toBe(1);
  });

  it('lists transitive test class via depth-3 BFS', async () => {
    const r = await testCoverageForMethodHandler(ctx, {
      classApiName: 'ApexClass:Target',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const chain = r.value.data.coveringTestClasses.find(
      (c) => c.id === 'ApexClass:ChainTest',
    );
    expect(chain).toBeDefined();
    expect(chain?.depth).toBe(2);
  });

  it('counts a test that exercises a batch class via dispatchesAsync', async () => {
    // OrderBatch is covered only through Database.executeBatch(new
    // OrderBatch()), which links via a dispatchesAsync edge — NOT
    // callsApex. The walk must follow dispatchesAsync or this is a
    // false-negative "uncovered".
    const r = await testCoverageForMethodHandler(ctx, {
      classApiName: 'ApexClass:OrderBatch',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.coveringTestClasses.map((c) => c.id);
    expect(ids).toContain('ApexClass:BatchTest');
    const batchTest = r.value.data.coveringTestClasses.find(
      (c) => c.id === 'ApexClass:BatchTest',
    );
    expect(batchTest?.depth).toBe(1);
  });

  it('does NOT include non-test callers as covering classes', async () => {
    const r = await testCoverageForMethodHandler(ctx, {
      classApiName: 'ApexClass:Target',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.coveringTestClasses.map((c) => c.id);
    expect(ids).not.toContain('ApexClass:NonTestCaller');
    expect(ids).not.toContain('ApexClass:Mid');
  });

  it('returns empty coveringTestClasses for an uncovered class', async () => {
    const r = await testCoverageForMethodHandler(ctx, {
      classApiName: 'ApexClass:Uncovered',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.coveringTestClasses.length).toBe(0);
    expect(r.value.data.totalCoveringCount).toBe(0);
  });

  it('echoes methodName verbatim into the response without affecting the walk', async () => {
    const r = await testCoverageForMethodHandler(ctx, {
      classApiName: 'ApexClass:Target',
      methodName: 'someMethod',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.methodName).toBe('someMethod');
    // Same coverage as without methodName.
    expect(r.value.data.coveringTestClasses.length).toBeGreaterThanOrEqual(2);
  });

  it('returns methodName: null when methodName is omitted', async () => {
    const r = await testCoverageForMethodHandler(ctx, {
      classApiName: 'ApexClass:Target',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.methodName).toBeNull();
  });

  it('surfaces the class-level disclosure when no methodName is given', async () => {
    const r = await testCoverageForMethodHandler(ctx, {
      classApiName: 'ApexClass:Target',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disclosure).toMatch(/CLASS granularity/);
    expect(r.value.data.disclosure).toMatch(/depth 3/);
    expect(r.value.data.methodCoveringCount).toBeNull();
  });

  it('surfaces the method-level disclosure + exercisesMethod when methodName is given (P4-test-reachability)', async () => {
    const r = await testCoverageForMethodHandler(ctx, {
      classApiName: 'ApexClass:Target',
      methodName: 'doWork',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disclosure).toMatch(/exercisesMethod/);
    expect(r.value.data.methodCoveringCount).not.toBeNull();
    // Every covering test carries the per-test exercisesMethod flag.
    for (const t of r.value.data.coveringTestClasses) {
      expect(typeof t.exercisesMethod).toBe('boolean');
    }
  });

  it('rejects a non-Apex prefix with invalid-query', async () => {
    const r = await testCoverageForMethodHandler(ctx, {
      classApiName: 'CustomField:Account.Industry__c',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('returns component-not-found for an unknown class', async () => {
    const r = await testCoverageForMethodHandler(ctx, {
      classApiName: 'ApexClass:DefinitelyNotHere',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('returns covering test classes sorted by id ASC', async () => {
    const r = await testCoverageForMethodHandler(ctx, {
      classApiName: 'ApexClass:Target',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.coveringTestClasses.map((c) => c.id);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });
});

describe('testCoverageForMethodInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    expect(
      testCoverageForMethodInputSchema.safeParse({
        classApiName: 'ApexClass:X',
      }).success,
    ).toBe(true);
  });

  it('accepts an optional methodName', () => {
    expect(
      testCoverageForMethodInputSchema.safeParse({
        classApiName: 'ApexClass:X',
        methodName: 'foo',
      }).success,
    ).toBe(true);
  });

  it('rejects empty classApiName', () => {
    expect(
      testCoverageForMethodInputSchema.safeParse({ classApiName: '' }).success,
    ).toBe(false);
  });

  it('rejects empty methodName', () => {
    expect(
      testCoverageForMethodInputSchema.safeParse({
        classApiName: 'ApexClass:X',
        methodName: '',
      }).success,
    ).toBe(false);
  });
});

describe('testCoverageForMethodHandler: test classes are coverage sinks (no fabricated path)', () => {
  let dirS: string;
  let storeS: GraphStore;
  let ctxS: Context;

  beforeAll(async () => {
    dirS = mkdtempSync(join(tmpdir(), 'sfi-mcp-tcfm-sink-'));
    const opened = await openGraph(join(dirS, 't.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    storeS = opened.value;
    // Selector <- Svc (callsApex). SvcTest -> Svc legitimately covers Selector
    // transitively. FabricatedTest has a spurious edge INTO SvcTest — the walk
    // must NOT traverse through the test node and credit FabricatedTest.
    const imp = await importExtractionResults(storeS, [
      {
        nodes: [
          makeNode({ id: 'ApexClass:Selector', apiName: 'Selector', properties: { isTest: false } }),
          makeNode({ id: 'ApexClass:Svc', apiName: 'Svc', properties: { isTest: false } }),
          makeNode({ id: 'ApexClass:SvcTest', apiName: 'SvcTest', properties: { isTest: true } }),
          makeNode({ id: 'ApexClass:FabricatedTest', apiName: 'FabricatedTest', properties: { isTest: true } }),
        ],
        edges: [
          makeEdge({ fromId: 'ApexClass:Svc', toId: 'ApexClass:Selector', edgeType: 'callsApex' }),
          makeEdge({ fromId: 'ApexClass:SvcTest', toId: 'ApexClass:Svc', edgeType: 'callsApex' }),
          // Spurious edge into a test node — must not relay coverage outward.
          makeEdge({ fromId: 'ApexClass:FabricatedTest', toId: 'ApexClass:SvcTest', edgeType: 'callsApex' }),
        ],
      },
    ]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctxS = { vaultRoot: dirS, manifest: FIXTURE_MANIFEST, graph: storeS };
  });

  afterAll(async () => {
    await closeGraph(storeS);
    rmSync(dirS, { recursive: true, force: true });
  });

  it('counts the real transitive test but never the one reachable only THROUGH a test', async () => {
    const r = await testCoverageForMethodHandler(ctxS, { classApiName: 'ApexClass:Selector' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.coveringTestClasses.map((c) => c.id);
    expect(ids).toContain('ApexClass:SvcTest');
    expect(ids).not.toContain('ApexClass:FabricatedTest');
  });
});

describe('testCoverageForMethodHandler: callout-mock cross-reference', () => {
  let dirC: string;
  let storeC: GraphStore;
  let ctxC: Context;

  beforeAll(async () => {
    dirC = mkdtempSync(join(tmpdir(), 'sfi-mcp-tcfm-callout-'));
    const opened = await openGraph(join(dirC, 't.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    storeC = opened.value;
    // CalloutSvc implements Database.AllowsCallouts and is covered ONLY by a
    // mock-less test (MocklessTest) -> inflated coverage. MockedSvc is a callout
    // class covered by a test that implements HttpCalloutMock. PlainSvc makes no
    // callout, so no calloutCoverage block is produced.
    const imp = await importExtractionResults(storeC, [
      {
        nodes: [
          makeNode({
            id: 'ApexClass:CalloutSvc',
            apiName: 'CalloutSvc',
            properties: { isTest: false, implements: ['Database.AllowsCallouts'] },
          }),
          makeNode({
            id: 'ApexClass:MocklessTest',
            apiName: 'MocklessTest',
            properties: { isTest: true, implements: [] },
          }),
          makeNode({
            id: 'ApexClass:MockedSvc',
            apiName: 'MockedSvc',
            properties: { isTest: false, implements: ['Database.AllowsCallouts'] },
          }),
          makeNode({
            id: 'ApexClass:MockingTest',
            apiName: 'MockingTest',
            properties: { isTest: true, implements: ['HttpCalloutMock'] },
          }),
          makeNode({
            id: 'ApexClass:PlainSvc',
            apiName: 'PlainSvc',
            properties: { isTest: false, implements: [] },
          }),
          makeNode({
            id: 'ApexClass:PlainTest',
            apiName: 'PlainTest',
            properties: { isTest: true, implements: [] },
          }),
        ],
        edges: [
          makeEdge({ fromId: 'ApexClass:MocklessTest', toId: 'ApexClass:CalloutSvc', edgeType: 'callsApex' }),
          makeEdge({ fromId: 'ApexClass:MockingTest', toId: 'ApexClass:MockedSvc', edgeType: 'callsApex' }),
          makeEdge({ fromId: 'ApexClass:PlainTest', toId: 'ApexClass:PlainSvc', edgeType: 'callsApex' }),
        ],
      },
    ]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctxC = { vaultRoot: dirC, manifest: FIXTURE_MANIFEST, graph: storeC };
  });

  afterAll(async () => {
    await closeGraph(storeC);
    rmSync(dirC, { recursive: true, force: true });
  });

  it('flags callout code covered exclusively by a mock-less test', async () => {
    const r = await testCoverageForMethodHandler(ctxC, { classApiName: 'ApexClass:CalloutSvc' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cc = r.value.data.calloutCoverage;
    expect(cc).not.toBeNull();
    expect(cc?.targetMakesCallout).toBe(true);
    expect(cc?.mockLessTestCount).toBe(1);
    expect(cc?.mockSettingTestCount).toBe(0);
    expect(cc?.coveredOnlyByMockLessTests).toBe(true);
    const t = r.value.data.coveringTestClasses.find((c) => c.id === 'ApexClass:MocklessTest');
    expect(t?.setsMock).toBe(false);
  });

  it('does NOT flag when a covering test installs a mock interface', async () => {
    const r = await testCoverageForMethodHandler(ctxC, { classApiName: 'ApexClass:MockedSvc' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cc = r.value.data.calloutCoverage;
    expect(cc?.targetMakesCallout).toBe(true);
    expect(cc?.mockSettingTestCount).toBe(1);
    expect(cc?.coveredOnlyByMockLessTests).toBe(false);
    const t = r.value.data.coveringTestClasses.find((c) => c.id === 'ApexClass:MockingTest');
    expect(t?.setsMock).toBe(true);
  });

  it('omits the calloutCoverage block for a class that makes no callout', async () => {
    const r = await testCoverageForMethodHandler(ctxC, { classApiName: 'ApexClass:PlainSvc' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.calloutCoverage).toBeNull();
    // setsMock is suppressed on covering tests for a non-callout target.
    const t = r.value.data.coveringTestClasses.find((c) => c.id === 'ApexClass:PlainTest');
    expect(t?.setsMock).toBeUndefined();
  });

  it('surfaces the callout-mock cross-reference in the disclosure', async () => {
    const r = await testCoverageForMethodHandler(ctxC, { classApiName: 'ApexClass:CalloutSvc' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disclosure).toMatch(/calloutCoverage/);
    expect(r.value.data.disclosure).toMatch(/Test\.setMock/);
  });
});

describe('testCoverageForMethodHandler: method-level exercise flag (P4-test-reachability)', () => {
  let dir2: string;
  let store2: GraphStore;
  let ctx2: Context;

  beforeAll(async () => {
    dir2 = mkdtempSync(join(tmpdir(), 'sfi-mcp-tcfm-method-'));
    const opened = await openGraph(join(dir2, 't.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store2 = opened.value;
    // SvcTest calls Svc.doWork; OtherTest calls Svc.somethingElse. Both cover
    // the class; only SvcTest exercises doWork.
    const imp = await importExtractionResults(store2, [
      {
        nodes: [
          makeNode({ id: 'ApexClass:Svc', apiName: 'Svc' }),
          makeNode({ id: 'ApexClass:SvcTest', apiName: 'SvcTest', properties: { isTest: true } }),
          makeNode({ id: 'ApexClass:OtherTest', apiName: 'OtherTest', properties: { isTest: true } }),
        ],
        edges: [
          makeEdge({ fromId: 'ApexClass:SvcTest', toId: 'ApexClass:Svc', edgeType: 'callsApex', properties: { methods: ['doWork', 'helper'] } }),
          makeEdge({ fromId: 'ApexClass:OtherTest', toId: 'ApexClass:Svc', edgeType: 'callsApex', properties: { methods: ['somethingElse'] } }),
        ],
      },
    ]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx2 = { vaultRoot: dir2, manifest: FIXTURE_MANIFEST, graph: store2 };
  });

  afterAll(async () => {
    await closeGraph(store2);
    rmSync(dir2, { recursive: true, force: true });
  });

  it('flags only the test that actually exercises the changed method', async () => {
    const r = await testCoverageForMethodHandler(ctx2, {
      classApiName: 'ApexClass:Svc',
      methodName: 'doWork',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byId = new Map(r.value.data.coveringTestClasses.map((c) => [c.id, c.exercisesMethod]));
    // Both cover the class...
    expect(byId.has('ApexClass:SvcTest')).toBe(true);
    expect(byId.has('ApexClass:OtherTest')).toBe(true);
    // ...but only SvcTest exercises doWork.
    expect(byId.get('ApexClass:SvcTest')).toBe(true);
    expect(byId.get('ApexClass:OtherTest')).toBe(false);
    expect(r.value.data.methodCoveringCount).toBe(1);
  });
});

// =============================================================================
// GUARD (TEST-COVERAGE-FOR-METHOD-REJECTS-COMPONENTID): a dev "which tests cover
// {method}?" after route_question naturally passes `componentId` (as on sibling
// Apex tools), but the schema required `classApiName` only and hard-failed
// `classApiName: Required`. componentId / apiName must now be interchangeable
// with classApiName (same covering tests, byte-equal), disagreeing selectors
// reject, and the resolved scope is echoed in appliedScope.
// =============================================================================
describe('testCoverageForMethodHandler — classApiName / componentId / apiName alias (guard)', () => {
  it('componentId ≡ classApiName ≡ bare apiName resolve to the same covering tests (byte-equal data)', async () => {
    const byComponentId = await testCoverageForMethodHandler(ctx, {
      componentId: 'ApexClass:Target',
    });
    const byClassApiName = await testCoverageForMethodHandler(ctx, {
      classApiName: 'ApexClass:Target',
    });
    const byApiName = await testCoverageForMethodHandler(ctx, { apiName: 'Target' });
    const byBare = await testCoverageForMethodHandler(ctx, { classApiName: 'Target' });
    expect(byComponentId.ok && byClassApiName.ok && byApiName.ok && byBare.ok).toBe(true);
    if (!byComponentId.ok || !byClassApiName.ok || !byApiName.ok || !byBare.ok) return;
    const canonical = JSON.stringify(byClassApiName.value.data);
    expect(JSON.stringify(byComponentId.value.data)).toBe(canonical);
    expect(JSON.stringify(byApiName.value.data)).toBe(canonical);
    expect(JSON.stringify(byBare.value.data)).toBe(canonical);
    expect(byComponentId.value.data.appliedScope).toEqual({
      component: 'ApexClass:Target',
      mode: 'component',
    });
  });

  it('componentId scope is actually honored — a different class returns ITS tests', async () => {
    const target = await testCoverageForMethodHandler(ctx, {
      componentId: 'ApexClass:Target',
    });
    const batch = await testCoverageForMethodHandler(ctx, {
      componentId: 'ApexClass:OrderBatch',
    });
    expect(target.ok && batch.ok).toBe(true);
    if (!target.ok || !batch.ok) return;
    const batchIds = batch.value.data.coveringTestClasses.map((c) => c.id);
    expect(batchIds).toContain('ApexClass:BatchTest');
    // The two scopes yield DIFFERENT covering sets — proof the alias is used,
    // not ignored in favor of a fixed default.
    expect(JSON.stringify(batch.value.data.coveringTestClasses)).not.toBe(
      JSON.stringify(target.value.data.coveringTestClasses),
    );
    expect(batch.value.data.appliedScope.component).toBe('ApexClass:OrderBatch');
  });

  it('disagreeing classApiName / componentId is invalid-query (never a silent pick)', async () => {
    const r = await testCoverageForMethodHandler(ctx, {
      classApiName: 'ApexClass:Target',
      componentId: 'ApexClass:OrderBatch',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('no class selector at all is invalid-query', async () => {
    const r = await testCoverageForMethodHandler(ctx, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });
});
