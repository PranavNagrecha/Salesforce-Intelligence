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
import { listViewSharingHandler } from '../../src/tools/list-view-sharing.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-08T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null, parentId: null, sourcePath: 'x.xml', lastModifiedDate: null,
  lastModifiedBy: null, apiVersion: null, properties: {}, ...o,
});

const lv = (
  apiName: string,
  filterScope: string,
  sharedTo: Array<Record<string, unknown>>,
): Node =>
  node({
    id: `ListView:Account.${apiName}`,
    type: 'ListView',
    apiName: `Account.${apiName}`,
    parentId: 'CustomObject:Account',
    properties: { filterScope, sharedTo },
  });

const seed: ExtractionResult = {
  nodes: [
    node({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
    lv('Shared', 'Everything', [
      { type: 'role', name: 'VP_Sales', targetId: 'Role:VP_Sales' },
      { type: 'roleAndSubordinates', name: 'Reps', targetId: 'Role:Reps', inheritance: 'subordinates' },
      { type: 'allInternalUsers', name: null, targetId: 'Group:AllInternalUsers', synthetic: true },
    ]),
    lv('Public', 'Everything', []),
    lv('MineOnly', 'Mine', []),
    // A list view on a DIFFERENT object — must not leak into the Account query.
    node({
      id: 'ListView:Contact.Other', type: 'ListView', apiName: 'Contact.Other',
      parentId: 'CustomObject:Contact', properties: { filterScope: 'Everything', sharedTo: [] },
    }),
  ],
  edges: [],
};

let tempDir: string; let store: GraphStore; let ctx: Context;
beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-lv-sharing-'));
  const o = await openGraph(join(tempDir, 'g.db')); if (!o.ok) throw new Error(o.error.message);
  store = o.value;
  const i = await importExtractionResults(store, [seed]); if (!i.ok) throw new Error(i.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});
afterAll(async () => { await closeGraph(store); rmSync(tempDir, { recursive: true, force: true }); });

describe('listViewSharingHandler', () => {
  it('rejects a non-object/non-listview id', async () => {
    const r = await listViewSharingHandler(ctx, { componentId: 'Flow:X' });
    expect(r.ok).toBe(false); if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('object mode: lists the object’s list views with a whole-object summary', async () => {
    const r = await listViewSharingHandler(ctx, { componentId: 'CustomObject:Account' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.scope).toBe('object');
    // 3 Account list views; Contact's does NOT leak in.
    expect(d.summary.listViews).toBe(3);
    expect(d.summary.sharedWithGroupsRoles).toBe(1);
    expect(d.summary.allUsersWithObjectAccess).toBe(2);
    expect(d.summary.distinctTargets).toBe(3);
    expect(d.listViews.every((row) => row.componentId.startsWith('ListView:Account.'))).toBe(true);
  });

  it('object mode: classifies visibility + surfaces inheritance/synthetic markers', async () => {
    const r = await listViewSharingHandler(ctx, { componentId: 'CustomObject:Account' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const shared = r.value.data.listViews.find((row) => row.componentId === 'ListView:Account.Shared')!;
    expect(shared.visibility).toBe('sharedWithGroupsRoles');
    expect(shared.sharedToCount).toBe(3);
    expect(shared.sharedTo.find((t) => t.targetId === 'Role:Reps')?.inheritance).toBe('subordinates');
    expect(shared.sharedTo.find((t) => t.targetId === 'Group:AllInternalUsers')?.synthetic).toBe(true);
    const pub = r.value.data.listViews.find((row) => row.componentId === 'ListView:Account.Public')!;
    expect(pub.visibility).toBe('allUsersWithObjectAccess');
  });

  it('object mode: paginates rows but keeps the summary whole', async () => {
    const r = await listViewSharingHandler(ctx, { componentId: 'CustomObject:Account', limit: 1, offset: 0 });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.listViews).toHaveLength(1);
    expect(r.value.data.hasMore).toBe(true);
    expect(r.value.data.summary.listViews).toBe(3);
  });

  it('listView mode: returns the single view in the same row shape', async () => {
    const r = await listViewSharingHandler(ctx, { componentId: 'ListView:Account.Shared' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.scope).toBe('listView');
    expect(r.value.data.listViews).toHaveLength(1);
    expect(r.value.data.listViews[0]?.componentId).toBe('ListView:Account.Shared');
    expect(r.value.data.summary.sharedWithGroupsRoles).toBe(1);
  });

  it('listView mode: component-not-found for an unknown list view', async () => {
    const r = await listViewSharingHandler(ctx, { componentId: 'ListView:Account.Nope' });
    expect(r.ok).toBe(false); if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('always discloses the view-vs-record-access boundary', async () => {
    const r = await listViewSharingHandler(ctx, { componentId: 'ListView:Account.Shared' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.boundaryNote).toContain('not record access');
    expect(r.value.data.boundaryNote).toContain('filterScope');
  });
});

// =============================================================================
// CR-22 — output continuation cursor + honest scan disclosure. Object mode pages
// the list-view rows via an opaque cursor (same-axis: the output offset IS the
// SQL scan offset). The pre-CR-22 SILENT drop past the scan walk is now an
// honest `scanTruncated` (only for a pathological object past SCAN_MAX, so not
// reachable in a fixture). A whole-fits call is byte-identical.
// =============================================================================
describe('listViewSharingHandler — output cursor (CR-22)', () => {
  it('a whole-fits call omits nextCursor/pageInfo/scanTruncated (byte-identical)', async () => {
    const r = await listViewSharingHandler(ctx, { componentId: 'CustomObject:Account' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data as unknown as Record<string, unknown>;
    expect('nextCursor' in d).toBe(false);
    expect('pageInfo' in d).toBe(false);
    expect('scanTruncated' in d).toBe(false);
  });

  it('a truncated page emits a cursor that resumes with no gaps or dupes', async () => {
    const all = await listViewSharingHandler(ctx, { componentId: 'CustomObject:Account', limit: 120 });
    expect(all.ok).toBe(true); if (!all.ok) return;
    const fullOrder = all.value.data.listViews.map((v) => v.componentId);
    expect(fullOrder.length).toBe(3);

    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const page = await listViewSharingHandler(
        ctx,
        cursor !== undefined
          ? { componentId: 'CustomObject:Account', limit: 1, cursor }
          : { componentId: 'CustomObject:Account', limit: 1 },
      );
      expect(page.ok).toBe(true); if (!page.ok) return;
      for (const v of page.value.data.listViews) seen.push(v.componentId);
      // The summary stays WHOLE on every page.
      expect(page.value.data.summary.listViews).toBe(3);
      if (page.value.data.nextCursor === undefined) break;
      cursor = page.value.data.nextCursor;
      guard += 1;
      if (guard > 20) throw new Error('cursor did not terminate');
    }
    expect(seen).toEqual(fullOrder);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('rejects a cursor minted for a DIFFERENT object (argsFingerprint bind)', async () => {
    const first = await listViewSharingHandler(ctx, { componentId: 'CustomObject:Account', limit: 1 });
    expect(first.ok).toBe(true); if (!first.ok) return;
    const cursor = first.value.data.nextCursor;
    expect(typeof cursor).toBe('string');
    if (typeof cursor !== 'string') return;
    const replay = await listViewSharingHandler(ctx, { componentId: 'CustomObject:Contact', cursor });
    expect(replay.ok).toBe(false); if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });
});
