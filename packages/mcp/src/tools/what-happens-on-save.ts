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
 *   3. **save** — the database write itself (a documented placeholder
 *      step the platform performs; no SfIntelligence node represents it).
 *   4. **after-triggers** — ApexTriggers whose `events` property
 *      contains a matching `after <event>` lifecycle event. These run
 *      after the record is written but ahead of the post-save automation.
 *   5. **post-save-assignment** — Lead/Case AssignmentRules,
 *      AutoResponseRules, and EscalationRules parented to the target
 *      object (`parentOf` from CustomObject to firer). Assignment and
 *      auto-response rules run ahead of workflow rules. Each rule's
 *      ConditionalContext is surfaced.
 *   6. **post-save-workflows** — WorkflowRules whose `triggersOn` edge
 *      points at the target object AND whose `triggerType` matches the
 *      DML event (workflows only fire on insert/update). Each rule's
 *      `firesWhen` ConditionalContext is surfaced alongside the rule.
 *   7. **post-save-flows** — record-triggered (after-save) Flows whose
 *      `triggersOn` edge points at the target object AND whose
 *      `recordTriggerType` matches the DML event. After-save flows run
 *      after workflow rules.
 *   8. **post-save-approval** — ApprovalProcesses parented to the
 *      target object (`parentOf` from CustomObject) with their entry
 *      criteria ConditionalContext.
 *   9. **post-save-async** — ApexClasses called via the
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
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  isUnresolvedApexCallTarget,
  isUnresolvedFieldReceiver,
} from './apex-receiver.js';
import {
  type InactiveConfiguredFirer,
  skipInactiveSoeFirer,
  sortedInactiveConfigured,
} from './soe-active.js';
import {
  composeSoeDisclosure,
  evaluateSoeAdmission,
  soeNotAdmittedMessage,
} from './soe-admission.js';
import {
  type BoundableStep,
  enforceSoeByteBudget,
  soeTruncationNote,
} from './soe-payload-bounds.js';

/**
 * The verbatim honesty-axis disclosure surfaced in every response.
 * Frozen here so the test suite can assert the exact string and so a
 * caller-facing rephrasing during rendering is a code-review concern,
 * not a silent drift.
 */
const DISCLOSURE =
  "v2.0e composes the documented Salesforce order-of-execution instantiated against THIS org's extracted automation. Before-save record-triggered flows are modeled as the leading `before-save-flows` phase (they run BEFORE before-triggers). Conditions ARE listed but NOT EVALUATED — the tool does not know whether this particular record satisfies them at runtime. Workflow field updates can re-fire before/after-update triggers (a second pass); this composition lists each automation once and does not expand that re-entrancy. A workflow rule's time-dependent actions (its workflowTimeTriggers) are SCHEDULED for an offset measured from a record field value the offline vault cannot evaluate; this composition lists the rule once in the synchronous post-save-workflows phase and does NOT claim its time-delayed actions fire at save. Manual sharing, sharing sets, account teams, and Apex callouts after save are out of scope.";

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
 *   - `objectApiName`: required, non-empty. The CustomObject API name
 *     (e.g., `'Account'`, `'Opportunity__c'`). Unknown objects surface
 *     as `component-not-found`.
 *   - `event`: required, one of the five DML events. Trigger-style
 *     phrasings ("after update", "before insert") and any casing are
 *     accepted — the timing prefix is stripped to the bare DML event.
 *   - `recordTypeId`: optional. Carried through to the response
 *     verbatim; v2.0e does NOT narrow automation by record type
 *     (deferred to v2.0e.1).
 */
export const whatHappensOnSaveInputSchema = z.object({
  objectApiName: z.string().min(1),
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
});

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
  readonly fieldRefs: readonly ComponentId[];
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
 * Which phase of the documented Salesforce order of execution a step
 * comes from. The order matches the platform's evaluation sequence
 * (per the vendored SOE docs); the `save` phase is a placeholder
 * representing the database write itself.
 */
export type SoePhase =
  | 'before-save-flows'
  | 'pre-save-triggers'
  | 'pre-save-validation'
  | 'save'
  | 'after-triggers'
  | 'post-save-assignment'
  | 'post-save-workflows'
  | 'post-save-flows'
  | 'post-save-approval'
  | 'post-save-async';

