/**
 * Handler for the `sfi.order_of_execution` MCP tool.
 *
 * v2.0e W1 — the order-of-execution overview headline. Sibling of
 * `sfi.what_happens_on_save` without the event filter: emits the
 * generic SOE structure with every potential automation for the
 * target object across every event type. Lets callers render the
 * full lifecycle map and let the user pick which event slice to
 * focus on.
 *
 * The shape per event type mirrors `sfi.what_happens_on_save`
 * exactly, but the response carries one phase block per supported
 * event (insert, update, delete, undelete; upsert is excluded
 * because it composes from insert + update on the client side).
 *
 * Output is a per-event nested tree:
 *
 *   {
 *     objectApiName: 'Account',
 *     byEvent: {
 *       insert: { soe: [...], summary: {...} },
 *       update: { soe: [...], summary: {...} },
 *       delete: { soe: [...], summary: {...} },
 *       undelete: { soe: [...], summary: {...} },
 *     },
 *     disclosure: '...',
 *   }
 *
 * Internally, this handler re-uses the same composition primitives
 * as `what_happens_on_save` (the SOE phase walker, the
 * ConditionalContext surfacer, the action builder) but invokes them
 * once per DML event. The four per-event runs are entirely
 * independent — the underlying graph state is stable across the
 * runs, so the responses do not interact.
 *
 * **Honesty axis**: the per-event `soe` array carries the same
 * heuristic-not-evaluated boundary as `what_happens_on_save`. The
 * `disclosure` field is the same verbatim string; callers should
 * surface it once per response rather than per event.
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
 * Identical to the `what_happens_on_save` disclosure — frozen here
 * so a caller-facing rephrasing during rendering is a code-review
 * concern, not a silent drift.
 */
const DISCLOSURE =
  "v2.0e composes the documented Salesforce order-of-execution instantiated against THIS org's extracted automation. Before-save record-triggered flows are modeled as the leading `before-save-flows` phase (they run BEFORE before-triggers). Conditions ARE listed but NOT EVALUATED — the tool does not know whether this particular record satisfies them at runtime. Workflow field updates can re-fire before/after-update triggers (a second pass); this composition lists each automation once and does not expand that re-entrancy. A workflow rule's time-dependent actions (its workflowTimeTriggers) are SCHEDULED for an offset measured from a record field value the offline vault cannot evaluate; this composition lists the rule once in the synchronous post-save-workflows phase and does NOT claim its time-delayed actions fire at save. Manual sharing, sharing sets, account teams, and Apex callouts after save are out of scope.";

/**
 * The four DML events the generic SOE diagram surfaces. `upsert` is
 * deliberately excluded — it composes from insert + update on the
 * client side, and surfacing it as a fifth bucket would just
 * duplicate the union without adding information.
 */
const SOE_EVENTS = ['insert', 'update', 'delete', 'undelete'] as const;
type SoeEvent = (typeof SOE_EVENTS)[number];

/** Same SoePhase union as `what_happens_on_save`. */
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
 * The automation phases (every {@link SoePhase} except the `save`
 * placeholder), frozen in documented SOE order. Mirrors the
 * what_happens_on_save list so the two save-order views agree on which
 * phases are counted as org automation.
 */
const AUTOMATION_PHASES: readonly Exclude<SoePhase, 'save'>[] = [
  'before-save-flows',
  'pre-save-triggers',
  'pre-save-validation',
  'after-triggers',
  'post-save-assignment',
  'post-save-workflows',
  'post-save-flows',
  'post-save-approval',
  'post-save-async',
];

/**
 * Grounded per-phase active-component counts. Same shape and semantics
 * as the what_happens_on_save `SoePhaseCounts` — one count per
 * automation phase (the `save` placeholder excluded), so the count of
 * triggers / record-triggered flows / workflow rules per event is
 * answerable directly from the per-event summary.
 */
export type SoePhaseCounts = Readonly<
  Record<Exclude<SoePhase, 'save'>, number>
