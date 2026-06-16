/**
 * Handler for `sfi.coverage_report`.
 *
 * This is the enterprise honesty surface: it reports what the last vault build
 * knows about its own completeness, including metadata families that are not
 * modeled yet.
 */

import type {
  CoverageEntry,
  McpError,
  McpResponse,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import { buildCoverageEntries, summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

export const COVERAGE_DISCLOSURE =
  "Coverage describes what the last `sf project retrieve` requested and returned — not what exists in the org. A type listed under `notModeled` is not analyzed by this product at all; its absence from any result means 'not checked', never 'none'. Re-run `/sfi-refresh` after widening your retrieve manifest to close a gap.";

export const coverageReportInputSchema = z.object({
  type: z.string().min(1).optional(),
});

export type CoverageReportInput = z.infer<typeof coverageReportInputSchema>;

export interface CoverageReportOutput {
  readonly coverageKnown: boolean;
  readonly coverageComputedAt: string | null;
  readonly covered: readonly CoverageEntry[];
  readonly partial: readonly CoverageEntry[];
  readonly notModeled: readonly CoverageEntry[];
  /**
   * P13-STAGED-tiers: types queued by an in-progress staged refresh — "not
   * retrieved YET (build in progress)", distinct from `partial` ("requested
   * but came back empty/errored"). Empty outside a staged build.
   */
  readonly pending: readonly CoverageEntry[];
  /** Present while a staged refresh is mid-build (tier progress). */
  readonly stagedBuild?: {
    readonly tier: number;
    readonly totalTiers: number;
  };
  readonly summary: ReturnType<typeof summarizeCoverage>;
  readonly trust: TrustSummary;
  readonly disclosure: string;
}

const partitionCoverage = (
  entries: readonly CoverageEntry[],
): Pick<CoverageReportOutput, 'covered' | 'partial' | 'notModeled' | 'pending'> => ({
  covered: entries.filter(
    (entry) =>
      entry.requested &&
      entry.retrieved > 0 &&
      !entry.errored &&
      !entry.neverModeled &&
      entry.pending !== true,
  ),
  partial: entries.filter(
    (entry) =>
      entry.requested &&
      (entry.retrieved === 0 || entry.errored) &&
      !entry.neverModeled &&
      entry.pending !== true,
  ),
  notModeled: entries.filter((entry) => entry.neverModeled),
  pending: entries.filter((entry) => entry.pending === true && !entry.neverModeled),
});

export const coverageReportHandler = async (
  ctx: Context,
  input: CoverageReportInput,
): Promise<Result<McpResponse<CoverageReportOutput>, McpError>> => {
  const entries = buildCoverageEntries(ctx.manifest).filter((entry) =>
    input.type === undefined ? true : entry.type === input.type,
  );
  const summary = summarizeCoverage(
    ctx.manifest,
    input.type === undefined ? undefined : [input.type],
  );
  const partitions = partitionCoverage(entries);
  const missingCoverage = summary.missingCoverage;
  const staged = ctx.manifest.staged;

  return ok({
    data: {
      coverageKnown: summary.coverageKnown,
      coverageComputedAt: ctx.manifest.coverageComputedAt ?? null,
      ...partitions,
      ...(staged !== undefined
        ? { stagedBuild: { tier: staged.tier, totalTiers: staged.totalTiers } }
        : {}),
      summary,
      trust: {
        provenance: 'offline_snapshot',
        confidence: summary.coverageKnown ? 'declared' : 'unknown',
        freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
        completeness: {
          status: summary.status,
          ...(missingCoverage.length > 0 ? { missingCoverage } : {}),
        },
        limitations: [COVERAGE_DISCLOSURE],
      },
      disclosure: COVERAGE_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
