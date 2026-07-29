/**
 * Handler for the `sfi.safe_to_delete_field` MCP tool.
 *
 * The v2.0b headline tool — the buyer-facing answer to admin #4 on the
 * top-10 questions list: "is it safe to delete this field?". Composes
 * every incoming dependency edge into a verdict-weighted reasoning
 * chain a caller can either render verbatim or summarise.
 *
 * The tool is a pure composition over existing graph queries: one
 * `getNodeById(fieldId)` (to verify the field exists) followed by one
 * `listEdges(fieldId, { direction: 'in' })` (to enumerate every
 * incoming dependency). Each incoming edge gets classified into a
 * category + verdict pair based on the source node's type and the
 * edge's type; the per-category reasoning is then aggregated into a
 * single overall verdict.
 *
 * Per-category classification table:
 *
 *   | Source node type             | Edge type   | Category    | Per-edge verdict |
 *   |------------------------------|-------------|-------------|------------------|
 *   | ApexClass / ApexTrigger      | readsFrom   | apex        | risky            |
 *   | Flow                         | readsFrom   | flow        | blocking         |
 *   | ConditionalContext           | readsFrom   | condition   | blocking         |
 *   | ApexClass / ApexTrigger      | writesTo    | apex        | blocking         |
 *   | Flow                         | writesTo    | flow        | blocking         |
 *   | WorkflowRule                 | writesTo    | workflow    | blocking         |
 *   | (any other source)           | writesTo    | unknown     | blocking         |
 *   | ValidationRule               | references  | validation  | blocking         |
 *   | (formula-tokenizer source)   | references  | formula     | blocking         |
 *   | source=rollup-summary        | references  | rollup      | blocking         |
 *   | source=relationship-resolver | references  | formula     | blocking         |
 *   |   (fromType CustomField)     |             |             |                  |
 *   | Layout                       | usedInLayout| layout      | review           |
 *   | VisualforcePage              | references  | frontend    | risky            |
 *   | VisualforceComponent         | references  | frontend    | risky            |
 *   | LightningComponentBundle     | readsFrom   | frontend    | risky            |
 *   | LightningComponentBundle     | writesTo    | frontend    | risky            |
 *   | AuraDefinitionBundle         | readsFrom   | frontend    | risky            |
 *   | AuraDefinitionBundle         | writesTo    | frontend    | risky            |
 *   | QuickAction                  | references  | layout      | risky            |
 *   | (any other edge)             | *           | unknown     | risky            |
 *
 * **Aggregate verdict**:
 *   - `safe` if there are NO incoming edges at all (and coverage is complete).
 *   - `review` if coverage is incomplete and the graph would otherwise be `safe`
 *     — means "not proven safe"; treat as **not permission to delete**.
 *   - `blocking` if ANY reason carries `blocking`.
 *   - `risky` if no `blocking` but at least one non-unknown `risky`.
 *   - `unknown` if every reason is in the `unknown` category.
 *
 * **Honesty axis** (per the v2.0b spec): when an incoming edge carries
 * `properties.confirmedByApi === true` (stamped by `sfi refresh
 * --with-tooling-api`'s MetadataComponentDependency pass), the tool
 * surfaces that as additive evidence (`apiConfirmed: true` on the
 * reasoning entry / example) — it does NOT change the verdict cascade.
 * A confirmation can only add trust, never remove a check. The tool does
 * NOT call the Tooling API at query time (ADR-002: refresh-time only).
 * It does NOT surface false positives from heuristic scanners (Apex regex
 * scanner, LWC field-access scanner) with declared confidence — the
 * verdict `risky` literally means "the scanner flagged a reference;
 * spot-check before deleting", whereas `blocking` means "the metadata
 * declaration IS a hard dependency the platform will refuse to drop".
 * The developer always gets the full referrer list (capped at 5 examples
 * per category to keep the response small) so they can verify
 * heuristic matches by hand.
 *
 * Apex evidence granularity (R6-03): the default-on Apex AST pass emits
 * `confidence: 'parsed'` readsFrom/writesTo edges for dot-access AND for
 * fields referenced inside inline static SOQL (SELECT / WHERE / ORDER BY /
 * GROUP BY) or constant-string `Database.query` literals — a field used
 * ONLY inside a query still shows up as an apex referrer. Case-variant
 * SOQL spellings are canonicalized onto the vaulted field id at import
 * (`canonicalizeFieldEdgeTargets`), so the incoming-edge walk here sees
 * them. String-BUILT dynamic SOQL remains the disclosed blind spot.
 *
 * Implementation notes:
 *   - `fieldId` is required to start with `CustomField:`. Other prefixes
 *     return `invalid-query` at the handler boundary. Zod cannot
 *     express the prefix constraint, so the check lives here.
 *   - A field id with no node AND no inbound references resolves to
 *     `component-not-found` (phantom-aware). A standard or managed-package
 *     field with no node of its own but referenced by dependency/permission
 *     edges is NOT an error: it returns a `review` verdict (not proven safe —
 *     a not-modeled field can't be assessed and a standard field can't be
 *     deleted anyway) (B12).
 *   - For each incoming edge, `getNodeById(edge.fromId)` resolves the
 *     referrer's identity (`type`, `apiName`). Sparse-graph misses are
 *     dropped silently — matches the tolerance every other composition
 *     tool uses.
 *   - The full referrer list is available via `sfi.get_impact`; the
 *     per-category `examples` array here is capped at 5 (sorted by id
 *     ASC) so the response stays compact for the headline-summary
 *     persona.
 *   - Categories are emitted in a stable order
 *     (`apex, flow, condition, workflow, validation, layout, formula,
 *     rollup, integration, permission, sharing, analytics, ui, frontend,
 *     unknown`) so consumer fixtures see the same shape across runs.
 */

