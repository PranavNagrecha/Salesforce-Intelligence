/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ExtractionResult,
  Node,
  VaultManifest,
} from '@sf-intelligence/contracts';
import {
  ACTIVE_HOLDERS_COMPLETE_SUBJECT,
  closeGraph,
  importExtractionResults,
  openGraph,
  writeFacts,
  type GraphStore,
} from '@sf-intelligence/graph';
import { computeSourceTreeHash } from '@sf-intelligence/vault';

import type { Context } from '../../src/server.js';
import { healthCheckHandler } from '../../src/tools/health-check.js';

const STALE_HASH = 'sha256:does-not-match-anything';

const baseManifest = (sourceTreeHash: string): VaultManifest => ({
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 1 },
  edges: {},
  sourceTreeHash,
  coverage: [
    {
      type: 'CustomObject',
      requested: true,
      retrieved: 1,
      errored: false,
      neverModeled: false,
    },
  ],
  coverageComputedAt: '2026-05-27T14:33:08Z',
});

/**
 * Seed a source tree with one file so `computeSourceTreeHash` has stable,
 * non-empty input. The exact content doesn't matter; only that two
 * invocations produce the same digest.
 */
const seedSourceTree = async (vaultRoot: string): Promise<string> => {
  const sourcePath = join(vaultRoot, 'source');
  await mkdir(sourcePath, { recursive: true });
  await writeFile(join(sourcePath, 'placeholder.txt'), 'health-check-seed');
  const hash = await computeSourceTreeHash(sourcePath);
  if (!hash.ok) throw new Error(`hash seeding failed: ${hash.error.message}`);
  return hash.value;
};

const openContext = async (
  vaultRoot: string,
  manifest: Context['manifest'],
): Promise<{ ctx: Context; store: GraphStore }> => {
  const opened = await openGraph(join(vaultRoot, 'graph.duckdb'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  return {
    ctx: { vaultRoot, manifest, graph: opened.value },
    store: opened.value,
  };
};

describe('healthCheckHandler: healthy', () => {
  let vaultRoot: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sfi-mcp-health-ok-'));
    const realHash = await seedSourceTree(vaultRoot);
    const built = await openContext(vaultRoot, baseManifest(realHash));
    ctx = built.ctx;
    store = built.store;
  });

  afterAll(async () => {
    await closeGraph(store);
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('reports healthy when every check passes', async () => {
    const result = await healthCheckHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.status).toBe('healthy');
    expect(result.value.data.issues).toEqual([]);
    expect(result.value.data.checks).toEqual({
      vaultExists: true,
      graphReadable: true,
      sourceHashMatches: true,
      uncoveredTypesOk: true,
      renderComplete: true,
    });
    expect(result.value.data.reason).toBeUndefined();
    expect(result.value.data.vaultHistory.enabled).toBe(false);
    expect(result.value.data.vaultHistory.enableHint).toContain('sfi vault git enable');
    expect(result.value.vaultState.sourceTreeHash).toBe(
      ctx.manifest.sourceTreeHash,
    );
  });
});

describe('healthCheckHandler: CR-P3-3 confirmed-empty vs unconfirmed-empty coverage', () => {
  let vaultRoot: string;
  let store: GraphStore;
  let realHash: string;

  beforeAll(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sfi-mcp-health-conf-'));
    realHash = await seedSourceTree(vaultRoot);
    const opened = await openGraph(join(vaultRoot, 'graph.duckdb'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    store = opened.value;
  });

  afterAll(async () => {
    await closeGraph(store);
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('stays healthy when an empty type is retrieveConfirmed (confirmed-empty == complete)', async () => {
    const ctx: Context = {
      vaultRoot,
      graph: store,
      manifest: {
        ...baseManifest(realHash),
        coverage: [
          { type: 'CustomObject', requested: true, retrieved: 1, errored: false, neverModeled: false, retrieveConfirmed: true },
          { type: 'SharingRule', requested: true, retrieved: 0, errored: false, neverModeled: false, retrieveConfirmed: true },
        ],
      },
    };
    const result = await healthCheckHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.status).toBe('healthy');
    expect(
      result.value.data.issues.some((i) => i.includes('coverage is partial')),
    ).toBe(false);
  });

  it('reports degraded when the same empty type is NOT retrieveConfirmed (honesty preserved)', async () => {
    const ctx: Context = {
      vaultRoot,
      graph: store,
      manifest: {
        ...baseManifest(realHash),
        coverage: [
          { type: 'CustomObject', requested: true, retrieved: 1, errored: false, neverModeled: false, retrieveConfirmed: true },
          { type: 'SharingRule', requested: true, retrieved: 0, errored: false, neverModeled: false },
        ],
      },
    };
    const result = await healthCheckHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.status).toBe('degraded');
    expect(
      result.value.data.issues.some(
        (i) => i.includes('coverage is partial') && i.includes('SharingRule'),
      ),
    ).toBe(true);
  });
});

describe('healthCheckHandler: staged build in progress (P13-STAGED-tiers)', () => {
  let vaultRoot: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sfi-mcp-health-staged-'));
    const realHash = await seedSourceTree(vaultRoot);
    const built = await openContext(vaultRoot, {
      ...baseManifest(realHash),
      staged: { tier: 1, totalTiers: 3, pendingTypes: ['RemoteSiteSetting', 'Report'] },
    });
    ctx = built.ctx;
    store = built.store;
  });

  afterAll(async () => {
    await closeGraph(store);
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('reports degraded with explicit tier progress while the marker is present', async () => {
    const result = await healthCheckHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.status).toBe('degraded');
    const stagedIssue = result.value.data.issues.find((i) =>
      i.includes('building tier 1/3'),
    );
    expect(stagedIssue).toBeDefined();
    expect(stagedIssue).toContain('2 metadata type(s) still queued');
    expect(stagedIssue).toContain('absence claims');
  });
});

describe('healthCheckHandler: stale source-tree hash', () => {
  let vaultRoot: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sfi-mcp-health-stale-'));
    await seedSourceTree(vaultRoot);
    // Manifest carries a hash that cannot match the seeded tree.
    const built = await openContext(vaultRoot, baseManifest(STALE_HASH));
    ctx = built.ctx;
    store = built.store;
  });

  afterAll(async () => {
    await closeGraph(store);
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('reports degraded with a hash-mismatch issue when source/ differs', async () => {
    const result = await healthCheckHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.status).toBe('degraded');
    expect(result.value.data.checks.graphReadable).toBe(true);
    expect(result.value.data.checks.sourceHashMatches).toBe(false);
    expect(
      result.value.data.issues.some((issue) =>
        issue.includes('source-tree hash mismatch'),
      ),
    ).toBe(true);
  });
});

