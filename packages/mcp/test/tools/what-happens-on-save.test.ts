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
import { runTool } from '../../src/tools/index.js';
import {
  computePhasesOmitted,
  tallyPhaseCounts,
  whatHappensOnSaveHandler,
  whatHappensOnSaveInputSchema,
} from '../../src/tools/what-happens-on-save.js';

import { measureGraphQueries } from './_graph-query-budget.js';

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

// =============================================================================
// Seed 6: object with TWO active after-save flows — one with an explicit
// recordTriggerType (Update), one whose triggersOn edge OMITS recordTriggerType
// (the extractor did not stamp it / the Flow defaulted it). Both are real,
// firing automations: the absent-value flow must NOT be silently dropped, or
// the active-flow count under-reports by half (the enumeration-undercount bug).
// =============================================================================

const ABSENT_OBJ = 'CustomObject:AbsentObj';
const ABSENT_EXPLICIT_FLOW = 'Flow:AbsentExplicitFlow';
const ABSENT_MISSING_FLOW = 'Flow:AbsentMissingTypeFlow';

const absentRecordTriggerTypeSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: ABSENT_OBJ, apiName: 'AbsentObj' }),
    makeNode({
      id: ABSENT_EXPLICIT_FLOW,
      type: 'Flow',
      apiName: 'AbsentExplicitFlow',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: ABSENT_MISSING_FLOW,
      type: 'Flow',
      apiName: 'AbsentMissingTypeFlow',
      properties: { status: 'Active' },
    }),
  ],
  edges: [
    makeEdge({
      fromId: ABSENT_EXPLICIT_FLOW,
      toId: ABSENT_OBJ,
      edgeType: 'triggersOn',
      properties: {
        triggerType: 'RecordAfterSave',
        recordTriggerType: 'Update',
      },
    }),
    // After-save flow whose edge has the before/after discriminator but NO
    // recordTriggerType — the dropped-flow case.
    makeEdge({
      fromId: ABSENT_MISSING_FLOW,
      toId: ABSENT_OBJ,
      edgeType: 'triggersOn',
      properties: {
        triggerType: 'RecordAfterSave',
      },
    }),
  ],
};

// =============================================================================
// Seed 7: real-org-shape Contact fixture — models the dense-automation pattern
// found on the Contact standard object: multiple active triggers with different
// event sets, ONE Inactive trigger (status: Inactive), plus after-save flows
// with recordTriggerType Create / Update / CreateAndUpdate and various statuses.
//
// This is the fixture-vs-reality gap left after commit 9b3c8a15: that commit
// fixed the recordTriggerType absent-value undercount but did NOT cover the
// case of an Inactive ApexTrigger being silently included in the active SOE
// steps (isActiveSoeFirer ignored ApexTrigger.status). A real org's Contact
// object always has at least one Inactive trigger; without the status check the
// inactive trigger inflates the after-triggers count and the wrong component
// appears in the "automation that fires" list.
// =============================================================================

const STDOBJ = 'CustomObject:StdObj';

// Two active triggers that fire on both after insert and after update.
const TRIG_AFTER_BOTH = 'ApexTrigger:StdObjTriggerA'; // mirrors ContactTrigger
const TRIG_AFTER_BOTH_2 = 'ApexTrigger:StdObjTriggerB'; // mirrors FSR_TriggerContactTest
// One trigger that fires on every DML event (mirrors dlrs_ContactTrigger).
const TRIG_ALL_EVENTS = 'ApexTrigger:StdObjTriggerC';
// One INACTIVE trigger with after insert — must not appear in active steps.
const TRIG_INACTIVE = 'ApexTrigger:StdObjInactiveTrigger';
// Active after-save flows.
const FLOW_AS_CREATE_UPDATE = 'Flow:StdObjAfterSaveCreateUpdate'; // recordTriggerType: CreateAndUpdate
const FLOW_AS_UPDATE_ONLY = 'Flow:StdObjAfterSaveUpdateOnly'; // recordTriggerType: Update
const FLOW_AS_CREATE_ONLY = 'Flow:StdObjAfterSaveCreateOnly'; // recordTriggerType: Create
// Inactive after-save flow — must not appear in active steps.
const FLOW_AS_OBSOLETE = 'Flow:StdObjAfterSaveObsolete'; // status: Obsolete

const realOrgShapeSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: STDOBJ, apiName: 'StdObj' }),
    makeNode({
      id: TRIG_AFTER_BOTH,
      type: 'ApexTrigger',
      apiName: 'StdObjTriggerA',
      properties: {
        status: 'Active',
        events: ['after insert', 'after update'],
        triggerObject: 'StdObj',
      },
    }),
    makeNode({
      id: TRIG_AFTER_BOTH_2,
      type: 'ApexTrigger',
      apiName: 'StdObjTriggerB',
      properties: {
        status: 'Active',
        events: ['after insert', 'after update'],
        triggerObject: 'StdObj',
      },
    }),
    makeNode({
      id: TRIG_ALL_EVENTS,
      type: 'ApexTrigger',
      apiName: 'StdObjTriggerC',
      properties: {
        status: 'Active',
        events: [
          'before delete', 'before insert', 'before update',
          'after delete', 'after insert', 'after update',
        ],
        triggerObject: 'StdObj',
      },
    }),
    // Inactive trigger — status: Inactive. Must be excluded from active steps
    // and disclosed in inactiveConfigured (mirrors autoCreateStudentAccountTrigger).
    makeNode({
      id: TRIG_INACTIVE,
      type: 'ApexTrigger',
      apiName: 'StdObjInactiveTrigger',
      properties: {
        status: 'Inactive',
        events: ['after insert'],
        triggerObject: 'StdObj',
      },
    }),
    makeNode({
      id: FLOW_AS_CREATE_UPDATE,
      type: 'Flow',
      apiName: 'StdObjAfterSaveCreateUpdate',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: FLOW_AS_UPDATE_ONLY,
      type: 'Flow',
      apiName: 'StdObjAfterSaveUpdateOnly',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: FLOW_AS_CREATE_ONLY,
      type: 'Flow',
      apiName: 'StdObjAfterSaveCreateOnly',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: FLOW_AS_OBSOLETE,
      type: 'Flow',
      apiName: 'StdObjAfterSaveObsolete',
      properties: { status: 'Obsolete' },
    }),
  ],
  edges: [
    makeEdge({
      fromId: TRIG_AFTER_BOTH,
      toId: STDOBJ,
      edgeType: 'triggersOn',
      properties: { events: ['after insert', 'after update'] },
    }),
    makeEdge({
      fromId: TRIG_AFTER_BOTH_2,
      toId: STDOBJ,
      edgeType: 'triggersOn',
      properties: { events: ['after insert', 'after update'] },
    }),
    makeEdge({
      fromId: TRIG_ALL_EVENTS,
      toId: STDOBJ,
      edgeType: 'triggersOn',
      properties: {
        events: [
          'before delete', 'before insert', 'before update',
          'after delete', 'after insert', 'after update',
        ],
      },
    }),
    makeEdge({
      fromId: TRIG_INACTIVE,
      toId: STDOBJ,
      edgeType: 'triggersOn',
      properties: { events: ['after insert'] },
    }),
    makeEdge({
      fromId: FLOW_AS_CREATE_UPDATE,
      toId: STDOBJ,
      edgeType: 'triggersOn',
      properties: { triggerType: 'RecordAfterSave', recordTriggerType: 'CreateAndUpdate' },
    }),
    makeEdge({
      fromId: FLOW_AS_UPDATE_ONLY,
      toId: STDOBJ,
      edgeType: 'triggersOn',
      properties: { triggerType: 'RecordAfterSave', recordTriggerType: 'Update' },
    }),
    makeEdge({
      fromId: FLOW_AS_CREATE_ONLY,
      toId: STDOBJ,
      edgeType: 'triggersOn',
      properties: { triggerType: 'RecordAfterSave', recordTriggerType: 'Create' },
    }),
    makeEdge({
      fromId: FLOW_AS_OBSOLETE,
      toId: STDOBJ,
      edgeType: 'triggersOn',
      properties: { triggerType: 'RecordAfterSave', recordTriggerType: 'CreateAndUpdate' },
    }),
  ],
};

