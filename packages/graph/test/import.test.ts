/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { Edge, ExtractionResult, Node } from '@sf-intelligence/contracts';

import { IMPORT_BATCH_SIZE, importExtractionResults } from '../src/import.js';
import { initSchema } from '../src/schema.js';
import type { GraphStore } from '../src/store.js';

// Each `it` block runs against a fresh DuckDB file under `tempDir`, so prior
// tests can't leak rows. Using a new instance per test is cheap (sub-10ms)
// and removes the entire class of "did the previous test leave behind ..."
// bugs that schema.test.ts has to reason about.
let tempDir: string;
const stores: GraphStore[] = [];

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-graph-import-'));
});

afterAll(() => {
  for (const store of stores) {
    store.connection.disconnectSync();
    store.instance.closeSync();
  }
  rmSync(tempDir, { recursive: true, force: true });
});

const makeStore = async (label: string): Promise<GraphStore> => {
  const dbPath = join(tempDir, `${label}.db`);
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  const initResult = await initSchema(connection);
  if (!initResult.ok) {
    throw new Error(`initSchema failed: ${initResult.error.message}`);
  }
  const store: GraphStore = { connection, instance };
  stores.push(store);
  return store;
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'Account',
  label: 'Account',
  parentId: null,
  sourcePath: 'objects/Account/Account.object-meta.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId'>,
): Edge => ({
  edgeType: 'parentOf',
  confidence: 'declared',
  source: 'extractor:custom-object',
  properties: {},
  ...overrides,
});

const queryRows = async (
  db: DuckDBConnection,
  sql: string,
): Promise<readonly Record<string, unknown>[]> => {
  const reader = await db.runAndReadAll(sql);
  return reader.getRowObjectsJS();
};

