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
import { objectAccessAuditHandler } from '../../src/tools/object-access-audit.js';

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
    });
    expect(r.value.data.notModeled).toBe(false);
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
