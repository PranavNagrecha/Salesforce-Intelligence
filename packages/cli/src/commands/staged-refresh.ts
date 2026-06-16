/**
 * P13-STAGED-tiers — `sfi refresh --staged`: build the vault in tiers so a
 * first-time (or rebuilding) operator gets a servable, HONEST vault in
 * minutes instead of waiting for one monolithic refresh.
 *
 *   T0  skeleton  — ~5 read-only COUNT queries → minimal manifest + a
 *                   `partial: true` org card; nothing retrieved yet.
 *   T1  priority  — scoped retrieve of the types behind most questions
 *                   (objects/fields/automation/Apex/permissions); Markdown
 *                   render deferred; manifest carries the staged marker and
 *                   the queue as `pending` coverage rows.
 *   T2  full      — a complete monolithic refresh through the transactional
 *                   side-build path (mid-T2 death leaves the T1 graph
 *                   byte-untouched). Because the final tier IS a monolithic
 *                   refresh, the staged end state converges to the
 *                   single-pass end state by construction.
 *   T3  reports   — only with `--with-reports`: the folder-based
 *                   Report/Dashboard opt-in pass.
 *
 * Honesty mid-build: `sfi.health_check` reports `degraded (building tier
 * i/n)` while the marker is present, and queued types read as `pending`
 * coverage — `retrieved: 0` pending rows keep absence-claim caveats firing,
 * so "no Reports reference X" can never be asserted unqualified before
 * Reports were retrieved.
 *
 * Resumability: `meta/staged-refresh.json` records completed tiers; a re-run
 * of `--staged` skips them. The file is deleted on full success.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getAuthFromSfCli } from '@sf-intelligence/tooling-api';
import {
  loadManifest,
  saveManifest,
  vaultPaths,
  type ExtendedVaultManifest,
  type StagedBuildMarker,
} from '@sf-intelligence/vault';

import { readCliPackageVersion } from '../package-version.js';
import { SUPPORTED_TYPES } from '../refresh-pipeline.js';

import { loadVaultConfig, runRefresh, type RefreshResult } from './refresh.js';

/**
 * Tier-1 priority types (design §G10): the metadata families behind the
 * overwhelming majority of first questions — schema, validation, automation,
 * code, page assignment, and the permission containers.
 */
export const TIER1_PRIORITY_TYPES: readonly string[] = [
  'ApexClass',
  'ApexTrigger',
  'CustomField',
  'CustomObject',
  'Flow',
  'Layout',
  'PermissionSet',
  'Profile',
  'RecordType',
  'ValidationRule',
];

/** The staged tier plan: T1's scope and what stays queued for T2. */
export const stagedTierPlan = (): {
  readonly tier1Types: readonly string[];
  readonly tier2PendingTypes: readonly string[];
} => {
  const t1 = new Set(TIER1_PRIORITY_TYPES);
  return {
    tier1Types: TIER1_PRIORITY_TYPES,
    tier2PendingTypes: (SUPPORTED_TYPES as readonly string[]).filter(
      (type) => !t1.has(type),
    ),
  };
};

/** On-disk resumability state (`meta/staged-refresh.json`). */
export interface StagedRefreshState {
  readonly version: 1;
  readonly startedAt: string;
  readonly targetOrg: string;
  readonly completedTiers: readonly string[];
}

const STATE_FILE = 'staged-refresh.json';

const statePath = (metaDir: string): string => join(metaDir, STATE_FILE);

/** Read the resumability state; absent/corrupt reads as "fresh start". */
export const readStagedState = async (
  metaDir: string,
): Promise<StagedRefreshState | null> => {
  try {
    const parsed = JSON.parse(
      await readFile(statePath(metaDir), 'utf8'),
    ) as Partial<StagedRefreshState>;
    if (parsed.version !== 1 || !Array.isArray(parsed.completedTiers)) return null;
    return parsed as StagedRefreshState;
  } catch {
    return null;
  }
};

const writeStagedState = async (
  metaDir: string,
  state: StagedRefreshState,
): Promise<void> => {
  await mkdir(metaDir, { recursive: true });
  await writeFile(statePath(metaDir), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
};

/**
 * Injectable executors for the T0 skeleton's read-only COUNT queries.
 * Production resolves auth via the sf CLI and queries over REST; tests stub.
 */
export interface SkeletonExecutors {
  readonly getAuth: (
    targetOrg: string,
  ) => Promise<
    | { readonly ok: true; readonly value: { readonly instanceUrl: string; readonly accessToken: string; readonly apiVersion: string } }
    | { readonly ok: false; readonly error: { readonly message: string } }
  >;
  readonly restGet: (
    auth: { readonly instanceUrl: string; readonly accessToken: string; readonly apiVersion: string },
    url: string,
  ) => Promise<
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: { readonly message: string } }
  >;
}

