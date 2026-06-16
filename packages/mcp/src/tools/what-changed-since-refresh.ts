/**
 * Handler for the `sfi.what_changed_since_refresh` MCP tool (P5-what-changed).
 *
 * Answers "since my last refresh, which component TYPES changed?" from the
 * continuous-learning history store (`meta/history.jsonl`). Every `sfi refresh`
 * appends a record with per-type component/edge deltas vs the prior snapshot;
 * this tool surfaces the MOST RECENT refresh's non-zero deltas as a focused
 * changed-types list.
 *
 * **Honesty axis (load-bearing):** these are the changes the LAST REFRESH
 * brought into the vault (vs the previous snapshot) — NOT what changed in the
 * live org SINCE that refresh. An offline vault cannot know the latter; the
 * boundary points the caller at `sfi.live_stale_check` (live Tooling API) for
 * true org-side drift. A vault with no recorded history (refreshed once, or
 * before the store shipped) returns `available: false`.
 */

import type { McpError, McpResponse } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { z } from 'zod';

import { loadRefreshHistory, summarizeRecentActivity } from '../history-store.js';
import type { Context } from '../server.js';

/** No-argument tool; the schema exists so `runTool` rejects extraneous fields. */
export const whatChangedSinceRefreshInputSchema = z.object({});
export type WhatChangedSinceRefreshInput = z.infer<
  typeof whatChangedSinceRefreshInputSchema
>;

export interface WhatChangedSinceRefreshOutput {
  /** False when the vault has no recorded refresh history. */
  readonly available: boolean;
  readonly lastRefreshedAt: string | null;
  /** Non-zero per-type component deltas (signed: + added, − removed) from the last refresh. */
  readonly changedTypes: Readonly<Record<string, number>>;
  readonly changedTypeCount: number;
  /** Non-zero per-edge-type deltas from the last refresh. */
  readonly changedEdges: Readonly<Record<string, number>>;
  readonly interpretation: string;
  readonly boundaries: readonly string[];
}

const BOUNDARIES: readonly string[] = Object.freeze([
  'These are the component TYPES the MOST RECENT `sfi refresh` changed vs the prior snapshot — what the refresh brought INTO the vault, NOT what changed in the live org SINCE. An offline vault cannot know org-side drift.',
  'For the REAL count of org components modified since the last refresh, run `sfi.live_stale_check` (live Tooling API, opt-in). History covers only refreshes performed since the continuous-learning store shipped.',
]);

/**
 * The `sfi.what_changed_since_refresh` MCP tool. See the module JSDoc for the
 * honesty axis. Never fails on a missing history log — that yields
 * `available: false`.
 *
 * @example
 *   const r = await whatChangedSinceRefreshHandler(ctx, {});
 *   if (r.ok) console.log(r.value.data.changedTypeCount);
 */
export const whatChangedSinceRefreshHandler = async (
  ctx: Context,
  _input: WhatChangedSinceRefreshInput,
): Promise<Result<McpResponse<WhatChangedSinceRefreshOutput>, McpError>> => {
  let recent;
  try {
    recent = summarizeRecentActivity(await loadRefreshHistory(ctx.vaultRoot));
  } catch (cause) {
    return err({
      kind: 'internal',
      message: `failed to read refresh history: ${String(cause)}`,
    });
  }

  const changedTypes = recent.lastRefreshComponentDeltas;
  const changedTypeCount = Object.keys(changedTypes).length;
  const interpretation = !recent.available
    ? 'No refresh history yet — run `sfi refresh` to start the timeline, or `sfi.live_stale_check` to compare the vault against the live org now.'
    : changedTypeCount === 0
      ? `The most recent refresh (${recent.lastRefreshedAt}) brought in no net component-type change vs the prior snapshot. Run \`sfi.live_stale_check\` for live org-side drift since.`
      : `The most recent refresh (${recent.lastRefreshedAt}) changed ${changedTypeCount} component type(s) vs the prior snapshot: ${Object.entries(
          changedTypes,
        )
          .map(([t, n]) => `${t} ${n > 0 ? '+' : ''}${n}`)
          .join(', ')}. This is what the refresh pulled in — for org-side drift SINCE, run \`sfi.live_stale_check\`.`;

  return ok({
    data: {
      available: recent.available,
      lastRefreshedAt: recent.lastRefreshedAt,
      changedTypes,
      changedTypeCount,
      changedEdges: recent.lastRefreshEdgeDeltas,
      interpretation,
      boundaries: BOUNDARIES,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
