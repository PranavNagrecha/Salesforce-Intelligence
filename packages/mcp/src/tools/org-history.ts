/**
 * Handler for the `sfi.org_history` MCP tool.
 *
 * The continuous-learning store's read side. Every `sfi refresh` appends a
 * record to `meta/history.jsonl` (timestamp, source hash, per-type
 * component/edge deltas). This tool reads that timeline so answers can reason
 * over "what was true before + what changed" rather than only the latest
 * snapshot — the foundation for history/diff-aware intelligence.
 *
 * **Honesty axis**: history only covers refreshes performed since this feature
 * shipped; a vault refreshed only once (or before it existed) yields a short or
 * empty timeline. Each entry's deltas are relative to the immediately prior
 * refresh, as recorded at that time — not recomputed.
 */

import type { McpError, McpResponse, PageInfo } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { z } from 'zod';

import {
  loadRefreshHistory,
  type OrgHistoryEntry,
} from '../history-store.js';
import type { Context } from '../server.js';

import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/** Tool name — used to bind/verify a CR-22 continuation cursor to this query. */
const TOOL_NAME = 'sfi.org_history';

export const orgHistoryInputSchema = z.object({
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
  /** CR-22 continuation cursor from a prior truncated response. Overrides `offset` when present. */
  cursor: z.string().optional(),
});

export type OrgHistoryInput = z.infer<typeof orgHistoryInputSchema>;

export type { OrgHistoryEntry } from '../history-store.js';

export interface OrgHistoryOutput {
  readonly refreshCount: number;
  readonly firstRefreshedAt: string | null;
  readonly lastRefreshedAt: string | null;
  /** totalComponents(last) − totalComponents(first); null when <1 entry. */
  readonly netComponentChange: number | null;
  /** Timeline, most recent first, capped at `limit`. */
  readonly entries: readonly OrgHistoryEntry[];
  readonly limit: number;
  readonly offset: number;
  /** True when strictly more history exists past `entries` — the typed truncation flag. */
  readonly truncated: boolean;
  /** Present only when `truncated`: the offset to resume from. */
  readonly nextOffset?: number;
  /** Present only when `truncated`: opaque continuation cursor for the next page. */
  readonly nextCursor?: string;
  readonly pageInfo?: PageInfo;
  readonly boundaries: readonly string[];
}

const BOUNDARIES: readonly string[] = Object.freeze([
  'History only covers refreshes performed since the continuous-learning store shipped; older or single-refresh vaults yield a short/empty timeline.',
  'Each entry\'s deltas are relative to the immediately prior refresh, recorded at that time (not recomputed). Run `sfi refresh` to add to the timeline.',
]);

/**
 * The `sfi.org_history` MCP tool. Returns the refresh timeline (most recent
 * first) + a net-change summary. See the module JSDoc for the honesty axis.
 *
 * @example
 *   const r = await orgHistoryHandler(ctx, {});
 *   if (r.ok) console.log(r.value.data.refreshCount, r.value.data.netComponentChange);
 */
export const orgHistoryHandler = async (
  ctx: Context,
  input: OrgHistoryInput,
): Promise<Result<McpResponse<OrgHistoryOutput>, McpError>> => {
  const limit = input.limit ?? DEFAULT_LIMIT;

  let history;
  try {
    history = await loadRefreshHistory(ctx.vaultRoot);
  } catch (cause) {
    return err({ kind: 'internal', message: `failed to read history: ${String(cause)}` });
  }

  // org_history takes no narrowing args beyond the paging knobs, so the
  // fingerprint is constant — it still binds a cursor to this tool + vault.
  const fingerprint = argsFingerprint({});

  // CR-22: resolve the resume offset (echoed cursor wins over explicit offset).
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: TOOL_NAME,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  // Most-recent-first ordering, then a typed CR-22 page over it.
  const mostRecentFirst = [...history.chronological].reverse();
  const paged = paginateLegacy(mostRecentFirst, {
    offset,
    limit,
    binding: {
      tool: TOOL_NAME,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const truncated = paged.hasMore;
  const emitCursor = paged.nextCursor !== null;

  return ok({
    data: {
      refreshCount: history.refreshCount,
      firstRefreshedAt: history.firstRefreshedAt,
      lastRefreshedAt: history.lastRefreshedAt,
      netComponentChange: history.netComponentChange,
      entries: paged.items,
      limit,
      offset,
      truncated,
      ...(truncated ? { nextOffset: offset + paged.items.length } : {}),
      ...(emitCursor ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo } : {}),
      boundaries: BOUNDARIES,
    },
    vaultState: { sourceTreeHash: ctx.manifest.sourceTreeHash, refreshedAt: ctx.manifest.refreshedAt },
  });
};
