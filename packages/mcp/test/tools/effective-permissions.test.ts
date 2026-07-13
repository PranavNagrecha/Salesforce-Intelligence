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

// ===========================================================================
// R6-06 — MUTING permission sets are SUBTRACTED, group-scoped, with mutedBy.
// A PSG with 2 members + 1 muting set. Mute denies: Account Delete, SSN FLS
// (both directions), ModifyAllData, SkipValidation (custom), DangerService
// (apex). A grant that survives OUTSIDE the group (profile ModifyAllData,
// Account Edit) is NOT muted; a second, non-muted group's grant survives too.
// ===========================================================================
describe('effectivePermissionsHandler — R6-06 muting subtraction', () => {
  let dir: string;
  let st: GraphStore;
  let cx: Context;

  const seed: ExtractionResult = {
    nodes: [
      // Profile grants Account EDIT + ModifyAllData OUTSIDE any group — these
      // must survive the group's mute (muting is group-scoped).
      node({
        id: 'Profile:P',
        type: 'Profile',
        apiName: 'P',
        properties: { userPermissions: ['ModifyAllData'] },
      }),
      // Group members.
      node({ id: 'PermissionSet:M1', type: 'PermissionSet', apiName: 'M1', properties: { userPermissions: ['ModifyAllData'] } }),
      node({ id: 'PermissionSet:M2', type: 'PermissionSet', apiName: 'M2', properties: {} }),
      node({ id: 'PermissionSet:M3', type: 'PermissionSet', apiName: 'M3', properties: {} }),
      // The muting set — R6-06 muted-perm node properties.
      node({
        id: 'MutingPermissionSet:Mute',
        type: 'MutingPermissionSet',
        apiName: 'Mute',
        properties: {
          mutedObjectPermissions: [
            { object: 'Account', allowCreate: false, allowRead: false, allowEdit: false, allowDelete: true, viewAllRecords: false, modifyAllRecords: false },
          ],
          mutedFieldPermissions: [{ field: 'Account.SSN__c', readable: true, editable: true }],
          mutedUserPermissions: ['ModifyAllData'],
          mutedCustomPermissions: ['SkipValidation'],
          mutedApexClasses: ['DangerService'],
        },
      }),
      node({
        id: 'PermissionSetGroup:G',
        type: 'PermissionSetGroup',
        apiName: 'G',
        properties: { permissionSets: ['M1', 'M2'], mutingPermissionSets: ['Mute'] },
      }),
      // A SECOND group with no muting — its grant must survive intact.
      node({
        id: 'PermissionSetGroup:G2',
        type: 'PermissionSetGroup',
        apiName: 'G2',
        properties: { permissionSets: ['M3'] },
      }),
      node({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
      node({ id: 'CustomObject:Widget', type: 'CustomObject', apiName: 'Widget' }),
      node({ id: 'CustomObject:Contact', type: 'CustomObject', apiName: 'Contact' }),
      node({ id: 'CustomField:Account.SSN__c', type: 'CustomField', apiName: 'Account.SSN__c' }),
      node({ id: 'CustomField:Account.Name', type: 'CustomField', apiName: 'Account.Name' }),
      node({ id: 'ApexClass:DangerService', type: 'ApexClass', apiName: 'DangerService' }),
      node({ id: 'ApexClass:SafeService', type: 'ApexClass', apiName: 'SafeService' }),
      node({ id: 'CustomPermission:OtherPerm', type: 'CustomPermission', apiName: 'OtherPerm' }),
    ],
    edges: [
      // Profile grants Account EDIT only.
      edge({ fromId: 'Profile:P', toId: 'CustomObject:Account', edgeType: 'grantedBy', properties: { allowEdit: true } }),
      // M1: broad Account grant + FLS + custom + apex.
      edge({ fromId: 'PermissionSet:M1', toId: 'CustomObject:Account', edgeType: 'grantedBy', properties: { allowRead: true, allowEdit: true, allowDelete: true } }),
      edge({ fromId: 'PermissionSet:M1', toId: 'CustomField:Account.SSN__c', edgeType: 'grantedBy', properties: { readable: true, editable: true } }),
      edge({ fromId: 'PermissionSet:M1', toId: 'CustomField:Account.Name', edgeType: 'grantedBy', properties: { readable: true } }),
      edge({ fromId: 'PermissionSet:M1', toId: 'CustomPermission:SkipValidation', edgeType: 'grantedBy', properties: { enabled: true } }),
      edge({ fromId: 'PermissionSet:M1', toId: 'CustomPermission:OtherPerm', edgeType: 'grantedBy', properties: { enabled: true } }),
      edge({ fromId: 'PermissionSet:M1', toId: 'ApexClass:DangerService', edgeType: 'grantedBy', properties: {} }),
      // M2: Widget read + a safe apex class (not muted).
      edge({ fromId: 'PermissionSet:M2', toId: 'CustomObject:Widget', edgeType: 'grantedBy', properties: { allowRead: true } }),
      edge({ fromId: 'PermissionSet:M2', toId: 'ApexClass:SafeService', edgeType: 'grantedBy', properties: {} }),
      // M3 (2nd group): Contact read — survives (no muting on G2).
      edge({ fromId: 'PermissionSet:M3', toId: 'CustomObject:Contact', edgeType: 'grantedBy', properties: { allowRead: true } }),
      // PSG membership + muting reference edges.
      edge({ fromId: 'PermissionSetGroup:G', toId: 'PermissionSet:M1', edgeType: 'references', properties: { referenceKind: 'permissionSetGroupMember' } }),
      edge({ fromId: 'PermissionSetGroup:G', toId: 'PermissionSet:M2', edgeType: 'references', properties: { referenceKind: 'permissionSetGroupMember' } }),
      edge({ fromId: 'PermissionSetGroup:G', toId: 'MutingPermissionSet:Mute', edgeType: 'references', properties: { referenceKind: 'mutingPermissionSet' } }),
      edge({ fromId: 'PermissionSetGroup:G2', toId: 'PermissionSet:M3', edgeType: 'references', properties: { referenceKind: 'permissionSetGroupMember' } }),
    ],
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-eff-perms-muting-'));
    const opened = await openGraph(join(dir, 'g.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    st = opened.value;
    const imported = await importExtractionResults(st, [seed]);
    if (!imported.ok) throw new Error(imported.error.message);
    cx = { vaultRoot: dir, manifest: MANIFEST, graph: st };
  });
  afterAll(async () => {
    await closeGraph(st);
    rmSync(dir, { recursive: true, force: true });
  });

  it('subtracts a muted object flag inside the group and cites mutedBy', async () => {
    const r = await effectivePermissionsHandler(cx, { profileId: 'Profile:P', permissionSetIds: ['PermissionSetGroup:G'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const acct = r.value.data.objectPermissions.find((o) => o.object === 'Account');
    // Read survives via the group member; Edit survives (member + profile);
    // Delete is muted inside the group and the profile does NOT grant it → gone.
    expect(acct?.allowRead).toBe(true);
    expect(acct?.allowEdit).toBe(true);
    expect(acct?.allowDelete).toBe(false);
    // Delete no longer attributed; the muting set is cited.
    expect(acct?.grantedBy).toEqual(['PermissionSet:M1', 'Profile:P']);
    expect(acct?.mutedBy).toEqual(['MutingPermissionSet:Mute']);
  });

  it('a grant that survives OUTSIDE the group (profile Edit) is never muted', async () => {
    const r = await effectivePermissionsHandler(cx, { profileId: 'Profile:P', permissionSetIds: ['PermissionSetGroup:G'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // System perm ModifyAllData is muted in the group but granted by the
    // profile OUTSIDE it → survives, annotated with mutedBy.
    const mad = r.value.data.systemPermissions.find((s) => s.permission === 'ModifyAllData');
    expect(mad).toBeDefined();
    expect(mad?.grantedBy).toEqual(['Profile:P']);
    expect(mad?.mutedBy).toEqual(['MutingPermissionSet:Mute']);
  });

  it('subtracts muted FLS (both directions) so the field drops from the count', async () => {
    const r = await effectivePermissionsHandler(cx, { profileId: 'Profile:P', permissionSetIds: ['PermissionSetGroup:G'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // SSN read+edit both muted → removed; Account.Name (readable, not muted) stays.
    expect(r.value.data.summary.fieldsWithFls).toBe(1);
  });

  it('removes a fully-muted custom permission and Apex class entirely', async () => {
    const r = await effectivePermissionsHandler(cx, { profileId: 'Profile:P', permissionSetIds: ['PermissionSetGroup:G'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // SkipValidation muted (nothing else grants it) → not listed; OtherPerm stays.
    expect(r.value.data.customPermissions.map((c) => c.name)).toEqual(['OtherPerm']);
    // DangerService apex muted; SafeService survives → count is 1.
    expect(r.value.data.summary.apexClasses).toBe(1);
  });

  it('a second, non-muted group confers its grant intact', async () => {
    const r = await effectivePermissionsHandler(cx, {
      permissionSetIds: ['PermissionSetGroup:G', 'PermissionSetGroup:G2'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const contact = r.value.data.objectPermissions.find((o) => o.object === 'Contact');
    expect(contact?.allowRead).toBe(true);
    expect(contact?.grantedBy).toEqual(['PermissionSet:M3']);
    // No muting on G2 → no mutedBy on Contact.
    expect(contact && 'mutedBy' in contact).toBe(false);
  });

  it('discloses that muting was applied and names the removed-entirely perms', async () => {
    const r = await effectivePermissionsHandler(cx, { profileId: 'Profile:P', permissionSetIds: ['PermissionSetGroup:G'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const applied = r.value.data.disclosures.find((d) => /muting applied/i.test(d));
    expect(applied).toBeDefined();
    expect(applied).toContain('MutingPermissionSet:Mute');
    // SkipValidation (custom) removed entirely; ModifyAllData survived via profile.
    expect(applied).toMatch(/1 custom permission\(s\) removed entirely/);
    // No "not applied" disclosure — the muting node carries muted-perm data.
    expect(r.value.data.disclosures.some((d) => /Muting NOT applied/i.test(d))).toBe(false);
  });

  it('a muting node WITHOUT muted-perm data cannot be subtracted and is disclosed', async () => {
    // Simulate a vault refreshed before the R6-06 extractor: the muting node
    // exists but carries no muted-perm properties. Its perms must NOT be
    // subtracted and the OVERSTATEMENT risk must be disclosed.
    const legacyDir = mkdtempSync(join(tmpdir(), 'sfi-eff-perms-muting-legacy-'));
    const opened = await openGraph(join(legacyDir, 'g.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    const store = opened.value;
    const legacySeed: ExtractionResult = {
      nodes: [
        node({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
        node({ id: 'PermissionSet:M1', type: 'PermissionSet', apiName: 'M1' }),
        // Old-format muting node: no muted* properties.
        node({ id: 'MutingPermissionSet:Old', type: 'MutingPermissionSet', apiName: 'Old' }),
        node({
          id: 'PermissionSetGroup:G',
          type: 'PermissionSetGroup',
          apiName: 'G',
          properties: { permissionSets: ['M1'], mutingPermissionSets: ['Old'] },
        }),
      ],
      edges: [
        edge({ fromId: 'PermissionSet:M1', toId: 'CustomObject:Account', edgeType: 'grantedBy', properties: { allowRead: true, allowEdit: true } }),
        edge({ fromId: 'PermissionSetGroup:G', toId: 'PermissionSet:M1', edgeType: 'references', properties: { referenceKind: 'permissionSetGroupMember' } }),
        edge({ fromId: 'PermissionSetGroup:G', toId: 'MutingPermissionSet:Old', edgeType: 'references', properties: { referenceKind: 'mutingPermissionSet' } }),
      ],
    };
    const imported = await importExtractionResults(store, [legacySeed]);
    if (!imported.ok) throw new Error(imported.error.message);
    const legacyCtx: Context = { vaultRoot: legacyDir, manifest: MANIFEST, graph: store };
    try {
      const r = await effectivePermissionsHandler(legacyCtx, { permissionSetIds: ['PermissionSetGroup:G'] });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // Perms fully present (nothing subtracted).
      const acct = r.value.data.objectPermissions.find((o) => o.object === 'Account');
      expect(acct?.allowRead).toBe(true);
      expect(acct?.allowEdit).toBe(true);
      // Disclosed: cannot apply, may be overstated, re-run /sfi-refresh.
      const notApplied = r.value.data.disclosures.find((d) => /Muting NOT applied/i.test(d));
      expect(notApplied).toBeDefined();
      expect(notApplied).toContain('MutingPermissionSet:Old');
      expect(notApplied).toMatch(/not subtracted/i);
      expect(notApplied).toMatch(/sfi-refresh/);
    } finally {
      await closeGraph(store);
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});

/** Assert the at-least-one-container refine without pulling zod in directly. */
function effectivePermissionsInputSchemaSafe(input: unknown): boolean {
  return effectivePermissionsInputSchema.safeParse(input).success;
}
