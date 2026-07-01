/**
 * Handler for the `sfi.tech_debt_score` MCP tool.
 *
 * The v2.4 org-wide tech-debt composite — the rollup buyers compile
 * from the prior hygiene tools into a single weighted 0-100 score
 * with category breakdown. Composes over v2.0b `unused_components`,
 * v2.4 `unused_fields_deep`, v2.4 `process_builder_migration_candidates`,
 * v2.4 `unassigned_permission_sets`, v2.4 `empty_queues_and_groups`,
 * v2.1's `qualityIssues` data (when present), v1.7 freshness data
 * (when present), and Apex API-version distribution.
 *
 * **Score direction (counterintuitive)** — higher means MORE debt
 * (worse). Range: 0 (no debt detected) to 100 (critical debt). Band:
 * low (0-25), moderate (26-50), high (51-75), critical (76-100). The
 * `admin-tech-debt-audit` skill surfaces this verbatim on every
 * response so users understand the inversion.
 *
 * **Weighting (PLAN-v2.4 §15)** — default weights:
 *   - unused fields (deadWeight): 0.20
 *   - legacy automation: 0.20
 *   - code quality: 0.15
 *   - freshness: 0.15
 *   - deprecated API versions (apiVersions): 0.15
 *   - unassigned grants: 0.15
 *
 * The score is `weighted_sum(contributions) / sum(applicable_weights)`
 * normalized to [0, 100]. The user may override `weights` per-call.
 *
 * **Exclude vs assume-zero (Q115 honesty anchor)** — a category whose
 * underlying extractor has not run is EXCLUDED from the score, not
 * assumed to be zero. The `excludedCategories` array names the
 * reason; when ANY category is excluded with reason
 * `'extractor-not-run'`, the response's `boundaries[]` appends the
 * verbatim Q115 disclosure so the skill can surface it BEFORE the
 * score band.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ComponentType,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { countNodesByType, listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  emptyQueuesAndGroupsHandler,
} from './empty-queues-and-groups.js';
import { findHardcodedValuesAnywhereHandler } from './find-hardcoded-values-anywhere.js';
import {
  processBuilderMigrationCandidatesHandler,
} from './process-builder-migration-candidates.js';
import { nodeScanLimit } from './scan-cap.js';
import {
  unassignedPermissionSetsHandler,
} from './unassigned-permission-sets.js';
import {
  unusedComponentsHandler,
} from './unused-components.js';
import {
  unusedFieldsDeepHandler,
} from './unused-fields-deep.js';

/**
 * Hard ceiling on a single `listNodesByType` page. `nodeScanLimit()` is
 * env-overridable (`SFI_NODE_SCAN_LIMIT`) so a test can drive the multi-page
 * offset loop without seeding 500+ nodes, but it does NOT clamp at 500, and the
 * graph layer rejects `limit > 500` — so every page request is clamped here.
 */
const PAGE_CAP = 500;
const pageSize = (): number => Math.min(nodeScanLimit(), PAGE_CAP);

/**
 * Load EVERY node of a single ComponentType, not just the first page. The
 * tech-debt composite SCORE inspects per-node properties (apiVersion,
 * qualityIssues, lastModifiedDate) and must be computed over the COMPLETE set —
 * a single `listNodesByType` page caps at 500 (id ASC), so an org with > 500 of
 * a scanned type used to score off only the first page (a saturated, wrong
 * composite). Page by `pageSize()` accumulating until a short page proves the
 * type is exhausted, with `countNodesByType` as a belt cross-check so a page
 * that unexpectedly returns full cannot loop forever. The common case (type
 * under the cap) runs exactly one sub-cap page — byte-identical.
 */
const loadAllNodes = async (
  ctx: Context,
  type: ComponentType,
): Promise<Result<readonly Node[], string>> => {
  const total = await countNodesByType(ctx.graph, type);
  if (!total.ok) return err(total.error.message);
  const limit = pageSize();
  const all: Node[] = [];
  for (let offset = 0; ; offset += limit) {
    const page = await listNodesByType(ctx.graph, type, { limit, offset });
    if (!page.ok) return err(page.error.message);
    all.push(...page.value);
    if (page.value.length < limit || all.length >= total.value) break;
  }
  return ok(all);
};

/**
 * The default weighting scheme per PLAN-v2.4 §15. Weights are
 * surfaced verbatim in the response so the user knows the bias.
 */
const DEFAULT_WEIGHTS: Readonly<Record<TechDebtCategory, number>> = Object.freeze({
  deadWeight: 0.2,
  legacyAutomation: 0.2,
  codeQuality: 0.15,
  freshness: 0.15,
  apiVersions: 0.15,
  unassignedGrants: 0.15,
});

