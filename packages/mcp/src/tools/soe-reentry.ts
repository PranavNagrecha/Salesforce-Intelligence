/**
 * SOE-REENTRY — which steps of a save write back to the object being saved,
 * what Salesforce runs again because of it, and whether a recursion guard is
 * visible. The classic "why did my flow/trigger run twice" answer.
 *
 * Only what the documented order of execution says is encoded (Apex Developer
 * Guide, "Triggers and Order of Execution"); each write-back names the rule it
 * relies on and `rules` quotes it. Three write-back mechanisms:
 *
 *   - `workflow-field-update` — a WorkflowRule's immediate field update on this
 *     object (`writesTo`, parsed from the XML; time-triggered updates excluded:
 *     they fire later, in their own save).
 *   - `flow-dml` — a record-triggered Flow whose Update/Create
 *     Records targets this object. Read from the flow's SOURCE (each DML element,
 *     reachable from the start's immediate or scheduled connectors): a `$Record`
 *     update, or an `<object>` update filtered to the current record's Id, is the
 *     triggering record; any other update is "records of this object". DML on a
 *     scheduled/async path is a separate later save (`when: scheduled-path`).
 *     When the source is unreadable the graph's `writesTo` edges are the
 *     fallback, disclosed in `flowSourceUnread` (object-level DML edges of one
 *     flow can collapse into one there).
 *   - `apex-dml` — an insert/update/upsert DML site in the trigger or the handler
 *     classes it calls whose operand is attributed to this object
 *     (`apex-dml-index`, inferred). Which trigger context runs it is not resolved.
 *
 * What re-runs depends on the mechanism: a workflow field update re-runs the
 * update triggers once (no flows); flow/process DML and Apex DML re-run
 * before-save flows and triggers. `rerunOnUpdate` says which.
 *
 * Before-save writes are NOT re-entry: they fold into the pending save.
 * Cross-object writes are listed one hop as `cascades`, with the count of active
 * automation on the target object; the target's own automation is not expanded.
 *
 * ONE module for `what_happens_on_save` and `order_of_execution`.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ComponentId, Edge, Node } from '@sf-intelligence/contracts';
import {
  FLOW_START_SENTINEL,
  listWorkflowFieldUpdates,
  parseFlowGraphSource,
  type FlowGraphProjection,
  type RecordOp,
} from '@sf-intelligence/extractors';
import { listEdges, listEdgesForNodes, listNodesByIds } from '@sf-intelligence/graph';
import { detectRecursionGuard, type RecursionGuardKind } from '@sf-intelligence/patterns';
import { resolveVaultSourcePath } from '@sf-intelligence/vault';

import type { Context } from '../server.js';

import { apexDmlFactsFor, dmlActsOn } from './apex-dml-index.js';
import { isActiveSoeFirer } from './soe-active.js';
import { flowMatchesEvent, triggerMatchesEvent } from './soe-event-match.js';
import { enrichTriggerStepsWithHandlerEffects, type SoeHandlerEffects } from './soe-trigger-effects.js';

/** The documented rules a write-back can rely on, quoted in `rules`. */
export const REENTRY_RULES = {
  'workflow-field-update':
    'Apex Developer Guide, "Triggers and Order of Execution", workflow step: if workflow field updates change the record, it is updated again, system validations re-run, and before-update and after-update triggers run one more time (only once), on insert or update. Custom validation rules, flows, duplicate rules, processes and escalation rules do not run again.',
  'reevaluate-workflow':
    'A field update marked "Re-evaluate Workflow Rules after Field Change" that changes the value re-evaluates every workflow rule on the object.',
  'recursive-save':
    'Apex Developer Guide, "Triggers and Order of Execution", flow step: when a flow or process does DML, the affected record goes through the save procedure again. A recursive save skips assignment rules through grandparent roll-ups (no workflow, processes or after-save flows); before-save flows, before triggers, validation, duplicate rules and after triggers run again.',
  'dml-save':
    'DML on other or new records of this object saves them with their own order of execution, so the object\'s triggers and flows fire for them. Whether the recursive-save skip applies is not resolved here.',
  'apex-dml':
    'Apex DML on records of this object is a new save of them: the order of execution runs for them (before-save flows, triggers, validation and on), so the object\'s triggers fire again (Apex recursion; the platform stops at trigger depth 16). Which later steps a nested save skips is not resolved here.',
  'async-save':
    'Salesforce Help, flow scheduled and asynchronous paths: they run after this transaction commits, in a separate transaction. Their DML is a new save that runs this object\'s automation again.',
} as const;

