/**
 * Handler for the `sfi.what_happens_on_save` MCP tool.
 *
 * v2.0e W1 — the lifecycle-narrator headline. Produces an ordered list
 * of every automation step that fires when a record of a given object
 * is saved (for a specific DML event: insert | update | upsert | delete
 * | undelete) — the Salesforce documented Order Of Execution (SOE)
 * instantiated against THIS org's extracted automation.
 *
 * The composition walks the SOE phases in the documented Salesforce
 * order of execution:
 *
 *   0. **before-save-flows** — before-save record-triggered Flows whose
 *      `triggersOn` edge `triggerType` is `RecordBeforeSave`. These run
 *      FIRST in the modern order of execution — ahead of before-triggers —
 *      and only on insert/update.
 *   1. **pre-save-triggers** — ApexTriggers whose `triggersOn` edge
 *      points at the target object AND whose `events` property contains
 *      a matching `before <event>` lifecycle event. Before triggers run
 *      after before-save flows but ahead of custom validation rules.
 *   2. **pre-save-validation** — ValidationRules parented to the
 *      target object. Each emits its `firesWhen` ConditionalContext so
 *      callers can see the condition gate before the rule runs.
 *   3. **duplicate-rules** — DuplicateRules parented to the target
 *      object, evaluated on insert/update only. Each step surfaces the
 *      rule's effective `DuplicateRuleOperation` set for this event
 *      (`Allow`/`Block`/`Alert`/`Report`) as `duplicateRuleOperations`,
 *      the derived `blocksOnSave` boolean, and the `MatchingRule` ids
 *      it references (via `actions`). Duplicate rules run AFTER
 *      before-triggers and validation, BEFORE the record is saved —
 *      per Salesforce's own numbered order-of-execution doc.
 *   4. **save** — the database write itself (a documented placeholder
 *      step the platform performs; no SfIntelligence node represents it).
 *   5. **after-triggers** — ApexTriggers whose `events` property
 *      contains a matching `after <event>` lifecycle event. These run
 *      after the record is written but ahead of the post-save automation.
 *   6. **post-save-assignment** — Lead/Case AssignmentRules,
 *      AutoResponseRules, and EscalationRules parented to the target
 *      object (`parentOf` from CustomObject to firer). Assignment and
 *      auto-response rules run ahead of workflow rules. Each rule's
 *      ConditionalContext is surfaced.
 *   7. **post-save-workflows** — WorkflowRules whose `triggersOn` edge
 *      points at the target object AND whose `triggerType` matches the
 *      DML event (workflows only fire on insert/update). Each rule's
 *      `firesWhen` ConditionalContext is surfaced alongside the rule.
 *   8. **post-save-flows** — record-triggered (after-save) Flows whose
 *      `triggersOn` edge points at the target object AND whose
 *      `recordTriggerType` matches the DML event. After-save flows run
 *      after workflow rules.
 *   9. **post-save-approval** — ApprovalProcesses parented to the
 *      target object (`parentOf` from CustomObject) with their entry
 *      criteria ConditionalContext.
 *   10. **post-save-rollup-recalc** — parent Summary (roll-up summary)
 *      CustomFields that aggregate this object, found by matching this
 *      object's api name against the child-object prefix of every
 *      Summary field's `summaryForeignKey` property (R6-07; there is no
 *      edge for this — see `soe-rollup-recalc.ts`). Fires on EVERY DML
 *      event (insert/update/delete/undelete all change the child record
 *      set a rollup aggregates), capped to ONE level (a grandparent's own
 *      rollup on the recalculated parent is NOT walked) and does NOT
 *      expand the parent's own triggers/flows/workflows (no re-entrancy).
 *   11. **post-save-async** — ApexClasses called via the
 *      `dispatchesAsync` edge from any trigger or Apex class identified
 *      in the earlier phases (the queueable / batchable / schedulable
 *      / @future jobs the save dispatches).
 *
 * **Honesty axis** (load-bearing): the response carries a verbatim
 * `disclosure` field naming what the tool does NOT evaluate:
 *
 *   - Conditions ARE listed but NOT EVALUATED. The tool surfaces the
 *     expression and the field-ref count from the ConditionalContext
 *     node, but it does not know whether a specific record at runtime
 *     satisfies the condition.
 *   - Roll-up recalculation is capped to one level and does not expand
 *     the recalculated parent's own automation (no re-entrancy).
 *   - Entitlement-process/milestone-type METADATA is modeled elsewhere
 *     in the vault (R6-18), but this composition does NOT simulate
 *     entitlement milestones as an order-of-execution phase — target
 *     minutes and live on-track/breached status are NOT modeled. When
 *     the target object has an active `EntitlementProcess`, the
 *     response carries an `entitlementProcessNotes` entry (R6-23)
 *     naming it — a disclosure-plus-pointer, not a simulated phase.
 *   - Criteria-based sharing recalculation — the FINAL step in
 *     Salesforce's documented order-of-execution, evaluated after
 *     every phase modeled here (including post-save-async) — is
 *     also NOT modeled (R6-23).
 *   - Manual sharing, sharing sets, account teams, and Apex callouts
 *     after save are out of scope.
 *   - Pre-save validation includes only ValidationRules; system
 *     validation (required-field checks, FK integrity, layout
 *     enforcement) is documented as the "save" placeholder step and
 *     has no per-org node.
 *
 * Implementation notes:
 *   - The target object is looked up via `getNodeById`. Unknown
 *     objects surface as `component-not-found` rather than `invalid-
 *     query`, mirroring the convention every other component-id-
 *     parameterised tool uses.
 *   - Each phase fetches its candidate set via `listEdges` and then
 *     filters in memory against the DML event. The event-filter axes
 *     vary per producer (ApexTrigger uses `events: ['before insert',
 *     ...]`, WorkflowRule uses `triggerType: 'onCreateOnly' | ...`,
 *     Flow uses `recordTriggerType: 'Create' | 'Update' | ...`), so
 *     the filter logic is per-phase. See the helper JSDocs below.
 *   - Each step carries its associated `firesWhen` ConditionalContext
 *     when one exists (looked up via the firer's outgoing `firesWhen`
 *     edges). Steps may have zero or one condition surfaced; multi-
 *     condition firers (Flow with multiple decisions) surface their
 *     first condition only — callers wanting the full list resolve via
 *     `sfi.get_edges`.
 *   - `recordTypeId` is accepted for the input axis but the v2.0e
 *     scope does not narrow automation by record type — the cascade
 *     surfaces every potential automation regardless. The field is
 *     surfaced verbatim in the response so callers can pass it through
 *     to a future v2.0e.1 record-type-scoped narrowing.
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  getNodeById,
  listEdges,
  listEdgesForNodes,
  listNodesByIds,
  listNodesByType,
} from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  soeReceiverVerificationNote,
  verifyStepActionReceivers,
  type ApexReceiverVerification,
  type ReceiverVerifiableStep,
} from './apex-receiver.js';
import {
  buildReservedConceptReasoning,
  CONCEPT_REASONING_SKIPPED_NOTE,
  CONCEPT_REASONING_UNAVAILABLE_NOTE,
  CONCEPT_RESERVATION_MAX_BYTES,
  type ConceptReasoningEnvelope,
} from './concept-reasoning.js';
import { resolveObjectAliasInVault } from './input-aliases.js';
import {
  groundStepConditions,
  type RefGroundableStep,
  SOE_UNGROUNDED_REFS_NOTE,
  soeRefGroundingNotCheckedNote,
  type SoeUngroundedRef,
} from './order-of-execution.js';
import { responseReductionCap } from './response-budget.js';
import {
  buildInactiveSummary,
  type InactiveConfiguredFirer,
  skipInactiveSoeFirer,
  type SoeInactiveSummary,
  sortedInactiveConfigured,
} from './soe-active.js';
import {
  composeSoeDisclosure,
  evaluateSoeAdmission,
  soeNotAdmittedMessage,
} from './soe-admission.js';
import {
  buildDuplicateRuleStep,
  DUPLICATE_RULE_TYPES,
} from './soe-duplicate-rules.js';
import {
  AUTOMATION_PHASES,
  type BoundableStep,
  computePhasesOmitted,
  crossPhaseShortfallNote,
  enforceSoeByteBudget,
  filteredPhaseShortfallNote,
  soeBudgetBytes,
  type SoePhase,
  type SoePhaseCounts,
  type SoePhaseOmission,
  soeTruncationNote,
  tallyPhaseCounts,
} from './soe-payload-bounds.js';
import {
  findRollupRecalcSteps,
  rollupScanTruncationNote,
} from './soe-rollup-recalc.js';
import {
  buildWithinPhaseOrder,
  censusFlowTriggerOrders,
  collectAmbiguousPhases,
  isTriggerOrderCoverageGap,
  sortFlowFirersByTriggerOrder,
  type SoeWithinPhaseOrder,
  TRIGGER_ORDER_NOT_EXTRACTED_CAVEAT,
} from './soe-trigger-order.js';

// Re-export the shared phase-omission contract so this module's public type +
// value surface is unchanged after the definitions moved to soe-payload-bounds
// (WHAT-HAPPENS-ON-SAVE-TRUNCATION-DROPS-LATER-PHASES).
export { computePhasesOmitted, tallyPhaseCounts };
export type { SoePhase, SoePhaseCounts, SoePhaseOmission };

/**
 * The verbatim honesty-axis disclosure surfaced in every response.
 * Frozen here so the test suite can assert the exact string and so a
 * caller-facing rephrasing during rendering is a code-review concern,
 * not a silent drift. BYTE-IDENTICAL to `order-of-execution.ts`'s
 * `DISCLOSURE` — the two SOE tools must stay in lockstep.
 */
const DISCLOSURE =
  "v2.0e composes the documented Salesforce order-of-execution instantiated against THIS org's extracted automation. Before-save record-triggered flows are modeled as the leading `before-save-flows` phase (they run BEFORE before-triggers). Duplicate rules are modeled as their own `duplicate-rules` phase, running after before-triggers and validation but BEFORE the save — evaluated on insert/update only, with the effective Block/Allow/Alert/Report operations surfaced per rule. Conditions ARE listed but NOT EVALUATED — the tool does not know whether this particular record satisfies them at runtime. Workflow field updates can re-fire before/after-update triggers (a second pass); this composition lists each automation once and does not expand that re-entrancy. A workflow rule's time-dependent actions (its workflowTimeTriggers) are SCHEDULED for an offset measured from a record field value the offline vault cannot evaluate; this composition lists the rule once in the synchronous post-save-workflows phase and does NOT claim its time-delayed actions fire at save. Parent Summary (roll-up) fields that aggregate this object recalculate in the `post-save-rollup-recalc` phase, capped to ONE level — a grandparent's own rollup on that recalculated parent is NOT walked — and the parent's own triggers/flows/workflows that its recalculated save would fire are NOT expanded (no re-entrancy). Entitlement-process and milestone-type METADATA is modeled elsewhere in the vault (R6-18: `EntitlementProcess`/`MilestoneType` nodes, queryable via `sfi.get_component` / `sfi.get_edges`, including each milestone's declared target `minutesToComplete` as of R7-C7) — but this composition does NOT simulate entitlement milestones as an order-of-execution phase: whether a specific record is currently on-track or breached against those target minutes is live, per-record timer data this offline vault cannot hold. Criteria-based sharing recalculation — the FINAL step in Salesforce's documented order-of-execution, evaluated after every phase modeled here (including post-save-async) — is also NOT modeled: a save that causes a record to newly match or stop matching a criteria-based sharing rule's criteria triggers a sharing recalculation this composition does not surface. Manual sharing, sharing sets, account teams, and Apex callouts after save are out of scope.";

/**
 * The set of DML events the input axis accepts. Mirrors the
 * documented Salesforce DML lifecycle. `upsert` is included because
 * the platform treats it as insert-or-update at runtime; the cascade
 * surfaces the union of insert and update automation when called with
 * `upsert`.
 */
const ALLOWED_EVENTS = [
  'insert',
  'update',
  'upsert',
  'delete',
  'undelete',
] as const;

type DmlEvent = (typeof ALLOWED_EVENTS)[number];

/**
 * Zod schema for the `sfi.what_happens_on_save` tool input.
 *
 *   - object identity (required): name the object ANY way the router / a
 *     sibling tool would (L2 Alias OS) — the canonical `objectApiName`
 *     (`'Account'`, `'My_Object__c'`), the `object` / `objectId` aliases,
 *     or a `CustomObject:` `componentId`. Exactly one target must survive
 *     resolution — disagreeing aliases are an `invalid-query`, and the
 *     resolved scope is echoed as `appliedScope`. Unknown objects surface as
 *     `component-not-found`.
 *   - `event`: required, one of the five DML events. Trigger-style
 *     phrasings ("after update", "before insert") and any casing are
 *     accepted — the timing prefix is stripped to the bare DML event.
 *   - `recordTypeId`: optional. Carried through to the response
 *     verbatim; v2.0e does NOT narrow automation by record type
 *     (deferred to v2.0e.1).
 */
const WHAT_HAPPENS_ON_SAVE_ACCEPTED_KEYS = [
  'objectApiName',
  'object',
  'objectId',
  'componentId',
  'event',
  'recordTypeId',
  'phase',
  'includeConceptReasoning',
  'includeInactive',
] as const;

