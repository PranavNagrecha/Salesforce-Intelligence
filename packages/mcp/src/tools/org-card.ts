/**
 * Handler for the `sfi.org_card` MCP tool — serve the refresh-time org card
 * (P13-CARD-tool): the ≤16 KB orientation snapshot an AI consumer loads
 * BEFORE its first question.
 *
 * READ-ONLY CACHE READ: the card is rendered once per refresh
 * (`meta/org-card.json`, beside `docs/org-card.md`) by the refresh hook —
 * this tool never recomputes it, so it costs one small file read instead of
 * the dozens of graph queries the assembly ran. A vault refreshed by an older
 * product version has no card yet; that is an honest `available: false` with
 * the refresh remedy, never an error and never a silently regenerated card
 * (a regenerated card would carry a render-time stamp that contradicts the
 * refresh-time provenance the card promises).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { McpError, McpResponse } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  buildEnumerationCoverageCaveatFor,
  type CoverageCaveat,
} from './coverage-trust.js';

/**
 * coverage-aware-zero (CR): the legacy-automation families the card's
 * automation counts summarize. When the manifest reports either was NOT
 * retrieved, an automation count of 0 on the card is "not retrieved,
 * re-refresh" — never a proven "no legacy automation".
 */
const CARD_AUTOMATION_COVERAGE = ['WorkflowRule', 'ApprovalProcess'] as const;

/** Zod schema for `sfi.org_card` — no inputs; the card is one per vault. */
export const orgCardInputSchema = z.object({});

export type OrgCardToolInput = z.infer<typeof orgCardInputSchema>;

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface OrgCardToolOutput {
  /** False when the vault predates the card-rendering refresh hook. */
  readonly available: boolean;
  /** The parsed `meta/org-card.json` (shape rendered at refresh), when available. */
  readonly card?: Readonly<Record<string, unknown>>;
  /** Honest next step when the card is absent. */
  readonly remedy?: string;
  /**
   * coverage-aware-zero (CR): present when the card is served but the manifest
   * reports the legacy-automation families (WorkflowRule / ApprovalProcess) the
   * card's automation counts summarize were NOT retrieved. A 0 automation count
   * under this caveat is "not retrieved, re-refresh", NOT a proven "none".
   * Absent on a legacy (no-coverage) vault and on a confirmed-clean retrieve.
   */
  readonly coverageCaveat?: CoverageCaveat;
}

const ABSENT_REMEDY =
  'No org card in this vault yet — it is rendered at refresh time (every full `sfi refresh`, including `sfi refresh --no-pull` on existing source). Run `/sfi-refresh` or `sfi refresh --no-pull` with the current CLI, then call sfi.org_card again. Vaults last refreshed before v0.1.9 never wrote meta/org-card.json.';

/**
 * The `sfi.org_card` MCP tool. Serves the cached refresh-time org card.
 *
 * @example
 *   const r = await orgCardHandler(ctx, {});
 *   if (r.ok && r.value.data.available) orient(r.value.data.card);
 */
export const orgCardHandler = async (
  ctx: Context,
  _input: OrgCardToolInput,
): Promise<Result<McpResponse<OrgCardToolOutput>, McpError>> => {
  const cardPath = join(ctx.vaultRoot, 'meta', 'org-card.json');
  let raw: string;
  try {
    raw = await readFile(cardPath, 'utf8');
  } catch {
    return ok({
      data: { available: false, remedy: ABSENT_REMEDY },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  }
  let card: Readonly<Record<string, unknown>>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    card = parsed as Readonly<Record<string, unknown>>;
  } catch {
    return err({
      kind: 'internal',
      message: `meta/org-card.json is unreadable (corrupt JSON) — re-run \`sfi refresh --no-pull\` to regenerate it.`,
    });
  }
  const coverageCaveat = buildEnumerationCoverageCaveatFor(
    ctx,
    CARD_AUTOMATION_COVERAGE,
    'The card automation counts',
  );
  return ok({
    data: {
      available: true,
      card,
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
