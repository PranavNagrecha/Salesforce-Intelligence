/**
 * `UserEntityAccess` fetcher — the PLATFORM's own verdict on ONE user's
 * per-object access.
 *
 * The offline engine (`sfi.effective_permissions` / `computeEffectiveGrants`)
 * RECONSTRUCTS effective object access from vault metadata: profile grants,
 * permission sets, permission-set groups, muting sets, re-grants. That
 * reconstruction is the product's moat — it works with no org connection — but
 * it has no way to know when it is wrong. `UserEntityAccess` is Salesforce
 * computing the same thing itself and handing back its FINAL answer, so it is
 * the parity ORACLE that can prove the offline engine right or wrong.
 *
 * This module is the fetch half only. It is PURE with respect to its inputs
 * (mirrors `enrich-dependencies.ts`): it issues queries and returns rows plus
 * honest markers; the caller does the diffing and applies the result.
 *
 * ## Why this MUST be targeted (the design crux)
 *
 * `UserEntityAccess` **cannot be paged**. An unbounded query fails hard:
 *
 * ```
 * EXCEEDED_ID_LIMIT: UserEntityAccess does not support queryMore(),
 * use LIMIT to restrict the results to a single batch
 * ```
 *
 * `LIMIT` **is** honoured on this object (verified against a real org:
 * `LIMIT 200` → exactly 200 rows, `LIMIT 2000` → exactly 2000 rows). That is
 * NOT true of every Tooling object — `PermissionDependency` silently ignores
 * `LIMIT` — so do not port a pagination strategy across from there.
 *
 * The consequence is architectural, not cosmetic: there is no "sync every
 * entity" mode available at any price. An org has thousands of entity
 * definitions and the platform will not enumerate them through this object.
 * So every call is bounded — a caller-supplied user plus a caller-supplied,
 * capped list of object names, chunked into `IN (...)` batches, each batch
 * carrying an explicit `LIMIT`.
 *
 * ## Verified query shape
 *
 * ```sql
 * SELECT EntityDefinitionId, IsReadable, IsCreatable, IsEditable, IsDeletable,
 *        IsUndeletable, IsFlsUpdatable
 * FROM UserEntityAccess
 * WHERE UserId = '{18-char-id}'
 *   AND EntityDefinitionId IN ('Account','Contact','Opportunity','Lead','Case')
 * LIMIT 50
 * ```
 *
 * `EntityDefinitionId` is the object NAME (`'Account'`) in the filter and in
 * the response — NOT a durable id.
 *
 * ## Flags do not move together
 *
 * A real admin in a real sandbox came back as
 * `R=true C=false E=true D=false Undel=true FLS=true` on Account, Contact and
 * Opportunity. `IsCreatable=false` alongside `IsEditable=true` is not a bug and
 * must never be "corrected": within the scope of this module the platform's
 * answer IS the ground truth. Nothing here normalizes, infers, or repairs a
 * surprising combination.
 *
 * ## Failure posture
 *
 * Never throws on partial data. A batch that fails is recorded in
 * {@link UserEntityAccessReport.failures} and the surviving batches' rows are
 * still returned. A requested object with NO returned row lands in
 * {@link UserEntityAccessReport.missing} — "the platform did not answer for
 * this object", which is emphatically NOT "the user has no access". The
 * `Result` err channel is reserved for caller-input faults (bad user id,
 * malformed object name, over-cap request) that must fail loudly before any
 * SOQL is built.
 */

import { err, ok, type Result } from '@sf-intelligence/core';

import type { ToolingApiClient, ToolingApiError } from './client.js';

/**
 * The client surface this fetcher needs — structurally the `query` half of
 * {@link ToolingApiClient}. Narrowed deliberately so a caller that routes
 * Tooling reads through its own budgeted/consented seam (the MCP live plane
 * does exactly this) can supply an adapter without constructing a real HTTP
 * client, while the production `ToolingApiClient` still satisfies it directly.
 */
export type UserEntityAccessClient = Pick<ToolingApiClient, 'query'>;

/**
 * The six per-object access flags this module reads, in the verified order.
 *
 * `IsMergeable`, `IsUpdatable` and `IsActivateable` are queryable but are NOT
 * fetched: they describe what can be done to the ENTITY DEFINITION, not what
 * this user may do to records of it, and pulling them would invite a bogus
 * `IsUpdatable`≈`IsEditable` equivalence. Adding them is a deliberate decision,
 * not a widening of the SELECT.
 */
export const USER_ENTITY_ACCESS_FLAGS = [
  'IsReadable',
  'IsCreatable',
  'IsEditable',
  'IsDeletable',
  'IsUndeletable',
  'IsFlsUpdatable',
] as const;

export type UserEntityAccessFlag = (typeof USER_ENTITY_ACCESS_FLAGS)[number];

/** One `UserEntityAccess` row — the platform's verdict for one object. */
export interface UserEntityAccessRow {
  /** The object API NAME (`'Account'`), not a durable id. */
  readonly EntityDefinitionId: string;
  readonly IsReadable: boolean;
  readonly IsCreatable: boolean;
  readonly IsEditable: boolean;
  readonly IsDeletable: boolean;
  readonly IsUndeletable: boolean;
  readonly IsFlsUpdatable: boolean;
}

