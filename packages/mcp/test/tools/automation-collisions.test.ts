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
import { responseReductionCap } from '../../src/tools/response-budget.js';
import { isActiveSoeFirer } from '../../src/tools/soe-active.js';

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
    // (l) WholeRec__c: the FLOW-RECORD-VARIABLE-DML blind spot. `WholeRecVarFlow`
    // is an ACTIVE record-triggered Flow whose Update Records element targets a
    // record VARIABLE (`<inputReference>Var4Update</inputReference>` with NO
    // `<inputAssignments>`), so the extractor can emit only an OBJECT-level
    // `writesTo` carrying `wholeRecord: true` / `fieldsEnumerable: false` — the
    // individual fields it assigns are NOT enumerable from the XML. A sibling
    // Flow DOES write `Status__c` at field level, so the object's write surface
    // looks populated. That is the corrosive shape: coverage is PARTIAL, and a
    // reader who sees field-level writers concludes the surface is modeled.
    node('CustomObject:WholeRec__c', 'CustomObject'),
    node('Flow:WholeRecVarFlow', 'Flow', { status: 'Active' }),
    node('Flow:WholeRecFieldFlow', 'Flow', { status: 'Active' }),
    // (m) DeleteWholeRec__c: the SAME record-variable markers on a
    // `recordDelete` object-level edge. A delete writes no FIELDS, so it must
    // NOT be counted as an unenumerable field write — the false-positive guard
    // on the new detector.
    node('CustomObject:DeleteWholeRec__c', 'CustomObject'),
    node('Flow:DeleteWholeRecFlow', 'Flow', { status: 'Active' }),
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
    // (l) record-variable DML: object-level write only, field identity unresolved.
    edge('Flow:WholeRecVarFlow', 'CustomObject:WholeRec__c', 'triggersOn', 'declared', {
      recordTriggerType: 'Update',
      triggerType: 'RecordAfterSave',
    }),
    edge('Flow:WholeRecVarFlow', 'CustomObject:WholeRec__c', 'writesTo', 'declared', {
      operation: 'recordUpdate',
      inputReferenceKind: 'recordVariable',
      inputReference: 'Var4Update',
      wholeRecord: true,
      fieldsEnumerable: false,
      disclosure: 'whole-record write; individual fields not enumerable from a record-variable DML',
    }),
    edge('Flow:WholeRecFieldFlow', 'CustomObject:WholeRec__c', 'triggersOn', 'declared', {
      recordTriggerType: 'Update',
      triggerType: 'RecordAfterSave',
    }),
    edge('Flow:WholeRecFieldFlow', 'CustomField:WholeRec__c.Status__c', 'writesTo', 'parsed', {
      operation: 'recordUpdate',
    }),
    // (m) record-variable DELETE: same markers, but a delete assigns no fields.
    edge('Flow:DeleteWholeRecFlow', 'CustomObject:DeleteWholeRec__c', 'triggersOn', 'declared', {
      recordTriggerType: 'Update',
      triggerType: 'RecordAfterSave',
    }),
    edge('Flow:DeleteWholeRecFlow', 'CustomObject:DeleteWholeRec__c', 'writesTo', 'declared', {
      operation: 'recordDelete',
      inputReferenceKind: 'recordVariable',
      inputReference: 'Var4Delete',
      wholeRecord: true,
      fieldsEnumerable: false,
      disclosure: 'whole-record write; individual fields not enumerable from a record-variable DML',
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

// --- R2 byte-budget honesty ------------------------------------------------
//
// A SECOND, deliberately fat vault: one object whose two after-save Flows each
// write 150 fields. That is 150 save-path field collisions AND 300 self-write
// cycles on ONE object — enough for either list, on its own, to overflow the
// per-page byte budget, which is exactly the shape the two defects need:
//
//   1. the truncation sentence printed `limit`, not the number of rows it
//      actually shipped, so a BYTE trim announced "truncated to 200 of 150"
//      over a 90-row page (and "200 of 150" is not even arithmetically
//      possible);
//   2. each list was paged against the FULL default 38 000-byte budget while
//      both travel in ONE ~39 000-byte envelope, so the two pages together
//      overflowed it and `jsonResult` tail-trimmed the SECOND list — while its
//      own `cyclesTruncated` flag, and the count in `boundaries` (which is
//      honesty-protected from that trim), still claimed the untrimmed number.
describe('automationCollisionsHandler — byte-budget honesty (R2)', () => {
  const BIG_FIELD_COUNT = 150;
  let bigDir: string;
  let bigStore: GraphStore;
  let bigCtx: Context;

  beforeAll(async () => {
    const nodes: Node[] = [
      node('CustomObject:BigBoth__c', 'CustomObject'),
      node('Flow:BigCollisionFlowAlpha', 'Flow', { status: 'Active' }),
      node('Flow:BigCollisionFlowBeta', 'Flow', { status: 'Active' }),
    ];
    const edges: Edge[] = [
      edge('Flow:BigCollisionFlowAlpha', 'CustomObject:BigBoth__c', 'triggersOn', 'declared', {
        recordTriggerType: 'Update',
        triggerType: 'RecordAfterSave',
      }),
      edge('Flow:BigCollisionFlowBeta', 'CustomObject:BigBoth__c', 'triggersOn', 'declared', {
        recordTriggerType: 'Update',
        triggerType: 'RecordAfterSave',
      }),
    ];
    for (let i = 0; i < BIG_FIELD_COUNT; i += 1) {
      const fieldId = `CustomField:BigBoth__c.Field${String(i).padStart(3, '0')}__c`;
      for (const flow of ['Flow:BigCollisionFlowAlpha', 'Flow:BigCollisionFlowBeta']) {
        edges.push(edge(flow, fieldId, 'writesTo', 'parsed', { operation: 'recordUpdate' }));
      }
    }
    bigDir = mkdtempSync(join(tmpdir(), 'sfi-collide-big-'));
    const opened = await openGraph(join(bigDir, 'big.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    bigStore = opened.value;
    const imported = await importExtractionResults(bigStore, [{ nodes, edges }]);
    if (!imported.ok) throw new Error(`big seed import failed: ${imported.error.message}`);
    bigCtx = { vaultRoot: bigDir, manifest: FIXTURE_MANIFEST, graph: bigStore } as Context;
  });

  afterAll(async () => {
    await closeGraph(bigStore);
    rmSync(bigDir, { recursive: true, force: true });
  });

  it('the truncation sentence counts the rows actually SHIPPED, never `limit`', async () => {
    const r = await automationCollisionsHandler(bigCtx, { object: 'BigBoth__c', limit: 200 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // The byte budget, not `limit`, is the binding constraint here.
    expect(d.summary.collisionsTruncated).toBe(true);
    expect(d.collisions.length).toBeLessThan(BIG_FIELD_COUNT);
    const note = d.boundaries.find((b) => b.startsWith('Collisions truncated'));
    expect(note).toBeDefined();
    expect(note).toContain(`to ${d.collisions.length} of ${BIG_FIELD_COUNT}`);
    // "200 of 150" is not a number of shipped rows — it is the requested cap.
    expect(note).not.toContain('to 200 of');

    const cycleNote = d.boundaries.find((b) => b.startsWith('Cycles truncated'));
    expect(cycleNote).toBeDefined();
    expect(cycleNote).toContain(`to ${d.cycles.length} of ${d.summary.cyclesFound}`);
    expect(cycleNote).not.toContain('to 200 of');
  });

  it('a BYTE-trimmed page never tells the caller that raising `limit` returns more', async () => {
    const r = await automationCollisionsHandler(bigCtx, { object: 'BigBoth__c', limit: 200 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // 150 collisions were found and `limit` was 200: `limit` did not cut this
    // page, the byte budget did, so "raise `limit`" is advice that cannot work.
    expect(d.summary.fieldsWithMultipleWriters).toBeLessThan(200);
    const note = d.boundaries.find((b) => b.startsWith('Collisions truncated'));
    expect(note).toBeDefined();
    expect(note).not.toMatch(/raise `limit`/);
  });

  it('both lists share ONE byte budget, so the envelope never silently tail-trims the second', async () => {
    const r = await automationCollisionsHandler(bigCtx, { object: 'BigBoth__c', limit: 200 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const payloadBytes = Buffer.byteLength(JSON.stringify(r.value.data), 'utf8');
    // Pre-fix each list was paged against the FULL default 38 000-byte budget,
    // so the two together were ~76 KB inside one ~39 KB envelope: `jsonResult`
    // dropped the tail of `cycles` while `cyclesTruncated` and the boundary
    // count still described the untrimmed list.
    expect(payloadBytes).toBeLessThanOrEqual(responseReductionCap());
    // Both lists still ship something — a shared budget must not starve one.
    expect(r.value.data.collisions.length).toBeGreaterThan(0);
    expect(r.value.data.cycles.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// FLOW-RECORD-VARIABLE-DML-IS-AN-UNCERTIFIED-BLIND-SPOT
//
// A Flow that assigns fields into an SObject VARIABLE and then commits that
// variable with a bare `<inputReference>` (no `<inputAssignments>`) really does
// write those fields on the record. The extractor cannot enumerate them
// offline, so it emits ONE object-level `writesTo` edge and stamps it
// `wholeRecord: true` / `fieldsEnumerable: false` — the graph already says, in
// a typed property, "this firer writes fields here and I do not know which".
//
// This tool DROPPED that edge (`if (!toId.startsWith('CustomField:')) continue`)
// and then certified the opposite in prose: "Flow and WorkflowRule field writes
// are `parsed` from declared XML". A collision report is a "what will break"
// answer; a writer the report never saw is a last-writer-wins fight it says
// does not exist, and the same silence hides a self-write recursion cycle.
//
// The fix does NOT invent the missing field names — reconstructing them from
// `<assignToReference>` alone produces phantom writers (a variable assigned but
// never committed, or a variable typed to a DIFFERENT SObject). It makes the
// gap VISIBLE: a typed `unenumerableFieldWrites[]` row per unresolved write,
// `summary.fieldWriteCoverage: 'partial'`, and prose that withdraws the
// blanket `parsed` certification.
// =============================================================================
describe('automationCollisionsHandler — Flow record-variable DML (unenumerable field writes)', () => {
  it('lists the record-variable writer in a typed field instead of dropping it', async () => {
    const r = await automationCollisionsHandler(ctx, { object: 'WholeRec__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.unenumerableFieldWrites).toEqual([
      {
        automationId: 'Flow:WholeRecVarFlow',
        automationType: 'Flow',
        fromObject: 'WholeRec__c',
        toObject: 'WholeRec__c',
        onQueriedObject: true,
        operation: 'recordUpdate',
        inputReference: 'Var4Update',
        active: true,
        timing: 'after',
        collisionPath: 'save',
        confidence: 'declared',
      },
    ]);
  });

  it('downgrades the certification: coverage is `partial`, and zero collisions is NOT a checked zero', async () => {
    const r = await automationCollisionsHandler(ctx, { object: 'WholeRec__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Only one field-level writer on Status__c -> the collision list is empty.
    // Pre-fix that empty list shipped with a full `parsed`-confidence boundary
    // block: an UNCHECKED zero wearing a CHECKED zero's clothes.
    expect(r.value.data.collisions).toEqual([]);
    expect(r.value.data.summary.fieldWriteCoverage).toBe('partial');
    expect(r.value.data.summary.unenumerableFieldWriteCount).toBe(1);
  });

  it('says it in prose a host reads aloud, naming the typed key', async () => {
    const r = await automationCollisionsHandler(ctx, { object: 'WholeRec__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = r.value.data.boundaries.join(' ');
    expect(text).toMatch(/unenumerableFieldWrites/);
    expect(text).toMatch(/fieldsEnumerable/);
    expect(text).toMatch(/record-variable|record variable/i);
  });

  it('the blanket "Flow field writes are parsed from declared XML" claim is gone', async () => {
    const r = await automationCollisionsHandler(ctx, { object: 'Collide__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const confidenceBoundary = r.value.data.boundaries.find((b) =>
      b.startsWith('Confidence varies per writer'),
    );
    expect(confidenceBoundary).toBeDefined();
    // The carve-out must travel with the claim on EVERY object, not only on the
    // objects that happen to have an unenumerable write today: a host that read
    // the unqualified sentence once generalises it to every later answer.
    expect(confidenceBoundary).toMatch(/record-variable|record variable/i);
    expect(confidenceBoundary).toMatch(/not enumerable|NOT enumerable/i);
  });

  it('an object with no record-variable DML still reports complete coverage (no false alarm)', async () => {
    const r = await automationCollisionsHandler(ctx, { object: 'Collide__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.unenumerableFieldWrites).toEqual([]);
    expect(r.value.data.summary.fieldWriteCoverage).toBe('complete');
    expect(r.value.data.summary.unenumerableFieldWriteCount).toBe(0);
    const text = r.value.data.boundaries.join(' ');
    expect(text).not.toMatch(/1 write\(s\) on this object/);
  });

  it('a record-variable DELETE is not an unenumerable FIELD write (false-positive guard)', async () => {
    const r = await automationCollisionsHandler(ctx, { object: 'DeleteWholeRec__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Same `wholeRecord` / `fieldsEnumerable: false` markers, but a delete
    // assigns no fields — flagging it would manufacture a blind spot that does
    // not exist and train a reader to ignore the flag.
    expect(r.value.data.unenumerableFieldWrites).toEqual([]);
    expect(r.value.data.summary.fieldWriteCoverage).toBe('complete');
  });
});

// --- The external-writer sweep (AUTOMATION-COLLISIONS-CONFIDENT-ZERO-OVER-A-
// --- ONE-NINTH CORPUS) -----------------------------------------------------
//
// The measured defect, on a real org: a standard object with ONE record-
// triggered Flow wired to it came back `collisions: []`,
// `fieldsWithMultipleWriters: 0`, `collisionsTruncated: false`,
// `automationsScanned: 1` — while the graph held EIGHT fields on that object
// with 2-5 DISTINCT `writesTo` writers each, among them live Apex service
// classes and a Flow triggered on a DIFFERENT object. A sibling tool
// (`why_field_changed`) named all of them on the same vault in the same
// session. Nothing in the envelope published how many writers the
// `triggersOn`-only scan had excluded, and `collisionsTruncated: false` read
// as "nothing was cut".
//
// Fixture shape, deliberately the real one:
//   ExtWrite__c   — ONE own after-save Flow (the whole scanned corpus), plus
//                   FOUR components that write its fields without triggering
//                   on it: a service class, a Flow triggered on another
//                   object, a TEST class, and a DRAFT flow.
//   CleanScan__c  — two own Flows that collide, and NO outside writer: the
//                   sweep must report a CHECKED zero, not silence.
//
// The field ids here deliberately have NO `CustomField` node of their own —
// 20% of this shape's real `writesTo` edges point at unvaulted fields, so a
// sweep that enumerated the object's field NODES would have found nothing and
// called it clean.
describe('automationCollisionsHandler — external writers outside the triggersOn scan', () => {
  let extDir: string;
  let extStore: GraphStore;
  let extCtx: Context;

  beforeAll(async () => {
    const nodes: Node[] = [
      node('CustomObject:ExtWrite__c', 'CustomObject'),
      node('CustomObject:OtherSrc__c', 'CustomObject'),
      // The ONE automation wired via triggersOn on the queried object.
      node('Flow:OwnAfterFlow', 'Flow', { status: 'Active' }),
      // Four writers that never trigger on it.
      // No `status` at all -> activation must read `'not-modeled'`, never a
      // defaulted `true` from the shared SOE predicate.
      node('ApexClass:WriterService', 'ApexClass', { isTest: false }),
      node('ApexClass:WriterServiceTest', 'ApexClass', { isTest: true }),
      // The REAL-vault ApexClass shape: the extractor DOES emit `status`, so
      // this one has a checked activation.
      node('ApexClass:StatusCarryingWriter', 'ApexClass', { isTest: false, status: 'Active' }),
      node('ApexClass:RetiredWriter', 'ApexClass', { isTest: false, status: 'Deleted' }),
      node('Flow:OtherObjectFlow', 'Flow', { status: 'Active' }),
      node('Flow:DraftExternalFlow', 'Flow', { status: 'Draft' }),
      // A control object whose only writers ARE its own scanned automation.
      node('CustomObject:CleanScan__c', 'CustomObject'),
      node('Flow:CleanFlowA', 'Flow', { status: 'Active' }),
      node('Flow:CleanFlowB', 'Flow', { status: 'Active' }),
    ];
    const edges: Edge[] = [
      edge('Flow:OwnAfterFlow', 'CustomObject:ExtWrite__c', 'triggersOn', 'declared', {
        recordTriggerType: 'Update',
        triggerType: 'RecordAfterSave',
      }),
      edge('Flow:OwnAfterFlow', 'CustomField:ExtWrite__c.Shared__c', 'writesTo', 'parsed', {
        operation: 'recordUpdate',
      }),
      // Outside writers on the SAME field the scanned Flow writes.
      edge('ApexClass:WriterService', 'CustomField:ExtWrite__c.Shared__c', 'writesTo', 'heuristic', {
        offset: 1,
        length: 4,
      }),
      edge('Flow:OtherObjectFlow', 'CustomObject:OtherSrc__c', 'triggersOn', 'declared', {
        recordTriggerType: 'Update',
        triggerType: 'RecordAfterSave',
      }),
      edge('Flow:OtherObjectFlow', 'CustomField:ExtWrite__c.Shared__c', 'writesTo', 'parsed', {
        operation: 'recordUpdate',
      }),
      // Outside writers on a field NO scanned automation touches at all.
      edge(
        'ApexClass:WriterServiceTest',
        'CustomField:ExtWrite__c.Only__c',
        'writesTo',
        'heuristic',
        { offset: 2, length: 4 },
      ),
      edge('Flow:DraftExternalFlow', 'CustomObject:OtherSrc__c', 'triggersOn', 'declared', {
        recordTriggerType: 'Update',
        triggerType: 'RecordAfterSave',
      }),
      edge('Flow:DraftExternalFlow', 'CustomField:ExtWrite__c.Only__c', 'writesTo', 'parsed', {
        operation: 'recordUpdate',
      }),
      edge(
        'ApexClass:StatusCarryingWriter',
        'CustomField:ExtWrite__c.Only__c',
        'writesTo',
        'parsed',
        { path: 'ExtWrite__c.Only__c' },
      ),
      edge(
        'ApexClass:RetiredWriter',
        'CustomField:ExtWrite__c.Only__c',
        'writesTo',
        'parsed',
        { path: 'ExtWrite__c.Only__c' },
      ),
      // Control: two scanned flows collide, nothing writes from outside.
      edge('Flow:CleanFlowA', 'CustomObject:CleanScan__c', 'triggersOn', 'declared', {
        recordTriggerType: 'Update',
        triggerType: 'RecordAfterSave',
      }),
      edge('Flow:CleanFlowB', 'CustomObject:CleanScan__c', 'triggersOn', 'declared', {
        recordTriggerType: 'Update',
        triggerType: 'RecordAfterSave',
      }),
      edge('Flow:CleanFlowA', 'CustomField:CleanScan__c.Status__c', 'writesTo', 'parsed', {
        operation: 'recordUpdate',
      }),
      edge('Flow:CleanFlowB', 'CustomField:CleanScan__c.Status__c', 'writesTo', 'parsed', {
        operation: 'recordUpdate',
      }),
    ];
    extDir = mkdtempSync(join(tmpdir(), 'sfi-collide-ext-'));
    const opened = await openGraph(join(extDir, 'ext.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    extStore = opened.value;
    const imported = await importExtractionResults(extStore, [{ nodes, edges }]);
    if (!imported.ok) throw new Error(`ext seed import failed: ${imported.error.message}`);
    extCtx = { vaultRoot: extDir, manifest: FIXTURE_MANIFEST, graph: extStore } as Context;
  });

  afterAll(async () => {
    await closeGraph(extStore);
    rmSync(extDir, { recursive: true, force: true });
  });

  it('FAIL-BEFORE: a one-automation object publishes the writers its scan excluded', async () => {
    const r = await automationCollisionsHandler(extCtx, { object: 'ExtWrite__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // The pre-fix shape, unchanged and still honest about ITS subset.
    expect(d.summary.automationsScanned).toBe(1);
    expect(d.collisions).toEqual([]);
    expect(d.summary.fieldsWithMultipleWriters).toBe(0);
    // The gap the pre-fix envelope never published anywhere.
    expect(d.summary.externalWriterCount).toBe(6);
    expect(d.summary.fieldsWithExternalWriters).toBe(2);
    expect(d.summary.fieldsWithMultipleWritersAnySource).toBe(2);
    expect(d.summary.externalWriterSweepComplete).toBe(true);
    const shared = d.externalWriters.find((f) => f.fieldApiName === 'Shared__c');
    expect(shared).toBeDefined();
    expect(shared?.totalWriterCount).toBe(3);
    expect(shared?.scannedWriterCount).toBe(1);
    expect(shared?.writers.map((w) => w.componentId).sort()).toEqual([
      'ApexClass:WriterService',
      'Flow:OtherObjectFlow',
    ]);
  });

  it('R3: the object’s OWN scanned automation is never listed as an external writer', async () => {
    const r = await automationCollisionsHandler(extCtx, { object: 'ExtWrite__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const everyWriter = r.value.data.externalWriters.flatMap((f) =>
      f.writers.map((w) => w.componentId),
    );
    expect(everyWriter).not.toContain('Flow:OwnAfterFlow');
  });

  it('an external writer carries activation and test-only status, never a defaulted true', async () => {
    const r = await automationCollisionsHandler(extCtx, { object: 'ExtWrite__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const only = r.value.data.externalWriters.find((f) => f.fieldApiName === 'Only__c');
    expect(only).toBeDefined();
    const byId = new Map(only?.writers.map((w) => [w.componentId, w]) ?? []);
    // An ApexClass has no activation flag at all — it must not read `active: true`.
    expect(byId.get('ApexClass:WriterServiceTest')?.activation).toBe('not-modeled');
    expect(byId.get('ApexClass:WriterServiceTest')?.testOnly).toBe(true);
    // A Draft flow is inactive, and a live one is active.
    expect(byId.get('Flow:DraftExternalFlow')?.activation).toBe('inactive');
    expect(byId.get('Flow:DraftExternalFlow')?.testOnly).toBe(false);
    // A class the vault DOES stamp with a status reads that status, not a default.
    expect(byId.get('ApexClass:StatusCarryingWriter')?.activation).toBe('active');
    expect(byId.get('ApexClass:RetiredWriter')?.activation).toBe('inactive');
    const shared = r.value.data.externalWriters.find((f) => f.fieldApiName === 'Shared__c');
    const otherFlow = shared?.writers.find((w) => w.componentId === 'Flow:OtherObjectFlow');
    expect(otherFlow?.activation).toBe('active');
    expect(otherFlow?.componentType).toBe('Flow');
  });

  it('the excluded writers are stated in prose a host reads aloud, with the subset caveat', async () => {
    const r = await automationCollisionsHandler(extCtx, { object: 'ExtWrite__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = r.value.data.boundaries.join(' ');
    expect(text).toContain('externalWriters');
    expect(text).toContain('6 component');
    // `fieldsWithMultipleWriters` must be framed as a property of the SCANNED
    // subset, not of the object.
    expect(text).toContain('fieldsWithMultipleWriters');
    expect(text).toMatch(/scanned subset/i);
    // `collisionsTruncated: false` must stop reading as "nothing was cut".
    expect(text).toContain('collisionsTruncated');
  });

  it('the static scan-scope boundary names EVERY-OTHER-OBJECT, not just the two narrow cases', async () => {
    const r = await automationCollisionsHandler(extCtx, { object: 'ExtWrite__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const scope = r.value.data.boundaries.find((b) => b.includes('SCAN SCOPE'));
    expect(scope).toBeDefined();
    // The pre-fix sentence enumerated only ApprovalProcess field updates and a
    // helper class the trigger calls — a NARROWER exclusion than the truth.
    expect(scope).toMatch(/DIFFERENT object/i);
    expect(scope).toMatch(/ApprovalProcess/);
  });

  it('a genuinely clean object gets a CHECKED zero, not silence', async () => {
    const r = await automationCollisionsHandler(extCtx, { object: 'CleanScan__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.summary.fieldsWithMultipleWriters).toBe(1); // its own two flows still collide
    expect(d.summary.externalWriterCount).toBe(0);
    expect(d.summary.fieldsWithExternalWriters).toBe(0);
    expect(d.summary.fieldsWithMultipleWritersAnySource).toBe(1);
    expect(d.externalWriters).toEqual([]);
    expect(d.summary.externalWriterSweepComplete).toBe(true);
    const text = d.boundaries.join(' ');
    expect(text).toMatch(/CHECKED zero/);
    // …and it must not invent excluded writers that do not exist.
    expect(text).not.toContain('0 component');
  });

  it('drift guard: activation matches the shared `isActiveSoeFirer` on every type it models', async () => {
    // R6: the tool reads the activation property the NODE CARRIES rather than
    // calling the shared predicate, because that predicate answers `true` for
    // every type it does not model (an ApexClass would print a defaulted
    // `active`). This pins that the two still agree everywhere it DOES model —
    // if `soe-active.ts` changes its verdict for one of these shapes, this
    // fails instead of the two drifting apart in silence.
    const modeled: readonly (readonly [Node, 'active' | 'inactive'])[] = [
      [node('Flow:DriftActive', 'Flow', { status: 'Active' }), 'active'],
      [node('Flow:DriftDraft', 'Flow', { status: 'Draft' }), 'inactive'],
      [node('Flow:DriftObsolete', 'Flow', { status: 'Obsolete' }), 'inactive'],
      [node('ApexTrigger:DriftActive', 'ApexTrigger', { status: 'Active' }), 'active'],
      [node('ApexTrigger:DriftOff', 'ApexTrigger', { status: 'Inactive' }), 'inactive'],
      [node('WorkflowRule:DriftOn', 'WorkflowRule', { active: true }), 'active'],
      [node('WorkflowRule:DriftOff', 'WorkflowRule', { active: false }), 'inactive'],
      [node('ApprovalProcess:DriftOn', 'ApprovalProcess', { active: true }), 'active'],
      [node('DuplicateRule:DriftOff', 'DuplicateRule', { isActive: false }), 'inactive'],
    ];
    for (const [n, expected] of modeled) {
      expect(
        isActiveSoeFirer(n) ? 'active' : 'inactive',
        `${n.id} disagrees with the tool's activation verdict`,
      ).toBe(expected);
    }
    // …and the divergence that is DELIBERATE: the shared predicate defaults an
    // unmodeled type to active; this tool must publish `not-modeled` instead.
    const bareClass = node('ApexClass:DriftNoStatus', 'ApexClass', { isTest: false });
    expect(isActiveSoeFirer(bareClass)).toBe(true);
    const r = await automationCollisionsHandler(extCtx, { object: 'ExtWrite__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bare = r.value.data.externalWriters
      .flatMap((f) => f.writers)
      .find((w) => w.componentId === 'ApexClass:WriterService');
    expect(bare?.activation).toBe('not-modeled');
  });

  it('R4: a REAL object typed in the wrong case sweeps the same writers', async () => {
    const wrongCase = await automationCollisionsHandler(extCtx, { object: 'extwrite__C' });
    const canonical = await automationCollisionsHandler(extCtx, { object: 'ExtWrite__c' });
    expect(wrongCase.ok && canonical.ok).toBe(true);
    if (!wrongCase.ok || !canonical.ok) return;
    expect(wrongCase.value.data.externalWriters).toEqual(canonical.value.data.externalWriters);
    expect(wrongCase.value.data.summary.externalWriterCount).toBe(6);
  });
});

// --- R2: the external-writer list travels in the SAME envelope ---------------
//
// A third disclosure list paged against its own full budget is the defect the
// two-list fix already had to close once. This vault gives ONE object 150
// fields, each written by an outside class, so `externalWriters` alone would
// overflow the envelope if it were not paged off the shared budget.
describe('automationCollisionsHandler — external writers share the ONE byte budget (R2)', () => {
  const BIG_EXT_FIELDS = 150;
  let bigExtDir: string;
  let bigExtStore: GraphStore;
  let bigExtCtx: Context;

  beforeAll(async () => {
    const nodes: Node[] = [
      node('CustomObject:BigExt__c', 'CustomObject'),
      node('Flow:BigExtOwnFlow', 'Flow', { status: 'Active' }),
      node('ApexClass:BigExtWriter', 'ApexClass', { isTest: false, status: 'Active' }),
    ];
    const edges: Edge[] = [
      edge('Flow:BigExtOwnFlow', 'CustomObject:BigExt__c', 'triggersOn', 'declared', {
        recordTriggerType: 'Update',
        triggerType: 'RecordAfterSave',
      }),
    ];
    for (let i = 0; i < BIG_EXT_FIELDS; i += 1) {
      edges.push(
        edge(
          'ApexClass:BigExtWriter',
          `CustomField:BigExt__c.Field${String(i).padStart(3, '0')}__c`,
          'writesTo',
          'parsed',
          { path: 'BigExt__c' },
        ),
      );
    }
    bigExtDir = mkdtempSync(join(tmpdir(), 'sfi-collide-bigext-'));
    const opened = await openGraph(join(bigExtDir, 'bigext.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    bigExtStore = opened.value;
    const imported = await importExtractionResults(bigExtStore, [{ nodes, edges }]);
    if (!imported.ok) throw new Error(`big ext seed import failed: ${imported.error.message}`);
    bigExtCtx = { vaultRoot: bigExtDir, manifest: FIXTURE_MANIFEST, graph: bigExtStore } as Context;
  });

  afterAll(async () => {
    await closeGraph(bigExtStore);
    rmSync(bigExtDir, { recursive: true, force: true });
  });

  it('a fat external-writer list is truncated INSIDE the envelope and says so', async () => {
    const r = await automationCollisionsHandler(bigExtCtx, { object: 'BigExt__c', limit: 200 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(Buffer.byteLength(JSON.stringify(d), 'utf8')).toBeLessThanOrEqual(responseReductionCap());
    // The counts are of the WHOLE sweep, not of the shipped page…
    expect(d.summary.fieldsWithExternalWriters).toBe(BIG_EXT_FIELDS);
    expect(d.summary.externalWriterCount).toBe(1); // 150 fields, ONE outside writer
    expect(d.summary.externalWriterSweepComplete).toBe(true);
    // …and the page that WAS shipped is disclosed as cut.
    expect(d.externalWriters.length).toBeLessThan(BIG_EXT_FIELDS);
    expect(d.summary.externalWritersTruncated).toBe(true);
    const note = d.boundaries.find((b) => b.startsWith('External writers truncated'));
    expect(note).toBeDefined();
    expect(note).toContain(`to ${d.externalWriters.length} of ${BIG_EXT_FIELDS}`);
  });
});

// --- A sweep the query ceiling CUT must not report a checked zero -----------
//
// The sweep reads at most QUERY_GRAPH_MAX_LIMIT (500) `writesTo` edges per
// call and gets an EXACT total beside them. This vault gives one object 520
// such edges, ALL of them from its own scanned Flow — so the sweep finds no
// outside writer AND could not finish. Publishing "this zero is a CHECKED
// zero" there would be the same defect one layer down.
describe('automationCollisionsHandler — a CUT external sweep never claims a checked zero', () => {
  const OVER_CEILING_FIELDS = 520;
  let cutDir: string;
  let cutStore: GraphStore;
  let cutCtx: Context;

  beforeAll(async () => {
    const nodes: Node[] = [
      node('CustomObject:Ceiling__c', 'CustomObject'),
      node('Flow:CeilingOwnFlow', 'Flow', { status: 'Active' }),
    ];
    const edges: Edge[] = [
      edge('Flow:CeilingOwnFlow', 'CustomObject:Ceiling__c', 'triggersOn', 'declared', {
        recordTriggerType: 'Update',
        triggerType: 'RecordBeforeSave',
      }),
    ];
    for (let i = 0; i < OVER_CEILING_FIELDS; i += 1) {
      edges.push(
        edge(
          'Flow:CeilingOwnFlow',
          `CustomField:Ceiling__c.Field${String(i).padStart(3, '0')}__c`,
          'writesTo',
          'parsed',
          { operation: 'recordUpdate' },
        ),
      );
    }
    cutDir = mkdtempSync(join(tmpdir(), 'sfi-collide-cut-'));
    const opened = await openGraph(join(cutDir, 'cut.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    cutStore = opened.value;
    const imported = await importExtractionResults(cutStore, [{ nodes, edges }]);
    if (!imported.ok) throw new Error(`cut seed import failed: ${imported.error.message}`);
    cutCtx = { vaultRoot: cutDir, manifest: FIXTURE_MANIFEST, graph: cutStore } as Context;
  });

  afterAll(async () => {
    await closeGraph(cutStore);
    rmSync(cutDir, { recursive: true, force: true });
  });

  it('reports the cut in a typed field and refuses the CHECKED-zero sentence', async () => {
    const r = await automationCollisionsHandler(cutCtx, { object: 'Ceiling__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.summary.externalWriterCount).toBe(0);
    expect(d.summary.externalWriterSweepComplete).toBe(false);
    const text = d.boundaries.join(' ');
    expect(text).not.toMatch(/CHECKED zero/);
    expect(text).toMatch(/FLOORS, not totals/);
    expect(text).toMatch(/NOT a checked zero/);
  });
});
