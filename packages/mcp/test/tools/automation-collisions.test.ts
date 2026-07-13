/// <reference types="vitest/globals" />

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
import {
  automationCollisionsHandler,
  automationCollisionsInputSchema,
} from '../../src/tools/automation-collisions.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-07-10T00:00:00Z',
  sourceOrg: 'test',
  components: { CustomObject: 6 },
  edges: { triggersOn: 10, writesTo: 10 },
  sourceTreeHash: 'sha256:fixture-collisions',
};

const node = (id: string, type: Node['type'], props: Record<string, unknown> = {}): Node => ({
  id,
  type,
  apiName: id.split(':')[1] ?? id,
  label: null,
  parentId: null,
  sourcePath: `${id}.xml`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: props,
});

const edge = (
  fromId: string,
  toId: string,
  edgeType: Edge['edgeType'],
  confidence: Edge['confidence'],
  props: Record<string, unknown> = {},
): Edge => ({
  fromId,
  toId,
  edgeType,
  confidence,
  source: 'unit-test',
  properties: props,
});

// --- Fixture design -----------------------------------------------------
//
// (a) Collide__c: two ACTIVE record-triggered Flows both write Status__c ->
//     collision, weakestConfidence 'parsed', severity 'high'.
// (b) ApexCollide__c: one Flow + one heuristic ApexTrigger both write
//     Priority__c -> collision, weakestConfidence 'heuristic' (weaker wins),
//     severity 'medium' (active but heuristic-tainted).
// (c) SelfLoop__c: an AFTER ApexTrigger writes its OWN object's Total__c ->
//     self-write cycle. A BEFORE-save Flow also writes Computed__c on the
//     same object -> must NOT produce a cycle (before-save writes don't
//     cause a second save).
// (d) CycleA__c / CycleB__c: Flow on A writes a field on B; Flow on B writes
//     a field back on A -> multi-object cycle, depth 2.
// (e) Clean__c: modeled (node present) but zero automation -> empty
//     collisions/cycles, no fabrication. NotInVault__c: genuine phantom (no
//     node, no edges) -> objectModeled false, empty findings, no error.
// (f) Inactive__c: one inactive Flow + one active Flow write Flag__c ->
//     collision still listed (2 distinct writers) but activeWriterCount=1,
//     severity 'medium'. DormantLoop__c: an INACTIVE ApexTrigger self-write
//     -> cycle still listed (absence of evidence != none) but allActive
//     false, severity 'info'.
// (g) WfCollide__c: a WorkflowRule + a Flow both write Score__c -> exercises
//     the third `triggersOn` firer family end-to-end.
const seed: ExtractionResult = {
  nodes: [
    // (a)
    node('CustomObject:Collide__c', 'CustomObject'),
    node('Flow:CollideFlowA', 'Flow', { status: 'Active' }),
    node('Flow:CollideFlowB', 'Flow', { status: 'Active' }),
    // (b)
    node('CustomObject:ApexCollide__c', 'CustomObject'),
    node('Flow:ApexCollideFlow', 'Flow', { status: 'Active' }),
    node('ApexTrigger:ApexCollideTrigger', 'ApexTrigger', {
      status: 'Active',
      events: ['after update'],
    }),
    // (c)
    node('CustomObject:SelfLoop__c', 'CustomObject'),
    node('ApexTrigger:SelfLoopTrigger', 'ApexTrigger', {
      status: 'Active',
      events: ['after update'],
    }),
    node('Flow:SelfLoopBeforeFlow', 'Flow', { status: 'Active' }),
    // (d)
    node('CustomObject:CycleA__c', 'CustomObject'),
    node('CustomObject:CycleB__c', 'CustomObject'),
    node('Flow:CycleFlowAtoB', 'Flow', { status: 'Active' }),
    node('Flow:CycleFlowBtoA', 'Flow', { status: 'Active' }),
    // (e)
    node('CustomObject:Clean__c', 'CustomObject'),
    // (f)
    node('CustomObject:Inactive__c', 'CustomObject'),
    node('Flow:InactiveFlowA', 'Flow', { status: 'Draft' }),
    node('Flow:InactiveFlowB', 'Flow', { status: 'Active' }),
    node('CustomObject:DormantLoop__c', 'CustomObject'),
    node('ApexTrigger:DormantTrigger', 'ApexTrigger', {
      status: 'Inactive',
      events: ['after update'],
    }),
    // (g)
    node('CustomObject:WfCollide__c', 'CustomObject'),
    node('WorkflowRule:WfRule', 'WorkflowRule', { active: true }),
    node('Flow:WfFlow', 'Flow', { status: 'Active' }),
  ],
  edges: [
    // (a)
    edge('Flow:CollideFlowA', 'CustomObject:Collide__c', 'triggersOn', 'declared', {
      recordTriggerType: 'Update',
      triggerType: 'RecordAfterSave',
    }),
    edge('Flow:CollideFlowB', 'CustomObject:Collide__c', 'triggersOn', 'declared', {
      recordTriggerType: 'Update',
      triggerType: 'RecordAfterSave',
    }),
    edge('Flow:CollideFlowA', 'CustomField:Collide__c.Status__c', 'writesTo', 'parsed', {
      operation: 'recordUpdate',
    }),
    edge('Flow:CollideFlowB', 'CustomField:Collide__c.Status__c', 'writesTo', 'parsed', {
      operation: 'recordUpdate',
    }),
    // (b)
    edge('Flow:ApexCollideFlow', 'CustomObject:ApexCollide__c', 'triggersOn', 'declared', {
      recordTriggerType: 'Update',
      triggerType: 'RecordAfterSave',
    }),
    edge(
      'ApexTrigger:ApexCollideTrigger',
      'CustomObject:ApexCollide__c',
      'triggersOn',
      'declared',
      {},
    ),
    edge('Flow:ApexCollideFlow', 'CustomField:ApexCollide__c.Priority__c', 'writesTo', 'parsed', {
      operation: 'recordUpdate',
    }),
    edge(
      'ApexTrigger:ApexCollideTrigger',
      'CustomField:ApexCollide__c.Priority__c',
      'writesTo',
      'heuristic',
      { offset: 10, length: 4 },
    ),
    // (c)
    edge('ApexTrigger:SelfLoopTrigger', 'CustomObject:SelfLoop__c', 'triggersOn', 'declared', {}),
    edge(
      'ApexTrigger:SelfLoopTrigger',
      'CustomField:SelfLoop__c.Total__c',
      'writesTo',
      'heuristic',
      { offset: 1, length: 4 },
    ),
    edge('Flow:SelfLoopBeforeFlow', 'CustomObject:SelfLoop__c', 'triggersOn', 'declared', {
      recordTriggerType: 'Update',
      triggerType: 'RecordBeforeSave',
    }),
    edge(
      'Flow:SelfLoopBeforeFlow',
      'CustomField:SelfLoop__c.Computed__c',
      'writesTo',
      'parsed',
      { operation: 'recordUpdate' },
    ),
    // (d)
    edge('Flow:CycleFlowAtoB', 'CustomObject:CycleA__c', 'triggersOn', 'declared', {
      recordTriggerType: 'Update',
      triggerType: 'RecordAfterSave',
    }),
    edge('Flow:CycleFlowAtoB', 'CustomField:CycleB__c.Mirror__c', 'writesTo', 'parsed', {
      operation: 'recordUpdate',
    }),
    edge('Flow:CycleFlowBtoA', 'CustomObject:CycleB__c', 'triggersOn', 'declared', {
      recordTriggerType: 'Update',
      triggerType: 'RecordAfterSave',
    }),
    edge('Flow:CycleFlowBtoA', 'CustomField:CycleA__c.Mirror__c', 'writesTo', 'parsed', {
      operation: 'recordUpdate',
    }),
    // (f)
    edge('Flow:InactiveFlowA', 'CustomObject:Inactive__c', 'triggersOn', 'declared', {
      recordTriggerType: 'Update',
      triggerType: 'RecordAfterSave',
    }),
    edge('Flow:InactiveFlowB', 'CustomObject:Inactive__c', 'triggersOn', 'declared', {
      recordTriggerType: 'Update',
      triggerType: 'RecordAfterSave',
    }),
    edge('Flow:InactiveFlowA', 'CustomField:Inactive__c.Flag__c', 'writesTo', 'parsed', {
      operation: 'recordUpdate',
    }),
    edge('Flow:InactiveFlowB', 'CustomField:Inactive__c.Flag__c', 'writesTo', 'parsed', {
      operation: 'recordUpdate',
    }),
    edge('ApexTrigger:DormantTrigger', 'CustomObject:DormantLoop__c', 'triggersOn', 'declared', {}),
    edge(
      'ApexTrigger:DormantTrigger',
      'CustomField:DormantLoop__c.Score__c',
      'writesTo',
      'heuristic',
      { offset: 2, length: 4 },
    ),
    // (g)
    edge('WorkflowRule:WfRule', 'CustomObject:WfCollide__c', 'triggersOn', 'declared', {
      triggerType: 'onAllChanges',
    }),
    edge('Flow:WfFlow', 'CustomObject:WfCollide__c', 'triggersOn', 'declared', {
      recordTriggerType: 'Update',
      triggerType: 'RecordAfterSave',
    }),
    edge('WorkflowRule:WfRule', 'CustomField:WfCollide__c.Score__c', 'writesTo', 'parsed', {
      operation: 'update',
    }),
    edge('Flow:WfFlow', 'CustomField:WfCollide__c.Score__c', 'writesTo', 'parsed', {
      operation: 'recordUpdate',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-collide-'));
  const opened = await openGraph(join(tempDir, 'collide.db'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store } as Context;
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('automationCollisionsInputSchema', () => {
  it('requires a non-empty object; limit is optional and bounded', () => {
    expect(automationCollisionsInputSchema.safeParse({}).success).toBe(false);
    expect(automationCollisionsInputSchema.safeParse({ object: '' }).success).toBe(false);
    expect(automationCollisionsInputSchema.safeParse({ object: 'Account' }).success).toBe(true);
    expect(
      automationCollisionsInputSchema.safeParse({ object: 'Account', limit: 10 }).success,
    ).toBe(true);
    expect(
      automationCollisionsInputSchema.safeParse({ object: 'Account', limit: 0 }).success,
    ).toBe(false);
  });
});

describe('automationCollisionsHandler — field-level write collisions', () => {
  it('(a) flags 2 active declared/parsed writers on the same field as a high-severity collision', async () => {
    const r = await automationCollisionsHandler(ctx, { object: 'Collide__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.objectModeled).toBe(true);
    expect(d.collisions).toHaveLength(1);
    const c = d.collisions[0]!;
    expect(c.fieldId).toBe('CustomField:Collide__c.Status__c');
    expect(c.fieldApiName).toBe('Status__c');
    expect(c.writers.map((w) => w.componentId).sort()).toEqual([
      'Flow:CollideFlowA',
      'Flow:CollideFlowB',
    ]);
    expect(c.activeWriterCount).toBe(2);
    expect(c.weakestConfidence).toBe('parsed');
    expect(c.severity).toBe('high');
  });

  it('(b) carries the WEAKEST confidence when one writer is a heuristic Apex write', async () => {
    const r = await automationCollisionsHandler(ctx, { object: 'ApexCollide__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.collisions).toHaveLength(1);
    const c = d.collisions[0]!;
    expect(c.fieldId).toBe('CustomField:ApexCollide__c.Priority__c');
    const byId = new Map(c.writers.map((w) => [w.componentId, w]));
    expect(byId.get('Flow:ApexCollideFlow')?.confidence).toBe('parsed');
    expect(byId.get('ApexTrigger:ApexCollideTrigger')?.confidence).toBe('heuristic');
    // The finding-level confidence is the WEAKEST across contributing writers.
    expect(c.weakestConfidence).toBe('heuristic');
    expect(c.severity).toBe('medium');
  });

  it('(e) a modeled-but-clean object returns empty findings, never fabricated', async () => {
    const r = await automationCollisionsHandler(ctx, { object: 'Clean__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.objectModeled).toBe(true);
    expect(r.value.data.collisions).toEqual([]);
    expect(r.value.data.cycles).toEqual([]);
  });

  it('(e) a genuine phantom object (no node, no edges) is objectModeled:false with no error', async () => {
    const r = await automationCollisionsHandler(ctx, { object: 'NotInVault__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.objectModeled).toBe(false);
    expect(r.value.data.collisions).toEqual([]);
    expect(r.value.data.cycles).toEqual([]);
  });

  it('(f) an inactive writer still surfaces the collision (2 distinct writers), but activeWriterCount reflects reality', async () => {
    const r = await automationCollisionsHandler(ctx, { object: 'Inactive__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.collisions).toHaveLength(1);
    const c = d.collisions[0]!;
    expect(c.writers).toHaveLength(2);
    expect(c.activeWriterCount).toBe(1);
    const byId = new Map(c.writers.map((w) => [w.componentId, w]));
    expect(byId.get('Flow:InactiveFlowA')?.active).toBe(false);
    expect(byId.get('Flow:InactiveFlowB')?.active).toBe(true);
    expect(c.severity).toBe('medium');
  });

  it('(g) a WorkflowRule and a Flow writing the same field is a real collision (third firer family)', async () => {
    const r = await automationCollisionsHandler(ctx, { object: 'WfCollide__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.collisions).toHaveLength(1);
    const c = d.collisions[0]!;
    expect(c.writers.map((w) => w.componentType).sort()).toEqual(['Flow', 'WorkflowRule']);
    expect(c.activeWriterCount).toBe(2);
    expect(c.severity).toBe('high');
  });
});

describe('automationCollisionsHandler — save-recursion cycles', () => {
  it('(c) an AFTER trigger writing its own object is a self-write cycle', async () => {
    const r = await automationCollisionsHandler(ctx, { object: 'SelfLoop__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    const selfWrites = d.cycles.filter((c) => c.kind === 'self-write');
    expect(selfWrites).toHaveLength(1);
    const cyc = selfWrites[0]!;
    expect(cyc.path).toHaveLength(1);
    expect(cyc.path[0]!.automationId).toBe('ApexTrigger:SelfLoopTrigger');
    expect(cyc.path[0]!.fieldId).toBe('CustomField:SelfLoop__c.Total__c');
    expect(cyc.allActive).toBe(true);
    expect(cyc.weakestConfidence).toBe('heuristic');
    expect(cyc.severity).toBe('medium');
  });

  it('(c) a BEFORE-save Flow writing its own object does NOT produce a cycle', async () => {
    const r = await automationCollisionsHandler(ctx, { object: 'SelfLoop__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const beforeSaveCycle = r.value.data.cycles.find(
      (c) => c.path[0]?.automationId === 'Flow:SelfLoopBeforeFlow',
    );
    expect(beforeSaveCycle).toBeUndefined();
  });

  it('(d) a two-object A->B->A write cycle is detected with the full real-node path', async () => {
    const r = await automationCollisionsHandler(ctx, { object: 'CycleA__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    const multi = d.cycles.filter((c) => c.kind === 'multi-object');
    expect(multi).toHaveLength(1);
    const cyc = multi[0]!;
    expect(cyc.path).toHaveLength(2);
    expect(cyc.path[0]!.automationId).toBe('Flow:CycleFlowAtoB');
    expect(cyc.path[0]!.fromObject).toBe('CycleA__c');
    expect(cyc.path[0]!.toObject).toBe('CycleB__c');
    expect(cyc.path[1]!.automationId).toBe('Flow:CycleFlowBtoA');
    expect(cyc.path[1]!.fromObject).toBe('CycleB__c');
    expect(cyc.path[1]!.toObject).toBe('CycleA__c');
    expect(cyc.allActive).toBe(true);
    expect(cyc.weakestConfidence).toBe('parsed');
    expect(cyc.severity).toBe('high');
  });

  it('(f) an INACTIVE self-writing trigger is still listed (absence of evidence != none) but marked non-active/lower severity', async () => {
    const r = await automationCollisionsHandler(ctx, { object: 'DormantLoop__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.cycles).toHaveLength(1);
    const cyc = d.cycles[0]!;
    expect(cyc.kind).toBe('self-write');
    expect(cyc.allActive).toBe(false);
    expect(cyc.severity).toBe('info');
  });

  it('(e) a clean object has zero cycles', async () => {
    const r = await automationCollisionsHandler(ctx, { object: 'Clean__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.cycles).toEqual([]);
  });
});

describe('automationCollisionsHandler — boundaries and summary', () => {
  it('always discloses the recursion-guard-not-evaluated and depth-cap boundaries', async () => {
    const r = await automationCollisionsHandler(ctx, { object: 'SelfLoop__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = r.value.data.boundaries.join(' ');
    expect(text).toMatch(/re-trigger|recursion guard/i);
    expect(text).toMatch(/depth/i);
    expect(text).toMatch(/not evaluated|NOT evaluated/);
  });

  it('summary counts automations scanned and findings', async () => {
    const r = await automationCollisionsHandler(ctx, { object: 'Collide__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.summary.automationsScanned).toBe(2);
    expect(r.value.data.summary.fieldsWithMultipleWriters).toBe(1);
  });
});
