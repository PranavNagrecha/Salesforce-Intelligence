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
  whatHappensOnSaveHandler,
  whatHappensOnSaveInputSchema,
} from '../../src/tools/what-happens-on-save.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 3 },
  edges: { parentOf: 4, triggersOn: 3, firesWhen: 2 },
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
// Seed 1: empty object — no automation. Cascade emits only the save
// placeholder when no validations/triggers/etc. exist.
// =============================================================================

const EMPTY_OBJ = 'CustomObject:EmptyObj';

const emptySeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: EMPTY_OBJ,
      apiName: 'EmptyObj',
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 2: full-cascade object. Has a ValidationRule (with firesWhen
// condition), a before-insert ApexTrigger (with dispatchesAsync),
// a record-trigger Flow on Create, a WorkflowRule on onCreateOnly,
// an AssignmentRule (parentOf), and an ApprovalProcess (parentOf).
// =============================================================================

const FULL_OBJ = 'CustomObject:FullObj';
const FULL_VR = 'ValidationRule:FullObj.IsValid';
const FULL_VR_COND = 'ConditionalContext:ValidationRule:FullObj.IsValid.condition-0';
const FULL_TRIGGER = 'ApexTrigger:FullTrigger';
const FULL_ASYNC_JOB = 'ApexClass:FullAsyncJob';
const FULL_FLOW = 'Flow:FullFlow';
const FULL_BEFORE_FLOW = 'Flow:FullBeforeFlow';
const FULL_WORKFLOW = 'WorkflowRule:FullObj.NotifyOnCreate';
const FULL_WORKFLOW_COND =
  'ConditionalContext:WorkflowRule:FullObj.NotifyOnCreate.condition-0';
const FULL_ASSIGNMENT = 'AssignmentRule:FullObj.RoundRobin';
const FULL_APPROVAL = 'ApprovalProcess:FullObj.CreditReview';

const fullSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: FULL_OBJ, apiName: 'FullObj' }),
    makeNode({
      id: FULL_VR,
      type: 'ValidationRule',
      apiName: 'IsValid',
      parentId: FULL_OBJ,
      properties: {
        errorMessage: 'Industry is required.',
        errorDisplayField: 'Industry',
        errorConditionFormula: 'ISBLANK(Industry)',
        active: true,
      },
    }),
    makeNode({
      id: FULL_VR_COND,
      type: 'ConditionalContext',
      apiName: 'ValidationRule:FullObj.IsValid.condition-0',
      parentId: FULL_VR,
      properties: {
        kind: 'formula',
        expression: 'ISBLANK(Industry)',
        fieldRefs: ['CustomField:FullObj.Industry'],
        synthesized: false,
      },
    }),
    makeNode({
      id: FULL_TRIGGER,
      type: 'ApexTrigger',
      apiName: 'FullTrigger',
      properties: {
        triggerObject: 'FullObj',
        events: ['before insert', 'after insert'],
      },
    }),
    makeNode({
      id: FULL_ASYNC_JOB,
      type: 'ApexClass',
      apiName: 'FullAsyncJob',
    }),
    makeNode({
      id: FULL_FLOW,
      type: 'Flow',
      apiName: 'FullFlow',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: FULL_BEFORE_FLOW,
      type: 'Flow',
      apiName: 'FullBeforeFlow',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: FULL_WORKFLOW,
      type: 'WorkflowRule',
      apiName: 'FullObj.NotifyOnCreate',
      parentId: FULL_OBJ,
      properties: { triggerType: 'onCreateOnly', active: true },
    }),
    makeNode({
      id: FULL_WORKFLOW_COND,
      type: 'ConditionalContext',
      apiName: 'WorkflowRule:FullObj.NotifyOnCreate.condition-0',
      parentId: FULL_WORKFLOW,
      properties: {
        kind: 'criteria',
        expression: 'FullObj.Type equals New',
        fieldRefs: ['CustomField:FullObj.Type'],
        synthesized: false,
      },
    }),
    makeNode({
      id: FULL_ASSIGNMENT,
      type: 'AssignmentRule',
      apiName: 'FullObj.RoundRobin',
      parentId: FULL_OBJ,
    }),
    makeNode({
      id: FULL_APPROVAL,
      type: 'ApprovalProcess',
      apiName: 'FullObj.CreditReview',
      parentId: FULL_OBJ,
    }),
  ],
  edges: [
    // ValidationRule parentOf + firesWhen.
    makeEdge({ fromId: FULL_OBJ, toId: FULL_VR, edgeType: 'parentOf' }),
    makeEdge({
      fromId: FULL_VR,
      toId: FULL_VR_COND,
      edgeType: 'firesWhen',
      confidence: 'parsed',
    }),
    // ApexTrigger triggersOn + dispatchesAsync.
    makeEdge({
      fromId: FULL_TRIGGER,
      toId: FULL_OBJ,
      edgeType: 'triggersOn',
      properties: { events: ['before insert', 'after insert'] },
    }),
    makeEdge({
      fromId: FULL_TRIGGER,
      toId: FULL_ASYNC_JOB,
      edgeType: 'dispatchesAsync',
    }),
    // Flow triggersOn (record-triggered after-save Create).
    makeEdge({
      fromId: FULL_FLOW,
      toId: FULL_OBJ,
      edgeType: 'triggersOn',
      properties: {
        triggerType: 'RecordAfterSave',
        recordTriggerType: 'Create',
      },
    }),
    // Before-save record-triggered Flow (Spring '22) — runs FIRST.
    makeEdge({
      fromId: FULL_BEFORE_FLOW,
      toId: FULL_OBJ,
      edgeType: 'triggersOn',
      properties: {
        triggerType: 'RecordBeforeSave',
        recordTriggerType: 'Create',
      },
    }),
    // WorkflowRule parentOf + triggersOn + firesWhen.
    makeEdge({
      fromId: FULL_OBJ,
      toId: FULL_WORKFLOW,
      edgeType: 'parentOf',
    }),
    makeEdge({
      fromId: FULL_WORKFLOW,
      toId: FULL_OBJ,
      edgeType: 'triggersOn',
      properties: { triggerType: 'onCreateOnly' },
    }),
    makeEdge({
      fromId: FULL_WORKFLOW,
      toId: FULL_WORKFLOW_COND,
      edgeType: 'firesWhen',
    }),
    // AssignmentRule parentOf.
    makeEdge({
      fromId: FULL_OBJ,
      toId: FULL_ASSIGNMENT,
      edgeType: 'parentOf',
    }),
    // ApprovalProcess parentOf.
    makeEdge({
      fromId: FULL_OBJ,
      toId: FULL_APPROVAL,
      edgeType: 'parentOf',
    }),
  ],
};

