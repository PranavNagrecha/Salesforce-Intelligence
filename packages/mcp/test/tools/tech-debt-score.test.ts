/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
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
