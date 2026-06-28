/// <reference types="vitest/globals" />

/**
 * CR-CAP-04 — PermissionSetGroup (PSG) expansion across the three access tools.
 *
 * A user assigned ONLY a PermissionSetGroup must get a REAL, declared-confidence
 * answer, not `unknown` / a missing grant. PSG membership is DECLARED metadata
 * (a PSG lists its member permission sets + muting permission sets), so consuming
 * it yields a real answer. This file pins the capability gain:
 *
 *   F1 effective_permissions: a PSG-only user gets the member permset's perms.
 *   F2 why_cant_user_see_record: a PSG-only user gets a real verdict, not unknown.
 *   F3 muting: full member perms still present + a muting caveat (NOT subtracted).
 *   F4 direct + PSG: not double-counted (containers deduped).
 *   F5 who_can_access_object: a reverse PSG row surfaces (distinct access path).
 */

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

import type { Context } from '../../src/server.js';
import { effectivePermissionsHandler } from '../../src/tools/effective-permissions.js';
import { objectAccessAuditHandler } from '../../src/tools/object-access-audit.js';
import { whyCantUserSeeRecordHandler } from '../../src/tools/why-cant-user-see-record.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-08T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
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

/** Open a throwaway graph seeded with one ExtractionResult; returns ctx + cleanup. */
const seedCtx = async (
  seed: ExtractionResult,
): Promise<{ ctx: Context; cleanup: () => Promise<void> }> => {
  const tempDir = mkdtempSync(join(tmpdir(), 'sfi-psg-'));
  const opened = await openGraph(join(tempDir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  const store: GraphStore = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(imported.error.message);
  const ctx: Context = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
  return {
    ctx,
    cleanup: async () => {
      await closeGraph(store);
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
};

// ===========================================================================
// F1 — effective_permissions: a PSG-only user gets the member permset's perms.
// ===========================================================================

describe('CR-CAP-04 F1: effective_permissions expands a PSG into member perms', () => {
  const WIDGET = 'CustomObject:Widget';
  const SALES_PS = 'PermissionSet:Sales_PS';
  const SALES_GROUP = 'PermissionSetGroup:Sales_Group';
  const seed: ExtractionResult = {
    nodes: [
      node({ id: WIDGET, type: 'CustomObject', apiName: 'Widget' }),
      node({ id: SALES_PS, type: 'PermissionSet', apiName: 'Sales_PS' }),
      node({
        id: SALES_GROUP,
        type: 'PermissionSetGroup',
        apiName: 'Sales_Group',
        properties: { permissionSets: ['Sales_PS'] },
      }),
    ],
    edges: [
      edge({
        fromId: SALES_PS,
        toId: WIDGET,
        edgeType: 'grantedBy',
        properties: { allowRead: true, allowEdit: true },
      }),
      // PSG -> member references edge (mirror of the property; some helpers walk it).
      edge({
        fromId: SALES_GROUP,
        toId: SALES_PS,
        edgeType: 'references',
        properties: { referenceKind: 'permissionSetGroupMember' },
      }),
    ],
  };

  let ctx: Context;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ ctx, cleanup } = await seedCtx(seed));
  });
  afterAll(() => cleanup());

  it('a PSG-only user gets the member permission set perms on Widget', async () => {
    const r = await effectivePermissionsHandler(ctx, {
      permissionSetIds: [SALES_GROUP],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const widget = r.value.data.objectPermissions.find(
      (o) => o.object === 'Widget',
    );
    expect(widget).toBeDefined();
    expect(widget?.allowRead).toBe(true);
    expect(widget?.allowEdit).toBe(true);
    // Attributed to the member permission set that actually grants it.
    expect(widget?.grantedBy).toContain(SALES_PS);
  });
});

// ===========================================================================
// F2 — why_cant: a PSG-only user gets a REAL verdict, not unknown.
// ===========================================================================

describe('CR-CAP-04 F2: why_cant resolves a PSG-only user to a real verdict', () => {
  const ACCT = 'CustomObject:Acct';
  const READER_PS = 'PermissionSet:Reader_PS';
  const READER_GROUP = 'PermissionSetGroup:Reader_Group';
  const seed: ExtractionResult = {
    nodes: [
      node({
        id: ACCT,
        type: 'CustomObject',
        apiName: 'Acct',
        properties: { sharingModel: 'Private' },
      }),
      node({ id: READER_PS, type: 'PermissionSet', apiName: 'Reader_PS' }),
      node({
        id: READER_GROUP,
        type: 'PermissionSetGroup',
        apiName: 'Reader_Group',
        properties: { permissionSets: ['Reader_PS'] },
      }),
    ],
    edges: [
      edge({
        fromId: READER_PS,
        toId: ACCT,
        edgeType: 'grantedBy',
        properties: { allowRead: true },
      }),
      edge({
        fromId: READER_GROUP,
        toId: READER_PS,
        edgeType: 'references',
        properties: { referenceKind: 'permissionSetGroupMember' },
      }),
    ],
  };

  let ctx: Context;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ ctx, cleanup } = await seedCtx(seed));
  });
  afterAll(() => cleanup());

  it('the object-Read precondition passes via the folded member permset', async () => {
    const r = await whyCantUserSeeRecordHandler(ctx, {
      componentId: ACCT,
      accessLevel: 'read',
      userContext: { permissionSetIds: [READER_GROUP] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // BEFORE the fix: the object-Read precondition fails (PSG never expanded),
    // so verdict is the bogus "no object Read" restricted.
    const restrictedNoRead = r.value.data.reasoning.find(
      (s) =>
        s.stage === 'PermissionGrant' &&
        s.verdict === 'restricted' &&
        /no object Read permission/i.test(s.reason),
    );
    expect(restrictedNoRead).toBeUndefined();

    // The PSG step must NOT be the old always-unknown stub.
    const psgStep = r.value.data.reasoning.find(
      (s) => s.stage === 'PermissionSetGroup',
    );
    expect(psgStep).toBeDefined();
    expect(psgStep?.verdict).not.toBe('unknown');
  });
});

// ===========================================================================
// F3 — muting: full member perms present + a caveat (NOT subtracted).
// ===========================================================================

describe('CR-CAP-04 F3: muting is disclosed but never subtracted', () => {
  const WIDGET = 'CustomObject:Widget';
  const SALES_PS = 'PermissionSet:Sales_PS';
  const MUTE_PS = 'MutingPermissionSet:Mute_PS';
  const SALES_GROUP = 'PermissionSetGroup:Sales_Group';
  const seed: ExtractionResult = {
    nodes: [
      node({ id: WIDGET, type: 'CustomObject', apiName: 'Widget' }),
      node({ id: SALES_PS, type: 'PermissionSet', apiName: 'Sales_PS' }),
      // A muting permission set node as the generic extractor produces it:
      // no userPermissions, no grantedBy. Nothing enumerable to subtract.
      node({ id: MUTE_PS, type: 'MutingPermissionSet', apiName: 'Mute_PS' }),
      node({
        id: SALES_GROUP,
        type: 'PermissionSetGroup',
        apiName: 'Sales_Group',
        properties: {
          permissionSets: ['Sales_PS'],
          mutingPermissionSets: ['Mute_PS'],
        },
      }),
    ],
    edges: [
      edge({
        fromId: SALES_PS,
        toId: WIDGET,
        edgeType: 'grantedBy',
        properties: { allowRead: true, allowEdit: true },
      }),
      edge({
        fromId: SALES_GROUP,
        toId: SALES_PS,
        edgeType: 'references',
        properties: { referenceKind: 'permissionSetGroupMember' },
      }),
      edge({
        fromId: SALES_GROUP,
        toId: MUTE_PS,
        edgeType: 'references',
        properties: { referenceKind: 'mutingPermissionSet' },
      }),
    ],
  };

  let ctx: Context;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ ctx, cleanup } = await seedCtx(seed));
  });
  afterAll(() => cleanup());

  it('member perms remain fully present and a muting caveat is emitted', async () => {
    const r = await effectivePermissionsHandler(ctx, {
      permissionSetIds: [SALES_GROUP],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const widget = r.value.data.objectPermissions.find(
      (o) => o.object === 'Widget',
    );
    // Muting removes NOTHING — perms fully present.
    expect(widget?.allowRead).toBe(true);
    expect(widget?.allowEdit).toBe(true);
    // A muting caveat must be disclosed, and it must say muting is NOT
    // subtracted — never claim subtraction happened.
    const muteCaveat = r.value.data.disclosures.find((d) => /muting/i.test(d));
    expect(muteCaveat).toBeDefined();
    expect(muteCaveat).toMatch(/not subtracted/i);
    // The honesty invariant: it must never assert muting WAS applied/subtracted.
    expect(muteCaveat).not.toMatch(/\bsubtracted from\b|\bwas subtracted\b|\bare subtracted\b/i);
  });
});

