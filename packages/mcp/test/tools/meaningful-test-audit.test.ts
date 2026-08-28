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

  it('refuses a well-formed classFilter id that matches no ApexClass in the vault (typo)', async () => {
    // MEANINGFUL-TEST-AUDIT-CLASSFILTER-SILENTLY-DROPS-UNRESOLVED: before the
    // fix, a well-formed but nonexistent id (e.g. a typo of a real test
    // class) was silently filtered out, returning `totalTestClassCount: 0`
    // with no distinguishable signal from "checked, found nothing wrong".
    // The handler must refuse — the caller's filter is unresolvable, not
    // legitimately empty.
    const r = await meaningfulTestAuditHandler(ctx, {
      classFilter: ['ApexClass:AccountServiceTets'],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain("'ApexClass:AccountServiceTets'");
    expect(r.error.path).toBe('classFilter');
  });

  it('refuses when only SOME classFilter ids are unresolved, citing just those', async () => {
    const r = await meaningfulTestAuditHandler(ctx, {
      classFilter: ['ApexClass:HighFakeTest', 'ApexClass:TotallyMadeUp'],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain("'ApexClass:TotallyMadeUp'");
    expect(r.error.message).not.toContain("'ApexClass:HighFakeTest'");
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
// MEANINGFUL-TEST-AUDIT-SILENTLY-IGNORES-TARGET — production-target mode.
// A caller who names a PRODUCTION class (via componentId/classApiName/targetId)
// used to have that id silently Zod-stripped and got the org-wide fake-assert
// leaderboard. Now the tool resolves the target's COVERING tests (inbound
// callsApex from isTest classes) and scores THOSE, echoing appliedScope.
// =============================================================================
describe('meaningfulTestAuditHandler — production-target / covering-tests mode', () => {
  const PROD = 'ApexClass:ProdBatch';
  const COVERING_TEST = 'ApexClass:ProdBatchTest';
  const UNRELATED_TEST = 'ApexClass:UnrelatedTest';
  const NON_TEST_CALLER = 'ApexClass:HelperCaller';
  const LONELY_PROD = 'ApexClass:LonelyProdClass';
  // A TEST class the apex scanner recorded as calling ITSELF. Real orgs carry
  // such self edges (a helper test class referencing its own static members).
  const SELF_REF_TEST = 'ApexClass:SelfRefTest';

  const targetSeed: ExtractionResult = {
    nodes: [
      makeNode({ id: PROD, apiName: 'ProdBatch', properties: { isTest: false } }),
      makeNode({ id: LONELY_PROD, apiName: 'LonelyProdClass', properties: { isTest: false } }),
      makeNode({
        id: COVERING_TEST,
        apiName: 'ProdBatchTest',
        properties: {
          isTest: true,
          assertionCount: 2,
          sourceBytes: 1000,
          qualityIssues: [{ rule: 'fake-assertion', location: 'line 7' }],
        },
      }),
      makeNode({
        id: UNRELATED_TEST,
        apiName: 'UnrelatedTest',
        properties: { isTest: true, assertionCount: 9, sourceBytes: 1000, qualityIssues: [] },
      }),
      // A NON-test class that also references the target — must NOT count as a
      // covering test.
      makeNode({ id: NON_TEST_CALLER, apiName: 'HelperCaller', properties: { isTest: false } }),
      makeNode({
        id: SELF_REF_TEST,
        apiName: 'SelfRefTest',
        properties: { isTest: true, assertionCount: 4, sourceBytes: 1000, qualityIssues: [] },
      }),
    ],
    edges: [
      {
        fromId: COVERING_TEST,
        toId: PROD,
        edgeType: 'callsApex',
        confidence: 'heuristic',
        source: 'apex-scanner',
        properties: {},
      },
      {
        fromId: NON_TEST_CALLER,
        toId: PROD,
        edgeType: 'callsApex',
        confidence: 'heuristic',
        source: 'apex-scanner',
        properties: {},
      },
      // The SELF edge: the class is recorded as calling itself.
      {
        fromId: SELF_REF_TEST,
        toId: SELF_REF_TEST,
        edgeType: 'callsApex',
        confidence: 'heuristic',
        source: 'apex-scanner',
        properties: {},
      },
      // A genuine, DIFFERENT covering test for the same target, so excluding
      // the self edge cannot be mistaken for excluding everything.
      {
        fromId: COVERING_TEST,
        toId: SELF_REF_TEST,
        edgeType: 'callsApex',
        confidence: 'heuristic',
        source: 'apex-scanner',
        properties: {},
      },
    ],
  };

  const withStore = async <T>(
    run: (ctx: Context) => Promise<T>,
  ): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-mta-target-'));
    const opened = await openGraph(join(dir, 'mta-target.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    const s = opened.value;
    const imp = await importExtractionResults(s, [targetSeed]);
    if (!imp.ok) throw new Error(imp.error.message);
    const localCtx: Context = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s };
    const out = await run(localCtx);
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });
    return out;
  };

  it('scores only the covering tests of the production target (componentId alias, not stripped)', async () => {
    // FAIL-before: componentId was Zod-stripped, so the tool ran org-wide and
    // returned BOTH ProdBatchTest AND UnrelatedTest. PASS-after: only the
    // covering test is scored, and appliedScope echoes covering-tests mode.
    const r = await withStore((localCtx) =>
      meaningfulTestAuditHandler(
        localCtx,
        meaningfulTestAuditInputSchema.parse({ componentId: PROD }),
      ),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.tests.map((t) => t.testClassId);
    expect(ids).toEqual([COVERING_TEST]);
    expect(ids).not.toContain(UNRELATED_TEST);
    // A non-test caller of the target is never counted as a covering test.
    expect(ids).not.toContain(NON_TEST_CALLER);
    // The covering test's fake-assert metrics are surfaced.
    expect(r.value.data.tests[0]?.fakeAssertionCount).toBe(1);
    expect(r.value.data.appliedScope).toEqual({
      mode: 'covering-tests',
      targetClassId: PROD,
      coveringTestCount: 1,
    });
  });

  it('accepts a bare production class name (classApiName alias) and coerces the id', async () => {
    const r = await withStore((localCtx) =>
      meaningfulTestAuditHandler(
        localCtx,
        meaningfulTestAuditInputSchema.parse({ classApiName: 'ProdBatch' }),
      ),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.tests.map((t) => t.testClassId)).toEqual([COVERING_TEST]);
    expect(r.value.data.appliedScope).toEqual({
      mode: 'covering-tests',
      targetClassId: PROD,
      coveringTestCount: 1,
    });
  });

  it('returns an honest empty list (NOT the org-wide dump) when the target has no covering tests', async () => {
    const r = await withStore((localCtx) =>
      meaningfulTestAuditHandler(localCtx, { targetClass: LONELY_PROD }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.tests).toEqual([]);
    expect(r.value.data.totalTestClassCount).toBe(0);
    expect(r.value.data.appliedScope).toEqual({
      mode: 'covering-tests',
      targetClassId: LONELY_PROD,
      coveringTestCount: 0,
    });
  });

  it('returns component-not-found for a target class absent from the vault', async () => {
    const r = await withStore((localCtx) =>
      meaningfulTestAuditHandler(localCtx, {
        targetClass: 'ApexClass:NoSuchClass',
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    expect(r.error.path).toBe('targetClass');
  });

  it('never counts the target as its OWN covering test (self callsApex edge)', async () => {
    // MEANINGFUL-TEST-AUDIT-TARGET-COVERS-ITSELF: the inbound `callsApex` walk
    // deduped by fromId but never excluded `fromId === targetId`, so a class
    // the scanner recorded as calling itself was reported as one of its own
    // covering tests — and `coveringTestCount` CERTIFIED that number. A class
    // cannot cover itself; the self edge must be dropped, leaving only the
    // genuine coverer.
    const r = await withStore((localCtx) =>
      meaningfulTestAuditHandler(localCtx, { targetClass: SELF_REF_TEST }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.tests.map((t) => t.testClassId);
    expect(ids).not.toContain(SELF_REF_TEST);
    expect(ids).toEqual([COVERING_TEST]);
    expect(r.value.data.totalTestClassCount).toBe(1);
    const scope = r.value.data.appliedScope;
    expect(scope.mode).toBe('covering-tests');
    if (scope.mode !== 'covering-tests') return;
    expect(scope.coveringTestCount).toBe(1);
  });

  it('refuses targetClass + classFilter together (ambiguous scope)', async () => {
    const r = await withStore((localCtx) =>
      meaningfulTestAuditHandler(localCtx, {
        targetClass: PROD,
        classFilter: [COVERING_TEST],
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.path).toBe('targetClass');
  });
});

// =============================================================================
// MEANINGFUL-TEST-AUDIT-NAMECONTAINS-SILENT-ORGWIDE — a case-insensitive
// `nameContains` substring on the test-class api name used to be Zod-stripped,
// so a scoped call returned the full org-wide leaderboard. It now narrows the
// scan, echoes `appliedScope: { mode: 'name-filter' }`, and a needle matching
// nothing returns an HONEST empty list (never the full roster).
// =============================================================================
describe('meaningfulTestAuditHandler — nameContains scope', () => {
  it('narrows to the test classes whose name contains the needle + echoes appliedScope', async () => {
    const r = await meaningfulTestAuditHandler(ctx, { nameContains: 'Fake' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.tests.map((t) => t.testClassId).sort();
    // Only HighFakeTest + OneFakeTest carry "Fake" in the name — NOT the full
    // 5-class org-wide roster.
    expect(ids).toEqual(['ApexClass:HighFakeTest', 'ApexClass:OneFakeTest']);
    expect(r.value.data.totalTestClassCount).toBe(2);
    expect(r.value.data.appliedScope).toEqual({
      mode: 'name-filter',
      nameContains: 'Fake',
    });
  });

  it('matches the name substring case-insensitively', async () => {
    const r = await meaningfulTestAuditHandler(ctx, { nameContains: 'clean' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.tests.map((t) => t.testClassId).sort();
    expect(ids).toEqual([
      'ApexClass:CleanDenseTest',
      'ApexClass:CleanSparseTest',
    ]);
  });

  it('returns an HONEST empty list (NOT the org-wide dump) when the needle matches nothing', async () => {
    const r = await meaningfulTestAuditHandler(ctx, {
      nameContains: 'Zzz_NoSuchTestName',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.tests).toEqual([]);
    expect(r.value.data.totalTestClassCount).toBe(0);
    expect(r.value.data.appliedScope).toEqual({
      mode: 'name-filter',
      nameContains: 'Zzz_NoSuchTestName',
    });
  });

  it('refuses nameContains + classFilter together (ambiguous scope)', async () => {
    const r = await meaningfulTestAuditHandler(ctx, {
      nameContains: 'Fake',
      classFilter: ['ApexClass:HighFakeTest'],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.path).toBe('nameContains');
  });

  it('refuses nameContains + targetClass together (ambiguous scope)', async () => {
    const r = await meaningfulTestAuditHandler(ctx, {
      nameContains: 'Fake',
      targetClass: 'ApexClass:SomeProdClass',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.path).toBe('nameContains');
  });

  it('bare call is unaffected by the nameContains addition (byte-identical org-wide)', async () => {
    const r = await meaningfulTestAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.appliedScope).toEqual({ mode: 'org-wide' });
    expect(r.value.data.totalTestClassCount).toBe(5);
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

  it('preserves the disclosure field and the stable top-level shape (output-shape)', async () => {
    const r = await meaningfulTestAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(typeof r.value.data.disclosure).toBe('string');
    // `appliedScope` is the one deliberate addition (target-scope honesty);
    // it is always present so the target is never silently ignored.
    expect(Object.keys(r.value.data).sort()).toEqual(
      ['appliedScope', 'disclosure', 'tests', 'totalTestClassCount'].sort(),
    );
    expect(r.value.data.appliedScope).toEqual({ mode: 'org-wide' });
  });
});

describe('meaningfulTestAuditHandler — R6 full-scan residual-cap disclosure (scanAllNodesOfTypes adoption)', () => {
  // MEANINGFUL-TEST-AUDIT-LOADALLNODES-NO-RESIDUAL-CAP: the hand-rolled
  // `loadAllNodes` had NO ceiling and no `scanIncomplete` typed state at all —
  // a pathological ApexClass count walked unbounded with no way to disclose
  // an incomplete scan. `SFI_MEANINGFUL_TEST_SCAN_MAX` only exists after
  // adopting `scanAllNodesOfTypes`; under the old code this env var was never
  // read, so the walk always ran to completion (`totalTestClassCount: 5`,
  // no truncation note) regardless of its value.
  beforeEach(() => {
    process.env['SFI_NODE_SCAN_LIMIT'] = '1';
    process.env['SFI_MEANINGFUL_TEST_SCAN_MAX'] = '3';
  });

  afterEach(() => {
    delete process.env['SFI_NODE_SCAN_LIMIT'];
    delete process.env['SFI_MEANINGFUL_TEST_SCAN_MAX'];
  });

  it('discloses an incomplete scan and under-reports the count rather than walking unbounded silently', async () => {
    const r = await meaningfulTestAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Ceiling of 3 stops the walk after the first 3 (of 6) ApexClass nodes —
    // fewer than the full 5 test classes — and the disclosure must say so.
    expect(r.value.data.totalTestClassCount).toBeLessThan(5);
    expect(r.value.data.disclosure).toMatch(/Full scan capped at 3 nodes per type/);
    expect(r.value.data.disclosure).toMatch(/scanTruncated/);
    // TYPED, not just prose: a machine consumer reading `totalTestClassCount`
    // must be able to see that the number is a floor without parsing English.
    expect(r.value.data.scanTruncated).toBe(true);
  });

  it('carries the incomplete scan in a TYPED field, not only in the prose disclosure', async () => {
    const r = await meaningfulTestAuditHandler(ctx, { nameContains: 'test' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // A name-filtered answer over a capped walk can be a FALSE ZERO / undercount.
    expect(r.value.data.scanTruncated).toBe(true);
  });

  it('resolves a classFilter id that sorts PAST the residual scan ceiling', async () => {
    // MEANINGFUL-TEST-AUDIT-CLASSFILTER-REFUSES-PAST-CAP: the unresolved-id
    // refusal must NOT be decided by membership in the org-wide walk, because
    // that walk is capped. Fixture ids sort ASC as CleanDenseTest,
    // CleanSparseTest, HighFakeTest, LegacyTest, NotATest, OneFakeTest — so
    // with a ceiling of 3, OneFakeTest is past the cap yet unquestionably
    // EXISTS. Refusing it as "does not match any ApexClass in this vault" is a
    // confident falsehood that also prescribes /sfi-refresh, a remedy that can
    // never help. The filter must resolve ids by direct id lookup instead.
    const r = await meaningfulTestAuditHandler(ctx, {
      classFilter: ['ApexClass:OneFakeTest'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalTestClassCount).toBe(1);
    expect(r.value.data.tests[0]?.testClassId).toBe('ApexClass:OneFakeTest');
    expect(r.value.data.tests[0]?.fakeAssertionCount).toBe(1);
  });

  it('still refuses a genuinely nonexistent classFilter id while the scan is capped', async () => {
    // Control for the case above: making the check ceiling-independent must
    // not neuter the R1 refusal. A typo still has no row at all.
    const r = await meaningfulTestAuditHandler(ctx, {
      classFilter: ['ApexClass:OneFakeTets'],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain("'ApexClass:OneFakeTets'");
    expect(r.error.path).toBe('classFilter');
  });

  it('does not stamp a truncation note on a class-filter answer resolved by id', async () => {
    // The class-filter answer is resolved id-by-id, so it is COMPLETE even
    // while the org-wide walk would truncate — disclosing scanTruncated here
    // would be over-disclosure about a scan this branch never performed.
    const r = await meaningfulTestAuditHandler(ctx, {
      classFilter: ['ApexClass:HighFakeTest', 'ApexClass:OneFakeTest'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalTestClassCount).toBe(2);
    expect(r.value.data.disclosure).not.toMatch(/Full scan capped/);
    expect('scanTruncated' in r.value.data).toBe(false);
  });

  it('stays silent about capping when the ceiling comfortably exceeds the corpus', async () => {
    process.env['SFI_MEANINGFUL_TEST_SCAN_MAX'] = '1000';
    const r = await meaningfulTestAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalTestClassCount).toBe(5);
    expect(r.value.data.disclosure).not.toMatch(/Full scan capped/);
    // Control: no over-disclosure. The key is absent, not `false`, so an org
    // under the ceiling keeps the byte-identical pre-knob shape.
    expect('scanTruncated' in r.value.data).toBe(false);
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

  it('merges the componentId alias into targetClass (no longer silently stripped)', () => {
    const parsed = meaningfulTestAuditInputSchema.safeParse({
      componentId: 'ApexClass:SomeProdBatch',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.targetClass).toBe('ApexClass:SomeProdBatch');
  });

  it('merges classApiName / targetId / apexClass aliases into targetClass', () => {
    for (const key of ['classApiName', 'targetId', 'targetClassId', 'apexClass']) {
      const parsed = meaningfulTestAuditInputSchema.safeParse({ [key]: 'SomeProdClass' });
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      expect(parsed.data.targetClass).toBe('SomeProdClass');
    }
  });

  it('accepts nameContains and keeps it distinct from targetClass (not merged)', () => {
    const parsed = meaningfulTestAuditInputSchema.safeParse({ nameContains: 'Course' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.nameContains).toBe('Course');
    expect(parsed.data.targetClass).toBeUndefined();
  });

  it('rejects an empty-string nameContains', () => {
    expect(
      meaningfulTestAuditInputSchema.safeParse({ nameContains: '' }).success,
    ).toBe(false);
  });
});

// =============================================================================
// FIX 14 — the resume knob, added BEFORE it is needed.
//
// Two properties, and they pull against each other on purpose:
//   1. COSTS NOTHING TODAY — a corpus that fits emits no paging fields at all,
//      so the response is byte-identical to the pre-paging shape.
//   2. THE TAIL IS REACHABLE — over the byte budget the handler makes the cut,
//      says so, and hands back a cursor that walks to the end.
// =============================================================================

const PAGED_TEST_CLASS_COUNT = 600;

/** Invented names, long enough that 600 rows blow past the 34 KB page budget. */
const pagedTestClassName = (i: number): string =>
  `Widget_Ledger_Reconciliation_Service_Test_${String(i).padStart(4, '0')}`;

const pagedSeed: ExtractionResult = {
  nodes: Array.from({ length: PAGED_TEST_CLASS_COUNT }, (_, i) =>
    makeNode({
      id: `ApexClass:${pagedTestClassName(i)}`,
      apiName: pagedTestClassName(i),
      properties: {
        isTest: true,
        // Identical scores across every row, so `compareEntries`' final
        // `testClassId` tiebreak is the ONLY thing making the order total —
        // exactly the condition under which a weak comparator dups/skips.
        assertionCount: 4,
        sourceBytes: 2000,
        qualityIssues: [{ rule: 'fake-assertion', location: 'line 7' }],
      },
    }),
  ),
  edges: [],
};

describe('meaningfulTestAuditHandler — FIX 14 resume knob', () => {
  let pageDir: string;
  let pageStore: GraphStore;
  let pageCtx: Context;

  beforeAll(async () => {
    pageDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-mta-page-'));
    const opened = await openGraph(join(pageDir, 'mta-page.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    pageStore = opened.value;
    const imp = await importExtractionResults(pageStore, [pagedSeed]);
    if (!imp.ok) throw new Error(imp.error.message);
    pageCtx = { vaultRoot: pageDir, manifest: FIXTURE_MANIFEST, graph: pageStore };
  });

  afterAll(async () => {
    await closeGraph(pageStore);
    rmSync(pageDir, { recursive: true, force: true });
  });

  it('COSTS NOTHING: a corpus that fits emits NO paging fields (byte-identical)', async () => {
    const r = await meaningfulTestAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.value.data).sort()).toEqual(
      ['appliedScope', 'disclosure', 'tests', 'totalTestClassCount'].sort(),
    );
    expect(r.value.data.tests).toHaveLength(5);
    expect(r.value.data.disclosure).not.toMatch(/nextCursor/);
  });

  it('FAIL-BEFORE/PASS-AFTER: a 600-class corpus is CUT, says so, and keeps the full count', async () => {
    const r = await meaningfulTestAuditHandler(pageCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // Pre-fix there was no cut at all: `tests.length === 600 === totalTestClass
    // Count`, and the over-budget payload was trimmed downstream with the
    // response still claiming to hold the whole ranking.
    expect(d.tests.length).toBeLessThan(PAGED_TEST_CLASS_COUNT);
    expect(d.truncated).toBe(true);
    expect(d.nextCursor).toBeDefined();
    // `totalTestClassCount` is the FULL count, never the page length.
    expect(d.totalTestClassCount).toBe(PAGED_TEST_CLASS_COUNT);
    expect(d.disclosure).toContain(
      `Showing ${d.tests.length} of ${PAGED_TEST_CLASS_COUNT} test classes. totalTestClassCount is the FULL count; advance with the returned nextCursor.`,
    );
  });

  it('ROUND TRIP: the cursor walks to the tail with no dups and no gaps', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let total = -1;
    for (;;) {
      const r = await meaningfulTestAuditHandler(
        pageCtx,
        cursor === undefined ? {} : { cursor },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.value.data;
      pages += 1;
      total = d.totalTestClassCount;
      for (const t of d.tests) seen.push(t.testClassId);
      if (d.truncated !== true) break;
      expect(d.nextCursor).toBeDefined();
      cursor = d.nextCursor;
      expect(pages).toBeLessThan(50);
    }
    expect(total).toBe(PAGED_TEST_CLASS_COUNT);
    expect(pages).toBeGreaterThan(1);
    expect(new Set(seen).size).toBe(total);
    expect(seen).toHaveLength(total);
  });

  it('an explicit offset resumes without re-listing the head', async () => {
    const first = await meaningfulTestAuditHandler(pageCtx, { limit: 10 });
    const second = await meaningfulTestAuditHandler(pageCtx, { limit: 10, offset: 10 });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.data.tests).toHaveLength(10);
    expect(second.value.data.tests).toHaveLength(10);
    expect(first.value.data.offset).toBe(0);
    expect(second.value.data.offset).toBe(10);
    const firstIds = new Set(first.value.data.tests.map((t) => t.testClassId));
    for (const t of second.value.data.tests) {
      expect(firstIds.has(t.testClassId)).toBe(false);
    }
  });

  it('the final page reports truncated:false and emits no cursor', async () => {
    const tail = await meaningfulTestAuditHandler(pageCtx, {
      limit: 5,
      offset: PAGED_TEST_CLASS_COUNT - 3,
    });
    expect(tail.ok).toBe(true);
    if (!tail.ok) return;
    expect(tail.value.data.tests).toHaveLength(3);
    expect(tail.value.data.truncated).toBe(false);
    expect(tail.value.data.nextCursor).toBeUndefined();
    expect(tail.value.data.totalTestClassCount).toBe(PAGED_TEST_CLASS_COUNT);
  });

  it('the ranking is a TOTAL order, so equal-score rows still page deterministically', async () => {
    const a = await meaningfulTestAuditHandler(pageCtx, { limit: 20 });
    const b = await meaningfulTestAuditHandler(pageCtx, { limit: 20 });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.data.tests.map((t) => t.testClassId)).toEqual(
      b.value.data.tests.map((t) => t.testClassId),
    );
    // Every score is identical in this fixture, so the order IS the tiebreak.
    expect(a.value.data.tests.map((t) => t.testClassId)).toEqual(
      [...a.value.data.tests.map((t) => t.testClassId)].sort(),
    );
  });
});
