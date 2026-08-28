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
    // Every container carries `flowGrantCount` — the sentinel BOTH container
    // extractors write on EVERY container once `<flowAccesses>` is extracted
    // (0 included). Without it these rows would model a PRE-extraction vault,
    // and the whole-vault blind-spot disclosure would fire on the happy path.
    node({ id: 'Profile:Sales', type: 'Profile', apiName: 'Sales', properties: { flowGrantCount: 2 } }),
    node({ id: 'PermissionSet:FlowRunner', type: 'PermissionSet', apiName: 'FlowRunner', properties: { flowGrantCount: 1 } }),
    node({ id: 'Profile:NoRun', type: 'Profile', apiName: 'NoRun', properties: { flowGrantCount: 0 } }),
    // A third granter so the CR-22 cursor can page (3 granters, limit 2).
    node({ id: 'Profile:Marketing', type: 'Profile', apiName: 'Marketing', properties: { flowGrantCount: 1 } }),
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
    // Fully-extracted vault: no blind spot, so no never-checked disclosure.
    expect(r.value.data.flowAccessNotChecked).toBe(0);
    expect(r.value.data.scanTruncated).toBe(false);
    expect(r.value.data.boundaryNote).not.toContain('flowGrantCount');
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

// ---------------------------------------------------------------------------
// R1 TYPED ABSENCE — flowAccess extraction vintage.
//
// `who_can_run` answers from `flowAccess` grantedBy edges. A vault whose refresh
// predates `buildFlowEdges` carries NO such edge for ANY flow, so every flow
// used to answer `granters: [], summary.granters: 0, confidence: 'declared'` —
// byte-identical to a flow that genuinely nobody can run. The forward sibling
// (`user_ability`) already decides this from the `flowGrantCount` sentinel BOTH
// container extractors always write; the reverse direction said nothing.
//
// Each case gets its OWN vault, because the question ("did this refresh extract
// the family at all?") is a property of the whole vault, not of one flow.
// ---------------------------------------------------------------------------

const makeCtx = async (
  slug: string,
  seedFor: ExtractionResult,
): Promise<{ ctx: Context; close: () => Promise<void> }> => {
  const dir = mkdtempSync(join(tmpdir(), `sfi-wcr-${slug}-`));
  const o = await openGraph(join(dir, 'g.db'));
  if (!o.ok) throw new Error(o.error.message);
  const s = o.value;
  const i = await importExtractionResults(s, [seedFor]);
  if (!i.ok) throw new Error(i.error.message);
  return {
    ctx: { vaultRoot: dir, manifest: MANIFEST, graph: s },
    close: async () => {
      await closeGraph(s);
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

describe('whoCanRunHandler — flowAccess extraction vintage (R1 typed absence)', () => {
  it('a PRE-EXTRACTION vault must not answer a verified zero: summary.granters is null + the family disclosure', async () => {
    // Every container predates `buildFlowEdges`: no `flowGrantCount` key, and
    // therefore no flowAccess edge anywhere in the vault.
    const { ctx: c, close } = await makeCtx('pre', {
      nodes: [
        node({ id: 'Flow:Legacy_Flow', type: 'Flow', apiName: 'Legacy_Flow' }),
        node({ id: 'Profile:Legacy_Admin', type: 'Profile', apiName: 'Legacy_Admin' }),
        node({ id: 'PermissionSet:Legacy_Set', type: 'PermissionSet', apiName: 'Legacy_Set' }),
      ],
      edges: [],
    });
    try {
      const r = await whoCanRunHandler(c, { componentId: 'Flow:Legacy_Flow' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.value.data;
      // NOTHING was checked — 0 is reserved for a CHECKED zero.
      expect(d.summary.granters).toBeNull();
      expect(d.granters).toEqual([]);
      // The disclosure must name the sentinel, the affected containers and the remedy.
      expect(d.boundaryNote).toContain('flowGrantCount');
      expect(d.boundaryNote).toContain('Profile:Legacy_Admin');
      expect(d.boundaryNote).toContain('PermissionSet:Legacy_Set');
      expect(d.boundaryNote).toContain('/sfi-refresh');
      expect(d.flowAccessNotChecked).toBe(2);
    } finally {
      await close();
    }
  });

  it('a POST-EXTRACTION vault with no grant answers a CHECKED zero and does NOT over-disclose', async () => {
    const { ctx: c, close } = await makeCtx('post', {
      nodes: [
        node({ id: 'Flow:Modern_Flow', type: 'Flow', apiName: 'Modern_Flow' }),
        node({ id: 'Profile:Modern_Admin', type: 'Profile', apiName: 'Modern_Admin', properties: { flowGrantCount: 0 } }),
        node({ id: 'PermissionSet:Modern_Set', type: 'PermissionSet', apiName: 'Modern_Set', properties: { flowGrantCount: 0 } }),
      ],
      edges: [],
    });
    try {
      const r = await whoCanRunHandler(c, { componentId: 'Flow:Modern_Flow' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.value.data;
      expect(d.summary.granters).toBe(0);
      expect(d.flowAccessNotChecked).toBe(0);
      expect(d.boundaryNote).not.toContain('flowGrantCount');
      expect(d.boundaryNote).not.toContain('/sfi-refresh');
    } finally {
      await close();
    }
  });

  it('a MIXED-vintage vault keeps the real count but discloses the containers that were never checked', async () => {
    const { ctx: c, close } = await makeCtx('mixed', {
      nodes: [
        node({ id: 'Flow:Mixed_Flow', type: 'Flow', apiName: 'Mixed_Flow' }),
        node({ id: 'Profile:Checked_One', type: 'Profile', apiName: 'Checked_One', properties: { flowGrantCount: 1 } }),
        node({ id: 'PermissionSet:Never_Checked', type: 'PermissionSet', apiName: 'Never_Checked' }),
      ],
      edges: [
        edge({ fromId: 'Profile:Checked_One', toId: 'Flow:Mixed_Flow', edgeType: 'grantedBy', properties: { flowAccess: true } }),
      ],
    });
    try {
      const r = await whoCanRunHandler(c, { componentId: 'Flow:Mixed_Flow' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.value.data;
      // A grant WAS found, so the count is a real floor — never null.
      expect(d.summary.granters).toBe(1);
      expect(d.flowAccessNotChecked).toBe(1);
      expect(d.boundaryNote).toContain('PermissionSet:Never_Checked');
      expect(d.boundaryNote).not.toContain('Profile:Checked_One');
      // The computed note must survive alongside the disclosure.
      expect(d.boundaryNote).toContain('app_access');
    } finally {
      await close();
    }
  });
});
