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
    // REALISTIC shape: the sharing extractor carries the parent object on
    // `parentId` (`CustomObject:Deal__c`) — it does NOT emit
    // `properties.sObjectType`. Keying on that phantom silently dropped every
    // sharing-rule granter (sibling of the false-empty sharing-summary bug).
    node({ id: 'SharingRule:Deal__c.Share_To_Sales', type: 'SharingRule', apiName: 'Deal__c.Share_To_Sales', parentId: OBJ, properties: { ruleType: 'owner', accessLevel: 'Edit' } }),
    node({ id: 'Group:Sales_Public', type: 'Group', apiName: 'Sales_Public' }),
    // CR-CAP-12: Sales_Public contains a User, a nested Group, and a dangling
    // Territory; the nested group contains a Role. who_can must list each as its
    // own granter row, transitively through the nested group.
    node({ id: 'Group:Sales_Inner', type: 'Group', apiName: 'Sales_Inner' }),
    // CR-CAP-05b: a roleAndSubordinates owner rule shares to Role:VP_Sales; the
    // descend must enumerate Role:Sales_Mgr (direct child) and Role:Sales_Rep_R
    // (grandchild). A separate plain-role rule shares to Role:Audit with NO
    // inheritance marker — it must NOT expand. Role:Parent_VP is VP_Sales's
    // MANAGER (VP inheritsFrom Parent_VP) and must NEVER be listed.
    node({ id: 'Role:VP_Sales', type: 'Role', apiName: 'VP_Sales' }),
    node({ id: 'Role:Sales_Mgr', type: 'Role', apiName: 'Sales_Mgr' }),
    node({ id: 'Role:Sales_Rep_R', type: 'Role', apiName: 'Sales_Rep_R' }),
    node({ id: 'Role:Parent_VP', type: 'Role', apiName: 'Parent_VP' }),
    node({ id: 'Role:Audit', type: 'Role', apiName: 'Audit' }),
    node({ id: 'SharingRule:Deal__c.Share_Subs', type: 'SharingRule', apiName: 'Deal__c.Share_Subs', parentId: OBJ, properties: { ruleType: 'owner', accessLevel: 'Read' } }),
    node({ id: 'SharingRule:Deal__c.Share_Audit', type: 'SharingRule', apiName: 'Deal__c.Share_Audit', parentId: OBJ, properties: { ruleType: 'owner', accessLevel: 'Read' } }),
  ],
  edges: [
    edge({ fromId: 'Profile:Admin', toId: OBJ, edgeType: 'grantedBy', properties: { allowRead: true, allowEdit: true, modifyAllRecords: true } }),
    edge({ fromId: 'PermissionSet:Reader', toId: OBJ, edgeType: 'grantedBy', properties: { allowRead: true } }),
    edge({ fromId: 'Profile:Deleter', toId: OBJ, edgeType: 'grantedBy', properties: { allowRead: true, allowDelete: true } }),
    edge({ fromId: 'PermissionSet:Creator', toId: OBJ, edgeType: 'grantedBy', properties: { allowCreate: true } }),
    edge({ fromId: 'SharingRule:Deal__c.Share_To_Sales', toId: 'Group:Sales_Public', edgeType: 'sharedWith' }),
    // hasMember topology (declared, emitted by the group extractor).
    edge({ fromId: 'Group:Sales_Public', toId: 'User:rep@example.com', edgeType: 'hasMember', source: 'group-extractor', properties: { memberType: 'User' } }),
    edge({ fromId: 'Group:Sales_Public', toId: 'Group:Sales_Inner', edgeType: 'hasMember', source: 'group-extractor', properties: { memberType: 'Group' } }),
    edge({ fromId: 'Group:Sales_Public', toId: 'Territory:West', edgeType: 'hasMember', source: 'group-extractor', properties: { memberType: 'Territory', resolvable: false } }),
    edge({ fromId: 'Group:Sales_Inner', toId: 'Role:Sales_Rep', edgeType: 'hasMember', source: 'group-extractor', properties: { memberType: 'Role' } }),
    // CR-CAP-05b: role subtree (inheritsFrom oriented child->parent).
    edge({ fromId: 'SharingRule:Deal__c.Share_Subs', toId: 'Role:VP_Sales', edgeType: 'sharedWith', properties: { inheritance: 'subordinates' } }),
    edge({ fromId: 'SharingRule:Deal__c.Share_Audit', toId: 'Role:Audit', edgeType: 'sharedWith' }),
    edge({ fromId: 'Role:Sales_Mgr', toId: 'Role:VP_Sales', edgeType: 'inheritsFrom', source: 'role-extractor' }),
    edge({ fromId: 'Role:Sales_Rep_R', toId: 'Role:Sales_Mgr', edgeType: 'inheritsFrom', source: 'role-extractor' }),
    edge({ fromId: 'Role:VP_Sales', toId: 'Role:Parent_VP', edgeType: 'inheritsFrom', source: 'role-extractor' }),
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

// CR-CAP-05b: an incomplete role subtree — Role:Top is shared with
// subordinates, has a child Role:Mid whose NODE was NOT retrieved (an inbound
// inheritsFrom edge references it but no node), so the descend must set
// truncated + a blindSpot, NEVER fabricate Mid's own subtree.
const INCOMPLETE_OBJ = 'CustomObject:Inc__c';
const incompleteSeed: ExtractionResult = {
  nodes: [
    node({ id: INCOMPLETE_OBJ, type: 'CustomObject', apiName: 'Inc__c', properties: { sharingModel: 'Private' } }),
    node({ id: 'Role:Top', type: 'Role', apiName: 'Top' }),
    node({ id: 'SharingRule:Inc__c.Share_Top', type: 'SharingRule', apiName: 'Inc__c.Share_Top', parentId: INCOMPLETE_OBJ, properties: { ruleType: 'owner', accessLevel: 'Read' } }),
  ],
  edges: [
    edge({ fromId: 'SharingRule:Inc__c.Share_Top', toId: 'Role:Top', edgeType: 'sharedWith', properties: { inheritance: 'subordinates' } }),
    // Role:Mid is a subordinate of Top by edge, but its NODE is absent.
    edge({ fromId: 'Role:Mid', toId: 'Role:Top', edgeType: 'inheritsFrom', source: 'role-extractor' }),
  ],
};

// CR-CAP-05b: roleAndSubordinatesInternal — same descend, but the internal-vs-
// portal exclusion cannot be applied offline; must be disclosed.
const INTERNAL_OBJ = 'CustomObject:Intl__c';
const internalSeed: ExtractionResult = {
  nodes: [
    node({ id: INTERNAL_OBJ, type: 'CustomObject', apiName: 'Intl__c', properties: { sharingModel: 'Private' } }),
    node({ id: 'Role:IntTop', type: 'Role', apiName: 'IntTop' }),
    node({ id: 'Role:IntChild', type: 'Role', apiName: 'IntChild' }),
    node({ id: 'SharingRule:Intl__c.Share_Int', type: 'SharingRule', apiName: 'Intl__c.Share_Int', parentId: INTERNAL_OBJ, properties: { ruleType: 'owner', accessLevel: 'Read' } }),
  ],
  edges: [
    edge({ fromId: 'SharingRule:Intl__c.Share_Int', toId: 'Role:IntTop', edgeType: 'sharedWith', properties: { inheritance: 'subordinatesInternal' } }),
    edge({ fromId: 'Role:IntChild', toId: 'Role:IntTop', edgeType: 'inheritsFrom', source: 'role-extractor' }),
  ],
};

// CR-CAP-05b: a malformed back-edge cycle (Role:CycA inheritsFrom Role:CycB AND
// Role:CycB inheritsFrom Role:CycA) must terminate via the visited-set.
const CYCLE_OBJ = 'CustomObject:Cyc__c';
const cycleSeed: ExtractionResult = {
  nodes: [
    node({ id: CYCLE_OBJ, type: 'CustomObject', apiName: 'Cyc__c', properties: { sharingModel: 'Private' } }),
    node({ id: 'Role:CycA', type: 'Role', apiName: 'CycA' }),
    node({ id: 'Role:CycB', type: 'Role', apiName: 'CycB' }),
    node({ id: 'SharingRule:Cyc__c.Share_Cyc', type: 'SharingRule', apiName: 'Cyc__c.Share_Cyc', parentId: CYCLE_OBJ, properties: { ruleType: 'owner', accessLevel: 'Read' } }),
  ],
  edges: [
    edge({ fromId: 'SharingRule:Cyc__c.Share_Cyc', toId: 'Role:CycA', edgeType: 'sharedWith', properties: { inheritance: 'subordinates' } }),
    edge({ fromId: 'Role:CycA', toId: 'Role:CycB', edgeType: 'inheritsFrom', source: 'role-extractor' }),
    edge({ fromId: 'Role:CycB', toId: 'Role:CycA', edgeType: 'inheritsFrom', source: 'role-extractor' }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-who-can-access-'));
  const opened = await openGraph(join(tempDir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imported = await importExtractionResults(store, [
    seed,
    publicSeed,
    restrictedSeed,
    incompleteSeed,
    internalSeed,
    cycleSeed,
  ]);
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

  it('CR-CAP-12: expands a shared group into its (transitive) members as granter rows', async () => {
    const r = await whoCanAccessObjectHandler(ctx, { componentId: OBJ, limit: 250 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byId = new Map(r.value.data.granters.map((g) => [`${g.granterId}|${g.via}`, g]));
    // The group still appears as its own row...
    expect(byId.get('Group:Sales_Public|owner-sharing-rule')?.access).toBe('edit');
    // ...AND each member it contains, transitively through the nested group.
    const user = byId.get('User:rep@example.com|owner-sharing-rule');
    expect(user?.granterType).toBe('User');
    expect(user?.access).toBe('edit');
    expect(user?.detail).toContain('Group:Sales_Public');
    const nested = byId.get('Group:Sales_Inner|owner-sharing-rule');
    expect(nested?.granterType).toBe('Group');
    // Role reached only via the nested group → transitivity.
    const role = byId.get('Role:Sales_Rep|owner-sharing-rule');
    expect(role?.granterType).toBe('Role');
    expect(role?.access).toBe('edit');
    // The Territory member is dangling-by-design: listed but flagged unresolved.
    const territory = byId.get('Territory:West|owner-sharing-rule');
    expect(territory?.granterType).toBe('Territory');
    expect(territory?.detail).toMatch(/dangling member/i);
  });

  // CR-CAP-05b: a roleAndSubordinates owner rule shares to Role:VP_Sales; the
  // descend must enumerate the named role AND every subordinate role below it.
  it('CR-CAP-05b: expands a roleAndSubordinates rule into the role subtree', async () => {
    const r = await whoCanAccessObjectHandler(ctx, { componentId: OBJ, limit: 250 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byId = new Map(r.value.data.granters.map((g) => [`${g.granterId}|${g.via}`, g]));
    // The named role appears as its own row (verbatim target, unchanged).
    expect(byId.get('Role:VP_Sales|owner-sharing-rule')?.access).toBe('read');
    // ...AND each subordinate role below it, transitively.
    const mgr = byId.get('Role:Sales_Mgr|owner-sharing-rule');
    expect(mgr?.granterType).toBe('Role');
    expect(mgr?.access).toBe('read');
    expect(mgr?.scope).toBe('shared-records');
    expect(mgr?.detail).toContain('Role:VP_Sales');
    expect(mgr?.detail).toMatch(/subordinate/i);
    const rep = byId.get('Role:Sales_Rep_R|owner-sharing-rule');
    expect(rep?.granterType).toBe('Role');
    expect(rep?.access).toBe('read');
  });

  // CR-CAP-05b OVER-GRANT GATE: the MANAGER (parent) of the shared role must
  // NEVER be listed — that would be an over-grant to the wrong principals.
  it('CR-CAP-05b: never lists a role ABOVE the shared role (managers)', async () => {
    const r = await whoCanAccessObjectHandler(ctx, { componentId: OBJ, limit: 250 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = new Set(r.value.data.granters.map((g) => g.granterId));
    expect(ids.has('Role:Parent_VP')).toBe(false);
  });

  // CR-CAP-05b GATE: a plain-role target with NO inheritance marker emits ONLY
  // the verbatim role row, zero descendants (proves the expansion is gated).
  it('CR-CAP-05b: a plain-role rule (no inheritance marker) does NOT expand', async () => {
    const r = await whoCanAccessObjectHandler(ctx, { componentId: OBJ, limit: 250 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byId = new Map(r.value.data.granters.map((g) => [`${g.granterId}|${g.via}`, g]));
    // Role:Audit is shared verbatim (no inheritance) and has no subtree.
    expect(byId.get('Role:Audit|owner-sharing-rule')?.granterType).toBe('Role');
    // Audit has no children anyway, but assert no spurious row beyond it.
    const auditRows = r.value.data.granters.filter((g) => g.granterId === 'Role:Audit');
    expect(auditRows.length).toBe(1);
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

  // CR-CAP-05b INCOMPLETE-TREE: a subordinate child node was not retrieved →
  // the reached roles are still listed, a blindSpot discloses the incomplete
  // subtree + /sfi-refresh, and NO fabricated role row is emitted.
  it('CR-CAP-05b: discloses an incomplete role subtree without over-granting', async () => {
    const r = await whoCanAccessObjectHandler(ctx, { componentId: INCOMPLETE_OBJ, limit: 250 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = new Set(r.value.data.granters.map((g) => g.granterId));
    // The named role is listed; the absent child Role:Mid is still named (the
    // edge declared it) but no FABRICATED descendant below Mid appears.
    expect(ids.has('Role:Top')).toBe(true);
    expect(
      r.value.data.blindSpots.some(
        (s) => /role hierarchy/i.test(s) && /sfi refresh/i.test(s),
      ),
    ).toBe(true);
  });

  // CR-CAP-05b INTERNAL: the internal-vs-portal exclusion cannot be applied
  // offline; the subtree is enumerated AND a disclosure says so.
  it('CR-CAP-05b: discloses that the internal-subordinates filter is not applied offline', async () => {
    const r = await whoCanAccessObjectHandler(ctx, { componentId: INTERNAL_OBJ, limit: 250 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = new Set(r.value.data.granters.map((g) => g.granterId));
    expect(ids.has('Role:IntTop')).toBe(true);
    expect(ids.has('Role:IntChild')).toBe(true);
    expect(
      r.value.data.blindSpots.some((s) => /internal/i.test(s) && /portal|partner/i.test(s)),
    ).toBe(true);
  });

  // CR-CAP-05b CYCLE: a malformed back-edge must terminate (no infinite loop).
  it('CR-CAP-05b: a back-edge cycle terminates via the visited-set', async () => {
    const r = await whoCanAccessObjectHandler(ctx, { componentId: CYCLE_OBJ, limit: 250 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = new Set(r.value.data.granters.map((g) => g.granterId));
    // Both roles in the cycle are reached, each once — no infinite loop / dupes.
    expect(ids.has('Role:CycA')).toBe(true);
    expect(ids.has('Role:CycB')).toBe(true);
    const cycARows = r.value.data.granters.filter((g) => g.granterId === 'Role:CycA');
    expect(cycARows.length).toBe(1);
  });
});
