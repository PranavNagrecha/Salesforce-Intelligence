/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';
import type { ExtendedVaultManifest } from '@sf-intelligence/vault';

import { classifyForDemandRetrieve } from '../src/commands/refresh.js';

// Synthetic-only fixtures: the demand-retrieve gate must pull ONLY
// automation-critical CustomObject phantoms and refuse everything else.
const MANIFEST: ExtendedVaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-04T00:00:00.000Z',
  sourceOrg: 'test',
  components: { CustomObject: 1 },
  edges: {},
  sourceTreeHash: 'sha256:dr',
  coverage: [
    { type: 'CustomObject', requested: true, retrieved: 1, errored: false, neverModeled: false },
  ],
};

const node = (id: string): Node => ({
  id,
  type: 'CustomObject',
  apiName: id.split(':')[1] ?? id,
  label: null,
  parentId: null,
  sourcePath: 'x',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

const edge = (fromId: string, edgeType: Edge['edgeType'], toId: string): Edge => ({
  fromId,
  toId,
  edgeType,
  confidence: 'declared',
  source: 'test',
  properties: {},
});

const SEED: ExtractionResult = {
  nodes: [node('CustomObject:Acme_Order__c')],
  edges: [
    edge('ApexTrigger:Acme_Trig', 'triggersOn', 'CustomObject:Acme_Auto__c'), // automation-critical
    edge('PermissionSet:Acme_PS', 'grantedBy', 'CustomObject:Acme_Grant__c'), // grant-only
    edge('PermissionSet:Acme_PS', 'grantedBy', 'CustomObject:ns__Managed__c'), // managed-extension
    edge('PermissionSet:Acme_PS', 'grantedBy', 'CustomObject:Account'), // standard-field-phantom
  ],
};

let tempDir: string;
let store: GraphStore;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-dr-'));
  const opened = await openGraph(join(tempDir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [SEED]);
  if (!imp.ok) throw new Error(imp.error.message);
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('classifyForDemandRetrieve (P7-demand-retrieve gate)', () => {
  it('pulls ONLY the automation-critical CustomObject and refuses the rest with reasons', async () => {
    const r = await classifyForDemandRetrieve(store, MANIFEST, [
      'CustomObject:Acme_Auto__c',
      'CustomObject:Acme_Grant__c',
      'CustomObject:ns__Managed__c',
      'CustomObject:Account',
      'CustomObject:Acme_Order__c', // already a real node
      'CustomObject:Acme_NoRefs__c', // not referenced — unknown
    ]);

    expect(r.retrieveObjects).toEqual(['Acme_Auto__c']);
    expect(r.alreadyPresent).toEqual(['CustomObject:Acme_Order__c']);

    const byId = Object.fromEntries(r.refused.map((x) => [x.id, x.classification]));
    expect(byId['CustomObject:Acme_Grant__c']).toBe('grant-only');
    expect(byId['CustomObject:ns__Managed__c']).toBe('managed-extension');
    expect(byId['CustomObject:Account']).toBe('standard-field-phantom');
    expect(byId['CustomObject:Acme_NoRefs__c']).toBe('unknown');
    // Every refusal carries a non-empty reason.
    expect(r.refused.every((x) => x.reason.length > 0)).toBe(true);
  });

  it('refuses an automation-critical id that is not a CustomObject (CustomObject-only in v1)', async () => {
    // ApexTrigger:Acme_Trig references CustomObject:Acme_Auto__c; treat a
    // non-CustomObject automation-critical id (a hypothetical) as refused.
    const r = await classifyForDemandRetrieve(store, MANIFEST, ['Flow:Acme_NoRefs']);
    expect(r.retrieveObjects).toEqual([]);
    expect(r.refused).toHaveLength(1);
    expect(r.refused[0]?.id).toBe('Flow:Acme_NoRefs');
  });
});

describe('markDemandQueueDrains (P13-STAGED-demand-queue)', () => {
  it('marks retrieved / already-present / refused outcomes; unknown ids are ignored at read', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { appendDemandHit, readDemandQueue } = await import('@sf-intelligence/vault');
    const { markDemandQueueDrains } = await import('../src/commands/refresh.js');

    const vaultRoot = await mkdtemp(join(tmpdir(), 'sfi-mark-drains-'));
    try {
      await appendDemandHit(vaultRoot, 'CustomObject:A__c', 'automation-critical', 't');
      await appendDemandHit(vaultRoot, 'CustomObject:B__c', 'automation-critical', 't');
      await appendDemandHit(vaultRoot, 'CustomObject:C__c', 'grant-only', 't');
      await markDemandQueueDrains(vaultRoot, {
        retrieved: ['CustomObject:A__c' as never],
        alreadyPresent: ['CustomObject:B__c'],
        refused: [
          { id: 'CustomObject:C__c', classification: 'grant-only', reason: 'not worth retrieving' },
          { id: 'CustomObject:NeverHit__c', classification: 'unknown', reason: 'unknown id' },
        ],
      });
      const queue = await readDemandQueue(vaultRoot);
      const byId = new Map(queue.map((e) => [e.id, e]));
      expect(byId.get('CustomObject:A__c')?.status).toBe('drained');
      expect(byId.get('CustomObject:A__c')?.drainOutcome).toBe('retrieved');
      expect(byId.get('CustomObject:B__c')?.status).toBe('drained');
      expect(byId.get('CustomObject:B__c')?.drainOutcome).toBe('already-present');
      expect(byId.get('CustomObject:C__c')?.status).toBe('refused');
      expect(byId.has('CustomObject:NeverHit__c')).toBe(false); // no dupes, no ghost rows
      // idempotent: marking again changes nothing material
      await markDemandQueueDrains(vaultRoot, {
        retrieved: ['CustomObject:A__c' as never],
        alreadyPresent: [],
        refused: [],
      });
      const again = await readDemandQueue(vaultRoot);
      expect(again.find((e) => e.id === 'CustomObject:A__c')?.status).toBe('drained');
      expect(again.length).toBe(queue.length);
    } finally {
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });
});
