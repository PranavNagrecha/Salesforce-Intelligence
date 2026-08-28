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
 * score band. An axis excluded because a scan was CAPPED (the data
 * exists, it just was not all read) carries `'insufficient-data'`
 * instead, precisely so the Q115 "run the appropriate refresh
 * command" remedy is NOT emitted for a cap no refresh can lift.
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
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  buildEnumerationCoverageCaveatFor,
  type CoverageCaveat,
} from './coverage-trust.js';
import {
  emptyQueuesAndGroupsHandler,
} from './empty-queues-and-groups.js';
import { findHardcodedValuesAnywhereHandler } from './find-hardcoded-values-anywhere.js';
import { firstNonEmpty } from './input-aliases.js';
import {
  processBuilderMigrationCandidatesHandler,
} from './process-builder-migration-candidates.js';
import {
  buildNotCheckedTypesNote,
  buildUnscannedNodesNote,
  censusQualityScanCoverage,
  NOT_APEX_TYPES,
  type QualityScanTypeCoverage,
} from './quality-scan-coverage.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { FULL_SCAN_MAX_NODES, fullScanTruncationNote } from './scan-cap.js';
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
 * Test-only override for the residual cap `loadAllNodes` passes to the shared
 * `scanAllNodesOfTypes` walk. Unset (`undefined`) in production, where the
 * walk uses its own default ({@link FULL_SCAN_MAX_NODES}, 20 000 — far above
 * any real org). A test sets `SFI_TECH_DEBT_SCAN_MAX_NODES` to force the
 * residual cap (and the `scanIncomplete` boundary disclosure it drives) without
 * seeding 20 000 real rows — the same test-seam pattern `SFI_NODE_SCAN_LIMIT`
 * already gives the per-window size (`clampedNodeScanLimit`, read internally
 * by `scanAllNodesOfTypes`).
 */
const scanMaxNodesOverride = (): number | undefined => {
  const v = Number(process.env['SFI_TECH_DEBT_SCAN_MAX_NODES']);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
};

/**
 * The residual per-type ceiling actually APPLIED to this invocation's scans.
 *
 * Read from ONE place by both the walk (`loadAllNodes`) and the disclosure
 * that reports it (`fullScanTruncationNote`'s `fullScanCap` argument). Read
 * twice, they drift: the note's default is the module constant, so a run under
 * the override used to announce "Full scan capped at 20000 nodes per type"
 * while the cap that actually bit was the override's value — a disclosure tool
 * stating the wrong number for its own limit.
 */
const residualScanCap = (): number =>
  scanMaxNodesOverride() ?? FULL_SCAN_MAX_NODES;

/**
 * Load EVERY node of a single ComponentType, not just the first page. The
 * tech-debt composite SCORE inspects per-node properties (apiVersion,
 * qualityIssues, lastModifiedDate) and must be computed over the COMPLETE set —
 * a single `listNodesByType` page caps at 500 (id ASC), so an org with > 500 of
 * a scanned type used to score off only the first page (a saturated, wrong
 * composite).
 *
 * R6 adoption: this used to be a private re-implementation of the multi-window
 * offset walk (its own 500 `PAGE_CAP`, its own `countNodesByType` cross-check),
 * which had already diverged from the shared {@link scanAllNodesOfTypes} in two
 * ways — no {@link FULL_SCAN_MAX_NODES} residual ceiling (a pathological type
 * walked unbounded) and no way for a caller to learn a walk was capped. Now a
 * thin delegate: every type the residual cap actually bit on is appended to
 * `incompleteAcc` (when the caller passes one) so the composer can disclose it
 * — see the `scanIncomplete` boundary in {@link techDebtScoreHandler}.
 *
 * The residual ceiling is passed as the BARE `maxNodes` number rather than an
 * options object: that is the shared helper's long-standing third-argument
 * form and the only one this file needs, so this call site does not depend on
 * any newer overload of a module it does not own.
 */