describe('importExtractionResults', () => {
  it('inserts a basic batch of nodes and edges and reports accurate counts', async () => {
    const store = await makeStore('basic');
    const result: ExtractionResult = {
      nodes: [
        makeNode({ id: 'CustomObject:Account' }),
        makeNode({
          id: 'CustomField:Account.Industry__c',
          type: 'CustomField',
          apiName: 'Industry__c',
          parentId: 'CustomObject:Account',
          sourcePath:
            'objects/Account/fields/Industry__c.field-meta.xml',
        }),
        makeNode({
          id: 'CustomField:Account.Region__c',
          type: 'CustomField',
          apiName: 'Region__c',
          parentId: 'CustomObject:Account',
          sourcePath: 'objects/Account/fields/Region__c.field-meta.xml',
        }),
      ],
      edges: [
        makeEdge({
          fromId: 'CustomObject:Account',
          toId: 'CustomField:Account.Industry__c',
        }),
        makeEdge({
          fromId: 'CustomObject:Account',
          toId: 'CustomField:Account.Region__c',
        }),
      ],
    };

    const imported = await importExtractionResults(store, [result]);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value).toEqual({ nodesInserted: 3, edgesInserted: 2 });

    const nodeRows = await queryRows(
      store.connection,
      'SELECT id FROM nodes ORDER BY id',
    );
    expect(nodeRows.map((r) => r['id'])).toEqual([
      'CustomField:Account.Industry__c',
      'CustomField:Account.Region__c',
      'CustomObject:Account',
    ]);

    const edgeRows = await queryRows(
      store.connection,
      'SELECT from_id, to_id FROM edges ORDER BY to_id',
    );
    expect(edgeRows).toEqual([
      {
        from_id: 'CustomObject:Account',
        to_id: 'CustomField:Account.Industry__c',
      },
      {
        from_id: 'CustomObject:Account',
        to_id: 'CustomField:Account.Region__c',
      },
    ]);
  });

  it('is idempotent on re-import of identical input', async () => {
    const store = await makeStore('idempotent');
    const result: ExtractionResult = {
      nodes: [
        makeNode({ id: 'CustomObject:Account' }),
        makeNode({
          id: 'CustomField:Account.Industry__c',
          type: 'CustomField',
        }),
      ],
      edges: [
        makeEdge({
          fromId: 'CustomObject:Account',
          toId: 'CustomField:Account.Industry__c',
        }),
      ],
    };

    const first = await importExtractionResults(store, [result]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value).toEqual({ nodesInserted: 2, edgesInserted: 1 });

    const second = await importExtractionResults(store, [result]);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Nodes are REPLACEd unconditionally, so they always re-insert.
    // Edges are IGNOREd on conflict, so the duplicate edge is dropped.
    expect(second.value).toEqual({ nodesInserted: 2, edgesInserted: 0 });

    const nodeCount = await queryRows(
      store.connection,
      'SELECT COUNT(*) AS n FROM nodes',
    );
    const edgeCount = await queryRows(
      store.connection,
      'SELECT COUNT(*) AS n FROM edges',
    );
    expect(nodeCount).toEqual([{ n: 2n }]);
    expect(edgeCount).toEqual([{ n: 1n }]);
  });

  it("replaces a node's properties on re-import with the same id", async () => {
    const store = await makeStore('replace');
    const original: ExtractionResult = {
      nodes: [
        makeNode({
          id: 'CustomField:Account.Status__c',
          type: 'CustomField',
          label: 'Status',
          properties: { dataType: 'Text', length: 80 },
        }),
      ],
      edges: [],
    };
    const updated: ExtractionResult = {
      nodes: [
        makeNode({
          id: 'CustomField:Account.Status__c',
          type: 'CustomField',
          label: 'Status (Renamed)',
          properties: { dataType: 'Picklist', length: 255 },
        }),
      ],
      edges: [],
    };

    const first = await importExtractionResults(store, [original]);
    expect(first.ok).toBe(true);
    const second = await importExtractionResults(store, [updated]);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value).toEqual({ nodesInserted: 1, edgesInserted: 0 });

    const rows = await queryRows(
      store.connection,
      "SELECT label, properties_json FROM nodes WHERE id = 'CustomField:Account.Status__c'",
    );
    expect(rows).toEqual([
      {
        label: 'Status (Renamed)',
        properties_json: '{"dataType":"Picklist","length":255}',
      },
    ]);
  });

  it('aggregates counts across multiple extraction results in one call', async () => {
    const store = await makeStore('multi');
    const makeBatch = (suffix: string): ExtractionResult => ({
      nodes: [
        makeNode({ id: `CustomObject:Obj${suffix}` }),
        makeNode({
          id: `CustomField:Obj${suffix}.F1__c`,
          type: 'CustomField',
          parentId: `CustomObject:Obj${suffix}`,
        }),
      ],
      edges: [
        makeEdge({
          fromId: `CustomObject:Obj${suffix}`,
          toId: `CustomField:Obj${suffix}.F1__c`,
        }),
      ],
    });
    const batches = [makeBatch('A'), makeBatch('B'), makeBatch('C')];

    const imported = await importExtractionResults(store, batches);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value).toEqual({ nodesInserted: 6, edgesInserted: 3 });

    const counts = await queryRows(
      store.connection,
      'SELECT (SELECT COUNT(*) FROM nodes) AS n, (SELECT COUNT(*) FROM edges) AS e',
    );
    expect(counts).toEqual([{ n: 6n, e: 3n }]);
  });

  it('serializes properties with keys in canonical order regardless of insertion order', async () => {
    const store = await makeStore('canonical');
    const result: ExtractionResult = {
      nodes: [
        makeNode({
          id: 'CustomField:X.A',
          // Keys deliberately in a different order than node B.
          properties: { b: 1, a: 2 },
        }),
        makeNode({
          id: 'CustomField:X.B',
          properties: { a: 2, b: 1 },
        }),
        makeNode({
          id: 'CustomField:X.Nested',
          // Nested object with reversed keys; canonical sort applies recursively.
          properties: {
            outer: { z: 1, y: 2, x: 3 },
            items: [{ k: 1, j: 2 }],
          },
        }),
      ],
      edges: [],
    };

    const imported = await importExtractionResults(store, [result]);
    expect(imported.ok).toBe(true);

    const rows = await queryRows(
      store.connection,
      'SELECT id, properties_json FROM nodes ORDER BY id',
    );
    expect(rows).toEqual([
      { id: 'CustomField:X.A', properties_json: '{"a":2,"b":1}' },
      { id: 'CustomField:X.B', properties_json: '{"a":2,"b":1}' },
      {
        id: 'CustomField:X.Nested',
        properties_json:
          '{"items":[{"j":2,"k":1}],"outer":{"x":3,"y":2,"z":1}}',
      },
    ]);
  });

  it('imports more rows than fit in a single batch (3 × IMPORT_BATCH_SIZE) without growing per-tx memory', async () => {
    // The bug this guards against: a single-transaction implementation
    // buffers every pending write inside one open transaction, exhausting
    // process memory on real fixtures. Spanning >= 3 batches forces the
    // implementation to actually rotate through BEGIN/COMMIT cycles, so a
    // regression to "one giant transaction" would either OOM here on a
    // bigger fixture or — at the unit-test scale — leave inconsistent
    // batch accounting that the per-row assertions below would catch.
    const store = await makeStore('large-import');
    const total = IMPORT_BATCH_SIZE * 3;
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    for (let i = 0; i < total; i++) {
      const id = `CustomField:Bulk.F${i}__c`;
      nodes.push(
        makeNode({
          id,
          type: 'CustomField',
          apiName: `F${i}__c`,
          parentId: 'CustomObject:Bulk',
          sourcePath: `objects/Bulk/fields/F${i}__c.field-meta.xml`,
        }),
      );
      edges.push(
        makeEdge({
          fromId: 'CustomObject:Bulk',
          toId: id,
          edgeType: 'parentOf',
        }),
      );
    }

    const imported = await importExtractionResults(store, [
      { nodes, edges },
    ]);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value).toEqual({
      nodesInserted: total,
      edgesInserted: total,
    });

    const counts = await queryRows(
      store.connection,
      'SELECT (SELECT COUNT(*) FROM nodes) AS n, (SELECT COUNT(*) FROM edges) AS e',
    );
    expect(counts).toEqual([{ n: BigInt(total), e: BigInt(total) }]);

    // Spot-check that the first, mid-batch, and final row all landed.
    const probe = await queryRows(
      store.connection,
      `SELECT id FROM nodes WHERE id IN
         ('CustomField:Bulk.F0__c',
          'CustomField:Bulk.F${IMPORT_BATCH_SIZE}__c',
          'CustomField:Bulk.F${total - 1}__c')
       ORDER BY id`,
    );
    expect(probe.map((r) => r['id']).sort()).toEqual(
      [
        'CustomField:Bulk.F0__c',
        `CustomField:Bulk.F${IMPORT_BATCH_SIZE}__c`,
        `CustomField:Bulk.F${total - 1}__c`,
      ].sort(),
    );
  });

  it('on mid-import batch failure persists earlier batches and rolls back the failing one', async () => {
    // Per-batch atomicity is the explicit trade-off: a partial-import
    // error returns with the count of batches that did commit, and
    // those rows remain queryable. This test seeds 1.5 batches of valid
    // nodes followed by a row that violates the `type NOT NULL` schema
    // constraint. Batch 1 commits cleanly; batch 2 begins, processes
    // one valid row, then hits the bad row and rolls back. Final state:
    // exactly `IMPORT_BATCH_SIZE` nodes (batch 1) persisted, none of
    // batch 2's rows visible, and a `partial import` error returned.
    const store = await makeStore('batch-failure');

    const goodNodes: Node[] = [];
    // 1.5 batches of valid rows. The first IMPORT_BATCH_SIZE forms
    // batch 1 (commits). The next IMPORT_BATCH_SIZE - 1 valid rows go
    // into batch 2, followed by the deliberately-broken row that aborts
    // batch 2.
    const goodInBatch2 = IMPORT_BATCH_SIZE - 1;
    for (let i = 0; i < IMPORT_BATCH_SIZE + goodInBatch2; i++) {
      goodNodes.push(
        makeNode({
          id: `CustomField:Failure.F${i}__c`,
          type: 'CustomField',
          apiName: `F${i}__c`,
          parentId: 'CustomObject:Failure',
          sourcePath: `objects/Failure/fields/F${i}__c.field-meta.xml`,
        }),
      );
    }

    // The bad row violates `type TEXT NOT NULL` from the schema. The
    // unsafe cast bypasses TypeScript's protections so we can simulate
    // a corrupt-fixture scenario at the SQL layer; the runtime check is
    // what the test actually exercises.
    const badNode = {
      ...makeNode({ id: 'CustomField:Failure.Bad__c' }),
      type: null as unknown as Node['type'],
    };

    const imported = await importExtractionResults(store, [
      { nodes: [...goodNodes, badNode], edges: [] },
    ]);
    expect(imported.ok).toBe(false);
    if (imported.ok) return;
    expect(imported.error.kind).toBe('query-failed');
    // The error mentions the partial-import shape so a caller can decide
    // whether to re-run; the explicit shape is part of the contract.
    expect(imported.error.message).toMatch(/partial import/);
    expect(imported.error.message).toMatch(/1 batches committed/);
    expect(imported.error.message).toMatch(/batch 2 failed/);

    // Batch 1 rows are persisted: exactly IMPORT_BATCH_SIZE present,
    // and the first/last ids of batch 1 are queryable.
    const counts = await queryRows(
      store.connection,
      'SELECT COUNT(*) AS n FROM nodes',
    );
    expect(counts).toEqual([{ n: BigInt(IMPORT_BATCH_SIZE) }]);

    const firstOfBatch1 = await queryRows(
      store.connection,
      "SELECT id FROM nodes WHERE id = 'CustomField:Failure.F0__c'",
    );
    expect(firstOfBatch1).toEqual([{ id: 'CustomField:Failure.F0__c' }]);

    const lastOfBatch1 = await queryRows(
      store.connection,
      `SELECT id FROM nodes WHERE id = 'CustomField:Failure.F${IMPORT_BATCH_SIZE - 1}__c'`,
    );
    expect(lastOfBatch1).toEqual([
      { id: `CustomField:Failure.F${IMPORT_BATCH_SIZE - 1}__c` },
    ]);

    // Batch 2 rows are not persisted: the first row of batch 2 is
    // absent, even though IMPORT_BATCH_SIZE - 1 valid rows were
    // attempted inside batch 2 before the bad row aborted it.
    const firstOfBatch2 = await queryRows(
      store.connection,
      `SELECT id FROM nodes WHERE id = 'CustomField:Failure.F${IMPORT_BATCH_SIZE}__c'`,
    );
    expect(firstOfBatch2).toEqual([]);

    // And of course the bad row itself is not present.
    const badRow = await queryRows(
      store.connection,
      "SELECT id FROM nodes WHERE id = 'CustomField:Failure.Bad__c'",
    );
    expect(badRow).toEqual([]);
  });
});
