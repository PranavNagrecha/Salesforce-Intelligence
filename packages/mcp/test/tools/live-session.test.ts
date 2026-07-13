/// <reference types="vitest/globals" />

import type { VaultManifest } from '@sf-intelligence/contracts';
import type { ExecCommand } from '@sf-intelligence/tooling-api';

import { mintLiveCapability } from '../../src/live-capability.js';
import type { Context } from '../../src/server.js';
import {
  liveBudgetHandler,
  liveBudgetStatus,
  liveCount,
  resetLiveSession,
  runLiveQuery,
} from '../../src/tools/live-session.js';

/** A mock `sf` returning a fixed count, tracking how many times it actually ran. */
const countingExec = (totalSize = 5): { exec: ExecCommand; calls: () => number } => {
  let calls = 0;
  const exec: ExecCommand = async () => {
    calls += 1;
    return { stdout: JSON.stringify({ result: { totalSize } }), stderr: '' };
  };
  return { exec, calls: () => calls };
};

/**
 * A mock `sf` whose call resolution is held until `release()` is invoked — used
 * to exercise CONCURRENT in-flight identical queries (the cache-stampede path).
 */
const gatedExec = (
  totalSize = 5,
): { exec: ExecCommand; calls: () => number; release: () => void } => {
  let calls = 0;
  const waiters: (() => void)[] = [];
  const exec: ExecCommand = async () => {
    calls += 1;
    await new Promise<void>((resolve) => waiters.push(resolve));
    return { stdout: JSON.stringify({ result: { totalSize } }), stderr: '' };
  };
  return {
    exec,
    calls: () => calls,
    release: () => {
      for (const w of waiters.splice(0)) w();
    },
  };
};

/** A mock `sf` that always fails (e.g. a bad alias), tracking attempt count. */
const failingExec = (): { exec: ExecCommand; calls: () => number } => {
  let calls = 0;
  const exec: ExecCommand = async () => {
    calls += 1;
    throw new Error('No authorization found for org "bad-alias"');
  };
  return { exec, calls: () => calls };
};

const SOQL_A = 'SELECT COUNT() FROM Account WHERE A__c = null';
const SOQL_B = 'SELECT COUNT() FROM Contact WHERE B__c = null';

beforeEach(() => {
  resetLiveSession();
  delete process.env.SFI_LIVE_QUERY_BUDGET;
  delete process.env.SFI_LIVE_CACHE_TTL_MS;
});

afterEach(() => {
  resetLiveSession();
  delete process.env.SFI_LIVE_QUERY_BUDGET;
  delete process.env.SFI_LIVE_CACHE_TTL_MS;
  vi.useRealTimers();
});

describe('live-result-cache (P6-live-result-cache)', () => {
  it('serves a repeated identical query from cache — exactly one org query', async () => {
    const { exec, calls } = countingExec();
    const first = await runLiveQuery('org', ['data', 'query', '--query', SOQL_A], exec);
    const second = await runLiveQuery('org', ['data', 'query', '--query', SOQL_A], exec);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.cached).toBe(false);
    expect(second.value.cached).toBe(true);
    // A cache hit keeps the ORIGINAL read time, never a fresh stamp.
    expect(second.value.queriedAt).toBe(first.value.queriedAt);
    expect(calls()).toBe(1);
  });

  it('treats a different query as a separate org call', async () => {
    const { exec, calls } = countingExec();
    await runLiveQuery('org', ['data', 'query', '--query', SOQL_A], exec);
    await runLiveQuery('org', ['data', 'query', '--query', SOQL_B], exec);
    expect(calls()).toBe(2);
  });

  it('re-queries once the TTL has elapsed', async () => {
    vi.useFakeTimers();
    process.env.SFI_LIVE_CACHE_TTL_MS = '1000';
    const { exec, calls } = countingExec();
    const a = await runLiveQuery('org', ['data', 'query', '--query', SOQL_A], exec);
    vi.advanceTimersByTime(1500);
    const b = await runLiveQuery('org', ['data', 'query', '--query', SOQL_A], exec);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.value.cached).toBe(false);
    expect(calls()).toBe(2);
  });
});

