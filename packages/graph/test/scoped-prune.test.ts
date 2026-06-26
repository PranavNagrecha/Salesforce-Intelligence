/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDBInstance } from '@duckdb/node-api';
import type {
  ComponentType,
  Edge,
  ExtractionResult,
  Node,
} from '@sf-intelligence/contracts';

import {
  computeChangeSet,
  pruneStaleNodes,
} from '../src/apply-change-set.js';
import { IMPORT_BATCH_SIZE, importExtractionResults } from '../src/import.js';
import { initSchema } from '../src/schema.js';
import type { GraphStore } from '../src/store.js';

// Part 2 of CR-20: the scoped/pruned WITH-PULL incremental path. A scoped
// `sfi refresh --types Flow` reconciles ONLY type Flow but the graph holds
// other types (ApexClass, ...). The OLD path routed this through applyChangeSet
// whose whole-graph self-check (global count == reconciled-only desiredNodeCount)
// is WRONG for a partial reconcile, so it rolled back and orphaned stale nodes
// (and on the CLI branch, hard-failed the refresh). The fix (approach b) prunes
// the computed type-scoped delete lists via chunked DELETE transactions, never
// touching surviving types.

let tempDir: string;
const stores: GraphStore[] = [];

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-graph-prune-'));
});

afterAll(() => {
  for (const store of stores) {
    store.connection.disconnectSync();
    store.instance.closeSync();
  }
  rmSync(tempDir, { recursive: true, force: true });
});

let storeCounter = 0;
const makeStore = async (): Promise<GraphStore> => {
  const dbPath = join(tempDir, `prune-${storeCounter++}.db`);
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  const initResult = await initSchema(connection);
  if (!initResult.ok) throw new Error(`initSchema failed: ${initResult.error.message}`);
  const store: GraphStore = { connection, instance };
  stores.push(store);
  return store;
};

const node = (id: string, overrides?: Partial<Node>): Node => {
  const sep = id.indexOf(':');
  const type = id.slice(0, sep) as ComponentType;
  const apiName = id.slice(sep + 1);
  return {
    id,
    type,
    apiName,
    label: apiName,
    parentId: null,
    sourcePath: `src/${apiName}`,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {},
    ...overrides,
  };
};

const edge = (fromId: string, toId: string, overrides?: Partial<Edge>): Edge => ({
  fromId,
  toId,
  edgeType: 'references',
  confidence: 'declared',
  source: 'extractor:test',
  properties: {},
  ...overrides,
});

const importInto = async (
  store: GraphStore,
  results: readonly ExtractionResult[],
): Promise<void> => {
  const r = await importExtractionResults(store, results);
  if (!r.ok) throw new Error(`import failed: ${r.error.message}`);
};

const nodeIds = async (store: GraphStore): Promise<Set<string>> => {
  const reader = await store.connection.runAndReadAll('SELECT id FROM nodes ORDER BY id');
  const rows = reader.getRowObjectsJS() as ReadonlyArray<Record<string, unknown>>;
  return new Set(rows.map((r) => r['id'] as string));
};

const edgePks = async (store: GraphStore): Promise<Set<string>> => {
  const reader = await store.connection.runAndReadAll(
    'SELECT from_id, to_id, edge_type, source FROM edges',
  );
  const rows = reader.getRowObjectsJS() as ReadonlyArray<Record<string, unknown>>;
  return new Set(
    rows.map(
      (r) =>
        `${r['from_id'] as string}|${r['to_id'] as string}|${r['edge_type'] as string}|${r['source'] as string}`,
    ),
  );
};

// Drive the full scoped/pruned reconcile the way refresh.ts does it (approach b):
// importExtractionResults(results) then prune the stale reconciled-type rows.
const scopedReconcile = async (
  store: GraphStore,
  results: readonly ExtractionResult[],
  pruneNodeTypes: ReadonlySet<ComponentType>,
): Promise<void> => {
  await importInto(store, results);
  const cs = await computeChangeSet(store, results, { pruneNodeTypes });
  if (!cs.ok) throw new Error(`computeChangeSet failed: ${cs.error.message}`);
  const pruned = await pruneStaleNodes(store, cs.value);
  if (!pruned.ok) throw new Error(`pruneStaleNodes failed: ${pruned.error.message}`);
};

