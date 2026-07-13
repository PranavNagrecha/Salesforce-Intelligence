import type { DuckDBConnection, DuckDBValue } from '@duckdb/node-api';
import type { Edge, Node, Result } from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';

import type { GraphError, GraphStore } from './store.js';

/**
 * A CONSTRAINED, parameterized query surface over the vault's DuckDB graph —
 * the safety-critical core behind the `sfi.query_graph` MCP tool.
 *
 * DESIGN (safety over power): the caller NEVER supplies SQL. They supply a
 * STRUCTURED query — a target table (`nodes` | `edges`), a list of
 * `{ column, op, value }` conditions, and a `limit` — which this module
 * compiles into a single, allowlisted, read-only `SELECT`. The compilation is
 * total and fail-closed:
 *
 *   - The table is an ENUM, so the `FROM` clause is a hardcoded literal.
 *   - Every filterable `column` is looked up in a fixed allowlist that maps the
 *     caller-facing name to a hardcoded SQL column expression — user text never
 *     reaches the SQL as a column. Property access (`property:<key>`) goes
 *     through the SAME `json_extract_string(properties_json, ?)` idiom the rest
 *     of the query layer uses (`appendNodePropertyFilters`), with the JSON path
 *     itself BOUND as a parameter, and the `<key>` validated to a bare
 *     identifier so it can never carry SQL or a JSON-path escape.
 *   - Every `op` is looked up in a fixed allowlist that yields a hardcoded SQL
 *     fragment (`= ?`, `!= ?`, `LIKE ?`, `ILIKE ?`, `IN (?, ?, …)`, `IS NULL`,
 *     `IS NOT NULL`). User text never becomes an operator.
 *   - Every `value` is a BOUND parameter (`?`), never interpolated. An `IN`
 *     list becomes N placeholders bound to N values.
 *   - The statement is ALWAYS a `SELECT` with a fixed, deterministic
 *     `ORDER BY` and a hard-capped, bound `LIMIT`. There is no code path that
 *     emits DDL/DML/PRAGMA/ATTACH/COPY, no semicolon, and no second statement.
 *
 * Because the ONLY user-controlled text that reaches the database is bound
 * parameter VALUES (and a regex-validated JSON-path key, itself bound), an
 * injection attempt (`'; DROP TABLE nodes; --`, `1 OR 1=1`, `UNION SELECT …`)
 * is either rejected at the allowlist boundary (if it targets a column/op) or
 * bound as an inert literal value that matches no row — it is never executed as
 * SQL. That compiler-level guarantee — SELECT-only, allowlisted, fully bound —
 * is the PRIMARY safety property and it holds unconditionally.
 *
 * Two engine-level backstops sit behind it, but note their DIFFERENT strengths:
 *
 *   - External-access is disabled on EVERY graph handle (`enable_external_access:
 *     'false'`; see `store.ts`), so `read_csv`/`read_parquet`/`ATTACH`/`COPY`/
 *     `INSTALL`/`LOAD`/httpfs are refused by the engine regardless of which handle
 *     serves — this backstop is an invariant.
 *   - The served handle is opened `access_mode: READ_ONLY` in the NORMAL path, but
 *     it is NOT an invariant: the read-only serve ladder
 *     (`openGraphServeReadOnly`) falls back to a read-WRITE handle under
 *     schema-migration, content-probe-failure, or read-only-open-failure
 *     conditions. So "the query runs on a strictly read-only connection" is the
 *     common case, not a guarantee — do NOT rely on the READ_ONLY mode alone to
 *     stop a write. It never matters in practice because the compiler emits no
 *     write in the first place.
 */

// ---------------------------------------------------------------------------
// Hard caps
// ---------------------------------------------------------------------------

