/// <reference types="vitest/globals" />

/**
 * WOW-2 — save order must not stop at the trigger dispatcher.
 *
 * A handler-pattern trigger (`Dispatcher.run(new XHandler())`) used to show
 * only "references XHandler / callsApex Dispatcher", with no field writes, and
 * a custom-metadata bypass record that switches the trigger off was invisible.
 * Both save-order tools share `soe-trigger-effects.ts`; this file pins both.
 * All names synthetic.
 */

import { mkdtempSync, rmSync } from 'node:fs';
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
import { orderOfExecutionHandler } from '../../src/tools/order-of-execution.js';
import { whatHappensOnSaveHandler } from '../../src/tools/what-happens-on-save.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});
const edge = (fromId: string, toId: string, edgeType: Edge['edgeType']): Edge => ({
  fromId,
  toId,
  edgeType,
  confidence: 'parsed',
  source: 'unit-test',
  properties: {},
});

const trigger = (name: string, obj: string): Node =>
  node({
    id: `ApexTrigger:${name}`,
    type: 'ApexTrigger',
    apiName: name,
    properties: { triggerObject: obj, events: ['before update', 'after update'], status: 'Active' },
  });

const seed: ExtractionResult = {
  nodes: [
    node({ id: 'CustomObject:Invoice__c', type: 'CustomObject', apiName: 'Invoice__c' }),
    node({ id: 'CustomObject:Project__c', type: 'CustomObject', apiName: 'Project__c' }),
    node({ id: 'CustomField:Invoice__c.Status__c', type: 'CustomField', apiName: 'Status__c' }),
    node({ id: 'CustomField:Project__c.Phase__c', type: 'CustomField', apiName: 'Phase__c' }),
    trigger('InvoiceTrigger', 'Invoice__c'),
    trigger('ProjectTrigger', 'Project__c'),
    node({ id: 'ApexClass:TriggerDispatcher', type: 'ApexClass', apiName: 'TriggerDispatcher' }),
    node({ id: 'ApexClass:InvoiceTriggerHandler', type: 'ApexClass', apiName: 'InvoiceTriggerHandler' }),
    node({ id: 'ApexClass:InvoiceService', type: 'ApexClass', apiName: 'InvoiceService' }),
    node({ id: 'ApexClass:ProjectTriggerHandler', type: 'ApexClass', apiName: 'ProjectTriggerHandler' }),
    node({ id: 'CustomObject:Trigger_Switch__mdt', type: 'CustomObject', apiName: 'Trigger_Switch__mdt' }),
    node({ id: 'CustomObject:Trigger_Switch', type: 'CustomObject', apiName: 'Trigger_Switch' }),
    node({
      id: 'CustomMetadataRecord:Trigger_Switch.Invoice',
      type: 'CustomMetadataRecord',
      apiName: 'Trigger_Switch.Invoice',
      properties: {
        recordName: 'Invoice',
        typeApiName: 'Trigger_Switch',
        values: [
          { field: 'Disable_All__c', value: true, valueType: 'boolean' },
          { field: 'Object_Name__c', value: 'Invoice__c', valueType: 'string' },
          { field: 'After_Update__c', value: false, valueType: 'boolean' },
        ],
      },
    }),
    // A per-context flag set TRUE (not bypass-named) — the dispatcher may skip
    // that context; the name alone cannot say.
    node({ id: 'CustomObject:Milestone__c', type: 'CustomObject', apiName: 'Milestone__c' }),
    trigger('MilestoneTrigger', 'Milestone__c'),
    node({
      id: 'CustomMetadataRecord:Trigger_Switch.Milestone',
      type: 'CustomMetadataRecord',
      apiName: 'Trigger_Switch.Milestone',
      properties: {
        recordName: 'Milestone',
        typeApiName: 'Trigger_Switch',
        values: [{ field: 'Before_Update__c', value: true, valueType: 'boolean' }],
      },
    }),
    // A record whose field values were never extracted.
    node({ id: 'CustomObject:Ticket__c', type: 'CustomObject', apiName: 'Ticket__c' }),
    trigger('TicketTrigger', 'Ticket__c'),
    node({
      id: 'CustomMetadataRecord:Trigger_Switch.Ticket',
      type: 'CustomMetadataRecord',
      apiName: 'Trigger_Switch.Ticket',
      properties: { recordName: 'Ticket', typeApiName: 'Trigger_Switch' },
    }),
  ],
  edges: [
    edge('ApexTrigger:MilestoneTrigger', 'CustomObject:Milestone__c', 'triggersOn'),
    edge('ApexTrigger:MilestoneTrigger', 'ApexClass:TriggerDispatcher', 'callsApex'),
    edge('CustomObject:Trigger_Switch', 'CustomMetadataRecord:Trigger_Switch.Milestone', 'parentOf'),
    edge('ApexTrigger:TicketTrigger', 'CustomObject:Ticket__c', 'triggersOn'),
    edge('ApexTrigger:TicketTrigger', 'ApexClass:TriggerDispatcher', 'callsApex'),
    edge('CustomObject:Trigger_Switch', 'CustomMetadataRecord:Trigger_Switch.Ticket', 'parentOf'),
    edge('ApexTrigger:InvoiceTrigger', 'CustomObject:Invoice__c', 'triggersOn'),
    edge('ApexTrigger:InvoiceTrigger', 'ApexClass:InvoiceTriggerHandler', 'references'),
    edge('ApexTrigger:InvoiceTrigger', 'ApexClass:TriggerDispatcher', 'callsApex'),
    edge('ApexClass:InvoiceTriggerHandler', 'ApexClass:InvoiceService', 'callsApex'),
    edge('ApexClass:InvoiceService', 'CustomField:Invoice__c.Status__c', 'writesTo'),
    edge('ApexClass:TriggerDispatcher', 'CustomObject:Trigger_Switch__mdt', 'readsFrom'),
    edge('ApexClass:TriggerDispatcher', 'CustomField:Trigger_Switch__mdt.Disable_All__c', 'readsFrom'),
    edge('CustomObject:Trigger_Switch', 'CustomMetadataRecord:Trigger_Switch.Invoice', 'parentOf'),
    edge('ApexTrigger:ProjectTrigger', 'CustomObject:Project__c', 'triggersOn'),
    edge('ApexTrigger:ProjectTrigger', 'ApexClass:ProjectTriggerHandler', 'references'),
    edge('ApexTrigger:ProjectTrigger', 'ApexClass:TriggerDispatcher', 'callsApex'),
    edge('ApexClass:ProjectTriggerHandler', 'CustomField:Project__c.Phase__c', 'writesTo'),
  ],
};

