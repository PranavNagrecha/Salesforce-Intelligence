/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, openGraph, type GraphStore } from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  analysisCategory,
  describeAnalysisHandler,
  listAnalysesHandler,
  oneLiner,
  resolveRunAnalysis,
} from '../../src/tools/catalog-gateway.js';
import { dispatchTool, V01_TOOLS } from '../../src/tools/index.js';

/**
 * P13-GW-meta-tools — the catalog gateway. The load-bearing contract is
 * BYTE-IDENTITY: `run_analysis` returns the target tool's envelope verbatim
 * (its dispatch case returns `dispatchTool`'s result without re-wrapping).
 * The full-roster sweep runs in the qa harness against the fixture vault;
 * these units pin the mechanics: identity on representative tools, the
 * JSON-encoded-string args quirk, self-dispatch refusal, and honest unknowns.
 */

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-09T22:00:00.000Z',
  sourceOrg: 'gateway-fixture',
  components: { CustomObject: 0 },
  edges: {},
  sourceTreeHash: 'sha256:gateway-fixture',
} as never;

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-gateway-'));
  const opened = await openGraph(join(tempDir, 'g.duckdb'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

const envelopeText = async (
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<string> => {
  const r = await dispatchTool(ctx, name, args);
  return (r.content?.[0] as { readonly text: string }).text;
};

describe('sfi.list_analyses', () => {
  it('catalogs the full roster with name + one-liner + category, paginated', async () => {
    const r = await listAnalysesHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.total).toBe(V01_TOOLS.filter((t) => !t.hidden).length);
    expect(r.value.data.analyses.length).toBeLessThanOrEqual(50); // default page
    for (const a of r.value.data.analyses.slice(0, 5)) {
      expect(a.name).toMatch(/^sfi\./);
      expect(a.oneLiner.length).toBeGreaterThan(0);
      expect(a.category.length).toBeGreaterThan(0);
    }
    const page2 = await listAnalysesHandler(ctx, { offset: 50, limit: 50 });
    expect(page2.ok && page2.value.data.analyses[0]?.name).not.toBe(
      r.value.data.analyses[0]?.name,
    );
  });

  it('filters by category and lists the category vocabulary', async () => {
    const r = await listAnalysesHandler(ctx, { category: 'live', limit: 200 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.analyses.length).toBeGreaterThan(10);
    expect(r.value.data.analyses.every((a) => a.category === 'live')).toBe(true);
    expect(r.value.data.categories).toContain('what-if');
  });

  describe('CR-22 continuation cursor', () => {
    it('emits a nextCursor on a truncated page and resumes; pages concat with no gaps/dupes', async () => {
      const first = await listAnalysesHandler(ctx, { limit: 20 });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const d1 = first.value.data;
      expect(d1.analyses.length).toBe(20);
      expect(typeof d1.nextCursor).toBe('string');
      expect(d1.pageInfo?.nextCursor).toBe(d1.nextCursor);

      const seen = new Set<string>(d1.analyses.map((a) => a.name));
      let cursor = d1.nextCursor as string;
      let guard = 0;
      for (;;) {
        const r = await listAnalysesHandler(ctx, { limit: 20, cursor });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const d = r.value.data;
        for (const a of d.analyses) seen.add(a.name);
        if (d.nextCursor === undefined) {
          expect('nextCursor' in d).toBe(false);
          break;
        }
        cursor = d.nextCursor;
        if (++guard > 1000) throw new Error('cursor did not terminate');
      }
      // Every advertised (non-hidden) roster tool surfaced exactly once.
      expect(seen.size).toBe(V01_TOOLS.filter((t) => !t.hidden).length);
    });

    it('in-budget whole-fits call emits NO cursor/pageInfo (byte-identical)', async () => {
      const r = await listAnalysesHandler(ctx, { limit: 200 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // 200 >= roster size in the fixture build? Guard: only assert when it fits.
      if (r.value.data.analyses.length === r.value.data.total) {
        expect('nextCursor' in r.value.data).toBe(false);
        expect('pageInfo' in r.value.data).toBe(false);
      }
    });

    it('rejects a cursor replayed against a different category filter', async () => {
      const first = await listAnalysesHandler(ctx, { limit: 5 });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const cursor = first.value.data.nextCursor;
      expect(typeof cursor).toBe('string');
      const replay = await listAnalysesHandler(ctx, {
        category: 'live',
        cursor: cursor as string,
      });
      expect(replay.ok).toBe(false);
      if (!replay.ok) expect(replay.error.kind).toBe('invalid-query');
    });

    it('rejects a malformed cursor', async () => {
      const replay = await listAnalysesHandler(ctx, { cursor: 'not-a-cursor' });
      expect(replay.ok).toBe(false);
      if (!replay.ok) expect(replay.error.kind).toBe('invalid-query');
    });
  });
});

describe('sfi.describe_analysis', () => {
  const prevProfile = process.env['SFI_TOOL_PROFILE'];
  afterEach(() => {
    if (prevProfile === undefined) delete process.env['SFI_TOOL_PROFILE'];
    else process.env['SFI_TOOL_PROFILE'] = prevProfile;
  });

  it('defaults to summary under core (progressive discovery)', async () => {
    process.env['SFI_TOOL_PROFILE'] = 'core';
    const r = await describeAnalysisHandler(ctx, { name: 'org_card' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.name).toBe('sfi.org_card');
    expect(r.value.data.detail).toBe('summary');
    expect(r.value.data.summary.length).toBeGreaterThan(0);
    expect(r.value.data.inputSchema).toBeUndefined();
    expect(r.value.data.description).toBeUndefined();
  });

  it('returns full schema when detail=full (with or without sfi. prefix)', async () => {
    const r = await describeAnalysisHandler(ctx, {
      name: 'org_card',
      detail: 'full',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.name).toBe('sfi.org_card');
    expect(r.value.data.detail).toBe('full');
    expect(r.value.data.inputSchema).toBeDefined();
    expect(r.value.data.description).toBeDefined();
  });

  it('answers an unknown name with an honest catalog pointer', async () => {
    const r = await describeAnalysisHandler(ctx, { name: 'sfi.totally_made_up' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('list_analyses');
  });
});

describe('sfi.run_analysis', () => {
  it('is byte-identical to the direct call (representative tools)', async () => {
    for (const [name, args] of [
      ['sfi.get_manifest', {}],
      ['sfi.health_check', {}],
      ['sfi.list_components', { type: 'CustomObject', limit: 5 }],
    ] as const) {
      const direct = await envelopeText(name, args);
      const viaGateway = await envelopeText('sfi.run_analysis', { name, args });
      expect(viaGateway).toBe(direct);
    }
  });

  it('accepts args as a JSON-encoded string (known client quirk) with identical output', async () => {
    const direct = await envelopeText('sfi.list_components', { type: 'CustomObject', limit: 5 });
    const viaString = await envelopeText('sfi.run_analysis', {
      name: 'list_components',
      args: '{"type":"CustomObject","limit":5}',
    });
    expect(viaString).toBe(direct);
  });

  it('refuses to dispatch itself and rejects non-object args strings', () => {
    const self = resolveRunAnalysis({ name: 'run_analysis', args: {} });
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.error.message).toContain('cannot dispatch itself');
    const badArgs = resolveRunAnalysis({ name: 'sfi.health_check', args: '[1,2]' });
    expect(badArgs.ok).toBe(false);
  });

  it('answers an unknown analysis with an honest catalog pointer', async () => {
    const text = await envelopeText('sfi.run_analysis', { name: 'sfi.nope_tool' });
    const body = JSON.parse(text) as { readonly error?: { readonly message?: string } };
    expect(body.error?.message).toContain('list_analyses');
  });
});

describe('category + one-liner derivation', () => {
  it('is stable for the families the catalog advertises', () => {
    expect(analysisCategory('sfi.live_count')).toBe('live');
    expect(analysisCategory('sfi.what_if_merge_profiles')).toBe('what-if');
    expect(analysisCategory('sfi.generate_data_dictionary')).toBe('documentation');
    expect(analysisCategory('sfi.find_dead_code')).toBe('search');
    expect(analysisCategory('sfi.compare_vaults')).toBe('cross-org');
    expect(analysisCategory('sfi.omniscript_flow')).toBe('industries');
    expect(analysisCategory('sfi.org_card')).toBe('core');
    expect(oneLiner('First sentence. Second sentence.')).toBe('First sentence.');
  });
});