import type {
  ComponentId,
  ComponentType,
  Edge,
  McpError,
  McpResponse,
  Node,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import {
  detectPiiClassification,
  type PiiCategory,
} from '@sf-intelligence/patterns';
import type { ExecCommand } from '@sf-intelligence/tooling-api';
import { z } from 'zod';

import { mdTable } from '../answer-render.js';
import { EDGE_SEMANTICS } from '../knowledge/loader.js';
import type { Context } from '../server.js';

import {
  applyCoverageToVerdict as applyCoverageToVerdictShared,
  buildUsageSourceCoverageCaveat,
  type CoverageCaveat,
} from './coverage-trust.js';
import { readFactBlock, type FactsBlock } from './facts-block.js';
import { fieldNotFoundError } from './field-not-found-suggest.js';
import { hybridTrust } from './hybrid-trust.js';
import { resolveFieldAlias } from './input-aliases.js';
import {
  computeLivePopulation,
  LIVE_POPULATION_NOT_CHECKED_DISCLOSURE,
  type LivePopulationEvidence,
} from './live-population-check.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import {
  buildDeleteProposal,
  type ProposalArtifact,
  type ProposalEvidence,
} from './proposal-artifact.js';
import {
  formatReportDashboardBreakEvidence,
  REPORT_DASHBOARD_USAGE_CAVEAT,
  reportDashboardUsageDetail,
  type ReportDashboardUsageDetail,
} from './report-dashboard-usage.js';
import { resolveToFieldOrSuggest } from './resolve-field-or-suggest.js';

/** Canonical id prefix for the CustomField node type. */
const CUSTOM_FIELD_PREFIX = 'CustomField:';

/**
 * Maximum number of example referrers surfaced per category in the
 * response. Callers wanting the full list should use
 * `sfi.get_impact` — the cap here keeps the headline-summary response
 * compact for chat UIs.
 */
const EXAMPLES_PER_CATEGORY_LIMIT = 5;

/**
 * The categories the v2.0b reasoning chain recognises. Stable order
 * keeps consumer fixtures deterministic across runs. `unknown` is the
 * fall-through bucket for incoming edges whose source-node type +
 * edge-type combination is not in the classification table.
 */
const CATEGORY_ORDER = [
  'apex',
  'flow',
  'condition',
  'workflow',
  'validation',
  'layout',
  'formula',
  'rollup',
  'integration',
  'permission',
  'sharing',
  'analytics',
  'ui',
  'frontend',
  'unknown',
] as const;

/** One of the recognised reasoning categories. */
type ReasonCategory = (typeof CATEGORY_ORDER)[number];

/** One of the per-edge or aggregate verdicts the tool emits. */
type Verdict = 'safe' | 'review' | 'risky' | 'blocking' | 'unknown';

/**
 * Zod schema for the `sfi.safe_to_delete_field` tool input.
 *
 *   - field identity (required): the canonical CustomField id
 *     (`CustomField:{Object}.{Field}`) as either `fieldId` (canonical) or the
 *     `componentId` alias a host reaches for (L2 Alias OS). Disagreeing values
 *     are an `invalid-query`. Non-`CustomField:` prefixes surface as
 *     `invalid-query` from the handler; unknown but well-formed ids surface as
 *     `component-not-found`.
 */
export const safeToDeleteFieldInputSchema = z
  .object({
    fieldId: z.string().min(1).optional(),
    componentId: z.string().min(1).optional(),
  /**
   * `'checklist'` adds a `checklist` field (P8-destructive-checklist): a
   * "before you delete X" Markdown checklist rendered from the verdict +
   * reasoning, with the coverageCaveat surfaced FIRST. `'proposal'`
   * (Finding #35) adds a `proposal` — a LOCAL, deploy-ready
   * `destructiveChanges.xml` (+ empty `package.xml`) for the field with the
   * verdict + evidence + coverage caveat inline as XML comments, for a human
   * to feed to their own deploy tool. Default `'json'` returns only the
   * structured reasoning.
   */
  format: z.enum(['json', 'checklist', 'proposal']).optional(),
  /**
   * CR-CAP-L5: opt-in live plane. When the STATIC verdict would be `safe`,
   * cross-check the field's live production population before trusting that
   * verdict — a field with real data despite zero static references may be
   * written by dynamic Apex, an integration, or another blind spot the
   * scanner cannot see. Never a hard dependency: offline stays fully
   * functional without it.
   */
  liveEnabled: z.boolean().optional(),
  orgAlias: z.string().min(1).optional(),
  })
  .refine((i) => i.fieldId !== undefined || i.componentId !== undefined, {
    message: 'name the field — pass `fieldId` or `componentId` (e.g. "CustomField:Account.My_Field__c")',
    path: ['fieldId'],
  });

/** Parsed input shape, inferred from `safeToDeleteFieldInputSchema`. */
export type SafeToDeleteFieldInput = z.infer<
  typeof safeToDeleteFieldInputSchema
>;

/**
 * One example referrer surfaced inside a category's `examples` array.
 * Combines the source node's identity so a caller can render
 * "Validation Rule X depends on this field" without a follow-up
 * round-trip.
 */
export interface SafeToDeleteFieldExample {
  readonly id: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  /**
   * Present when the inbound edge was confirmed by the Tooling API
   * MetadataComponentDependency enricher (`properties.confirmedByApi`).
   * Additive evidence only — does not change the per-edge or aggregate
   * verdict.
   */
  readonly apiConfirmed?: true;
}

/**
 * One per-category entry in the reasoning chain. `count` is the total
 * number of referrers in this category (may exceed `examples.length`
 * when truncated by `EXAMPLES_PER_CATEGORY_LIMIT`); `examples` is the
 * compact sample callers display directly. `note` is a single
 * plain-English sentence explaining what the category means and what
 * a verdict of `blocking` / `risky` should signal to the caller.
 */
