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
import {
  ACTIVE_HOLDERS_COMPLETE_SUBJECT,
  readFacts,
} from '@sf-intelligence/graph';
import {
  buildCoverageEntries,
  buildMixedFreshness,
  rankUncoveredFamilies,
  readTombstones,
  summarizeCoverage,
  type TombstoneRecord,
  type UncoveredFamily,
} from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { probeLiveAccess } from './live-plane.js';
import { ASSIGNMENT_DATA_LIVE_TOOLS } from './vault-assignment-disclosure.js';

/** CR-CAP-20 — cap on the ranked uncovered-families list. */
const TOP_UNCOVERED_FAMILIES_CAP = 10;

export const COVERAGE_DISCLOSURE =
  "Coverage describes what the last `sf project retrieve` requested and returned — not what exists in the org. A type listed under `notModeled` is not analyzed by this product at all; its absence from any result means 'not checked', never 'none'. Re-run `/sfi-refresh` after widening your retrieve manifest to close a gap. `topUncoveredFamilies` ranks (by skipped-file volume) directories that WERE retrieved but not modeled by an extractor — a listed family is retrieved-but-not-modeled, never 'absent'.";

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
  /**
   * CR-CAP-20: top families (capped at 10) that were RETRIEVED but not
   * modeled by an extractor, ranked by skipped-file volume desc. Each
   * row carries the canonical `family` label (a `ComponentType` when the
   * raw dir maps to one, else the raw dir name), `rawDir`, `skippedFiles`,
   * and `modeledType`. Empty `[]` on a clean vault — never implies the
   * family is absent from the org.
   */
  readonly topUncoveredFamilies: readonly UncoveredFamily[];
  /**
   * ENGINE-ARC §6 — runtime assignment data (User rows, PermissionSetAssignment,
   * GroupMember). NOT a retrieve gap: these are runtime data objects excluded
   * from the vault BY DESIGN (live-first; the counts-only facts capture is the
   * only offline snapshot, PII-pinned to counts). This section names the
   * consent-gated live tools that answer those questions and whether an
   * offline counts snapshot exists.
   */
  readonly assignmentData: AssignmentDataCoverage;
  /**
   * AUDIT-F5 — recent reconciled-absent tombstones (confirmed source deletions).
   * Empty when none recorded; never invents deletions from a refused reconcile.
   */
  readonly tombstones: readonly TombstoneRecord[];
  readonly trust: TrustSummary;
  readonly disclosure: string;
}

/** The `assignmentData` section of {@link CoverageReportOutput}. */
export interface AssignmentDataCoverage {
  readonly vaultModeled: false;
  readonly reason: string;
  readonly liveTools: readonly string[];
  /** Whether the live plane may run for this org right now (consent/env). */
  readonly liveConsent: boolean;
  /** The P13-FACTS counts-only snapshot (`sfi refresh --with-data-shape`). */
  readonly factsCounts: {
    readonly present: boolean;
    readonly capturedAt: string | null;
  };
  /** One-line human rendering of the three facts above. */
  readonly rendered: string;
}

/** Verbatim `reason` for {@link AssignmentDataCoverage} — judge-consumed. */
export const ASSIGNMENT_DATA_NOT_A_GAP_REASON =
  'runtime data object — by design, not a retrieve gap';

/**
 * Build the assignmentData coverage section: facts-snapshot presence from the
 * ACTIVE_HOLDERS_COMPLETE_SUBJECT marker (counts-only capture) and live-plane
 * availability from the org's standing consent/env. Best-effort — a facts
 * table that cannot be read simply reports `present: false`.
 */
