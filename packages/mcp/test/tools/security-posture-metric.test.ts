import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, openGraph, type GraphStore } from '@sf-intelligence/graph';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Context } from '../../src/server.js';
import {
  captureSecurityPostureMetrics,
  gradeFromFindingCount,
  securityPostureMetricsFromFindingCount,
} from '../../src/tools/security-posture-metric.js';

/**
 * Injection seam for the ONE branch no real graph can reach:
 * `perm.value.data.auditTotals === null`. That null is set only when the
 * CRUD/FLS sub-analysis returns an error, and every way to make it error with
 * a real store (a closed / unreadable graph) makes the OUTER report error
 * first — `!perm.ok` would short-circuit before the branch under test, so the
 * test would pass for the wrong reason. `override` is null for every other
 * case in this file: they all run the REAL handler against the REAL DuckDB
 * store opened in `beforeAll`.
 */
const stub = vi.hoisted(() => ({
  override: null as null | ((ctx: unknown, input: unknown) => unknown),
  lastInput: undefined as unknown,
}));

vi.mock('../../src/tools/synthesis-reports.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/tools/synthesis-reports.js')>();
  return {
    ...actual,
    permissionRiskReportHandler: (ctx: never, input: never) => {
      stub.lastInput = input;
      return stub.override === null
        ? actual.permissionRiskReportHandler(ctx, input)
        : stub.override(ctx, input);
    },
  };
});

describe('security-posture-metric (R8-SECURITY-TREND)', () => {
  it('grades finding counts like the retired org_scorecard Security dimension', () => {
    expect(gradeFromFindingCount(0)).toBe('A');
    expect(gradeFromFindingCount(1)).toBe('B');
    expect(gradeFromFindingCount(2)).toBe('B');
    expect(gradeFromFindingCount(3)).toBe('C');
    expect(gradeFromFindingCount(5)).toBe('C');
    expect(gradeFromFindingCount(6)).toBe('D');
    expect(gradeFromFindingCount(10)).toBe('D');
    expect(gradeFromFindingCount(11)).toBe('F');
  });

  it('maps grades to securityScore 0–100 and securityGrade GPA', () => {
    expect(securityPostureMetricsFromFindingCount(0)).toEqual({
      securityScore: 100,
      securityGrade: 4,
    });
    expect(securityPostureMetricsFromFindingCount(2)).toEqual({
      securityScore: 75,
      securityGrade: 3,
    });
    expect(securityPostureMetricsFromFindingCount(11)).toEqual({
      securityScore: 0,
      securityGrade: 0,
    });
  });
});

