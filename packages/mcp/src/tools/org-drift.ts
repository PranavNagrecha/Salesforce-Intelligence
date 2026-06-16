/**
 * Org-drift badge (P13-WATCH-badges) — when a RECENT stale-sweep
 * (`meta/staleness.json`, written by `sfi stale-sweep` / the `sfi watch`
 * daemon) shows the org has moved since the vault was built, tool responses
 * carry a top-level `orgDrift` badge — but ONLY when the drift could touch
 * the answer:
 *
 *   - FRESH sweep required: `generatedAt` within 2× the watcher interval
 *     (pidfile interval when a watcher runs, the 15m default otherwise).
 *     A stale or absent sweep is SILENT — yesterday's drift count presented
 *     as current would be exactly the staleness lie this product exists to
 *     prevent. Absent file = byte-identical to pre-badge behavior.
 *   - TYPE-INTERSECTED: the badge fires only when a drifted type also
 *     appears in the response payload (a PermissionSet drift does not nag a
 *     pure Apex answer), and reports only the intersecting types.
 *   - The badge NEVER mutates trust/provenance — it is a sibling annotation
 *     (`source: 'staleness-sweep'`), and an offline answer stays
 *     `offline_snapshot` (a4 invariant: drift never bleeds into live).
 *
 * Reads are cached per (path, mtime) — one stat per call, one parse per
 * sweep write.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The persisted sweep snapshot (see cli stale-sweep). */
interface StalenessSnapshot {
  readonly generatedAt: string;
  readonly vaultRefreshedAt: string;
  readonly method: string;
  readonly vaultStale: boolean;
  readonly driftCount: number;
  readonly byType: Readonly<Record<string, number>>;
}

interface WatchPid {
  readonly intervalMs?: number;
}

/** The badge attached to affected responses. */
export interface OrgDriftBadge {
  readonly source: 'staleness-sweep';
  readonly sweptAt: string;
  readonly vaultRefreshedAt: string;
  /** Drifted types that intersect this answer's payload. */
  readonly driftedTypes: Readonly<Record<string, number>>;
  readonly note: string;
}

const DEFAULT_INTERVAL_MS = 15 * 60_000;
const FRESH_MULTIPLIER = 2;

let cache: { path: string; mtimeMs: number; snapshot: StalenessSnapshot | null } | null = null;

const readSnapshot = (vaultRoot: string): StalenessSnapshot | null => {
  const path = join(vaultRoot, 'meta', 'staleness.json');
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  if (cache !== null && cache.path === path && cache.mtimeMs === mtimeMs) {
    return cache.snapshot;
  }
  try {
    const snapshot = JSON.parse(readFileSync(path, 'utf8')) as StalenessSnapshot;
    cache = { path, mtimeMs, snapshot };
    return snapshot;
  } catch {
    cache = { path, mtimeMs, snapshot: null };
    return null;
  }
};

const watchIntervalMs = (vaultRoot: string): number => {
  try {
    const pid = JSON.parse(
      readFileSync(join(vaultRoot, 'meta', 'watch.pid'), 'utf8'),
    ) as WatchPid;
    return typeof pid.intervalMs === 'number' && pid.intervalMs > 0
      ? pid.intervalMs
      : DEFAULT_INTERVAL_MS;
  } catch {
    return DEFAULT_INTERVAL_MS;
  }
};

/** Test hook: drop the per-process cache. */
export const resetOrgDriftCache = (): void => {
  cache = null;
};

/**
 * Build the badge for a serialized response, or `null` when silent (no/stale
 * sweep, no drift, or no type intersection). `nowIso` is injectable.
 */
export const orgDriftBadgeFor = (
  vaultRoot: string,
  serializedData: string,
  nowIso?: string,
): OrgDriftBadge | null => {
  const snapshot = readSnapshot(vaultRoot);
  if (snapshot === null || snapshot.vaultStale !== true || snapshot.driftCount <= 0) {
    return null;
  }
  const now = Date.parse(nowIso ?? new Date().toISOString());
  const swept = Date.parse(snapshot.generatedAt);
  if (Number.isNaN(now) || Number.isNaN(swept)) return null;
  const freshWindow = FRESH_MULTIPLIER * watchIntervalMs(vaultRoot);
  if (now - swept > freshWindow) return null; // stale sweep → SILENT

  const drifted: Record<string, number> = {};
  for (const [type, count] of Object.entries(snapshot.byType)) {
    if (count > 0 && serializedData.includes(`"${type}:`)) {
      drifted[type] = count;
    }
  }
  if (Object.keys(drifted).length === 0) return null; // no intersection → silent

  return {
    source: 'staleness-sweep',
    sweptAt: snapshot.generatedAt,
    vaultRefreshedAt: snapshot.vaultRefreshedAt,
    driftedTypes: drifted,
    note: `The org has changed since this vault was built: ${Object.entries(drifted)
      .map(([t, n]) => `${n} ${t}`)
      .join(', ')} component(s) modified after the refresh (sweep ${snapshot.generatedAt}). This answer reads the SNAPSHOT — run /sfi-refresh if those types matter here.`,
  };
};