/** The Q115 verbatim disclosure. */
const Q115_DISCLOSURE =
  'this score reflects only the axes that were extracted; missing axes are EXCLUDED, not assumed zero, and the score is not directly comparable to a score from a fully-extracted vault. To compute the missing categories, run the appropriate refresh command.';

/** The score-direction disclosure (always surfaced). */
const SCORE_DIRECTION_DISCLOSURE =
  "the tech debt score is inverted from a 'health score' — higher is WORSE (more debt). Range: 0 (no debt detected) to 100 (critical debt). Band: low (0-25), moderate (26-50), high (51-75), critical (76-100).";

/** Weight-scheme disclosure (always surfaced). */
const WEIGHT_SCHEME_DISCLOSURE =
  'the default weights reflect a typical enterprise-Salesforce-admin priority order. The deadWeight and legacyAutomation axes are weighted 0.20 each; codeQuality, freshness, apiVersions, and unassignedGrants are weighted 0.15 each. Pass a custom `weights` parameter to re-weight.';

/**
 * Heuristic-tier disclosure — surfaced when the codeQuality axis contributes to
 * the score. That axis is built from the heuristic Apex scanner (regex/token,
 * not a compiler), so per the product's trust contract its issue counts carry
 * `confidence: heuristic` and the axis's contribution must be cited as such
 * rather than read as exact (P10-A4 honesty invariant: heuristic tier always
 * cited).
 */
const CODE_QUALITY_HEURISTIC_DISCLOSURE =
  'the codeQuality axis is derived from the heuristic Apex scanner (regex/token, not a real compiler), so its issue counts carry confidence: heuristic — they approximate code quality and may over- or under-count (dynamic dispatch, reflective access, and cross-method dataflow are invisible). Treat this axis’s contribution to the score as indicative, not exact.';

/**
 * Surfaced when the freshness axis is INCLUDED. The
 * componentsNeverModifiedSinceCreation detail is always null because the vault
 * does not capture a per-component createdDate (only lastModifiedDate is
 * extracted/enriched) — so this honest boundary replaces what used to be a
 * fabricated 0 (CR-16a).
 */
const NEVER_MODIFIED_UNAVAILABLE_DISCLOSURE =
  'the "never modified since creation" count is not available — the vault does not capture a per-component createdDate (only lastModifiedDate is extracted/enriched), so this metric is reported as null rather than a fabricated 0.';

/** Per-category scale factor — converts a raw count to a 0-100 contribution. */
const SCALE_FACTORS: Readonly<Record<TechDebtCategory, number>> = Object.freeze({
  // 100 unused fields → contribution 100
  deadWeight: 0.5,
  // 50 legacy-automation entries → contribution 100
  legacyAutomation: 2,
  // 50 critical+high code issues → contribution 100
  codeQuality: 2,
  // 100 stale components → contribution 100
  freshness: 1,
  // 20 deprecated API classes → contribution 100
  apiVersions: 5,
  // 30 unassigned grants → contribution 100
  unassignedGrants: 3.3,
});

type TechDebtCategory =
  | 'deadWeight'
  | 'legacyAutomation'
  | 'codeQuality'
  | 'freshness'
  | 'apiVersions'
  | 'unassignedGrants';

type ScoreBand =
  | 'low-debt'
  | 'moderate-debt'
  | 'high-debt'
  | 'critical-debt';

type ExcludedReason = 'user-opted-out' | 'extractor-not-run' | 'insufficient-data';

/**
 * The canonical set of allowed weight keys — used by the Zod schema
 * and by the handler's explicit refusal for typo'd weight keys.
 */
const ALLOWED_WEIGHT_KEYS: ReadonlyArray<TechDebtCategory> = [
  'deadWeight',
  'legacyAutomation',
  'codeQuality',
  'freshness',
  'apiVersions',
  'unassignedGrants',
];

/** Zod schema for the input. */
export const techDebtScoreInputSchema = z.object({
  excludeCategories: z
    .array(
      z.enum([
        'deadWeight',
        'legacyAutomation',
        'codeQuality',
        'freshness',
        'apiVersions',
        'unassignedGrants',
      ]),
    )
    .optional(),
  // `.passthrough()` keeps unknown weight keys in the parsed input so
  // the handler can surface them in a structured `invalid-query`
  // refusal rather than silently dropping them at the Zod boundary.
  weights: z
    .object({
      deadWeight: z.number().min(0).max(1).optional(),
      legacyAutomation: z.number().min(0).max(1).optional(),
      codeQuality: z.number().min(0).max(1).optional(),
      freshness: z.number().min(0).max(1).optional(),
      apiVersions: z.number().min(0).max(1).optional(),
      unassignedGrants: z.number().min(0).max(1).optional(),
    })
    .passthrough()
    .optional(),
});