// =============================================================================
// Seed 8 (R6-07): duplicate-rules phase. DupObj has an ACTIVE DuplicateRule
// whose operationsOnInsert includes `Block` (referencing one MatchingRule)
// and an INACTIVE DuplicateRule (isActive: false) that must be excluded from
// the phase and disclosed in inactiveConfigured, mirroring the
// Draft/Obsolete-Flow and active:false-rule convention every other SOE phase
// follows.
// =============================================================================

const DUP_OBJ = 'CustomObject:DupObj';
const DUP_ACTIVE_RULE = 'DuplicateRule:DupObj.ActiveBlockRule';
const DUP_INACTIVE_RULE = 'DuplicateRule:DupObj.RetiredRule';
const DUP_MATCHING_RULE = 'MatchingRule:DupObj.NameMatch';

const duplicateRuleSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: DUP_OBJ, apiName: 'DupObj' }),
    makeNode({
      id: DUP_ACTIVE_RULE,
      type: 'DuplicateRule',
      apiName: 'DupObj.ActiveBlockRule',
      parentId: DUP_OBJ,
      properties: {
        isActive: true,
        actionOnInsert: 'Block',
        actionOnUpdate: 'Allow',
        operationsOnInsert: ['Block'],
        operationsOnUpdate: ['Report'],
      },
    }),
    makeNode({
      id: DUP_INACTIVE_RULE,
      type: 'DuplicateRule',
      apiName: 'DupObj.RetiredRule',
      parentId: DUP_OBJ,
      properties: {
        isActive: false,
        operationsOnInsert: ['Report'],
        operationsOnUpdate: ['Report'],
      },
    }),
    makeNode({
      id: DUP_MATCHING_RULE,
      type: 'MatchingRule',
      apiName: 'DupObj.NameMatch',
      parentId: DUP_OBJ,
    }),
  ],
  edges: [
    makeEdge({ fromId: DUP_OBJ, toId: DUP_ACTIVE_RULE, edgeType: 'parentOf' }),
    makeEdge({ fromId: DUP_OBJ, toId: DUP_INACTIVE_RULE, edgeType: 'parentOf' }),
    makeEdge({
      fromId: DUP_ACTIVE_RULE,
      toId: DUP_MATCHING_RULE,
      edgeType: 'references',
      properties: { matcherIndex: 0, objectMappingCount: 0 },
    }),
    makeEdge({
      fromId: DUP_INACTIVE_RULE,
      toId: DUP_MATCHING_RULE,
      edgeType: 'references',
      properties: { matcherIndex: 0, objectMappingCount: 0 },
    }),
  ],
};

// =============================================================================
// Seed 9 (R6-07): post-save-rollup-recalc phase. RollupChild is the detail
// side of a master-detail relationship; RollupParent carries a `type:
// Summary` CustomField (`Total_Amount__c`) whose `summaryForeignKey` names
// RollupChild as the child object. Saving RollupChild must name the parent
// field in the rollup phase.
// =============================================================================

const ROLLUP_PARENT = 'CustomObject:RollupParent';
const ROLLUP_CHILD = 'CustomObject:RollupChild';
const ROLLUP_FIELD = 'CustomField:RollupParent.Total_Amount__c';
const ROLLUP_COUNT_FIELD = 'CustomField:RollupParent.Child_Count__c';

const rollupRecalcSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: ROLLUP_PARENT, apiName: 'RollupParent' }),
    makeNode({ id: ROLLUP_CHILD, apiName: 'RollupChild' }),
    makeNode({
      id: ROLLUP_FIELD,
      type: 'CustomField',
      apiName: 'Total_Amount__c',
      parentId: ROLLUP_PARENT,
      properties: {
        dataType: 'Summary',
        summarizedField: 'RollupChild.Amount__c',
        summaryForeignKey: 'RollupChild.Parent__c',
        summaryOperation: 'sum',
      },
    }),
    makeNode({
      id: ROLLUP_COUNT_FIELD,
      type: 'CustomField',
      apiName: 'Child_Count__c',
      parentId: ROLLUP_PARENT,
      properties: {
        dataType: 'Summary',
        summaryForeignKey: 'RollupChild.Parent__c',
        summaryOperation: 'count',
      },
    }),
  ],
  edges: [
    makeEdge({ fromId: ROLLUP_PARENT, toId: ROLLUP_FIELD, edgeType: 'parentOf' }),
    makeEdge({ fromId: ROLLUP_PARENT, toId: ROLLUP_COUNT_FIELD, edgeType: 'parentOf' }),
  ],
};

// =============================================================================
// Seed 10 (R6-07): combined phase-order fixture. R607Obj exercises
// pre-save-triggers, pre-save-validation, duplicate-rules, save,
// after-triggers, post-save-workflows, and post-save-rollup-recalc (as the
// rollup child of R607RollupParent) together, so the EXACT documented
// Salesforce phase order — duplicate rules ahead of save, rollup recalc near
// the end — is a regression-guarded assertion, not an inference from two
// separate single-phase fixtures.
// =============================================================================

const R607_OBJ = 'CustomObject:R607Obj';
const R607_VR = 'ValidationRule:R607Obj.IsValid';
const R607_DUP = 'DuplicateRule:R607Obj.ActiveBlockRule';
const R607_TRIGGER = 'ApexTrigger:R607Trigger';
const R607_WORKFLOW = 'WorkflowRule:R607Obj.NotifyOnCreate';
const R607_ROLLUP_PARENT = 'CustomObject:R607RollupParent';
const R607_ROLLUP_FIELD = 'CustomField:R607RollupParent.Total__c';

const r607OrderSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: R607_OBJ, apiName: 'R607Obj' }),
    makeNode({
      id: R607_VR,
      type: 'ValidationRule',
      apiName: 'IsValid',
      parentId: R607_OBJ,
      properties: { errorMessage: 'Invalid.', active: true },
    }),
    makeNode({
      id: R607_DUP,
      type: 'DuplicateRule',
      apiName: 'R607Obj.ActiveBlockRule',
      parentId: R607_OBJ,
      properties: { isActive: true, operationsOnInsert: ['Block'], operationsOnUpdate: ['Block'] },
    }),
    makeNode({
      id: R607_TRIGGER,
      type: 'ApexTrigger',
      apiName: 'R607Trigger',
      properties: { triggerObject: 'R607Obj', events: ['before insert', 'after insert'] },
    }),
    makeNode({
      id: R607_WORKFLOW,
      type: 'WorkflowRule',
      apiName: 'R607Obj.NotifyOnCreate',
      parentId: R607_OBJ,
      properties: { triggerType: 'onCreateOnly' },
    }),
    makeNode({ id: R607_ROLLUP_PARENT, apiName: 'R607RollupParent' }),
    makeNode({
      id: R607_ROLLUP_FIELD,
      type: 'CustomField',
      apiName: 'Total__c',
      parentId: R607_ROLLUP_PARENT,
      properties: {
        dataType: 'Summary',
        summarizedField: 'R607Obj.Amount__c',
        summaryForeignKey: 'R607Obj.Parent__c',
        summaryOperation: 'sum',
      },
    }),
  ],
  edges: [
    makeEdge({ fromId: R607_OBJ, toId: R607_VR, edgeType: 'parentOf' }),
    makeEdge({ fromId: R607_OBJ, toId: R607_DUP, edgeType: 'parentOf' }),
    makeEdge({
      fromId: R607_TRIGGER,
      toId: R607_OBJ,
      edgeType: 'triggersOn',
      properties: { events: ['before insert', 'after insert'] },
    }),
    makeEdge({ fromId: R607_OBJ, toId: R607_WORKFLOW, edgeType: 'parentOf' }),
    makeEdge({
      fromId: R607_WORKFLOW,
      toId: R607_OBJ,
      edgeType: 'triggersOn',
      properties: { triggerType: 'onCreateOnly' },
    }),
    makeEdge({ fromId: R607_ROLLUP_PARENT, toId: R607_ROLLUP_FIELD, edgeType: 'parentOf' }),
  ],
};

