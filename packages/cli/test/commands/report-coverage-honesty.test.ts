/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ComponentType, CoverageEntry, VaultManifest } from '@sf-intelligence/contracts';
import { loadManifest, summarizeCoverage } from '@sf-intelligence/vault';

import {
  buildCoverageEntries,
  chunkFolderedReportManifest,
  decorateReportPullCoverage,
  decorateReportsCapCoverage,
  formatRefreshSummary,
  REPORT_PULL_DISCLOSURE,
  runRefresh,
  runSfRetrieveSmartReports,
  type RefreshResult,
  type ReportPullDisclosure,
  type runSf,
} from '../../src/commands/refresh.js';

/**
 * The 2026-07-28 report-coverage incident, pinned.
 *
 * A refresh against an org holding 4,296 reports wrote a manifest whose
 * `Report` coverage row read `{ requested: true, retrieved: 0, errored: false,
 * retrieveConfirmed: true }` — a CONFIRMED ZERO. Two independent defects made
 * that shape unfalsifiable:
 *
 *   1. `foldReportDashboardUsageIntoFields` DROPS every Report/Dashboard node
 *      before anything counts the graph, so `counts.components['Report']` is
 *      structurally 0 no matter how many report files landed. The identical
 *      row appears on the 2026-06-30 manifest of a run that DID land 3,076
 *      report files.
 *   2. `runSfRetrieveSmartReports` returned `err`, the caller logged it to
 *      stderr and continued, and NOTHING in the vault recorded the failure —
 *      the manifest was byte-identical to a successful empty pull.
 *
 * These tests assert the two honesty invariants that come out of that: a
 * fold-erased type can never carry `retrieveConfirmed`, and a report pull that
 * errored is recorded rather than swallowed.
 */

const counts = (components: Readonly<Record<string, number>>): RefreshResult['counts'] => ({
  components,
  edges: {},
});

const rows = (entries: readonly CoverageEntry[]): ReadonlyMap<string, CoverageEntry> =>
  new Map(entries.map((e) => [e.type, e]));

const allTypesConfirmed = (...types: readonly ComponentType[]): ReadonlySet<ComponentType> =>
  new Set(types);

const manifestWith = (coverage: readonly CoverageEntry[]): VaultManifest => ({
  version: '0.1.0',
  refreshedAt: '2026-07-28T00:00:00.000Z',
  sourceOrg: 'test',
  components: {},
  edges: {},
  sourceTreeHash: 'hash-a',
  coverage,
});

const disclosure = (over: Partial<ReportPullDisclosure> = {}): ReportPullDisclosure => ({
  mode: 'smart',
  outcome: 'failed',
  error: 'smart report retrieve failed: all 7 batch(es) errored',
  attemptedAt: '2026-07-28T04:00:00.000Z',
  ...over,
});

