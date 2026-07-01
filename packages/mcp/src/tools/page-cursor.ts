/**
 * CR-22 continuation-cursor protocol — the shared FOUNDATION (B0).
 *
 * A handler that pages a list emits a `PageInfo` with an opaque `nextCursor`
 * ONLY when the page it just produced was truncated (over a byte budget OR over
 * `limit`). The caller treats the token as a black box and echoes it back as
 * the `cursor` input; the handler decodes it, validates that it belongs to THIS
 * query (same tool, same vault hash, same arg fingerprint), and resumes from
 * the encoded offset. A request with NO cursor behaves exactly as before —
 * offset 0, default limit — so an in-budget response stays byte-identical and
 * the golden-diff does not move.
 *
 * This module owns three concerns:
 *   1. `encodeCursor` / `decodeCursor` — the opaque, versioned, hardened token
 *      codec. `decodeCursor` is the FIRST place the codebase `JSON.parse`s
 *      client-supplied bytes, so it is defensive: length-cap BEFORE decode,
 *      then type-and-range validate every field, and on ANY failure return an
 *      `invalid-query` `McpError` (never slice with an unvalidated offset).
 *   2. `paginate` — a flat single-list pager handlers call instead of
 *      open-coding `slice` + `hasMore` + `nextOffset` + byte-trim. It
 *      guarantees FORWARD PROGRESS: a single row whose serialized size alone
 *      exceeds the budget is slimmed and shipped alone (never an empty page),
 *      and the cursor advances by 1. The slimmer reduces long strings until the
 *      1-item page fits the budget; the only residual case is a large
 *      NON-string structure (e.g. a huge number array) that long-string
 *      trimming can't shrink — then the page is shipped flagged
 *      (`oversizedRowUnslimmable`) and the global `jsonResult` response guard
 *      converts the envelope to a structured `oversize` error.
 *   3. `paginateSection` — the multi-list / section variant. The token carries
 *      a `listId` so a handler with several independent lists (or nested
 *      grouped lists) can page ONE designated list and disclose the others
 *      honestly.
 *
 * NOTE (B0 scope): this module is the foundation + its unit tests ONLY. No
 * handler is converted here — that is B1. Nothing in the live tool roster
 * changes as a result of adding this file.
 */

import { createHash } from 'node:crypto';

import type { McpError, PageCursorToken, PageInfo } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';

/**
 * Current cursor protocol version. Bumped only on a breaking encoding change;
 * a decoded token whose `v` differs is rejected as stale (`invalid-query`).
 */
export const PAGE_CURSOR_VERSION = 1;

/**
 * Hard cap on the raw base64url token length, enforced BEFORE base64-decode and
 * JSON.parse. A legitimate token is well under 512 bytes (a handful of short
 * fields); anything larger is a malformed or adversarial input and is rejected
 * without ever being parsed. This bounds the work an attacker can force.
 */
export const MAX_CURSOR_RAW_BYTES = 512;

/** A safe non-negative integer (offset / scanOffset). Rejects negatives, floats, NaN, >MAX_SAFE_INTEGER. */
const isSafeNonNegativeInt = (v: unknown): v is number =>
  typeof v === 'number' &&
  Number.isInteger(v) &&
  v >= 0 &&
  v <= Number.MAX_SAFE_INTEGER;

/** A non-empty string field (tool / vault hash / fingerprint / key / listId). */
const isString = (v: unknown): v is string => typeof v === 'string';

/** Build the canonical `invalid-query` error every rejection path returns. */
const staleCursorError = (): McpError => ({
  kind: 'invalid-query',
  message: 'cursor stale or for a different query; restart without cursor',
});

/**
 * Serialize a {@link PageCursorToken} to an opaque base64url string. The token
 * is JSON with single-letter keys to stay compact. Callers never read the
 * result — it is a blob they echo back.
 */
export const encodeCursor = (token: PageCursorToken): string => {
  const json = JSON.stringify(token);
  return Buffer.from(json, 'utf8').toString('base64url');
};

/** What a resume must match for a decoded cursor to be accepted. */
export interface DecodeCursorExpect {
  /** The tool name resuming the cursor — must equal the token's `t`. */
  readonly tool: string;
  /** The current vault `sourceTreeHash` — must equal the token's `h`. */
  readonly vaultHash: string;
  /**
   * The current query's arg fingerprint — must equal the token's `q`. When
   * omitted, the token is required to ALSO carry no `q` (both-or-neither), so a
   * fingerprinted cursor can't be replayed against a fingerprint-less call.
   */
  readonly argsFingerprint?: string;
}

