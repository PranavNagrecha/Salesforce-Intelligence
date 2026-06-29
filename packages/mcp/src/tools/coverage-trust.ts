/**
 * Shared coverage-aware trust helpers for destructive and what-if tools.
 */

import type { TrustSummary } from '@sf-intelligence/contracts';
import { summarizeCoverage } from '@sf-intelligence/vault';

import type { Context } from '../server.js';

export interface CoverageCaveat {
  readonly status: 'partial' | 'unknown';
  readonly missingCoverage: readonly string[];
  readonly message: string;
}

/**
 * The unified severity verdict for the whole `what_if_*` family (P8-what-if-suite).
 *
 * Before the unification each tool redeclared its own `Verdict` with a
 * slightly different union — some carried `review` but not `unknown`, others
 * the reverse — so the same headline meant different things tool to tool.
 * This is the single superset. Widening any tool's local union to this is a
 * pure type-level change: no handler ever produced a value outside the set it
 * already used, so runtime output is unchanged.
 *
 *   - `safe`     — no impacts found and coverage is complete.
 *   - `review`   — impacts found, or a `safe` result whose coverage is partial
 *                  (absence is "not checked", not proven; see `coverageCaveat`).
 *   - `risky`    — impacts found that likely break callers/automation.
 *   - `blocking` — a hard metadata blocker (the change cannot be made as-is).
 *   - `unknown`  — the tool could not classify (degraded/partial signal).
 */
export type Verdict = 'safe' | 'review' | 'risky' | 'blocking' | 'unknown';

/**
 * The result envelope every `what_if_*` tool's `data` payload conforms to
 * (P8-what-if-suite). Tool-specific detail (impacts, conflicts, buckets) is
 * added on top by extending this base; the four common fields below are the
 * contract a caller can rely on regardless of which what-if they invoked.
 *
 * Conformance is asserted at compile time in
 * `test/tools/what-if-envelope.test.ts` — adding a tool that omits any of
 * these fails the build.
 */
export interface WhatIfEnvelope {
  /** Headline severity from the unified vocabulary above. */
  readonly verdict: Verdict;
  /** Present when a family this verdict depends on has incomplete coverage. */
  readonly coverageCaveat?: CoverageCaveat;
  /** Provenance / confidence / completeness for the answer. */
  readonly trust: TrustSummary;
  /** Verbatim boundary disclosure surfaced with every response. */
  readonly disclosure: string;
}

export const offlineTrust = (
  ctx: Context,
  completeness: TrustSummary['completeness'],
): TrustSummary => ({
  provenance: 'offline_snapshot',
  confidence: 'declared',
  freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
  completeness,
  limitations: [],
});

export const buildCoverageCaveat = (
  ctx: Context,
  requiredTypes: readonly string[],
  purpose: string,
): CoverageCaveat | undefined => {
  const coverage = summarizeCoverage(ctx.manifest, requiredTypes);
  if (coverage.status === 'complete') return undefined;
  const missingCoverage = coverage.missingCoverage.length > 0
    ? coverage.missingCoverage
    : [...requiredTypes];
  return {
    status: coverage.status === 'partial' ? 'partial' : 'unknown',
    missingCoverage,
    message:
      `${purpose} cannot be confirmed because the vault has incomplete coverage for: ${missingCoverage.join(', ')}. Treat absence of dependencies in those families as "not checked", not "none".`,
  };
};

/**
 * Coverage caveat for type-scoped enumeration tools (`list_components`, …).
 * Attached whenever manifest coverage for the requested type is not `complete`,
 * including when the page is non-empty — a scoped refresh can leave stale rows
 * while the inventory is not authoritative. Skipped when the manifest carries
 * no coverage rows (pre-v4 vaults) so legacy vaults are not false-flagged.
 */
export const buildEnumerationCoverageCaveat = (
  ctx: Context,
  type: string,
): CoverageCaveat | undefined => {
  const coverage = summarizeCoverage(ctx.manifest, [type]);
  if (!coverage.coverageKnown || coverage.status === 'complete') return undefined;
  return buildCoverageCaveat(ctx, [type], `The \`${type}\` inventory`);
};

/**
 * coverage-aware-zero (CR): the multi-type sibling of
 * `buildEnumerationCoverageCaveat`. For a tool whose 0/empty assembly spans
 * several metadata families (e.g. process-builder migration over Flow /
 * WorkflowRule / ApprovalProcess), attach a caveat when ANY of the requested
 * types is not fully covered per the manifest, so a bare 0 reads "not
 * retrieved, re-refresh" instead of a proven "none".
 *
 * Guards identical to the single-type helper: returns undefined when the
 * manifest carries no coverage rows (pre-v4 / legacy vaults — never false-flag
 * them) or when every requested type retrieved clean (status `complete`). The
 * caveat's `missingCoverage` lists only the families actually not covered, so a
 * partially-covered set names exactly which family is "not checked".
 */
export const buildEnumerationCoverageCaveatFor = (
  ctx: Context,
  types: readonly string[],
  purpose: string,
): CoverageCaveat | undefined => {
  if (types.length === 0) return undefined;
  const coverage = summarizeCoverage(ctx.manifest, types);
  if (!coverage.coverageKnown || coverage.status === 'complete') return undefined;
  return buildCoverageCaveat(ctx, types, purpose);
};

export const applyCoverageToVerdict = <V extends string>(
  verdict: V,
  caveat: CoverageCaveat | undefined,
  safeValue: V,
  reviewValue: V,
): V => {
  if (caveat === undefined) return verdict;
  return verdict === safeValue ? reviewValue : verdict;
};

/** Coverage families that affect flow-deactivation what-if completeness. */
export const FLOW_DEACTIVATION_REQUIRED_COVERAGE = [
  'Flow',
  'ApexClass',
  'CustomObject',
  'EmailTemplate',
] as const;

/** Coverage families that affect trigger-disable what-if completeness. */
export const TRIGGER_DISABLE_REQUIRED_COVERAGE = [
  'ApexTrigger',
  'ApexClass',
  'CustomObject',
  'PlatformEvent',
] as const;

/** Coverage families that affect method-signature change what-if completeness. */
export const METHOD_SIGNATURE_REQUIRED_COVERAGE = [
  'ApexClass',
  'ApexTrigger',
  'Flow',
  'LightningComponentBundle',
  'AuraDefinitionBundle',
] as const;

export const attachCoverageToWhatIf = (
  ctx: Context,
  requiredTypes: readonly string[],
  purpose: string,
  rawVerdict: string,
): {
  readonly verdict: string;
  readonly coverageCaveat?: CoverageCaveat;
  readonly trust: TrustSummary;
} => {
  const coverageCaveat = buildCoverageCaveat(ctx, requiredTypes, purpose);
  const verdict = applyCoverageToVerdict(
    rawVerdict,
    coverageCaveat,
    'safe',
    'review',
  );
  const completeness: TrustSummary['completeness'] =
    coverageCaveat === undefined
      ? { status: 'complete' }
      : {
          status: coverageCaveat.status,
          missingCoverage: coverageCaveat.missingCoverage,
        };
  return {
    verdict,
    ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
    trust: offlineTrust(ctx, completeness),
  };
};
