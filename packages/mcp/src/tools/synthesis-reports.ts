/**
 * Deterministic enterprise synthesis reports (v4.0 R7).
 *
 * Each tool composes existing handlers — no duplicated graph logic.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import { listEdges, listNodesByType } from '@sf-intelligence/graph';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

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
import { expandPermissionSetGroup } from './permission-set-group.js';
import { collectPiiInventoryFields } from './pii-inventory.js';
import {
  processBuilderMigrationCandidatesHandler,
} from './process-builder-migration-candidates.js';
import { REPORT_DASHBOARD_USAGE_CAVEAT } from './report-dashboard-usage.js';
import {
  techDebtScoreHandler,
  type TechDebtScoreOutput,
} from './tech-debt-score.js';
import {
  unassignedPermissionSetsHandler,
} from './unassigned-permission-sets.js';
import {
  unusedFieldsDeepHandler,
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
export const orgRiskReportInputSchema = synthesisInputSchema;
export const automationRiskReportInputSchema = synthesisInputSchema;
export const permissionRiskReportInputSchema = synthesisInputSchema;
export const releaseReadinessReportInputSchema = synthesisInputSchema;

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
}

export const orgRiskReportHandler = async (
  ctx: Context,
  input: SynthesisInput,
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

  return ok({
    data: {
      findings: sortFindings(findings),
      techDebt,
      healthIssueCount: issues.length,
      permissionRisk,
      piiExposure,
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
// sfi.field_cleanup_candidates
// ---------------------------------------------------------------------------

export interface FieldCleanupCandidatesOutput extends SynthesisBase {
  readonly fields: UnusedFieldsDeepOutput['fields'];
  /** Present when the candidate list was trimmed to fit the response size limit. */
  readonly note?: string;
}

/** Keep the serialized response under the global ~45 KB MCP guard. The `fields`
 *  entries carry the full eight-tier detail, so the default page can overflow. */
const FIELD_CLEANUP_BYTE_BUDGET = 36_000;

