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
  automationBuildAdvisorHandler,
  automationBuildAdvisorInputSchema,
} from '../../src/tools/automation-build-advisor.js';

import { measureGraphQueries } from './_graph-query-budget.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-29T00:00:00Z',
  sourceOrg: 'test',
  components: { CustomObject: 2 },
  edges: { triggersOn: 3 },
  sourceTreeHash: 'sha256:fixture',
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

const edge = (fromId: string, toId: string, edgeType: Edge['edgeType'], props: Record<string, unknown> = {}): Edge => ({
  fromId,
  toId,
  edgeType,
  confidence: 'declared',
  source: 'unit-test',
  properties: props,
});

// Busy__c: 2 active record-triggered Flows + 1 ApexTrigger → ordering + mixed risks.
// Quiet__c: nothing → greenfield.
// Case: a STANDARD object — its definition file omits <type>, so no CustomObject
//   node is materialized, yet automation targets it and it parents a rule. It IS
//   effectively modeled (node-present-OR-has-edges), not a phantom.
const seed: ExtractionResult = {
  nodes: [
    node('CustomObject:Busy__c', 'CustomObject'),
    node('CustomObject:Quiet__c', 'CustomObject'),
    node('Flow:FlowA', 'Flow', { status: 'Active' }),
    node('Flow:FlowB', 'Flow', { status: 'Active' }),
    node('ApexTrigger:BusyTrigger', 'ApexTrigger', { status: 'Active' }),
    // Standard object Case: no CustomObject node (standard objects omit <type>).
    node('Flow:CaseAfterSave', 'Flow', { status: 'Active' }),
    node('ValidationRule:Case.CaseRule', 'ValidationRule', { active: true }),
  ],
  edges: [
    edge('Flow:FlowA', 'CustomObject:Busy__c', 'triggersOn', { recordTriggerType: 'Update' }),
    edge('Flow:FlowB', 'CustomObject:Busy__c', 'triggersOn', { recordTriggerType: 'Update' }),
    edge('ApexTrigger:BusyTrigger', 'CustomObject:Busy__c', 'triggersOn', {}),
    edge('Flow:CaseAfterSave', 'CustomObject:Case', 'triggersOn', { recordTriggerType: 'Update' }),
    edge('CustomObject:Case', 'ValidationRule:Case.CaseRule', 'parentOf', {}),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-adv-'));
  const opened = await openGraph(join(tempDir, 'adv.db'));
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

describe('automationBuildAdvisorHandler', () => {
  it('lists existing automation and flags ordering + mixed-paradigm risks', async () => {
    const r = await automationBuildAdvisorHandler(ctx, { objectApiName: 'Busy__c' });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'per-object') return;
    const d = r.value.data;
    expect(d.existingAutomation.recordTriggeredFlows).toHaveLength(2);
    expect(d.existingAutomation.apexTriggers).toHaveLength(1);
    const kinds = d.risks.map((x) => x.kind);
    expect(kinds).toContain('flow-ordering');
    expect(kinds).toContain('mixed-trigger-and-flow');
    expect(d.recommendations.length).toBeGreaterThan(0);
  });

  it('reports greenfield for an object with no automation', async () => {
    const r = await automationBuildAdvisorHandler(ctx, { objectApiName: 'Quiet__c' });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'per-object') return;
    expect(r.value.data.risks.map((x) => x.kind)).toEqual(['greenfield']);
  });

  it('answers (objectModeled=false) even when the object is a genuine phantom (no node, no edges)', async () => {
    const r = await automationBuildAdvisorHandler(ctx, { objectApiName: 'NotInVault__c' });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'per-object') return;
    expect(r.value.data.objectModeled).toBe(false);
  });

  it('treats a standard object (no CustomObject node, but automation + parented rules) as modeled', async () => {
    // Case omits <type>, so no CustomObject node exists, but a record-triggered
    // Flow targets it and it parents a validation rule → it IS modeled, not a
    // phantom. Co-fire analysis on Case must be grounded.
    const r = await automationBuildAdvisorHandler(ctx, { objectApiName: 'Case' });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'per-object') return;
    expect(r.value.data.objectModeled).toBe(true);
    expect(r.value.data.existingAutomation.recordTriggeredFlows).toHaveLength(1);
    expect(r.value.data.existingAutomation.validationRules).toHaveLength(1);
  });
});

