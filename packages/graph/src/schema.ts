import type { DuckDBConnection } from '@duckdb/node-api';
import { err, ok, type Result } from '@sf-intelligence/core';

import type { GraphError } from './store.js';

/**
 * The raw DDL strings that define the v0.1 graph schema, kept as a single
 * frozen object so callers (tests, migrations, future tooling) can reference
 * any individual statement by name without duplicating SQL text.
 *
 * Each statement uses `IF NOT EXISTS` to make `initSchema` idempotent —
 * running it against an already-initialized database is a no-op.
 *
 * Mirrors the "Graph schema (DuckDB)" section of `ARCHITECTURE.md` verbatim:
 *   - `nodes` is keyed by canonical component id; one row per Salesforce
 *     metadata component.
 *   - `edges` is keyed by `(from_id, to_id, edge_type, source)` so the same
 *     extractor re-running yields an upsert rather than a duplicate.
 *   - `facts` (P13-FACTS-store) holds record-DATA-derived observations
 *     (approximate counts, fill rates, fired tallies) keyed by
 *     `(subject_id, metric, source)` — OUTSIDE nodes/edges and outside the
 *     A7 refresh-integrity comparison surface, which digests nodes+edges
 *     only. Refresh imports never touch it; rows persist until re-captured.
 *   - Four indexes accelerate the common access paths: lookup by node type,
 *     by parent (children of an object), and edges incident to a node from
 *     either direction.
 */
export const SCHEMA_DDL = {
  nodes: `CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  api_name TEXT NOT NULL,
  label TEXT,
  parent_id TEXT,
  source_path TEXT NOT NULL,
  last_modified_date TEXT,
  last_modified_by TEXT,
  api_version REAL,
  properties_json TEXT NOT NULL
);`,
  edges: `CREATE TABLE IF NOT EXISTS edges (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  confidence TEXT NOT NULL,
  source TEXT NOT NULL,
  properties_json TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, edge_type, source)
);`,
  facts: `CREATE TABLE IF NOT EXISTS facts (
  subject_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  value_json TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  method TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (subject_id, metric, source)
);`,
  indexNodesType: `CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);`,
  indexNodesParent: `CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);`,
  indexEdgesFrom: `CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);`,
  indexEdgesTo: `CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);`,
} as const;

// Ordered so the indexes only run after their parent tables exist. Doesn't
// matter for `IF NOT EXISTS` correctness but keeps the failure mode obvious
// if a future statement drops the guard.
const SCHEMA_STATEMENTS: readonly string[] = [
  SCHEMA_DDL.nodes,
  SCHEMA_DDL.edges,
  SCHEMA_DDL.facts,
  SCHEMA_DDL.indexNodesType,
  SCHEMA_DDL.indexNodesParent,
  SCHEMA_DDL.indexEdgesFrom,
  SCHEMA_DDL.indexEdgesTo,
];

/**
 * Run the v0.1 schema DDL idempotently against an open DuckDB connection.
 *
 * Safe to call multiple times on the same database — every statement is
 * `CREATE ... IF NOT EXISTS`, so a second call is a no-op. Migrations
 * orchestration belongs in `runMigrations` (see `./migrations.ts`); this
 * function only owns the initial schema.
 *
 * @example
 *   const instance = await DuckDBInstance.create('org-kb/graph/graph.duckdb');
 *   const connection = await instance.connect();
 *   const result = await initSchema(connection);
 *   if (!result.ok) {
 *     console.error(result.error.message);
 *     return;
 *   }
 */
export const initSchema = async (
  db: DuckDBConnection,
): Promise<Result<void, GraphError>> => {
  for (const sql of SCHEMA_STATEMENTS) {
    try {
      await db.run(sql);
    } catch (e) {
      return err({
        kind: 'schema-error',
        message: `initSchema failed: ${(e as Error).message}`,
      });
    }
  }
  return ok(undefined);
};
