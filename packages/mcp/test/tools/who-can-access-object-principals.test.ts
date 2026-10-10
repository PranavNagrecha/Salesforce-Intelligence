/// <reference types="vitest/globals" />

/**
 * FAIL-BEFORE/PASS-AFTER: `sfi.who_can_access_object` answered "which
 * permission sets can edit X / who can delete X" with one row PER CAPABILITY
 * PER PRINCIPAL, interleaved round-robin across kinds, and no filter. Hosts had
 * to read 40-83 rows and join them by hand; a Modify-All holder appeared up to
 * six times. It also said nothing about WHO a grant reaches: a permission set
 * licensed to external community users with Modify All looked identical to an
 * internal admin's.
 *
 * The default `principals` view now collapses each principal into one row with
 * its effective capability set (Modify All ⇒ Edit + Delete, …), `accessLevel`
 * and `principalType` filter it, and Profile / PermissionSet rows carry their
 * licence audience.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, importExtractionResults, openGraph, type GraphStore } from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  whoCanAccessObjectHandler,
  whoCanAccessObjectInputSchema,
  type PrincipalAccess,
} from '../../src/tools/who-can-access-object.js';

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

const OBJ = 'CustomObject:Invoice__c';
const FULL = {
  allowRead: true,
  allowCreate: true,
  allowEdit: true,
  allowDelete: true,
  viewAllRecords: true,
  modifyAllRecords: true,
};

const seed: ExtractionResult = {
  nodes: [
    node({ id: OBJ, type: 'CustomObject', apiName: 'Invoice__c', properties: { sharingModel: 'Private' } }),
    node({ id: 'Profile:Finance_Admin', type: 'Profile', apiName: 'Finance_Admin', properties: { userLicense: 'Salesforce' } }),
    node({ id: 'Profile:Read_Only', type: 'Profile', apiName: 'Read_Only', properties: { userLicense: 'Salesforce' } }),
    node({ id: 'Profile:Super', type: 'Profile', apiName: 'Super', properties: { userLicense: 'Salesforce', userPermissions: ['ModifyAllData'] } }),
    node({ id: 'PermissionSet:Invoice_Editor', type: 'PermissionSet', apiName: 'Invoice_Editor' }),
    node({ id: 'PermissionSet:Portal_Client', type: 'PermissionSet', apiName: 'Portal_Client', properties: { license: 'Customer Community Login' } }),
    // A capture carrying ONLY the Modify All flag: the platform implies Edit/Delete.
    node({ id: 'PermissionSet:Bulk_Fixer', type: 'PermissionSet', apiName: 'Bulk_Fixer' }),
    // Read + View All only: reaches every record but can never edit one.
    node({ id: 'PermissionSet:Audit_Viewer', type: 'PermissionSet', apiName: 'Audit_Viewer' }),
    // Read + Create without Edit.
    node({ id: 'PermissionSet:Intake_Creator', type: 'PermissionSet', apiName: 'Intake_Creator' }),
    node({ id: 'SharingRule:Invoice__c.Share_Finance', type: 'SharingRule', apiName: 'Invoice__c.Share_Finance', parentId: OBJ, properties: { ruleType: 'owner', accessLevel: 'Edit' } }),
    node({ id: 'Group:Finance', type: 'Group', apiName: 'Finance' }),
  ],
  edges: [
    edge({ fromId: 'Profile:Finance_Admin', toId: OBJ, edgeType: 'grantedBy', properties: FULL }),
    edge({ fromId: 'Profile:Read_Only', toId: OBJ, edgeType: 'grantedBy', properties: { allowRead: true } }),
    edge({ fromId: 'PermissionSet:Invoice_Editor', toId: OBJ, edgeType: 'grantedBy', properties: { allowRead: true, allowEdit: true } }),
    edge({ fromId: 'PermissionSet:Portal_Client', toId: OBJ, edgeType: 'grantedBy', properties: FULL }),
    edge({ fromId: 'PermissionSet:Bulk_Fixer', toId: OBJ, edgeType: 'grantedBy', properties: { modifyAllRecords: true } }),
    edge({ fromId: 'PermissionSet:Audit_Viewer', toId: OBJ, edgeType: 'grantedBy', properties: { allowRead: true, viewAllRecords: true } }),
    edge({ fromId: 'PermissionSet:Intake_Creator', toId: OBJ, edgeType: 'grantedBy', properties: { allowRead: true, allowCreate: true } }),
    edge({ fromId: 'SharingRule:Invoice__c.Share_Finance', toId: 'Group:Finance', edgeType: 'sharedWith' }),
  ],
};

let dir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-who-can-principals-'));
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

const principals = async (args: Record<string, unknown>): Promise<readonly PrincipalAccess[]> => {
  const parsed = whoCanAccessObjectInputSchema.parse({ componentId: OBJ, limit: 250, ...args });
  const r = await whoCanAccessObjectHandler(ctx, parsed);
  if (!r.ok) throw new Error(r.error.message);
  expect(r.value.data.view).toBe('principals');
  return r.value.data.granters as readonly PrincipalAccess[];
};

describe('who_can_access_object — principals view (FAIL-BEFORE/PASS-AFTER)', () => {
  it('collapses every path a principal holds into ONE row with its capability set', async () => {
    const rows = await principals({});
    const ids = rows.map((r) => r.granterId);
    expect(new Set(ids).size).toBe(ids.length);
    const admin = rows.find((r) => r.granterId === 'Profile:Finance_Admin');
    expect(admin?.capabilities).toEqual(['read', 'create', 'edit', 'delete', 'viewAll', 'modifyAll']);
    expect(admin?.scope).toBe('all-records');
    const editor = rows.find((r) => r.granterId === 'PermissionSet:Invoice_Editor');
    expect(editor?.capabilities).toEqual(['read', 'edit']);
    expect(editor?.scope).toBe('shared-records');
  });

  it('applies platform implications: a Modify-All-only capture can edit and delete', async () => {
    const rows = await principals({});
    const fixer = rows.find((r) => r.granterId === 'PermissionSet:Bulk_Fixer');
    expect(fixer?.capabilities).toEqual(['read', 'edit', 'delete', 'viewAll', 'modifyAll']);
    const sup = rows.find((r) => r.granterId === 'Profile:Super');
    expect(sup?.capabilities).toContain('delete');
    expect(sup?.vias).toEqual(['system-modify-all-data']);
  });

  it('"which permission sets can delete" is one filtered call', async () => {
    const rows = await principals({ accessLevel: 'delete', principalType: 'PermissionSet' });
    expect(rows.map((r) => r.granterId).sort()).toEqual([
      'PermissionSet:Bulk_Fixer',
      'PermissionSet:Portal_Client',
    ]);
  });

  it('an edit filter keeps Modify All Data holders and edit-level sharing, drops read-only', async () => {
    const rows = await principals({ accessLevel: 'edit' });
    const ids = new Set(rows.map((r) => r.granterId));
    expect(ids.has('Profile:Super')).toBe(true);
    expect(ids.has('Group:Finance')).toBe(true);
    expect(ids.has('Profile:Read_Only')).toBe(false);
    const finance = rows.find((r) => r.granterId === 'Group:Finance');
    expect(finance?.capabilities).toEqual([]);
    expect(finance?.recordSharing).toBe('edit');
    expect(finance?.detail).toMatch(/still need object Edit/);
  });

  it('carries the licence audience and flags external principals with all-records access', async () => {
    const r = await whoCanAccessObjectHandler(ctx, { componentId: OBJ });
    if (!r.ok) throw new Error(r.error.message);
    const rows = r.value.data.granters as readonly PrincipalAccess[];
    const portal = rows.find((g) => g.granterId === 'PermissionSet:Portal_Client');
    expect(portal?.audience).toBe('external');
    expect(portal?.licence).toBe('Customer Community Login');
    expect(rows.find((g) => g.granterId === 'Profile:Finance_Admin')?.audience).toBe('internal');
    expect(rows.find((g) => g.granterId === 'PermissionSet:Invoice_Editor')?.audience).toBe('unknown');
    expect(r.value.data.boundaryNote).toMatch(/EXTERNAL\/GUEST licence: PermissionSet:Portal_Client/);
  });

  it('accepts forgiving spellings of the filters', () => {
    const parsed = whoCanAccessObjectInputSchema.parse({
      objectApiName: 'Invoice__c',
      access: 'Modify-All',
      granterType: 'permission sets',
    });
    expect(parsed.accessLevel).toBe('modifyAll');
    expect(parsed.principalType).toBe('PermissionSet');
  });

  it('paths view keeps the per-capability rows and honours the same filters', async () => {
    const r = await whoCanAccessObjectHandler(ctx, { componentId: OBJ, view: 'paths', accessLevel: 'delete' });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.data.view).toBe('paths');
    const vias = new Set(r.value.data.granters.map((g) => g.via));
    expect(vias.has('object-permission-read')).toBe(false);
    expect(vias.has('object-permission-delete')).toBe(true);
    expect(vias.has('modify-all-object')).toBe(true);
  });
});

// FAIL-BEFORE/PASS-AFTER: `principalType` was a free string, so a kind that is
// never a granter here (`permission set groups`, a typo) filtered every row out
// and came back as an empty, complete-looking answer: "nobody has access".
describe('who_can_access_object — unknown principalType is rejected, not answered empty', () => {
  it('rejects a permission set group filter and points at its member sets', async () => {
    const parsed = whoCanAccessObjectInputSchema.parse({ componentId: OBJ, principalType: 'permission set groups' });
    const r = await whoCanAccessObjectHandler(ctx, parsed);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toMatch(/valid kinds: Profile, PermissionSet, Role, Group, User, Territory/);
    expect(r.error.message).toMatch(/member permission sets/);
  });

  // FAIL-BEFORE/PASS-AFTER (second review): 'Queue' was listed as a granter kind
  // but no row is ever a Queue (queues grant no object access and are never a
  // sharing-rule target), so `principalType: 'queues'` returned an empty,
  // complete-looking answer — the class this rejection exists to close.
  it('rejects a queue filter and says why a queue is never a granter', async () => {
    const parsed = whoCanAccessObjectInputSchema.parse({ componentId: OBJ, principalType: 'queues' });
    const r = await whoCanAccessObjectHandler(ctx, parsed);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toMatch(/grants no object access/);
  });

  it("accepts a plural kind such as 'Territories'", () => {
    const parsed = whoCanAccessObjectInputSchema.parse({ componentId: OBJ, principalType: 'Territories' });
    expect(parsed.principalType).toBe('Territory');
  });

  it('rejects an unrecognised kind with the valid list', async () => {
    const parsed = whoCanAccessObjectInputSchema.parse({ componentId: OBJ, principalType: 'Department' });
    const r = await whoCanAccessObjectHandler(ctx, parsed);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/principalType 'Department' is not a granter kind/);
  });

  it('a valid kind with no rows is still an answer, case-insensitively', async () => {
    const r = await whoCanAccessObjectHandler(ctx, { componentId: OBJ, principalType: 'territory' });
    expect(r.ok).toBe(true);
  });
});

// FAIL-BEFORE/PASS-AFTER (review): `accessLevel: 'edit'` counted roles / groups
// that only receive record sharing (capabilities []) alongside real editors, so
// a host counting "who can edit" over-counted with nothing in the summary to
// separate them.
describe('who_can_access_object — sharing-only matches are counted apart', () => {
  it('summary.sharingOnlyPrincipals counts principals with record sharing but no object Edit', async () => {
    const r = await whoCanAccessObjectHandler(ctx, { componentId: OBJ, accessLevel: 'edit', limit: 250 });
    if (!r.ok) throw new Error(r.error.message);
    const rows = r.value.data.granters as readonly PrincipalAccess[];
    const sharingOnly = rows.filter((p) => !p.capabilities.includes('edit')).map((p) => p.granterId);
    expect(sharingOnly).toContain('Group:Finance');
    expect(r.value.data.summary.sharingOnlyPrincipals).toBe(sharingOnly.length);
    expect(r.value.data.boundaryNote).toMatch(/match only through record sharing/);
  });

  it('is absent without a level filter', async () => {
    const r = await whoCanAccessObjectHandler(ctx, { componentId: OBJ });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.data.summary.sharingOnlyPrincipals).toBeUndefined();
  });
});

// FAIL-BEFORE/PASS-AFTER (eval A06): "which permission sets can edit X" with
// `accessLevel: 'edit'` silently dropped a Read + View All permission set, so
// the host never said "this one can only read". The filtered answer now names
// what the filter LEFT OUT that still reaches the object.
describe('who_can_access_object — excludedByFilter discloses what the filter hid', () => {
  it('counts read-only and other-capability permission sets left out by an edit filter', async () => {
    const r = await whoCanAccessObjectHandler(ctx, {
      componentId: OBJ,
      accessLevel: 'edit',
      principalType: 'PermissionSet',
      limit: 250,
    });
    if (!r.ok) throw new Error(r.error.message);
    const ids = (r.value.data.granters as readonly PrincipalAccess[]).map((p) => p.granterId);
    expect(ids).not.toContain('PermissionSet:Audit_Viewer');
    const ex = r.value.data.excludedByFilter;
    expect(ex).toBeDefined();
    if (ex === undefined) return;
    expect(ex.byReason['read-only']).toBe(1);
    expect(ex.byReason['other-capabilities']).toBe(1);
    // Profiles / the sharing group hold edit but are not permission sets.
    expect(ex.byReason['other-principal-type']).toBe(3);
    expect(ex.count).toBe(5);
    const viewer = ex.examples.find((e) => e.granterId === 'PermissionSet:Audit_Viewer');
    expect(viewer?.reason).toBe('read-only');
    expect(viewer?.capabilities).toEqual(['read', 'viewAll']);
    expect(ex.examples.find((e) => e.granterId === 'PermissionSet:Intake_Creator')?.reason).toBe(
      'other-capabilities',
    );
    // Fails BOTH filters (a read-only Profile) answers neither half: not counted.
    expect(ex.examples.some((e) => e.granterId === 'Profile:Read_Only')).toBe(false);
    expect(r.value.data.boundaryNote).toMatch(/EXCLUDED 5 principal\(s\).*1 can only read/);
  });

  it('a level-only filter attributes read-only profiles and sharing-only principals', async () => {
    const r = await whoCanAccessObjectHandler(ctx, { componentId: OBJ, accessLevel: 'delete', limit: 250 });
    if (!r.ok) throw new Error(r.error.message);
    const ex = r.value.data.excludedByFilter;
    expect(ex?.byReason['read-only']).toBe(2); // Profile:Read_Only + PermissionSet:Audit_Viewer
    expect(ex?.byReason['record-sharing-only']).toBe(1); // Group:Finance (edit sharing, no delete)
    expect(ex?.byReason['other-capabilities']).toBe(2); // Invoice_Editor, Intake_Creator
    expect(ex?.byReason['other-principal-type']).toBeUndefined();
  });

  it('is absent when no filter is applied', async () => {
    const r = await whoCanAccessObjectHandler(ctx, { componentId: OBJ });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.data.excludedByFilter).toBeUndefined();
  });
});