export type TechDebtScoreInput = z.infer<typeof techDebtScoreInputSchema>;

export interface CategoryBreakdown {
  readonly weight: number;
  /** `null` when the category is excluded — not measured, not zero. */
  readonly rawCount: number | null;
  readonly contribution: number;
  /** `null` values mean not measured (excluded extractor), not a count of zero. */
  readonly details: Readonly<Record<string, number | null>>;
}

export interface ExcludedCategory {
  readonly category: TechDebtCategory;
  readonly reason: ExcludedReason;
  readonly note: string;
}

export interface TechDebtScoreOutput {
  readonly overallScore: number;
  /**
   * Signed change vs the prior refresh's logged score (P9-risk-delta) —
   * `overallScore − previousScore`. Present only when `meta/risk-scores.jsonl`
   * holds an entry from an earlier org state (i.e. on a 2nd+ refresh). The log
   * is written at refresh time because snapshots can't be re-scored on demand.
   */
  readonly scoreDelta?: number;
  /** The prior refresh's overall score the delta is measured against. */
  readonly previousScore?: number;
  /** When that prior score was captured (ISO timestamp). */
  readonly previousRefreshedAt?: string;
  readonly scoreBand: ScoreBand;
  readonly categories: Readonly<Record<TechDebtCategory, CategoryBreakdown>>;
  readonly excludedCategories: readonly ExcludedCategory[];
  readonly weightingDisclosure: {
    readonly weightsApplied: Readonly<Record<TechDebtCategory, number>>;
    readonly weightsDefault: Readonly<Record<TechDebtCategory, number>>;
    readonly deviation: 'default' | 'user-overridden';
  };
  readonly recommendedActions: readonly string[];
  /**
   * Hardcoded Salesforce IDs found by `find_hardcoded_values_anywhere` (the
   * `id` category). Surfaced so the score consumer sees code debt the weighted
   * categories don't measure; `null` when the recognizer could not run. NOT
   * part of `overallScore`.
   */
  readonly hardcodedIdCount: number | null;
  readonly boundaries: readonly string[];
}

const bandFor = (score: number): ScoreBand => {
  if (score <= 25) return 'low-debt';
  if (score <= 50) return 'moderate-debt';
  if (score <= 75) return 'high-debt';
  return 'critical-debt';
};

const contribFor = (
  category: TechDebtCategory,
  rawCount: number,
): number => Math.min(100, rawCount * SCALE_FACTORS[category]);

/**
 * Recommendation text per category — surfaced verbatim in
 * `recommendedActions`.
 */
const recommendationFor = (
  category: TechDebtCategory,
  rawCount: number,
  contribution: number,
  weight: number,
): string => {
  const wPct = (weight * 100).toFixed(0);
  switch (category) {
    case 'deadWeight':
      return `close dead-weight backlog — ${rawCount} unused component(s) detected, contributing ${contribution.toFixed(1)}/100 at weight ${wPct}%.`;
    case 'legacyAutomation':
      return `close legacy-automation backlog — ${rawCount} legacy automation entries (Process Builders + WorkflowRules) detected, contributing ${contribution.toFixed(1)}/100 at weight ${wPct}%.`;
    case 'codeQuality':
      return `address code-quality findings — ${rawCount} critical or high severity issues detected, contributing ${contribution.toFixed(1)}/100 at weight ${wPct}%.`;
    case 'freshness':
      return `audit stale components — ${rawCount} components have not been modified in over 1 year, contributing ${contribution.toFixed(1)}/100 at weight ${wPct}%.`;
    case 'apiVersions':
      return `upgrade deprecated API versions — ${rawCount} Apex class(es) on API version < 50, contributing ${contribution.toFixed(1)}/100 at weight ${wPct}%.`;
    case 'unassignedGrants':
      return `clean up unassigned grants — ${rawCount} unassigned permission set(s) and empty queue(s)/group(s) detected, contributing ${contribution.toFixed(1)}/100 at weight ${wPct}%.`;
  }
};

/** Compute weighted score from per-category contributions. */
const weightedScore = (
  contributions: Readonly<Record<TechDebtCategory, number>>,
  weights: Readonly<Record<TechDebtCategory, number>>,
  excluded: ReadonlySet<TechDebtCategory>,
): number => {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const cat of Object.keys(weights) as TechDebtCategory[]) {
    if (excluded.has(cat)) continue;
    const w = weights[cat];
    weightedSum += w * contributions[cat];
    totalWeight += w;
  }
  if (totalWeight === 0) return 0;
  return weightedSum / totalWeight;
};