/** Default row limit when the caller omits one. */
export const QUERY_GRAPH_DEFAULT_LIMIT = 50;
/** Hard ceiling on rows a single query may return (before byte-trimming). */
export const QUERY_GRAPH_MAX_LIMIT = 500;
/** Hard ceiling on the number of WHERE conditions (bounds query complexity). */
export const QUERY_GRAPH_MAX_CONDITIONS = 20;
/** Hard ceiling on the length of an `IN` value list. */
export const QUERY_GRAPH_MAX_IN_VALUES = 50;
/**
 * Default statement-timeout guard (ms). A `LIKE '%…%'` over `properties_json` on
 * a large vault is a full scan; on timeout the executor CANCELS the running
 * statement via DuckDB's `connection.interrupt()` (not just a JS race that
 * abandons a still-running query) and returns `query-timeout`. Because the query
 * runs on a DEDICATED connection off the vault instance — not the shared server
 * connection — a heavy scan contends only with itself and the interrupt targets
 * only that connection, so other tools' in-flight queries are untouched.
 */
export const QUERY_GRAPH_DEFAULT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Column + operator allowlists
// ---------------------------------------------------------------------------

/**
 * Caller-facing scalar column name -> hardcoded SQL column expression, per
 * target table. This map is the ONLY way a column name reaches the SQL: the
 * value on the right is a fixed string literal, never derived from user input.
 * `property:<key>` is handled separately (a bound JSON-path extract).
 */
const NODE_COLUMN_SQL: Readonly<Record<string, string>> = Object.freeze({
  id: 'id',
  type: 'type',
  apiName: 'api_name',
  label: 'label',
  parentId: 'parent_id',
  sourcePath: 'source_path',
  lastModifiedDate: 'last_modified_date',
  lastModifiedBy: 'last_modified_by',
  apiVersion: 'api_version',
});

const EDGE_COLUMN_SQL: Readonly<Record<string, string>> = Object.freeze({
  fromId: 'from_id',
  toId: 'to_id',
  edgeType: 'edge_type',
  confidence: 'confidence',
  source: 'source',
});

/** The `SELECT` column list per table (fixed; mirrors queries.ts). */
const NODE_SELECT_COLUMNS =
  'id, type, api_name, label, parent_id, source_path, last_modified_date, last_modified_by, api_version, properties_json';
const EDGE_SELECT_COLUMNS =
  'from_id, to_id, edge_type, confidence, source, properties_json';

/** Deterministic sort per table so a byte-trimmed page is a stable prefix. */
const NODE_ORDER_BY = 'ORDER BY id ASC';
const EDGE_ORDER_BY = 'ORDER BY from_id ASC, to_id ASC, edge_type ASC, source ASC';

/** The `property:` column prefix + the bare-identifier key it accepts. */
const PROPERTY_PREFIX = 'property:';
const PROPERTY_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The operators the compiler accepts. */
export type GraphQueryOp =
  | '='
  | '!='
  | 'LIKE'
  | 'ILIKE'
  | 'IN'
  | 'IS NULL'
  | 'IS NOT NULL';

/** Operators that take exactly one bound scalar value. */
const SCALAR_OPS: ReadonlySet<GraphQueryOp> = new Set([
  '=',
  '!=',
  'LIKE',
  'ILIKE',
]);
/** Operators that take a bound list of values. */
const LIST_OPS: ReadonlySet<GraphQueryOp> = new Set(['IN']);
/** Operators that take NO value. */
const NULLARY_OPS: ReadonlySet<GraphQueryOp> = new Set(['IS NULL', 'IS NOT NULL']);
/**
 * All allowed operators, as a frozen tuple of string literals — the single
 * source the MCP Zod enum + advertised JSON Schema consume (so they cannot
 * drift from the compiler) AND the fail-closed error messages.
 */
export const QUERY_GRAPH_ALLOWED_OPS = [
  '=',
  '!=',
  'LIKE',
  'ILIKE',
  'IN',
  'IS NULL',
  'IS NOT NULL',
] as const satisfies readonly GraphQueryOp[];

/** The target table for a structured query. */
export type GraphQuerySelect = 'nodes' | 'edges';

/** A scalar a value/`IN`-element may take. */
export type GraphQueryScalar = string | number | boolean;

/** One structured filter condition. */
export interface GraphQueryCondition {
  /**
   * A caller-facing column name (`id`, `apiName`, `edgeType`, …) or a
   * `property:<key>` accessor over the node/edge `properties_json`.
   */
  readonly column: string;
  readonly op: GraphQueryOp;
  /**
   * A bound scalar (for `=`/`!=`/`LIKE`/`ILIKE`), a bound array (for `IN`), or
   * omitted (for `IS NULL`/`IS NOT NULL`). NEVER interpolated into SQL.
   */
  readonly value?: GraphQueryScalar | readonly GraphQueryScalar[];
}

