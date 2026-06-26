/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDBInstance } from '@duckdb/node-api';
import type { Edge, ExtractionResult, Node } from '@sf-intelligence/contracts';

import {
  applyChangeSet,
  type ChangeSet,
  computeChangeSet,
} from '../src/apply-change-set.js';
import { IMPORT_BATCH_SIZE, importExtractionResults } from '../src/import.js';
import { initSchema } from '../src/schema.js';
import type { GraphStore } from '../src/store.js';

// Part 1 of CR-20: the four per-row write loops in applyChangeSet are batched
// into multi-row VALUES statements inside the SAME single transaction. These
// tests pin (a) the chunking shape (one statement per IMPORT_BATCH_SIZE slice),
// (b) the all-or-nothing atomicity is preserved ACROSS chunks (a mid-apply
// failure in a non-first chunk still rolls the WHOLE apply back — proves no
// per-chunk commit crept in), and (c) the multi-chunk end state is byte-
// identical to a cold rebuild.

let tempDir: string;
const stores: GraphStore[] = [];

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-graph-batch-'));
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
  const dbPath = join(tempDir, `batch-${storeCounter++}.db`);
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  const initResult = await initSchema(connection);
  if (!initResult.ok) throw new Error(`initSchema failed: ${initResult.error.message}`);
  const store: GraphStore = { connection, instance };
  stores.push(store);
  return store;
};

