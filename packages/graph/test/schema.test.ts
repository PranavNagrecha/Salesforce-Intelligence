/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

import { initSchema } from '../src/schema.js';

// One temp DB per test file. Each `it` block runs against the *same*
// connection because the schema is idempotent — re-running `initSchema`
// inside a test must remain a no-op even when prior tests have populated
// tables.
let tempDir: string;
let dbPath: string;
let instance: DuckDBInstance;
let connection: DuckDBConnection;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-graph-schema-'));
  dbPath = join(tempDir, 'org-kb.db');
  instance = await DuckDBInstance.create(dbPath);
  connection = await instance.connect();
});

afterAll(() => {
  connection.disconnectSync();
  instance.closeSync();
  rmSync(tempDir, { recursive: true, force: true });
});

// Helper: read all rows from a query as plain JS-typed row objects.
const queryRows = async (
  db: DuckDBConnection,
  sql: string,
): Promise<readonly Record<string, unknown>[]> => {
  const reader = await db.runAndReadAll(sql);
  return reader.getRowObjectsJS();
};

describe('initSchema', () => {
  it('creates the nodes, edges, and facts tables on a fresh database', async () => {
    const result = await initSchema(connection);
    expect(result.ok).toBe(true);

    const tables = await queryRows(
      connection,
      "SELECT table_name FROM duckdb_tables() WHERE schema_name = 'main' ORDER BY table_name",
    );
    const names = tables.map((row) => row['table_name']);
    // CR-19 appended the schema_version ledger to the base schema.
    expect(names).toEqual(['edges', 'facts', 'nodes', 'schema_version']);
  });

  it('creates the expected columns on `nodes` with the documented types', async () => {
    const columns = await queryRows(
      connection,
      "SELECT column_name, data_type FROM duckdb_columns() WHERE table_name = 'nodes' ORDER BY column_index",
    );
    expect(columns).toEqual([
      { column_name: 'id', data_type: 'VARCHAR' },
      { column_name: 'type', data_type: 'VARCHAR' },
      { column_name: 'api_name', data_type: 'VARCHAR' },
      { column_name: 'label', data_type: 'VARCHAR' },
      { column_name: 'parent_id', data_type: 'VARCHAR' },
      { column_name: 'source_path', data_type: 'VARCHAR' },
      { column_name: 'last_modified_date', data_type: 'VARCHAR' },
      { column_name: 'last_modified_by', data_type: 'VARCHAR' },
      // DuckDB normalizes the SQL keyword `REAL` to its 32-bit `FLOAT`
      // storage type. This is a property of DuckDB's type system, not a
      // schema mismatch with ARCHITECTURE.md.
      { column_name: 'api_version', data_type: 'FLOAT' },
      { column_name: 'properties_json', data_type: 'VARCHAR' },
    ]);
  });

  it('creates the expected columns on `edges` with the documented types', async () => {
    const columns = await queryRows(
      connection,
      "SELECT column_name, data_type FROM duckdb_columns() WHERE table_name = 'edges' ORDER BY column_index",
    );
    expect(columns).toEqual([
      { column_name: 'from_id', data_type: 'VARCHAR' },
      { column_name: 'to_id', data_type: 'VARCHAR' },
      { column_name: 'edge_type', data_type: 'VARCHAR' },
      { column_name: 'confidence', data_type: 'VARCHAR' },
      { column_name: 'source', data_type: 'VARCHAR' },
      { column_name: 'properties_json', data_type: 'VARCHAR' },
    ]);
  });

  it('creates all four named indexes', async () => {
    const indexes = await queryRows(
      connection,
      "SELECT index_name FROM duckdb_indexes() WHERE schema_name = 'main' ORDER BY index_name",
    );
    const names = indexes.map((row) => row['index_name']);
    expect(names).toEqual([
      'idx_edges_from',
      'idx_edges_to',
      'idx_nodes_parent',
      'idx_nodes_type',
    ]);
  });

  it('is idempotent — calling a second time does not error', async () => {
    const second = await initSchema(connection);
    expect(second.ok).toBe(true);

    // And a third time, for paranoia. The point is `CREATE ... IF NOT EXISTS`
    // works whether the table was created in this process or a prior one.
    const third = await initSchema(connection);
    expect(third.ok).toBe(true);
  });

  it('accepts an inserted node row and reads it back', async () => {
    await connection.run(`INSERT INTO nodes (
      id, type, api_name, label, parent_id, source_path,
      last_modified_date, last_modified_by, api_version, properties_json
    ) VALUES (
      'CustomObject:Account', 'CustomObject', 'Account', 'Account',
      NULL, 'objects/Account/Account.object-meta.xml',
      NULL, NULL, NULL, '{}'
    );`);

    const rows = await queryRows(
      connection,
      "SELECT id, type, api_name, source_path FROM nodes WHERE id = 'CustomObject:Account'",
    );
    expect(rows).toEqual([
      {
        id: 'CustomObject:Account',
        type: 'CustomObject',
        api_name: 'Account',
        source_path: 'objects/Account/Account.object-meta.xml',
      },
    ]);
  });

  it("rejects a duplicate node id (primary key on `nodes.id`)", async () => {
    // Re-insert the same id from the previous test. DuckDB raises a
    // constraint violation; we surface it as the thrown error from
    // `connection.run`.
    await expect(
      connection.run(`INSERT INTO nodes (
        id, type, api_name, label, parent_id, source_path,
        last_modified_date, last_modified_by, api_version, properties_json
      ) VALUES (
        'CustomObject:Account', 'CustomObject', 'Account', 'Account Again',
        NULL, 'objects/Account/Account.object-meta.xml',
        NULL, NULL, NULL, '{}'
      );`),
    ).rejects.toThrow();
  });

  it('accepts an edge row and reads it back', async () => {
    // Insert a child node so the edge points at a real id (the edge table
    // itself has no FK, but it lets the read assert all six columns).
    await connection.run(`INSERT INTO nodes (
      id, type, api_name, label, parent_id, source_path,
      last_modified_date, last_modified_by, api_version, properties_json
    ) VALUES (
      'CustomField:Account.Industry__c', 'CustomField', 'Industry__c', 'Industry',
      'CustomObject:Account', 'objects/Account/fields/Industry__c.field-meta.xml',
      NULL, NULL, NULL, '{}'
    );`);

    await connection.run(`INSERT INTO edges (
      from_id, to_id, edge_type, confidence, source, properties_json
    ) VALUES (
      'CustomObject:Account', 'CustomField:Account.Industry__c', 'parentOf',
      'declared', 'extractor:custom-field', '{}'
    );`);

    const rows = await queryRows(
      connection,
      `SELECT from_id, to_id, edge_type, confidence, source
       FROM edges
       WHERE from_id = 'CustomObject:Account'`,
    );
    expect(rows).toEqual([
      {
        from_id: 'CustomObject:Account',
        to_id: 'CustomField:Account.Industry__c',
        edge_type: 'parentOf',
        confidence: 'declared',
        source: 'extractor:custom-field',
      },
    ]);
  });

  it('rejects a duplicate edge with the same composite primary key', async () => {
    // Same `(from_id, to_id, edge_type, source)` as the row inserted above.
    await expect(
      connection.run(`INSERT INTO edges (
        from_id, to_id, edge_type, confidence, source, properties_json
      ) VALUES (
        'CustomObject:Account', 'CustomField:Account.Industry__c', 'parentOf',
        'declared', 'extractor:custom-field', '{"updated": true}'
      );`),
    ).rejects.toThrow();
  });
});
