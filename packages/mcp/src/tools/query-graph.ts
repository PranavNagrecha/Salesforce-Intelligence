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
  QUERY_GRAPH_DEFAULT_LIMIT,
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
import { paginateLegacy } from './page-cursor.js';

/**
 * Per-response byte budget for the `rows` slice, leaving headroom under the
 * global ~45 KB MCP response guard for the envelope + compiled query + counts.
 * A wide page (fat `properties_json`) is trimmed to fit; mirrors `get_edges`.
 */
const QUERY_GRAPH_BYTE_BUDGET = 38_000;

/** Tool name the shared pager binds a page to. */
const QUERY_GRAPH_TOOL = 'sfi.query_graph';

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
 *   - `limit`: optional integer PAGE SIZE, hard-capped at `QUERY_GRAPH_MAX_LIMIT`.
 *   - `offset`: optional zero-based row offset to resume from — echo back the
 *     `nextOffset` the previous response published. Bounded BELOW
 *     `QUERY_GRAPH_MAX_LIMIT` because the compiled SELECT carries a hard `LIMIT`
 *     and no `OFFSET`: the pageable universe is the first `QUERY_GRAPH_MAX_LIMIT`
 *     rows of the fixed sort, so an offset at or past that cap can never address
 *     a row and is rejected fail-closed rather than answered with an empty page
 *     that reads like "nothing matched".
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
  offset: z.number().int().min(0).max(QUERY_GRAPH_MAX_LIMIT - 1).optional(),
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
  /**
   * True when more matching rows exist than this response shipped, measured
   * against the unpaged `count(*)` — NOT against the window the handler
   * materialised. A remainder hidden by the {@link QUERY_GRAPH_MAX_LIMIT} cap
   * still sets this, so the payload can never publish a complete answer over
   * rows it did not deliver.
   */
  readonly hasMore: boolean;
  /** The effective, capped PAGE SIZE that was applied (not the compiled SQL's LIMIT). */
  readonly limit: number;
  /**
   * QUERY-GRAPH-NO-RESUME-POINTER.
   *
   * On DEFAULT arguments — no `limit`, no filters — this tool reported
   * `totalCount: 118, returnedCount: 50, hasMore: true, truncated: false` and
   * shipped no `offset`, no `nextOffset` and no `nextCursor`. It told the
   * caller 68 more rows existed, called the 50 it sent "not truncated", and
   * offered no way to reach the rest: the only knob was `limit`, so the ONLY
   * way to see row 51 was to re-run the whole query with a bigger `limit` and
   * re-receive rows 1-50. Past `QUERY_GRAPH_MAX_LIMIT` there was no way at all.
   * A host agent walking the graph therefore either re-fetched everything on
   * every step or silently analysed the alphabetical head of the result set as
   * though it were the whole of it.
   *
   * `offset` + `nextOffset` close that. `nextOffset` is always
   * `offset + rows.length` — the rows ACTUALLY shipped, byte-trim included —
   * so resuming from it neither skips nor repeats a row. It is `null` when this
   * page ends the reachable set, which INCLUDES the cap case: see
   * {@link QueryGraphOutput.capReached}, where `hasMore` stays true and this
   * pointer is honestly absent rather than pointing at a row the compiler
   * cannot address.
   */
  readonly offset: number;
  /** Offset to pass on the next call, or `null` when no further page is reachable. */
  readonly nextOffset: number | null;
  /**
   * How many of `totalCount` rows this tool can reach AT ALL:
   * `min(totalCount, QUERY_GRAPH_MAX_LIMIT)`. The compiled SELECT has a hard
   * `LIMIT` and no `OFFSET`, so the pageable universe is the first
   * `QUERY_GRAPH_MAX_LIMIT` rows of the fixed sort.
   */
  readonly pageableCount: number;
  /**
   * True when `totalCount` exceeds `pageableCount` — matching rows exist that
   * NO `(limit, offset)` pair can address. `note` names the cap and the
   * remedy (narrow with a `where` filter). Never silently folded into
   * `hasMore: false`.
   */
  readonly capReached: boolean;
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
  const limit = input.limit ?? QUERY_GRAPH_DEFAULT_LIMIT;
  const offset = input.offset ?? 0;

  // The graph-layer compiler emits `... ORDER BY <fixed> LIMIT ?` and has NO
  // `OFFSET`, so paging happens HERE, over a materialised window.
  //
  // The window is `offset + limit + 1` rows: the page itself, plus ONE PROBE
  // ROW. The probe is what lets the shared pager see that rows remain past this
  // page without a second query — without it a saturated window is
  // indistinguishable from an exhausted one, which is exactly the mistake that
  // publishes `hasMore: false` over rows that were never delivered. The probe
  // row is never shipped: `paginateLegacy` slices `limit` items.
  //
  // The window is capped at `QUERY_GRAPH_MAX_LIMIT` — the compiler rejects a
  // larger LIMIT and there is no OFFSET to reach past it — so a result set
  // wider than the cap is disclosed via `capReached`, never silently truncated.
  const fetchLimit = Math.min(QUERY_GRAPH_MAX_LIMIT, offset + limit + 1);

  // Reshape the parsed input into the graph-layer GraphQuery. The `where`
  // conditions are passed through verbatim — the graph-layer compiler owns the
  // column/op allowlist and the fail-closed validation.
  const query: GraphQuery = {
    select: input.select,
    ...(input.where !== undefined
      ? { where: input.where as readonly GraphQueryCondition[] }
      : {}),
    limit: fetchLimit,
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

  // For nodes, slim any oversized single property value (Profile/PermissionSet
  // grant matrices) to an `{__omitted}` marker — the full node is one
  // `sfi.get_component` away — BEFORE paging, so the byte budget below measures
  // what will actually ship and a fat property costs the page fewer rows.
  let windowRows: readonly (Node | Edge)[] = result.value.rows;
  const slimmedIds = new Set<string>();
  if (result.value.select === 'nodes') {
    const original = result.value.rows as readonly Node[];
    const slimmed = slimGraphNodes(original);
    windowRows = slimmed.nodes;
    // `slimGraphNodes` returns the SAME object for a node it did not touch, so
    // reference identity names exactly WHICH rows were slimmed. The note has to
    // count the slimmed rows that were SHIPPED — counting the whole window
    // would attribute rows skipped by `offset` to this page.
    slimmed.nodes.forEach((node, i) => {
      if (node !== original[i]) slimmedIds.add(node.id);
    });
  }

  // ADOPT the shared CR-22 pager: it owns the slice, the byte-trim, the
  // forward-progress guarantee, `returnedCount` and the `nextOffset` pointer.
  // The byte-trim it performs replaces this file's own `byteTrimRows`, which was
  // a second spelling of the same arithmetic with no `nextOffset` attached —
  // and a page trimmed by one copy while the pointer is computed by another is
  // precisely how a caller ends up resuming past rows it never received.
  const paged = paginateLegacy(windowRows, {
    offset,
    limit,
    byteBudget: QUERY_GRAPH_BYTE_BUDGET,
    binding: { tool: QUERY_GRAPH_TOOL, vaultHash: ctx.manifest.sourceTreeHash },
  });
  const rows = paged.items;
  const returnedCount = rows.length;
  const totalCount = result.value.totalCount;
  const pageableCount = Math.min(totalCount, QUERY_GRAPH_MAX_LIMIT);
  const capReached = totalCount > pageableCount;
  // `paged.hasMore` only sees the materialised WINDOW; the unpaged `count(*)`
  // sees the whole result set. Take the count(*) view, so a remainder hidden
  // behind the hard cap is still reported as "more exist" rather than dressed
  // up as a complete answer.
  const hasMore = offset + returnedCount < totalCount;
  // `paged.nextOffset` is null exactly when the window is exhausted, which at
  // the cap means the next row is UNADDRESSABLE. Publishing a pointer there
  // would be worse than publishing none: it would send the caller to an offset
  // the compiler cannot reach.
  const nextOffset = paged.nextOffset;

  const slimmedOnPage = rows.filter((row) => slimmedIds.has((row as Node).id)).length;
  const slimNote =
    slimmedOnPage > 0
      ? ` ${slimmedOnPage} node(s) had an oversized property value summarised to an \`{__omitted}\` marker — fetch the full node with \`sfi.get_component\`.`
      : '';
  const trimNote = paged.byteTrimmed
    ? `Page byte-trimmed to ${returnedCount} of the ${limit} row(s) the page limit selected, to stay under the ~45 KB MCP response limit.`
    : '';
  const pageNote =
    hasMore || offset > 0
      ? ` Showing rows ${offset}–${offset + returnedCount} of ${totalCount}.${
          nextOffset === null
            ? ''
            : ` Resume with offset=${nextOffset} (same select/where/limit).`
        }`
      : '';
  const capNote = capReached
    ? ` Only the first ${pageableCount} of ${totalCount} matching row(s) are reachable: the compiled SELECT carries a hard LIMIT of ${QUERY_GRAPH_MAX_LIMIT} and no OFFSET, so no (limit, offset) pair addresses a row beyond it. Narrow with a \`where\` filter to bring the rest into range.`
    : '';
  const note = `${trimNote}${pageNote}${capNote}${slimNote}`.trim();

  return ok({
    data: {
      select: result.value.select,
      rows,
      returnedCount,
      totalCount,
      hasMore,
      limit,
      offset,
      nextOffset,
      pageableCount,
      capReached,
      query: {
        compiledSql: result.value.compiledSql,
        params: result.value.params,
      },
      truncated: paged.byteTrimmed,
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
