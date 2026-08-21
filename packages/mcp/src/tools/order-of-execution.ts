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
import {
  getNodeById,
  listEdges,
  listEdgesForNodes,
  listNodesByIds,
} from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  isUnresolvedApexCallTarget,
  isUnresolvedFieldReceiver,
} from './apex-receiver.js';
import { resolveObjectAlias } from './input-aliases.js';
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
  buildDuplicateRuleStep,
  DUPLICATE_RULE_TYPES,
} from './soe-duplicate-rules.js';
import {
  AUTOMATION_PHASES,
  type BoundableStep,
  computePhasesOmitted,
  enforceSoeByteBudget,
  SOE_MAX_PAYLOAD_BYTES,
  type SoeBudgetResult,
  type SoePhase,
  type SoePhaseCounts,
  type SoePhaseOmission,
  soeTruncationNote,
  tallyPhaseCounts,
} from './soe-payload-bounds.js';
import {
  findRollupRecalcSteps,
  rollupScanTruncationNote,
  type RollupRecalcStep,
} from './soe-rollup-recalc.js';
import {
  type AmbiguousPhaseForEvent,
  buildWithinPhaseOrderCaveat,
  censusFlowTriggerOrders,
  collectAmbiguousPhases,
  type FlowTriggerOrderCensus,
  type FlowTriggerOrderCensusState,
  isTriggerOrderCoverageGap,
  sortFlowFirersByTriggerOrder,
  TRIGGER_ORDER_NOT_EXTRACTED_CAVEAT,
} from './soe-trigger-order.js';

// Re-export the shared phase-omission contract so this module's public surface
// is unchanged after the definitions moved to soe-payload-bounds. `AUTOMATION_PHASES`
// is consumed by the save-order-phase lockstep test
// (ORDER-OF-EXECUTION-OVERSIZE-HARD-FAIL).
export { AUTOMATION_PHASES, computePhasesOmitted, tallyPhaseCounts };
export type { SoePhase, SoePhaseCounts, SoePhaseOmission };

/**
 * The verbatim honesty-axis disclosure surfaced in every response.
 * BYTE-IDENTICAL to `what-happens-on-save.ts`'s `DISCLOSURE` — frozen here
 * so a caller-facing rephrasing during rendering is a code-review concern,
 * not a silent drift. The two SOE tools must stay in lockstep.
 */
const DISCLOSURE =
  "v2.0e composes the documented Salesforce order-of-execution instantiated against THIS org's extracted automation. Before-save record-triggered flows are modeled as the leading `before-save-flows` phase (they run BEFORE before-triggers). Duplicate rules are modeled as their own `duplicate-rules` phase, running after before-triggers and validation but BEFORE the save — evaluated on insert/update only, with the effective Block/Allow/Alert/Report operations surfaced per rule. Conditions ARE listed but NOT EVALUATED — the tool does not know whether this particular record satisfies them at runtime. Workflow field updates can re-fire before/after-update triggers (a second pass); this composition lists each automation once and does not expand that re-entrancy. A workflow rule's time-dependent actions (its workflowTimeTriggers) are SCHEDULED for an offset measured from a record field value the offline vault cannot evaluate; this composition lists the rule once in the synchronous post-save-workflows phase and does NOT claim its time-delayed actions fire at save. Parent Summary (roll-up) fields that aggregate this object recalculate in the `post-save-rollup-recalc` phase, capped to ONE level — a grandparent's own rollup on that recalculated parent is NOT walked — and the parent's own triggers/flows/workflows that its recalculated save would fire are NOT expanded (no re-entrancy). Entitlement-process and milestone-type METADATA is modeled elsewhere in the vault (R6-18: `EntitlementProcess`/`MilestoneType` nodes, queryable via `sfi.get_component` / `sfi.get_edges`, including each milestone's declared target `minutesToComplete` as of R7-C7) — but this composition does NOT simulate entitlement milestones as an order-of-execution phase: whether a specific record is currently on-track or breached against those target minutes is live, per-record timer data this offline vault cannot hold. Criteria-based sharing recalculation — the FINAL step in Salesforce's documented order-of-execution, evaluated after every phase modeled here (including post-save-async) — is also NOT modeled: a save that causes a record to newly match or stop matching a criteria-based sharing rule's criteria triggers a sharing recalculation this composition does not surface. Manual sharing, sharing sets, account teams, and Apex callouts after save are out of scope.";

