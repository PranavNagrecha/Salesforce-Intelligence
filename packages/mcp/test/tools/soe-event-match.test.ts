/// <reference types="vitest/globals" />

/**
 * FAIL-BEFORE/PASS-AFTER (eval A01): `what_happens_on_save` with
 * `event: 'upsert'` merged insert and update into one chain without saying
 * which steps fire on only one of them, so an insert-only flow read as running
 * on every save. Each upsert step now carries `firesOn`.
 *
 * Also FAIL-BEFORE/PASS-AFTER for the duplicated matchers: `order_of_execution`
 * kept its own "byte-for-byte" copy that dropped a record-triggered flow with
 * no `recordTriggerType` from every chain, while `what_happens_on_save` treats
 * it as the platform's CreateAndUpdate default. Both now share one module.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, importExtractionResults, openGraph, type GraphStore } from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { orderOfExecutionHandler, orderOfExecutionInputSchema } from '../../src/tools/order-of-execution.js';
import { flowMatchesEvent, upsertFiresOn } from '../../src/tools/soe-event-match.js';
import { whatHappensOnSaveHandler } from '../../src/tools/what-happens-on-save.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-08T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'x.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

const edge = (o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...o,
});

const OBJ = 'CustomObject:Ticket__c';
const flowEdge = (id: string, triggerType: string, recordTriggerType?: string): Edge =>
  edge({
    fromId: id,
    toId: OBJ,
    edgeType: 'triggersOn',
    properties: { triggerType, ...(recordTriggerType !== undefined ? { recordTriggerType } : {}) },
  });

const seed: ExtractionResult = {
  nodes: [
    node({ id: OBJ, type: 'CustomObject', apiName: 'Ticket__c' }),
    node({ id: 'Flow:Ticket_On_Create', type: 'Flow', apiName: 'Ticket_On_Create', properties: { status: 'Active' } }),
    node({ id: 'Flow:Ticket_On_Edit', type: 'Flow', apiName: 'Ticket_On_Edit', properties: { status: 'Active' } }),
    node({ id: 'Flow:Ticket_Default', type: 'Flow', apiName: 'Ticket_Default', properties: { status: 'Active' } }),
    node({
      id: 'ApexTrigger:Ticket_Trigger',
      type: 'ApexTrigger',
      apiName: 'Ticket_Trigger',
      properties: { triggerObject: 'Ticket__c', events: ['before insert', 'after update'] },
    }),
    node({
      id: 'ValidationRule:Ticket__c.Needs_Subject',
      type: 'ValidationRule',
      apiName: 'Ticket__c.Needs_Subject',
      parentId: OBJ,
      properties: { active: true },
    }),
    node({
      id: 'WorkflowRule:Ticket__c.Welcome',
      type: 'WorkflowRule',
      apiName: 'Ticket__c.Welcome',
      parentId: OBJ,
      properties: { triggerType: 'onCreateOnly', active: true },
    }),
  ],
  edges: [
    flowEdge('Flow:Ticket_On_Create', 'RecordAfterSave', 'Create'),
    flowEdge('Flow:Ticket_On_Edit', 'RecordBeforeSave', 'Update'),
    // No recordTriggerType: the platform default is CreateAndUpdate.
    flowEdge('Flow:Ticket_Default', 'RecordAfterSave'),
    edge({
      fromId: 'ApexTrigger:Ticket_Trigger',
      toId: OBJ,
      edgeType: 'triggersOn',
      properties: { events: ['before insert', 'after update'] },
    }),
    edge({ fromId: OBJ, toId: 'ValidationRule:Ticket__c.Needs_Subject', edgeType: 'parentOf' }),
    edge({ fromId: OBJ, toId: 'WorkflowRule:Ticket__c.Welcome', edgeType: 'parentOf' }),
    edge({
      fromId: 'WorkflowRule:Ticket__c.Welcome',
      toId: OBJ,
      edgeType: 'triggersOn',
      properties: { triggerType: 'onCreateOnly' },
    }),
  ],
};

let dir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-soe-event-match-'));
  const opened = await openGraph(join(dir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(imported.error.message);
  ctx = { vaultRoot: dir, manifest: MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(dir, { recursive: true, force: true });
});

describe('soe-event-match', () => {
  it('derives the upsert branches from the same matcher', () => {
    expect(upsertFiresOn((e) => flowMatchesEvent('Create', e))).toEqual(['insert']);
    expect(upsertFiresOn((e) => flowMatchesEvent('Update', e))).toEqual(['update']);
    expect(upsertFiresOn((e) => flowMatchesEvent(undefined, e))).toEqual(['insert', 'update']);
  });
});

describe('what_happens_on_save — upsert steps say which event they fire on', () => {
  it('labels insert-only, update-only and both-event steps', async () => {
    const r = await whatHappensOnSaveHandler(ctx, { objectApiName: 'Ticket__c', event: 'upsert' });
    if (!r.ok) throw new Error(r.error.message);
    const firesOn = new Map(r.value.data.soe.map((s) => [`${s.phase}|${s.componentId}`, s.firesOn]));
    expect(firesOn.get('post-save-flows|Flow:Ticket_On_Create')).toEqual(['insert']);
    expect(firesOn.get('before-save-flows|Flow:Ticket_On_Edit')).toEqual(['update']);
    expect(firesOn.get('post-save-flows|Flow:Ticket_Default')).toEqual(['insert', 'update']);
    expect(firesOn.get('pre-save-triggers|ApexTrigger:Ticket_Trigger')).toEqual(['insert']);
    expect(firesOn.get('after-triggers|ApexTrigger:Ticket_Trigger')).toEqual(['update']);
    expect(firesOn.get('pre-save-validation|ValidationRule:Ticket__c.Needs_Subject')).toEqual(['insert', 'update']);
    expect(firesOn.get('post-save-workflows|WorkflowRule:Ticket__c.Welcome')).toEqual(['insert']);
    expect(firesOn.get(`save|${OBJ}`)).toEqual(['insert', 'update']);
  });

  it('a single-event call carries no firesOn', async () => {
    const r = await whatHappensOnSaveHandler(ctx, { objectApiName: 'Ticket__c', event: 'insert' });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.data.soe.some((s) => s.firesOn !== undefined)).toBe(false);
  });
});

describe('order_of_execution — a flow with no recordTriggerType is not dropped', () => {
  it('lists the defaulted flow on both the insert and the update chain', async () => {
    const parsed = orderOfExecutionInputSchema.parse({ objectApiName: 'Ticket__c', events: ['insert', 'update'] });
    const r = await orderOfExecutionHandler(ctx, parsed);
    if (!r.ok) throw new Error(r.error.message);
    for (const event of ['insert', 'update'] as const) {
      const ids = (r.value.data.byEvent[event]?.soe ?? []).map((s) => s.componentId);
      expect(ids).toContain('Flow:Ticket_Default');
    }
    const insertIds = (r.value.data.byEvent.insert?.soe ?? []).map((s) => s.componentId);
    expect(insertIds).toContain('Flow:Ticket_On_Create');
    expect(insertIds).not.toContain('Flow:Ticket_On_Edit');
  });
});
