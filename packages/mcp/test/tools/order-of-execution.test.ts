/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  Edge,
  ExtractionResult,
  Node,
  VaultManifest,
} from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  orderOfExecutionHandler,
  orderOfExecutionInputSchema,
} from '../../src/tools/order-of-execution.js';
import {
  SOE_MAX_PAYLOAD_BYTES,
  tallyPhaseCounts,
} from '../../src/tools/soe-payload-bounds.js';
import { jsonResult } from '../../src/tools/tool-dispatch.js';

import { measureGraphQueries } from './_graph-query-budget.js';

const utf8Bytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), 'utf8');

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 3 },
  edges: { parentOf: 2, triggersOn: 3, firesWhen: 1 },
  sourceTreeHash: 'sha256:fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'Account',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...overrides,
});

// =============================================================================
// Seed 1: empty object — no automation. Per-event payloads carry only
// the save placeholder.
// =============================================================================

const EMPTY_OBJ = 'CustomObject:EmptyObj';

const emptySeed: ExtractionResult = {
  nodes: [makeNode({ id: EMPTY_OBJ, apiName: 'EmptyObj' })],
  edges: [],
};

// =============================================================================
// Seed 2: object with mixed automation. Has:
//   - ValidationRule (parented)
//   - ApexTrigger on insert + update events
//   - Flow record-triggered on CreateAndUpdate
//   - WorkflowRule on onAllChanges (fires on both insert and update)
// =============================================================================

const MIXED_OBJ = 'CustomObject:MixedObj';
const MIXED_VR = 'ValidationRule:MixedObj.SaneCheck';
const MIXED_TRIGGER = 'ApexTrigger:MixedTrigger';
const MIXED_FLOW = 'Flow:MixedFlow';
const MIXED_BEFORE_FLOW = 'Flow:MixedBeforeFlow';
const MIXED_FLOW_COND = 'ConditionalContext:Flow:MixedFlow.condition-0';
const MIXED_WORKFLOW = 'WorkflowRule:MixedObj.AlwaysFires';

const mixedSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: MIXED_OBJ, apiName: 'MixedObj' }),
    makeNode({
      id: MIXED_VR,
      type: 'ValidationRule',
      apiName: 'SaneCheck',
      parentId: MIXED_OBJ,
      properties: {
        errorMessage: 'Amount must be positive.',
        errorDisplayField: 'Amount__c',
        errorConditionFormula: 'Amount__c <= 0',
        active: true,
      },
    }),
    makeNode({
      id: MIXED_TRIGGER,
      type: 'ApexTrigger',
      apiName: 'MixedTrigger',
      properties: {
        triggerObject: 'MixedObj',
        events: ['before insert', 'after update'],
      },
    }),
    makeNode({
      id: MIXED_FLOW,
      type: 'Flow',
      apiName: 'MixedFlow',
    }),
    makeNode({
      id: MIXED_FLOW_COND,
      type: 'ConditionalContext',
      apiName: 'Flow:MixedFlow.condition-0',
      parentId: MIXED_FLOW,
      properties: {
        kind: 'flow-decision',
        expression: 'MixedObj.Status equals Open',
        fieldRefs: ['CustomField:MixedObj.Status'],
        synthesized: false,
      },
    }),
    makeNode({
      id: MIXED_WORKFLOW,
      type: 'WorkflowRule',
      apiName: 'MixedObj.AlwaysFires',
      parentId: MIXED_OBJ,
      properties: { triggerType: 'onAllChanges' },
    }),
    makeNode({ id: MIXED_BEFORE_FLOW, type: 'Flow', apiName: 'MixedBeforeFlow' }),
  ],
  edges: [
    makeEdge({ fromId: MIXED_OBJ, toId: MIXED_VR, edgeType: 'parentOf' }),
    makeEdge({
      fromId: MIXED_TRIGGER,
      toId: MIXED_OBJ,
      edgeType: 'triggersOn',
      properties: { events: ['before insert', 'after update'] },
    }),
    makeEdge({
      fromId: MIXED_FLOW,
      toId: MIXED_OBJ,
      edgeType: 'triggersOn',
      properties: {
        triggerType: 'RecordAfterSave',
        recordTriggerType: 'CreateAndUpdate',
      },
    }),
    makeEdge({
      fromId: MIXED_BEFORE_FLOW,
      toId: MIXED_OBJ,
      edgeType: 'triggersOn',
      properties: {
        triggerType: 'RecordBeforeSave',
        recordTriggerType: 'CreateAndUpdate',
      },
    }),
    makeEdge({
      fromId: MIXED_FLOW,
      toId: MIXED_FLOW_COND,
      edgeType: 'firesWhen',
    }),
    makeEdge({ fromId: MIXED_OBJ, toId: MIXED_WORKFLOW, edgeType: 'parentOf' }),
    makeEdge({
      fromId: MIXED_WORKFLOW,
      toId: MIXED_OBJ,
      edgeType: 'triggersOn',
      properties: { triggerType: 'onAllChanges' },
    }),
  ],
};

// =============================================================================
// Seed 3: object with a Delete-only Flow. Used to verify the delete
// per-event payload picks it up but insert/update do not.
// =============================================================================

const DELETE_OBJ = 'CustomObject:DeleteObj';
const DELETE_FLOW = 'Flow:DeleteOnlyFlow';

const deleteSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: DELETE_OBJ, apiName: 'DeleteObj' }),
    makeNode({
      id: DELETE_FLOW,
      type: 'Flow',
      apiName: 'DeleteOnlyFlow',
    }),
  ],
  edges: [
    makeEdge({
      fromId: DELETE_FLOW,
      toId: DELETE_OBJ,
      edgeType: 'triggersOn',
      properties: {
        triggerType: 'RecordBeforeDelete',
        recordTriggerType: 'Delete',
      },
    }),
  ],
};

// Object without CustomObject node but with triggersOn — standard-object pattern.
const NODELESS_OBJ_NAME = 'NodelessObj';
const NODELESS_TRIGGER = 'ApexTrigger:NodelessTrigger';
const nodelessSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: NODELESS_TRIGGER,
      type: 'ApexTrigger',
      apiName: 'NodelessTrigger',
      properties: {
        triggerObject: NODELESS_OBJ_NAME,
        events: ['before insert', 'after update'],
      },
    }),
    // NOTE: deliberately NO CustomObject node for NodelessObj.
  ],
  edges: [
    makeEdge({
      fromId: NODELESS_TRIGGER,
      toId: `CustomObject:${NODELESS_OBJ_NAME}`,
      edgeType: 'triggersOn',
      properties: { events: ['before insert', 'after update'] },
    }),
  ],
};