/**
 * Fetch every Apex class to compute the API-version distribution. The
 * distribution feeds the `apiVersions` category only.
 */
const computeApiVersionDistribution = async (
  ctx: Context,
): Promise<
  Result<
    {
      readonly below30: number;
      readonly below40: number;
      readonly below50: number;
      readonly oldest: number | null;
    },
    string
  >
> => {
  const r = await loadAllNodes(ctx, 'ApexClass');
  if (!r.ok) return err(r.error);
  let below30 = 0;
  let below40 = 0;
  let below50 = 0;
  let oldest: number | null = null;
  for (const ax of r.value) {
    if (ax.apiVersion === null) continue;
    if (ax.apiVersion < 30) below30 += 1;
    if (ax.apiVersion < 40) below40 += 1;
    if (ax.apiVersion < 50) below50 += 1;
    if (oldest === null || ax.apiVersion < oldest) oldest = ax.apiVersion;
  }
  return ok({ below30, below40, below50, oldest });
};

/**
 * Aggregate v2.1 `qualityIssues` arrays across every ApexClass /
 * ApexTrigger / Flow node. Each node's `qualityIssues` is an array of
 * objects with `severity: 'critical' | 'high' | 'medium' | 'low'`.
 * When NO node carries the `qualityIssues` property (v2.1 hasn't
 * shipped to this vault), returns null — signals "extractor not run".
 */
const computeCodeQualityCounts = async (
  ctx: Context,
): Promise<
  Result<
    | {
        readonly critical: number;
        readonly high: number;
        readonly medium: number;
        readonly anyNodeHasIssuesProperty: boolean;
      }
    | null,
    string
  >
> => {
  const fetchType = async (
    type: ComponentType,
  ): Promise<Result<readonly Node[], string>> => loadAllNodes(ctx, type);
  const cs = await fetchType('ApexClass');
  if (!cs.ok) return err(cs.error);
  const ts = await fetchType('ApexTrigger');
  if (!ts.ok) return err(ts.error);
  const fs = await fetchType('Flow');
  if (!fs.ok) return err(fs.error);
  let critical = 0;
  let high = 0;
  let medium = 0;
  let anyNodeHasIssuesProperty = false;
  for (const n of [...cs.value, ...ts.value, ...fs.value]) {
    const issues = n.properties['qualityIssues'];
    if (!Array.isArray(issues)) continue;
    anyNodeHasIssuesProperty = true;
    for (const issue of issues) {
      if (typeof issue !== 'object' || issue === null) continue;
      const sev = (issue as Record<string, unknown>)['severity'];
      if (sev === 'critical') critical += 1;
      else if (sev === 'high') high += 1;
      else if (sev === 'medium') medium += 1;
    }
  }
  if (!anyNodeHasIssuesProperty) return ok(null);
  return ok({ critical, high, medium, anyNodeHasIssuesProperty });
};

/**
 * Compute the freshness category counts from the `lastModifiedDate`
 * node field. When NO node carries non-null `lastModifiedDate` (v1.7
 * R2 / Tooling-API enrichment hasn't run), returns null.
 *
 * `neverModified` ("never modified since creation") is ALWAYS null/unknown:
 * computing it requires a per-component `createdDate` to diff against
 * `lastModifiedDate`, but no such datum exists in the vault/graph — the Node
 * contract carries only `lastModifiedDate`/`lastModifiedBy`/`apiVersion` (no
 * `createdDate`), and the Tooling-API enrichment never SELECTs `CreatedDate`.
 * So only the `lastModifiedDate`-based axes (olderThan1Year/olderThan2Years)
 * are real; per the honesty contract `neverModified` is reported as null, never
 * a fabricated 0. (TODO: if a future enrichment adds `CreatedDate` to enrich.ts
 * and a `createdDate` field to Node, this could become a real computed metric.)
 */
const computeFreshnessCounts = async (
  ctx: Context,
): Promise<
  Result<
    | {
        readonly olderThan1Year: number;
        readonly olderThan2Years: number;
        readonly neverModified: null;
      }
    | null,
    string
  >
