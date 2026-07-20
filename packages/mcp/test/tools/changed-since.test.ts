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
