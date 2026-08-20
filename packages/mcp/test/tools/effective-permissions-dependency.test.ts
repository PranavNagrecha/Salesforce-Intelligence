/// <reference types="vitest/globals" />

/**
 * The platform-dependency-expansion axis of `sfi.effective_permissions`.
 *
 * The bug being fixed: the tool unioned DECLARED grants only, so a
 * permission set granting `ManageUsers` reported ONE system permission
 * when Salesforce actually confers 15 — the platform refuses to save a
 * container whose required permissions are not also enabled. Declared-only
 * answers therefore understate effective access, systematically.
 *
 * These tests pin the honesty contract around the fix:
 *   - NO capture in the vault → an explicit "DECLARED only / may be
 *     UNDERSTATED" disclosure, never silent pre-fix behaviour.
 *   - A capture present → the closure is applied, and an added permission
 *     carries `impliedBy` with an EMPTY `grantedBy` — never presented as
 *     directly granted.
 *   - A TRUNCATED capture → disclosed, with the closure marked partial.
 *   - `ModifyAllData` has no dependency edges and expands to nothing.
 *
 * Hermetic: a temp vault directory, a temp DuckDB graph, synthetic
 * container names. No org, no network.
 */

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
import {
  savePermissionDependencies,
  type PermissionDependencyFile,
} from '@sf-intelligence/vault';

import type { Context } from '../../src/server.js';
import { effectivePermissionsHandler } from '../../src/tools/effective-permissions.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-08-20T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:permdep-fixture',
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