/**
 * Decode + validate a client-supplied cursor. Returns the decoded token on
 * success, or an `invalid-query` {@link McpError} on ANY failure — oversized
 * raw input, malformed base64/JSON, version mismatch, wrong tool, wrong vault
 * hash, wrong arg fingerprint, or a field that is the wrong type or out of
 * range. The handler NEVER receives a partially-validated token, so it can
 * never slice with an unvalidated offset.
 *
 * Hardening order is deliberate:
 *   1. length-cap the RAW string BEFORE base64-decode/JSON.parse;
 *   2. parse defensively (any throw → reject);
 *   3. type-and-range validate EVERY field;
 *   4. bind-check v / t / h / q against the resuming query.
 */
export const decodeCursor = (
  raw: unknown,
  expect: DecodeCursorExpect,
): Result<PageCursorToken, McpError> => {
  // 1. Length-cap the raw token before any decode work. Reject non-strings and
  //    anything over the byte cap up front.
  if (typeof raw !== 'string' || raw.length === 0) return err(staleCursorError());
  if (Buffer.byteLength(raw, 'utf8') > MAX_CURSOR_RAW_BYTES) {
    return err(staleCursorError());
  }

  // 2. Defensive decode + parse. base64url is lenient, so also confirm the
  //    parsed value is a plain object before touching fields.
  let parsed: unknown;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    return err(staleCursorError());
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return err(staleCursorError());
  }
  const obj = parsed as Record<string, unknown>;

  // 3. Type-and-range validate EVERY field.
  if (obj['v'] !== PAGE_CURSOR_VERSION) return err(staleCursorError());
  if (!isString(obj['t'])) return err(staleCursorError());
  if (!isString(obj['h'])) return err(staleCursorError());
  if (!isSafeNonNegativeInt(obj['o'])) return err(staleCursorError());
  // Optional fields: present → must be the right type/range.
  if (obj['k'] !== undefined && !isString(obj['k'])) return err(staleCursorError());
  if (obj['s'] !== undefined && !isSafeNonNegativeInt(obj['s'])) {
    return err(staleCursorError());
  }
  if (obj['q'] !== undefined && !isString(obj['q'])) return err(staleCursorError());
  if (obj['listId'] !== undefined && !isString(obj['listId'])) {
    return err(staleCursorError());
  }

  // 4. Bind-check: the cursor must belong to THIS query.
  if (obj['t'] !== expect.tool) return err(staleCursorError());
  if (obj['h'] !== expect.vaultHash) return err(staleCursorError());
  // Fingerprint is both-or-neither: a fingerprinted token must match, and a
  // fingerprint-less call must reject a fingerprinted token (and vice versa).
  if ((obj['q'] as string | undefined) !== expect.argsFingerprint) {
    return err(staleCursorError());
  }

  const token: PageCursorToken = {
    v: PAGE_CURSOR_VERSION,
    t: obj['t'],
    h: obj['h'],
    o: obj['o'] as number,
    ...(obj['k'] !== undefined ? { k: obj['k'] as string } : {}),
    ...(obj['s'] !== undefined ? { s: obj['s'] as number } : {}),
    ...(obj['q'] !== undefined ? { q: obj['q'] as string } : {}),
    ...(obj['listId'] !== undefined ? { listId: obj['listId'] as string } : {}),
  };
  return ok(token);
};

/** Identity the minted cursor is bound to — the same triple `decodeCursor` checks. */
export interface PaginateBinding {
  /** Tool name minting the cursor (e.g. `sfi.get_edges`). */
  readonly tool: string;
  /** Current vault `sourceTreeHash`. */
  readonly vaultHash: string;
  /** Optional arg fingerprint — stamped onto the cursor so a resume can verify it. */
  readonly argsFingerprint?: string;
}