>;

/**
 * Tally the active components emitted into each automation phase for one
 * event's composed SOE. The `save` placeholder is never counted; every
 * phase is present (zero when empty) for a stable, indexable map.
 */
const tallyPhaseCounts = (
  soe: readonly { readonly phase: SoePhase }[],
): SoePhaseCounts => {
  const counts = Object.fromEntries(
    AUTOMATION_PHASES.map((p) => [p, 0]),
  ) as Record<Exclude<SoePhase, 'save'>, number>;
  for (const step of soe) {
    if (step.phase === 'save') continue;
    counts[step.phase] += 1;
  }
  return counts;
};

/** Same SoeStepCondition shape as `what_happens_on_save`. */
export interface SoeStepCondition {
  readonly conditionContextId: ComponentId;
  readonly expression: string;
  readonly fieldRefs: readonly ComponentId[];
}

/** Same SoeStepAction shape as `what_happens_on_save`. */
export interface SoeStepAction {
  readonly kind: string;
  readonly targetId?: ComponentId;
  readonly description: string;
}

/** Same SoeStep shape as `what_happens_on_save`. */
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
   * firers. Mirrors the what_happens_on_save SoeStep so the two save-order
   * views agree on what a validation rule actually does.
   */
  readonly errorMessage?: string;
  readonly errorDisplayField?: string | null;
}