let dir: string;
let graph: GraphStore;
let ctx: Context;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-soe-handler-'));
  const opened = await openGraph(join(dir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  graph = opened.value;
  const imported = await importExtractionResults(graph, [seed]);
  if (!imported.ok) throw new Error(imported.error.message);
  ctx = { vaultRoot: dir, manifest: MANIFEST, graph } as Context;
});

afterAll(async () => {
  await closeGraph(graph);
  rmSync(dir, { recursive: true, force: true });
});

describe('WOW-2 save order follows the trigger into its handler', () => {
  it('FAIL-BEFORE/PASS-AFTER: what_happens_on_save shows the handler-chain field write, marked via', async () => {
    const r = await whatHappensOnSaveHandler(ctx, { objectApiName: 'Invoice__c', event: 'update' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const step = r.value.data.soe.find(
      (s) => s.componentId === 'ApexTrigger:InvoiceTrigger' && s.phase === 'pre-save-triggers',
    );
    expect(step).toBeDefined();
    const write = step?.actions.find((a) => a.targetId === 'CustomField:Invoice__c.Status__c');
    expect(write).toMatchObject({ kind: 'writesTo', via: 'ApexClass:InvoiceService' });
    expect(step?.handlerEffects?.handlerChain).toEqual(
      expect.arrayContaining(['ApexClass:InvoiceTriggerHandler', 'ApexClass:InvoiceService']),
    );
    expect(r.value.data.disclosure).toContain('handler/dispatcher Apex');
  });

  it('FAIL-BEFORE/PASS-AFTER: a bypass record that names the object is surfaced as a warning', async () => {
    const r = await whatHappensOnSaveHandler(ctx, { objectApiName: 'Invoice__c', event: 'update' });
    if (!r.ok) throw new Error('expected ok');
    const step = r.value.data.soe.find((s) => s.componentId === 'ApexTrigger:InvoiceTrigger');
    expect(step?.handlerEffects?.bypassSwitches?.[0]).toMatchObject({
      switchType: 'CustomObject:Trigger_Switch__mdt',
      kind: 'custom-metadata',
      readBy: 'ApexClass:TriggerDispatcher',
      recordId: 'CustomMetadataRecord:Trigger_Switch.Invoice',
      trueFlags: ['Disable_All__c'],
      status: 'bypass-flag-set',
    });
    expect(r.value.data.triggerBypassWarnings).toHaveLength(1);
    expect(r.value.data.triggerBypassWarnings?.[0]).toContain('ApexTrigger:InvoiceTrigger may be switched OFF');
  });

  it('reads the switch but finds no record for an object: disclosed, no warning', async () => {
    const r = await whatHappensOnSaveHandler(ctx, { objectApiName: 'Project__c', event: 'update' });
    if (!r.ok) throw new Error('expected ok');
    const step = r.value.data.soe.find((s) => s.componentId === 'ApexTrigger:ProjectTrigger');
    expect(step?.handlerEffects?.bypassSwitches?.[0]?.status).toBe('no-record-for-object');
    expect(r.value.data.triggerBypassWarnings).toBeUndefined();
    expect(step?.actions.some((a) => a.targetId === 'CustomField:Project__c.Phase__c')).toBe(true);
  });

  it('FAIL-BEFORE/PASS-AFTER: order_of_execution carries the same enrichment (shared module)', async () => {
    const r = await orderOfExecutionHandler(ctx, { objectApiName: 'Invoice__c', event: 'update' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const soe = r.value.data.byEvent.update?.soe ?? [];
    const step = soe.find((s) => s.componentId === 'ApexTrigger:InvoiceTrigger');
    expect(step?.actions.some((a) => a.via === 'ApexClass:InvoiceService')).toBe(true);
    expect(r.value.data.triggerBypassWarnings).toHaveLength(1);
  });

  it('FAIL-BEFORE/PASS-AFTER: a TRUE per-context flag is not reported as "no bypass flag"', async () => {
    const r = await whatHappensOnSaveHandler(ctx, { objectApiName: 'Milestone__c', event: 'update' });
    if (!r.ok) throw new Error('expected ok');
    const step = r.value.data.soe.find((s) => s.componentId === 'ApexTrigger:MilestoneTrigger');
    expect(step?.handlerEffects?.bypassSwitches?.[0]).toMatchObject({
      trueFlags: ['Before_Update__c'],
      status: 'flags-set-not-evaluated',
    });
    expect(r.value.data.triggerBypassWarnings?.[0]).toContain('may be switched off for some contexts');
  });

  it('FAIL-BEFORE/PASS-AFTER: a record whose values were not extracted is "values-not-in-vault", not "no flag"', async () => {
    const r = await whatHappensOnSaveHandler(ctx, { objectApiName: 'Ticket__c', event: 'update' });
    if (!r.ok) throw new Error('expected ok');
    const step = r.value.data.soe.find((s) => s.componentId === 'ApexTrigger:TicketTrigger');
    expect(step?.handlerEffects?.bypassSwitches?.[0]).toMatchObject({
      recordId: 'CustomMetadataRecord:Trigger_Switch.Ticket',
      status: 'values-not-in-vault',
    });
  });
});
