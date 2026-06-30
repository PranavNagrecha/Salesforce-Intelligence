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
// ApexTrigger (with dispatchesAsync), a ValidationRule, a Create Flow,
// an onCreateOnly WorkflowRule, an AssignmentRule, and an ApprovalProcess.
// =============================================================================

const ORDER_OBJ = 'CustomObject:OrderObj';
const ORDER_VR = 'ValidationRule:OrderObj.IsValid';
const ORDER_TRIGGER = 'ApexTrigger:OrderTrigger';
const ORDER_ASYNC_JOB = 'ApexClass:OrderAsyncJob';
const ORDER_FLOW = 'Flow:OrderFlow';
const ORDER_WORKFLOW = 'WorkflowRule:OrderObj.NotifyOnCreate';
const ORDER_ASSIGNMENT = 'AssignmentRule:OrderObj.RoundRobin';
const ORDER_APPROVAL = 'ApprovalProcess:OrderObj.CreditReview';

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
  ],
  edges: [
    makeEdge({ fromId: ORDER_OBJ, toId: ORDER_VR, edgeType: 'parentOf' }),
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

describe('orderOfExecutionHandler', () => {
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
    expect(result.value.data.disclosure).toBe(
      "v2.0e composes the documented Salesforce order-of-execution instantiated against THIS org's extracted automation. Before-save record-triggered flows are modeled as the leading `before-save-flows` phase (they run BEFORE before-triggers). Conditions ARE listed but NOT EVALUATED — the tool does not know whether this particular record satisfies them at runtime. Workflow field updates can re-fire before/after-update triggers (a second pass); this composition lists each automation once and does not expand that re-entrancy. A workflow rule's time-dependent actions (its workflowTimeTriggers) are SCHEDULED for an offset measured from a record field value the offline vault cannot evaluate; this composition lists the rule once in the synchronous post-save-workflows phase and does NOT claim its time-delayed actions fire at save. Manual sharing, sharing sets, account teams, and Apex callouts after save are out of scope.",
    );
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
    // triggers precede custom validation rules, and post-save automation
    // runs assignment → workflow rules → after-save flows (NOT flows
    // first). This is the regression guard for the phase-order bug.
    expect(soe.map((s) => s.phase)).toEqual([
      'pre-save-triggers',
      'pre-save-validation',
      'save',
      'after-triggers',
      'post-save-assignment',
      'post-save-workflows',
      'post-save-flows',
      'post-save-approval',
      'post-save-async',
    ]);
    for (let i = 0; i < soe.length; i += 1) {
      expect(soe[i]?.stepIndex).toBe(i);
    }
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