/** One per-event entry inside the response's `byEvent` map. */
export interface SoePerEvent {
  readonly soe: readonly SoeStep[];
  readonly summary: {
    readonly totalSteps: number;
    /**
     * Count of ACTIVE org-configured automation components that fire on
     * this event — `totalSteps` minus the one `save` placeholder. The
     * grounded answer to "how many distinct automation components fire on
     * this event", per event.
     */
    readonly activeComponents: number;
    readonly conditionalSteps: number;
    readonly asyncFanOut: number;
    /**
     * Per-phase active-component counts for this event, in documented SOE
     * order. Lets a caller answer the count/ordering question (triggers vs
     * record-triggered flows vs workflow rules) directly per event.
     * Inactive automation is excluded — it is in `inactiveConfigured`.
     */
    readonly phaseCounts: SoePhaseCounts;
  };
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface OrderOfExecutionOutput {
  readonly objectApiName: string;
  readonly objectModeled: boolean;
  readonly byEvent: Readonly<Record<SoeEvent, SoePerEvent>>;
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
 * Zod schema for the `sfi.order_of_execution` tool input.
 *
 *   - `objectApiName`: required, non-empty. The CustomObject API
 *     name. Unknown objects surface as `component-not-found`.
 */
export const orderOfExecutionInputSchema = z.object({
  objectApiName: z.string().min(1),
});

/** Parsed input shape, inferred from `orderOfExecutionInputSchema`. */
export type OrderOfExecutionInput = z.infer<typeof orderOfExecutionInputSchema>;

// ---------------------------------------------------------------------------
// Re-used composition primitives.
//
// These match the helpers in `what-happens-on-save.ts` byte-for-byte.
// Duplicating them here keeps the tool-module boundary clean (the
// what_happens_on_save module is not a public API surface to other
// tools), and the duplication is small — two ~30-line helpers plus
// the per-phase fetchers. If the helpers ever grow, factoring them
// into a shared `soe-composition.ts` helper module is the next step;
// for v2.0e the per-module duplication is the simpler shape.
// ---------------------------------------------------------------------------

const workflowMatchesEvent = (
  triggerType: unknown,
  event: SoeEvent,
): boolean => {
  if (typeof triggerType !== 'string') return false;
  if (event === 'delete' || event === 'undelete') return false;
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

const flowMatchesEvent = (
  recordTriggerType: unknown,
  event: SoeEvent,
): boolean => {
  if (typeof recordTriggerType !== 'string') return false;
  if (event === 'undelete') return false;
  if (event === 'delete') return recordTriggerType === 'Delete';
  if (event === 'insert') {
    return recordTriggerType === 'Create' || recordTriggerType === 'CreateAndUpdate';
  }
  // event === 'update'
  return recordTriggerType === 'Update' || recordTriggerType === 'CreateAndUpdate';
};

const triggerMatchesEvent = (
  events: unknown,
  event: SoeEvent,
  timing: 'before' | 'after',
): boolean => {
  if (!Array.isArray(events)) return false;
  for (const e of events) {
    if (typeof e !== 'string') continue;
    if (!e.startsWith(`${timing} `)) continue;
    const action = e.slice(timing.length + 1);
    if (action === event) return true;
  }
  return false;
};

const surfaceFirstCondition = async (
  ctx: Context,
  firerId: ComponentId,
): Promise<Result<SoeStepCondition | undefined, string>> => {
  const edgesResult = await listEdges(ctx.graph, firerId, {
    direction: 'out',
    edgeType: 'firesWhen',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  const firstEdge = edgesResult.value[0];
  if (firstEdge === undefined) return ok(undefined);
  const conditionNodeResult = await getNodeById(ctx.graph, firstEdge.toId);
  if (!conditionNodeResult.ok) return err(conditionNodeResult.error.message);
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

const buildActions = async (
  ctx: Context,
  firerId: ComponentId,
): Promise<Result<readonly SoeStepAction[], string>> => {
  const edgesResult = await listEdges(ctx.graph, firerId, {
    direction: 'out',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  const actions: SoeStepAction[] = [];
  for (const edge of edgesResult.value) {
    if (
      edge.edgeType === 'parentOf' ||
      edge.edgeType === 'triggersOn' ||
      edge.edgeType === 'firesWhen'
    ) {
      continue;
    }
    // Drop heuristic apex-scanner edges to UNRESOLVED receivers (Apex
    // `this`/local-var field accesses, local-var "class" call targets) — parse
    // artifacts, not real save-time actions. Mirrors what_happens_on_save /
    // explain_apex_method; conservative (real receivers kept).
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
    // BLOCKS the save; surface it (and the field it lands on) — same axis as the
    // what_happens_on_save SoeStep. Omitted for non-VR firers. errorMessage is
    // required by the VR extractor; errorDisplayField is null for a page-level
    // (non-field) error.
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
  return ok([...firers].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
};

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

const ASSIGNMENT_TYPES: ReadonlySet<ComponentType> = new Set([
  'AssignmentRule',
  'AutoResponseRule',
  'EscalationRule',
]);
const APPROVAL_TYPES: ReadonlySet<ComponentType> = new Set(['ApprovalProcess']);
const VALIDATION_TYPES: ReadonlySet<ComponentType> = new Set(['ValidationRule']);
const FLOW_TYPES: ReadonlySet<ComponentType> = new Set(['Flow']);
const TRIGGER_TYPES: ReadonlySet<ComponentType> = new Set(['ApexTrigger']);
const WORKFLOW_TYPES: ReadonlySet<ComponentType> = new Set(['WorkflowRule']);

/**
 * Run the SOE composition for one specific DML event. Returns the
 * per-event payload (steps + summary). Mirrors the per-phase walker
 * in `what_happens_on_save` exactly — see its module JSDoc for the
 * detailed cascade.
 */
const composeForEvent = async (
  ctx: Context,
  objectId: ComponentId,
  objectApiName: string,
  event: SoeEvent,
  inactiveCollector: Map<ComponentId, InactiveConfiguredFirer>,
): Promise<Result<SoePerEvent, string>> => {
  const soe: SoeStep[] = [];
  let stepIndex = 0;

  // before-save-flows. Before-save record-triggered Flows (Spring '22) run
  // BEFORE before-triggers — the FIRST automation in the modern order of
  // execution. They fire only on insert/update (RecordBeforeSave). The
  // before/after-save discriminator lives on the `triggersOn` EDGE
  // (`properties.triggerType`), alongside `recordTriggerType`. Fetch the Flow
  // set once and partition by that edge so the post-save block reuses it.
  const allFlowsResult = await fetchTriggersOnFirers(ctx, objectId, FLOW_TYPES);
  if (!allFlowsResult.ok) return err(allFlowsResult.error);
  const beforeSaveFlows: Array<{ firer: Node; recordTriggerType: unknown }> = [];
  const afterSaveFlows: Array<{ firer: Node; recordTriggerType: unknown }> = [];
  for (const firer of allFlowsResult.value) {
    if (skipInactiveSoeFirer(inactiveCollector, firer)) continue;
    const flowEdgesResult = await listEdges(ctx.graph, firer.id, {
      direction: 'out',
      edgeType: 'triggersOn',
    });
    if (!flowEdgesResult.ok) return err(flowEdgesResult.error.message);
    const edgeToObject = flowEdgesResult.value.find((e) => e.toId === objectId);
    if (edgeToObject === undefined) continue;
    const entry = { firer, recordTriggerType: edgeToObject.properties['recordTriggerType'] };
    if (edgeToObject.properties['triggerType'] === 'RecordBeforeSave') beforeSaveFlows.push(entry);
    else afterSaveFlows.push(entry);
  }
  for (const { firer, recordTriggerType } of beforeSaveFlows) {
    if (!flowMatchesEvent(recordTriggerType, event)) continue;
    const stepResult = await buildStep(ctx, firer, 'before-save-flows', stepIndex);
    if (!stepResult.ok) return err(stepResult.error);
    soe.push(stepResult.value);
    stepIndex += 1;
  }

  // pre-save-triggers. Before triggers run after before-save flows but
  // ahead of custom validation rules in the documented order of execution.
  // The trigger set is fetched once here and re-filtered for the
  // after-triggers phase below.
  const triggersResult = await fetchTriggersOnFirers(
    ctx,
    objectId,
    TRIGGER_TYPES,
  );
  if (!triggersResult.ok) return err(triggersResult.error);
  const beforeTriggers: Node[] = [];
  for (const firer of triggersResult.value) {
    if (skipInactiveSoeFirer(inactiveCollector, firer)) continue;
    if (triggerMatchesEvent(firer.properties['events'], event, 'before')) {
      const stepResult = await buildStep(
        ctx,
        firer,
        'pre-save-triggers',
        stepIndex,
      );
      if (!stepResult.ok) return err(stepResult.error);
      soe.push(stepResult.value);
      beforeTriggers.push(firer);
      stepIndex += 1;
    }
  }

  // pre-save-validation. Custom validation rules run AFTER before
  // triggers. ValidationRules don't fire on delete/undelete.
  if (event === 'insert' || event === 'update') {
    const validationsResult = await fetchParentedFirers(
      ctx,
      objectId,
      VALIDATION_TYPES,
    );
    if (!validationsResult.ok) return err(validationsResult.error);
    for (const firer of validationsResult.value) {
      if (skipInactiveSoeFirer(inactiveCollector, firer)) continue;
      const stepResult = await buildStep(
        ctx,
        firer,
        'pre-save-validation',
        stepIndex,
      );
      if (!stepResult.ok) return err(stepResult.error);
      soe.push(stepResult.value);
      stepIndex += 1;
    }
  }

  // save placeholder.
  soe.push({
    phase: 'save',
    stepIndex,
    componentId: objectId,
    componentType: 'CustomObject',
    apiName: objectApiName,
    actions: [
      {
        kind: 'system-validation',
        description:
          'Salesforce performs built-in system validation (required fields, FK integrity, field-length checks) and writes the record to the database',
      },
    ],
  });
  stepIndex += 1;

  // after-triggers.
  const afterTriggers: Node[] = [];
  for (const firer of triggersResult.value) {
    if (skipInactiveSoeFirer(inactiveCollector, firer)) continue;
    if (triggerMatchesEvent(firer.properties['events'], event, 'after')) {
      const stepResult = await buildStep(
        ctx,
        firer,
        'after-triggers',
        stepIndex,
      );
      if (!stepResult.ok) return err(stepResult.error);
      soe.push(stepResult.value);
      afterTriggers.push(firer);
      stepIndex += 1;
    }
  }

  // post-save-assignment. Assignment / auto-response rules run immediately
  // after the after-triggers, ahead of workflow rules. EscalationRules are
  // bundled into this phase too; in the strict SOE escalation runs AFTER
  // workflow rules, but the tool does not split the bundle — a documented
  // coarseness, not a position the assignment rules themselves get wrong.
  const assignmentsResult = await fetchParentedFirers(
    ctx,
    objectId,
    ASSIGNMENT_TYPES,
  );
  if (!assignmentsResult.ok) return err(assignmentsResult.error);
  for (const firer of assignmentsResult.value) {
    const stepResult = await buildStep(
      ctx,
      firer,
      'post-save-assignment',
      stepIndex,
    );
    if (!stepResult.ok) return err(stepResult.error);
    soe.push(stepResult.value);
    stepIndex += 1;
  }

  // post-save-workflows.
  const workflowsResult = await fetchTriggersOnFirers(
    ctx,
    objectId,
    WORKFLOW_TYPES,
  );
  if (!workflowsResult.ok) return err(workflowsResult.error);
  for (const firer of workflowsResult.value) {
    if (skipInactiveSoeFirer(inactiveCollector, firer)) continue;
    if (workflowMatchesEvent(firer.properties['triggerType'], event)) {
      const stepResult = await buildStep(
        ctx,
        firer,
        'post-save-workflows',
        stepIndex,
      );
      if (!stepResult.ok) return err(stepResult.error);
      soe.push(stepResult.value);
      stepIndex += 1;
    }
  }

  // post-save-flows. Record-triggered AFTER-save flows run after workflow
  // rules in the documented order of execution. Before-save flows were already
  // emitted in the leading `before-save-flows` phase, so only the after-save
  // partition (already resolved against the object above) is walked here.
  //
  // Scheduled-only flows (hasImmediateConnector === false with scheduledPaths)
  // do NOT run synchronously in the triggering transaction. They are collected
  // here and emitted in post-save-async below.
  const scheduledOnlyAfterSaveFlows: Node[] = [];
  for (const { firer, recordTriggerType } of afterSaveFlows) {
    if (!flowMatchesEvent(recordTriggerType, event)) continue;
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
    const stepResult = await buildStep(ctx, firer, 'post-save-flows', stepIndex);
    if (!stepResult.ok) return err(stepResult.error);
    soe.push(stepResult.value);
    stepIndex += 1;
  }

  // post-save-approval. Approval submission isn't a standard SOE step;
  // when present it follows the standard post-save automation.
  const approvalsResult = await fetchParentedFirers(
    ctx,
    objectId,
    APPROVAL_TYPES,
  );
  if (!approvalsResult.ok) return err(approvalsResult.error);
  for (const firer of approvalsResult.value) {
    if (skipInactiveSoeFirer(inactiveCollector, firer)) continue;
    const stepResult = await buildStep(
      ctx,
      firer,
      'post-save-approval',
      stepIndex,
    );
    if (!stepResult.ok) return err(stepResult.error);
    soe.push(stepResult.value);
    stepIndex += 1;
  }

  // post-save-async.
  const asyncSourceSet: Node[] = [...beforeTriggers, ...afterTriggers];
  const asyncStepsResult = await buildAsyncSteps(
    ctx,
    asyncSourceSet,
    stepIndex,
  );
  if (!asyncStepsResult.ok) return err(asyncStepsResult.error);
  soe.push(...asyncStepsResult.value);
  let asyncFanOut = asyncStepsResult.value.length;
  stepIndex += asyncFanOut;
  // Emit scheduled-only after-save flows in post-save-async — they run only
  // via their scheduled/time-offset paths, not within the triggering transaction.
  for (const firer of scheduledOnlyAfterSaveFlows) {
    const stepResult = await buildStep(ctx, firer, 'post-save-async', stepIndex);
    if (!stepResult.ok) return err(stepResult.error);
    soe.push(stepResult.value);
    asyncFanOut += 1;
    stepIndex += 1;
  }

  const conditionalSteps = soe.filter((s) => s.conditional !== undefined).length;
  const activeComponents = soe.filter((s) => s.phase !== 'save').length;

  return ok({
    soe,
    summary: {
      totalSteps: soe.length,
      activeComponents,
      conditionalSteps,
      asyncFanOut,
      phaseCounts: tallyPhaseCounts(soe),
    },
  });
};

/**
 * The `sfi.order_of_execution` MCP tool. Returns a per-event SOE
 * tree for the given object. See the module JSDoc for the output
 * shape; the per-event composition mirrors `what_happens_on_save`.
 *
 * @example
 *   const r = await orderOfExecutionHandler(ctx, {
 *     objectApiName: 'Account',
 *   });
 *   if (r.ok) for (const event of Object.keys(r.value.data.byEvent)) {
 *     console.log(event, r.value.data.byEvent[event].soe.length);
 *   }
 */
export const orderOfExecutionHandler = async (
  ctx: Context,
  input: OrderOfExecutionInput,
): Promise<Result<McpResponse<OrderOfExecutionOutput>, McpError>> => {
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

  // Compose the SOE for each supported event. The four runs are
  // independent — the underlying graph state is stable across the
  // sequence — so the response carries the same per-event payload
  // shape per event.
  const inactiveCollector = new Map<ComponentId, InactiveConfiguredFirer>();
  const emptyPerEvent = (): SoePerEvent => ({
    soe: [],
    summary: {
      totalSteps: 0,
      activeComponents: 0,
      conditionalSteps: 0,
      asyncFanOut: 0,
      phaseCounts: tallyPhaseCounts([]),
    },
  });
  const byEvent: Record<SoeEvent, SoePerEvent> = {
    insert: emptyPerEvent(),
    update: emptyPerEvent(),
    delete: emptyPerEvent(),
    undelete: emptyPerEvent(),
  };
  for (const event of SOE_EVENTS) {
    const perEventResult = await composeForEvent(
      ctx,
      objectId,
      input.objectApiName,
      event,
      inactiveCollector,
    );
    if (!perEventResult.ok) {
      return err({ kind: 'internal', message: perEventResult.error });
    }
    byEvent[event] = perEventResult.value;
  }

  const inactiveConfigured = sortedInactiveConfigured(inactiveCollector);

  const data: {
    objectApiName: string;
    objectModeled: boolean;
    byEvent: Record<SoeEvent, SoePerEvent>;
    disclosure: string;
    inactiveConfigured?: readonly InactiveConfiguredFirer[];
    truncated?: boolean;
  } = {
    objectApiName: input.objectApiName,
    objectModeled,
    ...(inactiveConfigured.length > 0 ? { inactiveConfigured } : {}),
    ...(inactiveConfigured.length > 0
      ? {
          inactiveHeadline: `Excluded inactive: ${inactiveConfigured.map((i) => i.apiName).join(', ')}`,
        }
      : {}),
    byEvent,
    disclosure: composeSoeDisclosure(DISCLOSURE, objectModeled),
  };

  // The four-event payload is the heaviest SOE surface in the product; on a
  // densely-automated standard object (e.g. Contact, ~120 KB) it blows the MCP
  // response budget. Pass each event's step array as a container so the
  // enforcer can trim per-step actions/conditionals and, as a last resort, drop
  // trailing steps per event — keeping the response usable instead of rejected.
  const containers = SOE_EVENTS.map(
    (event) => byEvent[event].soe,
  ) as unknown as BoundableStep[][];
  const budget = enforceSoeByteBudget(data, containers);
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