/**
 * FIX 12. `.strict()`'s default text ("Unrecognized key(s) in object") does not
 * tell a caller what the tool DOES accept, so a typo'd knob reads as a bug in
 * the tool. This errorMap names the offending key AND the real knob list.
 * Passed at construction (not to `.strict(message)`, which is static and would
 * drop the key name) and preserved by the argument-less `.strict()` below.
 * Byte-for-byte the same helper as `order-of-execution.ts`'s — the two SOE
 * tools must stay in lockstep.
 */
const strictKeyErrorMap =
  (accepted: readonly string[]): z.ZodErrorMap =>
  (issue, ctx) => {
    if (issue.code === z.ZodIssueCode.unrecognized_keys) {
      return {
        message: `Unknown argument '${issue.keys.join("', '")}'. This tool accepts: ${accepted.join(', ')}. Refusing rather than ignoring it — a silently-dropped argument returns a confident answer to a question you did not ask.`,
      };
    }
    return { message: ctx.defaultError };
  };

export const whatHappensOnSaveInputSchema = z
  .object(
    {
    objectApiName: z.string().min(1).optional(),
    object: z.string().min(1).optional(),
    objectId: z.string().min(1).optional(),
    componentId: z.string().min(1).optional(),
    // Accept "after update" / "Before Insert" etc.: lower-case and drop the
    // before/after timing prefix so the bare DML event matches the enum. The
    // SOE walker models both timings internally; the event arg selects the row.
    event: z.preprocess(
      (v) =>
        typeof v === 'string'
          ? v.trim().toLowerCase().replace(/^(?:before|after)\s+/, '')
          : v,
      z.enum(ALLOWED_EVENTS),
    ),
    recordTypeId: z.string().min(1).optional(),
    /**
     * Optional single-phase filter. When set, `soe` returns ONLY that phase's
     * steps (recovery path for a phase truncated out of the full view — see
     * `phasesOmitted`); `summary` still reflects the FULL composition so the
     * caller keeps the whole phase distribution. Echoed back as
     * `appliedPhaseFilter`.
     */
    phase: z.enum(AUTOMATION_PHASES).optional(),
    // Concept-rule reasoning; DEFAULTS TRUE (opt-OUT) on the full view and
    // FALSE on a `phase`-filtered query (a phase call is a RECOVERY call, so
    // the whole budget goes to the requested phase). An explicit `true` always
    // wins. Its bytes are RESERVED out of the SOE budget, never bolted on.
    includeConceptReasoning: z.boolean().optional(),
    /**
     * Return the FULL roster of inactive configured automation as
     * `inactiveConfigured`. Defaults FALSE: the roster is the largest
     * top-level array on a densely-automated object and it describes the
     * automation that does NOT run, so by default the byte budget goes to the
     * automation that DOES. The count is ALWAYS reported in `inactiveSummary`
     * — a CHECKED zero-equivalent, never a silent omission.
     */
    includeInactive: z.boolean().optional(),
    },
    { errorMap: strictKeyErrorMap(WHAT_HAPPENS_ON_SAVE_ACCEPTED_KEYS) },
  )
  // `.strict()` must precede `.refine()` — a ZodEffects has no `.strict()`.
  .strict()
  .refine(
    (i) =>
      i.objectApiName !== undefined ||
      i.object !== undefined ||
      i.objectId !== undefined ||
      i.componentId !== undefined,
    {
      message:
        'name the object — pass `objectApiName` (e.g. "Account"), `object`, `objectId`, or a `CustomObject:` `componentId`',
      path: ['objectApiName'],
    },
  );

/** Parsed input shape, inferred from `whatHappensOnSaveInputSchema`. */
export type WhatHappensOnSaveInput = z.infer<typeof whatHappensOnSaveInputSchema>;

/**
 * One SOE step's condition reference. Carries the synthetic
 * ConditionalContext id, the parsed expression, and the canonical
 * `fieldRefs` array of CustomField canonical ids the expression
 * touches (sourced from the ConditionalContext node's
 * `properties.fieldRefs` per `ConditionalContextSemantics.md`).
 */
export interface SoeStepCondition {
  readonly conditionContextId: ComponentId;
  readonly expression: string;
  /**
   * GROUNDED ONLY. Every id here names a real node in this vault and is safe
   * to cite. FIX 15 (3): before this, a ref the extractor recorded but that
   * named NO component was republished here as a citable component id.
   */
  readonly fieldRefs: readonly ComponentId[];
  /**
   * Refs the condition mentions that do NOT name a component. NEVER citable.
   * Omitted when every ref grounded. See {@link SOE_UNGROUNDED_REFS_NOTE}.
   */
  readonly ungroundedRefs?: readonly SoeUngroundedRef[];
  /**
   * So an empty `fieldRefs` is readable as CHECKED. `checked: false` means the
   * single grounding query FAILED — the counts are then UNCHECKED zeros and
   * `fieldRefs` is the raw extractor record, not a verified list.
   */
  readonly refGrounding: {
    readonly checked: boolean;
    readonly grounded: number;
    readonly ungrounded: number;
  };
}

/**
 * One action a step performs (e.g., a WorkflowRule's `sendsEmail` to
 * a template, a Flow's `writesTo` a field, an ApprovalProcess's
 * `references` to a Group). The `kind` carries the action's
 * edge-level discriminator; `targetId` is the dependent node when
 * the edge resolves; `description` is a one-liner the caller can
 * render verbatim.
 *
 * Actions are deliberately scalar-flat — the depth-3 yaml-
 * frontmatter convention applies here even though this tool emits
 * JSON, because the same shape appears on the
 * `properties.conditions` mirror used by the renderer.
 */
export interface SoeStepAction {
  readonly kind: string;
  readonly targetId?: ComponentId;
  readonly description: string;
}

/**
 * One step in the SOE chain. `stepIndex` is the 0-based position
 * across all phases (preserved across the response so callers can
 * cross-reference); `componentId` / `componentType` / `apiName`
 * identify the firer; `conditional` references the ConditionalContext
 * gate when one exists; `actions` lists what the step will do at
 * runtime.
 *
 * `stepIndex` orders the PHASES, and ONLY the phases. Between two steps in the
 * SAME phase it is a reading position, not an execution order: Salesforce does
 * not define which of two same-kind automations in one phase runs first, except
 * where record-triggered flows declare distinct `<Flow><triggerOrder>` values
 * (which this composition sorts by — see `soe-trigger-order.ts`). Whenever a
 * phase holds two or more steps the response carries `withinPhaseOrder` saying
 * so; never present a within-phase sequence as the order things happen in.
 */
export interface SoeStep {
  readonly phase: SoePhase;
  readonly stepIndex: number;
  readonly componentId: ComponentId;
  readonly componentType: ComponentType;
  readonly apiName: string;
  readonly conditional?: SoeStepCondition;
  readonly actions: readonly SoeStepAction[];
  /**
   * Count of `actions` dropped from this step to keep the response under the
   * MCP payload budget (see {@link enforceSoeByteBudget}). Present only on a
   * trimmed step; absent means the action list is complete.
   */
  readonly actionsOmitted?: number;
  /**
   * APEX-RECEIVER-VERIFIED. Count of this step's edges demoted OUT of `actions`
   * because the Apex scanner's textual receiver does not name a real component
   * — an Apex class or trigger name, an inner DTO, a `__r` traversal, a
   * describe token, an untyped local. Distinct from `actionsOmitted`, which is
   * a byte-budget trim of REAL actions.
   *
   * Present only when this step lost rows. The raw tokens and the per-reason
   * census live once per response on
   * {@link WhatHappensOnSaveOutput.receiverVerification}; naming them per step
   * as well would cost the byte budget the steps need.
   */
  readonly unresolvedActionsOmitted?: number;
  /**
   * True when this step's `conditional` had its `expression`/`fieldRefs`
   * dropped to fit the response budget — the `conditionContextId` remains, so
   * the full condition is fetchable via `get_component`. Absent when intact.
   */
  readonly conditionalTruncated?: boolean;
  /**
   * For a ValidationRule step, the error the rule raises when it BLOCKS the
   * save — the verbatim `errorMessage` and the field it displays on
   * (`errorDisplayField`, or null for a page-level error). Omitted for non-VR
   * firers. Without them, "what happens on save" listed the rule and its firing
   * condition but never the error a user would actually hit.
   */
  readonly errorMessage?: string;
  readonly errorDisplayField?: string | null;
  /**
   * For a DuplicateRule step, its effective `DuplicateRuleOperation` set for
   * THIS event (`Allow`/`Block`/`Alert`/`Report`, deduped). Omitted for
   * non-DuplicateRule firers.
   */
  readonly duplicateRuleOperations?: readonly string[];
  /**
   * For a DuplicateRule step, whether the effective operation set includes
   * `Block` — the derived "does this stop the save" answer. Omitted for
   * non-DuplicateRule firers.
   */
  readonly blocksOnSave?: boolean;
}

/**
 * R6-23: cap on the number of entitlement-process informational notes
 * surfaced per response. An object realistically carries a handful of
 * distinct entitlement processes at most (e.g. Gold/Silver/Bronze SLA
 * tiers on Case); this defends against a pathological org without
 * materially limiting the real case.
 */
const ENTITLEMENT_PROCESS_NOTE_CAP = 20;

/**
 * R6-23: one active `EntitlementProcess` targeting this object — a
 * disclosure-PLUS-pointer, deliberately NOT a simulated order-of-execution
 * phase. Live milestone EVALUATION (whether a specific record is currently
 * on-track or breached) stays unmodeled per `DISCLOSURE`; this only tells
 * the caller WHERE to look (`sfi.get_component` / `sfi.get_edges` on
 * `componentId` surfaces the referenced `MilestoneType`s AND — as of R7-C7
 * — each milestone's declared target `minutesToComplete`, on the
 * EntitlementProcess node's own `properties.milestones`). `confidence` is
 * always `'declared'` — the match is a direct read of the EntitlementProcess
 * node's own `SObjectType` / `active` properties, not an inference.
 */
