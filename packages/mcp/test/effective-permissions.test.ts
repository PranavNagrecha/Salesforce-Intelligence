/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  Edge,
  ExtractionResult,
  Node,
  VaultManifest,
} from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../src/server.js';
import { effectivePermissionsHandler } from '../src/tools/effective-permissions.js';
import {
  listComponentsHandler,
  listComponentsInputSchema,
} from '../src/tools/list-components.js';

// End-to-end coverage for the CustomPermission access surface (CR-CAP-10 grant
// + CR-CAP-15 definition node), spanning BOTH the list_components allow-list fix
// (type:'CustomPermission' was rejected at the Zod boundary) and the
// effective_permissions custom-permission union. The per-handler CR-CAP-10 unit
// coverage lives in test/tools/effective-permissions.test.ts; this file proves
// the two surfaces line up on ONE vault: a CustomPermission you can enumerate
// via list_components is the same one effective_permissions resolves (so its
// grant is targetMissing:false), while a managed-package grant with no
// definition node is honestly disclosed (targetMissing:true).

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-07-01T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:custperm-surface',
};

const node = (
  o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>,
): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'x.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

const edge = (
  o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...o,
});

// A Profile + a PermissionSet each grant a DEFINED custom permission, plus the
// permission set grants a managed-package name whose definition is absent.
const seed: ExtractionResult = {
  nodes: [
    node({
      id: 'Profile:CampusAdmin',
      type: 'Profile',
      apiName: 'CampusAdmin',
      properties: { userPermissions: ['ApiEnabled'] },
    }),
    node({
      id: 'PermissionSet:AdvisorAccess',
      type: 'PermissionSet',
      apiName: 'AdvisorAccess',
      properties: {},
    }),
    // Two in-vault CustomPermission definition nodes (CR-CAP-15).
    node({
      id: 'CustomPermission:View_Sensitive_Records',
      type: 'CustomPermission',
      apiName: 'View_Sensitive_Records',
      label: 'View Sensitive Records',
    }),
    node({
      id: 'CustomPermission:Bypass_Validation',
      type: 'CustomPermission',
      apiName: 'Bypass_Validation',
      label: 'Bypass Validation',
    }),
  ],
  edges: [
    // Both containers grant the same defined custom permission → union of two
    // containers, targetMissing:false.
    edge({
      fromId: 'Profile:CampusAdmin',
      toId: 'CustomPermission:View_Sensitive_Records',
      edgeType: 'grantedBy',
      properties: { enabled: true },
    }),
    edge({
      fromId: 'PermissionSet:AdvisorAccess',
      toId: 'CustomPermission:View_Sensitive_Records',
      edgeType: 'grantedBy',
      properties: { enabled: true },
    }),
    // Profile grants a second defined custom permission (permission set does not).
    edge({
      fromId: 'Profile:CampusAdmin',
      toId: 'CustomPermission:Bypass_Validation',
      edgeType: 'grantedBy',
      properties: { enabled: true },
    }),
    // Permission set grants a managed-package name with NO definition node.
    edge({
      fromId: 'PermissionSet:AdvisorAccess',
      toId: 'CustomPermission:TracRTC__Manage_Sessions',
      edgeType: 'grantedBy',
      properties: { enabled: true },
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-custperm-surface-'));
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

describe('CustomPermission access surface — list_components enumeration', () => {
  it('accepts type:CustomPermission at the Zod boundary (was rejected before the allow-list fix)', () => {
    const parsed = listComponentsInputSchema.safeParse({
      type: 'CustomPermission',
    });
    expect(parsed.success).toBe(true);
  });

  it('returns the CustomPermission definition nodes for type:CustomPermission', async () => {
    const r = await listComponentsHandler(ctx, { type: 'CustomPermission' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Only the two DEFINITION nodes are enumerable; grants live on edges, and a
    // managed-package name with no definition never becomes a node.
    expect(r.value.data.components.map((c) => c.id)).toEqual([
      'CustomPermission:Bypass_Validation',
      'CustomPermission:View_Sensitive_Records',
    ]);
    expect(r.value.data.totalCount).toBe(2);
    for (const c of r.value.data.components) {
      expect(c.type).toBe('CustomPermission');
    }
  });
});

describe('CustomPermission access surface — effective_permissions union', () => {
  it('surfaces defined grants (targetMissing:false) with per-container attribution and discloses the missing managed-package name', async () => {
    const r = await effectivePermissionsHandler(ctx, {
      profileId: 'Profile:CampusAdmin',
      permissionSetIds: ['PermissionSet:AdvisorAccess'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.customPermissions).toEqual([
      {
        name: 'Bypass_Validation',
        targetMissing: false,
        grantedBy: ['Profile:CampusAdmin'],
      },
      {
        name: 'TracRTC__Manage_Sessions',
        targetMissing: true,
        grantedBy: ['PermissionSet:AdvisorAccess'],
      },
      {
        name: 'View_Sensitive_Records',
        targetMissing: false,
        grantedBy: ['PermissionSet:AdvisorAccess', 'Profile:CampusAdmin'],
      },
    ]);
    expect(r.value.data.summary.customPermissions).toBe(3);
    // Custom permissions are NOT folded into systemPermissions.
    const sys = r.value.data.systemPermissions.map((s) => s.permission);
    expect(sys).not.toContain('View_Sensitive_Records');
    expect(sys).not.toContain('Bypass_Validation');
    // The undefined managed-package grant is disclosed, not dropped.
    expect(
      r.value.data.disclosures.some((d) =>
        d.includes('not present in this vault'),
      ),
    ).toBe(true);
  });

  // RT parity, older-vault path: NEITHER seeded container carries a
  // recordTypeVisibilities property (pre-extraction vault) — the union must
  // not throw, contributes nothing, and discloses the re-refresh remedy.
  it('an absent recordTypeVisibilities property yields an empty RT union plus a re-refresh disclosure, never a throw', async () => {
    const r = await effectivePermissionsHandler(ctx, {
      profileId: 'Profile:CampusAdmin',
      permissionSetIds: ['PermissionSet:AdvisorAccess'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.recordTypeVisibilities).toEqual([]);
    expect(r.value.data.summary.recordTypeVisibilities).toBe(0);
    expect(
      r.value.data.disclosures.some(
        (d) =>
          d.includes('recordTypeVisibilities') &&
          d.includes('/sfi-refresh') &&
          d.includes('Profile:CampusAdmin') &&
          d.includes('PermissionSet:AdvisorAccess'),
      ),
    ).toBe(true);
  });

  it('links the two surfaces: every non-missing effective grant is enumerable via list_components', async () => {
    const listed = await listComponentsHandler(ctx, {
      type: 'CustomPermission',
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const definedIds = new Set(listed.value.data.components.map((c) => c.id));

    const eff = await effectivePermissionsHandler(ctx, {
      profileId: 'Profile:CampusAdmin',
      permissionSetIds: ['PermissionSet:AdvisorAccess'],
    });
    expect(eff.ok).toBe(true);
    if (!eff.ok) return;
    for (const cp of eff.value.data.customPermissions) {
      // targetMissing exactly tracks "not enumerable via list_components".
      expect(definedIds.has(`CustomPermission:${cp.name}`)).toBe(
        !cp.targetMissing,
      );
    }
  });
});
