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
  whatIfAssignPermsetHandler,
  whatIfAssignPermsetInputSchema,
  whatIfRevokePermsetHandler,
  whatIfRevokePermsetInputSchema,
} from '../../src/tools/what-if-permset.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-08T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
  // Complete coverage for the access families so a no-op verdict is `safe` (not
  // downgraded to `review` by the absence-of-coverage caveat) — the realistic
  // path a refreshed vault takes.
  coverage: [
    { type: 'Profile', requested: true, retrieved: 1, errored: false, neverModeled: false },
    { type: 'PermissionSet', requested: true, retrieved: 6, errored: false, neverModeled: false },
  ],
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

// A muted-object-permission entry (all-false except the denied flags).
const mutedObj = (object: string, denied: Partial<Record<string, boolean>>): Record<string, unknown> => ({
  object,
  allowCreate: denied['allowCreate'] === true,
  allowRead: denied['allowRead'] === true,
  allowEdit: denied['allowEdit'] === true,
  allowDelete: denied['allowDelete'] === true,
  viewAllRecords: denied['viewAllRecords'] === true,
  modifyAllRecords: denied['modifyAllRecords'] === true,
});

const seed: ExtractionResult = {
  nodes: [
    // Profile grants Account READ + ApiEnabled + Account.Standard record type.
    node({
      id: 'Profile:Base',
      type: 'Profile',
      apiName: 'Base',
      properties: {
        userPermissions: ['ApiEnabled'],
        recordTypeVisibilities: [{ recordType: 'Account.Standard', visible: true, default: true }],
      },
    }),
    // SalesConsole ADDS: Widget CRUD, Widget.Secret FLS, ViewAllData, a custom
    // perm, a NEW record type — PLUS a REDUNDANT Account read + a redundant
    // Account.Standard record type (both already held via the profile).
    node({
      id: 'PermissionSet:SalesConsole',
      type: 'PermissionSet',
      apiName: 'SalesConsole',
      properties: {
        userPermissions: ['ViewAllData'],
        recordTypeVisibilities: [
          { recordType: 'Widget.Standard', visible: true, default: false },
          { recordType: 'Account.Standard', visible: true, default: false },
        ],
      },
    }),
    // A set that grants ONLY the redundant Account read (assign → no net gain).
    node({ id: 'PermissionSet:AccountReadDup', type: 'PermissionSet', apiName: 'AccountReadDup' }),
    // Two sets that BOTH grant Widget read (revoke one → not lost).
    node({ id: 'PermissionSet:WidgetReaderA', type: 'PermissionSet', apiName: 'WidgetReaderA' }),
    node({ id: 'PermissionSet:WidgetReaderB', type: 'PermissionSet', apiName: 'WidgetReaderB' }),
    // Muting: a group member whose Account DELETE is muted inside the group.
    node({ id: 'PermissionSet:M1', type: 'PermissionSet', apiName: 'M1' }),
    node({
      id: 'MutingPermissionSet:Mute',
      type: 'MutingPermissionSet',
      apiName: 'Mute',
      properties: {
        mutedObjectPermissions: [mutedObj('Account', { allowDelete: true })],
        mutedFieldPermissions: [],
        mutedUserPermissions: [],
        mutedCustomPermissions: [],
        mutedApexClasses: [],
      },
    }),
    node({
      id: 'PermissionSetGroup:G',
      type: 'PermissionSetGroup',
      apiName: 'G',
      properties: { permissionSets: ['M1'], mutingPermissionSets: ['Mute'] },
    }),
    node({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
    node({ id: 'CustomObject:Widget', type: 'CustomObject', apiName: 'Widget' }),
    node({ id: 'CustomObject:Gadget', type: 'CustomObject', apiName: 'Gadget' }),
    node({ id: 'CustomField:Widget.Secret__c', type: 'CustomField', apiName: 'Widget.Secret__c' }),
    node({ id: 'CustomPermission:SkipValidation', type: 'CustomPermission', apiName: 'SkipValidation' }),
  ],
  edges: [
    edge({ fromId: 'Profile:Base', toId: 'CustomObject:Account', edgeType: 'grantedBy', properties: { allowRead: true } }),
    edge({ fromId: 'PermissionSet:SalesConsole', toId: 'CustomObject:Account', edgeType: 'grantedBy', properties: { allowRead: true } }),
    edge({ fromId: 'PermissionSet:SalesConsole', toId: 'CustomObject:Widget', edgeType: 'grantedBy', properties: { allowCreate: true, allowRead: true } }),
    edge({ fromId: 'PermissionSet:SalesConsole', toId: 'CustomField:Widget.Secret__c', edgeType: 'grantedBy', properties: { readable: true, editable: true } }),
    edge({ fromId: 'PermissionSet:SalesConsole', toId: 'CustomPermission:SkipValidation', edgeType: 'grantedBy', properties: { enabled: true } }),
    edge({ fromId: 'PermissionSet:AccountReadDup', toId: 'CustomObject:Account', edgeType: 'grantedBy', properties: { allowRead: true } }),
    edge({ fromId: 'PermissionSet:WidgetReaderA', toId: 'CustomObject:Widget', edgeType: 'grantedBy', properties: { allowRead: true } }),
    edge({ fromId: 'PermissionSet:WidgetReaderB', toId: 'CustomObject:Widget', edgeType: 'grantedBy', properties: { allowRead: true } }),
    edge({ fromId: 'PermissionSet:M1', toId: 'CustomObject:Account', edgeType: 'grantedBy', properties: { allowDelete: true } }),
    edge({ fromId: 'PermissionSet:M1', toId: 'CustomObject:Gadget', edgeType: 'grantedBy', properties: { allowRead: true } }),
    edge({ fromId: 'PermissionSetGroup:G', toId: 'PermissionSet:M1', edgeType: 'references', properties: { referenceKind: 'permissionSetGroupMember' } }),
    edge({ fromId: 'PermissionSetGroup:G', toId: 'MutingPermissionSet:Mute', edgeType: 'references', properties: { referenceKind: 'mutingPermissionSet' } }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-permset-whatif-'));
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

describe('whatIfAssignPermsetHandler — GAINED delta', () => {
  it('surfaces object CRUD / FLS / system / custom / record-type GAINED, but not the redundant Account read', async () => {
    const r = await whatIfAssignPermsetHandler(ctx, {
      permissionSetId: 'PermissionSet:SalesConsole',
      baseline: { profileId: 'Profile:Base', permissionSetIds: [] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;

    // Object CRUD: Widget create+read gained; Account NOT gained (profile already
    // grants read) — the net-change guarantee.
    expect(d.objectPermissions).toEqual([{ kind: 'object', object: 'Widget', flags: ['allowCreate', 'allowRead'] }]);
    // FLS: Widget.Secret read+edit gained.
    expect(d.fieldPermissions).toEqual([{ kind: 'field', field: 'Widget.Secret__c', readable: true, editable: true }]);
    // System: ViewAllData gained; ApiEnabled NOT (already held via profile).
    expect(d.systemPermissions).toEqual([{ kind: 'system', permission: 'ViewAllData' }]);
    // Custom + record type gained.
    expect(d.customPermissions).toEqual([{ kind: 'custom', name: 'SkipValidation' }]);
    // Widget.Standard gained; Account.Standard NOT (already visible via profile).
    expect(d.recordTypeVisibilities).toEqual([{ kind: 'record-type', recordType: 'Widget.Standard' }]);

    expect(d.action).toBe('assign');
    expect(d.summary.noOp).toBe(false);
    expect(d.summary.totalChanges).toBe(5);
    expect(d.verdict).toBe('review');
    // Envelope shape present.
    expect(d.trust.provenance).toBe('offline_snapshot');
    expect(typeof d.disclosure).toBe('string');
  });

  it('assigning a set whose grant the profile ALREADY confers gains nothing (net-change correctness)', async () => {
    const r = await whatIfAssignPermsetHandler(ctx, {
      permissionSetId: 'PermissionSet:AccountReadDup',
      baseline: { profileId: 'Profile:Base' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.summary.totalChanges).toBe(0);
    expect(d.summary.noOp).toBe(true);
    expect(d.verdict).toBe('safe');
    expect(d.objectPermissions).toEqual([]);
  });

  it('assigning a set already in the baseline is a disclosed no-op', async () => {
    const r = await whatIfAssignPermsetHandler(ctx, {
      permissionSetId: 'PermissionSet:SalesConsole',
      baseline: { profileId: 'Profile:Base', permissionSetIds: ['PermissionSet:SalesConsole'] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.targetInBaseline).toBe(true);
    expect(d.summary.noOp).toBe(true);
    expect(d.disclosures.some((x) => x.includes('already in the baseline') && x.includes('no-op'))).toBe(true);
  });

  it('an empty baseline gains the set’s full grant (before = effective(∅))', async () => {
    const r = await whatIfAssignPermsetHandler(ctx, { permissionSetId: 'PermissionSet:SalesConsole' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // Now Account read IS gained (no profile to already confer it).
    const acct = d.objectPermissions.find((o) => o.object === 'Account');
    expect(acct?.flags).toEqual(['allowRead']);
    expect(d.systemPermissions).toEqual([{ kind: 'system', permission: 'ViewAllData' }]);
  });
});

describe('whatIfRevokePermsetHandler — LOST delta', () => {
  it('revoking a set whose grant is ALSO conferred elsewhere loses nothing (net-change correctness)', async () => {
    const r = await whatIfRevokePermsetHandler(ctx, {
      permissionSetId: 'PermissionSet:WidgetReaderA',
      baseline: {
        profileId: 'Profile:Base',
        permissionSetIds: ['PermissionSet:WidgetReaderA', 'PermissionSet:WidgetReaderB'],
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // Widget read still held via WidgetReaderB → not lost.
    expect(d.summary.totalChanges).toBe(0);
    expect(d.summary.noOp).toBe(true);
    expect(d.targetInBaseline).toBe(true);
    expect(d.verdict).toBe('safe');
  });

  it('revoking SalesConsole loses its unique grants but NOT Account read (kept via the profile)', async () => {
    const r = await whatIfRevokePermsetHandler(ctx, {
      permissionSetId: 'PermissionSet:SalesConsole',
      baseline: { profileId: 'Profile:Base', permissionSetIds: ['PermissionSet:SalesConsole'] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.action).toBe('revoke');
    // Widget CRUD lost; Account NOT lost (profile still grants read).
    expect(d.objectPermissions).toEqual([{ kind: 'object', object: 'Widget', flags: ['allowCreate', 'allowRead'] }]);
    expect(d.fieldPermissions).toEqual([{ kind: 'field', field: 'Widget.Secret__c', readable: true, editable: true }]);
    expect(d.systemPermissions).toEqual([{ kind: 'system', permission: 'ViewAllData' }]);
    expect(d.customPermissions).toEqual([{ kind: 'custom', name: 'SkipValidation' }]);
    expect(d.recordTypeVisibilities).toEqual([{ kind: 'record-type', recordType: 'Widget.Standard' }]);
    expect(d.verdict).toBe('review');
  });

  it('revoking a set NOT in the baseline is a disclosed no-op', async () => {
    const r = await whatIfRevokePermsetHandler(ctx, {
      permissionSetId: 'PermissionSet:SalesConsole',
      baseline: { profileId: 'Profile:Base' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.targetInBaseline).toBe(false);
    expect(d.summary.totalChanges).toBe(0);
    expect(d.summary.noOp).toBe(true);
    expect(d.disclosures.some((x) => x.includes('NOT in the baseline') && x.includes('no-op'))).toBe(true);
  });
});

describe('whatIfPermset — muting composition (R6-06)', () => {
  it('assigning a group member DIRECTLY re-confers a perm the group muted (unmuted gain)', async () => {
    const r = await whatIfAssignPermsetHandler(ctx, {
      permissionSetId: 'PermissionSet:M1',
      baseline: { permissionSetIds: ['PermissionSetGroup:G'] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // In the baseline (the PSG), M1's Account DELETE is muted. Assigning M1
    // directly (unmuted) GAINS Account delete; Gadget read is already held via
    // the group, so it is NOT gained.
    expect(d.objectPermissions).toEqual([{ kind: 'object', object: 'Account', flags: ['allowDelete'] }]);
    expect(d.summary.noOp).toBe(false);
  });
});

describe('whatIfPermset — validation + schema', () => {
  it('requires permissionSetId', () => {
    expect(whatIfAssignPermsetInputSchema.safeParse({}).success).toBe(false);
    expect(whatIfRevokePermsetInputSchema.safeParse({}).success).toBe(false);
  });

  it('returns component-not-found for an unknown target', async () => {
    const r = await whatIfAssignPermsetHandler(ctx, { permissionSetId: 'PermissionSet:Ghost' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('returns invalid-query for a wrong-type target prefix', async () => {
    const r = await whatIfRevokePermsetHandler(ctx, { permissionSetId: 'CustomObject:Account' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('returns invalid-query for a wrong-type baseline profile prefix', async () => {
    const r = await whatIfAssignPermsetHandler(ctx, {
      permissionSetId: 'PermissionSet:SalesConsole',
      baseline: { profileId: 'CustomObject:Account' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('paginates the delta and resumes via cursor with no dup/skip', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i += 1) {
      const r = await whatIfRevokePermsetHandler(ctx, {
        permissionSetId: 'PermissionSet:SalesConsole',
        baseline: { profileId: 'Profile:Base', permissionSetIds: ['PermissionSet:SalesConsole'] },
        limit: 1,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.value.data;
      for (const o of d.objectPermissions) seen.push(`object:${o.object}`);
      for (const f of d.fieldPermissions) seen.push(`field:${f.field}`);
      for (const s of d.systemPermissions) seen.push(`system:${s.permission}`);
      for (const c of d.customPermissions) seen.push(`custom:${c.name}`);
      for (const rt of d.recordTypeVisibilities) seen.push(`rt:${rt.recordType}`);
      cursor = d.nextCursor;
      if (cursor === undefined) break;
    }
    // Five distinct delta rows, each seen exactly once.
    expect(seen.sort()).toEqual(
      ['custom:SkipValidation', 'field:Widget.Secret__c', 'object:Widget', 'rt:Widget.Standard', 'system:ViewAllData'].sort(),
    );
  });
});
