/**
 * Handler for the `sfi.query_graph` MCP tool — an ADVANCED, read-only,
 * guard-railed parameterized query surface over the vault's DuckDB dependency
 * graph, for power users who want to ask questions the purpose-built tools do
 * not cover.
 *
 * SAFETY (the whole point of this tool): it does NOT accept SQL. The caller
 * supplies a STRUCTURED query — a target table (`nodes` | `edges`), a list of
 * `{ column, op, value }` conditions, and a `limit` — which the graph layer
 * (`compileGraphQuery`) compiles into a single allowlisted, parameterized,
 * SELECT-only statement. Columns are drawn from a fixed per-table allowlist
 * (plus `property:<key>` JSON access through a BOUND json path); operators from
 * a fixed allowlist (`=`, `!=`, `LIKE`, `ILIKE`, `IN`, `IS NULL`,
 * `IS NOT NULL`); every value is a BOUND parameter, never interpolated. The
 * statement is always a `SELECT` with a fixed `ORDER BY` and a hard-capped,
 * bound `LIMIT` — no DDL/DML/PRAGMA/ATTACH/COPY, no semicolon, no second
 * statement. That SELECT-only compiler is the primary guarantee. Execution
 * routes through the server's shared graph handle (`ctx.graph`), which is opened
 * `access_mode: READ_ONLY` in the normal path but can fall back to a read-write
 * handle in the read-only serve ladder's migrate/probe/lock branches — so the
 * read-only mode is a secondary backstop, not an invariant; the compiler is what
 * guarantees no write. External file/URL access (`read_csv`/`ATTACH`/`COPY`/…)
 * is disabled at the DuckDB engine level on every handle. An unknown column/op is
 * rejected fail-closed with the allowlist named; an injection payload aimed at a
 * VALUE is bound as an inert literal that matches no row.
 *
 * HONESTY: the response echoes the exact compiled SQL + bound values (so the
 * caller sees what ran) and carries a `disclosure` that this is a RAW graph
 * view — ids/edges exactly as stored, per-edge `confidence`, and NO synthesis,
 * grounding, or coverage reconciliation. Output is byte-budgeted like the other
 * graph enumerators so a wide result cannot trip the MCP response limit.
 */

import type {
  Edge,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  runGraphQuery,
  QUERY_GRAPH_ALLOWED_OPS,
  QUERY_GRAPH_MAX_CONDITIONS,
  QUERY_GRAPH_MAX_IN_VALUES,
  QUERY_GRAPH_MAX_LIMIT,
  type GraphQuery,
  type GraphQueryCondition,
  type GraphQueryScalar,
} from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { slimGraphNodes } from './graph-payload-bounds.js';

/**
 * Per-response byte budget for the `rows` slice, leaving headroom under the
 * global ~45 KB MCP response guard for the envelope + compiled query + counts.
 * A wide page (fat `properties_json`) is trimmed to fit; mirrors `get_edges`.
 */
const QUERY_GRAPH_BYTE_BUDGET = 38_000;

/** A scalar a `value`/`IN`-element may take (mirrors the graph-layer type). */
const scalarSchema = z.union([z.string(), z.number(), z.boolean()]);

/**
 * Zod schema for the `sfi.query_graph` tool input.
 *
 *   - `select`: required; `'nodes'` or `'edges'` (the target table).
 *   - `where`: optional array of `{ column, op, value }` conditions, AND-ed.
 *     `op` is one of the seven allowlisted operators; `value` is a scalar
 *     (for `=`/`!=`/`LIKE`/`ILIKE`), an array (for `IN`), or omitted (for the
 *     null checks). `column` is validated against the per-table allowlist by
 *     the graph-layer compiler (a bad column earns `invalid-query`).
 *   - `limit`: optional integer, hard-capped at `QUERY_GRAPH_MAX_LIMIT`.
 */
export const queryGraphInputSchema = z.object({
  select: z.enum(['nodes', 'edges']),
  where: z
    .array(
      z.object({
        column: z.string().min(1),
        op: z.enum(QUERY_GRAPH_ALLOWED_OPS),
        value: z.union([scalarSchema, z.array(scalarSchema)]).optional(),
      }),
    )
    .max(QUERY_GRAPH_MAX_CONDITIONS)
    .optional(),
  limit: z.number().int().positive().max(QUERY_GRAPH_MAX_LIMIT).optional(),
});

/** Parsed input shape, inferred from `queryGraphInputSchema`. */
export type QueryGraphInput = z.infer<typeof queryGraphInputSchema>;

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface QueryGraphOutput {
  /** The target table that was queried. */
  readonly select: 'nodes' | 'edges';
  /** The matching rows, as STORED (no synthesis/grounding applied). */
  readonly rows: readonly (Node | Edge)[];
  /** Rows returned in this response (after limit + any byte-trim). */
  readonly returnedCount: number;
  /** Total rows matching the filters BEFORE the limit. */
  readonly totalCount: number;
  /** True when more rows matched than were returned (raise `limit` or narrow). */
  readonly hasMore: boolean;
  /** The effective, capped limit that was applied. */
  readonly limit: number;
  /** The exact compiled SELECT + bound values that ran (so the caller sees it). */
  readonly query: {
    readonly compiledSql: string;
    readonly params: readonly GraphQueryScalar[];
  };
  /** True when the page was byte-trimmed below the row count to fit the budget. */
  readonly truncated: boolean;
  /** Present only when byte-trimmed or property-slimmed. */
  readonly note?: string;
  /** Verbatim honesty note: this is a RAW graph view, not a grounded answer. */
  readonly disclosure: string;
}

