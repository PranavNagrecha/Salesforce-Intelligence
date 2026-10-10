/// <reference types="vitest/globals" />

/**
 * FAIL-BEFORE/PASS-AFTER — save order treated scheduled-only and stale-vault
 * after-save Flows as synchronous.
 *
 * `order_of_execution` and `what_happens_on_save` each copied the rule
 * "scheduled-only = no immediate connector AND scheduledPathTypes non-empty".
 * A time-offset scheduled path carries no `<pathType>`, so a Flow that runs
 * only "1 day after save" was listed as running IN the save; and a vault built
 * before `hasImmediateConnector` existed read every async Flow as synchronous
 * with no caveat. Flow steps also never said their declared trigger order or
 * that they fire only when a save changes the record to meet the criteria.
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

const OBJ = 'CustomObject:Ledger__c';
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
const triggersOn = (flow: string): Edge => ({
  fromId: flow,
  toId: OBJ,
  edgeType: 'triggersOn',
  confidence: 'declared',
  source: 'flow-extractor',
  properties: { triggerType: 'RecordAfterSave', recordTriggerType: 'CreateAndUpdate' },
});

const flow = (name: string, props: Record<string, unknown>): Node =>
  node({
    id: `Flow:${name}`,
    type: 'Flow',
    apiName: name,
    properties: {
      status: 'Active',
      triggerObject: 'Ledger__c',
      triggerType: 'RecordAfterSave',
      recordTriggerType: 'CreateAndUpdate',
      ...props,
    },
  });

const seed: ExtractionResult = {
  nodes: [
    node({ id: OBJ, type: 'CustomObject', apiName: 'Ledger__c' }),
    flow('Ordered_Now', {
      hasImmediateConnector: true,
      scheduledPathTypes: [],
      scheduledPathCount: 0,
      triggerOrder: 10,
      entryRequiresRecordChange: true,
    }),
    // Time-offset scheduled path only: no <pathType>, so scheduledPathTypes is empty.
    flow('Next_Day_Only', {
      hasImmediateConnector: false,
      scheduledPathTypes: [],
      scheduledPathCount: 1,
      triggerOrder: null,
    }),
    // Built before hasImmediateConnector existed.
    flow('Stale_Vault_Flow', {}),
  ],
  edges: ['Ordered_Now', 'Next_Day_Only', 'Stale_Vault_Flow'].map((n) => triggersOn(`Flow:${n}`)),
};

const manifest: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-01-01T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-soe-timing-'));
  const opened = await openGraph(join(tempDir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(imported.error.message);
  ctx = { vaultRoot: tempDir, manifest, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

type Step = { componentId: string; phase: string; timing?: string; triggerOrder?: number; onlyWhenChangedToMeet?: true };

const check = (soe: readonly Step[]): void => {
  const by = (id: string) => soe.find((s) => s.componentId === id);
  expect(by('Flow:Next_Day_Only')).toMatchObject({ phase: 'post-save-async', timing: 'async-only' });
  expect(by('Flow:Stale_Vault_Flow')).toMatchObject({ phase: 'post-save-flows', timing: 'unknown' });
  expect(by('Flow:Ordered_Now')).toMatchObject({
    phase: 'post-save-flows',
    triggerOrder: 10,
    onlyWhenChangedToMeet: true,
  });
  expect(by('Flow:Ordered_Now')?.timing).toBeUndefined();
};

describe('FAIL-BEFORE/PASS-AFTER: after-save Flow timing in save order', () => {
  it('order_of_execution', async () => {
    const r = await orderOfExecutionHandler(ctx, { objectApiName: 'Ledger__c', event: 'update' });
    if (!r.ok) throw new Error(r.error.message);
    check((r.value.data.byEvent.update?.soe ?? []) as readonly Step[]);
  });

  it('what_happens_on_save', async () => {
    const r = await whatHappensOnSaveHandler(ctx, { objectApiName: 'Ledger__c', event: 'update' });
    if (!r.ok) throw new Error(r.error.message);
    check(r.value.data.soe as readonly Step[]);
  });
});
