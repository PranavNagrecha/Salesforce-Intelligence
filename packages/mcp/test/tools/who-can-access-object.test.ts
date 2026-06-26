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
import { whoCanAccessObjectHandler } from '../../src/tools/who-can-access-object.js';

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

const OBJ = 'CustomObject:Deal__c';

// Private object: Admin has Modify All; ReadOnly PS has object read; God profile
// has ModifyAllData; an owner sharing rule shares to a public group.
const seed: ExtractionResult = {
  nodes: [
    node({ id: OBJ, type: 'CustomObject', apiName: 'Deal__c', label: 'Deal', properties: { sharingModel: 'Private' } }),
    node({ id: 'Profile:Admin', type: 'Profile', apiName: 'Admin' }),
    node({ id: 'PermissionSet:Reader', type: 'PermissionSet', apiName: 'Reader' }),
    node({ id: 'Profile:God', type: 'Profile', apiName: 'God', properties: { userPermissions: ['ModifyAllData'] } }),
    node({ id: 'Profile:Viewer', type: 'Profile', apiName: 'Viewer', properties: { userPermissions: ['ViewAllData'] } }),
    // CR-04: a grantor with object Delete and one with object Create — both
    // dropped by the old exclusive else-if chain (Delete was NEVER read).
    node({ id: 'Profile:Deleter', type: 'Profile', apiName: 'Deleter' }),
    node({ id: 'PermissionSet:Creator', type: 'PermissionSet', apiName: 'Creator' }),
    node({ id: 'SharingRule:Deal__c.Share_To_Sales', type: 'SharingRule', apiName: 'Deal__c.Share_To_Sales', properties: { ruleType: 'owner', accessLevel: 'Edit', sObjectType: 'Deal__c' } }),
    node({ id: 'Group:Sales_Public', type: 'Group', apiName: 'Sales_Public' }),
  ],
  edges: [
    edge({ fromId: 'Profile:Admin', toId: OBJ, edgeType: 'grantedBy', properties: { allowRead: true, allowEdit: true, modifyAllRecords: true } }),
    edge({ fromId: 'PermissionSet:Reader', toId: OBJ, edgeType: 'grantedBy', properties: { allowRead: true } }),
    edge({ fromId: 'Profile:Deleter', toId: OBJ, edgeType: 'grantedBy', properties: { allowRead: true, allowDelete: true } }),
    edge({ fromId: 'PermissionSet:Creator', toId: OBJ, edgeType: 'grantedBy', properties: { allowCreate: true } }),
    edge({ fromId: 'SharingRule:Deal__c.Share_To_Sales', toId: 'Group:Sales_Public', edgeType: 'sharedWith' }),
  ],
};

// A second, PUBLIC object to test the OWD-grants-all branch.
const PUBLIC_OBJ = 'CustomObject:Memo__c';
const publicSeed: ExtractionResult = {
  nodes: [node({ id: PUBLIC_OBJ, type: 'CustomObject', apiName: 'Memo__c', properties: { sharingModel: 'ReadWrite' } })],
  edges: [],
};