describe('scoped prune — multi-type graph (CR-20 data-safety headline)', () => {
  it('prunes stale X, keeps fresh X, and type Y SURVIVES', async () => {
    const store = await makeStore();
    // Graph: type Y (ApexClass:Y1, Y2) + type X (Flow:Xold).
    await importInto(store, [
      {
        nodes: [
          node('ApexClass:Y1'),
          node('ApexClass:Y2'),
          node('Flow:Xold'),
        ],
        edges: [],
      },
    ]);

    // Scoped re-extract of Flow only: Xold gone, Xnew present.
    await scopedReconcile(
      store,
      [{ nodes: [node('Flow:Xnew')], edges: [] }],
      new Set<ComponentType>(['Flow']),
    );

    const ids = await nodeIds(store);
    expect(ids.has('Flow:Xold')).toBe(false); // stale X pruned
    expect(ids.has('Flow:Xnew')).toBe(true); // fresh X present
    expect(ids.has('ApexClass:Y1')).toBe(true); // type Y survives
    expect(ids.has('ApexClass:Y2')).toBe(true); // type Y survives
  });

  it('orphan-edge completeness: X-incident edges gone, Y<->Y edges remain', async () => {
    const store = await makeStore();
    await importInto(store, [
      {
        nodes: [
          node('ApexClass:Y1'),
          node('ApexClass:Y2'),
          node('Flow:Xold'),
        ],
        edges: [
          edge('ApexClass:Y1', 'Flow:Xold'), // inbound to X from Y
          edge('Flow:Xold', 'ApexClass:Y2'), // outbound from X to Y
          edge('ApexClass:Y1', 'ApexClass:Y2'), // Y<->Y, must survive
        ],
      },
    ]);

    await scopedReconcile(
      store,
      [{ nodes: [node('Flow:Xnew')], edges: [] }],
      new Set<ComponentType>(['Flow']),
    );

    const ids = await nodeIds(store);
    const pks = await edgePks(store);
    expect(ids.has('Flow:Xold')).toBe(false);
    expect(ids.has('ApexClass:Y1')).toBe(true);
    expect(ids.has('ApexClass:Y2')).toBe(true);
    // every edge incident to X is gone
    expect(pks.has('ApexClass:Y1|Flow:Xold|references|extractor:test')).toBe(false);
    expect(pks.has('Flow:Xold|ApexClass:Y2|references|extractor:test')).toBe(false);
    // Y<->Y edge survives
    expect(pks.has('ApexClass:Y1|ApexClass:Y2|references|extractor:test')).toBe(true);
  });

  it('over-cap scoped prune STILL prunes (never no-ops, never fullRebuild)', async () => {
    const store = await makeStore();
    // Seed > INCREMENTAL_DELTA_CAP worth of stale Flow nodes + a survivor Y.
    const staleFlows: Node[] = [];
    for (let i = 0; i < IMPORT_BATCH_SIZE * 5 + 7; i += 1) {
      staleFlows.push(node(`Flow:Stale${i}`));
    }
    await importInto(store, [
      { nodes: [node('ApexClass:Y1'), ...staleFlows], edges: [] },
    ]);

    // Reconcile Flow to a single fresh node → all stale Flows must drop.
    await scopedReconcile(
      store,
      [{ nodes: [node('Flow:Fresh')], edges: [] }],
      new Set<ComponentType>(['Flow']),
    );

    const ids = await nodeIds(store);
    expect(ids.has('ApexClass:Y1')).toBe(true);
    expect(ids.has('Flow:Fresh')).toBe(true);
    for (let i = 0; i < staleFlows.length; i += 1) {
      expect(ids.has(`Flow:Stale${i}`)).toBe(false);
    }
  });

  it('empty prune delta is a no-op', async () => {
    const store = await makeStore();
    await importInto(store, [
      { nodes: [node('ApexClass:Y1'), node('Flow:X1')], edges: [] },
    ]);
    const before = await nodeIds(store);
    // Reconcile Flow to the SAME content → nothing to prune.
    await scopedReconcile(
      store,
      [{ nodes: [node('Flow:X1')], edges: [] }],
      new Set<ComponentType>(['Flow']),
    );
    const after = await nodeIds(store);
    expect([...after].sort()).toEqual([...before].sort());
  });
});