export type ReentryRule = keyof typeof REENTRY_RULES;
export type ReentryTier = 'declared' | 'parsed' | 'heuristic';
export type ReentryMechanism = 'workflow-field-update' | 'flow-dml' | 'apex-dml';
export type ReentryTarget = 'triggering-record' | 'records-of-object' | 'new-records-of-object';

export interface SoeReentryWriteBack {
  /** `stepIndex` in this response's `soe` (what_happens_on_save only). */
  readonly step?: number;
  readonly componentId: ComponentId;
  readonly mechanism: ReentryMechanism;
  readonly target: ReentryTarget;
  /** Further targets the same component writes on this object (e.g. it updates `$Record` AND creates a sibling). */
  readonly alsoTargets?: readonly ReentryTarget[];
  /**
   * `scheduled-path`: the DML runs on a scheduled/async flow path — a separate,
   * later save, not a re-run inside this one. `timing-unknown`: the vault predates
   * flow timing and the flow source was unreadable, so it may be that.
   */
  readonly when?: 'scheduled-path' | 'timing-unknown';
  /** order_of_execution only: the DML events this write-back's step fires on. */
  readonly on?: readonly string[];
  /** Fields written on this object (field api names), when the source names them. */
  readonly fields?: readonly string[];
  readonly fieldsOmitted?: number;
  /** apex-dml: the DML sites (`Component:line op`), first 3. */
  readonly sites?: readonly string[];
  readonly rules: readonly ReentryRule[];
  readonly tier: ReentryTier;
}

export interface SoeReentryTrigger {
  readonly componentId: ComponentId;
  /** Which of its update contexts fire on the re-save. */
  readonly fires: 'before update' | 'after update' | 'before and after update';
  /**
   * The recursion-guard shape found in the trigger or its handler chain, or
   * `none-visible` (no recognized shape in the files read — NOT proof the save
   * is unguarded), or `not-read` (source unreadable).
   */
  readonly guard: RecursionGuardKind | 'none-visible' | 'not-read';
  /** Where the guard was seen (the trigger itself or a handler class). */
  readonly guardIn?: ComponentId;
}

export interface SoeReentryCascade {
  readonly step?: number;
  readonly componentId: ComponentId;
  /** Target object api name; null for a workflow cross-object update (relationship only). */
  readonly object: string | null;
  readonly via?: string;
  readonly operation: string;
  /** The write runs on a scheduled/async flow path (a later, separate save). */
  readonly when?: 'scheduled-path';
  /** Active triggers/flows/workflow rules on the target object (null = not resolved). */
  readonly targetAutomation: number | null;
  readonly tier: ReentryTier;
}

export interface SoeReentry {
  readonly writeBacks: readonly SoeReentryWriteBack[];
  readonly writeBacksOmitted?: number;
  /**
   * What the same-transaction UPDATE write-backs re-run on this object. Present
   * only when one exists (inserts and scheduled-path writes are separate saves,
   * see their rules). Every mechanism re-runs the update `triggers`;
   * `beforeSaveFlowsRerunBy` names the mechanisms that also re-run before-save
   * flows — `[]` means none do (a workflow field update does not), and then
   * `beforeSaveFlows` is omitted.
   */
  readonly rerunOnUpdate?: {
    readonly triggers: readonly SoeReentryTrigger[];
    readonly beforeSaveFlowsRerunBy: readonly Exclude<ReentryMechanism, 'workflow-field-update'>[];
    readonly beforeSaveFlows?: readonly ComponentId[];
    readonly omitted?: number;
  };
  readonly cascades: readonly SoeReentryCascade[];
  readonly cascadesOmitted?: number;
  /** The rule text for every rule key used above. */
  readonly rules: Partial<Record<ReentryRule, string>>;
  /** Flows whose source could not be read: their DML came from graph edges (less exact). */
  readonly flowSourceUnread?: { readonly flows: readonly ComponentId[]; readonly omitted?: number; readonly note: string };
  readonly notModeled: string;
}