> => {
  // Scan a broad sweep of types known to carry freshness data: Apex,
  // Flow, CustomField, Layout, ValidationRule.
  const types: ComponentType[] = [
    'ApexClass',
    'ApexTrigger',
    'Flow',
    'CustomField',
    'Layout',
    'ValidationRule',
  ];
  let any = false;
  let olderThan1Year = 0;
  let olderThan2Years = 0;
  // Always null/unknown: no per-component createdDate exists in the vault/graph
  // to diff against lastModifiedDate (see JSDoc). Never a fabricated 0.
  const neverModified = null;
  const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const twoYearsAgo = Date.now() - 2 * 365 * 24 * 60 * 60 * 1000;
  for (const t of types) {
    const r = await loadAllNodes(ctx, t);
    if (!r.ok) return err(r.error);
    for (const n of r.value) {
      if (n.lastModifiedDate === null) continue;
      any = true;
      const ts = Date.parse(n.lastModifiedDate);
      if (Number.isNaN(ts)) continue;
      if (ts < oneYearAgo) olderThan1Year += 1;
      if (ts < twoYearsAgo) olderThan2Years += 1;
    }
  }
  if (!any) return ok(null);
  return ok({ olderThan1Year, olderThan2Years, neverModified });
};

/**
 * Read the prior refresh's tech-debt score from `meta/risk-scores.jsonl`
 * (P9-risk-delta) — the most recent logged entry whose `sourceTreeHash` differs
 * from the current vault's (a genuinely earlier org state, so no-op re-refreshes
 * of the same source are skipped). Returns null when the log is absent, empty,
 * or holds no earlier state; every failure is non-fatal (the delta is a
 * convenience over the score, never a precondition).
 */