export const fieldCleanupCandidatesHandler = async (
  ctx: Context,
  input: FieldCleanupCandidatesInput,
): Promise<Result<McpResponse<FieldCleanupCandidatesOutput>, McpError>> => {
  const limit = input.limit ?? 100;
  // Pass the object-scope parameters through to unused_fields_deep so the
  // scan is scoped to the requested object rather than returning org-wide
  // results. Both objectId and objectApiName are forwarded so callers can
  // use either alias.
  const deep = await unusedFieldsDeepHandler(ctx, {
    limit,
    ...(input.objectId !== undefined ? { objectId: input.objectId } : {}),
    ...(input.objectApiName !== undefined
      ? { objectApiName: input.objectApiName }
      : {}),
  });
  if (!deep.ok) return deep;
  const allFields = deep.value.data.fields;
  const toFinding = (field: UnusedFieldsDeepOutput['fields'][number]): RankedFinding => ({
    rank: 0,
    severity:
      field.confidence === 'high'
        ? 'high'
        : field.confidence === 'medium'
          ? 'medium'
          : 'low',
    category: 'unused-field',
    summary: `${field.id} — ${field.recommendedAction}`,
    evidence: field.invisibilityWarnings,
    confidence: 'heuristic' as const,
  });

  // Each `fields` entry carries the full eight-tier detail, so the default page
  // can exceed the response guard (a real org overflowed at ~191 KB). Trim
  // findings + fields together (they stay parallel, findings[i] from fields[i])
  // until the serialized response fits the byte budget.
  const build = (n: number): FieldCleanupCandidatesOutput => {
    const fields = allFields.slice(0, n);
    return {
      findings: sortFindings(fields.map(toFinding)),
      fields,
      trust: coverageTrust(ctx),
      // Cleanup candidates are absence-of-usage findings; without `--with-reports`
      // a report/dashboard-only field reads as unused. Surface that caveat so the
      // list is not mistaken for a safe-to-delete set.
      disclosure: `${SYNTHESIS_DISCLOSURE} Also: ${REPORT_DASHBOARD_USAGE_CAVEAT}`,
      ...(n < allFields.length
        ? {
            note:
              `Showing ${n} of ${allFields.length} cleanup candidates — trimmed to ` +
              `fit the response size limit. Narrow with a lower \`limit\` or use ` +
              `\`unused_fields_deep\` (paginated) for the full detail.`,
          }
        : {}),
    };
  };
  let n = allFields.length;
  let data = build(n);
  while (n > 1 && Buffer.byteLength(JSON.stringify(data), 'utf8') > FIELD_CLEANUP_BYTE_BUDGET) {
    n = Math.max(1, Math.floor(n * 0.8));
    data = build(n);
  }

  return ok({
    data,
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

// ---------------------------------------------------------------------------
// sfi.automation_risk_report
// ---------------------------------------------------------------------------

export interface AutomationRiskReportOutput extends SynthesisBase {
  readonly governorClasses: GovernorLimitRisksOutput['classes'] | null;
}

export const automationRiskReportHandler = async (
  ctx: Context,
  input: SynthesisInput,
): Promise<Result<McpResponse<AutomationRiskReportOutput>, McpError>> => {
  const limit = input.limit ?? 50;
  const findings: RankedFinding[] = [];

  const pb = await processBuilderMigrationCandidatesHandler(ctx, { limit });
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

  const gov = await governorLimitRisksHandler(ctx, { limit });
  let governorClasses: GovernorLimitRisksOutput['classes'] | null = null;
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

  return ok({
    data: {
      findings: sortFindings(findings),
      governorClasses,
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

  for (const type of ['Profile', 'PermissionSet'] as const) {
    const nodesResult = await listNodesByType(ctx.graph, type, {
      limit: PRIVILEGE_SCAN_CAP,
    });
    if (!nodesResult.ok) continue;
    for (const node of nodesResult.value) {
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

      // 2) Object-level View All / Modify All (outgoing grantedBy edges).
      let modifyAllObjects = 0;
      let viewAllObjects = 0;
      const examples: string[] = [];
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
            ? ' (has a muting permission set — effective perms may be lower)'
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
}

export const permissionRiskReportHandler = async (
  ctx: Context,
  input: SynthesisInput,
): Promise<Result<McpResponse<PermissionRiskReportOutput>, McpError>> => {
  const limit = input.limit ?? 50;
  const findings: RankedFinding[] = [];

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
// sfi.release_readiness_report
// ---------------------------------------------------------------------------

export interface ReleaseReadinessReportOutput extends SynthesisBase {
  readonly ready: boolean;
  readonly blockers: readonly string[];
}

export const releaseReadinessReportHandler = async (
  ctx: Context,
  input: SynthesisInput,
): Promise<Result<McpResponse<ReleaseReadinessReportOutput>, McpError>> => {
  const orgRisk = await orgRiskReportHandler(ctx, input);
  if (!orgRisk.ok) return orgRisk;

  const blockers: string[] = [];
  for (const finding of orgRisk.value.data.findings) {
    if (finding.severity === 'critical') {
      blockers.push(finding.summary);
    }
  }

  // Block ONLY on ACTIONABLE coverage gaps: a requested metadata type that
  // errored during retrieve (`partialTypes`), which the user can fix by
  // re-running /sfi-refresh. Do NOT block on `notModeledTypes`
  // (CompactLayout/FieldSet/Index/ListView/WebLink) — those are families this
  // product never models by design, so blocking on them made `ready`
  // permanently false for EVERY vault: a non-actionable gate that signals
  // nothing about the org. The not-modeled scope limitation is still disclosed
  // honestly via `trust.completeness`.
  const coverage = summarizeCoverage(ctx.manifest);
  if (coverage.partialTypes.length > 0) {
    blockers.push(
      `Incomplete vault coverage — requested metadata failed retrieve: ${coverage.partialTypes.join(', ')}. Re-run /sfi-refresh.`,
    );
  }

  const ready = blockers.length === 0;

  return ok({
    data: {
      findings: orgRisk.value.data.findings,
      ready,
      blockers,
      trust: coverageTrust(ctx),
      disclosure: SYNTHESIS_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
