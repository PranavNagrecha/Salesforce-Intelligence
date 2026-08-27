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
//     node, NO edges) -> REFUSED with invalid-query (0.3.3; it used to answer
//     `objectModeled: false` + empty findings, which reads as "nothing will
//     break here"). EdgeOnly__c (k): no node but REAL triggersOn edges -> still
//     answers, because the object IS in the vault.
// (f) Inactive__c: one inactive Flow + one active Flow write Flag__c ->
//     collision still listed (2 distinct writers) but activeWriterCount=1,
//     severity 'medium'. DormantLoop__c: an INACTIVE ApexTrigger self-write
//     -> cycle still listed (absence of evidence != none) but allActive
//     false, severity 'info'.
// (g) WfCollide__c: a WorkflowRule + a Flow both write Score__c -> exercises
//     the third `triggersOn` firer family end-to-end.
// (h) MixedDelete__c: a RecordAfterSave Flow AND a RecordBeforeDelete Flow both
//     write Status__c. They run on DIFFERENT execution paths (save vs delete),
//     so they must NOT be bucketed together -> ZERO collisions. This is the
//     regression the fix targets: the pre-fix `!= 'RecordBeforeSave' ? 'after'`
//     collapse folded the before-delete Flow into the save bucket and reported
//     a FALSE save collision here.
// (i) DeleteCollide__c: two RecordBeforeDelete Flows both write Flag__c -> a
//     legitimate DELETE-path collision (undefined delete-path order),
//     collisionPath 'delete', never labeled a save collision.
// (j) DeleteSelfLoop__c: an AFTER trigger self-writes Total__c -> self-write
//     cycle (cycles still work); a RecordBeforeDelete Flow self-writes
//     Computed__c -> must NOT produce a cycle (delete path is not save
//     recursion).
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
    // (h)
    node('CustomObject:MixedDelete__c', 'CustomObject'),
    node('Flow:MixedAfterFlow', 'Flow', { status: 'Active' }),
    node('Flow:MixedDeleteFlow', 'Flow', { status: 'Active' }),
    // (i)
    node('CustomObject:DeleteCollide__c', 'CustomObject'),
    node('Flow:DeleteFlowA', 'Flow', { status: 'Active' }),
    node('Flow:DeleteFlowB', 'Flow', { status: 'Active' }),
    // (j)
    node('CustomObject:DeleteSelfLoop__c', 'CustomObject'),
    node('ApexTrigger:DeleteSelfTrigger', 'ApexTrigger', {
      status: 'Active',
      events: ['after update'],
    }),
    node('Flow:DeleteSelfFlow', 'Flow', { status: 'Active' }),
    // (k) EdgeOnly__c: DELIBERATELY has NO `CustomObject:` node. Two active
    // triggers reach it through `triggersOn` alone — the "standard object the
    // retrieve never pulled, but whose automation it did" case. The existence
    // gate added in 0.3.3 must NOT refuse this: the object is present in the
    // vault, as edges. Refusing it would trade one silent wrong answer for a
    // loud one.
    node('ApexTrigger:EdgeOnlyTrigger', 'ApexTrigger', {
      status: 'Active',
      events: ['before update'],
    }),
    node('Flow:EdgeOnlyFlow', 'Flow', { status: 'Active' }),
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
    // (h) after-save + before-delete write the same field -> DIFFERENT paths
    edge('Flow:MixedAfterFlow', 'CustomObject:MixedDelete__c', 'triggersOn', 'declared', {
      recordTriggerType: 'Update',
      triggerType: 'RecordAfterSave',
    }),
    edge('Flow:MixedDeleteFlow', 'CustomObject:MixedDelete__c', 'triggersOn', 'declared', {
      recordTriggerType: 'Delete',
      triggerType: 'RecordBeforeDelete',
    }),
    edge('Flow:MixedAfterFlow', 'CustomField:MixedDelete__c.Status__c', 'writesTo', 'parsed', {
      operation: 'recordUpdate',
    }),
    edge('Flow:MixedDeleteFlow', 'CustomField:MixedDelete__c.Status__c', 'writesTo', 'parsed', {
      operation: 'recordUpdate',
    }),
    // (i) two before-delete flows write the same field -> delete-path collision
    edge('Flow:DeleteFlowA', 'CustomObject:DeleteCollide__c', 'triggersOn', 'declared', {
      recordTriggerType: 'Delete',
      triggerType: 'RecordBeforeDelete',
    }),
    edge('Flow:DeleteFlowB', 'CustomObject:DeleteCollide__c', 'triggersOn', 'declared', {
      recordTriggerType: 'Delete',
      triggerType: 'RecordBeforeDelete',
    }),
    edge('Flow:DeleteFlowA', 'CustomField:DeleteCollide__c.Flag__c', 'writesTo', 'parsed', {
      operation: 'recordUpdate',
    }),
    edge('Flow:DeleteFlowB', 'CustomField:DeleteCollide__c.Flag__c', 'writesTo', 'parsed', {
      operation: 'recordUpdate',
    }),
    // (j) after-trigger self-write (a cycle) + before-delete self-write (NOT a cycle)
    edge('ApexTrigger:DeleteSelfTrigger', 'CustomObject:DeleteSelfLoop__c', 'triggersOn', 'declared', {}),
    edge(
      'ApexTrigger:DeleteSelfTrigger',
      'CustomField:DeleteSelfLoop__c.Total__c',
      'writesTo',
      'heuristic',
      { offset: 3, length: 4 },
    ),
    edge('Flow:DeleteSelfFlow', 'CustomObject:DeleteSelfLoop__c', 'triggersOn', 'declared', {
      recordTriggerType: 'Delete',
      triggerType: 'RecordBeforeDelete',
    }),
    edge('Flow:DeleteSelfFlow', 'CustomField:DeleteSelfLoop__c.Computed__c', 'writesTo', 'parsed', {
      operation: 'recordUpdate',
    }),
    // (k) two save-path writers on an object with no node of its own.
    edge('ApexTrigger:EdgeOnlyTrigger', 'CustomObject:EdgeOnly__c', 'triggersOn', 'declared', {}),
    edge('ApexTrigger:EdgeOnlyTrigger', 'CustomField:EdgeOnly__c.Stage__c', 'writesTo', 'heuristic', {
      offset: 1,
      length: 2,
    }),
    edge('Flow:EdgeOnlyFlow', 'CustomObject:EdgeOnly__c', 'triggersOn', 'declared', {
      recordTriggerType: 'Update',
      triggerType: 'RecordAfterSave',
    }),
    edge('Flow:EdgeOnlyFlow', 'CustomField:EdgeOnly__c.Stage__c', 'writesTo', 'parsed', {
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

describe('automationCollisionsHandler — L2 alias OS (ADMIN-SURFACE-ALIAS-SKEW-CLUSTER)', () => {
  // GUARD: pre-fix the Zod schema declared only `object`, so a natural
  // `objectApiName` / `objectId` / `CustomObject:` `componentId` was STRIPPED
  // and the tool returned `object: Required`. Post-fix each alias resolves to
  // the SAME findings as the canonical `object`, with the scope echoed.
  const run = async (raw: unknown) => {
    const parsed = automationCollisionsInputSchema.safeParse(raw);
    if (!parsed.success) return { schemaOk: false as const };
    return { schemaOk: true as const, r: await automationCollisionsHandler(ctx, parsed.data) };
  };

  it('natural objectApiName ≡ canonical object (byte-equal findings + appliedScope)', async () => {
    const natural = await run({ objectApiName: 'Collide__c' });
    const canonical = await run({ object: 'Collide__c' });
    expect(natural.schemaOk).toBe(true);
    expect(canonical.schemaOk).toBe(true);
    if (!natural.schemaOk || !canonical.schemaOk) return;
    expect(natural.r.ok && canonical.r.ok).toBe(true);
    if (!natural.r.ok || !canonical.r.ok) return;
    expect(natural.r.value.data.collisions).toEqual(canonical.r.value.data.collisions);
    expect(natural.r.value.data.cycles).toEqual(canonical.r.value.data.cycles);
    expect(natural.r.value.data.appliedScope).toEqual({
      componentId: 'CustomObject:Collide__c',
      object: 'Collide__c',
    });
  });

  it('CustomObject componentId ≡ canonical object', async () => {
    const byComponent = await run({ componentId: 'CustomObject:Collide__c' });
    const canonical = await run({ object: 'Collide__c' });
    expect(byComponent.schemaOk && canonical.schemaOk).toBe(true);
    if (!byComponent.schemaOk || !canonical.schemaOk) return;
    if (!byComponent.r.ok || !canonical.r.ok) return;
    expect(byComponent.r.value.data.collisions).toEqual(canonical.r.value.data.collisions);
    expect(byComponent.r.value.data.appliedScope.object).toBe('Collide__c');
  });

  it('disagreeing aliases → invalid-query (never a silent pick)', async () => {
    const parsed = automationCollisionsInputSchema.safeParse({
      object: 'Collide__c',
      objectApiName: 'Clean__c',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const r = await automationCollisionsHandler(ctx, parsed.data);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid-query');
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

  it('(e) a genuine phantom object (no node, no edges) is REFUSED, not answered', async () => {
    // ASSERTION INVERTED IN 0.3.3, deliberately. This test used to pin
    // `ok` + `objectModeled: false` + `collisions: []` + `cycles: []` as the
    // intended answer for an object the vault has never heard of. It is not:
    // the payload a caller actually reads is a full collision report with
    // empty findings and the whole `boundaries` block, and `objectModeled` is
    // named nowhere in this tool's MCP description, so a host has no reason to
    // consult it. "There is no such object" and "this object has no automation
    // fighting itself" came back as the same shape — the unchecked zero
    // wearing a checked zero's clothes. It is now a named refusal.
    const r = await automationCollisionsHandler(ctx, { object: 'NotInVault__c' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('NotInVault__c');
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

describe('automationCollisionsHandler — before-delete path separation (RM-loop twin fix)', () => {
  it('(h) an after-save Flow and a before-delete Flow writing the SAME field are NOT a save collision', async () => {
    // Pre-fix, the before-delete Flow was mislabeled timing `after` and folded
    // into the save bucket, faking a 2-writer collision on Status__c. The two
    // Flows run on disjoint paths (save vs delete), so neither (field, path)
    // bucket has 2 writers -> zero collisions.
    const r = await automationCollisionsHandler(ctx, { object: 'MixedDelete__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // Both firers ARE scanned (never silently dropped) ...
    expect(d.summary.automationsScanned).toBe(2);
    // ... but they do NOT collide: a delete-path write never races a save write.
    expect(d.collisions).toEqual([]);
    expect(d.summary.fieldsWithMultipleWriters).toBe(0);
  });

  it('(i) two before-delete Flows writing one field ARE a delete-path collision, never a save collision', async () => {
    const r = await automationCollisionsHandler(ctx, { object: 'DeleteCollide__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.collisions).toHaveLength(1);
    const c = d.collisions[0]!;
    expect(c.fieldApiName).toBe('Flag__c');
    // Labeled a DELETE-path collision — NEVER a save collision.
    expect(c.collisionPath).toBe('delete');
    expect(c.writers.map((w) => w.componentId).sort()).toEqual([
      'Flow:DeleteFlowA',
      'Flow:DeleteFlowB',
    ]);
    // Every contributing writer's timing is before-delete (delete path).
    expect(c.writers.every((w) => w.timing === 'before-delete')).toBe(true);
    expect(c.activeWriterCount).toBe(2);
    expect(c.weakestConfidence).toBe('parsed');
    expect(c.severity).toBe('high');
  });

  it('(i) no collision or boundary text ever labels a before-delete collision a "save" collision', async () => {
    const r = await automationCollisionsHandler(ctx, { object: 'DeleteCollide__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // The delete-path finding is never tagged as a save-path collision.
    expect(d.collisions.every((c) => c.collisionPath !== 'save')).toBe(true);
    // The boundaries disclose the delete-vs-save partition explicitly.
    const text = d.boundaries.join(' ');
    expect(text).toMatch(/delete[- ]path/i);
    expect(text).toMatch(/never a save collision|DELETE path/i);
  });

  it('(j) a before-delete Flow self-write does NOT produce a save-recursion cycle, but a normal after-trigger self-write still does', async () => {
    const r = await automationCollisionsHandler(ctx, { object: 'DeleteSelfLoop__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // The before-delete Flow is on the DELETE path -> never a save-recursion hop.
    const deleteHop = d.cycles.find((c) =>
      c.path.some((h) => h.automationId === 'Flow:DeleteSelfFlow'),
    );
    expect(deleteHop).toBeUndefined();
    // Save-recursion detection still works for the after-trigger self-write.
    const selfWrites = d.cycles.filter((c) => c.kind === 'self-write');
    expect(selfWrites).toHaveLength(1);
    expect(selfWrites[0]!.path[0]!.automationId).toBe('ApexTrigger:DeleteSelfTrigger');
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

// =============================================================================
// AUTOMATION-COLLISIONS-ANSWERS-FOR-AN-OBJECT-IT-NEVER-FOUND (0.3.3).
//
// The object was resolved by the SYNC `resolveObjectAlias`, which canonicalises
// the name but never asks the vault whether the object is there. A caller
// asking "what already fights over this object?" about a name with no node and
// no automation edge got `ok` + `collisions: []` + `cycles: []` +
// `automationsScanned: 0` — "nothing will break". The same call in the WRONG
// CASE (`collide__c`) got the identical false all-clear, because
// `gatherFirersForObject` builds `CustomObject:${name}` and matches exactly.
//
// The gate is deliberately NOT `resolveExistingObjectScope`: this tool can
// legitimately answer for an object that has no `CustomObject:` node of its own
// but IS reached by `triggersOn` edges (a standard object whose automation was
// retrieved and whose own metadata was not). Only an object present in NEITHER
// place is refused.
// =============================================================================
describe('automationCollisionsHandler — unresolvable object scope', () => {
  const PHANTOM = 'Zzz_Nonexistent_Object_9x7__c';

  it('refuses an object present in neither the nodes nor the automation edges', async () => {
    const r = await automationCollisionsHandler(ctx, { object: PHANTOM });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain(PHANTOM);
  });

  it('refuses the same phantom named through every alias', async () => {
    for (const args of [
      { objectApiName: PHANTOM },
      { objectId: `CustomObject:${PHANTOM}` },
      { componentId: `CustomObject:${PHANTOM}` },
    ]) {
      const r = await automationCollisionsHandler(ctx, args);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.kind).toBe('invalid-query');
    }
  });

  it('a REAL object in the wrong case still answers, echoed in the vault casing', async () => {
    const lower = await automationCollisionsHandler(ctx, { object: 'collide__c' });
    const exact = await automationCollisionsHandler(ctx, { object: 'Collide__c' });
    expect(lower.ok && exact.ok).toBe(true);
    if (!lower.ok || !exact.ok) return;
    // The echo is the VAULT's casing — `CustomObject:collide__c` is an id this
    // vault does not hold, so echoing the caller's spelling would assert a
    // component that does not exist.
    expect(lower.value.data.appliedScope).toEqual({
      componentId: 'CustomObject:Collide__c',
      object: 'Collide__c',
    });
    expect(lower.value.data.collisions).toEqual(exact.value.data.collisions);
    expect(lower.value.data.collisions).toHaveLength(1);
  });

  it('(k) an object reached ONLY by triggersOn edges still answers — the gate is not a node check', async () => {
    // EdgeOnly__c has no `CustomObject:` node. It DOES have two active save-path
    // writers on Stage__c, so the collision is real and must be reported.
    const r = await automationCollisionsHandler(ctx, { object: 'EdgeOnly__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.summary.automationsScanned).toBe(2);
    expect(d.collisions).toHaveLength(1);
    expect(d.collisions[0]!.fieldApiName).toBe('Stage__c');
    // `objectModeled` keeps its "the vault holds this object in SOME form"
    // meaning — the same one `automation_build_advisor` publishes under the
    // same key over the same firer set. Narrowing it here would make two
    // sibling tools disagree about whether one object is modeled.
    expect(d.objectModeled).toBe(true);
    // The narrower fact goes where this tool puts its honesty: a boundary
    // saying the object's OWN metadata was never retrieved.
    const edgeOnlyBoundary = d.boundaries.find((b) => b.includes('EdgeOnly__c'));
    expect(edgeOnlyBoundary).toBeDefined();
    expect(edgeOnlyBoundary).toContain('NO CustomObject node');
  });
});
