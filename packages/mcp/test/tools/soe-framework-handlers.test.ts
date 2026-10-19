/// <reference types="vitest/globals" />

/**
 * SAVE-REGISTERED-HANDLERS — save order lists the handler classes a managed
 * trigger framework runs, as conditional steps.
 *
 * An org class that extends a trigger-framework base from another namespace
 * (`ns.TDTM_Runnable`) is run by the package's own trigger only if a
 * registration RECORD names it; the record is data the vault does not hold.
 * Before this, such classes were absent from both save-order tools and a host
 * told the user "nothing custom runs before the save". All names synthetic.
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
import { orderOfExecutionHandler } from '../../src/tools/order-of-execution.js';
import { SOE_FRAMEWORK_HANDLERS_NOTE } from '../../src/tools/soe-framework-handlers.js';
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

const BASE = 'demo_ns.TDTM_Runnable';
const cls = (name: string, properties: Record<string, unknown> = {}): Node =>
  node({
    id: `ApexClass:${name}`,
    type: 'ApexClass',
    apiName: name,
    sourcePath: `source/classes/${name}.cls`,
    properties: { superclass: BASE, implements: [], ...properties },
  });

const SOURCES: Record<string, string> = {
  // Extends the base, writes the object's field, names the before-update context.
  Demo_AppFlag_TDTM:
    'global class Demo_AppFlag_TDTM extends demo_ns.TDTM_Runnable {\n' +
    '  global override DmlWrapper run(List<SObject> newList, List<SObject> oldList, demo_ns.TDTM_Runnable.Action triggerAction, Schema.DescribeSObjectResult objResult) {\n' +
    '    if (triggerAction == demo_ns.TDTM_Runnable.Action.BeforeUpdate) { for (Demo_Application__c a : (List<Demo_Application__c>) newList) a.Demo_Flag__c = true; }\n' +
    '    return null;\n  }\n}\n',
  // Extends the base, NO graph edge to the object: touches it only through a
  // constructor-style assignment the scanner misses. Names after-insert only.
  Demo_AppUpsert_TDTM:
    'global class Demo_AppUpsert_TDTM extends demo_ns.TDTM_Runnable {\n' +
    '  global override DmlWrapper run(List<SObject> newList, List<SObject> oldList, demo_ns.TDTM_Runnable.Action triggerAction, Schema.DescribeSObjectResult objResult) {\n' +
    '    if (triggerAction == demo_ns.TDTM_Runnable.Action.AfterInsert) { update new Demo_Application__c(Id = newList[0].Id, Demo_Flag__c = false); }\n' +
    '    return null;\n  }\n}\n',
  // Extends the base but handles ANOTHER object.
  Demo_Other_TDTM:
    'global class Demo_Other_TDTM extends demo_ns.TDTM_Runnable {\n' +
    '  global override DmlWrapper run(List<SObject> newList, List<SObject> oldList, demo_ns.TDTM_Runnable.Action triggerAction, Schema.DescribeSObjectResult objResult) {\n' +
    '    for (Demo_Other__c o : (List<Demo_Other__c>) newList) o.Name = \'x\';\n    return null;\n  }\n}\n',
  // A test class for the handler: extends the base, names the object, never a step.
  Demo_AppFlag_TDTM_Test:
    '@isTest private class Demo_AppFlag_TDTM_Test extends demo_ns.TDTM_Runnable { static void t() { insert new Demo_Application__c(); } }\n',
  // A plain org class (no framework base) that writes the object: not a handler.
  Demo_AppService:
    'public class Demo_AppService { public static void go(Demo_Application__c a) { a.Demo_Flag__c = true; update a; } }\n',
};

const seed: ExtractionResult = {
  nodes: [
    node({ id: 'CustomObject:Demo_Application__c', type: 'CustomObject', apiName: 'Demo_Application__c' }),
    node({ id: 'CustomField:Demo_Application__c.Demo_Flag__c', type: 'CustomField', apiName: 'Demo_Flag__c' }),
    node({ id: 'CustomObject:Demo_Other__c', type: 'CustomObject', apiName: 'Demo_Other__c' }),
    node({ id: 'CustomObject:Demo_Plain__c', type: 'CustomObject', apiName: 'Demo_Plain__c' }),
    cls('Demo_AppFlag_TDTM'),
    cls('Demo_AppUpsert_TDTM'),
    cls('Demo_Other_TDTM'),
    cls('Demo_AppFlag_TDTM_Test', { isTest: true }),
    cls('Demo_AppService', { superclass: null }),
  ],
  edges: [
    edge('ApexClass:Demo_AppFlag_TDTM', 'CustomField:Demo_Application__c.Demo_Flag__c', 'writesTo'),
    edge('ApexClass:Demo_Other_TDTM', 'CustomObject:Demo_Other__c', 'references'),
    edge('ApexClass:Demo_AppFlag_TDTM_Test', 'CustomObject:Demo_Application__c', 'references'),
    edge('ApexClass:Demo_AppService', 'CustomField:Demo_Application__c.Demo_Flag__c', 'writesTo'),
  ],
};

let dir: string;
let graph: GraphStore;
let ctx: Context;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-soe-fw-handlers-'));
  mkdirSync(join(dir, 'source', 'classes'), { recursive: true });
  for (const [name, text] of Object.entries(SOURCES)) {
    writeFileSync(join(dir, 'source', 'classes', `${name}.cls`), text);
  }
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

const handlerSteps = <T extends { conditionalOn?: { reason: string } }>(soe: readonly T[]): T[] =>
  soe.filter((s) => s.conditionalOn?.reason === 'framework-registered-handler');

describe('SAVE-REGISTERED-HANDLERS: framework handler classes are conditional save-order steps', () => {
  it('FAIL-BEFORE/PASS-AFTER: update lists the two handlers that touch the object, in the phase their source names', async () => {
    const r = await whatHappensOnSaveHandler(ctx, { objectApiName: 'Demo_Application__c', event: 'update' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const steps = handlerSteps(r.value.data.soe);
    expect(steps.map((s) => s.componentId).sort()).toEqual([
      'ApexClass:Demo_AppFlag_TDTM',
      'ApexClass:Demo_AppUpsert_TDTM',
    ]);
    const flag = steps.find((s) => s.componentId === 'ApexClass:Demo_AppFlag_TDTM');
    expect(flag).toMatchObject({
      phase: 'pre-save-triggers',
      componentType: 'ApexClass',
      conditionalOn: { reason: 'framework-registered-handler', baseClass: BASE, phase: 'before' },
    });
    expect(flag?.actions).toEqual([
      expect.objectContaining({ kind: 'writesTo', targetId: 'CustomField:Demo_Application__c.Demo_Flag__c' }),
    ]);
    // Source-only touch (no graph edge); names after-insert, so on UPDATE the
    // context is unknown and it sits at the earliest point it could run.
    const upsert = steps.find((s) => s.componentId === 'ApexClass:Demo_AppUpsert_TDTM');
    expect(upsert).toMatchObject({
      phase: 'pre-save-triggers',
      conditionalOn: { reason: 'framework-registered-handler', baseClass: BASE, phase: 'unknown' },
    });
    expect(r.value.data.summary.conditionalSteps).toBe(2);
    expect(r.value.data.disclosure).toContain(SOE_FRAMEWORK_HANDLERS_NOTE);
  });

  it('insert places the after-insert handler under after-triggers', async () => {
    const r = await whatHappensOnSaveHandler(ctx, { objectApiName: 'Demo_Application__c', event: 'insert' });
    if (!r.ok) throw new Error('expected ok');
    const upsert = handlerSteps(r.value.data.soe).find((s) => s.componentId === 'ApexClass:Demo_AppUpsert_TDTM');
    expect(upsert).toMatchObject({ phase: 'after-triggers', conditionalOn: { phase: 'after' } });
  });

  it('FAIL-BEFORE/PASS-AFTER: order_of_execution carries the same rows (shared module)', async () => {
    const r = await orderOfExecutionHandler(ctx, { objectApiName: 'Demo_Application__c', event: 'update' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const steps = handlerSteps(r.value.data.byEvent.update?.soe ?? []);
    expect(steps.map((s) => [s.componentId, s.phase, s.conditionalOn?.phase]).sort()).toEqual([
      ['ApexClass:Demo_AppFlag_TDTM', 'pre-save-triggers', 'before'],
      ['ApexClass:Demo_AppUpsert_TDTM', 'pre-save-triggers', 'unknown'],
    ]);
    expect(r.value.data.byEvent.update?.summary.conditionalSteps).toBe(2);
    expect(r.value.data.disclosure).toContain(SOE_FRAMEWORK_HANDLERS_NOTE);
  });

  it('an object no framework subclass touches prints no handler step and no disclosure', async () => {
    const r = await whatHappensOnSaveHandler(ctx, { objectApiName: 'Demo_Plain__c', event: 'update' });
    if (!r.ok) throw new Error('expected ok');
    expect(handlerSteps(r.value.data.soe)).toHaveLength(0);
    expect(r.value.data.disclosure).not.toContain(SOE_FRAMEWORK_HANDLERS_NOTE);
    expect(r.value.data.disclosure).not.toContain('framework-registered-handler');
  });
});
