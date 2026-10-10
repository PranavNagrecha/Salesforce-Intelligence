/// <reference types="vitest/globals" />

/**
 * FAIL-BEFORE/PASS-AFTER: `sfi.field_access_audit` headline counts said who
 * can EDIT a field from field-level security alone. A read-only profile whose
 * object row says `allowEdit: false` (but whose FLS says editable) was listed
 * as `permission: 'edit'` and counted in `summary.profilesWithEdit`; the
 * correct intersection lived only in `update.canUpdate`, below the fold. The
 * read/edit counts also overlapped (read included edit), so they looked
 * additive.
 *
 * Each grant now carries its EFFECTIVE level for the container alone (FLS ∩
 * object CRUD ∩ field type) with a `note` when it is lower than the declared
 * FLS, and `summary.profiles` / `summary.permissionSets` are disjoint
 * effective buckets; the declared FLS counts move to `summary.declaredFls`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, importExtractionResults, openGraph, type GraphStore } from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { fieldAccessAuditHandler } from '../../src/tools/field-access-audit.js';

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

const OBJ = 'CustomObject:Project__c';
const FIELD = 'CustomField:Project__c.Budget__c';
const FLS_EDIT = { readable: true, editable: true };

const seed: ExtractionResult = {
  nodes: [
    node({ id: OBJ, type: 'CustomObject', apiName: 'Project__c' }),
    node({ id: FIELD, type: 'CustomField', apiName: 'Budget__c', parentId: OBJ, properties: { type: 'Currency' } }),
    node({ id: 'Profile:Editor', type: 'Profile', apiName: 'Editor' }),
    node({ id: 'Profile:Read_Only', type: 'Profile', apiName: 'Read_Only' }),
    node({ id: 'Profile:No_Object_Row', type: 'Profile', apiName: 'No_Object_Row' }),
    node({ id: 'Profile:Super', type: 'Profile', apiName: 'Super', properties: { userPermissions: ['ModifyAllData'] } }),
    node({ id: 'PermissionSet:Viewer', type: 'PermissionSet', apiName: 'Viewer' }),
    node({ id: 'PermissionSet:Denied', type: 'PermissionSet', apiName: 'Denied' }),
  ],
  edges: [
    // FLS grants on the field.
    edge({ fromId: 'Profile:Editor', toId: FIELD, edgeType: 'grantedBy', properties: FLS_EDIT }),
    edge({ fromId: 'Profile:Read_Only', toId: FIELD, edgeType: 'grantedBy', properties: FLS_EDIT }),
    edge({ fromId: 'Profile:No_Object_Row', toId: FIELD, edgeType: 'grantedBy', properties: FLS_EDIT }),
    edge({ fromId: 'Profile:Super', toId: FIELD, edgeType: 'grantedBy', properties: FLS_EDIT }),
    edge({ fromId: 'PermissionSet:Viewer', toId: FIELD, edgeType: 'grantedBy', properties: { readable: true } }),
    edge({ fromId: 'PermissionSet:Denied', toId: FIELD, edgeType: 'grantedBy', properties: { readable: true } }),
    // Object rows on the parent.
    edge({ fromId: 'Profile:Editor', toId: OBJ, edgeType: 'grantedBy', properties: { allowRead: true, allowEdit: true } }),
    edge({ fromId: 'Profile:Read_Only', toId: OBJ, edgeType: 'grantedBy', properties: { allowRead: true, allowEdit: false } }),
    edge({ fromId: 'PermissionSet:Viewer', toId: OBJ, edgeType: 'grantedBy', properties: { allowRead: true } }),
    edge({ fromId: 'PermissionSet:Denied', toId: OBJ, edgeType: 'grantedBy', properties: { allowRead: false } }),
  ],
};

let dir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-field-access-effective-'));
  const opened = await openGraph(join(dir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(imported.error.message);
  ctx = { vaultRoot: dir, manifest: MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(dir, { recursive: true, force: true });
});

const audit = async () => {
  const r = await fieldAccessAuditHandler(ctx, { fieldId: FIELD });
  if (!r.ok) throw new Error(r.error.message);
  return r.value.data;
};

describe('field_access_audit — effective access per grant (FAIL-BEFORE/PASS-AFTER)', () => {
  it('a profile with FLS Edit but object Read only is read, with a note', async () => {
    const d = await audit();
    const ro = d.grants.find((g) => g.grantorId === 'Profile:Read_Only');
    expect(ro?.flsPermission).toBe('edit');
    expect(ro?.permission).toBe('read');
    expect(ro?.note).toMatch(/Read only — cannot edit/);
  });

  it('labels every downgrade: no object row, object denies read, Modify All Data', async () => {
    const d = await audit();
    const by = new Map(d.grants.map((g) => [g.grantorId, g]));
    expect(by.get('Profile:Editor')?.permission).toBe('edit');
    expect(by.get('Profile:Editor')?.note).toBeUndefined();
    expect(by.get('Profile:No_Object_Row')?.permission).toBe('unconfirmed');
    expect(by.get('Profile:Super')?.permission).toBe('edit');
    expect(by.get('PermissionSet:Viewer')?.permission).toBe('read');
    expect(by.get('PermissionSet:Denied')?.permission).toBe('none');
  });

  it('headline counts are effective and disjoint; declared FLS counts are kept aside', async () => {
    const d = await audit();
    expect(d.summary.profiles).toEqual({
      canEdit: 2,
      readOnly: 1,
      unconfirmed: 1,
      noObjectAccess: 0,
      unknownLevel: 0,
    });
    expect(d.summary.permissionSets).toEqual({
      canEdit: 0,
      readOnly: 1,
      unconfirmed: 0,
      noObjectAccess: 1,
      unknownLevel: 0,
    });
    expect(d.summary.declaredFls.profilesWithEdit).toBe(4);
    // Disjoint: the buckets add up to the grant count.
    const sum = (c: Record<string, number>): number => Object.values(c).reduce((a, b) => a + b, 0);
    expect(sum({ ...d.summary.profiles }) + sum({ ...d.summary.permissionSets })).toBe(d.grants.length);
    // Only Profile:Read_Only is a VERIFIED downgrade; Profile:No_Object_Row is
    // `unconfirmed` (object access not checked) and is reported separately.
    expect(d.boundaryNote).toMatch(/1 container\(s\) declare FLS Edit but cannot edit on their own/);
  });

  // FAIL-BEFORE/PASS-AFTER (second review): the "cannot edit" count was declared
  // FLS-edit minus effective canEdit, so it swept in every `unconfirmed` grant —
  // stating a denial for containers whose object access was never checked.
  it('the "cannot edit" boundary count excludes unconfirmed grants', async () => {
    const d = await audit();
    const verified = d.grants.filter(
      (g) => g.flsPermission === 'edit' && (g.permission === 'read' || g.permission === 'none'),
    ).length;
    expect(verified).toBe(1);
    expect(d.boundaryNote).not.toMatch(/2 container\(s\) declare FLS Edit/);
    expect(d.boundaryNote).toMatch(/object edit was NOT CHECKED for 1 FLS-edit grantor/);
  });

  it('agrees with update.canUpdate', async () => {
    const d = await audit();
    const editIds = d.grants.filter((g) => g.permission === 'edit').map((g) => g.grantorId).sort();
    expect(d.update.canUpdate.map((g) => g.grantorId).sort()).toEqual(editIds);
  });
});

// FAIL-BEFORE/PASS-AFTER (review): `permissionType` still filtered on the
// declared FLS level, so `permissionType: 'edit'` listed the Read-only profile
// (effective `read`) and the object-denied set under "who can edit / read".
describe('field_access_audit — permissionType filters on effective access', () => {
  const ids = async (permissionType: 'read' | 'edit'): Promise<string[]> => {
    const r = await fieldAccessAuditHandler(ctx, { fieldId: FIELD, permissionType });
    if (!r.ok) throw new Error(r.error.message);
    return r.value.data.grants.map((g) => g.grantorId).sort();
  };

  it("'edit' keeps effective editors plus the unconfirmed FLS editor, not the Read-only profile", async () => {
    expect(await ids('edit')).toEqual(['Profile:Editor', 'Profile:No_Object_Row', 'Profile:Super']);
  });

  it("'read' drops a container whose object permission grants no Read", async () => {
    const got = await ids('read');
    expect(got).toContain('Profile:Read_Only');
    expect(got).not.toContain('PermissionSet:Denied');
  });
});