/** Options shared by `paginate` and `paginateSection`. */
export interface PaginateOptions<T> {
  /** Resume offset into the list (post-decode `token.o`; default 0). */
  readonly offset?: number;
  /** Max items per page (default {@link DEFAULT_PAGE_LIMIT}). */
  readonly limit?: number;
  /** Per-response byte budget for the page slice (default {@link DEFAULT_PAGE_BYTE_BUDGET}). */
  readonly byteBudget?: number;
  /** Identity to stamp onto a minted cursor. */
  readonly binding: PaginateBinding;
  /**
   * Optional total-order tiebreak key extractor (e.g. a row's edge-PK / id).
   * When given, the last kept item's key is stamped onto the cursor as `k`.
   */
  readonly keyOf?: (item: T) => string;
  /**
   * Forward-progress slimmer: shrink ONE oversized item so a 1-item page fits
   * the budget. Returns the slimmed item (the original is never mutated).
   * Defaults to {@link defaultItemSlim}, which reuses the same long-string
   * trim shape as the global `jsonResult` budget.
   */
  readonly slimItem?: (item: T) => T;
  /** Optional scan offset to carry on the minted cursor as `s`. */
  readonly scanOffset?: number;
}

/** Default page size when a handler does not pass `limit`. Mirrors `get_edges`. */
export const DEFAULT_PAGE_LIMIT = 200;
/** Default per-page byte budget, matching the paginated tools' ~38 KB slice budget. */
export const DEFAULT_PAGE_BYTE_BUDGET = 38_000;

/** Long-string trim threshold for the forward-progress slimmer (mirrors jsonResult). */
const SLIM_STRING_THRESHOLD_BYTES = 1_536;
/** …trimmed down to this many leading characters plus a marker. */
const SLIM_STRING_KEEP_CHARS = 1_024;

const utf8Bytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');

/**
 * Slim every string longer than `thresholdBytes` to a head of `keepChars`
 * characters plus a `…[+N bytes trimmed]` marker — the SAME shape
 * `jsonResult.slimDataStrings` uses. Deep-clones, never mutates the input.
 */
const slimStringsWith = <T>(item: T, thresholdBytes: number, keepChars: number): T => {
  const slimString = (v: string): string =>
    `${v.slice(0, keepChars)} …[+${Buffer.byteLength(v, 'utf8') - keepChars} bytes trimmed]`;
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      return Buffer.byteLength(node, 'utf8') > thresholdBytes ? slimString(node) : node;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(node as Record<string, unknown>)) {
        out[k] = walk((node as Record<string, unknown>)[k]);
      }
      return out;
    }
    return node;
  };
  return walk(structuredClone(item)) as T;
};

/**
 * Default per-item slimmer used for forward progress. Deep-clones the item and
 * trims every long string to a head + `…[+N bytes trimmed]` marker — the SAME
 * shape `jsonResult.slimDataStrings` uses — so a single fat row can be reduced
 * enough to ship a 1-item page. Never mutates the input.
 */
export const defaultItemSlim = <T>(item: T): T =>
  slimStringsWith(item, SLIM_STRING_THRESHOLD_BYTES, SLIM_STRING_KEEP_CHARS);

/**
 * Forward-progress reducer: slim ONE oversized row until it serializes within
 * `budget`, so a 1-item page is genuinely under the byte budget (not merely
 * "shipped"). Strategy, in order:
 *   1. apply the caller's `slimItem` (default {@link defaultItemSlim});
 *   2. if still over budget, progressively shrink the long-string keep-length
 *      (1024 → 256 → 64 → 8 chars) — this rescues many-long-strings rows;
 *   3. if STILL over budget (large NON-string structure: a huge number array,
 *      deeply nested objects), the row is structurally un-slimmable here. Return
 *      it as-is and let the caller flag it — the global `jsonResult` response
 *      guard converts the envelope to a structured `oversize` error. Forward
 *      progress holds regardless (offset advances by 1, page is never empty).
 *
 * Returns `{ item, underBudget }` so `paginateList` can record whether the
 * 1-item page is truly within budget.
 */
const reduceOversizedItem = <T>(
  item: T,
  budget: number,
  slimItem: (item: T) => T,
): { item: T; underBudget: boolean } => {
  let reduced = slimItem(item);
  if (utf8Bytes([reduced]) <= budget) return { item: reduced, underBudget: true };
  // Progressively shrink the long-string keep-length for many-long-strings rows.
  for (const keep of [256, 64, 8]) {
    reduced = slimStringsWith(item, keep, keep);
    if (utf8Bytes([reduced]) <= budget) return { item: reduced, underBudget: true };
  }
  // Un-slimmable big non-string structure: ship the most-slimmed form and flag.
  return { item: reduced, underBudget: false };
};