/**
 * The four DML events the generic SOE diagram surfaces. `upsert` is
 * deliberately excluded — it composes from insert + update on the
 * client side, and surfacing it as a fifth bucket would just
 * duplicate the union without adding information.
 */
const SOE_EVENTS = ['insert', 'update', 'delete', 'undelete'] as const;
type SoeEvent = (typeof SOE_EVENTS)[number];

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

/**
 * Same SoeStep shape as `what_happens_on_save` — including its `stepIndex`
 * contract: the index orders the PHASES and is only a reading position between
 * two steps INSIDE one phase, because Salesforce defines no order there except
 * via a record-triggered flow's `<Flow><triggerOrder>`. See that tool's
 * `SoeStep` JSDoc and `soe-trigger-order.ts`; the residual ambiguity is named
 * in this response's `withinPhaseOrder`.
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
   * firers. Mirrors the what_happens_on_save SoeStep so the two save-order
   * views agree on what a validation rule actually does.
   */
  readonly errorMessage?: string;
  readonly errorDisplayField?: string | null;
  /**
   * For a DuplicateRule step, its effective `DuplicateRuleOperation` set for
   * THIS event (`Allow`/`Block`/`Alert`/`Report`, deduped). Omitted for
   * non-DuplicateRule firers. Mirrors the what_happens_on_save SoeStep.
   */
  readonly duplicateRuleOperations?: readonly string[];
  /**
   * For a DuplicateRule step, whether the effective operation set includes
   * `Block`. Omitted for non-DuplicateRule firers.
   */
  readonly blocksOnSave?: boolean;
}

/** One per-event entry inside the response's `byEvent` map. */
export interface SoePerEvent {
  readonly soe: readonly SoeStep[];
  /**
   * Phases this event's `soe` no longer fully represents because byte-budget
   * enforcement dropped trailing steps (`declared` vs `present`). Present ONLY
   * when a phase was truncated out. Omitted when the sequence is complete.
   */
  readonly phasesOmitted?: readonly SoePhaseOmission[];
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
  /**
   * Echo of the `phase` input when a single-phase filter was applied — each
   * event's `soe` then holds only that phase's steps (`summary` stays
   * whole-composition). Absent on an un-filtered call.
   */
  readonly appliedPhaseFilter?: Exclude<SoePhase, 'save'>;
  /**
   * FLOW-ORDER-IS-ALPHABETICAL. Present ONLY when some event's composition has
   * a phase holding two or more steps — the only shape in which the consecutive
   * `stepIndex` values could be read as a run order. Names those phases (with
   * the event each belongs to), which of the three trigger-order states this
   * object is in (`triggerOrderState`), and — when extracted — how many of its
   * record-triggered flows declare one.
   */
  readonly withinPhaseOrder?: {
    readonly determined: false;
    readonly ambiguousPhases: readonly AmbiguousPhaseForEvent[];
    readonly triggerOrderState: FlowTriggerOrderCensusState;
    readonly flowsDeclaringTriggerOrder?: number;
    readonly flowsWithoutTriggerOrder?: number;
    readonly caveat: string;
  };
  /**
   * Present ONLY when `withinPhaseOrder` is present AND this object HAS
   * record-triggered flows whose `<Flow><triggerOrder>` this vault never
   * extracted — a gap a `sfi refresh` closes. An object with no
   * record-triggered flows never carries it: there was nothing to extract, so
   * claiming a vault gap there would be a fabricated caveat with a remediation
   * that changes nothing.
   */
  readonly coverageCaveat?: typeof TRIGGER_ORDER_NOT_EXTRACTED_CAVEAT;
}

/**
 * Zod schema for the `sfi.order_of_execution` tool input.
 *
 *   - object identity (required): name the object ANY way the router / a
 *     sibling tool would (L2 Alias OS) — the canonical `objectApiName`, the
 *     `object` / `objectId` aliases, or a `CustomObject:` `componentId`.
 *     Exactly one target must survive resolution — disagreeing aliases are an
 *     `invalid-query`, and the resolved scope is echoed as `appliedScope`.
 *     Unknown objects surface as `component-not-found`.
 *   - `phase`: optional. When set, each event's `soe` returns ONLY that phase's
 *     steps — the recovery path for a phase truncated out of the full
 *     four-event view (see `SoePerEvent.phasesOmitted`). Per-event `summary`
 *     still reflects the whole composition. Echoed as `appliedPhaseFilter`.
 */
