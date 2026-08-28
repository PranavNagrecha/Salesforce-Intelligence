/**
 * The APPROVAL chain — Salesforce's documented approval-process sequence,
 * instantiated against THIS org's `ApprovalProcess` components.
 *
 * ## Documented sequence this module implements
 *
 * Source of truth: the Salesforce `ApprovalProcess` metadata type and the
 * Approvals setup documentation. Every element named below is a real element of
 * that XML, and the extractor already lands each one on the node (see
 * `packages/extractors/src/approval-process.ts`), so this module is a
 * composition over declared facts, not a re-parse:
 *
 *   1. Submit — the request is raised by an allowed submitter
 *      (`allowedSubmitters`), from the Submit for Approval button, Apex
 *      `Approval.process()`, or a Flow `submit` action.
 *   2. Entry criteria — `entryCriteria` (a formula or criteria items) decides
 *      whether the process applies at all.
 *   3. Initial submission actions — `initialSubmissionActions` fire.
 *   4. Record lock — `recordEditability` decides who may still edit the record
 *      while it is pending.
 *   5. Step entry criteria — each `approvalStep`'s own `entryCriteria`, with
 *      `ifCriteriaNotMet` deciding what happens when a step is skipped.
 *   6. Approver assignment — each step's `assignedApprover`, by user, queue,
 *      group, role, role-and-subordinates, a related user field, or the
 *      hierarchy field named at `nextAutomatedApprover`.
 *   7. Step approval actions — a step's `approvalActions` fire when its
 *      approver approves.
 *   8. Step rejection actions — a step's `rejectionActions` fire when its
 *      approver rejects, with `rejectBehavior` deciding whether the
 *      rejection ends the request or returns it to the previous step.
 *   9. Final approval — `finalApprovalActions` fire once the last step
 *      approves.
 *  10. Final rejection — `finalRejectionActions` fire when a rejection ends
 *      the request outright (see step 8's `rejectBehavior`).
 *  11. Final lock — `finalApprovalRecordLock` decides whether the record
 *      stays locked after final approval; `finalRejectionRecordLock`
 *      decides the same after final rejection.
 *  12. Recall — `recallActions`, available only when `allowRecall` is true.
 *  13. Re-entry — field updates fired by approval actions write to the
 *      record, and that write re-enters the object's ordinary save order.
 *
 * ## The two honest holes this module surfaces
 *
 * Both are extraction-level, both are emitted as steps rather than dropped:
 *
 *   - A STEP-level `approvalActions` / `rejectionActions` FieldUpdate names the
 *     field update by NAME only. The extractor emits field-level `writesTo`
 *     edges for PROCESS-level hook actions but not for step-level ones, and
 *     `WorkflowFieldUpdate` is not a modeled ComponentType, so the FIELD a step
 *     action writes is unresolvable from this vault.
 *   - `assignedApprover.whenMultipleApprovers` (unanimous vs first-response) is
 *     not captured by the extractor, so a multi-approver step cannot say which
 *     rule applies.
 */

import type {
  ComponentId,
  ComponentType,
  Edge,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listEdges, listNodesByIds } from '@sf-intelligence/graph';

import type { Context } from '../server.js';

import { familyWasExtracted } from './absence-disclosure.js';
import {
  type ChainComponentRef,
  type ChainStep,
  type ChainStepCondition,
  composeNestedSave,
  suppressedNestedSave,
} from './action-chain-model.js';

/** The frozen, documented phase sequence of an approval request. */
export const APPROVAL_CHAIN_PHASES = [
  'submit-request',
  'entry-criteria',
  'initial-submission-actions',
  'record-lock',
  'step-entry-criteria',
  'approver-assignment',
  'step-approval-actions',
  'step-rejection-actions',
  'final-approval-actions',
  'final-rejection-actions',
  'final-lock',
  'recall',
  'field-update-reentry',
] as const;
export type ApprovalChainPhase = (typeof APPROVAL_CHAIN_PHASES)[number];

/** Which terminal branch(es) of the chain to expand. */
export const APPROVAL_OUTCOMES = ['approve', 'reject', 'recall', 'all'] as const;
export type ApprovalOutcome = (typeof APPROVAL_OUTCOMES)[number];

/**
 * Approval-action `<type>` → the canonical id prefix its `<name>` resolves to,
 * and whether that prefix is a ComponentType this product actually models. A
 * prefix that is NOT modeled can never resolve to a node, so a reference built
 * from it is a NAME — never evidence the component exists.
 */