/** The page a `paginate*` call produces: the slice plus its {@link PageInfo}. */
export interface PaginateResult<T> {
  /** The items for this page (already slimmed if forward-progress kicked in). */
  readonly items: readonly T[];
  /** Cursor-aware pagination metadata to attach under `data`. */
  readonly pageInfo: PageInfo;
  /** True when the page was reduced below `limit` to fit the byte budget. */
  readonly byteTrimmed: boolean;
  /**
   * True ONLY in the rare forward-progress case where a single row was kept
   * alone AND even after maximal slimming it STILL exceeds the byte budget
   * (a large non-string structure — e.g. a huge number array — that can't be
   * trimmed by long-string reduction). The page is shipped anyway to guarantee
   * forward progress; the global `jsonResult` response guard then converts the
   * envelope to a structured `oversize` error. False on every normal page,
   * including a normal forward-progress page that DID fit after slimming.
   */
  readonly oversizedRowUnslimmable: boolean;
}

/**
 * Core slice+budget+forward-progress engine shared by the flat and section
 * pagers. Pages ONE ordered list. Emits a `nextCursor` ONLY when the page is
 * truncated (over `limit` OR over `byteBudget`). Guarantees a non-empty page:
 * if even one item exceeds the budget it is slimmed (long strings reduced until
 * it fits) and shipped alone; the offset still advances by 1. A residual large
 * non-string structure that can't be slimmed is shipped flagged via
 * `oversizedRowUnslimmable` for the caller / global guard to convert.
 *
 * @param items - the FULL ordered list for the designated list (caller already
 *   sorted to a TOTAL order — a unique final tiebreak — so a resume can't dup
 *   or skip).
 * @param listId - optional list identifier stamped onto the cursor (section
 *   variant); omitted for a flat single list.
 */
const paginateList = <T>(
  items: readonly T[],
  opts: PaginateOptions<T>,
  listId?: string,
): PaginateResult<T> => {
  const total = items.length;
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? DEFAULT_PAGE_LIMIT;
  const budget = opts.byteBudget ?? DEFAULT_PAGE_BYTE_BUDGET;
  const slim = opts.slimItem ?? defaultItemSlim;

  // Past the end → empty exhausted page (a resume at total is valid and final).
  if (offset >= total) {
    return {
      items: [],
      byteTrimmed: false,
      oversizedRowUnslimmable: false,
      pageInfo: { totalCount: total, returnedCount: 0, hasMore: false, nextCursor: null },
    };
  }

  const window = items.slice(offset, offset + limit);
  const overLimit = offset + limit < total;

  // Byte-trim from the tail while the slice overflows AND more than one item
  // remains. The last-item case is handled below by forced forward progress.
  let page = window.slice();
  let byteTrimmed = false;
  while (page.length > 1 && utf8Bytes(page) > budget) {
    page = page.slice(0, -1);
    byteTrimmed = true;
  }

  // FORWARD-PROGRESS guarantee: a single row whose serialized size alone
  // exceeds the budget must NOT yield an empty page (which would loop forever
  // at the same offset). Keep exactly that one item but reduce it until the
  // 1-item page is actually under budget. If even maximal slimming can't fit it
  // (a large non-string structure), ship it anyway and flag it — the global
  // response guard converts the envelope to an oversize error. Either way the
  // cursor advances by 1, so forward progress holds.
  let oversizedRowUnslimmable = false;
  if (page.length === 1 && utf8Bytes(page) > budget) {
    const { item: reduced, underBudget } = reduceOversizedItem(page[0] as T, budget, slim);
    page = [reduced];
    byteTrimmed = true;
    oversizedRowUnslimmable = !underBudget;
  }

  const returnedCount = page.length;
  const nextOffset = offset + returnedCount;
  const truncated = byteTrimmed || overLimit;
  const hasMore = nextOffset < total;

  // Emit a cursor ONLY on a truncated page. Exhausted or whole-fits pages get
  // `nextCursor: null` so an in-budget call stays byte-identical to today.
  let nextCursor: string | null = null;
  if (truncated && hasMore) {
    const lastItem = page[returnedCount - 1] as T;
    const token: PageCursorToken = {
      v: PAGE_CURSOR_VERSION,
      t: opts.binding.tool,
      h: opts.binding.vaultHash,
      o: nextOffset,
      ...(opts.keyOf !== undefined ? { k: opts.keyOf(lastItem) } : {}),
      ...(opts.scanOffset !== undefined ? { s: opts.scanOffset } : {}),
      ...(opts.binding.argsFingerprint !== undefined
        ? { q: opts.binding.argsFingerprint }
        : {}),
      ...(listId !== undefined ? { listId } : {}),
    };
    nextCursor = encodeCursor(token);
  }

  return {
    items: page,
    byteTrimmed,
    oversizedRowUnslimmable,
    pageInfo: { totalCount: total, returnedCount, hasMore, nextCursor },
  };
};

