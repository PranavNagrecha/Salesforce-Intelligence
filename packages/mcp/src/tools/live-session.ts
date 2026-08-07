/**
 * P6-live-result-cache + P6-live-budget-guard — the session-scoped guard every
 * HYBRID live query flows through.
 *
 * A hybrid conversation (blast-radius, required-field-whatif) issues MANY live
 * queries — one COUNT per impacted dependency. Two safeties make that safe to
 * lean on:
 *
 *   1. **Result cache (P6-live-result-cache).** A short-TTL, in-process cache
 *      keyed on `(org, args)`. A repeated identical live query inside one
 *      session is served from cache and issues exactly ONE org query. Fail-open:
 *      a miss just queries live. A cache hit is STAMPED (`cached: true`) and
 *      carries the ORIGINAL read time, so a cached value is never passed off as
 *      a fresh read. The cache holds only counts/aggregates the tools already
 *      return — never raw record rows — and lives in memory only (never on disk).
 *
 *   2. **Budget guard (P6-live-budget-guard).** A per-session counter, default
 *      50 (env `SFI_LIVE_QUERY_BUDGET`), decremented per ORG query (a cache hit
 *      costs nothing). At zero the plane fails CLOSED with an actionable message.
 *      The cap is deliberately a tiny fraction of any org's daily API allotment
 *      (typically 15k–5M) so the live plane can never exhaust org limits; the
 *      `sfi.live_budget` tool cross-checks the real headroom via
 *      `live_org_limits`. A FAILED call is NOT cached, so its budget unit is
 *      REFUNDED (CR-P3) — a flapping alias cannot drain the session one retry at
 *      a time.
 *
 *   3. **In-flight de-dup (CR-P3 stampede).** Concurrent identical queries that
 *      all miss the cache SHARE one outstanding org call (and ONE budget unit)
 *      via a pending-promise map keyed like the cache, honoring the "exactly one
 *      org query" contract for repeated/concurrent identical reads.
 *
 * Session = the MCP server process lifetime. State is module-level and reset by
 * {@link resetLiveSession} (used by tests and a server restart).
 *
 * This module imports the low-level `runSfJson` / `restGet` from the
 * dependency-free leaf `live-exec.ts` (NOT `live-plane.ts`). CR-09: with the raw
 * primitives in the leaf, `live-plane.ts` itself now imports the budgeted seam
 * here ({@link runLiveQuery} / {@link runLiveRest}) and routes EVERY live read
 * through it — so the per-session budget is the single chokepoint for the whole
 * live plane, not just the hybrid tools. The dependency graph is acyclic:
 * live-exec.ts (leaf) <- live-session.ts <- live-plane.ts.
 */

import type { McpError, McpResponse } from '@sf-intelligence/contracts';
import { err, ok, withNetworkMode, type Result } from '@sf-intelligence/core';
import type { ExecCommand } from '@sf-intelligence/tooling-api';
import { z } from 'zod';

import type { Context } from '../server.js';

// CR-09: `runSfJson` / `restGet` now come from the dependency-free leaf
// (live-exec.ts), NOT live-plane.ts. That severs the live-session -> live-plane
// import edge for the raw primitives, so live-plane.ts can safely import the
// budgeted seam below FROM here without a cycle. `resolveLiveAccess` (the
// consent gate) still lives in live-plane.ts and is imported lazily inside the
// one budget-check handler to avoid re-introducing the static cycle.
import { apiPath, getLiveAuth, restGet, runSfJson } from './live-exec.js';

/** Default per-session live-query budget when `SFI_LIVE_QUERY_BUDGET` is unset. */
export const DEFAULT_LIVE_QUERY_BUDGET = 50;
/** Default cache TTL when `SFI_LIVE_CACHE_TTL_MS` is unset (90s — short enough for decision-support). */
export const DEFAULT_LIVE_CACHE_TTL_MS = 90_000;

/** Parse a non-negative integer env var, falling back to `fallback` on absent/invalid. */
const intEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

const budgetLimit = (): number => intEnv('SFI_LIVE_QUERY_BUDGET', DEFAULT_LIVE_QUERY_BUDGET);
const cacheTtlMs = (): number => intEnv('SFI_LIVE_CACHE_TTL_MS', DEFAULT_LIVE_CACHE_TTL_MS);

interface CacheEntry {
  readonly value: unknown;
  readonly queriedAt: string;
  readonly expiresAt: number;
}

// --- session state (process-lifetime) --------------------------------------
const cache = new Map<string, CacheEntry>();
let budgetUsed = 0;

/**
 * In-flight de-dup map (CR-P3 stampede). While one org call for a given key is
 * outstanding, concurrent identical queries SHARE its promise instead of each
 * spending budget + hitting the org. Keyed by the same `cacheKey` the result
 * cache uses, so a SOQL vector and a `['REST', suffix]` read never collide. An
 * entry is removed as soon as its call settles (success or failure).
 */