// R1 / MEDIUM — captureSecurityPostureMetrics must not grade a
// coverage-degraded permission-risk report as a clean 'A'/100. A run whose
// Profile family failed retrieve has an UNKNOWN finding count for the
// over-privilege headline, not a proven zero.
describe('captureSecurityPostureMetrics — coverage-degraded capture (R1 null-not-zero)', () => {
  let tempDir: string;
  let store: GraphStore;

  const BASE_MANIFEST: VaultManifest = {
    version: '0.1.0',
    refreshedAt: '2026-05-29T00:00:00.000Z',
    sourceOrg: 'security-posture-test',
    components: {},
    edges: {},
    sourceTreeHash: 'sha256:security-posture-fixture',
    coverageComputedAt: '2026-05-29T00:00:00.000Z',
    coverage: [
      { type: 'CustomObject', requested: true, retrieved: 1, errored: false, neverModeled: false },
      // The five families captureSecurityPostureMetrics' headline depends on
      // — declared fully, confirmed-clean-empty retrieves (retrieveConfirmed
      // marks "the describe confirmed the org supports this type AND the
      // clean retrieve returned zero members", i.e. genuinely covered, not a
      // silent drop) so the control case is truly "fully covered, zero
      // findings" rather than "coverage never checked".
      { type: 'Profile', requested: true, retrieved: 0, errored: false, neverModeled: false, retrieveConfirmed: true },
      { type: 'PermissionSet', requested: true, retrieved: 0, errored: false, neverModeled: false, retrieveConfirmed: true },
      { type: 'PermissionSetGroup', requested: true, retrieved: 0, errored: false, neverModeled: false, retrieveConfirmed: true },
      { type: 'ApexClass', requested: true, retrieved: 0, errored: false, neverModeled: false, retrieveConfirmed: true },
      { type: 'ApexTrigger', requested: true, retrieved: 0, errored: false, neverModeled: false, retrieveConfirmed: true },
    ],
  };

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sfi-security-posture-'));
    const opened = await openGraph(join(tempDir, 'graph.duckdb'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('captures a graded score on a fully-covered, empty-findings vault (control)', async () => {
    const ctx: Context = { vaultRoot: tempDir, manifest: BASE_MANIFEST, graph: store };
    const metrics = await captureSecurityPostureMetrics(ctx);
    // No Profile/PermissionSet/ApexClass nodes in the fixture graph, and the
    // families that matter for this report all retrieved clean — a genuine
    // zero-finding, gradeable run.
    expect(metrics).toEqual({ securityScore: 100, securityGrade: 4 });
  });

  it('withholds the metric (typed absence) when Profile retrieval ERRORED — not a graded A', async () => {
    // The over-privilege headline is read straight from Profile/PermissionSet
    // metadata. A Profile retrieve failure means the "0 over-privileged
    // grantors" the report would compute is UNCHECKED, not proven clean — the
    // same graph would grade 'A'/100 today because the finding-count path
    // never consults coverage.
    const degradedManifest: VaultManifest = {
      ...BASE_MANIFEST,
      // `?.map()` yields `CoverageEntry[] | undefined`, which `exactOptionalPropertyTypes`
      // refuses for an optional-but-never-undefined slot. The fixture always has
      // coverage; `?? []` keeps that explicit rather than asserting it away.
      coverage: (BASE_MANIFEST.coverage ?? []).map((entry) =>
        entry.type === 'Profile'
          ? { ...entry, retrieved: 0, errored: true, retrieveConfirmed: false }
          : entry,
      ),
    };
    const ctx: Context = { vaultRoot: tempDir, manifest: degradedManifest, graph: store };
    const metrics = await captureSecurityPostureMetrics(ctx);
    expect(metrics).toBeUndefined();
  });

  it('still grades a vault whose manifest carries NO coverage rows at all (pre-v4) — coverage UNKNOWN is not coverage MISSING', async () => {
    // A manifest written before coverage rows were persisted has no KNOWN gap,
    // only unknowable coverage. `summarizeCoverage` reports every requested
    // family in `missingCoverage` for such a manifest (the `filtered.length
    // === 0` branch), so a gate written as `missingCoverage.length > 0` fires
    // on EVERY snapshot of such a vault, forever, and the trend chart silently
    // goes blank with nothing saying why. That is the same
    // withhold-a-thing-you-never-checked defect in reverse, and it is reachable
    // in production: the snapshot command builds its Context from a bare
    // manifest load with no in-memory coverage backfill.
    // `buildEnumerationCoverageCaveatFor`'s `coverageKnown` guard is what draws
    // the line; this case pins it.
    const preV4Manifest: VaultManifest = {
      version: BASE_MANIFEST.version,
      refreshedAt: BASE_MANIFEST.refreshedAt,
      sourceOrg: BASE_MANIFEST.sourceOrg,
      components: BASE_MANIFEST.components,
      edges: BASE_MANIFEST.edges,
      sourceTreeHash: BASE_MANIFEST.sourceTreeHash,
      // NO `coverage` / `coverageComputedAt` keys — the pre-v4 shape.
    };
    const ctx: Context = { vaultRoot: tempDir, manifest: preV4Manifest, graph: store };
    const metrics = await captureSecurityPostureMetrics(ctx);
    expect(metrics).toEqual({ securityScore: 100, securityGrade: 4 });
  });

  it('withholds the metric when the CRUD/FLS sub-analysis ERRORED (auditTotals null) — a 0 that was never counted', async () => {
    // `auditTotals === null` means `crudFlsAuditHandler` returned an error, so
    // its findings never reached `findings.length`. Grading that length as a
    // clean 'A'/100 certifies a count nothing produced.
    stub.override = () =>
      Promise.resolve({
        ok: true,
        value: { data: { findings: [], auditTotals: null } },
      });
    try {
      const ctx: Context = { vaultRoot: tempDir, manifest: BASE_MANIFEST, graph: store };
      const metrics = await captureSecurityPostureMetrics(ctx);
      expect(metrics).toBeUndefined();
      // Pin the assumption that branch rests on. `auditTotals: null` is ALSO
      // returned, by design, by the scoped-profile paths in the report — there
      // it means "the sub-analysis was never run", not "it failed". Reading
      // null as an error is only sound because this caller passes no profile
      // filter. If one is ever plumbed through, this assertion fails first.
      expect(stub.lastInput).toEqual({ limit: 50 });
    } finally {
      stub.override = null;
    }
  });

  it('still captures a graded score when only a PERMANENTLY not-modeled family is missing (no perpetual withholding)', async () => {
    // notModeled families (e.g. ListView) are a permanent product limitation
    // disclosed elsewhere, not an actionable gap — gating on them would make
    // this metric undefined for every vault forever. Only families this
    // report actually depends on, and only ACTIONABLE (errored) gaps in them,
    // should withhold the metric.
    const neverModeledManifest: VaultManifest = {
      ...BASE_MANIFEST,
      coverage: [
        ...(BASE_MANIFEST.coverage ?? []),
        { type: 'ListView', requested: true, retrieved: 5, errored: false, neverModeled: true },
      ],
    };
    const ctx: Context = { vaultRoot: tempDir, manifest: neverModeledManifest, graph: store };
    const metrics = await captureSecurityPostureMetrics(ctx);
    expect(metrics).toEqual({ securityScore: 100, securityGrade: 4 });
  });
});