const productionSkeletonExecutors = (): SkeletonExecutors => ({
  getAuth: async (targetOrg) => {
    const r = await getAuthFromSfCli(targetOrg);
    return r.ok
      ? { ok: true, value: r.value }
      : { ok: false, error: { message: r.error.message } };
  },
  restGet: async (auth, url) => {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      });
      if (!response.ok) {
        return { ok: false, error: { message: `Salesforce REST ${response.status}` } };
      }
      return { ok: true, value: (await response.json()) as unknown };
    } catch (cause) {
      return {
        ok: false,
        error: { message: cause instanceof Error ? cause.message : String(cause) },
      };
    }
  },
});

/**
 * The ~5 read-only skeleton COUNT queries. `SELECT COUNT() FROM X` returns
 * the count as `totalSize` with no records. ApexClass / ApexTrigger /
 * FlowDefinition live on the Tooling API; Profile / PermissionSet on the
 * standard query endpoint. READ-ONLY by construction — the staged refresh
 * never writes to the org.
 */
const SKELETON_QUERIES: readonly {
  readonly label: string;
  readonly endpoint: 'tooling' | 'data';
  readonly entity: string;
}[] = [
  { label: 'ApexClass', endpoint: 'tooling', entity: 'ApexClass' },
  { label: 'ApexTrigger', endpoint: 'tooling', entity: 'ApexTrigger' },
  { label: 'Flow', endpoint: 'tooling', entity: 'FlowDefinition' },
  { label: 'Profile', endpoint: 'data', entity: 'Profile' },
  { label: 'PermissionSet', endpoint: 'data', entity: 'PermissionSet' },
];

/**
 * Capture approximate org-size counts for the T0 skeleton card. Best-effort:
 * any failure returns what succeeded so far — the skeleton is orientation,
 * not ground truth, and is labeled approximate wherever it appears.
 */
export const captureSkeletonCounts = async (
  targetOrg: string,
  executors: SkeletonExecutors,
): Promise<Readonly<Record<string, number>>> => {
  const counts: Record<string, number> = {};
  const auth = await executors.getAuth(targetOrg);
  if (!auth.ok) return counts;
  const major = auth.value.apiVersion.split('.')[0] ?? '62';
  const base = `${auth.value.instanceUrl}/services/data/v${major}.0`;
  for (const q of SKELETON_QUERIES) {
    const path = q.endpoint === 'tooling' ? `${base}/tooling/query` : `${base}/query`;
    const url = `${path}?q=${encodeURIComponent(`SELECT COUNT() FROM ${q.entity}`)}`;
    const result = await executors.restGet(auth.value, url);
    if (result.ok) {
      const totalSize = (result.value as { readonly totalSize?: unknown }).totalSize;
      if (typeof totalSize === 'number') counts[q.label] = totalSize;
    }
  }
  return counts;
};

/** Options accepted by `runStagedRefresh`. */
export interface RunStagedRefreshOptions {
  readonly cwd: string;
  /** When true, every tier recomputes from existing `source/` (tests/fixtures). */
  readonly noPull: boolean;
  readonly targetOrg?: string;
  /** Adds the T3 folder-based Report/Dashboard pass. */
  readonly withReports?: boolean;
  readonly onProgress?: (message: string) => void;
  /** Injectable refresh runner (tests verify sequencing / inject failures). */
  readonly refreshFn?: typeof runRefresh;
  /** Injectable T0 executors; `false` disables the live skeleton queries. */
  readonly skeleton?: SkeletonExecutors | false;
}

/** Outcome of a staged run: the final tier's result plus what actually ran. */
export interface StagedRefreshResult {
  readonly result: RefreshResult;
  readonly tiersRun: readonly string[];
  readonly tiersSkipped: readonly string[];
}

const failedResult = (message: string): RefreshResult => ({
  status: 'failed',
  counts: { components: {}, edges: {} },
  errors: [],
  durationMs: 0,
  fatalError: message,
  skippedDirectories: {},
});

