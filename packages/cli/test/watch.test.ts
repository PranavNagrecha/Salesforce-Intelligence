/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  claimWatchLock,
  jitteredDelay,
  readWatchState,
  releaseWatchLock,
  runWatchLoop,
  watchDailyTicks,
} from '../src/commands/watch.js';

/**
 * P13-WATCH-daemon — lifecycle units: atomic single-instance lock (live
 * refusal, stale recovery, owner-checked release), jitter bounds, the SEPARATE
 * daily tick budget degrading to idle (never API hammering), tick-failure
 * resilience, and the 20-tick mocked soak with a flat RSS.
 */

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sfi-watch-'));
  mkdirSync(join(cwd, 'org-kb', 'meta'), { recursive: true });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  delete process.env['SFI_WATCH_DAILY_TICKS'];
});

describe('watch lock lifecycle', () => {
  it('claims, refuses a second instance while alive, and releases', () => {
    expect(claimWatchLock(cwd, process.pid, 900_000, '2026-06-10T08:00:00.000Z')).toBe(true);
    expect(readWatchState(cwd).state).toBe('running');
    // double-start refused while the recorded pid is alive (it is: our own)
    expect(claimWatchLock(cwd, process.pid, 900_000)).toBe(false);
    expect(releaseWatchLock(cwd, process.pid)).toBe(true);
    expect(readWatchState(cwd).state).toBe('absent');
  });

  it('recovers a STALE pidfile from a dead process instead of failing', () => {
    writeFileSync(
      join(cwd, 'org-kb', 'meta', 'watch.pid'),
      JSON.stringify({ pid: 999999999, startedAt: 'x', intervalMs: 1 }),
    );
    expect(readWatchState(cwd).state).toBe('stale');
    expect(claimWatchLock(cwd, process.pid, 900_000)).toBe(true); // recovered
    expect(readWatchState(cwd).state).toBe('running');
    expect(releaseWatchLock(cwd, process.pid)).toBe(true);

    writeFileSync(join(cwd, 'org-kb', 'meta', 'watch.pid'), '{not json');
    expect(readWatchState(cwd).state).toBe('stale');
    expect(claimWatchLock(cwd, process.pid, 900_000)).toBe(true);
  });

  it("does not let an old watcher's cleanup delete the current owner's lock", () => {
    expect(claimWatchLock(cwd, process.pid, 900_000)).toBe(true);
    expect(releaseWatchLock(cwd, process.pid + 1)).toBe(false);
    expect(readWatchState(cwd).state).toBe('running');
    expect(releaseWatchLock(cwd, process.pid)).toBe(true);
  });
});

describe('jitter + budget', () => {
  it('jitteredDelay stays within ±10% of the interval', () => {
    expect(jitteredDelay(100_000, () => 0)).toBe(90_000);
    expect(jitteredDelay(100_000, () => 1)).toBe(110_000);
    expect(jitteredDelay(100_000, () => 0.5)).toBe(100_000);
  });

  it('watchDailyTicks honors the env with a floor', () => {
    expect(watchDailyTicks()).toBe(96);
    process.env['SFI_WATCH_DAILY_TICKS'] = '4';
    expect(watchDailyTicks()).toBe(4);
    process.env['SFI_WATCH_DAILY_TICKS'] = '0';
    expect(watchDailyTicks()).toBe(96);
  });

  it('the daily budget degrades to idling — never more sweeps than budgeted', async () => {
    process.env['SFI_WATCH_DAILY_TICKS'] = '3';
    let sweeps = 0;
    const r = await runWatchLoop({
      cwd,
      intervalMs: 1,
      ticks: 10,
      sweep: async () => {
        sweeps += 1;
      },
      sleep: async () => {},
      dayOf: () => '2026-06-10', // one fixed day — budget never resets
      log: () => {},
    });
    expect(sweeps).toBe(3);
    expect(r.ranTicks).toBe(3);
    expect(r.skippedBudget).toBe(7);
  });

  it('the budget resets on a new day', async () => {
    process.env['SFI_WATCH_DAILY_TICKS'] = '2';
    let tick = 0;
    const r = await runWatchLoop({
      cwd,
      intervalMs: 1,
      ticks: 6,
      sweep: async () => {},
      sleep: async () => {},
      dayOf: () => (tick++ < 3 ? '2026-06-10' : '2026-06-11'),
      log: () => {},
    });
    expect(r.ranTicks).toBe(4); // 2 on day one, 2 on day two
    expect(r.skippedBudget).toBe(2);
  });
});