/**
 * One step in the SOE chain. `stepIndex` is the 0-based position
 * across all phases (preserved across the response so callers can
 * cross-reference); `componentId` / `componentType` / `apiName`
 * identify the firer; `conditional` references the ConditionalContext
 * gate when one exists; `actions` lists what the step will do at
 * runtime.
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
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface WhatHappensOnSaveOutput {
  readonly objectApiName: string;
  readonly event: DmlEvent;
  readonly recordTypeId: ComponentId | null;
  readonly objectModeled: boolean;
  readonly soe: readonly SoeStep[];
  readonly summary: {
    readonly totalSteps: number;
    readonly conditionalSteps: number;
    readonly asyncFanOut: number;
  };
  readonly disclosure: string;
  /**
   * Automation configured on this object but inactive (Draft/Obsolete Flow,
   * active:false rule/process). Omitted when empty.
   */
  readonly inactiveConfigured?: readonly InactiveConfiguredFirer[];
  /**
   * True when per-step action lists were trimmed to fit the MCP response
   * budget. Every step is still present and in order — only the heaviest
   * steps' action edges were capped (see each step's `actionsOmitted`).
   * Absent when the full response fit.
   */
  readonly truncated?: boolean;
}

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
 */
const flowMatchesEvent = (
  recordTriggerType: unknown,
  event: DmlEvent,
): boolean => {
  if (typeof recordTriggerType !== 'string') return false;
  if (event === 'undelete') return false;
  if (event === 'delete') return recordTriggerType === 'Delete';
  if (event === 'upsert') {
    return (
      recordTriggerType === 'Create' ||
      recordTriggerType === 'Update' ||
      recordTriggerType === 'CreateAndUpdate'
    );
  }
  if (event === 'insert') {
    return recordTriggerType === 'Create' || recordTriggerType === 'CreateAndUpdate';
  }
  // event === 'update'
  return recordTriggerType === 'Update' || recordTriggerType === 'CreateAndUpdate';
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
    // Drop heuristic apex-scanner edges to UNRESOLVED receivers — a `readsFrom`/
    // `writesTo` to an Apex `this`/local-var field (`CustomField:this.x`,
    // `CustomField:acc.y`) or a `callsApex`/`dispatchesAsync` to a local-var
    // "class" (`ApexClass:acc`/`oldMap`) is a parse artifact, not a real save-time
    // action. (Same segregation explain_apex_method makes; conservative — real
    // standard/custom/namespaced receivers are kept.)
    if (
      (edge.edgeType === 'readsFrom' || edge.edgeType === 'writesTo') &&
      isUnresolvedFieldReceiver(edge.toId)
    ) {
      continue;
    }
    if (
      (edge.edgeType === 'callsApex' || edge.edgeType === 'dispatchesAsync') &&
      isUnresolvedApexCallTarget(edge.toId)
    ) {
      continue;
    }
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
  const firers: Node[] = [];
  for (const edge of edgesResult.value) {
    const nodeResult = await getNodeById(ctx.graph, edge.toId);
    if (!nodeResult.ok) return err(nodeResult.error.message);
    if (nodeResult.value === null) continue;
    if (!allowedTypes.has(nodeResult.value.type)) continue;
    firers.push(nodeResult.value);
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
  const firers: Node[] = [];
  for (const edge of edgesResult.value) {
    const nodeResult = await getNodeById(ctx.graph, edge.fromId);
    if (!nodeResult.ok) return err(nodeResult.error.message);
    if (nodeResult.value === null) continue;
    if (!allowedTypes.has(nodeResult.value.type)) continue;
    firers.push(nodeResult.value);
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
  const seenIds = new Set<ComponentId>();
  const seenJobs: Node[] = [];
  for (const source of sources) {
    const edgesResult = await listEdges(ctx.graph, source.id, {
      direction: 'out',
      edgeType: 'dispatchesAsync',
    });
    if (!edgesResult.ok) return err(edgesResult.error.message);
    for (const edge of edgesResult.value) {
      if (seenIds.has(edge.toId)) continue;
      const nodeResult = await getNodeById(ctx.graph, edge.toId);
      if (!nodeResult.ok) return err(nodeResult.error.message);
      if (nodeResult.value === null) continue;
      seenIds.add(edge.toId);
      seenJobs.push(nodeResult.value);
    }
  }
  const sorted = [...seenJobs].sort((a, b) =>
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
  input: WhatHappensOnSaveInput,
): Promise<Result<McpResponse<WhatHappensOnSaveOutput>, McpError>> => {
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
  for (const firer of allFlowsResult.value) {
    if (skipInactiveSoeFirer(inactiveCollector, firer)) continue;
    const flowEdgesResult = await listEdges(ctx.graph, firer.id, {
      direction: 'out',
      edgeType: 'triggersOn',
    });
    if (!flowEdgesResult.ok) {
      return err({ kind: 'internal', message: flowEdgesResult.error.message });
    }
    const edgeToObject = flowEdgesResult.value.find((e) => e.toId === objectId);
    if (edgeToObject === undefined) continue;
    const entry = { firer, recordTriggerType: edgeToObject.properties['recordTriggerType'] };
    if (edgeToObject.properties['triggerType'] === 'RecordBeforeSave') beforeSaveFlows.push(entry);
    else afterSaveFlows.push(entry);
  }
  for (const { firer, recordTriggerType } of beforeSaveFlows) {
    if (!flowMatchesEvent(recordTriggerType, input.event)) continue;
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

  // Phase 3: save. A documented placeholder; the platform's
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

  // Phase 4: after-triggers. ApexTriggers whose `events` includes a
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

  // Phase 5: post-save-assignment. Assignment / AutoResponse rules
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

  // Phase 6: post-save-workflows. WorkflowRules whose `triggerType`
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

  // Phase 7: post-save-flows. Record-triggered AFTER-save Flows whose
  // `recordTriggerType` matches the DML event. After-save flows run after
  // workflow rules. Before-save flows were already emitted in Phase 0, so only
  // the after-save partition is walked here.
  const matchedFlows: Node[] = [];
  for (const { firer, recordTriggerType } of afterSaveFlows) {
    if (!flowMatchesEvent(recordTriggerType, input.event)) continue;
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

  // Phase 8: post-save-approval. ApprovalProcesses parented to the
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

  // Phase 9: post-save-async. Walk dispatchesAsync from every
  // ApexTrigger that fired in phase 1 / 4. Dedupes targets.
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
  const asyncFanOut = asyncStepsResult.value.length;
  stepIndex += asyncFanOut;

  const conditionalCount = soe.filter((s) => s.conditional !== undefined).length;
  const inactiveConfigured = sortedInactiveConfigured(inactiveCollector);

  const data: {
    objectApiName: string;
    event: DmlEvent;
    recordTypeId: ComponentId | null;
    objectModeled: boolean;
    soe: readonly SoeStep[];
    summary: {
      totalSteps: number;
      conditionalSteps: number;
      asyncFanOut: number;
    };
    disclosure: string;
    inactiveConfigured?: readonly InactiveConfiguredFirer[];
    truncated?: boolean;
  } = {
    objectApiName: input.objectApiName,
    event: input.event,
    recordTypeId: input.recordTypeId ?? null,
    objectModeled,
    soe,
    summary: {
      totalSteps: soe.length,
      conditionalSteps: conditionalCount,
      asyncFanOut,
    },
    disclosure: composeSoeDisclosure(DISCLOSURE, objectModeled),
    ...(inactiveConfigured.length > 0 ? { inactiveConfigured } : {}),
  };

  // On a densely-automated standard object (e.g. Contact) the per-step action
  // enumeration can push the payload past the MCP response budget. Trim the
  // heaviest steps' action tails to fit — every step stays, only the
  // exhaustive edge list is capped, with an honest per-step count.
  const budget = enforceSoeByteBudget(data, [soe] as unknown as BoundableStep[][]);
  if (budget.truncated) {
    data.truncated = true;
    data.disclosure = `${data.disclosure} ${soeTruncationNote(budget)}`;
  }

  return ok({
    data,
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
