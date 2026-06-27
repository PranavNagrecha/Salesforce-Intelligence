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
import { tabAvailabilityHandler } from '../../src/tools/tab-availability.js';

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

const seed: ExtractionResult = {
  nodes: [
    node({ id: 'Profile:Admin', type: 'Profile', apiName: 'Admin', properties: {
      tabVisibilities: [
        { tab: 'Account', visibility: 'DefaultOn' },
        { tab: 'Deals__c', visibility: 'DefaultOff' },
        { tab: 'Secret__c', visibility: 'Hidden' },
      ],
    } }),
    // A profile with no tabVisibilities extracted → disclose "not modeled".
    node({ id: 'Profile:Bare', type: 'Profile', apiName: 'Bare' }),
  ],
  edges: [],
};

let tempDir: string; let store: GraphStore; let ctx: Context;
beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-tab-avail-'));
  const o = await openGraph(join(tempDir, 'g.db')); if (!o.ok) throw new Error(o.error.message);
  store = o.value;
  const i = await importExtractionResults(store, [seed]); if (!i.ok) throw new Error(i.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});
afterAll(async () => { await closeGraph(store); rmSync(tempDir, { recursive: true, force: true }); });

describe('tabAvailabilityHandler', () => {
  it('rejects a non-Profile/PermissionSet id', async () => {
    const r = await tabAvailabilityHandler(ctx, { componentId: 'CustomObject:Account' });
    expect(r.ok).toBe(false); if (r.ok) return; expect(r.error.kind).toBe('invalid-query');
  });
  it('lists tabs with visibility + available flag, tallied', async () => {
    const r = await tabAvailabilityHandler(ctx, { componentId: 'Profile:Admin' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.summary.total).toBe(3);
    expect(d.summary.available).toBe(2); // DefaultOn + DefaultOff
    expect(d.summary.hidden).toBe(1); // Hidden
    const hidden = d.tabs.find((t) => t.tab === 'Secret__c');
    expect(hidden?.available).toBe(false);
    const on = d.tabs.find((t) => t.tab === 'Account');
    expect(on?.available).toBe(true);
  });
  it('discloses "not modeled" when tabVisibilities was not extracted', async () => {
    const r = await tabAvailabilityHandler(ctx, { componentId: 'Profile:Bare' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.summary.total).toBe(0);
    expect(r.value.data.boundaryNote).toContain('not modeled');
  });
});

describe('tabAvailabilityHandler — CR-22 continuation cursor', () => {
  it('in-budget whole-fits call emits NO cursor/pageInfo (byte-identical)', async () => {
    const r = await tabAvailabilityHandler(ctx, { componentId: 'Profile:Admin' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect('nextCursor' in d).toBe(false);
    expect('pageInfo' in d).toBe(false);
    // truncated stays false on the first whole-fits page.
    expect(d.truncated).toBe(false);
    expect(d.hasMore).toBe(false);
  });

  it('a truncated (over-limit) page emits a nextCursor that resumes with no gaps/dupes', async () => {
    const first = await tabAvailabilityHandler(ctx, { componentId: 'Profile:Admin', limit: 2 });
    expect(first.ok).toBe(true); if (!first.ok) return;
    const d1 = first.value.data;
    expect(d1.tabs.length).toBe(2);
    expect(d1.hasMore).toBe(true);
    expect(typeof d1.nextCursor).toBe('string');
    expect(d1.pageInfo?.nextCursor).toBe(d1.nextCursor);

    const second = await tabAvailabilityHandler(ctx, {
      componentId: 'Profile:Admin',
      limit: 2,
      cursor: d1.nextCursor as string,
    });
    expect(second.ok).toBe(true); if (!second.ok) return;
    const d2 = second.value.data;
    expect(d2.tabs.length).toBe(1);
    expect(d2.hasMore).toBe(false);
    expect('nextCursor' in d2).toBe(false);

    const ids = (ts: typeof d1.tabs) => ts.map((t) => `${t.tab}|${t.visibility}`);
    const combined = [...ids(d1.tabs), ...ids(d2.tabs)];
    expect(new Set(combined).size).toBe(3); // no dupes
    const full = await tabAvailabilityHandler(ctx, { componentId: 'Profile:Admin' });
    if (!full.ok) return;
    expect(combined.sort()).toEqual(ids(full.value.data.tabs).sort()); // no gaps
  });

  it('rejects a cursor minted for a DIFFERENT componentId', async () => {
    const first = await tabAvailabilityHandler(ctx, { componentId: 'Profile:Admin', limit: 2 });
    expect(first.ok).toBe(true); if (!first.ok) return;
    const cursor = first.value.data.nextCursor as string;
    const replay = await tabAvailabilityHandler(ctx, { componentId: 'Profile:Bare', cursor });
    expect(replay.ok).toBe(false); if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });

  it('rejects a malformed / forged cursor string', async () => {
    const replay = await tabAvailabilityHandler(ctx, {
      componentId: 'Profile:Admin',
      cursor: 'not-a-real-cursor',
    });
    expect(replay.ok).toBe(false); if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });
});