const ACTION_TARGET_TABLE: Readonly<
  Record<
    string,
    {
      readonly prefix: string;
      readonly scopedByObject: boolean;
      readonly componentType: ComponentType | 'unresolved';
      readonly modeled: boolean;
    }
  >
> = {
  Alert: {
    prefix: 'WorkflowAlert',
    scopedByObject: true,
    componentType: 'WorkflowAlert',
    modeled: true,
  },
  FieldUpdate: {
    prefix: 'WorkflowFieldUpdate',
    scopedByObject: true,
    componentType: 'unresolved',
    modeled: false,
  },
  Task: {
    prefix: 'WorkflowTask',
    scopedByObject: true,
    componentType: 'unresolved',
    modeled: false,
  },
  OutboundMessage: {
    prefix: 'OutboundMessage',
    scopedByObject: true,
    componentType: 'OutboundMessage',
    modeled: true,
  },
  Apex: {
    prefix: 'ApexClass',
    scopedByObject: false,
    componentType: 'ApexClass',
    modeled: true,
  },
  FlowAction: {
    prefix: 'Flow',
    scopedByObject: false,
    componentType: 'Flow',
    modeled: true,
  },
};

const STEP_FIELD_UPDATE_UNRESOLVED =
  'A step-level FieldUpdate action names the field update by NAME only. The extractor emits a field-level `writesTo` edge for PROCESS-level hook actions (initial submission / final approval / final rejection / recall) but NOT for step-level approve / reject actions, and `WorkflowFieldUpdate` is not a ComponentType this product models — so the FIELD this action writes is UNRESOLVED. That is a hole in this answer, NOT a finding that the action writes nothing. Read the field update in the object\'s `workflows/{Object}.workflow-meta.xml` `<fieldUpdates>` collection.';

const MULTI_APPROVER_UNRESOLVED =
  'This step assigns MORE THAN ONE approver, so Salesforce applies the step\'s `whenMultipleApprovers` rule — unanimous (every approver must approve) or first-response (the first response decides). That element is NOT captured by this product\'s ApprovalProcess extractor, so which rule applies here is UNRESOLVED. Do not assume unanimous.';

const NAMELESS_APPROVER_UNRESOLVED =
  'At least one approver on this step carries a type but no name. For `userHierarchyField` that is the built-in standard Manager field — a standard User field, not a vault component, so there is nothing to link. For `adhoc` the approver is chosen BY THE SUBMITTER at submit time, which is runtime data an offline vault can never hold. Either way the approver identity is UNRESOLVED here, not absent.';

const EMAIL_APPROVAL_NOT_MODELED =
  'Email approval response, approver delegation (the `DelegatedApproverId` on a User), the approval HISTORY of any actual record, and the running position of any in-flight request are runtime state, not metadata. This tool does not model them, and the chain below is the process DEFINITION — never the status of a request.';

const PROCESS_ORDER_NOT_MODELED =
  'When an object has several active approval processes, Salesforce evaluates them in the org\'s configured process ORDER and applies the FIRST whose entry criteria the record satisfies. That order is Setup configuration, not a property of any `.approvalProcess-meta.xml` file, so it is not in this vault. The processes below are listed in canonical id order, which is NOT the evaluation order — do not read the first one as the one that would apply.';

/** A `{ name, type }` pair as stamped on `properties.steps[]` / hook lists. */
interface NamedTypedRef {
  readonly name: string | null;
  readonly type: string | null;
}

/** The extractor's per-step structured mirror, read defensively. */
interface ApprovalStepFacts {
  readonly stepIndex: number;
  readonly name: string | null;
  readonly label: string | null;
  readonly approvers: readonly NamedTypedRef[];
  readonly entryCriteriaFormula: string | null;
  readonly entryCriteriaItemCount: number;
  readonly ifCriteriaNotMet: string | null;
  readonly rejectBehaviorType: string | null;
  readonly approvalActions: readonly NamedTypedRef[];
  readonly rejectionActions: readonly NamedTypedRef[];
}

/** One approval process composed into its documented chain. */
export interface ApprovalProcessChain {
  readonly componentId: ComponentId;
  readonly apiName: string;
  readonly active: boolean;
  readonly stepCount: number;
  readonly chain: readonly ChainStep[];
}

/** Options the handler threads into the composer. */
export interface ApprovalChainOptions {
  readonly outcome: ApprovalOutcome;
  readonly nestedSaveDepth: 0 | 1;
  /** Collector the nested save-order engine's verbatim disclosure dedupes into. */
  readonly soeDisclosureSink: Set<string>;
}

