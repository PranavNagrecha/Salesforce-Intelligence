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
  effectivePermissionsHandler,
  effectivePermissionsInputSchema,
} from '../../src/tools/effective-permissions.js';

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

// Profile grants Account read; a PermissionSet ADDS Account edit + a system
// perm + a field + an apex class. The union must exceed either container.
const seed: ExtractionResult = {
  nodes: [
    node({
      id: 'Profile:Sales',
      type: 'Profile',
      apiName: 'Sales',
      properties: {
        userPermissions: ['ApiEnabled'],
        // RT parity: profile sees Standard_Deal, explicitly HIDES Archived_Deal.
        recordTypeVisibilities: [
          { recordType: 'Deal__c.Standard_Deal', visible: true, default: true },
          { recordType: 'Deal__c.Archived_Deal', visible: false, default: false },
        ],
      },
    }),
    node({
      id: 'PermissionSet:DealEditor',
      type: 'PermissionSet',
      apiName: 'DealEditor',
      properties: {
        userPermissions: ['ViewAllData'],
        // Adds Enterprise_Deal, re-grants Archived_Deal (visible=true must win),
        // and carries an older-metadata entry with visible:null (counts visible).
        recordTypeVisibilities: [
          { recordType: 'Deal__c.Enterprise_Deal', visible: true, default: false },
          { recordType: 'Deal__c.Archived_Deal', visible: true, default: false },
          { recordType: 'Deal__c.Legacy_Deal', visible: null, default: false },
        ],
      },
    }),
    // A permission set from a vault refreshed BEFORE record-type extraction —
    // no recordTypeVisibilities key at all (contributes nothing, disclosed).
    node({ id: 'PermissionSet:LegacyNoRt', type: 'PermissionSet', apiName: 'LegacyNoRt', properties: {} }),
    node({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
    node({ id: 'CustomField:Account.Amount__c', type: 'CustomField', apiName: 'Account.Amount__c' }),
    node({ id: 'ApexClass:DealService', type: 'ApexClass', apiName: 'DealService' }),
    // CR-CAP-10: a defined CustomPermission; the managed-package one below has no node.
    node({ id: 'CustomPermission:SkipValidation', type: 'CustomPermission', apiName: 'SkipValidation' }),
  ],
  edges: [
    edge({ fromId: 'Profile:Sales', toId: 'CustomObject:Account', edgeType: 'grantedBy', properties: { allowRead: true } }),
    edge({ fromId: 'PermissionSet:DealEditor', toId: 'CustomObject:Account', edgeType: 'grantedBy', properties: { allowRead: true, allowEdit: true } }),
    edge({ fromId: 'PermissionSet:DealEditor', toId: 'CustomField:Account.Amount__c', edgeType: 'grantedBy', properties: { readable: true, editable: true } }),
    edge({ fromId: 'PermissionSet:DealEditor', toId: 'ApexClass:DealService', edgeType: 'grantedBy', properties: {} }),
    edge({ fromId: 'Profile:Sales', toId: 'CustomPermission:SkipValidation', edgeType: 'grantedBy', properties: { enabled: true } }),
    edge({ fromId: 'PermissionSet:DealEditor', toId: 'CustomPermission:APXTConga4__Composer_Custom_Permission', edgeType: 'grantedBy', properties: { enabled: true } }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-effective-perms-'));
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

describe('effectivePermissionsHandler', () => {
  it('rejects when no container is supplied', () => {
    const parsed = effectivePermissionsInputSchemaSafe({});
    expect(parsed).toBe(false);
  });

  it('unions object permissions across profile + permission set (max-wins) with attribution', async () => {
    const r = await effectivePermissionsHandler(ctx, {
      profileId: 'Profile:Sales',
      permissionSetIds: ['PermissionSet:DealEditor'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const acct = r.value.data.objectPermissions.find((o) => o.object === 'Account');
    // Union: Sales gives read, DealEditor adds edit → both true.
    expect(acct?.allowRead).toBe(true);
    expect(acct?.allowEdit).toBe(true);
    // Cited to BOTH containers (both grant a flag).
    expect(acct?.grantedBy).toEqual(['PermissionSet:DealEditor', 'Profile:Sales']);
  });

  it('union exceeds either single container (edit only from the permission set)', async () => {
    const profileOnly = await effectivePermissionsHandler(ctx, { profileId: 'Profile:Sales' });
    expect(profileOnly.ok).toBe(true);
    if (!profileOnly.ok) return;
    const acctProfile = profileOnly.value.data.objectPermissions.find((o) => o.object === 'Account');
    expect(acctProfile?.allowEdit).toBe(false); // profile alone cannot edit
  });

  it('unions system permissions and summarises fields + apex', async () => {
    const r = await effectivePermissionsHandler(ctx, {
      profileId: 'Profile:Sales',
      permissionSetIds: ['PermissionSet:DealEditor'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sysPerms = r.value.data.systemPermissions.map((s) => s.permission).sort();
    expect(sysPerms).toEqual(['ApiEnabled', 'ViewAllData']);
    expect(r.value.data.summary.fieldsWithFls).toBe(1);
    expect(r.value.data.summary.apexClasses).toBe(1);
  });

  it('always discloses the PSG / app-tab / record-access boundaries', async () => {
    const r = await effectivePermissionsHandler(ctx, { profileId: 'Profile:Sales' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.confidence).toBe('declared');
    expect(r.value.data.disclosures.some((d) => d.includes('GROUP membership'))).toBe(true);
    expect(r.value.data.disclosures.some((d) => d.includes('App and tab'))).toBe(true);
  });

  // CR-CAP-10: custom permissions are unioned with per-container attribution and
  // targetMissing disclosure; they are NOT folded into systemPermissions.
  it('unions granted custom permissions with attribution + targetMissing, distinct from system perms', async () => {
    const r = await effectivePermissionsHandler(ctx, {
      profileId: 'Profile:Sales',
      permissionSetIds: ['PermissionSet:DealEditor'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cps = r.value.data.customPermissions;
    expect(cps).toEqual([
      { name: 'APXTConga4__Composer_Custom_Permission', targetMissing: true, grantedBy: ['PermissionSet:DealEditor'] },
      { name: 'SkipValidation', targetMissing: false, grantedBy: ['Profile:Sales'] },
    ]);
    expect(r.value.data.summary.customPermissions).toBe(2);
    // Not double-counted into systemPermissions.
    const sys = r.value.data.systemPermissions.map((s) => s.permission);
    expect(sys).not.toContain('SkipValidation');
    expect(sys).not.toContain('APXTConga4__Composer_Custom_Permission');
    // Disclosure surfaces the granted-but-undefined name.
    expect(r.value.data.disclosures.some((d) => d.includes('not present in this vault'))).toBe(true);
  });

  // RT parity: record-type visibilities are unioned max-wins with per-container
  // attribution, mirroring the customPermissions pattern.
  it('unions record-type visibilities across profile + permission set (visible=true wins) with attribution', async () => {
    const r = await effectivePermissionsHandler(ctx, {
      profileId: 'Profile:Sales',
      permissionSetIds: ['PermissionSet:DealEditor'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.recordTypeVisibilities).toEqual([
      // Profile hides it, permission set grants it → visible wins, cited to the granter only.
      { recordType: 'Deal__c.Archived_Deal', visible: true, grantedBy: ['PermissionSet:DealEditor'] },
      { recordType: 'Deal__c.Enterprise_Deal', visible: true, grantedBy: ['PermissionSet:DealEditor'] },
      // `<visible>` null (older metadata) counts as visible — only explicit false hides.
      { recordType: 'Deal__c.Legacy_Deal', visible: true, grantedBy: ['PermissionSet:DealEditor'] },
      { recordType: 'Deal__c.Standard_Deal', visible: true, grantedBy: ['Profile:Sales'] },
    ]);
    expect(r.value.data.summary.recordTypeVisibilities).toBe(4);
  });

  it('a lone container that hides a record type yields visible:false with no granter cited', async () => {
    const r = await effectivePermissionsHandler(ctx, { profileId: 'Profile:Sales' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const archived = r.value.data.recordTypeVisibilities.find((v) => v.recordType === 'Deal__c.Archived_Deal');
    expect(archived).toEqual({ recordType: 'Deal__c.Archived_Deal', visible: false, grantedBy: [] });
  });

  it('a container WITHOUT the recordTypeVisibilities property contributes nothing and is disclosed (older vault)', async () => {
    const r = await effectivePermissionsHandler(ctx, {
      profileId: 'Profile:Sales',
      permissionSetIds: ['PermissionSet:LegacyNoRt'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Only the profile's record types — LegacyNoRt contributes nothing, no throw.
    expect(r.value.data.recordTypeVisibilities.map((v) => v.recordType)).toEqual([
      'Deal__c.Archived_Deal',
      'Deal__c.Standard_Deal',
    ]);
    expect(
      r.value.data.disclosures.some(
        (d) => d.includes('recordTypeVisibilities') && d.includes('PermissionSet:LegacyNoRt') && d.includes('/sfi-refresh'),
      ),
    ).toBe(true);
  });

  it('does NOT emit the missing-RT-data disclosure when every container carries the property', async () => {
    const r = await effectivePermissionsHandler(ctx, {
      profileId: 'Profile:Sales',
      permissionSetIds: ['PermissionSet:DealEditor'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disclosures.some((d) => d.includes('no extracted `recordTypeVisibilities`'))).toBe(false);
  });

  it('returns component-not-found when no container exists', async () => {
    const r = await effectivePermissionsHandler(ctx, { profileId: 'Profile:Ghost' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });
});

describe('effectivePermissionsHandler — CR-22 section cursor', () => {
  let dir: string;
  let st: GraphStore;
  let cx: Context;

  // A PermissionSet granting read on FIVE objects so the object list can page.
  const objs = ['Acct', 'Bus', 'Cse', 'Deal', 'Evt'];
  const multiSeed: ExtractionResult = {
    nodes: [
      node({ id: 'PermissionSet:Many', type: 'PermissionSet', apiName: 'Many', properties: { userPermissions: ['ApiEnabled'] } }),
      node({ id: 'PermissionSet:Other', type: 'PermissionSet', apiName: 'Other', properties: {} }),
      ...objs.map((o) => node({ id: `CustomObject:${o}`, type: 'CustomObject', apiName: o })),
    ],
    edges: [
      ...objs.map((o) =>
        edge({ fromId: 'PermissionSet:Many', toId: `CustomObject:${o}`, edgeType: 'grantedBy', properties: { allowRead: true } }),
      ),
      edge({ fromId: 'PermissionSet:Other', toId: 'CustomObject:Acct', edgeType: 'grantedBy', properties: { allowRead: true } }),
    ],
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-eff-perms-cursor-'));
    const opened = await openGraph(join(dir, 'g.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    st = opened.value;
    const imported = await importExtractionResults(st, [multiSeed]);
    if (!imported.ok) throw new Error(imported.error.message);
    cx = { vaultRoot: dir, manifest: MANIFEST, graph: st };
  });
  afterAll(async () => {
    await closeGraph(st);
    rmSync(dir, { recursive: true, force: true });
  });

  it('whole-fits omits cursor block (byte-identical golden)', async () => {
    const r = await effectivePermissionsHandler(cx, { permissionSetIds: ['PermissionSet:Many'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('nextCursor' in r.value.data).toBe(false);
    expect('pageInfo' in r.value.data).toBe(false);
    expect('otherSections' in r.value.data).toBe(false);
    expect(r.value.data.truncated).toBe(false);
    expect(r.value.data.objectPermissions.length).toBe(5);
  });

  it('paging the object list emits nextCursor + discloses the system list', async () => {
    const r = await effectivePermissionsHandler(cx, { permissionSetIds: ['PermissionSet:Many'], limit: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.objectPermissions.length).toBe(2);
    expect(r.value.data.truncated).toBe(true);
    expect(r.value.data.nextCursor).toBeDefined();
    expect(r.value.data.designatedList).toBe('object');
    const others = r.value.data.otherSections ?? [];
    const sys = others.find((s) => s.listId === 'system');
    expect(sys?.totalCount).toBe(1); // ApiEnabled
    // summary still holds the full object count.
    expect(r.value.data.summary.objects).toBe(5);
  });

  it('resume walks the object list with no dup/skip', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i += 1) {
      const r = await effectivePermissionsHandler(cx, {
        permissionSetIds: ['PermissionSet:Many'],
        limit: 2,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      for (const o of r.value.data.objectPermissions) seen.push(o.object);
      cursor = r.value.data.nextCursor;
      if (cursor === undefined) break;
    }
    expect([...seen].sort()).toEqual(objs.slice().sort());
  });

  it('rejects a cursor minted for different containers', async () => {
    const p1 = await effectivePermissionsHandler(cx, { permissionSetIds: ['PermissionSet:Many'], limit: 2 });
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    const cursor = p1.value.data.nextCursor!;
    const stale = await effectivePermissionsHandler(cx, { permissionSetIds: ['PermissionSet:Other'], cursor, limit: 2 });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.kind).toBe('invalid-query');
  });
});

/** Assert the at-least-one-container refine without pulling zod in directly. */
function effectivePermissionsInputSchemaSafe(input: unknown): boolean {
  return effectivePermissionsInputSchema.safeParse(input).success;
}
