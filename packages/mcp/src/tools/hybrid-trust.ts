/**
 * P6-hybrid-trust — the trust block for answers that FUSE the offline vault
 * metadata plane with the opt-in live read-only org plane.
 *
 * Phase 6's whole premise is hybrid answers: the vault says WHAT depends on a
 * field (structure), and a live query says HOW MUCH is at stake (magnitude). An
 * answer that combines them must NOT let one plane's freshness imply the
 * other's — a fresh live count says nothing about whether the vault structure
 * is current, and a recent refresh says nothing about live record reality.
 *
 * The contract's {@link TrustSummary.freshness} already carries BOTH a
 * `snapshotRefreshedAt` (vault) and a `liveQueriedAt` (live) stamp, and
 * `provenance: 'hybrid'` already exists. This module is the single builder that
 * populates both, so every hybrid tool stamps provenance the same way:
 *
 *   - `provenance: 'hybrid'`
 *   - `freshness` carries BOTH planes' timestamps
 *   - `confidence` is the WEAKER of the two planes (a fused answer is only as
 *     trustworthy as its static-analysis plane — live counts are exact
 *     `declared`, so the result tracks the vault plane's confidence)
 *   - an optional {@link HybridStaleness} block (P6-stale-guard-hybrid) so a
 *     hybrid answer can LEAD with a drift warning when the org is ahead of the
 *     vault, instead of silently narrating a fresh live count against stale
 *     vault structure.
 *
 * Pure + deterministic. No graph reads, no org calls.
 */

import type { ConfidenceLevel, TrustSummary } from '@sf-intelligence/contracts';

/**
 * The result of comparing the vault's last refresh against live org
 * modifications (P6-stale-guard-hybrid). Produced by `checkVaultStaleness`
 * (factored out of the `sfi.live_stale_check` handler) and threaded into the
 * hybrid trust block so a fused answer can disclose vault staleness inline.
 */
export interface HybridStaleness {
  /** True when ≥1 checked type has a component modified after the vault refresh. */
  readonly vaultStale: boolean;
  /** Total components modified in the org since the vault refresh (checked types only). */
  readonly driftCount: number;
  /** The metadata types actually checked (the rest are NOT covered by this signal). */
  readonly checkedTypes: readonly string[];
  /** A lead-with warning when the vault is stale; `null` when current. */
  readonly warning: string | null;
}

/**
 * A {@link TrustSummary} narrowed to the hybrid plane, plus the optional
 * staleness block. `HybridTrust extends TrustSummary`, so any consumer that
 * reads `trust` as a plain `TrustSummary` keeps working.
 */
export interface HybridTrust extends TrustSummary {
  readonly provenance: 'hybrid';
  readonly staleness?: HybridStaleness;
}

/** Strongest → weakest. `unknown` is treated as weakest (we cannot vouch for it). */
const CONFIDENCE_RANK: Record<ConfidenceLevel | 'unknown', number> = {
  declared: 0,
  parsed: 1,
  heuristic: 2,
  unknown: 3,
};

/** The weaker (more cautious) of two confidence tiers. */
export const weakestConfidence = (
  a: ConfidenceLevel | 'unknown',
  b: ConfidenceLevel | 'unknown',
): ConfidenceLevel | 'unknown' => (CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b);

/** Verbatim honesty note attached to every hybrid answer's `limitations`. */
export const HYBRID_DISCLOSURE =
  'This answer fuses offline vault metadata (structure — what depends on what) ' +
  'with a live read-only org query (magnitude — how many records). Each plane ' +
  'carries its own freshness: the live figure is current as of liveQueriedAt, ' +
  'the vault structure as of snapshotRefreshedAt. A fresh live number does NOT ' +
  'imply the vault structure is current — when the org is ahead of the vault, ' +
  'the staleness block leads with a drift warning.';

/**
 * Build a hybrid trust block carrying BOTH planes' freshness. The live plane is
 * always `declared` (counts are exact), so the fused confidence collapses to
 * the vault plane's confidence — a hybrid answer is only as trustworthy as the
 * static analysis that decided WHAT is at stake.
 */
export const hybridTrust = (params: {
  readonly vaultRefreshedAt: string;
  readonly liveQueriedAt: string;
  /** The confidence of the vault/static-analysis plane being fused. */
  readonly vaultConfidence: ConfidenceLevel | 'unknown';
  readonly completeness?: TrustSummary['completeness'];
  readonly limitations?: readonly string[];
  readonly staleness?: HybridStaleness;
}): HybridTrust => ({
  provenance: 'hybrid',
  confidence: weakestConfidence(params.vaultConfidence, 'declared'),
  freshness: {
    snapshotRefreshedAt: params.vaultRefreshedAt,
    liveQueriedAt: params.liveQueriedAt,
  },
  completeness: params.completeness ?? { status: 'unknown' },
  limitations: [HYBRID_DISCLOSURE, ...(params.limitations ?? [])],
  ...(params.staleness !== undefined ? { staleness: params.staleness } : {}),
});

/**
 * The lead-with line a hybrid answer prints when the org is ahead of the vault.
 * `null` when the vault is current — callers should print nothing in that case.
 */
export const renderHybridStalenessWarning = (
  staleness: HybridStaleness,
): string | null => {
  if (!staleness.vaultStale) return null;
  return (
    `⚠️ Vault is STALE: ${staleness.driftCount} component(s) across ` +
    `${staleness.checkedTypes.length} checked type(s) were modified in the org ` +
    `after the last refresh. The live figures below are current, but the vault ` +
    `STRUCTURE they are fused with may be out of date — run /sfi-refresh before ` +
    `trusting this for a decision.`
  );
};