describe('healthCheckHandler: source/ directory missing', () => {
  let vaultRoot: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sfi-mcp-health-nosrc-'));
    // No source/ subdirectory — typical for a freshly-cloned vault where
    // `source/` is gitignored. The check should skip rather than fail.
    const built = await openContext(vaultRoot, baseManifest(STALE_HASH));
    ctx = built.ctx;
    store = built.store;
  });

  afterAll(async () => {
    await closeGraph(store);
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('reports degraded with a "source/ missing" issue and a null hash check', async () => {
    const result = await healthCheckHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.status).toBe('degraded');
    expect(result.value.data.checks.graphReadable).toBe(true);
    expect(result.value.data.checks.sourceHashMatches).toBeNull();
    expect(
      result.value.data.issues.some((issue) =>
        issue.includes('source/ directory missing'),
      ),
    ).toBe(true);
  });
});

describe('healthCheckHandler: uncovered metadata types', () => {
  let vaultRoot: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sfi-mcp-health-skipped-'));
    const realHash = await seedSourceTree(vaultRoot);
    // Manifest carries a skip-counter above the degraded threshold
    // (100 files). This is the architectural-bug-fix observability
    // path: a clean source tree + closed graph + a populated
    // `skippedDirectories` map should still flip the verdict to
    // degraded so MCP clients can warn the operator that the vault
    // is missing coverage.
    const manifest = {
      ...baseManifest(realHash),
      skippedDirectories: { omniProcesses: 244, omniDataTransforms: 201 },
    };
    const built = await openContext(vaultRoot, manifest);
    ctx = built.ctx;
    store = built.store;
  });

  afterAll(async () => {
    await closeGraph(store);
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('reports degraded with reason "uncovered-types-detected" when skip count exceeds threshold', async () => {
    const result = await healthCheckHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.status).toBe('degraded');
    expect(result.value.data.reason).toBe('uncovered-types-detected');
    expect(result.value.data.checks.uncoveredTypesOk).toBe(false);
    expect(
      result.value.data.issues.some((issue) =>
        issue.includes('vault skipped'),
      ),
    ).toBe(true);
    expect(
      result.value.data.issues.some((issue) =>
        issue.includes('sfi status --skipped'),
      ),
    ).toBe(true);
  });
});

