/// <reference types="vitest/globals" />

/**
 * FAIL-BEFORE/PASS-AFTER (second review): a workflow field update fired from a
 * TIME TRIGGER is extracted as the same `writesTo` edge as an immediate one,
 * marked `timeTriggered: true` — but only why_field_changed read the mark.
 * automation_collisions reported a same-save `high` collision between it and a
 * before-save Flow writing the same field, and what_happens_on_save /
 * order_of_execution listed it as a save-time write. It runs hours or days
 * later, in its own transaction. Names synthetic.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, Node, VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, importExtractionResults, openGraph, type GraphStore } from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { automationCollisionsHandler } from '../../src/tools/automation-collisions.js';
import { orderOfExecutionHandler } from '../../src/tools/order-of-execution.js';
import { whatHappensOnSaveHandler } from '../../src/tools/what-happens-on-save.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-07-10T00:00:00Z',
  sourceOrg: 'test',
  components: { CustomObject: 2 },
  edges: { triggersOn: 4, writesTo: 4 },
  sourceTreeHash: 'sha256:fixture-time-trigger',
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

let dir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-time-trigger-'));
  const opened = await openGraph(join(dir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imported = await importExtractionResults(store, [
    {
      nodes: [
        node('CustomObject:Deal__c', 'CustomObject'),
        node('CustomField:Deal__c.Stage__c', 'CustomField'),
        node('Flow:DealBeforeSave', 'Flow', { status: 'Active' }),
        node('WorkflowRule:Deal__c.Stale_Deal', 'WorkflowRule', { active: true, triggerType: 'onAllChanges' }),
      ],
      edges: [
        edge('Flow:DealBeforeSave', 'CustomObject:Deal__c', 'triggersOn', {
          recordTriggerType: 'Update',
          triggerType: 'RecordBeforeSave',
        }),
        edge('Flow:DealBeforeSave', 'CustomField:Deal__c.Stage__c', 'writesTo', { operation: 'recordUpdate' }),
        edge('WorkflowRule:Deal__c.Stale_Deal', 'CustomObject:Deal__c', 'triggersOn', {
          triggerType: 'onAllChanges',
        }),
        // Exactly the edge the workflow extractor mints for a time-trigger update.
        edge('WorkflowRule:Deal__c.Stale_Deal', 'CustomField:Deal__c.Stage__c', 'writesTo', {
          operation: 'Literal',
          timeTriggered: true,
        }),
      ],
    },
  ]);
  if (!imported.ok) throw new Error(imported.error.message);
  ctx = { vaultRoot: dir, manifest: MANIFEST, graph: store } as Context;
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(dir, { recursive: true, force: true });
});

describe('time-triggered workflow field updates are never same-save writes', () => {
  it('automation_collisions reports no save collision with a before-save Flow', async () => {
    const r = await automationCollisionsHandler(ctx, { object: 'Deal__c' });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.data.collisions.filter((c) => c.collisionPath === 'save')).toEqual([]);
  });

  it('what_happens_on_save shows it as scheduled, not as a writesTo action', async () => {
    const r = await whatHappensOnSaveHandler(ctx, { objectApiName: 'Deal__c', event: 'update' });
    if (!r.ok) throw new Error(r.error.message);
    const actions = r.value.data.soe
      .filter((s) => s.componentId === 'WorkflowRule:Deal__c.Stale_Deal')
      .flatMap((s) => s.actions);
    expect(actions.some((a) => a.kind === 'writesTo')).toBe(false);
    expect(actions.some((a) => a.kind === 'schedulesTimeTriggeredWrite')).toBe(true);
  });

  it('order_of_execution agrees (one shared action builder)', async () => {
    const r = await orderOfExecutionHandler(ctx, { objectApiName: 'Deal__c', event: 'update' });
    if (!r.ok) throw new Error(r.error.message);
    type Step = { componentId: string; actions: readonly { kind: string }[] };
    const steps = (r.value.data as unknown as { byEvent: Record<string, { soe: readonly Step[] }> }).byEvent['update']?.soe ?? [];
    expect(steps.length).toBeGreaterThan(0);
    const actions = steps
      .filter((s) => s.componentId === 'WorkflowRule:Deal__c.Stale_Deal')
      .flatMap((s) => s.actions);
    expect(actions.some((a) => a.kind === 'writesTo')).toBe(false);
    expect(actions.some((a) => a.kind === 'schedulesTimeTriggeredWrite')).toBe(true);
  });
});