const pending = new Map<string, Promise<unknown>>();

/** Reset the cache + budget. Called by tests and intended for a server restart. */
export const resetLiveSession = (): void => {
  cache.clear();
  pending.clear();
  budgetUsed = 0;
};

/** A stable cache key for an org + sf-CLI arg vector. `\0` never appears in args. */
const cacheKey = (org: string, args: readonly string[]): string =>
  `${org}${JSON.stringify(args)}`;

export interface LiveBudgetStatus {
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
}

/** Current per-session budget snapshot. */
export const liveBudgetStatus = (): LiveBudgetStatus => {
  const limit = budgetLimit();
  return { limit, used: budgetUsed, remaining: Math.max(0, limit - budgetUsed) };
};

export interface LiveCacheStatus {
  readonly entries: number;
  readonly ttlMs: number;
}

/** Current cache snapshot (sizes only — never the cached values). */
export const liveCacheStatus = (): LiveCacheStatus => ({
  entries: cache.size,
  ttlMs: cacheTtlMs(),
});

/** The actionable fail-closed error when the per-session budget is spent. */
const budgetExceededError = (limit: number): McpError => ({
  kind: 'invalid-query',
  message:
    `Live-query budget exhausted: this session has already issued ${limit} live org ` +
    `queries (the per-session cap that keeps the live plane from exhausting your org's ` +
    `API limits). Raise it with SFI_LIVE_QUERY_BUDGET, narrow the question so it needs ` +
    `fewer live counts, or start a new session to reset. Repeated identical queries are ` +
    `served from cache and do NOT count against the budget.`,
});

export interface LiveQueryOk {
  /** Parsed JSON from the `sf` CLI. */
  readonly value: unknown;
  /** True when served from the session cache (no org hit, no budget spent). */
  readonly cached: boolean;
  /** When the underlying org query actually ran (a cache hit keeps the original read time). */
  readonly queriedAt: string;
  /** Per-session budget remaining AFTER this call. */
  readonly remainingBudget: number;
}

/**
 * Run a live `sf` query through the session cache + budget guard. Used by the
 * Phase 6 hybrid tools so a multi-query answer is cheap and bounded.
 *
 *   - Cache HIT (within TTL): returns the cached value, `cached: true`, the
 *     original `queriedAt`, and spends NO budget.
 *   - In-flight HIT (CR-P3): an identical query already running shares that one
 *     org call + budget unit instead of issuing its own.
 *   - Cache MISS: enforces the budget (fail-closed at zero), spends one unit,
 *     queries live, caches a successful result, returns `cached: false`. A
 *     FAILED call refunds the unit (CR-P3) and is not cached.
 *
 * Fail-open on the cache (a miss just queries); fail-closed on the budget.
 */
export const runLiveQuery = async (
  org: string,
  args: readonly string[],
  exec?: ExecCommand,
): Promise<Result<LiveQueryOk, McpError>> => {
  const key = cacheKey(org, args);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit !== undefined && hit.expiresAt > now) {
    return ok({
      value: hit.value,
      cached: true,
      queriedAt: hit.queriedAt,
      remainingBudget: liveBudgetStatus().remaining,
    });
  }

  // CR-P3 stampede: if an identical query is already in flight, SHARE its call
  // rather than spending another budget unit and hitting the org again. The
  // followers ride the single fresh org read (the leader resolves the promise).
  const inFlight = pending.get(key) as
    | Promise<Result<LiveQueryOk, McpError>>
    | undefined;
  if (inFlight !== undefined) return inFlight;

  const limit = budgetLimit();
  if (budgetUsed >= limit) return err(budgetExceededError(limit));
  budgetUsed += 1;

  const work = (async (): Promise<Result<LiveQueryOk, McpError>> => {
    // AUDIT-F2: an authorized live call temporarily elevates to salesforce-read
    // (MCP default networkMode is `off`). Consent/capability already gated above.
    return withNetworkMode('salesforce-read', async () => {
      const queriedAt = new Date().toISOString();
      const parsed = exec === undefined
        ? await runSfJson(org, args)
        : await runSfJson(org, args, exec);
      if (!parsed.ok) {
        // CR-P3 refund: a FAILED call is not cached, so refund the budget unit —
        // a flapping alias must not drain the whole per-session budget.
        budgetUsed -= 1;
        return parsed;
      }

      const ttl = cacheTtlMs();
      if (ttl > 0) {
        cache.set(key, { value: parsed.value, queriedAt, expiresAt: now + ttl });
      }
      return ok({
        value: parsed.value,
        cached: false,
        queriedAt,
        remainingBudget: liveBudgetStatus().remaining,
      });
    });
  })();

  pending.set(key, work);
  try {
    return await work;
  } finally {
    pending.delete(key);
  }
};