/**
 * Flat single-list pager. Call this instead of open-coding
 * `slice` + `hasMore` + `nextOffset` + byte-trim. The list MUST already be
 * sorted to a TOTAL order (a unique final tiebreak) so a resume neither dups
 * nor skips. Emits a `nextCursor` ONLY on a truncated page; never yields an
 * empty page (forward-progress slimming keeps ≥1 item).
 */
export const paginate = <T>(
  items: readonly T[],
  opts: PaginateOptions<T>,
): PaginateResult<T> => paginateList(items, opts);

/** One named list handed to {@link paginateSection}. */
export interface PageableSection<T> {
  /** Stable identifier carried on the cursor (e.g. `'object'`, `'system'`). */
  readonly listId: string;
  /** The FULL ordered list for this section (caller already total-ordered). */
  readonly items: readonly T[];
}

/** A non-designated section, disclosed honestly alongside the paged one. */
export interface SectionDisclosure {
  readonly listId: string;
  /** Total items in this section (NOT paged in this response). */
  readonly totalCount: number;
}

/** Result of {@link paginateSection}: the paged section plus the others disclosed. */
export interface PaginateSectionResult<T> extends PaginateResult<T> {
  /** Which section was paged. */
  readonly listId: string;
  /** The other sections, surfaced with their full counts (not paged here). */
  readonly otherSections: readonly SectionDisclosure[];
}

/**
 * Multi-list / section pager. A handler with several INDEPENDENT lists (e.g.
 * `effective_permissions` object+system, `diff_snapshots`' three lists) pages
 * ONE designated section and discloses the others honestly with their counts.
 * The minted cursor carries the section's `listId`.
 *
 * HANDLER CONTRACT (important): this pager does NOT cross-check a resumed
 * cursor's `token.listId` against `designatedListId` — re-binding them is the
 * HANDLER's duty. On resume the handler MUST decode the cursor, read
 * `token.listId`, and pass THAT as `designatedListId` here. The pager only
 * guards the downstream case: if the named section no longer exists (a vanished
 * / ghost section) it returns `invalid-query`. If a handler ignores
 * `token.listId` and feeds a different section, the pager will silently page the
 * wrong section — so the handler, not the pager, owns that binding.
 *
 * NOTE: the actual conversion of `effective_permissions` / `find_field_anywhere`
 * to a section cursor is B5, NOT this batch — this is the reusable primitive.
 *
 * @param sections - every section, in a STABLE order.
 * @param designatedListId - which section this page advances. On a fresh call
 *   (no cursor) the handler passes the first/most-relevant section; on resume it
 *   passes the section read from the decoded `token.listId` (handler's duty).
 */
export const paginateSection = <T>(
  sections: readonly PageableSection<T>[],
  designatedListId: string,
  opts: PaginateOptions<T>,
): Result<PaginateSectionResult<T>, McpError> => {
  const designated = sections.find((s) => s.listId === designatedListId);
  if (designated === undefined) {
    // A cursor naming a section that no longer exists is a stale/forged query.
    return err(staleCursorError());
  }
  const paged = paginateList(designated.items, opts, designatedListId);
  const otherSections: SectionDisclosure[] = sections
    .filter((s) => s.listId !== designatedListId)
    .map((s) => ({ listId: s.listId, totalCount: s.items.length }));

  return ok({ ...paged, listId: designatedListId, otherSections });
};

/**
 * Detect whether a tool `data` payload already carries a handler-emitted
 * cursor (a `pageInfo` with a `nextCursor`, or a bare `nextCursor`). The
 * `jsonResult` seam uses this to SKIP its own approximate `nextOffset`
 * computation — a cursor-aware handler's pagination wins, and the global budget
 * must not overwrite it with a resume-less offset.
 */
