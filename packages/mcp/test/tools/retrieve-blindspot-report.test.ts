/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  Edge,
  ExtractionResult,
  Node,
  VaultManifest,
} from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  retrieveBlindspotReportHandler,
  retrieveBlindspotReportInputSchema,
} from '../../src/tools/retrieve-blindspot-report.js';

// Synthetic-only fixtures (no real org names).
const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-03T12:00:00.000Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 2, ApexTrigger: 1, ApexClass: 1 },
  edges: { triggersOn: 1, callsApex: 1, grantedBy: 1, usedInLayout: 1 },
  sourceTreeHash: 'sha256:blindspot',
  coverageComputedAt: '2026-06-03T12:01:00.000Z',
  coverage: [
    { type: 'CustomObject', requested: true, retrieved: 2, errored: false, neverModeled: false },
    { type: 'ApexClass', requested: true, retrieved: 1, errored: false, neverModeled: false },
    { type: 'EmailTemplate', requested: false, retrieved: 0, errored: false, neverModeled: true },
  ],
};

const node = (id: string, type: Node['type']): Node => ({
  id,
  type,
  apiName: id.split(':')[1] ?? id,
  label: null,
  parentId: null,
  sourcePath: 'x',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

const edge = (
  fromId: string,
  edgeType: Edge['edgeType'],
  toId: string,
  confidence: Edge['confidence'],
): Edge => ({ fromId, toId, edgeType, confidence, source: 'test', properties: {} });

// Resolved object + trigger; a trigger that fires on a MISSING object (functional
// blind spot), calls a MISSING class, a layout referencing a MISSING field, a perm
// grant on a MISSING object, and a heuristic scanner phantom.
const SEED: ExtractionResult = {
  nodes: [
    node('CustomObject:Acme_Order__c', 'CustomObject'),
    node('ApexTrigger:Acme_OrderTrigger', 'ApexTrigger'),
  ],
  edges: [
    edge('ApexTrigger:Acme_OrderTrigger', 'triggersOn', 'CustomObject:Acme_Order__c', 'declared'), // resolved
    edge('ApexTrigger:Acme_OrderTrigger', 'triggersOn', 'CustomObject:Acme_Missing__c', 'declared'), // functional
    edge('ApexTrigger:Acme_OrderTrigger', 'callsApex', 'ApexClass:Acme_MissingSvc', 'declared'), // functional
    edge('WorkflowAlert:Acme_Alert', 'sendsEmail', 'EmailTemplate:Acme.Missing_Tpl', 'declared'), // functional, notModeled type
    edge('Layout:Acme_Order__c-Layout', 'usedInLayout', 'CustomField:Acme_Order__c.Ghost__c', 'declared'), // layout
    edge('PermissionSet:Acme_PS', 'grantedBy', 'CustomObject:Acme_GrantTarget__c', 'declared'), // grant
    edge('ApexClass:Acme_Svc', 'readsFrom', 'CustomField:Acme_Missing__c.Foo__c', 'heuristic'), // scanner phantom
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-blindspot-'));
  const opened = await openGraph(join(tempDir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [SEED]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('retrieveBlindspotReportHandler', () => {
  it('surfaces automation/code references to unretrieved components, rolling up grant/layout/scanner noise', async () => {
    const r = await retrieveBlindspotReportHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;

    expect(d.cleanVault).toBe(false);
    const types = d.blindspots.map((b) => b.targetType).sort();
    // Functional blind spots only: CustomObject (triggersOn), ApexClass (callsApex), EmailTemplate (sendsEmail).
    expect(types).toEqual(['ApexClass', 'CustomObject', 'EmailTemplate']);
    // Every enumerated blindspot is the functional bucket.
    expect(d.blindspots.every((b) => b.bucket === 'automation-and-code')).toBe(true);

    const co = d.blindspots.find((b) => b.targetType === 'CustomObject');
    expect(co?.coverageStatus).toBe('covered'); // type retrieved; specific object missing
    expect(co?.edgeKinds.some((k) => k.edgeType === 'triggersOn')).toBe(true);
    expect(co?.edgeKinds.flatMap((k) => k.sampleTargets)).toContain('CustomObject:Acme_Missing__c');

    // notModeled type → whole-type manifest gap remedy.
    const et = d.blindspots.find((b) => b.targetType === 'EmailTemplate');
    expect(et?.coverageStatus).toBe('notModeled');
    expect(et?.remedy).toMatch(/manifest|never retrieved|not modeled/i);

    // Noise is rolled up, not enumerated.
    expect(d.rolledUp.permissionGrant.referenceEdges).toBe(1);
    expect(d.rolledUp.layoutReference.referenceEdges).toBe(1);
    expect(d.rolledUp.heuristicUnresolved.referenceEdges).toBe(1);
    expect(d.summary.functionalBlindspotTypes).toBe(3);
    expect(d.trust.provenance).toBe('offline_snapshot');
    expect(d.disclosure).toMatch(/lookupTo/);
  });

  it('includeLowSignal enumerates the grant/layout/scanner buckets too', async () => {
    const r = await retrieveBlindspotReportHandler(ctx, { includeLowSignal: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const buckets = new Set(r.value.data.blindspots.map((b) => b.bucket));
    expect(buckets.has('permission-grant')).toBe(true);
    expect(buckets.has('layout-reference')).toBe(true);
    expect(buckets.has('heuristic-unresolved')).toBe(true);
  });

  it('targetType filter narrows to one type', async () => {
    const r = await retrieveBlindspotReportHandler(ctx, { targetType: 'ApexClass' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.blindspots.map((b) => b.targetType)).toEqual(['ApexClass']);
  });

  it('coerces a stringified includeLowSignal boolean (MCP {} args)', () => {
    const parsed = retrieveBlindspotReportInputSchema.parse({ includeLowSignal: 'true' });
    expect(parsed.includeLowSignal).toBe(true);
  });
});
