/// <reference types="vitest/globals" />

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
import {
  changedSinceHandler,
  changedSinceInputSchema,
} from '../../src/tools/changed-since.js';
import { COMPONENT_TYPES } from '../../src/tools/list-components.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { ApexClass: 3, Flow: 1 },
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'src/path.cls',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

// Graph holds:
//   - ApexClass:NewFoo with properties.lastModifiedDate = 2026-05-15 (after boundary)
//   - ApexClass:OldBar with properties.lastModifiedDate = 2026-04-01 (before boundary)
//   - ApexClass:UnenrichedBaz with no lastModifiedDate (counted as unenriched)
//   - Flow:FreshFlow with properties.lastModifiedDate = 2026-05-20 (after boundary)
//   - CustomField:Account.LegacyField with TOP-LEVEL lastModifiedDate = 2026-05-12
//     (proves legacy field reads, no enrichment needed)
const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: 'ApexClass:NewFoo',
      type: 'ApexClass',
      apiName: 'NewFoo',
      properties: {
        lastModifiedDate: '2026-05-15T12:00:00.000Z',
        lastModifiedBy: { id: '005xxAA', name: 'Alice' },
      },
    }),
    makeNode({
      id: 'ApexClass:OldBar',
      type: 'ApexClass',
      apiName: 'OldBar',
      properties: {
        lastModifiedDate: '2026-04-01T00:00:00.000Z',
        lastModifiedBy: { id: '005xxBB', name: 'Bob' },
      },
    }),
    makeNode({
      id: 'ApexClass:UnenrichedBaz',
      type: 'ApexClass',
      apiName: 'UnenrichedBaz',
    }),
    makeNode({
      id: 'Flow:FreshFlow',
      type: 'Flow',
      apiName: 'FreshFlow',
      properties: {
        lastModifiedDate: '2026-05-20T00:00:00.000Z',
        lastModifiedBy: { id: '005xxCC', name: 'Carol' },
      },
    }),
    makeNode({
      id: 'CustomField:Account.LegacyField',
      type: 'CustomField',
      apiName: 'LegacyField',
      lastModifiedDate: '2026-05-12T00:00:00.000Z',
      lastModifiedBy: '005xxDD',
    }),
  ],
  edges: [] as readonly Edge[],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-changed-since-'));
  const dbPath = join(tempDir, 'changed-since.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) {
    throw new Error(`seed import failed: ${imported.error.message}`);
  }
  ctx = {
    vaultRoot: tempDir,
    manifest: FIXTURE_MANIFEST,
    graph: store,
  };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('changedSinceInputSchema', () => {
  it('accepts a date-only ISO string', () => {
    const r = changedSinceInputSchema.safeParse({ since: '2026-05-01' });
    expect(r.success).toBe(true);
  });

  it('accepts a full ISO 8601 timestamp', () => {
    const r = changedSinceInputSchema.safeParse({ since: '2026-05-01T00:00:00.000Z' });
    expect(r.success).toBe(true);
  });

  it('rejects a non-date string', () => {
    const r = changedSinceInputSchema.safeParse({ since: 'tomorrow' });
    expect(r.success).toBe(false);
  });

  // CHANGED-SINCE-REJECTS-LAST-REFRESH-TOKEN: the natural refresh tokens parse
  // (they resolve to refreshedAt at the handler), a bare non-date does not. The
  // separator is normalized, so the hyphen, underscore, AND space forms — the
  // residual the hyphen-only fix left open — all parse, case-insensitively.
  it('accepts the "last-refresh" refresh tokens (hyphen / underscore / space, any case)', () => {
    for (const since of [
      'last-refresh',
      'last_refresh',
      'last refresh',
      'Last Refresh',
      'refresh',
      'Last-Refresh',
    ]) {
      expect(changedSinceInputSchema.safeParse({ since }).success).toBe(true);
    }
  });

  it('rejects an unknown component type', () => {
    const r = changedSinceInputSchema.safeParse({
      since: '2026-05-01',
      types: ['NotARealType'],
    });
    expect(r.success).toBe(false);
  });

  it('rejects limit out of range', () => {
    const r = changedSinceInputSchema.safeParse({
      since: '2026-05-01',
      limit: 999_999,
    });
    expect(r.success).toBe(false);
  });

  it('accepts offset and cursor (CR-22)', () => {
    const r = changedSinceInputSchema.safeParse({
      since: '2026-05-01',
      offset: 1,
      cursor: 'abc',
    });
    expect(r.success).toBe(true);
  });
});

