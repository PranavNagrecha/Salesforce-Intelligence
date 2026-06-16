/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openGraph, closeGraph } from '@sf-intelligence/graph';
import { loadManifest, vaultPaths, type ExtendedVaultManifest } from '@sf-intelligence/vault';

import { runRefresh, type RefreshResult, type RunRefreshOptions } from '../src/commands/refresh.js';
import {
  captureSkeletonCounts,
  readStagedState,
  runStagedRefresh,
  stagedTierPlan,
  TIER1_PRIORITY_TYPES,
  type SkeletonExecutors,
} from '../src/commands/staged-refresh.js';
import { SUPPORTED_TYPES } from '../src/refresh-pipeline.js';

/**
 * P13-STAGED-tiers — planner, driver sequencing/resumability, T0 skeleton
 * honesty, mid-T2 failure injection (T1 state stays servable), and the
 * convergence oracle: staged final graph ≡ monolithic refresh, byte-identical.
 */

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'sfi-staged-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const seedVaultConfig = async (): Promise<string> => {
  const vaultRoot = join(cwd, 'org-kb');
  const paths = vaultPaths(vaultRoot);
  await mkdir(paths.meta, { recursive: true });
  await mkdir(join(paths.source, 'main', 'default', 'classes'), { recursive: true });
  await writeFile(
    paths.config,
    JSON.stringify({
      targetOrg: 'test',
      vaultRoot,
      version: '0.1.0',
      snapshotOnRefresh: false,
      createdAt: '2026-06-04T00:00:00.000Z',
    }),
    'utf8',
  );
  return vaultRoot;
};

const writeClass = async (vaultRoot: string, name: string, body: string): Promise<void> => {
  const dir = join(vaultPaths(vaultRoot).source, 'main', 'default', 'classes');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.cls`), body, 'utf8');
  await writeFile(
    join(dir, `${name}.cls-meta.xml`),
    `<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>60.0</apiVersion>
  <status>Active</status>
</ApexClass>
`,
    'utf8',
  );
};

/** A tier-2-remainder type so staged T1 (priority only) provably differs from T2. */
const writeRemoteSite = async (vaultRoot: string, name: string): Promise<void> => {
  const dir = join(vaultPaths(vaultRoot).source, 'main', 'default', 'remoteSiteSettings');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${name}.remoteSite-meta.xml`),
    `<?xml version="1.0" encoding="UTF-8"?>
<RemoteSiteSetting xmlns="http://soap.sforce.com/2006/04/metadata">
  <url>https://example.com/${name}</url>
  <isActive>true</isActive>
  <disableProtocolSecurity>false</disableProtocolSecurity>
</RemoteSiteSetting>
`,
    'utf8',
  );
};

/** Deterministic full-graph dump — the staged-vs-monolithic equivalence oracle. */
const dumpGraph = async (vaultRoot: string): Promise<string> => {
  const opened = await openGraph(vaultPaths(vaultRoot).graphDb);
  if (!opened.ok) throw new Error(opened.error.message);
  try {
    const q = async (sql: string): Promise<readonly Record<string, unknown>[]> =>
      (await opened.value.connection.runAndReadAll(sql)).getRowObjectsJS() as readonly Record<
        string,
        unknown
      >[];
    const nodes = await q(
      `SELECT id, type, api_name, label, parent_id, source_path,
              last_modified_date, last_modified_by, api_version, properties_json
       FROM nodes ORDER BY id`,
    );
    const edges = await q(
      `SELECT from_id, to_id, edge_type, confidence, source, properties_json
       FROM edges ORDER BY from_id, to_id, edge_type, source`,
    );
    return JSON.stringify({ nodes, edges });
  } finally {
    await closeGraph(opened.value);
  }
};

const okResult = (): RefreshResult => ({
  status: 'success',
  counts: { components: {}, edges: {} },
  errors: [],
  durationMs: 1,
  skippedDirectories: {},
});

