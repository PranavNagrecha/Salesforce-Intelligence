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
  findHardcodedValuesHandler,
  findHardcodedValuesInputSchema,
} from '../../src/tools/find-hardcoded-values.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-fhv',
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
    // Production class with one hardcoded id + one unrelated rule.
    makeNode({
      id: 'ApexClass:AccountSvc',
      apiName: 'AccountSvc',
      properties: {
        isTest: false,
        qualityIssues: [
          {
            rule: 'hardcoded-id',
            severity: 'medium',
            location: 'line 12',
            explanation: "Hardcoded Salesforce ID literal '0015g000001abcde'",
            confidence: 'heuristic',
          },
          {
            rule: 'missing-fls-check',
            severity: 'high',
            location: 'line 8',
            explanation: 'unrelated rule',
            confidence: 'heuristic',
          },
        ],
      },
    }),
    // Test class with hardcoded id (refusal-pattern axis).
    makeNode({
      id: 'ApexClass:AccountSvcTest',
      apiName: 'AccountSvcTest',
      properties: {
        isTest: true,
        qualityIssues: [
          {
            rule: 'hardcoded-id',
            severity: 'medium',
            location: 'line 5',
            explanation: "Hardcoded Salesforce ID literal '0030xxxxxxxxxxx'",
            confidence: 'heuristic',
          },
          {
            rule: 'hardcoded-sandbox-test-data',
            severity: 'medium',
            location: 'line 9',
            explanation: 'Hardcoded sandbox literal in test class',
            confidence: 'heuristic',
          },
        ],
      },
    }),
    // Class with hardcoded email + hardcoded username.
    makeNode({
      id: 'ApexClass:EmailSvc',
      apiName: 'EmailSvc',
      properties: {
        isTest: false,
        qualityIssues: [
          {
            rule: 'hardcoded-email',
            severity: 'low',
            location: 'line 3',
            explanation: "Hardcoded email 'admin@example.com'",
            confidence: 'heuristic',
          },
          {
            rule: 'hardcoded-username',
            severity: 'medium',
            location: 'line 6',
            explanation: "Hardcoded Salesforce username 'admin@org.example.com.sandbox'",
            confidence: 'heuristic',
          },
        ],
      },
    }),
    // Clean class (no qualityIssues data).
    makeNode({
      id: 'ApexClass:CleanCls',
      apiName: 'CleanCls',
      properties: { qualityIssues: [] },
    }),
  ],
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-fhv-'));
  const opened = await openGraph(join(tempDir, 'fhv.db'));
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