export interface LiveRestOk {
  /** Parsed JSON body from the Salesforce REST endpoint. */
  readonly value: unknown;
  /** True when served from the session cache (no org hit, no budget spent). */
  readonly cached: boolean;
  /** When the underlying org read actually ran (a cache hit keeps the original time). */
  readonly queriedAt: string;
  /** Per-session budget remaining AFTER this call. */
  readonly remainingBudget: number;
}

/**
 * Run a live read-only REST GET (e.g. `/limits`, `/limits/recordCount`) through
 * the SAME per-session cache + budget guard as {@link runLiveQuery}, so a live
 * REST read counts against the budget exactly like a SOQL query does. Resolves
 * the org auth, builds the versioned data-API path, and GETs it.
 *
 * The cache key is shaped `['REST', suffix]` (distinct from a SOQL args vector
 * `['data','query',...]`), so a REST path can never collide with a SOQL key.
 *
 *   - Cache HIT (within TTL): cached body, `cached: true`, original `queriedAt`,
 *     spends NO budget.
 *   - In-flight HIT (CR-P3): an identical REST read already running shares that
 *     one org call + budget unit.
 *   - Cache MISS: enforces the budget (fail-closed at zero) BEFORE the read,
 *     spends one unit, resolves auth + GETs, caches a successful body.
 *
 * Fail-open on the cache; fail-closed on the budget. An auth/REST failure is
 * returned as the McpError, is NOT cached, and REFUNDS its budget unit (CR-P3),
 * so a transient failure does not poison or drain the session.
 */
export const runLiveRest = async (
  org: string,
  suffix: string,
  exec?: ExecCommand,
): Promise<Result<LiveRestOk, McpError>> => {
  const key = cacheKey(org, ['REST', suffix]);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit !== undefined && hit.expiresAt > now) {
    return ok({
      value: hit.value,
      cached: true,
      queriedAt: hit.queriedAt,
      remainingBudget: liveBudgetStatus().remaining,
    });
  }

  // CR-P3 stampede: share an identical in-flight REST read (one budget unit,
  // one org hit) across concurrent callers.
  const inFlight = pending.get(key) as
    | Promise<Result<LiveRestOk, McpError>>
    | undefined;
  if (inFlight !== undefined) return inFlight;

  const limit = budgetLimit();
  if (budgetUsed >= limit) return err(budgetExceededError(limit));
  budgetUsed += 1;

  const work = (async (): Promise<Result<LiveRestOk, McpError>> => {
    // AUDIT-F2: authorized live REST elevates to salesforce-read for the call.
    return withNetworkMode('salesforce-read', async () => {
      const queriedAt = new Date().toISOString();
      const authResult = exec === undefined
        ? await getLiveAuth(org)
        : await getLiveAuth(org, exec);
      if (!authResult.ok) {
        // CR-P3 refund: auth failure is not cached — refund the budget unit.
        budgetUsed -= 1;
        return authResult;
      }
      const body = await restGet(authResult.value, apiPath(authResult.value, suffix));
      if (!body.ok) {
        // CR-P3 refund: a failed REST read is not cached — refund the budget unit.
        budgetUsed -= 1;
        return body;
      }

      const ttl = cacheTtlMs();
      if (ttl > 0) {
        cache.set(key, { value: body.value, queriedAt, expiresAt: now + ttl });
      }
      return ok({
        value: body.value,
        cached: false,
        queriedAt,
        remainingBudget: liveBudgetStatus().remaining,
      });
    });
  })();

  pending.set(key, work);
  try {
    return await work;
  } finally {
    pending.delete(key);
  }
};

/**
 * Convenience: run a SOQL query through the guard and return the parsed
 * `result.totalSize` (or `records[0].expr0` for an aggregate COUNT()), with the
 * cache/budget metadata. The single primitive every blast-radius / population
 * count is built on.
 */
export const liveCount = async (
  org: string,
  soql: string,
  exec?: ExecCommand,
): Promise<Result<{ count: number } & LiveQueryOk, McpError>> => {
  const r = await runLiveQuery(org, ['data', 'query', '--query', soql], exec);
  if (!r.ok) return r;
  const payload = r.value.value as {
    result?: { totalSize?: number; records?: readonly { expr0?: number }[] };
  };
  const count = payload.result?.totalSize ?? payload.result?.records?.[0]?.expr0 ?? 0;
  return ok({ count, ...r.value });
};

// ---------------------------------------------------------------------------
// sfi.live_budget  (P6-live-budget-guard — disclosure surface)
// ---------------------------------------------------------------------------

export const liveBudgetInputSchema = z.object({
  liveEnabled: z.boolean().optional(),
  orgAlias: z.string().min(1).optional(),
});

export type LiveBudgetInput = z.infer<typeof liveBudgetInputSchema>;