export const hasHandlerCursor = (data: unknown): boolean => {
  if (data === null || typeof data !== 'object') return false;
  const rec = data as Record<string, unknown>;
  if ('nextCursor' in rec) return true;
  const pageInfo = rec['pageInfo'];
  return (
    pageInfo !== null &&
    typeof pageInfo === 'object' &&
    'nextCursor' in (pageInfo as Record<string, unknown>)
  );
};

// ---------------------------------------------------------------------------
// argsFingerprint — bind a cursor to the query's NARROWING args
// ---------------------------------------------------------------------------

const canonicalJson = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
};

/**
 * Fingerprint a query's NARROWING args (everything except the paging knobs
 * `limit` / `offset` / `cursor`) into a short, stable hash stamped onto the
 * cursor as `q`. On resume the handler recomputes it from the current call's
 * args; ANY change to a narrowing arg (a different `nodeId`, `edgeType`,
 * `direction`, filter, etc.) changes the fingerprint and the stale cursor is
 * rejected — so a token can never be replayed against a DIFFERENT result set.
 *
 * `limit` / `offset` / `cursor` are excluded so that asking for a different
 * PAGE of the SAME query is allowed (that is exactly what a cursor is for), and
 * so that the fingerprint a handler computes on resume (which carries the echoed
 * `cursor`) still matches the one minted on the first page (which did not).
 */
export const argsFingerprint = (args: Readonly<Record<string, unknown>>): string => {
  const narrowing: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === 'limit' || k === 'offset' || k === 'cursor') continue;
    if (v === undefined) continue;
    narrowing[k] = v;
  }
  return createHash('sha256').update(canonicalJson(narrowing)).digest('hex').slice(0, 16);
};

// ---------------------------------------------------------------------------
// multi-type scan resume — the B3 scan axis (`s`) for capped node scans
// ---------------------------------------------------------------------------

/**
 * A scan-axis plan for a B3 tool: ONE handler enumerates several node TYPES
 * (e.g. `[ApexClass, ApexTrigger, Flow]`) under a single cursor, each scan
 * capped by `listNodesByType`'s `limit`. The token carries ONE scalar `s`
 * (see {@link PageCursorToken.s}); a multi-type scan must therefore encode
 * BOTH "which type" and "how far into it" into that scalar.
 *
 * The chosen encoding is a FLAT GLOBAL scan offset across the types
 * concatenated in their fixed declaration order:
 *
 *   global s = (Σ counts[0..typeIndex-1]) + withinTypeOffset
 *
 * Decoding `s` back to `(typeIndex, withinTypeOffset)` is deterministic GIVEN
 * the per-type true counts (from `countNodesByType`). Those counts are stable
 * for a fixed vault, and the cursor is bound to the vault hash (`h`), so a
 * resumed `s` decodes to exactly the same position it was minted at — the scan
 * neither dups nor skips at a type boundary. This is the property the
 * design-check required before any multi-type B3 conversion.
 *
 * The scan is COMPLETE when `s >= Σ counts` (the global end). A tool advances
 * the scan one window at a time: read the current type's window via
 * `listNodesByType({ limit, offset: withinTypeOffset })`, derive output rows,
 * and when the OUTPUT page is exhausted but the scan is not, mint a cursor
 * carrying the next global `s` (the position just past the last scanned node).
 */
export interface ScanTypeCount {
  /** The node ComponentType this entry counts (declaration order matters). */
  readonly type: string;
  /** The TRUE total of nodes of this type (from `countNodesByType`). */
  readonly count: number;
}

/** A decoded scan position: which type, and the SQL offset within it. */
export interface ScanPosition {
  /** Index into the fixed type-order array; `>= length` means "scan complete". */
  readonly typeIndex: number;
  /** SQL `OFFSET` within `types[typeIndex]` (0 when at a type boundary). */
  readonly withinTypeOffset: number;
  /** True when `globalOffset >= Σ counts` — every type fully scanned. */
  readonly complete: boolean;
}

/** The grand total of nodes across every scanned type (the scan-axis end). */
export const totalScanCount = (counts: readonly ScanTypeCount[]): number =>
  counts.reduce((sum, c) => sum + c.count, 0);

/**
 * Decode a flat global scan offset into `(typeIndex, withinTypeOffset)` against
 * the per-type counts. Walks the types in order, subtracting each type's count
 * until the offset lands inside a type (or runs past the end → `complete`). A
 * negative or non-integer offset is clamped to 0 (defensive; the codec already
 * range-validates `s`, but this never trusts an out-of-range scalar).
 */
