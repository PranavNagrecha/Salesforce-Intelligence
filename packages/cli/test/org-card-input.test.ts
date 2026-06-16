/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  listEdges,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import { buildOrgCardInput } from '../src/org-card-input.js';

/**
 * P13-CARD-render — "every number re-derivable from graph/manifest": build a
 * small synthetic graph, assemble the card input, and re-derive each headline
 * number with direct queries. The card may never claim a number the graph
 * does not produce.
 */

const node = (
  id: string,
  type: string,
  apiName: string,
  properties: Record<string, unknown> = {},
): ExtractionResult['nodes'][number] =>
  ({
    id,
    type,
    apiName,
    label: apiName,
    parentId: null,
    sourcePath: `source/${type}/${apiName}`,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties,
  }) as never;

const edge = (
  fromId: string,
  toId: string,
  edgeType: string,
): NonNullable<ExtractionResult['edges']>[number] =>
  ({ fromId, toId, edgeType, confidence: 'declared', source: 'test', properties: {} }) as never;

const FIXTURE: ExtractionResult = {
  nodes: [
    node('CustomObject:Alpha__c', 'CustomObject', 'Alpha__c'),
    node('CustomObject:Beta__c', 'CustomObject', 'Beta__c'),
    node('CustomField:Alpha__c.Score__c', 'CustomField', 'Alpha__c.Score__c'),
    node('Flow:Active_Flow', 'Flow', 'Active_Flow', { status: 'Active' }),
    node('Flow:Draft_Flow', 'Flow', 'Draft_Flow', { status: 'Draft' }),
    node('ApexClass:AlphaService', 'ApexClass', 'AlphaService'),
    node('Profile:Root_Admin', 'Profile', 'Root_Admin', {
      userPermissions: ['ViewAllData', 'ApiEnabled'],
    }),
    node('PermissionSet:Read_Only', 'PermissionSet', 'Read_Only', {
      userPermissions: ['ApiEnabled'],
    }),
    node('NamedCredential:Billing_API', 'NamedCredential', 'Billing_API'),
  ],
  edges: [
    // Alpha gets two real inbound dependencies + one structural parentOf
    // (which centrality must EXCLUDE); Beta gets one.
    edge('ApexClass:AlphaService', 'CustomObject:Alpha__c', 'readsFrom'),
    edge('Flow:Active_Flow', 'CustomObject:Alpha__c', 'triggersOn'),
    edge('CustomObject:Alpha__c', 'CustomField:Alpha__c.Score__c', 'parentOf'),
    edge('Flow:Draft_Flow', 'CustomObject:Beta__c', 'triggersOn'),
  ],
} as never;

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-09T22:00:00.000Z',
  sourceOrg: 'card-input-fixture',
  components: {
    CustomObject: 2,
    CustomField: 1,
    Flow: 2,
    ApexClass: 1,
    Profile: 1,
    PermissionSet: 1,
    NamedCredential: 1,
  },
  edges: { readsFrom: 1, triggersOn: 2, parentOf: 1 },
  sourceTreeHash: 'sha256:card-input-fixture',
} as never;

let tempDir: string;
let store: GraphStore;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-org-card-'));
  const opened = await openGraph(join(tempDir, 'g.duckdb'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imported = await importExtractionResults(store, [FIXTURE]);
  if (!imported.ok) throw new Error(imported.error.message);
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('buildOrgCardInput', () => {
  it('derives every headline number from the graph/manifest (re-derivable)', async () => {
    const input = await buildOrgCardInput(MANIFEST, store, '2026-06-10T00:00:00.000Z');

    // Scale — straight from the manifest.
    expect(input.totalComponents).toBe(9);
    expect(input.totalEdges).toBe(4);
    expect(input.componentCounts[0]).toEqual(['CustomObject', 2]);

    // Centrality — re-derive Alpha's inbound count directly and compare:
    // 3 inbound edges minus the structural parentOf = 2.
    const alphaEdges = await listEdges(store, 'CustomObject:Alpha__c' as never, {
      direction: 'in',
    });
    expect(alphaEdges.ok).toBe(true);
    const expectedAlpha = alphaEdges.ok
      ? alphaEdges.value.filter((e) => e.edgeType !== 'parentOf').length
      : -1;
    expect(input.topObjects[0]).toEqual({ id: 'CustomObject:Alpha__c', inboundRefs: expectedAlpha });
    expect(expectedAlpha).toBe(2);
    expect(input.topObjects[1]).toEqual({ id: 'CustomObject:Beta__c', inboundRefs: 1 });
    expect(input.objectScanCount).toBe(2);

    // Automation density — Active_Flow counts, Draft_Flow does not.
    const flowRow = input.automation.find((a) => a.type === 'Flow');
    expect(flowRow).toEqual({ type: 'Flow', total: 2, active: 1 });

    // Permissions posture — exactly the Profile holds god-mode.
    expect(input.permissions).toEqual({
      profileCount: 1,
      permissionSetCount: 1,
      godModeContainers: 1,
      godModeScanCount: 2,
    });

    // Integration surface — the one NamedCredential, nothing invented.
    expect(input.integrations).toEqual([['NamedCredential', 1]]);

    // Stamps pass through untouched.
    expect(input.generatedAt).toBe('2026-06-10T00:00:00.000Z');
    expect(input.refreshedAt).toBe(MANIFEST.refreshedAt);
    expect(input.sourceTreeHash).toBe(MANIFEST.sourceTreeHash);
  });
});