// =============================================================================
// Seed 11 (R6-23): entitlementProcessNotes informational rider. R623Obj
// carries one ACTIVE EntitlementProcess (must surface), one INACTIVE
// EntitlementProcess on the SAME object (must NOT surface — active:false),
// and one ACTIVE EntitlementProcess on a DIFFERENT object (must NOT surface
// — SObjectType mismatch). R623ManyObj carries more than
// ENTITLEMENT_PROCESS_NOTE_CAP active processes to exercise the truncation
// flag.
// =============================================================================

const ENTITLEMENT_OBJ = 'CustomObject:R623Obj';
const ENTITLEMENT_PROCESS_ACTIVE = 'EntitlementProcess:Gold_Support';
const ENTITLEMENT_PROCESS_INACTIVE = 'EntitlementProcess:Old_Support';
const ENTITLEMENT_PROCESS_OTHER_OBJECT = 'EntitlementProcess:Other_Obj_Support';
const ENTITLEMENT_MANY_OBJ = 'CustomObject:R623ManyObj';

const entitlementNoteSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: ENTITLEMENT_OBJ, apiName: 'R623Obj' }),
    makeNode({
      id: ENTITLEMENT_PROCESS_ACTIVE,
      type: 'EntitlementProcess',
      apiName: 'Gold_Support',
      label: 'Gold Support',
      properties: { SObjectType: 'R623Obj', active: 'true' },
    }),
    makeNode({
      id: ENTITLEMENT_PROCESS_INACTIVE,
      type: 'EntitlementProcess',
      apiName: 'Old_Support',
      properties: { SObjectType: 'R623Obj', active: 'false' },
    }),
    makeNode({
      id: ENTITLEMENT_PROCESS_OTHER_OBJECT,
      type: 'EntitlementProcess',
      apiName: 'Other_Obj_Support',
      properties: { SObjectType: 'SomeOtherObj', active: 'true' },
    }),
    makeNode({ id: ENTITLEMENT_MANY_OBJ, apiName: 'R623ManyObj' }),
    ...Array.from({ length: 25 }, (_, i) =>
      makeNode({
        id: `EntitlementProcess:Many_Support_${i}`,
        type: 'EntitlementProcess',
        apiName: `Many_Support_${i}`,
        properties: { SObjectType: 'R623ManyObj', active: 'true' },
      }),
    ),
  ],
  edges: [],
};

// =============================================================================
// Seed (WHAT-HAPPENS-ON-SAVE-TRUNCATION-DROPS-LATER-PHASES): a single object
// whose ONE-event insert payload blows the ~40 KB SOE byte budget, forcing the
// enforcer to trim per-step actions and set `truncated: true`. The byte bulk is
// one before-insert ApexTrigger carrying a very long `writesTo` action list; the
// witness's LATER phases — duplicate-rules, after-triggers, post-save-flows,
// post-save-async — each fire on insert and must STAY disclosed under
// truncation (a host must never be able to read a trimmed `soe` and conclude
// "no duplicate rules / no after-triggers / no post-save flows / no async").
// =============================================================================

const TRUNC_SAVE_OBJ = 'CustomObject:TruncSaveObj';
const TRUNC_SAVE_BEFORE_TRIGGER = 'ApexTrigger:TruncSaveBeforeTrigger';
const TRUNC_SAVE_AFTER_TRIGGER = 'ApexTrigger:TruncSaveAfterTrigger';
const TRUNC_SAVE_DUP = 'DuplicateRule:TruncSaveObj.LaterDupRule';
const TRUNC_SAVE_AFTER_FLOW = 'Flow:TruncSaveAfterFlow';
const TRUNC_SAVE_ASYNC_JOB = 'ApexClass:TruncSaveAsyncJob';

const truncSaveSeed: ExtractionResult = (() => {
  const nodes: Node[] = [makeNode({ id: TRUNC_SAVE_OBJ, apiName: 'TruncSaveObj' })];
  const edges: Edge[] = [];
  // Byte bulk — one active before-insert ApexTrigger (absent status ⇒ active)
  // with a long `writesTo` action list (~130 serialized bytes per edge). A
  // single insert event's payload then exceeds SOE_MAX_PAYLOAD_BYTES, so the
  // enforcer trims actions and flags `truncated`. `allowStepDrop: false` (the
  // what_happens_on_save default) means it NEVER drops the STEP itself.
  nodes.push(
    makeNode({
      id: TRUNC_SAVE_BEFORE_TRIGGER,
      type: 'ApexTrigger',
      apiName: 'TruncSaveBeforeTrigger',
      properties: { triggerObject: 'TruncSaveObj', events: ['before insert'] },
    }),
  );
  edges.push(
    makeEdge({
      fromId: TRUNC_SAVE_BEFORE_TRIGGER,
      toId: TRUNC_SAVE_OBJ,
      edgeType: 'triggersOn',
      properties: { events: ['before insert'] },
    }),
  );
  for (let i = 0; i < 1000; i += 1) {
    // PascalCase receiver (`TruncSaveObj`) ⇒ a resolved field ref, so
    // buildActions KEEPS it (not an unresolved apex-receiver parse artifact).
    const fieldId = `CustomField:TruncSaveObj.Field_${String(i).padStart(4, '0')}__c`;
    edges.push(
      makeEdge({ fromId: TRUNC_SAVE_BEFORE_TRIGGER, toId: fieldId, edgeType: 'writesTo' }),
    );
  }
  // Async target the before-trigger dispatches ⇒ a post-save-async step (and one
  // more action on the trigger). PascalCase class token ⇒ kept, not filtered.
  nodes.push(
    makeNode({ id: TRUNC_SAVE_ASYNC_JOB, type: 'ApexClass', apiName: 'TruncSaveAsyncJob' }),
  );
  edges.push(
    makeEdge({
      fromId: TRUNC_SAVE_BEFORE_TRIGGER,
      toId: TRUNC_SAVE_ASYNC_JOB,
      edgeType: 'dispatchesAsync',
    }),
  );
  // duplicate-rules phase — active, blocks on insert.
  nodes.push(
    makeNode({
      id: TRUNC_SAVE_DUP,
      type: 'DuplicateRule',
      apiName: 'TruncSaveObj.LaterDupRule',
      parentId: TRUNC_SAVE_OBJ,
      properties: {
        isActive: true,
        operationsOnInsert: ['Block'],
        operationsOnUpdate: ['Block'],
      },
    }),
  );
  edges.push(makeEdge({ fromId: TRUNC_SAVE_OBJ, toId: TRUNC_SAVE_DUP, edgeType: 'parentOf' }));
  // after-triggers phase — an after-insert ApexTrigger.
  nodes.push(
    makeNode({
      id: TRUNC_SAVE_AFTER_TRIGGER,
      type: 'ApexTrigger',
      apiName: 'TruncSaveAfterTrigger',
      properties: { triggerObject: 'TruncSaveObj', events: ['after insert'] },
    }),
  );
  edges.push(
    makeEdge({
      fromId: TRUNC_SAVE_AFTER_TRIGGER,
      toId: TRUNC_SAVE_OBJ,
      edgeType: 'triggersOn',
      properties: { events: ['after insert'] },
    }),
  );
  // post-save-flows phase — an after-save record-triggered Flow on Create.
  nodes.push(
    makeNode({
      id: TRUNC_SAVE_AFTER_FLOW,
      type: 'Flow',
      apiName: 'TruncSaveAfterFlow',
      properties: { status: 'Active' },
    }),
  );
  edges.push(
    makeEdge({
      fromId: TRUNC_SAVE_AFTER_FLOW,
      toId: TRUNC_SAVE_OBJ,
      edgeType: 'triggersOn',
      properties: { triggerType: 'RecordAfterSave', recordTriggerType: 'Create' },
    }),
  );
  return { nodes, edges };
})();

