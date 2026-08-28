/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ComponentId, ExtractionResult, Node } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { scanFlowConditionFieldReaders } from '../../src/tools/flow-condition-field-readers-scan.js';

// ===========================================================================
// CONDITION-SCAN-FAILURE-IS-NOT-A-CLEAN-ZERO
//
// `scanFlowConditionFieldReaders` returned `{ readers: [], truncated: false,
// scannedCount: 0, totalCount: 0 }` when the ConditionalContext walk FAILED —
// a FINISHED, COMPLETE zero. Both callers read that as proven absence:
// `field_360` gates its truncation caveat on `truncated` (so no caveat fired)
// and `safe_to_delete_field` turns every reader into a `blocking` flow
// referrer (so a graph error silently converted "blocking — Flows filter on
// this field" into "safe to delete"). Nothing was scanned, so the empty list
// is UNCHECKED, never "none".
// ===========================================================================

const FIELD_ID = 'CustomField:Ns__Obj__c.My_Field__c' as ComponentId;
const READER_FLOW_ID = 'Flow:F_0003' as ComponentId;

const makeNode = (n: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'source/fixture.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...n,
});

/** Three flow-parented ConditionalContext nodes; only the LAST names the field. */
const conditionNode = (n: number, refs: readonly ComponentId[]): Node =>
  makeNode({
    id: `ConditionalContext:Flow:F_${String(n).padStart(4, '0')}.condition-0` as ComponentId,
    type: 'ConditionalContext',
    apiName: `Flow:F_${String(n).padStart(4, '0')}.condition-0`,
    parentId: `Flow:F_${String(n).padStart(4, '0')}` as ComponentId,
    properties: { kind: 'flow-decision', fieldRefs: refs },
  });

const SEED: ExtractionResult = {
  nodes: [
    makeNode({ id: 'Flow:F_0001' as ComponentId, type: 'Flow', apiName: 'F_0001' }),
    makeNode({ id: 'Flow:F_0002' as ComponentId, type: 'Flow', apiName: 'F_0002' }),
    makeNode({ id: 'Flow:F_0003' as ComponentId, type: 'Flow', apiName: 'F_0003' }),
    makeNode({ id: FIELD_ID, type: 'CustomField', apiName: 'Ns__Obj__c.My_Field__c' }),
    conditionNode(1, ['CustomField:Ns__Obj__c.Other__c' as ComponentId]),
    conditionNode(2, []),
    conditionNode(3, [FIELD_ID]),
  ],
  edges: [],
};

/**
 * A store whose every query REJECTS — the graph-failure path
 * (`listNodesByType` returns `query-failed`) without needing to corrupt a real
 * DuckDB file.
 */
const failingStore = {
  connection: {
    runAndReadAll: (): Promise<never> =>
      Promise.reject(new Error('duckdb: connection was closed')),
  },
  instance: {},
} as unknown as GraphStore;

describe('scanFlowConditionFieldReaders', () => {
  let dir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-condition-scan-'));
    const opened = await openGraph(join(dir, 'graph.duckdb'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    store = opened.value;
    const imported = await importExtractionResults(store, [SEED]);
    if (!imported.ok) throw new Error(`import failed: ${imported.error.message}`);
    ctx = {
      vaultRoot: dir,
      manifest: {
        version: '0.1.0',
        refreshedAt: '2026-05-27T14:33:08Z',
        sourceOrg: 'me@example.com',
        components: { Flow: 3, ConditionalContext: 3 },
        edges: {},
        sourceTreeHash: 'sha256:fixture',
      },
      graph: store,
    };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env['SFI_CONDITION_SCAN_MAX'];
    delete process.env['SFI_NODE_SCAN_LIMIT'];
  });

  it('finds the flow-condition reader on a COMPLETE walk and claims completeness', async () => {
    const r = await scanFlowConditionFieldReaders(ctx, FIELD_ID);
    expect(r.readers.map((x) => x.flowId)).toEqual([READER_FLOW_ID]);
    expect(r.readers[0]?.conditionKind).toBe('flow-decision');
    expect(r.truncated).toBe(false);
    expect(r.scanFailed).toBe(false);
    expect(r.scannedCount).toBe(3);
  });

  it('a graph FAILURE is not a clean zero: readers [] is UNCHECKED, not "none"', async () => {
    const r = await scanFlowConditionFieldReaders(
      { ...ctx, graph: failingStore },
      FIELD_ID,
    );
    expect(r.readers).toEqual([]);
    // The whole finding: nothing was scanned, so the result must NOT present
    // itself as a finished, complete enumeration. `field_360` gates its caveat
    // on `truncated`; `safe_to_delete_field` flips to "safe" on an empty list.
    expect(r.truncated).toBe(true);
    expect(r.scanFailed).toBe(true);
    expect(r.scannedCount).toBe(0);
    expect(r.scanError).toContain('duckdb');
  });

  it('a CEILING-capped walk is truncated but NOT failed, and reports the true total', async () => {
    process.env['SFI_NODE_SCAN_LIMIT'] = '1';
    process.env['SFI_CONDITION_SCAN_MAX'] = '1';
    const r = await scanFlowConditionFieldReaders(ctx, FIELD_ID);
    expect(r.truncated).toBe(true);
    expect(r.scanFailed).toBe(false);
    expect(r.scanError).toBeNull();
    // The walk stopped before the only reader — absent, but DISCLOSED.
    expect(r.readers).toEqual([]);
    expect(r.scannedCount).toBe(1);
    expect(r.totalCount).toBe(3);
  });
});