/**
 * Objects per `IN (...)` batch. One (user, object) pair yields at most one
 * row, so 50 objects is 50 rows — comfortably inside a single batch.
 */
export const USER_ENTITY_ACCESS_CHUNK_SIZE = 50;

/**
 * `LIMIT` stamped on every batch. Deliberately 4× the chunk size: it is the
 * hard guard that keeps the query inside one batch (so `queryMore` is never
 * reached), while the headroom means hitting the limit is a genuine anomaly
 * worth reporting rather than the normal full-chunk case. Verified honoured
 * at this magnitude on a real org.
 */
export const USER_ENTITY_ACCESS_QUERY_LIMIT = 200;

/**
 * Documented per-call cap on requested objects. Two batches. Chosen against
 * the live plane's per-session query budget (default 50) so one oracle call
 * cannot eat a meaningful fraction of a session. A caller wanting more must
 * make more calls and own the fact that they are separate point-in-time reads.
 */
export const USER_ENTITY_ACCESS_MAX_OBJECTS = 100;

/** Salesforce 15- or 18-character record id. */
const RECORD_ID_RE = /^[a-zA-Z0-9]{15,18}$/;

/** A simple, unqualified Salesforce object API name (covers `__c`, `__mdt`). */
const OBJECT_API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Caller-input faults. Raised BEFORE any SOQL is built. */
export interface UserEntityAccessInputError {
  readonly kind: 'invalid-user-id' | 'invalid-object-name' | 'no-objects' | 'too-many-objects';
  readonly message: string;
}

/** One batch that did not come back. Its objects are unanswered, not denied. */
export interface UserEntityAccessBatchFailure {
  /** Zero-based batch index, in issue order. */
  readonly batchIndex: number;
  /** The object names this batch asked about — every one is now unanswered. */
  readonly objects: readonly string[];
  /** The underlying Tooling API error class. */
  readonly kind: ToolingApiError['kind'];
  readonly message: string;
}

/** What one bounded oracle read produced. */
export interface UserEntityAccessReport {
  readonly userId: string;
  /** Objects the caller asked about, de-duplicated, in caller order. */
  readonly requested: readonly string[];
  /** Rows the platform returned, in arrival order. */
  readonly rows: readonly UserEntityAccessRow[];
  /**
   * Requested objects the platform returned NO row for. The reason is not
   * knowable from here (object does not exist, not visible to the running
   * user, entity not exposed through `UserEntityAccess`, or the batch failed).
   * Treating these as "no access" is the single most dangerous mistake a
   * consumer can make with this data.
   */
  readonly missing: readonly string[];
  /** Batches that errored. Their objects also appear in `missing`. */
  readonly failures: readonly UserEntityAccessBatchFailure[];
  /** How many `IN (...)` batches were issued. */
  readonly batchCount: number;
  /** The `LIMIT` stamped on each batch. */
  readonly limitPerBatch: number;
  /**
   * True when any batch returned exactly `limitPerBatch` rows — i.e. the
   * result may have been silently cut. Should never fire at the configured
   * chunk/limit ratio; if it does, the response is NOT complete and the
   * consumer must say so rather than diffing against a truncated set.
   */
  readonly limitReached: boolean;
  /**
   * The exact SOQL issued, one entry per batch, in issue order. Kept so a
   * consumer can cite what it actually asked the platform instead of
   * paraphrasing it.
   */
  readonly queries: readonly string[];
  /** True when every requested object got a row and no batch failed. */
  readonly complete: boolean;
}

export interface FetchUserEntityAccessOptions {
  readonly client: UserEntityAccessClient;
  /** 15- or 18-character Salesforce User id. */
  readonly userId: string;
  /** Object API names. De-duplicated case-insensitively; caller order kept. */
  readonly objects: readonly string[];
  /** Objects per `IN (...)` batch. Defaults to {@link USER_ENTITY_ACCESS_CHUNK_SIZE}. */
  readonly chunkSize?: number;
  /** Per-batch `LIMIT`. Defaults to {@link USER_ENTITY_ACCESS_QUERY_LIMIT}. */
  readonly limitPerBatch?: number;
  /** Per-call object cap. Defaults to {@link USER_ENTITY_ACCESS_MAX_OBJECTS}. */
  readonly maxObjects?: number;
}

/**
 * SOQL string-literal escape. Backslash FIRST, then quote — reversing the
 * order lets a trailing backslash terminate the literal and inject SOQL.
 * Both inputs are additionally shape-validated above, so this is the second
 * of two independent guards, not the only one.
 */