/** The structured query input. */
export interface GraphQuery {
  readonly select: GraphQuerySelect;
  readonly where?: readonly GraphQueryCondition[];
  readonly limit?: number;
}

/** A compiled, parameterized query ready to execute. */
export interface CompiledGraphQuery {
  /** The row `SELECT` with `?` placeholders (ends with `LIMIT ?`). */
  readonly sql: string;
  /** A `SELECT count(*)` with the SAME `WHERE` (no `LIMIT`). */
  readonly countSql: string;
  /** Bound parameters for `sql`, in order; the FINAL element is the limit. */
  readonly params: readonly DuckDBValue[];
  /** Bound parameters for `countSql` (all of `params` except the trailing limit). */
  readonly countParams: readonly DuckDBValue[];
  /** The effective, capped limit. */
  readonly limit: number;
  /**
   * The bound values a caller can be SHOWN alongside the SQL (the JSON-path
   * params for property filters are internal plumbing and excluded).
   */
  readonly displayParams: readonly GraphQueryScalar[];
}

/** A fail-closed compile error naming what IS allowed. */
export interface GraphQueryCompileError {
  readonly message: string;
}

/** Rows + provenance returned by {@link runGraphQuery}. */
export interface GraphQueryResult {
  readonly select: GraphQuerySelect;
  /** The matching rows, as STORED (no synthesis/grounding applied). */
  readonly rows: readonly (Node | Edge)[];
  /** Rows returned in this response (after limit + any byte-trim). */
  readonly returnedCount: number;
  /** Total rows matching the filters BEFORE the limit. */
  readonly totalCount: number;
  /** True when more rows matched than were returned. */
  readonly hasMore: boolean;
  /** The effective, capped limit that was applied. */
  readonly limit: number;
  /** The exact compiled `SELECT` that ran (with `?` placeholders). */
  readonly compiledSql: string;
  /** The bound values shown to the caller (excludes internal JSON paths). */
  readonly params: readonly GraphQueryScalar[];
}

/** The error variants {@link runGraphQuery} can return. */
export interface GraphQueryError {
  readonly kind: 'invalid-query' | 'query-failed' | 'query-timeout';
  readonly message: string;
}

const allowedColumnsFor = (select: GraphQuerySelect): readonly string[] => [
  ...Object.keys(select === 'nodes' ? NODE_COLUMN_SQL : EDGE_COLUMN_SQL),
  'property:<key>',
];

/**
 * Resolve a caller-facing column to a hardcoded SQL column expression, pushing
 * any JSON-path parameter needed for a `property:` accessor. Returns the SQL
 * fragment (`api_name`, or `json_extract_string(properties_json, ?)`), or a
 * compile error naming the allowlist. The `<key>` of a `property:` accessor is
 * validated to a bare identifier AND bound as a parameter — never concatenated.
 */
const resolveColumn = (
  select: GraphQuerySelect,
  column: string,
  params: DuckDBValue[],
): Result<string, GraphQueryCompileError> => {
  if (column.startsWith(PROPERTY_PREFIX)) {
    const key = column.slice(PROPERTY_PREFIX.length);
    if (!PROPERTY_KEY_RE.test(key)) {
      return err({
        message:
          `property key '${key}' is not a bare identifier — only ` +
          `[A-Za-z_][A-Za-z0-9_]* is allowed (e.g. property:dataType, property:triggerType).`,
      });
    }
    // Same idiom as appendNodePropertyFilters: the JSON path is a BOUND
    // parameter, so the key can never carry SQL or a path escape.
    params.push(`$.${key}`);
    return ok('json_extract_string(properties_json, ?)');
  }
  const map = select === 'nodes' ? NODE_COLUMN_SQL : EDGE_COLUMN_SQL;
  const sqlColumn = map[column];
  if (sqlColumn === undefined) {
    return err({
      message:
        `unknown column '${column}' for select '${select}'. Allowed columns: ` +
        `${allowedColumnsFor(select).join(', ')}.`,
    });
  }
  return ok(sqlColumn);
};

