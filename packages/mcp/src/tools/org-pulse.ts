/**
 * Handler for the `sfi.org_pulse` MCP tool — "who shaped this org, and how
 * fresh is what I know about it?".
 *
 * A single-vault composition over two graph summaries that previously lived
 * only as functions / CLI surfaces:
 *   - `freshnessSummary` — how many components carry a known
 *     `lastModifiedDate`, the coverage %, and the oldest / newest components.
 *   - `contributorsSummary` — the top `lastModifiedBy` authors who shaped the
 *     org, by component count.
 *
 * **Honesty axis (verbatim in `disclosure`).** Both signals depend on the
 * vault carrying `lastModifiedDate` / `lastModifiedBy` per component. A plain
 * `sf project retrieve` does NOT populate those fields — they require a
 * refresh enriched via the Tooling API. On a vault retrieved without that
 * enrichment, coverage is ~0% and the contributor list is empty; that is an
 * honest "not captured", NOT "the org has no history".
 */

import type { McpError, McpResponse } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  contributorsSummary,
  freshnessSummary,
  type ContributorsSummary,
  type FreshnessSummary,
} from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

/** Default top-N for both the freshness entry lists and the contributor list. */
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/**
 * Zod schema for `sfi.org_pulse`.
 *   - `limit`: optional 1..50 (default 10) — caps the oldest/newest freshness
 *     entry lists and the contributor list.
 */
export const orgPulseInputSchema = z.object({
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
});

export type OrgPulseInput = z.infer<typeof orgPulseInputSchema>;

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface OrgPulseOutput {
  /** Per-vault freshness: coverage %, oldest/newest components. */
  readonly freshness: FreshnessSummary;
  /** Top contributors by `lastModifiedBy` component count. */
  readonly contributors: ContributorsSummary;
  /** Verbatim honesty note about tooling-API-dependent coverage. */
  readonly disclosure: string;
}

/**
 * Exported (not just used locally) so `sfi.generate_fleet_report`
 * (`fleet-report.ts`) can surface the SAME verbatim honesty axis for its
 * per-vault org-pulse-style digest, instead of drifting a second copy.
 */
export const ORG_PULSE_DISCLOSURE =
  "Freshness and contributor signals come from each component's lastModifiedDate / lastModifiedBy. A plain `sf project retrieve` does NOT populate those — they need a refresh enriched via the Tooling API. If coverage is ~0% and the contributor list is empty, that means the data was not captured at refresh time, NOT that the org has no history. Run a tooling-API-enabled refresh to populate it.";

/**
 * The `sfi.org_pulse` MCP tool. Returns the current vault's freshness coverage
 * and top contributors. See module JSDoc for the tooling-API honesty axis.
 *
 * @example
 *   const r = await orgPulseHandler(ctx, { limit: 5 });
 *   if (r.ok) console.log(r.value.data.freshness.coveragePct);
 */
export const orgPulseHandler = async (
  ctx: Context,
  input: OrgPulseInput,
): Promise<Result<McpResponse<OrgPulseOutput>, McpError>> => {
  const limit = input.limit ?? DEFAULT_LIMIT;

  const fresh = await freshnessSummary(ctx.graph, limit);
  if (!fresh.ok) {
    return err({
      kind: 'internal',
      message: `freshness query failed: ${fresh.error.message}`,
    });
  }

  const contrib = await contributorsSummary(ctx.graph, limit);
  if (!contrib.ok) {
    return err({
      kind: 'internal',
      message: `contributors query failed: ${contrib.error.message}`,
    });
  }

  return ok({
    data: {
      freshness: fresh.value,
      contributors: contrib.value,
      disclosure: ORG_PULSE_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
