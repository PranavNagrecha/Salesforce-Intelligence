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
const seed: ExtractionResult = {
  nodes: [
    node('CustomObject:Busy__c', 'CustomObject'),
    node('CustomObject:Quiet__c', 'CustomObject'),
    node('Flow:FlowA', 'Flow', { status: 'Active' }),
    node('Flow:FlowB', 'Flow', { status: 'Active' }),
    node('ApexTrigger:BusyTrigger', 'ApexTrigger', { status: 'Active' }),
  ],
  edges: [
    edge('Flow:FlowA', 'CustomObject:Busy__c', 'triggersOn', { recordTriggerType: 'Update' }),
    edge('Flow:FlowB', 'CustomObject:Busy__c', 'triggersOn', { recordTriggerType: 'Update' }),
    edge('ApexTrigger:BusyTrigger', 'CustomObject:Busy__c', 'triggersOn', {}),
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
    if (!r.ok) return;
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
    if (!r.ok) return;
    expect(r.value.data.risks.map((x) => x.kind)).toEqual(['greenfield']);
  });

  it('answers (objectModeled=false) even when the object node is absent', async () => {
    const r = await automationBuildAdvisorHandler(ctx, { objectApiName: 'NotInVault__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.objectModeled).toBe(false);
  });
});

describe('automationBuildAdvisorInputSchema', () => {
  it('requires objectApiName', () => {
    expect(automationBuildAdvisorInputSchema.safeParse({}).success).toBe(false);
    expect(automationBuildAdvisorInputSchema.safeParse({ objectApiName: 'Account' }).success).toBe(true);
  });
});
