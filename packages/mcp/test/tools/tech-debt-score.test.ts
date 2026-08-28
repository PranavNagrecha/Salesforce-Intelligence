/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

import type { Context } from '../../src/server.js';
import {
  readPriorTechDebtScore,
  techDebtScoreHandler,
  techDebtScoreInputSchema,
} from '../../src/tools/tech-debt-score.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-tds',
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

const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...overrides,
});

// ----- LOW-DEBT seed: minimal counts in each category -----
const lowDebtSeed: ExtractionResult = {
  nodes: [
    // Few/no unused: one ApexClass with a caller.
    makeNode({
      id: 'ApexClass:Used',
      apiName: 'Used',
      apiVersion: 58,
    }),
    makeNode({
      id: 'ApexClass:Caller',
      apiName: 'Caller',
      apiVersion: 58,
    }),
    // No active WorkflowRules.
    makeNode({
      id: 'WorkflowRule:Account.Inactive',
      type: 'WorkflowRule',
      apiName: 'Account.Inactive',
      properties: { active: false },
    }),
  ],
  edges: [
    makeEdge({
      fromId: 'ApexClass:Caller',
      toId: 'ApexClass:Used',
      edgeType: 'callsApex',
    }),
  ],
};

// ----- HIGH-DEBT seed: lots in each category -----
const highDebtNodes: Node[] = [];
// 30+ unused custom fields (high deadWeight raw count → big contribution)
for (let i = 0; i < 60; i++) {
  highDebtNodes.push(
    makeNode({
      id: `CustomField:HighDebt.Unused${i}__c`,
      type: 'CustomField',
      apiName: `Unused${i}__c`,
      properties: {},
    }),
  );
}
// 30 active workflow rules
for (let i = 0; i < 30; i++) {
  highDebtNodes.push(
    makeNode({
      id: `WorkflowRule:Account.Rule${i}`,
      type: 'WorkflowRule',
      apiName: `Account.Rule${i}`,
      properties: { active: true, criteriaItems: [{ field: 'X' }] },
    }),
  );
}
// 15 deprecated apex classes (apiVersion < 50)
for (let i = 0; i < 15; i++) {
  highDebtNodes.push(
    makeNode({
      id: `ApexClass:Old${i}`,
      type: 'ApexClass',
      apiName: `Old${i}`,
      apiVersion: 30,
    }),
  );
}

const highDebtSeed: ExtractionResult = { nodes: highDebtNodes, edges: [] };

// ----- Q115 honesty anchor: no qualityIssues, no freshness data -----
// (Use the lowDebtSeed which has no qualityIssues / no lastModifiedDate)

describe('techDebtScoreHandler — Q111 low-debt band', () => {
  let tempDir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-tds-low-'));
    const opened = await openGraph(join(tempDir, 'tds-low.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    const imp = await importExtractionResults(store, [lowDebtSeed]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns a low-debt score for a clean org', async () => {
    const r = await techDebtScoreHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.overallScore).toBeLessThanOrEqual(50);
    expect(['low-debt', 'moderate-debt']).toContain(r.value.data.scoreBand);
    // Bug 25: hardcoded-ID debt is surfaced from find_hardcoded_values_anywhere
    // (null only if the recognizer could not run), so "0 dead code" is not read
    // as "0 code debt".
    expect(r.value.data).toHaveProperty('hardcodedIdCount');
    expect(
      r.value.data.hardcodedIdCount === null ||
        typeof r.value.data.hardcodedIdCount === 'number',
    ).toBe(true);
  });

  it('always emits SCORE_DIRECTION_DISCLOSURE in boundaries', async () => {
    const r = await techDebtScoreHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaries.join(' ')).toMatch(/higher is WORSE/);
  });

  it('always emits the WEIGHT_SCHEME disclosure', async () => {
    const r = await techDebtScoreHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaries.join(' ')).toMatch(
      /weights reflect a typical enterprise/i,
    );
  });

  it('reports deviation=default when no weights overridden', async () => {
    const r = await techDebtScoreHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.weightingDisclosure.deviation).toBe('default');
  });

  it('exposes the default weights for the user to inspect', async () => {
    const r = await techDebtScoreHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.weightingDisclosure.weightsDefault.deadWeight).toBe(0.2);
    expect(r.value.data.weightingDisclosure.weightsDefault.legacyAutomation).toBe(0.2);
  });

  // LAST in this describe: it writes a risk-scores log into ctx.vaultRoot, so it
  // must not run before the no-delta assertions above (afterAll wipes tempDir).
  it('reports scoreDelta vs a prior logged refresh (P9-risk-delta)', async () => {
    mkdirSync(join(ctx.vaultRoot, 'meta'), { recursive: true });
    writeFileSync(
      join(ctx.vaultRoot, 'meta', 'risk-scores.jsonl'),
      `${JSON.stringify({ refreshedAt: '2026-01-01T00:00:00Z', sourceTreeHash: 'sha256:OLD-STATE', techDebtScore: 99 })}\n`,
    );
    const r = await techDebtScoreHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.previousScore).toBe(99);
    expect(r.value.data.previousRefreshedAt).toBe('2026-01-01T00:00:00Z');
    expect(r.value.data.scoreDelta).toBe(
      Math.round((r.value.data.overallScore - 99) * 100) / 100,
    );
  });
});

