/**
 * Deterministic enterprise synthesis reports (v4.0 R7).
 *
 * Each tool composes existing handlers — no duplicated graph logic.
 */

import type {
  ComponentId,
  Edge,
  McpError,
  McpResponse,
  Node,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  listEdges,
  listEdgesForNodes,
  listNodesByIds,
  listNodesByType,
} from '@sf-intelligence/graph';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { automationCollisionsHandler } from './automation-collisions.js';
import { offlineTrust } from './coverage-trust.js';
import {
  crudFlsAuditHandler,
  type CrudFlsAuditOutput,
} from './crud-fls-audit.js';
import { readActiveHoldersFor, type HoldersShape } from './facts-block.js';
import {
  governorLimitRisksHandler,
  type GovernorLimitRisksOutput,
} from './governor-limit-risks.js';
import { healthCheckHandler } from './health-check.js';
import { resolveExistingObjectScope } from './input-aliases.js';
import { namingConventionReportHandler } from './naming-convention-report.js';
import { expandPermissionSetGroup } from './permission-set-group.js';
import { collectPiiInventoryFields } from './pii-inventory.js';
import {
  processBuilderMigrationCandidatesHandler,
} from './process-builder-migration-candidates.js';
import {
  techDebtScoreHandler,
  type TechDebtScoreOutput,
} from './tech-debt-score.js';
import {
  unassignedPermissionSetsHandler,
} from './unassigned-permission-sets.js';
import {
  unusedFieldsDeepHandler,
  type UnusedFieldCleanupFinding,
  type UnusedFieldsDeepOutput,
} from './unused-fields-deep.js';

const synthesisInputSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
});

export type SynthesisInput = z.infer<typeof synthesisInputSchema>;

/**
 * Extended input schema for `sfi.field_cleanup_candidates`.  Accepts the
 * same `limit` as the generic synthesis schema plus optional object-scope
 * parameters: `objectId` (canonical `CustomObject:{ApiName}` or bare name),
 * and the `objectApiName` synonym (bare name only).
 */
export const fieldCleanupCandidatesInputSchema = synthesisInputSchema.extend({
  objectId: z.string().min(1).optional(),
  /** Synonym for objectId — accepts a bare object api name (`Contact`). */
  objectApiName: z.string().min(1).optional(),
});

export type FieldCleanupCandidatesInput = z.infer<
  typeof fieldCleanupCandidatesInputSchema
>;
/**
 * `sfi.org_risk_report` accepts the generic `limit` plus an optional `gate`
 * deploy-gate MODE (STEP-2: absorbed from the retired `release_readiness_report`).
 * When `gate: true`, the output additionally carries `ready` + `blockers` — the
 * critical-severity findings plus any ACTIONABLE coverage gap (a requested
 * metadata type that errored during retrieve) — so a caller can treat the org
 * risk synthesis as a go/no-go release gate.
 */
export const orgRiskReportInputSchema = synthesisInputSchema.extend({
  gate: z.boolean().optional(),
});
export type OrgRiskReportInput = z.infer<typeof orgRiskReportInputSchema>;
/**
 * `sfi.automation_risk_report` accepts the generic `limit` plus an optional
 * OBJECT SCOPE (AUTOMATION-RISK-REPORT-IGNORES-OBJECT-SCOPE). The report
 * composes two sub-analyses: legacy-automation migration candidates (Process
 * Builders — parented to an object) and governor-limit findings (Apex classes —
 * NOT object-attributable). When an object is named the report is HONORED by
 * narrowing the legacy-automation half to that object; the Apex governor-limit
 * half is EXCLUDED from the object-scoped view (it is org-wide, not attributable
 * to one object) and that exclusion is disclosed — never silently returning the
 * org-wide report. Accepts the interchangeable object identifiers.
 *
 * `mode` (AUTOMATION-SPRAWL-MODE) selects the report shape. The default
 * (`undefined` / `'risk'`) is the per-finding risk synthesis above, byte-for-byte
 * unchanged. `'sprawl'` switches to an ORG-WIDE, per-OBJECT automation-density
 * ranking — a prioritized candidate queue ("where is automation sprawl worst
 * first"), not a graded verdict. Sprawl mode is always org-wide, so the object
 * scope params do not apply to it.
 */
export const automationRiskReportInputSchema = synthesisInputSchema.extend({
  objectApiName: z.string().min(1).optional(),
  object: z.string().min(1).optional(),
  objectId: z.string().min(1).optional(),
  componentId: z.string().min(1).optional(),
  mode: z.enum(['risk', 'sprawl']).optional(),
});
export type AutomationRiskReportInput = z.infer<
  typeof automationRiskReportInputSchema
>;
/**
 * `sfi.permission_risk_report` accepts the generic `limit` plus an optional
 * `profileFilter` — a Profile api name / label to SCOPE the report to one
 * profile. The filter is HONORED: when the named profile does not exist in the
 * vault the report STOPS with a `profile not found` result (empty findings +
 * an explicit caveat naming the closest existing profile) rather than silently
 * dropping the filter and dumping the full org-wide report. Accepts a bare
 * name (`Custom: Sales`) or a canonical `Profile:<ApiName>` id.
 */
export const permissionRiskReportInputSchema = synthesisInputSchema.extend({
  profileFilter: z.string().min(1).optional(),
});
export const releaseReadinessReportInputSchema = synthesisInputSchema;

export type PermissionRiskReportInput = z.infer<
  typeof permissionRiskReportInputSchema
>;

export interface RankedFinding {
  readonly rank: number;
  readonly severity: 'critical' | 'high' | 'medium' | 'low';
  readonly category: string;
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly confidence: TrustSummary['confidence'];
}

interface SynthesisBase {
  readonly findings: readonly RankedFinding[];
  readonly trust: TrustSummary;
  readonly disclosure: string;
}

const SYNTHESIS_DISCLOSURE =
  'Synthesis reports rank offline vault evidence only unless a live tool was composed. Re-run /sfi-refresh and check sfi.coverage_report before acting on absence-based findings.';

const rankSeverity = (
  severity: RankedFinding['severity'],
): number => {
  switch (severity) {
    case 'critical':
      return 4;
    case 'high':
      return 3;
    case 'medium':
      return 2;
    default:
      return 1;
  }
};

const sortFindings = (
  findings: readonly RankedFinding[],
): readonly RankedFinding[] =>
  [...findings]
    .sort(
      (a, b) =>
        rankSeverity(b.severity) - rankSeverity(a.severity) ||
        a.category.localeCompare(b.category),
    )
    .map((finding, index) => ({ ...finding, rank: index + 1 }));

const coverageTrust = (ctx: Context): TrustSummary => {
  const summary = summarizeCoverage(ctx.manifest);
  const completeness: TrustSummary['completeness'] =
    summary.missingCoverage.length > 0
      ? { status: summary.status, missingCoverage: summary.missingCoverage }
      : { status: summary.status };
  return offlineTrust(ctx, completeness);
};

// ---------------------------------------------------------------------------
// sfi.org_risk_report
// ---------------------------------------------------------------------------

/** Headline permission-risk roster composed into the org-risk synthesis. */
export interface OrgRiskPermissionSummary {
  readonly overPrivilegedGrantorCount: number;
  readonly modifyAllDataGrantorCount: number;
  readonly viewAllDataGrantorCount: number;
}

/** PII exposure headline from the offline inventory recognizer. */
export interface OrgRiskPiiSummary {
  readonly regulatedFieldCount: number;
  readonly piiCount: number;
  readonly sensitiveCount: number;
}

export interface OrgRiskReportOutput extends SynthesisBase {
  /** Full tech-debt breakdown for drill-down; see also ranked `findings`. */
  readonly techDebt: TechDebtScoreOutput | null;
  readonly healthIssueCount: number;
  readonly permissionRisk: OrgRiskPermissionSummary | null;
  readonly piiExposure: OrgRiskPiiSummary | null;
  /**
   * Deploy-gate verdict — present ONLY in `gate: true` MODE (STEP-2: absorbed
   * from the retired `release_readiness_report`). `true` when there are no
   * blockers. Absent on a plain (non-gate) call so that output is unchanged.
   */
  readonly ready?: boolean;
  /**
   * The blocking conditions — critical-severity findings plus any ACTIONABLE
   * coverage gap (a requested metadata type that errored during retrieve).
   * Present ONLY in `gate: true` MODE. NOT-modeled families are NEVER blockers
   * (they are a permanent product limitation, disclosed via `trust`).
   */
  readonly blockers?: readonly string[];
}

