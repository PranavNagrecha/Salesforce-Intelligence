/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, importExtractionResults, openGraph } from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { orderOfExecutionHandler } from '../../src/tools/order-of-execution.js';
import { SOE_PRIMARY_DISCLOSURE } from '../../src/tools/soe-primary-disclosure.js';
import { testCoverageForMethodHandler } from '../../src/tools/test-coverage-for-method.js';
import { testsForChangeHandler } from '../../src/tools/tests-for-change.js';
import { whatHappensOnSaveHandler } from '../../src/tools/what-happens-on-save.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:v6-agreement',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'ApexClass',
  apiName: 'Anon',
  label: null,
  parentId: null,
  sourcePath: 'unused',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

describe('V6-1 SOE disclosure + trigger-bypass agreement', () => {
  it('ships one primary disclosure constant (byte-stable tripwire)', () => {
    expect(SOE_PRIMARY_DISCLOSURE.length).toBeGreaterThan(2_400);
    expect(SOE_PRIMARY_DISCLOSURE).toContain('before-save-flows');
  });

  it('what_happens_on_save and order_of_execution share the same primary disclosure line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'v6-soe-'));
    const graphPath = join(dir, 'graph.duckdb');
    const opened = await openGraph(graphPath);
    if (!opened.ok) throw new Error(opened.error.message);
    const seed: ExtractionResult = {
      nodes: [
        makeNode({ id: 'CustomObject:Demo_Obj__c', type: 'CustomObject', apiName: 'Demo_Obj__c' }),
      ],
      edges: [],
    };
    const imp = await importExtractionResults(opened.value, [seed]);
    if (!imp.ok) throw new Error(imp.error.message);
    const ctx = { graph: opened.value, vaultRoot: dir, manifest: MANIFEST } as Context;
    const whos = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'Demo_Obj__c',
      event: 'insert',
    });
    const ooe = await orderOfExecutionHandler(ctx, { objectApiName: 'Demo_Obj__c' });
    await closeGraph(opened.value);
    rmSync(dir, { recursive: true, force: true });
    expect(whos.ok).toBe(true);
    expect(ooe.ok).toBe(true);
    if (!whos.ok || !ooe.ok) return;
    expect(whos.value.data.disclosure.startsWith(SOE_PRIMARY_DISCLOSURE.slice(0, 80))).toBe(true);
    expect(ooe.value.data.disclosure.startsWith(SOE_PRIMARY_DISCLOSURE.slice(0, 80))).toBe(true);
    expect(whos.value.data.triggerBypassWarnings ?? []).toEqual(
      ooe.value.data.triggerBypassWarnings ?? [],
    );
  });
});

describe('V6-1 test-selection agreement', () => {
  let ctx: Context;
  let dir = '';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'v6-tfc-'));
    const graphPath = join(dir, 'graph.duckdb');
    const opened = await openGraph(graphPath);
    if (!opened.ok) throw new Error(opened.error.message);
    const handler = makeNode({
      id: 'ApexClass:Demo_Handler',
      apiName: 'Demo_Handler',
      properties: { isTest: false },
    });
    const test = makeNode({
      id: 'ApexClass:Demo_Handler_Test',
      apiName: 'Demo_Handler_Test',
      properties: { isTest: true },
    });
    const seed: ExtractionResult = {
      nodes: [handler, test],
      edges: [
        {
          fromId: 'ApexClass:Demo_Handler_Test',
          toId: 'ApexClass:Demo_Handler',
          edgeType: 'callsApex',
          confidence: 'parsed',
          source: 'metadata',
          properties: {},
        },
      ],
    };
    const imp = await importExtractionResults(opened.value, [seed]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx = { graph: opened.value, vaultRoot: dir, manifest: MANIFEST } as Context;
  });

  afterAll(async () => {
    await closeGraph(ctx.graph);
    rmSync(dir, { recursive: true, force: true });
  });

  it('tests_for_change and test_coverage_for_method select the same covering tests', async () => {
    const target = 'ApexClass:Demo_Handler';
    const tfc = await testsForChangeHandler(ctx, { changedComponents: [target] });
    const tcm = await testCoverageForMethodHandler(ctx, { classApiName: 'Demo_Handler' });
    expect(tfc.ok).toBe(true);
    expect(tcm.ok).toBe(true);
    if (!tfc.ok || !tcm.ok) return;
    const selected = new Set(
      (tfc.value.data.selectedTests ?? []).map((t) => t.id),
    );
    const covering = new Set(
      (tcm.value.data.coveringTestClasses ?? []).map((t) => t.id),
    );
    expect(selected).toEqual(covering);
  });
});