describe('the written manifest never carries an unprovable report zero (end to end)', () => {
  it('a refresh writes Report/Dashboard rows as pending, never retrieveConfirmed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-report-cov-'));
    try {
      const metaDir = join(cwd, 'org-kb', 'meta');
      await mkdir(metaDir, { recursive: true });
      await writeFile(
        join(metaDir, 'config.json'),
        JSON.stringify({
          targetOrg: 'test-org',
          vaultRoot: join(cwd, 'org-kb'),
          version: '0.1.0',
          createdAt: '2026-07-28T00:00:00.000Z',
        }),
        'utf8',
      );
      const objectDir = join(cwd, 'org-kb', 'source', 'objects', 'Only__c');
      await mkdir(objectDir, { recursive: true });
      await writeFile(
        join(objectDir, 'Only__c.object-meta.xml'),
        `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <deploymentStatus>Deployed</deploymentStatus>
    <label>Only</label>
    <nameField>
        <label>Name</label>
        <type>Text</type>
    </nameField>
    <pluralLabel>Onlys</pluralLabel>
    <sharingModel>ReadWrite</sharingModel>
</CustomObject>
`,
        'utf8',
      );

      const result = await runRefresh({ cwd, noPull: true });
      expect(result.status).toBe('success');

      const loaded = await loadManifest(join(cwd, 'org-kb'));
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      const byType = rows(loaded.value.coverage ?? []);

      // The vault holds zero report nodes — as it always will, fold or no fold.
      // The row must say "not checked", never "confirmed: this org has none".
      for (const type of ['Report', 'Dashboard'] as const) {
        expect(byType.get(type)?.pending).toBe(true);
        expect(byType.get(type)?.retrieveConfirmed).toBeUndefined();
      }
      expect(summarizeCoverage(loaded.value, ['Report']).missingCoverage).toContain('Report');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('buildCoverageEntries — a fold-erased type can never read as confirmed-empty', () => {
  it('never stamps retrieveConfirmed on Report/Dashboard even when the retrieve confirmed them', () => {
    // The exact shipped inputs: the wildcard package.xml requested Report, the
    // retrieve succeeded so Report landed in `confirmedTypes`, and the fold
    // then left the node count at 0.
    const entries = buildCoverageEntries(
      counts({ CustomObject: 27, Report: 0, Dashboard: 0 }),
      {},
      null,
      '/vault/source',
      [],
      allTypesConfirmed('CustomObject', 'Report', 'Dashboard'),
    );
    const byType = rows(entries);
    expect(byType.get('Report')?.retrieveConfirmed).toBeUndefined();
    expect(byType.get('Dashboard')?.retrieveConfirmed).toBeUndefined();
    // Unknown, not zero: the row carries no evidence of its own.
    expect(byType.get('Report')?.pending).toBe(true);
    expect(byType.get('Dashboard')?.pending).toBe(true);
  });

  it('COUNTERFACTUAL: a non-fold type in the same confirmed set still gets retrieveConfirmed', () => {
    // Without this, the test above would pass on a build that simply stopped
    // confirming anything — the confirmed-empty signal is still live for types
    // whose node count actually means something.
    const byType = rows(
      buildCoverageEntries(
        counts({ CustomObject: 0 }),
        {},
        null,
        '/vault/source',
        [],
        allTypesConfirmed('CustomObject'),
      ),
    );
    expect(byType.get('CustomObject')?.retrieveConfirmed).toBe(true);
    expect(byType.get('CustomObject')?.pending).toBeUndefined();
  });

  it('summarizeCoverage refuses to call a fold-erased row complete', () => {
    const entries = buildCoverageEntries(
      counts({ Report: 0 }),
      {},
      null,
      '/vault/source',
      [],
      allTypesConfirmed('Report'),
    );
    const summary = summarizeCoverage(manifestWith([...entries]), ['Report']);
    expect(summary.missingCoverage).toContain('Report');
  });
});

describe('decorateReportsCapCoverage — `retrieved` is what LANDED, not the post-fold node count', () => {
  const foldErasedRows: readonly CoverageEntry[] = [
    { type: 'Report', requested: true, retrieved: 0, errored: false, neverModeled: false, pending: true },
    { type: 'Dashboard', requested: true, retrieved: 0, errored: false, neverModeled: false, pending: true },
  ];

  it('reports the files the retrieve delivered, and keeps the capped tail pending', () => {
    const byType = rows(
      decorateReportsCapCoverage(foldErasedRows, {
        reports: { total: 4296, requested: 500, retrieved: 500 },
        dashboards: { total: 183, requested: 83, retrieved: 78 },
      }),
    );
    // The whole point: 500 landed report files, NOT the 0 nodes the fold left.
    expect(byType.get('Report')?.retrieved).toBe(500);
    expect(byType.get('Dashboard')?.retrieved).toBe(78);
    // 4,296 > 500 and 183 > 78 — the unchecked remainder keeps absence hedged.
    expect(byType.get('Report')?.pending).toBe(true);
    expect(byType.get('Dashboard')?.pending).toBe(true);
  });

  it('a fully-delivered non-zero pull clears pending and IS confirmed coverage', () => {
    const byType = rows(
      decorateReportsCapCoverage(foldErasedRows, {
        reports: { total: 12, requested: 12, retrieved: 12 },
        dashboards: { total: 0, requested: 0, retrieved: 0 },
      }),
    );
    expect(byType.get('Report')?.retrieved).toBe(12);
    expect(byType.get('Report')?.pending).toBeUndefined();
    expect(byType.get('Report')?.retrieveConfirmed).toBe(true);
    // A 0/0 dashboard row stays PENDING: the org total comes from a `count()`
    // that returns 0 on a failed query, so a zero there proves nothing.
    expect(byType.get('Dashboard')?.pending).toBe(true);
    expect(byType.get('Dashboard')?.retrieveConfirmed).toBeUndefined();
  });
});

describe('decorateReportPullCoverage — a failed pull cannot look like a successful empty one', () => {
  it('marks the rows errored + pending, strips retrieveConfirmed, and names the failure', () => {
    // Feed it the WORST case: rows that (on the shipped build) read as a clean
    // confirmed zero.
    const shipped: readonly CoverageEntry[] = [
      {
        type: 'Report',
        requested: true,
        retrieved: 0,
        errored: false,
        neverModeled: false,
        retrieveConfirmed: true,
      },
      { type: 'CustomObject', requested: true, retrieved: 27, errored: false, neverModeled: false },
    ];
    const byType = rows(decorateReportPullCoverage(shipped, disclosure()));

    expect(byType.get('Report')?.errored).toBe(true);
    expect(byType.get('Report')?.pending).toBe(true);
    expect(byType.get('Report')?.retrieveConfirmed).toBeUndefined();
    expect(byType.get('Report')?.errorReason).toContain(REPORT_PULL_DISCLOSURE);
    expect(byType.get('Report')?.errorReason).toContain('all 7 batch(es) errored');
    // Unrelated types are untouched — this is a scoped disclosure, not a
    // blanket degradation.
    expect(byType.get('CustomObject')).toEqual(shipped[1]);
  });

  it('the manifest a failed pull writes is NOT the manifest a clean pull writes', () => {
    const clean = decorateReportsCapCoverage(
      [{ type: 'Report', requested: true, retrieved: 0, errored: false, neverModeled: false, pending: true }],
      {
        reports: { total: 12, requested: 12, retrieved: 12 },
        dashboards: { total: 0, requested: 0, retrieved: 0 },
      },
    );
    const failed = decorateReportPullCoverage(clean, disclosure());
    expect(failed).not.toEqual(clean);
    expect(summarizeCoverage(manifestWith([...failed]), ['Report']).missingCoverage).toContain('Report');
    // The clean pull PROVED the org's 12 reports all landed, so it must NOT be
    // hedged — otherwise "errored" would carry no information at all.
    expect(summarizeCoverage(manifestWith([...clean]), ['Report']).missingCoverage).not.toContain('Report');
  });

  it('is a no-op when the pull was clean', () => {
    const clean: readonly CoverageEntry[] = [
      { type: 'Report', requested: true, retrieved: 500, errored: false, neverModeled: false },
    ];
    expect(decorateReportPullCoverage(clean, undefined)).toEqual(clean);
  });
});

describe('formatRefreshSummary — the failure reaches STDOUT, not just stderr', () => {
  const base: RefreshResult = {
    status: 'partial',
    counts: { components: {}, edges: {} },
    skippedDirectories: {},
    errors: [],
    durationMs: 1,
  };

  it('prints the disclosure, the underlying error, and what a 0 now means', () => {
    // `progress` writes to stderr; the CLI writes ONLY this string to stdout.
    // Operators pipe stdout, which is how the shipped failure went unread.
    const out = formatRefreshSummary({ ...base, reportPull: disclosure() });
    expect(out).toContain(REPORT_PULL_DISCLOSURE);
    expect(out).toContain('all 7 batch(es) errored');
    expect(out).toContain('NOT CHECKED');
  });

  it('says nothing when the pull was clean', () => {
    expect(formatRefreshSummary({ ...base, status: 'success' })).not.toContain(REPORT_PULL_DISCLOSURE);
  });
});

describe('chunkFolderedReportManifest — one 3,373-member package.xml becomes survivable batches', () => {
  const members = (prefix: string, n: number): readonly string[] =>
    Array.from({ length: n }, (_, i) => `Folder/${prefix}${i}`);

  it('splits per type, capped at the batch size, losing no member', () => {
    const batches = chunkFolderedReportManifest(
      { Report: members('R', 1250), Dashboard: members('D', 30) },
      500,
    );
    expect(batches.map((b) => `${b.type}:${b.members.length}`)).toEqual([
      'Report:500',
      'Report:500',
      'Report:250',
      'Dashboard:30',
    ]);
    const flat = batches.flatMap((b) => [...b.members]);
    expect(flat.length).toBe(1280);
    expect(new Set(flat).size).toBe(1280);
  });

  it('each batch is a standalone single-type package.xml', () => {
    const [first] = chunkFolderedReportManifest({ Report: ['Sales/Pipeline'], Dashboard: ['Exec/KPIs'] }, 500);
    expect(first?.manifestXml).toContain('<members>Sales/Pipeline</members>');
    expect(first?.manifestXml).toContain('<name>Report</name>');
    // Types never share a batch, so a type the org rejects cannot take the
    // other type's members down with it.
    expect(first?.manifestXml).not.toContain('<name>Dashboard</name>');
  });

  it('emits nothing when there is nothing to retrieve', () => {
    expect(chunkFolderedReportManifest({ Report: [], Dashboard: [] })).toEqual([]);
  });
});

/**
 * Batched-retrieve degradation, proven through the injectable `runSf` seam —
 * no org call. The shipped build made ONE retrieve call with ~3,373 members;
 * when it errored the entire pull was lost and the vault said 0.
 */
describe('runSfRetrieveSmartReports — a dead batch costs its own members, not the pull', () => {
  /**
   * An `sf` stub that answers the ranking SOQL with `count` reports and fails
   * the Nth `project retrieve start` call (1-indexed; 0 = fail none).
   */
  const spy = (
    reportCount: number,
    failNthRetrieve: number,
  ): { readonly runSfFn: typeof runSf; readonly retrieveCalls: () => number } => {
    let retrieves = 0;
    const fn = async (args: readonly string[]): Promise<{ stdout: string; stderr: string }> => {
      const argv = [...args];
      if (argv[0] === 'data' && argv[1] === 'query') {
        const q = argv[argv.indexOf('--query') + 1] ?? '';
        if (/FROM Folder/.test(q)) {
          return {
            stdout: JSON.stringify({
              result: { records: [{ Name: 'Sales Reports', DeveloperName: 'Sales_Reports' }], totalSize: 1 },
            }),
            stderr: '',
          };
        }
        if (/FROM Report/.test(q)) {
          const records = Array.from({ length: reportCount }, (_, i) => ({
            DeveloperName: `R${i}`,
            FolderName: 'Sales Reports',
          }));
          return { stdout: JSON.stringify({ result: { records, totalSize: reportCount } }), stderr: '' };
        }
        return { stdout: JSON.stringify({ result: { records: [], totalSize: 0 } }), stderr: '' };
      }
      if (argv[0] === 'project' && argv[1] === 'retrieve' && argv[2] === 'start') {
        retrieves += 1;
        if (retrieves === failNthRetrieve) throw new Error('MetadataTransferError: simulated batch failure');
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    return { runSfFn: fn as unknown as typeof runSf, retrieveCalls: () => retrieves };
  };

  it('one failed batch out of several degrades: ok, with the failure named', async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), 'sfi-batch-ok-'));
    const { runSfFn, retrieveCalls } = spy(1200, 2);
    try {
      const r = await runSfRetrieveSmartReports('myorg', sourceDir, 1200, runSfFn);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // 1,200 members / 500 = 3 calls, not the single monolithic one.
      expect(retrieveCalls()).toBe(3);
      expect(r.value.batchErrors.length).toBe(1);
      expect(r.value.batchErrors[0]).toContain('Report batch 2/3');
      expect(r.value.batchErrors[0]).toContain('MetadataTransferError');
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  it('a single-batch pull that dies is still a hard err (nothing landed)', async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), 'sfi-batch-err-'));
    const { runSfFn } = spy(10, 1);
    try {
      const r = await runSfRetrieveSmartReports('myorg', sourceDir, 10, runSfFn);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toContain('all 1 batch(es) errored');
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  it('a clean pull carries no batch errors', async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), 'sfi-batch-clean-'));
    const { runSfFn, retrieveCalls } = spy(600, 0);
    try {
      const r = await runSfRetrieveSmartReports('myorg', sourceDir, 600, runSfFn);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.batchErrors).toEqual([]);
      expect(retrieveCalls()).toBe(2);
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
    }
  });
});