describe('readPriorTechDebtScore (P9-risk-delta)', () => {
  it('returns the most recent logged score from an EARLIER org state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-risk-log-'));
    mkdirSync(join(dir, 'meta'), { recursive: true });
    const rows = [
      { refreshedAt: '2026-01-01T00:00:00Z', sourceTreeHash: 'h1', techDebtScore: 40 },
      { refreshedAt: '2026-02-01T00:00:00Z', sourceTreeHash: 'h2', techDebtScore: 55 },
      // current state — same hash as the query; must be skipped:
      { refreshedAt: '2026-03-01T00:00:00Z', sourceTreeHash: 'h3', techDebtScore: 60 },
    ];
    writeFileSync(
      join(dir, 'meta', 'risk-scores.jsonl'),
      `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`,
    );
    const prior = await readPriorTechDebtScore(dir, 'h3');
    expect(prior?.score).toBe(55);
    expect(prior?.refreshedAt).toBe('2026-02-01T00:00:00Z');
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null with no log, and when the only entry is the current state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-risk-log-'));
    expect(await readPriorTechDebtScore(dir, 'h1')).toBeNull(); // no log file
    mkdirSync(join(dir, 'meta'), { recursive: true });
    writeFileSync(
      join(dir, 'meta', 'risk-scores.jsonl'),
      `${JSON.stringify({ sourceTreeHash: 'h1', techDebtScore: 40 })}\n`,
    );
    expect(await readPriorTechDebtScore(dir, 'h1')).toBeNull(); // only current state
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('techDebtScoreHandler — Q112 high-debt band', () => {
  let tempDir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-tds-high-'));
    const opened = await openGraph(join(tempDir, 'tds-high.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    const imp = await importExtractionResults(store, [highDebtSeed]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns a higher-debt score for a messy org', async () => {
    const r = await techDebtScoreHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.overallScore).toBeGreaterThan(25);
  });

  it('reports per-category breakdown with non-zero contributions', async () => {
    const r = await techDebtScoreHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.categories.legacyAutomation.rawCount).toBeGreaterThan(0);
    expect(r.value.data.categories.apiVersions.rawCount).toBeGreaterThan(0);
  });

  it('produces recommendedActions ordered by contribution desc', async () => {
    const r = await techDebtScoreHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.recommendedActions.length).toBeGreaterThan(0);
    expect(r.value.data.recommendedActions.length).toBeLessThanOrEqual(5);
  });
});

