/**
 * ONE vault-freshness assessment for every vault-tool response (ARCH-02 /
 * ADM-2 / DEV-09).
 *
 * Before this module the "this vault was built by an older sf-intelligence"
 * check lived in exactly one tool (`safe_to_delete_field`) plus an advisory
 * nudge in `health_check`, so `get_impact`, `find_component_usages`,
 * `explain_flow`, `what_happens_on_save`, … served a stale-builder vault
 * silently and could report `soundness.complete: true` while a current
 * builder would find more referrers. The vault's AGE was likewise visible only
 * from `health_check`.
 *
 * This module is the single source for both signals. It is pure and cheap (no
 * I/O: it reads the manifest already in memory and the running version), so
 * the dispatcher can apply it to every success response. Tools that need the
 * signal for their own verdicts (`safe_to_delete_field`, `health_check`) read
 * {@link assessVaultFreshness} instead of re-deriving it.
 *
 * The age is reported in coarse BANDS (`>7d`, `>30d`, `>90d`), never as a
 * day count, so a response does not change byte-for-byte every day — only when
 * a band boundary is crossed. `health_check` still reports the exact day count.
 */
import type { McpResponse } from '@sf-intelligence/contracts';
import { compareVersions } from '@sf-intelligence/core';

import type { Context } from '../server.js';

/**
 * Injected by the CLI's esbuild `define` when the server is bundled into the
 * shipped `sfi` bin. Absent when running unbundled (dev, vitest).
 */
declare const SFI_BUILD_VERSION: string | undefined;

/** Milliseconds in one day. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Age (whole days) at or above which a vault is flagged stale (matches health_check). */
export const STALE_AGE_DAYS = 7;

/**
 * Extraction capabilities added per release, oldest first. A vault built
 * before `since` does not hold these edges, so their absence proves nothing.
 * Named so a stale-builder caveat says WHAT a re-refresh buys. Append a row
 * whenever a release adds an edge family a dependency answer relies on.
 */
export const EDGE_FAMILIES_BY_VERSION: readonly {
  readonly since: string;
  readonly families: readonly string[];
}[] = [
  {
    since: '0.3.0',
    families: [
      'roll-up coupling edges',
      'condition (criteria) field edges',
      'resolved formula-traversal edges',
    ],
  },
  {
    since: '0.3.3',
    families: ['OmniStudio -> Apex (remoteClass) caller edges', 'managed-package OmniStudio DataPacks'],
  },
  {
    // The first release after 0.3.3 (shipped as 0.4.0; there was no 0.3.4).
    since: '0.4.0',
    families: [
      'method-level LWC/Aura -> Apex caller edges',
      'Apex Custom Label reference edges',
      'Flow condition / filter / assignment literal values',
      'report filter column, DataMapper formula, LWC schema import, standard lookup and DLRS rollup field edges',
      'formula / FlexCard Custom Label reference edges',
      'validation rule error-display field edges',
      'sharing-rule criteria and restriction / scoping rule filter field edges',
      'time-triggered workflow field-update writer edges',
    ],
  },
];

/**
 * The release that introduced `family` (a string from
 * {@link EDGE_FAMILIES_BY_VERSION}). Throws on an unknown family so a typo in a
 * consumer fails at module load, never as a silent "always modeled".
 */
export const edgeFamilySince = (family: string): string => {
  const row = EDGE_FAMILIES_BY_VERSION.find((r) => r.families.includes(family));
  if (row === undefined) throw new Error(`unknown edge family: ${family}`);
  return row.since;
};

/** The age band reported on responses (never a raw day count). */
export type AgeBand = '>7d' | '>30d' | '>90d';

/** The shared freshness assessment. */
export interface VaultFreshnessAssessment {
  /** Manifest refresh timestamp. */
  readonly refreshedAt: string;
  /** Whole days since `refreshedAt`; `null` when unparseable. */
  readonly ageDays: number | null;
  /** `true` when `ageDays >= STALE_AGE_DAYS`. */
  readonly stale: boolean;
  /** Coarse age band, present only when `stale`. */
  readonly ageBand?: AgeBand;
  /** The sf-intelligence version that built the vault (`manifest.version`). */
  readonly builtBy: string | null;
  /** The running sf-intelligence version, when known. */
  readonly running: string | null;
  /** `true` only when both versions parse and `builtBy` is older than `running`. */
  readonly builderStale: boolean;
  /** Edge families added after `builtBy` (empty unless `builderStale`). */
  readonly missingEdgeFamilies: readonly string[];
}

