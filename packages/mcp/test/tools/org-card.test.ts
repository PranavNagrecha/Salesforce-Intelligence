/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, openGraph, type GraphStore } from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { orgCardHandler } from '../../src/tools/org-card.js';

/**
 * P13-CARD-tool — `sfi.org_card` is a pure cache read of `meta/org-card.json`:
 * present → the parsed card verbatim; absent → honest `available: false` with
 * the refresh remedy (an old vault is not an error); corrupt → recoverable
 * internal error naming the regeneration step. It never recomputes the card.
 */

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-09T22:00:00.000Z',
  sourceOrg: 'org-card-tool-fixture',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:org-card-tool-fixture',
} as never;

const CARD = {
  generatedAt: '2026-06-09T22:00:00.000Z',
  kind: 'org-card',
  totals: { components: 42, edges: 99 },
  topObjects: [{ id: 'CustomObject:Alpha__c', inboundRefs: 7 }],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-org-card-tool-'));
  const opened = await openGraph(join(tempDir, 'g.duckdb'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  mkdirSync(join(tempDir, 'meta'), { recursive: true });
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('sfi.org_card', () => {
  it('serves the cached card verbatim when present', async () => {
    writeFileSync(join(tempDir, 'meta', 'org-card.json'), JSON.stringify(CARD));
    const r = await orgCardHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.available).toBe(true);
    expect(r.value.data.card).toEqual(CARD);
    expect(r.value.vaultState.sourceTreeHash).toBe(FIXTURE_MANIFEST.sourceTreeHash);
  });

  it('returns honest available:false with the refresh remedy when the card is absent', async () => {
    rmSync(join(tempDir, 'meta', 'org-card.json'), { force: true });
    const r = await orgCardHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.available).toBe(false);
    expect(r.value.data.card).toBeUndefined();
    expect(r.value.data.remedy).toContain('refresh');
  });

  it('fails recoverably (with the regeneration step) on corrupt JSON', async () => {
    writeFileSync(join(tempDir, 'meta', 'org-card.json'), '{not json');
    const r = await orgCardHandler(ctx, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('internal');
    expect(r.error.message).toContain('refresh --no-pull');
  });
});