export const orderOfExecutionInputSchema = z
  .object({
    objectApiName: z.string().min(1).optional(),
    object: z.string().min(1).optional(),
    objectId: z.string().min(1).optional(),
    componentId: z.string().min(1).optional(),
    phase: z.enum(AUTOMATION_PHASES).optional(),
  })
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
  // ONE batched node fetch for every parentOf child, replacing the per-edge
  // `getNodeById` N+1. The per-edge Map lookup below preserves the old loop's
  // multiplicity (a duplicate edge pushes its node twice) and its null-skip
  // (`listNodesByIds` drops ids with no row exactly like `getNodeById`); the
  // trailing id-ASC sort makes push order irrelevant to the output.
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
  // row exactly like the old `getNodeById` null-skip, so `sorted` is the same
  // distinct non-null job set.
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
 *
 * `rollupSteps` is precomputed ONCE by the caller (`findRollupRecalcSteps`
 * does not depend on `event` — a roll-up recalculates on every DML event
 * identically) and threaded through so the org-wide Summary-field scan does
 * not repeat per event.
 */
const composeForEvent = async (
  ctx: Context,
  objectId: ComponentId,
  objectApiName: string,
  event: SoeEvent,
  inactiveCollector: Map<ComponentId, InactiveConfiguredFirer>,
  rollupSteps: readonly RollupRecalcStep[],
): Promise<
  Result<
    { readonly perEvent: SoePerEvent; readonly flowCensus: FlowTriggerOrderCensus },
    string
  >
