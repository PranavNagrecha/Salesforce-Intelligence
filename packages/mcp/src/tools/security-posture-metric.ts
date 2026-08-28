/**
 * Capture-time security posture metric (R8-SECURITY-TREND).
 *
 * Reconstructs the graded Security dimension that used to live inside the
 * deleted `org_scorecard` tool — without resurrecting that tool. Grades come
 * from `permission_risk_report` finding count (fewer findings → better grade).
 * Persisted onto `SnapshotMeta.metrics` at snapshot-create / refresh
 * auto-capture so `sfi.trend({ metric: 'securityScore' })` can chart posture
 * across refreshes (scores cannot be recomputed from hash-only snapshot nodes).
 */

import { summarizeCoverage } from '@sf-intelligence/vault';

import type { Context } from '../server.js';

import { permissionRiskReportHandler } from './synthesis-reports.js';

/**
 * The metadata families `permissionRiskReportHandler`'s headline
 * (over-privilege) and CRUD/FLS sub-analyses actually read from. Scoped
 * deliberately narrow — NOT the whole-vault coverage surface — so a
 * permanently not-modeled family elsewhere in the org (ListView,
 * SessionSettings, …) never withholds this metric forever; only an
 * ACTIONABLE gap (a requested family that errored / never confirmed
 * retrieved) in a family this specific report depends on does.
 */
const SECURITY_POSTURE_REQUIRED_COVERAGE = [
  'Profile',
  'PermissionSet',
  'PermissionSetGroup',
  'ApexClass',
  'ApexTrigger',
] as const;

export type SecurityGradeLetter = 'A' | 'B' | 'C' | 'D' | 'F';

/** GPA scale matching the retired org_scorecard Security dimension. */
export const SECURITY_GRADE_GPA: Readonly<Record<SecurityGradeLetter, number>> =
  Object.freeze({ A: 4, B: 3, C: 2, D: 1, F: 0 });

/**
 * Letter grade from permission-risk finding count — identical thresholds to
 * the retired org_scorecard Security dimension.
 */
export const gradeFromFindingCount = (n: number): SecurityGradeLetter =>
  n === 0 ? 'A' : n <= 2 ? 'B' : n <= 5 ? 'C' : n <= 10 ? 'D' : 'F';

/**
 * Numeric metrics bag written to `SnapshotMeta.metrics`.
 * - `securityScore`: 0–100 (= GPA × 25)
 * - `securityGrade`: GPA 4/3/2/1/0 for A/B/C/D/F (`Record<string, number>`
 *   cannot store letter grades; trend consumers map back via GPA)
 */
export const securityPostureMetricsFromFindingCount = (
  findingCount: number,
): Readonly<Record<string, number>> => {
  const grade = gradeFromFindingCount(findingCount);
  const gpa = SECURITY_GRADE_GPA[grade];
  return {
    securityScore: gpa * 25,
    securityGrade: gpa,
  };
};

/**
 * Best-effort capture of security posture metrics for the current vault.
 * Returns `undefined` — a typed absence, never a graded zero — when the
 * underlying report fails outright, OR when it "succeeded" but ran on
 * metadata the report's own headline depends on that was not actually
 * retrieved. A finding COUNT derived from a coverage-degraded run is not a
 * proven zero: it was not checked, so it has no count (the same
 * `findingCount: null` law `ComposedAnalysis` encodes for composed
 * reports). Snapshot create must still succeed without metrics.
 */
export const captureSecurityPostureMetrics = async (
  ctx: Context,
): Promise<Readonly<Record<string, number>> | undefined> => {
  try {
    const perm = await permissionRiskReportHandler(ctx, { limit: 50 });
    if (!perm.ok) return undefined;

    // Coverage gate scoped to what this report reads (Profile / PermissionSet
    // / PermissionSetGroup / ApexClass / ApexTrigger — never the whole
    // manifest): none of these five is ever a permanently not-modeled family
    // for this product, so `missingCoverage` here means "not requested" or
    // "requested but errored / not confirmed retrieved" — either way, the
    // over-privilege / CRUD-FLS headline this metric grades was computed over
    // data that was not actually retrieved. Scoping to this list (rather than
    // reading the report's own whole-vault `trust.completeness`) is what
    // keeps this metric from being withheld forever by an UNRELATED
    // permanently-unmodeled family elsewhere in the vault (e.g. ListView).
    const coverage = summarizeCoverage(ctx.manifest, [
      ...SECURITY_POSTURE_REQUIRED_COVERAGE,
    ]);
    if (coverage.missingCoverage.length > 0) return undefined;

    // `auditTotals` is null iff the CRUD/FLS sub-analysis errored (its
    // findings never made it into `findings.length` at all) — the same
    // signal `permissionRiskReportHandler` already exposes for this failure
    // mode, unread until now.
    if (perm.value.data.auditTotals === null) return undefined;

    return securityPostureMetricsFromFindingCount(
      perm.value.data.findings.length,
    );
  } catch {
    return undefined;
  }
};
