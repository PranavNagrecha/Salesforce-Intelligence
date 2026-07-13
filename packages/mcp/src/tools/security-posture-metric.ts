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

import type { Context } from '../server.js';

import { permissionRiskReportHandler } from './synthesis-reports.js';

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
 * Returns `undefined` when the underlying report fails — snapshot create
 * must still succeed without metrics.
 */
export const captureSecurityPostureMetrics = async (
  ctx: Context,
): Promise<Readonly<Record<string, number>> | undefined> => {
  try {
    const perm = await permissionRiskReportHandler(ctx, { limit: 50 });
    if (!perm.ok) return undefined;
    return securityPostureMetricsFromFindingCount(
      perm.value.data.findings.length,
    );
  } catch {
    return undefined;
  }
};
