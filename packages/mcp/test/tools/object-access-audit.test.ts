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
  objectAccessAuditHandler,
  objectAccessAuditInputSchema,
} from '../../src/tools/object-access-audit.js';

import { measureGraphQueries } from './_graph-query-budget.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-08T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 1, Profile: 1, PermissionSet: 1 },
  edges: { grantedBy: 2 },
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

const OBJ = 'CustomObject:Widget__c';
const ADMIN = 'Profile:Admin';
const READER_PS = 'PermissionSet:ReadOnly';

// A retrieved object with an admin profile (full CRUD + Modify All) and a
// read-only permission set (read only).
const seed: ExtractionResult = {
  nodes: [
    node({ id: OBJ, type: 'CustomObject', apiName: 'Widget__c', label: 'Widget', properties: { sharingModel: 'Private' } }),
    node({ id: ADMIN, type: 'Profile', apiName: 'Admin' }),
    node({ id: READER_PS, type: 'PermissionSet', apiName: 'ReadOnly' }),
  ],
  edges: [
    edge({
      fromId: ADMIN,
      toId: OBJ,
      edgeType: 'grantedBy',
      properties: {
        allowCreate: true,
        allowRead: true,
        allowEdit: true,
        allowDelete: true,
        modifyAllRecords: true,
        viewAllRecords: true,
      },
    }),
    edge({
      fromId: READER_PS,
      toId: OBJ,
      edgeType: 'grantedBy',
      properties: { allowRead: true },
    }),
  ],
};

// A phantom object: not retrieved (no node) but referenced by a grant edge.
const PHANTOM = 'CustomObject:Managed__x';
const phantomSeed: ExtractionResult = {
  nodes: [node({ id: 'Profile:Support', type: 'Profile', apiName: 'Support' })],
  edges: [
    edge({
      fromId: 'Profile:Support',
      toId: PHANTOM,
      edgeType: 'grantedBy',
      properties: { allowRead: true, allowEdit: true },
    }),
  ],
};

