/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, importExtractionResults, openGraph } from '@sf-intelligence/graph';
import { notModeledCoverageTypes } from '@sf-intelligence/vault';

import type { Context } from '../../src/server.js';
import { coverageReportHandler } from '../../src/tools/coverage-report.js';
import { healthCheckHandler } from '../../src/tools/health-check.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 1, Index: 2 },
  edges: {},
  sourceTreeHash: 'sha256:v6-not-modeled',
  coverage: [
    { type: 'CustomObject', requested: true, retrieved: 1, errored: false, neverModeled: false },
    { type: 'Index', requested: true, retrieved: 2, errored: false, neverModeled: false },
    { type: 'Report', requested: false, retrieved: 0, errored: false, neverModeled: true },
  ],
  coverageComputedAt: '2026-05-27T14:33:08Z',
};

describe('V6-2 notModeled agreement (coverage_report vs health_check)', () => {
  let dir = '';
  let ctx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'v6-nm-'));
    const opened = await openGraph(join(dir, 'graph.duckdb'));
    if (!opened.ok) throw new Error(opened.error.message);
    const seed: ExtractionResult = {
      nodes: [
        {
          id: 'CustomObject:Demo_Obj__c',
          type: 'CustomObject',
          apiName: 'Demo_Obj__c',
          label: null,
          parentId: null,
          sourcePath: 'x',
          lastModifiedDate: null,
          lastModifiedBy: null,
          apiVersion: null,
          properties: {},
        },
      ],
      edges: [],
    };
    const imp = await importExtractionResults(opened.value, [seed]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx = { vaultRoot: dir, manifest: MANIFEST, graph: opened.value } as Context;
  });

  afterAll(async () => {
    await closeGraph(ctx.graph);
    rmSync(dir, { recursive: true, force: true });
  });

  it('coverage_report.notModeled types match summary.notModeledTypes and health_check.coverage', async () => {
    const cov = await coverageReportHandler(ctx, {});
    const hc = await healthCheckHandler(ctx, {});
    expect(cov.ok).toBe(true);
    expect(hc.ok).toBe(true);
    if (!cov.ok || !hc.ok) return;

    const fromReport = cov.value.data.notModeled.map((e) => e.type).sort();
    const fromSummary = [...cov.value.data.summary.notModeledTypes].sort();
    const fromHealth = [...hc.value.data.coverage.notModeledTypes].sort();
    const canonical = [...notModeledCoverageTypes(MANIFEST)].sort();

    expect(fromReport).toEqual(fromSummary);
    expect(fromHealth).toEqual(canonical);
    expect(fromReport).toEqual(canonical);
  });
});