const apexNode = (i: number, overrides?: Partial<Node>): Node => ({
  id: `ApexClass:C${i}`,
  type: 'ApexClass',
  apiName: `C${i}`,
  label: `C${i}`,
  parentId: null,
  sourcePath: `classes/C${i}.cls`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const callEdge = (from: number, to: number): Edge => ({
  fromId: `ApexClass:C${from}`,
  toId: `ApexClass:C${to}`,
  edgeType: 'references',
  confidence: 'declared',
  source: 'extractor:test',
  properties: {},
});

const dump = async (store: GraphStore): Promise<string> => {
  const q = async (sql: string): Promise<readonly Record<string, unknown>[]> => {
    const reader = await store.connection.runAndReadAll(sql);
    return reader.getRowObjectsJS() as readonly Record<string, unknown>[];
  };
  const nodes = await q(
    `SELECT id, type, api_name, label, parent_id, source_path,
            last_modified_date, last_modified_by, api_version, properties_json
     FROM nodes ORDER BY id`,
  );
  const edges = await q(
    `SELECT from_id, to_id, edge_type, confidence, source, properties_json
     FROM edges ORDER BY from_id, to_id, edge_type, source`,
  );
  return JSON.stringify({ nodes, edges });
};

const importInto = async (
  store: GraphStore,
  results: readonly ExtractionResult[],
): Promise<void> => {
  const r = await importExtractionResults(store, results);
  if (!r.ok) throw new Error(`import failed: ${r.error.message}`);
};

describe('applyChangeSet — Part 1 batched writes', () => {
  it('atomic ROLLBACK across a MULTI-chunk upsert (no per-chunk commit)', async () => {
    // > 2x IMPORT_BATCH_SIZE upsert nodes onto an empty graph, with a NOT NULL
    // violation placed in a NON-first chunk. If a per-chunk commit had been
    // introduced (import.ts commitBatched style), the earlier chunks would
    // persist and the dump would differ. With a single transaction the whole
    // thing rolls back to the pre-apply (empty) state.
    const store = await makeStore();
    const before = await dump(store);

    const n = IMPORT_BATCH_SIZE * 2 + 10; // spans 3 chunks
    const upsertNodes: Node[] = [];
    for (let i = 0; i < n; i += 1) upsertNodes.push(apexNode(i));
    // Poison a row inside the LAST chunk (index well past 2x batch size).
    const poisonIdx = IMPORT_BATCH_SIZE * 2 + 5;
    upsertNodes[poisonIdx] = apexNode(poisonIdx, {
      apiName: null as unknown as string,
    });

    const finalNodeIds = new Set(upsertNodes.map((nd) => nd.id));
    const badCs: ChangeSet = {
      upsertNodes,
      deleteNodeIds: [],
      upsertEdges: [],
      deleteEdgeKeys: [],
      finalNodeIds,
      desiredNodeCount: n,
      desiredEdgeCount: 0,
    };

    const applied = await applyChangeSet(store, badCs);
    expect(applied.ok).toBe(false);
    // Byte-for-byte unchanged → no earlier chunk committed.
    expect(await dump(store)).toBe(before);
  });

  it('> 2x IMPORT_BATCH_SIZE: end state byte-identical to a cold rebuild', async () => {
    const n = IMPORT_BATCH_SIZE * 2 + 37; // > 2 chunks of nodes
    const s2Nodes: Node[] = [];
    for (let i = 0; i < n; i += 1) s2Nodes.push(apexNode(i));
    // A dense edge set well over IMPORT_BATCH_SIZE too (chain each → next).
    const s2Edges: Edge[] = [];
    for (let i = 0; i + 1 < n; i += 1) s2Edges.push(callEdge(i, i + 1));
    const s2: ExtractionResult[] = [{ nodes: s2Nodes, edges: s2Edges }];

    const cold = await makeStore();
    await importInto(cold, s2);
    const coldDump = await dump(cold);

    // Seed the incremental store with a smaller S1 so the change set is large
    // but built off a non-empty graph (exercises real diff + multi-chunk).
    const incremental = await makeStore();
    const s1: ExtractionResult[] = [{ nodes: [apexNode(0)], edges: [] }];
    await importInto(incremental, s1);
    const csResult = await computeChangeSet(incremental, s2);
    expect(csResult.ok).toBe(true);
    if (!csResult.ok) return;
    expect(csResult.value.upsertNodes.length).toBeGreaterThan(IMPORT_BATCH_SIZE * 2);
    const applied = await applyChangeSet(incremental, csResult.value);
    expect(applied.ok).toBe(true);
    expect(await dump(incremental)).toBe(coldDump);
  });

  it('issues ceil(N / IMPORT_BATCH_SIZE) multi-row node statements (chunking shape)', async () => {
    const store = await makeStore();
    const n = IMPORT_BATCH_SIZE * 2 + 1; // 3 node chunks
    const m = IMPORT_BATCH_SIZE + 3; // 2 edge chunks (m edges over n nodes)
    const nodes: Node[] = [];
    for (let i = 0; i < n; i += 1) nodes.push(apexNode(i));
    const edges: Edge[] = [];
    for (let i = 0; i < m; i += 1) edges.push(callEdge(i, i + 1));
    const finalNodeIds = new Set(nodes.map((nd) => nd.id));
    const cs: ChangeSet = {
      upsertNodes: nodes,
      deleteNodeIds: [],
      upsertEdges: edges,
      deleteEdgeKeys: [],
      finalNodeIds,
      desiredNodeCount: n,
      desiredEdgeCount: m,
    };

    // Spy on connection.run, classifying each SQL by its leading verb/table.
    const calls: string[] = [];
    const realRun = store.connection.run.bind(store.connection);
    (store.connection as { run: typeof store.connection.run }).run = ((
      sql: string,
      params?: unknown,
    ) => {
      calls.push(sql);
      return realRun(sql, params as never);
    }) as typeof store.connection.run;

    try {
      const applied = await applyChangeSet(store, cs);
      expect(applied.ok).toBe(true);
    } finally {
      (store.connection as { run: typeof store.connection.run }).run = realRun;
    }

    const nodeInserts = calls.filter((s) => /INSERT OR REPLACE INTO nodes/i.test(s));
    const edgeInserts = calls.filter((s) => /INSERT OR REPLACE INTO edges/i.test(s));
    expect(nodeInserts.length).toBe(Math.ceil(n / IMPORT_BATCH_SIZE));
    expect(edgeInserts.length).toBe(Math.ceil(m / IMPORT_BATCH_SIZE));
  });
});
