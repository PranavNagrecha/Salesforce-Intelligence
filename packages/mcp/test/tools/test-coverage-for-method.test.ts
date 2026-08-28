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

// =============================================================================
// REAL-ORG REGRESSION (TCFM-CERTIFIED-ZERO): the single most common Apex
// coverage topology in Salesforce is TRIGGER/DML-MEDIATED — a test does DML on
// an object, the object's trigger fires, the trigger calls a helper class. That
// path is NOT an edge in this graph (`coversTest` is declared in contracts and
// emitted by NO extractor, so no vault has ever held one), and the test class
// has no callsApex/dispatchesAsync edge to the helper. On the owner's real vault
// the tool answered `totalCoveringCount: 0` AND stamped it
// `soundness { complete: true, blindSpots: [], staticCoverage: 'full' }` — a
// certified zero over a topology the data model provably cannot represent. The
// same tool asked about the TRIGGER in the same upstream walk answered
// `complete: false`, so the certification was self-contradictory.
//
// These cases pin: (1) the certification is gone, (2) the un-traversed usage
// edge types are NAMED in a typed field, (3) the trigger-mediated candidates are
// actually COMPUTED from triggersOn + writesTo rather than merely disclaimed,
// and (4) the prose a host reads aloud says a 0 is not "nothing covers this".
// =============================================================================
describe('testCoverageForMethodHandler — trigger/DML-mediated coverage (TCFM-CERTIFIED-ZERO)', () => {
  let dirT: string;
  let storeT: GraphStore;
  let ctxT: Context;

  beforeAll(async () => {
    dirT = mkdtempSync(join(tmpdir(), 'sfi-mcp-tcfm-trigger-'));
    const opened = await openGraph(join(dirT, 't.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    storeT = opened.value;
    const imp = await importExtractionResults(storeT, [
      {
        nodes: [
          // `qualityIssues: []` = the recognizer RAN and found nothing, which is
          // what a real refreshed vault carries on an ApexClass. That is exactly the
          // state in which the tool used to answer `complete: true` while the trigger
          // one hop upstream (no `qualityIssues` on ApexTrigger nodes) answered
          // `complete: false` — the self-contradiction inside one walk.
          makeNode({
            id: 'ApexClass:Helper_C',
            apiName: 'Helper_C',
            properties: { isTest: false, qualityIssues: [] },
          }),
          makeNode({
            id: 'ApexTrigger:Trigger_B',
            apiName: 'Trigger_B',
            type: 'ApexTrigger',
            sourcePath: 'unused.trigger',
            properties: {},
          }),
          makeNode({
            id: 'CustomObject:Obj_A__c',
            apiName: 'Obj_A__c',
            type: 'CustomObject',
            sourcePath: 'unused.object-meta.xml',
            properties: {},
          }),
          makeNode({
            id: 'CustomField:Obj_A__c.F1__c',
            apiName: 'F1__c',
            type: 'CustomField',
            parentId: 'CustomObject:Obj_A__c',
            sourcePath: 'unused.field-meta.xml',
            properties: {},
          }),
          // Covers Helper_C ONLY by doing DML on Obj_A__c — no Apex-to-Apex edge.
          makeNode({ id: 'ApexClass:Helper_CTest', apiName: 'Helper_CTest', properties: { isTest: true } }),
          // Reaches Helper_C directly AND writes the object — must not be listed twice.
          makeNode({ id: 'ApexClass:DirectCallerTest', apiName: 'DirectCallerTest', properties: { isTest: true } }),
          // A class with NO trigger anywhere upstream — control.
          makeNode({
            id: 'ApexClass:Lonely_C',
            apiName: 'Lonely_C',
            properties: { isTest: false, qualityIssues: [] },
          }),
          // Bare-name resolution: a trigger with no same-named class.
          makeNode({
            id: 'ApexTrigger:Lone_T',
            apiName: 'Lone_T',
            type: 'ApexTrigger',
            sourcePath: 'unused.trigger',
            properties: {},
          }),
          // Bare-name ambiguity: a class AND a trigger share one api name.
          makeNode({ id: 'ApexClass:Dual_D', apiName: 'Dual_D', properties: { isTest: false } }),
          makeNode({
            id: 'ApexTrigger:Dual_D',
            apiName: 'Dual_D',
            type: 'ApexTrigger',
            sourcePath: 'unused.trigger',
            properties: {},
          }),
        ],
        edges: [
          makeEdge({ fromId: 'ApexTrigger:Trigger_B', toId: 'ApexClass:Helper_C', edgeType: 'callsApex' }),
          makeEdge({ fromId: 'ApexTrigger:Trigger_B', toId: 'CustomObject:Obj_A__c', edgeType: 'triggersOn' }),
          makeEdge({ fromId: 'ApexClass:Helper_CTest', toId: 'CustomField:Obj_A__c.F1__c', edgeType: 'writesTo' }),
          makeEdge({ fromId: 'ApexClass:DirectCallerTest', toId: 'ApexClass:Helper_C', edgeType: 'callsApex' }),
          makeEdge({ fromId: 'ApexClass:DirectCallerTest', toId: 'CustomField:Obj_A__c.F1__c', edgeType: 'writesTo' }),
        ],
      },
    ]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctxT = { vaultRoot: dirT, manifest: FIXTURE_MANIFEST, graph: storeT };
  });

  afterAll(async () => {
    await closeGraph(storeT);
    rmSync(dirT, { recursive: true, force: true });
  });

  it('never certifies a coverage answer complete while the DML-mediated path is unrepresentable', async () => {
    const r = await testCoverageForMethodHandler(ctxT, {
      classApiName: 'Helper_C',
      methodName: 'methodX',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.soundness.complete).toBe(false);
    expect(r.value.data.soundness.staticCoverage).toBe('partial');
    const spot = r.value.data.soundness.blindSpots.find((b) => b.kind === 'unwalked-edge-type');
    expect(spot).toBeDefined();
    // The gap is NAMED in a typed field a machine consumer cannot skip.
    expect(spot?.unwalkedEdgeTypes ?? []).toContain('references');
  });

  it('answers the class and the trigger on the SAME walk with the same completeness claim', async () => {
    const byClass = await testCoverageForMethodHandler(ctxT, { classApiName: 'ApexClass:Helper_C' });
    const byTrigger = await testCoverageForMethodHandler(ctxT, {
      componentId: 'ApexTrigger:Trigger_B',
    });
    expect(byClass.ok && byTrigger.ok).toBe(true);
    if (!byClass.ok || !byTrigger.ok) return;
    expect(byClass.value.data.soundness.complete).toBe(byTrigger.value.data.soundness.complete);
    expect(byClass.value.data.soundness.complete).toBe(false);
  });

  it('computes the trigger-mediated candidate tests from triggersOn + writesTo', async () => {
    const r = await testCoverageForMethodHandler(ctxT, { classApiName: 'ApexClass:Helper_C' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Direct-call coverage is unchanged.
    expect(r.value.data.coveringTestClasses.map((c) => c.id)).toEqual(['ApexClass:DirectCallerTest']);
    const tm = r.value.data.triggerMediatedCoverage;
    expect(tm).not.toBeNull();
    expect(tm?.triggers).toEqual(['ApexTrigger:Trigger_B']);
    expect(tm?.triggerObjects).toEqual(['CustomObject:Obj_A__c']);
    const ids = (tm?.candidateTestClasses ?? []).map((c) => c.id);
    // The test that ONLY does DML is found...
    expect(ids).toContain('ApexClass:Helper_CTest');
    // ...and a test already reported as a DIRECT coverer is not double-listed.
    expect(ids).not.toContain('ApexClass:DirectCallerTest');
    expect(tm?.candidateTestCount).toBe(1);
    expect(tm?.confidence).toBe('heuristic');
  });

  it('omits the trigger-mediated block when no trigger is on the upstream path', async () => {
    const r = await testCoverageForMethodHandler(ctxT, { classApiName: 'ApexClass:Lonely_C' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.triggerMediatedCoverage).toBeNull();
    // Still never certified: writesTo/triggersOn were not traversed either.
    expect(r.value.data.soundness.complete).toBe(false);
    const spot = r.value.data.soundness.blindSpots.find((b) => b.kind === 'unwalked-edge-type');
    expect(spot?.unwalkedEdgeTypes ?? []).toContain('triggersOn');
  });

  it('says in the prose that a zero is not "no test covers this"', async () => {
    const byClass = await testCoverageForMethodHandler(ctxT, { classApiName: 'ApexClass:Helper_C' });
    const byMethod = await testCoverageForMethodHandler(ctxT, {
      classApiName: 'ApexClass:Helper_C',
      methodName: 'methodX',
    });
    expect(byClass.ok && byMethod.ok).toBe(true);
    if (!byClass.ok || !byMethod.ok) return;
    for (const d of [byClass.value.data.disclosure, byMethod.value.data.disclosure]) {
      expect(d).toMatch(/coversTest/);
      expect(d).toMatch(/triggerMediatedCoverage/);
      expect(d).toMatch(/NEVER "no test covers this"/);
    }
  });
});

// =============================================================================
// REAL-ORG REGRESSION (TCFM-TRIGGER-BARE-NAME): the contract says the target is
// "an ApexClass: or ApexTrigger: id (accepted interchangeably as classApiName,
// componentId, or apiName — a bare name or the canonical id)". In fact a bare
// name was hard-prefixed `ApexClass:`, so EVERY ApexTrigger in a vault was
// unreachable by bare name through all three selectors — and the error text then
// read "no ApexClass or ApexTrigger with id ApexClass:X", asserting a two-family
// search the echoed id disproves.
// =============================================================================
describe('testCoverageForMethodHandler — bare ApexTrigger name (TCFM-TRIGGER-BARE-NAME)', () => {
  let dirB: string;
  let storeB: GraphStore;
  let ctxB: Context;

  beforeAll(async () => {
    dirB = mkdtempSync(join(tmpdir(), 'sfi-mcp-tcfm-bare-'));
    const opened = await openGraph(join(dirB, 't.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    storeB = opened.value;
    const imp = await importExtractionResults(storeB, [
      {
        nodes: [
          makeNode({
            id: 'ApexTrigger:Lone_T',
            apiName: 'Lone_T',
            type: 'ApexTrigger',
            sourcePath: 'unused.trigger',
            properties: {},
          }),
          makeNode({ id: 'ApexClass:Dual_D', apiName: 'Dual_D', properties: { isTest: false } }),
          makeNode({
            id: 'ApexTrigger:Dual_D',
            apiName: 'Dual_D',
            type: 'ApexTrigger',
            sourcePath: 'unused.trigger',
            properties: {},
          }),
        ],
        edges: [
          // Referenced by this org, definition never retrieved — a PHANTOM. The
          // bare-name branch probes two ids; it must not lose the phantom
          // disclosure the single-id branch has always given.
          makeEdge({
            fromId: 'ApexTrigger:Lone_T',
            toId: 'ApexClass:Phantom_P',
            edgeType: 'callsApex',
          }),
        ],
      },
    ]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctxB = { vaultRoot: dirB, manifest: FIXTURE_MANIFEST, graph: storeB };
  });

  afterAll(async () => {
    await closeGraph(storeB);
    rmSync(dirB, { recursive: true, force: true });
  });

  it('resolves a bare trigger name through all three selectors', async () => {
    for (const input of [
      { classApiName: 'Lone_T' },
      { apiName: 'Lone_T' },
      { componentId: 'Lone_T' },
    ]) {
      const r = await testCoverageForMethodHandler(ctxB, input);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data.appliedScope.component).toBe('ApexTrigger:Lone_T');
      expect(r.value.data.classApiName).toBe('ApexTrigger:Lone_T');
    }
  });

  it('does not claim it searched ApexTrigger when only an ApexClass id was given', async () => {
    const r = await testCoverageForMethodHandler(ctxB, { classApiName: 'ApexClass:Nope_X' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    expect(r.error.message).not.toMatch(/ApexTrigger/);
  });

  it('names BOTH ids actually looked up when a bare name matches nothing', async () => {
    const r = await testCoverageForMethodHandler(ctxB, { classApiName: 'Nope_X' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    expect(r.error.message).toMatch(/ApexClass:Nope_X/);
    expect(r.error.message).toMatch(/ApexTrigger:Nope_X/);
  });

  it('still discloses a PHANTOM when the bare name was probed against both families', async () => {
    const r = await testCoverageForMethodHandler(ctxB, { classApiName: 'Phantom_P' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    // The two-id probe must not downgrade "referenced but never retrieved" to a
    // flat "does not exist".
    expect(r.error.message).toMatch(/never retrieved into the vault/);
    expect(r.error.message).toMatch(/ApexTrigger:Phantom_P/);
  });

  it('refuses to silently pick when a bare name matches BOTH a class and a trigger', async () => {
    const r = await testCoverageForMethodHandler(ctxB, { apiName: 'Dual_D' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toMatch(/ApexClass:Dual_D/);
    expect(r.error.message).toMatch(/ApexTrigger:Dual_D/);
  });

  it('an explicit kind alongside the same bare name disambiguates rather than rejecting', async () => {
    const r = await testCoverageForMethodHandler(ctxB, {
      classApiName: 'Dual_D',
      componentId: 'ApexTrigger:Dual_D',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.appliedScope.component).toBe('ApexTrigger:Dual_D');
  });

  // The prose above was made honest; `error.path` was not. `McpError.path` is
  // documented as "pointer to the offending input", and it is the TYPED field a
  // machine consumer reads INSTEAD of the prose. Echoing a synthesized
  // `ApexClass:<name>` there re-asserts, in the one field a host cannot skip,
  // exactly the single-family search the message just disclaimed — and it names
  // a family the caller never mentioned.
  it('does not echo a synthesized single-family id as the offending input for a bare-name miss', async () => {
    const r = await testCoverageForMethodHandler(ctxB, { classApiName: 'Nope_X' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    expect(r.error.message).toMatch(/ApexTrigger:Nope_X/);
    expect(r.error.path).not.toBe('ApexClass:Nope_X');
    expect(r.error.path).toBe('Nope_X');
  });

  it('still points at the one id looked up when the caller named the family', async () => {
    for (const input of [
      { componentId: 'ApexTrigger:Nope_X' },
      { classApiName: 'ApexClass:Nope_X' },
    ]) {
      const r = await testCoverageForMethodHandler(ctxB, input);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.path).toBe(Object.values(input)[0]);
    }
  });

  it('two selectors naming DIFFERENT components are still invalid-query', async () => {
    const r = await testCoverageForMethodHandler(ctxB, {
      classApiName: 'ApexClass:Dual_D',
      componentId: 'ApexTrigger:Lone_T',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });
});