export interface EntitlementProcessNote {
  readonly componentId: ComponentId;
  readonly apiName: string;
  readonly message: string;
  readonly confidence: 'declared';
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface WhatHappensOnSaveOutput {
  readonly objectApiName: string;
  /**
   * Echoes the object scope ACTUALLY resolved so a host never assumes an alias
   * it passed (`object` / `objectId` / `componentId`) was honored — the silent
   * Zod-strip that surfaced as `objectApiName: Required` was the bug this
   * closes. `componentId` is the canonical `CustomObject:` id; `object` is its
   * bare api name (== `objectApiName`).
   */
  readonly appliedScope: {
    readonly componentId: string;
    readonly object: string;
  };
  readonly event: DmlEvent;
  readonly recordTypeId: ComponentId | null;
  readonly objectModeled: boolean;
  readonly soe: readonly SoeStep[];
  readonly summary: {
    readonly totalSteps: number;
    /**
     * Count of ACTIVE org-configured automation components that fire on
     * this object + event — `totalSteps` minus the one `save` placeholder.
     * The grounded answer to "how many distinct automation components
     * fire", so a caller need not re-derive it from `soe`.
     */
    readonly activeComponents: number;
    readonly conditionalSteps: number;
    readonly asyncFanOut: number;
    /**
     * Per-phase active-component counts, in documented SOE order. Answers
     * the count/ordering question directly (e.g. how many before-save
     * flows vs before-triggers vs after-triggers vs after-save flows).
     * Inactive automation is excluded — it is in `inactiveConfigured`, so
     * a deactivation delta is this map before vs after the change.
     */
    readonly phaseCounts: SoePhaseCounts;
  };
  readonly disclosure: string;
  /**
   * APEX-RECEIVER-VERIFIED. What the receiver check did, for the whole
   * composition. ALWAYS present, because the three states it separates are all
   * meaningful and an absent block would collapse them:
   *
   *   - `checked: true` with an empty `demoted` census — every Apex
   *     field-access receiver in this composition names an SObject node here.
   *     A CHECKED zero.
   *   - `checked: true` with a census — those rows were found NOT to name a
   *     component and were demoted out of `soe[].actions`. `tokens` names them
   *     as RAW TOKENS (capped; the census is complete), and each losing step
   *     carries `unresolvedActionsOmitted`.
   *   - `checked: false` — the verification query FAILED. Every field-access
   *     row is demoted with `receiver-not-verified` and `reason` says why;
   *     nothing is claimed on the lexical guess.
     *
   * Scope is the WHOLE composition, like `summary` — a `phase` filter narrows
   * the returned steps but not this census, so the two never disagree about the
   * same object.
   */
  readonly receiverVerification: ApexReceiverVerification;
  /**
   * Automation configured on this object but inactive (Draft/Obsolete Flow,
   * active:false rule/process). Present ONLY when the caller passed
   * `includeInactive: true` on an un-filtered view — see
   * {@link SoeInactiveSummary}, which is ALWAYS present and always carries the
   * count.
   */
  readonly inactiveConfigured?: readonly InactiveConfiguredFirer[];
  /**
   * D-3 CHECKED ZERO. ALWAYS present — including `total: 0`, which is the
   * whole point: an absent block reads as "inactive automation was never
   * looked at", and a zero-finding response is the shape that most needs to
   * say what WAS scanned.
   */
  readonly inactiveSummary: SoeInactiveSummary;
  /**
   * Phases the returned `soe` does NOT fully represent because byte-budget
   * enforcement dropped trailing steps — each names the phase, its true
   * `declared` count (still in `summary.phaseCounts`), and how many `present`
   * survived. Present ONLY on the full (un-filtered) view when a phase was
   * partially/fully truncated out. `what_happens_on_save` never drops steps
   * (its byte guard keeps every firing step and trims only per-step
   * actions/conditions), so this is normally absent; it exists so a truncated
   * payload can never silently contradict `phaseCounts`. Recover a named phase
   * with the `phase` filter. Omitted when empty.
   */
  readonly phasesOmitted?: readonly SoePhaseOmission[];
  /**
   * Echo of the `phase` input when a single-phase filter was applied — `soe`
   * then holds only that phase's steps (`summary` stays whole-composition).
   * Absent on an un-filtered call.
   */
  readonly appliedPhaseFilter?: Exclude<SoePhase, 'save'>;
  /**
   * FLOW-ORDER-IS-ALPHABETICAL. Present ONLY when this composition has a phase
   * holding two or more steps — the only shape in which the consecutive
   * `stepIndex` values could be read as a run order. Names those phases, which
   * of the three trigger-order states this object is in (`triggerOrderState`),
   * and — when extracted — how many of its record-triggered flows declare one.
   */
  readonly withinPhaseOrder?: SoeWithinPhaseOrder;
  /**
   * Present ONLY when `withinPhaseOrder` is present AND this object HAS
   * record-triggered flows whose `<Flow><triggerOrder>` this vault never
   * extracted — a gap a `sfi refresh` closes. An object with no
   * record-triggered flows never carries it: there was nothing to extract, so
   * claiming a vault gap there would be a fabricated caveat with a remediation
   * that changes nothing.
   */
  readonly coverageCaveat?: typeof TRIGGER_ORDER_NOT_EXTRACTED_CAVEAT;
  /**
   * True when per-step action lists were trimmed to fit the MCP response
   * budget. Every step is still present and in order — only the heaviest
   * steps' action edges were capped (see each step's `actionsOmitted`).
   * Absent when the full response fit.
   */
  readonly truncated?: boolean;
  /**
   * R6-23: active `EntitlementProcess`(es) targeting this object — an
   * informational pointer, NOT a simulated order-of-execution phase (see
   * {@link EntitlementProcessNote}). Omitted when the object carries no
   * active EntitlementProcess. Capped at {@link ENTITLEMENT_PROCESS_NOTE_CAP};
   * `entitlementProcessNotesTruncated` is present (`true`) only when the
   * cap was hit.
   */
  readonly entitlementProcessNotes?: readonly EntitlementProcessNote[];
  /** Present (`true`) only when `entitlementProcessNotes` hit the cap. */
  readonly entitlementProcessNotesTruncated?: boolean;
  /**
   * REASONING-REACHABILITY — deterministic concept-rule claims about the target
   * OBJECT, on the shared `EvidenceEnvelopeV2` contract plus a `completeness`
   * report that keeps "checked and found nothing" distinct from "never
   * checked". DEFAULT ON — absent when the caller passed
   * `includeConceptReasoning: false`, when the reasoning read failed, or when
   * the ANSWER used the budget (see below).
   *
   * HOW IT SHARES THE BUDGET (F4). This tool's SOE cap (`soeBudgetBytes()`)
   * is DERIVED to sit just below what the global response guard would trim to,
   * so the block cannot simply be bolted on afterwards. It used to claim its slice by RIGHT:
   * built first and its size subtracted from the budget, so an opt-out-able
   * enrichment reserved space ahead of the order of execution — measured on a
   * real org's busiest object, 27 of 109 steps with reasoning on against 54
   * with it off.
   *
   * The steps are now fitted FIRST, against the whole budget, and reasoning
   * gets what is left (still capped by `CONCEPT_RESERVATION_MAX_BYTES` — the
   * headroom is a ceiling, not a licence). On a heavy object nothing is left
   * and the block is ABSENT, with a verbatim note saying the steps kept the
   * budget and that no concept layer was checked.
   *
   * Read `completeness.noRuleCoversComponentType` FIRST: when true, no concept
   * rule applies to this component type and an empty `claims` list means
   * NOTHING WAS CHECKED — never "clean".
   */
  readonly conceptReasoning?: ConceptReasoningEnvelope;
  /**
   * TYPED ABSENCE for {@link conceptReasoning} — present EXACTLY when that key
   * is absent, and never at the same time as it. Read it before concluding
   * anything from a missing reasoning block: `checked: false` means no concept
   * layer ran, which is "not checked", never "nothing found". See
   * {@link ConceptReasoningOmission}.
   */
  readonly conceptReasoningOmitted?: ConceptReasoningOmission;
  /**
   * Present ONLY when the composed payload is over {@link responseReductionCap}
   * — the ceiling the GLOBAL response reducer trims to — so it will cut steps
   * from the tail of `soe` and NO argument of this tool can page past the cut.
   * Carries the tool's real accepted-argument list and, depending on whether
   * `phase` is still unspent, either the phases worth re-querying or an
   * executable enumeration for the phase already asked for. See
   * {@link SoeRecoveryPath} — and read it INSTEAD of any generic "re-query with
   * a smaller limit" note in the envelope, which does not apply to this tool.
   *
   * ABSENT on a payload that fits: this block must never be the thing that
   * pushes an answer over the reducer's trigger, because the reducer HALVES
   * what it trims.
   */
  readonly recoveryPath?: SoeRecoveryPath;
}

/**
 * FIX 3 (3). Appended after {@link CONCEPT_REASONING_SKIPPED_NOTE} when the
 * skip was this tool's phase-filter DEFAULT rather than the caller's explicit
 * `includeConceptReasoning: false` — so a caller never has to guess which of
 * the two happened.
 */
const PHASE_FILTER_CONCEPT_REASONING_OFF_NOTE =
  'Concept reasoning is off by default on a phase-filtered query so the whole budget goes to the requested phase; pass includeConceptReasoning: true to force it.';

/**
 * F4. Room kept back from the SOE budget for the honesty scaffolding appended
 * AFTER `enforceSoeByteBudget` has measured `data` — the truncation note, the
 * phase-shortfall sentence, `phasesOmitted`, the concept-reasoning notes and
 * {@link ConceptReasoningOmission}. The longest combination observed on a real
 * org runs under 1 KB; 2 KB is the reserve, so the scaffolding can grow without
 * pushing the payload back over the ceiling.
 *
 * It is passed to `enforceSoeByteBudget` as `budgetBytes` — the module's own
 * documented reserve seam. It used to be subtracted ONLY from the
 * concept-reasoning allowance, which left the enforcement pass fitting `data`
 * to the full `soeBudgetBytes()` and the scaffolding pushing it back over
 * afterwards (measured: fitted to 37 976, delivered at 38 763). A named
 * reserve that the pass it is named for never sees is a comment, not a guard.
 */
const POST_ENFORCEMENT_DISCLOSURE_HEADROOM_BYTES = 2_000;

/**
 * F4. Below this much headroom a concept-reasoning block is not worth
 * attempting: the fitter's own measured floor — counts, coverage, absence,
 * trust and the four conditional honesty sentences, with EVERY enumeration
 * emptied — is ~2.5 KB, so anything under it can only come back over budget.
 * Asking for it anyway would spend a graph traversal to produce a block that
 * has to be thrown away.
 */
const CONCEPT_REASONING_MIN_HEADROOM_BYTES = 2_500;

/**
 * F4. Verbatim note for a reasoning block dropped because the ANSWER used the
 * budget. Product copy: it must read as a deliberate trade, not a failure, and
 * it must not prescribe `includeConceptReasoning: false` — reasoning is already
 * off in this response, and re-passing the flag would change nothing.
 */
const CONCEPT_REASONING_NO_HEADROOM_NOTE = (headroom: number): string =>
  'Concept reasoning was NOT attached to this response: the order-of-execution steps are ' +
  `fitted FIRST and left ${headroom} byte(s) of the response budget, below what a reasoning ` +
  'block needs. The steps are the answer, so they keep the budget. No concept layer was ' +
  'checked here — that is "not checked", not "nothing found". Re-query one `phase` at a time ' +
  'for a narrower response with room for it.';

/**
 * The inactive-roster census is defined ONCE in `soe-active.ts`, beside
 * `InactiveConfiguredFirer` and the active/inactive predicate it counts over.
 * Re-exported here so this module's public type surface is unchanged. Both
 * save-order tools used to carry a byte-identical private copy under a comment
 * promising they would stay in lockstep — the same drift seam that let two
 * constants named `UNPROVEN_REGISTRATION_DISCLOSURE` ship different text.
 */
export type { SoeInactiveSummary };

/**
 * Determine whether a WorkflowRule's `triggerType` property matches
 * the requested DML event. WorkflowRules only fire on insert/update
 * (Salesforce doesn't support workflows for delete/undelete), so
 * non-write events return an empty match set.
 *
 * The `upsert` event matches every workflow that fires on insert OR
 * update (every triggerType value), since the platform treats upsert
 * as insert-or-update.
 */
const workflowMatchesEvent = (
  triggerType: unknown,
  event: DmlEvent,
): boolean => {
  if (typeof triggerType !== 'string') return false;
  if (event === 'delete' || event === 'undelete') return false;
  if (event === 'upsert') return true;
  // onCreateOnly fires on insert only.
  // onCreateOrTriggeringUpdate, onAllChanges, onCreateOrAllChanges fire on insert+update.
  if (event === 'insert') {
    return (
      triggerType === 'onCreateOnly' ||
      triggerType === 'onCreateOrTriggeringUpdate' ||
      triggerType === 'onAllChanges' ||
      triggerType === 'onCreateOrAllChanges'
    );
  }
  // event === 'update'
  return (
    triggerType === 'onCreateOrTriggeringUpdate' ||
    triggerType === 'onAllChanges' ||
    triggerType === 'onCreateOrAllChanges'
  );
};

/**
 * Determine whether a Flow's `recordTriggerType` value matches the
 * requested DML event. Salesforce's record-triggered Flow values are
 * `Create`, `Update`, `CreateAndUpdate`, `Delete`. Non-matching
 * events (e.g., `undelete`) return false — Flow does not surface a
 * Salesforce-documented undelete trigger.
 *
 * `upsert` matches Create + Update + CreateAndUpdate (the union of
 * insert and update).
 *
 * **Absent `recordTriggerType` (under-count guard):** a record-triggered
 * Flow whose `triggersOn` edge carries the before/after discriminator
 * (`triggerType: RecordBeforeSave | RecordAfterSave`) but is MISSING the
 * `recordTriggerType` (the extractor did not stamp it, or the Flow
 * definition omitted `<recordTriggerType>` and the platform defaulted it)
 * is a real, firing automation. Silently excluding it (the old
 * `typeof !== 'string'` short-circuit) under-counts the active flows on a
 * densely-automated object by half. We instead treat an absent value as
 * `CreateAndUpdate` — i.e. it fires on insert/update/upsert — which is the
 * Salesforce default a save-order narration should assume rather than drop
 * the step. It still does NOT match `delete`/`undelete`, since an absent
 * value never implies a delete-triggered flow.
 */
const flowMatchesEvent = (
  recordTriggerType: unknown,
  event: DmlEvent,
): boolean => {
  // Treat an absent / non-string recordTriggerType as the CreateAndUpdate
  // default so an after-save flow with no explicit value is not dropped.
  const effective: string =
    typeof recordTriggerType === 'string' ? recordTriggerType : 'CreateAndUpdate';
  if (event === 'undelete') return false;
  if (event === 'delete') return effective === 'Delete';
  if (event === 'upsert') {
    return (
      effective === 'Create' ||
      effective === 'Update' ||
      effective === 'CreateAndUpdate'
    );
  }
  if (event === 'insert') {
    return effective === 'Create' || effective === 'CreateAndUpdate';
  }
  // event === 'update'
  return effective === 'Update' || effective === 'CreateAndUpdate';
};

/**
 * Determine whether an ApexTrigger's `events` array contains an
 * event that matches the requested DML event for the given timing
 * (`before` for pre-save triggers, `after` for post-save). The
 * trigger header parser emits events as two-word strings like
 * `'before insert'` / `'after update'`; the helper matches against
 * the lifecycle-event suffix.
 *
 * `upsert` matches every trigger that fires on insert OR update at
 * the requested timing.
 */
const triggerMatchesEvent = (
  events: unknown,
  event: DmlEvent,
  timing: 'before' | 'after',
): boolean => {
  if (!Array.isArray(events)) return false;
  for (const e of events) {
    if (typeof e !== 'string') continue;
    if (!e.startsWith(`${timing} `)) continue;
    const action = e.slice(timing.length + 1);
    if (event === 'upsert') {
      if (action === 'insert' || action === 'update') return true;
    } else if (action === event) {
      return true;
    }
  }
  return false;
};

/**
 * Surface the first `firesWhen` ConditionalContext for a firer node,
 * or `undefined` when the firer has no conditions. The condition
 * carries `kind`, `expression`, and the `fieldRefs` array; this
 * helper extracts the
 * `{ conditionContextId, expression, fieldRefs }` triple.
 *
 * Multi-condition firers (a Flow with several `<decisions>` blocks,
 * an ApprovalProcess with both `entryCriteria` formula and
 * `criteriaItems`) surface their FIRST condition only. Callers
 * wanting the full list re-query via
 * `sfi.get_edges({ nodeId, direction: 'out', edgeType: 'firesWhen' })`.
 */
const surfaceFirstCondition = async (
  ctx: Context,
  firerId: ComponentId,
): Promise<Result<SoeStepCondition | undefined, string>> => {
  const edgesResult = await listEdges(ctx.graph, firerId, {
    direction: 'out',
    edgeType: 'firesWhen',
  });
  if (!edgesResult.ok) {
    return err(edgesResult.error.message);
  }
  const firstEdge = edgesResult.value[0];
  if (firstEdge === undefined) return ok(undefined);
  const conditionNodeResult = await getNodeById(ctx.graph, firstEdge.toId);
  if (!conditionNodeResult.ok) {
    return err(conditionNodeResult.error.message);
  }
  if (conditionNodeResult.value === null) return ok(undefined);
  const conditionNode = conditionNodeResult.value;
  const expression = conditionNode.properties['expression'];
  const rawFieldRefs = conditionNode.properties['fieldRefs'];
  const fieldRefs: readonly ComponentId[] = Array.isArray(rawFieldRefs)
    ? rawFieldRefs.filter((v): v is ComponentId => typeof v === 'string')
    : [];
  return ok({
    conditionContextId: conditionNode.id,
    expression: typeof expression === 'string' ? expression : '',
    fieldRefs,
    // Provisional: `groundStepConditions` runs ONE batched probe over the whole
    // composition and rewrites this. Until then nothing is claimed.
    refGrounding: { checked: false, grounded: 0, ungrounded: 0 },
  });
};

/**
 * Build the `actions` array for a firer node by walking its outgoing
 * non-`firesWhen` / non-`parentOf` / non-`triggersOn` edges. Each
 * edge's `edgeType` becomes the action `kind`; the `toId` becomes
 * the optional `targetId`; the description is a short human-readable
 * sentence the caller can render verbatim.
 *
 * `parentOf`, `triggersOn`, and `firesWhen` are skipped because they
 * describe structural relationships (containment, listener target,
 * condition gate) rather than runtime actions. Every other edge type
 * the firer emits is surfaced as an action.
 */
const buildActions = async (
  ctx: Context,
  firerId: ComponentId,
): Promise<Result<readonly SoeStepAction[], string>> => {
  const edgesResult = await listEdges(ctx.graph, firerId, {
    direction: 'out',
  });
  if (!edgesResult.ok) {
    return err(edgesResult.error.message);
  }
  const actions: SoeStepAction[] = [];
  for (const edge of edgesResult.value) {
    if (
      edge.edgeType === 'parentOf' ||
      edge.edgeType === 'triggersOn' ||
      edge.edgeType === 'firesWhen'
    ) {
      continue;
    }
    // APEX-RECEIVER-VERIFIED. Apex-scanner artifacts used to be dropped HERE,
    // by a lexical test that only caught `this.x` / lowercase locals — so an
    // Apex class name, an inner DTO, a `__r` traversal and a describe token
    // survived as save-time FIELD actions on components that do not exist.
    // The decision now happens ONCE per composition in
    // `verifySoeActionReceivers`, which checks each receiver against the vault
    // and DISCLOSES what it demoted instead of deleting it silently. Everything
    // is emitted here; nothing downstream reads `actions` before that pass.
    actions.push({
      kind: edge.edgeType,
      targetId: edge.toId,
      description: `${edge.edgeType} ${edge.toId}`,
    });
  }
  return ok(actions);
};

/**
 * Compose the structural step for a single firer. Resolves the
 * firer node, fetches its first `firesWhen` condition (when one
 * exists), and builds the actions array. Returns `null` when the
 * firer node went missing (sparse-graph case — matches the silent-
 * skip convention every composition tool uses).
 */
const buildStep = async (
  ctx: Context,
  firer: Node,
  phase: SoePhase,
  stepIndex: number,
): Promise<Result<SoeStep, string>> => {
  const conditionResult = await surfaceFirstCondition(ctx, firer.id);
  if (!conditionResult.ok) return err(conditionResult.error);
  const actionsResult = await buildActions(ctx, firer.id);
  if (!actionsResult.ok) return err(actionsResult.error);
  const base: Omit<SoeStep, 'conditional'> = {
    phase,
    stepIndex,
    componentId: firer.id,
    componentType: firer.type,
    apiName: firer.apiName,
    actions: actionsResult.value,
    // A ValidationRule's user-facing payload is the error it raises when it
    // BLOCKS the save; surface it (and the field it lands on) so "what happens
    // on save" can answer "...and what error would I hit?". Omitted for non-VR
    // firers. errorMessage is required by the VR extractor; errorDisplayField
    // is null for a page-level (non-field) error.
    ...(firer.type === 'ValidationRule'
      ? {
          errorMessage:
            typeof firer.properties['errorMessage'] === 'string'
              ? firer.properties['errorMessage']
              : '',
          errorDisplayField:
            typeof firer.properties['errorDisplayField'] === 'string'
              ? firer.properties['errorDisplayField']
              : null,
        }
      : {}),
  };
  return ok(
    conditionResult.value === undefined
      ? base
      : { ...base, conditional: conditionResult.value },
  );
};

/**
 * Walk all outgoing `parentOf` edges from the target object and
 * resolve them into the candidate firer set. Filters by the caller-
 * provided ComponentType set so only the firers relevant to the
 * current phase are returned.
 */
const fetchParentedFirers = async (
  ctx: Context,
  objectId: ComponentId,
  allowedTypes: ReadonlySet<ComponentType>,
): Promise<Result<readonly Node[], string>> => {
  const edgesResult = await listEdges(ctx.graph, objectId, {
    direction: 'out',
    edgeType: 'parentOf',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  // ONE batched node fetch for every parentOf child, replacing the per-edge
  // `getNodeById` N+1. The per-edge Map lookup preserves the old loop's
  // multiplicity and null-skip (`listNodesByIds` drops ids with no row exactly
  // like `getNodeById`); the trailing id-ASC sort makes push order irrelevant.
  const nodesResult = await listNodesByIds(
    ctx.graph,
    edgesResult.value.map((e) => e.toId),
  );
  if (!nodesResult.ok) return err(nodesResult.error.message);
  const byId = new Map(nodesResult.value.map((n) => [n.id, n]));
  const firers: Node[] = [];
  for (const edge of edgesResult.value) {
    const node = byId.get(edge.toId);
    if (node === undefined) continue;
    if (!allowedTypes.has(node.type)) continue;
    firers.push(node);
  }
  // Deterministic order by id so the response is stable across runs.
  return ok([...firers].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
};

/**
 * Walk all incoming `triggersOn` edges to the target object and
 * resolve the firers (Flow, ApexTrigger, WorkflowRule). Filters by
 * the caller-provided ComponentType set so only the firers relevant
 * to the current phase are returned.
 */
const fetchTriggersOnFirers = async (
  ctx: Context,
  objectId: ComponentId,
  allowedTypes: ReadonlySet<ComponentType>,
): Promise<Result<readonly Node[], string>> => {
  const edgesResult = await listEdges(ctx.graph, objectId, {
    direction: 'in',
    edgeType: 'triggersOn',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  // ONE batched node fetch for every triggersOn firer, replacing the per-edge
  // `getNodeById` N+1 (mirrors fetchParentedFirers above).
  const nodesResult = await listNodesByIds(
    ctx.graph,
    edgesResult.value.map((e) => e.fromId),
  );
  if (!nodesResult.ok) return err(nodesResult.error.message);
  const byId = new Map(nodesResult.value.map((n) => [n.id, n]));
  const firers: Node[] = [];
  for (const edge of edgesResult.value) {
    const node = byId.get(edge.fromId);
    if (node === undefined) continue;
    if (!allowedTypes.has(node.type)) continue;
    firers.push(node);
  }
  return ok([...firers].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
};

/**
 * Build the post-save-async step list from a set of "source"
 * firers identified in earlier phases. Walks each source's outgoing
 * `dispatchesAsync` edges and resolves the target ApexClass node
 * (the queueable / batchable / schedulable / @future job).
 *
 * Targets are deduplicated by id — if multiple triggers / classes
 * dispatch to the same async job, the job appears once.
 */
const buildAsyncSteps = async (
  ctx: Context,
  sources: readonly Node[],
  startingStepIndex: number,
): Promise<Result<readonly SoeStep[], string>> => {
  // ONE batched fetch of every source's OUTGOING dispatchesAsync edges, then ONE
  // batched fetch of the distinct target job nodes — replacing the per-source
  // `listEdges` + per-edge `getNodeById` double N+1. The distinct-toId set is
  // collected in the same source→bucket order the old loop saw (irrelevant to
  // the output, which sorts by id); `listNodesByIds` drops target ids with no
  // row exactly like the old null-skip, so `sorted` is the same distinct
  // non-null job set.
  const edgeBatch = await listEdgesForNodes(
    ctx.graph,
    sources.map((s) => s.id),
    { direction: 'out', edgeTypes: ['dispatchesAsync'] },
  );
  if (!edgeBatch.ok) return err(edgeBatch.error.message);
  const seenIds = new Set<ComponentId>();
  const targetIds: ComponentId[] = [];
  for (const source of sources) {
    for (const edge of edgeBatch.value.get(source.id) ?? []) {
      if (seenIds.has(edge.toId)) continue;
      seenIds.add(edge.toId);
      targetIds.push(edge.toId);
    }
  }
  const jobsResult = await listNodesByIds(ctx.graph, targetIds);
  if (!jobsResult.ok) return err(jobsResult.error.message);
  const sorted = [...jobsResult.value].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const steps: SoeStep[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const stepResult = await buildStep(
      ctx,
      sorted[i]!,
      'post-save-async',
      startingStepIndex + i,
    );
    if (!stepResult.ok) return err(stepResult.error);
    steps.push(stepResult.value);
  }
  return ok(steps);
};

/** Allowed types for the post-save-assignment phase. */
const ASSIGNMENT_TYPES: ReadonlySet<ComponentType> = new Set([
  'AssignmentRule',
  'AutoResponseRule',
  'EscalationRule',
]);

/** Allowed types for the post-save-approval phase. */
const APPROVAL_TYPES: ReadonlySet<ComponentType> = new Set([
  'ApprovalProcess',
]);

/** Allowed types for the pre-save-validation phase. */
const VALIDATION_TYPES: ReadonlySet<ComponentType> = new Set([
  'ValidationRule',
]);

/** Allowed types for the post-save-flow phase. */
const FLOW_TYPES: ReadonlySet<ComponentType> = new Set(['Flow']);

/** Allowed types for trigger phases. */
const TRIGGER_TYPES: ReadonlySet<ComponentType> = new Set(['ApexTrigger']);

/** Allowed types for the post-save-workflows phase. */
const WORKFLOW_TYPES: ReadonlySet<ComponentType> = new Set(['WorkflowRule']);

/**
 * RECOVERY-PATH-NAMES-KNOBS-THIS-TOOL-DOES-NOT-HAVE.
 *
 * ## The measured defect
 *
 * On a real org's busiest object the `pre-save-validation` phase holds 100
 * active rules. The composed payload is ~65 KB against a ~38 KB budget, so the
 * GLOBAL response reducer tail-truncates `soe` to 50 steps. Everything about
 * that was disclosed honestly EXCEPT the way out. Three separate sentences told
 * the caller how to recover and all three were dead ends for THIS tool:
 *
 *   - the envelope's shared `responseBudget.note`: "re-query with a smaller
 *     limit";
 *   - {@link filteredPhaseShortfallNote}: "narrow further with limit/offset, or
 *     pass includeConceptReasoning: false";
 *   - {@link CONCEPT_REASONING_NO_HEADROOM_NOTE} / the cross-phase note:
 *     "re-query one `phase` at a time".
 *
 * `sfi.what_happens_on_save` is `.strict()` and accepts NO `limit`, `offset` or
 * `cursor` — following the first two returns `invalid-query: Unknown argument`.
 * `includeConceptReasoning` is ALREADY false on a phase-filtered call, so
 * re-passing it changes nothing. And the third is false precisely when it is
 * needed: a phase-filtered call on that object returns 50 of 100 as well,
 * because ONE phase is itself over budget. The other 50 rules that can block a
 * save were unreachable through the tool that models them.
 *
 * Those three sentences are shared prose: two live in `soe-payload-bounds.ts`
 * (used by `order_of_execution` too, which DOES accept limit/offset/cursor, so
 * they are true THERE) and one in the dispatcher's envelope. This module cannot
 * rewrite them. What it can do — and what {@link SoeRecoveryPath} does — is
 * state the truth for THIS tool in a TYPED field a machine consumer cannot skip
 * and in prose a host reads aloud: name every argument the tool really accepts,
 * say that the narrowest scope has already been applied when it has, and hand
 * back an EXECUTABLE, resumable enumeration that does reach the full roster.
 *
 * ## What it must never cost
 *
 * The reducer HALVES the list it trims, so a disclosure block bolted onto an
 * over-budget payload can cost fifty percent of the delivered steps — and a
 * block bolted onto a payload that FIT can cause the trim outright. Both were
 * measured on a real org and both are now designed out: the block is gated on
 * {@link responseReductionCap} (never on this tool's stricter local cap), it is
 * capped at {@link RECOVERY_PATH_BYTE_CEILING}, and it enumerates ONE phase —
 * the one already asked for — rather than all eleven. See
 * {@link buildPhaseEnumeration}.
 *
 * ## Why the enumerations are trustworthy
 *
 * They are DERIVED from the same `ComponentType` sets the phase collectors
 * filter on, and from the same `parentOf` / `triggersOn` split the collectors
 * walk — not a second hand-maintained copy free to drift. A phase whose firers
 * reach this object by neither route gets an EMPTY `enumerateWith` and a stated
 * `unenumerableReason` rather than a call that would answer a different
 * question.
 */
const PARENT_SCOPED_PHASE_TYPES: ReadonlyMap<
  Exclude<SoePhase, 'save'>,
  ReadonlySet<ComponentType>
> = new Map([
  ['pre-save-validation', VALIDATION_TYPES],
  ['duplicate-rules', DUPLICATE_RULE_TYPES],
  ['post-save-assignment', ASSIGNMENT_TYPES],
  ['post-save-approval', APPROVAL_TYPES],
]);

/**
 * Phases whose firers reach the target object by an INCOMING `triggersOn` edge
 * (see {@link fetchTriggersOnFirers}). Their full roster is reachable with
 * `sfi.get_edges`, which pages with a resumable cursor.
 */
const TRIGGERS_ON_PHASES: ReadonlySet<Exclude<SoePhase, 'save'>> = new Set([
  'before-save-flows',
  'pre-save-triggers',
  'after-triggers',
  'post-save-workflows',
  'post-save-flows',
]);

/** One executable, resumable call that enumerates a phase's candidate roster. */
export interface SoePhaseEnumeration {
  readonly tool: 'sfi.list_components' | 'sfi.get_edges';
  readonly arguments: Readonly<Record<string, string | number>>;
  /**
   * ALWAYS `true`, and stated rather than implied: every enumeration named here
   * is a SUPERSET of the phase. It ignores the DML `event` filter and the
   * active/inactive filter this composition applies, and the `triggersOn` one
   * spans all five edge-driven phases at once. It answers "what is the complete
   * roster this phase is drawn from", never "what fires on this event".
   */
  readonly superset: true;
}

/**
 * TYPED, MACHINE-READABLE recovery contract for the ONE state in which this
 * tool has genuinely run out of exits.
 *
 * Emitted when BOTH hold:
 *
 *   1. `data` is over {@link responseReductionCap}, so the global reducer will
 *      cut steps from `soe` after this handler returns; and
 *   2. `phase` was supplied — the narrowest scope the tool has is SPENT.
 *
 * Condition 2 is not thrift, it is the definition of the defect. An UNFILTERED
 * over-budget answer already carries `crossPhaseShortfallNote`'s "re-query with
 * the `phase` filter to see the full roster", which names a knob this tool
 * really has and really does narrow with — a working exit, not a dead end. It
 * is the PHASE-FILTERED answer whose shared tail says "narrow further with
 * limit/offset, or pass includeConceptReasoning: false", and every one of those
 * is refused or already in force. So the correction goes exactly where the
 * false advice is, the chain terminates (unfiltered → `phase` → this block →
 * the complete roster), and the answer that has no headroom to spare does not
 * pay for a paragraph it does not need.
 *
 * See {@link PARENT_SCOPED_PHASE_TYPES} for the defect this closes, and
 * {@link RECOVERY_PATH_BYTE_CEILING} for why it is this small.
 */
export interface SoeRecoveryPath {
  /** Literal `false`: no argument of this tool can resume this response. */
  readonly resumable: false;
  readonly reason: 'over-budget-and-tool-accepts-no-paging-arguments';
  /**
   * Size of the COMPOSED payload — what this handler built, BEFORE the global
   * reducer trimmed it. It is deliberately not the size of what you received:
   * the reducer runs after this handler returns and this number is the evidence
   * that it had to. Read `soe.length` against `summary.phaseCounts` for what
   * actually arrived.
   */
  readonly composedPayloadBytes: number;
  /** {@link responseReductionCap} — the ceiling `composedPayloadBytes` is over. */
  readonly reducerCapBytes: number;
  /**
   * Every argument this tool accepts. The SAME tuple that drives the
   * `.strict()` refusal message, so the refusal and this list can never
   * disagree. `accepted arguments track the input schema` pins it to
   * {@link whatHappensOnSaveInputSchema}'s own shape — the tuple is
   * hand-maintained, so a drift test, not a comment, is what holds it there.
   */
  readonly acceptedArguments: readonly string[];
  /** The finest scope this tool offers. There is nothing narrower. */
  readonly narrowestScope: 'phase';
  /**
   * Literal `true`. The block exists ONLY in the state where `phase` was
   * already applied and the single phase STILL did not fit — see
   * {@link SoeRecoveryPath} for why an unfiltered answer does not get one.
   */
  readonly narrowestScopeApplied: true;
  /**
   * The way out, as calls a host can run. Empty ONLY when no single call
   * reaches the phase, in which case {@link unenumerableReason} says why rather
   * than leaving a bare `[]` to be read as "nothing to enumerate".
   */
  readonly enumerateWith: readonly SoePhaseEnumeration[];
  /** Present exactly when {@link enumerateWith} is empty. */
  readonly unenumerableReason?: string;
}

/**
 * Phases no single call enumerates, each with the reason IN ITS OWN WORDS.
 * `covers every automation phase` asserts that these three maps
 * ({@link PARENT_SCOPED_PHASE_TYPES}, {@link TRIGGERS_ON_PHASES}, this one)
 * partition `AUTOMATION_PHASES` exactly, so a new phase cannot silently inherit
 * another phase's excuse.
 */
const UNENUMERABLE_PHASE_REASONS: ReadonlyMap<Exclude<SoePhase, 'save'>, string> =
  new Map([
    [
      'post-save-async',
      'reached by a dispatchesAsync edge FROM each earlier-phase firer, not from this object — enumerate per firer with sfi.get_edges.',
    ],
    [
      'post-save-rollup-recalc',
      'matched by a property scan over parent Summary fields, not by an edge from this object — no single call enumerates it.',
    ],
  ]);

/** Page size named in an emitted `sfi.list_components` recovery call. */
const LIST_COMPONENTS_PAGE_LIMIT = 100;

/** Page size named in an emitted `sfi.get_edges` recovery call. */
const GET_EDGES_PAGE_LIMIT = 100;

/**
 * The three routes' phase keys, exported ONLY so a drift test can prove they
 * partition {@link AUTOMATION_PHASES}. A comment claiming full coverage is what
 * this replaces — R6: a parity comment is not a guard.
 */
export const RECOVERY_PHASE_ROUTES: {
  readonly parentScoped: readonly string[];
  readonly triggersOn: readonly string[];
  readonly unenumerable: readonly string[];
} = {
  parentScoped: [...PARENT_SCOPED_PHASE_TYPES.keys()],
  triggersOn: [...TRIGGERS_ON_PHASES],
  unenumerable: [...UNENUMERABLE_PHASE_REASONS.keys()],
};

/**
 * MEASURED CEILING for the whole recovery block, prose included.
 *
 * The global reducer HALVES a list to make room (`keep = max(10, floor(len/2))`
 * in `tool-dispatch.ts`), so on an over-budget payload every byte this block
 * costs can cost fifty percent of the delivered steps. The first shape of this
 * block enumerated all eleven phases and ran 1.6-2.8 KB; measured on a real
 * org through the FULL pipeline that turned a 54-step answer into 27 and a
 * 60-step answer into 30. `stays inside its byte ceiling` pins the current
 * shape so a future field cannot quietly buy itself half an answer.
 *
 * 1 500 is set against the SMALLEST slack measured on the only path that emits
 * the block: on a real org's busiest object a phase-filtered answer arrives
 * with ~3 100 bytes to spare under the reducer's trigger, and the block as
 * shipped costs ~1 370 of them. Roughly a factor of two in hand, and a test
 * that fails long before the block can start buying steps.
 */
export const RECOVERY_PATH_BYTE_CEILING = 1_500;

/**
 * The ONE phase enumeration a phase-filtered over-budget answer hands back.
 *
 * Only the phase-filtered path gets enumerations, and only for its own phase.
 * An unfiltered answer's cheap recovery is a narrower re-query (`retryPhases`),
 * and enumerating every phase up front is what made the first version of this
 * block cost half the answer — see {@link RECOVERY_PATH_BYTE_CEILING}.
 *
 * DERIVED from the same `ComponentType` sets the phase collectors filter on and
 * the same `parentOf` / `triggersOn` split they walk, so an enumeration cannot
 * describe a different roster than the phase it names.
 *
 * Exported so `every phase route resolves to the call that actually reaches it`
 * can exercise all three routes directly. Only a phase-filtered over-budget
 * answer emits one, and fixturing that state for every phase would test the
 * budget arithmetic rather than the routing.
 */
export const buildPhaseEnumeration = (
  objectId: ComponentId,
  phase: Exclude<SoePhase, 'save'>,
): { readonly calls: readonly SoePhaseEnumeration[]; readonly reason?: string } => {
  const parentTypes = PARENT_SCOPED_PHASE_TYPES.get(phase);
  if (parentTypes !== undefined) {
    return {
      calls: [...parentTypes].map((type) => ({
        tool: 'sfi.list_components' as const,
        arguments: { type, parentId: objectId, limit: LIST_COMPONENTS_PAGE_LIMIT },
        superset: true as const,
      })),
    };
  }
  if (TRIGGERS_ON_PHASES.has(phase)) {
    return {
      calls: [
        {
          tool: 'sfi.get_edges' as const,
          arguments: {
            nodeId: objectId,
            direction: 'in',
            edgeType: 'triggersOn',
            limit: GET_EDGES_PAGE_LIMIT,
          },
          superset: true as const,
        },
      ],
    };
  }
  return {
    calls: [],
    // Keyed, never a fall-through `else`. A phase added to `AUTOMATION_PHASES`
    // but to none of the three maps would otherwise inherit whichever sentence
    // the `else` happened to hold — a fabricated reason, which is the defect
    // this whole block exists to remove. It gets the neutral sentence instead,
    // and `covers every automation phase` fails so the gap is fixed rather
    // than shipped.
    reason:
      UNENUMERABLE_PHASE_REASONS.get(phase) ??
      'this phase is reached by neither a parentOf nor a triggersOn edge from this object, and this tool names no enumeration for it.',
  };
};

/**
 * Verbatim recovery prose. It must contradict the shared boilerplate BY NAME —
 * a host that has just read "re-query with a smaller limit" needs to be told
 * that sentence does not apply here, not merely offered an alternative. Every
 * clause is DERIVED from the block beside it, so the sentence a host reads
 * aloud and the field a machine reads can never state two different things, and
 * it names no key this response did not populate.
 */
const recoveryPathNote = (path: SoeRecoveryPath): string =>
  `RECOVERY PATH. The composed payload was ${path.composedPayloadBytes} byte(s) against a ` +
  `${path.reducerCapBytes} byte reducer cap, so steps were cut from the END of \`soe\` after ` +
  'this tool returned — any phase where `soe` holds fewer steps than `summary.phaseCounts` ' +
  'declares was CUT, never absent. This tool accepts NO `limit`, `offset` or `cursor`, and ' +
  '`phase` — its narrowest scope — is already applied, so every "narrow further with ' +
  'limit/offset", "re-query with a smaller limit" or "pass includeConceptReasoning: false" ' +
  'note elsewhere in this response is generic boilerplate that DOES NOT APPLY here: those ' +
  'arguments are refused as unknown, and reasoning is already off. ' +
  (path.enumerateWith.length > 0
    ? "Run `recoveryPath.enumerateWith` for this phase's COMPLETE roster (resumable; each is a " +
      'SUPERSET, ignoring the `event` and active filters applied here).'
    : 'No single call enumerates this phase — `recoveryPath.unenumerableReason` says why.');

/**
 * TYPED ABSENCE for the concept-reasoning block (R1).
 *
 * `conceptReasoning` is documented DEFAULT ON, so a host that finds the key
 * missing has no way to tell "the reasoning engine ran and flagged nothing"
 * from "no concept layer was checked at all" — and the block's own contract
 * (`completeness.noRuleCoversComponentType`) exists precisely to stop that
 * misreading. Measured on a real org: the key is present on four light objects
 * and absent on the two heavy ones, i.e. absent exactly where the answer is
 * least complete. The prose said so; nothing TYPED did, and a machine consumer
 * reading `data` cannot be asked to regex a paragraph.
 *
 * So absence is now decided by a property the payload CARRIES. `checked` is the
 * literal `false` — this object is emitted ONLY when the block is missing.
 */
export interface ConceptReasoningOmission {
  /** Literal `false`. An absent `conceptReasoning` is never "checked and clean". */
  readonly checked: false;
  readonly reason:
    | 'caller-opted-out'
    | 'phase-filter-default'
    | 'no-budget-headroom'
    | 'build-unavailable';
  /**
   * Bytes left for the block after the steps were fitted. Never negative.
   *
   * ABSENT — not zero — on `caller-opted-out` and `phase-filter-default`, where
   * the block was never attempted and no headroom was ever measured. A `0`
   * beside {@link minimumHeadroomBytes} reads as a MEASUREMENT saying "no room
   * was left", which is a different (and false) claim from "no one looked". A
   * typed-absence field that invents a number is the exact shape this field
   * exists to prevent, so it is omitted instead.
   */
  readonly headroomBytes?: number;
  /**
   * {@link CONCEPT_REASONING_MIN_HEADROOM_BYTES} at the time of measurement.
   * Present exactly when {@link headroomBytes} is — the two are only readable
   * together.
   */
  readonly minimumHeadroomBytes?: number;
}

/**
 * The `sfi.what_happens_on_save` MCP tool. Returns the ordered SOE
 * step list for the given object + event combination. See the module
 * JSDoc for the cascade and the honesty-axis design.
 *
 * @example
 *   const r = await whatHappensOnSaveHandler(ctx, {
 *     objectApiName: 'Account',
 *     event: 'insert',
 *   });
 *   if (r.ok) for (const step of r.value.data.soe) {
 *     console.log(step.phase, step.apiName);
 *   }
 */
export const whatHappensOnSaveHandler = async (
  ctx: Context,
  rawInput: WhatHappensOnSaveInput,
): Promise<Result<McpResponse<WhatHappensOnSaveOutput>, McpError>> => {
  // L2 Alias OS: resolve the object from any of objectApiName / object /
  // objectId / CustomObject: componentId. Disagreeing aliases -> invalid-query.
  // `...InVault` additionally folds CASE against the vault's own ids, because
  // Salesforce api names are case-insensitive and `route_question("what runs
  // when I save a contact?")` binds the lower-case form. The id echoed below is
  // the VAULT's spelling, never the caller's.
  const scopeResult = await resolveObjectAliasInVault(ctx.graph, rawInput);
  if (!scopeResult.ok) return err(scopeResult.error);
  if (scopeResult.value === null) {
    return err({
      kind: 'invalid-query',
      message:
        'name the object — pass `objectApiName`, `object`, `objectId`, or a `CustomObject:` `componentId`',
      path: 'objectApiName',
    });
  }
  const appliedScope = {
    componentId: scopeResult.value.componentId,
    object: scopeResult.value.object,
  };
  // Normalize the object identity into `objectApiName` so every downstream
  // read below stays byte-identical to the canonical-arg path.
  const input = { ...rawInput, objectApiName: scopeResult.value.object };
  const objectId: ComponentId = `CustomObject:${input.objectApiName}`;
  const admission = await evaluateSoeAdmission(ctx, objectId);
  if (!admission.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${admission.error}`,
    });
  }
  if (!admission.value.admitted) {
    return err({
      kind: 'component-not-found',
      message: soeNotAdmittedMessage(
        objectId,
        admission.value.referencedButNotModeled ?? false,
      ),
      path: objectId,
    });
  }
  const { objectModeled } = admission.value;

  const soe: SoeStep[] = [];
  const inactiveCollector = new Map<ComponentId, InactiveConfiguredFirer>();
  let stepIndex = 0;

  // Phase 0: before-save-flows. Before-save record-triggered Flows (Spring '22)
  // run BEFORE before-triggers — the FIRST automation in the modern order of
  // execution (they fire only on insert/update). The before/after-save
  // discriminator lives on the `triggersOn` EDGE (`properties.triggerType`).
  // Fetch the Flow set once and partition by that edge so the after-save flows
  // below reuse it.
  const allFlowsResult = await fetchTriggersOnFirers(ctx, objectId, FLOW_TYPES);
  if (!allFlowsResult.ok) {
    return err({ kind: 'internal', message: allFlowsResult.error });
  }
  const beforeSaveFlows: Array<{ firer: Node; recordTriggerType: unknown }> = [];
  const afterSaveFlows: Array<{ firer: Node; recordTriggerType: unknown }> = [];
  // ONE batched fetch of every Flow's OUTGOING triggersOn edges, replacing the
  // per-flow `listEdges` N+1. Each bucket is sorted by the FULL (to_id,
  // edge_type, from_id, source) order — a refinement of listEdges' order — so
  // `.find(e => e.toId === objectId)` returns the same first-matching edge.
  const flowEdgeBatch = await listEdgesForNodes(
    ctx.graph,
    allFlowsResult.value.map((f) => f.id),
    { direction: 'out', edgeTypes: ['triggersOn'] },
  );
  if (!flowEdgeBatch.ok) {
    return err({ kind: 'internal', message: flowEdgeBatch.error.message });
  }
  for (const firer of allFlowsResult.value) {
    if (skipInactiveSoeFirer(inactiveCollector, firer)) continue;
    const flowEdges = flowEdgeBatch.value.get(firer.id) ?? [];
    const edgeToObject = flowEdges.find((e) => e.toId === objectId);
    if (edgeToObject === undefined) continue;
    const entry = { firer, recordTriggerType: edgeToObject.properties['recordTriggerType'] };
    if (edgeToObject.properties['triggerType'] === 'RecordBeforeSave') beforeSaveFlows.push(entry);
    else afterSaveFlows.push(entry);
  }
  // FLOW-ORDER-IS-ALPHABETICAL. Within one phase these arrays were emitted in
  // ascending component id and numbered as if that were the run order. Sort by
  // the ONE thing Salesforce lets an admin declare — `<Flow><triggerOrder>` —
  // falling back to ascending id, which is what the sort collapses to on a
  // vault that never extracted the property or an org where no flow declares
  // one. See `soe-trigger-order.ts`; the residual ambiguity is disclosed in
  // `withinPhaseOrder` below rather than papered over with a numbered list.
  const orderedBeforeSaveFlows = sortFlowFirersByTriggerOrder(beforeSaveFlows);
  const orderedAfterSaveFlows = sortFlowFirersByTriggerOrder(afterSaveFlows);
  // The census covers the record-triggered flows that actually reach THIS
  // response's phases — i.e. those surviving the per-event filter below.
  //
  // It used to be taken over every flow resolved for the object, BEFORE that
  // filter, on the reasoning that the vault's extraction state is a property of
  // the vault rather than of the DML event. True of the vault, but the caveat
  // it gates says "the flow steps below are ordered by ascending component id
  // only" — and on `event: "delete"` there are no flow steps below. That
  // fabricated a Flow.triggerOrder coverage gap, plus a `sfi refresh`
  // remediation that would change nothing, on a composition whose only
  // ambiguous phase was two Apex triggers.
  const eventFlowFirers: Node[] = [];
  for (const { firer, recordTriggerType } of orderedBeforeSaveFlows) {
    if (!flowMatchesEvent(recordTriggerType, input.event)) continue;
    eventFlowFirers.push(firer);
    const stepResult = await buildStep(ctx, firer, 'before-save-flows', stepIndex);
    if (!stepResult.ok) {
      return err({ kind: 'internal', message: stepResult.error });
    }
    soe.push(stepResult.value);
    stepIndex += 1;
  }

  // Phase 1: pre-save-triggers. ApexTriggers whose `events` includes
  // a `before <event>` lifecycle entry. Before triggers run after the
  // before-save flows but ahead of custom validation rules. The trigger
  // set is fetched once here and re-filtered for the after-triggers phase.
  const beforeTriggersResult = await fetchTriggersOnFirers(
    ctx,
    objectId,
    TRIGGER_TYPES,
  );
  if (!beforeTriggersResult.ok) {
    return err({ kind: 'internal', message: beforeTriggersResult.error });
  }
  const beforeTriggers: Node[] = [];
  for (const firer of beforeTriggersResult.value) {
    if (skipInactiveSoeFirer(inactiveCollector, firer)) continue;
    if (triggerMatchesEvent(firer.properties['events'], input.event, 'before')) {
      const stepResult = await buildStep(
        ctx,
        firer,
        'pre-save-triggers',
        stepIndex,
      );
      if (!stepResult.ok) {
        return err({ kind: 'internal', message: stepResult.error });
      }
      soe.push(stepResult.value);
      beforeTriggers.push(firer);
      stepIndex += 1;
    }
  }

  // Phase 2: pre-save-validation. Custom validation rules run AFTER
  // before triggers. ValidationRules fire on every insert/update;
  // delete/undelete do not run validation rules.
  if (input.event === 'insert' || input.event === 'update' || input.event === 'upsert') {
    const validationsResult = await fetchParentedFirers(
      ctx,
      objectId,
      VALIDATION_TYPES,
    );
    if (!validationsResult.ok) {
      return err({ kind: 'internal', message: validationsResult.error });
    }
    for (const firer of validationsResult.value) {
      if (skipInactiveSoeFirer(inactiveCollector, firer)) continue;
      const stepResult = await buildStep(
        ctx,
        firer,
        'pre-save-validation',
        stepIndex,
      );
      if (!stepResult.ok) {
        return err({ kind: 'internal', message: stepResult.error });
      }
      soe.push(stepResult.value);
      stepIndex += 1;
    }
  }

  // Phase 3: duplicate-rules. DuplicateRules parented to the object run
  // AFTER before-triggers and validation, BEFORE the record is saved — per
  // Salesforce's documented order-of-execution numbering. They evaluate on
  // insert/update only (same event gate as validation rules).
  if (input.event === 'insert' || input.event === 'update' || input.event === 'upsert') {
    const duplicateRulesResult = await fetchParentedFirers(
      ctx,
      objectId,
      DUPLICATE_RULE_TYPES,
    );
    if (!duplicateRulesResult.ok) {
      return err({ kind: 'internal', message: duplicateRulesResult.error });
    }
    for (const firer of duplicateRulesResult.value) {
      if (skipInactiveSoeFirer(inactiveCollector, firer)) continue;
      const dupResult = await buildDuplicateRuleStep(ctx, firer, input.event);
      if (!dupResult.ok) {
        return err({ kind: 'internal', message: dupResult.error });
      }
      // `null` means the rule's effective operations for THIS event are empty
      // (e.g. only operationsOnUpdate configured, called on insert) — it does
      // not evaluate on this event, so it is excluded, mirroring how the
      // workflow/flow event gates drop a non-matching firer.
      if (dupResult.value === null) continue;
      const dup = dupResult.value;
      soe.push({
        phase: 'duplicate-rules',
        stepIndex,
        componentId: dup.componentId,
        componentType: 'DuplicateRule',
        apiName: dup.apiName,
        actions: dup.matchingRules.map((toId) => ({
          kind: 'references',
          targetId: toId,
          description: `references ${toId}`,
        })),
        duplicateRuleOperations: dup.operations,
        blocksOnSave: dup.blocksOnSave,
      });
      stepIndex += 1;
    }
  }

  // Phase 4: save. A documented placeholder; the platform's
  // system-validation + database-write step has no per-org node.
  // Stable id under the CustomObject so the step is renderable.
  soe.push({
    phase: 'save',
    stepIndex,
    componentId: objectId,
    componentType: 'CustomObject',
    apiName: input.objectApiName,
    actions: [
      {
        kind: 'system-validation',
        description:
          'Salesforce performs built-in system validation (required fields, FK integrity, field-length checks) and writes the record to the database',
      },
    ],
  });
  stepIndex += 1;

  // Phase 5: after-triggers. ApexTriggers whose `events` includes a
  // `after <event>` lifecycle entry.
  const afterTriggers: Node[] = [];
  for (const firer of beforeTriggersResult.value) {
    if (skipInactiveSoeFirer(inactiveCollector, firer)) continue;
    if (triggerMatchesEvent(firer.properties['events'], input.event, 'after')) {
      const stepResult = await buildStep(
        ctx,
        firer,
        'after-triggers',
        stepIndex,
      );
      if (!stepResult.ok) {
        return err({ kind: 'internal', message: stepResult.error });
      }
      soe.push(stepResult.value);
      afterTriggers.push(firer);
      stepIndex += 1;
    }
  }

  // Phase 6: post-save-assignment. Assignment / AutoResponse rules
  // parented to the object run ahead of workflow rules. EscalationRules
  // are bundled into this phase too; in the strict SOE escalation runs
  // AFTER workflow rules, but the tool does not split the bundle — a
  // documented coarseness.
  const assignmentsResult = await fetchParentedFirers(
    ctx,
    objectId,
    ASSIGNMENT_TYPES,
  );
  if (!assignmentsResult.ok) {
    return err({ kind: 'internal', message: assignmentsResult.error });
  }
  for (const firer of assignmentsResult.value) {
    const stepResult = await buildStep(
      ctx,
      firer,
      'post-save-assignment',
      stepIndex,
    );
    if (!stepResult.ok) {
      return err({ kind: 'internal', message: stepResult.error });
    }
    soe.push(stepResult.value);
    stepIndex += 1;
  }

  // Phase 7: post-save-workflows. WorkflowRules whose `triggerType`
  // property matches the DML event.
  const workflowsResult = await fetchTriggersOnFirers(
    ctx,
    objectId,
    WORKFLOW_TYPES,
  );
  if (!workflowsResult.ok) {
    return err({ kind: 'internal', message: workflowsResult.error });
  }
  for (const firer of workflowsResult.value) {
    if (skipInactiveSoeFirer(inactiveCollector, firer)) continue;
    if (workflowMatchesEvent(firer.properties['triggerType'], input.event)) {
      const stepResult = await buildStep(
        ctx,
        firer,
        'post-save-workflows',
        stepIndex,
      );
      if (!stepResult.ok) {
        return err({ kind: 'internal', message: stepResult.error });
      }
      soe.push(stepResult.value);
      stepIndex += 1;
    }
  }

  // Phase 8: post-save-flows. Record-triggered AFTER-save Flows whose
  // `recordTriggerType` matches the DML event. After-save flows run after
  // workflow rules. Before-save flows were already emitted in Phase 0, so only
  // the after-save partition is walked here.
  //
  // Scheduled-only after-save flows (hasImmediateConnector === false and they
  // have scheduledPaths) do NOT run synchronously within the triggering
  // transaction. They are collected and emitted in post-save-async instead.
  const matchedFlows: Node[] = [];
  const scheduledOnlyAfterSaveFlows: Node[] = [];
  for (const { firer, recordTriggerType } of orderedAfterSaveFlows) {
    if (!flowMatchesEvent(recordTriggerType, input.event)) continue;
    eventFlowFirers.push(firer);
    const hasImmediateConnector = firer.properties['hasImmediateConnector'] as boolean | undefined;
    const scheduledPathTypes = firer.properties['scheduledPathTypes'] as string[] | undefined;
    const isScheduledOnly =
      hasImmediateConnector === false &&
      Array.isArray(scheduledPathTypes) &&
      scheduledPathTypes.length > 0;
    if (isScheduledOnly) {
      scheduledOnlyAfterSaveFlows.push(firer);
      continue;
    }
    const stepResult = await buildStep(
      ctx,
      firer,
      'post-save-flows',
      stepIndex,
    );
    if (!stepResult.ok) {
      return err({ kind: 'internal', message: stepResult.error });
    }
    soe.push(stepResult.value);
    matchedFlows.push(firer);
    stepIndex += 1;
  }

  // Phase 9: post-save-approval. ApprovalProcesses parented to the
  // object.
  const approvalsResult = await fetchParentedFirers(
    ctx,
    objectId,
    APPROVAL_TYPES,
  );
  if (!approvalsResult.ok) {
    return err({ kind: 'internal', message: approvalsResult.error });
  }
  for (const firer of approvalsResult.value) {
    if (skipInactiveSoeFirer(inactiveCollector, firer)) continue;
    const stepResult = await buildStep(
      ctx,
      firer,
      'post-save-approval',
      stepIndex,
    );
    if (!stepResult.ok) {
      return err({ kind: 'internal', message: stepResult.error });
    }
    soe.push(stepResult.value);
    stepIndex += 1;
  }

  // Phase 10: post-save-rollup-recalc. Parent Summary (roll-up summary)
  // CustomFields that aggregate THIS object recalculate on every DML event —
  // insert/update/delete/undelete all change the child record set a rollup
  // aggregates, unlike duplicate rules/validation which evaluate on
  // insert/update only. Found by scanning `summaryForeignKey` (R6-07; there
  // is no edge for this walk — see `soe-rollup-recalc.ts`), capped to ONE
  // level (a grandparent's own rollup is NOT walked) and does not expand the
  // parent's own automation (no re-entrancy).
  const rollupResult = await findRollupRecalcSteps(ctx, input.objectApiName);
  if (!rollupResult.ok) {
    return err({ kind: 'internal', message: rollupResult.error });
  }
  for (const rollup of rollupResult.value.steps) {
    soe.push({
      phase: 'post-save-rollup-recalc',
      stepIndex,
      componentId: rollup.fieldId,
      componentType: 'CustomField',
      apiName: rollup.apiName,
      actions: [
        {
          kind: 'recalculates',
          targetId: rollup.parentObjectId,
          description: `recalculates ${rollup.summaryOperation ?? 'unknown-operation'}(${rollup.summarizedField ?? 'record count'}) on ${rollup.parentObjectId}`,
        },
      ],
    });
    stepIndex += 1;
  }

  // Phase 11: post-save-async. Walk dispatchesAsync from every
  // ApexTrigger that fired in phase 1 / 4. Dedupes targets.
  // Also emit scheduled-only after-save Flows here: these flows have no
  // direct <connector> in <start> (hasImmediateConnector === false) so they
  // run ONLY via their scheduled/time-offset paths — not in the triggering
  // transaction. They are async by construction.
  const asyncSourceSet: Node[] = [...beforeTriggers, ...afterTriggers];
  const asyncStepsResult = await buildAsyncSteps(
    ctx,
    asyncSourceSet,
    stepIndex,
  );
  if (!asyncStepsResult.ok) {
    return err({ kind: 'internal', message: asyncStepsResult.error });
  }
  soe.push(...asyncStepsResult.value);
  let asyncFanOut = asyncStepsResult.value.length;
  stepIndex += asyncFanOut;
  for (const firer of scheduledOnlyAfterSaveFlows) {
    const stepResult = await buildStep(ctx, firer, 'post-save-async', stepIndex);
    if (!stepResult.ok) {
      return err({ kind: 'internal', message: stepResult.error });
    }
    soe.push(stepResult.value);
    asyncFanOut += 1;
    stepIndex += 1;
  }

  // APEX-RECEIVER-VERIFIED. ONE batched vault lookup answers, for every
  // field-access receiver the whole composition would emit, whether it names an
  // SObject here. Anything that does not is demoted out of `actions` with a
  // typed reason. It runs BEFORE `conditionalCount` / `phaseCounts` so every
  // downstream census counts the verified action lists, and it is a single
  // query so the pinned "query count does not scale with object fan-out" budget
  // is unchanged.
  const receiverVerification = await verifyStepActionReceivers(
    ctx.graph,
    soe as unknown as ReceiverVerifiableStep[],
  );

  // FIX 15 (3). ONE more batched query partitions every condition's
  // `fieldRefs` into grounded (citable) and ungrounded (never citable). Runs
  // over the FULL composition, before `visibleSoe`, so a `phase` filter cannot
  // change what a condition claims about itself.
  const refGroundingCensus = await groundStepConditions(
    ctx.graph,
    soe as unknown as RefGroundableStep[],
  );

  const conditionalCount = soe.filter((s) => s.conditional !== undefined).length;
  const inactiveConfigured = sortedInactiveConfigured(inactiveCollector);
  const inactiveSummary = buildInactiveSummary(
    inactiveConfigured,
    input.includeInactive === true,
    input.phase !== undefined,
  );
  // `phaseCounts` / `activeComponents` are computed from the FULL composition so
  // the summary keeps the whole phase distribution even when the caller narrows
  // `soe` with a `phase` filter.
  const phaseCounts = tallyPhaseCounts(soe);
  // The save placeholder is the only non-automation step; everything else is an
  // active org-configured component that fires.
  const activeComponents = soe.filter((s) => s.phase !== 'save').length;

  // Optional single-phase filter (recovery path for a phase truncated out of a
  // fuller view). `soe` returns only the requested phase; `summary` is unchanged
  // (still the whole composition). Un-filtered calls emit the full sequence.
  const visibleSoe: readonly SoeStep[] =
    input.phase !== undefined ? soe.filter((s) => s.phase === input.phase) : soe;

  // R6-23: informational rider — active EntitlementProcess(es) targeting
  // this object. Disclosure-PLUS-pointer only: milestone evaluation itself
  // is NOT simulated as an order-of-execution phase (see DISCLOSURE above)
  // — this just tells the caller an active process exists and where to
  // read its milestones from. `SObjectType`/`active` are read directly off
  // the EntitlementProcess node's own properties (R6-18), so the match is
  // `declared` confidence, not inferred. Fetch one past the cap to detect
  // truncation honestly rather than silently dropping the tail.
  const entitlementResult = await listNodesByType(ctx.graph, 'EntitlementProcess', {
    propertyStringEquals: { SObjectType: input.objectApiName },
    propertyEquals: { active: true },
    limit: ENTITLEMENT_PROCESS_NOTE_CAP + 1,
  });
  if (!entitlementResult.ok) {
    return err({ kind: 'internal', message: entitlementResult.error.message });
  }
  const entitlementProcessNotesTruncated =
    entitlementResult.value.length > ENTITLEMENT_PROCESS_NOTE_CAP;
  const entitlementProcessNotes: EntitlementProcessNote[] = entitlementResult.value
    .slice(0, ENTITLEMENT_PROCESS_NOTE_CAP)
    .map((node) => ({
      componentId: node.id,
      apiName: node.apiName,
      message: `entitlement process ${node.apiName} is active on this object — milestone evaluation not simulated`,
      confidence: 'declared' as const,
    }));

  const data: {
    objectApiName: string;
    appliedScope: { componentId: string; object: string };
    event: DmlEvent;
    recordTypeId: ComponentId | null;
    objectModeled: boolean;
    soe: readonly SoeStep[];
    summary: {
      totalSteps: number;
      activeComponents: number;
      conditionalSteps: number;
      asyncFanOut: number;
      phaseCounts: SoePhaseCounts;
    };
    disclosure: string;
    receiverVerification: ApexReceiverVerification;
    inactiveConfigured?: readonly InactiveConfiguredFirer[];
    inactiveSummary: SoeInactiveSummary;
    phasesOmitted?: readonly SoePhaseOmission[];
    appliedPhaseFilter?: Exclude<SoePhase, 'save'>;
    truncated?: boolean;
    entitlementProcessNotes?: readonly EntitlementProcessNote[];
    entitlementProcessNotesTruncated?: boolean;
    conceptReasoning?: ConceptReasoningEnvelope;
    conceptReasoningOmitted?: ConceptReasoningOmission;
    recoveryPath?: SoeRecoveryPath;
    withinPhaseOrder?: SoeWithinPhaseOrder;
    coverageCaveat?: typeof TRIGGER_ORDER_NOT_EXTRACTED_CAVEAT;
  } = {
    objectApiName: input.objectApiName,
    appliedScope,
    event: input.event,
    recordTypeId: input.recordTypeId ?? null,
    objectModeled,
    // FIX 3 (1)+(2). `inactiveHeadline` is GONE: it was
    // `inactiveConfigured.map(apiName).join(', ')` — the same names the array
    // already carried, restated as prose, for ~11% of the budget and zero new
    // information. The roster itself is now opt-in; the COUNT is always here.
    ...(inactiveSummary.included ? { inactiveConfigured } : {}),
    inactiveSummary,
    ...(input.phase !== undefined ? { appliedPhaseFilter: input.phase } : {}),
    ...(entitlementProcessNotes.length > 0 ? { entitlementProcessNotes } : {}),
    ...(entitlementProcessNotesTruncated ? { entitlementProcessNotesTruncated } : {}),
    summary: {
      totalSteps: soe.length,
      activeComponents,
      conditionalSteps: conditionalCount,
      asyncFanOut,
      phaseCounts,
    },
    soe: visibleSoe,
    receiverVerification,
    // The verification axis rides `disclosure` because this tool has no
    // `boundaries[]`. Always appended: a zero census must read as CHECKED, and
    // a failed probe must read as NOT CHECKED. Attached BEFORE the byte-budget
    // pass so its bytes are measured, never re-inflating the payload after.
    disclosure: `${composeSoeDisclosure(DISCLOSURE, objectModeled)}${soeReceiverVerificationNote(receiverVerification)}`,
  };

  // The org-wide Summary-field scan behind post-save-rollup-recalc hit the
  // shared node-scan cap — the rollup list above may be INCOMPLETE. Disclose
  // it rather than imply every aggregating parent was found.
  if (rollupResult.value.scanTruncated) {
    data.disclosure = `${data.disclosure} ${rollupScanTruncationNote()}`;
  }

  // FIX 15 (3). An ungrounded ref must never be presented as a component id,
  // and a grounding probe that FAILED must never read as a clean partition.
  if (!refGroundingCensus.checked) {
    data.disclosure = `${data.disclosure} ${soeRefGroundingNotCheckedNote(refGroundingCensus.reason ?? 'reason not reported')}`;
  } else if (refGroundingCensus.ungrounded > 0) {
    data.disclosure = `${data.disclosure} ${refGroundingCensus.ungrounded} condition field reference(s) across this composition are listed under \`conditional.ungroundedRefs\`. ${SOE_UNGROUNDED_REFS_NOTE}`;
  }

  // Snapshot the grounding counts before the byte pass: its conditional trim
  // rebuilds a heavy condition from three keys and would otherwise drop them,
  // leaving an emitted `fieldRefs: []` unreadable.
  // FLOW-ORDER-IS-ALPHABETICAL. Emitted ONLY when at least one phase holds two
  // or more steps — the only shape in which the consecutive `stepIndex` values
  // could be read as a run order. Computed from the FULL pre-truncation
  // `phaseCounts` (ambiguity is a fact about the org, not about what survived
  // the byte budget) and attached BEFORE the budget pass so its bytes are
  // measured rather than re-inflating the payload past the guard. A response
  // with at most one step per phase is byte-identical to before this existed.
  const flowTriggerOrderCensus = censusFlowTriggerOrders(eventFlowFirers);
  const withinPhaseOrder = buildWithinPhaseOrder(
    collectAmbiguousPhases(phaseCounts),
    flowTriggerOrderCensus,
  );
  if (withinPhaseOrder !== undefined) {
    data.withinPhaseOrder = withinPhaseOrder;
    // A vault built before `<Flow><triggerOrder>` was extracted has a gap a
    // refresh CAN close — so it is a coverageCaveat, not an inherent boundary.
    // Gated on the census state and NOT on `!extracted`: an object with NO
    // record-triggered flows is `not-applicable`, and asserting a vault gap
    // there fabricated a coverage claim (plus a `sfi refresh` remediation that
    // would change nothing) on a phase made of validation rules or triggers.
    if (isTriggerOrderCoverageGap(flowTriggerOrderCensus)) {
      data.coverageCaveat = TRIGGER_ORDER_NOT_EXTRACTED_CAVEAT;
    }
  }

  // On a densely-automated standard object (e.g. Contact) the per-step action
  // enumeration can push the payload past the MCP response budget. Trim the
  // heaviest steps' action tails (and, if needed, the verbose firing
  // conditions) to fit — every step STAYS, only the exhaustive edge list /
  // condition expression is capped, with an honest per-step count.
  //
  // `allowStepDrop: false` is load-bearing for the single-event view: dropping
  // trailing steps would silently un-name real firing automations (the
  // after-trigger / post-save-flow tail), defeating the whole point of the
  // tool. A single-event step list, once its actions/conditionals are slimmed,
  // is small enough that the step COUNT alone never exceeds the budget, so the
  // last-resort step-drop pass is neither needed nor allowed here.
  //
  // WHAT THIS PROMISE IS AND IS NOT. It binds THIS layer only: no firing step
  // is dropped by `enforceSoeByteBudget`. It is NOT a claim that no step can
  // be lost downstream — the GLOBAL response reducer in `tool-dispatch.ts`
  // trims the largest `data` array (which is `soe`) when a payload still
  // exceeds the envelope cap, and this handler does not control that layer.
  // `reconcileSoePhasesOmittedAfterGlobalTrim` is the backstop that re-stamps
  // `phasesOmitted` after such a trim; that re-stamp is the one thing that
  // must never be lost, because it is what stops a shortened `soe` from
  // silently contradicting `summary.phaseCounts`.
  // ANSWER FIRST, ENRICHMENT SECOND (F4).
  //
  // Concept reasoning used to be built BEFORE the byte-budget pass and its
  // measured size SUBTRACTED from the SOE budget, so an optional enrichment
  // block reserved space ahead of the answer the tool exists to give. Measured
  // on the busiest object in a real org: `soe` came back with 27 of 109 steps
  // with reasoning on and 54 of 109 with `includeConceptReasoning: false` — the
  // enrichment was paid for in STEPS, roughly halving the answer, and the
  // response disclosed the trade only in prose.
  //
  // The allocation is now the other way round. `enforceSoeByteBudget` runs
  // first against the WHOLE budget, so the steps are seated exactly as they are
  // on an `includeConceptReasoning: false` call. Whatever headroom is left over
  // is what reasoning may have, and `buildReservedConceptReasoning` is fitted to
  // THAT number rather than to a fixed ceiling. On a heavy object the headroom
  // is too small for even the block's irreducible honesty prose, and the block
  // is DROPPED — the correct outcome, said out loud in the disclosure rather
  // than paid for out of the caller's answer.
  //
  // The block is still attached only AFTER enforcement: `enforceSoeByteBudget`
  // measures `sizeOf(payload)` WHOLE, so attaching first AND subtracting its
  // size charged it twice (an earlier revision stripped 33 of 50 real objects'
  // entire action inventory on ~30 KB payloads, 10 KB UNDER budget, and then
  // disclosed a truncation its own arithmetic had invented).
  //
  // FIX 3 (3). A `phase` call is a RECOVERY call, not a reasoning call: the
  // caller is here because the full view could not hold that phase, so the
  // whole budget goes to the phase they asked for. An explicit
  // `includeConceptReasoning: true` still wins.
  const conceptReasoningOffByPhaseDefault =
    input.phase !== undefined && input.includeConceptReasoning === undefined;
  const wantConceptReasoning =
    input.includeConceptReasoning ?? input.phase === undefined;
  // R1 — TYPED ABSENCE. Every path that leaves `conceptReasoning` off the
  // payload also records WHY, in a field, not only in prose. A host that reads
  // `data` and finds neither key would otherwise be free to read the missing
  // block as "the reasoning engine found nothing", which is the one reading the
  // block exists to prevent. Set here for the opt-out paths and below for the
  // two budget paths; attached at the end, and only when `conceptReasoning`
  // itself is absent, so the two keys can never both appear.
  let conceptReasoningOmitted: ConceptReasoningOmission | undefined;
  if (!wantConceptReasoning) {
    const skipNote = conceptReasoningOffByPhaseDefault
      ? `${CONCEPT_REASONING_SKIPPED_NOTE} ${PHASE_FILTER_CONCEPT_REASONING_OFF_NOTE}`
      : CONCEPT_REASONING_SKIPPED_NOTE;
    data.disclosure = `${data.disclosure} ${skipNote}`;
    // NO `headroomBytes` / `minimumHeadroomBytes` here. The block was never
    // attempted on this path, so there is no measurement to report and a `0`
    // would read as one. `reason` carries the whole truth; the sentence is in
    // `disclosure`.
    conceptReasoningOmitted = {
      checked: false,
      reason: conceptReasoningOffByPhaseDefault
        ? 'phase-filter-default'
        : 'caller-opted-out',
    };
  }

  // RESERVE the post-enforcement additions instead of bolting them on after.
  //
  // `POST_ENFORCEMENT_DISCLOSURE_HEADROOM_BYTES` already existed and already
  // said what it was for, but it was only ever subtracted from the CONCEPT
  // REASONING allowance — the enforcement pass itself never knew about it. So
  // the pass fitted `data` to exactly `soeBudgetBytes()` and the notes,
  // `phasesOmitted` and typed-absence blocks appended afterwards pushed it back
  // over: measured on a real org, a payload fitted to 37 976 was delivered at
  // 38 763. That is inside the reducer's trigger band, where a few hundred more
  // bytes cost half the steps. `enforceSoeByteBudget` documents `budgetBytes`
  // for exactly this ("a caller that appends HONESTY scaffolding to the payload
  // AFTER enforcement passes a value BELOW soeBudgetBytes to reserve headroom"),
  // so the honesty scaffolding is now paid for out of the trim ladder — which
  // sheds ACTION tails and, under `allowStepDrop: false`, can never cost a step.
  const budget = enforceSoeByteBudget(
    data,
    [visibleSoe] as unknown as BoundableStep[][],
    {
      allowStepDrop: false,
      budgetBytes: soeBudgetBytes() - POST_ENFORCEMENT_DISCLOSURE_HEADROOM_BYTES,
    },
  );
  if (budget.truncated) {
    data.truncated = true;
    data.disclosure = `${data.disclosure} ${soeTruncationNote(budget)}`;
  }

  // The steps are seated. What is left of the budget — minus room for the
  // honesty prose still to be appended below — is the enrichment's allowance.
  let conceptReasoning: ConceptReasoningEnvelope | undefined;
  if (wantConceptReasoning) {
    const headroom =
      soeBudgetBytes() -
      Buffer.byteLength(JSON.stringify(data), 'utf8') -
      POST_ENFORCEMENT_DISCLOSURE_HEADROOM_BYTES;
    const reserved =
      headroom >= CONCEPT_REASONING_MIN_HEADROOM_BYTES
        ? await buildReservedConceptReasoning(ctx, objectId, {
            // Headroom is a CEILING, never a licence. A small object leaves
            // tens of KB free and the block's own target
            // (`CONCEPT_RESERVATION_MAX_BYTES`) still governs there — fitting
            // to the headroom alone would let a light object ship a 15 KB
            // enrichment block, which is the size problem that cap exists for.
            maxBytes: Math.min(headroom, CONCEPT_RESERVATION_MAX_BYTES),
          })
        : null;
    if (reserved !== null && reserved.reservedBytes <= headroom) {
      conceptReasoning = reserved.envelope;
    } else if (reserved === null && headroom >= CONCEPT_REASONING_MIN_HEADROOM_BYTES) {
      // R3 — a MISSING block must never be silent. `null` covers both a
      // component that did not resolve and a graph read that failed, so the
      // note attributes neither.
      const note = CONCEPT_REASONING_UNAVAILABLE_NOTE(objectId);
      data.disclosure = `${data.disclosure} ${note}`;
      conceptReasoningOmitted = {
        checked: false,
        reason: 'build-unavailable',
        headroomBytes: Math.max(0, headroom),
        minimumHeadroomBytes: CONCEPT_REASONING_MIN_HEADROOM_BYTES,
      };
    } else {
      // Built but too big for what the steps left, or never attempted because
      // the headroom was already below the floor. Same outcome, same sentence.
      const note = CONCEPT_REASONING_NO_HEADROOM_NOTE(Math.max(0, headroom));
      data.disclosure = `${data.disclosure} ${note}`;
      conceptReasoningOmitted = {
        checked: false,
        reason: 'no-budget-headroom',
        headroomBytes: Math.max(0, headroom),
        minimumHeadroomBytes: CONCEPT_REASONING_MIN_HEADROOM_BYTES,
      };
    }
  }

  // Honesty invariant (WHAT-HAPPENS-ON-SAVE-TRUNCATION-DROPS-LATER-PHASES):
  // `soe` must fully represent every phase `phaseCounts` claims.
  // `allowStepDrop: false` above guarantees this at THIS layer, but the delta
  // is computed anyway so a truncated payload can never SILENTLY contradict
  // `phaseCounts` — any shortfall is named in `phasesOmitted`.
  //
  // FIX 3 (4). This runs on a phase-filtered call TOO. A phase filter narrows
  // WHICH phase is returned; it never authorises returning a PARTIAL phase
  // silently. This is the recovery path the full view points at, so a
  // shortfall here is the last place a caller can find out. What changes under
  // a filter is the COMPARISON, not whether it happens: the other phases are
  // absent on purpose and are not omissions, so only the requested phase's
  // declared-vs-present is checked.
  if (input.phase === undefined) {
    const phasesOmitted = computePhasesOmitted(phaseCounts, data.soe);
    if (phasesOmitted.length > 0) {
      data.phasesOmitted = phasesOmitted;
      data.disclosure = `${data.disclosure} ${crossPhaseShortfallNote(phasesOmitted)}`;
    }
  } else {
    // `data.soe` is `visibleSoe` here — every step already carries
    // `phase === input.phase` — so `computePhasesOmitted`'s own tally against
    // ONLY that phase is exactly the single-phase comparison this used to do
    // with a second, hand-rolled copy of the same rule
    // (WHAT-HAPPENS-ON-SAVE-TRUNCATION-DROPS-LATER-PHASES).
    const [omission] = computePhasesOmitted(phaseCounts, data.soe, input.phase);
    if (omission !== undefined) {
      data.phasesOmitted = [omission];
      data.truncated = true;
      data.disclosure = `${data.disclosure} ${filteredPhaseShortfallNote(omission)}`;
    }
  }

  // Attach LAST — after every budget/trim pass has measured `data` without it.
  if (conceptReasoning !== undefined) {
    data.conceptReasoning = conceptReasoning;
  } else if (conceptReasoningOmitted !== undefined) {
    // Mutually exclusive by construction: the omission marker exists only on
    // the paths that produced no envelope, and this branch is the only writer.
    data.conceptReasoningOmitted = conceptReasoningOmitted;
  }

  // RECOVERY PATH — measured LAST, gated on the cap the GLOBAL REDUCER actually
  // uses, and emitted ONLY where the tool's own exits are spent.
  //
  // Two measured mistakes are designed out here.
  //
  // (1) The gate used to be `soeBudgetBytes()` (37 976). That is the TOOL-LOCAL
  // cap, derived to sit `TOOL_LOCAL_BUDGET_MARGIN_BYTES` BELOW what the reducer
  // trims to — so a payload inside that margin was over the tool's cap and
  // still perfectly deliverable. The block fired on it anyway and its own bytes
  // then pushed the envelope past the reducer's trigger. Because the reducer
  // HALVES (`keep = max(10, floor(len/2))` in `tool-dispatch.ts`), that cost
  // 50% of the steps: measured through the full pipeline on a real org, a
  // 60-step answer that had been delivered COMPLETE came back with 30, losing
  // every duplicate rule, every after-trigger and all eight post-save flows. A
  // warning that manufactures the truncation it warns about is worse than no
  // warning. The gate is now the SHARED `responseReductionCap()`, measured on
  // `data` WITH everything else attached and WITHOUT this block, so a payload
  // that fits is byte-identical to one built without this code path.
  //
  // (2) It fired on unfiltered answers too, where the same halving turned 54
  // delivered steps into 27 — to repeat advice the response already had. An
  // unfiltered over-budget answer carries `crossPhaseShortfallNote`'s "re-query
  // with the `phase` filter", which is TRUE and names a knob this tool has. The
  // dead end is one step later, on the phase-filtered answer, whose shared tail
  // recommends limit/offset/includeConceptReasoning — all refused or already in
  // force. So the block goes there, where it is both needed and affordable.
  // See {@link SoeRecoveryPath}.
  const composedPayloadBytes = Buffer.byteLength(JSON.stringify(data), 'utf8');
  const reducerCapBytes = responseReductionCap();
  if (input.phase !== undefined && composedPayloadBytes > reducerCapBytes) {
    const enumeration = buildPhaseEnumeration(objectId, input.phase);
    const recoveryPath: SoeRecoveryPath = {
      resumable: false,
      reason: 'over-budget-and-tool-accepts-no-paging-arguments',
      composedPayloadBytes,
      reducerCapBytes,
      // The SAME tuple that drives the `.strict()` refusal, so the refusal and
      // this list cannot disagree. It is hand-maintained rather than read off
      // the Zod shape, which is why `accepted arguments track the input schema`
      // pins the two together — a comment would not have.
      acceptedArguments: [...WHAT_HAPPENS_ON_SAVE_ACCEPTED_KEYS],
      narrowestScope: 'phase',
      narrowestScopeApplied: true,
      enumerateWith: enumeration.calls,
      ...(enumeration.reason !== undefined
        ? { unenumerableReason: enumeration.reason }
        : {}),
    };
    data.recoveryPath = recoveryPath;
    // The prose is DERIVED from the block, so the sentence a host reads aloud
    // and the field a machine reads can never state two different things, and
    // it names no key this response did not populate. It lives in `disclosure`
    // only — a second copy inside `data` would cost this already-over-budget
    // payload more steps to say it twice.
    data.disclosure = `${data.disclosure} ${recoveryPathNote(recoveryPath)}`;
  }

  return ok({
    data,
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