export interface SafeToDeleteFieldReason {
  readonly category: ReasonCategory;
  readonly verdict: Verdict;
  readonly count: number;
  readonly examples: readonly SafeToDeleteFieldExample[];
  readonly note: string;
  /**
   * Present when at least one referrer in this category carries
   * Tooling-API confirmation (`properties.confirmedByApi`). Additive
   * evidence only — does not move the category or aggregate verdict.
   */
  readonly apiConfirmed?: true;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface SafeToDeleteFieldOutput {
  readonly fieldId: ComponentId;
  readonly verdict: Verdict;
  readonly reasoning: readonly SafeToDeleteFieldReason[];
  readonly coverageCaveat?: CoverageCaveat;
  /**
   * GROUP-A PII-safety: a non-verdict-lowering compliance escalation present
   * only when the heuristic recognizer classifies the field `pii` / `sensitive`.
   * Mirrors `coverageCaveat` — it is surfaced FIRST in the checklist and never
   * moves the verdict, so a PII field never reads as a bland `safe`. HEURISTIC:
   * absence of this block is NOT a clearance, only the absence of a recognised
   * PII signal.
   */
  readonly piiCompliance?: PiiCompliance;
  readonly trust: TrustSummary;
  /** Present only when `format: 'checklist'` (P8-destructive-checklist). */
  readonly checklist?: string;
  /**
   * Present only when `format: 'proposal'` (Finding #35): a LOCAL, deploy-ready
   * `destructiveChanges.xml` (+ empty `package.xml`) for this field, with the
   * verdict + evidence + coverage caveat inline as XML comments. sfi NEVER
   * deploys it — the host writes the strings; a human feeds them to Gearset /
   * Copado / `sf project deploy`.
   */
  readonly proposal?: ProposalArtifact;
  /**
   * P13-FACTS-consumers: captured fill rate for this field (`data_snapshot`),
   * when one exists. CONTEXT ONLY — the verdict above is computed purely from
   * the metadata graph and NEVER moves toward safe because of a sampled
   * observation (adversarial unit pins this).
   */
  readonly dataShape?: FactsBlock;
  /**
   * Profile / PermissionSet FLS grants on this field (access, not usage).
   * Excluded from `reasoning` — aligns with `unused_fields_deep`.
   */
  readonly flsGrantCount?: number;
  /**
   * CR-CAP-L5: live production population evidence, present ONLY when the
   * static verdict was `safe` AND the live plane answered (consent granted
   * or `liveEnabled: true`). A `populatedCount > 0` DOWNGRADES `verdict` from
   * `safe` to `review` — real data despite zero static references is a
   * signal, not proof of a bug, but "no references found" should not read as
   * "safe to delete" when the field is actively populated. Absence of this
   * block means the live check was not attempted (verdict was not `safe`) or
   * could not run (see `trust.limitations` for the disclosed reason) — it is
   * NEVER a substitute for the static analysis, only a cross-check on top of
   * it.
   */
  readonly livePopulation?: LivePopulationEvidence;
  /**
   * Finding #36 / R6-24-WIRE: WHICH reports/dashboards reference this field
   * (capped fold-time name lists). Present only when folded usage is set —
   * feeds `format:'proposal'` evidence comments so a delete bundle names what
   * would break, not just a boolean.
   */
  readonly reportUsage?: ReportDashboardUsageDetail;
}

/**
 * GROUP-A PII-safety: a heuristic PII/sensitive compliance escalation for a
 * field whose deletion is otherwise judged safe. Does NOT alter the verdict.
 */
export interface PiiCompliance {
  readonly classification: 'pii' | 'sensitive';
  readonly category: PiiCategory;
  readonly message: string;
}

/**
 * Classify one incoming edge into a (category, verdict) pair.
 *
 * RM-1b: the per-edge `(edgeType, sourceType) → {category, verdict}` mapping —
 * the formula-tokenizer special case (checked first), every per-source-type
 * result, and every per-edgeType default — is curated DATA in the two-track
 * concept model (`packages/mcp/model/edge-semantics.yaml` → the generated,
 * frozen `EDGE_SEMANTICS`). This function only applies that lookup; the mapping
 * it yields is byte-identical to the former inline switch. The verdict lattice,
 * per-category aggregation, coverage caveat, and PII escalation stay in this
 * file.
 *
 * Lookup order (mirrors the data table):
 *   1. formula-tokenizer special case — a `references` edge whose extractor
 *      `source` marker is `formula-tokenizer` is a formula reference
 *      (`{formula, blocking}`), regardless of the source node's type. The
 *      `references` edgeType overlaps validation rules and frontend components,
 *      but the marker is the source of truth for what the tokenizer extracted.
 *   2. `byEdgeType[edgeType].bySourceType[sourceType]` — keyed by the referrer
 *      node's ComponentType (e.g. `usedInLayout`/`grantedBy` classify to
 *      `review`: the platform auto-handles the field's removal and nothing
 *      breaks — a heads-up, not a hard dependency).
 *   3. `byEdgeType[edgeType].default` — the edge type is known but the source
 *      ComponentType is not listed.
 *   4. `EDGE_SEMANTICS.default` — the edge type itself is not in the table.
 */
export const classifyEdge = (
  edge: Edge,
  fromNode: Node,
): { category: ReasonCategory; verdict: Verdict } => {
  // Ordered source-keyed special cases, first match wins. Keyed on the extractor
  // `source` marker because `references` has several producers whose semantics
  // differ and whose referrer ComponentType does not tell them apart — a
  // CustomField-sourced `references` edge is a formula reference, a roll-up
  // coupling, or a resolved cross-object traversal depending ONLY on `source`.
  // Classifying by type alone made the tool cite a roll-up summary that did not
  // exist. `fromType`, when the rule carries one, scopes it further.
  for (const rule of EDGE_SEMANTICS.bySource) {
    if (edge.edgeType !== rule.edgeType) continue;
    if (edge.source !== rule.source) continue;
    if (rule.fromType !== undefined && fromNode.type !== rule.fromType) continue;
    return {
      category: rule.category as ReasonCategory,
      verdict: rule.verdict as Verdict,
    };
  }
  const rule = EDGE_SEMANTICS.byEdgeType[edge.edgeType];
  const resolved =
    rule === undefined
      ? EDGE_SEMANTICS.default
      : (rule.bySourceType[fromNode.type] ?? rule.default);
  return {
    category: resolved.category as ReasonCategory,
    verdict: resolved.verdict as Verdict,
  };
};

/**
 * Per-category notes shown to the caller. Each note describes the
 * dependency kind in one sentence and (where relevant) flags the
 * heuristic-confidence boundary so the caller knows when a `risky`
 * verdict means "spot-check before deleting" vs. "definitely
 * depended on".
 */
const CATEGORY_NOTES: Readonly<Record<ReasonCategory, string>> = Object.freeze(
  {
    apex: 'Apex classes and triggers reference this field. Parsed-confidence matches (the default-on Apex AST pass — dot-access plus inline static SOQL SELECT/WHERE/ORDER BY/GROUP BY fields and constant-string Database.query literals) are real references; heuristic-confidence matches (apex-scanner regex fallback) may include false positives — spot-check those before deleting. String-BUILT dynamic SOQL remains invisible either way.',
    flow: 'Flow definitions read or write this field. The Flow XML names the field literally; deleting the field will break the Flow at runtime.',
    condition:
      'A condition EVALUATES this field — a Flow entry criterion, a Flow decision, a workflow-rule criterion, or a validation-rule condition. Salesforce refuses to delete a field a live condition tests, so this is a hard blocker even when the field appears on no layout and in no formula. The condition is listed but NOT evaluated: sfi does not know whether any record satisfies it.',
    workflow:
      'A WorkflowRule field-update action writes this field. The action will fail at runtime if the field is removed.',
    validation:
      'A Validation Rule formula references this field. The Validation Rule will fail to compile if the field is removed.',
    layout:
      'This field is placed on one or more page layouts (deleting the field auto-removes it from them — Salesforce does not block the delete and the layouts keep working, but users of those layouts will no longer see the field) or referenced by a QuickAction (whose create/edit form is affected). Review the UI impact before deleting.',
    formula:
      'Another formula field references this field — either directly (tokenized from the formula body) or through a cross-object relationship traversal (`Parent__r.Field__c`) resolved against the org\u2019s lookup fields. Each reasoning entry carries the referring field id, and a traversal-derived one also carries the `traversalPath` it was resolved from. The referencing formula will fail to compile if this field is removed.',
    rollup:
      'A roll-up summary field on the PARENT object aggregates this field (as its summarizedField) or is anchored on it (as its summaryForeignKey master-detail field). Salesforce REFUSES the delete outright while the roll-up exists — delete or repoint the roll-up first. The coupling is declared in the parent object’s metadata, not this field’s, so a search restricted to this object cannot find it.',
    integration:
      'An integration surface (external data source, external service) references this field. Removing it may break the outbound or inbound contract.',
    permission:
      'A Profile or Permission Set grants access to this field. Removing the field will drop the permission grant but is not blocked.',
    sharing:
      'A SharingRule, Restriction Rule, or Scoping Rule criterion references this field. Deleting the field will break the rule.',
    analytics:
      'A Report, Dashboard, List View, or Report Type references this field. Removing the field will break the analytics surface at runtime.',
    ui:
      'A Lightning page (FlexiPage) references this field. Removing the field will leave the page with a broken element.',
    frontend:
      'A Lightning Web Component, Aura bundle, Visualforce page, or Visualforce component references this field. Heuristic-confidence matches (LWC/Aura scanners) may include false positives; spot-check the bundle source before deleting.',
    unknown:
      'An incoming dependency edge was found whose source/type combination is not in the v2.0b classification table. Review the impact via sfi.get_impact before deleting.',
  },
);

/**
 * Comparator for the deterministic example sort. `id` ASC matches the
 * convention every other enumeration-style tool in this package uses.
 */
const compareExamples = (
  a: SafeToDeleteFieldExample,
  b: SafeToDeleteFieldExample,
): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Build the reasoning array from the per-category accumulators. Each
 * category in `CATEGORY_ORDER` that has at least one referrer emits a
 * single reason; categories with no referrers are dropped so the
 * response stays compact. Per-category verdict precedence is
 * `blocking > risky > unknown` — the worst per-edge verdict in the
 * category determines what the category reports.
 */
const buildReasoning = (
  buckets: Map<ReasonCategory, {
    verdict: Verdict;
    examples: SafeToDeleteFieldExample[];
    count: number;
  }>,
): readonly SafeToDeleteFieldReason[] => {
  const out: SafeToDeleteFieldReason[] = [];
  for (const category of CATEGORY_ORDER) {
    const bucket = buckets.get(category);
    if (bucket === undefined) continue;
    const sortedExamples = [...bucket.examples]
      .sort(compareExamples)
      .slice(0, EXAMPLES_PER_CATEGORY_LIMIT);
    const apiConfirmed = bucket.examples.some((e) => e.apiConfirmed === true);
    out.push({
      category,
      verdict: bucket.verdict,
      count: bucket.count,
      examples: sortedExamples,
      note: CATEGORY_NOTES[category],
      ...(apiConfirmed ? { apiConfirmed: true as const } : {}),
    });
  }
  return out;
};

/**
 * Promote `current` to the worse of `(current, next)` using the
 * `blocking > risky > review > unknown > safe` precedence. Used inside each
 * per-category accumulator so the category's verdict reflects the
 * worst incoming edge it saw.
 */
const promoteVerdict = (current: Verdict, next: Verdict): Verdict => {
  if (current === 'blocking' || next === 'blocking') return 'blocking';
  if (current === 'risky' || next === 'risky') return 'risky';
  if (current === 'review' || next === 'review') return 'review';
  if (current === 'unknown' || next === 'unknown') return 'unknown';
  return 'safe';
};

/**
 * Aggregate the per-category verdicts into the headline answer.
 *   - empty reasoning → `safe` (no incoming edges at all).
 *   - any `blocking` → `blocking`.
 *   - any non-`unknown` `risky` → `risky`.
 *   - every reason is `unknown`-category → `unknown`.
 */
const aggregateVerdict = (
  reasoning: readonly SafeToDeleteFieldReason[],
): Verdict => {
  if (reasoning.length === 0) return 'safe';
  let sawNonUnknownRisky = false;
  let sawUnknownRisky = false;
  let sawOnlyUnknown = true;
  let sawReview = false;
  for (const r of reasoning) {
    if (r.verdict === 'blocking') return 'blocking';
    if (r.category !== 'unknown') sawOnlyUnknown = false;
    if (r.verdict === 'risky') {
      if (r.category !== 'unknown') sawNonUnknownRisky = true;
      else sawUnknownRisky = true;
    }
    if (r.verdict === 'review') sawReview = true;
  }
  if (sawNonUnknownRisky) return 'risky';
  if (sawOnlyUnknown) return 'unknown';
  // An unknown-category risky reference still warrants a spot-check, so it
  // keeps precedence over review.
  if (sawUnknownRisky) return 'risky';
  // A 'review' reason (a page-layout placement or an FLS grant — the platform
  // auto-handles it on delete and nothing breaks) is a heads-up, not a risk.
  // Without this branch it fell through to the 'risky' default below, which
  // mis-reported every layout-only / FLS-only field as risky.
  if (sawReview) return 'review';
  return 'risky';
};

/**
 * GATE-HONESTY-EMPTY-GRAPH-EQUALS-SAFE: the field-deletion coverage caveat now
 * flows through the SHARED usage-source contract (`coverage-trust.ts`), so this
 * tool and `review_change` / `unused_components` enforce ONE completeness rule
 * rather than three copies. `USAGE_SOURCE_FAMILIES.CustomField` is the vetted
 * field-referrer set; `fireOnUnknownCoverage: true` keeps this tool's fail-harder
 * stance (a vault with no coverage rows at all is not-provably-complete, so a
 * bare `safe` is still downgraded). The message + missingCoverage are
 * byte-identical to the former local helper.
 */
const buildCoverageCaveat = (ctx: Context): CoverageCaveat | undefined =>
  buildUsageSourceCoverageCaveat(ctx, 'CustomField', 'Deletion safety', {
    fireOnUnknownCoverage: true,
  });

const applyCoverageToVerdict = (
  verdict: Verdict,
  caveat: CoverageCaveat | undefined,
): Verdict => applyCoverageToVerdictShared(verdict, caveat, 'safe', 'review');

/**
 * GROUP-A PII-safety: build a non-verdict-lowering PII compliance escalation
 * from the heuristic recognizer. Returns undefined when the field is not
 * recognised as PII / sensitive (NOT a clearance — just no recognised signal).
 */
const buildPiiCompliance = (node: Node): PiiCompliance | undefined => {
  const { piiClassification, piiCategory } = detectPiiClassification(node);
  if (piiClassification !== 'pii' && piiClassification !== 'sensitive') {
    return undefined;
  }
  return {
    classification: piiClassification,
    category: piiCategory,
    message:
      `This field is classified ${piiClassification}/${piiCategory} (heuristic). Even when the metadata verdict is "safe", deletion may be irreversible and compliance-relevant (FERPA/GDPR/PCI): require explicit data-retention sign-off and verify it is not the system of record before deleting. Absence of this escalation on other fields is NOT a clearance.`,
  };
};

/**
 * The `sfi.safe_to_delete_field` MCP tool. Returns a confidence-
 * weighted verdict for a CustomField deletion, citing every incoming
 * dependency the graph holds. See the module JSDoc for the
 * classification table and the honesty-axis design.
 *
 * @example
 *   const r = await safeToDeleteFieldHandler(ctx, {
 *     fieldId: 'CustomField:Account.Industry__c',
 *   });
 *   if (r.ok) console.log(r.value.data.verdict);
 */
/** Severity order for the delete checklist — resolve the most severe first. */
const VERDICT_ORDER: Record<Verdict, number> = {
  blocking: 0,
  risky: 1,
  review: 2,
  unknown: 3,
  safe: 4,
};

/**
 * Render a "before you delete X" Markdown checklist (P8-destructive-checklist)
 * from a safe-to-delete result. The coverageCaveat is surfaced FIRST (never
 * footnoted) per the vault-coverage-honesty rule; removal steps are ordered
 * most-severe-first. PROPOSES a checklist — it never deletes or writes.
 */
export const renderDeleteChecklist = (out: SafeToDeleteFieldOutput): string => {
  const lines: string[] = [`## Before you delete \`${out.fieldId}\``, ''];
  // GROUP-A PII-safety: the PII compliance escalation is surfaced FIRST (above
  // the coverage caveat and the verdict), so a PII field never reads as a bland
  // "safe" deletion. It NEVER alters the verdict.
  if (out.piiCompliance !== undefined) {
    lines.push(
      `> 🔒 **PII compliance (${out.piiCompliance.classification}/${out.piiCompliance.category}):** ${out.piiCompliance.message}`,
      '',
    );
  }
  if (out.coverageCaveat !== undefined) {
    lines.push(
      `> ⚠️ **Coverage caveat (${out.coverageCaveat.status}):** ${out.coverageCaveat.message}`,
      '',
    );
  }
  lines.push(`**Verdict: ${out.verdict.toUpperCase()}**`, '');
  const ordered = [...out.reasoning].sort(
    (a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict],
  );
  if (ordered.length === 0) {
    lines.push('No inbound dependencies found — nothing to resolve before deleting.');
  } else {
    lines.push('### Resolve these before deleting (most severe first)');
    for (const r of ordered) {
      const apiNote = r.apiConfirmed === true ? ' [Tooling API confirmed]' : '';
      lines.push(`- [ ] **${r.category}** (${r.count})${apiNote} — ${r.note}`);
    }
    lines.push(
      '',
      mdTable(
        ['Category', 'Severity', 'Count', 'Examples'],
        ordered.map((r) => [
          r.category,
          r.verdict,
          r.count,
          r.examples
            .map((e) =>
              e.apiConfirmed === true ? `${e.id} (API-confirmed)` : e.id,
            )
            .join(', ') || '—',
        ]),
      ),
    );
  }
  lines.push(
    '',
    "_Proposed from the vault's last refresh — verify against your org before deleting. This never deploys or modifies the org._",
  );
  return lines.join('\n');
};

/**
 * Finding #35: build a LOCAL, deploy-ready delete proposal for the field from a
 * safe-to-delete result. Emits `destructiveChanges.xml` (the field) + an empty
 * `package.xml`, each led by an evidence comment carrying the verdict, every
 * dependency finding, and the tool's verbatim coverage/limitation disclosures.
 * PURE — it PROPOSES local files a human feeds to their own deploy tool; it
 * never deploys or writes to the org. The proposal is emitted for EVERY verdict
 * (including `blocking`): the evidence comment leads with the verdict so a field
 * that is NOT safe reads loudly as such rather than being silently withheld.
 */
export const buildSafeToDeleteFieldProposal = (
  out: SafeToDeleteFieldOutput,
  vaultState: { readonly sourceTreeHash: string; readonly refreshedAt: string },
): ProposalArtifact => {
  const reasons: string[] = [];
  // R6-24-WIRE: lead with named report/dashboard break evidence when the fold
  // stamped usedInReports / usedInDashboards — the differentiator vs a boolean.
  if (out.reportUsage !== undefined) {
    reasons.push(
      ...formatReportDashboardBreakEvidence(out.reportUsage, {
        fieldId: out.fieldId,
      }),
    );
  }
  reasons.push(
    ...out.reasoning.map((r) => {
      const examples = r.examples
        .map((e) => (e.apiConfirmed === true ? `${e.id} (API-confirmed)` : e.id))
        .join(', ');
      const apiTag = r.apiConfirmed === true ? ', API-confirmed' : '';
      return `${r.category} (${r.verdict}, ${r.count}${apiTag})${examples ? `: ${examples}` : ''} — ${r.note}`;
    }),
  );
  if (out.piiCompliance !== undefined) {
    reasons.unshift(
      `PII compliance (${out.piiCompliance.classification}/${out.piiCompliance.category}): ${out.piiCompliance.message}`,
    );
  }
  const evidence: ProposalEvidence = {
    verdict: out.verdict,
    sourceTreeHash: vaultState.sourceTreeHash,
    refreshedAt: vaultState.refreshedAt,
    reasons,
    disclosures: [...out.trust.limitations],
  };
  return buildDeleteProposal([out.fieldId], evidence, {
    headline:
      `Proposes deleting ${out.fieldId} (verdict: ${out.verdict}). ` +
      `Review the ${out.reasoning.length} dependency finding(s) in the evidence comment before deploying.`,
  });
};

const coreSafeToDeleteFieldHandler = async (
  ctx: Context,
  rawInput: SafeToDeleteFieldInput,
  exec?: ExecCommand,
): Promise<Result<McpResponse<SafeToDeleteFieldOutput>, McpError>> => {
  // L2 Alias OS: accept the `componentId` alias for `fieldId`. Disagreeing
  // values -> invalid-query (never a silent pick). Normalize into `fieldId`.
  const fieldAlias = resolveFieldAlias(rawInput);
  if (!fieldAlias.ok) return err(fieldAlias.error);
  const input = { ...rawInput, fieldId: fieldAlias.value.fieldId };
  // FLD-02: graceful object→field routing.
  const suggestionResult = await resolveToFieldOrSuggest(ctx, input.fieldId);
  if (!suggestionResult.ok) return suggestionResult;
  if (suggestionResult.value !== null) {
    return ok(
      suggestionResult.value as unknown as McpResponse<SafeToDeleteFieldOutput>,
    );
  }

  if (!input.fieldId.startsWith(CUSTOM_FIELD_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `fieldId must start with '${CUSTOM_FIELD_PREFIX}'; got '${input.fieldId}'`,
      path: 'fieldId',
    });
  }

