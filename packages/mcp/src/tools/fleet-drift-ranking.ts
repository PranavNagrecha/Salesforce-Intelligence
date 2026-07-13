/**
 * Handler for `sfi.fleet_drift_ranking` (P7-fleet-drift-ranking).
 *
 * Fleet ops, the staleness question across MANY orgs: of every registered
 * vault, which is the most behind its live org — i.e. which should you refresh
 * first? It runs the same Tooling-API staleness check `sfi.live_stale_check`
 * runs for one org (components modified after the vault's `refreshedAt`, across
 * {@link STALE_CHECK_TYPES}) across the whole registry, and ranks the vaults by
 * drift descending.
 *
 * Three honesty/safety properties make a fleet sweep safe:
 *   - **Per-org consent.** Each vault's `sourceOrg` is gated independently
 *     (`probeLiveAccess`). A vault whose org has no consent is an honest
 *     `no-consent` SKIP, never an error and never a silent live call.
 *   - **Shared session budget.** Every staleness query routes through
 *     `runLiveQuery`, so N orgs × 6 queries decrement the same P6 budget that
 *     bounds the hybrid plane. When the budget can't cover a vault's checks, the
 *     vault is a `budget-exhausted` skip — the sweep degrades, never overruns
 *     the org's API limits.
 *   - **Roll-up provenance.** Each ranked row is its own `live_org` read with
 *     its own `liveQueriedAt`; the aggregate is a fleet roll-up, so one org's
 *     freshness never implies another's.
 */

