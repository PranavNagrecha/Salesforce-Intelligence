/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, openGraph, type GraphStore } from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  describeAnalysisHandler,
  listAnalysesHandler,
} from '../../src/tools/catalog-gateway.js';
import { dispatchTool } from '../../src/tools/index.js';

/**
 * (e) — FAIL-BEFORE/PASS-AFTER.
 *  - describe_analysis's default (core) `summary` carried only required arg
 *    NAMES — no types, no optional args, no hint — so a host still guessed
 *    (baseline A07: is `value` the label or the API name?).
 *  - list_analyses silently stripped a `query` arg and returned the whole
 *    roster as if filtered.
 */
const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-09T22:00:00.000Z',
  sourceOrg: 'catalog-fixture',
  components: { CustomObject: 0 },
  edges: {},
  sourceTreeHash: 'sha256:catalog-fixture',
} as never;

let tempDir: string;
let store: GraphStore;
let ctx: Context;
const prevProfile = process.env['SFI_TOOL_PROFILE'];

beforeAll(async () => {
  delete process.env['SFI_TOOL_PROFILE'];
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-catalog-disc-'));
  const opened = await openGraph(join(tempDir, 'g.duckdb'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});

afterAll(async () => {
  if (prevProfile !== undefined) process.env['SFI_TOOL_PROFILE'] = prevProfile;
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('describe_analysis default includes a compact arg signature', () => {
  it('summary (core default) lists every arg with its type, required ones unmarked', async () => {
    const r = await describeAnalysisHandler(ctx, { name: 'sfi.what_if_remove_picklist_value' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.detail).toBe('summary');
    const args = r.value.data.args ?? [];
    expect(args.some((a) => a.startsWith('fieldId: string'))).toBe(true);
    expect(args.some((a) => a.startsWith('value: string'))).toBe(true);
  });

  it('optional args carry a ? marker', async () => {
    const r = await describeAnalysisHandler(ctx, { name: 'sfi.get_edges' });
    if (!r.ok) throw new Error(r.error.message);
    const args = r.value.data.args ?? [];
    expect(args.some((a) => a.startsWith('nodeId: string'))).toBe(true);
    expect(args.some((a) => a.startsWith('limit?:'))).toBe(true);
  });
});

describe('list_analyses honors a query filter', () => {
  it('filters to analyses whose name or summary contains every word, and echoes it', async () => {
    const r = await listAnalysesHandler(ctx, { query: 'picklist' });
    if (!r.ok) throw new Error(r.error.message);
    const names = r.value.data.analyses.map((a) => a.name);
    expect(names).toContain('sfi.what_if_remove_picklist_value');
    expect(r.value.data.total).toBeLessThan(30);
    expect(r.value.data.appliedQuery).toBe('picklist');
  });

  it('via dispatch, `query` is no longer an ignored argument', async () => {
    const res = await dispatchTool(ctx, 'sfi.list_analyses', { query: 'picklist' });
    const body = JSON.parse((res.content?.[0] as { text: string }).text) as {
      data: { total: number };
      argumentNotes?: unknown;
    };
    expect(body.argumentNotes).toBeUndefined();
    expect(body.data.total).toBeLessThan(30);
  });
});