/** Write the T0 skeleton manifest — only when the vault has none yet. */
const writeSkeletonManifest = async (
  vaultRoot: string,
  targetOrg: string,
  marker: StagedBuildMarker,
): Promise<void> => {
  const existing = await loadManifest(vaultRoot);
  const now = new Date().toISOString();
  if (existing.ok) {
    // An existing vault keeps its real counts/coverage; T0 only stamps the
    // marker so health reads "building tier 0/n" without degrading the
    // currently-servable data to pending.
    const updated: ExtendedVaultManifest = { ...existing.value, staged: marker };
    await saveManifest(vaultRoot, updated);
    return;
  }
  const skeleton: ExtendedVaultManifest = {
    version: readCliPackageVersion(),
    refreshedAt: now,
    sourceOrg: targetOrg,
    components: {},
    edges: {},
    sourceTreeHash: '',
    coverage: (SUPPORTED_TYPES as readonly string[]).map((type) => ({
      type,
      requested: true,
      retrieved: 0,
      errored: false,
      neverModeled: false,
      pending: true,
    })),
    coverageComputedAt: now,
    skippedDirectories: {},
    staged: marker,
  };
  await saveManifest(vaultRoot, skeleton);
};

/** Write the T0 skeleton org card — only when no card exists yet. */
const writeSkeletonCard = async (
  vaultRoot: string,
  metaDir: string,
  targetOrg: string,
  marker: StagedBuildMarker,
  approxCounts: Readonly<Record<string, number>>,
): Promise<void> => {
  const cardJsonPath = join(metaDir, 'org-card.json');
  try {
    await readFile(cardJsonPath, 'utf8');
    return; // a prior full card is better orientation than a skeleton
  } catch {
    // no card yet — write the skeleton
  }
  const now = new Date().toISOString();
  const card = {
    partial: true,
    staged: { tier: marker.tier, totalTiers: marker.totalTiers },
    generatedAt: now,
    sourceOrg: targetOrg,
    approxCounts,
    note:
      'Staged build in progress — counts are approximate (read-only COUNT queries), nothing retrieved yet. The full card is rendered when the final tier completes.',
  };
  const lines = [
    '# Org card (staged skeleton)',
    '',
    `> **STAGED BUILD IN PROGRESS** (tier ${marker.tier}/${marker.totalTiers}) — this is a pre-retrieve skeleton; counts below are approximate.`,
    '',
    `- Org: ${targetOrg}`,
    `- Generated: ${now}`,
    ...Object.entries(approxCounts).map(([k, v]) => `- ~${k}: ${v}`),
    '',
  ];
  try {
    await mkdir(metaDir, { recursive: true });
    await writeFile(cardJsonPath, `${JSON.stringify(card, null, 2)}\n`, 'utf8');
    const docsDir = join(vaultRoot, 'docs');
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(docsDir, 'org-card.md'), `${lines.join('\n')}\n`, 'utf8');
  } catch {
    // best-effort — the skeleton card is orientation, never load-bearing
  }
};

/**
 * Run the staged refresh: T0 skeleton → T1 priority → T2 full (transactional
 * side-build) → optional T3 reports, resuming past tiers a prior run
 * completed. The final tier is a plain monolithic refresh, so the staged end
 * state equals the single-pass end state by construction.
 *
 * @example
 *   const r = await runStagedRefresh({ cwd: process.cwd(), noPull: false });
 *   if (r.result.status !== 'failed') console.log(`done: ${r.tiersRun.join(' → ')}`);
 */