> => {
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
  // ONE batched fetch of every Flow's OUTGOING triggersOn edges, replacing the
  // per-flow `listEdges` N+1 (mirrors what_happens_on_save). Each bucket is
  // sorted by the FULL (to_id, edge_type, from_id, source) order — a refinement
  // of listEdges' order — so `.find(e => e.toId === objectId)` returns the same
  // first-matching edge.
  const flowEdgeBatch = await listEdgesForNodes(
    ctx.graph,
    allFlowsResult.value.map((f) => f.id),
    { direction: 'out', edgeTypes: ['triggersOn'] },
  );
  if (!flowEdgeBatch.ok) return err(flowEdgeBatch.error.message);
  for (const firer of allFlowsResult.value) {
    if (skipInactiveSoeFirer(inactiveCollector, firer)) continue;
    const flowEdges = flowEdgeBatch.value.get(firer.id) ?? [];
    const edgeToObject = flowEdges.find((e) => e.toId === objectId);
    if (edgeToObject === undefined) continue;
    const entry = { firer, recordTriggerType: edgeToObject.properties['recordTriggerType'] };
    if (edgeToObject.properties['triggerType'] === 'RecordBeforeSave') beforeSaveFlows.push(entry);
    else afterSaveFlows.push(entry);
  }
  // FLOW-ORDER-IS-ALPHABETICAL — identical treatment to `what_happens_on_save`
  // (the two SOE tools must stay in lockstep). Sort by the declared
  // `<Flow><triggerOrder>` where one exists, ascending component id otherwise
  // — which is exactly the pre-existing order on a vault that never extracted
  // the property. See `soe-trigger-order.ts`.
  const orderedBeforeSaveFlows = sortFlowFirersByTriggerOrder(beforeSaveFlows);
  const orderedAfterSaveFlows = sortFlowFirersByTriggerOrder(afterSaveFlows);
  const flowCensus = censusFlowTriggerOrders([
    ...orderedBeforeSaveFlows.map((e) => e.firer),
    ...orderedAfterSaveFlows.map((e) => e.firer),
  ]);
  for (const { firer, recordTriggerType } of orderedBeforeSaveFlows) {
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

  // duplicate-rules. DuplicateRules parented to the object run AFTER
  // before-triggers and validation, BEFORE the record is saved — per
  // Salesforce's documented order-of-execution numbering. They evaluate on
  // insert/update only (`order_of_execution` has no `upsert` event — it
  // composes from insert + update on the client side).
  if (event === 'insert' || event === 'update') {
    const duplicateRulesResult = await fetchParentedFirers(
      ctx,
      objectId,
      DUPLICATE_RULE_TYPES,
    );
    if (!duplicateRulesResult.ok) return err(duplicateRulesResult.error);
    for (const firer of duplicateRulesResult.value) {
      if (skipInactiveSoeFirer(inactiveCollector, firer)) continue;
      const dupResult = await buildDuplicateRuleStep(ctx, firer, event);
      if (!dupResult.ok) return err(dupResult.error);
      // `null` means the rule's effective operations for THIS event are
      // empty — it does not evaluate on this event, so it is excluded.
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
  for (const { firer, recordTriggerType } of orderedAfterSaveFlows) {
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

  // post-save-rollup-recalc. Parent Summary (roll-up summary) CustomFields
  // that aggregate THIS object recalculate on every DML event — precomputed
  // once by the caller (see `rollupSteps` JSDoc above) since the set is the
  // same for insert/update/delete/undelete alike. Capped to ONE level and
  // does not expand the parent's own automation (no re-entrancy) — see
  // `soe-rollup-recalc.ts`.
  for (const rollup of rollupSteps) {
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
    perEvent: {
      soe,
      summary: {
        totalSteps: soe.length,
        activeComponents,
        conditionalSteps,
        asyncFanOut,
        phaseCounts: tallyPhaseCounts(soe),
      },
    },
    flowCensus,
  });
};

/** Serialized byte size of any value — used to keep the honesty additions within budget. */
const sizeOfBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * Headroom reserved below {@link SOE_MAX_PAYLOAD_BYTES} for the honesty
 * scaffolding the four-event view appends AFTER byte-budget enforcement — the
 * per-event `phasesOmitted` arrays and the phases-dropped disclosure note. Those
 * additions are measured by `enforceSoeByteBudget` only if they are reserved
 * for; otherwise they push `data` back over budget and the global dispatch guard
 * mangles the (load-bearing) disclosure or, since the nested per-event `soe`
 * arrays are not reducible by that guard, rejects the whole answer — the exact
 * ORDER-OF-EXECUTION-OVERSIZE-HARD-FAIL / re-inflation bug. Sized to cover the
 * common tail-drop (a few phases per event); a pathological object that exceeds
 * it triggers a second, precisely-reserved enforcement pass in the handler.
 */
const OOE_HONESTY_RESERVE_BYTES = 3_000;

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
  rawInput: OrderOfExecutionInput,
): Promise<Result<McpResponse<OrderOfExecutionOutput>, McpError>> => {
  // L2 Alias OS: resolve the object from any of objectApiName / object /
  // objectId / CustomObject: componentId. Disagreeing aliases -> invalid-query.
  const scopeResult = resolveObjectAlias(rawInput);
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

  // Precompute the post-save-rollup-recalc set ONCE — it does not depend on
  // the event (a roll-up recalculates on insert/update/delete/undelete
  // alike), so scanning it four times (once per composeForEvent call) would
  // repeat the same org-wide Summary-field scan for no reason.
  const rollupResult = await findRollupRecalcSteps(ctx, input.objectApiName);
  if (!rollupResult.ok) {
    return err({ kind: 'internal', message: rollupResult.error });
  }

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
  // FLOW-ORDER-IS-ALPHABETICAL. The four per-event compositions resolve the SAME
  // record-triggered flow set for the object, so the trigger-order census they
  // produce is identical; keep the last one (any one) for the response-level
  // `withinPhaseOrder`. Undefined only when no event composed at all.
  let flowCensus: FlowTriggerOrderCensus | undefined;
  for (const event of SOE_EVENTS) {
    const perEventResult = await composeForEvent(
      ctx,
      objectId,
      input.objectApiName,
      event,
      inactiveCollector,
      rollupResult.value.steps,
    );
    if (!perEventResult.ok) {
      return err({ kind: 'internal', message: perEventResult.error });
    }
    flowCensus = perEventResult.value.flowCensus;
    // Optional single-phase filter (recovery path for a phase truncated out of
    // the full four-event view). Each event's `soe` returns only the requested
    // phase; `summary` is left whole (still the full phase distribution) so the
    // caller keeps the complete counts. Filtering here — before enforcement —
    // means the small per-phase slice never blows the byte budget, so a phase
    // the full view dropped is recoverable in one call.
    byEvent[event] =
      input.phase !== undefined
        ? {
            ...perEventResult.value.perEvent,
            soe: perEventResult.value.perEvent.soe.filter(
              (s) => s.phase === input.phase,
            ),
          }
        : perEventResult.value.perEvent;
  }

  const inactiveConfigured = sortedInactiveConfigured(inactiveCollector);

  const data: {
    objectApiName: string;
    appliedScope: { componentId: string; object: string };
    objectModeled: boolean;
    byEvent: Record<SoeEvent, SoePerEvent>;
    disclosure: string;
    inactiveConfigured?: readonly InactiveConfiguredFirer[];
    truncated?: boolean;
    appliedPhaseFilter?: Exclude<SoePhase, 'save'>;
    withinPhaseOrder?: {
      readonly determined: false;
      readonly ambiguousPhases: readonly AmbiguousPhaseForEvent[];
      readonly triggerOrderState: FlowTriggerOrderCensusState;
      readonly flowsDeclaringTriggerOrder?: number;
      readonly flowsWithoutTriggerOrder?: number;
      readonly caveat: string;
    };
    coverageCaveat?: typeof TRIGGER_ORDER_NOT_EXTRACTED_CAVEAT;
  } = {
    objectApiName: input.objectApiName,
    appliedScope,
    objectModeled,
    ...(inactiveConfigured.length > 0 ? { inactiveConfigured } : {}),
    ...(inactiveConfigured.length > 0
      ? {
          inactiveHeadline: `Excluded inactive: ${inactiveConfigured.map((i) => i.apiName).join(', ')}`,
        }
      : {}),
    ...(input.phase !== undefined ? { appliedPhaseFilter: input.phase } : {}),
    byEvent,
    disclosure: composeSoeDisclosure(DISCLOSURE, objectModeled),
  };

  // The org-wide Summary-field scan behind post-save-rollup-recalc hit the
  // shared node-scan cap — the rollup list above may be INCOMPLETE. Disclose
  // it rather than imply every aggregating parent was found.
  if (rollupResult.value.scanTruncated) {
    data.disclosure = `${data.disclosure} ${rollupScanTruncationNote()}`;
  }

  // FLOW-ORDER-IS-ALPHABETICAL. One response-level block covering all four
  // events, its `ambiguousPhases` naming the event each ambiguous phase belongs
  // to (the four compositions do not share a phase distribution). Emitted ONLY
  // when some event holds a phase with two or more steps — the only shape in
  // which consecutive `stepIndex` values could read as a run order — so a
  // sparsely-automated object's response is byte-identical to before. Attached
  // BEFORE the byte-budget passes below so its bytes are measured, not
  // re-inflated past the guard.
  const ambiguousPhases: AmbiguousPhaseForEvent[] = [];
  for (const event of SOE_EVENTS) {
    for (const entry of collectAmbiguousPhases(
      byEvent[event].summary.phaseCounts,
    )) {
      ambiguousPhases.push({ event, ...entry });
    }
  }
  if (ambiguousPhases.length > 0 && flowCensus !== undefined) {
    data.withinPhaseOrder = {
      determined: false,
      ambiguousPhases,
      triggerOrderState: flowCensus.state,
      ...(flowCensus.state === 'extracted'
        ? {
            flowsDeclaringTriggerOrder: flowCensus.declared,
            flowsWithoutTriggerOrder: flowCensus.undeclared,
          }
        : {}),
      caveat: buildWithinPhaseOrderCaveat(flowCensus),
    };
    // A gap a refresh CAN close, so it rides the coverageCaveat channel — but
    // ONLY when the object actually has record-triggered flows. With none, the
    // census is `not-applicable` and a `Flow.triggerOrder` coverage claim would
    // be fabricated: nothing was missed and a refresh would change nothing.
    if (isTriggerOrderCoverageGap(flowCensus)) {
      data.coverageCaveat = TRIGGER_ORDER_NOT_EXTRACTED_CAVEAT;
    }
  }

  // The four-event payload is the heaviest SOE surface in the product; on a
  // densely-automated standard object (e.g. Contact, ~120 KB) it blows the MCP
  // response budget. Pass each event's step array as a container so the
  // enforcer can trim per-step actions/conditionals and, as a last resort, drop
  // trailing steps per event — keeping the response usable instead of rejected.
  const containers = SOE_EVENTS.map(
    (event) => byEvent[event].soe,
  ) as unknown as BoundableStep[][];

  // Base disclosure (rollup note included, honesty scaffolding NOT) — captured
  // so `attachEnvelopeHonesty` rebuilds the disclosure from a clean base each
  // time it runs, never doubling a note across the two enforcement passes below.
  const baseDisclosure = data.disclosure;
  // Stable references to each event's composed payload (its `soe` array is the
  // one the enforcer trims in place; its `summary.phaseCounts` are the true
  // pre-enforcement counts). `attachEnvelopeHonesty` derives `byEvent[event]`
  // from these each pass so a re-enforcement never compounds a prior pass's
  // `phasesOmitted`.
  const perEventBase = { ...byEvent };

  /**
   * Rebuild `data`'s truncation disclosure + per-event `phasesOmitted` for the
   * CURRENT survivor state (WHAT-HAPPENS-ON-SAVE-TRUNCATION-DROPS-LATER-PHASES):
   * the last-resort step-drop can shed whole phases from the tail of an event's
   * `soe` while `summary.phaseCounts` still reports their true count, so name the
   * shortfall in `phasesOmitted` — the counts can never silently contradict the
   * sequence. Rebuilds from `baseDisclosure`, so it is idempotent and safe to
   * call again after a re-enforcement pass. Skipped (phasesOmitted-wise) on a
   * phase-filtered call — the caller narrowed on purpose. Byte-neutral when
   * nothing was dropped.
   */
  const attachEnvelopeHonesty = (result: SoeBudgetResult): void => {
    let disclosure = baseDisclosure;
    if (result.truncated) {
      data.truncated = true;
      disclosure = `${disclosure} ${soeTruncationNote(result)}`;
    } else {
      delete data.truncated;
    }
    if (input.phase === undefined) {
      const omittedByEvent: string[] = [];
      for (const event of SOE_EVENTS) {
        const base = perEventBase[event];
        const phasesOmitted = computePhasesOmitted(
          base.summary.phaseCounts,
          base.soe,
        );
        byEvent[event] =
          phasesOmitted.length > 0 ? { ...base, phasesOmitted } : base;
        if (phasesOmitted.length > 0) {
          omittedByEvent.push(
            `${event}: ${phasesOmitted.map((p) => `${p.phase} (${p.present}/${p.declared})`).join(', ')}`,
          );
        }
      }
      if (omittedByEvent.length > 0) {
        data.truncated = true;
        disclosure =
          `${disclosure} Note: byte-budget truncation dropped whole phases from the returned sequence though \`phaseCounts\` still reports them — ${omittedByEvent.join('; ')}. Re-query with the \`phase\` filter (or \`what_happens_on_save\` for one event) to see the full roster.`;
      }
    }
    data.disclosure = disclosure;
  };

  // Pass 1 — enforce with modest headroom reserved for the honesty scaffolding
  // attached below, then attach it. Reserving here is what makes the FINAL
  // `data` (scaffolding included) obey the same envelope law as
  // `what_happens_on_save`: it stays within budget instead of re-inflating past
  // it and forcing the global guard to mangle the disclosure.
  let budget = enforceSoeByteBudget(data, containers, {
    budgetBytes: SOE_MAX_PAYLOAD_BYTES - OOE_HONESTY_RESERVE_BYTES,
  });
  const soeOnlyBytes = sizeOfBytes(data);
  attachEnvelopeHonesty(budget);

  // Pass 2 (rare) — on a pathologically dense object the honesty scaffolding
  // exceeded the reserve and pushed `data` back over the hard SOE ceiling.
  // Re-enforce reserving the MEASURED scaffolding size (plus the same headroom
  // for its growth as more steps drop), then re-attach against the new
  // survivors. `phasesOmitted` is bounded by phase-count, so this converges and
  // guarantees the final `data` is within budget without the global guard.
  if (sizeOfBytes(data) > SOE_MAX_PAYLOAD_BYTES) {
    const honestyBytes = sizeOfBytes(data) - soeOnlyBytes;
    const budget2 = enforceSoeByteBudget(data, containers, {
      budgetBytes:
        SOE_MAX_PAYLOAD_BYTES - honestyBytes - OOE_HONESTY_RESERVE_BYTES,
    });
    budget = {
      truncated: budget.truncated || budget2.truncated,
      actionsOmitted: budget.actionsOmitted + budget2.actionsOmitted,
      conditionalsTrimmed:
        budget.conditionalsTrimmed + budget2.conditionalsTrimmed,
      stepsOmitted: budget.stepsOmitted + budget2.stepsOmitted,
    };
    attachEnvelopeHonesty(budget);
  }

  return ok({
    data,
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
