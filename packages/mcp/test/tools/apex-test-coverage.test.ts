/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  apexTestCoverageHandler,
  apexTestCoverageInputSchema,
} from '../../src/tools/apex-test-coverage.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-29T00:00:00Z',
  sourceOrg: 'test',
  components: { ApexClass: 5 },
  edges: { callsApex: 2 },
  sourceTreeHash: 'sha256:fixture',
};

const cls = (name: string, test = false): Node => ({
  id: `ApexClass:${name}`,
  type: 'ApexClass',
  apiName: name,
  label: null,
  parentId: null,
  sourcePath: `${name}.cls`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: test ? { isTest: true } : {},
});

const calls = (from: string, to: string): Edge => ({
  fromId: `ApexClass:${from}`,
  toId: `ApexClass:${to}`,
  edgeType: 'callsApex',
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
});

// SvcA <- SvcATest, SvcB <- SvcBTest, SvcC has no test.
const seed: ExtractionResult = {
  nodes: [cls('SvcA'), cls('SvcB'), cls('SvcC'), cls('SvcATest', true), cls('SvcBTest', true)],
  edges: [calls('SvcATest', 'SvcA'), calls('SvcBTest', 'SvcB')],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-cov-'));
  const opened = await openGraph(join(tempDir, 'cov.db'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store } as Context;
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('apexTestCoverageHandler — single class', () => {
  it('lists the covering test for a referenced class', async () => {
    const r = await apexTestCoverageHandler(ctx, { classApiName: 'SvcA' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.mode).toBe('single-class');
    expect(r.value.data.target?.status).toBe('has-test-references');
    expect(r.value.data.target?.coveringTests).toEqual(['ApexClass:SvcATest']);
  });

  it('reports no-test-references-found for an untested class', async () => {
    const r = await apexTestCoverageHandler(ctx, { classApiName: 'SvcC' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.target?.status).toBe('no-test-references-found');
    expect(r.value.data.target?.coveringTests).toEqual([]);
  });

  it('returns component-not-found for an unknown class', async () => {
    const r = await apexTestCoverageHandler(ctx, { classApiName: 'NoSuchClass' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('accepts the apexClass alias and stays in single-class mode (no silent org-wide downgrade)', async () => {
    const r = await apexTestCoverageHandler(ctx, { apexClass: 'SvcA' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The bug: a wrong-but-plausible key used to be stripped, dropping the
    // request to org-wide mode and answering a different question silently.
    expect(r.value.data.mode).toBe('single-class');
    expect(r.value.data.target?.classApiName).toBe('SvcA');
    expect(r.value.data.target?.coveringTests).toEqual(['ApexClass:SvcATest']);
  });

  it('prefers classApiName when both keys are present', async () => {
    const r = await apexTestCoverageHandler(ctx, { classApiName: 'SvcA', apexClass: 'SvcB' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.target?.classApiName).toBe('SvcA');
  });
});

describe('apexTestCoverageHandler — org-wide', () => {
  it('lists only the untested non-test classes and counts correctly', async () => {
    const r = await apexTestCoverageHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.mode).toBe('org-wide');
    expect(r.value.data.untestedClasses).toEqual(['ApexClass:SvcC']);
    expect(r.value.data.summary).toMatchObject({
      testClasses: 2,
      nonTestClasses: 3,
      classesWithTestReferences: 2,
      classesWithoutTestReferences: 1,
    });
  });
});

// --- Multi-page roster scan (H6 de-cap) ---------------------------------
//
// With SFI_NODE_SCAN_LIMIT=2 the per-type page is 2, so any org with > 2
// ApexClasses forces the offset loop to walk multiple pages. id-ASC ordering
// puts the `Zzz` pair LAST, i.e. past the (tiny) cap — the exact shape of the
// H6 bug where a covering test sorted past row 500 was dropped.
describe('apexTestCoverageHandler — past-cap roster (de-cap)', () => {
  let dir: string;
  let st: GraphStore;
  let pagedCtx: Context;

  // Aaa, Bbb = filler. Zzz (non-test) + ZzzTest (test, covers Zzz) sort last.
  // Yyy (non-test) is past the cap with NO covering test. Caller (non-test)
  // also emits callsApex into Zzz — must NOT count as a covering test.
  const pagedSeed: ExtractionResult = {
    nodes: [
      cls('Aaa'),
      cls('Bbb'),
      cls('Caller'),
      cls('Yyy'),
      cls('Zzz'),
      cls('ZzzTest', true),
    ],
    edges: [calls('ZzzTest', 'Zzz'), calls('Caller', 'Zzz')],
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-cov-paged-'));
    const opened = await openGraph(join(dir, 'cov.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    st = opened.value;
    const imported = await importExtractionResults(st, [pagedSeed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    pagedCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: st } as Context;
  });

  afterAll(async () => {
    await closeGraph(st);
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env['SFI_NODE_SCAN_LIMIT'] = '2';
  });

  afterEach(() => {
    delete process.env['SFI_NODE_SCAN_LIMIT'];
  });

  it('single-class: finds a covering test sorted PAST the cap (the H6 false-negative)', async () => {
    // BEFORE the fix the capped first-2-class roster dropped both Zzz and
    // ZzzTest, so the verdict was a wrong "no-test-references-found".
    const r = await apexTestCoverageHandler(pagedCtx, { classApiName: 'Zzz' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.target?.status).toBe('has-test-references');
    expect(r.value.data.target?.coveringTests).toEqual(['ApexClass:ZzzTest']);
  });

  it('single-class: excludes a NON-test caller from coveringTests', async () => {
    // `Caller` (non-test) emits callsApex into Zzz; inbound-then-filter must
    // keep only sources with isTest===true, else a regular caller is
    // miscounted as coverage (a false positive).
    const r = await apexTestCoverageHandler(pagedCtx, { classApiName: 'Zzz' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.target?.coveringTests).not.toContain('ApexClass:Caller');
    expect(r.value.data.target?.coveringTests).toEqual(['ApexClass:ZzzTest']);
  });

  it('org-wide: enumerates untested classes from the FULL roster (not just page 1)', async () => {
    // Yyy and Caller are past the cap and untested; org-wide must list them.
    const r = await apexTestCoverageHandler(pagedCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.mode).toBe('org-wide');
    // Aaa, Bbb, Caller, Yyy untested; Zzz covered; ZzzTest is a test class.
    expect(r.value.data.untestedClasses).toEqual([
      'ApexClass:Aaa',
      'ApexClass:Bbb',
      'ApexClass:Caller',
      'ApexClass:Yyy',
    ]);
    // Counts come from the exhaustive walk, cross-checked against true totals.
    expect(r.value.data.summary).toMatchObject({
      testClasses: 1,
      nonTestClasses: 5,
      classesWithTestReferences: 1,
      classesWithoutTestReferences: 4,
    });
  });

  // CR-22 B4 — org-wide output cursor over the 4-untested-class list.
  it('org-wide: a truncated page emits a cursor that resumes with no gaps or dupes', async () => {
    const all = await apexTestCoverageHandler(pagedCtx, { limit: 500 });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const fullOrder = all.value.data.untestedClasses ?? [];
    expect(fullOrder.length).toBe(4);

    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const page: Awaited<ReturnType<typeof apexTestCoverageHandler>> =
        await apexTestCoverageHandler(
          pagedCtx,
          cursor !== undefined ? { limit: 1, cursor } : { limit: 1 },
        );
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      for (const id of page.value.data.untestedClasses ?? []) seen.push(id);
      const nc = page.value.data.nextCursor;
      if (nc === undefined) break;
      cursor = nc;
      guard += 1;
      if (guard > 20) throw new Error('cursor did not terminate');
    }
    expect(seen).toEqual([...fullOrder]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('org-wide: summary totals stay full-org across pages', async () => {
    const page = await apexTestCoverageHandler(pagedCtx, { limit: 1 });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    // Counts are computed pre-slice, so they remain the full-org totals.
    expect(page.value.data.summary).toMatchObject({
      testClasses: 1,
      nonTestClasses: 5,
      classesWithTestReferences: 1,
      classesWithoutTestReferences: 4,
    });
    expect(page.value.data.summary.truncated).toBe(true);
  });
});

// CR-22 B4 — single-class mode must NEVER emit a cursor; org-wide whole-fits
// stays byte-identical.
describe('apexTestCoverageHandler — output cursor (CR-22)', () => {
  it('single-class mode never emits a cursor or paging fields', async () => {
    const r = await apexTestCoverageHandler(ctx, { classApiName: 'SvcA' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data as unknown as Record<string, unknown>;
    expect('limit' in d).toBe(false);
    expect('offset' in d).toBe(false);
    expect('nextCursor' in d).toBe(false);
    expect('pageInfo' in d).toBe(false);
  });

  it('org-wide whole-fits no-cursor call omits all paging fields', async () => {
    const r = await apexTestCoverageHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data as unknown as Record<string, unknown>;
    expect('limit' in d).toBe(false);
    expect('offset' in d).toBe(false);
    expect('nextOffset' in d).toBe(false);
    expect('nextCursor' in d).toBe(false);
    expect('pageInfo' in d).toBe(false);
  });
});

// A test class can emit the SAME callsApex edge into the target from two
// extraction sources (e.g. declared vs the heuristic scanner). The edge PK is
// (from_id, to_id, edge_type, source), so two distinct sources => two rows.
// coveringTests must dedup so the test appears exactly once, mirroring the old
// per-target Set semantics.
describe('apexTestCoverageHandler — duplicate covering edge', () => {
  let dir: string;
  let st: GraphStore;
  let dupCtx: Context;

  const declaredCall = (from: string, to: string): Edge => calls(from, to);
  const heuristicCall = (from: string, to: string): Edge => ({
    ...calls(from, to),
    confidence: 'heuristic',
    source: 'apex-scanner',
  });

  const dupSeed: ExtractionResult = {
    nodes: [cls('Svc'), cls('SvcTest', true)],
    edges: [declaredCall('SvcTest', 'Svc'), heuristicCall('SvcTest', 'Svc')],
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-cov-dup-'));
    const opened = await openGraph(join(dir, 'cov.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    st = opened.value;
    const imported = await importExtractionResults(st, [dupSeed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    dupCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: st } as Context;
  });

  afterAll(async () => {
    await closeGraph(st);
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists a doubly-edged covering test exactly once', async () => {
    const r = await apexTestCoverageHandler(dupCtx, { classApiName: 'Svc' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.target?.coveringTests).toEqual(['ApexClass:SvcTest']);
  });
});

describe('apexTestCoverageInputSchema', () => {
  it('accepts empty input and a classApiName', () => {
    expect(apexTestCoverageInputSchema.safeParse({}).success).toBe(true);
    expect(apexTestCoverageInputSchema.safeParse({ classApiName: 'X' }).success).toBe(true);
  });
  it('accepts the apexClass alias', () => {
    expect(apexTestCoverageInputSchema.safeParse({ apexClass: 'X' }).success).toBe(true);
  });
  it('rejects limit above 500', () => {
    expect(apexTestCoverageInputSchema.safeParse({ limit: 501 }).success).toBe(false);
  });
  it('accepts offset and cursor (CR-22)', () => {
    expect(
      apexTestCoverageInputSchema.safeParse({ offset: 1, cursor: 'abc' }).success,
    ).toBe(true);
  });
});