export const orgRiskReportHandler = async (
  ctx: Context,
  input: OrgRiskReportInput,
): Promise<Result<McpResponse<OrgRiskReportOutput>, McpError>> => {
  const limit = input.limit ?? 50;
  const findings: RankedFinding[] = [];

  const health = await healthCheckHandler(ctx, {});
  if (!health.ok) return health;
  const { issues, status } = health.value.data;
  for (const issue of issues.slice(0, limit)) {
    findings.push({
      rank: 0,
      severity: status === 'unhealthy' ? 'critical' : 'high',
      category: 'vault-health',
      summary: issue,
      evidence: ['health-check'],
      confidence: 'declared',
    });
  }

  const debt = await techDebtScoreHandler(ctx, {});
  let techDebt: TechDebtScoreOutput | null = null;
  if (debt.ok) {
    techDebt = debt.value.data;
    findings.push({
      rank: 0,
      severity:
        techDebt.scoreBand === 'critical-debt'
          ? 'critical'
          : techDebt.scoreBand === 'high-debt'
            ? 'high'
            : 'medium',
      category: 'tech-debt',
      summary: `Org tech debt score ${techDebt.overallScore} (${techDebt.scoreBand})`,
      evidence: techDebt.excludedCategories.map((c) => `excluded:${c.category}`),
      confidence: 'heuristic',
    });
  }

  const coverage = summarizeCoverage(ctx.manifest);
  if (coverage.status !== 'complete') {
    const coverageEvidence = [
      ...coverage.missingCoverage,
      ...coverage.partialTypes.map((t) => `partial:${t}`),
    ];
    findings.push({
      rank: 0,
      severity: coverage.partialTypes.length > 0 ? 'critical' : 'high',
      category: 'coverage',
      summary:
        coverage.partialTypes.length > 0
          ? `Vault coverage is ${coverage.status} — retrieve failed for: ${coverage.partialTypes.join(', ')}`
          : `Vault coverage is ${coverage.status}`,
      evidence: coverageEvidence,
      confidence: 'declared',
    });
  }

  // Permission-risk synthesis — over-privilege is the headline security gap.
  let permissionRisk: OrgRiskPermissionSummary | null = null;
  const permRisk = await permissionRiskReportHandler(ctx, { limit });
  if (permRisk.ok) {
    const { privilege, findings: permFindings } = permRisk.value.data;
    permissionRisk = {
      overPrivilegedGrantorCount: privilege.overPrivilegedGrantorCount,
      modifyAllDataGrantorCount: privilege.modifyAllDataGrantors.length,
      viewAllDataGrantorCount: privilege.viewAllDataGrantors.length,
    };
    for (const finding of permFindings.slice(0, limit)) {
      findings.push(finding);
    }
    if (privilege.overPrivilegedGrantorCount > 0) {
      findings.push({
        rank: 0,
        severity: permFindings.some((f) => f.severity === 'critical')
          ? 'critical'
          : 'high',
        category: 'permission-risk',
        summary:
          `${privilege.overPrivilegedGrantorCount} over-privileged profile(s) / ` +
          `permission set(s) — ${privilege.modifyAllDataGrantors.length} with ` +
          `ModifyAllData, ${privilege.viewAllDataGrantors.length} with ViewAllData`,
        evidence: [
          ...privilege.modifyAllDataGrantors.slice(0, 5),
          ...privilege.viewAllDataGrantors.slice(0, 5),
        ],
        confidence: 'declared',
      });
    }
  }

  // PII exposure synthesis — regulated-field inventory from the offline recognizer.
  let piiExposure: OrgRiskPiiSummary | null = null;
  const pii = await collectPiiInventoryFields(ctx, { classification: 'all' });
  if (pii.ok) {
    const regulated = pii.value.fields.filter(
      (f) => f.classification === 'pii' || f.classification === 'sensitive',
    );
    const piiCount = pii.value.fields.filter((f) => f.classification === 'pii').length;
    const sensitiveCount = pii.value.fields.filter(
      (f) => f.classification === 'sensitive',
    ).length;
    piiExposure = {
      regulatedFieldCount: regulated.length,
      piiCount,
      sensitiveCount,
    };
    if (regulated.length > 0) {
      const topExamples = regulated.slice(0, 5).map((f) => f.id);
      findings.push({
        rank: 0,
        severity: sensitiveCount > 0 ? 'high' : 'medium',
        category: 'pii-exposure',
        summary:
          `${regulated.length} regulated field(s) in vault ` +
          `(${piiCount} pii, ${sensitiveCount} sensitive) — run ` +
          `sfi.field_access_audit per field for FLS exposure`,
        evidence: topExamples,
        confidence: 'heuristic',
      });
    }
  }

  // Tech-debt axes excluded from the score but carrying assignment-unknown signal.
  if (techDebt !== null) {
    const unassignedExcluded = techDebt.excludedCategories.find(
      (e) => e.category === 'unassignedGrants',
    );
    const unknownCount =
      techDebt.categories.unassignedGrants.details
        .unknownAssignmentPermissionSetsCount ?? 0;
    if (unassignedExcluded !== undefined && unknownCount > 0) {
      findings.push({
        rank: 0,
        severity: 'high',
        category: 'assignment-unknown',
        summary:
          `${unknownCount} permission set(s) have unknown user-assignment ` +
          `status — tooling API enrichment did not run; run ` +
          `\`sfi refresh --classify-permissions\``,
        evidence: [unassignedExcluded.note],
        confidence: 'declared',
      });
    }
  }

  const sortedFindings = sortFindings(findings);

  // STEP-2 gate MODE (absorbed from release_readiness_report). Emit the
  // deploy-gate verdict ONLY when the caller opts in with `gate: true`, so a
  // plain org_risk_report response is byte-unchanged. Block on critical findings
  // + ACTIONABLE coverage gaps (a requested type that ERRORED during retrieve),
  // NEVER on not-modeled families — those are a permanent product limitation and
  // would keep `ready` false for every vault; they stay disclosed via `trust`.
  let gate: { ready: boolean; blockers: string[] } | undefined;
  if (input.gate === true) {
    const blockers: string[] = [];
    for (const finding of sortedFindings) {
      if (finding.severity === 'critical') blockers.push(finding.summary);
    }
    if (coverage.partialTypes.length > 0) {
      blockers.push(
        `Incomplete vault coverage — requested metadata failed retrieve: ${coverage.partialTypes.join(', ')}. Re-run /sfi-refresh.`,
      );
    }
    gate = { ready: blockers.length === 0, blockers };
  }

  return ok({
    data: {
      findings: sortedFindings,
      techDebt,
      healthIssueCount: issues.length,
      permissionRisk,
      piiExposure,
      trust: coverageTrust(ctx),
      disclosure: SYNTHESIS_DISCLOSURE,
      ...(gate !== undefined ? { ready: gate.ready, blockers: gate.blockers } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

// ---------------------------------------------------------------------------
// sfi.field_cleanup_candidates — HIDDEN back-compat alias (STEP-2)
//
// The ranked cleanup roster (findings + report/dashboard caveat + 36 KB
// findings+fields trim) folded into `unused_fields_deep`'s `format: 'cleanup'`
// MODE, so the survivor owns the preserved projection. This is now a THIN alias
// forwarding the object-scope params with `format: 'cleanup'`. Un-advertised on
// tools/list, dispatchable by name / run_analysis.
// ---------------------------------------------------------------------------

/**
 * The cleanup output the (hidden) field_cleanup alias returns. `format: 'cleanup'`
 * always populates `findings` + `disclosure`, redeclared here as required (they
 * are optional on the base `UnusedFieldsDeepOutput`).
 */
export interface FieldCleanupCandidatesOutput extends UnusedFieldsDeepOutput {
  readonly findings: readonly UnusedFieldCleanupFinding[];
  readonly disclosure: string;
}

export const fieldCleanupCandidatesHandler = async (
  ctx: Context,
  input: FieldCleanupCandidatesInput,
): Promise<Result<McpResponse<FieldCleanupCandidatesOutput>, McpError>> => {
  // Forward the object-scope params (objectId / objectApiName) + `limit` with
  // `format: 'cleanup'`. Deliberately does NOT pass `staticOnly` — the
  // user-facing cleanup view keeps unused_fields_deep's live-population
  // enrichment (bounded by LIVE_CROSS_CHECK_CAP, so no 60s-timeout risk).
  const r = await unusedFieldsDeepHandler(ctx, {
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.objectId !== undefined ? { objectId: input.objectId } : {}),
    ...(input.objectApiName !== undefined
      ? { objectApiName: input.objectApiName }
      : {}),
    format: 'cleanup',
  });
  // `format: 'cleanup'` guarantees findings + disclosure are populated.
  return r as Result<McpResponse<FieldCleanupCandidatesOutput>, McpError>;
};

// ---------------------------------------------------------------------------
// sfi.automation_risk_report
// ---------------------------------------------------------------------------

export interface AutomationRiskReportOutput extends SynthesisBase {
  readonly governorClasses: GovernorLimitRisksOutput['classes'] | null;
  /**
   * Present ONLY on an object-scoped call
   * (AUTOMATION-RISK-REPORT-IGNORES-OBJECT-SCOPE) — echoes the object the
   * legacy-automation half was narrowed to so a host never reads a scoped
   * answer as org-wide. Absent on the bare call, keeping that response
   * byte-identical. `object` is the canonical `CustomObject:` id; `mode` is
   * always `component` when present.
   */
  readonly appliedScope?: {
    readonly object: string;
    readonly mode: 'component';
  };
  /**
   * Discriminant for AUTOMATION-SPRAWL-MODE. Present (`'sprawl'`) ONLY on a
   * `mode: 'sprawl'` call; ABSENT on the default/risk call so that response
   * stays byte-identical. When present, `findings` is `[]`, `governorClasses`
   * is `null`, and the per-object density ranking lives in `sprawl`.
   */
  readonly mode?: 'sprawl';
  /**
   * The org-wide per-OBJECT automation-density ranking. Present ONLY in
   * `mode: 'sprawl'`. A prioritized CANDIDATE QUEUE ("review these objects
   * first"), NOT a graded verdict — every number is a heuristic ranking signal.
   */
  readonly sprawl?: SprawlBlock;
  /** Verbatim honesty disclosures for the sprawl ranking. Present ONLY in `mode: 'sprawl'`. */
  readonly boundaries?: readonly string[];
}

/** The per-signal automation counts that feed one object's density score. */
export interface SprawlObjectSignals {
  /** Record-triggered Flows firing on the object (inbound `triggersOn`). */
  readonly recordTriggeredFlows: number;
  /** ApexTriggers on the object (inbound `triggersOn`). */
  readonly apexTriggers: number;
  /** WorkflowRules on the object (inbound `triggersOn`). */
  readonly workflowRules: number;
  /** Process Builders (Flow `processType` Workflow) parented to the object. */
  readonly processBuilders: number;
  /**
   * Fields with 2+ distinct automations writing them (from the
   * `automation_collisions` engine). 0 when the object was not collision-scanned
   * (see `collisionScanned`).
   */
  readonly fieldWriteCollisions: number;
  /**
   * Count of the object's naming conventions (prefix/suffix/casing) that have
   * deviating fields, capped at 3 — a minor field-hygiene nudge from
   * `get_naming_convention_report`.
   */
  readonly namingInconsistencies: number;
}

/** One ranked object in the sprawl candidate queue. */
export interface SprawlCandidate {
  readonly rank: number;
  readonly objectId: ComponentId;
  readonly objectApiName: string;
  /** The weighted density composite (see {@link SprawlBlock.scoreBasis}). */
  readonly densityScore: number;
  readonly signals: SprawlObjectSignals;
  /**
   * TRUE when the field-write-collision engine actually ran for this object.
   * Collisions are computed only for the densest objects (2+ record-triggered
   * firers, capped); elsewhere `signals.fieldWriteCollisions` is a floor of 0.
   */
  readonly collisionScanned: boolean;
}

/** The disclosed weighting behind the density score — never a black-box number. */
export interface SprawlScoreBasis {
  readonly weights: {
    readonly recordTriggeredFlow: number;
    readonly apexTrigger: number;
    readonly workflowRule: number;
    readonly processBuilder: number;
    readonly fieldWriteCollision: number;
    readonly namingInconsistency: number;
  };
  /** Human-readable formula the weights plug into. */
  readonly formula: string;
  /** Confidence-tier note for the density counts (the honesty axis). */
  readonly confidenceNote: string;
}

/** The sprawl-mode payload: ranked candidates + the disclosed score basis. */
export interface SprawlBlock {
  /** Objects ranked worst-first, capped at `limit`. */
  readonly candidates: readonly SprawlCandidate[];
  readonly scoreBasis: SprawlScoreBasis;
  readonly scanned: {
    /** CustomObject nodes scanned (bounded by the graph list cap). */
    readonly objects: number;
    /** Objects with any automation density (score > 0) — the full ranked set before `limit`. */
    readonly objectsRanked: number;
    /** Objects the collision engine actually ran for. */
    readonly objectsCollisionScanned: number;
    /** TRUE when the CustomObject scan hit its node cap. */
    readonly objectScanTruncated: boolean;
    /** TRUE when the Flow scan (Process Builder detection) hit its node cap. */
    readonly flowScanTruncated: boolean;
    /** TRUE when more objects qualified for collision scanning than the cap allowed. */
    readonly collisionScanCapped: boolean;
  };
}

export const automationRiskReportHandler = async (
  ctx: Context,
  input: AutomationRiskReportInput,
): Promise<Result<McpResponse<AutomationRiskReportOutput>, McpError>> => {
  // AUTOMATION-SPRAWL-MODE: a fully separate early return so the risk path below
  // is byte-for-byte untouched. Only `mode: 'sprawl'` diverts here; `undefined`
  // and `'risk'` fall through to the unchanged per-finding risk synthesis.
  if (input.mode === 'sprawl') {
    return automationSprawlReport(ctx, input);
  }

  const limit = input.limit ?? 50;
  const findings: RankedFinding[] = [];

  // AUTOMATION-RISK-REPORT-IGNORES-OBJECT-SCOPE: resolve the optional object
  // scope (and verify it exists). `null` = bare org-wide call (byte-identical);
  // a resolved scope narrows the legacy-automation half to that object; an
  // unresolvable / absent object → `invalid-query`.
  const scopeResult = await resolveExistingObjectScope(ctx.graph, input);
  if (!scopeResult.ok) return err(scopeResult.error);
  const scope = scopeResult.value;

  // Legacy-automation half: Process Builders are parented to an object, so it
  // narrows honestly. Forward the object scope to the composed sub-handler when
  // scoped (it re-resolves + filters by `parentObjectId`).
  const pb = await processBuilderMigrationCandidatesHandler(ctx, {
    limit,
    ...(scope !== null ? { componentId: scope.componentId } : {}),
  });
  if (pb.ok) {
    for (const item of pb.value.data.processBuilders.slice(0, limit)) {
      findings.push({
        rank: 0,
        severity: 'high',
        category: 'legacy-automation',
        summary: `Process Builder ${item.id} is a migration candidate`,
        evidence: [item.apiName],
        confidence: 'declared',
      });
    }
  }

  // Governor-limit half: findings live in Apex classes, which are NOT
  // attributable to a single object. Under an object scope they are EXCLUDED
  // (returning them scoped-to-an-object would be a lie) and the exclusion is
  // disclosed; a bare call keeps them exactly as before.
  let governorClasses: GovernorLimitRisksOutput['classes'] | null = null;
  if (scope === null) {
    const gov = await governorLimitRisksHandler(ctx, { limit });
    if (gov.ok) {
      governorClasses = gov.value.data.classes;
      for (const entry of governorClasses.slice(0, limit)) {
        for (const risk of entry.risks) {
          findings.push({
            rank: 0,
            severity: risk.severity === 'critical' ? 'critical' : 'high',
            category: 'governor-limit',
            summary: `${entry.apiName}: ${risk.rule}`,
            evidence: [entry.componentId, risk.location],
            confidence: 'heuristic',
          });
        }
      }
    }
  }

  const disclosure =
    scope === null
      ? SYNTHESIS_DISCLOSURE
      : `Scoped to ${scope.componentId}: only legacy automation (Process Builders) parented to this object is shown. ` +
        'Governor-limit findings live in Apex classes, which are not attributable to a single object, so they are ' +
        'EXCLUDED from this object-scoped view — run sfi.governor_limit_risks (org-wide or per-class), or the bare ' +
        `automation_risk_report, for those. ${SYNTHESIS_DISCLOSURE}`;

  return ok({
    data: {
      // appliedScope FIRST + only when scoped, so a bare call omits the whole
      // block and its serialized response stays byte-identical to pre-fix.
      ...(scope !== null
        ? { appliedScope: { object: scope.componentId, mode: 'component' as const } }
        : {}),
      findings: sortFindings(findings),
      governorClasses,
      trust: coverageTrust(ctx),
      disclosure,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

// ---------------------------------------------------------------------------
// sfi.automation_risk_report — mode: 'sprawl' (org-wide density triage)
//
// The org-wide per-OBJECT roll-up the three single-object automation tools
// (automation_collisions / automation_build_advisor / order_of_execution) lack:
// "where is automation sprawl worst FIRST". It reuses their raw signals —
// inbound `triggersOn` firer counts, parented Process Builders, the
// automation_collisions field-write-collision engine, and the naming-convention
// recognizer — into ONE ranked candidate queue. It is a TRIAGE heuristic, not a
// graded verdict; every number is disclosed via `scoreBasis` + `boundaries`.
// ---------------------------------------------------------------------------

/**
 * Disclosed weights for the density composite. Never a black-box number — the
 * exact per-signal weight ships in `scoreBasis.weights`. Field-write collisions
 * carry the highest weight (they are the sharpest silent-data-loss hazard);
 * naming inconsistency is the lowest (a minor field-hygiene nudge).
 */
const SPRAWL_WEIGHTS = Object.freeze({
  recordTriggeredFlow: 3,
  apexTrigger: 3,
  workflowRule: 2,
  processBuilder: 2,
  fieldWriteCollision: 4,
  namingInconsistency: 1,
});

/** Bounded scan caps — the graph list cap for node scans, and a collision-scan budget. */
const SPRAWL_OBJECT_SCAN_CAP = 500;
const SPRAWL_FLOW_SCAN_CAP = 500;
/** Only the densest objects get the (heavier) field-write-collision walk. */
const SPRAWL_MAX_COLLISION_SCANS = 40;
/** Default number of ranked candidates returned. */
const SPRAWL_DEFAULT_LIMIT = 50;
/** Naming-inconsistency sub-signal is capped so field hygiene can't outrank real automation stacking. */
const SPRAWL_NAMING_CAP = 3;

/** Verbatim honesty disclosures for the sprawl ranking. */
const SPRAWL_BOUNDARIES: readonly string[] = Object.freeze([
  'The sprawl density score is a TRIAGE HEURISTIC for ordering objects to review FIRST — not a defect count and not a proven-broken verdict. A high-ranked object is a candidate for review, not a confirmed problem.',
  'Inactive / obsolete Flow versions are NOT counted: a source-format retrieve carries only the latest saved Flow version, so superseded/inactive versions are invisible here and never inflate a score.',
  'Managed-package automation may be UNDER-counted: namespaced Flows/triggers a source retrieve omits, and Process Builders the vault could not attribute to an object (null parent), do not contribute to that object\'s density.',
  'Only automation families the last refresh actually retrieved are counted (coverage floor). A family missing from sfi.coverage_report contributes zero, so a low score can mean "not retrieved," not "no automation" — re-run /sfi-refresh and check coverage before acting.',
  'Density counts come from `triggersOn` / `writesTo` edges (mostly declared / parsed confidence); the field-write-collision sub-signal reuses sfi.automation_collisions, whose Apex-trigger writes are heuristic static analysis while Flow / WorkflowRule writes are parsed from declared XML.',
]);

/** The sprawl-mode disclosure, prepended to the shared synthesis disclosure. */
const SPRAWL_DISCLOSURE =
  'Automation-sprawl mode ranks OBJECTS org-wide by an automation-density composite so you can see where automation is thickest FIRST — a prioritized candidate queue for review, not a graded verdict that these objects are broken. The composite is a heuristic RANKING signal, not a correctness verdict; disclosed weights are in scoreBasis. Object-scope parameters do not apply in sprawl mode (it is always org-wide). ' +
  SYNTHESIS_DISCLOSURE;

/** Intermediate per-object firer tally, before the composite score is computed. */
interface SprawlRow {
  readonly objectId: ComponentId;
  readonly apiName: string;
  readonly recordTriggeredFlows: number;
  readonly apexTriggers: number;
  readonly workflowRules: number;
  readonly processBuilders: number;
  readonly namingInconsistencies: number;
  /** triggersOn firers only (flows + triggers + workflow rules) — the collision-scan gate. */
  readonly triggersOnFirers: number;
}

/**
 * `sfi.automation_risk_report` `mode: 'sprawl'` — the org-wide, per-OBJECT
 * automation-density ranking. See the section header for composition + honesty.
 * Object-scope input is intentionally IGNORED (sprawl is always org-wide).
 */
const automationSprawlReport = async (
  ctx: Context,
  input: AutomationRiskReportInput,
): Promise<Result<McpResponse<AutomationRiskReportOutput>, McpError>> => {
  const limit = input.limit ?? SPRAWL_DEFAULT_LIMIT;
  const fail = (m: string): Result<never, McpError> =>
    err({ kind: 'internal', message: `graph query failed: ${m}` });

  // 1) Every CustomObject (bounded scan).
  const objectsRes = await listNodesByType(ctx.graph, 'CustomObject', {
    limit: SPRAWL_OBJECT_SCAN_CAP,
  });
  if (!objectsRes.ok) return fail(objectsRes.error.message);
  const objects = objectsRes.value;
  const objectScanTruncated = objects.length >= SPRAWL_OBJECT_SCAN_CAP;
  const objectIds = objects.map((o) => o.id);

  // 2) Inbound `triggersOn` firers per object — ONE batched round-trip (the
  //    automation_build_advisor / automation_collisions edge family).
  const inEdges = await listEdgesForNodes(ctx.graph, objectIds, {
    direction: 'in',
    edgeTypes: ['triggersOn'],
  });
  if (!inEdges.ok) return fail(inEdges.error.message);

  // 3) ONE batched node fetch of every firer, to read its type.
  const firerIdSet = new Set<ComponentId>();
  for (const edges of inEdges.value.values()) {
    for (const e of edges) firerIdSet.add(e.fromId);
  }
  const firerNodesRes = await listNodesByIds(ctx.graph, [...firerIdSet]);
  if (!firerNodesRes.ok) return fail(firerNodesRes.error.message);
  const firerTypeById = new Map<ComponentId, Node['type']>();
  for (const n of firerNodesRes.value) firerTypeById.set(n.id, n.type);

  // 4) Process Builders (Flow processType Workflow) grouped by parent object.
  //    These emit NO `triggersOn` edge (the Flow extractor only edges the three
  //    RECORD trigger types), so counting them by parentId never double-counts
  //    the record-triggered Flow firers above.
  const flowsRes = await listNodesByType(ctx.graph, 'Flow', {
    limit: SPRAWL_FLOW_SCAN_CAP,
  });
  if (!flowsRes.ok) return fail(flowsRes.error.message);
  const flowScanTruncated = flowsRes.value.length >= SPRAWL_FLOW_SCAN_CAP;
  const processBuilderByObject = new Map<ComponentId, number>();
  for (const flow of flowsRes.value) {
    if (flow.properties['processType'] !== 'Workflow') continue;
    if (flow.parentId === null) continue;
    processBuilderByObject.set(
      flow.parentId,
      (processBuilderByObject.get(flow.parentId) ?? 0) + 1,
    );
  }

  // 5) Naming-inconsistency sub-signal — ONE org-wide naming-convention report
  //    (reuse, not a re-scan). Per object: how many of its dominant conventions
  //    (prefix/suffix/casing) have deviating fields.
  const namingByObject = new Map<ComponentId, number>();
  const naming = await namingConventionReportHandler(ctx, {});
  if (naming.ok) {
    for (const obs of naming.value.data.observations) {
      if (obs.kind !== 'naming-convention') continue;
      if (obs.evidence.matching >= obs.evidence.total) continue; // fully consistent
      const m = /^CustomField:([^.]+)/.exec(obs.scope);
      if (m === null) continue;
      const objectId = `CustomObject:${m[1] as string}` as ComponentId;
      namingByObject.set(objectId, (namingByObject.get(objectId) ?? 0) + 1);
    }
  }

  // 6) Per-object firer tallies.
  const rows: SprawlRow[] = objects.map((obj) => {
    let recordTriggeredFlows = 0;
    let apexTriggers = 0;
    let workflowRules = 0;
    for (const e of inEdges.value.get(obj.id) ?? []) {
      const t = firerTypeById.get(e.fromId);
      if (t === 'Flow') recordTriggeredFlows += 1;
      else if (t === 'ApexTrigger') apexTriggers += 1;
      else if (t === 'WorkflowRule') workflowRules += 1;
    }
    return {
      objectId: obj.id,
      apiName: obj.apiName,
      recordTriggeredFlows,
      apexTriggers,
      workflowRules,
      processBuilders: processBuilderByObject.get(obj.id) ?? 0,
      namingInconsistencies: Math.min(
        namingByObject.get(obj.id) ?? 0,
        SPRAWL_NAMING_CAP,
      ),
      triggersOnFirers: recordTriggeredFlows + apexTriggers + workflowRules,
    };
  });

  // 7) Field-write collisions for the densest objects only (the walk is heavy);
  //    a collision needs 2+ distinct triggersOn writers, so objects below that
  //    floor are skipped with a collisionCount of 0. Reuse the automation_collisions
  //    engine rather than re-implementing its writesTo bucketing.
  const collisionCandidates = rows
    .filter((r) => r.triggersOnFirers >= 2)
    .sort(
      (a, b) =>
        b.triggersOnFirers - a.triggersOnFirers ||
        (a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0),
    );
  const collisionScanCapped =
    collisionCandidates.length > SPRAWL_MAX_COLLISION_SCANS;
  const collisionByObject = new Map<ComponentId, number>();
  const collisionScannedSet = new Set<ComponentId>();
  for (const r of collisionCandidates.slice(0, SPRAWL_MAX_COLLISION_SCANS)) {
    collisionScannedSet.add(r.objectId);
    const coll = await automationCollisionsHandler(ctx, { object: r.apiName });
    // Resilient: a per-object failure leaves the count at its 0 floor rather
    // than failing the whole ranking.
    collisionByObject.set(
      r.objectId,
      coll.ok ? coll.value.data.summary.fieldsWithMultipleWriters : 0,
    );
  }

  // 8) Composite score. Keep only objects with ANY automation density (>0) —
  //    an object with zero automation is not a sprawl candidate.
  const scored = rows
    .map((r) => {
      const fieldWriteCollisions = collisionByObject.get(r.objectId) ?? 0;
      const densityScore =
        r.recordTriggeredFlows * SPRAWL_WEIGHTS.recordTriggeredFlow +
        r.apexTriggers * SPRAWL_WEIGHTS.apexTrigger +
        r.workflowRules * SPRAWL_WEIGHTS.workflowRule +
        r.processBuilders * SPRAWL_WEIGHTS.processBuilder +
        fieldWriteCollisions * SPRAWL_WEIGHTS.fieldWriteCollision +
        r.namingInconsistencies * SPRAWL_WEIGHTS.namingInconsistency;
      return { r, fieldWriteCollisions, densityScore };
    })
    .filter((s) => s.densityScore > 0)
    .sort((a, b) => {
      if (b.densityScore !== a.densityScore) return b.densityScore - a.densityScore;
      const aAuto =
        a.r.triggersOnFirers + a.r.processBuilders;
      const bAuto =
        b.r.triggersOnFirers + b.r.processBuilders;
      if (bAuto !== aAuto) return bAuto - aAuto;
      return a.r.objectId < b.r.objectId ? -1 : a.r.objectId > b.r.objectId ? 1 : 0;
    });

  const candidates: SprawlCandidate[] = scored.slice(0, limit).map((s, i) => ({
    rank: i + 1,
    objectId: s.r.objectId,
    objectApiName: s.r.apiName,
    densityScore: s.densityScore,
    signals: {
      recordTriggeredFlows: s.r.recordTriggeredFlows,
      apexTriggers: s.r.apexTriggers,
      workflowRules: s.r.workflowRules,
      processBuilders: s.r.processBuilders,
      fieldWriteCollisions: s.fieldWriteCollisions,
      namingInconsistencies: s.r.namingInconsistencies,
    },
    collisionScanned: collisionScannedSet.has(s.r.objectId),
  }));

  const boundaries = [...SPRAWL_BOUNDARIES];
  if (objectScanTruncated) {
    boundaries.push(
      `The CustomObject scan hit its ${SPRAWL_OBJECT_SCAN_CAP}-node cap; the ranking is computed over a deterministic prefix — re-verify on orgs with more than ${SPRAWL_OBJECT_SCAN_CAP} objects.`,
    );
  }
  if (flowScanTruncated) {
    boundaries.push(
      `The Flow scan hit its ${SPRAWL_FLOW_SCAN_CAP}-node cap; Process Builder counts may under-count on orgs with more than ${SPRAWL_FLOW_SCAN_CAP} Flows.`,
    );
  }
  if (collisionScanCapped) {
    boundaries.push(
      `Field-write collisions were computed for only the ${SPRAWL_MAX_COLLISION_SCANS} densest objects (2+ record-triggered firers); other objects report a collision floor of 0 (collisionScanned: false).`,
    );
  }

  return ok({
    data: {
      mode: 'sprawl' as const,
      findings: [],
      governorClasses: null,
      sprawl: {
        candidates,
        scoreBasis: {
          weights: { ...SPRAWL_WEIGHTS },
          formula:
            'densityScore = recordTriggeredFlows*3 + apexTriggers*3 + workflowRules*2 + processBuilders*2 + fieldWriteCollisions*4 + namingInconsistencies*1',
          confidenceNote:
            'Counts derive from triggersOn/writesTo edges (mostly declared/parsed confidence). Apex-trigger write collisions are heuristic. The composite is a heuristic ranking signal, not a correctness verdict.',
        },
        scanned: {
          objects: objects.length,
          objectsRanked: scored.length,
          objectsCollisionScanned: collisionScannedSet.size,
          objectScanTruncated,
          flowScanTruncated,
          collisionScanCapped,
        },
      },
      boundaries,
      trust: coverageTrust(ctx),
      disclosure: SPRAWL_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

// ---------------------------------------------------------------------------
// sfi.permission_risk_report — over-privilege / god-mode analysis
// ---------------------------------------------------------------------------

/**
 * System (user) permissions that confer broad, cross-object, or administrative
 * power, with the severity each earns. `ModifyAllData` and `ViewAllData` are
 * the two true god-mode RECORD permissions (they bypass sharing on every
 * object); the rest grant metadata, user, or sharing control. The profile /
 * permission-set extractors surface them on `Node.properties.userPermissions`.
 * A permission not in this map is not flagged.
 */
const SYSTEM_PERMISSION_SEVERITY: Readonly<
  Record<string, RankedFinding['severity']>
> = {
  ModifyAllData: 'critical',
  ViewAllData: 'critical',
  AuthorApex: 'high',
  CustomizeApplication: 'high',
  ManageUsers: 'high',
  ManageInternalUsers: 'high',
  ManageProfilesPermissionsets: 'high',
  ModifyMetadata: 'high',
  ManageSharing: 'high',
  ManageRoles: 'high',
  ManagePasswordPolicies: 'high',
  ManageLoginAccessPolicies: 'high',
  ViewAllUsers: 'medium',
  ViewSetup: 'medium',
  PasswordNeverExpires: 'medium',
};

/** Upper bound on Profile + PermissionSet nodes scanned for over-privilege. */
const PRIVILEGE_SCAN_CAP = 500;
/** Per-grantor example object ids carried as finding evidence. */
const ESCALATION_EXAMPLE_CAP = 5;
/** Upper bound on each god-mode roster (keeps the response bounded). */
const ROSTER_CAP = 100;

/** Headline over-privilege rosters surfaced alongside the ranked findings. */
export interface PrivilegeSummary {
  /** Profile / PermissionSet ids granting `ModifyAllData` (god-mode write). */
  readonly modifyAllDataGrantors: readonly ComponentId[];
  /** Profile / PermissionSet ids granting `ViewAllData` (god-mode read). */
  readonly viewAllDataGrantors: readonly ComponentId[];
  /** Total grantors with ANY flagged over-privilege (system or object-level). */
  readonly overPrivilegedGrantorCount: number;
  readonly scanned: {
    readonly profiles: number;
    readonly permissionSets: number;
    readonly permissionSetGroups: number;
  };
}

/** Build the aggregated over-privilege finding for one grantor, or null. */
const grantorFinding = (
  node: Node,
  type: 'Profile' | 'PermissionSet',
  riskyPerms: readonly string[],
  modifyAllObjects: number,
  viewAllObjects: number,
  worst: RankedFinding['severity'] | null,
  examples: readonly string[],
): RankedFinding | null => {
  if (riskyPerms.length === 0 && modifyAllObjects === 0 && viewAllObjects === 0) {
    return null;
  }
  const parts: string[] = [];
  if (riskyPerms.length > 0) {
    parts.push(`system perms: ${[...riskyPerms].sort().join(', ')}`);
  }
  if (modifyAllObjects > 0) {
    parts.push(`Modify All on ${modifyAllObjects} object(s)`);
  }
  if (viewAllObjects > 0) {
    parts.push(`View All on ${viewAllObjects} object(s)`);
  }
  return {
    rank: 0,
    severity: worst ?? 'medium',
    category: 'over-privilege',
    summary: `${type} ${node.apiName} grants ${parts.join('; ')}`,
    evidence: [node.id, ...examples],
    confidence: 'declared',
  };
};

/**
 * Scan every Profile and PermissionSet for over-privilege from the extracted
 * data: high-risk `userPermissions` (god-mode + administrative system perms)
 * and object-level View All / Modify All grants (`grantedBy` edges whose
 * `viewAllRecords` / `modifyAllRecords` flag is set; the grant edge runs
 * grantor -> object, so they are the grantor's OUTGOING edges). One AGGREGATED
 * finding per over-privileged grantor keeps the report bounded. Declared
 * confidence — these are literal metadata flags, not heuristics.
 */
const analyzeOverPrivilege = async (
  ctx: Context,
  limit: number,
): Promise<{ findings: RankedFinding[]; privilege: PrivilegeSummary }> => {
  const findings: RankedFinding[] = [];
  const modifyAllDataGrantors: ComponentId[] = [];
  const viewAllDataGrantors: ComponentId[] = [];
  const scanned = { profiles: 0, permissionSets: 0, permissionSetGroups: 0 };
  // Per-PermissionSet risk profile, consulted when aggregating the effective
  // permissions of a PermissionSetGroup from its member permission sets.
  const permsetRisk = new Map<
    string,
    {
      readonly perms: readonly string[];
      readonly modAll: number;
      readonly viewAll: number;
    }
  >();

  // Collect Profile then PermissionSet nodes in the SAME order the former
  // per-type loop scanned them, so the accumulation pass below reproduces
  // node-iteration order exactly — the ROSTER_CAP roster and the per-node
  // ESCALATION_EXAMPLE_CAP examples are order-sensitive.
  const scanNodes: { readonly type: 'Profile' | 'PermissionSet'; readonly node: Node }[] = [];
  for (const type of ['Profile', 'PermissionSet'] as const) {
    const nodesResult = await listNodesByType(ctx.graph, type, {
      limit: PRIVILEGE_SCAN_CAP,
    });
    if (!nodesResult.ok) continue;
    for (const node of nodesResult.value) {
      scanNodes.push({ type, node });
    }
  }

  // ONE batched round-trip for every scanned container's OUTGOING grantedBy
  // edges, replacing the former per-node `listEdges` N+1 (thousands of serial
  // DuckDB queries on a large vault — the residual >60s timeout after d7a3b8f).
  // `listEdgesForNodes` sorts each per-node bucket by the FULL
  // (to_id, edge_type, from_id, source) total order — a refinement of the
  // (to_id, edge_type) order `listEdges` returned — so the capped example
  // pushes below stay byte-identical. A failed batch yields an empty map, i.e.
  // every node behaves exactly as the old `!outResult.ok` (no escalation) path.
  let grantedByOut: ReadonlyMap<ComponentId, readonly Edge[]> = new Map();
  const outBatch = await listEdgesForNodes(
    ctx.graph,
    scanNodes.map((s) => s.node.id),
    { direction: 'out', edgeTypes: ['grantedBy'] },
  );
  if (outBatch.ok) grantedByOut = outBatch.value;

  for (const { type, node } of scanNodes) {
    if (type === 'Profile') scanned.profiles += 1;
    else scanned.permissionSets += 1;

    // 1) High-risk system permissions (properties.userPermissions).
    const riskyPerms: string[] = [];
    let worst: RankedFinding['severity'] | null = null;
    const ups = node.properties['userPermissions'];
    if (Array.isArray(ups)) {
      for (const perm of ups) {
        if (typeof perm !== 'string') continue;
        const sev = SYSTEM_PERMISSION_SEVERITY[perm];
        if (sev === undefined) continue;
        riskyPerms.push(perm);
        if (worst === null || rankSeverity(sev) > rankSeverity(worst)) {
          worst = sev;
        }
        if (perm === 'ModifyAllData' && modifyAllDataGrantors.length < ROSTER_CAP) {
          modifyAllDataGrantors.push(node.id);
        }
        if (perm === 'ViewAllData' && viewAllDataGrantors.length < ROSTER_CAP) {
          viewAllDataGrantors.push(node.id);
        }
      }
    }

    // 2) Object-level View All / Modify All (outgoing grantedBy edges) — read
    //    from the ONE batched fetch above instead of a per-node round-trip.
    let modifyAllObjects = 0;
    let viewAllObjects = 0;
    const examples: string[] = [];
    for (const edge of grantedByOut.get(node.id) ?? []) {
      if (!edge.toId.startsWith('CustomObject:')) continue;
      if (edge.properties['modifyAllRecords'] === true) {
        modifyAllObjects += 1;
        if (examples.length < ESCALATION_EXAMPLE_CAP) examples.push(edge.toId);
      } else if (edge.properties['viewAllRecords'] === true) {
        viewAllObjects += 1;
        if (examples.length < ESCALATION_EXAMPLE_CAP) examples.push(edge.toId);
      }
    }
    if (
      modifyAllObjects > 0 &&
      (worst === null || rankSeverity('high') > rankSeverity(worst))
    ) {
      worst = 'high';
    } else if (viewAllObjects > 0 && worst === null) {
      worst = 'medium';
    }

    if (type === 'PermissionSet') {
      permsetRisk.set(node.id, {
        perms: riskyPerms,
        modAll: modifyAllObjects,
        viewAll: viewAllObjects,
      });
    }

    const finding = grantorFinding(
      node,
      type,
      riskyPerms,
      modifyAllObjects,
      viewAllObjects,
      worst,
      examples,
    );
    if (finding !== null) findings.push(finding);
  }

  // 3) Permission Set Groups: a PSG's effective permissions are the UNION of
  // its member permission sets' grants (membership captured by the PSG
  // extractor as `references` edges + `properties.permissionSets`). Aggregate
  // them so the god-mode roster includes users who get it via a GROUP. Muting
  // is noted but NOT subtracted (a v1 honesty boundary).
  const psgResult = await listNodesByType(ctx.graph, 'PermissionSetGroup', {
    limit: PRIVILEGE_SCAN_CAP,
  });
  if (psgResult.ok) {
    for (const psg of psgResult.value) {
      scanned.permissionSetGroups += 1;
      // CR-CAP-04: membership RESOLUTION is delegated to the shared helper —
      // its `memberPermissionSetIds` are `PermissionSet:<name>` ids, identical
      // to the old inline `PermissionSet:${member}` reconstruction, so the
      // `permsetRisk` lookup key and this risk aggregation are UNCHANGED.
      const expanded = await expandPermissionSetGroup(ctx, psg.id);
      if (!expanded.ok || expanded.value === null) continue;
      const conferred = new Set<string>();
      let aggModAll = 0;
      let aggViewAll = 0;
      const riskyMembers: string[] = [];
      for (const memberId of expanded.value.memberPermissionSetIds) {
        const risk = permsetRisk.get(memberId);
        if (risk === undefined) continue;
        if (risk.perms.length === 0 && risk.modAll === 0 && risk.viewAll === 0) {
          continue;
        }
        for (const perm of risk.perms) conferred.add(perm);
        aggModAll += risk.modAll;
        aggViewAll += risk.viewAll;
        if (riskyMembers.length < ESCALATION_EXAMPLE_CAP) {
          riskyMembers.push(memberId);
        }
      }
      if (conferred.size === 0 && aggModAll === 0 && aggViewAll === 0) continue;

      let worst: RankedFinding['severity'] = 'medium';
      if (conferred.has('ModifyAllData') || conferred.has('ViewAllData')) {
        worst = 'critical';
      } else if (
        aggModAll > 0 ||
        [...conferred].some((p) => SYSTEM_PERMISSION_SEVERITY[p] === 'high')
      ) {
        worst = 'high';
      }
      if (
        conferred.has('ModifyAllData') &&
        modifyAllDataGrantors.length < ROSTER_CAP
      ) {
        modifyAllDataGrantors.push(psg.id);
      }
      if (
        conferred.has('ViewAllData') &&
        viewAllDataGrantors.length < ROSTER_CAP
      ) {
        viewAllDataGrantors.push(psg.id);
      }

      // Muting is NOTED but NOT subtracted (a v1 honesty boundary) — the helper
      // surfaces `hasMuting` from the same `mutingPermissionSets` property.
      const hasMuting = expanded.value.hasMuting;
      const parts: string[] = [];
      if (conferred.size > 0) {
        parts.push(`system perms: ${[...conferred].sort().join(', ')}`);
      }
      if (aggModAll > 0) {
        parts.push(`Modify All on ${aggModAll} object(s) (aggregate)`);
      }
      if (aggViewAll > 0) {
        parts.push(`View All on ${aggViewAll} object(s) (aggregate)`);
      }
      findings.push({
        rank: 0,
        severity: worst,
        category: 'over-privilege',
        summary:
          `PermissionSetGroup ${psg.apiName} confers via member permission ` +
          `set(s) ${parts.join('; ')}` +
          (hasMuting
            ? ' (has a muting permission set, not subtracted in this god-mode roster — effective perms may be lower; use sfi.effective_permissions for the muting-correct net grant, R6-06)'
            : ''),
        evidence: [psg.id, ...riskyMembers],
        confidence: 'declared',
      });
    }
  }

  const ranked = [...findings].sort(
    (a, b) => rankSeverity(b.severity) - rankSeverity(a.severity),
  );
  return {
    findings: ranked.slice(0, limit),
    privilege: {
      modifyAllDataGrantors: [...modifyAllDataGrantors].sort(),
      viewAllDataGrantors: [...viewAllDataGrantors].sort(),
      overPrivilegedGrantorCount: findings.length,
      scanned,
    },
  };
};

/**
 * Build a permission-risk report SCOPED to a single, already-resolved Profile
 * node. Analyses ONLY that profile's god-mode / administrative system perms and
 * object-level View All / Modify All grants — the same declared-metadata logic
 * `analyzeOverPrivilege` runs org-wide, narrowed to one grantor. An empty
 * `findings` here means the profile carries no flagged over-privilege (a real
 * answer, not a missing one).
 */
const scopedProfileReport = async (
  ctx: Context,
  node: Node,
  limit: number,
  requested: string,
): Promise<Result<McpResponse<PermissionRiskReportOutput>, McpError>> => {
  const riskyPerms: string[] = [];
  let worst: RankedFinding['severity'] | null = null;
  const modifyAllDataGrantors: ComponentId[] = [];
  const viewAllDataGrantors: ComponentId[] = [];
  const ups = node.properties['userPermissions'];
  if (Array.isArray(ups)) {
    for (const perm of ups) {
      if (typeof perm !== 'string') continue;
      const sev = SYSTEM_PERMISSION_SEVERITY[perm];
      if (sev === undefined) continue;
      riskyPerms.push(perm);
      if (worst === null || rankSeverity(sev) > rankSeverity(worst)) worst = sev;
      if (perm === 'ModifyAllData') modifyAllDataGrantors.push(node.id);
      if (perm === 'ViewAllData') viewAllDataGrantors.push(node.id);
    }
  }

  let modifyAllObjects = 0;
  let viewAllObjects = 0;
  const examples: string[] = [];
  // Single-node `listEdges` is O(1) here — this scoped path analyses exactly
  // one already-resolved Profile, so there is no N+1 to batch (unlike the
  // org-wide `analyzeOverPrivilege` scan, which now uses `listEdgesForNodes`).
  const outResult = await listEdges(ctx.graph, node.id, {
    direction: 'out',
    edgeType: 'grantedBy',
  });
  if (outResult.ok) {
    for (const edge of outResult.value) {
      if (!edge.toId.startsWith('CustomObject:')) continue;
      if (edge.properties['modifyAllRecords'] === true) {
        modifyAllObjects += 1;
        if (examples.length < ESCALATION_EXAMPLE_CAP) examples.push(edge.toId);
      } else if (edge.properties['viewAllRecords'] === true) {
        viewAllObjects += 1;
        if (examples.length < ESCALATION_EXAMPLE_CAP) examples.push(edge.toId);
      }
    }
  }
  if (
    modifyAllObjects > 0 &&
    (worst === null || rankSeverity('high') > rankSeverity(worst))
  ) {
    worst = 'high';
  } else if (viewAllObjects > 0 && worst === null) {
    worst = 'medium';
  }

  const finding = grantorFinding(
    node,
    'Profile',
    riskyPerms,
    modifyAllObjects,
    viewAllObjects,
    worst,
    examples,
  );
  const findings: RankedFinding[] = finding !== null ? [finding] : [];

  const godModeIds = [
    ...new Set([...modifyAllDataGrantors, ...viewAllDataGrantors]),
  ];
  const dataShape = await readActiveHoldersFor(ctx, godModeIds);

  return ok({
    data: {
      findings: sortFindings(findings).slice(0, limit),
      auditTotals: null,
      privilege: {
        modifyAllDataGrantors: [...modifyAllDataGrantors].sort(),
        viewAllDataGrantors: [...viewAllDataGrantors].sort(),
        overPrivilegedGrantorCount: findings.length,
        scanned: { profiles: 1, permissionSets: 0, permissionSetGroups: 0 },
      },
      profileFilter: {
        requested,
        found: true,
        resolvedId: node.id,
        closestMatch: null,
        caveat: `Report scoped to ${node.id}.`,
      },
      ...(dataShape !== undefined ? { dataShape } : {}),
      trust: coverageTrust(ctx),
      disclosure: SYNTHESIS_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

// ---------------------------------------------------------------------------
// sfi.permission_risk_report
// ---------------------------------------------------------------------------

export interface PermissionRiskReportOutput extends SynthesisBase {
  readonly auditTotals: Pick<
    CrudFlsAuditOutput,
    'totalFindingCount' | 'totalClassCount'
  > | null;
  /** Over-privilege rosters: god-mode system perms + object-level escalation. */
  readonly privilege: PrivilegeSummary;
  /**
   * P13-PSA-counts: active-holder counts for the god-mode grantors
   * (`data_snapshot`), when captured — holder-weighted risk: a god-mode
   * permission set held by 40 active users outranks one held by none.
   */
  readonly dataShape?: HoldersShape;
  /**
   * Echo of the requested `profileFilter` and how it was honored. Present ONLY
   * when a `profileFilter` was supplied. `found: false` means no Profile in the
   * vault matched the requested name — the report stopped (empty findings),
   * `closestMatch` names the nearest existing profile (or null), and `caveat`
   * states the premise was false. `found: true` means the report was SCOPED to
   * the resolved profile id.
   */
  readonly profileFilter?: ProfileFilterResult;
}

/** Resolution of a requested `profileFilter` against the vault's profiles. */
export interface ProfileFilterResult {
  /** The verbatim filter string the caller passed. */
  readonly requested: string;
  /** True when a Profile matched and the report was scoped to it. */
  readonly found: boolean;
  /** Resolved `Profile:<ApiName>` id when `found`; null otherwise. */
  readonly resolvedId: ComponentId | null;
  /** Nearest existing profile name when NOT found (best-effort), else null. */
  readonly closestMatch: string | null;
  /** Human-readable caveat — explicit false-premise statement when not found. */
  readonly caveat: string;
}

/** Normalise a profile name for forgiving comparison (case/space/underscore). */
const normalizeProfileName = (raw: string): string =>
  raw
    .replace(/^Profile:/i, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '');

/** Cheap Levenshtein distance, capped to keep the scan bounded. */
const editDistance = (a: string, b: string): number => {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (curr[j - 1] ?? 0) + 1,
        (prev[j] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] ?? 0;
};

/**
 * Resolve a requested `profileFilter` against the Profile nodes in the vault.
 * Returns the matched node (exact, normalised match wins; substring is a
 * secondary signal) plus the full profile roster so the caller can name the
 * closest existing profile when nothing matched. A `profileFilter` for a
 * profile that does NOT exist is a FALSE PREMISE — the cascade must stop and
 * say so, never silently ignore the filter and dump the org-wide report.
 */
const resolveProfileFilter = async (
  ctx: Context,
  requested: string,
): Promise<{
  readonly matched: Node | null;
  readonly profiles: readonly Node[];
}> => {
  const nodesResult = await listNodesByType(ctx.graph, 'Profile', {
    limit: PRIVILEGE_SCAN_CAP,
  });
  const profiles = nodesResult.ok ? nodesResult.value : [];
  const wanted = normalizeProfileName(requested);
  // 1) Exact normalised match on apiName or label.
  for (const node of profiles) {
    if (normalizeProfileName(node.apiName) === wanted) {
      return { matched: node, profiles };
    }
    if (typeof node.label === 'string' && normalizeProfileName(node.label) === wanted) {
      return { matched: node, profiles };
    }
  }
  return { matched: null, profiles };
};

/** Name of the profile closest to `requested` (for a false-premise caveat). */
const closestProfileName = (
  requested: string,
  profiles: readonly Node[],
): string | null => {
  const wanted = normalizeProfileName(requested);
  let best: { name: string; score: number } | null = null;
  for (const node of profiles) {
    // Prefer the human label for display (matches how an admin names a
    // profile, e.g. "AcmeCo Community Login User"); fall back to the api name.
    const display =
      typeof node.label === 'string' && node.label.length > 0
        ? node.label
        : node.apiName;
    // Score against BOTH api name and label so either spelling can match, but
    // always REPORT the display name.
    const forms = [node.apiName];
    if (typeof node.label === 'string' && node.label.length > 0) {
      forms.push(node.label);
    }
    let nodeScore = Infinity;
    for (const form of forms) {
      const norm = normalizeProfileName(form);
      // Substring overlap is a strong signal (AcmeCo_Integration_User vs
      // "AcmeCo Community Login User" share the AcmeCo token); score it ahead
      // of a raw edit distance by halving the distance when one contains the
      // other.
      const overlap = norm.includes(wanted) || wanted.includes(norm);
      const dist = editDistance(wanted, norm);
      const score = overlap ? dist / 2 : dist;
      if (score < nodeScore) nodeScore = score;
    }
    if (best === null || nodeScore < best.score) {
      best = { name: display, score: nodeScore };
    }
  }
  return best ? best.name : null;
};

export const permissionRiskReportHandler = async (
  ctx: Context,
  input: PermissionRiskReportInput,
): Promise<Result<McpResponse<PermissionRiskReportOutput>, McpError>> => {
  const limit = input.limit ?? 50;
  const findings: RankedFinding[] = [];

  // profileFilter HONESTY: when the caller scopes the report to a named
  // profile, the filter is HONORED. A profile that does not exist in the vault
  // is a FALSE PREMISE — stop the cascade and report it (empty findings + the
  // closest existing profile) rather than silently dropping the filter and
  // dumping the full org-wide report.
  if (input.profileFilter !== undefined) {
    const { matched, profiles } = await resolveProfileFilter(
      ctx,
      input.profileFilter,
    );
    if (matched === null) {
      const closest = closestProfileName(input.profileFilter, profiles);
      const caveat =
        `No profile named '${input.profileFilter}' exists in this vault` +
        (closest !== null ? ` (closest match: '${closest}')` : '') +
        '. The requested profile-scoped analysis cannot be performed — the ' +
        'premise is false. Verify the profile name or run /sfi-refresh if the ' +
        'vault may be stale.';
      return ok({
        data: {
          findings: [],
          auditTotals: null,
          privilege: {
            modifyAllDataGrantors: [],
            viewAllDataGrantors: [],
            overPrivilegedGrantorCount: 0,
            scanned: { profiles: 0, permissionSets: 0, permissionSetGroups: 0 },
          },
          profileFilter: {
            requested: input.profileFilter,
            found: false,
            resolvedId: null,
            closestMatch: closest,
            caveat,
          },
          trust: coverageTrust(ctx),
          disclosure: `${caveat} ${SYNTHESIS_DISCLOSURE}`,
        },
        vaultState: {
          sourceTreeHash: ctx.manifest.sourceTreeHash,
          refreshedAt: ctx.manifest.refreshedAt,
        },
      });
    }
    return scopedProfileReport(ctx, matched, limit, input.profileFilter);
  }

  // Over-privilege: god-mode system perms + object-level View All / Modify All,
  // read straight from the extracted profile / permission-set metadata. This is
  // the headline of a permission-risk report, so it leads the findings.
  const overPriv = await analyzeOverPrivilege(ctx, limit);
  findings.push(...overPriv.findings);

  const unassigned = await unassignedPermissionSetsHandler(ctx, { limit });
  if (unassigned.ok) {
    for (const row of unassigned.value.data.unassigned.slice(0, limit)) {
      findings.push({
        rank: 0,
        severity: 'medium',
        category: 'unassigned-grant',
        summary: `Permission set ${row.id} has no assignments`,
        evidence: [row.apiName],
        confidence: 'declared',
      });
    }
  }

  const audit = await crudFlsAuditHandler(ctx, { limit });
  let auditTotals: PermissionRiskReportOutput['auditTotals'] = null;
  if (audit.ok) {
    auditTotals = {
      totalFindingCount: audit.value.data.totalFindingCount,
      totalClassCount: audit.value.data.totalClassCount,
    };
    if (audit.value.data.totalFindingCount > 0) {
      findings.push({
        rank: 0,
        severity: 'high',
        category: 'crud-fls',
        summary: `${audit.value.data.totalFindingCount} CRUD/FLS findings across ${audit.value.data.totalClassCount} classes`,
        evidence: Object.keys(audit.value.data.byRule),
        confidence: 'declared',
      });
    }
  }

  const godModeIds = [
    ...new Set([
      ...overPriv.privilege.modifyAllDataGrantors,
      ...overPriv.privilege.viewAllDataGrantors,
    ]),
  ].slice(0, 50);
  const dataShape = await readActiveHoldersFor(ctx, godModeIds);

  return ok({
    data: {
      findings: sortFindings(findings),
      auditTotals,
      privilege: overPriv.privilege,
      ...(dataShape !== undefined ? { dataShape } : {}),
      trust: coverageTrust(ctx),
      disclosure: SYNTHESIS_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

// ---------------------------------------------------------------------------
// sfi.release_readiness_report — HIDDEN back-compat alias (STEP-2)
//
// The deploy-gate capability (ready + blockers) folded into org_risk_report's
// `gate: true` MODE. This is now a THIN alias delegating with gate forced on, so
// the survivor owns the preserved output and direct / run_analysis callers of
// the retired name keep working. Un-advertised on tools/list.
// ---------------------------------------------------------------------------

/**
 * The org-risk gate output the (hidden) release_readiness alias returns. Since
 * the alias always forces `gate: true`, `ready` + `blockers` are ALWAYS present
 * — redeclared here as required (they are optional on the base). A structural
 * superset of the historical shape (also carries the org-risk drill-down fields).
 */
export interface ReleaseReadinessReportOutput extends OrgRiskReportOutput {
  readonly ready: boolean;
  readonly blockers: readonly string[];
}

export const releaseReadinessReportHandler = async (
  ctx: Context,
  input: SynthesisInput,
): Promise<Result<McpResponse<ReleaseReadinessReportOutput>, McpError>> => {
  const r = await orgRiskReportHandler(ctx, { ...input, gate: true });
  // `gate: true` guarantees the handler populated ready + blockers, so the
  // widened base output is safe to present with them required.
  return r as Result<McpResponse<ReleaseReadinessReportOutput>, McpError>;
};