describe('stagedTierPlan (planner)', () => {
  it('T1 is the §G10 priority list; T2 remainder completes the roster disjointly', () => {
    const plan = stagedTierPlan();
    expect(plan.tier1Types).toEqual(TIER1_PRIORITY_TYPES);
    // disjoint
    for (const t of plan.tier2PendingTypes) {
      expect(plan.tier1Types).not.toContain(t);
    }
    // complete: T1 ∪ T2 === SUPPORTED_TYPES
    const union = new Set([...plan.tier1Types, ...plan.tier2PendingTypes]);
    expect(union.size).toBe(SUPPORTED_TYPES.length);
    for (const t of SUPPORTED_TYPES) expect(union.has(t)).toBe(true);
  });

  it('every priority type is a real supported type', () => {
    for (const t of TIER1_PRIORITY_TYPES) {
      expect(SUPPORTED_TYPES as readonly string[]).toContain(t);
    }
  });
});

describe('captureSkeletonCounts (T0 read-only queries)', () => {
  const auth = {
    instanceUrl: 'https://org.example',
    accessToken: 'tok',
    apiVersion: '62.0',
  };

  it('parses COUNT() totalSize per entity and routes tooling vs data endpoints', async () => {
    const urls: string[] = [];
    const execs: SkeletonExecutors = {
      getAuth: async () => ({ ok: true, value: auth }),
      restGet: async (_a, url) => {
        urls.push(url);
        return { ok: true, value: { totalSize: 42, records: [] } };
      },
    };
    const counts = await captureSkeletonCounts('test', execs);
    expect(counts).toEqual({
      ApexClass: 42,
      ApexTrigger: 42,
      Flow: 42,
      Profile: 42,
      PermissionSet: 42,
    });
    expect(urls.filter((u) => u.includes('/tooling/query')).length).toBe(3);
    expect(urls.filter((u) => !u.includes('/tooling/')).length).toBe(2);
    // READ-ONLY by construction: every call is a GET of a COUNT() query.
    for (const u of urls) expect(u).toContain(encodeURIComponent('SELECT COUNT() FROM'));
  });

  it('auth failure and per-query failures degrade to partial/empty counts', async () => {
    const noAuth: SkeletonExecutors = {
      getAuth: async () => ({ ok: false, error: { message: 'no org' } }),
      restGet: async () => ({ ok: true, value: { totalSize: 1 } }),
    };
    expect(await captureSkeletonCounts('test', noAuth)).toEqual({});

    let i = 0;
    const flaky: SkeletonExecutors = {
      getAuth: async () => ({ ok: true, value: auth }),
      restGet: async () => {
        i += 1;
        return i === 1
          ? { ok: true, value: { totalSize: 7 } }
          : { ok: false, error: { message: 'REST 500' } };
      },
    };
    expect(await captureSkeletonCounts('test', flaky)).toEqual({ ApexClass: 7 });
  });
});