/**
 * Compile ONE condition into a parameterized SQL fragment, pushing its bound
 * params (JSON path first for a property column, then the value(s)). Every
 * branch emits a hardcoded operator fragment and binds every value.
 */
const compileCondition = (
  select: GraphQuerySelect,
  cond: GraphQueryCondition,
  params: DuckDBValue[],
  displayParams: GraphQueryScalar[],
): Result<string, GraphQueryCompileError> => {
  if (!QUERY_GRAPH_ALLOWED_OPS.includes(cond.op)) {
    return err({
      message:
        `unknown operator '${String(cond.op)}'. Allowed operators: ` +
        `${QUERY_GRAPH_ALLOWED_OPS.join(', ')}.`,
    });
  }
  const col = resolveColumn(select, cond.column, params);
  if (!col.ok) return col;

  if (NULLARY_OPS.has(cond.op)) {
    if (cond.value !== undefined) {
      return err({
        message: `operator '${cond.op}' takes no value (got one for column '${cond.column}').`,
      });
    }
    return ok(`${col.value} ${cond.op}`);
  }

  if (SCALAR_OPS.has(cond.op)) {
    if (cond.value === undefined || Array.isArray(cond.value)) {
      return err({
        message: `operator '${cond.op}' on column '${cond.column}' requires a single scalar value.`,
      });
    }
    const scalar = cond.value as GraphQueryScalar;
    params.push(scalar);
    displayParams.push(scalar);
    return ok(`${col.value} ${cond.op} ?`);
  }

  if (LIST_OPS.has(cond.op)) {
    if (!Array.isArray(cond.value)) {
      return err({
        message: `operator 'IN' on column '${cond.column}' requires an array value.`,
      });
    }
    const values = cond.value as readonly GraphQueryScalar[];
    if (values.length === 0) {
      return err({
        message: `operator 'IN' on column '${cond.column}' requires a non-empty array.`,
      });
    }
    if (values.length > QUERY_GRAPH_MAX_IN_VALUES) {
      return err({
        message: `operator 'IN' on column '${cond.column}' accepts at most ${QUERY_GRAPH_MAX_IN_VALUES} values (got ${values.length}).`,
      });
    }
    for (const v of values) {
      params.push(v);
      displayParams.push(v);
    }
    const placeholders = values.map(() => '?').join(', ');
    return ok(`${col.value} IN (${placeholders})`);
  }

  // Unreachable: the op passed the allowlist above and every allowed op is in
  // exactly one of the three sets. Fail closed rather than emit partial SQL.
  return err({ message: `operator '${cond.op}' is not supported.` });
};

/**
 * Compile a structured {@link GraphQuery} into a parameterized, allowlisted,
 * SELECT-only {@link CompiledGraphQuery}. Pure and total — no DB access — so it
 * is directly unit-testable (including the adversarial cases). Fail-closed:
 * any unknown column/op, malformed value, or over-cap input returns a
 * {@link GraphQueryCompileError} naming what IS allowed, and NO SQL is emitted.
 */
