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
import { whoCanRunHandler } from '../../src/tools/who-can-run.js';

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
const edge = (o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>): Edge => ({
  confidence: 'declared', source: 'unit-test', properties: {}, ...o,
});

const FLOW = 'Flow:Onboard_Contact';
const seed: ExtractionResult = {
  nodes: [
    node({ id: FLOW, type: 'Flow', apiName: 'Onboard_Contact' }),
    node({ id: 'Profile:Sales', type: 'Profile', apiName: 'Sales' }),
    node({ id: 'PermissionSet:FlowRunner', type: 'PermissionSet', apiName: 'FlowRunner' }),
    node({ id: 'Profile:NoRun', type: 'Profile', apiName: 'NoRun' }),
    // A third granter so the CR-22 cursor can page (3 granters, limit 2).
    node({ id: 'Profile:Marketing', type: 'Profile', apiName: 'Marketing' }),
    // A second flow (with its own granter) so a cursor minted for FLOW can be
    // replayed against a DIFFERENT existing flow → fingerprint mismatch.
    node({ id: 'Flow:Second', type: 'Flow', apiName: 'Second' }),
  ],
  edges: [
    edge({ fromId: 'Profile:Sales', toId: FLOW, edgeType: 'grantedBy', properties: { flowAccess: true } }),
    edge({ fromId: 'PermissionSet:FlowRunner', toId: FLOW, edgeType: 'grantedBy', properties: { flowAccess: true } }),
    edge({ fromId: 'Profile:Marketing', toId: FLOW, edgeType: 'grantedBy', properties: { flowAccess: true } }),
    edge({ fromId: 'Profile:Sales', toId: 'Flow:Second', edgeType: 'grantedBy', properties: { flowAccess: true } }),
    // A non-flowAccess grant edge to a class must NOT be counted.
    edge({ fromId: 'Profile:NoRun', toId: 'ApexClass:Foo', edgeType: 'grantedBy', properties: { enabled: true } }),
  ],
};

let tempDir: string; let store: GraphStore; let ctx: Context;
beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-who-can-run-'));
  const o = await openGraph(join(tempDir, 'g.db')); if (!o.ok) throw new Error(o.error.message);
  store = o.value;
  const i = await importExtractionResults(store, [seed]); if (!i.ok) throw new Error(i.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});
afterAll(async () => { await closeGraph(store); rmSync(tempDir, { recursive: true, force: true }); });

describe('whoCanRunHandler', () => {
  it('rejects a non-Flow id with a helpful message', async () => {
    const r = await whoCanRunHandler(ctx, { componentId: 'CustomObject:Account' });
    expect(r.ok).toBe(false); if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('app_access');
  });

  it('lists the profiles/permsets that grant run access to the flow', async () => {
    const r = await whoCanRunHandler(ctx, { componentId: FLOW });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.summary.granters).toBe(3);
    expect(r.value.data.granters.map((g) => g.granterId).sort()).toEqual([
      'PermissionSet:FlowRunner', 'Profile:Marketing', 'Profile:Sales',
    ]);
  });

  it('component-not-found for a flow with no node and no run grant', async () => {
    const r = await whoCanRunHandler(ctx, { componentId: 'Flow:Nope' });
    expect(r.ok).toBe(false); if (r.ok) return; expect(r.error.kind).toBe('component-not-found');
  });

  it('always discloses the app/folder boundary', async () => {
    const r = await whoCanRunHandler(ctx, { componentId: FLOW });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.boundaryNote).toContain('app_access');
    expect(r.value.data.boundaryNote).toContain('live plane');
  });
});

describe('whoCanRunHandler — CR-22 continuation cursor', () => {
  it('in-budget whole-fits call emits NO cursor/pageInfo and no internal __source', async () => {
    const r = await whoCanRunHandler(ctx, { componentId: FLOW });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect('nextCursor' in d).toBe(false);
    expect('pageInfo' in d).toBe(false);
    expect(d.truncated).toBe(false);
    expect(d.hasMore).toBe(false);
    // The internal sort tiebreak must never leak into the emitted row.
    for (const g of d.granters) {
      expect('__source' in g).toBe(false);
      expect(Object.keys(g).sort()).toEqual(['granterId', 'granterLabel', 'granterType']);
    }
  });

  it('a truncated (over-limit) page emits a nextCursor that resumes with no gaps/dupes', async () => {
    const first = await whoCanRunHandler(ctx, { componentId: FLOW, limit: 2 });
    expect(first.ok).toBe(true); if (!first.ok) return;
    const d1 = first.value.data;
    expect(d1.granters.length).toBe(2);
    expect(d1.hasMore).toBe(true);
    expect(typeof d1.nextCursor).toBe('string');
    expect(d1.pageInfo?.nextCursor).toBe(d1.nextCursor);

    const second = await whoCanRunHandler(ctx, {
      componentId: FLOW,
      limit: 2,
      cursor: d1.nextCursor as string,
    });
    expect(second.ok).toBe(true); if (!second.ok) return;
    const d2 = second.value.data;
    expect(d2.granters.length).toBe(1);
    expect(d2.hasMore).toBe(false);
    expect('nextCursor' in d2).toBe(false);

    const combined = [...d1.granters, ...d2.granters].map((g) => g.granterId);
    expect(new Set(combined).size).toBe(3); // no dupes
    expect([...combined].sort()).toEqual([
      'PermissionSet:FlowRunner', 'Profile:Marketing', 'Profile:Sales',
    ]); // no gaps
  });

  it('rejects a cursor minted for a DIFFERENT componentId', async () => {
    const first = await whoCanRunHandler(ctx, { componentId: FLOW, limit: 2 });
    expect(first.ok).toBe(true); if (!first.ok) return;
    const cursor = first.value.data.nextCursor as string;
    // Replay against a different (but valid, granted) flow id — fingerprint mismatch.
    const replay = await whoCanRunHandler(ctx, { componentId: 'Flow:Second', cursor });
    expect(replay.ok).toBe(false); if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });

  it('rejects a malformed / forged cursor string', async () => {
    const replay = await whoCanRunHandler(ctx, { componentId: FLOW, cursor: 'not-a-real-cursor' });
    expect(replay.ok).toBe(false); if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });
});