// One profile declaring ManageUsers + ModifyAllData; one permission set
// declaring EmailMass. Declared total = 3 system permissions.
const seed: ExtractionResult = {
  nodes: [
    node({
      id: 'Profile:SyntheticAdmin',
      type: 'Profile',
      apiName: 'SyntheticAdmin',
      properties: {
        userPermissions: ['ManageUsers', 'ModifyAllData', 'ImportPersonal'],
        recordTypeVisibilities: [],
      },
    }),
    node({
      id: 'PermissionSet:SyntheticMailer',
      type: 'PermissionSet',
      apiName: 'SyntheticMailer',
      properties: { userPermissions: ['EmailMass'], recordTypeVisibilities: [] },
    }),
    node({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
  ],
  edges: [
    edge({
      fromId: 'Profile:SyntheticAdmin',
      toId: 'CustomObject:Account',
      edgeType: 'grantedBy',
      properties: { allowRead: true },
    }),
  ],
};

/** The platform's measured type labels — the space is part of the value. */
const USER_T = 'User Permission';
const OBJECT_T = 'Object Permission';

const record = (permission: string, requiredPermission: string) => ({
  permission,
  permissionType: USER_T,
  requiredPermission,
  requiredPermissionType: USER_T,
});

/** A USER permission whose requirement is OBJECT-level — a real observed shape. */
const objectRecord = (permission: string, requiredPermission: string) => ({
  permission,
  permissionType: USER_T,
  requiredPermission,
  requiredPermissionType: OBJECT_T,
});

const CAPTURE: PermissionDependencyFile = {
  version: 1,
  capturedAt: '2026-08-20T09:00:00.000Z',
  source: 'tooling-api:PermissionDependency',
  edgeCount: 9,
  rawRowsReceived: 45,
  truncated: false,
  edges: [
    record('ManageUsers', 'ResetPasswords'),
    record('ManageUsers', 'ViewAllUsers'),
    record('ManageUsers', 'ManageProfilesPermissionsets'),
    record('ManageProfilesPermissionsets', 'ViewSetup'),
    // The real depth-2 platform chain.
    record('EmailMass', 'EmailSingle'),
    record('EmailSingle', 'EditTask'),
    // Real observed rows: a USER permission whose actual requirements are
    // OBJECT-level. Someone asking "what does ImportPersonal give this
    // user?" gets a materially incomplete answer if these vanish.
    objectRecord('ImportPersonal', 'Account<create>'),
    objectRecord('ImportPersonal', 'Account<update>'),
    objectRecord('ImportPersonal', 'Contact<create>'),
  ],
};

const CONTAINERS: { profileId: string; permissionSetIds: string[] } = {
  profileId: 'Profile:SyntheticAdmin',
  permissionSetIds: ['PermissionSet:SyntheticMailer'],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-permdep-eff-'));
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

describe('effective_permissions — NO dependency capture in the vault', () => {
  it('discloses declared-only + possible UNDERSTATEMENT instead of silently not expanding', async () => {
    const r = await effectivePermissionsHandler(ctx, { ...CONTAINERS });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.dependencyExpansion.available).toBe(false);
    expect(d.dependencyExpansion.impliedSystemPermissions).toBe(0);
    expect(d.dependencyExpansion.edgeCount).toBe(0);
    expect(d.dependencyExpansion.capturedAt).toBeUndefined();
    // Declared-only union: exactly the three declared permissions.
    expect(d.systemPermissions.map((s) => s.permission)).toEqual([
      'EmailMass',
      'ImportPersonal',
      'ManageUsers',
      'ModifyAllData',
    ]);
    expect(d.summary.impliedSystemPermissions).toBe(0);
    expect(d.impliedObjectPermissions).toEqual([]);
    const disclosure = d.disclosures.find((x) => x.includes('Dependency expansion UNAVAILABLE'));
    expect(disclosure).toBeDefined();
    expect(disclosure).toContain('DECLARED grants ONLY');
    expect(disclosure).toContain('UNDERSTATED');
    expect(disclosure).toContain('--with-tooling-api');
  });
});

describe('effective_permissions — dependency capture present', () => {
  beforeAll(async () => {
    const saved = await savePermissionDependencies(tempDir, CAPTURE);
    if (!saved.ok) throw new Error(saved.error.message);
  });

  it('expands the declared set through the closure', async () => {
    const r = await effectivePermissionsHandler(ctx, { ...CONTAINERS });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.dependencyExpansion.available).toBe(true);
    expect(d.dependencyExpansion.partial).toBe(false);
    expect(d.dependencyExpansion.capturedAt).toBe('2026-08-20T09:00:00.000Z');
    expect(d.systemPermissions.map((s) => s.permission)).toEqual([
      'EditTask',
      'EmailMass',
      'EmailSingle',
      'ImportPersonal',
      'ManageProfilesPermissionsets',
      'ManageUsers',
      'ModifyAllData',
      'ResetPasswords',
      'ViewAllUsers',
      'ViewSetup',
    ]);
    // 4 declared + 6 implied USER perms; the 3 object-level requirements are
    // partitioned out by DECLARED TYPE, not by name shape.
    expect(d.summary.systemPermissions).toBe(10);
    expect(d.summary.impliedSystemPermissions).toBe(6);
  });

  it('never presents an IMPLIED permission as directly granted', async () => {
    const r = await effectivePermissionsHandler(ctx, { ...CONTAINERS });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;

    const declared = d.systemPermissions.find((s) => s.permission === 'ManageUsers');
    expect(declared?.grantedBy).toEqual(['Profile:SyntheticAdmin']);
    expect(declared?.impliedBy).toBeUndefined();

    const implied = d.systemPermissions.find((s) => s.permission === 'ResetPasswords');
    expect(implied?.grantedBy).toEqual([]);
    expect(implied?.impliedBy?.rootPermission).toBe('ManageUsers');
    expect(implied?.impliedBy?.path).toEqual(['ManageUsers', 'ResetPasswords']);
    expect(implied?.impliedBy?.rootGrantedBy).toEqual(['Profile:SyntheticAdmin']);

    // Every implied row has an empty grantedBy; every granted row has none.
    for (const row of d.systemPermissions) {
      if (row.impliedBy !== undefined) expect(row.grantedBy).toEqual([]);
      else expect(row.grantedBy.length).toBeGreaterThan(0);
    }
  });

  it('cites a MULTI-HOP chain rather than collapsing it to the root', async () => {
    const r = await effectivePermissionsHandler(ctx, { ...CONTAINERS });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const viewSetup = r.value.data.systemPermissions.find((s) => s.permission === 'ViewSetup');
    expect(viewSetup?.impliedBy?.path).toEqual([
      'ManageUsers',
      'ManageProfilesPermissionsets',
      'ViewSetup',
    ]);
    const editTask = r.value.data.systemPermissions.find((s) => s.permission === 'EditTask');
    expect(editTask?.impliedBy?.path).toEqual(['EmailMass', 'EmailSingle', 'EditTask']);
    expect(editTask?.impliedBy?.rootGrantedBy).toEqual(['PermissionSet:SyntheticMailer']);
  });

  it('keeps ModifyAllData unexpanded — dependency is NOT risk', async () => {
    const r = await effectivePermissionsHandler(ctx, { ...CONTAINERS });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const mad = r.value.data.systemPermissions.find((s) => s.permission === 'ModifyAllData');
    expect(mad?.grantedBy).toEqual(['Profile:SyntheticAdmin']);
    expect(mad?.impliedBy).toBeUndefined();
    const applied = r.value.data.disclosures.find((x) =>
      x.includes('Dependency expansion applied'),
    );
    expect(applied).toContain('ZERO dependency edges');
  });

  // The motivating real case: ImportPersonal is a USER permission whose
  // actual requirements are OBJECT-level. "What does ImportPersonal give
  // this user?" is materially incomplete if these are dropped.
  it('surfaces the OBJECT-level requirements of a granted USER permission', async () => {
    const r = await effectivePermissionsHandler(ctx, { ...CONTAINERS });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.impliedObjectPermissions.map((o) => o.permission)).toEqual([
      'Account<create>',
      'Account<update>',
      'Contact<create>',
    ]);
    const acctCreate = d.impliedObjectPermissions.find(
      (o) => o.permission === 'Account<create>',
    );
    expect(acctCreate?.object).toBe('Account');
    expect(acctCreate?.flag).toBe('create');
    expect(acctCreate?.impliedBy.rootPermission).toBe('ImportPersonal');
    expect(acctCreate?.impliedBy.rootGrantedBy).toEqual(['Profile:SyntheticAdmin']);
  });

  it('partitions by the DECLARED type, keeping object tokens out of systemPermissions', async () => {
    const r = await effectivePermissionsHandler(ctx, { ...CONTAINERS });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    const names = d.systemPermissions.map((s) => s.permission);
    expect(names).not.toContain('Account<create>');
    expect(names).not.toContain('Account<update>');
    expect(names).not.toContain('Contact<create>');
    // The declared Account row is untouched — allowCreate stays false, because
    // an implied object requirement is NOT merged into the declared grant.
    const account = d.objectPermissions.find((o) => o.object === 'Account');
    expect(account?.allowRead).toBe(true);
    expect(account?.allowCreate).toBe(false);
  });

  // "N listed separately" understates the hold-back when object-level rows
  // are most of the graph. The disclosure must carry the PROPORTION.
  it('discloses the object-level PROPORTION and that object access may still be understated', async () => {
    const r = await effectivePermissionsHandler(ctx, { ...CONTAINERS });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const disclosure = r.value.data.disclosures.find((x) =>
      x.includes('OBJECT-LEVEL REQUIREMENTS ARE REPORTED BUT NOT MERGED'),
    );
    expect(disclosure).toBeDefined();
    // 3 of 9 captured edges require an object-level permission.
    expect(disclosure).toContain('3 of 9 captured dependency edges (33%)');
    expect(disclosure).toContain('STILL be UNDERSTATED');
    expect(disclosure).toContain('NOT used as expansion roots');
  });
});

describe('effective_permissions — TRUNCATED dependency capture', () => {
  beforeAll(async () => {
    const saved = await savePermissionDependencies(tempDir, {
      ...CAPTURE,
      rawRowsReceived: 10_000,
      truncated: true,
      truncationReason:
        'un-paged PermissionDependency query returned 10000 RAW records (2000 distinct edges), at or above the 10000-record server response cap',
    });
    if (!saved.ok) throw new Error(saved.error.message);
  });

  it('marks the closure PARTIAL and discloses the lower bound', async () => {
    const r = await effectivePermissionsHandler(ctx, { ...CONTAINERS });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.dependencyExpansion.available).toBe(true);
    expect(d.dependencyExpansion.partial).toBe(true);
    const disclosure = d.disclosures.find((x) => x.includes('Dependency capture is TRUNCATED'));
    expect(disclosure).toBeDefined();
    expect(disclosure).toContain('LOWER BOUND');
    expect(disclosure).toContain('10000-record server response cap');
    // Expansion still runs — a partial graph beats none.
    expect(d.summary.impliedSystemPermissions).toBe(6);
  });
});
