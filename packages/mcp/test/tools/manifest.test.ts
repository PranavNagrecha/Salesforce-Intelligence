/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { getManifestHandler } from '../../src/tools/manifest.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 3, CustomField: 17 },
  edges: { parentOf: 17 },
  sourceTreeHash: 'sha256:manifest-fixture',
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  // The handler never queries the graph — but `Context` requires a live
  // `GraphStore`, so open one against a throwaway DuckDB file. The same
  // store services every test in this file.
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-manifest-'));
  const opened = await openGraph(join(tempDir, 'graph.duckdb'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
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

describe('getManifestHandler', () => {
  it('returns ctx.manifest fields verbatim in the data payload', async () => {
    const result = await getManifestHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The handler is a near-pure pass-through: every contract field
    // surfaces unchanged. `skippedDirectories` is the architectural-
    // bug-fix extension; when the underlying manifest does not carry
    // the field, the handler injects an empty map so the wire shape
    // is stable across vault versions.
    expect(result.value.data).toMatchObject(FIXTURE_MANIFEST);
    expect(result.value.data.skippedDirectories).toEqual({});
  });

  it('copies sourceTreeHash and refreshedAt into the vaultState envelope', async () => {
    const result = await getManifestHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vaultState.sourceTreeHash).toBe(
      'sha256:manifest-fixture',
    );
    expect(result.value.vaultState.refreshedAt).toBe('2026-05-27T14:33:08Z');
  });

  it('returns byte-identical responses across two calls (determinism)', async () => {
    const first = await getManifestHandler(ctx, {});
    const second = await getManifestHandler(ctx, {});
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // JSON-serialization equality matches how the dispatch layer ships
    // the response over the wire.
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('surfaces skippedDirectories from the manifest when present', async () => {
    // Build a manifest that already carries the skip-counter. The
    // refresh pipeline writes this field on every refresh; here we
    // stub it directly to confirm the handler surfaces it verbatim.
    const ctxWithSkips = {
      ...ctx,
      manifest: {
        ...FIXTURE_MANIFEST,
        skippedDirectories: { omniProcesses: 244, omniDataTransforms: 201 },
      },
    };
    const result = await getManifestHandler(ctxWithSkips, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.skippedDirectories).toEqual({
      omniProcesses: 244,
      omniDataTransforms: 201,
    });
  });

  it('treats a manifest missing skippedDirectories as an empty map (back-compat)', async () => {
    // Older vaults built before the architectural-bug fix landed do
    // not carry `skippedDirectories`. The handler must NOT crash and
    // MUST surface the canonical empty-map default so clients can
    // treat the field as always-present.
    const result = await getManifestHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.skippedDirectories).toEqual({});
  });
});