// =============================================================================
// Seed 5: full-cascade object where every post-save phase co-occurs.
// Neither real test vault has an object that triggers
// >=2 post-save phases together, so this synthetic seed is the only way
// to assert the cross-phase emit order. Has a before+after-insert
// ApexTrigger (with dispatchesAsync), a ValidationRule, an active
// blocking DuplicateRule (R6-07), a Create Flow, an onCreateOnly
// WorkflowRule, an AssignmentRule, an ApprovalProcess, and — as the child
// of a Summary field on a separate parent object (R6-07) — a
// post-save-rollup-recalc entry.
// =============================================================================

const ORDER_OBJ = 'CustomObject:OrderObj';
const ORDER_VR = 'ValidationRule:OrderObj.IsValid';
const ORDER_DUP = 'DuplicateRule:OrderObj.ActiveBlockRule';
const ORDER_TRIGGER = 'ApexTrigger:OrderTrigger';
const ORDER_ASYNC_JOB = 'ApexClass:OrderAsyncJob';
const ORDER_FLOW = 'Flow:OrderFlow';
const ORDER_WORKFLOW = 'WorkflowRule:OrderObj.NotifyOnCreate';
const ORDER_ASSIGNMENT = 'AssignmentRule:OrderObj.RoundRobin';
const ORDER_APPROVAL = 'ApprovalProcess:OrderObj.CreditReview';
const ORDER_ROLLUP_PARENT = 'CustomObject:OrderRollupParent';
const ORDER_ROLLUP_FIELD = 'CustomField:OrderRollupParent.Total__c';

const orderSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: ORDER_OBJ, apiName: 'OrderObj' }),
    makeNode({
      id: ORDER_VR,
      type: 'ValidationRule',
      apiName: 'IsValid',
      parentId: ORDER_OBJ,
      properties: {
        errorMessage: 'Industry is required.',
        errorDisplayField: 'Industry',
        errorConditionFormula: 'ISBLANK(Industry)',
        active: true,
      },
    }),
    makeNode({
      id: ORDER_DUP,
      type: 'DuplicateRule',
      apiName: 'OrderObj.ActiveBlockRule',
      parentId: ORDER_OBJ,
      properties: { isActive: true, operationsOnInsert: ['Block'], operationsOnUpdate: ['Block'] },
    }),
    makeNode({
      id: ORDER_TRIGGER,
      type: 'ApexTrigger',
      apiName: 'OrderTrigger',
      properties: {
        triggerObject: 'OrderObj',
        events: ['before insert', 'after insert'],
      },
    }),
    makeNode({
      id: ORDER_ASYNC_JOB,
      type: 'ApexClass',
      apiName: 'OrderAsyncJob',
    }),
    makeNode({ id: ORDER_FLOW, type: 'Flow', apiName: 'OrderFlow' }),
    makeNode({
      id: ORDER_WORKFLOW,
      type: 'WorkflowRule',
      apiName: 'OrderObj.NotifyOnCreate',
      parentId: ORDER_OBJ,
      properties: { triggerType: 'onCreateOnly' },
    }),
    makeNode({
      id: ORDER_ASSIGNMENT,
      type: 'AssignmentRule',
      apiName: 'OrderObj.RoundRobin',
      parentId: ORDER_OBJ,
    }),
    makeNode({
      id: ORDER_APPROVAL,
      type: 'ApprovalProcess',
      apiName: 'OrderObj.CreditReview',
      parentId: ORDER_OBJ,
    }),
    makeNode({ id: ORDER_ROLLUP_PARENT, apiName: 'OrderRollupParent' }),
    makeNode({
      id: ORDER_ROLLUP_FIELD,
      type: 'CustomField',
      apiName: 'Total__c',
      parentId: ORDER_ROLLUP_PARENT,
      properties: {
        dataType: 'Summary',
        summarizedField: 'OrderObj.Amount__c',
        summaryForeignKey: 'OrderObj.Parent__c',
        summaryOperation: 'sum',
      },
    }),
  ],
  edges: [
    makeEdge({ fromId: ORDER_OBJ, toId: ORDER_VR, edgeType: 'parentOf' }),
    makeEdge({ fromId: ORDER_OBJ, toId: ORDER_DUP, edgeType: 'parentOf' }),
    makeEdge({
      fromId: ORDER_TRIGGER,
      toId: ORDER_OBJ,
      edgeType: 'triggersOn',
      properties: { events: ['before insert', 'after insert'] },
    }),
    makeEdge({
      fromId: ORDER_TRIGGER,
      toId: ORDER_ASYNC_JOB,
      edgeType: 'dispatchesAsync',
    }),
    makeEdge({
      fromId: ORDER_FLOW,
      toId: ORDER_OBJ,
      edgeType: 'triggersOn',
      properties: {
        triggerType: 'RecordAfterSave',
        recordTriggerType: 'Create',
      },
    }),
    makeEdge({ fromId: ORDER_OBJ, toId: ORDER_WORKFLOW, edgeType: 'parentOf' }),
    makeEdge({
      fromId: ORDER_WORKFLOW,
      toId: ORDER_OBJ,
      edgeType: 'triggersOn',
      properties: { triggerType: 'onCreateOnly' },
    }),
    makeEdge({
      fromId: ORDER_OBJ,
      toId: ORDER_ASSIGNMENT,
      edgeType: 'parentOf',
    }),
    makeEdge({ fromId: ORDER_OBJ, toId: ORDER_APPROVAL, edgeType: 'parentOf' }),
    makeEdge({ fromId: ORDER_ROLLUP_PARENT, toId: ORDER_ROLLUP_FIELD, edgeType: 'parentOf' }),
  ],
};

// =============================================================================
// Seed 6 (B29): a PHANTOM object — a PermissionSet grants object access to a
// CustomObject whose definition was never retrieved (managed-package object).
// No node, no automation, only an inbound grantedBy edge. SOE must explain it
// is referenced-but-not-modeled, not a bare unknown id.
// =============================================================================

const PHANTOM_OBJ = 'CustomObject:Pkg_Application__c';
const GRANTING_PERMSET = 'PermissionSet:Pkg_Admin';

const phantomSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: GRANTING_PERMSET, type: 'PermissionSet', apiName: 'Pkg_Admin' }),
  ],
  edges: [
    // PermissionSet -> object grant whose target has no node in the vault.
    makeEdge({ fromId: GRANTING_PERMSET, toId: PHANTOM_OBJ, edgeType: 'grantedBy' }),
  ],
};

// =============================================================================
// Seed 7 (WHAT-HAPPENS-ON-SAVE-TRUNCATION-DROPS-LATER-PHASES): a densely-
// automated object whose four-event payload blows the ~40 KB byte budget and
// forces the last-resort tail step-drop — dropping whole later phases from
// `soe` while `summary.phaseCounts` still reports them. Many pre-save
// ValidationRules fill the budget (early phase); a DuplicateRule + an
// after-insert ApexTrigger sit later in save-order and get tail-dropped.
// =============================================================================