export const runStagedRefresh = async (
  opts: RunStagedRefreshOptions,
): Promise<StagedRefreshResult> => {
  const progress = opts.onProgress ?? (() => {});
  const refreshFn = opts.refreshFn ?? runRefresh;
  const configResult = await loadVaultConfig(opts.cwd);
  if (!configResult.ok) {
    return { result: failedResult(configResult.error), tiersRun: [], tiersSkipped: [] };
  }
  const vaultRoot = configResult.value.vaultRoot;
  const paths = vaultPaths(vaultRoot);
  const targetOrg = opts.targetOrg ?? configResult.value.targetOrg;
  const plan = stagedTierPlan();
  const totalTiers = opts.withReports === true ? 4 : 3;

  const prior = await readStagedState(paths.meta);
  const done = new Set(prior?.completedTiers ?? []);
  if (prior !== null) {
    progress(
      `Resuming staged refresh started ${prior.startedAt} (completed: ${prior.completedTiers.join(', ') || 'none'}).`,
    );
  }
  const tiersRun: string[] = [];
  const tiersSkipped: string[] = [...done];
  const startedAt = prior?.startedAt ?? new Date().toISOString();
  const markDone = async (tier: string): Promise<void> => {
    done.add(tier);
    tiersRun.push(tier);
    await writeStagedState(paths.meta, {
      version: 1,
      startedAt,
      targetOrg,
      completedTiers: [...done],
    });
  };

  // ---- T0: skeleton (no retrieve; read-only COUNT queries at most) -------
  if (!done.has('t0')) {
    progress(`Staged tier 0/${totalTiers}: skeleton (read-only counts, no retrieve)...`);
    const marker: StagedBuildMarker = {
      tier: 0,
      totalTiers,
      pendingTypes: [...(SUPPORTED_TYPES as readonly string[])],
    };
    let approx: Readonly<Record<string, number>> = {};
    if (!opts.noPull && opts.skeleton !== false) {
      approx = await captureSkeletonCounts(
        targetOrg,
        opts.skeleton ?? productionSkeletonExecutors(),
      );
    }
    await writeSkeletonManifest(vaultRoot, targetOrg, marker);
    await writeSkeletonCard(vaultRoot, paths.meta, targetOrg, marker, approx);
    await markDone('t0');
  } else {
    progress('Staged tier 0 already complete — skipping.');
  }

  // ---- T1: priority types (render deferred; marker + pending coverage) ---
  if (!done.has('t1')) {
    progress(
      `Staged tier 1/${totalTiers}: priority types (${plan.tier1Types.length} families)...`,
    );
    const t1 = await refreshFn({
      cwd: opts.cwd,
      noPull: opts.noPull,
      ...(opts.targetOrg !== undefined ? { targetOrg: opts.targetOrg } : {}),
      types: plan.tier1Types.join(','),
      skipRender: true,
      stagedMarker: { tier: 1, totalTiers, pendingTypes: plan.tier2PendingTypes },
      onProgress: progress,
    });
    if (t1.status === 'failed') {
      return { result: t1, tiersRun, tiersSkipped };
    }
    await markDone('t1');
  } else {
    progress('Staged tier 1 already complete — skipping.');
  }

  // ---- T2: full monolithic refresh through the transactional side-build --
  let final: RefreshResult;
  if (!done.has('t2')) {
    progress(`Staged tier 2/${totalTiers}: full refresh (transactional side-build)...`);
    final = await refreshFn({
      cwd: opts.cwd,
      noPull: opts.noPull,
      ...(opts.targetOrg !== undefined ? { targetOrg: opts.targetOrg } : {}),
      forceSideBuild: true,
      onProgress: progress,
      // With a T3 still queued, T2 keeps a marker (pendingTypes empty — every
      // modeled family is retrieved; only the Report/Dashboard opt-in pass
      // remains) so health stays honest until the build truly finishes.
      ...(opts.withReports === true
        ? { stagedMarker: { tier: 2, totalTiers, pendingTypes: [] } }
        : {}),
    });
    if (final.status === 'failed') {
      return { result: final, tiersRun, tiersSkipped };
    }
    await markDone('t2');
  } else {
    progress('Staged tier 2 already complete — skipping.');
    final = failedResult('tier already complete'); // replaced below when T3 runs
  }

  // ---- T3: folder-based Report/Dashboard opt-in pass ----------------------
  if (opts.withReports === true && !done.has('t3')) {
    progress(`Staged tier 3/${totalTiers}: folder-based Reports/Dashboards...`);
    final = await refreshFn({
      cwd: opts.cwd,
      noPull: opts.noPull,
      ...(opts.targetOrg !== undefined ? { targetOrg: opts.targetOrg } : {}),
      withReports: true,
      onProgress: progress,
    });
    if (final.status === 'failed') {
      return { result: final, tiersRun, tiersSkipped };
    }
    await markDone('t3');
  }

  if (final.status === 'failed' && done.has('t2')) {
    // Resumed past T2 with no T3 to run: nothing executed this invocation —
    // re-run the final tier so the caller still gets a real result and the
    // marker-clearing manifest is freshly written.
    progress('All tiers previously complete — re-running the final tier to converge.');
    final = await refreshFn({
      cwd: opts.cwd,
      noPull: opts.noPull,
      ...(opts.targetOrg !== undefined ? { targetOrg: opts.targetOrg } : {}),
      forceSideBuild: true,
      onProgress: progress,
    });
    if (final.status === 'failed') {
      return { result: final, tiersRun, tiersSkipped };
    }
  }

  await rm(statePath(paths.meta), { force: true });
  progress('Staged refresh complete — all tiers done, marker cleared.');
  return { result: final, tiersRun, tiersSkipped };
};