// Seed (WHAT-HAPPENS-ON-SAVE-TRUNCATION-DROPS-LATER-PHASES — GLOBAL budget): an
// object whose insert SOE has so MANY firing steps that the payload SURVIVES the
// tool-local `allowStepDrop:false` trim (every step's action list is already ≤ the
// keep-all floor, so `enforceSoeByteBudget` has nothing to shed and never drops a
// step) yet is STILL well over the ~40 KB budget. The GLOBAL `jsonResult`
// responseBudget guard then tail-truncates `data.soe`, shedding the LATER phases
// first (SOE runs pre-save → save → post-save → async). The byte bulk is a large
// roster of pre-save-validation rules (the early head that survives); the
// duplicate-rules / after-triggers / post-save-flows / post-save-async firers sit
// at the tail and get dropped. This is the path the tool-local W5.1 guard cannot
// reach — the residual GLOBAL-budget honesty hole. All names synthetic.
// =============================================================================

const SAVE_HEAVY_OBJ = 'CustomObject:SaveHeavyObj';
// Enough validation rules that even with zero-action steps the composed SOE
// blows the 40 KB budget — so the GLOBAL guard (not the tool-local one) trims.
const SAVE_HEAVY_VR_COUNT = 160;
const SAVE_HEAVY_DUP_A = 'DuplicateRule:SaveHeavyObj.LaterDupA';
const SAVE_HEAVY_DUP_B = 'DuplicateRule:SaveHeavyObj.LaterDupB';
const SAVE_HEAVY_DUP_C = 'DuplicateRule:SaveHeavyObj.LaterDupC';
const SAVE_HEAVY_AFTER_TRIGGER = 'ApexTrigger:SaveHeavyAfterTrigger';
const SAVE_HEAVY_ASYNC_JOB = 'ApexClass:SaveHeavyAsyncJob';
const SAVE_HEAVY_AFTER_FLOW = 'Flow:SaveHeavyAfterFlow';

