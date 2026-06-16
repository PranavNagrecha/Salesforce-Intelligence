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
    node({ id: 'SharingRule:Deal__c.Share_To_Sales', type: 'SharingRule', apiName: 'Deal__c.Share_To_Sales', properties: { ruleType: 'owner', accessLevel: 'Edit', sObjectType: 'Deal__c' } }),
    node({ id: 'Group:Sales_Public', type: 'Group', apiName: 'Sales_Public' }),
  ],
  edges: [
    edge({ fromId: 'Profile:Admin', toId: OBJ, edgeType: 'grantedBy', properties: { allowRead: true, allowEdit: true, modifyAllRecords: true } }),
    edge({ fromId: 'PermissionSet:Reader', toId: OBJ, edgeType: 'grantedBy', properties: { allowRead: true } }),
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
    expect(byId.get('PermissionSet:Reader|object-permission')?.scope).toBe('shared-records');
    // God profile: ModifyAllData system perm.
    expect(byId.get('Profile:God|system-modify-all-data')?.access).toBe('all');
    // Viewer profile: ViewAllData → read.
    expect(byId.get('Profile:Viewer|system-view-all-data')?.access).toBe('read');
    // The owner sharing rule's group target with Edit access.
    const group = byId.get('Group:Sales_Public|owner-sharing-rule');
    expect(group?.granterType).toBe('Group');
    expect(group?.access).toBe('edit');
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
});