/**
 * The running sf-intelligence version: `SFI_PLUGIN_VERSION` (set by `sfi mcp`)
 * first, then the bundled build define. `null` when neither is available — the
 * drift is then undetectable and NOT reported (never guessed).
 */
export const runningVersion = (): string | null => {
  const env = process.env['SFI_PLUGIN_VERSION'];
  if (env !== undefined && env !== '') return env;
  if (typeof SFI_BUILD_VERSION !== 'undefined' && SFI_BUILD_VERSION) {
    return SFI_BUILD_VERSION;
  }
  return null;
};

const ageBandFor = (ageDays: number): AgeBand =>
  ageDays >= 90 ? '>90d' : ageDays >= 30 ? '>30d' : '>7d';

/**
 * Assess the bound vault's freshness. Pure apart from reading the clock and the
 * running version; reads only `ctx.manifest` (defensively — unit tests drive
 * the dispatcher with a synthetic `{}` ctx).
 */
export const assessVaultFreshness = (
  ctx: Pick<Context, 'manifest'> | undefined,
  now: number = Date.now(),
): VaultFreshnessAssessment => {
  const manifest = (ctx?.manifest ?? {}) as {
    readonly refreshedAt?: unknown;
    readonly version?: unknown;
  };
  const refreshedAt = typeof manifest.refreshedAt === 'string' ? manifest.refreshedAt : '';
  const refreshedMs = Date.parse(refreshedAt);
  const ageDays = Number.isNaN(refreshedMs)
    ? null
    : Math.max(0, Math.floor((now - refreshedMs) / MS_PER_DAY));
  const stale = ageDays !== null && ageDays >= STALE_AGE_DAYS;
  const builtBy =
    typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : null;
  const running = runningVersion();
  const builderStale = builtBy !== null && running !== null && compareVersions(builtBy, running);
  const missingEdgeFamilies = builderStale
    ? EDGE_FAMILIES_BY_VERSION.filter(
        (row) => compareVersions(builtBy, row.since) && !compareVersions(running, row.since),
      ).flatMap((row) => row.families.map((f) => `${f} (${row.since})`))
    : [];
  return {
    refreshedAt,
    ageDays,
    stale,
    ...(stale && ageDays !== null ? { ageBand: ageBandFor(ageDays) } : {}),
    builtBy,
    running,
    builderStale,
    missingEdgeFamilies,
  };
};

/**
 * One-line stale-builder caveat, or `undefined` when the builder is current or
 * the drift is undetectable. Shared by the dispatcher and the tools that fold
 * it into their own verdicts.
 */
export const builderStaleCaveat = (a: VaultFreshnessAssessment): string | undefined => {
  if (!a.builderStale || a.builtBy === null || a.running === null) return undefined;
  const missing =
    a.missingEdgeFamilies.length > 0
      ? ` Missing until re-refresh: ${a.missingEdgeFamilies.join('; ')}.`
      : '';
  return (
    `Vault built by sf-intelligence ${a.builtBy}; running ${a.running}. Extraction added since ` +
    `${a.builtBy} is absent, so "no referrers / nothing found" is NOT proof — run \`sfi refresh\`.${missing}`
  );
};

/** One-line age caveat (banded), or `undefined` when the vault is fresh. */
export const ageCaveat = (a: VaultFreshnessAssessment): string | undefined =>
  a.stale && a.ageBand !== undefined
    ? `Vault snapshot is ${a.ageBand} old (refreshed ${a.refreshedAt}); the org may have changed since — run \`sfi refresh\`.`
    : undefined;

/** The compact block stamped on `vaultState` when anything is stale. */
export interface VaultFreshnessStamp {
  readonly ageBand?: AgeBand;
  readonly builderStale?: { readonly builtBy: string; readonly running: string };
  readonly warning: string;
}

const STALE_BUILDER_BLIND_SPOT_NOTE =
  'Vault built by an older sf-intelligence than the one running; referrer kinds extracted only by ' +
  'newer builders are absent from this result. Re-run `sfi refresh`.';