// =============================================================================
// Seed 3: object whose only automation is an after-update trigger.
// Used to exercise the event filter (insert should NOT pick it up).
// =============================================================================

const UPDATE_OBJ = 'CustomObject:UpdateObj';
const UPDATE_TRIGGER = 'ApexTrigger:UpdateTrigger';

const updateOnlySeed: ExtractionResult = {
  nodes: [
    makeNode({ id: UPDATE_OBJ, apiName: 'UpdateObj' }),
    makeNode({
      id: UPDATE_TRIGGER,
      type: 'ApexTrigger',
      apiName: 'UpdateTrigger',
      properties: {
        triggerObject: 'UpdateObj',
        events: ['after update'],
      },
    }),
  ],
  edges: [
    makeEdge({
      fromId: UPDATE_TRIGGER,
      toId: UPDATE_OBJ,
      edgeType: 'triggersOn',
      properties: { events: ['after update'] },
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

// =============================================================================
// Seed 4: object without CustomObject node but with incoming triggersOn —
// mirrors standard objects (Account, Contact) whose object-meta.xml was not
// retrieved. SOE tools admit and set objectModeled: false.
// =============================================================================

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
// Seed 5: inactive Draft/Obsolete record-triggered Flows must not appear in SOE.
// =============================================================================

const INACTIVE_OBJ = 'CustomObject:InactiveObj';
const INACTIVE_ACTIVE_FLOW = 'Flow:InactiveActiveFlow';
const INACTIVE_DRAFT_FLOW = 'Flow:InactiveDraftFlow';
const INACTIVE_OBSOLETE_FLOW = 'Flow:InactiveObsoleteFlow';

const inactiveFlowSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: INACTIVE_OBJ, apiName: 'InactiveObj' }),
    makeNode({
      id: INACTIVE_ACTIVE_FLOW,
      type: 'Flow',
      apiName: 'InactiveActiveFlow',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: INACTIVE_DRAFT_FLOW,
      type: 'Flow',
      apiName: 'InactiveDraftFlow',
      properties: { status: 'Draft' },
    }),
    makeNode({
      id: INACTIVE_OBSOLETE_FLOW,
      type: 'Flow',
      apiName: 'InactiveObsoleteFlow',
      properties: { status: 'Obsolete' },
    }),
  ],
  edges: [
    makeEdge({
      fromId: INACTIVE_DRAFT_FLOW,
      toId: INACTIVE_OBJ,
      edgeType: 'triggersOn',
      properties: {
        triggerType: 'RecordBeforeSave',
        recordTriggerType: 'Update',
      },
    }),
    makeEdge({
      fromId: INACTIVE_OBSOLETE_FLOW,
      toId: INACTIVE_OBJ,
      edgeType: 'triggersOn',
      properties: {
        triggerType: 'RecordAfterSave',
        recordTriggerType: 'Update',
      },
    }),
    makeEdge({
      fromId: INACTIVE_ACTIVE_FLOW,
      toId: INACTIVE_OBJ,
      edgeType: 'triggersOn',
      properties: {
        triggerType: 'RecordAfterSave',
        recordTriggerType: 'Update',
      },
    }),
  ],
};

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-whos-'));
  const dbPath = join(tempDir, 'whos.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [
    emptySeed,
    fullSeed,
    updateOnlySeed,
    nodelessSeed,
    inactiveFlowSeed,
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

describe('whatHappensOnSaveHandler', () => {
  it('returns component-not-found for an unknown object', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'NoSuchObject',
      event: 'insert',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    expect(result.error.path).toBe('CustomObject:NoSuchObject');
  });

  it('composes SOE when object node is absent but triggersOn automation exists', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: NODELESS_OBJ_NAME,
      event: 'insert',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.objectModeled).toBe(false);
    expect(result.value.data.soe.length).toBeGreaterThan(1);
    expect(result.value.data.disclosure).toContain(
      "object's own metadata definition is not in this vault",
    );
    const triggerStep = result.value.data.soe.find(
      (s) => s.componentId === NODELESS_TRIGGER,
    );
    expect(triggerStep).toBeDefined();
  });

  it('excludes Draft and Obsolete Flows from SOE and discloses them as inactive', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'InactiveObj',
      event: 'update',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const flowIds = result.value.data.soe
      .filter((s) => s.componentType === 'Flow')
      .map((s) => s.componentId);
    expect(flowIds).toEqual([INACTIVE_ACTIVE_FLOW]);
    expect(result.value.data.inactiveConfigured).toEqual([
      {
        componentId: INACTIVE_DRAFT_FLOW,
        componentType: 'Flow',
        apiName: 'InactiveDraftFlow',
        inactiveReason: 'status: Draft',
      },
      {
        componentId: INACTIVE_OBSOLETE_FLOW,
        componentType: 'Flow',
        apiName: 'InactiveObsoleteFlow',
        inactiveReason: 'status: Obsolete',
      },
    ]);
  });

  it('returns just the save placeholder for an object with no automation', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'EmptyObj',
      event: 'insert',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { soe, summary } = result.value.data;
    // The save placeholder is always present, even with no other steps.
    expect(soe.length).toBe(1);
    expect(soe[0]?.phase).toBe('save');
    expect(summary.totalSteps).toBe(1);
    expect(summary.conditionalSteps).toBe(0);
    expect(summary.asyncFanOut).toBe(0);
  });

  it('emits steps for every SOE phase on the full-cascade object (insert)', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'FullObj',
      event: 'insert',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { soe } = result.value.data;
    const phasesPresent = new Set(soe.map((s) => s.phase));
    // Every documented phase should appear at least once.
    expect(phasesPresent.has('before-save-flows')).toBe(true);
    expect(phasesPresent.has('pre-save-validation')).toBe(true);
    expect(phasesPresent.has('pre-save-triggers')).toBe(true);
    expect(phasesPresent.has('save')).toBe(true);
    expect(phasesPresent.has('post-save-flows')).toBe(true);
    expect(phasesPresent.has('post-save-workflows')).toBe(true);
    expect(phasesPresent.has('post-save-assignment')).toBe(true);
    expect(phasesPresent.has('post-save-approval')).toBe(true);
    expect(phasesPresent.has('post-save-async')).toBe(true);
  });

  it('orders the SOE steps in canonical Salesforce sequence', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'FullObj',
      event: 'insert',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { soe } = result.value.data;
    // FullObj exercises every phase on insert: a before+after-insert
    // ApexTrigger (with dispatchesAsync), a ValidationRule, a Create
    // Flow, an onCreateOnly WorkflowRule, an AssignmentRule, and an
    // ApprovalProcess. Assert the EXACT emitted phase order against the
    // documented Salesforce order of execution: before triggers run
    // ahead of custom validation rules, and post-save automation runs
    // assignment → workflow rules → after-save flows (NOT flows first).
    expect(soe.map((s) => s.phase)).toEqual([
      'before-save-flows',
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
    // stepIndex is the 0-based position across all phases and must stay
    // monotonic with the emit order.
    for (let i = 0; i < soe.length; i += 1) {
      expect(soe[i]!.stepIndex).toBe(i);
    }
  });

  it('places before-save record-triggered flows FIRST (P11-SOE-before-save-flows)', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'FullObj',
      event: 'insert',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { soe } = result.value.data;
    // The before-save flow is the very first SOE step — ahead of before-triggers.
    expect(soe[0]?.phase).toBe('before-save-flows');
    expect(soe[0]?.componentId).toBe(FULL_BEFORE_FLOW);
    // The after-save flow stays in post-save-flows, NOT before-save-flows.
    const afterFlowStep = soe.find((s) => s.componentId === FULL_FLOW);
    expect(afterFlowStep?.phase).toBe('post-save-flows');
    // before-save flows do not fire on delete.
    const del = await whatHappensOnSaveHandler(ctx, { objectApiName: 'FullObj', event: 'delete' });
    expect(del.ok).toBe(true);
    if (!del.ok) return;
    expect(del.value.data.soe.some((s) => s.phase === 'before-save-flows')).toBe(false);
  });

  it('surfaces the error message + display field on a ValidationRule step', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'FullObj',
      event: 'insert',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const vrStep = result.value.data.soe.find((s) => s.componentId === FULL_VR);
    expect(vrStep).toBeDefined();
    // The VR step lists the rule + its condition, but a user asking "what
    // happens on save" needs the error they'd actually HIT and the field it
    // lands on — previously dropped (only the firing condition was surfaced).
    expect(vrStep?.errorMessage).toBe('Industry is required.');
    expect(vrStep?.errorDisplayField).toBe('Industry');
  });

  it('populates the conditional field when the firer has a firesWhen edge', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'FullObj',
      event: 'insert',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { soe } = result.value.data;
    const validation = soe.find((s) => s.phase === 'pre-save-validation');
    expect(validation).toBeDefined();
    expect(validation?.conditional?.conditionContextId).toBe(FULL_VR_COND);
    expect(validation?.conditional?.expression).toBe('ISBLANK(Industry)');
    expect(validation?.conditional?.fieldRefs).toHaveLength(1);

    const workflow = soe.find((s) => s.phase === 'post-save-workflows');
    expect(workflow?.conditional?.conditionContextId).toBe(FULL_WORKFLOW_COND);
    expect(workflow?.conditional?.expression).toBe('FullObj.Type equals New');
  });

  it('omits the conditional field when the firer has no firesWhen edge', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'FullObj',
      event: 'insert',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { soe } = result.value.data;
    // The assignment rule has no firesWhen edge in the fixture.
    const assignment = soe.find((s) => s.phase === 'post-save-assignment');
    expect(assignment).toBeDefined();
    expect(assignment?.conditional).toBeUndefined();
  });

  it('narrows the cascade when the event filter excludes a phase', async () => {
    // UpdateObj's only trigger fires `after update`. Calling with
    // `event: 'insert'` should produce NO pre-save-triggers entries
    // for that trigger.
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'UpdateObj',
      event: 'insert',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { soe } = result.value.data;
    // Only the save placeholder should appear.
    const triggerSteps = soe.filter((s) => s.componentType === 'ApexTrigger');
    expect(triggerSteps.length).toBe(0);
  });

  it('includes the after-update trigger when event matches', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'UpdateObj',
      event: 'update',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { soe } = result.value.data;
    const triggerSteps = soe.filter((s) => s.componentType === 'ApexTrigger');
    expect(triggerSteps.length).toBe(1);
    expect(triggerSteps[0]?.componentId).toBe(UPDATE_TRIGGER);
    // An after-<event> trigger belongs in the `after-triggers` phase (it fires
    // AFTER the save), not `pre-save-triggers`. The composer previously
    // mislabelled it because the `SoePhase` union lacked an `after-triggers`
    // value, so the after-triggers loop reused `pre-save-triggers`.
    expect(triggerSteps[0]?.phase).toBe('after-triggers');
  });

  it('populates the async fan-out from triggers that dispatch async work', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'FullObj',
      event: 'insert',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { soe, summary } = result.value.data;
    const asyncSteps = soe.filter((s) => s.phase === 'post-save-async');
    expect(asyncSteps.length).toBe(1);
    expect(asyncSteps[0]?.componentId).toBe(FULL_ASYNC_JOB);
    expect(summary.asyncFanOut).toBe(1);
  });

  it('omits validation rules from the cascade on delete events', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'FullObj',
      event: 'delete',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { soe } = result.value.data;
    const validations = soe.filter((s) => s.phase === 'pre-save-validation');
    expect(validations.length).toBe(0);
    // Workflows also don't fire on delete.
    const workflows = soe.filter((s) => s.phase === 'post-save-workflows');
    expect(workflows.length).toBe(0);
  });

  it('omits the matched Flow when its recordTriggerType does not match', async () => {
    // The flow fixture has recordTriggerType: 'Create' so update should
    // NOT include it; delete should also not.
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'FullObj',
      event: 'update',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { soe } = result.value.data;
    const flowSteps = soe.filter((s) => s.phase === 'post-save-flows');
    expect(flowSteps.length).toBe(0);
  });

  it('echoes the recordTypeId verbatim when provided', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'FullObj',
      event: 'insert',
      recordTypeId: 'RecordType:FullObj.Standard',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.recordTypeId).toBe('RecordType:FullObj.Standard');
  });

  it('returns null recordTypeId when not provided', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'FullObj',
      event: 'insert',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.recordTypeId).toBe(null);
  });

  it('carries the verbatim honesty-axis disclosure', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'EmptyObj',
      event: 'insert',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The disclosure must be the exact string the spec mandates.
    expect(result.value.data.disclosure).toBe(
      "v2.0e composes the documented Salesforce order-of-execution instantiated against THIS org's extracted automation. Before-save record-triggered flows are modeled as the leading `before-save-flows` phase (they run BEFORE before-triggers). Conditions ARE listed but NOT EVALUATED — the tool does not know whether this particular record satisfies them at runtime. Workflow field updates can re-fire before/after-update triggers (a second pass); this composition lists each automation once and does not expand that re-entrancy. Manual sharing, sharing sets, account teams, and Apex callouts after save are out of scope.",
    );
  });

  it('summary.conditionalSteps reflects the count of steps with firesWhen', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'FullObj',
      event: 'insert',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { soe, summary } = result.value.data;
    const conditionalCount = soe.filter((s) => s.conditional !== undefined).length;
    expect(summary.conditionalSteps).toBe(conditionalCount);
    expect(summary.conditionalSteps).toBe(2); // ValidationRule + WorkflowRule.
  });
});

describe('whatHappensOnSaveInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    const parsed = whatHappensOnSaveInputSchema.safeParse({
      objectApiName: 'Account',
      event: 'insert',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts the upsert event', () => {
    const parsed = whatHappensOnSaveInputSchema.safeParse({
      objectApiName: 'Account',
      event: 'upsert',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unrecognised event', () => {
    const parsed = whatHappensOnSaveInputSchema.safeParse({
      objectApiName: 'Account',
      event: 'merge',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty objectApiName', () => {
    const parsed = whatHappensOnSaveInputSchema.safeParse({
      objectApiName: '',
      event: 'insert',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing event', () => {
    const parsed = whatHappensOnSaveInputSchema.safeParse({
      objectApiName: 'Account',
    });
    expect(parsed.success).toBe(false);
  });

  it('normalizes trigger-style event phrasings to the bare DML event (B4)', () => {
    for (const [input, expected] of [
      ['after update', 'update'],
      ['before insert', 'insert'],
      ['After Update', 'update'],
      ['UPDATE', 'update'],
    ] as const) {
      const parsed = whatHappensOnSaveInputSchema.safeParse({
        objectApiName: 'Account',
        event: input,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.event).toBe(expected);
    }
  });
});
