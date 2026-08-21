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
 *   | source=formula-tokenizer     | references  | formula     | blocking         |
 *   |   (fromType CustomField)     |             |             |                  |
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
 *   - `safe` if there are NO incoming edges at all (and coverage is complete,
 *     and the vault was built by this version or newer).
 *   - `review` if the graph would otherwise be `safe` but the evidence is not
 *     provably complete — either coverage is incomplete, or the vault was BUILT
 *     by an older sf-intelligence than the one running (`builderVersionCaveat`:
 *     the roll-up / condition / traversal edge families added in 0.3.0 are
 *     absent from an older vault, so their absence proves nothing). Both mean
 *     "not proven safe"; treat as **not permission to delete**.
 *   - `blocking` if ANY reason carries `blocking`.
 *   - `risky` if no `blocking` but at least one non-unknown `risky`.
 *   - `unknown` if every reason is in the `unknown` category.
 *
 * **Example provenance**: an example row carries, when its edge stamped one,
 * the qualifier that makes the citation specific rather than a family list —
 * `traversalPath` (the `Parent__r.Field__c` a formula reference was resolved
 * from), `rollupRole` (`summarizedField` | `summaryForeignKey` |
 * `summaryFilterItem`), and `firerId` (the Flow / ValidationRule /
 * WorkflowRule / ApprovalProcess / AssignmentRule / AutoResponseRule /
 * EscalationRule whose criteria a condition belongs to — the example `id`
 * itself is a synthetic `ConditionalContext:` node). Each is OMITTED when the
 * edge did not carry it: the tool never fills in a plausible default, because
 * a guessed qualifier is a fabricated citation.
 *
 * **Referrer collapse** (one referrer, one row): a validation rule reaches the
 * fields its `errorConditionFormula` names by TWO edges tokenized from that one
 * string — a direct `references` edge and a `ConditionalContext` `readsFrom`
 * edge. Reported as-is that is one rule counted as two blockers under two
 * categories with two examples. The condition row folds into the `validation`
 * row, and the folded category is disclosed on the surviving example as
 * `alsoVia: ['condition']` (the only DERIVED example qualifier). Nothing is
 * dropped: both edges stay in the graph, and any ADDITIVE condition — a rule
 * testing a field its direct reference could not resolve, a Flow that WRITES
 * and separately TESTS one field — keeps its own row and its own count.
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
 * D2 caveat — polymorphic Activity fields: a dot-access read/write keyed on a
 * `Task`/`Event` receiver (`someTask.Foo__c = …`) does NOT land on the
 * shared `CustomField:Activity.Foo__c` node by parsing alone — the
 * extractor keys the edge on the RECEIVER type, so it projects to a dangling
 * `CustomField:Task.Foo__c`. `canonicalizeFieldEdgeTargets` re-points that
 * dangling target onto the existing Activity field at import via a NAME-BASED
 * polymorphic alias (Task/Event share Activity's custom fields). When the vault
 * has NO Activity base node — activity fields sourced from the offline `sobject
 * describe` snapshot materialize the same field as BOTH a `Task` and an `Event`
 * sibling — `mintPolymorphicActivityFieldEdges` instead mirrors the edge across
 * those existing siblings, so the write is visible whichever representation the
 * admin queries. Either way the incoming-edge walk here now sees such a write as
 * the blocking `apex` referrer it is — but the attribution is a name match, not
 * a declared parent relationship, and is disclosed as a confirm-before-you-
 * delete limitation.
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
  EvidenceEnvelopeV2,
  McpError,
  McpResponse,
  Node,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { compareVersions, err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import {
  detectPiiClassification,
  isRegulatedPiiClassification,
  type PiiCategory,
} from '@sf-intelligence/patterns';
import type { ExecCommand } from '@sf-intelligence/tooling-api';
import { buildMixedFreshness } from '@sf-intelligence/vault';
import { z } from 'zod';

import { mdTable } from '../answer-render.js';
import type { Context } from '../server.js';

import {
  applyCoverageToVerdict as applyCoverageToVerdictShared,
  buildUsageSourceCoverageCaveat,
  type CoverageCaveat,
} from './coverage-trust.js';
import { classifyEdgeSemantics } from './edge-semantics-classify.js';
import { buildSafeToDeleteEvidenceEnvelope } from './evidence-envelope.js';
import { readFactBlock, type FactsBlock } from './facts-block.js';
import { normalizeFieldId } from './field-360.js';
import { fieldNotFoundError } from './field-not-found-suggest.js';
import { scanFlowConditionFieldReaders } from './flow-condition-field-readers-scan.js';
import { scanSupplementalFlowFieldWriters } from './flow-field-writers-scan.js';
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
import { indexRestatedConditionEdges } from './restated-condition-edges.js';

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
  // OBJECT-TIER categories. Reached only through the four object-tier edge
  // types added to `EDGE_SEMANTICS` for `object_360` (`lookupTo`, `triggersOn`,
  // `parentOf`, `sharedWith`). None of those edge types lands on a CustomField
  // on this edge model, so `safe_to_delete_field` never emits them — they are
  // declared here so the shared `classifyEdge` return type and `CATEGORY_NOTES`
  // stay TOTAL over the curated table rather than silently returning a category
  // with no note behind it.
  'relationship',
  'automation',
  'containment',
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
  /**
   * The relationship path a `formula` citation was resolved from
   * (`Programme__r.Status__c`), copied verbatim from the
   * relationship-resolver edge's `properties.traversalPath`.
   *
   * The `formula` note has always PROMISED this; without it the reader saw
   * only the referring formula field's id and could not tell a direct
   * tokenized reference from a resolved cross-object traversal — nor which
   * of the formula's several traversals was the one that hit this field.
   * A note that promises evidence the payload never carries is a fabricated
   * citation by omission, which is the failure this tool exists to avoid.
   * Absent on directly-tokenized formula references (there is no path).
   */
  readonly traversalPath?: string;
  /**
   * WHICH of the three declared roll-up roles couples this field to the
   * roll-up summary named by `id` — `summarizedField` (the roll-up
   * aggregates it), `summaryForeignKey` (the roll-up is anchored on it), or
   * `summaryFilterItem` (the roll-up's filter tests it). Copied from the
   * rollup-summary edge's `properties.rollupRole`.
   *
   * Without it the note could only LIST the possibilities, so every roll-up
   * citation described three couplings of which at most one was real —
   * on the reference vault a third of roll-up edges are `summaryFilterItem`,
   * which the note did not even mention.
   */
  readonly rollupRole?: string;
  /**
   * The component whose criteria the condition belongs to — the Flow,
   * ValidationRule, WorkflowRule, ApprovalProcess, AssignmentRule,
   * AutoResponseRule or EscalationRule — copied from the condition-extractor
   * edge's `properties.firerId`.
   *
   * `id` is the SYNTHETIC `ConditionalContext:…` node, which is not a thing
   * the admin can open or fix. Naming the firer makes the citation the actual
   * rule to go change, and stops an approval-process blocker from being
   * described as a Flow.
   */
  readonly firerId?: ComponentId;
  /**
   * Categories this referrer ALSO reaches the field through, whose rows were
   * folded into this one so the referrer is counted ONCE.
   *
   * DERIVED, not extractor-stamped — the only qualifier on this interface that
   * is. A validation rule reaches a field its `errorConditionFormula` names by
   * two edges tokenized from that one string (a direct `references` and a
   * `ConditionalContext` `readsFrom`); they are two facts about one referrer,
   * so counting both inflated the referrer count and cited the same rule twice
   * under two categories. The condition row is suppressed and named here
   * instead — collapse by disclosure, never by silent deletion. Both edges stay
   * in the graph and every ADDITIVE condition (a rule that tests a field its
   * formula reference could not resolve, a Flow that writes AND tests one
   * field) keeps its own row.
   */
  readonly alsoVia?: readonly ReasonCategory[];
  /**
   * SUPPLEMENTAL-FLOW-EVIDENCE: the reconstruction that produced this row when
   * it did NOT come from an incoming graph edge — `flow-condition-reads-scan`
   * (a Flow decision / record-trigger filter that TESTS this field: extracted as
   * a `firesWhen` edge to a synthetic ConditionalContext with the field on its
   * `fieldRefs`, never as a `readsFrom` edge ONTO the field) or
   * `flow-field-writers-scan` (a `<recordCreates>`/`<recordUpdates>`
   * `<inputAssignments>` write through an SObject variable, which mints no
   * `writesTo` edge either).
   *
   * Absent on every edge-derived row. Present rows are HEURISTIC by provenance
   * even though the Flow XML names the field literally, and they force the
   * response's `trust.confidence` to `heuristic` — see the limitation this
   * stamps.
   */
  readonly via?: 'flow-condition-reads-scan' | 'flow-field-writers-scan';
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
   * UPGRADE PATH: present when the vault was BUILT by an older sf-intelligence
   * than the one now running — i.e. the vault predates extractors this build
   * has. Unlike `coverageCaveat` (which reports what the refresh did not
   * RETRIEVE), this reports what the refresh could not EXTRACT from what it
   * did retrieve: the roll-up coupling, condition-firer and resolved
   * formula-traversal edges added in 0.3.0 are simply absent from an older
   * vault, so a field whose only dependency is one of those reads as `safe`
   * with nothing to warn the reader. Verdict-affecting in one direction only:
   * an otherwise-`safe` verdict is routed to `review` (not proven safe), the
   * same treatment incomplete coverage gets. Also mirrored into
   * `trust.limitations` so the proposal artifact discloses it.
   */
  readonly builderVersionCaveat?: string;
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
   * static verdict was `safe` AND the live plane answered (a standing grant
   * covers the org, or `SFI_LIVE_PLANE_ENABLED=1`; per-call `liveEnabled` is
   * intent only). A `populatedCount > 0` DOWNGRADES `verdict` from
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
  /**
   * AUDIT-F4 — shared EvidenceEnvelope v2 projection of verdict / reasoning /
   * coverage / trust. Additive; legacy keys remain the primary surface.
   */
  readonly evidenceEnvelope: EvidenceEnvelopeV2;
}

/** Core handler payload before the public wrapper stamps `evidenceEnvelope`. */
type SafeToDeleteFieldCoreData = Omit<SafeToDeleteFieldOutput, 'evidenceEnvelope'>;

const withEvidenceEnvelope = (
  data: SafeToDeleteFieldCoreData,
): SafeToDeleteFieldOutput => ({
  ...data,
  evidenceEnvelope: buildSafeToDeleteEvidenceEnvelope(data),
});

/**
 * GROUP-A PII-safety: a heuristic PII/sensitive compliance escalation for a
 * field whose deletion is otherwise judged safe. Does NOT alter the verdict.
 */
export interface PiiCompliance {
  readonly classification: 'pii' | 'sensitive' | 'protected';
  readonly category: PiiCategory;
  readonly message: string;
}

/**
 * Classify one incoming edge into a (category, verdict) pair.
 *
 * The lookup itself now lives in the import-free leaf
 * `./edge-semantics-classify.js` so `sfi.object_360` — a `vault`-plane tool —
 * can share the SAME curated deletion vocabulary without inheriting this
 * module's live-plane reach (`live-population-check.js`). Re-exported here,
 * narrowed to this tool's `ReasonCategory` / `Verdict` unions, so every
 * existing importer (including the `classifyEdge` golden-lock parity test) is
 * unchanged and the two tools can never disagree about what an edge means.
 */
export const classifyEdge = (
  edge: Edge,
  fromNode: Node,
): { category: ReasonCategory; verdict: Verdict } => {
  const resolved = classifyEdgeSemantics(edge, fromNode);
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
      'A condition EVALUATES this field. Seven firer families mint these: Flow entry criteria, Flow decisions, validation-rule conditions, workflow-rule criteria, and approval-process, assignment-rule, auto-response-rule and escalation-rule criteria. Each example carries the `firerId` of the component whose criteria it is, so the citation names the actual rule to go change rather than the family list (the example `id` itself is a synthetic ConditionalContext node). Salesforce refuses to delete a field a live condition tests, so this is a hard blocker even when the field appears on no layout and in no formula. The condition is listed but NOT evaluated: sfi does not know whether any record satisfies it.',
    workflow:
      'A WorkflowRule field-update action writes this field. The action will fail at runtime if the field is removed.',
    validation:
      'A Validation Rule formula references this field. The Validation Rule will fail to compile if the field is removed, and Salesforce refuses the delete while the rule is live. The rule’s `errorConditionFormula` is BOTH a formula reference and a condition that evaluates this field; those are two edges from one tokenized string, so the rule is counted ONCE here and the folded row is disclosed on the example as `alsoVia: ["condition"]` rather than reported as a second referrer. As with any condition, it is listed but NOT evaluated: sfi does not know whether any record satisfies it.',
    layout:
      'This field is placed on one or more page layouts (deleting the field auto-removes it from them — Salesforce does not block the delete and the layouts keep working, but users of those layouts will no longer see the field) or referenced by a QuickAction (whose create/edit form is affected). Review the UI impact before deleting.',
    formula:
      'Another formula field references this field — either directly (tokenized from the formula body) or through a cross-object relationship traversal (`Parent__r.Field__c`) resolved against the org\u2019s lookup fields. Each EXAMPLE carries the referring field id, and a traversal-derived one also carries the `traversalPath` it was resolved from. The referencing formula will fail to compile if this field is removed.',
    rollup:
      'A roll-up summary field on the PARENT object depends on this field in one of three declared roles: `summarizedField` (the roll-up aggregates this field), `summaryForeignKey` (the roll-up is anchored on this master-detail field), or `summaryFilterItem` (the roll-up’s filter tests this field). Each example carries its own `rollupRole`, so the citation names the coupling that actually exists rather than listing the possibilities. Salesforce REFUSES the delete outright while the roll-up exists — delete or repoint the roll-up first. The coupling is declared in the parent object’s metadata, not this field’s, so a search restricted to this object cannot find it.',
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
    relationship:
      'A relationship field on another object points AT this object (`lookupTo`). A master-detail parent cannot be deleted while children exist — the platform refuses outright and cascade-deletes the children if you force the relationship away first; a lookup requires the referencing field to go first. Object-tier only: no CustomField carries an incoming `lookupTo` edge.',
    automation:
      'Automation is BOUND to this object by a `triggersOn` edge (an ApexTrigger or a record-triggered Flow). Neither carries a parentId, so this edge is the only evidence the binding exists, and Salesforce will not delete an object that still has one attached. The binding is listed but NOT evaluated: whether the automation fires for any given record depends on entry criteria this tool does not run. Object-tier only.',
    containment:
      'A component this object OWNS (`parentOf`). Containment is not an external dependency — the child is destroyed with the parent automatically and does not block the delete — but it IS the blast radius, so it is reported as `review`, never `blocking`. Object-tier only: `safe_to_delete_field` skips `parentOf` before classification.',
    unknown:
      'An incoming dependency edge was found whose source/type combination is not in the v2.0b classification table. Review the impact via sfi.get_impact before deleting.',
  },
);