const saveHeavySeed: ExtractionResult = (() => {
  const nodes: Node[] = [makeNode({ id: SAVE_HEAVY_OBJ, apiName: 'SaveHeavyObj' })];
  const edges: Edge[] = [];
  // Byte bulk — a roster of active ValidationRules (pre-save-validation, an
  // EARLY phase). Each carries a ~120-char errorMessage so the per-step byte
  // cost pushes the whole SOE well past 40 KB, and each has ZERO action edges so
  // the tool-local action-trim has nothing to shed (allowStepDrop:false ⇒ steps
  // stay). These form the head that survives the global tail-truncation.
  for (let i = 0; i < SAVE_HEAVY_VR_COUNT; i += 1) {
    const suffix = String(i).padStart(4, '0');
    const vrId = `ValidationRule:SaveHeavyObj.SaveHeavyVR_${suffix}`;
    nodes.push(
      makeNode({
        id: vrId,
        type: 'ValidationRule',
        apiName: `SaveHeavyVR_${suffix}`,
        parentId: SAVE_HEAVY_OBJ,
        properties: {
          active: true,
          errorMessage: `Save-heavy validation rule ${suffix} blocks the save when its guarded field roster is inconsistent — synthetic message for byte bulk.`,
          errorDisplayField: null,
        },
      }),
    );
    edges.push(
      makeEdge({ fromId: SAVE_HEAVY_OBJ, toId: vrId, edgeType: 'parentOf' }),
    );
  }
  // LATER phases at the tail — each fires on insert and must be NAMED in
  // `phasesOmitted` once the global trim sheds them.
  //   duplicate-rules — three active, blocking on insert.
  for (const dupId of [SAVE_HEAVY_DUP_A, SAVE_HEAVY_DUP_B, SAVE_HEAVY_DUP_C]) {
    nodes.push(
      makeNode({
        id: dupId,
        type: 'DuplicateRule',
        apiName: dupId.slice('DuplicateRule:'.length),
        parentId: SAVE_HEAVY_OBJ,
        properties: {
          isActive: true,
          operationsOnInsert: ['Block'],
          operationsOnUpdate: ['Block'],
        },
      }),
    );
    edges.push(
      makeEdge({ fromId: SAVE_HEAVY_OBJ, toId: dupId, edgeType: 'parentOf' }),
    );
  }
  //   after-triggers — one after-insert ApexTrigger, which dispatches async.
  nodes.push(
    makeNode({
      id: SAVE_HEAVY_AFTER_TRIGGER,
      type: 'ApexTrigger',
      apiName: 'SaveHeavyAfterTrigger',
      properties: { triggerObject: 'SaveHeavyObj', events: ['after insert'] },
    }),
  );
  edges.push(
    makeEdge({
      fromId: SAVE_HEAVY_AFTER_TRIGGER,
      toId: SAVE_HEAVY_OBJ,
      edgeType: 'triggersOn',
      properties: { events: ['after insert'] },
    }),
  );
  //   post-save-async — the after-trigger dispatches to this ApexClass job.
  nodes.push(
    makeNode({ id: SAVE_HEAVY_ASYNC_JOB, type: 'ApexClass', apiName: 'SaveHeavyAsyncJob' }),
  );
  edges.push(
    makeEdge({
      fromId: SAVE_HEAVY_AFTER_TRIGGER,
      toId: SAVE_HEAVY_ASYNC_JOB,
      edgeType: 'dispatchesAsync',
    }),
  );
  //   post-save-flows — one active after-save record-triggered Flow on Create.
  nodes.push(
    makeNode({
      id: SAVE_HEAVY_AFTER_FLOW,
      type: 'Flow',
      apiName: 'SaveHeavyAfterFlow',
      properties: { status: 'Active' },
    }),
  );
  edges.push(
    makeEdge({
      fromId: SAVE_HEAVY_AFTER_FLOW,
      toId: SAVE_HEAVY_OBJ,
      edgeType: 'triggersOn',
      properties: { triggerType: 'RecordAfterSave', recordTriggerType: 'Create' },
    }),
  );
  return { nodes, edges };
})();

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
    absentRecordTriggerTypeSeed,
    realOrgShapeSeed,
    duplicateRuleSeed,
    rollupRecalcSeed,
    r607OrderSeed,
    entitlementNoteSeed,
    truncSaveSeed,
    saveHeavySeed,
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

  // GUARD (L2 alias OS / ADMIN-SURFACE-ALIAS-SKEW-CLUSTER): pre-fix the schema
  // required `objectApiName` and Zod-STRIPPED `object` / `objectId` / a
  // `CustomObject:` `componentId` -> `objectApiName: Required`. Post-fix each
  // alias resolves to the SAME composition, with `appliedScope` echoed.
  it('natural object aliases ≡ canonical objectApiName (byte-equal soe + appliedScope)', async () => {
    const run = async (raw: unknown) => {
      const parsed = whatHappensOnSaveInputSchema.safeParse(raw);
      if (!parsed.success) return null;
      return whatHappensOnSaveHandler(ctx, parsed.data);
    };
    const canonical = await run({ objectApiName: 'FullObj', event: 'insert' });
    const byObject = await run({ object: 'FullObj', event: 'insert' });
    const byObjectId = await run({ objectId: 'CustomObject:FullObj', event: 'insert' });
    const byComponent = await run({ componentId: 'CustomObject:FullObj', event: 'insert' });
    for (const r of [canonical, byObject, byObjectId, byComponent]) {
      expect(r).not.toBeNull();
      expect(r?.ok).toBe(true);
    }
    if (!canonical?.ok || !byObject?.ok || !byObjectId?.ok || !byComponent?.ok) return;
    expect(canonical.value.data.appliedScope).toEqual({
      componentId: 'CustomObject:FullObj',
      object: 'FullObj',
    });
    for (const r of [byObject, byObjectId, byComponent]) {
      expect(r.value.data.soe).toEqual(canonical.value.data.soe);
      expect(r.value.data.summary).toEqual(canonical.value.data.summary);
      expect(r.value.data.appliedScope).toEqual(canonical.value.data.appliedScope);
      expect(r.value.data.objectApiName).toBe('FullObj');
    }
  });

  it('disagreeing object aliases → invalid-query', async () => {
    const parsed = whatHappensOnSaveInputSchema.safeParse({
      objectApiName: 'FullObj',
      object: 'EmptyObj',
      event: 'insert',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const r = await whatHappensOnSaveHandler(ctx, parsed.data);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid-query');
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

  it('enumerates an after-save flow whose triggersOn edge OMITS recordTriggerType (under-count guard)', async () => {
    // AbsentObj has two active after-save flows: one explicit (Update) and one
    // with NO recordTriggerType on its triggersOn edge. Both fire on update —
    // the absent-value flow must not be silently dropped, or the active-flow
    // count under-reports by half.
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'AbsentObj',
      event: 'update',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const flowSteps = result.value.data.soe.filter(
      (s) => s.phase === 'post-save-flows',
    );
    // BOTH flows are enumerated and individually named.
    expect(flowSteps.length).toBe(2);
    const named = flowSteps.map((s) => s.apiName).sort();
    expect(named).toContain('AbsentExplicitFlow');
    expect(named).toContain('AbsentMissingTypeFlow');
  });

  it('treats an absent recordTriggerType as CreateAndUpdate — fires on insert too, but never on delete', async () => {
    const onInsert = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'AbsentObj',
      event: 'insert',
    });
    expect(onInsert.ok).toBe(true);
    if (!onInsert.ok) return;
    const insertFlows = onInsert.value.data.soe.filter(
      (s) => s.phase === 'post-save-flows',
    );
    // The absent-type flow fires on insert (CreateAndUpdate default); the
    // explicit Update-only flow does not.
    expect(insertFlows.map((s) => s.apiName)).toContain('AbsentMissingTypeFlow');
    expect(insertFlows.map((s) => s.apiName)).not.toContain('AbsentExplicitFlow');

    const onDelete = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'AbsentObj',
      event: 'delete',
    });
    expect(onDelete.ok).toBe(true);
    if (!onDelete.ok) return;
    // An absent recordTriggerType is never a delete-triggered flow.
    expect(
      onDelete.value.data.soe.filter((s) => s.phase === 'post-save-flows').length,
    ).toBe(0);
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
      "v2.0e composes the documented Salesforce order-of-execution instantiated against THIS org's extracted automation. Before-save record-triggered flows are modeled as the leading `before-save-flows` phase (they run BEFORE before-triggers). Duplicate rules are modeled as their own `duplicate-rules` phase, running after before-triggers and validation but BEFORE the save — evaluated on insert/update only, with the effective Block/Allow/Alert/Report operations surfaced per rule. Conditions ARE listed but NOT EVALUATED — the tool does not know whether this particular record satisfies them at runtime. Workflow field updates can re-fire before/after-update triggers (a second pass); this composition lists each automation once and does not expand that re-entrancy. A workflow rule's time-dependent actions (its workflowTimeTriggers) are SCHEDULED for an offset measured from a record field value the offline vault cannot evaluate; this composition lists the rule once in the synchronous post-save-workflows phase and does NOT claim its time-delayed actions fire at save. Parent Summary (roll-up) fields that aggregate this object recalculate in the `post-save-rollup-recalc` phase, capped to ONE level — a grandparent's own rollup on that recalculated parent is NOT walked — and the parent's own triggers/flows/workflows that its recalculated save would fire are NOT expanded (no re-entrancy). Entitlement-process and milestone-type METADATA is modeled elsewhere in the vault (R6-18: `EntitlementProcess`/`MilestoneType` nodes, queryable via `sfi.get_component` / `sfi.get_edges`, including each milestone's declared target `minutesToComplete` as of R7-C7) — but this composition does NOT simulate entitlement milestones as an order-of-execution phase: whether a specific record is currently on-track or breached against those target minutes is live, per-record timer data this offline vault cannot hold. Criteria-based sharing recalculation — the FINAL step in Salesforce's documented order-of-execution, evaluated after every phase modeled here (including post-save-async) — is also NOT modeled: a save that causes a record to newly match or stop matching a criteria-based sharing rule's criteria triggers a sharing recalculation this composition does not surface. Manual sharing, sharing sets, account teams, and Apex callouts after save are out of scope.",
    );
  });

  it('CR-CAP-11b: the time-trigger disclosure sentence is present and makes no firing claim', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'EmptyObj',
      event: 'insert',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data.disclosure;
    expect(d).toContain('SCHEDULED');
    expect(d).toContain('does NOT claim its time-delayed actions fire at save');
    // It must NOT assert the time-trigger fires.
    expect(/time-(?:delayed|dependent) actions fire(?! at save)/.test(d)).toBe(
      false,
    );
  });

  it('grounds a per-phase active-component count (answers "how many fire, and in what order")', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'FullObj',
      event: 'insert',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { soe, summary } = result.value.data;
    // The count question must be answerable from the summary, not re-bucketed
    // by the caller. activeComponents = every step except the save placeholder.
    expect(summary.activeComponents).toBe(soe.length - 1);
    // FullObj on insert: 1 before-save flow, 1 before-trigger, 1 validation
    // rule, 1 after-trigger, 1 assignment rule, 1 workflow rule, 1 after-save
    // flow, 1 approval, 1 async job = 9 active components.
    expect(summary.activeComponents).toBe(9);
    // Per-phase counts are present for EVERY automation phase (zero-filled),
    // never the save placeholder, and tally exactly the emitted steps.
    expect(summary.phaseCounts).toEqual({
      'before-save-flows': 1,
      'pre-save-triggers': 1,
      'pre-save-validation': 1,
      'duplicate-rules': 0,
      'after-triggers': 1,
      'post-save-assignment': 1,
      'post-save-workflows': 1,
      'post-save-flows': 1,
      'post-save-approval': 1,
      'post-save-rollup-recalc': 0,
      'post-save-async': 1,
    });
    expect('save' in summary.phaseCounts).toBe(false);
    // The map's values sum to activeComponents.
    const summed = Object.values(summary.phaseCounts).reduce((a, b) => a + b, 0);
    expect(summed).toBe(summary.activeComponents);
  });

  it('per-phase counts reflect the deactivation delta — inactive components are not counted', async () => {
    // InactiveObj has one active after-save flow plus a Draft + an Obsolete
    // flow on update. Only the active one is counted; the inactive pair is
    // disclosed separately, so "how many still fire after deactivation" is the
    // grounded count, not a generic deferral.
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'InactiveObj',
      event: 'update',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { summary, inactiveConfigured } = result.value.data;
    expect(summary.phaseCounts['post-save-flows']).toBe(1);
    expect(summary.activeComponents).toBe(1);
    // The two inactive flows are accounted for separately (the delta source).
    expect(inactiveConfigured?.length).toBe(2);
  });

  it('per-phase counts are all zero (and activeComponents is 0) for an automation-free object', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'EmptyObj',
      event: 'insert',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { summary } = result.value.data;
    // Only the save placeholder exists, which is NOT automation.
    expect(summary.activeComponents).toBe(0);
    expect(Object.values(summary.phaseCounts).every((c) => c === 0)).toBe(true);
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

  // =========================================================================
  // Real-org-shape Contact fixture tests (Seed 7).
  // These cover the fixture-vs-reality gap left after commit 9b3c8a15:
  //   • An Inactive ApexTrigger (status: Inactive) must be excluded from the
  //     active SOE steps and disclosed in inactiveConfigured.
  //   • Active after-save flows with recordTriggerType: Create are excluded
  //     from the update event (only CreateAndUpdate + Update fire on update).
  //   • The after-triggers and post-save-flows phaseCounts are exact.
  // =========================================================================

  it('real-org-shape: excludes Inactive ApexTrigger from active after-triggers and discloses it', async () => {
    // StdObj insert: both active triggers with after insert fire; the Inactive
    // trigger also has after insert but MUST be excluded and disclosed.
    // Without the ApexTrigger status check in isActiveSoeFirer the inactive
    // trigger inflates after-triggers from 3 to 4.
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'StdObj',
      event: 'insert',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { soe, summary, inactiveConfigured } = result.value.data;

    const afterTrigSteps = soe.filter((s) => s.phase === 'after-triggers');
    // 3 active triggers have after insert: TriggerA, TriggerB, TriggerC.
    // StdObjInactiveTrigger (Inactive) must NOT appear.
    expect(summary.phaseCounts['after-triggers']).toBe(3);
    expect(afterTrigSteps.map((s) => s.componentId).sort()).toEqual(
      [TRIG_AFTER_BOTH, TRIG_AFTER_BOTH_2, TRIG_ALL_EVENTS].sort(),
    );
    expect(afterTrigSteps.some((s) => s.componentId === TRIG_INACTIVE)).toBe(false);

    // The inactive trigger must be disclosed in inactiveConfigured.
    const inactiveTrigEntry = inactiveConfigured?.find(
      (ic) => ic.componentId === TRIG_INACTIVE,
    );
    expect(inactiveTrigEntry).toBeDefined();
    expect(inactiveTrigEntry?.inactiveReason).toBe('status: Inactive');
  });

  it('real-org-shape: after-update event enumerates correct after-triggers and post-save-flows counts', async () => {
    // StdObj update:
    //   after-triggers: TriggerA (after update), TriggerB (after update), TriggerC (after update) = 3.
    //   StdObjInactiveTrigger (Inactive) is excluded.
    //   post-save-flows: CreateAndUpdate (fires on update) + UpdateOnly = 2.
    //   CreateOnly does NOT match update. Obsolete flow is inactive.
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'StdObj',
      event: 'update',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { summary, inactiveConfigured } = result.value.data;

    expect(summary.phaseCounts['after-triggers']).toBe(3);
    expect(summary.phaseCounts['post-save-flows']).toBe(2);

    // The inactive trigger and obsolete flow are both disclosed.
    const ids = inactiveConfigured?.map((ic) => ic.componentId) ?? [];
    expect(ids).toContain(TRIG_INACTIVE);
    expect(ids).toContain(FLOW_AS_OBSOLETE);
  });

  it('real-org-shape: Inactive ApexTrigger inactiveReason is "status: Inactive"', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'StdObj',
      event: 'update',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const inactive = result.value.data.inactiveConfigured ?? [];
    const entry = inactive.find((ic) => ic.componentId === TRIG_INACTIVE);
    expect(entry).toBeDefined();
    expect(entry?.componentType).toBe('ApexTrigger');
    expect(entry?.inactiveReason).toBe('status: Inactive');
  });

  // ===========================================================================
  // R6-07: duplicate-rules phase (Seed 8).
  // ===========================================================================

  it('includes only the active DuplicateRule in the duplicate-rules phase and discloses the inactive one', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'DupObj',
      event: 'insert',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { soe, inactiveConfigured } = result.value.data;
    const dupSteps = soe.filter((s) => s.phase === 'duplicate-rules');
    expect(dupSteps.map((s) => s.componentId)).toEqual([DUP_ACTIVE_RULE]);
    expect(
      inactiveConfigured?.some((ic) => ic.componentId === DUP_INACTIVE_RULE),
    ).toBe(true);
    expect(
      inactiveConfigured?.find((ic) => ic.componentId === DUP_INACTIVE_RULE)
        ?.inactiveReason,
    ).toBe('isActive: false');
  });

  it('surfaces blocksOnSave, duplicateRuleOperations, and the referenced MatchingRule for a DuplicateRule step', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'DupObj',
      event: 'insert',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const step = result.value.data.soe.find((s) => s.componentId === DUP_ACTIVE_RULE);
    expect(step).toBeDefined();
    expect(step?.blocksOnSave).toBe(true);
    expect(step?.duplicateRuleOperations).toEqual(['Block']);
    expect(step?.actions).toEqual([
      {
        kind: 'references',
        targetId: DUP_MATCHING_RULE,
        description: `references ${DUP_MATCHING_RULE}`,
      },
    ]);
  });

  it('the same DuplicateRule does not block on update — operationsOnUpdate has no Block', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'DupObj',
      event: 'update',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const step = result.value.data.soe.find((s) => s.componentId === DUP_ACTIVE_RULE);
    expect(step).toBeDefined();
    expect(step?.blocksOnSave).toBe(false);
    expect(step?.duplicateRuleOperations).toEqual(['Report']);
  });

  it('excludes duplicate-rules on delete — duplicate rules only evaluate on insert/update', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'DupObj',
      event: 'delete',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.soe.some((s) => s.phase === 'duplicate-rules')).toBe(
      false,
    );
  });

  // ===========================================================================
  // R6-07: post-save-rollup-recalc phase (Seed 9).
  // ===========================================================================

  it('names the parent Summary field(s) in post-save-rollup-recalc when this object is a rollup child', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'RollupChild',
      event: 'insert',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rollupSteps = result.value.data.soe.filter(
      (s) => s.phase === 'post-save-rollup-recalc',
    );
    // Both the sum field and the count field on RollupParent name RollupChild
    // as their summaryForeignKey child object.
    const fieldIds = rollupSteps.map((s) => s.componentId).sort();
    expect(fieldIds).toEqual([ROLLUP_COUNT_FIELD, ROLLUP_FIELD].sort());
    const sumStep = rollupSteps.find((s) => s.componentId === ROLLUP_FIELD);
    expect(sumStep?.apiName).toBe('Total_Amount__c');
    expect(sumStep?.actions).toEqual([
      {
        kind: 'recalculates',
        targetId: ROLLUP_PARENT,
        description: `recalculates sum(RollupChild.Amount__c) on ${ROLLUP_PARENT}`,
      },
    ]);
    const countStep = rollupSteps.find((s) => s.componentId === ROLLUP_COUNT_FIELD);
    // A count rollup has no summarizedField — the description honestly says
    // "record count" rather than fabricating a source field.
    expect(countStep?.actions[0]?.description).toBe(
      `recalculates count(record count) on ${ROLLUP_PARENT}`,
    );
  });

  it('post-save-rollup-recalc fires on delete and undelete too (unlike duplicate-rules)', async () => {
    for (const event of ['delete', 'undelete'] as const) {
      const result = await whatHappensOnSaveHandler(ctx, {
        objectApiName: 'RollupChild',
        event,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const rollupSteps = result.value.data.soe.filter(
        (s) => s.phase === 'post-save-rollup-recalc',
      );
      expect(rollupSteps.length).toBe(2);
    }
  });

  it('does not name RollupChild itself, or an unrelated object, in the rollup phase', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'RollupParent',
      event: 'insert',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // RollupParent is the PARENT, not a rollup child of anything in this fixture.
    expect(
      result.value.data.soe.some((s) => s.phase === 'post-save-rollup-recalc'),
    ).toBe(false);
  });

  it('omits both duplicate-rules and post-save-rollup-recalc for an object with neither (convention: absent phase, not empty placeholder)', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'EmptyObj',
      event: 'insert',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const phasesPresent = new Set(result.value.data.soe.map((s) => s.phase));
    expect(phasesPresent.has('duplicate-rules')).toBe(false);
    expect(phasesPresent.has('post-save-rollup-recalc')).toBe(false);
    expect(result.value.data.summary.phaseCounts['duplicate-rules']).toBe(0);
    expect(result.value.data.summary.phaseCounts['post-save-rollup-recalc']).toBe(0);
  });

  // ===========================================================================
  // R6-07: combined phase-order assertion (Seed 10).
  // ===========================================================================

  it('emits duplicate-rules ahead of save and post-save-rollup-recalc near the end, in the documented order', async () => {
    const result = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'R607Obj',
      event: 'insert',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { soe } = result.value.data;
    expect(soe.map((s) => s.phase)).toEqual([
      'pre-save-triggers',
      'pre-save-validation',
      'duplicate-rules',
      'save',
      'after-triggers',
      'post-save-workflows',
      'post-save-rollup-recalc',
    ]);
    for (let i = 0; i < soe.length; i += 1) {
      expect(soe[i]!.stepIndex).toBe(i);
    }
    const rollupStep = soe.find((s) => s.phase === 'post-save-rollup-recalc');
    expect(rollupStep?.componentId).toBe(R607_ROLLUP_FIELD);
  });

  // R6-23: entitlementProcessNotes informational rider — a disclosure-plus-
  // pointer, NOT a simulated order-of-execution phase.
  describe('R6-23: entitlementProcessNotes rider', () => {
    it('surfaces a note for an active EntitlementProcess targeting the object, excluding inactive and other-object processes', async () => {
      const result = await whatHappensOnSaveHandler(ctx, {
        objectApiName: 'R623Obj',
        event: 'insert',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const { entitlementProcessNotes, entitlementProcessNotesTruncated } = result.value.data;
      expect(entitlementProcessNotes).toEqual([
        {
          componentId: ENTITLEMENT_PROCESS_ACTIVE,
          apiName: 'Gold_Support',
          message:
            'entitlement process Gold_Support is active on this object — milestone evaluation not simulated',
          confidence: 'declared',
        },
      ]);
      // The inactive process and the process on a different object never
      // appear — confirms the active + SObjectType filters, not just presence.
      expect(
        entitlementProcessNotes?.some((n) => n.componentId === ENTITLEMENT_PROCESS_INACTIVE),
      ).toBe(false);
      expect(
        entitlementProcessNotes?.some((n) => n.componentId === ENTITLEMENT_PROCESS_OTHER_OBJECT),
      ).toBe(false);
      expect(entitlementProcessNotesTruncated).toBeUndefined();
    });

    it('OMITS entitlementProcessNotes for an object with no active EntitlementProcess', async () => {
      const result = await whatHappensOnSaveHandler(ctx, {
        objectApiName: 'EmptyObj',
        event: 'insert',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect('entitlementProcessNotes' in result.value.data).toBe(false);
      expect('entitlementProcessNotesTruncated' in result.value.data).toBe(false);
    });

    it('caps entitlementProcessNotes and sets entitlementProcessNotesTruncated when the cap is hit', async () => {
      const result = await whatHappensOnSaveHandler(ctx, {
        objectApiName: 'R623ManyObj',
        event: 'insert',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const { entitlementProcessNotes, entitlementProcessNotesTruncated } = result.value.data;
      expect(entitlementProcessNotes?.length).toBe(20);
      expect(entitlementProcessNotesTruncated).toBe(true);
    });

    it('still carries the refined criteria-based-sharing disclosure alongside the rider', async () => {
      const result = await whatHappensOnSaveHandler(ctx, {
        objectApiName: 'R623Obj',
        event: 'insert',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.data.disclosure).toContain(
        "Criteria-based sharing recalculation — the FINAL step in Salesforce's documented order-of-execution",
      );
      expect(result.value.data.disclosure).toContain('EntitlementProcess');
    });
  });
});

describe('whatHappensOnSaveHandler — phase filter + phase-omission honesty (WHAT-HAPPENS-ON-SAVE-TRUNCATION-DROPS-LATER-PHASES)', () => {
  it('computePhasesOmitted names phases whose surviving soe fell below phaseCounts', () => {
    // Pure-function guard (the helper did not exist pre-fix). Declared counts
    // claim two duplicate-rules + one after-trigger; the survivors show none.
    const declared = tallyPhaseCounts([
      { phase: 'duplicate-rules' },
      { phase: 'duplicate-rules' },
      { phase: 'after-triggers' },
      { phase: 'pre-save-validation' },
    ]);
    const survivors = [{ phase: 'pre-save-validation' as const }];
    const omitted = computePhasesOmitted(declared, survivors);
    const byPhase = new Map(omitted.map((o) => [o.phase, o]));
    expect(byPhase.get('duplicate-rules')).toEqual({
      phase: 'duplicate-rules',
      declared: 2,
      present: 0,
    });
    expect(byPhase.get('after-triggers')).toEqual({
      phase: 'after-triggers',
      declared: 1,
      present: 0,
    });
    // A fully-represented phase is NOT reported.
    expect(byPhase.has('pre-save-validation')).toBe(false);
  });

  it('full (un-filtered) view on a small object keeps every phase — no phasesOmitted, no appliedPhaseFilter', async () => {
    const r = await whatHappensOnSaveHandler(ctx, { objectApiName: 'FullObj', event: 'insert' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // The single-event view never drops steps: every phase phaseCounts claims is
    // present in soe, so the honesty invariant holds and phasesOmitted is absent.
    const soePhases = new Set(d.soe.map((s) => s.phase));
    for (const [phase, count] of Object.entries(d.summary.phaseCounts)) {
      if (count > 0) expect(soePhases.has(phase as never)).toBe(true);
    }
    expect(d.phasesOmitted).toBeUndefined();
    expect(d.appliedPhaseFilter).toBeUndefined();
  });

  it('FAIL-BEFORE/PASS-AFTER: the `phase` filter narrows soe to one phase while summary stays whole', async () => {
    const r = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'FullObj',
      event: 'insert',
      phase: 'pre-save-validation',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // FAIL-BEFORE: `phase` was not a schema field and was Zod-stripped, so soe
    // held every phase and appliedPhaseFilter was undefined.
    expect(d.appliedPhaseFilter).toBe('pre-save-validation');
    expect(d.soe.length).toBeGreaterThan(0);
    expect(d.soe.every((s) => s.phase === 'pre-save-validation')).toBe(true);
    // summary reflects the WHOLE composition, not the narrowed slice.
    expect(d.summary.phaseCounts['pre-save-validation']).toBe(1);
    expect(d.summary.totalSteps).toBeGreaterThan(d.soe.length);
  });

  it('input schema accepts the phase filter and rejects an unknown phase', () => {
    expect(
      whatHappensOnSaveInputSchema.safeParse({
        objectApiName: 'FullObj',
        event: 'insert',
        phase: 'duplicate-rules',
      }).success,
    ).toBe(true);
    expect(
      whatHappensOnSaveInputSchema.safeParse({
        objectApiName: 'FullObj',
        event: 'insert',
        phase: 'not-a-phase',
      }).success,
    ).toBe(false);
  });

  it('a byte-budget-truncated insert never silently drops a later phase — duplicate-rules stays disclosed', async () => {
    const r = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'TruncSaveObj',
      event: 'insert',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // Precondition — the payload REALLY truncated (per-step action lists trimmed
    // to fit the ~40 KB SOE budget). Without a real trim this proves nothing.
    expect(d.truncated).toBe(true);

    const pc = d.summary.phaseCounts;
    // The witness shape: LATER phases the counts claim are non-zero. A host that
    // trusted a truncated `soe` alone could wrongly report "no duplicate rules /
    // no after-triggers / no post-save flows / no async fires on save".
    expect(pc['duplicate-rules']).toBeGreaterThan(0);
    expect(pc['after-triggers']).toBeGreaterThan(0);
    expect(pc['post-save-flows']).toBeGreaterThan(0);
    expect(pc['post-save-async']).toBeGreaterThan(0);

    // Honesty invariant (WHAT-HAPPENS-ON-SAVE-TRUNCATION-DROPS-LATER-PHASES): for
    // EVERY non-zero phase, its steps are either fully present in `soe` OR the
    // shortfall is named in `phasesOmitted` with the true declared/present
    // counts — so a truncated payload can NEVER silently contradict
    // `phaseCounts`. Today what_happens_on_save uses allowStepDrop:false, so
    // every phase stays fully present and `phasesOmitted` is absent; this
    // assertion still holds AND would catch a regression that started dropping
    // steps without disclosing them.
    const present = tallyPhaseCounts(d.soe) as Record<string, number>;
    const omittedByPhase = new Map((d.phasesOmitted ?? []).map((o) => [o.phase, o]));
    for (const [phase, declared] of Object.entries(pc)) {
      if (declared === 0) continue;
      if (present[phase]! >= declared) {
        expect(present[phase]).toBe(declared);
      } else {
        const omission = omittedByPhase.get(phase as never);
        expect(omission).toBeDefined();
        expect(omission?.declared).toBe(declared);
        expect(omission?.present).toBe(present[phase]);
      }
    }

    // Concretely for duplicate-rules: it is disclosed structurally — present in
    // `soe` OR named in `phasesOmitted`. Either way a host cannot conclude "no
    // duplicate rules fire on save" from a truncated payload.
    const dupPresent = present['duplicate-rules']! > 0;
    const dupDisclosed = omittedByPhase.has('duplicate-rules');
    expect(dupPresent || dupDisclosed).toBe(true);
    // Today (allowStepDrop:false) the stronger guarantee holds: nothing dropped.
    expect(d.phasesOmitted).toBeUndefined();
    expect(dupPresent).toBe(true);
  });

  it('GLOBAL responseBudget trim of a large SOE attaches phasesOmitted naming every dropped non-zero phase (incl duplicate-rules)', async () => {
    // W5.1 GLOBAL residual (WHAT-HAPPENS-ON-SAVE-TRUNCATION-DROPS-LATER-PHASES).
    // The tool-local `enforceSoeByteBudget` runs with `allowStepDrop:false`, so
    // on a many-step object it drops NOTHING (every step's action list is under
    // the keep-all floor) and hands back a payload STILL over budget. The global
    // `jsonResult` responseBudget guard then tail-truncates `data.soe`, shedding
    // the LATER phases — the honesty hole the tool-local guard cannot reach.

    // Precondition — the handler alone SURVIVES the tool-local trim: it never
    // drops a STEP (allowStepDrop:false), so every phase phaseCounts claims is
    // fully present in `soe` and `phasesOmitted` is absent. (It may set
    // `truncated` because the tool-local pass trims per-step ACTION edges — that
    // is orthogonal; what matters is no step, hence no PHASE, was shed here.)
    // So whatever phase-omission the wire shows below was done by the GLOBAL
    // budget path, not the tool-local one.
    const handlerOnly = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'SaveHeavyObj',
      event: 'insert',
    });
    expect(handlerOnly.ok).toBe(true);
    if (!handlerOnly.ok) return;
    expect(handlerOnly.value.data.soe.length).toBe(
      handlerOnly.value.data.summary.totalSteps,
    );
    expect(handlerOnly.value.data.phasesOmitted).toBeUndefined();
    const declared = handlerOnly.value.data.summary.phaseCounts;
    // The witness shape: later phases the counts claim are non-zero.
    expect(declared['pre-save-validation']).toBe(SAVE_HEAVY_VR_COUNT);
    expect(declared['duplicate-rules']).toBe(3);
    expect(declared['after-triggers']).toBe(1);
    expect(declared['post-save-flows']).toBe(1);
    expect(declared['post-save-async']).toBe(1);
    // The handler payload really is over the global budget (so the guard bites).
    const handlerBytes = Buffer.byteLength(
      JSON.stringify(handlerOnly.value.data),
      'utf8',
    );
    expect(handlerBytes).toBeGreaterThan(40_000);

    // Drive the PRODUCTION dispatch path (parse → handle → stamp → jsonResult).
    const wire = await runTool(
      ctx,
      { objectApiName: 'SaveHeavyObj', event: 'insert' },
      whatHappensOnSaveInputSchema,
      whatHappensOnSaveHandler,
    );
    const text = (wire.content[0] as { readonly text: string }).text;
    const parsed = JSON.parse(text) as {
      readonly data: {
        readonly soe: readonly { readonly phase: string }[];
        readonly summary: { readonly phaseCounts: Record<string, number> };
        readonly phasesOmitted?: readonly {
          readonly phase: string;
          readonly declared: number;
          readonly present: number;
        }[];
      };
      readonly responseBudget?: {
        readonly truncated?: boolean;
        readonly droppedCount?: number;
      };
    };

    // The GLOBAL guard truncated `data.soe` (this is the path under test).
    expect(parsed.responseBudget?.truncated).toBe(true);
    expect(parsed.responseBudget?.droppedCount ?? 0).toBeGreaterThan(0);
    expect(parsed.data.soe.length).toBeLessThan(
      parsed.data.summary.phaseCounts['pre-save-validation']! +
        parsed.data.summary.phaseCounts['duplicate-rules']!,
    );

    // Acceptance — the truncated-on-the-wire payload names EVERY dropped
    // non-zero phase in `phasesOmitted`; a host can NEVER read it as "no
    // duplicate rules / no after-triggers / no post-save flows / no async".
    const pc = parsed.data.summary.phaseCounts;
    const present = tallyPhaseCounts(
      parsed.data.soe as readonly { readonly phase: never }[],
    ) as Record<string, number>;
    const omittedByPhase = new Map(
      (parsed.data.phasesOmitted ?? []).map((o) => [o.phase, o]),
    );
    for (const [phase, count] of Object.entries(pc)) {
      if (count === 0) continue;
      if (present[phase]! >= count) continue; // fully present ⇒ no omission needed
      const omission = omittedByPhase.get(phase);
      expect(omission).toBeDefined();
      expect(omission?.declared).toBe(count);
      expect(omission?.present).toBe(present[phase]);
    }
    // Concretely: duplicate-rules was shed and is NAMED, not silently dropped.
    expect(present['duplicate-rules'] ?? 0).toBe(0);
    expect(omittedByPhase.get('duplicate-rules')).toEqual({
      phase: 'duplicate-rules',
      declared: 3,
      present: 0,
    });
    // …and the envelope stayed under the wire budget (no opaque rejection).
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(45_000);
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

// =============================================================================
// N+1 query budget (finding C-1). Mirror of the order_of_execution guard:
// fetchParentedFirers / fetchTriggersOnFirers / buildAsyncSteps and the flow-
// partition loop are batched, so the total edge+node round-trip count must NOT
// scale with the object's child fan-out. A wide object whose children are all
// filtered-out non-firers produces zero steps but exercises every firer
// resolution over the full fan-out.
// =============================================================================
describe('whatHappensOnSaveHandler — bounded graph queries', () => {
  const seedWideObject = async (childCount: number) => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-whos-budget-'));
    const opened = await openGraph(join(dir, 'whos.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    const s = opened.value;
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
      whatHappensOnSaveHandler(wideCtx, { objectApiName: 'Wide', event: 'insert' }),
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
    // Independence: a reintroduced per-child getNodeById loop would add ~140
    // node queries going 60 -> 200. Batched, both counts are identical.
    expect(large.nodeQueries).toBe(small.nodeQueries);
    expect(large.edgeQueries).toBe(small.edgeQueries);
    expect(large.nodeQueries).toBeLessThan(60);
  });
});