const soqlLiteral = (value: string): string =>
  `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Coerce a Tooling API JSON value to a strict boolean (absent → false). */
const asBool = (value: unknown): boolean => value === true;

/**
 * Build one batch's SOQL. Exported so a test can assert the shape — in
 * particular that the statement ALWAYS carries a `LIMIT` and a bounded
 * `IN (...)`, i.e. that the unbounded `queryMore`-triggering form can never be
 * issued from this module.
 */
export const buildUserEntityAccessSoql = (
  userId: string,
  objects: readonly string[],
  limit: number,
): string =>
  `SELECT EntityDefinitionId, ${USER_ENTITY_ACCESS_FLAGS.join(', ')} ` +
  `FROM UserEntityAccess ` +
  `WHERE UserId = ${soqlLiteral(userId)} ` +
  `AND EntityDefinitionId IN (${objects.map(soqlLiteral).join(',')}) ` +
  `LIMIT ${limit}`;

/**
 * Ask the platform for its own verdict on `userId`'s access to `objects`.
 *
 * @example
 *   const report = await fetchUserEntityAccess({
 *     client,
 *     userId,
 *     objects: ['Account', 'Contact', 'Opportunity'],
 *   });
 *   if (!report.ok) return report;            // caller-input fault
 *   for (const row of report.value.rows) { ... }
 *   // report.value.missing is "not answered", NEVER "no access".
 */
export const fetchUserEntityAccess = async (
  opts: FetchUserEntityAccessOptions,
): Promise<Result<UserEntityAccessReport, UserEntityAccessInputError>> => {
  const userId = opts.userId.trim();
  if (!RECORD_ID_RE.test(userId)) {
    return err({
      kind: 'invalid-user-id',
      message:
        'userId must be a 15- or 18-character Salesforce User id — ' +
        'UserEntityAccess is keyed on UserId and has no name-based filter.',
    });
  }

  const maxObjects = opts.maxObjects ?? USER_ENTITY_ACCESS_MAX_OBJECTS;
  const chunkSize = Math.max(1, opts.chunkSize ?? USER_ENTITY_ACCESS_CHUNK_SIZE);
  const limitPerBatch = Math.max(1, opts.limitPerBatch ?? USER_ENTITY_ACCESS_QUERY_LIMIT);

  // De-duplicate case-insensitively (SOQL matches object names case-
  // insensitively, so `account` and `Account` are one query slot) while
  // keeping the caller's spelling and order for everything user-facing.
  const requested: string[] = [];
  const seen = new Set<string>();
  for (const raw of opts.objects) {
    const name = raw.trim();
    if (!OBJECT_API_NAME_RE.test(name)) {
      return err({
        kind: 'invalid-object-name',
        message:
          `'${raw}' is not a simple Salesforce object API name ` +
          '(letters, digits, underscores). Refusing to build a filter from it.',
      });
    }
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    requested.push(name);
  }

  if (requested.length === 0) {
    return err({
      kind: 'no-objects',
      message:
        'UserEntityAccess cannot be enumerated — it does not support queryMore(), ' +
        'so there is no "all objects" mode. Name the objects to check.',
    });
  }
  if (requested.length > maxObjects) {
    return err({
      kind: 'too-many-objects',
      message:
        `${requested.length} objects requested but the per-call cap is ${maxObjects}. ` +
        'UserEntityAccess must be read in bounded batches (it cannot be paged); ' +
        'split the request and treat each call as its own point-in-time read.',
    });
  }

  const batches: string[][] = [];
  for (let i = 0; i < requested.length; i += chunkSize) {
    batches.push(requested.slice(i, i + chunkSize));
  }

  const rows: UserEntityAccessRow[] = [];
  const failures: UserEntityAccessBatchFailure[] = [];
  const queries: string[] = [];
  let limitReached = false;

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex] ?? [];
    const soql = buildUserEntityAccessSoql(userId, batch, limitPerBatch);
    queries.push(soql);

    const result = await opts.client.query<Record<string, unknown>>(soql);
    if (!result.ok) {
      // Partial data is still data: record the failed batch and keep going, so
      // one edition-specific or transient failure cannot blank the whole read.
      failures.push({
        batchIndex,
        objects: batch,
        kind: result.error.kind,
        message: result.error.message,
      });
      continue;
    }

    const batchRows = result.value;
    if (batchRows.length >= limitPerBatch) limitReached = true;
    for (const raw of batchRows) {
      const entity = raw['EntityDefinitionId'];
      if (typeof entity !== 'string' || entity.length === 0) continue;
      rows.push({
        EntityDefinitionId: entity,
        IsReadable: asBool(raw['IsReadable']),
        IsCreatable: asBool(raw['IsCreatable']),
        IsEditable: asBool(raw['IsEditable']),
        IsDeletable: asBool(raw['IsDeletable']),
        IsUndeletable: asBool(raw['IsUndeletable']),
        IsFlsUpdatable: asBool(raw['IsFlsUpdatable']),
      });
    }
  }

  const answered = new Set(rows.map((r) => r.EntityDefinitionId.toLowerCase()));
  const missing = requested.filter((name) => !answered.has(name.toLowerCase()));

  return ok({
    userId,
    requested,
    rows,
    missing,
    failures,
    batchCount: batches.length,
    limitPerBatch,
    limitReached,
    queries,
    complete: missing.length === 0 && failures.length === 0 && !limitReached,
  });
};
