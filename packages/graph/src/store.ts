import type { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { err, ok, type Result } from '@sf-intelligence/core';

import { runMigrations } from './migrations.js';

type DuckDBApi = typeof import('@duckdb/node-api');

/**
 * The error variants that the graph package's operations can return.
 *
 *   - `not-implemented`: a feature is still a stub. Phase D's remaining
 *     graph-* tasks (import pipeline, query API) replace stubs with real
 *     implementations.
 *   - `open-failed`: the DuckDB instance could not be opened (I/O failure,
 *     corrupt file, permission denied, native-binding failure, etc.).
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
 * WINDOWS emits a different string entirely. There the collision is not
 * DuckDB's advisory lock but the OS refusing the open outright:
 * `IO Error: Cannot open file "...": The process cannot access the file
 * because it is being used by another process.` Matching only the POSIX
 * fragments meant a Windows user hit the raw message classified as
 * `open-failed` — losing the actionable remedy this function exists to unlock,
 * on the one platform where the remedy differs and matters most. Found by the
 * Windows CI job on its first real run after being re-armed.
 *
 * Pure + exported so it can be unit-tested directly against representative
 * DuckDB strings without provoking a real cross-process lock.
 */
export const isLockConflict = (message: string): boolean => {
  const m = message.toLowerCase();
  return (
    m.includes('could not set lock') ||
    m.includes('conflicting lock') ||
    // Windows (ERROR_SHARING_VIOLATION, surfaced through DuckDB's IO Error).
    m.includes('being used by another process') ||
    m.includes('sharing violation')
  );
};

/**
 * The actionable message surfaced when {@link isLockConflict} matches. Names
 * the likely culprit (a running MCP server or a concurrent refresh) and the
 * concrete remedy, then appends the underlying DuckDB error for diagnostics.
 *
 * The auto-recovery clause is DERIVED from the platform rather than asserted,
 * because it is only true on POSIX. `sfi refresh` rebuilds into a side file and
 * renames it over the live database — which POSIX permits while another process
 * holds the old inode open, and Windows does not: the rename fails with
 * EPERM/EBUSY for as long as a connected MCP server holds a handle. Telling a
 * Windows user their refresh "handles this AUTOMATICALLY — no restart needed"
 * sends them to look for a bug somewhere else entirely. Fixing the underlying
 * swap needs generation-named database files, which is a change well beyond
 * this message; until then the honest instruction is to close the client.
 */
export const lockConflictMessage = (path: string, cause: string): string => {
  const remedy =
    process.platform === 'win32'
      ? 'On Windows the running server must be stopped first: Windows will not ' +
        'let `sfi refresh` replace a database file while another process holds ' +
        'it open, so close your MCP client (or stop `sfi mcp`), re-run the ' +
        'refresh, then reopen the client and retry.'
      : '`sfi refresh` handles this AUTOMATICALLY (it rebuilds into a side ' +
        'file and atomically swaps it in; an open MCP server picks up the new ' +
        'vault on its next call via the refresh epoch — no restart needed). ' +
        'Any OTHER writer should stop the holding process and retry.';
  return (
    `vault database at ${path} is locked by another process — most likely a ` +
    "running `sfi mcp` server (your IDE's MCP integration) or a concurrent " +
    `\`sfi refresh\`. DuckDB allows only one writer at a time. ${remedy} ` +
    `Underlying error: ${cause}`
  );
};

/**
 * Detect a `@duckdb/node-api` native-binding load failure (INFRA-11).
 *
 * A missing/yanked/platform-mismatched `.node` binary surfaces as a raw
 * `dlopen` / `ERR_DLOPEN_FAILED` / "library not loaded" error at import or
 * first open. Match stable fragments so callers (and `sfi doctor`) can emit
 * an actionable reinstall hint instead of the ELF/mach-o noise.
 *
 * Pure + exported for unit tests against representative strings.
 */
export const isNativeBindingFailure = (message: string): boolean => {
  const m = message.toLowerCase();
  return (
    m.includes('dlopen') ||
    m.includes('err_dlopen_failed') ||
    m.includes('cannot open shared object') ||
    m.includes('library not loaded') ||
    m.includes('image not found') ||
    m.includes('invalid elf header') ||
    m.includes('not a valid win32 application') ||
    m.includes('was compiled against a different node') ||
    m.includes('no native build was found') ||
    m.includes('could not locate the bindings') ||
    (m.includes('cannot find module') && m.includes('duckdb')) ||
    (m.includes('cannot find package') && m.includes('duckdb'))
  );
};

/**
 * Actionable message for a native-binding failure. Names platform/arch/Node
 * and the reinstall remedy, then appends the underlying error.
 */
export const nativeBindingMessage = (cause: string): string => {
  const platform = `${process.platform}-${process.arch}`;
  return (
    `@duckdb/node-api native bindings failed to load on ${platform} ` +
    `(Node ${process.version}). Reinstall so the platform-matched binding is ` +
    'fetched (`pnpm rebuild @duckdb/node-api`, or reinstall sf-intelligence). ' +
    'The package pins an exact native release (no caret) — a yanked or ' +
    'unsupported platform/arch has no patch-range fallback. ' +
    `Underlying error: ${cause}`
  );
};

/** Classify an open/load error: lock conflict, native binding, or generic open-failed. */
const classifyOpenFailure = (
  path: string,
  msg: string,
  mode: 'rw' | 'ro',
): GraphError => {
  if (isLockConflict(msg)) {
    return { kind: 'locked', message: lockConflictMessage(path, msg) };
  }
  if (isNativeBindingFailure(msg)) {
    return { kind: 'open-failed', message: nativeBindingMessage(msg) };
  }
  const prefix =
    mode === 'ro'
      ? `cannot open graph read-only at ${path}`
      : `cannot open graph at ${path}`;
  return { kind: 'open-failed', message: `${prefix}: ${msg}` };
};

let duckdbApi: DuckDBApi | undefined;
let duckdbLoadError: GraphError | undefined;

/**
 * Lazy-load `@duckdb/node-api` so a native-binding failure is caught here
 * (with {@link nativeBindingMessage}) instead of as a raw module-eval `dlopen`
 * crash when this file is first imported.
 */
const loadDuckDB = async (): Promise<Result<DuckDBApi, GraphError>> => {
  if (duckdbApi !== undefined) return ok(duckdbApi);
  if (duckdbLoadError !== undefined) return err(duckdbLoadError);
  try {
    duckdbApi = await import('@duckdb/node-api');
    return ok(duckdbApi);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    duckdbLoadError = {
      kind: 'open-failed',
      message: isNativeBindingFailure(msg)
        ? nativeBindingMessage(msg)
        : `cannot load @duckdb/node-api: ${msg}`,
    };
    return err(duckdbLoadError);
  }
};

/**
 * Probe whether the DuckDB native bindings load on this platform (INFRA-11).
 * Used by `sfi doctor`; does not open a database file.
 */
export const probeDuckDBNative = async (): Promise<Result<void, GraphError>> => {
  const loaded = await loadDuckDB();
  if (!loaded.ok) return err(loaded.error);
  return ok(undefined);
};
/**
 * DuckDB instance config applied to EVERY graph open (read-write and read-only).
 *
 * `enable_external_access: 'false'` is a defense-in-depth, engine-level backstop
 * for the `sfi.query_graph` power tool (and any future SQL path). DuckDB defaults
 * this setting ON, which leaves `read_csv` / `read_parquet` / `ATTACH` / `COPY` /
 * `INSTALL` / `LOAD` / httpfs reachable — the ONLY thing currently preventing a
 * file/URL read is that the query_graph compiler never emits one. Nothing in this
 * codebase legitimately needs external file/URL access: the import pipeline writes
 * via prepared statements + appenders to the vault's OWN database file (which stays
 * fully writable under this flag — only foreign files/URLs are blocked), and the
 * cross-vault/fleet tools open SEPARATE instances rather than SQL `ATTACH`. Turning
 * it off converts "trust the compiler" into a hard engine guarantee that survives
 * any future SQL-composing edit.
 *
 * It is applied to BOTH opens deliberately: the read-only serve ladder
 * ({@link openGraphServeReadOnly}) can fall back to the read-WRITE `openGraph`
 * handle, so scoping the backstop to the read-only open alone would leave external
 * access ON in exactly those fallback branches.
 *
 * NOTE: DuckDB config values are strings (`Record<string, string>`), so this is
 * the STRING `'false'`, not a boolean.
 */
const EXTERNAL_ACCESS_DISABLED: Readonly<Record<string, string>> = Object.freeze({
  enable_external_access: 'false',
});

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
  const loaded = await loadDuckDB();
  if (!loaded.ok) return loaded;
  // DuckDB's public export is PascalCase; rename the binding for naming-convention.
  const { DuckDBInstance: duckDbInstance } = loaded.value;

  let instance: DuckDBInstance;
  try {
    instance = await duckDbInstance.create(path, { ...EXTERNAL_ACCESS_DISABLED });
  } catch (e) {
    return err(classifyOpenFailure(path, (e as Error).message, 'rw'));
  }

  let connection: DuckDBConnection;
  try {
    connection = await instance.connect();
  } catch (e) {
    instance.closeSync();
    const msg = (e as Error).message;
    if (isNativeBindingFailure(msg)) {
      return err({ kind: 'open-failed', message: nativeBindingMessage(msg) });
    }
    return err({
      kind: 'open-failed',
      message: `cannot connect to graph at ${path}: ${msg}`,
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
 * the handle, and multiple readers can open the same vault concurrently. Like
 * `openGraph`, it also disables DuckDB external file/URL access (see
 * {@link EXTERNAL_ACCESS_DISABLED}).
 *
 * @example
 *   const r = await openGraphReadOnly('org-kb/graph/graph.duckdb');
 *   if (r.ok) { /* ... read-only queries ... *\/ await closeGraph(r.value); }
 */
export const openGraphReadOnly = async (
  path: string,
): Promise<Result<GraphStore, GraphError>> => {
  const loaded = await loadDuckDB();
  if (!loaded.ok) return loaded;
  // DuckDB's public export is PascalCase; rename the binding for naming-convention.
  const { DuckDBInstance: duckDbInstance } = loaded.value;

  let instance: DuckDBInstance;
  try {
    instance = await duckDbInstance.create(path, {
      access_mode: 'READ_ONLY',
      ...EXTERNAL_ACCESS_DISABLED,
    });
  } catch (e) {
    return err(classifyOpenFailure(path, (e as Error).message, 'ro'));
  }

  try {
    const connection = await instance.connect();
    return ok({ connection, instance });
  } catch (e) {
    instance.closeSync();
    const msg = (e as Error).message;
    if (isNativeBindingFailure(msg)) {
      return err({ kind: 'open-failed', message: nativeBindingMessage(msg) });
    }
    return err({
      kind: 'open-failed',
      message: `cannot connect read-only to graph at ${path}: ${msg}`,
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
