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
  ],
  edges: [
    makeEdge({ fromId: 'ApexClass:OrderServiceTest', toId: 'ApexClass:OrderService', edgeType: 'callsApex' }),
    makeEdge({ fromId: 'ApexClass:SharedHelperTest', toId: 'ApexClass:OrderService', edgeType: 'callsApex' }),
    makeEdge({ fromId: 'ApexClass:SharedHelperTest', toId: 'ApexClass:PricingEngine', edgeType: 'callsApex' }),
    makeEdge({ fromId: 'ApexClass:Mid', toId: 'ApexClass:PricingEngine', edgeType: 'callsApex' }),
    makeEdge({ fromId: 'ApexClass:PricingEngineTest', toId: 'ApexClass:Mid', edgeType: 'callsApex' }),
    makeEdge({ fromId: 'ApexClass:BatchTest', toId: 'ApexClass:OrderBatch', edgeType: 'dispatchesAsync' }),
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

  it('surfaces the verbatim honesty disclosure', async () => {
    const r = await testsForChangeHandler(ctx, {
      changedComponents: ['ApexClass:OrderService'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disclosure).toMatch(/CLASS granularity/);
    expect(r.value.data.disclosure).toMatch(/depth 3/);
    expect(r.value.data.disclosure).toMatch(/UNGUARDED/);
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
