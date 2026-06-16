/**
 * sfi.org_scorecard — a graded (A–F) Well-Architected roll-up.
 *
 * Composes existing offline synthesis tools into one dimension-by-dimension
 * letter-graded scorecard (Code health, Test coverage, Security, Vault
 * completeness) plus an overall grade. Read-only; adds no new data — it grades
 * what `tech_debt_score`, `apex_test_coverage`, `permission_risk_report`, and
 * the coverage summary already compute. Each dimension degrades to `n/a` if its
 * sub-tool is unavailable, so the scorecard never crashes on a partial vault.
 */

import type { McpError, McpResponse, TrustSummary } from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import { mdTable } from '../answer-render.js';
import type { Context } from '../server.js';

import { apexTestCoverageHandler } from './apex-test-coverage.js';
import { offlineTrust } from './coverage-trust.js';
import { permissionRiskReportHandler } from './synthesis-reports.js';
import { techDebtScoreHandler } from './tech-debt-score.js';

export const orgScorecardInputSchema = z.object({});
export type OrgScorecardInput = z.infer<typeof orgScorecardInputSchema>;

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface ScorecardDimension {
  readonly name: string;
  readonly grade: Grade | 'n/a';
  /** 0–100 underlying score (null when n/a). */
  readonly score: number | null;
  readonly detail: string;
}
export interface OrgScorecardOutput {
  readonly overall: Grade | 'n/a';
  readonly gpa: number | null;
  readonly dimensions: readonly ScorecardDimension[];
  readonly trust: TrustSummary;
  readonly rendered: string;
}

const GPA: Record<Grade, number> = { A: 4, B: 3, C: 2, D: 1, F: 0 };
const gradeFromScore = (score: number): Grade =>
  score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
const gradeFromCount = (n: number): Grade =>
  n === 0 ? 'A' : n <= 2 ? 'B' : n <= 5 ? 'C' : n <= 10 ? 'D' : 'F';

const na = (name: string, why: string): ScorecardDimension => ({
  name,
  grade: 'n/a',
  score: null,
  detail: why,
});

export const orgScorecardHandler = async (
  ctx: Context,
  _input: OrgScorecardInput,
): Promise<Result<McpResponse<OrgScorecardOutput>, McpError>> => {
  const dimensions: ScorecardDimension[] = [];

  // 1. Code health — from the tech-debt band (higher debt → worse grade).
  const debt = await techDebtScoreHandler(ctx, {});
  if (debt.ok) {
    const band = String(debt.value.data.scoreBand);
    const grade: Grade = /critical/.test(band)
      ? 'F'
      : /high/.test(band)
        ? 'D'
        : /moderate|medium/.test(band)
          ? 'C'
          : /low/.test(band)
            ? 'B'
            : 'A';
    dimensions.push({
      name: 'Code health',
      grade,
      score: GPA[grade] * 25,
      detail: `tech-debt score ${debt.value.data.overallScore} (${band})`,
    });
  } else {
    dimensions.push(na('Code health', 'tech_debt_score unavailable'));
  }

  // 2. Test coverage — classes referenced by a test, over non-test classes.
  const cov = await apexTestCoverageHandler(ctx, {});
  if (cov.ok) {
    const s = cov.value.data.summary;
    const denom = Math.max(1, s.nonTestClasses);
    const pct = Math.round((s.classesWithTestReferences / denom) * 100);
    dimensions.push({
      name: 'Test coverage',
      grade: gradeFromScore(pct),
      score: pct,
      detail: `${s.classesWithTestReferences}/${s.nonTestClasses} non-test classes referenced by a test (${pct}%)`,
    });
  } else {
    dimensions.push(na('Test coverage', 'apex_test_coverage unavailable'));
  }

  // 3. Security — fewer permission-risk findings is better.
  const perm = await permissionRiskReportHandler(ctx, { limit: 50 });
  if (perm.ok) {
    const n = perm.value.data.findings.length;
    const grade = gradeFromCount(n);
    dimensions.push({
      name: 'Security',
      grade,
      score: GPA[grade] * 25,
      detail: `${n} permission-risk finding(s)`,
    });
  } else {
    dimensions.push(na('Security', 'permission_risk_report unavailable'));
  }

  // 4. Vault completeness — can we even trust the verdicts above?
  const coverage = summarizeCoverage(ctx.manifest);
  const completenessGrade: Grade =
    coverage.status === 'complete' ? 'A' : coverage.status === 'partial' ? 'C' : 'F';
  dimensions.push({
    name: 'Vault completeness',
    grade: completenessGrade,
    score: GPA[completenessGrade] * 25,
    detail: `coverage ${coverage.status}`,
  });

  // Overall — GPA across the graded dimensions.
  const graded = dimensions.filter((d): d is ScorecardDimension & { grade: Grade } => d.grade !== 'n/a');
  const gpa =
    graded.length === 0
      ? null
      : Math.round((graded.reduce((sum, d) => sum + GPA[d.grade], 0) / graded.length) * 100) / 100;
  const overall: Grade | 'n/a' =
    gpa === null
      ? 'n/a'
      : gpa >= 3.5 ? 'A' : gpa >= 2.5 ? 'B' : gpa >= 1.5 ? 'C' : gpa >= 0.5 ? 'D' : 'F';

  const trust = offlineTrust(ctx, { status: coverage.status });

  const table = mdTable(
    ['Dimension', 'Grade', 'Detail'],
    dimensions.map((d) => [d.name, d.grade, d.detail]),
  );
  const rendered = `## Org scorecard — overall **${overall}**${gpa !== null ? ` (GPA ${gpa})` : ''}\n\n${table}\n\n_Offline scorecard — grades what the vault already computes; partial coverage caps confidence._`;

  return ok({
    data: { overall, gpa, dimensions, trust, rendered },
    vaultState: { sourceTreeHash: ctx.manifest.sourceTreeHash, refreshedAt: ctx.manifest.refreshedAt },
  });
};
