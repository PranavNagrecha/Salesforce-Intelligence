/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
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

import type { Context } from '../../src/server.js';
import {
  meaningfulTestAuditHandler,
  meaningfulTestAuditInputSchema,
} from '../../src/tools/meaningful-test-audit.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-28T09:12:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-mta',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'ApexClass',
  apiName: 'Anon',
  label: null,
  parentId: null,
  sourcePath: 'unused.cls',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const seed: ExtractionResult = {
  nodes: [
    // High-fake test class — 3 fake assertions.
    makeNode({
      id: 'ApexClass:HighFakeTest',
      apiName: 'HighFakeTest',
      properties: {
        isTest: true,
        assertionCount: 10,
        sourceBytes: 2000,
        qualityIssues: [
          { rule: 'fake-assertion', location: 'line 4' },
          { rule: 'fake-assertion', location: 'line 8' },
          { rule: 'fake-assertion', location: 'line 12' },
        ],
      },
    }),
    // Single-fake test class.
    makeNode({
      id: 'ApexClass:OneFakeTest',
      apiName: 'OneFakeTest',
      properties: {
        isTest: true,
        assertionCount: 5,
        sourceBytes: 1000,
        qualityIssues: [{ rule: 'fake-assertion', location: 'line 10' }],
      },
    }),
    // Clean test class with high density.
    makeNode({
      id: 'ApexClass:CleanDenseTest',
      apiName: 'CleanDenseTest',
      properties: {
        isTest: true,
        assertionCount: 20,
        sourceBytes: 1000,
        qualityIssues: [],
      },
    }),
    // Clean test class with sparse asserts (low density).
    makeNode({
      id: 'ApexClass:CleanSparseTest',
      apiName: 'CleanSparseTest',
      properties: {
        isTest: true,
        assertionCount: 1,
        sourceBytes: 5000,
        qualityIssues: [],
      },
    }),
    // Test class without v2.1 R2 fields (no assertionCount, no qualityIssues).
    makeNode({
      id: 'ApexClass:LegacyTest',
      apiName: 'LegacyTest',
      properties: { isTest: true },
    }),
    // Non-test class — excluded.
    makeNode({
      id: 'ApexClass:NotATest',
      apiName: 'NotATest',
      properties: { isTest: false, assertionCount: 100 },
    }),
  ],
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-mta-'));
  const opened = await openGraph(join(tempDir, 'mta.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('meaningfulTestAuditHandler', () => {
  it('lists every test class but excludes non-test classes', async () => {
    const r = await meaningfulTestAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.tests.map((t) => t.testClassId);
    expect(ids).toContain('ApexClass:HighFakeTest');
    expect(ids).toContain('ApexClass:CleanDenseTest');
    expect(ids).toContain('ApexClass:LegacyTest');
    expect(ids).not.toContain('ApexClass:NotATest');
    expect(r.value.data.totalTestClassCount).toBe(5);
  });

  it('ranks the HighFakeTest at the top by fakeAssertionCount DESC', async () => {
    const r = await meaningfulTestAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.tests[0]?.testClassId).toBe('ApexClass:HighFakeTest');
    expect(r.value.data.tests[0]?.fakeAssertionCount).toBe(3);
  });

  it('computes density from assertionCount per KB of sourceBytes', async () => {
    const r = await meaningfulTestAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dense = r.value.data.tests.find(
      (t) => t.testClassId === 'ApexClass:CleanDenseTest',
    );
    // 20 asserts / 1KB = 20.
    expect(dense?.density).toBe(20);
    const sparse = r.value.data.tests.find(
      (t) => t.testClassId === 'ApexClass:CleanSparseTest',
    );
    // 1 assert / 5KB = 0.2.
    expect(sparse?.density).toBeCloseTo(0.2, 5);
  });

  it('captures the verbatim fake-assertion locations for triage', async () => {
    const r = await meaningfulTestAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const high = r.value.data.tests.find(
      (t) => t.testClassId === 'ApexClass:HighFakeTest',
    );
    expect(high?.fakeAssertionLocations.length).toBe(3);
    expect(high?.fakeAssertionLocations).toContain('line 4');
    expect(high?.fakeAssertionLocations).toContain('line 8');
  });

  it('returns fakeAssertionCount: 0 for tests without qualityIssues', async () => {
    const r = await meaningfulTestAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const legacy = r.value.data.tests.find(
      (t) => t.testClassId === 'ApexClass:LegacyTest',
    );
    expect(legacy?.fakeAssertionCount).toBe(0);
    expect(legacy?.assertionCount).toBe(0);
  });

  it('surfaces the verbatim disclosure', async () => {
    const r = await meaningfulTestAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disclosure).toMatch(/System\.assert/);
    expect(r.value.data.disclosure).toMatch(/helper methods/);
  });

  it('honors classFilter to scope the scan', async () => {
    const r = await meaningfulTestAuditHandler(ctx, {
      classFilter: ['ApexClass:HighFakeTest'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.tests.length).toBe(1);
    expect(r.value.data.tests[0]?.testClassId).toBe('ApexClass:HighFakeTest');
  });

  it('returns empty list when classFilter contains only non-test ids', async () => {
    const r = await meaningfulTestAuditHandler(ctx, {
      classFilter: ['ApexClass:NotATest'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.tests.length).toBe(0);
  });

  it('refuses an empty classFilter array with invalid-query', async () => {
    // Regression for journal 0160: the empty-array case is ambiguous
    // ("no filter" vs "filter to nothing"). Supersedes the journal
    // 0158 "by-design" deferral — the deep smoke of a second org
    // re-flagged the same pattern in `sfi.test_coverage_gaps`, so for
    // consistency across the v2.x test-quality tier both tools now
    // refuse and ask the caller to omit the field or supply at least
    // one id.
    const r = await meaningfulTestAuditHandler(ctx, { classFilter: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toMatch(/classFilter is an empty array/);
    expect(r.error.path).toBe('classFilter');
  });

  it('refuses classFilter ids that do not carry the ApexClass: prefix', async () => {
    const r = await meaningfulTestAuditHandler(ctx, {
      classFilter: ['CustomObject:NotAClass'],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toMatch(/ApexClass:/);
    expect(r.error.message).toContain("'CustomObject:NotAClass'");
  });

  it('cites every malformed classFilter id in the refusal message', async () => {
    const r = await meaningfulTestAuditHandler(ctx, {
      classFilter: [
        'ApexClass:ValidName',
        'CustomObject:Bad1',
        'Flow:Bad2',
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain("'CustomObject:Bad1'");
    expect(r.error.message).toContain("'Flow:Bad2'");
  });

  it('secondary sort: lower density surfaces higher among same fake count', async () => {
    const r = await meaningfulTestAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Two zero-fake entries (CleanDenseTest, CleanSparseTest, LegacyTest).
    // Sparse has density 0.2; Legacy 0; Dense 20. So order should be
    // Legacy (0) < Sparse (0.2) < Dense (20).
    const zeroFakes = r.value.data.tests.filter(
      (t) => t.fakeAssertionCount === 0,
    );
    const ids = zeroFakes.map((t) => t.testClassId);
    expect(ids.indexOf('ApexClass:LegacyTest')).toBeLessThan(
      ids.indexOf('ApexClass:CleanSparseTest'),
    );
    expect(ids.indexOf('ApexClass:CleanSparseTest')).toBeLessThan(
      ids.indexOf('ApexClass:CleanDenseTest'),
    );
  });
});

// =============================================================================
// CR-12 — page-to-exhaustion. The ApexClass roster is walked to the end, not
// just the first page; a test class sorted PAST the cap by id ASC used to be
// dropped from both the ranking and totalTestClassCount. With
// SFI_NODE_SCAN_LIMIT=2 the loop walks multiple pages. Mirrors
// apex-test-coverage.test.ts past-cap pattern.
// =============================================================================
describe('meaningfulTestAuditHandler — past-cap roster (CR-12 de-cap)', () => {
  beforeEach(() => {
    process.env['SFI_NODE_SCAN_LIMIT'] = '2';
  });

  afterEach(() => {
    delete process.env['SFI_NODE_SCAN_LIMIT'];
  });

  it('includes a test class sorted PAST the cap and counts the FULL corpus', async () => {
    // id-ASC test classes: CleanDenseTest, CleanSparseTest, HighFakeTest,
    // LegacyTest, OneFakeTest. With a cap of 2 the single-page code saw only
    // the first 2, dropping HighFakeTest (the genuinely-worst class) AND
    // undercounting totalTestClassCount.
    const r = await meaningfulTestAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.tests.map((t) => t.testClassId);
    expect(ids).toContain('ApexClass:HighFakeTest');
    expect(ids).toContain('ApexClass:OneFakeTest');
    // 5 test classes (NotATest is excluded) — the full count, not the capped 2.
    expect(r.value.data.totalTestClassCount).toBe(5);
    // The past-cap worst class still ranks at the top by fakeAssertionCount.
    expect(r.value.data.tests[0]?.testClassId).toBe('ApexClass:HighFakeTest');
  });

  it('preserves the disclosure field and adds no new top-level field (output-shape)', async () => {
    const r = await meaningfulTestAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(typeof r.value.data.disclosure).toBe('string');
    expect(Object.keys(r.value.data).sort()).toEqual(
      ['disclosure', 'tests', 'totalTestClassCount'].sort(),
    );
  });
});

describe('meaningfulTestAuditInputSchema', () => {
  it('accepts empty input', () => {
    expect(meaningfulTestAuditInputSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a non-empty classFilter array', () => {
    expect(
      meaningfulTestAuditInputSchema.safeParse({
        classFilter: ['ApexClass:X'],
      }).success,
    ).toBe(true);
  });

  it('rejects classFilter above maxItems (500)', () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => `ApexClass:X${i}`);
    expect(
      meaningfulTestAuditInputSchema.safeParse({ classFilter: tooMany }).success,
    ).toBe(false);
  });

  it('rejects empty string entries in classFilter', () => {
    expect(
      meaningfulTestAuditInputSchema.safeParse({ classFilter: [''] }).success,
    ).toBe(false);
  });
});