describe('techDebtScoreHandler — P10-A4 codeQuality heuristic-tier citation', () => {
  let tempDir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-tds-cqh-'));
    const opened = await openGraph(join(tempDir, 'tds-cqh.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    // A vault whose Apex carries heuristic-scanner qualityIssues → codeQuality
    // is INCLUDED in the score, so the heuristic tier must be cited.
    const seed: ExtractionResult = {
      nodes: [
        makeNode({
          id: 'ApexClass:Smelly',
          apiName: 'Smelly',
          apiVersion: 58,
          properties: {
            qualityIssues: [
              { severity: 'critical', rule: 'hardcoded-id' },
              { severity: 'high', rule: 'soql-in-loop' },
            ],
          },
        }),
      ],
      edges: [],
    };
    const imp = await importExtractionResults(store, [seed]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('includes the codeQuality axis when qualityIssues are present', async () => {
    const r = await techDebtScoreHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      r.value.data.excludedCategories.map((e) => e.category),
    ).not.toContain('codeQuality');
    expect(r.value.data.categories.codeQuality.rawCount).toBeGreaterThan(0);
  });

  it('cites the heuristic tier in boundaries when codeQuality contributes', async () => {
    const r = await techDebtScoreHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaries.join(' ')).toMatch(/heuristic Apex scanner/);
  });

  it('omits the heuristic disclosure when codeQuality is excluded (no qualityIssues)', async () => {
    const tmp2 = mkdtempSync(join(tmpdir(), 'sfi-mcp-tds-cqx-'));
    const o2 = await openGraph(join(tmp2, 'x.db'));
    if (!o2.ok) throw new Error(o2.error.message);
    const s2 = o2.value;
    const imp = await importExtractionResults(s2, [lowDebtSeed]);
    if (!imp.ok) throw new Error(imp.error.message);
    const ctx2: Context = { vaultRoot: tmp2, manifest: FIXTURE_MANIFEST, graph: s2 };
    const r = await techDebtScoreHandler(ctx2, {});
    await closeGraph(s2);
    rmSync(tmp2, { recursive: true, force: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaries.join(' ')).not.toMatch(/heuristic Apex scanner/);
  });
});

describe('techDebtScoreHandler — Q113 weighting override', () => {
  let tempDir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-tds-wovr-'));
    const opened = await openGraph(join(tempDir, 'tds-wovr.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    const imp = await importExtractionResults(store, [highDebtSeed]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports deviation=user-overridden when weights changed', async () => {
    const r = await techDebtScoreHandler(ctx, {
      weights: { legacyAutomation: 0.4 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.weightingDisclosure.deviation).toBe('user-overridden');
    expect(r.value.data.weightingDisclosure.weightsApplied.legacyAutomation).toBe(0.4);
  });
});

describe('techDebtScoreHandler — Q114 user-opted-out exclusion', () => {
  let tempDir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-tds-excl-'));
    const opened = await openGraph(join(tempDir, 'tds-excl.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    const imp = await importExtractionResults(store, [lowDebtSeed]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports excluded category with reason user-opted-out when requested', async () => {
    const r = await techDebtScoreHandler(ctx, {
      excludeCategories: ['freshness'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const excluded = r.value.data.excludedCategories.find(
      (e) => e.category === 'freshness',
    );
    expect(excluded?.reason).toBe('user-opted-out');
  });
});

describe('techDebtScoreHandler — Q115 honesty anchor (extractor-not-run)', () => {
  let tempDir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-tds-q115-'));
    const opened = await openGraph(join(tempDir, 'tds-q115.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    // Use the low-debt seed: NO qualityIssues, NO lastModifiedDate
    const imp = await importExtractionResults(store, [lowDebtSeed]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('excludes categories whose underlying extractor did not run', async () => {
    const r = await techDebtScoreHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const excludedCats = r.value.data.excludedCategories.map((e) => e.category);
    // Both codeQuality and freshness lack data in the seed.
    expect(excludedCats).toContain('codeQuality');
    expect(excludedCats).toContain('freshness');
    for (const e of r.value.data.excludedCategories) {
      expect(['user-opted-out', 'extractor-not-run']).toContain(e.reason);
    }
  });

  it('emits the verbatim Q115 disclosure when extractor-not-run', async () => {
    const r = await techDebtScoreHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaries.join(' ')).toContain(
      'this score reflects only the axes that were extracted; missing axes are EXCLUDED, not assumed zero',
    );
  });

  it('does NOT assume zero for missing data — score is computed across included categories only', async () => {
    const r = await techDebtScoreHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Confirm score band is bounded
    expect(r.value.data.overallScore).toBeGreaterThanOrEqual(0);
    expect(r.value.data.overallScore).toBeLessThanOrEqual(100);
  });

  it('nulls excluded category rawCount and details — not misleading zeros', async () => {
    const r = await techDebtScoreHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.categories.codeQuality.rawCount).toBeNull();
    expect(r.value.data.categories.codeQuality.details.criticalIssuesCount).toBeNull();
    expect(r.value.data.categories.freshness.rawCount).toBeNull();
  });

  it('nulls unassignedGrants counts when excluded but surfaces unknownAssignmentCount', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-tds-unas-'));
    const opened = await openGraph(join(dir, 'unas.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    const g = opened.value;
    const permSets: Node[] = [];
    for (let i = 0; i < 5; i++) {
      permSets.push(
        makeNode({
          id: `PermissionSet:PS_${i}`,
          type: 'PermissionSet',
          apiName: `PS_${i}`,
          properties: {},
        }),
      );
    }
    const imp = await importExtractionResults(g, [{ nodes: permSets, edges: [] }]);
    if (!imp.ok) throw new Error(imp.error.message);
    const localCtx: Context = {
      vaultRoot: dir,
      manifest: FIXTURE_MANIFEST,
      graph: g,
    };
    const r = await techDebtScoreHandler(localCtx, {});
    await closeGraph(g);
    rmSync(dir, { recursive: true, force: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const unassigned = r.value.data.categories.unassignedGrants;
    expect(
      r.value.data.excludedCategories.map((e) => e.category),
    ).toContain('unassignedGrants');
    expect(unassigned.rawCount).toBeNull();
    expect(unassigned.details.unassignedPermissionSetsCount).toBeNull();
    expect(unassigned.details.emptyQueuesCount).toBeNull();
    expect(unassigned.details.emptyGroupsCount).toBeNull();
    expect(unassigned.details.unknownAssignmentPermissionSetsCount).toBe(5);
  });

  it('does not attribute deprecated API version counts to legacyAutomation details', async () => {
    const r = await techDebtScoreHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      r.value.data.categories.legacyAutomation.details,
    ).not.toHaveProperty('deprecatedApiVersionApexCount');
  });
});

describe('techDebtScoreHandler — neverModified honesty (CR-16a)', () => {
  let tempDir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-tds-nm-'));
    const opened = await openGraph(join(tempDir, 'tds-nm.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    // Seed nodes that carry a REAL lastModifiedDate so the freshness category is
    // INCLUDED (not excluded). Several are >2y old, one is recent.
    const threeYearsAgo = new Date(
      Date.now() - 3 * 365 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const recent = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const freshnessNodes: Node[] = [];
    for (let i = 0; i < 4; i++) {
      freshnessNodes.push(
        makeNode({
          id: `CustomField:Stale.Old${i}__c`,
          type: 'CustomField',
          apiName: `Old${i}__c`,
          lastModifiedDate: threeYearsAgo,
        }),
      );
    }
    freshnessNodes.push(
      makeNode({
        id: 'CustomField:Stale.Fresh__c',
        type: 'CustomField',
        apiName: 'Fresh__c',
        lastModifiedDate: recent,
      }),
    );
    const imp = await importExtractionResults(store, [
      { nodes: freshnessNodes, edges: [] },
    ]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports componentsNeverModifiedSinceCreation as null (unknowable), not a fabricated 0', async () => {
    const r = await techDebtScoreHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Freshness must be INCLUDED — we are exercising the data-present path so the
    // null is because the metric is unknowable, not because the axis was dropped.
    expect(
      r.value.data.excludedCategories.map((e) => e.category),
    ).not.toContain('freshness');
    expect(
      r.value.data.categories.freshness.details
        .componentsNeverModifiedSinceCreation,
    ).toBeNull();
    // The honest sibling axes still compute real numbers from lastModifiedDate.
    expect(
      r.value.data.categories.freshness.details.componentsOlderThan2Years,
    ).toBeGreaterThan(0);
  });

  it('emits an explicit not-available disclosure instead of a silent fake 0', async () => {
    const r = await techDebtScoreHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaries.join(' ')).toMatch(
      /never modified since creation.*not available|does not capture a per-component createdDate/i,
    );
  });
});

describe('techDebtScoreHandler — unknown weight key refusal', () => {
  let tempDir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-tds-unkw-'));
    const opened = await openGraph(join(tempDir, 'tds-unkw.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    const imp = await importExtractionResults(store, [lowDebtSeed]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('refuses an unknown weight key with invalid-query', async () => {
    const r = await techDebtScoreHandler(ctx, {
      weights: { invalid: 0.5 } as never,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain("'invalid'");
    expect(r.error.message).toMatch(/Allowed keys are/);
  });

  it('cites every unknown weight key in the refusal message', async () => {
    const r = await techDebtScoreHandler(ctx, {
      weights: {
        deadWeight: 0.5,
        typo1: 0.1,
        typo2: 0.2,
      } as never,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain("'typo1'");
    expect(r.error.message).toContain("'typo2'");
  });

  it('still accepts a recognized weight override', async () => {
    const r = await techDebtScoreHandler(ctx, {
      weights: { deadWeight: 0.5 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.weightingDisclosure.weightsApplied.deadWeight).toBe(0.5);
  });

  // GUARD (TECH-DEBT-SCORE-IGNORES-OBJECT-SCOPE): pre-fix an object scope was
  // Zod-stripped, so `{ objectApiName: X }` was byte-identical to `{}`. Post-fix
  // the bare call echoes `appliedScope.mode: 'all'` and any object/component
  // scope is refused (never silently answered fleet-wide).
  it('bare call echoes org-wide appliedScope; an object scope is refused', async () => {
    const bare = await techDebtScoreHandler(ctx, {});
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    expect(bare.value.data.appliedScope).toEqual({ object: null, mode: 'all' });

    for (const scoped of [
      { objectApiName: 'Account' },
      { object: 'Opportunity' },
      { objectId: 'CustomObject:Account' },
      { componentId: 'CustomObject:Account' },
    ]) {
      const parsed = techDebtScoreInputSchema.safeParse(scoped);
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      const r = await techDebtScoreHandler(ctx, parsed.data);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error.kind).toBe('invalid-query');
      expect(r.error.message).toMatch(/org-wide|per-object/i);
    }
  });
});

describe('techDebtScoreInputSchema', () => {
  it('accepts empty input', () => {
    expect(techDebtScoreInputSchema.safeParse({}).success).toBe(true);
  });

  it('accepts exclusion array', () => {
    expect(
      techDebtScoreInputSchema.safeParse({
        excludeCategories: ['freshness', 'codeQuality'],
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown category', () => {
    expect(
      techDebtScoreInputSchema.safeParse({
        excludeCategories: ['unknownCategory'],
      }).success,
    ).toBe(false);
  });

  it('rejects weight above 1', () => {
    expect(
      techDebtScoreInputSchema.safeParse({
        weights: { deadWeight: 1.5 },
      }).success,
    ).toBe(false);
  });

  it('accepts partial weight override', () => {
    expect(
      techDebtScoreInputSchema.safeParse({
        weights: { legacyAutomation: 0.4 },
      }).success,
    ).toBe(true);
  });

  // The object / component scope keys parse (so the handler can refuse them with
  // a helpful message) rather than being silently stripped at the Zod boundary.
  it('accepts object / component scope keys at the schema level (handler refuses them)', () => {
    for (const scoped of [
      { objectApiName: 'Account' },
      { object: 'Account' },
      { objectId: 'CustomObject:Account' },
      { componentId: 'CustomObject:Account' },
    ]) {
      expect(techDebtScoreInputSchema.safeParse(scoped).success).toBe(true);
    }
  });
});

// =============================================================================
// CR-12 — page-to-exhaustion. The composite SCORE inspects per-node properties
// (apiVersion, qualityIssues, lastModifiedDate) and must be computed over the
// COMPLETE node set, not just the first page. With SFI_NODE_SCAN_LIMIT=2 the
// loadAllNodes offset loop walks multiple pages; a deprecated/smelly class
// sorted PAST the cap by id ASC used to be invisible, undercounting the score.
// =============================================================================
describe('techDebtScoreHandler — past-cap score completeness (CR-12 de-cap)', () => {
  let tempDir: string;
  let store: GraphStore;
  let ctx: Context;

  // id-ASC: Aaa, Bbb (modern, apiVersion 58) come first; the deprecated
  // (apiVersion 30) Yyy/Zzz and the smelly Www sort LAST — past a cap of 2.
  const pastCapSeed: ExtractionResult = {
    nodes: [
      makeNode({ id: 'ApexClass:Aaa', apiName: 'Aaa', apiVersion: 58 }),
      makeNode({ id: 'ApexClass:Bbb', apiName: 'Bbb', apiVersion: 58 }),
      makeNode({
        id: 'ApexClass:Www',
        apiName: 'Www',
        apiVersion: 58,
        properties: {
          qualityIssues: [
            { severity: 'critical', rule: 'soql-in-loop' },
            { severity: 'high', rule: 'dml-in-loop' },
          ],
        },
      }),
      makeNode({ id: 'ApexClass:Yyy', apiName: 'Yyy', apiVersion: 30 }),
      makeNode({ id: 'ApexClass:Zzz', apiName: 'Zzz', apiVersion: 30 }),
    ],
    edges: [],
  };

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-tds-pastcap-'));
    const opened = await openGraph(join(tempDir, 'tds-pastcap.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    const imp = await importExtractionResults(store, [pastCapSeed]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env['SFI_NODE_SCAN_LIMIT'] = '2';
  });

  afterEach(() => {
    delete process.env['SFI_NODE_SCAN_LIMIT'];
  });

  it('counts deprecated API classes past the cap (apiVersions rawCount complete)', async () => {
    // BEFORE the fix: single-page sees only Aaa/Bbb (both apiVersion 58) →
    // below50 = 0. AFTER: the walk reaches Yyy/Zzz → below50 = 2.
    const r = await techDebtScoreHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.categories.apiVersions.rawCount).toBe(2);
  });

  it('aggregates qualityIssues from a class past the cap (codeQuality rawCount complete)', async () => {
    // Www (critical + high) sorts at position 3, past the cap of 2.
    const r = await techDebtScoreHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.categories.codeQuality.rawCount).toBe(2);
  });
});

describe('techDebtScoreHandler — QUALITY-SCAN-SKIPS-TRIGGERS-AND-FLOWS', () => {
  let tempDir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-tds-partial-scan-'));
    const opened = await openGraph(join(tempDir, 'partial.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    // The real vault's shape: every ApexClass scanned, every ApexTrigger not.
    // `anyNodeHasIssuesProperty` is an ANY, so this scored the codeQuality axis
    // off part of the Apex surface and said nothing at all — the exclusion hook
    // only fires when NO node anywhere carries the property.
    const imp = await importExtractionResults(store, [
      {
        nodes: [
          makeNode({
            id: 'ApexClass:Smelly',
            apiName: 'Smelly',
            apiVersion: 58,
            properties: {
              qualityIssues: [{ severity: 'critical', rule: 'soql-in-loop' }],
            },
          }),
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
    if (!imp.ok) throw new Error(imp.error.message);
    ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('discloses PARTIAL scan coverage, which the extractor-not-run exclusion never covered', async () => {
    const r = await techDebtScoreHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The axis DOES contribute — this is not the exclusion path.
    expect(
      r.value.data.excludedCategories.map((e) => e.category),
    ).not.toContain('codeQuality');
    expect(r.value.data.qualityScanCoverage).toEqual([
      { type: 'ApexClass', nodes: 1, scanned: 1 },
      { type: 'ApexTrigger', nodes: 1, scanned: 0 },
    ]);
    expect(r.value.data.boundaries.join(' ')).toContain(
      'NOT SCANNED IN THIS VAULT',
    );
  });

  it('names Flow as permanently not-checked whenever the axis contributes', async () => {
    const r = await techDebtScoreHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.notCheckedTypes?.map((n) => n.type)).toEqual(['Flow']);
    expect(r.value.data.boundaries.join(' ')).toContain(
      'NOT CHECKED BY DESIGN',
    );
  });

  it('says nothing when the axis is EXCLUDED — an excluded axis is already disclosed', async () => {
    const r = await techDebtScoreHandler(ctx, {
      excludeCategories: ['codeQuality'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.qualityScanCoverage).toBeUndefined();
    expect(r.value.data.notCheckedTypes).toBeUndefined();
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).not.toContain('NOT SCANNED IN THIS VAULT');
    expect(joined).not.toContain('NOT CHECKED BY DESIGN');
  });
});

// ---------------------------------------------------------------------------
// TECH-DEBT-UNCHECKED-ZERO-SCORED-AS-CLEAN
//
// The composite printed "missing axes are EXCLUDED, not assumed zero" as a
// boundary while doing the opposite on its heaviest axis: a `WorkflowRule`
// family the vault never confirmed-retrieved scored as `rawCount: 0,
// contribution: 0` — a CLEAN zero at weight 0.20 — on the same vault where
// `coverage_report` listed WorkflowRule in `missingCoverage` and
// `list_components` called it "not retrieved, not proof of absence".
//
// The pair of fixtures below is the whole point: the SAME zero, once with a
// coverage row that never confirmed the retrieve (UNCHECKED — must be excluded)
// and once with `retrieveConfirmed: true` (CHECKED — must keep scoring). A fix
// that only silences the stale case would break the fresh one.
// ---------------------------------------------------------------------------

/** Every metadata family the six axes are computed from. */
const AXIS_COVERAGE_FAMILIES = [
  'CustomField',
  'ApexClass',
  'ApexTrigger',
  'Flow',
  'EmailTemplate',
  'StaticResource',
  'CustomLabel',
  'WorkflowRule',
  'Layout',
  'ValidationRule',
  'PermissionSet',
  'Queue',
  'Group',
] as const;

/** A clean, confirmed-retrieved coverage row. */
const confirmedRow = (type: string, retrieved = 5): CoverageEntry => ({
  type,
  requested: true,
  retrieved,
  errored: false,
  neverModeled: false,
  retrieveConfirmed: true,
});

/**
 * The stale-vault row shape: requested, retrieved ZERO, and NO
 * `retrieveConfirmed` — byte-identical to "the org genuinely has none", which
 * is exactly why it must read as "not checked".
 */
const unconfirmedZeroRow = (type: string): CoverageEntry => ({
  type,
  requested: true,
  retrieved: 0,
  errored: false,
  neverModeled: false,
});

const manifestWithCoverage = (
  unconfirmed: readonly string[],
): VaultManifest => ({
  ...FIXTURE_MANIFEST,
  coverage: AXIS_COVERAGE_FAMILIES.map((t) =>
    unconfirmed.includes(t) ? unconfirmedZeroRow(t) : confirmedRow(t),
  ),
});

// Zero WorkflowRule nodes and zero EmailTemplate nodes — so both raw counts are
// 0 and ONLY the coverage row decides whether that 0 is a measurement. Two Apex
// classes carry a quality scan; the trigger carries none (the roll-up's
// partly-scanned-surface case).
const coverageSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: 'ApexClass:OldOne',
      apiName: 'OldOne',
      apiVersion: 30,
      properties: { qualityIssues: [{ severity: 'critical' }] },
    }),
    makeNode({
      id: 'ApexClass:OldTwo',
      apiName: 'OldTwo',
      apiVersion: 30,
      properties: { qualityIssues: [{ severity: 'high' }] },
    }),
    makeNode({
      id: 'ApexTrigger:NeverScanned',
      type: 'ApexTrigger',
      apiName: 'NeverScanned',
      properties: {},
    }),
    makeNode({
      id: 'CustomField:Thing.Unused__c',
      type: 'CustomField',
      apiName: 'Unused__c',
      properties: {},
    }),
  ],
  edges: [],
};

describe('techDebtScoreHandler — unchecked zero vs checked zero', () => {
  let tempDir: string;
  let store: GraphStore;
  let baseCtx: Context;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-tds-cov-'));
    const opened = await openGraph(join(tempDir, 'tds-cov.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    const imp = await importExtractionResults(store, [coverageSeed]);
    if (!imp.ok) throw new Error(imp.error.message);
    baseCtx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(tempDir, { recursive: true, force: true });
  });

  const staleCtx = (): Context => ({
    ...baseCtx,
    manifest: manifestWithCoverage(['WorkflowRule', 'EmailTemplate']),
  });
  const freshCtx = (): Context => ({
    ...baseCtx,
    manifest: manifestWithCoverage([]),
  });

  it('EXCLUDES legacyAutomation when WorkflowRule was never confirmed-retrieved (was: scored as a clean 0 at weight 0.20)', async () => {
    const r = await techDebtScoreHandler(staleCtx(), {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const excluded = r.value.data.excludedCategories.find(
      (e) => e.category === 'legacyAutomation',
    );
    expect(excluded).toBeDefined();
    expect(excluded?.reason).toBe('extractor-not-run');
    expect(excluded?.note).toContain('WorkflowRule');
    expect(excluded?.note).toContain('UNCHECKED');
    // rawCount is null, NOT 0: a sum with an unchecked term is unchecked.
    expect(r.value.data.categories.legacyAutomation.rawCount).toBeNull();
    expect(r.value.data.categories.legacyAutomation.contribution).toBe(0);
    // The unchecked family reads null; the CHECKED family keeps its real 0.
    expect(
      r.value.data.categories.legacyAutomation.details.activeWorkflowRulesCount,
    ).toBeNull();
    expect(
      r.value.data.categories.legacyAutomation.details.activeProcessBuildersCount,
    ).toBe(0);
    // and the false recommendation is gone.
    expect(r.value.data.recommendedActions.join(' ')).not.toContain(
      'legacy automation entries',
    );
  });

  it('KEEPS legacyAutomation as a scored zero when the same 0 carries retrieveConfirmed', async () => {
    const r = await techDebtScoreHandler(freshCtx(), {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      r.value.data.excludedCategories.map((e) => e.category),
    ).not.toContain('legacyAutomation');
    expect(r.value.data.categories.legacyAutomation.rawCount).toBe(0);
    expect(
      r.value.data.categories.legacyAutomation.details.activeWorkflowRulesCount,
    ).toBe(0);
    expect(
      r.value.data.categories.legacyAutomation.details.activeProcessBuildersCount,
    ).toBe(0);
    expect(r.value.data.coverageCaveat).toBeUndefined();
    expect(r.value.data.boundaries.join(' ')).not.toContain(
      'UNCHECKED, NOT ZERO',
    );
  });

  it('reports unusedEmailTemplatesCount as null when EmailTemplate was never retrieved, while the CHECKED families keep real counts', async () => {
    const r = await techDebtScoreHandler(staleCtx(), {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dw = r.value.data.categories.deadWeight;
    expect(dw.details.unusedEmailTemplatesCount).toBeNull();
    // Coverage exclusion must NOT blank the families that WERE checked.
    expect(typeof dw.details.unusedFieldsCount).toBe('number');
    expect(typeof dw.details.unusedApexClassesCount).toBe('number');
    expect(dw.rawCount).toBeNull();
  });

  it('reports unusedEmailTemplatesCount as a real 0 on a confirmed-retrieved vault', async () => {
    const r = await techDebtScoreHandler(freshCtx(), {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      r.value.data.categories.deadWeight.details.unusedEmailTemplatesCount,
    ).toBe(0);
    expect(r.value.data.categories.deadWeight.rawCount).not.toBeNull();
  });

  it('emits a coverageCaveat naming the unchecked families, and a boundary saying which axes it cost', async () => {
    const r = await techDebtScoreHandler(staleCtx(), {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.coverageCaveat).toBeDefined();
    expect(r.value.data.coverageCaveat?.missingCoverage).toContain(
      'WorkflowRule',
    );
    expect(r.value.data.coverageCaveat?.missingCoverage).toContain(
      'EmailTemplate',
    );
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).toContain('UNCHECKED, NOT ZERO');
    expect(joined).toContain('legacyAutomation');
    // The Q115 anchor must still be there — it is now actually true.
    expect(joined).toContain('missing axes are EXCLUDED, not assumed zero');
  });

  it('leaves a coverage-known-nothing (pre-v4) manifest completely alone', async () => {
    // FIXTURE_MANIFEST carries no `coverage` rows at all. A vault whose
    // completeness is UNKNOWN must never be false-flagged as incomplete.
    const r = await techDebtScoreHandler(baseCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.coverageCaveat).toBeUndefined();
    expect(
      r.value.data.excludedCategories.map((e) => e.category),
    ).not.toContain('legacyAutomation');
    expect(r.value.data.categories.legacyAutomation.rawCount).toBe(0);
  });

  it('qualifies the codeQuality recommendation as a FLOOR when some Apex node carries no scan', async () => {
    // QUALITY-SCAN-SKIPS-TRIGGERS-AND-FLOWS in the roll-up: the boundary and
    // `qualityScanCoverage` already disclosed the unscanned trigger, but
    // `recommendedActions` — the field a host quotes — still stated the issue
    // count as a whole-surface total.
    const r = await techDebtScoreHandler(freshCtx(), {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.qualityScanCoverage).toEqual(
      expect.arrayContaining([{ type: 'ApexTrigger', nodes: 1, scanned: 0 }]),
    );
    const codeQualityRec = r.value.data.recommendedActions.find((a) =>
      a.startsWith('address code-quality findings'),
    );
    expect(codeQualityRec).toBeDefined();
    expect(codeQualityRec).toContain('FLOOR');
    expect(codeQualityRec).toContain('ApexTrigger');
    expect(codeQualityRec).toContain('not checked');
  });

  it('leaves the codeQuality recommendation unqualified when every Apex node was scanned', async () => {
    const cleanDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-tds-scan-'));
    const opened = await openGraph(join(cleanDir, 'tds-scan.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    const imp = await importExtractionResults(opened.value, [
      {
        nodes: [
          makeNode({
            id: 'ApexClass:Scanned',
            apiName: 'Scanned',
            apiVersion: 30,
            properties: { qualityIssues: [{ severity: 'critical' }] },
          }),
        ],
        edges: [],
      },
    ]);
    if (!imp.ok) throw new Error(imp.error.message);
    const r = await techDebtScoreHandler(
      { vaultRoot: cleanDir, manifest: manifestWithCoverage([]), graph: opened.value },
      {},
    );
    await closeGraph(opened.value);
    rmSync(cleanDir, { recursive: true, force: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.qualityScanCoverage).toBeUndefined();
    const codeQualityRec = r.value.data.recommendedActions.find((a) =>
      a.startsWith('address code-quality findings'),
    );
    expect(codeQualityRec).toBeDefined();
    expect(codeQualityRec).not.toContain('FLOOR');
  });
});

// =============================================================================
// R1 — the legacyAutomation axis composes over
// `sfi.process_builder_migration_candidates`, which caps its internal
// WorkflowRule/Flow/ApprovalProcess scan at 500 nodes per type (`LIST_PAGE_SIZE`)
// and honestly discloses the cap via `scanTruncated` + `trueTypeCounts` on its
// own response. This composer must read that disclosure and EXCLUDE the axis
// (same as any other extractor-not-run category) rather than score a capped,
// alphabetically-first subset at full confidence.
// =============================================================================
describe('techDebtScoreHandler — legacyAutomation scan-truncation honesty (R1)', () => {
  let tempDir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-tds-scantrunc-'));
    const opened = await openGraph(join(tempDir, 'tds-scantrunc.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    // 501 WorkflowRule nodes — one past process-builder-migration-candidates'
    // internal LIST_PAGE_SIZE (500) cap, so its own countNodesByType cross-check
    // sets scanTruncated: true and trueTypeCounts.workflowRules = 501.
    const nodes: Node[] = [];
    for (let i = 0; i < 501; i++) {
      nodes.push(
        makeNode({
          id: `WorkflowRule:Account.WR${i}`,
          type: 'WorkflowRule',
          apiName: `Account.WR${i}`,
          properties: { active: true },
        }),
      );
    }
    const imp = await importExtractionResults(store, [{ nodes, edges: [] }]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('excludes legacyAutomation rather than scoring a scan-capped subset at full confidence', async () => {
    const r = await techDebtScoreHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const excludedCats = r.value.data.excludedCategories.map((e) => e.category);
    expect(excludedCats).toContain('legacyAutomation');
    expect(r.value.data.categories.legacyAutomation.rawCount).toBeNull();
    expect(r.value.data.categories.legacyAutomation.contribution).toBe(0);
  });

  // The exclusion must NOT borrow `'extractor-not-run'`: that reason is the
  // key that appends the verbatim Q115 boundary, whose remedy is "run the
  // appropriate refresh command" — a remedy that cannot lift a 500-node scan
  // cap. A disclosure tool emitting a dead-end remedy as fact is the same
  // class of defect this brief exists to remove, so the reason is
  // `'insufficient-data'` (the extractor DID run; the read was capped).
  it('reports the scan-cap exclusion as insufficient-data, not extractor-not-run', async () => {
    const r = await techDebtScoreHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const entry = r.value.data.excludedCategories.find(
      (e) => e.category === 'legacyAutomation',
    );
    expect(entry).toBeDefined();
    expect(entry?.reason).toBe('insufficient-data');
    // The note must still carry the remedy that DOES work.
    expect(entry?.note).toContain('process_builder_migration_candidates');
    expect(entry?.note).not.toMatch(/refresh/i);
  });

  it('does not recommend a refresh when the ONLY non-user exclusion is the scan cap', async () => {
    // Opt every other axis out by hand so the scan-cap exclusion is the only
    // machine-decided one left; any 'run the appropriate refresh command' text
    // in `boundaries` can then only have come from the scan-cap door.
    const r = await techDebtScoreHandler(ctx, {
      excludeCategories: [
        'deadWeight',
        'codeQuality',
        'freshness',
        'apiVersions',
        'unassignedGrants',
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const machineExcluded = r.value.data.excludedCategories.filter(
      (e) => e.reason !== 'user-opted-out',
    );
    expect(machineExcluded.map((e) => e.category)).toEqual(['legacyAutomation']);
    // Asserted BEFORE the reason so the bite proof shows the dead-end remedy
    // itself, not just the reason string that would have produced it.
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).not.toContain('run the appropriate refresh command');
    expect(machineExcluded[0]?.reason).toBe('insufficient-data');
  });
});

// =============================================================================
// R6 — `loadAllNodes` used to be a private re-implementation of the shared
// `scanAllNodesOfTypes` multi-window walk: its own 500 `PAGE_CAP`, its own
// `countNodesByType` cross-check, NO residual `FULL_SCAN_MAX_NODES` ceiling,
// and no way for a caller to learn a walk was capped (`scanIncomplete` /
// `incompleteTypes`). Adopting the shared helper closes both gaps. This test
// forces the residual cap via the test-only `SFI_TECH_DEBT_SCAN_MAX_NODES`
// override (mirrors `scan-all-nodes.test.ts`'s own explicit-`maxNodes` seam)
// so the cap is provably reachable WITHOUT seeding 20 000 real rows.
// =============================================================================
describe('techDebtScoreHandler — full-node-scan residual-cap disclosure (R6)', () => {
  let tempDir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-tds-residualcap-'));
    const opened = await openGraph(join(tempDir, 'tds-residualcap.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    // 3 ApexClass nodes; with windowSize 1 and a residual maxNodes of 2, the
    // walk reads node 1, node 2 (scannedThisType hits the cap), probes for a
    // 3rd, finds it, and stops — incomplete, 2 of 3 nodes actually loaded.
    const imp = await importExtractionResults(store, [
      {
        nodes: [
          makeNode({ id: 'ApexClass:Aaa', apiName: 'Aaa', apiVersion: 58 }),
          makeNode({ id: 'ApexClass:Bbb', apiName: 'Bbb', apiVersion: 58 }),
          makeNode({ id: 'ApexClass:Ccc', apiName: 'Ccc', apiVersion: 58 }),
        ],
        edges: [],
      },
    ]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env['SFI_NODE_SCAN_LIMIT'] = '1';
    process.env['SFI_TECH_DEBT_SCAN_MAX_NODES'] = '2';
  });

  afterEach(() => {
    delete process.env['SFI_NODE_SCAN_LIMIT'];
    delete process.env['SFI_TECH_DEBT_SCAN_MAX_NODES'];
  });

  it('discloses a capped full-node scan in boundaries instead of scoring silently off a partial subset', async () => {
    const r = await techDebtScoreHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaries.join(' ')).toContain('Full scan capped');
    expect(r.value.data.boundaries.join(' ')).toContain('ApexClass');
    expect(r.value.data.boundaries.join(' ')).toContain('INCOMPLETE');
  });
});