import type {
  McpError,
  McpResponse,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import type { ExecCommand } from '@sf-intelligence/tooling-api';
import {
  findRegistryRoot,
  listRegisteredVaults,
  loadManifest,
} from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { probeLiveAccess, STALE_CHECK_TYPES } from './live-plane.js';
import { liveBudgetStatus, runLiveQuery, type LiveBudgetStatus } from './live-session.js';

export const FLEET_DRIFT_DISCLOSURE =
  'Ranks registered vaults by how far each is BEHIND its live org — a per-org Tooling-API count of components modified since that vault\'s last refresh, across ApexClass / ApexTrigger / ValidationRule / Layout / Flow / CustomField (other families NOT checked). Each ranked row is its own live_org read at its own time; the aggregate is a fleet roll-up, so one org\'s freshness never implies another\'s. Consent is per org (a vault without it is an honest no-consent skip); every query routes through the per-session live-query budget (a vault the budget can\'t cover is a budget-exhausted skip — raise SFI_LIVE_QUERY_BUDGET or sweep a subset). Read-only; mutates neither org nor vault.';

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const STALE_TYPE_COUNT = STALE_CHECK_TYPES.length;

/** MCP `{}` args can arrive stringified — coerce the optional boolean. */
const coerceBool = z.preprocess(
  (v) => (v === 'true' ? true : v === 'false' ? false : v),
  z.boolean().optional(),
);

export const fleetDriftRankingInputSchema = z.object({
  /** Enable the live plane for every org in this sweep (per-call override of consent). */
  liveEnabled: coerceBool,
  /** Restrict the sweep to these registered aliases; default = all registered. */
  vaults: z.array(z.string().min(1)).optional(),
});

export type FleetDriftRankingInput = z.infer<typeof fleetDriftRankingInputSchema>;

interface DriftRow {
  readonly alias: string;
  readonly sourceOrg: string;
  readonly refreshedAt: string;
  readonly driftCount: number;
  readonly vaultStale: boolean;
  readonly checkedTypes: readonly string[];
  readonly erroredTypes: readonly string[];
  readonly liveQueriedAt: string;
  /** Per-row provenance — each row is its own live read. */
  readonly provenance: 'live_org';
}

type SkipReason =
  | 'no-consent'
  | 'never-refreshed'
  | 'unreadable'
  | 'budget-exhausted';

interface SkipRow {
  readonly alias: string;
  readonly sourceOrg: string | null;
  readonly reason: SkipReason;
  readonly detail: string;
}

export interface FleetDriftRankingOutput {
  readonly registeredVaultCount: number;
  /** Vaults that were drift-checked, most-behind first. */
  readonly ranking: readonly DriftRow[];
  /** Vaults skipped (consent / freshness / budget), with the honest reason. */
  readonly skipped: readonly SkipRow[];
  /** The vault to refresh first, or null when none drifted / none checked. */
  readonly mostDrifted: { readonly alias: string; readonly driftCount: number } | null;
  readonly recommendation: string;
  /** Per-session live-query budget snapshot after the sweep. */
  readonly budget: LiveBudgetStatus;
  readonly trust: TrustSummary;
  readonly disclosure: string;
  readonly note: string | null;
}

const totalSizeOf = (value: unknown): number =>
  (value as { result?: { totalSize?: number } }).result?.totalSize ?? 0;

/** Run the per-type staleness check for one org through the session budget. */
const driftForOrg = async (
  org: string,
  refreshedAt: string,
  exec?: ExecCommand,
): Promise<{ total: number; checked: string[]; errored: string[]; queriedAt: string }> => {
  const sinceLiteral = refreshedAt.replace(/\.\d+Z$/, 'Z');
  let total = 0;
  const checked: string[] = [];
  const errored: string[] = [];
  let queriedAt = new Date().toISOString();
  for (const type of STALE_CHECK_TYPES) {
    const soql = `SELECT Id FROM ${type} WHERE LastModifiedDate > ${sinceLiteral}`;
    const r = await runLiveQuery(
      org,
      ['data', 'query', '--query', soql, '--use-tooling-api'],
      exec,
    );
    if (!r.ok) {
      errored.push(type);
      continue;
    }
    queriedAt = r.value.queriedAt;
    total += totalSizeOf(r.value.value);
    checked.push(type);
  }
  return { total, checked, errored, queriedAt };
};

export const fleetDriftRankingHandler = async (
  ctx: Context,
  input: FleetDriftRankingInput,
  exec?: ExecCommand,
): Promise<Result<McpResponse<FleetDriftRankingOutput>, McpError>> => {
  const root = findRegistryRoot(ctx.vaultRoot);
  const registry = await listRegisteredVaults(root);
  if (!registry.ok) {
    return { ok: false, error: { kind: 'internal', message: registry.error.message } };
  }

  const wanted = input.vaults === undefined ? null : new Set(input.vaults);
  const vaults = registry.value.filter((v) => wanted === null || wanted.has(v.alias));

  const ranking: DriftRow[] = [];
  const skipped: SkipRow[] = [];

  for (const vault of vaults) {
    const manifestResult = await loadManifest(vault.path);
    if (!manifestResult.ok) {
      skipped.push({
        alias: vault.alias,
        sourceOrg: null,
        reason: 'unreadable',
        detail: `Vault manifest could not be read (${vault.path}). Has it been refreshed?`,
      });
      continue;
    }
    const { sourceOrg, refreshedAt } = manifestResult.value;
    if (typeof refreshedAt !== 'string' || !ISO_TIMESTAMP_RE.test(refreshedAt)) {
      skipped.push({
        alias: vault.alias,
        sourceOrg: sourceOrg ?? null,
        reason: 'never-refreshed',
        detail: 'No usable refresh timestamp — run `sfi refresh` for this vault first.',
      });
      continue;
    }
    const access = await probeLiveAccess(ctx, {
      liveEnabled: input.liveEnabled,
      orgAlias: sourceOrg,
    });
    if (!access.allowed) {
      skipped.push({
        alias: vault.alias,
        sourceOrg,
        reason: 'no-consent',
        detail: `Live plane not enabled for '${sourceOrg}'. Grant per-org consent (sfi.live_consent { grant: true, orgAlias: '${sourceOrg}' }) or pass liveEnabled: true.`,
      });
      continue;
    }
    // Pre-check the shared budget: skip whole vaults we cannot fully check, so a
    // sweep never half-checks an org and never overruns the API budget.
    if (liveBudgetStatus().remaining < STALE_TYPE_COUNT) {
      skipped.push({
        alias: vault.alias,
        sourceOrg,
        reason: 'budget-exhausted',
        detail: `Session live-query budget (${liveBudgetStatus().remaining} left) cannot cover this vault's ${STALE_TYPE_COUNT} checks. Raise SFI_LIVE_QUERY_BUDGET, sweep a subset via \`vaults\`, or start a new session.`,
      });
      continue;
    }
    const { total, checked, errored, queriedAt } = await driftForOrg(
      sourceOrg,
      refreshedAt,
      exec,
    );
    ranking.push({
      alias: vault.alias,
      sourceOrg,
      refreshedAt,
      driftCount: total,
      vaultStale: total > 0,
      checkedTypes: checked,
      erroredTypes: errored,
      liveQueriedAt: queriedAt,
      provenance: 'live_org',
    });
  }

  ranking.sort(
    (a, b) =>
      b.driftCount - a.driftCount ||
      (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0),
  );

  const top = ranking[0];
  const mostDrifted =
    top !== undefined && top.driftCount > 0
      ? { alias: top.alias, driftCount: top.driftCount }
      : null;

  let recommendation: string;
  if (ranking.length === 0) {
    recommendation =
      registry.value.length === 0
        ? 'No vaults are registered. Register orgs with `sfi register-vault <alias> <path>` to rank fleet drift.'
        : `No vault could be drift-checked (${skipped.length} skipped). Grant per-org consent with sfi.live_consent { grant: true } or pass liveEnabled: true, then re-run.`;
  } else if (mostDrifted !== null) {
    recommendation = `Refresh '${mostDrifted.alias}' first — its org has ${mostDrifted.driftCount} component(s) changed since its last refresh (${top?.refreshedAt}). ${ranking.length} vault(s) checked, ranked most-behind first.`;
  } else {
    recommendation = `All ${ranking.length} checked vault(s) are current for the checked types — no refresh needed yet.`;
  }

  const anyLive = ranking.length > 0;
  const latestQueriedAt = ranking.reduce<string | null>(
    (latest, row) => (latest === null || row.liveQueriedAt > latest ? row.liveQueriedAt : latest),
    null,
  );

  const note =
    registry.value.length === 0
      ? 'No registry found — fleet drift ranking needs registered vaults (sfi register-vault).'
      : skipped.length > 0 && ranking.length === 0
        ? 'Every registered vault was skipped — see `skipped` for the per-vault reason.'
        : null;

  const trust: TrustSummary = {
    provenance: anyLive ? 'live_org' : 'offline_snapshot',
    confidence: 'declared',
    freshness: anyLive && latestQueriedAt !== null
      ? { liveQueriedAt: latestQueriedAt }
      : { snapshotRefreshedAt: ctx.manifest.refreshedAt },
    completeness: { status: skipped.length > 0 ? 'partial' : 'complete' },
    limitations: [FLEET_DRIFT_DISCLOSURE],
  };

  return ok({
    data: {
      registeredVaultCount: registry.value.length,
      ranking,
      skipped,
      mostDrifted,
      recommendation,
      budget: liveBudgetStatus(),
      trust,
      disclosure: FLEET_DRIFT_DISCLOSURE,
      note,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
