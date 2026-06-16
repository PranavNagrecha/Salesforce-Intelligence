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
