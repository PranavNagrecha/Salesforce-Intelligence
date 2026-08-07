/**
 * AUDIT-F5 — per-family retrieve epochs + mixed-freshness disclosure.
 *
 * A vault-wide `refreshedAt` alone lies after a scoped `--types` refresh:
 * untouched families keep older evidence under a new global stamp. These
 * helpers stamp / preserve per-family clocks and surface `overall: 'mixed'`.
 */

import type { CoverageEntry, TrustSummary, VaultManifest } from '@sf-intelligence/contracts';

/**
 * Stamp `retrievedAt` / `epoch` onto coverage rows after a refresh.
 *
 *   - When `pullRan` is true and a row was requested and not `pending`, bump
 *     that family's epoch and set `retrievedAt` to `nowIso`.
 *   - Otherwise preserve prior epoch / retrievedAt (scoped / staged / --no-pull).
 */
export const stampFamilyEpochs = (
  entries: readonly CoverageEntry[],
  previous: readonly CoverageEntry[] | undefined,
  nowIso: string,
  pullRan: boolean,
): readonly CoverageEntry[] => {
  const prior = new Map<string, CoverageEntry>();
  for (const row of previous ?? []) {
    prior.set(row.type, row);
  }
  return entries.map((entry) => {
    const prev = prior.get(entry.type);
    const shouldStamp =
      pullRan && entry.requested === true && entry.pending !== true;
    if (shouldStamp) {
      const nextEpoch = (prev?.epoch ?? 0) + 1;
      return {
        ...entry,
        retrievedAt: nowIso,
        epoch: nextEpoch,
      };
    }
    if (prev === undefined) return entry;
    return {
      ...entry,
      ...(prev.retrievedAt !== undefined ? { retrievedAt: prev.retrievedAt } : {}),
      ...(prev.epoch !== undefined ? { epoch: prev.epoch } : {}),
    };
  });
};

/**
 * Build TrustSummary.freshness with optional mixed-family disclosure.
 * When `involvedTypes` is set, only those families contribute to mixedness;
 * otherwise every coverage row with `retrievedAt` is considered.
 */
export const buildMixedFreshness = (
  manifest: VaultManifest,
  involvedTypes?: readonly string[],
): TrustSummary['freshness'] => {
  const coverage = manifest.coverage ?? [];
  const filter =
    involvedTypes !== undefined && involvedTypes.length > 0
      ? new Set(involvedTypes)
      : null;
  const families: Record<string, string> = {};
  for (const row of coverage) {
    if (row.retrievedAt === undefined) continue;
    if (filter !== null && !filter.has(row.type)) continue;
    families[row.type] = row.retrievedAt;
  }
  const times = Object.values(families);
  const base: TrustSummary['freshness'] = {
    snapshotRefreshedAt: manifest.refreshedAt,
  };
  // Pre-F5 manifests (no per-family clocks) stay byte-stable: no overall/families.
  if (times.length === 0) {
    return base;
  }
  let oldest = times[0]!;
  let newest = times[0]!;
  for (const t of times) {
    if (t < oldest) oldest = t;
    if (t > newest) newest = t;
  }
  const overall = oldest !== newest ? 'mixed' : 'uniform';
  return {
    ...base,
    overall,
    families,
    oldestEvidenceAt: oldest,
  };
};

/** Compact ledger row persisted under `meta/retrieval-ledger.json`. */
export interface RetrievalLedgerFamily {
  readonly type: string;
  readonly requested: boolean;
  readonly retrieved: number;
  readonly errored: boolean;
  readonly pending?: boolean;
  readonly retrieveConfirmed?: boolean;
  readonly retrievedAt?: string;
  readonly epoch?: number;
}

export interface RetrievalLedger {
  readonly version: 1;
  readonly refreshedAt: string;
  readonly sourceOrg: string;
  readonly pullRan: boolean;
  readonly families: readonly RetrievalLedgerFamily[];
}

export const buildRetrievalLedger = (
  manifest: VaultManifest,
  pullRan: boolean,
): RetrievalLedger => ({
  version: 1,
  refreshedAt: manifest.refreshedAt,
  sourceOrg: manifest.sourceOrg,
  pullRan,
  families: (manifest.coverage ?? []).map((row) => ({
    type: row.type,
    requested: row.requested,
    retrieved: row.retrieved,
    errored: row.errored,
    ...(row.pending === true ? { pending: true } : {}),
    ...(row.retrieveConfirmed === true ? { retrieveConfirmed: true } : {}),
    ...(row.retrievedAt !== undefined ? { retrievedAt: row.retrievedAt } : {}),
    ...(row.epoch !== undefined ? { epoch: row.epoch } : {}),
  })),
});