// =============================================================================
// CR-22 B4 — output cursor + full type scan. A whole-fits no-cursor call stays
// byte-identical (no limit/offset/nextCursor/pageInfo/boundaries); a truncated
// page resumes the full set with no gaps / dupes.
// =============================================================================
describe('changedSinceHandler — output cursor (CR-22)', () => {
  it('whole-fits no-cursor call omits all paging + boundary fields', async () => {
    const r = await changedSinceHandler(ctx, { since: '2026-01-01' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data as unknown as Record<string, unknown>;
    expect('limit' in d).toBe(false);
    expect('offset' in d).toBe(false);
    expect('nextOffset' in d).toBe(false);
    expect('nextCursor' in d).toBe(false);
    expect('pageInfo' in d).toBe(false);
    // Small org full-scan completes → no scan-incompleteness boundary.
    expect('boundaries' in d).toBe(false);
  });

  it('a truncated page emits a cursor that resumes with no gaps or dupes', async () => {
    const all = await changedSinceHandler(ctx, { since: '2026-01-01', limit: 500 });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const fullOrder = all.value.data.changed.map((c) => c.id);
    expect(fullOrder.length).toBeGreaterThan(2);

    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const page: Awaited<ReturnType<typeof changedSinceHandler>> =
        await changedSinceHandler(
          ctx,
          cursor !== undefined
            ? { since: '2026-01-01', limit: 1, cursor }
            : { since: '2026-01-01', limit: 1 },
        );
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      for (const c of page.value.data.changed) seen.push(c.id);
      const nc = page.value.data.nextCursor;
      if (nc === undefined) break;
      cursor = nc;
      guard += 1;
      if (guard > 50) throw new Error('cursor did not terminate');
    }
    expect(seen).toEqual(fullOrder);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('rejects a cursor minted for a different `since` boundary', async () => {
    const first = await changedSinceHandler(ctx, { since: '2026-01-01', limit: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cursor = first.value.data.nextCursor;
    expect(typeof cursor).toBe('string');
    if (typeof cursor !== 'string') return;
    const replay = await changedSinceHandler(ctx, { since: '2026-05-01', cursor });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });

  it('rejects a cursor minted for a different types filter', async () => {
    const first = await changedSinceHandler(ctx, { since: '2026-01-01', limit: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cursor = first.value.data.nextCursor;
    expect(typeof cursor).toBe('string');
    if (typeof cursor !== 'string') return;
    const replay = await changedSinceHandler(ctx, {
      since: '2026-01-01',
      types: ['Flow'],
      cursor,
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });
});

describe('changedSinceHandler — boundary filter and partial-data axis', () => {
  it('returns nodes whose lastModifiedDate is at or after the since boundary', async () => {
    const result = await changedSinceHandler(ctx, { since: '2026-05-01' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.changed.map((c) => c.id);
    expect(ids).toContain('ApexClass:NewFoo');
    expect(ids).toContain('Flow:FreshFlow');
    expect(ids).toContain('CustomField:Account.LegacyField');
    expect(ids).not.toContain('ApexClass:OldBar');
  });

  it('omits nodes whose lastModifiedDate is null and reports unenrichedCount > 0', async () => {
    const result = await changedSinceHandler(ctx, { since: '2026-01-01' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.changed.map((c) => c.id);
    expect(ids).not.toContain('ApexClass:UnenrichedBaz');
    expect(result.value.data.unenrichedCount).toBeGreaterThanOrEqual(1);
  });

  // GUARD (CHANGED-SINCE-REJECTS-LAST-REFRESH-TOKEN): pre-fix `since:
  // "last-refresh"` hard-failed the ISO refine. Post-fix it resolves to the
  // manifest's refreshedAt — BYTE-IDENTICAL to passing that ISO instant — and the
  // echoed `since` reflects the resolved boundary (proving the token was honored,
  // not epoch-defaulted: it differs from a far-past date, which matches more).
  it('"last-refresh" ≡ the explicit refreshedAt ISO (byte-equal) and differs from a far-past date', async () => {
    const viaToken = await changedSinceHandler(ctx, { since: 'last-refresh' });
    const viaIso = await changedSinceHandler(ctx, {
      since: FIXTURE_MANIFEST.refreshedAt,
    });
    const viaFarPast = await changedSinceHandler(ctx, { since: '2000-01-01' });
    expect(viaToken.ok && viaIso.ok && viaFarPast.ok).toBe(true);
    if (!viaToken.ok || !viaIso.ok || !viaFarPast.ok) return;
    // Token resolved to refreshedAt → byte-identical to the explicit ISO call.
    expect(viaToken.value.data).toEqual(viaIso.value.data);
    // The echoed boundary is the resolved refresh instant, NOT the raw token.
    expect(viaToken.value.data.since).toBe(
      new Date(FIXTURE_MANIFEST.refreshedAt).toISOString(),
    );
    // Scope honored: a far-past `since` surfaces changes the refresh boundary excludes.
    expect(viaFarPast.value.data.changed.length).toBeGreaterThan(
      viaToken.value.data.changed.length,
    );
  });

  // RESIDUAL (CHANGED-SINCE-REJECTS-LAST-REFRESH-TOKEN): the SPACE form
  // "last refresh" (and its cased variant) resolves identically to the hyphen
  // token — the hyphen-only fix left the space form hard-failing.
  it('the space form "last refresh" ≡ "last-refresh" (byte-equal)', async () => {
    const viaHyphen = await changedSinceHandler(ctx, { since: 'last-refresh' });
    for (const since of ['last refresh', 'Last Refresh', 'last_refresh']) {
      const viaSpace = await changedSinceHandler(ctx, { since });
      expect(viaHyphen.ok && viaSpace.ok).toBe(true);
      if (!viaHyphen.ok || !viaSpace.ok) return;
      expect(viaSpace.value.data).toEqual(viaHyphen.value.data);
    }
  });

  it('reads lastModifiedDate from the top-level node field when properties does not carry one', async () => {
    const result = await changedSinceHandler(ctx, {
      since: '2026-05-01',
      types: ['CustomField'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.changed.map((c) => c.id)).toEqual([
      'CustomField:Account.LegacyField',
    ]);
  });

  it('falls back to the legacy string lastModifiedBy when properties does not carry an object', async () => {
    const result = await changedSinceHandler(ctx, {
      since: '2026-05-01',
      types: ['CustomField'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const legacy = result.value.data.changed[0];
    expect(legacy).toBeDefined();
    if (legacy === undefined) return;
    expect(legacy.lastModifiedBy.id).toBe('005xxDD');
    expect(legacy.lastModifiedBy.name).toBe('');
  });
});

describe('changedSinceHandler — narrows by types', () => {
  it('respects the optional types filter and skips other types', async () => {
    const result = await changedSinceHandler(ctx, {
      since: '2026-05-01',
      types: ['Flow'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.changed.map((c) => c.id)).toEqual(['Flow:FreshFlow']);
  });
});

describe('changedSinceHandler — fully functional against un-enriched vault', () => {
  it('returns ok with empty changed and the full unenrichedCount when nothing has been enriched', async () => {
    const result = await changedSinceHandler(ctx, {
      since: '2026-05-01',
      types: ['ValidationRule'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.changed).toEqual([]);
    expect(result.value.data.unenrichedCount).toBe(0);
    expect(result.value.data.truncated).toBe(false);
  });
});

// =============================================================================
// TYPED-ABSENCE-CHANGED-SINCE — `changed: []` and `unenrichedCount: 0` must each
// say WHICH kind of empty they are.
//
// The shipped payload was `{ changed: [], unenrichedCount: N, truncated: false }`.
// On a vault whose freshness overlay never ran that is a tool with NO dates
// answering "nothing changed" in the same shape it uses for a completed scan —
// measured on `examples/demo-vault`, where 110 of 110 scanned nodes carry no
// `lastModifiedDate`. `unenrichedCount` was the only honesty axis and it is a
// bare number sitting beside the list it invalidates.
// =============================================================================
describe('changedSinceHandler — typed absence', () => {
  it('a vault with NO freshness data reports not-checked, not "nothing changed"', async () => {
    const unenrichedDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-changed-since-unenriched-'));
    const opened = await openGraph(join(unenrichedDir, 'g.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    try {
      const imported = await importExtractionResults(opened.value, [
        {
          nodes: [
            makeNode({ id: 'ApexClass:NoDateA', type: 'ApexClass', apiName: 'NoDateA' }),
            makeNode({ id: 'ApexClass:NoDateB', type: 'ApexClass', apiName: 'NoDateB' }),
          ],
          edges: [] as readonly Edge[],
        },
      ]);
      if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
      const unenrichedCtx: Context = {
        vaultRoot: unenrichedDir,
        manifest: FIXTURE_MANIFEST,
        graph: opened.value,
      };
      const r = await changedSinceHandler(unenrichedCtx, {
        since: '2000-01-01',
        types: ['ApexClass'],
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data.changed).toEqual([]);
      expect(r.value.data.unenrichedCount).toBe(2);
      const absence = r.value.data.absence;
      expect(absence?.status).toBe('not-checked');
      const changedSite = absence?.sites.find((site) => site.path === 'changed');
      expect(changedSite?.kind).toBe('freshness-not-enriched');
      expect(changedSite?.status).toBe('not-checked');
      // `unenrichedCount` is 2, not 0 — it is not an absence site and must not
      // acquire an entry.
      expect(absence?.sites.map((site) => site.path)).toEqual(['changed']);
    } finally {
      await closeGraph(opened.value);
      rmSync(unenrichedDir, { recursive: true, force: true });
    }
  });

  it('a completed scan over dated components reports proven-none on BOTH sites', async () => {
    // Flow:FreshFlow carries a date, so nothing about this type is unenriched
    // and a boundary in the future is a real finding of nothing.
    const r = await changedSinceHandler(ctx, { since: '2099-01-01', types: ['Flow'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.changed).toEqual([]);
    expect(r.value.data.unenrichedCount).toBe(0);
    const absence = r.value.data.absence;
    expect(absence?.status).toBe('proven-none');
    expect(
      absence?.sites.map((site) => [site.path, site.kind, site.status]),
    ).toEqual([
      ['changed', 'checked-empty', 'proven-none'],
      ['unenrichedCount', 'checked-empty', 'proven-none'],
    ]);
  });

  it('a zero unenrichedCount over an EMPTY scan is not-checked, not "fully enriched"', async () => {
    // The arithmetic trap: no ValidationRule node was scanned, so "0 unenriched"
    // is a statement about an empty set. Reading it as full enrichment is the
    // unchecked-zero this family is about.
    const r = await changedSinceHandler(ctx, {
      since: '2026-05-01',
      types: ['ValidationRule'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.unenrichedCount).toBe(0);
    const absence = r.value.data.absence;
    expect(absence?.status).toBe('not-checked');
    expect(
      absence?.sites.map((site) => [site.path, site.kind]),
    ).toEqual([
      ['changed', 'no-nodes-scanned'],
      ['unenrichedCount', 'no-nodes-scanned'],
    ]);
  });

  it('names a requested type whose retrieve the coverage row cannot confirm', async () => {
    // ConnectedApp contributes no node and the manifest carries no coverage row
    // proving the retrieve landed it, so a change to a ConnectedApp is
    // invisible here — the empty list does not bound that type.
    const r = await changedSinceHandler(ctx, {
      since: '2099-01-01',
      types: ['Flow', 'ConnectedApp'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.changed).toEqual([]);
    const changedSite = r.value.data.absence?.sites.find((site) => site.path === 'changed');
    expect(changedSite?.kind).toBe('types-not-retrieved');
    expect(changedSite?.status).toBe('not-checked');
    expect(changedSite?.reason).toContain('ConnectedApp');
  });

  it('a `retrieveConfirmed` coverage row turns the same empty answer into proven-none', async () => {
    // The discriminating control for the test above: identical call, identical
    // empty payload, and the ONLY difference is the manifest's confirmation
    // that the ConnectedApp retrieve completed. The classification must move.
    const confirmedCtx: Context = {
      vaultRoot: tempDir,
      manifest: {
        ...FIXTURE_MANIFEST,
        coverage: [
          {
            type: 'ConnectedApp',
            requested: true,
            retrieved: 0,
            errored: false,
            neverModeled: false,
            retrieveConfirmed: true,
          },
        ],
      },
      graph: store,
    };
    const r = await changedSinceHandler(confirmedCtx, {
      since: '2099-01-01',
      types: ['Flow', 'ConnectedApp'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.changed).toEqual([]);
    const changedSite = r.value.data.absence?.sites.find((site) => site.path === 'changed');
    expect(changedSite?.kind).toBe('checked-empty');
    expect(changedSite?.status).toBe('proven-none');
  });

  it('an offset PAST the last row says the page is empty, not the result set', async () => {
    const all = await changedSinceHandler(ctx, { since: '2026-01-01', limit: 500 });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const total = all.value.data.changed.length;
    expect(total).toBeGreaterThan(0);

    const past = await changedSinceHandler(ctx, {
      since: '2026-01-01',
      offset: total + 5,
    });
    expect(past.ok).toBe(true);
    if (!past.ok) return;
    expect(past.value.data.changed).toEqual([]);
    const changedSite = past.value.data.absence?.sites.find((site) => site.path === 'changed');
    expect(changedSite?.kind).toBe('page-past-end');
    // NOT `not-checked` — the scan ran fine. NOT `proven-none` either: things
    // did change. `unknown` is the only honest reading of an empty page.
    expect(changedSite?.status).toBe('unknown');
    expect(changedSite?.reason).toContain(String(total));
  });

  it('a populated answer with unenriched nodes carries no absence block', async () => {
    const r = await changedSinceHandler(ctx, { since: '2026-01-01' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.changed.length).toBeGreaterThan(0);
    expect(r.value.data.unenrichedCount).toBeGreaterThan(0);
    const d = r.value.data as unknown as Record<string, unknown>;
    expect('absence' in d).toBe(false);
  });
});

describe('changedSinceHandler — limit + truncation', () => {
  it('truncates to limit and flips truncated true when matched > limit', async () => {
    const result = await changedSinceHandler(ctx, {
      since: '2026-01-01',
      limit: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.changed).toHaveLength(1);
    expect(result.value.data.truncated).toBe(true);
  });
});

describe('changedSinceHandler — sort order is date DESC then id ASC', () => {
  it('orders the most-recently-modified first', async () => {
    const result = await changedSinceHandler(ctx, { since: '2026-01-01' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Expected dates: Flow:FreshFlow 05-20, ApexClass:NewFoo 05-15,
    // CustomField:Account.LegacyField 05-12, ApexClass:OldBar 04-01.
    const ids = result.value.data.changed.map((c) => c.id);
    expect(ids.slice(0, 3)).toEqual([
      'Flow:FreshFlow',
      'ApexClass:NewFoo',
      'CustomField:Account.LegacyField',
    ]);
  });
});

describe('changedSinceHandler — normalises since to UTC', () => {
  it('emits the canonical UTC ISO form of the input boundary', async () => {
    const result = await changedSinceHandler(ctx, { since: '2026-05-01' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.since).toBe('2026-05-01T00:00:00.000Z');
  });
});

describe('changedSinceHandler — vault-state envelope', () => {
  it('copies the manifest sourceTreeHash + refreshedAt into the response envelope', async () => {
    const result = await changedSinceHandler(ctx, { since: '2026-05-01' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vaultState.sourceTreeHash).toBe(FIXTURE_MANIFEST.sourceTreeHash);
    expect(result.value.vaultState.refreshedAt).toBe(FIXTURE_MANIFEST.refreshedAt);
  });
});

// ---------------------------------------------------------------------------
// CHANGED-SINCE-DEFAULT-SCAN-SET-NARROWER-THAN-ADVERTISED
//
// `roster.ts` advertises "default scans every ComponentType" and the module
// JSDoc says the scan defaults to "ALL types in the v1.x contract". The default
// set was a HAND-LISTED 46 of the 103 compile-time-proven `COMPONENT_TYPES`, so
// a bare `changed_since({ since })` never looked at 57 types (FlexiPage,
// CustomPermission, Report, Dashboard, ListView, PermissionSetGroup,
// RestrictionRule, Network, every CPQ / OmniStudio / GenAi type, …) and still
// answered `truncated: false` with no boundary naming them. The blind spot was
// invisible in the payload: an admin asking "what changed since my last
// refresh?" before a deploy got a confident, complete-looking list.
//
// This block is the DRIFT GUARD the old `KNOWN GAP` comment was not: it seeds
// one freshly-dated node of EVERY `ComponentType` and asserts a DEFAULT call
// returns all of them. Re-narrowing the default fails here, naming the types.
// ---------------------------------------------------------------------------
describe('changedSinceHandler — default scan set covers every ComponentType', () => {
  let allDir: string;
  let allStore: GraphStore;
  let allCtx: Context;

  beforeAll(async () => {
    allDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-changed-since-all-'));
    const opened = await openGraph(join(allDir, 'all-types.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    allStore = opened.value;
    const everyType: ExtractionResult = {
      nodes: COMPONENT_TYPES.map((type) =>
        makeNode({
          id: `${type}:Probe`,
          type,
          apiName: 'Probe',
          properties: { lastModifiedDate: '2026-05-15T12:00:00.000Z' },
        }),
      ),
      edges: [] as readonly Edge[],
    };
    const imported = await importExtractionResults(allStore, [everyType]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    allCtx = { vaultRoot: allDir, manifest: FIXTURE_MANIFEST, graph: allStore };
  });

  afterAll(async () => {
    await closeGraph(allStore);
    rmSync(allDir, { recursive: true, force: true });
  });

  it('a default (no `types`) call sees a changed component of EVERY ComponentType', async () => {
    const result = await changedSinceHandler(allCtx, {
      since: '2026-01-01',
      limit: 500,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const seen = new Set(result.value.data.changed.map((c) => c.type));
    const unscanned = COMPONENT_TYPES.filter((t) => !seen.has(t));
    expect(unscanned).toEqual([]);
    // …and the answer must not claim completeness by omission either.
    expect(result.value.data.truncated).toBe(false);
  });

  it('a default call over an all-type vault reports a FlexiPage / CustomPermission / Report change', async () => {
    const result = await changedSinceHandler(allCtx, {
      since: '2026-01-01',
      limit: 500,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.changed.map((c) => c.id);
    expect(ids).toContain('FlexiPage:Probe');
    expect(ids).toContain('CustomPermission:Probe');
    expect(ids).toContain('Report:Probe');
    expect(ids).toContain('PermissionSetGroup:Probe');
    expect(ids).toContain('RestrictionRule:Probe');
  });

  it('an EXPLICIT types filter still narrows (widening the default did not break scoping)', async () => {
    const result = await changedSinceHandler(allCtx, {
      since: '2026-01-01',
      types: ['FlexiPage'],
      limit: 500,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.changed.map((c) => c.id)).toEqual(['FlexiPage:Probe']);
  });
});
