/**
 * The PermissionDependency ingest — the PLATFORM's own "permission X
 * requires permission Y" graph, read from the Tooling API.
 *
 * Salesforce ships a standard Tooling object, `PermissionDependency`,
 * whose rows are the edges of a directed graph over permissions:
 *
 *   `Id, Permission, PermissionType, RequiredPermission, RequiredPermissionType`
 *
 * A row means "enabling `Permission` requires `RequiredPermission` to be
 * enabled too" — the platform refuses to save a profile / permission set
 * that grants the former without the latter. That makes the closure of
 * this graph a CORRECTNESS input, not a nicety: a container that declares
 * `ManageUsers` confers every permission `ManageUsers` transitively
 * requires, whether or not the retrieved metadata lists them. Any
 * effective-access answer built from DECLARED grants alone systematically
 * UNDERSTATES access.
 *
 * ## Measured behaviour of this object (probed against a real org)
 *
 * This is a VIRTUAL / synthetic Tooling object and it does not behave like
 * a normal sObject. Everything below was measured, not assumed:
 *
 *   - `SELECT COUNT() FROM PermissionDependency` reported ~9.3k rows. The
 *     number of UNIQUE logical edges is far lower — the wire is
 *     duplicate-heavy (see below) and the true distinct-tuple total for the
 *     whole object was not established. Do not quote a unique-edge count.
 *   - **`LIMIT` IS SILENTLY IGNORED.** Verified at LIMIT 3, 50 and 5 — all
 *     returned the same full result. The `LIMIT` clause below is therefore
 *     a HINT honoured by well-behaved endpoints, never a guarantee, and
 *     nothing in this module may treat a batch's SIZE as a signal.
 *   - **`WHERE Id > '{x}'` and `ORDER BY Id ASC` ARE honoured.** Probed
 *     with a real cursor value, the next page began at the exact
 *     successor id. The keyset walk is therefore sound, and it is the ONLY
 *     mechanism here that can cover the whole object.
 *   - **The queryMore cursor RE-SERVES.** One response carried a records
 *     array of 10,000 holding only 2,000 DISTINCT ids — the server serves
 *     ~2,000 distinct rows per batch and re-serves that same batch ~5x
 *     until it hits a 10,000-record response cap. `totalSize` (~9.3k) and
 *     the records array length (10,000) disagree by design.
 *   - Both `PermissionType` and `RequiredPermissionType` have a closed,
 *     TWO-value domain — the literals `'User Permission'` and
 *     `'Object Permission'` (note the space). The overwhelming majority of
 *     rows are object-typed. These strings are transported VERBATIM; the
 *     classification that reads them lives with the consumer.
 *
 * ## RAW records vs DISTINCT edges — the distinction that must not blur
 *
 * Because the wire re-serves, a RAW record count is roughly 5x the edges
 * it actually carries. Conflating the two produces wrong answers in BOTH
 * directions, so this module keeps them strictly separate:
 *
 *   - `edges.length` is the ONLY count that means "how much of the graph
 *     we have". It is the headline everywhere downstream.
 *   - `rawRowsReceived` is a wire diagnostic. It is used for exactly one
 *     decision — detecting the server's 10,000-RECORD response cap on the
 *     degraded single-query path — and is never presented as an edge count.
 *   - Batch LENGTH is used for NOTHING. Termination is decided purely by
 *     whether the keyset cursor advanced, because `LIMIT` is ignored and a
 *     short batch proves nothing about what lies past the cursor.
 *
 * ## Two read strategies
 *
 *   1. KEYSET (default, and the only complete one): repeated
 *      `WHERE Id > '{last}' ORDER BY Id ASC`, advancing to the highest id
 *      seen, until a batch is EMPTY (definitively past the last row) or the
 *      cursor fails to advance. Duplicate re-serves are expected here and
 *      are harmless — they fold away and the cursor still advances — so
 *      they do NOT mark the result truncated.
 *   2. SINGLE un-paged query, used ONLY when the org rejects the keyset
 *      SOQL on its FIRST query (`query-failed` — an unfilterable or
 *      unsortable `Id` would look exactly like that). This path is
 *      DEGRADED and cannot be trusted to be complete: the measured
 *      un-paged response covered ~2,000 distinct of ~9.3k rows. It is
 *      marked truncated when the raw response hit the record cap OR when
 *      it contained duplicate re-serves at all — duplicates prove the
 *      server was cursoring, which is exactly the regime in which coverage
 *      was measured to be partial.
 *
 * ## What this module does NOT do
 *
 * It does not interpret risk. Verified against a real org, `ModifyAllData`
 * and `ViewAllData` have ZERO dependency edges — the two most dangerous
 * permissions in Salesforce expand to nothing. Dependency is not risk, and
 * no caller should read an empty closure as "harmless".
 *
 * It is PURE with respect to the client: it issues reads and returns a
 * value. Nothing is written to disk here — persistence is the vault's job
 * (`@sf-intelligence/vault` `savePermissionDependencies`).
 */

