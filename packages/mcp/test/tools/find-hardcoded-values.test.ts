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

  it('returns empty matches and empty boundaries when nothing matches the category', async () => {
    // Build a transient ctx whose nodes have no hardcoded-literal rules.
    const localDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-fhv-empty-'));
    const opened = await openGraph(join(localDir, 'empty.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const localStore = opened.value;
    const imp = await importExtractionResults(localStore, [
      {
        nodes: [
          makeNode({ id: 'ApexClass:JustClean', apiName: 'JustClean' }),
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
    expect(r.value.data.boundaries.length).toBe(0);
    await closeGraph(localStore);
    rmSync(localDir, { recursive: true, force: true });
  });
});

// =============================================================================
// CR-12 — input-scan saturation disclosure. The per-type scan caps at
// `nodeScanLimit()`; when a type's page comes back AT the cap, findings may sit
// BEHIND it, so a `scanTruncationNote` must be appended to `boundaries` naming
// the truncated type. This append is OUTSIDE the `sorted.length > 0` gate, so it
// fires even with zero matched findings. Mirrors app-access.test.ts.
// =============================================================================
describe('findHardcodedValuesHandler — input-scan truncation disclosure (CR-12)', () => {
  it('does NOT emit a Scan-capped boundary under the default cap (byte-identical happy path)', async () => {
    const r = await findHardcodedValuesHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaries.join(' ')).not.toMatch(/Scan capped/);
  });

  it('appends a Scan-capped boundary naming the truncated type when the scan hits the cap', async () => {
    // The fixture has multiple ApexClasses; a cap of 1 forces the ApexClass
    // scan to saturate, so findings past the cap were silently unexamined.
    const prev = process.env['SFI_NODE_SCAN_LIMIT'];
    process.env['SFI_NODE_SCAN_LIMIT'] = '1';
    try {
      const r = await findHardcodedValuesHandler(ctx, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const joined = r.value.data.boundaries.join(' ');
      expect(joined).toMatch(/Scan capped at 1 nodes per type/);
      expect(joined).toMatch(/ApexClass/);
    } finally {
      if (prev === undefined) delete process.env['SFI_NODE_SCAN_LIMIT'];
      else process.env['SFI_NODE_SCAN_LIMIT'] = prev;
    }
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
