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
    // CR-CAP-10: a defined CustomPermission (resolves) and a permset granting
    // both it and a managed-package perm with no definition (targetMissing).
    node({ id: 'CustomPermission:SkipValidation', type: 'CustomPermission', apiName: 'SkipValidation' }),
    node({ id: 'PermissionSet:CustomPerms', type: 'PermissionSet', apiName: 'CustomPerms', properties: { userPermissions: [] } }),
    // A profile that grants run access to THREE flows — used to exercise the
    // CR-22 cursor over the paged runnableFlows list.
    node({ id: 'Profile:MultiFlow', type: 'Profile', apiName: 'MultiFlow', properties: { userPermissions: [] } }),
    node({ id: 'Flow:Alpha', type: 'Flow', apiName: 'Alpha' }),
    node({ id: 'Flow:Beta', type: 'Flow', apiName: 'Beta' }),
    node({ id: 'Flow:Gamma', type: 'Flow', apiName: 'Gamma' }),
  ],
  edges: [
    edge({ fromId: 'Profile:Sales', toId: 'Flow:Onboard_Contact', edgeType: 'grantedBy', properties: { flowAccess: true } }),
    edge({ fromId: 'PermissionSet:FlowRunner', toId: 'Flow:Onboard_Contact', edgeType: 'grantedBy', properties: { flowAccess: true } }),
    edge({ fromId: 'Profile:MultiFlow', toId: 'Flow:Alpha', edgeType: 'grantedBy', properties: { flowAccess: true } }),
    edge({ fromId: 'Profile:MultiFlow', toId: 'Flow:Beta', edgeType: 'grantedBy', properties: { flowAccess: true } }),
    edge({ fromId: 'Profile:MultiFlow', toId: 'Flow:Gamma', edgeType: 'grantedBy', properties: { flowAccess: true } }),
    edge({ fromId: 'PermissionSet:CustomPerms', toId: 'CustomPermission:SkipValidation', edgeType: 'grantedBy', properties: { enabled: true } }),
    edge({ fromId: 'PermissionSet:CustomPerms', toId: 'CustomPermission:APXTConga4__Composer_Custom_Permission', edgeType: 'grantedBy', properties: { enabled: true } }),
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
    // The full IP-range windows are now surfaced structurally (not just counted).
    expect(d.loginRestrictions.ipRanges).toEqual([{ startAddress: '10.0.0.1', endAddress: '10.0.0.255' }]);
    // Login-hours windows are deferred behind the SessionSettings tier — always empty.
    expect(d.loginRestrictions.loginHours).toEqual([]);
  });

  it('marks login restrictions not-applicable for a permission set', async () => {
    const r = await userAbilityHandler(ctx, { componentId: 'PermissionSet:FlowRunner' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.runnableFlows).toEqual(['Flow:Onboard_Contact']);
    expect(r.value.data.loginRestrictions.applies).toBe(false);
    // A permission set carries no login security → empty structured lists.
    expect(r.value.data.loginRestrictions.ipRanges).toEqual([]);
    expect(r.value.data.loginRestrictions.loginHours).toEqual([]);
  });

  it('component-not-found for an unknown id', async () => {
    const r = await userAbilityHandler(ctx, { componentId: 'Profile:Ghost' });
    expect(r.ok).toBe(false); if (r.ok) return; expect(r.error.kind).toBe('component-not-found');
  });

  // CR-CAP-10: user_ability now surfaces granted custom permissions, marking a
  // managed-package grant whose definition is not in the vault as targetMissing.
  it('surfaces granted custom permissions, flagging the one with no definition as targetMissing', async () => {
    const r = await userAbilityHandler(ctx, { componentId: 'PermissionSet:CustomPerms' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.customPermissions).toEqual([
      { name: 'APXTConga4__Composer_Custom_Permission', targetMissing: true },
      { name: 'SkipValidation', targetMissing: false },
    ]);
    expect(d.summary.customPermissions).toBe(2);
    // The disclosure must call out the granted-but-undefined name (not drop it).
    expect(d.boundaryNote).toContain('not present in this vault');
  });

  it('reports zero custom permissions cleanly for a container that grants none', async () => {
    const r = await userAbilityHandler(ctx, { componentId: 'Profile:Sales' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.customPermissions).toEqual([]);
    expect(r.value.data.summary.customPermissions).toBe(0);
  });
});

describe('userAbilityHandler — CR-22 continuation cursor', () => {
  it('in-budget whole-fits call emits NO cursor/pageInfo (byte-identical)', async () => {
    const r = await userAbilityHandler(ctx, { componentId: 'Profile:MultiFlow' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.runnableFlows.length).toBe(3);
    expect('nextCursor' in d).toBe(false);
    expect('pageInfo' in d).toBe(false);
    expect(d.truncated).toBe(false);
    expect(d.hasMore).toBe(false);
    // The golden shape: runnableFlows stays a bare ComponentId[] string array.
    expect(d.runnableFlows).toEqual(['Flow:Alpha', 'Flow:Beta', 'Flow:Gamma']);
  });

  it('a truncated (over-limit) page emits a nextCursor that resumes with no gaps/dupes', async () => {
    const first = await userAbilityHandler(ctx, { componentId: 'Profile:MultiFlow', limit: 2 });
    expect(first.ok).toBe(true); if (!first.ok) return;
    const d1 = first.value.data;
    expect(d1.runnableFlows.length).toBe(2);
    expect(d1.hasMore).toBe(true);
    expect(typeof d1.nextCursor).toBe('string');
    expect(d1.pageInfo?.nextCursor).toBe(d1.nextCursor);

    const second = await userAbilityHandler(ctx, {
      componentId: 'Profile:MultiFlow',
      limit: 2,
      cursor: d1.nextCursor as string,
    });
    expect(second.ok).toBe(true); if (!second.ok) return;
    const d2 = second.value.data;
    expect(d2.runnableFlows.length).toBe(1);
    expect(d2.hasMore).toBe(false);
    expect('nextCursor' in d2).toBe(false);

    const combined = [...d1.runnableFlows, ...d2.runnableFlows];
    expect(new Set(combined).size).toBe(3); // no dupes
    expect([...combined].sort()).toEqual(['Flow:Alpha', 'Flow:Beta', 'Flow:Gamma']); // no gaps
  });

  it('rejects a cursor minted for a DIFFERENT componentId', async () => {
    const first = await userAbilityHandler(ctx, { componentId: 'Profile:MultiFlow', limit: 2 });
    expect(first.ok).toBe(true); if (!first.ok) return;
    const cursor = first.value.data.nextCursor as string;
    const replay = await userAbilityHandler(ctx, { componentId: 'Profile:Sales', cursor });
    expect(replay.ok).toBe(false); if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });

  it('rejects a malformed / forged cursor string', async () => {
    const replay = await userAbilityHandler(ctx, {
      componentId: 'Profile:MultiFlow',
      cursor: 'not-a-real-cursor',
    });
    expect(replay.ok).toBe(false); if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });
});