  const fieldId = input.fieldId as ComponentId;

  const nodeResult = await getNodeById(ctx.graph, fieldId);
  if (!nodeResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodeResult.error.message}`,
    });
  }
  if (nodeResult.value === null) {
    // B12: a standard field (Contact.Email) or managed-package field is often
    // not modeled as its own node. If it is referenced (dependency / permission
    // edges exist), don't return a silent component-not-found — return a
    // `review` verdict (NOT proven safe): a not-modeled field can't be assessed
    // from its absent definition, and a standard field can't be deleted via
    // metadata anyway. Only a field with NO inbound references is genuinely
    // unknown (a typo / wrong id).
    const inboundResult = await listEdges(ctx.graph, fieldId, {
      direction: 'in',
    });
    if (!inboundResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${inboundResult.error.message}`,
      });
    }
    if (inboundResult.value.length === 0) {
      return err(
        await fieldNotFoundError(
          ctx,
          fieldId,
          await phantomAwareNotFoundMessage(ctx, fieldId, 'CustomField'),
        ),
      );
    }
    return ok({
      data: {
        fieldId,
        verdict: 'review',
        reasoning: [
          {
            category: 'unknown',
            verdict: 'review',
            count: inboundResult.value.length,
            examples: [],
            note:
              `This field's own definition was not retrieved into the vault — ` +
              `standard fields and managed-package fields are not modeled. It is ` +
              `referenced by ${inboundResult.value.length} component(s)/grant(s). ` +
              `NOT proven safe to delete: a standard field cannot be deleted via ` +
              `metadata, and a not-modeled field cannot be fully assessed. Run ` +
              `\`sfi refresh\` if it should be retrievable, or treat it as external.`,
          },
        ],
        trust: {
          provenance: 'offline_snapshot',
          confidence: 'declared',
          freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
          completeness: { status: 'partial' },
          limitations: [
            "The field's own definition is not in the vault (standard or managed-package field); this verdict is based on inbound references only.",
          ],
        },
      },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  }

  const node = nodeResult.value;
  const objectApi =
    node.parentId?.startsWith('CustomObject:')
      ? node.parentId.slice('CustomObject:'.length)
      : null;
  const isStandardObject = objectApi !== null && !objectApi.includes('__');
  const isStandardField =
    isStandardObject &&
    !node.apiName.endsWith('__c') &&
    !node.apiName.endsWith('__s');
  if (isStandardField) {
    return ok({
      data: {
        fieldId,
        verdict: 'blocking',
        reasoning: [
          {
            category: 'unknown',
            verdict: 'blocking',
            count: 1,
            examples: [],
            note:
              `This is a standard field on ${objectApi} (${node.apiName}). Standard fields are undeletable via metadata — that verdict is intrinsic and does not depend on clearing Apex or formula references.`,
          },
        ],
        trust: {
          provenance: 'offline_snapshot',
          confidence: 'declared',
          freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
          completeness: { status: 'complete' },
          limitations: [
            'Standard-field deletion is platform-blocked; dependency counts are informational only.',
          ],
        },
      },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  }

  // A platform system/audit field (synthesized into the vault for reference,
  // e.g. CreatedById/SystemModstamp on a standard object) is Salesforce-owned
  // and cannot be deleted at all — short-circuit to a blocking verdict rather
  // than reasoning over its (absent) dependency edges.
  if (nodeResult.value.properties['system'] === true) {
    return ok({
      data: {
        fieldId,
        verdict: 'blocking',
        reasoning: [
          {
            category: 'unknown',
            verdict: 'blocking',
            count: 1,
            examples: [],
            note: 'This is a platform-managed system/audit field (e.g. CreatedDate, OwnerId, SystemModstamp). Salesforce owns it — it cannot be deleted. (It is synthesized into the vault as a reference anchor, not a custom field.)',
          },
        ],
        trust: {
          provenance: 'offline_snapshot',
          confidence: 'declared',
          freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
          completeness: { status: 'complete' },
          limitations: [
            'System fields are platform-guaranteed; this verdict does not depend on dependency-edge coverage.',
          ],
        },
      },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  }

  const edgesResult = await listEdges(ctx.graph, fieldId, {
    direction: 'in',
  });
  if (!edgesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${edgesResult.error.message}`,
    });
  }

  const buckets = new Map<
    ReasonCategory,
    { verdict: Verdict; examples: SafeToDeleteFieldExample[]; count: number }
  >();

  let flsGrantCount = 0;
  for (const edge of edgesResult.value) {
    // `parentOf` is the structural object→field ownership edge: the parent
    // object OWNS the field, it does not depend on it, so deleting the field
    // never affects the parent. Skip it so the field's own parent object does
    // not show up as a (risky) deletion dependency.
    if (edge.edgeType === 'parentOf') continue;
    // `grantedBy` is FLS access (Profile / PermissionSet), not usage — same
    // exclusion as `unused_fields_deep` / `find_dead_code`. Grants drop
    // automatically when the field is deleted; they are not deletion blockers.
    if (edge.edgeType === 'grantedBy') {
      flsGrantCount += 1;
      continue;
    }
    const fromResult = await getNodeById(ctx.graph, edge.fromId);
    if (!fromResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${fromResult.error.message}`,
      });
    }
    const fromNode = fromResult.value;
    if (fromNode === null) {
      // Sparse-graph case: the edge points at an id the graph has no
      // node row for. Drop silently — matches the tolerance every
      // other composition tool uses.
      continue;
    }
    const { category, verdict } = classifyEdge(edge, fromNode);
    const apiConfirmed = edge.properties['confirmedByApi'] === true;
    const example: SafeToDeleteFieldExample = {
      id: fromNode.id,
      type: fromNode.type,
      apiName: fromNode.apiName,
      ...(apiConfirmed ? { apiConfirmed: true as const } : {}),
    };
    const existing = buckets.get(category);
    if (existing === undefined) {
      buckets.set(category, {
        verdict,
        examples: [example],
        count: 1,
      });
    } else {
      existing.verdict = promoteVerdict(existing.verdict, verdict);
      existing.count += 1;
      existing.examples.push(example);
    }
  }

  // Report / Dashboard usage is folded onto the field as a property (no per-report
  // node/edge — see foldReportDashboardUsageIntoFields), so the edge walk above
  // can't see it. Inject it as an `analytics` (blocking) reason so a field used
  // only in a report column / dashboard component never reads as `safe`.
  // Finding #36 / R6-24-WIRE: when the fold stamped capped name lists, surface
  // those as examples (and later as proposal evidence) so the answer names WHICH
  // reports/dashboards would break — not just a boolean.
  const rdUsage = reportDashboardUsageDetail(nodeResult.value);
  if (rdUsage.usedInReport || rdUsage.usedInDashboard) {
    const existing = buckets.get('analytics');
    const foldExamples: SafeToDeleteFieldExample[] = [
      ...rdUsage.reportNames.map(
        (name): SafeToDeleteFieldExample => ({
          id: `Report:${name}` as ComponentId,
          type: 'Report',
          apiName: name,
        }),
      ),
      ...rdUsage.dashboardNames.map(
        (name): SafeToDeleteFieldExample => ({
          id: `Dashboard:${name}` as ComponentId,
          type: 'Dashboard',
          apiName: name,
        }),
      ),
    ];
    const reportCount =
      rdUsage.reportsTruncatedTotal ??
      (rdUsage.usedInReport ? Math.max(rdUsage.reportNames.length, 1) : 0);
    const dashboardCount =
      rdUsage.dashboardsTruncatedTotal ??
      (rdUsage.usedInDashboard ? Math.max(rdUsage.dashboardNames.length, 1) : 0);
    const added = reportCount + dashboardCount;
    buckets.set('analytics', {
      verdict: 'blocking',
      examples: [...(existing?.examples ?? []), ...foldExamples],
      count: (existing?.count ?? 0) + added,
    });
  }

  const reasoning = buildReasoning(buckets);
  const coverageCaveat = buildCoverageCaveat(ctx);
  // GROUP-A PII-safety: a non-verdict-lowering compliance escalation.
  const piiCompliance = buildPiiCompliance(nodeResult.value);
  const staticVerdict = applyCoverageToVerdict(aggregateVerdict(reasoning), coverageCaveat);

  const dataShape = await readFactBlock(ctx, fieldId, 'fillRate');

  const baseConfidence = reasoning.some((r) => r.verdict === 'risky')
    ? ('heuristic' as const)
    : ('declared' as const);
  const baseCompleteness = {
    status: coverageCaveat === undefined ? ('complete' as const) : coverageCaveat.status,
    ...(coverageCaveat !== undefined
      ? { missingCoverage: coverageCaveat.missingCoverage }
      : {}),
  };
  const baseLimitations: string[] = [
    'Dependency evidence comes from the last offline vault refresh. String-built dynamic SOQL, reflective Apex, and runtime metadata access remain invisible to static analysis; inline static SOQL and constant-string Database.query field references ARE resolved (parsed-confidence Apex AST edges).',
    REPORT_DASHBOARD_USAGE_CAVEAT,
    ...(flsGrantCount > 0
      ? [
          `${flsGrantCount} Profile/PermissionSet FLS grant(s) exist on this field (access, not usage) — excluded from the verdict; see \`sfi.field_access_audit\` or \`sfi.unused_fields_deep\`. Deleting the field drops grants automatically.`,
        ]
      : []),
    ...(coverageCaveat !== undefined ? [coverageCaveat.message] : []),
    ...(piiCompliance !== undefined ? [piiCompliance.message] : []),
  ];

  // CR-CAP-L5: cross-check a `safe` static verdict against live production
  // population. NEVER attempted for a non-`safe` verdict — the live plane is
  // a cross-check on "no static evidence found", not a general enrichment.
  let verdict: Verdict = staticVerdict;
  let livePopulation: LivePopulationEvidence | undefined;
  let liveQueriedAt: string | undefined;
  if (staticVerdict === 'safe') {
    const live = await computeLivePopulation(ctx, objectApi, node.apiName, input, exec);
    if (live.status === 'ok') {
      livePopulation = live.evidence;
      liveQueriedAt = live.evidence.liveQueriedAt;
      if (live.evidence.populatedCount > 0) {
        verdict = 'review';
        baseLimitations.push(
          `Verdict downgraded from safe to review: ${live.evidence.populatedCount} of ${live.evidence.totalCount} live record(s) on ${live.evidence.objectApiName} currently populate ${live.evidence.fieldApiName} (${Math.round(live.evidence.populationRate * 100)}%) despite no static references found — investigate dynamic Apex, an integration, or a UI path the scanner cannot see before deleting.`,
        );
      }
    } else {
      baseLimitations.push(LIVE_POPULATION_NOT_CHECKED_DISCLOSURE);
    }
  }

  const trust =
    liveQueriedAt !== undefined
      ? hybridTrust({
          vaultRefreshedAt: ctx.manifest.refreshedAt,
          liveQueriedAt,
          vaultConfidence: baseConfidence,
          completeness: baseCompleteness,
          limitations: baseLimitations,
        })
      : {
          provenance: 'offline_snapshot' as const,
          confidence: baseConfidence,
          freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
          completeness: baseCompleteness,
          limitations: baseLimitations,
        };

  return ok({
    data: {
      fieldId,
      verdict,
      ...(dataShape !== undefined ? { dataShape } : {}),
      reasoning,
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
      ...(piiCompliance !== undefined ? { piiCompliance } : {}),
      ...(flsGrantCount > 0 ? { flsGrantCount } : {}),
      ...(livePopulation !== undefined ? { livePopulation } : {}),
      ...(rdUsage.usedInReport || rdUsage.usedInDashboard
        ? { reportUsage: rdUsage }
        : {}),
      trust,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

/**
 * Thin wrapper over the core handler that post-processes the result by
 * `format` — so every verdict path (main / system-field / not-modeled) carries
 * the extra rendering without touching the individual return sites.
 *   - `'checklist'` (P8-destructive-checklist): a Markdown delete checklist.
 *   - `'proposal'` (Finding #35): a LOCAL, deploy-ready destructiveChanges.xml
 *     (+ empty package.xml) with the verdict + evidence inline as XML comments.
 *     PURE local-file emit — nothing is deployed or written to the org.
 */
export const safeToDeleteFieldHandler = async (
  ctx: Context,
  input: SafeToDeleteFieldInput,
  exec?: ExecCommand,
): Promise<Result<McpResponse<SafeToDeleteFieldOutput>, McpError>> => {
  const result = await coreSafeToDeleteFieldHandler(ctx, input, exec);
  if (!result.ok) return result;
  if (input.format === 'checklist') {
    return ok({
      ...result.value,
      data: {
        ...result.value.data,
        checklist: renderDeleteChecklist(result.value.data),
      },
    });
  }
  if (input.format === 'proposal') {
    return ok({
      ...result.value,
      data: {
        ...result.value.data,
        proposal: buildSafeToDeleteFieldProposal(
          result.value.data,
          result.value.vaultState,
        ),
      },
    });
  }
  return result;
};