// ===========================================================================
// F4 — direct + PSG: not double-counted (containers deduped).
// ===========================================================================

describe('CR-CAP-04 F4: a permset reachable directly AND via a PSG is not double-counted', () => {
  const WIDGET = 'CustomObject:Widget';
  const BOTH_PS = 'PermissionSet:Both_PS';
  const GRP = 'PermissionSetGroup:Grp';
  const seed: ExtractionResult = {
    nodes: [
      node({ id: WIDGET, type: 'CustomObject', apiName: 'Widget' }),
      node({ id: BOTH_PS, type: 'PermissionSet', apiName: 'Both_PS' }),
      node({
        id: GRP,
        type: 'PermissionSetGroup',
        apiName: 'Grp',
        properties: { permissionSets: ['Both_PS'] },
      }),
    ],
    edges: [
      edge({
        fromId: BOTH_PS,
        toId: WIDGET,
        edgeType: 'grantedBy',
        properties: { allowRead: true },
      }),
      edge({
        fromId: GRP,
        toId: BOTH_PS,
        edgeType: 'references',
        properties: { referenceKind: 'permissionSetGroupMember' },
      }),
    ],
  };

  let ctx: Context;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ ctx, cleanup } = await seedCtx(seed));
  });
  afterAll(() => cleanup());

  it('exactly one Widget row and Both_PS cited exactly once', async () => {
    const r = await effectivePermissionsHandler(ctx, {
      permissionSetIds: [BOTH_PS, GRP],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const widgetRows = r.value.data.objectPermissions.filter(
      (o) => o.object === 'Widget',
    );
    expect(widgetRows).toHaveLength(1);
    const cited = widgetRows[0]?.grantedBy.filter((g) => g === BOTH_PS) ?? [];
    expect(cited).toHaveLength(1);
    // The container list itself must not list the member twice (the genuine
    // dedup signal — Both_PS reaches the union directly AND via Grp).
    const containerHits = r.value.data.containers.filter((c) => c === BOTH_PS);
    expect(containerHits).toHaveLength(1);
  });
});