const loadAllNodes = async (
  ctx: Context,
  type: ComponentType,
  incompleteAcc?: Set<string>,
): Promise<Result<readonly Node[], string>> => {
  const r = await scanAllNodesOfTypes(ctx.graph, [type], residualScanCap());
  if (!r.ok) return err(r.error.message);
  if (incompleteAcc !== undefined) {
    for (const t of r.value.incompleteTypes) incompleteAcc.add(t);
  }
  return ok(r.value.nodes);
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

/**
 * TECH-DEBT-UNCHECKED-ZERO-SCORED-AS-CLEAN. The metadata families each axis's
 * `rawCount` is summed OVER — the axis's evidence base.
 *
 * The bug this table closes: `legacyAutomation` read `WorkflowRule` straight
 * off the graph and scored the resulting 0 as a measured, clean zero on its
 * heaviest axis (weight 0.20) — on a vault whose OWN coverage row said
 * `{requested: true, retrieved: 0}` with NO `retrieveConfirmed`, i.e. the
 * family was never confirmed-retrieved. `coverage_report` listed it in
 * `trust.completeness.missingCoverage` and `list_components` called it "not
 * retrieved, not proof of absence" — while this composite called the same
 * signal ZERO, contradicting its own printed Q115 boundary ("missing axes are
 * EXCLUDED, not assumed zero"). Same defect on `deadWeight`'s
 * `unusedEmailTemplatesCount`.
 *
 * The gate is COVERAGE (`retrieveConfirmed` / `missingCoverage` per
 * {@link summarizeCoverage}), never the raw count — a count-based gate is the
 * very confusion being fixed, and it would also mis-fire the other way (a
 * confirmed-clean zero on a fully-retrieved vault is a REAL zero and must keep
 * scoring). Arithmetic honesty: a sum with an UNCHECKED term is unchecked, not
 * zero, so the axis is EXCLUDED (`extractor-not-run`) and `rawCount` is null.
 * Per-family `details` still carry the real numbers for the families that WERE
 * checked, and `null` only for the ones that were not — so the reader can see
 * exactly which term went missing rather than losing the whole breakdown.
 */
const AXIS_FAMILIES: Readonly<
  Record<TechDebtCategory, readonly ComponentType[]>
> = Object.freeze({
  // unused_components byType + unused_fields_deep
  deadWeight: [
    'CustomField',
    'ApexClass',
    'Flow',
    'EmailTemplate',
    'StaticResource',
    'CustomLabel',
  ],
  // WorkflowRule + Process Builders (a Flow with processType Workflow)
  legacyAutomation: ['WorkflowRule', 'Flow'],
  codeQuality: ['ApexClass', 'ApexTrigger'],
  freshness: [
    'ApexClass',
    'ApexTrigger',
    'Flow',
    'CustomField',
    'Layout',
    'ValidationRule',
  ],
  apiVersions: ['ApexClass'],
  unassignedGrants: ['PermissionSet', 'Queue', 'Group'],
});


type ScoreBand =
  | 'low-debt'
  | 'moderate-debt'
  | 'high-debt'
  | 'critical-debt';

/**
 * Why an axis is not scored.
 * - `'user-opted-out'` — the caller passed it in `excludeCategories`.
 * - `'extractor-not-run'` — the backing family was never extracted/retrieved,
 *   so a refresh is a real remedy (this is the reason that appends
 *   {@link Q115_DISCLOSURE}).
 * - `'insufficient-data'` — the family WAS extracted but the measurement is
 *   incomplete (e.g. a sub-tool capped its scan), so the count would be a sum
 *   with an unchecked term. A refresh cannot fix this, so the Q115 refresh
 *   remedy is deliberately NOT emitted; the per-exclusion `note` carries the
 *   remedy that actually applies.
 */
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
  // TECH-DEBT-SCORE-IGNORES-OBJECT-SCOPE: object / domain scope keys a host
  // reaches for on "tech debt for the {object} domain". Accepted here ONLY so the
  // handler can REFUSE with the org-wide-only pointer instead of silently
  // returning the fleet-wide score (which was byte-identical scoped vs bare).
  // NEVER a valid scope — this composite is org-wide.
  objectApiName: z.string().min(1).optional(),
  object: z.string().min(1).optional(),
  objectId: z.string().min(1).optional(),
  componentId: z.string().min(1).optional(),
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
  /**
   * Echoes the scope ACTUALLY applied so a host never assumes an object /
   * domain key it passed was honored — this composite is ORG-WIDE, so `object`
   * is always `null` and `mode` is always `'all'`. A call that DID pass an
   * object / component scope is rejected upstream with `invalid-query`
   * (TECH-DEBT-SCORE-IGNORES-OBJECT-SCOPE), never silently answered org-wide.
   */
  readonly appliedScope: {
    readonly object: string | null;
    readonly mode: 'all';
  };
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
  /**
   * QUALITY-SCAN-SKIPS-TRIGGERS-AND-FLOWS. Per-type count of Apex nodes read vs
   * nodes that actually carry a `qualityIssues` scan, feeding the `codeQuality`
   * axis. Present ONLY when the axis ran AND some node was never scanned — the
   * path where the axis is computed over part of the Apex surface and presented
   * as whole. A fully-scanned vault omits it and its response is unchanged.
   */
  readonly qualityScanCoverage?: readonly QualityScanTypeCoverage[];
  /**
   * Types the `codeQuality` axis structurally cannot cover on any vault after
   * any refresh — currently `Flow`, because the recognizers read Apex syntax.
   * Present ONLY when the axis contributes to the score, where a reader could
   * otherwise take "code quality" to span every automation surface.
   */
  readonly notCheckedTypes?: typeof NOT_APEX_TYPES;
  /**
   * TECH-DEBT-UNCHECKED-ZERO-SCORED-AS-CLEAN. Present when a metadata family an
   * axis is computed FROM was not confirmed-retrieved into this vault, so at
   * least one axis is excluded as UNCHECKED rather than scored as a clean zero.
   * Same shape every other coverage-aware tool emits, so a host renders it the
   * same way; absent on a vault whose axis families all retrieved clean (the
   * response is then byte-identical to before this field existed).
   */
  readonly coverageCaveat?: CoverageCaveat;
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
 * QUALITY-SCAN-SKIPS-TRIGGERS-AND-FLOWS, in the ROLL-UP's own voice.
 *
 * `code_quality_audit` discloses its unscanned nodes verbatim ("NOT SCANNED IN
 * THIS VAULT: 22 of 22 ApexTrigger node(s)…"); the composite carried that
 * sentence in `boundaries` and `qualityScanCoverage` but its
 * `recommendedActions` still said, flatly, "357 critical or high severity
 * issues detected" — a whole-surface claim over a partly-scanned surface, in
 * the one field a host is most likely to quote back. The issue count is a
 * FLOOR whenever any Apex node carries no `qualityIssues` scan; say so where
 * the number is stated, not only three fields away.
 *
 * Empty string when every scanned node carries a scan, so a fully-scanned
 * vault's recommendation text is byte-identical to before.
 */
const unscannedRecommendationQualifier = (
  coverage: readonly QualityScanTypeCoverage[],
): string => {
  const gaps = coverage.filter((c) => c.scanned < c.nodes);
  if (gaps.length === 0) return '';
  const named = gaps
    .map((c) => `${c.nodes - c.scanned} of ${c.nodes} ${c.type}`)
    .join(', ');
  return ` This is a FLOOR, not a total: ${named} node(s) carry no \`qualityIssues\` property, so the recognizers never ran over their source and their findings are NOT in this count — zero findings for them is "not checked", NOT "clean" (see \`qualityScanCoverage\`; re-run \`sfi refresh\` to close the gap).`;
};

/**
 * Recommendation text per category — surfaced verbatim in
 * `recommendedActions`. `qualifier` is appended to the axes that need a
 * partial-measurement caveat stated where the number is stated (today:
 * `codeQuality`, see {@link unscannedRecommendationQualifier}).
 */
const recommendationFor = (
  category: TechDebtCategory,
  rawCount: number,
  contribution: number,
  weight: number,
  qualifier = '',
): string => {
  const wPct = (weight * 100).toFixed(0);
  switch (category) {
    case 'deadWeight':
      return `close dead-weight backlog — ${rawCount} unused component(s) detected, contributing ${contribution.toFixed(1)}/100 at weight ${wPct}%.`;
    case 'legacyAutomation':
      return `close legacy-automation backlog — ${rawCount} legacy automation entries (Process Builders + WorkflowRules) detected, contributing ${contribution.toFixed(1)}/100 at weight ${wPct}%.`;
    case 'codeQuality':
      return `address code-quality findings — ${rawCount} critical or high severity issues detected, contributing ${contribution.toFixed(1)}/100 at weight ${wPct}%.${qualifier}`;
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
  incompleteAcc?: Set<string>,
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
  const r = await loadAllNodes(ctx, 'ApexClass', incompleteAcc);
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
 * Aggregate `qualityIssues` arrays across every ApexClass / ApexTrigger node.
 * Each node's `qualityIssues` is an array of objects with
 * `severity: 'critical' | 'high' | 'medium' | 'low'`. When NO node carries the
 * `qualityIssues` property, returns null — signals "extractor not run", and the
 * whole codeQuality category is EXCLUDED rather than scored as zero.
 *
 * QUALITY-SCAN-SKIPS-TRIGGERS-AND-FLOWS, twice over.
 *
 *  1. `Flow` used to be in this fetch. It contributed exactly 0 of 275 nodes on
 *     a real vault, because every recognizer reads Apex syntax and a Flow has
 *     none — so loading it was 275 wasted node reads that could never move the
 *     score. It is now named in {@link NOT_APEX_TYPES} on the response instead
 *     of silently scanned. Dropping it cannot change any score: a Flow node
 *     could never carry the property in the first place.
 *  2. `anyNodeHasIssuesProperty` is an ANY, so 192-of-192 ApexClasses scanned
 *     and 0-of-22 ApexTriggers scanned reported "extractor ran" and said
 *     nothing at all about the triggers — a codeQuality axis computed over
 *     two-thirds of the Apex surface, presented as whole. {@link coverage}
 *     carries the per-type split so the caller can see it.
 */
const computeCodeQualityCounts = async (
  ctx: Context,
  incompleteAcc?: Set<string>,
): Promise<
  Result<
    | {
        readonly critical: number;
        readonly high: number;
        readonly medium: number;
        readonly anyNodeHasIssuesProperty: boolean;
        /** Per-type nodes-read vs nodes-actually-scanned for the Apex types. */
        readonly coverage: readonly QualityScanTypeCoverage[];
      }
    | null,
    string
  >
> => {
  const fetchType = async (
    type: ComponentType,
  ): Promise<Result<readonly Node[], string>> =>
    loadAllNodes(ctx, type, incompleteAcc);
  const cs = await fetchType('ApexClass');
  if (!cs.ok) return err(cs.error);
  const ts = await fetchType('ApexTrigger');
  if (!ts.ok) return err(ts.error);
  const apexNodes = [...cs.value, ...ts.value];
  let critical = 0;
  let high = 0;
  let medium = 0;
  let anyNodeHasIssuesProperty = false;
  for (const n of apexNodes) {
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
  return ok({
    critical,
    high,
    medium,
    anyNodeHasIssuesProperty,
    coverage: censusQualityScanCoverage(apexNodes),
  });
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
  incompleteAcc?: Set<string>,
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
    const r = await loadAllNodes(ctx, t, incompleteAcc);
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
  // TECH-DEBT-SCORE-IGNORES-OBJECT-SCOPE: refuse an object / domain scope rather
  // than silently returning the fleet-wide score (byte-identical scoped vs bare,
  // so a host invents a domain binding). The score composes org-wide extractors;
  // there is no honest per-object subset to return — point at the object-scoped
  // hygiene tools instead.
  const scopeKey = firstNonEmpty(
    input.objectApiName,
    input.object,
    input.objectId,
    input.componentId,
  );
  if (scopeKey !== undefined) {
    return err({
      kind: 'invalid-query',
      message:
        `tech_debt_score is an ORG-WIDE weighted composite; it cannot scope to a single object or domain (\`${scopeKey}\`). ` +
        'Its categories (deadWeight / legacyAutomation / codeQuality / freshness / apiVersions / unassignedGrants) roll up whole-org extractors that are not partitioned by object. ' +
        'For per-object debt signals run the object-scoped tools on that object — `object_access_audit`, `safe_to_delete_field`, `find_component_usages` — or `code_quality_audit` for code. Call tech_debt_score with only `weights` / `excludeCategories` for the whole-org score.',
      path: 'objectApiName',
    });
  }

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
  // staticOnly: this composition reads ONLY `ufd.totalCount` (the static count),
  // so it must NOT trigger the CR-CAP-L5 live-population cross-check. Without
  // this guard, a standing-consent org would fire ~2 live SELECT COUNT() reads
  // per high-confidence unused field from inside the score roll-up — hundreds of
  // serial live queries pushing tech_debt_score (and org_risk_report /
  // release_readiness_report, which compose it) past the MCP 60s client timeout.
  // The live cross-check never changes `totalCount`, so the score is byte-
  // identical to the discarded-live path — just without the wasted queries.
  const ufdRes = await unusedFieldsDeepHandler(ctx, { staticOnly: true });
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
  // R6: types whose full-node scan (deadWeight/apiVersions/codeQuality/
  // freshness axes, via `loadAllNodes` -> the shared `scanAllNodesOfTypes`)
  // stopped at the residual FULL_SCAN_MAX_NODES cap with more nodes behind it
  // — collected across every axis so one boundary can disclose all of them.
  const scanIncompleteTypes = new Set<string>();
  const apiVersionsRes = await computeApiVersionDistribution(
    ctx,
    scanIncompleteTypes,
  );
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
  const cqRes = await computeCodeQualityCounts(ctx, scanIncompleteTypes);
  if (!cqRes.ok) return err({ kind: 'internal', message: cqRes.error });
  const cq = cqRes.value;
  const codeQualityRaw = cq === null ? 0 : cq.critical + cq.high;
  const codeQualityExtractorRan = cq !== null;

  // -- freshness category — null when v1.7 R2 hasn't run.
  const frRes = await computeFreshnessCounts(ctx, scanIncompleteTypes);
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
  // UNMEASURED-CONTAINERS-SCORED-AS-DEAD-WEIGHT. `totalQueues` / `totalGroups`
  // are ROW COUNTS and include the `unknown-membership` rows — containers whose
  // emptiness was never MEASURED. Adding them here charged the org debt score
  // for containers nobody had looked at, which is exactly the "absence of
  // evidence read as evidence" this axis exists to avoid; on a real vault that
  // was 42 unmeasured containers scored as confirmed dead weight. Score only
  // what was measured: `confirmedEmptyQueues + unknownMemberCountQueues ===
  // totalQueues` by construction, so the unknown rows are not lost, they move
  // to the honest-signal keys in `details` below.
  const unassignedGrantsRaw = unassignedPsAuthoritative
    ? ups.unassignedCount + eq.confirmedEmptyQueues + eq.confirmedEmptyGroups
    : eq.confirmedEmptyQueues + eq.confirmedEmptyGroups;

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
      note: 'qualityIssues data is not present on any ApexClass / ApexTrigger node, so the code-quality recognizers never ran over this vault. Re-run `sfi refresh` to compute this category. (Flow is not scanned by design — the recognizers read Apex syntax; see `notCheckedTypes`.)',
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
  // R1: `sfi.process_builder_migration_candidates` caps its internal
  // WorkflowRule/Flow/ApprovalProcess scan at 500 nodes per type and honestly
  // discloses it on its OWN response via `scanTruncated` + `trueTypeCounts`
  // (never in `totalWorkflowRules`/`totalProcessBuilders`, which stay counted
  // from the capped, alphabetically-first page). A capped scan is the same
  // kind of unchecked term the coverage gate below excludes for — it just
  // arrives through a different door (a sub-tool's cap, not missing retrieve
  // coverage) — so this axis is EXCLUDED, not scored on a partial subset.
  //
  // The reason is `'insufficient-data'`, NOT `'extractor-not-run'`: the
  // extractor DID run and the family IS retrieved — the sub-tool's per-type
  // page cap is what made the term unchecked. That distinction is
  // load-bearing, because `'extractor-not-run'` is the key that appends the
  // verbatim Q115 boundary ("To compute the missing categories, run the
  // appropriate refresh command") further down, and no refresh can lift a
  // 500-node scan cap — emitting it here would be a dead-end remedy stated as
  // fact by a disclosure tool. The note below carries the remedy that DOES
  // work (page the sub-tool's cursor directly).
  //
  // The exclusion is ALSO announced in `boundaries` further down
  // (`legacyScanCapBoundary`). `excludedCategories` is the typed field a
  // machine consumer cannot skip; `boundaries` is the prose a host reads
  // aloud. Populating only the first is how a dropped 0.20-weight axis went
  // unmentioned in every sentence the caller actually sees.
  let legacyScanCapBoundary: string | undefined;
  if (lc.scanTruncated === true && !excludedByUser.has('legacyAutomation')) {
    const trueCounts = lc.trueTypeCounts ?? {};
    const cappedRows: readonly (readonly [string, number | undefined])[] = [
      ['WorkflowRule', trueCounts.workflowRules],
      ['Flow (Process Builder)', trueCounts.flows],
      ['ApprovalProcess', trueCounts.approvalProcesses],
    ];
    const capped = cappedRows
      .filter((pair): pair is readonly [string, number] => pair[1] !== undefined)
      .map(([label, count]) => `${label}: ${count} actual vs a 500-node scan cap`)
      .join(', ');
    excluded.push({
      category: 'legacyAutomation',
      reason: 'insufficient-data',
      note:
        `sfi.process_builder_migration_candidates capped its internal scan at 500 nodes per type (${capped}), so activeWorkflowRulesCount/activeProcessBuildersCount would be counted from an alphabetically-first subset, not the complete org. This axis's raw count would be a sum with an UNCHECKED term, so it is EXCLUDED from the score rather than scored on a capped subset. Call \`sfi.process_builder_migration_candidates\` directly and page its cursor for the complete inventory.`,
    });
    // Deliberately worded WITHOUT the word "refresh": a re-retrieve re-reads
    // the same 500-node window, so naming it here would be the dead-end
    // remedy this exclusion exists to avoid stating (that is why the reason is
    // `'insufficient-data'` and not `'extractor-not-run'`).
    //
    // Two numbers in this sentence are read from the values that ACTUALLY
    // applied, never from the module defaults: the weight comes from
    // `weightsApplied` (a caller who passed `weights` re-weighted this axis,
    // and quoting DEFAULT_WEIGHTS would announce a share the run never used),
    // and the score arithmetic is described as `weightedScore` performs it.
    // That function SKIPS an excluded axis in both the numerator and the
    // denominator — it re-normalises over the surviving weights rather than
    // folding a zero in — so "contributes 0" would read as "this axis dragged
    // the score DOWN", i.e. understating debt, which is the opposite of what
    // happens. The typed `categories.legacyAutomation.contribution` field does
    // read 0; the prose has to say what that 0 means.
    legacyScanCapBoundary =
      `UNCHECKED, NOT ZERO — legacyAutomation (weight ${weightsApplied.legacyAutomation}) is EXCLUDED from this score: ` +
      `\`sfi.process_builder_migration_candidates\` capped its internal scan at 500 nodes per type (${capped}), so the axis would have been counted from an alphabetically-first subset rather than the complete org. ` +
      `An excluded axis is REMOVED from the weighted mean — dropped from both the numerator and the divisor, so the remaining axes are re-normalised over their own weights and absorb its share; it is not folded in as a zero. Its \`contribution\` field reads 0 because the axis was not scored, NOT because the org scored clean there. This composite is therefore NOT comparable to one from an org under the cap. ` +
      `Call \`sfi.process_builder_migration_candidates\` directly and page its cursor for the complete automation inventory.`;
  }

  // TECH-DEBT-UNCHECKED-ZERO-SCORED-AS-CLEAN. Gate every axis on the COVERAGE
  // of the families it is computed from (see {@link AXIS_FAMILIES}). A family
  // the vault never confirmed-retrieved makes the axis's raw count a sum with
  // an UNCHECKED term — which is not a zero, so the axis is EXCLUDED rather
  // than scored. Guarded by `coverageKnown`: a pre-v4 / fixture manifest
  // carries no coverage rows at all, and a vault whose completeness is unknown
  // must never be false-flagged (same guard every other coverage-aware tool
  // uses). On a vault whose rows carry `retrieveConfirmed`, a retrieved-zero
  // family is COVERED and its zero keeps scoring — a confirmed-clean zero is a
  // real measurement, and that is the case this gate must NOT disturb.
  const uncheckedByAxis = new Map<TechDebtCategory, readonly string[]>();
  const uncheckedFamilies = new Set<string>();
  for (const cat of ALLOWED_WEIGHT_KEYS) {
    const cov = summarizeCoverage(ctx.manifest, AXIS_FAMILIES[cat]);
    const missing = cov.coverageKnown ? cov.missingCoverage : [];
    uncheckedByAxis.set(cat, missing);
    for (const family of missing) uncheckedFamilies.add(family);
  }
  // Categories excluded specifically BECAUSE of retrieve coverage. Kept apart
  // from the other exclusion reasons because their `details` behave
  // differently: an extractor that never ran measured NOTHING (every detail is
  // null), whereas a coverage gap left the OTHER families measured — nulling
  // those too would throw away real, actionable counts and would itself be a
  // small dishonesty ("not measured" for something that was).
  const coverageExcluded = new Set<TechDebtCategory>();
  const alreadyExcluded = new Set<TechDebtCategory>(excluded.map((e) => e.category));
  for (const cat of ALLOWED_WEIGHT_KEYS) {
    if (alreadyExcluded.has(cat)) continue;
    const missing = uncheckedByAxis.get(cat) ?? [];
    if (missing.length === 0) continue;
    coverageExcluded.add(cat);
    const named = missing.join(', ');
    excluded.push({
      category: cat,
      reason: 'extractor-not-run',
      note:
        `${named} was never confirmed-retrieved into this vault (\`sfi.coverage_report\` lists it in \`trust.completeness.missingCoverage\`; \`sfi.list_components\` calls it "not retrieved", not proof of absence), ` +
        `so this axis's raw count would be a sum with an UNCHECKED term. A zero here would mean "not checked", NOT "none in the org", so the axis is EXCLUDED from the score rather than scored as a clean zero. ` +
        `The families that WERE checked keep their real counts in \`details\`; the unchecked one(s) are null. Run \`sfi refresh\` (widen the retrieve to include ${named}) to score this axis.`,
    });
  }

  const excludedSet = new Set<TechDebtCategory>(excluded.map((e) => e.category));

  /**
   * A per-axis raw count: null whenever the axis is excluded (including the
   * coverage case — an unchecked term makes the whole sum unchecked).
   */
  const rawWhenIncluded = (
    category: TechDebtCategory,
    value: number,
  ): number | null => (excludedSet.has(category) ? null : value);

  /**
   * One `details` entry. `family` is the metadata family THIS number is
   * counted over (null when the number spans the axis's whole family set, so
   * no single family can be blamed for it):
   *
   *   - the family is unchecked        -> null (never a fabricated 0)
   *   - the axis is excluded for a
   *     non-coverage reason            -> null (nothing was measured at all)
   *   - otherwise                      -> the measured value, even when the
   *                                       axis is coverage-excluded, because
   *                                       that family really was checked.
   */
  const detailWhenIncluded = (
    category: TechDebtCategory,
    value: number,
    family: ComponentType | null = null,
  ): number | null => {
    if (family !== null && uncheckedFamilies.has(family)) return null;
    if (excludedSet.has(category) && !coverageExcluded.has(category)) return null;
    return value;
  };

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
      rawCount: rawWhenIncluded('deadWeight', deadWeightRaw),
      contribution: excludedSet.has('deadWeight')
        ? 0
        : contributions.deadWeight,
      details: {
        unusedFieldsCount: detailWhenIncluded(
          'deadWeight',
          unusedFieldsCount,
          'CustomField',
        ),
        unusedFieldsDeepCount: detailWhenIncluded(
          'deadWeight',
          unusedFieldsDeepCount,
          'CustomField',
        ),
        unusedApexClassesCount: detailWhenIncluded(
          'deadWeight',
          unusedApexClassesCount,
          'ApexClass',
        ),
        unusedFlowsCount: detailWhenIncluded('deadWeight', unusedFlowsCount, 'Flow'),
        unusedEmailTemplatesCount: detailWhenIncluded(
          'deadWeight',
          unusedEmailTemplatesCount,
          'EmailTemplate',
        ),
        unusedStaticResourcesCount: detailWhenIncluded(
          'deadWeight',
          unusedStaticResourcesCount,
          'StaticResource',
        ),
        unusedCustomLabelsCount: detailWhenIncluded(
          'deadWeight',
          unusedCustomLabelsCount,
          'CustomLabel',
        ),
      },
    },
    legacyAutomation: {
      weight: weightsApplied.legacyAutomation,
      rawCount: rawWhenIncluded('legacyAutomation', legacyAutomationRaw),
      contribution: excludedSet.has('legacyAutomation')
        ? 0
        : contributions.legacyAutomation,
      details: {
        activeWorkflowRulesCount: detailWhenIncluded(
          'legacyAutomation',
          activeWorkflowRulesCount,
          'WorkflowRule',
        ),
        activeProcessBuildersCount: detailWhenIncluded(
          'legacyAutomation',
          activeProcessBuildersCount,
          'Flow',
        ),
      },
    },
    codeQuality: {
      weight: weightsApplied.codeQuality,
      rawCount: rawWhenIncluded('codeQuality', codeQualityRaw),
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
      rawCount: rawWhenIncluded('freshness', freshnessRaw),
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
      rawCount: rawWhenIncluded('apiVersions', apiVersionsRaw),
      contribution: excludedSet.has('apiVersions')
        ? 0
        : contributions.apiVersions,
      details: {
        apexBelowApiVersion30Count: detailWhenIncluded('apiVersions', av.below30, 'ApexClass'),
        apexBelowApiVersion40Count: detailWhenIncluded('apiVersions', av.below40, 'ApexClass'),
        apexBelowApiVersion50Count: detailWhenIncluded('apiVersions', av.below50, 'ApexClass'),
        oldestApiVersionInOrg: detailWhenIncluded('apiVersions', av.oldest ?? 0, 'ApexClass'),
      },
    },
    unassignedGrants: {
      weight: weightsApplied.unassignedGrants,
      rawCount: rawWhenIncluded('unassignedGrants', unassignedGrantsRaw),
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
        // CONFIRMED-empty only — a key named `emptyQueuesCount` must not be a
        // row count that includes containers whose membership was never read.
        emptyQueuesCount: unassignedGrantsExcluded ? null : eq.confirmedEmptyQueues,
        emptyGroupsCount: unassignedGrantsExcluded ? null : eq.confirmedEmptyGroups,
        // Always surfaced, like unknownAssignmentPermissionSetsCount above: the
        // containers NOT scored, so a reader can see what the number excludes
        // rather than inferring a clean zero.
        unknownMembershipQueuesCount: eq.unknownMemberCountQueues,
        unknownMembershipGroupsCount: eq.unknownMemberCountGroups,
      },
    },
  };

  // QUALITY-SCAN-SKIPS-TRIGGERS-AND-FLOWS. The `extractor-not-run` exclusion
  // above only fires when NO node anywhere carries the property, so a vault
  // with 192-of-192 ApexClasses scanned and 0-of-22 ApexTriggers scanned scored
  // the codeQuality axis off two-thirds of the Apex surface and said nothing.
  // These notes fire only when the axis actually contributes — an excluded
  // axis is already disclosed as excluded, and re-disclosing it would mislead.
  const codeQualityAxisContributes =
    codeQualityExtractorRan && !excludedSet.has('codeQuality');
  const qualityScanCoverage = cq?.coverage ?? [];
  const unscannedNote = codeQualityAxisContributes
    ? buildUnscannedNodesNote(qualityScanCoverage)
    : undefined;

  // Build recommended actions ordered by contribution desc. The codeQuality
  // recommendation carries the unscanned-nodes qualifier so the issue count is
  // never stated as a whole-surface total in the one field a host quotes back.
  const codeQualityQualifier = codeQualityAxisContributes
    ? unscannedRecommendationQualifier(qualityScanCoverage)
    : '';
  const orderedRecs = (Object.entries(categories) as [
    TechDebtCategory,
    CategoryBreakdown,
  ][])
    .filter(([cat]) => !excludedSet.has(cat))
    .sort((a, b) => b[1].contribution - a[1].contribution)
    .slice(0, 5)
    .map(([cat, br]) =>
      recommendationFor(
        cat,
        br.rawCount ?? 0,
        br.contribution,
        br.weight,
        cat === 'codeQuality' ? codeQualityQualifier : '',
      ),
    );

  // Compose boundaries: always include direction + weight scheme +
  // exclusion note (verbatim Q115 disclosure when extractor-not-run).
  // The gate is deliberately `'extractor-not-run'` only — Q115's remedy is
  // "run the appropriate refresh command", which is true for a family that
  // was never extracted and FALSE for an `'insufficient-data'` exclusion
  // (a capped scan; refreshing re-reads the same capped window).
  const boundaries: string[] = [
    SCORE_DIRECTION_DISCLOSURE,
    WEIGHT_SCHEME_DISCLOSURE,
  ];
  if (excluded.some((e) => e.reason === 'extractor-not-run')) {
    boundaries.push(Q115_DISCLOSURE);
  }
  // The scan-cap exclusion's own prose. Q115 above deliberately does NOT cover
  // it (its remedy is a refresh, which cannot lift a page cap), so without
  // this line the axis vanished from `boundaries` entirely.
  if (legacyScanCapBoundary !== undefined) {
    boundaries.push(legacyScanCapBoundary);
  }
  // Cite the heuristic tier whenever the codeQuality axis actually contributes
  // (its input is the heuristic Apex scanner). When the axis is excluded it is
  // not part of the score, so the disclosure would be misleading.
  if (codeQualityExtractorRan && !excludedSet.has('codeQuality')) {
    boundaries.push(CODE_QUALITY_HEURISTIC_DISCLOSURE);
  }
  if (unscannedNote !== undefined) boundaries.push(unscannedNote);
  // The permanent, refresh-proof half: `Flow` can never carry a finding.
  const notCheckedNote = codeQualityAxisContributes
    ? buildNotCheckedTypesNote(NOT_APEX_TYPES)
    : undefined;
  if (notCheckedNote !== undefined) boundaries.push(notCheckedNote);
  // When freshness is INCLUDED, state honestly that the never-modified count is
  // not available (no createdDate in the vault) rather than emit a fabricated 0.
  // When freshness is excluded the extractor-not-run note already covers it.
  if (freshnessExtractorRan && !excludedSet.has('freshness')) {
    boundaries.push(NEVER_MODIFIED_UNAVAILABLE_DISCLOSURE);
  }
  // R6: at least one full-node scan behind the apiVersions/codeQuality/
  // freshness axes (each backed by `loadAllNodes` -> `scanAllNodesOfTypes`)
  // hit the residual FULL_SCAN_MAX_NODES cap with more nodes behind it — those
  // axes' counts are a floor, not the complete org, until the vault is
  // narrower or the cap is raised.
  if (scanIncompleteTypes.size > 0) {
    boundaries.push(
      fullScanTruncationNote(
        [...scanIncompleteTypes].sort(),
        // The cap that ACTUALLY bit, not the module default — see
        // {@link residualScanCap}.
        residualScanCap(),
      ),
    );
  }
  // TECH-DEBT-UNCHECKED-ZERO-SCORED-AS-CLEAN. The composite used to print the
  // Q115 "missing axes are EXCLUDED, not assumed zero" boundary while scoring
  // a never-retrieved family as a clean zero, and carried no `coverageCaveat`
  // anywhere for a host to render. Emit the standard caveat naming exactly
  // which families were never confirmed-retrieved, plus a boundary that says
  // in which direction the score is wrong (an excluded ZERO-contribution axis
  // no longer drags the weighted mean down, so the score RISES).
  const coverageCaveat = buildEnumerationCoverageCaveatFor(
    ctx,
    [...uncheckedFamilies].sort(),
    {
      preamble:
        coverageExcluded.size > 0
          ? `${[...coverageExcluded].sort().join(', ')} ${coverageExcluded.size === 1 ? 'is' : 'are'} EXCLUDED from the score: a metadata family the axis is computed from was never confirmed-retrieved, so its count would be a sum with an UNCHECKED term.`
          : 'A metadata family one of the score axes reads was never confirmed-retrieved.',
      subject: 'A complete tech-debt score',
    },
  );
  if (coverageExcluded.size > 0) {
    boundaries.push(
      `UNCHECKED, NOT ZERO — ${[...coverageExcluded].sort().join(', ')} ` +
        `${coverageExcluded.size === 1 ? 'is' : 'are'} excluded from this score because ` +
        `${[...uncheckedFamilies].sort().join(', ')} ` +
        `${uncheckedFamilies.size === 1 ? 'was' : 'were'} never confirmed-retrieved into this vault. ` +
        `A zero on those axes would be "not checked", not "none in the org" — cross-check with ` +
        `\`sfi.coverage_report\` (\`trust.completeness.missingCoverage\`). ` +
        `The score is computed over the REMAINING axes only, so it is not comparable to a score from a fully-retrieved vault.`,
    );
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
      appliedScope: { object: null, mode: 'all' },
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
      ...(unscannedNote !== undefined ? { qualityScanCoverage } : {}),
      ...(codeQualityAxisContributes ? { notCheckedTypes: NOT_APEX_TYPES } : {}),
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
      boundaries,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
