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
import { appAccessHandler, type AppAccessGranterOutput, type AppAccessOutput } from '../../src/tools/app-access.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-08T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null, parentId: null, sourcePath: 'x.xml', lastModifiedDate: null,
  lastModifiedBy: null, apiVersion: null, properties: {}, ...o,
});
const edge = (o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>): Edge => ({
  confidence: 'declared', source: 'unit-test', properties: {}, ...o,
});

const APP = 'CustomApplication:Sales';
const seed: ExtractionResult = {
  nodes: [
    node({ id: APP, type: 'CustomApplication', apiName: 'Sales', label: 'Sales', properties: { navType: 'Standard' } }),
    node({ id: 'CustomTab:Account', type: 'CustomTab', apiName: 'Account' }),
    node({ id: 'CustomTab:Deals__c', type: 'CustomTab', apiName: 'Deals__c' }),
    node({ id: 'Profile:Admin', type: 'Profile', apiName: 'Admin', properties: {
      applicationVisibilities: [{ application: 'Sales', default: true, visible: true }],
    } }),
    node({ id: 'Profile:NoSales', type: 'Profile', apiName: 'NoSales', properties: {
      applicationVisibilities: [{ application: 'Sales', default: false, visible: false }],
    } }),
    node({ id: 'PermissionSet:SalesPS', type: 'PermissionSet', apiName: 'SalesPS', properties: {
      applicationVisibilities: [{ application: 'Sales', default: false, visible: true }],
    } }),
  ],
  edges: [
    edge({ fromId: 'CustomTab:Deals__c', toId: APP, edgeType: 'belongsToApp', properties: { ordinal: 1 } }),
    edge({ fromId: 'CustomTab:Account', toId: APP, edgeType: 'belongsToApp', properties: { ordinal: 0 } }),
  ],
};

let tempDir: string; let store: GraphStore; let ctx: Context;
beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-app-access-'));
  const o = await openGraph(join(tempDir, 'g.db')); if (!o.ok) throw new Error(o.error.message);
  store = o.value;
  const i = await importExtractionResults(store, [seed]); if (!i.ok) throw new Error(i.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});
afterAll(async () => { await closeGraph(store); rmSync(tempDir, { recursive: true, force: true }); });

describe('appAccessHandler', () => {
  it('rejects an id outside the app/granter contract', async () => {
    const r = await appAccessHandler(ctx, { componentId: 'Flow:Nope' });
    expect(r.ok).toBe(false); if (r.ok) return; expect(r.error.kind).toBe('invalid-query');
  });

  // P14-APP-default-reverse — the INVERSE direction.
  it('answers a Profile id with its openable apps and default app', async () => {
    const r = await appAccessHandler(ctx, { componentId: 'Profile:Admin' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data as AppAccessGranterOutput;
    expect(d.granterType).toBe('Profile');
    expect(d.openableApps).toEqual(['CustomApplication:Sales']);
    expect(d.defaultApp).toBe('CustomApplication:Sales');
  });

  it('a visible:false entry is NOT openable; no default → null', async () => {
    const r = await appAccessHandler(ctx, { componentId: 'Profile:NoSales' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data as AppAccessGranterOutput;
    expect(d.openableApps).toEqual([]);
    expect(d.defaultApp).toBeNull();
  });

  it('a granter WITHOUT the extracted property answers "not modeled", never a verified empty', async () => {
    await importExtractionResults(store, [{
      nodes: [node({ id: 'Profile:Legacy', type: 'Profile', apiName: 'Legacy', properties: {} })],
      edges: [],
    }]);
    const r = await appAccessHandler(ctx, { componentId: 'Profile:Legacy' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data as AppAccessGranterOutput;
    expect(d.openableApps).toEqual([]);
    expect(d.boundaryNote).toMatch(/not modeled/i);
  });

  it('rejects a PermissionSetGroup id with the honest union explanation', async () => {
    const r = await appAccessHandler(ctx, { componentId: 'PermissionSetGroup:Sales_PSG' });
    expect(r.ok).toBe(false); if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toMatch(/UNION of its member permission sets/);
  });
  it('returns component-not-found for an unknown app', async () => {
    const r = await appAccessHandler(ctx, { componentId: 'CustomApplication:Nope' });
    expect(r.ok).toBe(false); if (r.ok) return; expect(r.error.kind).toBe('component-not-found');
  });
  it('returns navType, tabs (ordinal order), who can open + who defaults', async () => {
    const r = await appAccessHandler(ctx, { componentId: APP });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data as AppAccessOutput;
    expect(d.navType).toBe('Standard');
    expect(d.tabs).toEqual(['CustomTab:Account', 'CustomTab:Deals__c']); // ordinal 0,1
    // Admin + SalesPS can open (visible:true); NoSales cannot (visible:false).
    expect(d.canOpen.map((g) => g.granterId).sort()).toEqual(['PermissionSet:SalesPS', 'Profile:Admin']);
    expect(d.defaultedBy).toEqual(['Profile:Admin']);
    expect(d.summary.tabs).toBe(2);
  });

  it('does NOT flag scanTruncated when the scan fits under the cap (P12-HONESTY-scan-cap-disclosure)', async () => {
    const r = await appAccessHandler(ctx, { componentId: APP });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect((r.value.data as AppAccessOutput).scanTruncated).toBe(false);
    expect(r.value.data.boundaryNote).not.toMatch(/Scan capped/);
  });

  it('flags scanTruncated + discloses it in boundaryNote when a grantor scan hits the cap', async () => {
    const prev = process.env['SFI_NODE_SCAN_LIMIT'];
    process.env['SFI_NODE_SCAN_LIMIT'] = '1'; // fixture has 2 Profiles -> the Profile scan hits the cap
    try {
      const r = await appAccessHandler(ctx, { componentId: APP });
      expect(r.ok).toBe(true); if (!r.ok) return;
      expect((r.value.data as AppAccessOutput).scanTruncated).toBe(true);
      expect(r.value.data.boundaryNote).toMatch(/Scan capped at 1 nodes per type/);
      expect(r.value.data.boundaryNote).toMatch(/Profile/);
    } finally {
      if (prev === undefined) delete process.env['SFI_NODE_SCAN_LIMIT'];
      else process.env['SFI_NODE_SCAN_LIMIT'] = prev;
    }
  });
});