// ===========================================================================
// F5 — who_can_access_object: a reverse PSG row surfaces.
// ===========================================================================

describe('CR-CAP-04 F5: who_can_access_object surfaces a distinct PSG row', () => {
  const WIDGET = 'CustomObject:Widget';
  const SALES_PS = 'PermissionSet:Sales_PS';
  const SALES_GROUP = 'PermissionSetGroup:Sales_Group';
  const seed: ExtractionResult = {
    nodes: [
      node({ id: WIDGET, type: 'CustomObject', apiName: 'Widget' }),
      node({ id: SALES_PS, type: 'PermissionSet', apiName: 'Sales_PS' }),
      node({
        id: SALES_GROUP,
        type: 'PermissionSetGroup',
        apiName: 'Sales_Group',
        properties: { permissionSets: ['Sales_PS'] },
      }),
    ],
    edges: [
      edge({
        fromId: SALES_PS,
        toId: WIDGET,
        edgeType: 'grantedBy',
        properties: { allowRead: true, allowEdit: true },
      }),
      // The reverse helper walks edges, so the membership edge is required.
      edge({
        fromId: SALES_GROUP,
        toId: SALES_PS,
        edgeType: 'references',
        properties: { referenceKind: 'permissionSetGroupMember' },
      }),
    ],
  };

  let ctx: Context;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ ctx, cleanup } = await seedCtx(seed));
  });
  afterAll(() => cleanup());

  it('emits both the direct Sales_PS row and a Sales_Group PSG row', async () => {
    const r = await objectAccessAuditHandler(ctx, { componentId: WIDGET });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const grants = r.value.data.grants;
    const direct = grants.find((g) => g.granterId === SALES_PS);
    expect(direct).toBeDefined();
    const psgRow = grants.find((g) => g.granterId === SALES_GROUP);
    expect(psgRow).toBeDefined();
    expect(psgRow?.granterType).toBe('PermissionSetGroup');
    // Same CRUD flags conferred through the group.
    expect(psgRow?.allowRead).toBe(true);
    expect(psgRow?.allowEdit).toBe(true);
    // The PSG counts as its own distinct access path.
    expect(r.value.data.summary.distinctGranters).toBe(2);
  });
});
