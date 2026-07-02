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

  it('CR-P3-3: a retrieveConfirmed-empty type lands in covered (not partial) and the summary agrees (lockstep)', async () => {
    // A confirmed-clean empty retrieve (describe confirmed the org supports the
    // type AND the clean pull returned zero) is COMPLETE. partitionCoverage and
    // summarizeCoverage must stay in lockstep: the confirmed-empty type appears
    // in `covered`, NOT `partial`, and summary.coveredTypes agrees — no row is
    // ever in summary.coveredTypes while coverage_report lists it under partial.
    const confirmedCtx: Context = {
      ...ctx,
      manifest: {
        ...manifest,
        coverage: [
          { type: 'CustomObject', requested: true, retrieved: 2, errored: false, neverModeled: false, retrieveConfirmed: true },
          { type: 'SharingRule', requested: true, retrieved: 0, errored: false, neverModeled: false, retrieveConfirmed: true },
        ],
      },
    };
    const result = await coverageReportHandler(confirmedCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.covered.map((e) => e.type)).toContain('SharingRule');
    expect(data.partial.map((e) => e.type)).not.toContain('SharingRule');
    expect(data.summary.coveredTypes).toContain('SharingRule');
    expect(data.summary.partialTypes).not.toContain('SharingRule');
    // Lockstep: no row is covered-by-summary but partial-by-partition.
    for (const t of data.summary.coveredTypes) {
      expect(data.partial.map((e) => e.type)).not.toContain(t);
    }
  });

  describe('CR-CAP-20 — topUncoveredFamilies ranking', () => {
    it('ranks skipped families desc, caps at 10, labels modeled vs raw, and extends the disclosure', async () => {
      // Build a manifest with >10 skipped dirs to exercise the cap, plus a
      // SKIPPED_DIR_COVERAGE-mapped dir (compactLayouts -> CompactLayout)
      // and an unmapped one (omniProcesses, raw label).
      const skipped: Record<string, number> = { omniProcesses: 500, compactLayouts: 5 };
      for (let i = 0; i < 11; i++) skipped[`fam${i}`] = 100 + i;
      const skipCtx: Context = {
        ...ctx,
        manifest: { ...manifest, skippedDirectories: skipped } as Context['manifest'],
      };
      const result = await coverageReportHandler(skipCtx, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const top = result.value.data.topUncoveredFamilies;
      expect(top).toBeDefined();
      // Capped at 10.
      expect(top!.length).toBe(10);
      // Highest-volume family first.
      expect(top![0]!.family).toBe('omniProcesses');
      expect(top![0]!.skippedFiles).toBe(500);
      expect(top![0]!.modeledType).toBe(false);
      // compactLayouts (only 5) is below the cap cut-off and excluded;
      // but verify the mapped-label behavior in the small-map test below.
      // Disclosure carries the new clause and the honest framing: a
      // listed family is "retrieved-but-not-modeled, never 'absent'" — it
      // must NOT label any family as absent.
      expect(result.value.data.disclosure).toContain('skipped-file volume');
      expect(result.value.data.disclosure).toContain('not modeled by an extractor');
      expect(result.value.data.disclosure).toContain("never 'absent'");
    });

    it('maps a known dir to its ComponentType (modeledType true) and keeps an unmapped dir raw', async () => {
      const skipCtx: Context = {
        ...ctx,
        manifest: {
          ...manifest,
          skippedDirectories: { omniProcesses: 30, compactLayouts: 5 },
        } as Context['manifest'],
      };
      const result = await coverageReportHandler(skipCtx, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const top = result.value.data.topUncoveredFamilies!;
      expect(top).toEqual([
        { family: 'omniProcesses', rawDir: 'omniProcesses', skippedFiles: 30, modeledType: false },
        { family: 'CompactLayout', rawDir: 'compactLayouts', skippedFiles: 5, modeledType: true },
      ]);
    });

    it('is an empty array on a clean vault (no skippedDirectories) — inert on the golden', async () => {
      const result = await coverageReportHandler(ctx, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.data.topUncoveredFamilies).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// ENGINE-ARC §6 — the assignmentData section: runtime assignment data is NOT
// a retrieve gap (by design, live-first), and the report says so explicitly.
// ---------------------------------------------------------------------------

describe('coverageReportHandler — assignmentData (ENGINE-ARC §6)', () => {
  const savedEnv = {
    consent: process.env['SFI_CONSENT_PATH'],
    live: process.env['SFI_LIVE_PLANE_ENABLED'],
  };
  beforeEach(() => {
    // Deterministic consent state: point the consent store at a nonexistent
    // file and clear the env enable, so liveConsent is false unless a test
    // explicitly turns it on.
    process.env['SFI_CONSENT_PATH'] = '/tmp/sfi-nonexistent-consent/none.json';
    delete process.env['SFI_LIVE_PLANE_ENABLED'];
  });
  afterAll(() => {
    if (savedEnv.consent === undefined) delete process.env['SFI_CONSENT_PATH'];
    else process.env['SFI_CONSENT_PATH'] = savedEnv.consent;
    if (savedEnv.live === undefined) delete process.env['SFI_LIVE_PLANE_ENABLED'];
    else process.env['SFI_LIVE_PLANE_ENABLED'] = savedEnv.live;
  });

  it('reports the by-design boundary, the four live tools, and no facts snapshot', async () => {
    const result = await coverageReportHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ad = result.value.data.assignmentData;
    expect(ad.vaultModeled).toBe(false);
    // Verbatim judge-consumed reason — a retrieve gap this is NOT.
    expect(ad.reason).toBe('runtime data object — by design, not a retrieve gap');
    expect(ad.liveTools).toEqual([
      'sfi.live_permset_holders',
      'sfi.live_user_permsets',
      'sfi.live_group_members',
      'sfi.live_zombie_accounts',
    ]);
    expect(ad.liveConsent).toBe(false);
    // The fake graph has no facts capture — present:false, never invented.
    expect(ad.factsCounts).toEqual({ present: false, capturedAt: null });
    expect(ad.rendered).toContain('not in vault (by design)');
    expect(ad.rendered).toContain('consent-needed');
    expect(ad.rendered).toContain('Offline counts snapshot: none');
  });

  it('reports liveConsent true when the live plane is env-enabled', async () => {
    process.env['SFI_LIVE_PLANE_ENABLED'] = '1';
    const result = await coverageReportHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.assignmentData.liveConsent).toBe(true);
    expect(result.value.data.assignmentData.rendered).toContain('Live: available');
  });

  it('assignmentData never poses as coverage: PermissionSetAssignment stays out of covered[]', async () => {
    const result = await coverageReportHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.covered.map((e) => e.type)).not.toContain('PermissionSetAssignment');
    expect(result.value.data.covered.map((e) => e.type)).not.toContain('User');
  });
});