import { err, ok, type Result } from '@sf-intelligence/core';

import type { ToolingApiClient, ToolingApiError } from './client.js';

/**
 * A raw `PermissionDependency` row as the Tooling API returns it. Field
 * casing is Salesforce's, matching the `Dependency` row shape in
 * `./client.ts` — the SOQL projection and this interface are the same
 * five columns in the same order.
 */
export interface PermissionDependencyRow {
  readonly Id: string;
  readonly Permission: string;
  readonly PermissionType: string;
  readonly RequiredPermission: string;
  readonly RequiredPermissionType: string;
}

/**
 * One normalised dependency EDGE: `permission` requires
 * `requiredPermission`.
 *
 * Names are carried verbatim (including the `Object<verb>` encoding, whose
 * observed verbs include `create`, `update`, `read` and `viewAllRecords`).
 * The `*Type` fields carry the platform's own classification — measured to
 * be `'User Permission'` or `'Object Permission'` — transported unaltered
 * so the consumer can use the authoritative field rather than inferring
 * the kind from the name.
 */
export interface PermissionDependencyEdge {
  readonly permission: string;
  readonly permissionType: string;
  readonly requiredPermission: string;
  readonly requiredPermissionType: string;
}

/** Which read strategy actually produced the rows. */
export type PermissionDependencyStrategy = 'keyset' | 'single';

/** Result shape returned by {@link fetchPermissionDependencies}. */
export interface PermissionDependencyFetchResult {
  /**
   * The deduped edge list, sorted for a byte-stable artifact. THIS is the
   * graph: `edges.length` is the only honest "how many dependencies did we
   * capture" number. Deduped on the SEMANTIC tuple
   * `(permissionType, permission, requiredPermissionType, requiredPermission)`
   * — never on `Id`, which would leave duplicate logical edges behind.
   */
  readonly edges: readonly PermissionDependencyEdge[];
  /**
   * RAW records the wire returned, INCLUDING the server's duplicate
   * re-serves. A WIRE DIAGNOSTIC, roughly 5x the edge count on the probed
   * org — never an edge count, never a headline. Its one decision-making
   * use is detecting the 10,000-record response cap on the single-query
   * path.
   */
  readonly rawRowsReceived: number;
  /**
   * TRUE when this is NOT the whole graph. A consumer MUST propagate it:
   * any closure computed from a truncated capture is a LOWER BOUND on
   * effective access.
   */
  readonly truncated: boolean;
  /** Present only when `truncated` — the specific reason, for disclosure. */
  readonly truncationReason?: string;
  /** Queries issued. */
  readonly pagesFetched: number;
  /** Which strategy produced this result. */
  readonly strategy: PermissionDependencyStrategy;
  /**
   * Rows dropped because `Permission` or `RequiredPermission` was absent
   * or empty — an edge to nowhere is not an edge. Counted, never silent.
   */
  readonly malformedRowsDropped: number;
  /**
   * Raw records collapsed as exact semantic duplicates. Large by design on
   * this object (the cursor re-serves each batch ~5x); it is a property of
   * the WIRE, not a data-quality problem.
   */
  readonly duplicateRowsDropped: number;
  /**
   * Distinct `(permission, requiredPermission)` pairs the wire reported
   * under CONFLICTING type labels. Expected to be 0; a non-zero value
   * means the platform's own type field disagrees with itself and the
   * consumer should disclose rather than silently pick a side.
   */
  readonly conflictingTypeRows: number;
}