describe('healthCheckHandler: trivial skips below threshold', () => {
  let vaultRoot: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sfi-mcp-health-trivial-skips-'));
    const realHash = await seedSourceTree(vaultRoot);
    // A tiny number of skips (e.g. a stray `.DS_Store` directory)
    // should NOT trip the indicator — the threshold (100) keeps
    // noise from creating false-positive degraded states.
    const manifest = {
      ...baseManifest(realHash),
      skippedDirectories: { strayDir: 3 },
    };
    const built = await openContext(vaultRoot, manifest);
    ctx = built.ctx;
    store = built.store;
  });

  afterAll(async () => {
    await closeGraph(store);
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('stays healthy when skip count is at or below threshold', async () => {
    const result = await healthCheckHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.status).toBe('healthy');
    expect(result.value.data.checks.uncoveredTypesOk).toBe(true);
    expect(result.value.data.reason).toBeUndefined();
  });
});

describe('healthCheckHandler: pre-counter manifest back-compat', () => {
  let vaultRoot: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sfi-mcp-health-back-compat-'));
    const realHash = await seedSourceTree(vaultRoot);
    // Manifest missing `skippedDirectories` entirely — mirrors
    // vaults built before the architectural-bug fix shipped. The
    // handler must treat the missing field as the empty map, not
    // crash, and report healthy.
    const built = await openContext(vaultRoot, baseManifest(realHash));
    ctx = built.ctx;
    store = built.store;
  });

  afterAll(async () => {
    await closeGraph(store);
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('handles a missing skippedDirectories field as empty and stays healthy', async () => {
    const result = await healthCheckHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.status).toBe('healthy');
    expect(result.value.data.checks.uncoveredTypesOk).toBe(true);
  });
});