// A third object carrying a RestrictionRule: god-mode rows must gain the
// narrowing caveat and blindSpots the restriction entry (mirrors why_cant's
// `unknown` god-mode verdict on restricted objects).
const RESTRICTED_OBJ = 'CustomObject:Vault_Case__c';
const restrictedSeed: ExtractionResult = {
  nodes: [
    node({ id: RESTRICTED_OBJ, type: 'CustomObject', apiName: 'Vault_Case__c', properties: { sharingModel: 'Private' } }),
    node({ id: 'RestrictionRule:Vault_Case__c.Hide_Foreign', type: 'RestrictionRule', apiName: 'Vault_Case__c.Hide_Foreign', parentId: RESTRICTED_OBJ }),
  ],
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-who-can-access-'));
  const opened = await openGraph(join(tempDir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed, publicSeed, restrictedSeed]);
  if (!imported.ok) throw new Error(imported.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('whoCanAccessObjectHandler', () => {
  it('rejects a non-CustomObject componentId with invalid-query', async () => {
    const r = await whoCanAccessObjectHandler(ctx, { componentId: 'Profile:Admin' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('returns component-not-found for an unknown object', async () => {
    const r = await whoCanAccessObjectHandler(ctx, { componentId: 'CustomObject:Nope__c' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('enumerates object-permission, god-mode, and sharing-rule access paths', async () => {
    const r = await whoCanAccessObjectHandler(ctx, { componentId: OBJ });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { granters, owd, owdGrantsAllInternalUsers } = r.value.data;
    expect(owd).toBe('Private');
    expect(owdGrantsAllInternalUsers).toBe(false);
    const byId = new Map(granters.map((g) => [`${g.granterId}|${g.via}`, g]));
    // Admin: object Modify All → access all, all-records.
    expect(byId.get('Profile:Admin|modify-all-object')?.access).toBe('all');
    // Reader PS: object Read → read, shared-records.
    expect(byId.get('PermissionSet:Reader|object-permission-read')?.scope).toBe('shared-records');
    // God profile: ModifyAllData system perm.
    expect(byId.get('Profile:God|system-modify-all-data')?.access).toBe('all');
    // Viewer profile: ViewAllData → read.
    expect(byId.get('Profile:Viewer|system-view-all-data')?.access).toBe('read');
    // The owner sharing rule's group target with Edit access.
    const group = byId.get('Group:Sales_Public|owner-sharing-rule');
    expect(group?.granterType).toBe('Group');
    expect(group?.access).toBe('edit');
  });

  // CR-04: Delete and Create capabilities are enumerated independently — the
  // old exclusive else-if chain NEVER read allowDelete and subsumed allowCreate.
  it('emits independent object-permission-delete and -create rows (CR-04)', async () => {
    const r = await whoCanAccessObjectHandler(ctx, { componentId: OBJ });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byId = new Map(r.value.data.granters.map((g) => [`${g.granterId}|${g.via}`, g]));
    // Deleter: object Delete → its own row with access 'delete'.
    expect(byId.get('Profile:Deleter|object-permission-delete')?.access).toBe('delete');
    expect(byId.get('Profile:Deleter|object-permission-delete')?.scope).toBe('shared-records');
    // Deleter also has Read → an independent read row (NOT subsumed).
    expect(byId.get('Profile:Deleter|object-permission-read')?.access).toBe('read');
    // Creator: object Create → its own row with access 'create'.
    expect(byId.get('PermissionSet:Creator|object-permission-create')?.access).toBe('create');
  });

  // CR-04: a grantor with several capabilities (Admin: Read+Edit+Modify-All)
  // emits MULTIPLE independently-addressable rows — the old chain hid the lower
  // capabilities behind Modify-All.
  it('emits independent read/edit rows for a grantor that also has Modify-All (CR-04)', async () => {
    const r = await whoCanAccessObjectHandler(ctx, { componentId: OBJ });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byId = new Map(r.value.data.granters.map((g) => [`${g.granterId}|${g.via}`, g]));
    expect(byId.get('Profile:Admin|modify-all-object')?.access).toBe('all');
    expect(byId.get('Profile:Admin|object-permission-edit')?.access).toBe('edit');
    expect(byId.get('Profile:Admin|object-permission-read')?.access).toBe('read');
    // summary.total (ROW count) exceeds summary.distinctGranters (ACTOR count).
    expect(r.value.data.summary.total).toBeGreaterThan(r.value.data.summary.distinctGranters);
    // The shared-records / all-records split stays scope-based and correct:
    // Admin emits modify-all (all-records) + edit + read (shared-records);
    // delete/create rows are shared-records too.
    expect(r.value.data.summary.allRecordsAccess).toBeGreaterThanOrEqual(1);
    expect(r.value.data.summary.sharedRecordsAccess).toBeGreaterThanOrEqual(1);
    expect(r.value.data.boundaryNote).toContain('distinctGranters');
  });

  it('flags a public OWD as granting all internal users', async () => {
    const r = await whoCanAccessObjectHandler(ctx, { componentId: PUBLIC_OBJ });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.owdGrantsAllInternalUsers).toBe(true);
    expect(r.value.data.boundaryNote).toContain('PUBLIC');
  });

  it('always discloses record-level blind spots', async () => {
    const r = await whoCanAccessObjectHandler(ctx, { componentId: OBJ });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.confidence).toBe('declared');
    expect(r.value.data.blindSpots.length).toBeGreaterThanOrEqual(3);
    expect(r.value.data.blindSpots.some((s) => s.includes('ownership'))).toBe(true);
  });

  it('caveats god-mode rows and adds a blind spot when the object has restriction rules', async () => {
    const r = await whoCanAccessObjectHandler(ctx, { componentId: RESTRICTED_OBJ });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const god = r.value.data.granters.find((g) => g.via === 'system-modify-all-data');
    expect(god?.detail).toContain('restriction rule');
    const viewer = r.value.data.granters.find((g) => g.via === 'system-view-all-data');
    expect(viewer?.detail).toContain('restriction rule');
    expect(
      r.value.data.blindSpots.some((s) => s.includes('RestrictionRule:Vault_Case__c.Hide_Foreign')),
    ).toBe(true);
  });

  it('keeps god-mode rows clean on an object without restriction rules', async () => {
    const r = await whoCanAccessObjectHandler(ctx, { componentId: OBJ });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const god = r.value.data.granters.find((g) => g.via === 'system-modify-all-data');
    expect(god?.detail).not.toContain('restriction rule');
    expect(r.value.data.blindSpots.some((s) => s.includes('restriction rule'))).toBe(false);
  });

  it('paginates the granter list while keeping the summary complete', async () => {
    const r = await whoCanAccessObjectHandler(ctx, { componentId: OBJ, limit: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.granters.length).toBe(2);
    expect(r.value.data.summary.total).toBeGreaterThan(2);
    expect(r.value.data.hasMore).toBe(true);
    expect(r.value.data.truncated).toBe(true);
  });

  // C2 / Systemic #1: an empty (or even non-empty) sharing-rule granter list is
  // byte-identical whether the object has no sharing rules or the SharingRule
  // type was never retrieved. When manifest coverage marks SharingRule
  // requested-but-empty, a blindSpot must disclose that sharing-rule grants
  // could not be enumerated — IN ADDITION to the static BLIND_SPOTS.
  it('adds a SharingRule-not-retrieved blindSpot when SharingRule coverage is requested-but-empty (C2)', async () => {
    const covCtx: Context = {
      ...ctx,
      manifest: {
        ...MANIFEST,
        coverage: [
          { type: 'CustomObject', requested: true, retrieved: 1, errored: false, neverModeled: false },
          { type: 'SharingRule', requested: true, retrieved: 0, errored: false, neverModeled: false },
        ],
      },
    };
    const r = await whoCanAccessObjectHandler(covCtx, { componentId: OBJ });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      r.value.data.blindSpots.some((s) => /SharingRule.*not retrieved/i.test(s)),
    ).toBe(true);
    expect(r.value.data.blindSpots.some((s) => /not checked/i.test(s))).toBe(true);
    // In ADDITION to the static blind spots, never replacing them.
    expect(r.value.data.blindSpots.some((s) => s.includes('ownership'))).toBe(true);
  });

  // Regression guard: a pre-v4 manifest (no coverage array) must NOT emit the
  // SharingRule-not-retrieved blindSpot — coverageKnown is false, so legacy
  // vaults stay quiet (only the static BLIND_SPOTS are present).
  it('does NOT add the SharingRule blindSpot for a legacy manifest with no coverage array', async () => {
    const r = await whoCanAccessObjectHandler(ctx, { componentId: OBJ });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      r.value.data.blindSpots.some((s) => /SharingRule.*not retrieved/i.test(s)),
    ).toBe(false);
  });
});