/**
 * Render ONE example as the citation string the checklist table and the
 * proposal's evidence comment both show. Shared so the two human-facing
 * surfaces cannot drift into citing different evidence for the same edge —
 * the drift that let a note promise a `traversalPath` no renderer emitted.
 *
 * Qualifiers are appended ONLY when the edge actually carried them, in a
 * fixed order so fixtures stay deterministic. A bare id (no qualifier) renders
 * byte-identically to before.
 */
const formatExampleCitation = (e: SafeToDeleteFieldExample): string => {
  const qualifiers: string[] = [];
  if (e.via !== undefined) qualifiers.push(`found by ${e.via}, heuristic`);
  if (e.rollupRole !== undefined) qualifiers.push(`as ${e.rollupRole}`);
  if (e.traversalPath !== undefined) qualifiers.push(`via ${e.traversalPath}`);
  if (e.firerId !== undefined) qualifiers.push(`fired by ${e.firerId}`);
  // DERIVED (not extractor-stamped): the categories whose duplicate row for
  // this same referrer was folded into this one. Rendered so the collapse is
  // visible on the citation itself — a fold the reader cannot see is a
  // dropped dependency as far as they can tell.
  if (e.alsoVia !== undefined && e.alsoVia.length > 0) {
    qualifiers.push(`also via ${[...e.alsoVia].join(', ')}`);
  }
  if (e.apiConfirmed === true) qualifiers.push('API-confirmed');
  return qualifiers.length === 0 ? e.id : `${e.id} (${qualifiers.join(', ')})`;
};

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
 * The release that introduced the dependency edges this tool now cites but a
 * vault built before it does not hold: roll-up coupling edges
 * (`source: rollup-summary`), condition field edges (`ConditionalContext ->
 * CustomField readsFrom`), and import-time resolved formula `__r` traversals
 * plus FlexiPage related-list aliases (`source: relationship-resolver`).
 * Named in the caveat so the reader knows WHAT re-refreshing buys them.
 */