export const buildAssignmentDataCoverage = async (
  ctx: Context,
): Promise<AssignmentDataCoverage> => {
  let present = false;
  let capturedAt: string | null = null;
  try {
    const rows = await readFacts(ctx.graph, {
      subjectId: ACTIVE_HOLDERS_COMPLETE_SUBJECT,
      metric: 'activeHolders',
      limit: 1,
    });
    const marker = rows.ok ? rows.value[0] : undefined;
    if (
      marker !== undefined &&
      typeof marker.value === 'object' &&
      marker.value !== null &&
      (marker.value as { readonly complete?: unknown }).complete === true
    ) {
      present = true;
      capturedAt = marker.capturedAt;
    }
  } catch {
    // A missing/corrupt facts table must not fail the coverage report.
  }
  const liveConsent = (await probeLiveAccess(ctx)).allowed;
  return {
    vaultModeled: false,
    reason: ASSIGNMENT_DATA_NOT_A_GAP_REASON,
    liveTools: ASSIGNMENT_DATA_LIVE_TOOLS,
    liveConsent,
    factsCounts: { present, capturedAt },
    rendered:
      'Runtime assignment data: not in vault (by design). ' +
      `Live: ${liveConsent ? 'available' : 'consent-needed'} (${ASSIGNMENT_DATA_LIVE_TOOLS.join(', ')}). ` +
      `Offline counts snapshot: ${present && capturedAt !== null ? `as of ${capturedAt}` : 'none'}.`,
  };
};

// CR-P3-3: kept in deliberate lockstep with `summarizeCoverage`'s tri-state
// (manifest.ts). A confirmed-clean empty type (`retrieved === 0` AND
// `retrieveConfirmed === true`) moves from `partial` to `covered`; an
// unconfirmed empty type (no signal / dropped / --no-pull) stays in `partial`.
// Without this gate coverage_report would self-contradict summarizeCoverage
// (its own `partial[]` listing a type the summary calls complete) — the exact
// bug the lockstep comment in manifest.ts guards.
const partitionCoverage = (
  entries: readonly CoverageEntry[],
): Pick<CoverageReportOutput, 'covered' | 'partial' | 'notModeled' | 'pending'> => ({
  covered: entries.filter(
    (entry) =>
      entry.requested &&
      (entry.retrieved > 0 || entry.retrieveConfirmed === true) &&
      !entry.errored &&
      !entry.neverModeled &&
      entry.pending !== true,
  ),
  partial: entries.filter(
    (entry) =>
      entry.requested &&
      ((entry.retrieved === 0 && entry.retrieveConfirmed !== true) ||
        entry.errored) &&
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
  // CR-CAP-20: rank retrieved-but-not-modeled families and cap the list.
  // Inert ([]) when `skippedDirectories` is empty/absent (clean vault).
  const topUncoveredFamilies = rankUncoveredFamilies(ctx.manifest).slice(
    0,
    TOP_UNCOVERED_FAMILIES_CAP,
  );
  const assignmentData = await buildAssignmentDataCoverage(ctx);
  const involvedTypes =
    input.type === undefined ? undefined : ([input.type] as readonly string[]);
  const freshness = buildMixedFreshness(ctx.manifest, involvedTypes);
  const tombstones = await readTombstones(ctx.vaultRoot, 50);
  const mixedNote =
    freshness.overall === 'mixed'
      ? `Mixed family freshness: oldest evidence at ${freshness.oldestEvidenceAt ?? 'unknown'} — a scoped refresh left some families older than the vault-wide refreshedAt.`
      : null;

  return ok({
    data: {
      coverageKnown: summary.coverageKnown,
      coverageComputedAt: ctx.manifest.coverageComputedAt ?? null,
      ...partitions,
      ...(staged !== undefined
        ? { stagedBuild: { tier: staged.tier, totalTiers: staged.totalTiers } }
        : {}),
      summary,
      topUncoveredFamilies,
      assignmentData,
      tombstones,
      trust: {
        provenance: 'offline_snapshot',
        confidence: summary.coverageKnown ? 'declared' : 'unknown',
        freshness,
        completeness: {
          status: summary.status,
          ...(missingCoverage.length > 0 ? { missingCoverage } : {}),
        },
        limitations: [
          COVERAGE_DISCLOSURE,
          ...(mixedNote !== null ? [mixedNote] : []),
        ],
      },
      disclosure: COVERAGE_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
