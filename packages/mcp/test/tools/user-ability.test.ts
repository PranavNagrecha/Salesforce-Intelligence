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
import { userAbilityHandler } from '../../src/tools/user-ability.js';

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

const seed: ExtractionResult = {
  nodes: [
    node({ id: 'Profile:Sales', type: 'Profile', apiName: 'Sales', properties: {
      userPermissions: ['RunReports', 'ExportReport', 'ApiEnabled', 'ManageUsers' /* admin, filtered out */],
      loginIpRanges: [{ startAddress: '10.0.0.1', endAddress: '10.0.0.255' }],
      loginHoursDefined: true,
    } }),
    node({ id: 'PermissionSet:FlowRunner', type: 'PermissionSet', apiName: 'FlowRunner', properties: { userPermissions: [] } }),
    node({ id: 'Flow:Onboard_Contact', type: 'Flow', apiName: 'Onboard_Contact' }),
  ],
  edges: [
    edge({ fromId: 'Profile:Sales', toId: 'Flow:Onboard_Contact', edgeType: 'grantedBy', properties: { flowAccess: true } }),
    edge({ fromId: 'PermissionSet:FlowRunner', toId: 'Flow:Onboard_Contact', edgeType: 'grantedBy', properties: { flowAccess: true } }),
  ],
};

let tempDir: string; let store: GraphStore; let ctx: Context;
beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-user-ability-'));
  const o = await openGraph(join(tempDir, 'g.db')); if (!o.ok) throw new Error(o.error.message);
  store = o.value;
  const i = await importExtractionResults(store, [seed]); if (!i.ok) throw new Error(i.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});
afterAll(async () => { await closeGraph(store); rmSync(tempDir, { recursive: true, force: true }); });

describe('userAbilityHandler', () => {
  it('rejects a non-Profile/PermissionSet id', async () => {
    const r = await userAbilityHandler(ctx, { componentId: 'CustomObject:Account' });
    expect(r.ok).toBe(false); if (r.ok) return; expect(r.error.kind).toBe('invalid-query');
  });

  it('returns runnable flows + action permissions + login restrictions for a profile', async () => {
    const r = await userAbilityHandler(ctx, { componentId: 'Profile:Sales' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.runnableFlows).toEqual(['Flow:Onboard_Contact']);
    // ManageUsers (admin) is filtered out; the action perms remain.
    expect(d.actionPermissions).toEqual(['ApiEnabled', 'ExportReport', 'RunReports']);
    expect(d.loginRestrictions.ipRangeCount).toBe(1);
    expect(d.loginRestrictions.loginHoursRestricted).toBe(true);
    expect(d.loginRestrictions.applies).toBe(true);
  });

  it('marks login restrictions not-applicable for a permission set', async () => {
    const r = await userAbilityHandler(ctx, { componentId: 'PermissionSet:FlowRunner' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.runnableFlows).toEqual(['Flow:Onboard_Contact']);
    expect(r.value.data.loginRestrictions.applies).toBe(false);
  });

  it('component-not-found for an unknown id', async () => {
    const r = await userAbilityHandler(ctx, { componentId: 'Profile:Ghost' });
    expect(r.ok).toBe(false); if (r.ok) return; expect(r.error.kind).toBe('component-not-found');
  });
});