export const compileGraphQuery = (
  query: GraphQuery,
): Result<CompiledGraphQuery, GraphQueryCompileError> => {
  if (query.select !== 'nodes' && query.select !== 'edges') {
    return err({
      message: `select must be 'nodes' or 'edges' (got '${String(query.select)}').`,
    });
  }
  const conditions = query.where ?? [];
  if (conditions.length > QUERY_GRAPH_MAX_CONDITIONS) {
    return err({
      message: `at most ${QUERY_GRAPH_MAX_CONDITIONS} where conditions are allowed (got ${conditions.length}).`,
    });
  }

  const rawLimit = query.limit ?? QUERY_GRAPH_DEFAULT_LIMIT;
  if (!Number.isInteger(rawLimit) || rawLimit < 1) {
    return err({ message: `limit must be a positive integer (got ${String(rawLimit)}).` });
  }
  if (rawLimit > QUERY_GRAPH_MAX_LIMIT) {
    return err({
      message: `limit exceeds the hard cap of ${QUERY_GRAPH_MAX_LIMIT} (got ${rawLimit}).`,
    });
  }
  const limit = rawLimit;

  const whereParams: DuckDBValue[] = [];
  const displayParams: GraphQueryScalar[] = [];
  const fragments: string[] = [];
  for (const cond of conditions) {
    const compiled = compileCondition(query.select, cond, whereParams, displayParams);
    if (!compiled.ok) return compiled;
    fragments.push(compiled.value);
  }

  const table = query.select === 'nodes' ? 'nodes' : 'edges';
  const selectColumns =
    query.select === 'nodes' ? NODE_SELECT_COLUMNS : EDGE_SELECT_COLUMNS;
  const orderBy = query.select === 'nodes' ? NODE_ORDER_BY : EDGE_ORDER_BY;
  const whereClause = fragments.length > 0 ? ` WHERE ${fragments.join(' AND ')}` : '';

  const sql = `SELECT ${selectColumns} FROM ${table}${whereClause} ${orderBy} LIMIT ?`;
  const countSql = `SELECT count(*)::INT AS n FROM ${table}${whereClause}`;
  const params: DuckDBValue[] = [...whereParams, limit];

  return ok({
    sql,
    countSql,
    params,
    countParams: whereParams,
    limit,
    displayParams,
  });
};

const parseProperties = (raw: unknown): Readonly<Record<string, unknown>> => {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    return {};
  }
};

type RawRow = Readonly<Record<string, unknown>>;

const rowToNode = (r: RawRow): Node => ({
  id: r['id'] as Node['id'],
  type: r['type'] as Node['type'],
  apiName: r['api_name'] as string,
  label: (r['label'] ?? null) as string | null,
  parentId: (r['parent_id'] ?? null) as Node['parentId'],
  sourcePath: r['source_path'] as string,
  lastModifiedDate: (r['last_modified_date'] ?? null) as string | null,
  lastModifiedBy: (r['last_modified_by'] ?? null) as string | null,
  apiVersion: (r['api_version'] ?? null) as number | null,
  properties: parseProperties(r['properties_json']),
});

const rowToEdge = (r: RawRow): Edge => ({
  fromId: r['from_id'] as Edge['fromId'],
  toId: r['to_id'] as Edge['toId'],
  edgeType: r['edge_type'] as Edge['edgeType'],
  confidence: r['confidence'] as Edge['confidence'],
  source: r['source'] as string,
  properties: parseProperties(r['properties_json']),
});

/** Sentinel the row/count race resolves to when the deadline wins. */
const TIMEOUT_SENTINEL = Symbol('query-graph-timeout');

/**
 * Race a running query against a deadline. On timeout, CANCEL it via DuckDB's
 * `connection.interrupt()` so the abandoned statement stops consuming the
 * connection instead of running to completion in the background. The caller is
 * responsible for awaiting the (now-rejecting) query promise before tearing the
 * connection down — a no-op `catch` is attached here so the post-interrupt
 * rejection is never an unhandled rejection while the race unwinds.
 */