describe('findHardcodedValuesHandler', () => {
  it('returns every hardcoded-literal finding across nodes when no category is supplied', async () => {
    const r = await findHardcodedValuesHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 2 hardcoded-id (AccountSvc + AccountSvcTest)
    // + 1 hardcoded-email + 1 hardcoded-username + 1 hardcoded-sandbox = 5
    expect(r.value.data.totalCount).toBe(5);
    expect(r.value.data.byCategory.id).toBe(2);
    expect(r.value.data.byCategory.email).toBe(1);
    expect(r.value.data.byCategory.username).toBe(1);
    expect(r.value.data.byCategory['sandbox-data']).toBe(1);
  });

  it('narrows by category = "id"', async () => {
    const r = await findHardcodedValuesHandler(ctx, { category: 'id' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(2);
    for (const m of r.value.data.matches) {
      expect(m.rule).toBe('hardcoded-id');
    }
  });

  it('narrows by category = "email"', async () => {
    const r = await findHardcodedValuesHandler(ctx, { category: 'email' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(1);
    expect(r.value.data.matches[0]?.rule).toBe('hardcoded-email');
  });

  it('narrows by category = "sandbox-data"', async () => {
    const r = await findHardcodedValuesHandler(ctx, {
      category: 'sandbox-data',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(1);
    expect(r.value.data.matches[0]?.rule).toBe('hardcoded-sandbox-test-data');
  });

  it('surfaces the refusal-pattern test-class disclosure when a finding is in a test class', async () => {
    const r = await findHardcodedValuesHandler(ctx, { category: 'id' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).toMatch(/@isTest|test class|test fixtures/i);
  });

  it('marks inTestClass=true on findings from test classes only', async () => {
    const r = await findHardcodedValuesHandler(ctx, { category: 'id' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const test = r.value.data.matches.find(
      (m) => m.componentId === 'ApexClass:AccountSvcTest',
    );
    const prod = r.value.data.matches.find(
      (m) => m.componentId === 'ApexClass:AccountSvc',
    );
    expect(test?.inTestClass).toBe(true);
    expect(prod?.inTestClass).toBe(false);
  });

  it('omits the test-class refusal-pattern boundary when no findings are in a test class', async () => {
    const r = await findHardcodedValuesHandler(ctx, { category: 'email' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(1);
    // The single match is in EmailSvc (isTest: false), so the refusal-
    // pattern disclosure must NOT be surfaced.
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).not.toMatch(/@isTest|test fixtures/i);
  });

  it('sorts matches by componentId ASC then location ASC then rule ASC', async () => {
    const r = await findHardcodedValuesHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.matches.map((m) => m.componentId);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it('truncates matches to limit and flips truncated=true', async () => {
    const r = await findHardcodedValuesHandler(ctx, { limit: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.matches.length).toBe(2);
    expect(r.value.data.totalCount).toBe(5);
    expect(r.value.data.truncated).toBe(true);
  });

  it('a zero-match scan over a SCANNED-clean node says what it read and how', async () => {
    // Build a transient ctx whose node WAS scanned and came back clean —
    // `qualityIssues: []` present, empty. A node with no `qualityIssues` KEY
    // was never scanned and is covered by the next test.
    const localDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-fhv-empty-'));
    const opened = await openGraph(join(localDir, 'empty.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const localStore = opened.value;
    const imp = await importExtractionResults(localStore, [
      {
        nodes: [
          makeNode({
            id: 'ApexClass:JustClean',
            apiName: 'JustClean',
            properties: { isTest: false, qualityIssues: [] },
          }),
        ],
        edges: [],
      },
    ]);
    expect(imp.ok).toBe(true);
    if (!imp.ok) return;
    const localCtx: Context = {
      vaultRoot: localDir,
      manifest: FIXTURE_MANIFEST,
      graph: localStore,
    };
    const r = await findHardcodedValuesHandler(localCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.matches.length).toBe(0);
    // INVARIANT GUARDED: a scanned-and-clean node must NOT be told to re-run
    // `sfi refresh` — the NOT-SCANNED note is for a missing `qualityIssues` KEY.
    //
    // MOVED (FIX 6): was `boundaries.length === 0` +
    // `qualityScanCoverage === undefined`. "No hardcoded values here" and
    // "nothing here was ever scanned" returned the identical empty payload;
    // the heuristic disclosure and the census now ride on both.
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).toMatch(/heuristic/i);
    expect(joined).not.toContain('NOT SCANNED IN THIS VAULT');
    expect(r.value.data.qualityScanCoverage).toEqual([
      { type: 'ApexClass', nodes: 1, scanned: 1 },
    ]);
    await closeGraph(localStore);
    rmSync(localDir, { recursive: true, force: true });
  });

  it('QUALITY-SCAN-SKIPS-TRIGGERS-AND-FLOWS: an UNSCANNED trigger is "not checked", not clean', async () => {
    // The false-clean shape: `SCANNED_TYPES` includes ApexTrigger, but the
    // recognizers ran from the ApexClass extractor only, so a vault built
    // before the trigger extractor was wired returned `matches: []`,
    // `boundaries: []` for every trigger — byte-identical to a clean one.
    const localDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-fhv-unscanned-'));
    const opened = await openGraph(join(localDir, 'unscanned.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const localStore = opened.value;
    const imp = await importExtractionResults(localStore, [
      {
        nodes: [
          // Scanned + clean.
          makeNode({
            id: 'ApexClass:ScannedClean',
            apiName: 'ScannedClean',
            properties: { isTest: false, qualityIssues: [] },
          }),
          // Never scanned: no `qualityIssues` KEY at all.
          makeNode({
            id: 'ApexTrigger:NeverScanned',
            type: 'ApexTrigger',
            apiName: 'NeverScanned',
            sourcePath: 'unused.trigger',
            properties: {},
          }),
        ],
        edges: [],
      },
    ]);
    expect(imp.ok).toBe(true);
    if (!imp.ok) return;
    const localCtx: Context = {
      vaultRoot: localDir,
      manifest: FIXTURE_MANIFEST,
      graph: localStore,
    };
    const r = await findHardcodedValuesHandler(localCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.matches.length).toBe(0);
    expect(r.value.data.qualityScanCoverage).toEqual([
      { type: 'ApexClass', nodes: 1, scanned: 1 },
      { type: 'ApexTrigger', nodes: 1, scanned: 0 },
    ]);
    expect(r.value.data.boundaries.join(' ')).toContain('NOT SCANNED IN THIS VAULT');

    // ...and the note follows the SCOPE: a call scoped to the scanned class
    // alone has no gap to report and stays byte-identical.
    const scoped = await findHardcodedValuesHandler(localCtx, {
      componentId: 'ApexClass:ScannedClean',
    });
    expect(scoped.ok).toBe(true);
    if (!scoped.ok) return;
    // INVARIANT GUARDED: the NOT-SCANNED note follows the SCOPE — a call scoped
    // to the scanned class alone has no gap to report.
    //
    // MOVED (FIX 6): was `qualityScanCoverage === undefined` +
    // `boundaries.length === 0`. The scoped census now states `ApexClass 1/1`
    // so the scoped clean answer proves the class was read, and the scanner
    // disclosure rides along; only the NOT-SCANNED note is scope-dependent.
    expect(scoped.value.data.qualityScanCoverage).toEqual([
      { type: 'ApexClass', nodes: 1, scanned: 1 },
    ]);
    expect(scoped.value.data.boundaries.join(' ')).not.toContain(
      'NOT SCANNED IN THIS VAULT',
    );
    expect(scoped.value.data.boundaries.join(' ')).toMatch(/heuristic/i);

    await closeGraph(localStore);
    rmSync(localDir, { recursive: true, force: true });
  });
});

// =============================================================================
// CR-12 / CR-22 B3 — the scan now WINDOWS past the per-type cap. Historically a
// single capped listNodesByType page dropped the scan TAIL (node 501+ findings
// unreachable). B3 pages the SQL OFFSET forward window-by-window until the type
// is exhausted, so a low cap no longer makes the enumeration INCOMPLETE — it
// just scans in smaller windows and still reaches every finding. The honest
// `scanTruncated` disclosure now fires only for a pathological residual cap
// (FULL_SCAN_MAX_NODES), never for a normal multi-class org.
// =============================================================================
describe('findHardcodedValuesHandler — full multi-window scan (CR-22 B3)', () => {
  it('does NOT emit a Scan-capped boundary under the default cap (byte-identical happy path)', async () => {
    const r = await findHardcodedValuesHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaries.join(' ')).not.toMatch(/Scan capped/);
  });

  it('FAIL-BEFORE/PASS-AFTER: a cap of 1 still reaches every finding by windowing the scan', async () => {
    // Before B3 a cap of 1 fetched only the FIRST ApexClass (id ASC) and
    // silently dropped the rest — findings on later classes were unreachable.
    // After B3 the scan pages the SQL OFFSET forward, so all 5 findings are
    // found regardless of the per-window cap.
    const prev = process.env['SFI_NODE_SCAN_LIMIT'];
    process.env['SFI_NODE_SCAN_LIMIT'] = '1';
    try {
      const r = await findHardcodedValuesHandler(ctx, { limit: 500 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // All 5 findings reached even though each window fetched only 1 node.
      expect(r.value.data.totalCount).toBe(5);
      // Findings live on EmailSvc — the LAST class in id-ASC order — proving the
      // scan reached PAST the first window (the pre-B3 unreachable tail).
      const componentIds = new Set(r.value.data.matches.map((m) => m.componentId));
      expect(componentIds.has('ApexClass:EmailSvc')).toBe(true);
      // The completed full scan does NOT claim INCOMPLETE.
      expect(r.value.data.boundaries.join(' ')).not.toMatch(/Scan capped/);
    } finally {
      if (prev === undefined) delete process.env['SFI_NODE_SCAN_LIMIT'];
      else process.env['SFI_NODE_SCAN_LIMIT'] = prev;
    }
  });

  it('a low cap does NOT hard-error (RV10 clamp; cap is windowed, not rejected)', async () => {
    const prev = process.env['SFI_NODE_SCAN_LIMIT'];
    process.env['SFI_NODE_SCAN_LIMIT'] = '600'; // > LIST_MAX_LIMIT(500)
    try {
      const r = await findHardcodedValuesHandler(ctx, {});
      // Pre-RV10 this returned kind:'internal' (listNodesByType rejects >500).
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data.totalCount).toBe(5);
    } finally {
      if (prev === undefined) delete process.env['SFI_NODE_SCAN_LIMIT'];
      else process.env['SFI_NODE_SCAN_LIMIT'] = prev;
    }
  });
});

// =============================================================================
// CR-22 — output-axis cursor. A truncated page emits an opaque nextCursor that
// resumes with no gaps / no dupes; a whole-fits no-cursor call is byte-identical
// (no limit/offset/nextCursor/pageInfo fields).
// =============================================================================
describe('findHardcodedValuesHandler — output cursor (CR-22)', () => {
  it('whole-fits no-cursor call omits all paging fields (byte-identical)', async () => {
    const r = await findHardcodedValuesHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data as unknown as Record<string, unknown>;
    expect('limit' in d).toBe(false);
    expect('offset' in d).toBe(false);
    expect('nextOffset' in d).toBe(false);
    expect('nextCursor' in d).toBe(false);
    expect('pageInfo' in d).toBe(false);
  });

  it('a truncated page emits a cursor that resumes with no gaps or dupes', async () => {
    const all = await findHardcodedValuesHandler(ctx, { limit: 500 });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const fullOrder = all.value.data.matches.map((m) => m.componentId + '|' + m.location + '|' + m.rule);

    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const page: Awaited<ReturnType<typeof findHardcodedValuesHandler>> =
        await findHardcodedValuesHandler(
          ctx,
          cursor !== undefined ? { limit: 2, cursor } : { limit: 2 },
        );
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      for (const m of page.value.data.matches) {
        seen.push(m.componentId + '|' + m.location + '|' + m.rule);
      }
      const nc = page.value.data.nextCursor;
      if (nc === undefined) break;
      cursor = nc;
      guard += 1;
      if (guard > 20) throw new Error('cursor did not terminate');
    }
    // The concatenated pages exactly reproduce the full ordered list.
    expect(seen).toEqual(fullOrder);
    // No duplicates.
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('rejects a cursor minted for a DIFFERENT category (argsFingerprint bind)', async () => {
    const first = await findHardcodedValuesHandler(ctx, { category: 'id', limit: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cursor = first.value.data.nextCursor;
    expect(typeof cursor).toBe('string');
    if (typeof cursor !== 'string') return;
    // Replay the id-cursor against the email category — must be rejected.
    const replay = await findHardcodedValuesHandler(ctx, { category: 'email', cursor });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });
});

describe('findHardcodedValuesInputSchema', () => {
  it('accepts empty input', () => {
    expect(findHardcodedValuesInputSchema.safeParse({}).success).toBe(true);
  });

  it('accepts each valid category', () => {
    for (const c of ['id', 'email', 'username', 'sandbox-data']) {
      expect(
        findHardcodedValuesInputSchema.safeParse({ category: c }).success,
      ).toBe(true);
    }
  });

  it('rejects unknown category', () => {
    expect(
      findHardcodedValuesInputSchema.safeParse({ category: 'phone' }).success,
    ).toBe(false);
  });

  it('rejects limit above 500', () => {
    expect(
      findHardcodedValuesInputSchema.safeParse({ limit: 501 }).success,
    ).toBe(false);
  });
});

describe('findHardcodedValuesHandler: url category (P4-hardcoded-scan)', () => {
  let dir2: string;
  let store2: GraphStore;
  let ctx2: Context;

  beforeAll(async () => {
    dir2 = mkdtempSync(join(tmpdir(), 'sfi-mcp-fhv-url-'));
    const opened = await openGraph(join(dir2, 'u.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store2 = opened.value;
    const imp = await importExtractionResults(store2, [
      {
        nodes: [
          makeNode({
            id: 'ApexClass:IntegrationSvc',
            apiName: 'IntegrationSvc',
            properties: {
              isTest: false,
              qualityIssues: [
                {
                  rule: 'hardcoded-url',
                  severity: 'medium',
                  location: 'line 12',
                  explanation:
                    "Hardcoded endpoint URL 'https://api.example.com/v1' — Move it to a Named Credential.",
                  confidence: 'heuristic',
                },
                {
                  rule: 'hardcoded-email',
                  severity: 'low',
                  location: 'line 20',
                  explanation: "Hardcoded email 'ops@example.com'",
                  confidence: 'heuristic',
                },
              ],
            },
          }),
        ],
        edges: [],
      },
    ]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx2 = { vaultRoot: dir2, manifest: FIXTURE_MANIFEST, graph: store2 };
  });

  afterAll(async () => {
    await closeGraph(store2);
    rmSync(dir2, { recursive: true, force: true });
  });

  it('category:url narrows to the hardcoded-url findings only', async () => {
    const r = await findHardcodedValuesHandler(ctx2, { category: 'url' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.matches.map((m) => m.rule)).toEqual(['hardcoded-url']);
    expect(r.value.data.matches[0]?.explanation).toMatch(/Named Credential/);
  });

  it('byCategory reports the url count across the full set', async () => {
    const r = await findHardcodedValuesHandler(ctx2, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.byCategory.url).toBe(1);
    expect(r.value.data.byCategory.email).toBe(1);
  });
});

// =============================================================================
// FIX 6 / D-3 — `matches: []` is the false-clean shape. A scoped scan of a
// SCANNED-and-clean class used to return `boundaries: []` and no census, i.e.
// exactly what a class nobody read returns.
// =============================================================================
describe('findHardcodedValuesHandler — FIX 6 clean-scope disclosure', () => {
  it('FAIL-BEFORE/PASS-AFTER: a clean single class comes back with populated boundaries', async () => {
    const r = await findHardcodedValuesHandler(ctx, {
      componentId: 'ApexClass:CleanCls',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.matches).toEqual([]);
    expect(r.value.data.totalCount).toBe(0);
    // PRE-FIX: `boundaries` was `[]` on exactly this shape.
    expect(r.value.data.boundaries.length).toBeGreaterThan(0);
    expect(r.value.data.boundaries.join(' ')).toMatch(/heuristic/i);
  });

  it('a clean single class proves it was READ: census present, nodes === scanned', async () => {
    const r = await findHardcodedValuesHandler(ctx, {
      componentId: 'ApexClass:CleanCls',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.qualityScanCoverage).toEqual([
      { type: 'ApexClass', nodes: 1, scanned: 1 },
    ]);
  });

  it('the ROW-level refusal disclosure stays gated on there being a test-class row', async () => {
    // INVARIANT GUARDED: TEST_CLASS_REFUSAL_DISCLOSURE is a claim about the rows
    // THIS response returned ("some of these may be deliberate fixtures"), not
    // about the scanner — so unlike the heuristic disclosure it must NOT fire
    // on a response with no test-class row in it.
    const r = await findHardcodedValuesHandler(ctx, {
      componentId: 'ApexClass:CleanCls',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaries.join(' ')).not.toContain(
      'may be intentional test fixtures',
    );
  });
});

// =============================================================================
// FIX 13 — the per-match `inTestClass` flag already existed; the AGGREGATE
// lied. Measured on a real org, 110 of 116 matches sat inside @isTest classes,
// where a hardcoded id or email is the correct Apex idiom — so `totalCount`
// overstated the actionable work ~19x. Fixture below reproduces that ratio in
// miniature: 10 fixture matches, 2 production matches.
// =============================================================================
describe('findHardcodedValuesHandler — FIX 13 production / test-fixture split', () => {
  let splitDir: string;
  let splitStore: GraphStore;
  let splitCtx: Context;

  const issue = (n: number, rule: string): Record<string, unknown> => ({
    rule,
    severity: 'medium',
    location: `line ${n.toString()}`,
    explanation: `hardcoded literal #${n.toString()}`,
    confidence: 'heuristic',
  });

  beforeAll(async () => {
    splitDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-fhv-split-'));
    const opened = await openGraph(join(splitDir, 'split.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    splitStore = opened.value;
    const imported = await importExtractionResults(splitStore, [
      {
        nodes: [
          // 2 PRODUCTION matches: one id, one email.
          makeNode({
            id: 'ApexClass:LedgerService',
            apiName: 'LedgerService',
            properties: {
              isTest: false,
              qualityIssues: [
                issue(11, 'hardcoded-id'),
                issue(12, 'hardcoded-email'),
              ],
            },
          }),
          // 10 TEST-FIXTURE matches: 1 id + 9 emails.
          makeNode({
            id: 'ApexClass:LedgerServiceTest',
            apiName: 'LedgerServiceTest',
            properties: {
              isTest: true,
              qualityIssues: [
                issue(1, 'hardcoded-id'),
                issue(2, 'hardcoded-email'),
                issue(3, 'hardcoded-email'),
                issue(4, 'hardcoded-email'),
                issue(5, 'hardcoded-email'),
                issue(6, 'hardcoded-email'),
                issue(7, 'hardcoded-email'),
                issue(8, 'hardcoded-email'),
                issue(9, 'hardcoded-email'),
                issue(10, 'hardcoded-email'),
              ],
            },
          }),
        ],
        edges: [],
      },
    ]);
    if (!imported.ok) throw new Error(imported.error.message);
    splitCtx = {
      vaultRoot: splitDir,
      manifest: FIXTURE_MANIFEST,
      graph: splitStore,
    };
  });

  afterAll(async () => {
    await closeGraph(splitStore);
    rmSync(splitDir, { recursive: true, force: true });
  });

  it('FAIL-BEFORE/PASS-AFTER: splits the headline into production vs test fixture', async () => {
    const r = await findHardcodedValuesHandler(splitCtx, { limit: 500 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // totalCount is NOT replaced — it still counts everything.
    expect(r.value.data.totalCount).toBe(12);
    expect(r.value.data.productionCount).toBe(2);
    expect(r.value.data.testFixtureCount).toBe(10);
    // The parts reconcile with the whole, always.
    expect(
      (r.value.data.productionCount ?? 0) + (r.value.data.testFixtureCount ?? 0),
    ).toBe(r.value.data.totalCount);
  });

  it('byCategory stays the FULL set and byCategoryProduction rides alongside it', async () => {
    const r = await findHardcodedValuesHandler(splitCtx, { limit: 500 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // FULL: 2 ids (1 prod + 1 test), 10 emails (1 prod + 9 test).
    expect(r.value.data.byCategory.id).toBe(2);
    expect(r.value.data.byCategory.email).toBe(10);
    // PRODUCTION only.
    expect(r.value.data.byCategoryProduction?.id).toBe(1);
    expect(r.value.data.byCategoryProduction?.email).toBe(1);
  });

  it('states the split verbatim in boundaries', async () => {
    const r = await findHardcodedValuesHandler(splitCtx, { limit: 500 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaries.join(' ')).toContain(
      '10 of 12 matches are inside @isTest classes, where a hardcoded id or email is usually a deliberate fixture. The actionable production count is 2. Pass excludeTestClasses: true to scan production only.',
    );
  });

  it('excludeTestClasses: true scans production only and says how many it dropped', async () => {
    const r = await findHardcodedValuesHandler(splitCtx, {
      excludeTestClasses: true,
      limit: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.matches.length).toBe(2);
    expect(r.value.data.totalCount).toBe(2);
    for (const m of r.value.data.matches) {
      expect(m.inTestClass).toBe(false);
    }
    expect(r.value.data.appliedScope?.excludeTestClasses).toBe(true);
    expect(r.value.data.appliedScope?.mode).toBe('all');
    // A filter that removes rows must say how many, or the smaller totalCount
    // reads as a smaller org rather than a narrower question.
    expect(r.value.data.boundaries.join(' ')).toContain(
      '10 match(es) inside @isTest classes were filtered out',
    );
  });

  it('all matches in test classes → productionCount: 0, and that zero is CHECKED', async () => {
    const r = await findHardcodedValuesHandler(splitCtx, {
      componentId: 'ApexClass:LedgerServiceTest',
      limit: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(10);
    expect(r.value.data.productionCount).toBe(0);
    expect(r.value.data.testFixtureCount).toBe(10);
    expect(r.value.data.boundaries.join(' ')).toContain(
      'The actionable production count is 0.',
    );
  });

  it('refuses a test-class scope combined with excludeTestClasses instead of returning an empty scan', async () => {
    const r = await findHardcodedValuesHandler(splitCtx, {
      componentId: 'ApexClass:LedgerServiceTest',
      excludeTestClasses: true,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toBe(
      'You scoped to an @isTest class and also excluded test classes; those cannot both hold.',
    );
  });

  it('a cursor minted with excludeTestClasses cannot be replayed against the unfiltered list', async () => {
    // Without the flag in argsFingerprint the token decodes cleanly and resumes
    // at an offset that points at a DIFFERENT row — a silent skip across the
    // production/fixture boundary.
    const filtered = await findHardcodedValuesHandler(splitCtx, {
      excludeTestClasses: true,
      limit: 1,
    });
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) return;
    const cursor = filtered.value.data.nextCursor;
    expect(cursor).toBeDefined();
    if (cursor === undefined) return;

    const replayed = await findHardcodedValuesHandler(splitCtx, {
      cursor,
      limit: 1,
    });
    expect(replayed.ok).toBe(false);
    if (replayed.ok) return;
    expect(replayed.error.kind).toBe('invalid-query');

    // ...and the same cursor still resumes correctly WITH the flag.
    const resumed = await findHardcodedValuesHandler(splitCtx, {
      cursor,
      excludeTestClasses: true,
      limit: 1,
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.data.offset).toBe(1);
  });

  it('a fixture with zero test-class matches keeps the pre-split response shape', async () => {
    // The no-cost claim: the split fields appear exactly when they say
    // something `totalCount` / `byCategory` do not. Scoped to the production
    // class, `totalCount` IS the production count, so all three stay absent and
    // the serialized data keys are unchanged from pre-FIX-13.
    const r = await findHardcodedValuesHandler(splitCtx, {
      componentId: 'ApexClass:LedgerService',
      limit: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(2);
    expect(r.value.data.productionCount).toBeUndefined();
    expect(r.value.data.testFixtureCount).toBeUndefined();
    expect(r.value.data.byCategoryProduction).toBeUndefined();
    expect(r.value.data.appliedScope?.excludeTestClasses).toBeUndefined();
    expect(Object.keys(r.value.data)).toEqual([
      'matches',
      'totalCount',
      'byCategory',
      'qualityScanCoverage',
      'boundaries',
      'truncated',
      'appliedScope',
    ]);
  });
});
