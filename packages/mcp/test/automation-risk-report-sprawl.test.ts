/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../src/server.js';
import { automationRiskReportHandler } from '../src/tools/synthesis-reports.js';

// AUTOMATION-SPRAWL-MODE — a synthetic org proving (a) the default/absent mode
// is byte-identical to the pre-change risk report, (b) mode:'sprawl' ranks a
// denser object above a lighter one, and (c) the score weights + candidate
// framing are disclosed. Synthetic placeholder objects only — no real org names.

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-29T00:00:00.000Z',
  sourceOrg: 'sprawl-test',
  components: { CustomObject: 3 },
  edges: { triggersOn: 5 },
  sourceTreeHash: 'sha256:sprawl-fixture',
  coverageComputedAt: '2026-05-29T00:00:00.000Z',
  coverage: [
    { type: 'CustomObject', requested: true, retrieved: 3, errored: false, neverModeled: false },
    { type: 'Flow', requested: true, retrieved: 3, errored: false, neverModeled: false },
    { type: 'ApexTrigger', requested: true, retrieved: 1, errored: false, neverModeled: false },
    { type: 'WorkflowRule', requested: true, retrieved: 1, errored: false, neverModeled: false },
  ],
};

const makeNode = (o: Partial<Node> & Pick<Node, 'id' | 'type'>): Node => ({
  apiName: (o.id.split(':')[1] ?? o.id) as string,
  label: null,
  parentId: null,
  sourcePath: 'x',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

const triggersOn = (fromId: string, toId: string, properties = {}): Edge => ({
  fromId,
  toId,
  edgeType: 'triggersOn',
  confidence: 'declared',
  source: 'unit-test',
  properties,
});

const writesTo = (fromId: string, toId: string): Edge => ({
  fromId,
  toId,
  edgeType: 'writesTo',
  confidence: 'parsed',
  source: 'unit-test',
  properties: {},
});

const parentOf = (fromId: string, toId: string): Edge => ({
  fromId,
  toId,
  edgeType: 'parentOf',
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
});

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-sprawl-'));
  const opened = await openGraph(join(tempDir, 'graph.duckdb'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;

  const nodes: Node[] = [
    // Heavy__c: 2 record-triggered Flows + 1 ApexTrigger + 1 WorkflowRule fire
    // on it (via triggersOn), PLUS 1 Process Builder parented to it. The densest.
    makeNode({ id: 'CustomObject:Heavy__c', type: 'CustomObject', apiName: 'Heavy__c' }),
    makeNode({ id: 'CustomObject:Light__c', type: 'CustomObject', apiName: 'Light__c' }),
    makeNode({ id: 'CustomObject:Empty__c', type: 'CustomObject', apiName: 'Empty__c' }),

    makeNode({ id: 'Flow:Heavy_RT1', type: 'Flow', apiName: 'Heavy_RT1', properties: { status: 'Active' } }),
    makeNode({ id: 'Flow:Heavy_RT2', type: 'Flow', apiName: 'Heavy_RT2', properties: { status: 'Active' } }),
    makeNode({ id: 'ApexTrigger:Heavy_Trig', type: 'ApexTrigger', apiName: 'Heavy_Trig', properties: { status: 'Active' } }),
    makeNode({ id: 'WorkflowRule:Heavy_WF', type: 'WorkflowRule', apiName: 'Heavy_WF', properties: { active: true } }),
    // A Process Builder = Flow with processType Workflow, parented to Heavy__c.
    // It emits NO triggersOn edge (mirrors the extractor), so it is only counted
    // as a Process Builder, never double-counted as a record-triggered firer.
    makeNode({
      id: 'Flow:Heavy_PB',
      type: 'Flow',
      apiName: 'Heavy_PB',
      parentId: 'CustomObject:Heavy__c',
      properties: { processType: 'Workflow', active: true, decisionCount: 1, actionCount: 1 },
    }),

    // Light__c: a single record-triggered Flow.
    makeNode({ id: 'Flow:Light_RT1', type: 'Flow', apiName: 'Light_RT1', properties: { status: 'Active' } }),

    // A colliding field on Heavy__c: two distinct automations write it → the
    // automation_collisions engine reports one field-write collision.
    makeNode({
      id: 'CustomField:Heavy__c.Status__c',
      type: 'CustomField',
      apiName: 'Status__c',
      parentId: 'CustomObject:Heavy__c',
      properties: { dataType: 'Picklist' },
    }),
  ];

  const edges: Edge[] = [
    triggersOn('Flow:Heavy_RT1', 'CustomObject:Heavy__c', { triggerType: 'RecordAfterSave', recordTriggerType: 'Update' }),
    triggersOn('Flow:Heavy_RT2', 'CustomObject:Heavy__c', { triggerType: 'RecordAfterSave', recordTriggerType: 'Update' }),
    triggersOn('ApexTrigger:Heavy_Trig', 'CustomObject:Heavy__c'),
    triggersOn('WorkflowRule:Heavy_WF', 'CustomObject:Heavy__c'),
    triggersOn('Flow:Light_RT1', 'CustomObject:Light__c', { triggerType: 'RecordAfterSave', recordTriggerType: 'Update' }),
    // Two distinct writers on the same field, same (save) path → 1 collision.
    writesTo('Flow:Heavy_RT1', 'CustomField:Heavy__c.Status__c'),
    writesTo('ApexTrigger:Heavy_Trig', 'CustomField:Heavy__c.Status__c'),
    parentOf('CustomObject:Heavy__c', 'CustomField:Heavy__c.Status__c'),
  ];

  const imp = await importExtractionResults(store, [{ nodes, edges }]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('automation_risk_report — default mode is UNCHANGED (byte-identity)', () => {
  it('an absent mode carries none of the sprawl keys (risk shape preserved)', async () => {
    const r = await automationRiskReportHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('mode' in r.value.data).toBe(false);
    expect('sprawl' in r.value.data).toBe(false);
    // UPDATED (FIX 9) — INVARIANT: the "this report composes TWO analyses"
    // boundary is UNCONDITIONAL, so `boundaries` is no longer a sprawl-only
    // key; it is the shared verbatim-disclosure array. The sprawl-only keys
    // above are still absent, and the two byte-identity tests below still pin
    // mode:'risk' ≡ the bare call. What must NOT leak is `sprawl`/`scoreBasis`.
    expect('boundaries' in r.value.data).toBe(true);
    expect('sprawl' in r.value.data).toBe(false);
    // The risk report still composes its two halves.
    expect(r.value.data.governorClasses).not.toBeNull();
    expect(Array.isArray(r.value.data.findings)).toBe(true);
  });

  it("mode:'risk' is byte-identical to the bare call (a true no-op)", async () => {
    const bare = await automationRiskReportHandler(ctx, {});
    const risk = await automationRiskReportHandler(ctx, { mode: 'risk' });
    expect(bare.ok && risk.ok).toBe(true);
    expect(JSON.stringify(bare)).toBe(JSON.stringify(risk));
  });

  it("mode:'risk' with a limit is byte-identical to the bare call with the same limit", async () => {
    const bare = await automationRiskReportHandler(ctx, { limit: 5 });
    const risk = await automationRiskReportHandler(ctx, { limit: 5, mode: 'risk' });
    expect(bare.ok && risk.ok).toBe(true);
    expect(JSON.stringify(bare)).toBe(JSON.stringify(risk));
  });
});

describe("automation_risk_report mode:'sprawl' — org-wide density ranking", () => {
  it('ranks a denser object above a lighter one and excludes zero-automation objects', async () => {
    const r = await automationRiskReportHandler(ctx, { mode: 'sprawl' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.value.data;
    expect(data.mode).toBe('sprawl');
    expect(data.sprawl).toBeDefined();
    const cands = data.sprawl?.candidates ?? [];

    const heavyIdx = cands.findIndex((c) => c.objectApiName === 'Heavy__c');
    const lightIdx = cands.findIndex((c) => c.objectApiName === 'Light__c');
    expect(heavyIdx).toBeGreaterThanOrEqual(0);
    expect(lightIdx).toBeGreaterThanOrEqual(0);
    // Denser object ranks FIRST.
    expect(heavyIdx).toBeLessThan(lightIdx);
    expect(cands[heavyIdx]?.rank).toBe(1);
    expect(cands[heavyIdx]?.densityScore).toBeGreaterThan(cands[lightIdx]?.densityScore ?? 0);

    // Zero-automation object is not a candidate.
    expect(cands.some((c) => c.objectApiName === 'Empty__c')).toBe(false);

    // Heavy signal breakdown is exact and disclosed per-signal.
    const heavy = cands[heavyIdx];
    expect(heavy?.signals.recordTriggeredFlows).toBe(2);
    expect(heavy?.signals.apexTriggers).toBe(1);
    expect(heavy?.signals.workflowRules).toBe(1);
    expect(heavy?.signals.processBuilders).toBe(1);
    // 2 distinct writers on one field → collision engine ran and found it.
    expect(heavy?.collisionScanned).toBe(true);
    expect(heavy?.signals.fieldWriteCollisions).toBeGreaterThanOrEqual(1);
  });

  it('discloses the score weights + formula (never a black-box number)', async () => {
    const r = await automationRiskReportHandler(ctx, { mode: 'sprawl' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const basis = r.value.data.sprawl?.scoreBasis;
    expect(basis).toBeDefined();
    expect(basis?.weights.recordTriggeredFlow).toBe(3);
    expect(basis?.weights.apexTrigger).toBe(3);
    expect(basis?.weights.workflowRule).toBe(2);
    expect(basis?.weights.processBuilder).toBe(2);
    expect(basis?.weights.fieldWriteCollision).toBe(4);
    expect(basis?.weights.namingInconsistency).toBe(1);
    expect(typeof basis?.formula).toBe('string');
    expect(basis?.formula.length).toBeGreaterThan(0);
    expect((basis?.confidenceNote ?? '').toLowerCase()).toContain('heuristic');
  });

  it('frames the ranking as a CANDIDATE QUEUE, not a graded verdict', async () => {
    const r = await automationRiskReportHandler(ctx, { mode: 'sprawl' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.value.data;
    // Sprawl mode does not emit severity-graded findings.
    expect(data.findings).toEqual([]);
    expect(data.governorClasses).toBeNull();
    // Candidate-not-verdict framing in the disclosure.
    expect(data.disclosure.toLowerCase()).toContain('candidate queue');
    expect(data.disclosure.toLowerCase()).toContain('not a graded verdict');
    // Verbatim boundaries: triage heuristic, inactive/obsolete versions not
    // counted, managed-package under-count, coverage floor.
    const boundaries = data.boundaries ?? [];
    expect(boundaries.length).toBeGreaterThan(0);
    const joined = boundaries.join(' ').toLowerCase();
    expect(joined).toContain('triage heuristic');
    expect(joined).toMatch(/inactive .*obsolete flow versions are not counted/);
    expect(joined).toContain('managed-package automation may be under-counted');
    expect(joined).toContain('coverage floor');
  });

  it('is deterministic across two calls', async () => {
    const a = await automationRiskReportHandler(ctx, { mode: 'sprawl' });
    const b = await automationRiskReportHandler(ctx, { mode: 'sprawl' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('carries the offline trust block', async () => {
    const r = await automationRiskReportHandler(ctx, { mode: 'sprawl' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.trust.provenance).toBe('offline_snapshot');
  });
});