/**
 * Apply the assessment to a success response. Byte-transparent when the vault
 * is fresh and the builder is current. Otherwise:
 *   - `vaultState.freshness` carries the banded age / builder drift + one line;
 *   - a `data.trust` block gains the warning in `limitations` and, if its
 *     `freshness` is empty, the snapshot timestamp;
 *   - on builder drift, `data.trust.completeness` `complete` becomes `partial`
 *     and `data.soundness` `complete: true` becomes `partial` with a
 *     `stale-builder` blind spot — a stale extraction cannot certify absence.
 */
export const applyVaultFreshness = <T>(
  resp: McpResponse<T>,
  ctx: Pick<Context, 'manifest'> | undefined,
  now: number = Date.now(),
): McpResponse<T> => {
  if (ctx?.manifest === undefined) return resp;
  const a = assessVaultFreshness(ctx, now);
  const builderLine = builderStaleCaveat(a);
  const ageLine = ageCaveat(a);
  if (builderLine === undefined && ageLine === undefined) {
    // Fresh vault: only fill an EMPTY `trust.freshness` (e.g. route_question
    // shipped `{}`), so every trust block names its snapshot.
    const filled = applyToData(resp.data, a, undefined, undefined);
    return filled === resp.data ? resp : { ...resp, data: filled };
  }
  const warning = [builderLine, ageLine].filter((s): s is string => s !== undefined).join(' ');
  const stamp: VaultFreshnessStamp = {
    ...(a.ageBand !== undefined ? { ageBand: a.ageBand } : {}),
    ...(builderLine !== undefined && a.builtBy !== null && a.running !== null
      ? { builderStale: { builtBy: a.builtBy, running: a.running } }
      : {}),
    warning,
  };
  const data = applyToData(resp.data, a, builderLine, ageLine);
  return {
    ...resp,
    data,
    vaultState: { ...resp.vaultState, freshness: stamp } as McpResponse<T>['vaultState'],
  };
};

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);

const applyToData = <T>(
  data: T,
  a: VaultFreshnessAssessment,
  builderLine: string | undefined,
  ageLine: string | undefined,
): T => {
  if (!isRec(data)) return data;
  let out: Rec = data;
  // A tool that already folds the builder caveat into its own verdict
  // (`safe_to_delete_field`'s `builderVersionCaveat`) keeps its wording; only
  // the age line is added so the same fact is not stated twice.
  const ownsBuilderCaveat = typeof out['builderVersionCaveat'] === 'string';
  const line = [ownsBuilderCaveat ? undefined : builderLine, ageLine]
    .filter((s): s is string => s !== undefined)
    .join(' ');
  const trust = out['trust'];
  const stale = builderLine !== undefined || ageLine !== undefined;
  if (
    isRec(trust) &&
    Array.isArray(trust['limitations']) &&
    (stale || (isRec(trust['freshness']) && Object.keys(trust['freshness']).length === 0))
  ) {
    const limitations = trust['limitations'] as unknown[];
    const freshness = isRec(trust['freshness']) ? trust['freshness'] : {};
    const completeness = isRec(trust['completeness']) ? trust['completeness'] : undefined;
    out = {
      ...out,
      trust: {
        ...trust,
        ...(Object.keys(freshness).length === 0 && trust['freshness'] !== undefined && a.refreshedAt !== ''
          ? { freshness: { snapshotRefreshedAt: a.refreshedAt } }
          : {}),
        ...(builderLine !== undefined && completeness?.['status'] === 'complete'
          ? { completeness: { ...completeness, status: 'partial' } }
          : {}),
        limitations:
          line === '' || limitations.includes(line) ? limitations : [line, ...limitations],
      },
    };
  }
  const soundness = out['soundness'];
  if (builderLine !== undefined && isRec(soundness) && Array.isArray(soundness['blindSpots'])) {
    out = {
      ...out,
      soundness: {
        ...soundness,
        complete: false,
        staticCoverage: 'partial',
        blindSpots: [
          ...(soundness['blindSpots'] as unknown[]),
          { kind: 'stale-builder', componentIds: [], note: STALE_BUILDER_BLIND_SPOT_NOTE },
        ],
      },
    };
  }
  return out as T;
};