/** Per-call options for {@link fetchPermissionDependencies}. */
export interface PermissionDependencyFetchOptions {
  readonly client: ToolingApiClient;
  /**
   * Rows-per-page HINT placed in the `LIMIT` clause. Measured to be
   * SILENTLY IGNORED by this object, so it changes nothing on a real org;
   * it is kept because a well-behaved endpoint honours it and because it
   * costs nothing. NOTHING in this module branches on batch size.
   */
  readonly pageSize?: number;
  /**
   * The RAW RECORD count at which a single un-paged response is known to
   * have been capped by the server. Defaults to
   * {@link PERMISSION_DEPENDENCY_RAW_RECORD_CAP}. Compared against
   * `rawRowsReceived`, NEVER against the edge count — the wire is
   * duplicate-inflated, so an edge count would never reach it.
   */
  readonly rawRecordCap?: number;
  /**
   * Hard bound on keyset pages so a misbehaving server cannot trap the
   * walk. Defaults to 50. At the ~2,000 DISTINCT rows per batch measured
   * on a real org that is ~100,000 distinct edges — comfortably past the
   * ~9.3k rows a dev sandbox reports, with room for a large production
   * org. Exhausting it sets `truncated`.
   */
  readonly maxPages?: number;
  /**
   * Minimum interval between successive queries in milliseconds.
   * Defaults to 200 — the same "be a good citizen" floor
   * `enrichDependencies` uses. Tests pass 0.
   */
  readonly rateLimitPauseMs?: number;
  /** Injectable sleep for tests. Defaults to a `setTimeout`-based sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Default rate-limit interval — Tooling API "be a good citizen" floor. */
const DEFAULT_RATE_LIMIT_PAUSE_MS = 200;

/** Rows-per-page hint. Measured to be ignored by this object; see the options doc. */
const DEFAULT_PAGE_SIZE = 2000;

/**
 * The RAW RECORD cap of a single un-paged `PermissionDependency`
 * response, measured against a real org: the records array stopped at
 * exactly 10,000 while `totalSize` reported ~9.3k and the array held only
 * ~2,000 distinct ids.
 *
 * This is a count of WIRE RECORDS, not of dependency edges. It is compared
 * against `rawRowsReceived` only. The keyset walk genuinely steps past it
 * — each keyset page is its own bounded query and the `WHERE Id >` cursor
 * was verified to advance to the exact successor row — so an org with more
 * than 10,000 distinct edges is still captured completely by strategy 1.
 * It is strategy 2, the degraded single-query fallback, that cannot.
 */
export const PERMISSION_DEPENDENCY_RAW_RECORD_CAP = 10_000;

/** Keyset page budget — see {@link PermissionDependencyFetchOptions.maxPages}. */
const DEFAULT_MAX_PAGES = 50;

/** The five columns, projected identically on both read paths. */
const PROJECTION =
  'SELECT Id, Permission, PermissionType, RequiredPermission, RequiredPermissionType FROM PermissionDependency';

/** Default sleep used between successive queries. */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** SOQL string-literal escaping — backslash first, so `\'` cannot break out. */
const escapeSoqlLiteral = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** A row is usable only when BOTH endpoints of the edge are named. */
const isUsableRow = (row: PermissionDependencyRow | undefined): boolean =>
  row !== undefined &&
  typeof row.Permission === 'string' &&
  row.Permission.length > 0 &&
  typeof row.RequiredPermission === 'string' &&
  row.RequiredPermission.length > 0;

/** Normalise a type label; a missing/non-string value becomes the empty string. */
const typeLabel = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Folded output of {@link foldRows}. */
interface FoldedRows {
  readonly edges: readonly PermissionDependencyEdge[];
  readonly malformedRowsDropped: number;
  readonly duplicateRowsDropped: number;
  readonly conflictingTypeRows: number;
}

/**
 * Fold raw records into the deduped, sorted edge list.
 *
 * Dedupe key is the SEMANTIC tuple
 * `(permissionType, permission, requiredPermissionType, requiredPermission)`.
 * Deduping on `Id` would be wrong twice over: the server re-serves the SAME
 * ids (so Id-dedup would still work for those) but different ids can carry
 * the same logical edge, and Id-level dedup would leave those duplicate
 * logical edges in the graph.
 *
 * A `(permission, requiredPermission)` pair appearing under two DIFFERENT
 * type labels is kept (both tuples are distinct) and counted in
 * `conflictingTypeRows`, so the consumer can disclose the platform
 * disagreeing with itself rather than silently picking a side.
 */
const foldRows = (rows: readonly PermissionDependencyRow[]): FoldedRows => {
  const seen = new Set<string>();
  const pairTypes = new Map<string, string>();
  const conflictingPairs = new Set<string>();
  const edges: PermissionDependencyEdge[] = [];
  let malformedRowsDropped = 0;
  let duplicateRowsDropped = 0;
  for (const row of rows) {
    if (!isUsableRow(row)) {
      malformedRowsDropped += 1;
      continue;
    }
    const permissionType = typeLabel(row.PermissionType);
    const requiredPermissionType = typeLabel(row.RequiredPermissionType);
    const key = `${permissionType}\x00${row.Permission}\x00${requiredPermissionType}\x00${row.RequiredPermission}`;
    if (seen.has(key)) {
      duplicateRowsDropped += 1;
      continue;
    }
    seen.add(key);
    // Track the type labels each logical pair arrives under, so a platform
    // self-contradiction is COUNTED rather than silently resolved.
    const pairKey = `${row.Permission}\x00${row.RequiredPermission}`;
    const typeKey = `${permissionType}\x00${requiredPermissionType}`;
    const priorTypeKey = pairTypes.get(pairKey);
    if (priorTypeKey === undefined) {
      pairTypes.set(pairKey, typeKey);
    } else if (priorTypeKey !== typeKey) {
      conflictingPairs.add(pairKey);
    }
    edges.push({
      permission: row.Permission,
      permissionType,
      requiredPermission: row.RequiredPermission,
      requiredPermissionType,
    });
  }
  edges.sort((a, b) =>
    a.permission < b.permission
      ? -1
      : a.permission > b.permission
        ? 1
        : a.requiredPermission < b.requiredPermission
          ? -1
          : a.requiredPermission > b.requiredPermission
            ? 1
            : 0,
  );
  return {
    edges,
    malformedRowsDropped,
    duplicateRowsDropped,
    conflictingTypeRows: conflictingPairs.size,
  };
};

/**
 * Read the org's `PermissionDependency` graph.
 *
 * Returns `err` ONLY when nothing usable was read at all (auth failure,
 * network failure, or both strategies rejected on their first query).
 * Every partial outcome comes back as `ok` with `truncated: true` and a
 * `truncationReason` — the caller decides whether a lower-bound graph is
 * worth persisting, and MUST carry the flag forward into any closure it
 * computes.
 *
 * @example
 *   const r = await fetchPermissionDependencies({ client });
 *   if (r.ok && r.value.truncated) {
 *     // disclose: dependency closure is a LOWER BOUND
 *   }
 */
export const fetchPermissionDependencies = async (
  opts: PermissionDependencyFetchOptions,
): Promise<Result<PermissionDependencyFetchResult, ToolingApiError>> => {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const rawRecordCap = opts.rawRecordCap ?? PERMISSION_DEPENDENCY_RAW_RECORD_CAP;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const pauseMs = opts.rateLimitPauseMs ?? DEFAULT_RATE_LIMIT_PAUSE_MS;
  const sleep = opts.sleep ?? defaultSleep;

  const rows: PermissionDependencyRow[] = [];
  let pagesFetched = 0;
  let truncated = false;
  let truncationReason: string | undefined;
  let lastId = '';

  /** Assemble the result from an already-folded row set. */
  const build = (
    strategy: PermissionDependencyStrategy,
    folded: FoldedRows,
  ): PermissionDependencyFetchResult => ({
    edges: folded.edges,
    rawRowsReceived: rows.length,
    truncated,
    ...(truncationReason !== undefined ? { truncationReason } : {}),
    pagesFetched,
    strategy,
    malformedRowsDropped: folded.malformedRowsDropped,
    duplicateRowsDropped: folded.duplicateRowsDropped,
    conflictingTypeRows: folded.conflictingTypeRows,
  });

  /** Fold and assemble — the exit used by every keyset return. */
  const finish = (strategy: PermissionDependencyStrategy): PermissionDependencyFetchResult =>
    build(strategy, foldRows(rows));

  // ---- Strategy 1: keyset walk -------------------------------------------
  // Termination is CURSOR-based, never size-based: `LIMIT` is ignored by
  // this object and each batch is duplicate-inflated, so a batch's length
  // says nothing about whether more rows lie past the cursor. We stop only
  // on an EMPTY batch (definitively past the last row) or on a cursor that
  // fails to advance. The cost is one extra empty query per walk; the
  // alternative is a size heuristic that can silently claim a partial
  // capture is complete.
  let keysetRejected = false;
  for (let page = 0; page < maxPages; page++) {
    if (pagesFetched > 0 && pauseMs > 0) await sleep(pauseMs);
    const where = lastId.length > 0 ? ` WHERE Id > '${escapeSoqlLiteral(lastId)}'` : '';
    const soql = `${PROJECTION}${where} ORDER BY Id ASC LIMIT ${pageSize}`;
    const result = await opts.client.query<PermissionDependencyRow>(soql);
    if (!result.ok) {
      if (pagesFetched === 0) {
        // The FIRST keyset query failed. A `query-failed` here is the
        // "this org will not let me filter/sort Id on this object" shape,
        // so fall through to the degraded single query rather than
        // reporting no dependency graph at all. Auth / network / rate-limit
        // are NOT recoverable by re-asking the same way — those propagate.
        if (result.error.kind !== 'query-failed') return err(result.error);
        keysetRejected = true;
        break;
      }
      // Mid-walk failure with pages already banked: keep what we have and
      // say plainly that it is incomplete. Discarding banked pages would
      // trade a disclosed partial graph for no graph.
      truncated = true;
      truncationReason = `keyset walk stopped after ${pagesFetched} page(s): ${result.error.kind}: ${result.error.message}`;
      return ok(finish('keyset'));
    }
    pagesFetched += 1;
    const batch = result.value;
    if (batch.length === 0) {
      // Nothing past the cursor — the walk covered the object.
      return ok(finish('keyset'));
    }
    for (const row of batch) rows.push(row);
    // Highest id in the batch, scanned rather than assumed from the tail:
    // `ORDER BY Id ASC` is honoured, but the batch is re-served and a
    // max-scan costs one pass and cannot regress the cursor.
    let maxId = '';
    for (const row of batch) {
      const id = typeof row?.Id === 'string' ? row.Id : '';
      if (id > maxId) maxId = id;
    }
    if (maxId.length === 0 || maxId <= lastId) {
      // No usable cursor to advance on (no Id, or the server re-served
      // without moving past the last one). Stopping is the only safe move —
      // looping would spin forever on the same batch.
      truncated = true;
      truncationReason = `keyset walk could not advance past id '${lastId}' after ${pagesFetched} page(s) (missing or non-advancing Id) — the dependency graph is incomplete`;
      return ok(finish('keyset'));
    }
    lastId = maxId;
    if (page === maxPages - 1) {
      truncated = true;
      truncationReason = `keyset page budget exhausted after ${maxPages} page(s) — the dependency graph is incomplete`;
      return ok(finish('keyset'));
    }
  }
  if (!keysetRejected && pagesFetched > 0) {
    return ok(finish('keyset'));
  }

  // ---- Strategy 2: degraded single query ---------------------------------
  // Only reached when the org rejected the keyset SOQL. This path CANNOT be
  // trusted to be complete: the measured un-paged response carried 10,000
  // records holding ~2,000 distinct rows against a ~9.3k-row object — about
  // a fifth of the graph. Two signals mark it truncated:
  //   1. the raw response hit the server's record cap; or
  //   2. it contained duplicate re-serves AT ALL, which proves the server
  //      was cursoring this virtual object — exactly the regime in which
  //      coverage was measured to be partial.
  // Erring toward "truncated" here is the safe direction: it yields a
  // LOWER-BOUND claim on a path that is already abnormal.
  const single = await opts.client.query<PermissionDependencyRow>(PROJECTION);
  if (!single.ok) return err(single.error);
  pagesFetched = 1;
  rows.length = 0;
  for (const row of single.value) rows.push(row);
  const folded = foldRows(rows);
  if (rows.length >= rawRecordCap) {
    truncated = true;
    truncationReason = `un-paged PermissionDependency query returned ${rows.length} RAW records (${folded.edges.length} distinct edges), at or above the ${rawRecordCap}-record server response cap — this is a CAPPED response, not the whole graph`;
  } else if (folded.duplicateRowsDropped > 0) {
    truncated = true;
    truncationReason = `un-paged PermissionDependency query returned ${rows.length} RAW records collapsing to only ${folded.edges.length} distinct edges — the server re-served its cursor, which is the regime in which an un-paged response was measured to cover about a fifth of the object; completeness cannot be claimed`;
  }
  return ok(build('single', folded));
};