export const readPriorTechDebtScore = async (
  vaultRoot: string,
  currentHash: string,
): Promise<{ readonly score: number; readonly refreshedAt: string } | null> => {
  try {
    const raw = await readFile(
      join(vaultRoot, 'meta', 'risk-scores.jsonl'),
      'utf8',
    );
    const lines = raw.split('\n').filter((line) => line.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line === undefined) continue;
      const entry = JSON.parse(line) as {
        sourceTreeHash?: unknown;
        techDebtScore?: unknown;
        refreshedAt?: unknown;
      };
      if (
        entry.sourceTreeHash !== currentHash &&
        typeof entry.techDebtScore === 'number'
      ) {
        return {
          score: entry.techDebtScore,
          refreshedAt:
            typeof entry.refreshedAt === 'string' ? entry.refreshedAt : '',
        };
      }
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * The `sfi.tech_debt_score` MCP tool. See module JSDoc for the
 * weighted composition, score direction, and Q115 honesty anchor.
 */
export const techDebtScoreHandler = async (
  ctx: Context,
  input: TechDebtScoreInput,
): Promise<Result<McpResponse<TechDebtScoreOutput>, McpError>> => {
  // Refuse unknown weight keys explicitly. The Zod schema uses
  // `.passthrough()` on `weights` precisely so we can see typos here;
  // without this check, a typo (e.g. `{ weight: 0.5 }`) would produce a
  // normal-looking score derived from the defaults and mask the
  // user's mistake.
  if (input.weights !== undefined) {
    const allowed = new Set<string>(ALLOWED_WEIGHT_KEYS);
    const unknownKeys = Object.keys(input.weights).filter(
      (k) => !allowed.has(k),
    );
    if (unknownKeys.length > 0) {
      const allowedList = [...ALLOWED_WEIGHT_KEYS].join(', ');
      return err({
        kind: 'invalid-query',
        message: `unknown weight key(s): ${unknownKeys.map((k) => `'${k}'`).join(', ')}. Allowed keys are: ${allowedList}.`,
        path: 'weights',
      });
    }
  }

  const excludedByUser = new Set<TechDebtCategory>(input.excludeCategories ?? []);
  const weightsApplied: Record<TechDebtCategory, number> = { ...DEFAULT_WEIGHTS };
  const userOverrides = input.weights ?? {};
  for (const cat of Object.keys(weightsApplied) as TechDebtCategory[]) {
    const override = userOverrides[cat];
    if (override !== undefined) weightsApplied[cat] = override;
  }
  const deviation: 'default' | 'user-overridden' =
    Object.keys(userOverrides).length > 0 ? 'user-overridden' : 'default';

  // -- deadWeight category: unused_components + unused_fields_deep
  const ucRes = await unusedComponentsHandler(ctx, {});
  if (!ucRes.ok) return err(ucRes.error);
  const uc = ucRes.value.data;
  const ufdRes = await unusedFieldsDeepHandler(ctx, {});
  if (!ufdRes.ok) return err(ufdRes.error);
  const ufd = ufdRes.value.data;
  const unusedFieldsCount = uc.byType['CustomField'] ?? 0;
  const unusedFieldsDeepCount = ufd.totalCount;
  const unusedApexClassesCount = uc.byType['ApexClass'] ?? 0;
  const unusedFlowsCount = uc.byType['Flow'] ?? 0;
  const unusedEmailTemplatesCount = uc.byType['EmailTemplate'] ?? 0;
  const unusedStaticResourcesCount = uc.byType['StaticResource'] ?? 0;
  const unusedCustomLabelsCount = uc.byType['CustomLabel'] ?? 0;
  const deadWeightRaw =
    unusedFieldsDeepCount +
    unusedApexClassesCount +
    unusedFlowsCount +
    unusedEmailTemplatesCount +
    unusedStaticResourcesCount +
    unusedCustomLabelsCount;

  // -- legacyAutomation category
  const lcRes = await processBuilderMigrationCandidatesHandler(ctx, {});
  if (!lcRes.ok) return err(lcRes.error);
  const lc = lcRes.value.data;
  const activeWorkflowRulesCount = lc.totalWorkflowRules;
  const activeProcessBuildersCount = lc.totalProcessBuilders;
  const apiVersionsRes = await computeApiVersionDistribution(ctx);
  if (!apiVersionsRes.ok) {
    return err({ kind: 'internal', message: apiVersionsRes.error });
  }
  const av = apiVersionsRes.value;
  const deprecatedApiVersionApexCount = av.below50;
  const legacyAutomationRaw =
    activeWorkflowRulesCount + activeProcessBuildersCount;

  // -- apiVersions category
  const apiVersionsRaw = deprecatedApiVersionApexCount;

  // -- codeQuality category — null when v2.1 hasn't shipped to this vault.
  const cqRes = await computeCodeQualityCounts(ctx);
  if (!cqRes.ok) return err({ kind: 'internal', message: cqRes.error });
  const cq = cqRes.value;
  const codeQualityRaw = cq === null ? 0 : cq.critical + cq.high;
  const codeQualityExtractorRan = cq !== null;

  // -- freshness category — null when v1.7 R2 hasn't run.
  const frRes = await computeFreshnessCounts(ctx);
  if (!frRes.ok) return err({ kind: 'internal', message: frRes.error });
  const fr = frRes.value;
  const freshnessRaw = fr === null ? 0 : fr.olderThan1Year;
  const freshnessExtractorRan = fr !== null;

  // -- unassignedGrants category
  const upsRes = await unassignedPermissionSetsHandler(ctx, {});
  if (!upsRes.ok) return err(upsRes.error);
  const ups = upsRes.value.data;
  const eqRes = await emptyQueuesAndGroupsHandler(ctx, {});
  if (!eqRes.ok) return err(eqRes.error);
  const eq = eqRes.value.data;
  // Honesty: when enrichmentStatus is structural-only or
  // no-assignment-data, the unassigned-permission-set count is NOT
  // authoritative. We still include the category, but treat it as
  // EXTRACTOR-NOT-RUN if no enrichment data exists at all.
  const unassignedPsAuthoritative =
    ups.enrichmentStatus === 'tooling-api-fresh' ||
    ups.enrichmentStatus === 'tooling-api-stale';
  const unassignedGrantsExtractorRan =
    unassignedPsAuthoritative || ups.unknownAssignmentCount === 0;
  const unassignedGrantsRaw = unassignedPsAuthoritative
    ? ups.unassignedCount + eq.totalQueues + eq.totalGroups
    : eq.totalQueues + eq.totalGroups;

  // Build excluded categories list.
  const excluded: ExcludedCategory[] = [];
  for (const cat of excludedByUser) {
    excluded.push({
      category: cat,
      reason: 'user-opted-out',
      note: 'category excluded at user request via excludeCategories input.',
    });
  }
  if (!codeQualityExtractorRan && !excludedByUser.has('codeQuality')) {
    excluded.push({
      category: 'codeQuality',
      reason: 'extractor-not-run',
      note: 'v2.1 qualityIssues data is not present on any ApexClass / ApexTrigger / Flow node. Run the v2.1 code-quality recognizer pass to compute this category.',
    });
  }
  if (!freshnessExtractorRan && !excludedByUser.has('freshness')) {
    excluded.push({
      category: 'freshness',
      reason: 'extractor-not-run',
      note: 'v1.7 R2 freshness data (lastModifiedDate) is not populated. Run `sfi refresh --with-tooling-api` to enrich freshness fields.',
    });
  }
  if (!unassignedGrantsExtractorRan && !excludedByUser.has('unassignedGrants')) {
    const unknownNote =
      ups.unknownAssignmentCount > 0
        ? `${ups.unknownAssignmentCount} permission set(s) have unknown assignment status (not counted as unassigned). `
        : '';
    excluded.push({
      category: 'unassignedGrants',
      reason: 'extractor-not-run',
      note:
        `${unknownNote}v1.7 R2 permission-set assignment data is not populated. ` +
        'Run `sfi refresh --classify-permissions` to enrich grant data.',
    });
  }

  const excludedSet = new Set<TechDebtCategory>(excluded.map((e) => e.category));

  const detailWhenIncluded = (
    category: TechDebtCategory,
    value: number,
  ): number | null => (excludedSet.has(category) ? null : value);

  const contributions: Record<TechDebtCategory, number> = {
    deadWeight: contribFor('deadWeight', deadWeightRaw),
    legacyAutomation: contribFor('legacyAutomation', legacyAutomationRaw),
    codeQuality: contribFor('codeQuality', codeQualityRaw),
    freshness: contribFor('freshness', freshnessRaw),
    apiVersions: contribFor('apiVersions', apiVersionsRaw),
    unassignedGrants: contribFor('unassignedGrants', unassignedGrantsRaw),
  };

  const overallScore = weightedScore(contributions, weightsApplied, excludedSet);
  const scoreBand = bandFor(overallScore);

  // Build categories breakdown — include all categories, but mark
  // contribution=0 when excluded so the user sees the structure.
  const unassignedGrantsExcluded = excludedSet.has('unassignedGrants');

  const categories: Record<TechDebtCategory, CategoryBreakdown> = {
    deadWeight: {
      weight: weightsApplied.deadWeight,
      rawCount: detailWhenIncluded('deadWeight', deadWeightRaw),
      contribution: excludedSet.has('deadWeight')
        ? 0
        : contributions.deadWeight,
      details: {
        unusedFieldsCount: detailWhenIncluded('deadWeight', unusedFieldsCount),
        unusedFieldsDeepCount: detailWhenIncluded(
          'deadWeight',
          unusedFieldsDeepCount,
        ),
        unusedApexClassesCount: detailWhenIncluded(
          'deadWeight',
          unusedApexClassesCount,
        ),
        unusedFlowsCount: detailWhenIncluded('deadWeight', unusedFlowsCount),
        unusedEmailTemplatesCount: detailWhenIncluded(
          'deadWeight',
          unusedEmailTemplatesCount,
        ),
        unusedStaticResourcesCount: detailWhenIncluded(
          'deadWeight',
          unusedStaticResourcesCount,
        ),
        unusedCustomLabelsCount: detailWhenIncluded(
          'deadWeight',
          unusedCustomLabelsCount,
        ),
      },
    },
    legacyAutomation: {
      weight: weightsApplied.legacyAutomation,
      rawCount: detailWhenIncluded('legacyAutomation', legacyAutomationRaw),
      contribution: excludedSet.has('legacyAutomation')
        ? 0
        : contributions.legacyAutomation,
      details: {
        activeWorkflowRulesCount: detailWhenIncluded(
          'legacyAutomation',
          activeWorkflowRulesCount,
        ),
        activeProcessBuildersCount: detailWhenIncluded(
          'legacyAutomation',
          activeProcessBuildersCount,
        ),
      },
    },
    codeQuality: {
      weight: weightsApplied.codeQuality,
      rawCount: detailWhenIncluded('codeQuality', codeQualityRaw),
      contribution: excludedSet.has('codeQuality')
        ? 0
        : contributions.codeQuality,
      details: {
        criticalIssuesCount: detailWhenIncluded('codeQuality', cq?.critical ?? 0),
        highIssuesCount: detailWhenIncluded('codeQuality', cq?.high ?? 0),
        mediumIssuesCount: detailWhenIncluded('codeQuality', cq?.medium ?? 0),
      },
    },
    freshness: {
      weight: weightsApplied.freshness,
      rawCount: detailWhenIncluded('freshness', freshnessRaw),
      contribution: excludedSet.has('freshness')
        ? 0
        : contributions.freshness,
      details: {
        componentsOlderThan1Year: detailWhenIncluded(
          'freshness',
          fr?.olderThan1Year ?? 0,
        ),
        componentsOlderThan2Years: detailWhenIncluded(
          'freshness',
          fr?.olderThan2Years ?? 0,
        ),
        // Always null/unknown — "never modified since creation" needs a
        // per-component createdDate that the vault/graph does not capture, so we
        // report null (not measured) rather than a fabricated 0. Null in BOTH
        // the data-present and freshness-excluded paths. (CR-16a)
        componentsNeverModifiedSinceCreation: fr?.neverModified ?? null,
      },
    },
    apiVersions: {
      weight: weightsApplied.apiVersions,
      rawCount: detailWhenIncluded('apiVersions', apiVersionsRaw),
      contribution: excludedSet.has('apiVersions')
        ? 0
        : contributions.apiVersions,
      details: {
        apexBelowApiVersion30Count: detailWhenIncluded('apiVersions', av.below30),
        apexBelowApiVersion40Count: detailWhenIncluded('apiVersions', av.below40),
        apexBelowApiVersion50Count: detailWhenIncluded('apiVersions', av.below50),
        oldestApiVersionInOrg: detailWhenIncluded('apiVersions', av.oldest ?? 0),
      },
    },
    unassignedGrants: {
      weight: weightsApplied.unassignedGrants,
      rawCount: detailWhenIncluded('unassignedGrants', unassignedGrantsRaw),
      contribution: unassignedGrantsExcluded
        ? 0
        : contributions.unassignedGrants,
      details: {
        unassignedPermissionSetsCount: unassignedGrantsExcluded
          ? null
          : ups.unassignedCount,
        // Always surface unknown-assignment count — it is the honest signal when
        // tooling API enrichment did not run (Bug 20).
        unknownAssignmentPermissionSetsCount: ups.unknownAssignmentCount,
        emptyQueuesCount: unassignedGrantsExcluded ? null : eq.totalQueues,
        emptyGroupsCount: unassignedGrantsExcluded ? null : eq.totalGroups,
      },
    },
  };

  // Build recommended actions ordered by contribution desc.
  const orderedRecs = (Object.entries(categories) as [
    TechDebtCategory,
    CategoryBreakdown,
  ][])
    .filter(([cat]) => !excludedSet.has(cat))
    .sort((a, b) => b[1].contribution - a[1].contribution)
    .slice(0, 5)
    .map(([cat, br]) =>
      recommendationFor(cat, br.rawCount ?? 0, br.contribution, br.weight),
    );

  // Compose boundaries: always include direction + weight scheme +
  // exclusion note (verbatim Q115 disclosure when extractor-not-run).
  const boundaries: string[] = [
    SCORE_DIRECTION_DISCLOSURE,
    WEIGHT_SCHEME_DISCLOSURE,
  ];
  if (excluded.some((e) => e.reason === 'extractor-not-run')) {
    boundaries.push(Q115_DISCLOSURE);
  }
  // Cite the heuristic tier whenever the codeQuality axis actually contributes
  // (its input is the heuristic Apex scanner). When the axis is excluded it is
  // not part of the score, so the disclosure would be misleading.
  if (codeQualityExtractorRan && !excludedSet.has('codeQuality')) {
    boundaries.push(CODE_QUALITY_HEURISTIC_DISCLOSURE);
  }
  // When freshness is INCLUDED, state honestly that the never-modified count is
  // not available (no createdDate in the vault) rather than emit a fabricated 0.
  // When freshness is excluded the extractor-not-run note already covers it.
  if (freshnessExtractorRan && !excludedSet.has('freshness')) {
    boundaries.push(NEVER_MODIFIED_UNAVAILABLE_DISCLOSURE);
  }

  // Hardcoded-Salesforce-ID debt, sourced from the dedicated recognizer so the
  // score's consumer is not misled into reading "0 dead code" as "0 code debt".
  // It is NOT folded into the weighted score (that would shift the model and
  // its goldens); it is surfaced as a separate, disclosed signal.
  let hardcodedIdCount: number | null = null;
  const hardcoded = await findHardcodedValuesAnywhereHandler(ctx, {
    category: 'id',
  });
  if (hardcoded.ok) {
    hardcodedIdCount = hardcoded.value.data.byCategory.id;
    if (hardcodedIdCount > 0) {
      boundaries.push(
        `${hardcodedIdCount} hardcoded Salesforce ID(s) detected by ` +
          `\`sfi.find_hardcoded_values_anywhere\` — this is code debt that is NOT ` +
          `folded into the weighted score; review it separately.`,
      );
    }
  }

  const roundedScore = Math.round(overallScore * 100) / 100;
  // P9-risk-delta: the signed change vs the prior refresh's logged score.
  const prior = await readPriorTechDebtScore(
    ctx.vaultRoot,
    ctx.manifest.sourceTreeHash,
  );
  const deltaFields =
    prior !== null
      ? {
          scoreDelta: Math.round((roundedScore - prior.score) * 100) / 100,
          previousScore: prior.score,
          ...(prior.refreshedAt.length > 0
            ? { previousRefreshedAt: prior.refreshedAt }
            : {}),
        }
      : {};

  return ok({
    data: {
      overallScore: roundedScore,
      ...deltaFields,
      scoreBand,
      categories,
      excludedCategories: excluded,
      weightingDisclosure: {
        weightsApplied,
        weightsDefault: DEFAULT_WEIGHTS,
        deviation,
      },
      recommendedActions: orderedRecs,
      hardcodedIdCount,
      boundaries,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