/** Org API headroom, when the live plane is enabled and `live_org_limits` answers. */
export interface OrgApiHeadroom {
  readonly dailyApiRequestsRemaining: number;
  readonly dailyApiRequestsMax: number;
  /** The session budget as a fraction of the org's REMAINING daily API requests. */
  readonly sessionBudgetFractionOfRemaining: number;
}

export interface LiveBudgetOutput {
  readonly budget: LiveBudgetStatus;
  readonly cache: LiveCacheStatus;
  /** `null` unless live is enabled AND `live_org_limits` answered (best-effort, non-fatal). */
  readonly orgApiHeadroom: OrgApiHeadroom | null;
  readonly interpretation: string;
  readonly boundaries: readonly string[];
}

const LIVE_BUDGET_BOUNDARIES: readonly string[] = Object.freeze([
  'The budget and cache figures are SESSION-LOCAL runtime state (this MCP server process), not org data — reported without a live call. They reset when the server restarts.',
  'orgApiHeadroom is a LIVE read via live_org_limits; it is null unless the live plane is enabled (SFI_LIVE_PLANE_ENABLED, liveEnabled:true, or consent) and the org answered. A cache hit costs no budget and no org API call.',
]);

/**
 * `sfi.live_budget` — disclose the per-session live-query budget + cache state
 * (P6-live-budget-guard), and, when the live plane is enabled, cross-check
 * against the org's real `DailyApiRequests` headroom so the cap is visibly a
 * tiny fraction of what the org can serve. Budget/cache are reported
 * unconditionally (session-local); only the org headroom needs consent.
 */
export const liveBudgetHandler = async (
  ctx: Context,
  input: LiveBudgetInput,
  exec?: ExecCommand,
): Promise<Result<McpResponse<LiveBudgetOutput>, McpError>> => {
  const budget = liveBudgetStatus();
  const cache = liveCacheStatus();
  const org = input.orgAlias?.trim() || ctx.manifest.sourceOrg;

  let orgApiHeadroom: OrgApiHeadroom | null = null;
  // CR-09: `resolveLiveAccess` lives in live-plane.ts, which now imports the
  // budgeted seam from THIS module — a static import back would re-form the
  // cycle. Pull it lazily here (the only consumer of it in live-session) so the
  // static dependency graph stays acyclic.
  const { resolveLiveAccess } = await import('./live-plane.js');
  const access = await resolveLiveAccess(org, input.liveEnabled, ctx.liveCapability);
  if (access.allowed) {
    // `sf org limits list` goes through the CLI (runSfJson), not the REST/fetch
    // path, so it is mockable and does NOT decrement the live-query budget — a
    // budget check must never consume budget. Elevate network mode the same way
    // runLiveQuery does (AUDIT-F2); raw runSfJson is fail-closed under mode=off.
    orgApiHeadroom = await withNetworkMode(
      'salesforce-read',
      async (): Promise<OrgApiHeadroom | null> => {
        const limits =
          exec === undefined
            ? await runSfJson(org, ['org', 'limits', 'list'])
            : await runSfJson(org, ['org', 'limits', 'list'], exec);
        if (!limits.ok) return null;
        const rows = (limits.value as {
          result?: unknown;
        }).result;
        // `sf org limits list --json` returns an array; mocked execs in budget
        // tests often return a SOQL-shaped `{ totalSize }` — ignore non-arrays.
        if (!Array.isArray(rows)) return null;
        const daily = (
          rows as readonly { name?: string; max?: number; remaining?: number }[]
        ).find((row) => row.name === 'DailyApiRequests');
        if (daily?.remaining === undefined || daily.max === undefined) return null;
        return {
          dailyApiRequestsRemaining: daily.remaining,
          dailyApiRequestsMax: daily.max,
          sessionBudgetFractionOfRemaining:
            daily.remaining > 0
              ? Math.round((budget.limit / daily.remaining) * 10_000) / 10_000
              : 1,
        };
      },
    );
  }

  const interpretation =
    budget.remaining === 0
      ? `Live-query budget SPENT (${budget.used}/${budget.limit}). Further live queries fail closed until the session resets or SFI_LIVE_QUERY_BUDGET is raised. Cached repeats still answer.`
      : `${budget.remaining} of ${budget.limit} live queries remaining this session; ${cache.entries} result(s) cached (TTL ${Math.round(cache.ttlMs / 1000)}s).` +
        (orgApiHeadroom !== null
          ? ` The org has ${orgApiHeadroom.dailyApiRequestsRemaining} of ${orgApiHeadroom.dailyApiRequestsMax} daily API requests left — the session cap is a small fraction of that.`
          : '');

  return ok({
    data: { budget, cache, orgApiHeadroom, interpretation, boundaries: LIVE_BUDGET_BOUNDARIES },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