/** Minimal step shape both SOE tools satisfy. */
export interface ReentryStepLike {
  readonly phase: string;
  readonly stepIndex?: number;
  readonly componentId: ComponentId;
  readonly componentType: string;
  readonly timing?: 'async-only' | 'unknown';
  readonly handlerEffects?: { readonly handlerChain: readonly ComponentId[] };
  /** order_of_execution: the DML event this step was composed for. */
  readonly event?: string;
}

const MAX_WRITEBACKS = 12;
const MAX_FIELDS = 6;
const MAX_SITES = 3;
const MAX_CASCADES = 8;
const MAX_RERUN_TRIGGERS = 10;

export const SOE_REENTRY_NOT_MODELED =
  'Conditions are not evaluated. Not listed: approval-process field updates, time-triggered workflow updates, Process Builder processes (not linked to their object in the vault, so absent from this save order), deletes of this object\'s own records, DML inside subflows or invocable actions, flow elements not connected to the start, Apex field writes without DML, Apex merge and lead conversion calls. A cascade target\'s automation is counted, not expanded.';

const FLOW_SOURCE_UNREAD_NOTE =
  'Flow source unreadable: DML read from graph edges, where one flow\'s several same-object DML elements can collapse into one edge, so the target is a best guess and scheduled paths are not separated.';
const MAX_UNREAD_FLOWS = 5;

const fieldOf = (toId: string, objectApiName: string): string | null => {
  const prefix = `CustomField:${objectApiName}.`;
  return toId.toLowerCase().startsWith(prefix.toLowerCase()) ? toId.slice(prefix.length) : null;
};

const objectOfFieldId = (toId: string): string | null => {
  if (!toId.startsWith('CustomField:')) return null;
  const rest = toId.slice('CustomField:'.length);
  const dot = rest.indexOf('.');
  return dot > 0 ? rest.slice(0, dot) : null;
};

const capFields = (fields: readonly string[]): Pick<SoeReentryWriteBack, 'fields' | 'fieldsOmitted'> => {
  const uniq = [...new Set(fields)].sort();
  if (uniq.length === 0) return {};
  return uniq.length > MAX_FIELDS
    ? { fields: uniq.slice(0, MAX_FIELDS), fieldsOmitted: uniq.length - MAX_FIELDS }
    : { fields: uniq };
};

const stepRef = (s: ReentryStepLike): { step?: number } =>
  s.stepIndex === undefined ? {} : { step: s.stepIndex };

const sameObject = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Read the object's workflow file once — from a WorkflowRule node's own
 * `sourcePath`, else the conventional path; null when absent/unreadable.
 */
const readWorkflowDefs = async (
  ctx: Context,
  objectApiName: string,
  sourcePaths: readonly string[],
): Promise<ReturnType<typeof listWorkflowFieldUpdates> | null> => {
  const candidates = [
    ...sourcePaths.map((p) => resolveVaultSourcePath(ctx.vaultRoot, p)),
    join(ctx.vaultRoot, 'source', 'workflows', `${objectApiName}.workflow-meta.xml`),
  ];
  for (const path of [...new Set(candidates)]) {
    try {
      return listWorkflowFieldUpdates(await readFile(path, 'utf-8'));
    } catch {
      // try the next candidate
    }
  }
  return null;
};

const readSource = async (ctx: Context, node: Node | undefined): Promise<string | null> => {
  if (node === undefined || node.sourcePath === null || node.sourcePath.length === 0) return null;
  try {
    return await readFile(resolveVaultSourcePath(ctx.vaultRoot, node.sourcePath), 'utf-8');
  } catch {
    return null;
  }
};

/** What one flow's DML does to this object and to others, for one timing. */
interface FlowDmlSummary {
  triggeringRecord: boolean;
  otherRecords: boolean;
  creates: boolean;
  readonly fields: string[];
  readonly others: Map<string, Set<string>>;
}

const emptySummary = (): FlowDmlSummary => ({
  triggeringRecord: false,
  otherRecords: false,
  creates: false,
  fields: [],
  others: new Map(),
});

const addOther = (sum: FlowDmlSummary, obj: string, op: string): void => {
  const ops = sum.others.get(obj) ?? new Set<string>();
  ops.add(op);
  sum.others.set(obj, ops);
};

const DML_OP: Partial<Record<RecordOp['kind'], string>> = {
  create: 'recordCreate',
  update: 'recordUpdate',
  delete: 'recordDelete',
};