let store: GraphStore;
let tempDir: string;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-obj-access-'));
  const opened = await openGraph(join(tempDir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [seed, phantomSeed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('objectAccessAuditHandler', () => {
  it('enumerates per-granter CRUD + View/Modify-All bits', async () => {
    const r = await objectAccessAuditHandler(ctx, { componentId: OBJ });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { grants } = r.value.data;
    expect(grants).toHaveLength(2);
    const admin = grants.find((g) => g.granterId === ADMIN)!;
    expect(admin.allowCreate && admin.allowRead && admin.allowEdit && admin.allowDelete).toBe(true);
    expect(admin.modifyAllRecords && admin.viewAllRecords).toBe(true);
    expect(admin.granterType).toBe('Profile');
    const reader = grants.find((g) => g.granterId === READER_PS)!;
    expect(reader.allowRead).toBe(true);
    expect(reader.allowEdit || reader.allowDelete || reader.allowCreate).toBe(false);
    expect(reader.granterType).toBe('PermissionSet');
  });

  it('summarizes the CRUD tallies', async () => {
    const r = await objectAccessAuditHandler(ctx, { componentId: OBJ });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.summary).toEqual({
      granters: 2,
      distinctGranters: 2,
      create: 1,
      read: 2,
      edit: 1,
      delete: 1,
      viewAll: 1,
      modifyAll: 1,
      // OBJECT-ACCESS-SUMMARY-MIXES-GRANTER-KINDS: the flat tallies above are
      // row counts over Profiles + PermissionSets + PSG duplicate rows. The
      // per-kind, distinct-actor split is what answers "how many PROFILES".
      byGranterType: {
        Profile: {
          granters: 1,
          create: 1,
          read: 1,
          edit: 1,
          delete: 1,
          viewAll: 1,
          modifyAll: 1,
        },
        PermissionSet: {
          granters: 1,
          create: 0,
          read: 1,
          edit: 0,
          delete: 0,
          viewAll: 0,
          modifyAll: 0,
        },
        PermissionSetGroup: {
          granters: 0,
          create: 0,
          read: 0,
          edit: 0,
          delete: 0,
          viewAll: 0,
          modifyAll: 0,
        },
      },
    });
    expect(r.value.data.notModeled).toBe(false);
  });

  // OBJECT-ACCESS-SUMMARY-MIXES-GRANTER-KINDS. The owner's question is "which
  // profiles will be affected — X profiles who can create it, X who can edit".
  // `summary.create` cannot answer it: it counts Profile rows + PermissionSet
  // rows + PermissionSetGroup rows, and a PSG row is a COPY of its member
  // permission set's flags, so the same access is counted twice. Measured on a
  // real hub object: `summary.create` = 35 against a true profile answer of 20.
  it('answers "how many PROFILES can create/edit" without mixing in permission sets', async () => {
    const r = await objectAccessAuditHandler(ctx, { componentId: OBJ });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.value.data.summary;
    // The flat tally spans both populations…
    expect(s.read).toBe(2);
    // …while the profile-only answer is 1. These must not be conflated.
    expect(s.byGranterType.Profile.read).toBe(1);
    expect(s.byGranterType.Profile.create).toBe(1);
    expect(s.byGranterType.Profile.edit).toBe(1);
    expect(s.byGranterType.PermissionSet.read).toBe(1);
    expect(s.byGranterType.PermissionSet.create).toBe(0);
    // And the note must say the flat tallies are not a profile count, fire even
    // though no granter here has two access paths, and refuse a user reading.
    const note = r.value.data.note ?? '';
    expect(note).toContain('ROW counts');
    expect(note).toContain('byGranterType.Profile');
    expect(note).toContain('never a USER count');
  });

  // OBJECT-ACCESS-PERMSET-MODE-ZEROS: the PermissionSet branch is a disclosure
  // mode; its all-zero summary must not read as "this permission set grants
  // nothing".
  it('explains the all-zero summary in PermissionSet disclosure mode', async () => {
    const r = await objectAccessAuditHandler(ctx, { componentId: READER_PS });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.summary.granters).toBe(0);
    const note = r.value.data.note ?? '';
    expect(note).toContain('BY CONSTRUCTION');
    expect(note).toContain('do NOT mean this permission set grants nothing');
  });

  it('rejects a non-CustomObject id with invalid-query', async () => {
    const r = await objectAccessAuditHandler(ctx, { componentId: 'Profile:Admin' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('audits a phantom (not-retrieved-but-referenced) object with notModeled', async () => {
    const r = await objectAccessAuditHandler(ctx, { componentId: PHANTOM });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.notModeled).toBe(true);
    expect(r.value.data.notModeledNote).toContain('not retrieved');
    expect(r.value.data.grants).toHaveLength(1);
    expect(r.value.data.grants[0]!.allowEdit).toBe(true);
  });

  it('returns component-not-found for an id with no node and no grants', async () => {
    const r = await objectAccessAuditHandler(ctx, { componentId: 'CustomObject:Nope__c' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });
});

// =============================================================================
// GUARD (OBJECT-ACCESS-AUDIT-REJECTS-OBJECTAPINAME): the router sends admins here
// with the natural object key, but `objectApiName` used to be Zod-stripped and
// the tool hard-failed with `componentId: Required`. The alias must now (a) pass
// the input schema and (b) produce the SAME audit as the canonical CustomObject
// id. Pre-fix the schema rejects `{ objectApiName }` (componentId required), so
// the first assertion is RED before the fix.
describe('objectAccessAuditHandler — objectApiName / objectId aliases (guard)', () => {
  it('accepts objectApiName at the schema layer (was stripped → componentId Required)', () => {
    const parsed = objectAccessAuditInputSchema.safeParse({ objectApiName: 'Widget__c' });
    expect(parsed.success).toBe(true);
  });

  it('objectApiName audit ≡ CustomObject componentId audit', async () => {
    const byName = await objectAccessAuditHandler(ctx, { objectApiName: 'Widget__c' });
    const byId = await objectAccessAuditHandler(ctx, { componentId: OBJ });
    expect(byName.ok && byId.ok).toBe(true);
    if (!byName.ok || !byId.ok) return;
    expect(byName.value.data.summary).toEqual(byId.value.data.summary);
    expect(byName.value.data.grants).toEqual(byId.value.data.grants);
    expect(byName.value.data.appliedScope).toEqual({ componentId: OBJ, object: 'Widget__c' });
  });

  it('objectId (canonical) alias resolves identically', async () => {
    const r = await objectAccessAuditHandler(ctx, { objectId: OBJ });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.appliedScope.componentId).toBe(OBJ);
    expect(r.value.data.grants).toHaveLength(2);
  });

  it('rejects disagreeing aliases with invalid-query (never a silent pick)', async () => {
    const r = await objectAccessAuditHandler(ctx, {
      componentId: OBJ,
      objectApiName: 'Other__c',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });
});

// =============================================================================
// N+1 query budget (finding C-1). Grantor resolution used to `getNodeById`
// once per inbound grantedBy edge — Account-class hubs fan out to hundreds of
// grants. It is now a single `listNodesByIds` batch, so the count must NOT
// scale with the granter count. (The reverse-PSG walk stays per-pair — its
// expand/find helpers dominate — so this fixture uses only direct grants.)
// =============================================================================
describe('objectAccessAuditHandler — bounded graph queries', () => {
  const seedWideObject = async (granterCount: number) => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-oaa-budget-'));
    const opened = await openGraph(join(dir, 'oaa.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    const s = opened.value;
    const nodes: Node[] = [
      node({ id: 'CustomObject:Wide__c', type: 'CustomObject', apiName: 'Wide__c' }),
    ];
    const edges: Edge[] = [];
    for (let i = 0; i < granterCount; i += 1) {
      nodes.push(node({ id: `Profile:P${i}`, type: 'Profile', apiName: `P${i}` }));
      edges.push(
        edge({
          fromId: `Profile:P${i}`,
          toId: 'CustomObject:Wide__c',
          edgeType: 'grantedBy',
          properties: { allowRead: true },
        }),
      );
    }
    const imported = await importExtractionResults(s, [{ nodes, edges }]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    const wideCtx = { vaultRoot: dir, manifest: MANIFEST, graph: s };
    const measured = await measureGraphQueries(s, () =>
      objectAccessAuditHandler(wideCtx, { componentId: 'CustomObject:Wide__c' }),
    );
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });
    return measured;
  };

  it('issues a query count independent of the granter count', async () => {
    const small = await seedWideObject(60);
    const large = await seedWideObject(200);
    expect(small.result.ok).toBe(true);
    expect(large.result.ok).toBe(true);
    // ONE batched grantor fetch — not one per grant.
    expect(large.nodeQueries).toBe(small.nodeQueries);
    expect(large.edgeQueries).toBe(small.edgeQueries);
    expect(large.nodeQueries + large.edgeQueries).toBeLessThanOrEqual(4);
  });
});
