/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { dispatchTool } from '../../src/tools/index.js';
import { orgDriftBadgeFor, resetOrgDriftCache } from '../../src/tools/org-drift.js';

/**
 * P13-WATCH-badges — the orgDrift badge: fresh sweep + type intersection →
 * badge; stale sweep, absent file, or non-intersecting drift → SILENT (a
 * vault without staleness.json behaves byte-identically to before). The
 * badge never touches trust/provenance (a4: drift never bleeds into live).
 */

const NOW = '2026-06-10T08:00:00.000Z';
const FRESH_SWEEP = '2026-06-10T07:45:00.000Z'; // 15m old — inside 2×15m
const STALE_SWEEP = '2026-06-10T06:00:00.000Z'; // 2h old — outside

let vaultRoot: string;

const writeSweep = (overrides: Record<string, unknown> = {}): void => {
  writeFileSync(
    join(vaultRoot, 'meta', 'staleness.json'),
    JSON.stringify({
      generatedAt: FRESH_SWEEP,
      vaultRefreshedAt: '2026-06-09T22:00:00.000Z',
      method: 'per-type',
      vaultStale: true,
      driftCount: 4,
      byType: { PermissionSet: 3, CustomObject: 1, ApexClass: 0 },
      checkedTypes: [],
      erroredTypes: [],
      ...overrides,
    }),
  );
  resetOrgDriftCache();
};

beforeEach(() => {
  vaultRoot = mkdtempSync(join(tmpdir(), 'sfi-drift-'));
  mkdirSync(join(vaultRoot, 'meta'), { recursive: true });
  resetOrgDriftCache();
});

afterEach(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
});

describe('orgDriftBadgeFor', () => {
  it('badges a fresh sweep whose drifted types intersect the answer — intersection only', () => {
    writeSweep();
    const badge = orgDriftBadgeFor(
      vaultRoot,
      '{"components":[{"id":"CustomObject:Alpha__c"}]}',
      NOW,
    );
    expect(badge?.source).toBe('staleness-sweep');
    expect(badge?.driftedTypes).toEqual({ CustomObject: 1 }); // PermissionSet drift not in this answer
    expect(badge?.sweptAt).toBe(FRESH_SWEEP);
    expect(badge?.note).toContain('/sfi-refresh');
  });

  it('stays SILENT on a stale sweep — old drift presented as current is the lie this prevents', () => {
    writeSweep({ generatedAt: STALE_SWEEP });
    expect(orgDriftBadgeFor(vaultRoot, '{"id":"CustomObject:Alpha__c"}', NOW)).toBeNull();
  });

  it('stays SILENT without the file, without drift, and without type intersection', () => {
    expect(orgDriftBadgeFor(vaultRoot, '{"id":"CustomObject:Alpha__c"}', NOW)).toBeNull(); // absent
    writeSweep({ vaultStale: false, driftCount: 0, byType: {} });
    expect(orgDriftBadgeFor(vaultRoot, '{"id":"CustomObject:Alpha__c"}', NOW)).toBeNull(); // clean
    writeSweep({ byType: { PermissionSet: 3 } });
    expect(orgDriftBadgeFor(vaultRoot, '{"id":"ApexClass:Foo"}', NOW)).toBeNull(); // no intersection
  });

  it('respects the watcher interval from the pidfile for the freshness window', () => {
    // 1h-interval watcher → 2h window; the 2h-old sweep is just inside at 1h59m.
    writeFileSync(
      join(vaultRoot, 'meta', 'watch.pid'),
      JSON.stringify({ pid: 1, startedAt: 'x', intervalMs: 3_600_000 }),
    );
    writeSweep({ generatedAt: '2026-06-10T06:01:00.000Z' });
    expect(
      orgDriftBadgeFor(vaultRoot, '{"id":"CustomObject:Alpha__c"}', NOW),
    ).not.toBeNull();
  });
});

describe('end-to-end through dispatch', () => {
  const node = (id: string, type: string, apiName: string) =>
    ({
      id, type, apiName, label: apiName, parentId: null,
      sourcePath: `source/${apiName}`, lastModifiedDate: null,
      lastModifiedBy: null, apiVersion: null, properties: {},
    }) as never;

  let store: GraphStore;
  let ctx: Context;

  beforeEach(async () => {
    const opened = await openGraph(join(vaultRoot, 'g.duckdb'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    const imported = await importExtractionResults(store, [
      { nodes: [node('CustomObject:Alpha__c', 'CustomObject', 'Alpha__c')], edges: [] } as unknown as ExtractionResult,
    ]);
    if (!imported.ok) throw new Error(imported.error.message);
    ctx = {
      vaultRoot,
      manifest: {
        version: '0.1.0', refreshedAt: '2026-06-09T22:00:00.000Z',
        sourceOrg: 'drift-fixture', components: {}, edges: {},
        sourceTreeHash: 'sha256:drift-fixture',
      } as unknown as VaultManifest,
      graph: store,
    };
  });

  afterEach(async () => {
    await closeGraph(store);
  });

  it('attaches orgDrift to an affected answer without touching anything else', async () => {
    // Without the file: no badge.
    const before = await dispatchTool(ctx, 'sfi.list_components', { type: 'CustomObject', limit: 5 });
    const beforeBody = JSON.parse((before.content[0] as { text: string }).text) as Record<string, unknown>;
    expect('orgDrift' in beforeBody).toBe(false);

    // dynamic stamp — the dispatch path uses the REAL clock, and a fixed
    // "fresh" timestamp would rot past the 30m window by tomorrow's runs
    writeSweep({ generatedAt: new Date().toISOString() });
    const after = await dispatchTool(ctx, 'sfi.list_components', { type: 'CustomObject', limit: 5 });
    const afterBody = JSON.parse((after.content[0] as { text: string }).text) as {
      readonly orgDrift?: { readonly source: string; readonly driftedTypes: Record<string, number> };
      readonly data?: unknown;
    };
    expect(afterBody.orgDrift?.source).toBe('staleness-sweep');
    expect(afterBody.orgDrift?.driftedTypes['CustomObject']).toBe(1);
    // Everything else identical (badge is additive; data + vaultState untouched).
    const restAfter = { ...(afterBody as Record<string, unknown>) };
    delete restAfter['orgDrift'];
    delete restAfter['estimatedPayloadBytes'];
    const restBefore = { ...beforeBody };
    delete restBefore['estimatedPayloadBytes'];
    expect(restAfter).toEqual(restBefore);
  });
});