const asRecordArray = (value: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter(
        (v): v is Record<string, unknown> =>
          typeof v === 'object' && v !== null && !Array.isArray(v),
      )
    : [];

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const asNamedTypedList = (value: unknown): readonly NamedTypedRef[] =>
  asRecordArray(value).map((o) => ({
    name: asString(o['name']),
    type: asString(o['type']),
  }));

/** Read `properties.steps[]` off an ApprovalProcess node, defensively. */
const readStepFacts = (node: Node): readonly ApprovalStepFacts[] =>
  asRecordArray(node.properties['steps']).map((o, i) => ({
    stepIndex: typeof o['stepIndex'] === 'number' ? o['stepIndex'] : i,
    name: asString(o['name']),
    label: asString(o['label']),
    approvers: asNamedTypedList(o['approvers']),
    entryCriteriaFormula: asString(o['entryCriteriaFormula']),
    entryCriteriaItemCount:
      typeof o['entryCriteriaItemCount'] === 'number' ? o['entryCriteriaItemCount'] : 0,
    ifCriteriaNotMet: asString(o['ifCriteriaNotMet']),
    rejectBehaviorType: asString(o['rejectBehaviorType']),
    approvalActions: asNamedTypedList(o['approvalActions']),
    rejectionActions: asNamedTypedList(o['rejectionActions']),
  }));

/** Build the canonical id an approval action's `<name>` refers to. */
const actionTargetId = (
  action: NamedTypedRef,
  objectApiName: string,
): { readonly id: ComponentId; readonly modeled: boolean; readonly componentType: ComponentType | 'unresolved' } | null => {
  if (action.name === null || action.type === null) return null;
  const spec = ACTION_TARGET_TABLE[action.type];
  if (spec === undefined) return null;
  const tail = spec.scopedByObject ? `${objectApiName}.${action.name}` : action.name;
  return {
    id: `${spec.prefix}:${tail}`,
    modeled: spec.modeled,
    componentType: spec.componentType,
  };
};

/**
 * Turn a list of approval actions into component refs, resolving each against
 * the graph. Returns the refs plus whether ANY of them was an unresolvable
 * step-level FieldUpdate — the caller uses that to attach the typed hole.
 */
const actionRefs = (
  actions: readonly NamedTypedRef[],
  objectApiName: string,
  role: string,
  resolvedIds: ReadonlySet<string>,
): { readonly refs: readonly ChainComponentRef[]; readonly hasUnresolvedFieldUpdate: boolean } => {
  const refs: ChainComponentRef[] = [];
  let hasUnresolvedFieldUpdate = false;
  for (const action of actions) {
    const target = actionTargetId(action, objectApiName);
    if (target === null) {
      refs.push({
        componentId: `unresolved:${action.type ?? 'unknown-type'}.${action.name ?? 'unnamed'}`,
        componentType: 'unresolved',
        apiName: action.name ?? 'unnamed',
        role,
        targetMissing: true,
        note: `action type \`${action.type ?? 'unknown'}\` has no canonical id form in this product`,
      });
      continue;
    }
    if (action.type === 'FieldUpdate') hasUnresolvedFieldUpdate = true;
    const exists = resolvedIds.has(target.id);
    refs.push({
      componentId: target.id,
      componentType: target.componentType,
      apiName: action.name ?? target.id,
      role,
      ...(exists ? {} : { targetMissing: true as const }),
      note: target.modeled
        ? exists
          ? `declared ${action.type ?? 'action'}`
          : `declared ${action.type ?? 'action'}; no node with this id in the vault`
        : `declared ${action.type ?? 'action'}; \`${target.id.split(':')[0] ?? ''}\` is not a ComponentType this product models, so this is a NAME, not a resolved component`,
    });
  }
  return { refs, hasUnresolvedFieldUpdate };
};

/**
 * One process-level hook list, plus whether the EXTRACTOR wrote it at all.
 *
 * The distinction is the whole verified-none-vs-unresolved axis at this level:
 * a hook-list property PRESENT and empty means the extractor read the element
 * and found nothing (a declared absence — the process really fires no action
 * there). A property ABSENT means this node predates the structured hook-list
 * extraction, so an empty result is a coverage hole and claiming "no actions
 * fire" would be a fabrication.
 */
interface HookListState {
  readonly actions: readonly NamedTypedRef[];
  readonly extracted: boolean;
}

/** Read one hook list off the process node, tracking whether it was extracted. */
const readHookActions = (node: Node, key: string): HookListState => ({
  actions: asNamedTypedList(node.properties[key]),
  extracted: familyWasExtracted(node.properties, key),
});

/**
 * The step + absence fields for a hook list, resolving the three-way state:
 * actions present → `resolved`; extracted and empty → `verified-none` with the
 * declared basis; never extracted → `unresolved` with the coverage reason.
 */
const hookResolution = (
  state: HookListState,
  element: string,
): {
  readonly resolution: 'resolved' | 'verified-none' | 'unresolved';
  readonly extra: { absenceBasis?: string; unresolvedReason?: string };
} => {
  if (state.actions.length > 0) return { resolution: 'resolved', extra: {} };
  if (!state.extracted) {
    return {
      resolution: 'unresolved',
      extra: {
        unresolvedReason: `This ApprovalProcess node carries no \`${element}\` property at all — the structured hook-list extraction did not run for this vault. An empty result here is a COVERAGE HOLE, not a finding that no action fires at this point. Re-run \`sfi refresh\`.`,
      },
    };
  }
  return {
    resolution: 'verified-none',
    extra: {
      absenceBasis: `The \`<${element}>\` element is absent or empty on this process's own extracted metadata — a DECLARED absence read directly off the component, not an inference from a missing family.`,
    },
  };
};

/** The process-level entry condition, as a listed-not-evaluated condition. */
const entryCondition = (node: Node): ChainStepCondition | null => {
  const formula = asString(node.properties['entryCriteriaFormula']);
  const itemCount =
    typeof node.properties['entryCriteriaItemCount'] === 'number'
      ? node.properties['entryCriteriaItemCount']
      : 0;
  if (formula === null && itemCount === 0) return null;
  return {
    source: 'entryCriteria',
    expression: formula ?? '',
    ...(itemCount > 0 ? { criteriaItemCount: itemCount } : {}),
  };
};

const outcomeIncludes = (outcome: ApprovalOutcome, branch: 'approve' | 'reject' | 'recall'): boolean =>
  outcome === 'all' || outcome === branch;

/** A step under construction, before its `stepIndex` is stamped. */
type PartialStep = Omit<ChainStep, 'stepIndex'>;

/**
 * Compose one `ApprovalProcess` node into its documented chain.
 *
 * Every documented phase is emitted whether or not this vault could fill it.
 * `allowRecall: false` produces a `verified-none` recall step (a DECLARED org
 * fact, not an inference); an unnamed approver produces an `unresolved` one.
 */
export const composeApprovalProcessChain = async (
  ctx: Context,
  process: Node,
  objectApiName: string,
  options: ApprovalChainOptions,
): Promise<Result<ApprovalProcessChain, string>> => {
  const steps: PartialStep[] = [];
  const props = process.properties;
  const active = props['active'] === true;

  // ONE fetch of every outgoing edge, partitioned below. The extractor stamps
  // `hookType` on process-level hook edges and `stepIndex` on approver edges, so
  // the whole grounded surface of the process is one query.
  const edgesResult = await listEdges(ctx.graph, process.id, { direction: 'out' });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  const outEdges: readonly Edge[] = edgesResult.value;

  const stepFacts = readStepFacts(process);

  // Resolve every id this chain will reference in ONE batched node fetch, so a
  // convention-built id can be honestly marked present or missing.
  const candidateIds: ComponentId[] = [];
  for (const edge of outEdges) candidateIds.push(edge.toId);
  for (const fact of stepFacts) {
    for (const a of [...fact.approvalActions, ...fact.rejectionActions]) {
      const t = actionTargetId(a, objectApiName);
      if (t !== null) candidateIds.push(t.id);
    }
  }
  const nodesResult = await listNodesByIds(ctx.graph, [...new Set(candidateIds)]);
  if (!nodesResult.ok) return err(nodesResult.error.message);
  const nodeById = new Map(nodesResult.value.map((n) => [n.id, n]));
  const resolvedIds: ReadonlySet<string> = new Set(nodeById.keys());

  const refFor = (
    id: ComponentId,
    role: string,
    fallbackType: ComponentType | 'unresolved',
    note?: string,
  ): ChainComponentRef => {
    const node = nodeById.get(id);
    return {
      componentId: id,
      componentType: node?.type ?? fallbackType,
      apiName: node?.apiName ?? id,
      role,
      ...(node === undefined ? { targetMissing: true as const } : {}),
      ...(note !== undefined ? { note } : {}),
    };
  };

  // ---- 1. submit-request --------------------------------------------------
  const submitters = asRecordArray(props['allowedSubmitters']).map((o) => ({
    type: asString(o['type']),
    name: asString(o['name']),
  }));
  const submitterRefs: ChainComponentRef[] = [];
  for (const s of submitters) {
    if (s.name === null) continue;
    const prefix =
      s.type === 'group' ? 'Group' : s.type === 'role' ? 'Role' : s.type === 'user' ? 'User' : null;
    if (prefix === null) continue;
    submitterRefs.push(
      refFor(`${prefix}:${s.name}`, 'allowed-submitter', 'unresolved', `declared submitter type \`${s.type ?? 'unknown'}\``),
    );
  }
  const ownerOnlySubmitters = submitters.filter((s) => s.name === null);
  steps.push({
    phase: 'submit-request',
    title: 'Request submitted for approval',
    resolution: submitterRefs.length > 0 ? 'resolved' : 'platform-step',
    components: submitterRefs,
    note: `A submission is raised from the Submit for Approval button, from Apex \`Approval.process()\`, or from a Flow \`submit\` action. ${submitters.length === 0 ? 'This process declares no `allowedSubmitters`, so the platform default applies: the record owner may submit.' : `This process declares ${submitters.length} allowed-submitter entry(ies)${ownerOnlySubmitters.length > 0 ? `, ${ownerOnlySubmitters.length} of which name no component (e.g. type \`owner\`) and so have no id to link` : ''}.`} Whether a given user is IN one of these groups/roles is runtime data — use \`sfi.group_membership\` / \`sfi.effective_permissions\`.`,
  });

  // ---- 2. entry-criteria --------------------------------------------------
  const entry = entryCondition(process);
  steps.push({
    phase: 'entry-criteria',
    title: 'Process entry criteria evaluated',
    resolution: entry === null ? 'verified-none' : 'resolved',
    components: [],
    note:
      entry === null
        ? 'This process declares NO entry criteria, so it applies to every submitted record of this object (subject to process order).'
        : 'The record must satisfy this condition for the process to apply. LISTED, NOT EVALUATED — whether a particular record satisfies it needs record data this offline vault does not hold.',
    ...(entry === null
      ? {
          absenceBasis:
            'The `<entryCriteria>` element is absent from this process\'s own extracted metadata — a DECLARED absence read directly off the component, not an inference from a missing family.',
        }
      : { conditions: [entry] }),
  });

  // ---- 3. initial-submission-actions -------------------------------------
  const initialHookEdges = outEdges.filter(
    (e) => e.properties['hookType'] === 'initialSubmission',
  );
  const initialActions = readHookActions(process, 'initialSubmissionActions');
  const initialState = hookResolution(initialActions, 'initialSubmissionActions');
  steps.push({
    phase: 'initial-submission-actions',
    title: 'Initial submission actions fire',
    resolution: initialState.resolution,
    components: initialHookEdges.map((e) =>
      refFor(
        e.toId,
        'initial-submission-action',
        'unresolved',
        `declared ${String(e.properties['actionType'] ?? e.edgeType)}`,
      ),
    ),
    note: 'Field updates, email alerts, tasks and outbound messages the process fires the moment a record enters it.',
    ...initialState.extra,
  });

  // ---- 4. record-lock -----------------------------------------------------
  const recordEditability = asString(props['recordEditability']);
  steps.push({
    phase: 'record-lock',
    title: 'Record locked while the request is pending',
    resolution: recordEditability === null ? 'unresolved' : 'resolved',
    components: [],
    note:
      recordEditability === null
        ? 'Salesforce locks a record on submission; `recordEditability` decides who may still edit it.'
        : `\`recordEditability: ${recordEditability}\` — ${recordEditability === 'AdminOnly' ? 'only administrators may edit the record while it is pending' : recordEditability === 'AdminOrCurrentApprover' ? 'administrators and the current approver may edit the record while it is pending' : `declared value \`${recordEditability}\``}. This is the DECLARED lock policy; whether a particular user is an administrator or the current approver is runtime data.`,
    ...(recordEditability === null
      ? {
          unresolvedReason:
            'This process\'s `<recordEditability>` element was not extracted, so who may edit a pending record is unresolved — NOT a finding that the record is unlocked.',
        }
      : {}),
  });

  // ---- 5-7. per-step chain ------------------------------------------------
  for (const fact of stepFacts) {
    const stepLabel = fact.label ?? fact.name ?? `step ${fact.stepIndex + 1}`;

    // 5. step entry criteria
    const hasStepCriteria =
      fact.entryCriteriaFormula !== null || fact.entryCriteriaItemCount > 0;
    steps.push({
      phase: 'step-entry-criteria',
      title: `Step ${fact.stepIndex + 1} (${stepLabel}) — entry criteria`,
      resolution: hasStepCriteria ? 'resolved' : 'verified-none',
      components: [],
      note: hasStepCriteria
        ? `LISTED, NOT EVALUATED. When the record does not satisfy it, \`ifCriteriaNotMet: ${fact.ifCriteriaNotMet ?? 'not declared'}\` decides what happens${fact.ifCriteriaNotMet === 'ApproveRecord' ? ' — the record is APPROVED without this step running' : fact.ifCriteriaNotMet === 'RejectRecord' ? ' — the record is REJECTED' : fact.ifCriteriaNotMet === 'GoToNextStep' ? ' — the step is skipped and evaluation moves on' : ''}.`
        : 'This step declares no entry criteria, so it always evaluates when reached.',
      ...(hasStepCriteria
        ? {
            conditions: [
              {
                source: 'stepEntryCriteria',
                expression: fact.entryCriteriaFormula ?? '',
                ...(fact.entryCriteriaItemCount > 0
                  ? { criteriaItemCount: fact.entryCriteriaItemCount }
                  : {}),
              },
            ],
          }
        : {
            absenceBasis:
              'The step\'s `<entryCriteria>` element is absent from this process\'s own extracted metadata — a DECLARED absence read off the component.',
          }),
    });

    // 6. approver assignment
    const approverEdges = outEdges.filter(
      (e) =>
        e.edgeType === 'references' &&
        e.properties['stepIndex'] === fact.stepIndex &&
        e.properties['approverType'] !== undefined,
    );
    const approverRefs = approverEdges.map((e) =>
      refFor(
        e.toId,
        'approver',
        'unresolved',
        `approver type \`${String(e.properties['approverType'])}\`${e.properties['includeSubordinates'] === true ? ' (includes subordinates)' : ''}${e.properties['viaNextAutomatedApprover'] === true ? ' (resolved from the process-level nextAutomatedApprover hierarchy field)' : ''}`,
      ),
    );
    const namelessApprovers = fact.approvers.filter((a) => a.name === null);
    const multiApprover = fact.approvers.length > 1;
    // No resolvable approver id — whether that is an unnamed hierarchy/adhoc
    // approver or a step with no `<assignedApprover>` at all, the identity of
    // who approves here is UNRESOLVED. It is never a verified none: an approval
    // step ALWAYS has an approver at runtime, so an empty roster is a hole.
    const approverResolution = approverRefs.length > 0 ? 'resolved' : 'unresolved';
    steps.push({
      phase: 'approver-assignment',
      title: `Step ${fact.stepIndex + 1} (${stepLabel}) — approver assigned`,
      resolution: approverResolution,
      components: approverRefs,
      note: `${fact.approvers.length} declared approver(s) on this step.${namelessApprovers.length > 0 ? ` ${namelessApprovers.length} of them carry a type but no name (${[...new Set(namelessApprovers.map((a) => a.type ?? 'unknown'))].join(', ')}).` : ''}${multiApprover ? ' MULTIPLE approvers are assigned.' : ''}`,
      ...(approverRefs.length === 0
        ? { unresolvedReason: NAMELESS_APPROVER_UNRESOLVED }
        : multiApprover
          ? {
              gate: {
                setting: 'assignedApprover.whenMultipleApprovers (unanimous vs first-response)',
                status: 'unresolved',
                reason: MULTI_APPROVER_UNRESOLVED,
              },
            }
          : {}),
    });

    // 7a. approve branch
    if (outcomeIncludes(options.outcome, 'approve')) {
      const built = actionRefs(
        fact.approvalActions,
        objectApiName,
        'step-approval-action',
        resolvedIds,
      );
      steps.push({
        phase: 'step-approval-actions',
        title: `Step ${fact.stepIndex + 1} (${stepLabel}) — actions on APPROVE`,
        resolution:
          fact.approvalActions.length === 0
            ? 'verified-none'
            : built.hasUnresolvedFieldUpdate
              ? 'unresolved'
              : 'resolved',
        components: built.refs,
        note:
          fact.approvalActions.length === 0
            ? 'This step declares no approve actions; approval simply advances to the next step (or to final approval).'
            : 'Actions the step fires when its approver approves, then evaluation advances.',
        ...(fact.approvalActions.length === 0
          ? {
              absenceBasis:
                'The step\'s `<approvalActions>` element is absent or empty on this process\'s own extracted metadata — a DECLARED absence read off the component.',
            }
          : built.hasUnresolvedFieldUpdate
            ? { unresolvedReason: STEP_FIELD_UPDATE_UNRESOLVED }
            : {}),
      });
    }

    // 7b. reject branch
    if (outcomeIncludes(options.outcome, 'reject')) {
      const built = actionRefs(
        fact.rejectionActions,
        objectApiName,
        'step-rejection-action',
        resolvedIds,
      );
      steps.push({
        phase: 'step-rejection-actions',
        title: `Step ${fact.stepIndex + 1} (${stepLabel}) — actions on REJECT`,
        resolution:
          fact.rejectionActions.length === 0
            ? 'verified-none'
            : built.hasUnresolvedFieldUpdate
              ? 'unresolved'
              : 'resolved',
        components: built.refs,
        note: `${fact.rejectionActions.length === 0 ? 'This step declares no reject actions. ' : 'Actions the step fires when its approver rejects. '}\`rejectBehavior: ${fact.rejectBehaviorType ?? 'not declared'}\` — ${fact.rejectBehaviorType === 'BackToPrevious' ? 'a rejection returns the request to the PREVIOUS step rather than ending it, so the final-rejection actions below do not necessarily fire' : fact.rejectBehaviorType === 'RejectRequest' ? 'a rejection ends the whole request, so the final-rejection actions below fire' : 'the declared reject behaviour was not extracted for this step'}.`,
        ...(fact.rejectionActions.length === 0
          ? {
              absenceBasis:
                'The step\'s `<rejectionActions>` element is absent or empty on this process\'s own extracted metadata — a DECLARED absence read off the component.',
            }
          : built.hasUnresolvedFieldUpdate
            ? { unresolvedReason: STEP_FIELD_UPDATE_UNRESOLVED }
            : {}),
      });
    }
  }

  if (stepFacts.length === 0) {
    steps.push({
      phase: 'step-entry-criteria',
      title: 'Approval steps',
      resolution: 'unresolved',
      components: [],
      note: `This process node carries \`stepCount: ${String(props['stepCount'] ?? 'unknown')}\` but no structured \`steps\` breakdown.`,
      unresolvedReason:
        'The per-step breakdown (`properties.steps`) is absent from this ApprovalProcess node — typically a vault refreshed before the structured step extraction shipped. The step sequence is therefore UNRESOLVED, NOT a finding that the process has no steps. Re-run `sfi refresh`.',
    });
  }

  // ---- 8. final approval --------------------------------------------------
  if (outcomeIncludes(options.outcome, 'approve')) {
    const finalApprovalActions = readHookActions(process, 'finalApprovalActions');
    const finalApprovalState = hookResolution(finalApprovalActions, 'finalApprovalActions');
    const finalApprovalEdges = outEdges.filter(
      (e) => e.properties['hookType'] === 'finalApproval',
    );
    steps.push({
      phase: 'final-approval-actions',
      title: 'Final approval actions fire',
      resolution: finalApprovalState.resolution,
      components: finalApprovalEdges.map((e) =>
        refFor(
          e.toId,
          'final-approval-action',
          'unresolved',
          `declared ${String(e.properties['actionType'] ?? e.edgeType)}`,
        ),
      ),
      note: 'Fired once the LAST step approves.',
      ...finalApprovalState.extra,
    });
    steps.push({
      phase: 'final-lock',
      title: 'Record lock after final approval',
      resolution: 'resolved',
      components: [],
      note: `\`finalApprovalRecordLock: ${String(props['finalApprovalRecordLock'] ?? 'not declared')}\` — ${props['finalApprovalRecordLock'] === true ? 'the record STAYS LOCKED after final approval' : 'the record is UNLOCKED after final approval'}.`,
    });
  }

  // ---- 9. final rejection -------------------------------------------------
  if (outcomeIncludes(options.outcome, 'reject')) {
    const finalRejectionActions = readHookActions(process, 'finalRejectionActions');
    const finalRejectionState = hookResolution(finalRejectionActions, 'finalRejectionActions');
    const finalRejectionEdges = outEdges.filter(
      (e) => e.properties['hookType'] === 'finalRejection',
    );
    steps.push({
      phase: 'final-rejection-actions',
      title: 'Final rejection actions fire',
      resolution: finalRejectionState.resolution,
      components: finalRejectionEdges.map((e) =>
        refFor(
          e.toId,
          'final-rejection-action',
          'unresolved',
          `declared ${String(e.properties['actionType'] ?? e.edgeType)}`,
        ),
      ),
      note: 'Fired when a rejection ends the request (see each step\'s `rejectBehavior`).',
      ...finalRejectionState.extra,
    });
    steps.push({
      phase: 'final-lock',
      title: 'Record lock after final rejection',
      resolution: 'resolved',
      components: [],
      note: `\`finalRejectionRecordLock: ${String(props['finalRejectionRecordLock'] ?? 'not declared')}\` — ${props['finalRejectionRecordLock'] === true ? 'the record STAYS LOCKED after final rejection' : 'the record is UNLOCKED after final rejection'}.`,
    });
  }

  // ---- 10. recall ---------------------------------------------------------
  if (outcomeIncludes(options.outcome, 'recall')) {
    const allowRecall = props['allowRecall'] === true;
    const recallActions = readHookActions(process, 'recallActions');
    const recallState = hookResolution(recallActions, 'recallActions');
    const recallEdges = outEdges.filter((e) => e.properties['hookType'] === 'recall');
    steps.push({
      phase: 'recall',
      title: 'Request recalled',
      // `allowRecall: false` is a DECLARED org fact and outranks the hook-list
      // state: the branch is unreachable, so whether its action list was
      // extracted is moot.
      resolution: !allowRecall ? 'verified-none' : recallState.resolution,
      components: allowRecall
        ? recallEdges.map((e) =>
            refFor(
              e.toId,
              'recall-action',
              'unresolved',
              `declared ${String(e.properties['actionType'] ?? e.edgeType)}`,
            ),
          )
        : [],
      note: allowRecall
        ? 'The submitter (or an administrator) may recall a pending request; the record unlocks and these actions fire.'
        : 'This process declares `allowRecall: false`, so the recall branch cannot be taken at all.',
      ...(!allowRecall
        ? {
            absenceBasis:
              'The process declares `allowRecall: false` — a DECLARED org fact read directly off the component, not an inference from missing metadata. The recall branch is unreachable for this process.',
          }
        : recallState.resolution === 'verified-none'
          ? {
              absenceBasis:
                'Recall is allowed but the `<recallActions>` element is absent or empty — a DECLARED absence read off the component. The record still unlocks; no configured action fires.',
            }
          : recallState.extra),
    });
  }

  // ---- 11. field-update re-entry -----------------------------------------
  const fieldUpdateWrites = outEdges.filter((e) => e.edgeType === 'writesTo');
  const reentryNested =
    options.nestedSaveDepth === 0
      ? suppressedNestedSave(objectApiName, 'update')
      : await composeNestedSave(ctx, objectApiName, 'update', 1, options.soeDisclosureSink);
  steps.push({
    phase: 'field-update-reentry',
    title: 'Approval field updates re-enter the record save order',
    resolution: fieldUpdateWrites.length > 0 ? 'resolved' : 'unresolved',
    components: fieldUpdateWrites.map((e) =>
      refFor(
        e.toId,
        'field-update-target',
        'CustomField',
        `written by the \`${String(e.properties['hookType'] ?? 'unknown')}\` hook (operation: ${String(e.properties['operation'] ?? 'not declared')})`,
      ),
    ),
    note: `A field update fired by an approval action WRITES to the record, and that write re-enters the object's ordinary update order of execution — it can fire before/after-update triggers, record-triggered flows, and (when the field update is configured to re-evaluate them) workflow rules. The nested chain attached here is the chain such a write WOULD enter; it is NOT a claim that any of it runs, because whether a field update fires depends on the branch the request actually took. ${reentryNested.suppressedByDepthCap === true ? 'Expansion suppressed by `nestedSaveDepth: 0`.' : `${reentryNested.summary.activeComponents} active automation component(s) sit on a ${objectApiName} update.`}`,
    ...(fieldUpdateWrites.length === 0
      ? { unresolvedReason: STEP_FIELD_UPDATE_UNRESOLVED }
      : {}),
    nestedSave: reentryNested,
  });

  return ok({
    componentId: process.id,
    apiName: process.apiName,
    active,
    stepCount: typeof props['stepCount'] === 'number' ? props['stepCount'] : stepFacts.length,
    chain: steps.map((step, stepIndex) => ({ ...step, stepIndex })),
  });
};

/** Disclosures every approval-chain response carries. */
export const approvalChainDisclosures = (
  processCount: number,
): readonly string[] => [
  EMAIL_APPROVAL_NOT_MODELED,
  ...(processCount > 1 ? [PROCESS_ORDER_NOT_MODELED] : []),
];