describe('automationBuildAdvisorInputSchema', () => {
  it('accepts per-object OR org-wide scope, but not both/neither', () => {
    expect(automationBuildAdvisorInputSchema.safeParse({}).success).toBe(false);
    expect(automationBuildAdvisorInputSchema.safeParse({ objectApiName: 'Account' }).success).toBe(true);
    expect(automationBuildAdvisorInputSchema.safeParse({ scope: 'flow-only-objects' }).success).toBe(true);
    // Exactly one — supplying both is rejected.
    expect(
      automationBuildAdvisorInputSchema.safeParse({
        objectApiName: 'Account',
        scope: 'flow-only-objects',
      }).success,
    ).toBe(false);
    // Unknown scope literal is rejected.
    expect(automationBuildAdvisorInputSchema.safeParse({ scope: 'everything' }).success).toBe(false);
  });
});

// --- Org-wide flow-only-objects gap analytic ---------------------------------
//
// Fixture exercises the set difference and the master-detail role annotation:
//   FlowOnly__c        : active record-triggered Flow, NO Apex trigger, MD child
//                        of Account  → flow-only, master-detail-child.
//   FlowOnlyChild__c   : active record-triggered Flow, NO trigger, MD child of
//                        Contact     → flow-only, master-detail-child.
//   Junction__c        : active record-triggered Flow, NO trigger, TWO MD
//                        parents      → flow-only, junction.
//   Standalone__c      : active record-triggered Flow, NO trigger, only a
//                        LOOKUP (not MD) → flow-only, lookup-only.
//   Guarded__c         : active record-triggered Flow AND an active Apex
//                        trigger      → EXCLUDED (has a trigger guard).
//   NS__Managed__c     : active record-triggered Flow, no trigger, but
//                        namespaced  → EXCLUDED (managed package).
//   Account / Contact  : record-triggered Flow but STANDARD object → EXCLUDED.
//   ScreenOnly__c      : an autolaunched/screen Flow targets it (no
//                        recordTriggerType on the edge) → EXCLUDED.
//   InactiveFlow__c    : its only record-triggered Flow is Draft (inactive) →
//                        EXCLUDED.
const gapSeed: ExtractionResult = {
  nodes: [
    node('CustomObject:FlowOnly__c', 'CustomObject'),
    node('CustomObject:FlowOnlyChild__c', 'CustomObject'),
    node('CustomObject:Junction__c', 'CustomObject'),
    node('CustomObject:Standalone__c', 'CustomObject'),
    node('CustomObject:Guarded__c', 'CustomObject'),
    node('CustomObject:NS__Managed__c', 'CustomObject'),
    node('CustomObject:ScreenOnly__c', 'CustomObject'),
    node('CustomObject:InactiveFlow__c', 'CustomObject'),
    // MD parents.
    node('CustomObject:Account', 'CustomObject'),
    node('CustomObject:Contact', 'CustomObject'),
    // Flows.
    node('Flow:GF_FlowOnly', 'Flow', { status: 'Active' }),
    node('Flow:GF_FlowOnlyChild', 'Flow', { status: 'Active' }),
    node('Flow:GF_Junction', 'Flow', { status: 'Active' }),
    node('Flow:GF_Standalone', 'Flow', { status: 'Active' }),
    node('Flow:GF_Guarded', 'Flow', { status: 'Active' }),
    node('Flow:GF_Managed', 'Flow', { status: 'Active' }),
    node('Flow:GF_Standard', 'Flow', { status: 'Active' }),
    node('Flow:GF_Screen', 'Flow', { status: 'Active' }),
    node('Flow:GF_Inactive', 'Flow', { status: 'Draft' }),
    // Apex trigger guarding Guarded__c.
    node('ApexTrigger:GuardedTrigger', 'ApexTrigger', { status: 'Active' }),
    // Master-detail / lookup fields.
    node('CustomField:FlowOnly__c.Acct__c', 'CustomField'),
    node('CustomField:FlowOnlyChild__c.Con__c', 'CustomField'),
    node('CustomField:Junction__c.Acct__c', 'CustomField'),
    node('CustomField:Junction__c.Con__c', 'CustomField'),
    node('CustomField:Standalone__c.AcctLk__c', 'CustomField'),
  ],
  edges: [
    // Record-triggered Flows (edge carries recordTriggerType).
    edge('Flow:GF_FlowOnly', 'CustomObject:FlowOnly__c', 'triggersOn', { recordTriggerType: 'Create' }),
    edge('Flow:GF_FlowOnlyChild', 'CustomObject:FlowOnlyChild__c', 'triggersOn', { recordTriggerType: 'Update' }),
    edge('Flow:GF_Junction', 'CustomObject:Junction__c', 'triggersOn', { recordTriggerType: 'Create' }),
    edge('Flow:GF_Standalone', 'CustomObject:Standalone__c', 'triggersOn', { recordTriggerType: 'Update' }),
    edge('Flow:GF_Guarded', 'CustomObject:Guarded__c', 'triggersOn', { recordTriggerType: 'Create' }),
    edge('Flow:GF_Managed', 'CustomObject:NS__Managed__c', 'triggersOn', { recordTriggerType: 'Create' }),
    edge('Flow:GF_Standard', 'CustomObject:Account', 'triggersOn', { recordTriggerType: 'Update' }),
    edge('Flow:GF_Inactive', 'CustomObject:InactiveFlow__c', 'triggersOn', { recordTriggerType: 'Create' }),
    // Screen/autolaunched Flow — NO recordTriggerType → not record-triggered.
    edge('Flow:GF_Screen', 'CustomObject:ScreenOnly__c', 'triggersOn', {}),
    // Apex trigger guard.
    edge('ApexTrigger:GuardedTrigger', 'CustomObject:Guarded__c', 'triggersOn', {}),
    // parentOf field edges.
    edge('CustomObject:FlowOnly__c', 'CustomField:FlowOnly__c.Acct__c', 'parentOf', {}),
    edge('CustomObject:FlowOnlyChild__c', 'CustomField:FlowOnlyChild__c.Con__c', 'parentOf', {}),
    edge('CustomObject:Junction__c', 'CustomField:Junction__c.Acct__c', 'parentOf', {}),
    edge('CustomObject:Junction__c', 'CustomField:Junction__c.Con__c', 'parentOf', {}),
    edge('CustomObject:Standalone__c', 'CustomField:Standalone__c.AcctLk__c', 'parentOf', {}),
    // lookupTo edges: MD vs plain Lookup.
    edge('CustomField:FlowOnly__c.Acct__c', 'CustomObject:Account', 'lookupTo', { relationshipType: 'MasterDetail' }),
    edge('CustomField:FlowOnlyChild__c.Con__c', 'CustomObject:Contact', 'lookupTo', { relationshipType: 'MasterDetail' }),
    edge('CustomField:Junction__c.Acct__c', 'CustomObject:Account', 'lookupTo', { relationshipType: 'MasterDetail' }),
    edge('CustomField:Junction__c.Con__c', 'CustomObject:Contact', 'lookupTo', { relationshipType: 'MasterDetail' }),
    edge('CustomField:Standalone__c.AcctLk__c', 'CustomObject:Account', 'lookupTo', { relationshipType: 'Lookup' }),
  ],
};

