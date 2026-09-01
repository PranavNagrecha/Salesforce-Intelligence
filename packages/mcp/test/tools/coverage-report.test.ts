/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  CoverageEntry,
  Edge,
  ExtractionResult,
  Node,
  VaultManifest,
} from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import { mintLiveCapability } from '../../src/live-capability.js';
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

// REFERENCED-BUT-ABSENT: `coverageReportHandler` now queries the graph
// (`referencedButAbsentFamilies`, shared with list_components/
// unused_components) for every confirmed-clean-zero row, so `ctx.graph` must
// be a REAL store — a `{}` stub made every such query fail closed and every
// test below fail with it. A real but EMPTY store (no nodes, no edges) is
// behaviorally identical to the old stub for every test that predates this
// fix: zero edges means `referencedButAbsentFamilies` always resolves to an
// empty map, so no existing assertion changes.
let graphDir: string;
let graphStore: GraphStore;
let ctx: Context;

beforeAll(async () => {
  graphDir = mkdtempSync(join(tmpdir(), 'sfi-coverage-report-'));
  const opened = await openGraph(join(graphDir, 'coverage.db'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  graphStore = opened.value;
  const imported = await importExtractionResults(graphStore, [{ nodes: [], edges: [] }]);
  if (!imported.ok) throw new Error('empty seed import failed');
  ctx = {
    vaultRoot: graphDir,
    manifest,
    graph: graphStore,
    // INFRA-12-DEEP: coverage_report is livePlane:opt-in; unit tests bypass dispatch.
    liveCapability: mintLiveCapability('opt-in'),
  };
});

afterAll(async () => {
  await closeGraph(graphStore);
  rmSync(graphDir, { recursive: true, force: true });
});

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

  // FIX-2 (coverage-spine): a family that WAS attempted and landed a real,
  // non-zero, intentionally-capped result (the real-vault regression: Report
  // retrieved=388, Dashboard retrieved=76, both `pending: true`) must read
  // `capped`, not `pending` — `pending` is reserved for a family this refresh
  // never touched at all (P13-STAGED-tiers). The caveat must keep firing
  // (missingCoverage still names it) — only the REASON is now legible.
  it('surfaces capped-but-retrieved rows in their own bucket, distinct from pending/partial', async () => {
    const cappedCtx: Context = {
      ...ctx,
      manifest: {
        ...manifest,
        coverage: [
          ...(manifest.coverage ?? []),
          {
            type: 'Report',
            requested: true,
            retrieved: 388,
            errored: false,
            neverModeled: false,
            capped: true,
          },
        ],
      },
    };
    const result = await coverageReportHandler(cappedCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.data.capped.map((entry) => entry.type)).toEqual(['Report']);
    expect(result.value.data.pending.map((entry) => entry.type)).not.toContain('Report');
    expect(result.value.data.partial.map((entry) => entry.type)).not.toContain('Report');
    expect(result.value.data.covered.map((entry) => entry.type)).not.toContain('Report');
    // A capped family is genuinely incomplete coverage: the caveat is NOT
    // wrong, only the "never attempted" reading it used to imply was.
    expect(result.value.data.summary.missingCoverage).toContain('Report');
  });

  it('reports an empty capped bucket when nothing in the vault is capped', async () => {
    const result = await coverageReportHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.capped).toEqual([]);
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

  // WORKFLOWRULE-RETRIEVED-ZERO — RM-A14 depends on the WorkflowRule plane.
  // Pre-CR-P3-3 vaults (and describe-blind / --no-pull rebuilds) carry the
  // byte-identical {requested:true, retrieved:0} row WITHOUT retrieveConfirmed;
  // coverage_report must classify that as partial so hosts never read "0 rules"
  // as proven absence. A post-refresh confirmed-empty org (Flow-only, no legacy
  // workflow) lands in covered instead — honest silence, not a false caveat.
  describe('WORKFLOWRULE-RETRIEVED-ZERO — WorkflowRule plane tri-state', () => {
    it('un-confirmed retrieved:0 WorkflowRule is partial (not checked, not proven none)', async () => {
      const unconfirmedCtx: Context = {
        ...ctx,
        manifest: {
          ...manifest,
          coverage: [
            { type: 'CustomObject', requested: true, retrieved: 2, errored: false, neverModeled: false, retrieveConfirmed: true },
            { type: 'WorkflowRule', requested: true, retrieved: 0, errored: false, neverModeled: false },
          ],
        },
      };
      const result = await coverageReportHandler(unconfirmedCtx, { type: 'WorkflowRule' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.value.data;
      expect(data.partial.map((e) => e.type)).toContain('WorkflowRule');
      expect(data.covered.map((e) => e.type)).not.toContain('WorkflowRule');
      expect(data.summary.status).toBe('partial');
      expect(data.summary.missingCoverage).toContain('WorkflowRule');
      expect(data.trust.completeness.status).toBe('partial');
    });

    it('retrieveConfirmed-empty WorkflowRule is covered (confirmed org has none)', async () => {
      const confirmedEmptyCtx: Context = {
        ...ctx,
        manifest: {
          ...manifest,
          coverage: [
            { type: 'CustomObject', requested: true, retrieved: 2, errored: false, neverModeled: false, retrieveConfirmed: true },
            { type: 'WorkflowRule', requested: true, retrieved: 0, errored: false, neverModeled: false, retrieveConfirmed: true },
          ],
        },
      };
      const result = await coverageReportHandler(confirmedEmptyCtx, { type: 'WorkflowRule' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.value.data;
      expect(data.covered.map((e) => e.type)).toContain('WorkflowRule');
      expect(data.partial.map((e) => e.type)).not.toContain('WorkflowRule');
      expect(data.summary.status).toBe('complete');
      expect(data.summary.missingCoverage).not.toContain('WorkflowRule');
      expect(data.trust.completeness.status).toBe('complete');
    });
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

// =============================================================================
// NOT PARSED, MEMBER NEVER ARRIVED (spec row 7) at the coverage_report surface.
// On the probe vault `SessionSettings` and `FieldServiceSettings` sat in
// `covered` with `retrieved: 0` while 139 files under the `settings/` container
// they are dispatched from were walked past into `skippedDirectories` — the
// report was simultaneously listing `settings` in `topUncoveredFamilies` as
// retrieved-but-not-modeled and calling the two types complete.
//
// The disclosure must state the TRUE cause. Verified on the probe vault:
// neither `Session.settings-meta.xml` nor `FieldService.settings-meta.xml` is
// on disk (139 OTHER settings files are), both filenames ARE dispatched to
// shipped extractors, and both types already alias onto `Settings` in the
// retrieve manifest. So the container was requested, returned, and simply did
// not carry this member — it is NOT "the files are here and nothing read them",
// and NOT "the product cannot parse that container yet".
// =============================================================================
describe('coverageReportHandler — shared container returned without the member', () => {
  // Built in a nested beforeAll (not at describe-body scope) because it
  // spreads the module-level `ctx`, which the file-level beforeAll above
  // populates with a real GraphStore — describe bodies run at COLLECTION
  // time, before any beforeAll, so `ctx` would still be unset here.
  let unparsedCtx: Context;
  beforeAll(() => {
    unparsedCtx = {
      ...ctx,
      manifest: {
        ...manifest,
        skippedDirectories: { settings: 139 },
        coverage: [
          { type: 'CustomObject', requested: true, retrieved: 2, errored: false, neverModeled: false, retrieveConfirmed: true },
          { type: 'SessionSettings', requested: true, retrieved: 0, errored: false, neverModeled: false, retrieveConfirmed: true },
          { type: 'FieldServiceSettings', requested: true, retrieved: 0, errored: false, neverModeled: false, retrieveConfirmed: true },
          // Confirmed-empty, but its own container IS dispatched — stays covered.
          { type: 'SharingRule', requested: true, retrieved: 0, errored: false, neverModeled: false, retrieveConfirmed: true },
        ],
      },
    };
  });

  it('moves the unparsed types out of covered into their own bucket and discloses why', async () => {
    const result = await coverageReportHandler(unparsedCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;

    const covered = data.covered.map((e) => e.type);
    expect(covered).not.toContain('SessionSettings');
    expect(covered).not.toContain('FieldServiceSettings');
    // Narrowly scoped: a confirmed-empty type outside the class is untouched.
    expect(covered).toContain('SharingRule');

    expect((data.retrievedNotParsed ?? []).map((e) => e.type)).toEqual([
      'FieldServiceSettings',
      'SessionSettings',
    ]);
    // Not silently re-labelled as a retrieve gap — `partial` prescribes a
    // re-retrieve, which cannot close this.
    const partial = data.partial.map((e) => e.type);
    expect(partial).not.toContain('SessionSettings');
    expect(partial).not.toContain('FieldServiceSettings');

    // INVARIANT: the summary and the partitions agree — the lockstep this file
    // already guards for the confirmed-empty tri-state now covers the new state.
    expect(data.summary.retrievedNotParsedTypes).toEqual([
      'FieldServiceSettings',
      'SessionSettings',
    ]);
    expect(data.summary.coveredTypes).not.toContain('SessionSettings');
    expect(data.summary.missingCoverage).toContain('SessionSettings');
    expect(data.summary.status).toBe('partial');
    expect(data.trust.completeness.status).toBe('partial');

    expect(data.disclosure).toContain('THE CONTAINER RETURNED WITHOUT THIS MEMBER');
    expect(data.disclosure).toContain('NOT CHECKED');
    // The three clauses that were false, all gone — a reader sent to a
    // re-retrieve (or to a parser the product already ships) is sent nowhere.
    expect(data.disclosure).not.toContain('files on disk');
    expect(data.disclosure).not.toContain("types' files on disk");
    expect(data.disclosure).not.toContain('the product does not parse that container yet');
    // …and the remedy that IS true for SessionSettings: the member cannot
    // arrive, because Salesforce nests it inside Security.settings.
    expect(data.disclosure).toContain('Security.settings-meta.xml');
    expect(data.disclosure).toContain('PRODUCT change');
    expect(data.trust.limitations[0]).toBe(data.disclosure);
  });

  it('is inert on a vault whose containers were all dispatched (key absent, disclosure unchanged)', async () => {
    const result = await coverageReportHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.retrievedNotParsed).toBeUndefined();
    expect(result.value.data.disclosure).not.toContain('THE CONTAINER RETURNED WITHOUT THIS MEMBER');
  });

  // R6 DRIFT: partitionCoverage (this file) and summarizeCoverage
  // (manifest.ts) each hand-roll the same five-way tri-state and are guarded
  // only by a "kept in deliberate lockstep" comment in both files. A type
  // that summary.missingCoverage flags as needing attention must land in AT
  // LEAST ONE of covered/partial/notModeled/pending/capped/retrievedNotParsed
  // so a reader who follows the bucketed lists can find out why it is
  // missing — and no type may ever sit in summary.coveredTypes while also
  // appearing in one of the non-covered buckets. Both directions are swept
  // here over every reachable CoverageEntry shape (not just the two rows the
  // CR-P3-3 fixture above exercises) so a future edit to one predicate that
  // is not mirrored in the other fails loudly instead of silently dropping
  // or double-counting a type.
  describe('R6: partitionCoverage stays in lockstep with summarizeCoverage over every entry shape', () => {
    const boolOptions = [true, false, undefined] as const;
    const retrievedOptions = [0, 3] as const;

    const allEntries: CoverageEntry[] = [];
    let i = 0;
    for (const requested of [true, false]) {
      for (const retrieved of retrievedOptions) {
        for (const errored of [true, false]) {
          for (const neverModeled of [true, false]) {
            for (const pending of boolOptions) {
              for (const capped of boolOptions) {
                for (const retrieveConfirmed of boolOptions) {
                  i += 1;
                  allEntries.push({
                    type: `Gen${i}`,
                    requested,
                    retrieved,
                    errored,
                    neverModeled,
                    ...(pending === undefined ? {} : { pending }),
                    ...(capped === undefined ? {} : { capped }),
                    ...(retrieveConfirmed === undefined ? {} : { retrieveConfirmed }),
                  });
                }
              }
            }
          }
        }
      }
    }

    const genManifest: VaultManifest = {
      ...manifest,
      coverage: allEntries,
    };
    // Same collection-vs-runtime ordering issue as `unparsedCtx` above:
    // spreads `ctx`, so it must wait for the file-level beforeAll.
    let genCtx: Context;
    beforeAll(() => {
      genCtx = { ...ctx, manifest: genManifest };
    });

    it('every entry lands in a bucket consistent with the summary, in both directions', async () => {
      const result = await coverageReportHandler(genCtx, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.value.data;

      const coveredSet = new Set(data.covered.map((e) => e.type));
      const nonCoveredSet = new Set([
        ...data.partial.map((e) => e.type),
        ...data.notModeled.map((e) => e.type),
        ...data.pending.map((e) => e.type),
        ...data.capped.map((e) => e.type),
        ...(data.retrievedNotParsed ?? []).map((e) => e.type),
        ...(data.notRequested ?? []).map((e) => e.type),
      ]);
      const summaryCovered = new Set(data.summary.coveredTypes);
      const summaryMissing = new Set(data.summary.missingCoverage);

      const violations: string[] = [];
      for (const entry of allEntries) {
        const inCovered = coveredSet.has(entry.type);
        const inNonCovered = nonCoveredSet.has(entry.type);
        const inSummaryCovered = summaryCovered.has(entry.type);
        const inSummaryMissing = summaryMissing.has(entry.type);

        // Direction 1: never covered-by-partition AND non-covered-by-partition
        // at once (partitionCoverage's own buckets must be mutually exclusive).
        if (inCovered && inNonCovered) {
          violations.push(`${entry.type}: in BOTH covered and a non-covered bucket`);
        }
        // Direction 2: the summary must never call a type covered while
        // coverage_report's own buckets call it non-covered (the exact
        // self-contradiction the lockstep comment exists to prevent).
        if (inSummaryCovered && inNonCovered) {
          violations.push(`${entry.type}: summary.coveredTypes but also a non-covered bucket`);
        }
        // Direction 3: whatever the partition calls covered must not be a
        // type the summary flags as still missing coverage.
        if (inCovered && inSummaryMissing) {
          violations.push(`${entry.type}: in covered but summary.missingCoverage flags it`);
        }
        // Direction 4: a type the summary says needs attention
        // (missingCoverage) must be explainable from SOME bucket in the
        // per-entry listing — it must not vanish from covered, partial,
        // notModeled, pending, capped AND retrievedNotParsed all at once,
        // which would silently drop it from every bucketed list a reader
        // can page through even though the summary still names it.
        if (inSummaryMissing && !inCovered && !inNonCovered) {
          violations.push(`${entry.type}: summary.missingCoverage but in NO coverage_report bucket`);
        }
      }

      expect(violations).toEqual([]);
    });
  });
});

// =============================================================================
// UNUSED-CERTIFIED-ZERO-CONTRADICTED-BY-OWN-GRAPH, coverage_report's half.
//
// Same shared fact `unusedComponentsHandler` reads via
// `referencedButAbsentFamilies` (`../../src/tools/referenced-but-absent.js`)
// and `listComponentsHandler` now reads too. Measured on a real production
// vault: a folder-scoped metadata family with 0 nodes, and dozens of
// `declared` edges from other retrieved components naming specific members of
// it that were never retrieved. Before this fix, `coverage_report` called
// that family `covered` — the exact reading `unused_components` and
// `list_components` were independently found to disagree with on the same
// vault, same run.
// =============================================================================
describe('coverageReportHandler — a certified zero its own graph contradicts', () => {
  const REFERENCED_ABSENT_A = 'EmailTemplate:Folder_A/Template_B';
  const REFERENCED_ABSENT_B = 'EmailTemplate:Folder_A/Template_C';
  const ALERT_A = 'WorkflowAlert:Obj_A__c.Alert_D';
  const APPROVAL_A = 'ApprovalProcess:Obj_A__c.Approval_E';
  const PHANTOM_TARGET = 'GlobalValueSet:Phantom_G';
  const PHANTOM_SOURCE = 'ApexClass:Scanner_H';

  const makeDanglingNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
    type: 'ApexClass',
    apiName: 'Unused',
    label: null,
    parentId: null,
    sourcePath: 'unused.cls',
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {},
    ...overrides,
  });

  const makeEdge = (
    overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
  ): Edge => ({
    confidence: 'declared',
    source: 'unit-test',
    properties: {},
    ...overrides,
  });

  /** EmailTemplate/GlobalValueSet/Letterhead all read "requested, confirmed
   *  clean, zero members" — the exact upstream fact `covered` is built on.
   *  Letterhead has no dangling referrer at all, so it is the control: a
   *  genuinely confirmed-empty type must read unchanged. */
  const danglingManifest: VaultManifest = {
    ...manifest,
    coverage: [
      { type: 'CustomObject', requested: true, retrieved: 2, errored: false, neverModeled: false, retrieveConfirmed: true },
      { type: 'EmailTemplate', requested: true, retrieved: 0, errored: false, neverModeled: false, retrieveConfirmed: true },
      { type: 'GlobalValueSet', requested: true, retrieved: 0, errored: false, neverModeled: false, retrieveConfirmed: true },
      { type: 'Letterhead', requested: true, retrieved: 0, errored: false, neverModeled: false, retrieveConfirmed: true },
    ],
  };

  let danglingDir: string;
  let danglingStore: GraphStore;
  let danglingCtx: Context;

  beforeAll(async () => {
    danglingDir = mkdtempSync(join(tmpdir(), 'sfi-coverage-report-dangling-'));
    const opened = await openGraph(join(danglingDir, 'dangling.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    danglingStore = opened.value;
    const seed: ExtractionResult = {
      nodes: [
        // NO EmailTemplate node exists. These are the referrers that name
        // templates the refresh never brought back.
        makeDanglingNode({ id: ALERT_A, type: 'WorkflowAlert', apiName: 'Obj_A__c.Alert_D' }),
        makeDanglingNode({ id: APPROVAL_A, type: 'ApprovalProcess', apiName: 'Obj_A__c.Approval_E' }),
        makeDanglingNode({ id: PHANTOM_SOURCE, type: 'ApexClass', apiName: 'Scanner_H' }),
      ],
      edges: [
        makeEdge({ fromId: ALERT_A, toId: REFERENCED_ABSENT_A, edgeType: 'references' }),
        makeEdge({ fromId: APPROVAL_A, toId: REFERENCED_ABSENT_A, edgeType: 'sendsEmail' }),
        makeEdge({ fromId: APPROVAL_A, toId: REFERENCED_ABSENT_B, edgeType: 'references' }),
        // A HEURISTIC scanner phantom at a wholly-absent family — must NOT be
        // strong enough to unseat a checked zero (same rule
        // `unused_components` enforces via CONTRADICTING_CONFIDENCE).
        makeEdge({
          fromId: PHANTOM_SOURCE,
          toId: PHANTOM_TARGET,
          edgeType: 'references',
          confidence: 'heuristic',
        }),
      ],
    };
    const imported = await importExtractionResults(danglingStore, [seed]);
    if (!imported.ok) throw new Error('importExtractionResults failed');
    danglingCtx = {
      vaultRoot: danglingDir,
      manifest: danglingManifest,
      graph: danglingStore,
      liveCapability: mintLiveCapability('opt-in'),
    };
  });

  afterAll(async () => {
    await closeGraph(danglingStore);
    rmSync(danglingDir, { recursive: true, force: true });
  });

  it('moves a family its own edges contradict OUT of covered and INTO partial', async () => {
    const result = await coverageReportHandler(danglingCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;

    expect(data.covered.map((e) => e.type)).not.toContain('EmailTemplate');
    expect(data.partial.map((e) => e.type)).toContain('EmailTemplate');
    // The control: nothing dangles at Letterhead, so it stays covered.
    expect(data.covered.map((e) => e.type)).toContain('Letterhead');
    expect(data.partial.map((e) => e.type)).not.toContain('Letterhead');
    // The heuristic-only phantom must NOT unseat GlobalValueSet's checked zero.
    expect(data.covered.map((e) => e.type)).toContain('GlobalValueSet');
    expect(data.partial.map((e) => e.type)).not.toContain('GlobalValueSet');
  });

  it('names the contradiction (edge count, distinct member count) in a typed field', async () => {
    const result = await coverageReportHandler(danglingCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.value.data.referencedButAbsent?.find((e) => e.type === 'EmailTemplate');
    expect(entry).toBeDefined();
    expect(entry?.referenceEdges).toBe(3);
    // Groups are split by (edgeType, confidence) and summed as an honest
    // UPPER BOUND (a `references` group and a `sendsEmail` group both name
    // REFERENCED_ABSENT_A, so the sum over-counts rather than deduping
    // globally) — same arithmetic `unused_components` uses for this identical
    // fixture shape.
    expect(entry?.distinctTargets).toBe(3);
    expect(entry?.retrieveConfirmed).toBe(true);
    expect(entry?.retrieved).toBe(0);
  });

  it('names the same contradiction in the disclosure prose, matching the other two tools\' framing', async () => {
    const result = await coverageReportHandler(danglingCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.disclosure).toContain('REFERENCED BUT ABSENT');
    expect(data.disclosure).toContain('NOT A CHECKED ZERO');
    expect(data.disclosure).toContain('3 declared/parsed reference edge(s)');
    expect(data.disclosure).toContain('retrieve_blindspot_report');
    expect(data.trust.limitations[0]).toBe(data.disclosure);
  });

  it('widens trust.completeness so the report cannot read complete while partial[] lists the contradiction', async () => {
    const result = await coverageReportHandler(danglingCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.trust.completeness.status).not.toBe('complete');
    expect(data.trust.completeness.missingCoverage).toContain('EmailTemplate');
  });

  it('is inert on a vault with no referenced-but-absent condition (empty graph)', async () => {
    const result = await coverageReportHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.referencedButAbsent).toBeUndefined();
    expect(result.value.data.disclosure).not.toContain('REFERENCED BUT ABSENT');
  });
});