const EDGE_FAMILIES_ADDED_IN = '0.3.0';

/**
 * UPGRADE PATH: build the stale-builder caveat for a vault that a previous,
 * older sf-intelligence built.
 *
 * The failure this closes: someone upgrades to a build whose whole point is to
 * stop false-`safe` verdicts, does NOT re-refresh, and gets exactly the
 * false-`safe` the release fixes — with no caveat at all, because the
 * coverage caveat only sees which metadata families were RETRIEVED, and those
 * were. The missing evidence is the extraction, not the retrieve, so nothing
 * downstream could tell.
 *
 * Reads the running version from `SFI_PLUGIN_VERSION` (set by `sfi mcp` at
 * startup) exactly as `health_check`'s vault-version nudge does — purely
 * local, no network. An absent env var or an unparseable version on either
 * side yields no caveat: `compareVersions` returns false on malformed input,
 * and a verdict must never be downgraded on a guess.
 *
 * RESIDUAL GAP (shared with `health_check`): a host that starts the server
 * some way other than `sfi mcp` leaves `SFI_PLUGIN_VERSION` unset, so the
 * drift is undetectable and no caveat fires. Fail-open is the only honest
 * choice here — the alternative is downgrading every verdict on every host
 * that does not set the var — but it means absence of this caveat is NOT
 * proof the vault is current. `sfi.health_check` is the direct check.
 */