describe('automationBuildAdvisorHandler — flow-only-objects (org-wide gap)', () => {
  let gapDir: string;
  let gapStore: GraphStore;
  let gapCtx: Context;

  beforeAll(async () => {
    gapDir = mkdtempSync(join(tmpdir(), 'sfi-adv-gap-'));
    const opened = await openGraph(join(gapDir, 'gap.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    gapStore = opened.value;
    const imported = await importExtractionResults(gapStore, [gapSeed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    gapCtx = { vaultRoot: gapDir, manifest: FIXTURE_MANIFEST, graph: gapStore } as Context;
  });

  afterAll(async () => {
    await closeGraph(gapStore);
    rmSync(gapDir, { recursive: true, force: true });
  });

  it('computes the trigger-minus-flow set difference, excluding standard/managed/guarded/screen/inactive', async () => {
    const r = await automationBuildAdvisorHandler(gapCtx, { scope: 'flow-only-objects' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.mode).toBe('flow-only-objects');
    if (d.mode !== 'flow-only-objects') return;
    const names = d.flowOnlyObjects.map((o) => o.apiName);
    // Included: the four org-custom flow-only objects.
    expect(names).toEqual(['FlowOnly__c', 'FlowOnlyChild__c', 'Junction__c', 'Standalone__c'].sort());
    // Excluded: guarded (has trigger), managed, standard, screen-only, inactive-flow.
    expect(names).not.toContain('Guarded__c');
    expect(names).not.toContain('NS__Managed__c');
    expect(names).not.toContain('Account');
    expect(names).not.toContain('ScreenOnly__c');
    expect(names).not.toContain('InactiveFlow__c');
  });

  it('annotates master-detail child / junction / lookup-only relationship roles', async () => {
    const r = await automationBuildAdvisorHandler(gapCtx, { scope: 'flow-only-objects' });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'flow-only-objects') return;
    const d = r.value.data;
    const byName = new Map(d.flowOnlyObjects.map((o) => [o.apiName, o]));

    expect(byName.get('FlowOnly__c')?.relationshipRole).toBe('master-detail-child');
    expect(byName.get('FlowOnly__c')?.masterDetailParents).toEqual(['CustomObject:Account']);

    expect(byName.get('FlowOnlyChild__c')?.relationshipRole).toBe('master-detail-child');
    expect(byName.get('FlowOnlyChild__c')?.masterDetailParents).toEqual(['CustomObject:Contact']);

    expect(byName.get('Junction__c')?.relationshipRole).toBe('junction');
    expect(byName.get('Junction__c')?.masterDetailParents).toEqual([
      'CustomObject:Account',
      'CustomObject:Contact',
    ]);

    // Plain lookup (not master-detail) → lookup-only, no MD parent.
    expect(byName.get('Standalone__c')?.relationshipRole).toBe('lookup-only');
    expect(byName.get('Standalone__c')?.masterDetailParents).toEqual([]);

    // Summary tallies: 4 org-custom, 2 MD children, 1 junction.
    expect(d.summary.orgCustomCount).toBe(4);
    expect(d.summary.masterDetailChildCount).toBe(2);
    expect(d.summary.junctionCount).toBe(1);
  });
});

// =============================================================================
// N+1 query budget (finding C-1). perObjectHandler resolved incoming
// triggersOn sources and parented ValidationRules with `getNodeById` per edge;
// both are now single `listNodesByIds` batches. The count must NOT scale with
// the object's automation/child fan-out. (The org-wide flow-only-objects path
// was already batched in 299a460.)
// =============================================================================
describe('automationBuildAdvisorHandler — bounded graph queries (perObject)', () => {
  const seedWideObject = async (fanOut: number) => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-aba-budget-'));
    const opened = await openGraph(join(dir, 'aba.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    const s = opened.value;
    // `fanOut` incoming triggersOn Flows AND `fanOut` parented ValidationRules,
    // so both batched loops range over a wide fan-out.
    const nodes: Node[] = [node('CustomObject:Wide__c', 'CustomObject')];
    const edges: Edge[] = [];
    for (let i = 0; i < fanOut; i += 1) {
      nodes.push(node(`Flow:WideFlow${i}`, 'Flow', { status: 'Active' }));
      edges.push(edge(`Flow:WideFlow${i}`, 'CustomObject:Wide__c', 'triggersOn', { recordTriggerType: 'Update' }));
      nodes.push(node(`ValidationRule:Wide__c.Rule${i}`, 'ValidationRule', { active: true }));
      edges.push(edge('CustomObject:Wide__c', `ValidationRule:Wide__c.Rule${i}`, 'parentOf', {}));
    }
    const imported = await importExtractionResults(s, [{ nodes, edges }]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    const wideCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s } as Context;
    const measured = await measureGraphQueries(s, () =>
      automationBuildAdvisorHandler(wideCtx, { objectApiName: 'Wide__c' }),
    );
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });
    return measured;
  };

  it('issues a query count independent of automation/child fan-out', async () => {
    const small = await seedWideObject(60);
    const large = await seedWideObject(200);
    expect(small.result.ok).toBe(true);
    expect(large.result.ok).toBe(true);
    // Exactly two edge fetches (incoming triggersOn + outgoing parentOf), flat.
    expect(small.edgeQueries).toBe(2);
    expect(large.edgeQueries).toBe(2);
    // Node fetches: one object probe + one batch per non-empty fan-out — a
    // small constant, NOT one per edge. Equal at N=60 and N=200.
    expect(large.nodeQueries).toBe(small.nodeQueries);
    expect(large.nodeQueries).toBeLessThanOrEqual(4);
  });
});
