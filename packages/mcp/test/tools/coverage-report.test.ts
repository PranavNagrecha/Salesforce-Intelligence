/// <reference types="vitest/globals" />

import type { VaultManifest } from '@sf-intelligence/contracts';

import type { Context } from '../../src/server.js';
import { coverageReportHandler } from '../../src/tools/coverage-report.js';

const manifest: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-29T12:00:00.000Z',
  sourceOrg: 'enterprise-sandbox',
  components: { CustomObject: 2, CustomField: 10 },
  edges: { parentOf: 10 },
  sourceTreeHash: 'sha256:coverage',
  coverageComputedAt: '2026-05-29T12:01:00.000Z',
  coverage: [
    {
      type: 'CustomObject',
      requested: true,
      retrieved: 2,
      errored: false,
      neverModeled: false,
    },
    {
      type: 'Flow',
      requested: true,
      retrieved: 0,
      errored: true,
      errorReason: 'retrieve failed',
      neverModeled: false,
    },
    {
      type: 'Report',
      requested: false,
      retrieved: 0,
      errored: false,
      neverModeled: true,
    },
  ],
};

const ctx: Context = {
  vaultRoot: '/tmp/not-used',
  manifest,
  graph: {} as Context['graph'],
};

describe('coverageReportHandler', () => {
  it('partitions covered, partial, and not-modeled metadata families', async () => {
    const result = await coverageReportHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.data.coverageKnown).toBe(true);
    expect(result.value.data.coverageComputedAt).toBe('2026-05-29T12:01:00.000Z');
    expect(result.value.data.covered.map((entry) => entry.type)).toContain('CustomObject');
    expect(result.value.data.partial.map((entry) => entry.type)).toContain('Flow');
    expect(result.value.data.notModeled.map((entry) => entry.type)).toContain('Report');
    expect(result.value.data.summary.status).toBe('partial');
    expect(result.value.data.trust.provenance).toBe('offline_snapshot');
    expect(result.value.data.disclosure).toContain('not checked');
  });

  it('filters to a single metadata family', async () => {
    const result = await coverageReportHandler(ctx, { type: 'CustomObject' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.data.covered.map((entry) => entry.type)).toEqual(['CustomObject']);
    expect(result.value.data.partial).toEqual([]);
    expect(result.value.data.notModeled).toEqual([]);
    expect(result.value.data.summary.status).toBe('complete');
  });

  it('surfaces staged-build pending rows in their own bucket, not as partial (P13-STAGED-tiers)', async () => {
    const stagedCtx: Context = {
      ...ctx,
      manifest: {
        ...manifest,
        coverage: [
          ...(manifest.coverage ?? []),
          {
            type: 'RemoteSiteSetting',
            requested: true,
            retrieved: 0,
            errored: false,
            neverModeled: false,
            pending: true,
          },
        ],
        staged: { tier: 1, totalTiers: 3, pendingTypes: ['RemoteSiteSetting'] },
      },
    };
    const result = await coverageReportHandler(stagedCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.data.pending.map((entry) => entry.type)).toEqual(['RemoteSiteSetting']);
    expect(result.value.data.partial.map((entry) => entry.type)).not.toContain(
      'RemoteSiteSetting',
    );
    expect(result.value.data.stagedBuild).toEqual({ tier: 1, totalTiers: 3 });
    // honesty preserved for pre-flag consumers: the pending type still counts
    // as missing coverage in the summary, so absence caveats keep firing.
    expect(result.value.data.summary.missingCoverage).toContain('RemoteSiteSetting');
  });

  it('reports no pending bucket and no stagedBuild outside a staged build', async () => {
    const result = await coverageReportHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.pending).toEqual([]);
    expect(result.value.data.stagedBuild).toBeUndefined();
  });

  // C2 / Systemic #1: coverage_report used to self-contradict — its `partial[]`
  // partition listed every requested-but-empty (retrieved:0) type while its
  // `summary` (from summarizeCoverage) reported the vault "complete" and counted
  // those same types as covered. The fix puts summarizeCoverage's coveredTypes
  // filter in lockstep with partitionCoverage (both require retrieved>0), so
  // summary now AGREES with partial[].
  it('summary agrees with partial[] for a requested-but-empty type (no self-contradiction, C2)', async () => {
    const emptyCtx: Context = {
      ...ctx,
      manifest: {
        ...manifest,
        coverage: [
          { type: 'CustomObject', requested: true, retrieved: 2, errored: false, neverModeled: false },
          // requested but retrieve pulled NOTHING — no error, modeled type.
          { type: 'SharingRule', requested: true, retrieved: 0, errored: false, neverModeled: false },
        ],
      },
    };
    const result = await coverageReportHandler(emptyCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    // partitionCoverage classifies the empty type as partial...
    expect(data.partial.map((e) => e.type)).toContain('SharingRule');
    expect(data.covered.map((e) => e.type)).not.toContain('SharingRule');
    // ...and the summary now AGREES (was 'complete' + coveredTypes incl. it).
    expect(data.summary.status).toBe('partial');
    expect(data.summary.coveredTypes).not.toContain('SharingRule');
    expect(data.summary.partialTypes).toContain('SharingRule');
    expect(data.summary.missingCoverage).toContain('SharingRule');
    // trust.completeness mirrors the summary status (line 103).
    expect(data.trust.completeness.status).toBe('partial');
  });
});