export const decodeScanOffset = (
  globalOffset: number,
  counts: readonly ScanTypeCount[],
): ScanPosition => {
  let remaining =
    Number.isInteger(globalOffset) && globalOffset > 0 ? globalOffset : 0;
  for (let i = 0; i < counts.length; i += 1) {
    const c = counts[i] as ScanTypeCount;
    if (remaining < c.count) {
      return { typeIndex: i, withinTypeOffset: remaining, complete: false };
    }
    remaining -= c.count;
  }
  return { typeIndex: counts.length, withinTypeOffset: 0, complete: true };
};

/**
 * Encode `(typeIndex, withinTypeOffset)` back to a flat global scan offset —
 * the inverse of {@link decodeScanOffset}. Used when a tool advances its scan
 * window and needs the global `s` to stamp on the next cursor. A `typeIndex`
 * at/after the end yields the grand total (a complete-scan sentinel).
 */
export const encodeScanOffset = (
  typeIndex: number,
  withinTypeOffset: number,
  counts: readonly ScanTypeCount[],
): number => {
  if (typeIndex >= counts.length) return totalScanCount(counts);
  let base = 0;
  for (let i = 0; i < typeIndex; i += 1) base += (counts[i] as ScanTypeCount).count;
  return base + Math.max(0, withinTypeOffset);
};

// ---------------------------------------------------------------------------
// paginateLegacy — back-compat adapter for the B1 offset tools
// ---------------------------------------------------------------------------

/**
 * Back-compat fields the B1 tools already emit on their `data` payload BEFORE
 * CR-22 — kept byte-identical so the golden-diff does not move.
 */
export interface LegacyPageFields<T> {
  /** The page of items (already byte-trimmed / forward-progress-slimmed). */
  readonly items: readonly T[];
  /** Total items matching the filters BEFORE paging. */
  readonly totalCount: number;
  /** True when more items remain past this page. */
  readonly hasMore: boolean;
  /** Approximate next offset (legacy), or `null` when exhausted. */
  readonly nextOffset: number | null;
}

/** What {@link paginateLegacy} returns: legacy fields + a cursor ONLY on truncation. */
export interface PaginateLegacyResult<T> extends LegacyPageFields<T> {
  /**
   * Opaque continuation token — present (non-null) ONLY when this page was
   * truncated (over `limit` OR over the byte budget). A whole-fits page omits
   * it entirely (the handler must spread it conditionally so an in-budget
   * response is byte-identical to pre-CR-22).
   */
  readonly nextCursor: string | null;
  /** The structured {@link PageInfo} (used by the seam detector via `pageInfo`). */
  readonly pageInfo: PageInfo;
  /** True when the page was byte-trimmed below `limit`. */
  readonly byteTrimmed: boolean;
  /** Forward-progress residual flag — see {@link PaginateResult.oversizedRowUnslimmable}. */
  readonly oversizedRowUnslimmable: boolean;
}

/**
 * Adapter that runs {@link paginate} but returns the LEGACY field shape the B1
 * offset tools already emit (`items` / `totalCount` / `hasMore` / `nextOffset`),
 * plus a `nextCursor` + `pageInfo` that are populated ONLY on a truncated page.
 *
 * A handler converts by: (1) computing `nextOffset` exactly as before for the
 * back-compat field; (2) spreading `nextCursor` / `pageInfo` ONLY when truncated
 * (the helper returns `nextCursor: null` on a whole-fits page, and the caller
 * spreads conditionally) so an in-budget response stays byte-for-byte identical.
 *
 * The list MUST be pre-sorted to a TOTAL order (unique final tiebreak).
 */
export const paginateLegacy = <T>(
  items: readonly T[],
  opts: PaginateOptions<T>,
): PaginateLegacyResult<T> => {
  const offset = opts.offset ?? 0;
  const page = paginate(items, opts);
  const returnedEnd = offset + page.pageInfo.returnedCount;
  return {
    items: page.items,
    totalCount: page.pageInfo.totalCount,
    hasMore: page.pageInfo.hasMore,
    nextOffset: page.pageInfo.hasMore ? returnedEnd : null,
    nextCursor: page.pageInfo.nextCursor,
    pageInfo: page.pageInfo,
    byteTrimmed: page.byteTrimmed,
    oversizedRowUnslimmable: page.oversizedRowUnslimmable,
  };
};