describe('healthCheckHandler: freshness nudge', () => {
  let vaultRoot: string;
  let store: GraphStore;
  let ctx: Context;
  let realHash: string;

  // The base manifest's refreshedAt is 2026-05-27T14:33:08Z. Anchor a fixed
  // clock so the age math is deterministic regardless of wall time.
  const refreshedMs = Date.parse('2026-05-27T14:33:08Z');
  const DAY = 24 * 60 * 60 * 1000;

  beforeAll(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sfi-mcp-health-fresh-'));
    realHash = await seedSourceTree(vaultRoot);
    const built = await openContext(vaultRoot, baseManifest(realHash));
    ctx = built.ctx;
    store = built.store;
  });

  afterAll(async () => {
    await closeGraph(store);
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('always reports a freshness block carrying the manifest refreshedAt', async () => {
    const result = await healthCheckHandler(ctx, {}, refreshedMs + 1 * DAY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.freshness.refreshedAt).toBe(
      ctx.manifest.refreshedAt,
    );
  });

  it('stays fresh (no nudge) when the vault is under a week old', async () => {
    const result = await healthCheckHandler(ctx, {}, refreshedMs + 3 * DAY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.freshness.ageDays).toBe(3);
    expect(result.value.data.freshness.stale).toBe(false);
    expect(result.value.data.freshness.nudge).toBeNull();
    // A fresh-but-healthy vault must not be downgraded by the nudge.
    expect(result.value.data.status).toBe('healthy');
  });

  it('flags stale + emits a /sfi-refresh nudge once the vault is a week old', async () => {
    const result = await healthCheckHandler(ctx, {}, refreshedMs + 9 * DAY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.freshness.ageDays).toBe(9);
    expect(result.value.data.freshness.stale).toBe(true);
    expect(result.value.data.freshness.nudge).toContain('/sfi-refresh');
    expect(result.value.data.freshness.nudge).toContain('9 days ago');
    // Age is advisory: it must NOT change the aggregate status.
    expect(result.value.data.status).toBe('healthy');
  });

  it('reports availability:false for a vault with no refresh history', async () => {
    const result = await healthCheckHandler(ctx, {}, refreshedMs + 1 * DAY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.freshness.lastRefresh.available).toBe(false);
    expect(result.value.data.freshness.lastRefresh.componentsChanged).toBe(0);
  });

  it('emits no plugin-update clause when no update check is injected', async () => {
    // A fresh vault + no injected update result → completely quiet nudge.
    const result = await healthCheckHandler(ctx, {}, refreshedMs + 3 * DAY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.freshness.nudge).toBeNull();
  });

  it('appends an advisory npm-update clause when an update is confirmed (status unchanged)', async () => {
    // Fresh vault so the ONLY nudge clause is the plugin-update one.
    const result = await healthCheckHandler(ctx, {}, refreshedMs + 3 * DAY, {
      shouldUpdate: true,
      latestVersion: '9.9.9',
      cached: false,
      error: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.freshness.nudge).toContain('9.9.9');
    expect(result.value.data.freshness.nudge).toContain(
      'npm i -g sf-intelligence@latest',
    );
    // The npm update is advisory — it must never change the aggregate status,
    // and it must not falsely flag the vault snapshot as stale.
    expect(result.value.data.status).toBe('healthy');
    expect(result.value.data.freshness.stale).toBe(false);
  });

  it('adds no update clause when the injected check reports no update', async () => {
    const result = await healthCheckHandler(ctx, {}, refreshedMs + 3 * DAY, {
      shouldUpdate: false,
      latestVersion: '0.1.0',
      cached: true,
      error: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.freshness.nudge).toBeNull();
  });
});

describe('healthCheckHandler: offline vault-version nudge', () => {
  // baseManifest is built by version '0.1.0'. When the RUNNING plugin
  // (SFI_PLUGIN_VERSION, set by `sfi mcp` at startup) is newer, health_check
  // advises a re-refresh — purely offline, no network. The env is set inside
  // each test and cleared afterwards so it can never leak into the sibling
  // `nudge === null` assertions above.
  let vaultRoot: string;
  let store: GraphStore;
  let ctx: Context;

  const refreshedMs = Date.parse('2026-05-27T14:33:08Z');
  const DAY = 24 * 60 * 60 * 1000;
  const PLUGIN_ENV = 'SFI_PLUGIN_VERSION';

  beforeAll(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sfi-mcp-health-vaultver-'));
    const realHash = await seedSourceTree(vaultRoot);
    const built = await openContext(vaultRoot, baseManifest(realHash));
    ctx = built.ctx;
    store = built.store;
  });

  afterAll(async () => {
    await closeGraph(store);
    await rm(vaultRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env[PLUGIN_ENV];
  });

  it('nudges to /sfi-refresh when the running plugin is newer than the vault builder', async () => {
    process.env[PLUGIN_ENV] = '0.2.0';
    // Fresh vault (no age nudge) so the ONLY clause is the vault-version one.
    const result = await healthCheckHandler(ctx, {}, refreshedMs + 3 * DAY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const nudge = result.value.data.freshness.nudge;
    expect(nudge).toContain('built by sf-intelligence 0.1.0');
    expect(nudge).toContain('0.2.0');
    expect(nudge).toContain('/sfi-refresh');
    // Advisory only — an out-of-date builder must not fail the vault.
    expect(result.value.data.status).toBe('healthy');
    expect(result.value.data.freshness.stale).toBe(false);
  });

  it('stays quiet when the running plugin matches the vault builder version', async () => {
    process.env[PLUGIN_ENV] = '0.1.0';
    const result = await healthCheckHandler(ctx, {}, refreshedMs + 3 * DAY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.freshness.nudge).toBeNull();
  });

  it('stays quiet when the running plugin is OLDER than the vault builder', async () => {
    // A downgrade must not nag — only a newer plugin implies missing extraction.
    process.env[PLUGIN_ENV] = '0.0.9';
    const result = await healthCheckHandler(ctx, {}, refreshedMs + 3 * DAY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.freshness.nudge).toBeNull();
  });

  it('stays quiet when SFI_PLUGIN_VERSION is unset (non-`sfi mcp` callers)', async () => {
    delete process.env[PLUGIN_ENV];
    const result = await healthCheckHandler(ctx, {}, refreshedMs + 3 * DAY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.freshness.nudge).toBeNull();
  });
});

describe('healthCheckHandler: freshness nudge counts the last refresh + flags source drift', () => {
  let vaultRoot: string;
  let store: GraphStore;
  let ctx: Context;

  const refreshedMs = Date.parse('2026-05-27T14:33:08Z');
  const DAY = 24 * 60 * 60 * 1000;

  beforeAll(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sfi-mcp-health-fresh-hist-'));
    await seedSourceTree(vaultRoot);
    // Write a two-line history log: the LAST refresh added 4 CustomFields and
    // removed 1 Flow → 5 components changed.
    const metaDir = join(vaultRoot, 'meta');
    await mkdir(metaDir, { recursive: true });
    const lines = [
      JSON.stringify({
        refreshedAt: '2026-05-20T10:00:00Z',
        sourceTreeHash: 'sha256:older',
        sourceTreeHashChanged: true,
        componentDeltas: {},
        edgeDeltas: {},
        totalComponents: 10,
      }),
      JSON.stringify({
        refreshedAt: '2026-05-27T14:33:08Z',
        sourceTreeHash: 'sha256:newer',
        sourceTreeHashChanged: true,
        componentDeltas: { CustomField: 4, Flow: -1 },
        edgeDeltas: {},
        totalComponents: 13,
      }),
    ];
    await writeFile(join(metaDir, 'history.jsonl'), `${lines.join('\n')}\n`);
    // STALE_HASH guarantees a source-drift mismatch on top of the history.
    const built = await openContext(vaultRoot, baseManifest(STALE_HASH));
    ctx = built.ctx;
    store = built.store;
  });

  afterAll(async () => {
    await closeGraph(store);
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('counts 5 components changed at the last refresh and surfaces a source-drift nudge', async () => {
    const result = await healthCheckHandler(ctx, {}, refreshedMs + 2 * DAY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.freshness.lastRefresh.available).toBe(true);
    expect(result.value.data.freshness.lastRefresh.componentsChanged).toBe(5);
    // Source drift produces a nudge even when the vault is otherwise young.
    expect(result.value.data.freshness.stale).toBe(false);
    expect(result.value.data.freshness.nudge).toContain('source-tree hash mismatch');
    expect(result.value.data.freshness.nudge).toContain('sfi refresh --no-pull');
  });
});

describe('healthCheckHandler: graph unreadable', () => {
  let vaultRoot: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sfi-mcp-health-nograph-'));
    const realHash = await seedSourceTree(vaultRoot);
    const built = await openContext(vaultRoot, baseManifest(realHash));
    ctx = built.ctx;
    store = built.store;
    // Close the graph before the test runs: subsequent queries fail.
    await closeGraph(store);
  });

  afterAll(async () => {
    // Graph already closed in beforeAll; rmSync would double-close.
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('reports unhealthy with a graph-related issue when the graph is closed', async () => {
    const result = await healthCheckHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.status).toBe('unhealthy');
    expect(result.value.data.checks.graphReadable).toBe(false);
    expect(
      result.value.data.issues.some((issue) =>
        issue.startsWith('graph query'),
      ),
    ).toBe(true);
  });
});

describe('healthCheckHandler: partially-rendered vault (graph/vault desync)', () => {
  let vaultRoot: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sfi-mcp-health-desync-'));
    const realHash = await seedSourceTree(vaultRoot);
    // The manifest records only ONE CustomObject (as if rendered by older,
    // pre-pagination code), but the graph below holds three. That mismatch is
    // the desync: the resolver would offer Bbb__c / Ccc__c, but their .md
    // files were never written, so get_component fails with "vault file
    // missing". Regression for the adversarial-Q&A finding.
    const built = await openContext(vaultRoot, {
      ...baseManifest(realHash),
      components: { CustomObject: 1 },
    });
    ctx = built.ctx;
    store = built.store;
    const node = (id: string, apiName: string): Node => ({
      id,
      type: 'CustomObject',
      apiName,
      label: null,
      parentId: null,
      sourcePath: 'x',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: {},
    });
    const seed: ExtractionResult = {
      nodes: [
        node('CustomObject:Aaa__c', 'Aaa__c'),
        node('CustomObject:Bbb__c', 'Bbb__c'),
        node('CustomObject:Ccc__c', 'Ccc__c'),
      ],
      edges: [],
    };
    const imp = await importExtractionResults(store, [seed]);
    if (!imp.ok) throw new Error(`seed import failed: ${imp.error.message}`);
  });

  afterAll(async () => {
    await closeGraph(store);
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('flags renderComplete=false and degrades when the graph holds more nodes than the manifest records', async () => {
    const result = await healthCheckHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.checks.renderComplete).toBe(false);
    expect(result.value.data.status).toBe('degraded');
    expect(
      result.value.data.issues.some(
        (i) => i.includes('partially rendered') && i.includes('/sfi-refresh'),
      ),
    ).toBe(true);
  });

  it('still confirms the OTHER checks pass (so the desync is isolated)', async () => {
    const result = await healthCheckHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.checks.graphReadable).toBe(true);
    expect(result.value.data.checks.sourceHashMatches).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ENGINE-ARC §6 — the informational assignmentData block: runtime assignment
// data is live-first BY DESIGN, so it never degrades status.
// ---------------------------------------------------------------------------

describe('healthCheckHandler: assignmentData block (informational only)', () => {
  let vaultRoot: string;
  let store: GraphStore;
  let ctx: Context;
  const savedConsent = process.env['SFI_CONSENT_PATH'];
  const savedLive = process.env['SFI_LIVE_PLANE_ENABLED'];

  beforeAll(async () => {
    process.env['SFI_CONSENT_PATH'] = '/tmp/sfi-nonexistent-consent/none.json';
    delete process.env['SFI_LIVE_PLANE_ENABLED'];
    vaultRoot = await mkdtemp(join(tmpdir(), 'sfi-mcp-health-assign-'));
    const realHash = await seedSourceTree(vaultRoot);
    const built = await openContext(vaultRoot, baseManifest(realHash));
    ctx = built.ctx;
    store = built.store;
  });

  afterAll(async () => {
    if (savedConsent === undefined) delete process.env['SFI_CONSENT_PATH'];
    else process.env['SFI_CONSENT_PATH'] = savedConsent;
    if (savedLive === undefined) delete process.env['SFI_LIVE_PLANE_ENABLED'];
    else process.env['SFI_LIVE_PLANE_ENABLED'] = savedLive;
    await closeGraph(store);
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('carries the block without degrading status — missing assignment data is by-design', async () => {
    const result = await healthCheckHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The vault has NO assignment data and NO facts capture — and the verdict
    // must still be healthy, with zero issues. Not a retrieval failure.
    expect(result.value.data.status).toBe('healthy');
    expect(result.value.data.issues).toEqual([]);

    const ad = result.value.data.assignmentData;
    expect(ad.vaultModeled).toBe(false);
    expect(ad.reason).toBe('runtime data object — by design, not a retrieve gap');
    expect(ad.liveTools).toEqual([
      'sfi.live_permset_holders',
      'sfi.live_user_permsets',
      'sfi.live_group_members',
      'sfi.live_zombie_accounts',
    ]);
    expect(ad.factsCounts).toEqual({ present: false, capturedAt: null });
    // No capture at all → no stale-facts advisory (absence is not staleness).
    expect(ad.advisory).toBeNull();
  });
});

describe('healthCheckHandler: stale assignment-facts advisory (>30d, advisory only)', () => {
  let vaultRoot: string;
  let store: GraphStore;
  let ctx: Context;
  const savedConsent = process.env['SFI_CONSENT_PATH'];

  beforeAll(async () => {
    process.env['SFI_CONSENT_PATH'] = '/tmp/sfi-nonexistent-consent/none.json';
    vaultRoot = await mkdtemp(join(tmpdir(), 'sfi-mcp-health-facts-'));
    const realHash = await seedSourceTree(vaultRoot);
    const built = await openContext(vaultRoot, baseManifest(realHash));
    ctx = built.ctx;
    store = built.store;
    // Seed a COMPLETE counts capture 40 days before the injected `now`.
    const wrote = await writeFacts(store, [
      {
        subjectId: ACTIVE_HOLDERS_COMPLETE_SUBJECT,
        metric: 'activeHolders',
        value: { complete: true },
        capturedAt: '2026-05-23T00:00:00.000Z',
        method: 'aggregate-soql',
        source: 'refresh-with-data-shape',
      },
    ]);
    if (!wrote.ok) throw new Error(`writeFacts failed: ${wrote.error.message}`);
  });

  afterAll(async () => {
    if (savedConsent === undefined) delete process.env['SFI_CONSENT_PATH'];
    else process.env['SFI_CONSENT_PATH'] = savedConsent;
    await closeGraph(store);
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('emits the re-capture advisory without touching status or issues', async () => {
    const now = Date.parse('2026-07-02T00:00:00.000Z'); // 40 days after capture
    const result = await healthCheckHandler(ctx, {}, now);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ad = result.value.data.assignmentData;
    expect(ad.factsCounts.present).toBe(true);
    expect(ad.factsCounts.capturedAt).toBe('2026-05-23T00:00:00.000Z');
    expect(ad.advisory).toContain('40 days old');
    expect(ad.advisory).toContain('--with-data-shape');
    // Advisory ONLY: the stale snapshot must not appear in issues[] (which
    // would flip status to degraded) — assignment data is live-first.
    expect(result.value.data.issues.join(' ')).not.toContain('--with-data-shape');
  });

  it('stays silent when the capture is fresh (<30d)', async () => {
    const now = Date.parse('2026-06-01T00:00:00.000Z'); // 9 days after capture
    const result = await healthCheckHandler(ctx, {}, now);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.assignmentData.advisory).toBeNull();
  });
});
