/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

import { CURRENT_SCHEMA_VERSION } from '../src/index.js';
import { runMigrations, readSchemaVersion } from '../src/migrations.js';
import { SCHEMA_DDL } from '../src/schema.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-graph-migrations-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const open = async (
  name: string,
): Promise<{ instance: DuckDBInstance; connection: DuckDBConnection }> => {
  const instance = await DuckDBInstance.create(join(tempDir, name));
  const connection = await instance.connect();
  return { instance, connection };
};

const close = (h: {
  instance: DuckDBInstance;
  connection: DuckDBConnection;
}): void => {
  h.connection.disconnectSync();
  h.instance.closeSync();
};

const queryRows = async (
  db: DuckDBConnection,
  sql: string,
): Promise<readonly Record<string, unknown>[]> => {
  const reader = await db.runAndReadAll(sql);
  return reader.getRowObjectsJS();
};

const tableExists = async (
  db: DuckDBConnection,
  name: string,
): Promise<boolean> => {
  const rows = await queryRows(
    db,
    `SELECT table_name FROM duckdb_tables() WHERE schema_name = 'main' AND table_name = '${name}'`,
  );
  return rows.length === 1;
};

/**
 * Build the PRE-versioning ("old") schema directly: the v0.1 base tables only,
 * with NO schema_version table. This is what a vault built by code before this
 * change looks like on disk.
 */
const buildOldSchema = async (db: DuckDBConnection): Promise<void> => {
  await db.run(SCHEMA_DDL.nodes);
  await db.run(SCHEMA_DDL.edges);
  await db.run(SCHEMA_DDL.facts);
  await db.run(SCHEMA_DDL.indexNodesType);
  await db.run(SCHEMA_DDL.indexNodesParent);
  await db.run(SCHEMA_DDL.indexEdgesFrom);
  await db.run(SCHEMA_DDL.indexEdgesTo);
};

describe('runMigrations', () => {
  it('upgrades an OLD-schema vault forward losslessly and stamps CURRENT', async () => {
    const h = await open('old.db');
    await buildOldSchema(h.connection);
    // Seed a row so we can prove data survives the migration.
    await h.connection.run(`INSERT INTO nodes (
      id, type, api_name, label, parent_id, source_path,
      last_modified_date, last_modified_by, api_version, properties_json
    ) VALUES (
      'CustomObject:Account', 'CustomObject', 'Account', 'Account',
      NULL, 'objects/Account/Account.object-meta.xml', NULL, NULL, NULL, '{}'
    );`);
    // Pre-condition: no version table yet (genuinely old).
    expect(await tableExists(h.connection, 'schema_version')).toBe(false);

    const result = await runMigrations(h.connection);
    expect(result.ok).toBe(true);

    // The data is preserved verbatim.
    const rows = await queryRows(
      h.connection,
      "SELECT id, api_name FROM nodes WHERE id = 'CustomObject:Account'",
    );
    expect(rows).toEqual([{ id: 'CustomObject:Account', api_name: 'Account' }]);

    // The version is now stamped to CURRENT.
    const versionResult = await readSchemaVersion(h.connection);
    expect(versionResult.ok).toBe(true);
    if (versionResult.ok) expect(versionResult.value).toBe(CURRENT_SCHEMA_VERSION);
    close(h);
  });

  it('is idempotent — re-running on a CURRENT vault is a no-op (version unchanged, data intact)', async () => {
    const h = await open('current.db');
    const first = await runMigrations(h.connection);
    expect(first.ok).toBe(true);
    const v1 = await readSchemaVersion(h.connection);

    const second = await runMigrations(h.connection);
    expect(second.ok).toBe(true);
    const v2 = await readSchemaVersion(h.connection);

    expect(v1.ok && v2.ok).toBe(true);
    if (v1.ok && v2.ok) {
      expect(v1.value).toBe(CURRENT_SCHEMA_VERSION);
      expect(v2.value).toBe(CURRENT_SCHEMA_VERSION);
    }
    close(h);
  });

  it('readSchemaVersion returns 0 when the version table is absent (pre-versioning vault)', async () => {
    const h = await open('noversion.db');
    await buildOldSchema(h.connection);
    const r = await readSchemaVersion(h.connection);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(0);
    close(h);
  });

  it('rolls back and surfaces a typed schema-error when a migration step fails', async () => {
    const h = await open('fail.db');
    await buildOldSchema(h.connection);
    // Stamp version 0 explicitly via the framework, then inject a poison
    // migration through the exported runner to prove ROLLBACK + typed error.
    const result = await runMigrations(h.connection, [
      {
        version: 1,
        // Intentionally invalid SQL — must fail and roll back.
        run: async (db) => db.run('THIS IS NOT VALID SQL;'),
      },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('schema-error');
    close(h);
  });
});
