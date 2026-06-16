/**
 * Shared read side of the continuous-learning store (`meta/history.jsonl`).
 *
 * Every `sfi refresh` appends a record (timestamp, source hash, per-type
 * component/edge deltas). This module parses that timeline and derives a
 * summary, so MULTIPLE tools can fold "what changed recently" into their
 * answers — not just the dedicated `sfi.org_history` tool. `org_overview`, for
 * one, uses it to make the org's front-page answer history-aware.
 *
 * Honesty axis: history only covers refreshes since the store shipped; a vault
 * refreshed once (or before it existed) yields a short/empty timeline. Each
 * entry's deltas are relative to the immediately prior refresh, as recorded
 * then — not recomputed.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { vaultPaths } from '@sf-intelligence/vault';

export interface OrgHistoryEntry {
  readonly refreshedAt: string;
  readonly sourceTreeHash: string;
  readonly sourceTreeHashChanged: boolean;
  readonly componentDeltas: Readonly<Record<string, number>>;
  readonly edgeDeltas: Readonly<Record<string, number>>;
  readonly totalComponents: number;
}

export interface RefreshHistory {
  /** Chronological (oldest-first) timeline as written. */
  readonly chronological: readonly OrgHistoryEntry[];
  readonly refreshCount: number;
  readonly firstRefreshedAt: string | null;
  readonly lastRefreshedAt: string | null;
  /** totalComponents(last) − totalComponents(first); null when <1 entry. */
  readonly netComponentChange: number | null;
}

/** Parse the JSONL log into entries, skipping malformed lines defensively. */
export const parseHistory = (raw: string): OrgHistoryEntry[] => {
  const out: OrgHistoryEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const o = JSON.parse(trimmed) as Partial<OrgHistoryEntry>;
      if (typeof o.refreshedAt !== 'string' || typeof o.sourceTreeHash !== 'string') {
        continue;
      }
      out.push({
        refreshedAt: o.refreshedAt,
        sourceTreeHash: o.sourceTreeHash,
        sourceTreeHashChanged: o.sourceTreeHashChanged === true,
        componentDeltas: o.componentDeltas ?? {},
        edgeDeltas: o.edgeDeltas ?? {},
        totalComponents: typeof o.totalComponents === 'number' ? o.totalComponents : 0,
      });
    } catch {
      // Skip a corrupt line rather than failing the whole read.
    }
  }
  return out;
};

/**
 * Load + summarize the refresh history for a vault. A missing log is NOT an
 * error (a vault refreshed before the store shipped, or never since): it yields
 * an empty timeline. Any other read failure throws.
 */
export const loadRefreshHistory = async (
  vaultRoot: string,
): Promise<RefreshHistory> => {
  const historyPath = join(vaultPaths(vaultRoot).meta, 'history.jsonl');
  let raw: string;
  try {
    raw = await readFile(historyPath, 'utf8');
  } catch (cause) {
    if ((cause as { code?: string }).code === 'ENOENT') {
      return {
        chronological: [],
        refreshCount: 0,
        firstRefreshedAt: null,
        lastRefreshedAt: null,
        netComponentChange: null,
      };
    }
    throw cause;
  }

  const chronological = parseHistory(raw);
  const first = chronological[0];
  const last = chronological[chronological.length - 1];
  return {
    chronological,
    refreshCount: chronological.length,
    firstRefreshedAt: first?.refreshedAt ?? null,
    lastRefreshedAt: last?.refreshedAt ?? null,
    netComponentChange:
      first !== undefined && last !== undefined
        ? last.totalComponents - first.totalComponents
        : null,
  };
};

/** A compact "what changed recently" block other tools embed in their answers. */
export interface RecentActivity {
  /** False when there is no history yet (single/pre-store-ship vault). */
  readonly available: boolean;
  readonly refreshCount: number;
  readonly lastRefreshedAt: string | null;
  /** Net component change across the whole recorded timeline. */
  readonly netComponentChange: number | null;
  readonly trend: 'growing' | 'shrinking' | 'stable' | 'unknown';
  /** Non-zero component-type deltas from the MOST RECENT refresh. */
  readonly lastRefreshComponentDeltas: Readonly<Record<string, number>>;
  /** Non-zero edge-type deltas from the MOST RECENT refresh. */
  readonly lastRefreshEdgeDeltas: Readonly<Record<string, number>>;
  readonly note: string;
}

/** Drop zero-valued deltas so the recent-activity block stays compact. */
const nonZero = (
  deltas: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> => {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(deltas)) if (v !== 0) out[k] = v;
  return out;
};

/** Summarize history into the embeddable recent-activity block. */
export const summarizeRecentActivity = (
  history: RefreshHistory,
): RecentActivity => {
  if (history.refreshCount === 0) {
    return {
      available: false,
      refreshCount: 0,
      lastRefreshedAt: null,
      netComponentChange: null,
      trend: 'unknown',
      lastRefreshComponentDeltas: {},
      lastRefreshEdgeDeltas: {},
      note: 'No refresh history yet — run `sfi refresh` to start the timeline. (History covers only refreshes since the continuous-learning store shipped.)',
    };
  }
  const last = history.chronological[history.chronological.length - 1]!;
  const net = history.netComponentChange;
  const trend: RecentActivity['trend'] =
    history.refreshCount < 2 || net === null
      ? 'unknown'
      : net > 0
        ? 'growing'
        : net < 0
          ? 'shrinking'
          : 'stable';
  return {
    available: true,
    refreshCount: history.refreshCount,
    lastRefreshedAt: history.lastRefreshedAt,
    netComponentChange: net,
    trend,
    lastRefreshComponentDeltas: nonZero(last.componentDeltas),
    lastRefreshEdgeDeltas: nonZero(last.edgeDeltas),
    note: 'Deltas are relative to the immediately prior refresh, recorded at that time. History covers only refreshes since the continuous-learning store shipped.',
  };
};