describe('soak + resilience', () => {
  it('a failing tick logs and continues — the loop never dies on a sweep error', async () => {
    let calls = 0;
    const logs: string[] = [];
    const r = await runWatchLoop({
      cwd,
      intervalMs: 1,
      ticks: 5,
      sweep: async () => {
        calls += 1;
        if (calls === 2) throw new Error('org unreachable');
      },
      sleep: async () => {},
      log: (l) => logs.push(l),
    });
    expect(calls).toBe(5);
    expect(r.ranTicks).toBe(4); // the failed tick is not counted as ran
    expect(logs.some((l) => l.includes('non-fatal'))).toBe(true);
  });

  it('20-tick mocked soak: RSS stays flat (no per-tick leak)', async () => {
    const before = process.memoryUsage().rss;
    await runWatchLoop({
      cwd,
      intervalMs: 1,
      ticks: 20,
      sweep: async () => {
        // allocate-and-release per tick; a leak would accumulate
        JSON.parse(JSON.stringify({ blob: 'x'.repeat(50_000) }));
      },
      sleep: async () => {},
      log: () => {},
    });
    if (typeof global.gc === 'function') global.gc();
    const growth = process.memoryUsage().rss - before;
    expect(growth).toBeLessThan(30 * 1024 * 1024); // flat within noise
  });
});

describe('auto-refresh trigger + throttle (P13-WATCH-auto-refresh)', () => {
  const staleSweep = async () => ({ ok: true, snapshot: { vaultStale: true } });
  const cleanSweep = async () => ({ ok: true, snapshot: { vaultStale: false } });

  it('fires on drift, throttles inside the hour, fires again after it', async () => {
    let clock = 0;
    const refreshed: number[] = [];
    const r = await runWatchLoop({
      cwd,
      intervalMs: 1,
      ticks: 4,
      sweep: async () => {
        clock += 25 * 60_000; // 25m between ticks
        return staleSweep();
      },
      sleep: async () => {},
      log: () => {},
      autoRefresh: {
        refresh: async () => {
          refreshed.push(clock);
        },
        nowMs: () => clock,
      },
    });
    // ticks at 25/50/75/100m: refresh at 25m, throttled at 50/75, fires at 100m (≥1h later)
    expect(r.autoRefreshes).toBe(2);
    expect(r.autoRefreshThrottled).toBe(2);
    expect(refreshed).toEqual([25 * 60_000, 100 * 60_000]);
  });

  it('never fires without drift', async () => {
    let fired = 0;
    const r = await runWatchLoop({
      cwd,
      intervalMs: 1,
      ticks: 3,
      sweep: cleanSweep,
      sleep: async () => {},
      log: () => {},
      autoRefresh: { refresh: async () => { fired += 1; }, nowMs: () => 0 },
    });
    expect(fired).toBe(0);
    expect(r.autoRefreshes).toBe(0);
  });

  it('a failing auto-refresh logs non-fatally and the watcher continues', async () => {
    const logs: string[] = [];
    let clock = 0;
    const r = await runWatchLoop({
      cwd,
      intervalMs: 1,
      ticks: 2,
      sweep: async () => {
        clock += 90 * 60_000;
        return staleSweep();
      },
      sleep: async () => {},
      log: (l) => logs.push(l),
      autoRefresh: {
        refresh: async () => {
          throw new Error('retrieve failed');
        },
        nowMs: () => clock,
      },
    });
    expect(r.ranTicks).toBe(2); // loop survived both ticks
    expect(r.autoRefreshes).toBe(0);
    expect(logs.filter((l) => l.includes('auto-refresh failed (non-fatal')).length).toBe(2);
  });
});

describe('demand-queue drain hook (P13-STAGED-demand-queue)', () => {
  it('drains when the queue has entries, throttles inside the hour, fires again after it', async () => {
    let clock = 0;
    const drains: number[] = [];
    const r = await runWatchLoop({
      cwd,
      intervalMs: 1,
      ticks: 4,
      sweep: async () => {
        clock += 25 * 60_000;
      },
      sleep: async () => {},
      log: () => {},
      drainQueue: {
        peek: async () => 2,
        drain: async () => {
          drains.push(clock);
        },
        nowMs: () => clock,
      },
    });
    // ticks at 25/50/75/100m: drain at 25m, throttled at 50/75, fires at 100m
    expect(r.queueDrains).toBe(2);
    expect(r.queueDrainThrottled).toBe(2);
    expect(drains).toEqual([25 * 60_000, 100 * 60_000]);
  });

  it('never drains an empty queue', async () => {
    let fired = 0;
    const r = await runWatchLoop({
      cwd,
      intervalMs: 1,
      ticks: 3,
      sweep: async () => {},
      sleep: async () => {},
      log: () => {},
      drainQueue: { peek: async () => 0, drain: async () => { fired += 1; }, nowMs: () => 0 },
    });
    expect(fired).toBe(0);
    expect(r.queueDrains).toBe(0);
    expect(r.queueDrainThrottled).toBe(0);
  });

  it('a failing drain logs non-fatally and the watcher continues', async () => {
    const logs: string[] = [];
    let clock = 0;
    const r = await runWatchLoop({
      cwd,
      intervalMs: 1,
      ticks: 2,
      sweep: async () => {
        clock += 90 * 60_000;
      },
      sleep: async () => {},
      log: (l) => logs.push(l),
      drainQueue: {
        peek: async () => 1,
        drain: async () => {
          throw new Error('retrieve failed');
        },
        nowMs: () => clock,
      },
    });
    expect(r.ranTicks).toBe(2);
    expect(r.queueDrains).toBe(0);
    expect(logs.filter((l) => l.includes('demand-queue drain failed (non-fatal')).length).toBe(2);
  });
});