const DISCLOSURE =
  'Raw graph view: rows are returned exactly as stored in the vault dependency graph — ' +
  'canonical component ids, edge endpoints, and each edge\'s per-edge `confidence` ' +
  '(declared/parsed/heuristic) — with NO synthesis, grounding, or coverage reconciliation ' +
  'applied. `confidence` describes how a single edge was derived, not org-wide truth; an ' +
  'absent row means "not present in the graph as queried", which on a partially-refreshed ' +
  'vault is NOT the same as "does not exist in the org". This is an advanced/raw surface — ' +
  'for grounded answers prefer the purpose-built tools (get_edges, get_impact, list_components, ' +
  'who_can_access_object, what_happens_on_save, …) and sfi.synthesize_answer.';

/**
 * Byte-trim a row list to fit `budget`, keeping the deterministic prefix (the
 * rows are already in a stable ORDER BY). Accumulates per-row serialized bytes
 * so it is O(n); always keeps at least one row so the caller gets something.
 */
const byteTrimRows = <T>(
  rows: readonly T[],
  budget: number,
): { readonly rows: readonly T[]; readonly trimmed: boolean } => {
  let total = 2; // the enclosing `[]`
  const kept: T[] = [];
  for (const row of rows) {
    const rowBytes = Buffer.byteLength(JSON.stringify(row) ?? 'null', 'utf8') + 1;
    if (kept.length > 0 && total + rowBytes > budget) {
      return { rows: kept, trimmed: true };
    }
    kept.push(row);
    total += rowBytes;
  }
  return { rows: kept, trimmed: kept.length !== rows.length };
};

/**
 * The `sfi.query_graph` MCP tool. Compiles a structured query to an allowlisted,
 * parameterized, read-only SELECT and returns the matching rows as stored, with
 * the compiled SQL echoed and a raw-graph-view disclosure. Byte-budgeted so a
 * wide result cannot overflow the MCP response.
 *
 * @example
 *   const r = await queryGraphHandler(ctx, {
 *     select: 'edges',
 *     where: [{ column: 'edgeType', op: '=', value: 'grantedBy' }],
 *     limit: 20,
 *   });
 *   if (r.ok) console.log(r.value.data.totalCount, r.value.data.rows.length);
 */
export const queryGraphHandler = async (
  ctx: Context,
  input: QueryGraphInput,
): Promise<Result<McpResponse<QueryGraphOutput>, McpError>> => {
  // Reshape the parsed input into the graph-layer GraphQuery. The `where`
  // conditions are passed through verbatim — the graph-layer compiler owns the
  // column/op allowlist and the fail-closed validation.
  const query: GraphQuery = {
    select: input.select,
    ...(input.where !== undefined
      ? { where: input.where as readonly GraphQueryCondition[] }
      : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  };

  const result = await runGraphQuery(ctx.graph, query);
  if (!result.ok) {
    // Fail-closed compile errors (unknown column/op, bad value/limit) are the
    // caller's to fix -> `invalid-query`, message names what IS allowed. A
    // timeout or execution fault is surfaced honestly (message preserved).
    if (result.error.kind === 'invalid-query') {
      return err({ kind: 'invalid-query', message: result.error.message });
    }
    return err({ kind: 'internal', message: result.error.message });
  }

  // Byte-bound the slice so it can't trip the ~45 KB MCP response guard. For
  // nodes, first slim any oversized single property value (Profile/PermissionSet
  // grant matrices) to an `{__omitted}` marker — the full node is one
  // `sfi.get_component` away — then trim rows from the tail to fit the budget.
  let rows: readonly (Node | Edge)[] = result.value.rows;
  let slimmedCount = 0;
  if (result.value.select === 'nodes') {
    const slimmed = slimGraphNodes(result.value.rows as readonly Node[]);
    rows = slimmed.nodes;
    slimmedCount = slimmed.slimmedCount;
  }
  const trimmed = byteTrimRows(rows, QUERY_GRAPH_BYTE_BUDGET);
  const returnedCount = trimmed.rows.length;
  // A byte-trim reduced the visible rows below what the LIMIT selected, so more
  // remain even if the unpaged total already fit the limit.
  const hasMore = result.value.hasMore || trimmed.trimmed;

  const slimNote =
    slimmedCount > 0
      ? ` ${slimmedCount} node(s) had an oversized property value summarised to an \`{__omitted}\` marker — fetch the full node with \`sfi.get_component\`.`
      : '';
  const trimNote = trimmed.trimmed
    ? `Page byte-trimmed to ${returnedCount} of the ${result.value.returnedCount} row(s) the limit selected, to stay under the ~45 KB MCP response limit. Narrow with a where filter or a smaller limit to see the rest.`
    : '';
  const note = `${trimNote}${slimNote}`.trim();

  return ok({
    data: {
      select: result.value.select,
      rows: trimmed.rows,
      returnedCount,
      totalCount: result.value.totalCount,
      hasMore,
      limit: result.value.limit,
      query: {
        compiledSql: result.value.compiledSql,
        params: result.value.params,
      },
      truncated: trimmed.trimmed,
      ...(note.length > 0 ? { note } : {}),
      disclosure: DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

// Referenced in the tool description + JSON schema; exported so a drift test can
// pin the advertised caps to the graph-layer constants.
export {
  QUERY_GRAPH_MAX_CONDITIONS,
  QUERY_GRAPH_MAX_IN_VALUES,
  QUERY_GRAPH_MAX_LIMIT,
};
