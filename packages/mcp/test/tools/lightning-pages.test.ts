/// <reference types="vitest/globals" />

import { mkdtemp, rm } from 'node:fs/promises';
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
import { lightningPagesHandler } from '../../src/tools/lightning-pages.js';

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

const seed: ExtractionResult = {
  nodes: [
    node({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
    node({ id: 'FlexiPage:Account_Record_Page', type: 'FlexiPage', apiName: 'Account_Record_Page', properties: { sobjectType: 'Account', pageType: 'RecordPage', masterLabel: 'Account Record Page', activationsModeled: false } }),
    node({ id: 'FlexiPage:Account_Console', type: 'FlexiPage', apiName: 'Account_Console', properties: { sobjectType: 'Account', pageType: 'RecordPage', masterLabel: 'Account Console', activationsModeled: false } }),
    // A third page on Account so the CR-22 cursor can page (3 pages, limit 2).
    node({ id: 'FlexiPage:Account_Mobile', type: 'FlexiPage', apiName: 'Account_Mobile', properties: { sobjectType: 'Account', pageType: 'RecordPage', masterLabel: 'Account Mobile', activationsModeled: false } }),
    // A second object (with its own page) so a cursor minted for Account can be
    // replayed against a DIFFERENT existing object → fingerprint mismatch.
    node({ id: 'CustomObject:Contact', type: 'CustomObject', apiName: 'Contact' }),
    node({ id: 'FlexiPage:Contact_Record_Page', type: 'FlexiPage', apiName: 'Contact_Record_Page', properties: { sobjectType: 'Contact', pageType: 'RecordPage', masterLabel: 'Contact Record Page', activationsModeled: false } }),
  ],
  edges: [
    edge({ fromId: 'FlexiPage:Account_Record_Page', toId: 'CustomObject:Account', edgeType: 'references', properties: { referenceKind: 'flexiPageObject' } }),
    edge({ fromId: 'FlexiPage:Account_Console', toId: 'CustomObject:Account', edgeType: 'references', properties: { referenceKind: 'flexiPageObject' } }),
    edge({ fromId: 'FlexiPage:Account_Mobile', toId: 'CustomObject:Account', edgeType: 'references', properties: { referenceKind: 'flexiPageObject' } }),
    edge({ fromId: 'FlexiPage:Contact_Record_Page', toId: 'CustomObject:Contact', edgeType: 'references', properties: { referenceKind: 'flexiPageObject' } }),
  ],
};

let tempDir: string; let store: GraphStore; let ctx: Context;
beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'sfi-lightning-pages-'));
  const o = await openGraph(join(tempDir, 'g.db')); if (!o.ok) throw new Error(o.error.message);
  store = o.value;
  const i = await importExtractionResults(store, [seed]); if (!i.ok) throw new Error(i.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});
afterAll(async () => { await closeGraph(store); await rm(tempDir, { recursive: true, force: true }); });

describe('lightningPagesHandler', () => {
  it('rejects a non-object/flexipage id', async () => {
    const r = await lightningPagesHandler(ctx, { componentId: 'Profile:Admin' });
    expect(r.ok).toBe(false); if (r.ok) return; expect(r.error.kind).toBe('invalid-query');
  });

  it('object mode: lists the Lightning pages for the object', async () => {
    const r = await lightningPagesHandler(ctx, { componentId: 'CustomObject:Account' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.mode).toBe('object');
    expect(r.value.data.summary.pages).toBe(3);
    expect(r.value.data.pages?.map((p) => p.componentId).sort()).toEqual([
      'FlexiPage:Account_Console', 'FlexiPage:Account_Mobile', 'FlexiPage:Account_Record_Page',
    ]);
    expect(r.value.data.pages?.[0]?.pageType).toBe('RecordPage');
  });

  it('flexipage mode: returns the page object + kind + label', async () => {
    const r = await lightningPagesHandler(ctx, { componentId: 'FlexiPage:Account_Record_Page' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.mode).toBe('flexipage');
    expect(r.value.data.forObject).toBe('Account');
    expect(r.value.data.pageType).toBe('RecordPage');
  });

  it('always discloses that activation is not in the metadata', async () => {
    const r = await lightningPagesHandler(ctx, { componentId: 'CustomObject:Account' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.activationDisclosure).toContain('NOT in the retrieved FlexiPage metadata');
  });

  it('component-not-found for an unknown object', async () => {
    const r = await lightningPagesHandler(ctx, { componentId: 'CustomObject:Nope__c' });
    expect(r.ok).toBe(false); if (r.ok) return; expect(r.error.kind).toBe('component-not-found');
  });
});

describe('lightningPagesHandler — CR-22 continuation cursor (object mode)', () => {
  it('in-budget whole-fits call emits NO cursor/pageInfo (byte-identical)', async () => {
    const r = await lightningPagesHandler(ctx, { componentId: 'CustomObject:Account' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect('nextCursor' in d).toBe(false);
    expect('pageInfo' in d).toBe(false);
    expect(d.truncated).toBe(false);
    expect(d.hasMore).toBe(false);
  });

  it('flexipage mode never emits a cursor (single-node fast path)', async () => {
    const r = await lightningPagesHandler(ctx, { componentId: 'FlexiPage:Account_Record_Page' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect('nextCursor' in d).toBe(false);
    expect('pageInfo' in d).toBe(false);
    expect(d.hasMore).toBe(false);
    expect(d.truncated).toBe(false);
  });

  it('a truncated (over-limit) page emits a nextCursor that resumes with no gaps/dupes', async () => {
    const first = await lightningPagesHandler(ctx, { componentId: 'CustomObject:Account', limit: 2 });
    expect(first.ok).toBe(true); if (!first.ok) return;
    const d1 = first.value.data;
    expect(d1.pages?.length).toBe(2);
    expect(d1.hasMore).toBe(true);
    expect(typeof d1.nextCursor).toBe('string');
    expect(d1.pageInfo?.nextCursor).toBe(d1.nextCursor);

    const second = await lightningPagesHandler(ctx, {
      componentId: 'CustomObject:Account',
      limit: 2,
      cursor: d1.nextCursor as string,
    });
    expect(second.ok).toBe(true); if (!second.ok) return;
    const d2 = second.value.data;
    expect(d2.pages?.length).toBe(1);
    expect(d2.hasMore).toBe(false);
    expect('nextCursor' in d2).toBe(false);

    const combined = [...(d1.pages ?? []), ...(d2.pages ?? [])].map((p) => p.componentId);
    expect(new Set(combined).size).toBe(3); // no dupes
    expect([...combined].sort()).toEqual([
      'FlexiPage:Account_Console', 'FlexiPage:Account_Mobile', 'FlexiPage:Account_Record_Page',
    ]); // no gaps
  });

  it('rejects a cursor minted for a DIFFERENT object', async () => {
    const first = await lightningPagesHandler(ctx, { componentId: 'CustomObject:Account', limit: 2 });
    expect(first.ok).toBe(true); if (!first.ok) return;
    const cursor = first.value.data.nextCursor as string;
    const replay = await lightningPagesHandler(ctx, { componentId: 'CustomObject:Contact', cursor });
    expect(replay.ok).toBe(false); if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });

  it('rejects a malformed / forged cursor string', async () => {
    const replay = await lightningPagesHandler(ctx, {
      componentId: 'CustomObject:Account',
      cursor: 'not-a-real-cursor',
    });
    expect(replay.ok).toBe(false); if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });
});
