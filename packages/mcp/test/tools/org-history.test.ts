/// <reference types="vitest/globals" />

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';

import type { Context } from '../../src/server.js';
import { orgHistoryHandler, orgHistoryInputSchema } from '../../src/tools/org-history.js';

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
  tempDir = join(tmpdir(), `sfi-hist-${Math.random().toString(36).slice(2)}`);
  ctx = { vaultRoot: join(tempDir, 'org-kb'), manifest: FIXTURE_MANIFEST } as Context;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('orgHistoryHandler', () => {
  it('returns an empty timeline (not an error) when no history exists', async () => {
    const r = await orgHistoryHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.refreshCount).toBe(0);
    expect(r.value.data.entries).toEqual([]);
    expect(r.value.data.netComponentChange).toBeNull();
  });

  it('reads the timeline most-recent-first and computes net component change', async () => {
    writeHistory([
      JSON.stringify({ refreshedAt: '2026-05-01T00:00:00Z', sourceTreeHash: 'h1', sourceTreeHashChanged: true, componentDeltas: { Flow: 3 }, edgeDeltas: {}, totalComponents: 100 }),
      JSON.stringify({ refreshedAt: '2026-05-15T00:00:00Z', sourceTreeHash: 'h2', sourceTreeHashChanged: true, componentDeltas: { Flow: 2 }, edgeDeltas: {}, totalComponents: 110 }),
    ]);
    const r = await orgHistoryHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.refreshCount).toBe(2);
    expect(r.value.data.firstRefreshedAt).toBe('2026-05-01T00:00:00Z');
    expect(r.value.data.lastRefreshedAt).toBe('2026-05-15T00:00:00Z');
    expect(r.value.data.netComponentChange).toBe(10); // 110 - 100
    expect(r.value.data.entries[0]?.refreshedAt).toBe('2026-05-15T00:00:00Z'); // most recent first
  });

  it('R2 repro: carries typed truncation state when history exceeds limit', async () => {
    const lines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({
        refreshedAt: `2026-05-0${i + 1}T00:00:00Z`,
        sourceTreeHash: `h${i}`,
        sourceTreeHashChanged: true,
        componentDeltas: {},
        edgeDeltas: {},
        totalComponents: 100 + i,
      }),
    );
    writeHistory(lines);
    const r = await orgHistoryHandler(ctx, { limit: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.entries.length).toBe(2);
    expect(r.value.data.refreshCount).toBe(5);
    // The response must carry an explicit truncation flag and a resume pointer,
    // not just a derivable comparison between entries.length and refreshCount.
    expect((r.value.data as unknown as { truncated?: boolean }).truncated).toBe(true);
    expect((r.value.data as unknown as { nextOffset?: number }).nextOffset).toBe(2);
  });

  it('skips malformed lines defensively', async () => {
    writeHistory([
      '{ not valid json',
      JSON.stringify({ refreshedAt: '2026-05-15T00:00:00Z', sourceTreeHash: 'h2', totalComponents: 5 }),
      '',
    ]);
    const r = await orgHistoryHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.refreshCount).toBe(1);
  });
});

describe('orgHistoryInputSchema', () => {
  it('accepts empty input and rejects limit over 500', () => {
    expect(orgHistoryInputSchema.safeParse({}).success).toBe(true);
    expect(orgHistoryInputSchema.safeParse({ limit: 501 }).success).toBe(false);
  });
});