const raceWithInterrupt = async <T>(
  conn: DuckDBConnection,
  p: Promise<T>,
  ms: number,
): Promise<T | typeof TIMEOUT_SENTINEL> => {
  p.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
    timer = setTimeout(() => {
      conn.interrupt();
      resolve(TIMEOUT_SENTINEL);
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** Options for {@link runGraphQuery}. */
export interface RunGraphQueryOptions {
  /** Statement-timeout guard in ms (default {@link QUERY_GRAPH_DEFAULT_TIMEOUT_MS}). */
  readonly timeoutMs?: number;
}

/**
 * Compile and execute a structured {@link GraphQuery} against the READ-ONLY
 * graph store, returning the matching rows AS STORED plus the exact compiled
 * SQL and bound values (so the caller can see what ran). Runs a `count(*)` with
 * the same WHERE for an honest `totalCount`/`hasMore`, and races the row query
 * against a statement-timeout guard.
 *
 * The `store` is the server's shared graph handle (`ctx.graph`). This function
 * never opens, composes a write, or mutates anything: it only compiles and runs
 * the allowlisted SELECT. That handle is normally opened `access_mode:
 * READ_ONLY`, but the read-only serve ladder (`openGraphServeReadOnly`) can hand
 * back a read-WRITE handle in its migrate/probe-fail/lock fallbacks, so read-only
 * mode is the usual case rather than a guarantee — safety here rests on the
 * SELECT-only compiler, not on the connection's access mode.
 *
 * @example
 *   const r = await runGraphQuery(store, {
 *     select: 'nodes',
 *     where: [{ column: 'type', op: '=', value: 'CustomObject' }],
 *     limit: 10,
 *   });
 *   if (r.ok) console.log(r.value.totalCount, r.value.rows.length);
 */
export const runGraphQuery = async (
  store: GraphStore,
  query: GraphQuery,
  options?: RunGraphQueryOptions,
): Promise<Result<GraphQueryResult, GraphQueryError>> => {
  const compiled = compileGraphQuery(query);
  if (!compiled.ok) {
    return err({ kind: 'invalid-query', message: compiled.error.message });
  }
  const timeoutMs = options?.timeoutMs ?? QUERY_GRAPH_DEFAULT_TIMEOUT_MS;

  // Run on a DEDICATED connection off the vault instance, NOT the shared server
  // connection (`store.connection`). A heavy `LIKE '%…%'` full-scan then contends
  // only with itself, and the timeout's `interrupt()` cancels only THIS
  // connection — other tools' in-flight queries are untouched. The dedicated
  // connection inherits the instance config (access_mode + external-access), so
  // it is exactly as locked down as the shared handle.
  let conn: DuckDBConnection;
  try {
    conn = await store.instance.connect();
  } catch (e) {
    return err({
      kind: 'query-failed',
      message: `query_graph could not open a query connection: ${(e as Error).message}`,
    });
  }

  // The most-recent in-flight query promise. On timeout we interrupt() and must
  // let it settle (it rejects with an INTERRUPT error) BEFORE disconnecting, so
  // the synchronous teardown never races a native query still unwinding.
  let inFlight: Promise<unknown> = Promise.resolve();
  try {
    // Exact total (same WHERE, no LIMIT) for an honest hasMore.
    const countP = conn.runAndReadAll(compiled.value.countSql, [
      ...compiled.value.countParams,
    ]);
    inFlight = countP;
    const countReader = await raceWithInterrupt(conn, countP, timeoutMs);
    if (countReader === TIMEOUT_SENTINEL) {
      return err({
        kind: 'query-timeout',
        message: `query_graph count timed out after ${timeoutMs} ms; narrow the query (add a where filter) and retry.`,
      });
    }
    const countRows = countReader.getRowObjectsJS() as readonly RawRow[];
    const totalCount = Number((countRows[0] as RawRow)['n'] ?? 0);

    const rowP = conn.runAndReadAll(compiled.value.sql, [...compiled.value.params]);
    inFlight = rowP;
    const rowReader = await raceWithInterrupt(conn, rowP, timeoutMs);
    if (rowReader === TIMEOUT_SENTINEL) {
      return err({
        kind: 'query-timeout',
        message: `query_graph timed out after ${timeoutMs} ms; narrow the query (add a where filter, reduce limit) and retry.`,
      });
    }
    const rawRows = rowReader.getRowObjectsJS() as readonly RawRow[];
    const rows: readonly (Node | Edge)[] =
      query.select === 'nodes' ? rawRows.map(rowToNode) : rawRows.map(rowToEdge);

    return ok({
      select: query.select,
      rows,
      returnedCount: rows.length,
      totalCount,
      hasMore: totalCount > rows.length,
      limit: compiled.value.limit,
      compiledSql: compiled.value.sql,
      params: compiled.value.displayParams,
    });
  } catch (e) {
    return err({
      kind: 'query-failed',
      message: `query_graph execution failed: ${(e as Error).message}`,
    });
  } finally {
    // Let any interrupted/in-flight query fully settle (swallowing its INTERRUPT
    // rejection) before tearing down, so disconnectSync never collides with a
    // native query still cancelling.
    await inFlight.catch(() => undefined);
    conn.disconnectSync();
  }
};

// Re-export so a caller that already holds a GraphStore can surface the
// GraphError type without a second import (parity with queries.ts).
export type { GraphError };