/** `Id = $Record.Id` (or a process's `myVariable_current.Id`) with AND logic: the triggering record. */
const filtersToCurrentRecord = (op: RecordOp): boolean =>
  (op.filterLogic === null || op.filterLogic.toLowerCase() === 'and') &&
  op.filters.some(
    (f) =>
      f.leftValueReference.toLowerCase() === 'id' &&
      f.operator === 'EqualTo' &&
      f.rightValueKind === 'reference' &&
      f.rightValue !== null &&
      /^(\$record|myvariable_current)\.id$/i.test(f.rightValue),
  );

/** Element names reachable from the start's immediate vs scheduled connectors. */
const reachableFromStart = (proj: FlowGraphProjection): { immediate: Set<string>; scheduled: Set<string> } => {
  const next = new Map<string, string[]>();
  for (const c of proj.connectors) {
    if (c.from === FLOW_START_SENTINEL) continue;
    const list = next.get(c.from) ?? [];
    list.push(c.to);
    next.set(c.from, list);
  }
  const walk = (seeds: readonly string[]): Set<string> => {
    const seen = new Set<string>();
    const queue = [...seeds];
    while (queue.length > 0) {
      const n = queue.pop() as string;
      if (seen.has(n)) continue;
      seen.add(n);
      queue.push(...(next.get(n) ?? []));
    }
    return seen;
  };
  const fromStart = proj.connectors.filter((c) => c.from === FLOW_START_SENTINEL);
  return {
    immediate: walk(fromStart.filter((c) => c.kind !== 'scheduled').map((c) => c.to)),
    scheduled: walk(fromStart.filter((c) => c.kind === 'scheduled').map((c) => c.to)),
  };
};

/**
 * Summarize a flow's DML from its parsed source. An element reachable from the
 * immediate start counts as immediate even if a scheduled path also reaches it.
 */
const summarizeFlowSource = (
  proj: FlowGraphProjection,
  objectApiName: string,
): { immediate: FlowDmlSummary; scheduled: FlowDmlSummary } => {
  const reach = reachableFromStart(proj);
  const out = { immediate: emptySummary(), scheduled: emptySummary() };
  for (const op of proj.recordOps) {
    const opName = DML_OP[op.kind];
    if (opName === undefined || op.object === null) continue;
    const sum = reach.immediate.has(op.name) ? out.immediate : reach.scheduled.has(op.name) ? out.scheduled : null;
    if (sum === null) continue;
    if (!sameObject(op.object, objectApiName)) {
      addOther(sum, op.object, opName);
      continue;
    }
    if (op.kind === 'delete') continue;
    if (op.kind === 'create') sum.creates = true;
    else if (op.objectResolution === 'triggerRecord' || filtersToCurrentRecord(op)) sum.triggeringRecord = true;
    else sum.otherRecords = true;
    sum.fields.push(...op.inputAssignments.map((a) => a.field));
  }
  return out;
};

/**
 * Fallback when the flow source is unreadable: summarize its `writesTo` edges.
 * Object-level DML edges of one flow share a graph key, so a `$Record` update
 * can be hidden behind a create/delete edge of the same object: a same-object
 * field-level update edge is evidence of an update even then.
 */
const summarizeFlowEdges = (edges: readonly Edge[], objectApiName: string): FlowDmlSummary => {
  const sum = emptySummary();
  let fieldUpdate = false;
  for (const e of edges) {
    if (e.edgeType !== 'writesTo') continue;
    const op = e.properties['operation'];
    if (op !== 'recordUpdate' && op !== 'recordCreate' && op !== 'recordDelete') continue;
    if (e.toId.startsWith('CustomObject:')) {
      const obj = e.toId.slice('CustomObject:'.length);
      if (!sameObject(obj, objectApiName)) addOther(sum, obj, op);
      else if (op === 'recordCreate') sum.creates = true;
      else if (op === 'recordUpdate') {
        // `$Record` update: object inferred from the trigger (heuristic, no
        // record-variable marker); otherwise any records of this object.
        if (e.confidence === 'heuristic' && e.properties['inputReferenceKind'] === undefined) sum.triggeringRecord = true;
        else sum.otherRecords = true;
      }
      continue;
    }
    if (op === 'recordDelete') continue;
    const f = fieldOf(e.toId, objectApiName);
    if (f !== null) {
      sum.fields.push(f);
      if (op === 'recordUpdate') fieldUpdate = true;
      continue;
    }
    const other = objectOfFieldId(e.toId);
    if (other !== null && !sameObject(other, objectApiName)) addOther(sum, other, op);
  }
  if (fieldUpdate && !sum.triggeringRecord && !sum.otherRecords) sum.otherRecords = true;
  return sum;
};