describe('live-budget-guard (P6-live-budget-guard)', () => {
  it('decrements per org query and fails closed at zero', async () => {
    process.env.SFI_LIVE_QUERY_BUDGET = '2';
    const { exec } = countingExec();
    const r1 = await runLiveQuery('org', ['data', 'query', '--query', SOQL_A], exec);
    const r2 = await runLiveQuery('org', ['data', 'query', '--query', SOQL_B], exec);
    const r3 = await runLiveQuery('org', ['data', 'query', '--query', 'SELECT COUNT() FROM Lead'], exec);
    expect(r1.ok && r2.ok).toBe(true);
    expect(r3.ok).toBe(false);
    if (r3.ok) return;
    expect(r3.error.kind).toBe('invalid-query');
    expect(r3.error.message).toContain('budget');
    expect(liveBudgetStatus().remaining).toBe(0);
  });

  it('a cache hit costs NO budget', async () => {
    process.env.SFI_LIVE_QUERY_BUDGET = '1';
    const { exec } = countingExec();
    // First A spends the only budget unit.
    const a1 = await runLiveQuery('org', ['data', 'query', '--query', SOQL_A], exec);
    // Repeated A is cached — must still succeed despite a spent budget.
    const a2 = await runLiveQuery('org', ['data', 'query', '--query', SOQL_A], exec);
    // A brand-new query B is blocked (budget already spent).
    const b = await runLiveQuery('org', ['data', 'query', '--query', SOQL_B], exec);
    expect(a1.ok && a2.ok).toBe(true);
    if (a2.ok) expect(a2.value.cached).toBe(true);
    expect(b.ok).toBe(false);
  });

  it('resetLiveSession restores the full budget (per-session reset)', async () => {
    process.env.SFI_LIVE_QUERY_BUDGET = '1';
    const { exec } = countingExec();
    await runLiveQuery('org', ['data', 'query', '--query', SOQL_A], exec);
    expect(liveBudgetStatus().remaining).toBe(0);
    resetLiveSession();
    expect(liveBudgetStatus().remaining).toBe(1);
  });

  // CR-P3 (live-session): a FAILED call must REFUND the budget — a transient
  // failure (e.g. a bad alias) is not cached, so without a refund a wedged alias
  // burns the whole 50-unit budget one retry at a time.
  it('FAIL-BEFORE/PASS-AFTER: a failed live call refunds the budget unit', async () => {
    process.env.SFI_LIVE_QUERY_BUDGET = '3';
    const { exec, calls } = failingExec();
    const r1 = await runLiveQuery('org', ['data', 'query', '--query', SOQL_A], exec);
    const r2 = await runLiveQuery('org', ['data', 'query', '--query', SOQL_A], exec);
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    // Both attempts hit the org (failures are not cached)…
    expect(calls()).toBe(2);
    // …but neither consumed budget — a failed call refunds, so a flapping alias
    // can't drain the session.
    expect(liveBudgetStatus().remaining).toBe(3);
  });
});

// CR-P3 (live-session): concurrent identical queries must NOT stampede — they
// share ONE in-flight org call (and ONE budget unit), per the "exactly one org
// query" docstring. Before the fix each concurrent miss hit the org and spent a
// budget unit independently.
describe('live-session in-flight de-dup (CR-P3 stampede)', () => {
  it('FAIL-BEFORE/PASS-AFTER: concurrent identical queries share one org call', async () => {
    const { exec, calls, release } = gatedExec();
    // Fire three identical queries concurrently — none has completed/cached yet.
    const p1 = runLiveQuery('org', ['data', 'query', '--query', SOQL_A], exec);
    const p2 = runLiveQuery('org', ['data', 'query', '--query', SOQL_A], exec);
    const p3 = runLiveQuery('org', ['data', 'query', '--query', SOQL_A], exec);
    // Let the gated org call(s) resolve, then await all three.
    release();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.ok && r2.ok && r3.ok).toBe(true);
    // Exactly ONE org call served all three concurrent identical queries.
    expect(calls()).toBe(1);
    // And exactly ONE budget unit was spent (50 default - 1).
    expect(liveBudgetStatus().used).toBe(1);
  });

  it('concurrent DIFFERENT queries each get their own org call', async () => {
    const { exec, calls, release } = gatedExec();
    const pA = runLiveQuery('org', ['data', 'query', '--query', SOQL_A], exec);
    const pB = runLiveQuery('org', ['data', 'query', '--query', SOQL_B], exec);
    release();
    await Promise.all([pA, pB]);
    expect(calls()).toBe(2);
    expect(liveBudgetStatus().used).toBe(2);
  });

  it('a query AFTER an in-flight one completes is served from cache (no extra call)', async () => {
    const { exec, calls, release } = gatedExec();
    const p1 = runLiveQuery('org', ['data', 'query', '--query', SOQL_A], exec);
    release();
    await p1;
    const second = await runLiveQuery('org', ['data', 'query', '--query', SOQL_A], exec);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.cached).toBe(true);
    expect(calls()).toBe(1);
  });
});

describe('liveCount convenience', () => {
  it('extracts the count and carries cache/budget metadata', async () => {
    const { exec } = countingExec(42);
    const r = await liveCount('org', SOQL_A, exec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.count).toBe(42);
    expect(r.value.cached).toBe(false);
    expect(typeof r.value.remainingBudget).toBe('number');
  });
});

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-02T19:02:05Z',
  sourceOrg: 'unconsented-org',
  components: { CustomObject: 1 },
  edges: { parentOf: 1 },
  sourceTreeHash: 'sha256:fixture',
};
const ctx = { manifest: MANIFEST, liveCapability: mintLiveCapability('primary') } as Context;

describe('sfi.live_budget (disclosure surface)', () => {
  it('reports budget + cache without a live call, headroom null without access', async () => {
    process.env.SFI_LIVE_QUERY_BUDGET = '7';
    const { exec, calls } = countingExec();
    const r = await liveBudgetHandler(ctx, {}, exec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.budget.limit).toBe(7);
    expect(r.value.data.budget.remaining).toBe(7);
    expect(r.value.data.orgApiHeadroom).toBeNull();
    // No live call made when access is denied.
    expect(calls()).toBe(0);
  });

  it('cross-checks org API headroom when the live plane is enabled', async () => {
    const exec: ExecCommand = async () => ({
      stdout: JSON.stringify({
        result: [
          { name: 'DailyApiRequests', max: 15000, remaining: 14990 },
          { name: 'DataStorageMB', max: 1024, remaining: 900 },
        ],
      }),
      stderr: '',
    });
    const r = await liveBudgetHandler(ctx, { liveEnabled: true }, exec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.orgApiHeadroom?.dailyApiRequestsRemaining).toBe(14990);
    expect(r.value.data.interpretation).toContain('14990');
  });
});