const buildBuilderVersionCaveat = (ctx: Context): string | undefined => {
  const runningVersion = process.env['SFI_PLUGIN_VERSION'];
  const builtByVersion = ctx.manifest.version;
  if (runningVersion === undefined || runningVersion === '') return undefined;
  if (typeof builtByVersion !== 'string' || builtByVersion === '') {
    return undefined;
  }
  if (!compareVersions(builtByVersion, runningVersion)) return undefined;
  return (
    `This vault was built by sf-intelligence ${builtByVersion}; you are running ${runningVersion}. ` +
    `Roll-up coupling, condition (Flow / validation-rule / workflow-rule / approval-process / ` +
    `assignment-rule / auto-response-rule / escalation-rule criteria) and resolved formula-traversal ` +
    `dependency edges were added in ${EDGE_FAMILIES_ADDED_IN} and are ABSENT until you re-run ` +
    `\`sfi refresh\` — a field whose only dependency is one of those cannot be seen here. A verdict ` +
    `of "safe" is therefore reported as "review" (NOT proven safe) on this vault.`
  );
};

/**
 * GROUP-A PII-safety: build a non-verdict-lowering PII compliance escalation
 * from the heuristic recognizer. Returns undefined when the field is not
 * recognised as PII / sensitive (NOT a clearance — just no recognised signal).
 */
