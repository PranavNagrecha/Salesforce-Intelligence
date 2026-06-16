/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { layoutAssignmentsHandler } from '../../src/tools/layout-assignments.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-08T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: { Layout: 1, Profile: 3 },
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

const LAYOUT = 'Layout:Account.Account Layout';

// Account Layout is assigned by Admin twice (default + Administrative record
// type); Sales assigns a different layout; NoData carries no layoutAssignments.
const seed: ExtractionResult = {
  nodes: [
    node({ id: LAYOUT, type: 'Layout', apiName: 'Account.Account Layout', label: 'Account Layout' }),
    node({
      id: 'Profile:Admin',
      type: 'Profile',
      apiName: 'Admin',
      properties: {
        layoutAssignments: [
          { layout: 'Account-Account Layout', recordType: null },
          { layout: 'Account-Account Layout', recordType: 'Account.Administrative' },
          { layout: 'Contact-Contact Layout', recordType: null },
        ],
      },
    }),
    node({
      id: 'Profile:Sales',
      type: 'Profile',
      apiName: 'Sales',
      properties: {
        layoutAssignments: [{ layout: 'Account-Partner Account Layout', recordType: 'Account.Partner' }],
      },
    }),
    node({ id: 'Profile:NoData', type: 'Profile', apiName: 'NoData' }),
  ],
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-layout-assignments-'));
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

describe('layoutAssignmentsHandler', () => {
  it('rejects a non-Layout componentId with invalid-query', async () => {
    const r = await layoutAssignmentsHandler(ctx, { componentId: 'CustomObject:Account' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('returns component-not-found for an unknown layout', async () => {
    const r = await layoutAssignmentsHandler(ctx, { componentId: 'Layout:Account.No Such Layout' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('lists the (profile × record type) assignments targeting the layout', async () => {
    const r = await layoutAssignmentsHandler(ctx, { componentId: LAYOUT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { assignments, summary, object } = r.value.data;
    expect(object).toBe('Account');
    // Admin assigns it twice (default + Administrative); Sales does not.
    expect(assignments.length).toBe(2);
    expect(assignments.every((a) => a.profileId === 'Profile:Admin')).toBe(true);
    const recordTypes = assignments.map((a) => a.recordType).sort();
    expect(recordTypes).toEqual(['Account.Administrative', null]);
    // The non-null record type carries a canonical RecordType id.
    const rt = assignments.find((a) => a.recordType === 'Account.Administrative');
    expect(rt?.recordTypeId).toBe('RecordType:Account.Administrative');
    const def = assignments.find((a) => a.recordType === null);
    expect(def?.recordTypeId).toBe(null);
    expect(summary.profiles).toBe(1);
    expect(summary.assignments).toBe(2);
  });

  it('paginates the assignment list while keeping the summary complete', async () => {
    const r = await layoutAssignmentsHandler(ctx, { componentId: LAYOUT, limit: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.assignments.length).toBe(1); // page of 1
    expect(r.value.data.summary.assignments).toBe(2); // full count
    expect(r.value.data.hasMore).toBe(true);
    expect(r.value.data.truncated).toBe(true);
    expect(r.value.data.boundaryNote).toContain('of 2');
    // Second page returns the rest.
    const r2 = await layoutAssignmentsHandler(ctx, { componentId: LAYOUT, limit: 1, offset: 1 });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.data.assignments.length).toBe(1);
    expect(r2.value.data.hasMore).toBe(false);
  });

  it('discloses the classic-only scope in boundaryNote', async () => {
    const r = await layoutAssignmentsHandler(ctx, { componentId: LAYOUT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaryNote).toContain('Lightning record pages (FlexiPage)');
    expect(r.value.data.confidence).toBe('declared');
  });
});

// A vault where the layout exists but NO profile carries layoutAssignments —
// the result must DISCLOSE "not modeled", not a confident empty list.
describe('layoutAssignmentsHandler — extraction gap', () => {
  let gapDir: string;
  let gapStore: GraphStore;
  let gapCtx: Context;

  beforeAll(async () => {
    gapDir = mkdtempSync(join(tmpdir(), 'sfi-layout-assignments-gap-'));
    const opened = await openGraph(join(gapDir, 'g.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    gapStore = opened.value;
    const imported = await importExtractionResults(gapStore, [
      {
        nodes: [
          node({ id: LAYOUT, type: 'Layout', apiName: 'Account.Account Layout' }),
          node({ id: 'Profile:Bare', type: 'Profile', apiName: 'Bare' }),
        ],
        edges: [],
      } as ExtractionResult,
    ]);
    if (!imported.ok) throw new Error(imported.error.message);
    gapCtx = { vaultRoot: gapDir, manifest: MANIFEST, graph: gapStore };
  });

  afterAll(async () => {
    await closeGraph(gapStore);
    rmSync(gapDir, { recursive: true, force: true });
  });

  it('discloses the extraction gap when no profile carries layoutAssignments', async () => {
    const r = await layoutAssignmentsHandler(gapCtx, { componentId: LAYOUT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.assignments.length).toBe(0);
    expect(r.value.data.boundaryNote).toContain('not modeled');
  });
});