const targetsOf = (sum: FlowDmlSummary): ReentryTarget[] => [
  ...(sum.triggeringRecord ? (['triggering-record'] as const) : []),
  ...(sum.otherRecords ? (['records-of-object'] as const) : []),
  ...(sum.creates ? (['new-records-of-object'] as const) : []),
];

/**
 * Build the re-entry report for one object from the composed SOE steps. A failed
 * graph query yields `null` (the caller discloses "not checked"); it never
 * yields an empty report, which would read as "no re-entry".
 */
export const buildSoeReentry = async (
  ctx: Context,
  objectApiName: string,
  steps: readonly ReentryStepLike[],
): Promise<SoeReentry | null> => {
  const objectId = `CustomObject:${objectApiName}`;
  const writeBacks: SoeReentryWriteBack[] = [];
  const cascades: SoeReentryCascade[] = [];

  // order_of_execution composes several events: remember which ones each step fires on.
  const eventsOf = new Map<ComponentId, Set<string>>();
  for (const s of steps) {
    if (s.event === undefined) continue;
    const set = eventsOf.get(s.componentId) ?? new Set<string>();
    set.add(s.event);
    eventsOf.set(s.componentId, set);
  }
  const onOf = (id: ComponentId): { on?: readonly string[] } => {
    const set = eventsOf.get(id);
    return set === undefined ? {} : { on: [...set].sort() };
  };

  // --- workflow + flow write-backs: one batched out-edge read --------------
  const wfSteps = steps.filter((s) => s.phase === 'post-save-workflows' && s.componentType === 'WorkflowRule');
  // After-save flows, including scheduled-only ones (listed in post-save-async):
  // their scheduled-path DML is reported as a separate later save.
  const flowSteps = steps.filter(
    (s) => s.componentType === 'Flow' && (s.phase === 'post-save-flows' || s.phase === 'post-save-async'),
  );
  const declarative = [...new Set([...wfSteps, ...flowSteps].map((s) => s.componentId))];
  const outEdges =
    declarative.length === 0
      ? new Map<ComponentId, readonly Edge[]>()
      : await listEdgesForNodes(ctx.graph, declarative, {
          direction: 'out',
          edgeTypes: ['writesTo', 'references'],
        }).then((r) => (r.ok ? r.value : null));
  if (outEdges === null) return null;
  const declNodesR = declarative.length === 0 ? { ok: true as const, value: [] as Node[] } : await listNodesByIds(ctx.graph, declarative);
  if (!declNodesR.ok) return null;
  const declNode = new Map(declNodesR.value.map((n) => [n.id, n]));

  const wfDefs =
    wfSteps.length > 0
      ? await readWorkflowDefs(
          ctx,
          objectApiName,
          wfSteps.flatMap((s) => {
            const sp = declNode.get(s.componentId)?.sourcePath;
            return sp === null || sp === undefined || sp.length === 0 ? [] : [sp];
          }),
        )
      : null;
  const wfDefByName = new Map((wfDefs ?? []).map((d) => [d.name, d]));
  const seen = new Set<ComponentId>();
  for (const s of wfSteps) {
    if (seen.has(s.componentId)) continue;
    seen.add(s.componentId);
    const edges = outEdges.get(s.componentId) ?? [];
    const fields: string[] = [];
    let reevaluates = false;
    for (const e of edges) {
      if (e.edgeType === 'writesTo' && e.properties['timeTriggered'] !== true) {
        const f = fieldOf(e.toId, objectApiName);
        if (f !== null) fields.push(f);
      }
      if (e.edgeType === 'references' && e.toId.startsWith('WorkflowFieldUpdate:') && e.properties['timeTriggered'] !== true) {
        const name = e.toId.slice(e.toId.indexOf('.') + 1);
        const def = wfDefByName.get(name);
        if (def === undefined) continue;
        if (def.targetObject !== null) {
          cascades.push({
            ...stepRef(s),
            componentId: s.componentId,
            object: null,
            via: def.targetObject,
            operation: `field update ${def.field ?? '?'}`,
            targetAutomation: null,
            tier: 'declared',
          });
        } else if (def.reevaluateOnChange) {
          reevaluates = true;
        }
      }
    }
    if (fields.length === 0) continue;
    writeBacks.push({
      ...stepRef(s),
      componentId: s.componentId,
      mechanism: 'workflow-field-update',
      target: 'triggering-record',
      ...onOf(s.componentId),
      ...capFields(fields),
      rules: reevaluates ? ['workflow-field-update', 'reevaluate-workflow'] : ['workflow-field-update'],
      tier: 'parsed',
    });
  }

  const flowSourceUnread: ComponentId[] = [];
  for (const s of flowSteps) {
    if (seen.has(s.componentId)) continue;
    seen.add(s.componentId);
    const src = await readSource(ctx, declNode.get(s.componentId));
    const parsed = src === null ? null : parseFlowGraphSource(src);
    const fromSource = parsed !== null && parsed.ok;
    let timings: Array<{ sum: FlowDmlSummary; when?: 'scheduled-path' | 'timing-unknown' }>;
    if (parsed !== null && parsed.ok) {
      const both = summarizeFlowSource(parsed.value, objectApiName);
      timings = [{ sum: both.immediate }, { sum: both.scheduled, when: 'scheduled-path' }];
    } else {
      flowSourceUnread.push(s.componentId);
      const sum = summarizeFlowEdges(outEdges.get(s.componentId) ?? [], objectApiName);
      const when = s.timing === 'async-only' ? 'scheduled-path' : s.timing === 'unknown' ? 'timing-unknown' : undefined;
      timings = [when === undefined ? { sum } : { sum, when }];
    }
    for (const { sum, when } of timings) {
      for (const [obj, ops] of sum.others) {
        cascades.push({
          ...stepRef(s),
          componentId: s.componentId,
          object: obj,
          operation: [...ops].sort().join('+'),
          ...(when === 'scheduled-path' ? { when } : {}),
          targetAutomation: null,
          tier: fromSource ? 'parsed' : 'heuristic',
        });
      }
      const targets = targetsOf(sum);
      const [target, ...alsoTargets] = targets;
      if (target === undefined) continue;
      const rules: ReentryRule[] =
        when === 'scheduled-path'
          ? ['async-save']
          : [
              ...(sum.triggeringRecord ? (['recursive-save'] as const) : []),
              ...(sum.otherRecords || sum.creates ? (['dml-save'] as const) : []),
            ];
      writeBacks.push({
        ...stepRef(s),
        componentId: s.componentId,
        mechanism: 'flow-dml',
        target,
        ...(alsoTargets.length > 0 ? { alsoTargets } : {}),
        ...(when === undefined ? {} : { when }),
        ...onOf(s.componentId),
        ...capFields(sum.fields),
        rules,
        tier: fromSource ? 'parsed' : 'heuristic',
      });
    }
  }

  // --- Apex DML write-backs -------------------------------------------------
  const triggerSteps = steps.filter((s) => s.componentType === 'ApexTrigger');
  const chainOf = new Map<ComponentId, ComponentId[]>();
  for (const s of triggerSteps) {
    const chain = chainOf.get(s.componentId) ?? [];
    for (const c of s.handlerEffects?.handlerChain ?? []) if (!chain.includes(c)) chain.push(c);
    chainOf.set(s.componentId, chain);
  }
  if (chainOf.size > 0) {
    const ids = [...new Set([...chainOf.keys(), ...[...chainOf.values()].flat()])];
    const nodesR = await listNodesByIds(ctx.graph, ids);
    if (!nodesR.ok) return null;
    // `delete` only feeds cascades: deletes of this object's own records are not listed (notModeled).
    const factsR = await apexDmlFactsFor(ctx, nodesR.value, ['insert', 'update', 'upsert', 'delete']);
    if (!factsR.ok) return null;
    for (const [triggerId, chain] of chainOf) {
      const members = new Set([triggerId, ...chain]);
      const facts = factsR.value.facts.filter((f) => members.has(f.componentId));
      const own = facts.filter((f) => f.operation !== 'delete' && dmlActsOn(f, objectApiName) !== 'no');
      if (own.length > 0) {
        const step = triggerSteps.find((s) => s.componentId === triggerId);
        const onlyInserts = own.every((f) => f.operation === 'insert');
        writeBacks.push({
          ...(step === undefined ? {} : stepRef(step)),
          componentId: triggerId,
          mechanism: 'apex-dml',
          target: onlyInserts ? 'new-records-of-object' : 'records-of-object',
          ...onOf(triggerId),
          sites: own
            .slice(0, MAX_SITES)
            .map((f) => `${f.componentId}:${f.line} ${f.operation} (${dmlActsOn(f, objectApiName)})`),
          rules: ['apex-dml'],
          tier: 'heuristic',
        });
      }
      const typedOther = new Map<string, Set<string>>();
      for (const f of facts) {
        for (const o of f.objectsTyped) {
          if (sameObject(o, objectApiName)) continue;
          const ops = typedOther.get(o) ?? new Set<string>();
          ops.add(f.operation);
          typedOther.set(o, ops);
        }
      }
      const step = triggerSteps.find((s) => s.componentId === triggerId);
      for (const [obj, ops] of typedOther) {
        cascades.push({
          ...(step === undefined ? {} : stepRef(step)),
          componentId: triggerId,
          object: obj,
          operation: [...ops].sort().join('+'),
          targetAutomation: null,
          tier: 'heuristic',
        });
      }
    }
  }

  // --- cascade targets: count active automation, one batched read ----------
  const targetObjects = [...new Set(cascades.flatMap((c) => (c.object === null ? [] : [`CustomObject:${c.object}`])))];
  const automationCount = new Map<string, number>();
  if (targetObjects.length > 0) {
    const inR = await listEdgesForNodes(ctx.graph, targetObjects, { direction: 'in', edgeTypes: ['triggersOn'] });
    if (!inR.ok) return null;
    const firerIds = [...new Set([...inR.value.values()].flat().map((e) => e.fromId))];
    const firersR = firerIds.length === 0 ? { ok: true as const, value: [] as Node[] } : await listNodesByIds(ctx.graph, firerIds);
    if (!firersR.ok) return null;
    const active = new Set(firersR.value.filter(isActiveSoeFirer).map((n) => n.id));
    for (const [id, edges] of inR.value) {
      automationCount.set(id, new Set(edges.map((e) => e.fromId).filter((f) => active.has(f))).size);
    }
  }
  const dedupedCascades = new Map<string, SoeReentryCascade>();
  for (const c of cascades) {
    const key = `${c.componentId}|${c.object ?? c.via ?? ''}|${c.operation}`;
    if (dedupedCascades.has(key)) continue;
    dedupedCascades.set(key, {
      ...c,
      targetAutomation: c.object === null ? null : (automationCount.get(`CustomObject:${c.object}`) ?? 0),
    });
  }
  const allCascades = [...dedupedCascades.values()];

  // --- what an update re-runs on this object, with visible guards ----------
  // Only same-transaction UPDATE write-backs re-run this object's update path:
  // an insert fires insert automation for the new rows (its own save), and a
  // scheduled-path write is a later, separate save.
  const updateWriteBacks = writeBacks.filter((w) => w.when !== 'scheduled-path' && w.target !== 'new-records-of-object');
  const beforeSaveFlowsRerunBy = [
    ...new Set(
      updateWriteBacks.flatMap((w) => (w.mechanism === 'workflow-field-update' ? [] : [w.mechanism])),
    ),
  ].sort();
  let rerunOnUpdate: SoeReentry['rerunOnUpdate'];
  if (updateWriteBacks.length > 0) {
    const inR = await listEdges(ctx.graph, objectId, { direction: 'in', edgeType: 'triggersOn' });
    if (!inR.ok) return null;
    const firersR = await listNodesByIds(ctx.graph, [...new Set(inR.value.map((e) => e.fromId))]);
    if (!firersR.ok) return null;
    const byId = new Map(firersR.value.map((n) => [n.id, n]));
    const beforeSaveFlows: ComponentId[] = [];
    const updateTriggers: Node[] = [];
    for (const e of inR.value) {
      const n = byId.get(e.fromId);
      if (n === undefined || !isActiveSoeFirer(n)) continue;
      if (n.type === 'Flow' && e.properties['triggerType'] === 'RecordBeforeSave' && flowMatchesEvent(e.properties['recordTriggerType'], 'update')) {
        if (!beforeSaveFlows.includes(n.id)) beforeSaveFlows.push(n.id);
      }
      if (
        n.type === 'ApexTrigger' &&
        (triggerMatchesEvent(n.properties['events'], 'update', 'before') ||
          triggerMatchesEvent(n.properties['events'], 'update', 'after')) &&
        !updateTriggers.some((t) => t.id === n.id)
      ) {
        updateTriggers.push(n);
      }
    }
    updateTriggers.sort((a, b) => (a.id < b.id ? -1 : 1));
    const shown = updateTriggers.slice(0, MAX_RERUN_TRIGGERS);
    // Handler chains for the re-run triggers (they may not be in `steps` when
    // the composed event is insert): reuse the save-order handler walk.
    const pseudo: Array<{
      componentId: ComponentId;
      componentType: string;
      actions: { kind: string; description: string }[];
      handlerEffects?: SoeHandlerEffects;
    }> = shown.map((t) => ({ componentId: t.id, componentType: 'ApexTrigger', actions: [] }));
    await enrichTriggerStepsWithHandlerEffects(ctx.graph, pseudo, objectApiName);
    const chainIds = [...new Set(pseudo.flatMap((p) => p.handlerEffects?.handlerChain ?? []))];
    const chainNodesR = chainIds.length === 0 ? { ok: true as const, value: [] as Node[] } : await listNodesByIds(ctx.graph, chainIds);
    const chainNodes = new Map((chainNodesR.ok ? chainNodesR.value : []).map((n) => [n.id, n]));
    const triggers: SoeReentryTrigger[] = [];
    for (const [i, t] of shown.entries()) {
      const before = triggerMatchesEvent(t.properties['events'], 'update', 'before');
      const after = triggerMatchesEvent(t.properties['events'], 'update', 'after');
      const fires = before && after ? 'before and after update' : before ? 'before update' : 'after update';
      const files: Node[] = [t, ...(pseudo[i]?.handlerEffects?.handlerChain ?? []).flatMap((id) => {
        const n = chainNodes.get(id);
        return n === undefined ? [] : [n];
      })];
      let guard: SoeReentryTrigger['guard'] = 'none-visible';
      let guardIn: ComponentId | undefined;
      let anyRead = false;
      for (const f of files) {
        const src = await readSource(ctx, f);
        if (src === null) continue;
        anyRead = true;
        const kind = detectRecursionGuard(src);
        if (kind !== null) {
          guard = kind;
          guardIn = f.id;
          break;
        }
      }
      if (!anyRead) guard = 'not-read';
      triggers.push({ componentId: t.id, fires, guard, ...(guardIn === undefined ? {} : { guardIn }) });
    }
    rerunOnUpdate = {
      triggers,
      beforeSaveFlowsRerunBy,
      ...(beforeSaveFlowsRerunBy.length > 0 ? { beforeSaveFlows: beforeSaveFlows.sort() } : {}),
      ...(updateTriggers.length > shown.length ? { omitted: updateTriggers.length - shown.length } : {}),
    };
  }

  const usedRules = new Set<ReentryRule>(writeBacks.flatMap((w) => w.rules));
  const rules: Partial<Record<ReentryRule, string>> = {};
  for (const r of Object.keys(REENTRY_RULES) as ReentryRule[]) if (usedRules.has(r)) rules[r] = REENTRY_RULES[r];

  return {
    writeBacks: writeBacks.slice(0, MAX_WRITEBACKS),
    ...(writeBacks.length > MAX_WRITEBACKS ? { writeBacksOmitted: writeBacks.length - MAX_WRITEBACKS } : {}),
    ...(rerunOnUpdate === undefined ? {} : { rerunOnUpdate }),
    cascades: allCascades.slice(0, MAX_CASCADES),
    ...(allCascades.length > MAX_CASCADES ? { cascadesOmitted: allCascades.length - MAX_CASCADES } : {}),
    rules,
    ...(flowSourceUnread.length === 0
      ? {}
      : {
          flowSourceUnread: {
            flows: flowSourceUnread.slice(0, MAX_UNREAD_FLOWS),
            ...(flowSourceUnread.length > MAX_UNREAD_FLOWS ? { omitted: flowSourceUnread.length - MAX_UNREAD_FLOWS } : {}),
            note: FLOW_SOURCE_UNREAD_NOTE,
          },
        }),
    notModeled: SOE_REENTRY_NOT_MODELED,
  };
};

/** Shipped instead of `reentry` when a graph query behind it failed. */
export const REENTRY_NOT_CHECKED =
  'Re-entry was NOT checked (a vault query failed) — this is not "no re-entry".';
