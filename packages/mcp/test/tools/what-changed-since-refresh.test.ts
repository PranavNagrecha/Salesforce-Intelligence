/// <reference types="vitest/globals" />

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';

import type { Context } from '../../src/server.js';
import { whatChangedSinceRefreshHandler } from '../../src/tools/what-changed-since-refresh.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-29T00:00:00Z',
  sourceOrg: 'test',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

let tempDir: string;
let ctx: Context;

const writeHistory = (lines: string[]): void => {
  const metaDir = join(tempDir, 'org-kb', 'meta');
  mkdirSync(metaDir, { recursive: true });
  writeFileSync(join(metaDir, 'history.jsonl'), lines.join('\n'), 'utf8');
};

beforeEach(() => {
  tempDir = join(tmpdir(), `sfi-wcsr-${Math.random().toString(36).slice(2)}`);
  ctx = { vaultRoot: join(tempDir, 'org-kb'), manifest: FIXTURE_MANIFEST } as Context;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('whatChangedSinceRefreshHandler (P5-what-changed)', () => {
  it('returns available:false (not an error) when no history exists', async () => {
    const r = await whatChangedSinceRefreshHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.available).toBe(false);
    expect(r.value.data.changedTypeCount).toBe(0);
    expect(r.value.data.interpretation).toMatch(/live_stale_check/);
  });

  it('lists the component TYPES the most recent refresh changed', async () => {
    writeHistory([
      JSON.stringify({
        refreshedAt: '2026-05-20T00:00:00Z',
        sourceTreeHash: 'sha256:old',
        sourceTreeHashChanged: true,
        componentDeltas: {},
        edgeDeltas: {},
        totalComponents: 10,
      }),
      JSON.stringify({
        refreshedAt: '2026-05-29T00:00:00Z',
        sourceTreeHash: 'sha256:new',
        sourceTreeHashChanged: true,
        componentDeltas: { ApexClass: 3, Flow: -1, CustomField: 0 },
        edgeDeltas: { callsApex: 5 },
        totalComponents: 12,
      }),
    ]);
    const r = await whatChangedSinceRefreshHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.available).toBe(true);
    expect(r.value.data.lastRefreshedAt).toBe('2026-05-29T00:00:00Z');
    // Only NON-ZERO deltas surface (CustomField:0 is dropped).
    expect(r.value.data.changedTypes).toEqual({ ApexClass: 3, Flow: -1 });
    expect(r.value.data.changedTypeCount).toBe(2);
    expect(r.value.data.changedEdges).toEqual({ callsApex: 5 });
    // The honesty axis points at the live check for org-side drift.
    expect(r.value.data.boundaries.join(' ')).toMatch(/live_stale_check/);
  });

  it('reports zero changed types when the last refresh had no net delta', async () => {
    writeHistory([
      JSON.stringify({
        refreshedAt: '2026-05-29T00:00:00Z',
        sourceTreeHash: 'sha256:same',
        sourceTreeHashChanged: false,
        componentDeltas: {},
        edgeDeltas: {},
        totalComponents: 10,
      }),
    ]);
    const r = await whatChangedSinceRefreshHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.available).toBe(true);
    expect(r.value.data.changedTypeCount).toBe(0);
  });
});
