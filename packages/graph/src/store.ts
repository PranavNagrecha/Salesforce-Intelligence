import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { err, ok, type Result } from '@sf-intelligence/core';

import { runMigrations } from './migrations.js';

/**
 * The error variants that the graph package's operations can return.
 *
 *   - `not-implemented`: a feature is still a stub. Phase D's remaining
 *     graph-* tasks (import pipeline, query API) replace stubs with real
 *     implementations.
 *   - `open-failed`: the DuckDB instance could not be opened (I/O failure,
 *     corrupt file, permission denied, etc.).
 *   - `schema-error`: opening succeeded but a migration or DDL step failed.
 *   - `query-failed`: a runtime query against the store failed.
 */
export interface GraphError {
  readonly kind:
    | 'not-implemented'
    | 'open-failed'
    | 'locked'
    | 'schema-error'
    | 'query-failed';
  readonly message: string;
}

/**
 * Detect a DuckDB single-writer lock conflict from an open error message.
 *
 * DuckDB allows only one read-write opener of a database file at a time; a
 * second opener (a running `sfi mcp` server holding the vault, or a
 * concurrent `sfi refresh`) fails with an "IO Error: Could not set lock on
 * file ...: Conflicting lock is held in ..." message. We match on the stable
 * fragments of that text so the caller can surface an ACTIONABLE hint instead
 * of a raw, baffling DuckDB error.
 *
 * Pure + exported so it can be unit-tested directly against representative
 * DuckDB strings without provoking a real cross-process lock.
 */
export const isLockConflict = (message: string): boolean => {
  const m = message.toLowerCase();
  return m.includes('could not set lock') || m.includes('conflicting lock');
};

/**
 * The actionable message surfaced when {@link isLockConflict} matches. Names
 * the likely culprit (a running MCP server or a concurrent refresh) and the
 * concrete remedy, then appends the underlying DuckDB error for diagnostics.
 */
export const lockConflictMessage = (path: string, cause: string): string =>
  `vault database at ${path} is locked by another process — most likely a ` +
  "running `sfi mcp` server (your IDE's MCP integration) or a concurrent " +
  '`sfi refresh`. DuckDB allows only one writer at a time. `sfi refresh` ' +
  'handles this AUTOMATICALLY (it rebuilds into a side file and atomically ' +
  'swaps it in; an open MCP server picks up the new vault on its next call ' +
  'via the refresh epoch — no restart needed). Any OTHER writer should stop ' +
  `the holding process and retry. Underlying error: ${cause}`;

/**
 * The handle returned by `openGraph` and consumed by every other graph
 * operation in v0.1.
 *
 * Holds the underlying `DuckDBInstance` (for explicit lifecycle control)
 * and the `DuckDBConnection` used for queries. Callers should treat the
 * fields as opaque and route I/O through the graph package's query API
 * once it lands (Phase D's `graph-query-api` task); this type is exported
 * primarily so that API can accept a `GraphStore` directly.
 */
export interface GraphStore {
  readonly connection: DuckDBConnection;
  readonly instance: DuckDBInstance;
}

/**
 * Open the graph store at the given DuckDB file path.
 *
 * Creates the file if it doesn't exist (DuckDB handles the create-on-open
 * itself), connects to it, and runs all pending migrations before returning.
 * Any failure in any of those steps is surfaced as a typed `GraphError`
 * rather than thrown.
 *
 * The caller is responsible for parent-directory creation: `DuckDBInstance.create`
 * does not `mkdir -p`. v0.1 callers (`sfi refresh`) create `org-kb/graph/`
 * before invoking this.
 *
 * @example
 *   const result = await openGraph('org-kb/graph/graph.duckdb');
 *   if (!result.ok) {
 *     console.error(result.error.message);
 *     return;
 *   }
 *   const store = result.value;
 *   // ... use store.connection for queries ...
 *   await closeGraph(store);
 */
export const openGraph = async (
  path: string,
): Promise<Result<GraphStore, GraphError>> => {
  let instance: DuckDBInstance;
  try {
    instance = await DuckDBInstance.create(path);
  } catch (e) {
    const msg = (e as Error).message;
    return err(
      isLockConflict(msg)
        ? { kind: 'locked', message: lockConflictMessage(path, msg) }
        : { kind: 'open-failed', message: `cannot open graph at ${path}: ${msg}` },
    );
  }

  let connection: DuckDBConnection;
  try {
    connection = await instance.connect();
  } catch (e) {
    instance.closeSync();
    return err({
      kind: 'open-failed',
      message: `cannot connect to graph at ${path}: ${(e as Error).message}`,
    });
  }

  const migrationResult = await runMigrations(connection);
  if (!migrationResult.ok) {
    connection.disconnectSync();
    instance.closeSync();
    return migrationResult;
  }

  return ok({ connection, instance });
};

/**
 * Open the graph store at `path` in READ-ONLY mode.
 *
 * Unlike `openGraph`, this never writes: it does not create the file and does
 * not run migrations (read-only connections cannot run DDL). The file must
 * already exist; a missing or unreadable file surfaces as `open-failed`.
 *
 * This is the correct mode for query-only consumers (the MCP server, the eval
 * harness, fleet read paths): the vault cannot be mutated or corrupted through
 * the handle, and multiple readers can open the same vault concurrently.
 *
 * @example
 *   const r = await openGraphReadOnly('org-kb/graph/graph.duckdb');
 *   if (r.ok) { /* ... read-only queries ... *\/ await closeGraph(r.value); }
 */
export const openGraphReadOnly = async (
  path: string,
): Promise<Result<GraphStore, GraphError>> => {
  let instance: DuckDBInstance;
  try {
    instance = await DuckDBInstance.create(path, { access_mode: 'READ_ONLY' });
  } catch (e) {
    const msg = (e as Error).message;
    return err(
      isLockConflict(msg)
        ? { kind: 'locked', message: lockConflictMessage(path, msg) }
        : {
            kind: 'open-failed',
            message: `cannot open graph read-only at ${path}: ${msg}`,
          },
    );
  }

  try {
    const connection = await instance.connect();
    return ok({ connection, instance });
  } catch (e) {
    instance.closeSync();
    return err({
      kind: 'open-failed',
      message: `cannot connect read-only to graph at ${path}: ${(e as Error).message}`,
    });
  }
};

/**
 * Close a graph store, releasing the DuckDB connection and instance.
 *
 * The `@duckdb/node-api` runtime does not require explicit close —
 * resources are released when the objects are garbage-collected — but
 * `sfi refresh` runs to completion and exits, so closing explicitly
 * keeps the lifecycle obvious and avoids holding the DB file open
 * longer than necessary in long-running embedders (the MCP server).
 *
 * @example
 *   await closeGraph(store);
 */
export const closeGraph = async (store: GraphStore): Promise<void> => {
  store.connection.disconnectSync();
  store.instance.closeSync();
};
