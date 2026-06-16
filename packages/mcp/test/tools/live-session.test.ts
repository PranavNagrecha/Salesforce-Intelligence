/// <reference types="vitest/globals" />

import type { VaultManifest } from '@sf-intelligence/contracts';
import type { ExecCommand } from '@sf-intelligence/tooling-api';

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
const ctx = { manifest: MANIFEST } as Context;

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
