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
import {
  lightningPagesHandler,
  lightningPagesInputSchema,
} from '../../src/tools/lightning-pages.js';

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
    expect(r.value.data.appliedScope).toEqual({
      componentId: 'FlexiPage:Account_Record_Page',
      object: 'Account',
    });
  });

  // GUARD (L2 alias OS / ADMIN-SURFACE-ALIAS-SKEW-CLUSTER): pre-fix the schema
  // required `componentId` and Zod-STRIPPED `objectApiName` -> `componentId:
  // Required`. Post-fix a natural object alias resolves to the SAME object-mode
  // result as the canonical CustomObject: componentId, with appliedScope echoed.
  it('natural objectApiName ≡ canonical CustomObject componentId (byte-equal + appliedScope)', async () => {
    const run = async (raw: unknown) => {
      const parsed = lightningPagesInputSchema.safeParse(raw);
      if (!parsed.success) return null;
      return lightningPagesHandler(ctx, parsed.data);
    };
    const canonical = await run({ componentId: 'CustomObject:Account' });
    const byObjectApiName = await run({ objectApiName: 'Account' });
    const byObject = await run({ object: 'Account' });
    const byObjectId = await run({ objectId: 'CustomObject:Account' });
    for (const r of [canonical, byObjectApiName, byObject, byObjectId]) {
      expect(r).not.toBeNull();
      expect(r?.ok).toBe(true);
    }
    if (!canonical?.ok || !byObjectApiName?.ok || !byObject?.ok || !byObjectId?.ok) return;
    expect(canonical.value.data.appliedScope).toEqual({
      componentId: 'CustomObject:Account',
      object: 'Account',
    });
    for (const r of [byObjectApiName, byObject, byObjectId]) {
      expect(r.value.data.pages).toEqual(canonical.value.data.pages);
      expect(r.value.data.summary).toEqual(canonical.value.data.summary);
      expect(r.value.data.appliedScope).toEqual(canonical.value.data.appliedScope);
    }
  });

  it('disagreeing object aliases → invalid-query', async () => {
    const parsed = lightningPagesInputSchema.safeParse({
      objectApiName: 'Account',
      object: 'Contact',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const r = await lightningPagesHandler(ctx, parsed.data);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid-query');
  });

  it('a FlexiPage: componentId + an object alias is ambiguous → invalid-query', async () => {
    const parsed = lightningPagesInputSchema.safeParse({
      componentId: 'FlexiPage:Account_Record_Page',
      objectApiName: 'Account',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const r = await lightningPagesHandler(ctx, parsed.data);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid-query');
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

  // GUARD (LIGHTNING-PAGES-SILENTLY-DROPS-PROFILE-ARGS): pre-fix an object +
  // profile call was BYTE-IDENTICAL to the bare object call (profile Zod-stripped)
  // and read as "{profile} is served these pages". Post-fix a profile* key is
  // REFUSED with the activation-gap pointer instead of a silent bare inventory.
  it('a profile* key is refused (activation not modeled), never silently stripped', async () => {
    for (const profileArg of [
      { profileApiName: 'Sales_Rep' },
      { profileId: 'Profile:Sales_Rep' },
      { profileName: 'Sales_Rep' },
      { profile: 'Sales_Rep' },
    ]) {
      const parsed = lightningPagesInputSchema.safeParse({
        objectApiName: 'Account',
        ...profileArg,
      });
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      const r = await lightningPagesHandler(ctx, parsed.data);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error.kind).toBe('invalid-query');
      expect(r.error.message).toMatch(/layout_for_user|App Builder/);
    }
  });

  // The refusal must DIFFER from the bare object inventory (which still succeeds),
  // proving the profile scope is honored (rejected), not dropped.
  it('bare object call still succeeds and differs from the profile-scoped refusal', async () => {
    const bare = await lightningPagesHandler(ctx, { objectApiName: 'Account' });
    expect(bare.ok).toBe(true);
    const parsed = lightningPagesInputSchema.safeParse({
      objectApiName: 'Account',
      profileApiName: 'Sales_Rep',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const scoped = await lightningPagesHandler(ctx, parsed.data);
    expect(scoped.ok).toBe(false);
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

// R6 — census brief 069, line 171: `resolveObjectAlias` (sync) does not
// canonicalize casing against the vault, so `objectApiName: 'account'` built
// `CustomObject:account` (no such node) instead of resolving to the real
// `CustomObject:Account` the vault holds under the correct case.
describe('lightningPagesHandler — R6 wrong-case object alias (vault canonicalization)', () => {
  it('a lower-cased objectApiName resolves to the correctly-cased object, not component-not-found', async () => {
    const r = await lightningPagesHandler(ctx, { objectApiName: 'account' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.mode).toBe('object');
    expect(r.value.data.object).toBe('Account');
    expect(r.value.data.appliedScope).toEqual({
      componentId: 'CustomObject:Account',
      object: 'Account',
    });
    expect(r.value.data.summary.pages).toBe(3);
  });

  it('an all-caps objectId resolves the same way', async () => {
    const r = await lightningPagesHandler(ctx, { objectId: 'CustomObject:ACCOUNT' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.object).toBe('Account');
    expect(r.value.data.summary.pages).toBe(3);
  });
});

// R1 — census brief 069, line 43: object mode answers ENTIRELY from the
// FlexiPage -> CustomObject `references` (flexiPageObject) edge, which only
// exists on a vault whose refresh ran the extractor version that captures
// `sobjectType`. A vault whose refresh predates it holds bare FlexiPage nodes
// with NO `sobjectType` property at all, so `pages: []` for every object is
// indistinguishable from a genuinely checked-empty object.
describe('lightningPagesHandler — R1 typed absence (FlexiPage extraction vintage)', () => {
  let vintageTempDir: string;
  let vintageStore: GraphStore;
  let vintageCtx: Context;

  beforeAll(async () => {
    vintageTempDir = await mkdtemp(join(tmpdir(), 'sfi-lightning-pages-vintage-'));
    const o = await openGraph(join(vintageTempDir, 'g.db'));
    if (!o.ok) throw new Error(o.error.message);
    vintageStore = o.value;
    const vintageSeed: ExtractionResult = {
      nodes: [
        node({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
        // A pre-extraction-era FlexiPage: a bare node with NO `sobjectType` /
        // `pageType` / `masterLabel` property at all — exactly what a refresh
        // that predates the extractor upgrade leaves behind. No `references`
        // edge is ever minted for a node like this (the extractor only emits
        // the edge `if (sobjectType !== null)`), so it is invisible to every
        // object query no matter which object it actually targets.
        node({ id: 'FlexiPage:Legacy_Page', type: 'FlexiPage', apiName: 'Legacy_Page', properties: {} }),
      ],
      edges: [],
    };
    const i = await importExtractionResults(vintageStore, [vintageSeed]);
    if (!i.ok) throw new Error(i.error.message);
    vintageCtx = { vaultRoot: vintageTempDir, manifest: MANIFEST, graph: vintageStore };
  });
  afterAll(async () => {
    await closeGraph(vintageStore);
    await rm(vintageTempDir, { recursive: true, force: true });
  });

  it('a zero-page answer on a never-extracted vault is a typed absence (null), not a verified zero', async () => {
    const r = await lightningPagesHandler(vintageCtx, { componentId: 'CustomObject:Account' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The bug: this asserted `toBe(0)` pre-fix — a confident "no Lightning
    // pages exist for Account" on a vault that never extracted the family.
    expect(r.value.data.summary.pages).toBeNull();
  });

  it('the activation/extraction disclosure names the unextracted FlexiPage and does not claim completeness', async () => {
    const r = await lightningPagesHandler(vintageCtx, { componentId: 'CustomObject:Account' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.activationDisclosure).toContain('FlexiPage:Legacy_Page');
    expect(r.value.data.activationDisclosure).toMatch(/NOT/);
    // The activation-gap sentence must still be present (it covers a
    // different, still-true boundary).
    expect(r.value.data.activationDisclosure).toContain('NOT in the retrieved FlexiPage metadata');
  });

  it('a genuinely-checked object (extraction DID run, some FlexiPage carries the sentinel) still reports a real number, not null', async () => {
    // Add a properly-extracted FlexiPage on a second object into the SAME
    // vintage graph, proving the null-vs-number split is per-query, not a
    // global switch flipped by the presence of any legacy node.
    const mixedSeed: ExtractionResult = {
      nodes: [
        node({ id: 'CustomObject:Contact', type: 'CustomObject', apiName: 'Contact' }),
        node({
          id: 'FlexiPage:Contact_Record_Page',
          type: 'FlexiPage',
          apiName: 'Contact_Record_Page',
          properties: { sobjectType: 'Contact', pageType: 'RecordPage', masterLabel: 'Contact Record Page' },
        }),
      ],
      edges: [
        edge({
          fromId: 'FlexiPage:Contact_Record_Page',
          toId: 'CustomObject:Contact',
          edgeType: 'references',
          properties: { referenceKind: 'flexiPageObject' },
        }),
      ],
    };
    const i = await importExtractionResults(vintageStore, [mixedSeed]);
    if (!i.ok) throw new Error(i.error.message);
    const r = await lightningPagesHandler(vintageCtx, { componentId: 'CustomObject:Contact' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.summary.pages).toBe(1);
  });
});