const TRUNC_OBJ = 'CustomObject:TruncObj';
const TRUNC_DUP = 'DuplicateRule:TruncObj.LaterDupRule';
const TRUNC_AFTER_TRIGGER = 'ApexTrigger:TruncAfterTrigger';

const truncSeed: ExtractionResult = (() => {
  const nodes: Node[] = [makeNode({ id: TRUNC_OBJ, apiName: 'TruncObj' })];
  const edges: Edge[] = [];
  // 90 active validation rules — enough distinct steps that, even after actions
  // and conditionals are trimmed, the four-event step COUNT alone exceeds the
  // budget and the tail step-drop engages.
  for (let i = 0; i < 90; i += 1) {
    const id = `ValidationRule:TruncObj.Rule_${String(i).padStart(3, '0')}`;
    nodes.push(
      makeNode({
        id,
        type: 'ValidationRule',
        apiName: `Rule_${String(i).padStart(3, '0')}`,
        parentId: TRUNC_OBJ,
        properties: {
          active: true,
          errorMessage: `Rule ${i} failed with a deliberately long message to add payload bytes so the enforcer must trim before it drops steps.`,
          errorDisplayField: null,
        },
      }),
    );
    edges.push(makeEdge({ fromId: TRUNC_OBJ, toId: id, edgeType: 'parentOf' }));
  }
  // A later-phase DuplicateRule (duplicate-rules phase) and an after-insert
  // ApexTrigger (after-triggers phase) — these sit AFTER the validation bulk in
  // save-order, so the tail-drop sheds them first.
  nodes.push(
    makeNode({
      id: TRUNC_DUP,
      type: 'DuplicateRule',
      apiName: 'TruncObj.LaterDupRule',
      parentId: TRUNC_OBJ,
      properties: { isActive: true, operationsOnInsert: ['Block'], operationsOnUpdate: ['Block'] },
    }),
    makeNode({
      id: TRUNC_AFTER_TRIGGER,
      type: 'ApexTrigger',
      apiName: 'TruncAfterTrigger',
      properties: { triggerObject: 'TruncObj', events: ['after insert'] },
    }),
  );
  edges.push(
    makeEdge({ fromId: TRUNC_OBJ, toId: TRUNC_DUP, edgeType: 'parentOf' }),
    makeEdge({
      fromId: TRUNC_AFTER_TRIGGER,
      toId: TRUNC_OBJ,
      edgeType: 'triggersOn',
      properties: { events: ['after insert'] },
    }),
  );
  return { nodes, edges };
})();

// =============================================================================
// Seed: APEX-RECEIVER-VERIFIED. A trigger whose Apex scanner edges are keyed on
// the TEXTUAL receiver. `RecursionGuard` is a real ApexClass NODE here, so
// `CustomField:RecursionGuard.hasRun` is an Apex STATIC MEMBER, not a field on
// any object — yet it was emitted as a save-time `readsFrom`/`writesTo` action
// with a `CustomField:` targetId. The describe token, the `__r` traversal and
// the unvaulted receiver are the other shapes the lexical test let through; the
// object's own field is the control that must SURVIVE.
// =============================================================================

const GUARD_OBJ = 'CustomObject:GuardObj';
const GUARD_TRIGGER = 'ApexTrigger:GuardObjTrigger';
const GUARD_APEX_TYPE = 'ApexClass:RecursionGuard';

const receiverGuardSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: GUARD_OBJ, apiName: 'GuardObj' }),
    makeNode({
      id: GUARD_TRIGGER,
      type: 'ApexTrigger',
      apiName: 'GuardObjTrigger',
      properties: { triggerObject: 'GuardObj', events: ['before insert'] },
    }),
    makeNode({ id: GUARD_APEX_TYPE, type: 'ApexClass', apiName: 'RecursionGuard' }),
  ],
  edges: [
    makeEdge({
      fromId: GUARD_TRIGGER,
      toId: GUARD_OBJ,
      edgeType: 'triggersOn',
      properties: { events: ['before insert'] },
    }),
    // The control: a real field on the object the trigger fires on. SURVIVES.
    makeEdge({
      fromId: GUARD_TRIGGER,
      toId: 'CustomField:GuardObj.Status__c',
      edgeType: 'readsFrom',
      confidence: 'parsed',
      source: 'apex-ast',
    }),
    // The defect: an Apex class STATIC, emitted as a field at `parsed`.
    makeEdge({
      fromId: GUARD_TRIGGER,
      toId: 'CustomField:RecursionGuard.hasRun',
      edgeType: 'readsFrom',
      confidence: 'parsed',
      source: 'apex-ast',
    }),
    makeEdge({
      fromId: GUARD_TRIGGER,
      toId: 'CustomField:RecursionGuard.hasRun',
      edgeType: 'writesTo',
      confidence: 'parsed',
      source: 'apex-ast',
    }),
    // An Apex describe token — reads like a field after the dot, is not one.
    makeEdge({
      fromId: GUARD_TRIGGER,
      toId: 'CustomField:GuardObj.fields',
      edgeType: 'readsFrom',
      confidence: 'heuristic',
      source: 'apex-scanner',
    }),
    // A relationship traversal — a field on the RELATED object, not this one.
    makeEdge({
      fromId: GUARD_TRIGGER,
      toId: 'CustomField:GuardParent__r.Code__c',
      edgeType: 'readsFrom',
      confidence: 'heuristic',
      source: 'apex-scanner',
    }),
    // Nothing here names this receiver: an unretrieved SObject, an Apex system
    // type, or an inner class — the tier that cannot be told apart.
    makeEdge({
      fromId: GUARD_TRIGGER,
      toId: 'CustomField:UnvaultedThing.Name',
      edgeType: 'readsFrom',
      confidence: 'heuristic',
      source: 'apex-scanner',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-ooe-'));
  const dbPath = join(tempDir, 'ooe.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [
    emptySeed,
    mixedSeed,
    deleteSeed,
    nodelessSeed,
    orderSeed,
    phantomSeed,
    truncSeed,
    receiverGuardSeed,
  ]);
  if (!imported.ok) {
    throw new Error(`seed import failed: ${imported.error.message}`);
  }
  ctx = {
    vaultRoot: tempDir,
    manifest: FIXTURE_MANIFEST,
    graph: store,
  };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('orderOfExecutionHandler — truncation phase honesty (WHAT-HAPPENS-ON-SAVE-TRUNCATION-DROPS-LATER-PHASES)', () => {
  it('FAIL-BEFORE/PASS-AFTER: a truncated payload discloses phasesOmitted instead of silently contradicting phaseCounts', async () => {
    const result = await orderOfExecutionHandler(ctx, { objectApiName: 'TruncObj' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    // Precondition: the payload truncated (tail step-drop engaged).
    expect(data.truncated).toBe(true);
    const insert = data.byEvent.insert;
    // The dropped later phases are still CLAIMED by phaseCounts...
    expect(insert.summary.phaseCounts['duplicate-rules']).toBe(1);
    expect(insert.summary.phaseCounts['after-triggers']).toBe(1);
    // ...but their steps were tail-dropped from soe. That contradiction must be
    // DISCLOSED via phasesOmitted (the field did not exist pre-fix).
    expect(insert.phasesOmitted).toBeDefined();
    const omittedPhases = (insert.phasesOmitted ?? []).map((p) => p.phase);
    expect(omittedPhases).toContain('duplicate-rules');
    expect(omittedPhases).toContain('after-triggers');
    // Each omission carries the true declared count and the (smaller) present count.
    const dupOmission = insert.phasesOmitted?.find((p) => p.phase === 'duplicate-rules');
    expect(dupOmission?.declared).toBe(1);
    expect(dupOmission?.present).toBe(0);
    // The disclosure names the truncation-vs-counts contradiction.
    expect(data.disclosure).toMatch(/still reports them/i);
  });

  it('the `phase` filter recovers a phase dropped from the full view', async () => {
    const result = await orderOfExecutionHandler(ctx, {
      objectApiName: 'TruncObj',
      phase: 'duplicate-rules',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.appliedPhaseFilter).toBe('duplicate-rules');
    const insert = data.byEvent.insert;
    // The narrowed view surfaces the DuplicateRule the full view had to drop.
    expect(insert.soe.map((s) => s.componentId)).toContain(TRUNC_DUP);
    expect(insert.soe.every((s) => s.phase === 'duplicate-rules')).toBe(true);
    // summary still reflects the WHOLE composition (not the filtered slice).
    expect(insert.summary.phaseCounts['pre-save-validation']).toBe(90);
    // A single-phase slice is tiny — no truncation, no phasesOmitted.
    expect(data.truncated).toBeFalsy();
    expect(insert.phasesOmitted).toBeUndefined();
  });
});

describe('orderOfExecutionHandler — one envelope law (ORDER-OF-EXECUTION-OVERSIZE-HARD-FAIL)', () => {
  it('an oversize four-event OOE returns a PARTIAL envelope (never a hard-fail) whose data stays within budget with the disclosure intact', async () => {
    const result = await orderOfExecutionHandler(ctx, { objectApiName: 'TruncObj' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    // Precondition — this object is genuinely oversize and truncated.
    expect(data.truncated).toBe(true);

    // FAIL-BEFORE: the honesty scaffolding (per-event `phasesOmitted` + the
    // phases-dropped disclosure note) was appended AFTER enforcement measured
    // `data`, re-inflating it PAST its own SOE budget (~40826 B observed).
    // PASS-AFTER: the scaffolding is reserved for, so the FINAL `data` — notes
    // and phasesOmitted included — stays within SOE_MAX_PAYLOAD_BYTES.
    expect(utf8Bytes(data)).toBeLessThanOrEqual(SOE_MAX_PAYLOAD_BYTES);

    // The load-bearing disclosure survives WHOLE through the real dispatch guard
    // — it is neither slimmed nor forced into an oversize error. Before the fix
    // the re-inflated payload made the global guard mangle the disclosure (only
    // the nested per-event `soe` arrays are un-reducible, so a denser object hit
    // the guard's Pass-3 oversize rejection = the hard-fail this closes).
    const wrapped = jsonResult(result.value);
    const env = JSON.parse((wrapped.content[0] as { text: string }).text) as {
      error?: { kind?: string };
      responseBudget?: unknown;
      data?: { disclosure?: string };
    };
    expect('error' in env).toBe(false); // no oversize hard-fail
    expect(env.responseBudget).toBeUndefined(); // global guard never engaged
    expect(env.data?.disclosure).toBe(data.disclosure); // disclosure byte-identical
    expect(env.data?.disclosure ?? '').not.toContain('bytes trimmed');
  });

  it('a truncated OOE payload never hides a dropped NON-ZERO phase — every shortfall is named in phasesOmitted', async () => {
    const result = await orderOfExecutionHandler(ctx, { objectApiName: 'TruncObj' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.truncated).toBe(true);

    const events = ['insert', 'update', 'delete', 'undelete'] as const;
    let anyNonZeroPhaseOmitted = false;
    for (const event of events) {
      const perEvent = data.byEvent[event];
      const declared = perEvent.summary.phaseCounts;
      const survived = tallyPhaseCounts(perEvent.soe);
      const named = new Map(
        (perEvent.phasesOmitted ?? []).map((o) => [o.phase, o]),
      );
      for (const phase of Object.keys(declared) as (keyof typeof declared)[]) {
        if (declared[phase] > survived[phase]) {
          // A phase the counts claim but the sequence no longer fully holds
          // MUST be named — a truncated payload can never imply "0 of these"
          // for a phase that really fires. This is the "0 phases / no
          // phasesOmitted" contradiction the finding forbids.
          const omission = named.get(phase);
          expect(omission).toBeDefined();
          expect(omission?.declared).toBe(declared[phase]);
          expect(omission?.present).toBe(survived[phase]);
          if (declared[phase] > 0) anyNonZeroPhaseOmitted = true;
        } else {
          // Not dropped ⇒ not falsely named as omitted.
          expect(named.has(phase)).toBe(false);
        }
      }
      // Whenever this event carries a phasesOmitted list, it is non-empty and
      // each entry is a real shortfall (present strictly below declared).
      for (const o of perEvent.phasesOmitted ?? []) {
        expect(o.present).toBeLessThan(o.declared);
      }
    }
    // This fixture drops later phases (duplicate-rules / after-triggers) whose
    // declared count is non-zero, so the honesty path is genuinely exercised.
    expect(anyNonZeroPhaseOmitted).toBe(true);
  });
});

describe('orderOfExecutionHandler', () => {
  it('accepts an optional phase filter in the input schema', () => {
    // FAIL-BEFORE: `phase` was not in the schema and was Zod-stripped.
    const parsed = orderOfExecutionInputSchema.safeParse({
      objectApiName: 'OrderObj',
      phase: 'duplicate-rules',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.phase).toBe('duplicate-rules');
    // An unknown phase is rejected rather than silently ignored.
    expect(
      orderOfExecutionInputSchema.safeParse({ objectApiName: 'OrderObj', phase: 'not-a-phase' })
        .success,
    ).toBe(false);
  });

  // GUARD (L2 alias OS / ADMIN-SURFACE-ALIAS-SKEW-CLUSTER): pre-fix the schema
  // declared only `objectApiName`, so `object` / `objectId` / a `CustomObject:`
  // `componentId` was Zod-STRIPPED -> `objectApiName: Required`. Post-fix each
  // alias resolves to the SAME byEvent composition, with `appliedScope` echoed.
  it('natural object aliases ≡ canonical objectApiName (byte-equal byEvent + appliedScope)', async () => {
    const run = async (raw: unknown) => {
      const parsed = orderOfExecutionInputSchema.safeParse(raw);
      if (!parsed.success) return null;
      return orderOfExecutionHandler(ctx, parsed.data);
    };
    const canonical = await run({ objectApiName: 'OrderObj' });
    const byObject = await run({ object: 'OrderObj' });
    const byObjectId = await run({ objectId: 'CustomObject:OrderObj' });
    const byComponent = await run({ componentId: 'CustomObject:OrderObj' });
    for (const r of [canonical, byObject, byObjectId, byComponent]) {
      expect(r).not.toBeNull();
      expect(r?.ok).toBe(true);
    }
    if (!canonical?.ok || !byObject?.ok || !byObjectId?.ok || !byComponent?.ok) return;
    expect(canonical.value.data.appliedScope).toEqual({
      componentId: 'CustomObject:OrderObj',
      object: 'OrderObj',
    });
    for (const r of [byObject, byObjectId, byComponent]) {
      expect(r.value.data.byEvent).toEqual(canonical.value.data.byEvent);
      expect(r.value.data.appliedScope).toEqual(canonical.value.data.appliedScope);
    }
  });

  it('disagreeing object aliases → invalid-query', async () => {
    const parsed = orderOfExecutionInputSchema.safeParse({
      objectApiName: 'OrderObj',
      object: 'MixedObj',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const r = await orderOfExecutionHandler(ctx, parsed.data);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid-query');
  });

  it('phase filter on OrderObj returns only that phase; full view returns all phases', async () => {
    const full = await orderOfExecutionHandler(ctx, { objectApiName: 'OrderObj' });
    const filtered = await orderOfExecutionHandler(ctx, {
      objectApiName: 'OrderObj',
      phase: 'pre-save-validation',
    });
    expect(full.ok && filtered.ok).toBe(true);
    if (!full.ok || !filtered.ok) return;
    // Full (un-filtered) view: no phase filter echoed, multiple phases present.
    expect(full.value.data.appliedPhaseFilter).toBeUndefined();
    const fullInsertPhases = new Set(full.value.data.byEvent.insert.soe.map((s) => s.phase));
    expect(fullInsertPhases.size).toBeGreaterThan(2);
    // Filtered view: only the requested phase in soe; full counts retained.
    expect(filtered.value.data.appliedPhaseFilter).toBe('pre-save-validation');
    const fInsert = filtered.value.data.byEvent.insert;
    expect(fInsert.soe.every((s) => s.phase === 'pre-save-validation')).toBe(true);
    expect(fInsert.soe.length).toBe(1);
    expect(fInsert.summary.phaseCounts['pre-save-validation']).toBe(1);
    // Counts stay the whole-composition truth even though soe is narrowed.
    expect(fInsert.summary.phaseCounts['duplicate-rules']).toBe(1);
  });

  it('returns component-not-found for an unknown object', async () => {
    const result = await orderOfExecutionHandler(ctx, {
      objectApiName: 'NoSuchObject',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    expect(result.error.path).toBe('CustomObject:NoSuchObject');
    // A genuinely unknown id gets the plain message — not the phantom one.
    expect(result.error.message).not.toMatch(/referenced by this org/);
  });

  it('explains a phantom object referenced by grants but never retrieved (B29)', async () => {
    const result = await orderOfExecutionHandler(ctx, {
      objectApiName: 'Pkg_Application__c',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    expect(result.error.path).toBe('CustomObject:Pkg_Application__c');
    // Honest, actionable: says it's referenced-but-not-retrieved (managed pkg),
    // rather than implying the id is bogus.
    expect(result.error.message).toMatch(/referenced by this org/);
    expect(result.error.message).toMatch(/managed-package|never retrieved/);
  });

  it('composes byEvent when object node is absent but triggersOn automation exists', async () => {
    const result = await orderOfExecutionHandler(ctx, {
      objectApiName: NODELESS_OBJ_NAME,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.objectModeled).toBe(false);
    expect(result.value.data.disclosure).toContain(
      "object's own metadata definition is not in this vault",
    );
    expect(result.value.data.byEvent.insert.soe.length).toBeGreaterThan(1);
  });

  it('produces a byEvent map with all four DML events as keys', async () => {
    const result = await orderOfExecutionHandler(ctx, {
      objectApiName: 'MixedObj',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { byEvent } = result.value.data;
    expect(Object.keys(byEvent).sort()).toEqual([
      'delete',
      'insert',
      'undelete',
      'update',
    ]);
  });

  it('emits only the save placeholder for an empty object across all events', async () => {
    const result = await orderOfExecutionHandler(ctx, {
      objectApiName: 'EmptyObj',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { byEvent } = result.value.data;
    for (const event of ['insert', 'update', 'delete', 'undelete'] as const) {
      expect(byEvent[event].soe.length).toBe(1);
      expect(byEvent[event].soe[0]?.phase).toBe('save');
      expect(byEvent[event].summary.totalSteps).toBe(1);
    }
  });

  it('places before-save-flows FIRST on insert + update, absent on delete (P12-TEST-soe-ooe-before-save; parity with what_happens_on_save)', async () => {
    const result = await orderOfExecutionHandler(ctx, { objectApiName: 'MixedObj' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { byEvent } = result.value.data;
    for (const event of ['insert', 'update'] as const) {
      const soe = byEvent[event].soe;
      // The RecordBeforeSave flow is the leading SOE phase, ahead of before-triggers.
      expect(soe[0]?.phase).toBe('before-save-flows');
      expect(soe[0]?.componentId).toBe(MIXED_BEFORE_FLOW);
      // The RecordAfterSave flow stays in post-save-flows, not before-save-flows.
      expect(soe.find((s) => s.componentId === MIXED_FLOW)?.phase).toBe('post-save-flows');
    }
    // before-save flows do not fire on delete.
    expect(byEvent.delete.soe.some((s) => s.phase === 'before-save-flows')).toBe(false);
  });

  it('insert event picks up the validation, trigger, flow, and workflow on MixedObj', async () => {
    const result = await orderOfExecutionHandler(ctx, {
      objectApiName: 'MixedObj',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { soe } = result.value.data.byEvent.insert;
    // ValidationRule should appear, before-insert trigger should appear,
    // CreateAndUpdate flow should appear, onAllChanges workflow should appear.
    const componentIds = soe.map((s) => s.componentId);
    expect(componentIds).toContain(MIXED_VR);
    expect(componentIds).toContain(MIXED_TRIGGER);
    expect(componentIds).toContain(MIXED_FLOW);
    expect(componentIds).toContain(MIXED_WORKFLOW);
  });

  it('surfaces the error message + display field on a ValidationRule step', async () => {
    const result = await orderOfExecutionHandler(ctx, {
      objectApiName: 'MixedObj',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const vrStep = result.value.data.byEvent.insert.soe.find(
      (s) => s.componentId === MIXED_VR,
    );
    expect(vrStep).toBeDefined();
    // A VR step lists the rule + its condition; the order-of-execution view must
    // also carry the error a user would HIT and the field it blocks (sibling of
    // the what_happens_on_save fix). Previously dropped.
    expect(vrStep?.errorMessage).toBe('Amount must be positive.');
    expect(vrStep?.errorDisplayField).toBe('Amount__c');
  });

  it('update event picks up the after-update trigger and the flow', async () => {
    const result = await orderOfExecutionHandler(ctx, {
      objectApiName: 'MixedObj',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { soe } = result.value.data.byEvent.update;
    const componentIds = soe.map((s) => s.componentId);
    // The trigger has 'after update' so update should include it.
    expect(componentIds).toContain(MIXED_TRIGGER);
    // CreateAndUpdate flow should appear on update.
    expect(componentIds).toContain(MIXED_FLOW);
    // onAllChanges workflow should appear on update.
    expect(componentIds).toContain(MIXED_WORKFLOW);
  });

  it('delete event excludes validation and workflows', async () => {
    const result = await orderOfExecutionHandler(ctx, {
      objectApiName: 'MixedObj',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { soe } = result.value.data.byEvent.delete;
    const phasesPresent = new Set(soe.map((s) => s.phase));
    expect(phasesPresent.has('pre-save-validation')).toBe(false);
    expect(phasesPresent.has('post-save-workflows')).toBe(false);
  });

  it('delete event includes the delete-only flow on DeleteObj', async () => {
    const result = await orderOfExecutionHandler(ctx, {
      objectApiName: 'DeleteObj',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const deleteSoe = result.value.data.byEvent.delete.soe;
    const flowSteps = deleteSoe.filter((s) => s.phase === 'post-save-flows');
    expect(flowSteps.length).toBe(1);
    expect(flowSteps[0]?.componentId).toBe(DELETE_FLOW);
  });

  it('insert event excludes the delete-only flow on DeleteObj', async () => {
    const result = await orderOfExecutionHandler(ctx, {
      objectApiName: 'DeleteObj',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const insertSoe = result.value.data.byEvent.insert.soe;
    const flowSteps = insertSoe.filter((s) => s.phase === 'post-save-flows');
    expect(flowSteps.length).toBe(0);
  });

  it('populates the conditional field on Flow steps that have a firesWhen edge', async () => {
    const result = await orderOfExecutionHandler(ctx, {
      objectApiName: 'MixedObj',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const insertSoe = result.value.data.byEvent.insert.soe;
    const flowStep = insertSoe.find((s) => s.componentId === MIXED_FLOW);
    expect(flowStep?.conditional?.conditionContextId).toBe(MIXED_FLOW_COND);
    expect(flowStep?.conditional?.expression).toBe(
      'MixedObj.Status equals Open',
    );
    expect(flowStep?.conditional?.fieldRefs).toHaveLength(1);
  });

  it('per-event summary.conditionalSteps matches the number of conditional steps', async () => {
    const result = await orderOfExecutionHandler(ctx, {
      objectApiName: 'MixedObj',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const event of ['insert', 'update', 'delete', 'undelete'] as const) {
      const perEvent = result.value.data.byEvent[event];
      const conditionalCount = perEvent.soe.filter(
        (s) => s.conditional !== undefined,
      ).length;
      expect(perEvent.summary.conditionalSteps).toBe(conditionalCount);
    }
  });

  it('grounds per-event, per-phase active-component counts (answers the count/ordering question per event)', async () => {
    const result = await orderOfExecutionHandler(ctx, {
      objectApiName: 'MixedObj',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { byEvent } = result.value.data;

    // MixedObj on INSERT: a before-save flow, a before-insert trigger, a
    // validation rule, an after-save (CreateAndUpdate) flow, and an
    // onAllChanges workflow = 5 active components. The before+after trigger
    // events are 'before insert' + 'after update', so there is NO after-insert
    // trigger on the insert event.
    const insert = byEvent.insert.summary;
    expect(insert.activeComponents).toBe(5);
    expect(insert.phaseCounts['before-save-flows']).toBe(1);
    expect(insert.phaseCounts['pre-save-triggers']).toBe(1);
    expect(insert.phaseCounts['pre-save-validation']).toBe(1);
    expect(insert.phaseCounts['after-triggers']).toBe(0);
    expect(insert.phaseCounts['post-save-workflows']).toBe(1);
    expect(insert.phaseCounts['post-save-flows']).toBe(1);
    // The save placeholder is never counted as automation.
    expect('save' in insert.phaseCounts).toBe(false);
    expect(insert.activeComponents).toBe(insert.totalSteps - 1);

    // MixedObj on UPDATE: the same before-save flow, an after-update trigger
    // (so after-triggers, not pre-save-triggers), the validation rule, the
    // after-save flow, and the onAllChanges workflow = 5.
    const update = byEvent.update.summary;
    expect(update.activeComponents).toBe(5);
    expect(update.phaseCounts['pre-save-triggers']).toBe(0);
    expect(update.phaseCounts['after-triggers']).toBe(1);

    // Per-phase counts sum to activeComponents on every event.
    for (const event of ['insert', 'update', 'delete', 'undelete'] as const) {
      const s = byEvent[event].summary;
      const summed = Object.values(s.phaseCounts).reduce((a, b) => a + b, 0);
      expect(summed).toBe(s.activeComponents);
    }
  });

  it('per-event phaseCounts are zero-filled for an automation-free object', async () => {
    const result = await orderOfExecutionHandler(ctx, {
      objectApiName: 'EmptyObj',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const event of ['insert', 'update', 'delete', 'undelete'] as const) {
      const s = result.value.data.byEvent[event].summary;
      expect(s.activeComponents).toBe(0);
      expect(Object.values(s.phaseCounts).every((c) => c === 0)).toBe(true);
    }
  });

  it('echoes the objectApiName in the response', async () => {
    const result = await orderOfExecutionHandler(ctx, {
      objectApiName: 'MixedObj',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.objectApiName).toBe('MixedObj');
  });

  it('carries the verbatim honesty-axis disclosure', async () => {
    const result = await orderOfExecutionHandler(ctx, {
      objectApiName: 'EmptyObj',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The spec-mandated string must be carried VERBATIM as the PREFIX. It is
    // asserted as a prefix, not as the whole value, because this tool appends
    // always-on honesty riders after it (the rollup-scan note, the
    // concept-reasoning note, and — since APEX-RECEIVER-VERIFIED — the
    // receiver-verification sentence, which must be said even when it demoted
    // NOTHING so a clean action list reads as CHECKED rather than unchecked).
    // Not one byte of the mandated text may change; the assertion below pins
    // the rider that follows it on this fixture.
    expect(result.value.data.disclosure.startsWith(
      "v2.0e composes the documented Salesforce order-of-execution instantiated against THIS org's extracted automation. Before-save record-triggered flows are modeled as the leading `before-save-flows` phase (they run BEFORE before-triggers). Duplicate rules are modeled as their own `duplicate-rules` phase, running after before-triggers and validation but BEFORE the save — evaluated on insert/update only, with the effective Block/Allow/Alert/Report operations surfaced per rule. Conditions ARE listed but NOT EVALUATED — the tool does not know whether this particular record satisfies them at runtime. Workflow field updates can re-fire before/after-update triggers (a second pass); this composition lists each automation once and does not expand that re-entrancy. A workflow rule's time-dependent actions (its workflowTimeTriggers) are SCHEDULED for an offset measured from a record field value the offline vault cannot evaluate; this composition lists the rule once in the synchronous post-save-workflows phase and does NOT claim its time-delayed actions fire at save. Parent Summary (roll-up) fields that aggregate this object recalculate in the `post-save-rollup-recalc` phase, capped to ONE level — a grandparent's own rollup on that recalculated parent is NOT walked — and the parent's own triggers/flows/workflows that its recalculated save would fire are NOT expanded (no re-entrancy). Entitlement-process and milestone-type METADATA is modeled elsewhere in the vault (R6-18: `EntitlementProcess`/`MilestoneType` nodes, queryable via `sfi.get_component` / `sfi.get_edges`, including each milestone's declared target `minutesToComplete` as of R7-C7) — but this composition does NOT simulate entitlement milestones as an order-of-execution phase: whether a specific record is currently on-track or breached against those target minutes is live, per-record timer data this offline vault cannot hold. Criteria-based sharing recalculation — the FINAL step in Salesforce's documented order-of-execution, evaluated after every phase modeled here (including post-save-async) — is also NOT modeled: a save that causes a record to newly match or stop matching a criteria-based sharing rule's criteria triggers a sharing recalculation this composition does not surface. Manual sharing, sharing sets, account teams, and Apex callouts after save are out of scope.",
      ),
    ).toBe(true);
    // CHECKED-and-nothing-demoted: this fixture's object has no Apex
    // field-access edge at all, and that zero must READ as checked.
    expect(result.value.data.disclosure).toContain(
      'was CHECKED against this vault and each one names an SObject node here',
    );
    expect(result.value.data.receiverVerification).toEqual({
      checked: true,
      reason: null,
      demoted: {},
      tokens: [],
      tokensTruncated: false,
    });
  });

  it('CR-CAP-11b: time-trigger disclosure is byte-identical to what_happens_on_save and makes no firing claim', async () => {
    const result = await orderOfExecutionHandler(ctx, {
      objectApiName: 'EmptyObj',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data.disclosure;
    expect(d).toContain('SCHEDULED');
    expect(d).toContain('does NOT claim its time-delayed actions fire at save');
    expect(/time-(?:delayed|dependent) actions fire(?! at save)/.test(d)).toBe(
      false,
    );
  });

  it('per-event payloads have monotonic stepIndex starting from 0', async () => {
    const result = await orderOfExecutionHandler(ctx, {
      objectApiName: 'MixedObj',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const event of ['insert', 'update', 'delete', 'undelete'] as const) {
      const { soe } = result.value.data.byEvent[event];
      for (let i = 0; i < soe.length; i += 1) {
        expect(soe[i]?.stepIndex).toBe(i);
      }
    }
  });

  it('emits the canonical Salesforce phase order on insert (full cascade)', async () => {
    const result = await orderOfExecutionHandler(ctx, {
      objectApiName: 'OrderObj',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { soe } = result.value.data.byEvent.insert;
    // OrderObj is the one seed where every post-save phase co-occurs.
    // Assert the EXACT documented Salesforce order of execution: before
    // triggers precede custom validation rules, duplicate rules run after
    // validation but before the save (R6-07), post-save automation runs
    // assignment → workflow rules → after-save flows (NOT flows first), and
    // roll-up recalculation (R6-07) runs after approval but before async.
    // This is the regression guard for the phase-order bug.
    expect(soe.map((s) => s.phase)).toEqual([
      'pre-save-triggers',
      'pre-save-validation',
      'duplicate-rules',
      'save',
      'after-triggers',
      'post-save-assignment',
      'post-save-workflows',
      'post-save-flows',
      'post-save-approval',
      'post-save-rollup-recalc',
      'post-save-async',
    ]);
    for (let i = 0; i < soe.length; i += 1) {
      expect(soe[i]?.stepIndex).toBe(i);
    }
    const dupStep = soe.find((s) => s.phase === 'duplicate-rules');
    expect(dupStep?.componentId).toBe(ORDER_DUP);
    expect(dupStep?.blocksOnSave).toBe(true);
    const rollupStep = soe.find((s) => s.phase === 'post-save-rollup-recalc');
    expect(rollupStep?.componentId).toBe(ORDER_ROLLUP_FIELD);
    expect(rollupStep?.actions[0]?.targetId).toBe(ORDER_ROLLUP_PARENT);
  });

  // ===========================================================================
  // R6-07: duplicate-rules + post-save-rollup-recalc per-event coverage.
  // ===========================================================================

  it('duplicate-rules is present on insert/update but absent on delete/undelete', async () => {
    const result = await orderOfExecutionHandler(ctx, { objectApiName: 'OrderObj' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { byEvent } = result.value.data;
    expect(byEvent.insert.soe.some((s) => s.phase === 'duplicate-rules')).toBe(true);
    expect(byEvent.update.soe.some((s) => s.phase === 'duplicate-rules')).toBe(true);
    expect(byEvent.delete.soe.some((s) => s.phase === 'duplicate-rules')).toBe(false);
    expect(byEvent.undelete.soe.some((s) => s.phase === 'duplicate-rules')).toBe(
      false,
    );
  });

  it('post-save-rollup-recalc is present on every event (insert/update/delete/undelete alike)', async () => {
    const result = await orderOfExecutionHandler(ctx, { objectApiName: 'OrderObj' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { byEvent } = result.value.data;
    for (const event of ['insert', 'update', 'delete', 'undelete'] as const) {
      const rollupSteps = byEvent[event].soe.filter(
        (s) => s.phase === 'post-save-rollup-recalc',
      );
      expect(rollupSteps.map((s) => s.componentId)).toEqual([ORDER_ROLLUP_FIELD]);
    }
  });

  it('omits both duplicate-rules and post-save-rollup-recalc for an object with neither', async () => {
    const result = await orderOfExecutionHandler(ctx, { objectApiName: 'EmptyObj' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const event of ['insert', 'update', 'delete', 'undelete'] as const) {
      const phasesPresent = new Set(
        result.value.data.byEvent[event].soe.map((s) => s.phase),
      );
      expect(phasesPresent.has('duplicate-rules')).toBe(false);
      expect(phasesPresent.has('post-save-rollup-recalc')).toBe(false);
    }
  });
});

// =============================================================================
// APEX-RECEIVER-VERIFIED (FAIL-BEFORE / PASS-AFTER)
//
// Same defect and same fix as `what_happens_on_save`, across all four events:
// `buildActions` decided what was a real save-time action LEXICALLY, so an Apex
// class static, a describe token, a `__r` traversal and an unretrieved receiver
// were all emitted with a `CustomField:` targetId. Receivers are now CHECKED
// against the vault once per composition, and demotions are DISCLOSED.
// =============================================================================

describe('orderOfExecutionHandler — verified Apex field-access receivers', () => {
  const guard = async () => {
    const result = await orderOfExecutionHandler(ctx, { objectApiName: 'GuardObj' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('handler failed');
    const step = result.value.data.byEvent.insert.soe.find(
      (s) => s.componentId === 'ApexTrigger:GuardObjTrigger',
    );
    expect(step).toBeDefined();
    return { data: result.value.data, step: step! };
  };

  it('does not name an Apex class STATIC as a field this save touches', async () => {
    const { step } = await guard();
    const targets = step.actions.map((a) => a.targetId);
    // FAILS BEFORE: emitted verbatim at `parsed` confidence, on both edges.
    expect(targets).not.toContain('CustomField:RecursionGuard.hasRun');
    // Control: the object's OWN field survives untouched.
    expect(targets).toContain('CustomField:GuardObj.Status__c');
  });

  it('demotes the describe token, the __r traversal and the unvaulted receiver too', async () => {
    const { step } = await guard();
    const targets = step.actions.map((a) => a.targetId);
    expect(targets).not.toContain('CustomField:GuardObj.fields');
    expect(targets).not.toContain('CustomField:GuardParent__r.Code__c');
    expect(targets).not.toContain('CustomField:UnvaultedThing.Name');
  });

  it('DISCLOSES every demotion with a typed reason — nothing is dropped silently', async () => {
    const { data, step } = await guard();
    // Five demoted ACTION edges on this step; four distinct TOKENS in the
    // census (the read and the write on the Apex static share one token).
    expect(step.unresolvedActionsOmitted).toBe(5);
    expect(data.receiverVerification.checked).toBe(true);
    expect(data.receiverVerification.reason).toBe(null);
    expect(data.receiverVerification.demoted).toEqual({
      'apex-type-receiver': 1,
      'describe-token': 1,
      'relationship-traversal': 1,
      'receiver-not-in-vault': 1,
    });
    expect(data.receiverVerification.tokens).toEqual([
      { token: 'GuardObj.fields', reason: 'describe-token' },
      { token: 'GuardParent__r.Code__c', reason: 'relationship-traversal' },
      { token: 'RecursionGuard.hasRun', reason: 'apex-type-receiver' },
      { token: 'UnvaultedThing.Name', reason: 'receiver-not-in-vault' },
    ]);
    expect(data.disclosure).toContain('apex-type-receiver');
    expect(data.disclosure).toContain('demoted out of `soe[].actions`');
  });

  it('the demotion note survives the byte-budget rebuild of the disclosure', async () => {
    // `attachEnvelopeHonesty` rebuilds `disclosure` from a captured base on
    // every enforcement pass. A note folded in AFTER that capture would vanish
    // on any truncated object, which is exactly where honesty matters most.
    const result = await orderOfExecutionHandler(ctx, { objectApiName: 'TruncObj' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.disclosure).toContain('CHECKED against this vault');
    expect(result.value.data.receiverVerification.checked).toBe(true);
  });
});

describe('orderOfExecutionInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    const parsed = orderOfExecutionInputSchema.safeParse({
      objectApiName: 'Account',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty objectApiName', () => {
    const parsed = orderOfExecutionInputSchema.safeParse({
      objectApiName: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing objectApiName', () => {
    const parsed = orderOfExecutionInputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });
});

// =============================================================================
// N+1 query budget (finding C-1). fetchParentedFirers / fetchTriggersOnFirers
// used to `getNodeById` once per incident edge, and buildAsyncSteps /
// the flow-partition loop `listEdges` once per source — all now batched. The
// total edge+node round-trip count must NOT scale with the object's child
// fan-out. A wide object with children that are all filtered-out non-firers
// isolates the firer-resolution N+1: it produces ZERO steps (so buildStep
// never runs) but the old code issued ~fan-out node queries per resolution.
// =============================================================================
describe('orderOfExecutionHandler — bounded graph queries', () => {
  const seedWideObject = async (childCount: number) => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-ooe-budget-'));
    const opened = await openGraph(join(dir, 'ooe.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    const s = opened.value;
    // A modeled object with `childCount` CustomField children (parentOf) — none
    // are firer types, so every fetchParentedFirers call fetches them all and
    // filters them out, producing no steps. Fits in one scan window.
    const nodes: Node[] = [makeNode({ id: 'CustomObject:Wide', apiName: 'Wide' })];
    const edges: Edge[] = [];
    for (let i = 0; i < childCount; i += 1) {
      nodes.push(
        makeNode({
          id: `CustomField:Wide.F${i}__c`,
          type: 'CustomField',
          apiName: `F${i}__c`,
          parentId: 'CustomObject:Wide',
        }),
      );
      edges.push(
        makeEdge({
          fromId: 'CustomObject:Wide',
          toId: `CustomField:Wide.F${i}__c`,
          edgeType: 'parentOf',
        }),
      );
    }
    const imported = await importExtractionResults(s, [{ nodes, edges }]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    const wideCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s } as Context;
    const measured = await measureGraphQueries(s, () =>
      orderOfExecutionHandler(wideCtx, { objectApiName: 'Wide' }),
    );
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });
    return measured;
  };

  it('issues a query count independent of the object child fan-out', async () => {
    const small = await seedWideObject(60);
    const large = await seedWideObject(200);
    expect(small.result.ok).toBe(true);
    expect(large.result.ok).toBe(true);
    // Independence is the discriminator: a reintroduced per-child getNodeById
    // loop would add ~140 node queries going 60 -> 200. Batched, both counts
    // are identical.
    expect(large.nodeQueries).toBe(small.nodeQueries);
    expect(large.edgeQueries).toBe(small.edgeQueries);
    // And the constant stays far below the fan-out (a per-child N+1 at N=200
    // would be >=200 node queries across the firer resolutions).
    expect(large.nodeQueries).toBeLessThan(60);
  });
});
