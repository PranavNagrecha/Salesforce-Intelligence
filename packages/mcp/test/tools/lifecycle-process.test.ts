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
import { lifecycleProcessHandler } from '../../src/tools/lifecycle-process.js';

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

const OPP = 'CustomObject:Opportunity';
const WON_WF = 'WorkflowRule:Opportunity.OnClosedWon';
const WON_COND = 'ConditionalContext:WorkflowRule:Opportunity.OnClosedWon.condition-0';
const OTHER_WF = 'WorkflowRule:Opportunity.OnAmount';
const OTHER_COND = 'ConditionalContext:WorkflowRule:Opportunity.OnAmount.condition-0';

// Opportunity with two update workflows: one gated on StageName = Closed Won,
// one gated on Amount — to prove the lifecycle coupling filter.
const seed: ExtractionResult = {
  nodes: [
    node({ id: OPP, type: 'CustomObject', apiName: 'Opportunity', properties: { sharingModel: 'Private' } }),
    node({ id: WON_WF, type: 'WorkflowRule', apiName: 'Opportunity.OnClosedWon', parentId: OPP, properties: { triggerType: 'onAllChanges', active: true } }),
    node({
      id: WON_COND,
      type: 'ConditionalContext',
      apiName: 'WorkflowRule:Opportunity.OnClosedWon.condition-0',
      parentId: WON_WF,
      properties: {
        kind: 'criteria',
        expression: 'Opportunity.StageName equals Closed Won',
        fieldRefs: ['CustomField:Opportunity.StageName'],
        synthesized: false,
      },
    }),
    node({ id: OTHER_WF, type: 'WorkflowRule', apiName: 'Opportunity.OnAmount', parentId: OPP, properties: { triggerType: 'onAllChanges', active: true } }),
    node({
      id: OTHER_COND,
      type: 'ConditionalContext',
      apiName: 'WorkflowRule:Opportunity.OnAmount.condition-0',
      parentId: OTHER_WF,
      properties: {
        kind: 'criteria',
        expression: 'Opportunity.Amount greater than 1000',
        fieldRefs: ['CustomField:Opportunity.Amount'],
        synthesized: false,
      },
    }),
  ],
  edges: [
    edge({ fromId: OPP, toId: WON_WF, edgeType: 'parentOf' }),
    edge({ fromId: WON_WF, toId: OPP, edgeType: 'triggersOn', properties: { triggerType: 'onAllChanges' } }),
    edge({ fromId: WON_WF, toId: WON_COND, edgeType: 'firesWhen', confidence: 'parsed' }),
    edge({ fromId: OPP, toId: OTHER_WF, edgeType: 'parentOf' }),
    edge({ fromId: OTHER_WF, toId: OPP, edgeType: 'triggersOn', properties: { triggerType: 'onAllChanges' } }),
    edge({ fromId: OTHER_WF, toId: OTHER_COND, edgeType: 'firesWhen', confidence: 'parsed' }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-lifecycle-'));
  const opened = await openGraph(join(tempDir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(imported.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('lifecycleProcessHandler', () => {
  it('couples automation to the field/value transition', async () => {
    const r = await lifecycleProcessHandler(ctx, {
      objectApiName: 'Opportunity',
      field: 'StageName',
      value: 'Closed Won',
      event: 'update',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.transition.field).toBe('StageName');
    expect(d.transition.value).toBe('Closed Won');
    // The Closed-Won workflow is coupled to BOTH the field and the value.
    const won = d.coupledAutomation.find((s) => s.componentId === WON_WF);
    expect(won?.coupledToField).toBe(true);
    expect(won?.coupledToValue).toBe(true);
    // The Amount workflow is NOT coupled to this transition.
    expect(d.coupledAutomation.some((s) => s.componentId === OTHER_WF)).toBe(false);
    expect(d.summary.fieldCoupledSteps).toBe(1);
    expect(d.summary.valueCoupledSteps).toBe(1);
  });

  it('still lists the full chain (both workflows appear in process)', async () => {
    const r = await lifecycleProcessHandler(ctx, {
      objectApiName: 'Opportunity',
      field: 'StageName',
      value: 'Closed Won',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.process.map((s) => s.componentId);
    expect(ids).toContain(WON_WF);
    expect(ids).toContain(OTHER_WF);
    expect(r.value.data.confidence).toBe('parsed');
  });

  it('hints to pass a transition when field/value are omitted', async () => {
    const r = await lifecycleProcessHandler(ctx, { objectApiName: 'Opportunity' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.transition.field).toBe(null);
    expect(r.value.data.coupledAutomation.length).toBe(0);
    expect(r.value.data.disclosures.some((s) => s.includes('Pass `field`'))).toBe(true);
  });

  it('always discloses the conditions-not-evaluated boundary', async () => {
    const r = await lifecycleProcessHandler(ctx, {
      objectApiName: 'Opportunity',
      field: 'StageName',
      value: 'Closed Won',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disclosures.some((s) => s.includes('NOT EVALUATED'))).toBe(true);
  });

  it('propagates the underlying not-found error for an unknown object', async () => {
    const r = await lifecycleProcessHandler(ctx, { objectApiName: 'NoSuchObj__c' });
    // order_of_execution surfaces component-not-found for an unknown object.
    expect(r.ok).toBe(false);
  });
});
