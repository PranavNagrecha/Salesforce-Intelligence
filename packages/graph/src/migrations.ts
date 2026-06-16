import type { DuckDBConnection } from '@duckdb/node-api';
import type { Result } from '@sf-intelligence/core';

import { initSchema } from './schema.js';
import type { GraphError } from './store.js';

/**
 * Run all pending migrations against an open DuckDB connection.
 *
 * v0.1 has exactly one migration step — the initial schema in
 * `initSchema` — so this function is currently a thin wrapper.
 * The wrapper exists so v0.2+ can add ordered, versioned migration
 * steps (e.g., new tables, column additions) without restructuring
 * the call sites in `openGraph` or the CLI's refresh pipeline.
 *
 * Future migrations are intended to be appended *after* `initSchema`
 * here, gated by a `schema_version` table that this module would
 * read on entry. We deliberately avoid building that scaffolding
 * in v0.1: a `CREATE TABLE IF NOT EXISTS` for `schema_version`
 * would itself be a migration, and v0.2 will introduce the
 * versioning machinery when the first real migration arrives.
 *
 * @example
 *   const instance = await DuckDBInstance.create('org-kb/graph/graph.duckdb');
 *   const connection = await instance.connect();
 *   const result = await runMigrations(connection);
 *   if (!result.ok) {
 *     console.error(result.error.message);
 *     return;
 *   }
 */
export const runMigrations = async (
  db: DuckDBConnection,
): Promise<Result<void, GraphError>> => {
  // v0.2+: read schema_version, then run any pending steps in order.
  return initSchema(db);
};