describe('driver sequencing + T0 skeleton honesty', () => {
  it('fresh run: T0 writes skeleton manifest/card, T1 is scoped+deferred-render, T2 is side-build, state cleared', async () => {
    const vaultRoot = await seedVaultConfig();
    const calls: RunRefreshOptions[] = [];
    const r = await runStagedRefresh({
      cwd,
      noPull: true,
      refreshFn: async (o) => {
        calls.push(o);
        return okResult();
      },
      onProgress: () => {},
    });
    expect(r.result.status).toBe('success');
    expect(r.tiersRun).toEqual(['t0', 't1', 't2']);

    expect(calls.length).toBe(2);
    const [t1, t2] = calls as [RunRefreshOptions, RunRefreshOptions];
    expect(t1.types).toBe(TIER1_PRIORITY_TYPES.join(','));
    expect(t1.skipRender).toBe(true);
    expect(t1.stagedMarker).toEqual({
      tier: 1,
      totalTiers: 3,
      pendingTypes: stagedTierPlan().tier2PendingTypes,
    });
    expect(t2.types).toBeUndefined();
    expect(t2.forceSideBuild).toBe(true);
    expect(t2.stagedMarker).toBeUndefined(); // final tier clears the marker

    // state file removed on success
    expect(await readStagedState(vaultPaths(vaultRoot).meta)).toBeNull();
  });

  it('T0 skeleton manifest: all-pending coverage + staged tier 0; card is partial:true', async () => {
    const vaultRoot = await seedVaultConfig();
    // fail T1 so the run stops with T0's artifacts on disk
    const r = await runStagedRefresh({
      cwd,
      noPull: true,
      refreshFn: async () => ({ ...okResult(), status: 'failed', fatalError: 'boom' }),
      onProgress: () => {},
    });
    expect(r.result.status).toBe('failed');

    const manifest = await loadManifest(vaultRoot);
    if (!manifest.ok) throw new Error('skeleton manifest missing');
    const m = manifest.value;
    expect(m.staged).toEqual({
      tier: 0,
      totalTiers: 3,
      pendingTypes: [...SUPPORTED_TYPES],
    });
    expect(m.components).toEqual({});
    const coverage = m.coverage ?? [];
    expect(coverage.length).toBe(SUPPORTED_TYPES.length);
    for (const row of coverage) {
      expect(row.pending).toBe(true);
      expect(row.retrieved).toBe(0); // absence caveats keep firing
    }

    const card = JSON.parse(
      await readFile(join(vaultPaths(vaultRoot).meta, 'org-card.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(card['partial']).toBe(true);
    expect(card['staged']).toEqual({ tier: 0, totalTiers: 3 });

    // T0 completed → resumable state retained
    const state = await readStagedState(vaultPaths(vaultRoot).meta);
    expect(state?.completedTiers).toEqual(['t0']);
  });

  it('an existing manifest is NOT clobbered by T0 — counts survive, marker added', async () => {
    const vaultRoot = await seedVaultConfig();
    const existing: ExtendedVaultManifest = {
      version: '0.1.0',
      refreshedAt: '2026-06-01T00:00:00.000Z',
      sourceOrg: 'test',
      components: { ApexClass: 7 },
      edges: {},
      sourceTreeHash: 'abc',
    };
    const { saveManifest } = await import('@sf-intelligence/vault');
    await saveManifest(vaultRoot, existing);

    await runStagedRefresh({
      cwd,
      noPull: true,
      refreshFn: async () => ({ ...okResult(), status: 'failed', fatalError: 'stop after t0' }),
      onProgress: () => {},
    });
    const after = await loadManifest(vaultRoot);
    if (!after.ok) throw new Error('manifest unreadable');
    expect(after.value.components).toEqual({ ApexClass: 7 }); // preserved
    expect(after.value.staged?.tier).toBe(0);
  });

  it('resume skips completed tiers; --with-reports adds T3 and keeps a marker on T2', async () => {
    const vaultRoot = await seedVaultConfig();
    const meta = vaultPaths(vaultRoot).meta;
    await writeFile(
      join(meta, 'staged-refresh.json'),
      JSON.stringify({
        version: 1,
        startedAt: '2026-06-10T00:00:00.000Z',
        targetOrg: 'test',
        completedTiers: ['t0', 't1'],
      }),
      'utf8',
    );
    const calls: RunRefreshOptions[] = [];
    const r = await runStagedRefresh({
      cwd,
      noPull: true,
      withReports: true,
      refreshFn: async (o) => {
        calls.push(o);
        return okResult();
      },
      onProgress: () => {},
    });
    expect(r.result.status).toBe('success');
    expect(r.tiersSkipped).toEqual(['t0', 't1']);
    expect(r.tiersRun).toEqual(['t2', 't3']);
    const [t2, t3] = calls as [RunRefreshOptions, RunRefreshOptions];
    // with a T3 queued, T2 keeps the marker (pendingTypes empty) so health stays honest
    expect(t2.stagedMarker).toEqual({ tier: 2, totalTiers: 4, pendingTypes: [] });
    expect(t3.withReports).toBe(true);
    expect(t3.stagedMarker).toBeUndefined();
  });
});

describe('failure injection + convergence (real pipeline, fixture vault)', () => {
  it('mid-T2 failure leaves the T1 graph servable; resume converges; staged ≡ monolithic byte-identical', async () => {
    // Two identical vaults: A gets a monolithic refresh, B the staged path.
    const vaultRootB = await seedVaultConfig();
    await writeClass(vaultRootB, 'Alpha', 'public class Alpha { public void go() {} }');
    await writeRemoteSite(vaultRootB, 'LegacyApi');

    const cwdA = await mkdtemp(join(tmpdir(), 'sfi-staged-mono-'));
    try {
      const vaultRootA = join(cwdA, 'org-kb');
      const pathsA = vaultPaths(vaultRootA);
      await mkdir(pathsA.meta, { recursive: true });
      await writeFile(
        pathsA.config,
        JSON.stringify({
          targetOrg: 'test',
          vaultRoot: vaultRootA,
          version: '0.1.0',
          snapshotOnRefresh: false,
          createdAt: '2026-06-04T00:00:00.000Z',
        }),
        'utf8',
      );
      await writeClass(vaultRootA, 'Alpha', 'public class Alpha { public void go() {} }');
      await writeRemoteSite(vaultRootA, 'LegacyApi');

      // --- monolithic reference ---
      const mono = await runRefresh({ cwd: cwdA, noPull: true });
      expect(mono.status).toBe('success');

      // --- staged run with an injected mid-T2 death ---
      let t2Attempts = 0;
      const failing = await runStagedRefresh({
        cwd,
        noPull: true,
        refreshFn: async (o) => {
          if (o.forceSideBuild === true) {
            t2Attempts += 1;
            return { ...okResult(), status: 'failed', fatalError: 'killed mid-T2' };
          }
          return runRefresh(o); // T1 runs for real
        },
        onProgress: () => {},
      });
      expect(t2Attempts).toBe(1);
      expect(failing.result.status).toBe('failed');

      // T1 state is SERVABLE: graph holds the priority types, manifest is
      // honest (staged tier 1, remainder pending), and the T2-remainder
      // RemoteSiteSetting is NOT in the graph yet.
      const t1Dump = JSON.parse(await dumpGraph(vaultRootB)) as {
        nodes: readonly { id: string }[];
      };
      expect(t1Dump.nodes.some((n) => n.id.startsWith('ApexClass:Alpha'))).toBe(true);
      expect(t1Dump.nodes.some((n) => n.id.startsWith('RemoteSiteSetting:'))).toBe(false);
      const midManifest = await loadManifest(vaultRootB);
      if (!midManifest.ok) throw new Error('mid-build manifest unreadable');
      expect(midManifest.value.staged?.tier).toBe(1);
      const pendingRows = (midManifest.value.coverage ?? []).filter((c) => c.pending === true);
      expect(pendingRows.map((c) => c.type)).toContain('RemoteSiteSetting');
      // no side-build leftover was renamed over the live graph
      const state = await readStagedState(vaultPaths(vaultRootB).meta);
      expect(state?.completedTiers).toEqual(['t0', 't1']);

      // --- resume with the real pipeline: only T2 runs, then converges ---
      const resumed = await runStagedRefresh({ cwd, noPull: true, onProgress: () => {} });
      expect(resumed.result.status).toBe('success');
      expect(resumed.tiersSkipped).toEqual(['t0', 't1']);

      // Convergence oracle: byte-identical graphs, marker cleared, coverage clean.
      expect(await dumpGraph(vaultRootB)).toBe(await dumpGraph(vaultRootA));
      const finalManifest = await loadManifest(vaultRootB);
      if (!finalManifest.ok) throw new Error('final manifest unreadable');
      expect(finalManifest.value.staged).toBeUndefined();
      expect((finalManifest.value.coverage ?? []).every((c) => c.pending !== true)).toBe(true);
      const monoManifest = await loadManifest(join(cwdA, 'org-kb'));
      if (!monoManifest.ok) throw new Error('monolithic manifest unreadable');
      expect(finalManifest.value.components).toEqual(monoManifest.value.components);
      expect(finalManifest.value.edges).toEqual(monoManifest.value.edges);
      expect(finalManifest.value.sourceTreeHash).toBe(monoManifest.value.sourceTreeHash);
    } finally {
      await rm(cwdA, { recursive: true, force: true });
    }
  }, 120_000);
});
