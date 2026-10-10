/// <reference types="vitest/globals" />

/**
 * FAIL-BEFORE/PASS-AFTER — "what sets field X to value V?"
 *
 * Before: `value` was compared by exact string, never checked against the
 * field (a typo'd picklist value returned "no writers"; `true` never matched a
 * workflow checkbox update, which writes `1`), writers were only split into
 * kept/dropped with no reason and no list of what was checked, the graph kept
 * only the FIRST value of a component that writes the field in several places
 * (an approval process's submit / approve / reject updates), and nothing said
 * when a definite writer runs.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { whyFieldChangedHandler } from '../../src/tools/why-field-changed.js';

const OBJ = 'CustomObject:Ticket__c';
const STATUS = 'CustomField:Ticket__c.Status__c';
const FLAG = 'CustomField:Ticket__c.Escalated__c';
const STAGE = 'CustomField:Ticket__c.Stage__c';
const TIER = 'CustomField:Ticket__c.Tier__c';
const afterSave = (id: string, props: Record<string, unknown>): Node =>
  node({ id, type: 'Flow', apiName: id.slice('Flow:'.length), properties: { status: 'Active', triggerType: 'RecordAfterSave', ...props } });
const afterSaveTrigger = (fromId: string): Edge =>
  edge({ fromId, toId: OBJ, edgeType: 'triggersOn', properties: { triggerType: 'RecordAfterSave', recordTriggerType: 'CreateAndUpdate' } });

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'missing/on/purpose.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});
const edge = (o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>): Edge => ({
  confidence: 'parsed',
  source: 'flow-extractor',
  properties: {},
  ...o,
});
const writes = (fromId: string, toId: string, properties: Record<string, unknown>, o: Partial<Edge> = {}): Edge =>
  edge({ fromId, toId, edgeType: 'writesTo', properties, ...o });

const seed: ExtractionResult = {
  nodes: [
    node({ id: OBJ, type: 'CustomObject', apiName: 'Ticket__c' }),
    node({
      id: STATUS,
      type: 'CustomField',
      apiName: 'Status__c',
      parentId: OBJ,
      properties: {
        dataType: 'Picklist',
        picklistValues: [
          { value: 'New', isActive: true },
          { value: 'Closed', isActive: true },
          { value: 'Archived', isActive: false },
        ],
      },
    }),
    node({ id: FLAG, type: 'CustomField', apiName: 'Escalated__c', parentId: OBJ, properties: { dataType: 'Checkbox' } }),
    node({
      id: STAGE,
      type: 'CustomField',
      apiName: 'Stage__c',
      parentId: OBJ,
      properties: {
        dataType: 'Picklist',
        picklistValues: [
          { value: 'Pending', isActive: true },
          { value: 'Expired', isActive: true },
        ],
      },
    }),
    node({ id: TIER, type: 'CustomField', apiName: 'Tier__c', parentId: OBJ, properties: { dataType: 'Number' } }),
    // Runs ONLY on a 10-day scheduled path (no <start><connector>).
    afterSave('Flow:Delay_Expire', { hasImmediateConnector: false, scheduledPathCount: 1, scheduledPathTypes: [] }),
    // Runs in the save AND has a scheduled path — which element is on it is not modeled.
    afterSave('Flow:Mixed_Expire', { hasImmediateConnector: true, scheduledPathCount: 1, scheduledPathTypes: [] }),
    // Runs only on a run-after-commit path.
    afterSave('Flow:Async_Expire', { hasImmediateConnector: false, scheduledPathCount: 1, scheduledPathTypes: ['AsyncAfterCommit'] }),
    // In the save, no scheduled path.
    afterSave('Flow:Now_Expire', { hasImmediateConnector: true, scheduledPathCount: 0, scheduledPathTypes: [] }),
    node({ id: 'Flow:Set_Tier', type: 'Flow', apiName: 'Set_Tier', properties: { status: 'Active' } }),
    node({ id: 'Flow:Rel_Update', type: 'Flow', apiName: 'Rel_Update', sourcePath: 'flows/Rel_Update.flow-meta.xml', properties: { status: 'Active' } }),
    node({ id: 'WorkflowRule:Ticket__c.Expire', type: 'WorkflowRule', apiName: 'Ticket__c.Expire', properties: { active: true, triggerType: 'onCreateOnly' } }),
    node({ id: 'Flow:Close_Ticket', type: 'Flow', apiName: 'Close_Ticket', properties: { status: 'Active', triggerType: 'RecordBeforeSave' } }),
    node({ id: 'Flow:Reset_Ticket', type: 'Flow', apiName: 'Reset_Ticket', properties: { status: 'Active' } }),
    node({ id: 'Flow:Copy_Status', type: 'Flow', apiName: 'Copy_Status', properties: { status: 'Active' } }),
    node({ id: 'Flow:Flag_Const', type: 'Flow', apiName: 'Flag_Const', properties: { status: 'Active' } }),
    node({ id: 'ApexClass:TicketService', type: 'ApexClass', apiName: 'TicketService', properties: { isTest: false } }),
    node({ id: 'WorkflowRule:Ticket__c.Escalate', type: 'WorkflowRule', apiName: 'Ticket__c.Escalate', properties: { active: true, triggerType: 'onCreateOrTriggeringUpdate' } }),
    node({ id: 'WorkflowRule:Ticket__c.Stamp', type: 'WorkflowRule', apiName: 'Ticket__c.Stamp', properties: { active: true, triggerType: 'onAllChanges' } }),
    node({ id: 'ApprovalProcess:Ticket__c.Review', type: 'ApprovalProcess', apiName: 'Ticket__c.Review', properties: { active: true } }),
    node({
      id: 'ConditionalContext:Flow:Close_Ticket.condition-0',
      type: 'ConditionalContext',
      apiName: 'Flow:Close_Ticket.condition-0',
      parentId: 'Flow:Close_Ticket',
      properties: { kind: 'flow-recordtrigger', expression: 'Resolved__c EqualTo true', entryRequiresRecordChange: true },
    }),
    node({
      id: 'ConditionalContext:Flow:Close_Ticket.condition-1',
      type: 'ConditionalContext',
      apiName: 'Flow:Close_Ticket.condition-1',
      parentId: 'Flow:Close_Ticket',
      properties: { kind: 'flow-decision', expression: 'Priority__c EqualTo Low' },
    }),
    node({
      id: 'ConditionalContext:WorkflowRule:Ticket__c.Escalate.condition-0',
      type: 'ConditionalContext',
      apiName: 'WorkflowRule:Ticket__c.Escalate.condition-0',
      parentId: 'WorkflowRule:Ticket__c.Escalate',
      properties: { kind: 'criteria', expression: 'Ticket__c.Priority__c equals High' },
    }),
  ],
  edges: [
    edge({ fromId: OBJ, toId: STATUS, edgeType: 'parentOf', source: 'unit' }),
    edge({ fromId: OBJ, toId: FLAG, edgeType: 'parentOf', source: 'unit' }),
    // Definite: before-save literal, record-triggered on update, entry criteria + one decision.
    writes('Flow:Close_Ticket', STATUS, { operation: 'beforeSaveFieldAssignment', assignedValue: 'Closed', assignedValueKind: 'literal' }, { confidence: 'declared' }),
    edge({ fromId: 'Flow:Close_Ticket', toId: OBJ, edgeType: 'triggersOn', properties: { triggerType: 'RecordBeforeSave', recordTriggerType: 'Update' } }),
    edge({ fromId: 'Flow:Close_Ticket', toId: 'ConditionalContext:Flow:Close_Ticket.condition-0', edgeType: 'firesWhen' }),
    edge({ fromId: 'Flow:Close_Ticket', toId: 'ConditionalContext:Flow:Close_Ticket.condition-1', edgeType: 'firesWhen' }),
    // Cannot: writes only another literal.
    writes('Flow:Reset_Ticket', STATUS, { operation: 'recordUpdate', assignedValue: 'New', assignedValueKind: 'literal' }),
    // May: value from a variable.
    writes('Flow:Copy_Status', STATUS, { operation: 'recordUpdate', assignedValue: 'varNextStatus', assignedValueKind: 'reference' }),
    // May: Apex — no stated value.
    writes('ApexClass:TicketService', STATUS, {}, { confidence: 'parsed', source: 'apex-ast' }),
    // One approval process, three hook updates on ONE field — same graph key.
    writes('ApprovalProcess:Ticket__c.Review', STATUS, { hookType: 'initialSubmission', operation: 'Literal', assignedValue: 'New', assignedValueKind: 'literal' }, { source: 'approval-process-extractor' }),
    writes('ApprovalProcess:Ticket__c.Review', STATUS, { hookType: 'finalApproval', operation: 'Literal', assignedValue: 'Closed', assignedValueKind: 'literal' }, { source: 'approval-process-extractor' }),
    writes('ApprovalProcess:Ticket__c.Review', STATUS, { hookType: 'finalRejection', operation: 'Formula', assignedValue: 'PRIORVALUE(Status__c)', assignedValueKind: 'formula' }, { source: 'approval-process-extractor' }),
    // Checkbox: workflow updates write 1 / 0; a Flow writes $GlobalConstant.True.
    writes('WorkflowRule:Ticket__c.Escalate', FLAG, { operation: 'Literal', assignedValue: '1', assignedValueKind: 'literal' }, { source: 'workflow-rule-extractor' }),
    edge({ fromId: 'WorkflowRule:Ticket__c.Escalate', toId: 'ConditionalContext:WorkflowRule:Ticket__c.Escalate.condition-0', edgeType: 'firesWhen', source: 'workflow-rule-extractor' }),
    writes('WorkflowRule:Ticket__c.Stamp', FLAG, { operation: 'Literal', assignedValue: '0', assignedValueKind: 'literal' }, { source: 'workflow-rule-extractor' }),
    writes('Flow:Flag_Const', FLAG, { operation: 'recordUpdate', assignedValue: '$GlobalConstant.True', assignedValueKind: 'reference' }),
    ...['Flow:Delay_Expire', 'Flow:Mixed_Expire', 'Flow:Async_Expire', 'Flow:Now_Expire'].flatMap((f) => [
      writes(f, STAGE, { operation: 'recordUpdate', assignedValue: 'Expired', assignedValueKind: 'literal' }),
      afterSaveTrigger(f),
    ]),
    // One rule: an immediate update to Pending and a time-triggered one to Expired — one graph key.
    writes('WorkflowRule:Ticket__c.Expire', STAGE, { operation: 'Literal', assignedValue: 'Pending', assignedValueKind: 'literal' }, { source: 'workflow-rule-extractor' }),
    writes('WorkflowRule:Ticket__c.Expire', STAGE, { operation: 'Literal', assignedValue: 'Expired', assignedValueKind: 'literal', timeTriggered: true }, { source: 'workflow-rule-extractor' }),
    // The graph attributes only the direct update (Pending); the source also
    // writes Expired through a relationship the extractor did not resolve.
    writes('Flow:Rel_Update', STAGE, { operation: 'recordUpdate', assignedValue: 'Pending', assignedValueKind: 'literal' }),
    // A Flow <numberValue>1.0</numberValue> is stored as '1'.
    writes('Flow:Set_Tier', TIER, { operation: 'recordUpdate', assignedValue: '1', assignedValueKind: 'literal' }),
  ],
};

const REL_UPDATE_XML = `<?xml version="1.0"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <recordUpdates>
    <name>Direct</name>
    <object>Ticket__c</object>
    <inputAssignments><field>Stage__c</field><value><stringValue>Pending</stringValue></value></inputAssignments>
  </recordUpdates>
  <recordUpdates>
    <name>Through_Parent</name>
    <inputReference>$Record.Parent_Ticket__r</inputReference>
    <inputAssignments><field>Stage__c</field><value><stringValue>Expired</stringValue></value></inputAssignments>
  </recordUpdates>
</Flow>`;

const manifest: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-01-01T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-wfc-value-search-'));
  mkdirSync(join(tempDir, 'flows'));
  writeFileSync(join(tempDir, 'flows', 'Rel_Update.flow-meta.xml'), REL_UPDATE_XML, 'utf-8');
  const opened = await openGraph(join(tempDir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(imported.error.message);
  ctx = { vaultRoot: tempDir, manifest, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

const ask = async (fieldId: string, value: string) => {
  const r = await whyFieldChangedHandler(ctx, { fieldId, value });
  if (!r.ok) throw new Error(r.error.message);
  const vf = r.value.data.valueFilter;
  if (vf === undefined) throw new Error('no valueFilter');
  return { data: r.value.data, vf };
};

describe('FAIL-BEFORE/PASS-AFTER: value-aware writer search groups every writer', () => {
  it('puts each writer in exactly one group, with a reason for maySet and the other values for cannotSet', async () => {
    const { data, vf } = await ask(STATUS, 'Closed');
    expect(vf.definitelySets.map((d) => d.id)).toEqual([
      'ApprovalProcess:Ticket__c.Review',
      'Flow:Close_Ticket',
    ]);
    expect(vf.maySet.map((m) => m.id)).toEqual(['ApexClass:TicketService', 'Flow:Copy_Status']);
    expect(vf.maySet.find((m) => m.id === 'ApexClass:TicketService')?.why).toMatch(/Apex/);
    expect(vf.maySet.find((m) => m.id === 'Flow:Copy_Status')?.why).toMatch(/varNextStatus/);
    expect(vf.cannotSet).toEqual([{ id: 'Flow:Reset_Ticket', sets: ['New'] }]);
    expect(vf.excludedWriters).toBe(1);
    // `writers` keeps the definite + may writers, not the cannot ones.
    expect(data.writers.map((w) => w.id)).not.toContain('Flow:Reset_Ticket');
    expect(vf.disclosure).toMatch(/managed-package/);
  });

  it('keeps every value of a component that writes the field in several places (approval submit / approve / reject)', async () => {
    // Before: the graph kept only the first hook's edge ('New'), so the
    // approval process read as unable to set 'Closed'.
    const { vf } = await ask(STATUS, 'Closed');
    expect(vf.definitelySets.map((d) => d.id)).toContain('ApprovalProcess:Ticket__c.Review');
    const { vf: newVf } = await ask(STATUS, 'New');
    expect(newVf.definitelySets.map((d) => d.id)).toContain('ApprovalProcess:Ticket__c.Review');
  });

  it('says when each definite writer fires: trigger, entry criteria, only-when-changed, and un-walked decisions', async () => {
    const { vf } = await ask(STATUS, 'Closed');
    const flow = vf.definitelySets.find((d) => d.id === 'Flow:Close_Ticket');
    expect(flow?.firesWhen).toContain('before-save Flow on Ticket__c update');
    expect(flow?.firesWhen).toContain('entry criteria: Resolved__c EqualTo true (only when a save changes the record to meet them)');
    expect(flow?.firesWhen).toContain('1 decision outcome(s) inside the Flow may further gate this write');
    expect(flow?.runnable).toBe(true);
  });
});

describe('FAIL-BEFORE/PASS-AFTER: the asked value is checked against the field', () => {
  it('matches a picklist value case-insensitively and reports the declared spelling', async () => {
    const { vf } = await ask(STATUS, 'closed');
    expect(vf.matchedValue).toBe('Closed');
    expect(vf.valueSetState).toBe('active');
    expect(vf.definitelySets.map((d) => d.id)).toContain('Flow:Close_Ticket');
  });

  it('refuses an undeclared picklist value, listing the declared values', async () => {
    const r = await whyFieldChangedHandler(ctx, { fieldId: STATUS, value: 'Clsoed' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('Declared values: New, Closed, Archived');
  });

  it('notes an inactive picklist value instead of refusing it', async () => {
    const { vf } = await ask(STATUS, 'Archived');
    expect(vf.valueSetState).toBe('inactive');
    expect(vf.note).toMatch(/INACTIVE/);
  });

  it('reads a checkbox workflow update of 1 / 0 and a Flow $GlobalConstant as true / false', async () => {
    const { vf } = await ask(FLAG, 'true');
    expect(vf.definitelySets.map((d) => d.id)).toEqual(['Flow:Flag_Const', 'WorkflowRule:Ticket__c.Escalate']);
    expect(vf.cannotSet).toEqual([{ id: 'WorkflowRule:Ticket__c.Stamp', sets: ['0'] }]);
    const rule = vf.definitelySets.find((d) => d.id === 'WorkflowRule:Ticket__c.Escalate');
    expect(rule?.firesWhen).toBe(
      'workflow rule, evaluated on create, and on an edit that changes the record to meet the criteria; criteria: Ticket__c.Priority__c equals High',
    );
  });

  it('refuses a non-boolean value for a checkbox', async () => {
    const r = await whyFieldChangedHandler(ctx, { fieldId: FLAG, value: 'yes' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toMatch(/checkbox/);
  });
});

describe('FAIL-BEFORE/PASS-AFTER: a delayed write is never reported as written in the save', () => {
  it('says a Flow write runs only on a scheduled path when the Flow has no immediate path', async () => {
    // Before: 'after-save Flow on Ticket__c create or update; no entry criteria…' — read as in the save.
    const { vf } = await ask(STAGE, 'Expired');
    const fires = (id: string) => vf.definitelySets.find((d) => d.id === id)?.firesWhen ?? '';
    expect(fires('Flow:Delay_Expire')).toContain('runs only on its 1 scheduled path(s) (1 time-delayed), NOT in the save');
    expect(fires('Flow:Async_Expire')).toContain('runs only on its 1 scheduled path(s) (async, after the save commits), NOT in the save');
    expect(fires('Flow:Mixed_Expire')).toContain('has 1 scheduled path(s) (1 time-delayed); this write may run on one rather than in the save');
    expect(fires('Flow:Now_Expire')).not.toMatch(/scheduled/);
  });

  it('keeps a workflow time trigger\'s value timed when the rule also updates the field in the save', async () => {
    // Before: the fold kept the immediate edge only; 'Expired' answered
    // 'workflow rule, evaluated on create only' with no delay.
    const { data, vf } = await ask(STAGE, 'Expired');
    expect(vf.definitelySets.find((d) => d.id === 'WorkflowRule:Ticket__c.Expire')?.firesWhen).toBe(
      'workflow rule, evaluated on create only (this value is written by a time trigger — later, NOT in the save)',
    );
    expect(data.writers.find((w) => w.id === 'WorkflowRule:Ticket__c.Expire')?.timeTriggeredValues).toEqual(['Expired']);
    const { vf: pending } = await ask(STAGE, 'Pending');
    expect(pending.definitelySets.find((d) => d.id === 'WorkflowRule:Ticket__c.Expire')?.firesWhen).toBe(
      "workflow rule, evaluated on create only (this value is written in the save; the rule's time trigger writes other value(s) later)",
    );
  });
});

describe('FAIL-BEFORE/PASS-AFTER: numbers compare numerically', () => {
  it("matches a stored '1' when asked '1.0' (never a false cannotSet)", async () => {
    const { vf } = await ask(TIER, '1.0');
    expect(vf.definitelySets.map((d) => d.id)).toEqual(['Flow:Set_Tier']);
    expect(vf.cannotSet).toEqual([]);
  });
});

describe('FAIL-BEFORE/PASS-AFTER: cannotSet is re-checked against a Flow\'s own source', () => {
  it('moves a Flow to maySet when its source writes the value in an element the graph did not attribute', async () => {
    // Before: cannotSet [{ id: 'Flow:Rel_Update', sets: ['Pending'] }] — a wrong negative claim.
    const { vf } = await ask(STAGE, 'Expired');
    expect(vf.cannotSet.map((c) => c.id)).not.toContain('Flow:Rel_Update');
    expect(vf.maySet.find((m) => m.id === 'Flow:Rel_Update')?.why).toMatch(/did not attribute to this field/);
    const { vf: pending } = await ask(STAGE, 'Pending');
    expect(pending.definitelySets.map((d) => d.id)).toContain('Flow:Rel_Update');
  });
});