const buildPiiCompliance = (node: Node): PiiCompliance | undefined => {
  const { piiClassification, piiCategory } = detectPiiClassification(node);
  if (!isRegulatedPiiClassification(piiClassification)) {
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
  // UPGRADE PATH: surfaced ABOVE the verdict for the same reason the coverage
  // caveat is — the checklist renders no `trust` block, so without this a
  // stale-vault `review` would print with no stated cause.
  if (out.builderVersionCaveat !== undefined) {
    lines.push(`> ⚠️ **Stale vault:** ${out.builderVersionCaveat}`, '');
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
          r.examples.map(formatExampleCitation).join('; ') || '—',
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
      const examples = r.examples.map(formatExampleCitation).join('; ');
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
): Promise<Result<McpResponse<SafeToDeleteFieldCoreData>, McpError>> => {
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
      suggestionResult.value as unknown as McpResponse<SafeToDeleteFieldCoreData>,
    );
  }

  // SIBLING-TOOLS-DISAGREED-ON-INPUT-FORM: `sfi.field_360` promotes the short
  // `<Object>.<Field>` form to canonical; this tool refused it with
  // `invalid-query`. One user typing `Contact.Employee_ID__c` got a full
  // forensic report from one field tool and a refusal from the other, on the
  // same vault, in the same session. Accept the same forms the sibling does —
  // any OTHER `Type:Name` prefix still refuses, which is the check that matters.
  const normalizedFieldId = normalizeFieldId(input.fieldId);
  if (normalizedFieldId === null) {
    return err({
      kind: 'invalid-query',
      message: `fieldId must be a CustomField canonical id ('${CUSTOM_FIELD_PREFIX}<Object>.<Field>') or its '<Object>.<Field>' short form; got '${input.fieldId}'`,
      path: 'fieldId',
    });
  }

  const fieldId = normalizedFieldId;

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
  // A platform system/audit field (synthesized into the vault for reference,
  // e.g. CreatedById/SystemModstamp on a standard object) is Salesforce-owned
  // and cannot be deleted at all — short-circuit to a blocking verdict rather
  // than reasoning over its dependency edges.
  const isSystemField = node.properties['system'] === true;
  if (isStandardField || isSystemField) {
    // UNDELETABLE-FIELD-COUNT-WAS-FABRICATED. Both short-circuits used to emit
    // `count: 1` with `examples: []` — a number nothing had counted. On the
    // reference vault `CustomField:Contact.Id` has 85 real usage referrers (55
    // Apex/Flow reads, 16 writes, 12 formulas) that `field_360` prints in full;
    // this tool answered "1". `SafeToDeleteFieldReason.count` is documented as
    // "the total number of referrers in this category", so a caller rendering
    // the reasoning chain read one dependency where there were 85, on the tool
    // whose entire job is dependency counting. The verdict is intrinsic and does
    // not change; the count now reflects what the graph actually holds.
    const undeletableEdges = await listEdges(ctx.graph, fieldId, {
      direction: 'in',
    });
    if (!undeletableEdges.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${undeletableEdges.error.message}`,
      });
    }
    const usageReferrerCount = undeletableEdges.value.filter(
      (e) => e.edgeType !== 'parentOf' && e.edgeType !== 'grantedBy',
    ).length;
    const grantCount = undeletableEdges.value.filter(
      (e) => e.edgeType === 'grantedBy',
    ).length;
    // UNDELETABLE-FIELD-CLAIMED-COMPLETE-COVERAGE. `completeness: 'complete'`
    // was asserted unconditionally here, on vaults whose own coverage rows say
    // `partial` (the reference vault is missing Report, Dashboard, WorkflowRule,
    // EscalationRule and AutoResponseRule). The VERDICT does not depend on
    // coverage — a standard field is undeletable whatever the vault holds — but
    // the referrer count printed beside it does, and stamping the whole response
    // `complete` told the reader otherwise. The verdict's independence from
    // coverage is stated in the limitation instead, where it is true.
    const undeletableCaveat = buildCoverageCaveat(ctx);
    const intrinsicNote = isStandardField
      ? `This is a standard field on ${objectApi} (${node.apiName}). Standard fields are undeletable via metadata — that verdict is intrinsic and does not depend on clearing Apex or formula references.`
      : 'This is a platform-managed system/audit field (e.g. CreatedDate, OwnerId, SystemModstamp). Salesforce owns it — it cannot be deleted. (It is synthesized into the vault as a reference anchor, not a custom field.)';
    return ok({
      data: {
        fieldId,
        verdict: 'blocking',
        reasoning: [
          {
            category: 'unknown',
            verdict: 'blocking',
            count: usageReferrerCount,
            examples: [],
            note:
              `${intrinsicNote} The count beside this reason is the number of USAGE referrer edges the graph holds for it (${usageReferrerCount}; ${grantCount} field-level security grant(s) and the parent-object containment edge are excluded) — informational context, not a deletion blocker, since the block is intrinsic. Call \`sfi.field_360\` or \`sfi.get_impact\` to enumerate them.`,
          },
        ],
        ...(undeletableCaveat !== undefined
          ? { coverageCaveat: undeletableCaveat }
          : {}),
        trust: {
          provenance: 'offline_snapshot',
          confidence: 'declared',
          freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
          completeness: {
            status:
              undeletableCaveat === undefined
                ? ('complete' as const)
                : undeletableCaveat.status,
            ...(undeletableCaveat !== undefined
              ? { missingCoverage: undeletableCaveat.missingCoverage }
              : {}),
          },
          limitations: [
            isStandardField
              ? 'Standard-field deletion is platform-blocked; the referrer count is informational only and the BLOCKING verdict does not depend on dependency-edge coverage.'
              : 'System fields are platform-guaranteed; the referrer count is informational only and the BLOCKING verdict does not depend on dependency-edge coverage.',
            ...(undeletableCaveat !== undefined
              ? [undeletableCaveat.message]
              : []),
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
  // PASS 1 — resolve every referrer node BEFORE classifying anything. The
  // referrer-collapse index below must be built over exactly the edges that
  // will be reported: pairing a condition row against a direct row the
  // sparse-graph guard then drops would suppress a real dependency instead of
  // folding a duplicate presentation of one.
  const resolvedEdges: { edge: Edge; fromNode: Node }[] = [];
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
    resolvedEdges.push({ edge, fromNode });
  }

  // One REFERRER must be counted once. A validation rule reaches a field its
  // `errorConditionFormula` names twice — a direct `references` edge and a
  // `ConditionalContext` `readsFrom` edge, both tokenized from that one string
  // in one extractor pass — which reported ONE rule as TWO blockers under TWO
  // categories with two counts and two examples (681 such pairs on the
  // reference vault; 17 fields whose ENTIRE non-structural incoming set is one
  // duplicated pair). Inflated referrer counts are exactly the clone-propagation
  // double-count this product's own field-audit method warns against. The
  // duplicate PRESENTATION folds; the graph keeps both edges, every additive
  // condition keeps its own row, and the folded category is disclosed on the
  // surviving citation via `alsoVia`. See `restated-condition-edges.ts` for why
  // the pairing is exact and why a Flow that writes AND tests one field is
  // structurally incapable of collapsing.
  const restated = indexRestatedConditionEdges(
    resolvedEdges.map((r) => r.edge),
  );

  // PASS 2 — classify and bucket.
  for (const { edge, fromNode } of resolvedEdges) {
    if (restated.isRestatingCondition(edge)) continue;
    const { category, verdict } = classifyEdge(edge, fromNode);
    const apiConfirmed = edge.properties['confirmedByApi'] === true;
    // Per-example provenance qualifiers. Each is stamped by exactly one
    // extractor and OMITTED when that extractor did not mint the edge, so the
    // citation can never claim a coupling the edge does not carry — an
    // unstamped edge stays a bare id rather than defaulting to a plausible
    // role. Empty strings are dropped for the same reason.
    const edgeString = (key: string): string | undefined => {
      const raw = edge.properties[key];
      return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
    };
    const traversalPath = edgeString('traversalPath');
    const rollupRole = edgeString('rollupRole');
    const firerId = edgeString('firerId');
    // The one DERIVED qualifier: this referrer also reaches the field through a
    // condition whose row was folded into this one. Present only on the
    // surviving half of a real pair, so it can never claim a fold that did not
    // happen.
    const alsoVia: readonly ReasonCategory[] | undefined = restated
      .isRestatedDirectReference(edge)
      ? (['condition'] as const)
      : undefined;
    const example: SafeToDeleteFieldExample = {
      id: fromNode.id,
      type: fromNode.type,
      apiName: fromNode.apiName,
      ...(apiConfirmed ? { apiConfirmed: true as const } : {}),
      ...(traversalPath !== undefined ? { traversalPath } : {}),
      ...(rollupRole !== undefined ? { rollupRole } : {}),
      ...(firerId !== undefined ? { firerId } : {}),
      ...(alsoVia !== undefined ? { alsoVia } : {}),
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

  // SUPPLEMENTAL-FLOW-EVIDENCE — the two Flow dependencies that mint NO incoming
  // edge onto the field, and which this tool therefore could not see at all:
  //
  //   1. a Flow DECISION / record-trigger filter that tests the field. The
  //      condition extractor stores it as a `firesWhen` edge from the Flow to a
  //      synthetic `ConditionalContext` node carrying the field on its
  //      `fieldRefs` property — there is no edge onto the field, so the incoming
  //      walk above never sees it.
  //   2. a Flow `<recordCreates>` / `<recordUpdates>` `<inputAssignments>` write
  //      routed through an SObject VARIABLE rather than `$Record`, which mints no
  //      `writesTo` edge.
  //
  // `field_360` has composed both for releases; `safe_to_delete_field` had
  // neither, so the two tools disagreed about whether a Flow touches a field —
  // and the disagreement fell on the destructive side. Measured on the reference
  // vault: `CustomField:APXT_CongaSign__Transaction__c.Parent_a7s__c` is tested
  // by two record-triggered Flow decisions (`$Record.Parent_a7s__c IsNull`, and
  // assigned from in a third element) and this tool reported `reasoning: []` —
  // ZERO referrers. Only the vault's stale-builder and partial-coverage caveats
  // held the verdict at `review`; on a current, fully-covered vault the same
  // field reaches a bare `safe`. A destructive-advice tool that cannot see a
  // dependency its own sibling prints is the worst failure this file can have.
  //
  // Filed under `flow` (the category whose note already reads "Flow definitions
  // read or write this field. The Flow XML names the field literally") at
  // `blocking`, matching how the tool classifies every other Flow read/write.
  // The PROVENANCE is what differs, not the consequence, so it is disclosed on
  // the example (`via`), in a limitation, and by forcing `trust.confidence` to
  // `heuristic` — never by softening the verdict.
  //
  // Deduped against everything already bucketed: a Flow already cited by a real
  // edge, and a Flow already named as the `firerId` of a ConditionalContext row,
  // must not be counted twice. The two rows name DIFFERENT components (the
  // synthetic context vs the Flow), which is why the `firerId` check is needed on
  // top of the id check.
  const knownReferrerIds = new Set<string>();
  for (const bucket of buckets.values()) {
    for (const ex of bucket.examples) {
      knownReferrerIds.add(ex.id as string);
      if (ex.firerId !== undefined) knownReferrerIds.add(ex.firerId as string);
    }
  }
  const addFlowReferrer = (example: SafeToDeleteFieldExample): void => {
    const existing = buckets.get('flow');
    if (existing === undefined) {
      buckets.set('flow', { verdict: 'blocking', examples: [example], count: 1 });
      return;
    }
    existing.verdict = promoteVerdict(existing.verdict, 'blocking');
    existing.count += 1;
    existing.examples.push(example);
  };

  const conditionScan = await scanFlowConditionFieldReaders(ctx, fieldId);
  let supplementalConditionReaders = 0;
  for (const reader of conditionScan.readers) {
    if (knownReferrerIds.has(reader.flowId as string)) continue;
    knownReferrerIds.add(reader.flowId as string);
    supplementalConditionReaders += 1;
    addFlowReferrer({
      id: reader.flowId,
      type: 'Flow',
      apiName: reader.flowApiName,
      via: 'flow-condition-reads-scan',
    });
  }

  let supplementalFlowWriters = 0;
  if (objectApi !== null) {
    const writers = await scanSupplementalFlowFieldWriters(
      ctx,
      objectApi,
      node.apiName,
    );
    for (const writer of writers) {
      if (knownReferrerIds.has(writer.componentId as string)) continue;
      knownReferrerIds.add(writer.componentId as string);
      supplementalFlowWriters += 1;
      addFlowReferrer({
        id: writer.componentId,
        type: 'Flow',
        apiName: writer.apiName,
        via: 'flow-field-writers-scan',
      });
    }
  }

  // Report / Dashboard usage is folded onto the field as a property by
  // `applyReportDashboardPersistence`. Inject it as an `analytics` (blocking)
  // reason so a field used only in a report column / dashboard component never
  // reads as `safe`.
  // Finding #36 / R6-24-WIRE: the fold stamps capped name lists, surfaced as
  // examples (and later as proposal evidence) so the answer names WHICH
  // reports/dashboards would break — not just a boolean.
  //
  // REPORT-DASHBOARD-GRAPH-PERSISTENCE — DE-DUPLICATION (defensive).
  // The refresh persists Report/Dashboard NODES but deliberately not the
  // analytics -> `CustomField` edges, so on a current vault the edge walk
  // above contributes NO Report/Dashboard referrers and this subtraction is a
  // no-op — the counts are byte-identical to the pre-change behaviour. It is
  // kept because the two sources are not interchangeable and the vault is not
  // guaranteed to be current: a vault built by a different build (or a future
  // one that does persist those edges) would otherwise count the same report
  // twice, once from its edge and once from the folded name. The FOLD total is
  // always the superset (it covers every EXTRACTED report; its name list is
  // per-field-capped at 50 but its `…Truncated` total is exact), so
  // edge-derived referrers are subtracted from it and only the genuinely
  // additional remainder is added. Examples are unioned by id — both sides
  // mint the same `Report:{Folder}/{Name}` identity.
  const rdUsage = reportDashboardUsageDetail(nodeResult.value);
  let analyticsCountIsFloor = false;
  if (rdUsage.usedInReport || rdUsage.usedInDashboard) {
    const existing = buckets.get('analytics');
    const existingExamples = existing?.examples ?? [];
    const existingIds = new Set(existingExamples.map((e) => e.id as string));
    const alreadyCounted = (type: string): number =>
      existingExamples.filter((e) => e.type === type).length;
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
    ].filter((e) => !existingIds.has(e.id as string));
    const reportCount =
      rdUsage.reportsTruncatedTotal ??
      (rdUsage.usedInReport ? Math.max(rdUsage.reportNames.length, 1) : 0);
    const dashboardCount =
      rdUsage.dashboardsTruncatedTotal ??
      (rdUsage.usedInDashboard ? Math.max(rdUsage.dashboardNames.length, 1) : 0);
    const added =
      Math.max(0, reportCount - alreadyCounted('Report')) +
      Math.max(0, dashboardCount - alreadyCounted('Dashboard'));
    // ANALYTICS-COUNT-IS-A-FLOOR-NOT-A-TOTAL. When the fold stamped the boolean
    // but no name list and no truncation total — every field on a vault built
    // before the name property existed; 303 fields carry `usedInReport: true`
    // and NONE carry names on the reference vault — `Math.max(names.length, 1)`
    // above yields 1. The vault knows "at least one", not "exactly one", but
    // `SafeToDeleteFieldReason.count` is documented as "the total number of
    // referrers in this category", so 1 reads as a total and the checklist
    // renders "**analytics** (1)" with no examples behind it. The count stays
    // (dropping it would under-report a blocker); what changes is that the
    // response now says out loud that it is a lower bound.
    analyticsCountIsFloor =
      (rdUsage.usedInReport &&
        rdUsage.reportNames.length === 0 &&
        rdUsage.reportsTruncatedTotal === undefined) ||
      (rdUsage.usedInDashboard &&
        rdUsage.dashboardNames.length === 0 &&
        rdUsage.dashboardsTruncatedTotal === undefined);
    buckets.set('analytics', {
      verdict: 'blocking',
      examples: [...existingExamples, ...foldExamples],
      count: (existing?.count ?? 0) + added,
    });
  }

  const reasoning = buildReasoning(buckets);
  const coverageCaveat = buildCoverageCaveat(ctx);
  // GROUP-A PII-safety: a non-verdict-lowering compliance escalation.
  const piiCompliance = buildPiiCompliance(nodeResult.value);
  // UPGRADE PATH: a vault older than the running build is missing whole edge
  // FAMILIES this tool cites, which the coverage caveat cannot see (the
  // families were retrieved; the extractor that reads them did not exist).
  // Applied at the same point, and with the same safe->review demotion, as the
  // coverage caveat: both mean "not proven safe", not "a dependency exists".
  const builderVersionCaveat = buildBuilderVersionCaveat(ctx);
  const coverageVerdict = applyCoverageToVerdict(
    aggregateVerdict(reasoning),
    coverageCaveat,
  );
  const staticVerdict: Verdict =
    builderVersionCaveat !== undefined && coverageVerdict === 'safe'
      ? 'review'
      : coverageVerdict;

  const dataShape = await readFactBlock(ctx, fieldId, 'fillRate');

  const supplementalFlowTotal =
    supplementalConditionReaders + supplementalFlowWriters;
  // SUPPLEMENTAL-FLOW-EVIDENCE: a reconstruction is heuristic by provenance even
  // when its underlying fact is declared in the Flow XML, so a verdict that
  // leans on one must not report `declared`.
  const baseConfidence =
    reasoning.some((r) => r.verdict === 'risky') || supplementalFlowTotal > 0
      ? ('heuristic' as const)
      : ('declared' as const);
  const baseCompleteness = {
    status: coverageCaveat === undefined ? ('complete' as const) : coverageCaveat.status,
    ...(coverageCaveat !== undefined
      ? { missingCoverage: coverageCaveat.missingCoverage }
      : {}),
  };
  const baseLimitations: string[] = [
    'Dependency evidence comes from the last offline vault refresh. String-built dynamic SOQL, reflective Apex, and runtime metadata access remain invisible to static analysis; inline static SOQL and constant-string Database.query field references ARE resolved (parsed-confidence Apex AST edges). A dot-access read/write to a shared Activity custom field through a Task or Event receiver (someTask.Field__c) is NOT a direct parsed edge on the Activity field — it is attached by a name-based polymorphic import alias (see next limitation).',
    'Polymorphic Activity attribution: a shared Activity custom field can appear as up to three nodes (CustomField:Activity/Task/Event.<field>) that are ONE physical field. A read/write keyed on one representation is attached to the others at import by a name-based alias — re-pointed onto the Activity base when it exists, otherwise mirrored across the Task/Event describe-snapshot siblings (Task and Event share the custom fields defined on Activity). This is a heuristic name match applied at import, not a declared parent relationship — an admin should still confirm the referrer before deleting.',
    // Unconditional when it fires — a `blocking` verdict on a stale vault is
    // still a verdict computed from incomplete edge families, so the reader is
    // told even though the verdict did not move.
    ...(builderVersionCaveat !== undefined ? [builderVersionCaveat] : []),
    // SUPPLEMENTAL-FLOW-EVIDENCE — say which rows are reconstructions and which
    // reconstruction found them; a `blocking` row a caller cannot trace back to
    // an edge is otherwise indistinguishable from a declared dependency.
    ...(supplementalFlowTotal > 0
      ? [
          `${supplementalFlowTotal} \`flow\` referrer(s) were RECONSTRUCTED, not read from an incoming edge` +
            `${supplementalConditionReaders > 0 ? ` — ${supplementalConditionReaders} by \`flow-condition-reads-scan\` from Flow decision / record-trigger filter conditions (stored as a firesWhen edge to a synthetic ConditionalContext, never as an edge onto the field)` : ''}` +
            `${supplementalFlowWriters > 0 ? `${supplementalConditionReaders > 0 ? ',' : ' —'} ${supplementalFlowWriters} by \`flow-field-writers-scan\` from a Flow \`<inputAssignments>\` write routed through an SObject variable rather than $Record (mints no writesTo edge)` : ''}` +
            `. Each such example carries \`via\`. The Flow XML names the field literally, so these are real dependencies and are classified \`blocking\` like any other Flow read/write — but the ATTRIBUTION is a source/property scan, so this response's confidence is reported as \`heuristic\`; confirm the Flow before deleting.`,
        ]
      : []),
    // Residual: the ConditionalContext walk has a ceiling. A flow-condition
    // referrer past it is MISSED, so absence of `flow` rows is not proof of none.
    ...(conditionScan.truncated
      ? [
          `Flow decision/filter referrer reconstruction was CAPPED at ${conditionScan.scannedCount} of ${conditionScan.totalCount} ConditionalContext nodes (SFI_CONDITION_SCAN_MAX) — a Flow condition on this field in the un-scanned tail is NOT reflected in the verdict. Treat the absence of a \`flow\` condition referrer as UNCHECKED beyond that cap.`,
        ]
      : []),
    // ANALYTICS-COUNT-IS-A-FLOOR-NOT-A-TOTAL (see the fold above).
    ...(analyticsCountIsFloor
      ? [
          'The `analytics` count is a LOWER BOUND, not a total: this vault carries the folded `usedInReport` / `usedInDashboard` BOOLEAN with no report/dashboard name list, so the tool knows "at least one" and counted 1 per flagged family. The empty `examples` array means "names not captured", NEVER "zero reports". Run `sfi refresh --no-pull` to repopulate the names, then re-run for the real count and the list of what would break.',
        ]
      : []),
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

  const familyFreshness = buildMixedFreshness(ctx.manifest);
  const trust =
    liveQueriedAt !== undefined
      ? {
          ...hybridTrust({
            vaultRefreshedAt: ctx.manifest.refreshedAt,
            liveQueriedAt,
            vaultConfidence: baseConfidence,
            completeness: baseCompleteness,
            limitations: baseLimitations,
          }),
          freshness: {
            snapshotRefreshedAt: ctx.manifest.refreshedAt,
            liveQueriedAt,
            ...(familyFreshness.overall !== undefined
              ? { overall: familyFreshness.overall }
              : {}),
            ...(familyFreshness.families !== undefined
              ? { families: familyFreshness.families }
              : {}),
            ...(familyFreshness.oldestEvidenceAt !== undefined
              ? { oldestEvidenceAt: familyFreshness.oldestEvidenceAt }
              : {}),
          },
        }
      : {
          provenance: 'offline_snapshot' as const,
          confidence: baseConfidence,
          freshness: familyFreshness,
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
      ...(builderVersionCaveat !== undefined ? { builderVersionCaveat } : {}),
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
  // FLD-02: object→field routing returns a suggestion payload (no verdict) —
  // leave it untouched; EvidenceEnvelope applies only to delete verdicts.
  const raw = result.value.data as SafeToDeleteFieldCoreData | Record<string, unknown>;
  if (
    !('verdict' in raw) ||
    !('reasoning' in raw) ||
    !('trust' in raw) ||
    !('fieldId' in raw)
  ) {
    return ok(result.value as McpResponse<SafeToDeleteFieldOutput>);
  }
  let data = withEvidenceEnvelope(raw as SafeToDeleteFieldCoreData);
  if (input.format === 'checklist') {
    data = { ...data, checklist: renderDeleteChecklist(data) };
  } else if (input.format === 'proposal') {
    data = {
      ...data,
      proposal: buildSafeToDeleteFieldProposal(data, result.value.vaultState),
    };
  }
  return ok({
    ...result.value,
    data,
  });
};
