/**
 * `sfi watch` (P13-WATCH-daemon) — a small detached daemon that runs one
 * `stale-sweep` tick per interval, so `meta/staleness.json` stays current and
 * the trust `orgDrift` badges (next item) have something fresh to read.
 *
 * Lifecycle, deliberately boring:
 *   - `sfi watch [--interval 15m]` — refuses a second instance (pidfile +
 *     liveness probe; a STALE pidfile from a dead process is recovered, not
 *     fatal), then re-spawns itself detached (`--foreground`) and returns.
 *   - `sfi watch status` — pidfile + last sweep stamp, honest about both.
 *   - `sfi watch stop`  — SIGTERM; the owning daemon cleans up its pidfile.
 *
 * Each tick is the bounded stale-sweep (≤16 read-only Tooling queries) with
 * ±10% jitter so a fleet of watchers does not synchronize against one org.
 * A SEPARATE daily tick budget (`SFI_WATCH_DAILY_TICKS`, default 96 ≈ 24h at
 * 15m) hard-stops a misconfigured tight interval — the daemon idles out the
 * day rather than hammering the API. Ticks never write anything but
 * `meta/staleness.json`; org access is read-only by construction.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Command } from 'commander';

import { runStaleSweep } from './stale-sweep.js';

const PIDFILE = 'watch.pid';
const DEFAULT_INTERVAL_MS = 15 * 60_000;
const MIN_INTERVAL_MS = 5 * 60_000;
const JITTER_RATIO = 0.1;

/** Daily tick budget — the daemon's own, separate from any live-plane budget. */
export const watchDailyTicks = (): number => {
  const raw = process.env['SFI_WATCH_DAILY_TICKS'];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 96;
};

export interface WatchPidState {
  readonly pid: number;
  readonly startedAt: string;
  readonly intervalMs: number;
}

const pidPath = (cwd: string): string => join(cwd, 'org-kb', 'meta', PIDFILE);

/** Is the recorded process actually alive? (signal 0 probe) */
const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Read the pidfile and classify it: running daemon, stale leftover from a
 * dead process, or absent. Stale files are RECOVERABLE, never fatal.
 */
export const readWatchState = (
  cwd: string,
): { readonly state: 'running' | 'stale' | 'absent'; readonly pidState?: WatchPidState } => {
  const p = pidPath(cwd);
  if (!existsSync(p)) return { state: 'absent' };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as WatchPidState;
    if (!Number.isInteger(parsed.pid) || parsed.pid < 1) return { state: 'stale' };
    return processAlive(parsed.pid)
      ? { state: 'running', pidState: parsed }
      : { state: 'stale', pidState: parsed };
  } catch {
    return { state: 'stale' };
  }
};

const alreadyExists = (error: unknown): boolean =>
  error !== null &&
  typeof error === 'object' &&
  (error as { readonly code?: unknown }).code === 'EEXIST';

/**
 * Remove a stale lock only while it still names the dead PID we inspected.
 * Corrupt legacy files have no owner, so they are removed only after a second
 * stale classification immediately before removal.
 */
const removeStaleWatchLock = (cwd: string, state: ReturnType<typeof readWatchState>): boolean => {
  if (state.state !== 'stale') return false;
  if (state.pidState !== undefined) {
    return releaseWatchLock(cwd, state.pidState.pid);
  }
  if (readWatchState(cwd).state !== 'stale') return false;
  rmSync(pidPath(cwd), { force: true });
  return true;
};

/**
 * Claim the single-instance lock: refuses when a live daemon holds it,
 * recovers a stale file, and uses exclusive creation so concurrent claimants
 * cannot both win. Returns false when refused. Exported for tests.
 */
export const claimWatchLock = (
  cwd: string,
  pid: number,
  intervalMs: number,
  now?: string,
): boolean => {
  const contents = `${JSON.stringify({ pid, startedAt: now ?? new Date().toISOString(), intervalMs } satisfies WatchPidState, null, 2)}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(pidPath(cwd), contents, { flag: 'wx' });
      return true;
    } catch (error) {
      if (!alreadyExists(error)) throw error;
      const current = readWatchState(cwd);
      if (current.state === 'running' || !removeStaleWatchLock(cwd, current)) {
        return false;
      }
    }
  }
  return false;
};

/** Remove the lock only when it is still owned by `ownerPid`. */
export const releaseWatchLock = (cwd: string, ownerPid: number): boolean => {
  const current = readWatchState(cwd);
  if (current.pidState?.pid !== ownerPid) return false;
  rmSync(pidPath(cwd), { force: true });
  return true;
};

/** Next delay with ±10% jitter (injectable random for tests). */
export const jitteredDelay = (intervalMs: number, random: () => number = Math.random): number =>
  Math.round(intervalMs * (1 - JITTER_RATIO + 2 * JITTER_RATIO * random()));

/**
 * The foreground tick loop, fully injectable for tests: `ticks` bounds the
 * loop (Infinity in production), `sweep` is the tick body, `sleep` the timer.
 * Counts API-budget consumption per UTC day and SKIPS (idles) once the daily
 * tick budget is spent — a misconfigured interval degrades to idling, never
 * to API hammering. Tick failures are logged and do not stop the loop.
 */
export const runWatchLoop = async (options: {
  readonly cwd: string;
  readonly intervalMs: number;
  readonly ticks?: number;
  readonly sweep?: (cwd: string) => Promise<unknown>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly dayOf?: () => string;
  readonly log?: (line: string) => void;
  /**
   * P13-WATCH-auto-refresh: when a tick's sweep reports drift, trigger a
   * refresh — at most once per `minIntervalMs` (default 1h). The refresh
   * itself is lock-safe by construction (epoch side-build + atomic rename),
   * and a failure logs and continues — the watcher never corrupts and never
   * dies on a refresh error.
   */
  readonly autoRefresh?: {
    readonly refresh: (cwd: string) => Promise<unknown>;
    readonly minIntervalMs?: number;
    readonly nowMs?: () => number;
  };
  /**
   * P13-STAGED-demand-queue: optionally drain queued automation-critical
   * phantom hits after a tick — at most once per `minIntervalMs` (default
   * 1h, shared clock with autoRefresh). `peek` returns how many ids are
   * queued (0 → nothing happens); `drain` runs the demand-retrieve. A
   * failure logs and the watcher continues.
   */
  readonly drainQueue?: {
    readonly peek: (cwd: string) => Promise<number>;
    readonly drain: (cwd: string) => Promise<unknown>;
    readonly minIntervalMs?: number;
    readonly nowMs?: () => number;
  };
}): Promise<{
  readonly ranTicks: number;
  readonly skippedBudget: number;
  readonly autoRefreshes: number;
  readonly autoRefreshThrottled: number;
  readonly queueDrains: number;
  readonly queueDrainThrottled: number;
}> => {
  const sweep = options.sweep ?? (async (cwd: string) => runStaleSweep({ cwd }));
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const dayOf = options.dayOf ?? (() => new Date().toISOString().slice(0, 10));
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const budget = watchDailyTicks();
  const maxTicks = options.ticks ?? Number.POSITIVE_INFINITY;

  let ranTicks = 0;
  let skippedBudget = 0;
  let autoRefreshes = 0;
  let autoRefreshThrottled = 0;
  let queueDrains = 0;
  let queueDrainThrottled = 0;
  let budgetDay = dayOf();
  let spentToday = 0;
  const nowMs = options.autoRefresh?.nowMs ?? (() => Date.now());
  const minRefreshGap = options.autoRefresh?.minIntervalMs ?? 3_600_000;
  let lastAutoRefreshMs = Number.NEGATIVE_INFINITY;
  const drainNowMs = options.drainQueue?.nowMs ?? (() => Date.now());
  const minDrainGap = options.drainQueue?.minIntervalMs ?? 3_600_000;
  let lastDrainMs = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < maxTicks; i += 1) {
    const today = dayOf();
    if (today !== budgetDay) {
      budgetDay = today;
      spentToday = 0;
    }
    if (spentToday >= budget) {
      skippedBudget += 1;
      log(`watch: daily tick budget (${budget}) spent — idling until tomorrow`);
    } else {
      spentToday += 1;
      try {
        const result = (await sweep(options.cwd)) as
          | { readonly ok?: boolean; readonly snapshot?: { readonly vaultStale?: boolean } }
          | undefined;
        ranTicks += 1;
        const drifted = result?.snapshot?.vaultStale === true;
        if (drifted && options.autoRefresh !== undefined) {
          if (nowMs() - lastAutoRefreshMs >= minRefreshGap) {
            lastAutoRefreshMs = nowMs();
            try {
              await options.autoRefresh.refresh(options.cwd);
              autoRefreshes += 1;
              log('watch: drift detected — auto-refresh completed (lock-safe; open servers reopen via the epoch)');
            } catch (e) {
              log(`watch: auto-refresh failed (non-fatal, vault untouched): ${e instanceof Error ? e.message : String(e)}`);
            }
          } else {
            autoRefreshThrottled += 1;
            log('watch: drift detected but auto-refresh throttled (max 1 per hour) — skipped');
          }
        }
        // P13-STAGED-demand-queue: drain queued phantom hits, throttled.
        if (options.drainQueue !== undefined) {
          try {
            const queued = await options.drainQueue.peek(options.cwd);
            if (queued > 0) {
              if (drainNowMs() - lastDrainMs >= minDrainGap) {
                lastDrainMs = drainNowMs();
                await options.drainQueue.drain(options.cwd);
                queueDrains += 1;
                log(`watch: drained ${queued} queued demand-retrieve id(s)`);
              } else {
                queueDrainThrottled += 1;
                log('watch: demand queue has entries but drain throttled (max 1 per hour) — skipped');
              }
            }
          } catch (e) {
            log(`watch: demand-queue drain failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } catch (e) {
        log(`watch: tick failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (i + 1 < maxTicks) {
      await sleep(jitteredDelay(options.intervalMs, options.random));
    }
  }
  return { ranTicks, skippedBudget, autoRefreshes, autoRefreshThrottled, queueDrains, queueDrainThrottled };
};

const parseInterval = (raw: string | undefined): number => {
  if (raw === undefined) return DEFAULT_INTERVAL_MS;
  const m = /^(\d+)(m|h)$/.exec(raw.trim());
  if (!m) return DEFAULT_INTERVAL_MS;
  const n = Number(m[1]);
  const ms = m[2] === 'h' ? n * 3_600_000 : n * 60_000;
  return Math.max(ms, MIN_INTERVAL_MS);
};

export const registerWatchCommand = (program: Command): void => {
  const watch = program
    .command('watch')
    .description(
      'Org-drift watcher: a small detached daemon running one read-only stale-sweep tick per interval (default 15m, floor 5m, ±10% jitter, separate daily tick budget) so meta/staleness.json stays current. Single-instance per vault (stale pidfiles recovered). Subcommands: status, stop.',
    )
    .option('--interval <duration>', 'Tick interval, e.g. 15m or 1h (floor 5m)', '15m')
    .option(
      '--auto-refresh <mode>',
      "When a tick detects drift, run `sfi refresh --incremental` automatically — at most once per hour; lock-safe (epoch side-build); a failure logs and the watcher continues. Mode: 'incremental'.",
    )
    .option('--foreground', 'Run the loop in THIS process (used by the detached child)')
    .option(
      '--drain-demand-queue',
      'After a tick, drain queued automation-critical phantom hits (`meta/demand-queue.jsonl`, recorded by sfi.get_component) via the demand-retrieve gate — at most once per hour; a failure logs and the watcher continues.',
    )
    .action(async (flags: { readonly interval?: string; readonly foreground?: boolean; readonly autoRefresh?: string; readonly drainDemandQueue?: boolean }) => {
      const cwd = process.cwd();
      const intervalMs = parseInterval(flags.interval);
      if (!existsSync(join(cwd, 'org-kb', 'meta'))) {
        process.stderr.write('watch: no vault here — run from the vault directory (org-kb/ missing).\n');
        process.exit(1);
      }
      if (flags.foreground === true) {
        if (!claimWatchLock(cwd, process.pid, intervalMs)) {
          process.stderr.write('watch: another watcher already runs for this vault — refusing a second instance.\n');
          process.exit(1);
        }
        const cleanup = (): void => {
          releaseWatchLock(cwd, process.pid);
          process.exit(0);
        };
        process.on('SIGTERM', cleanup);
        process.on('SIGINT', cleanup);
        process.stderr.write(`watch: running (pid ${process.pid}, every ~${Math.round(intervalMs / 60000)}m)\n`);
        await runWatchLoop({
          cwd,
          intervalMs,
          ...(flags.autoRefresh === 'incremental'
            ? {
                autoRefresh: {
                  refresh: async (dir: string) => {
                    const { runRefresh } = await import('./refresh.js');
                    return runRefresh({ cwd: dir, noPull: false, incremental: true, incrementalGraph: true });
                  },
                },
              }
            : {}),
          ...(flags.drainDemandQueue === true
            ? {
                drainQueue: {
                  peek: async (dir: string) => {
                    const { queuedDrainIds, readDemandQueue } = await import('@sf-intelligence/vault');
                    return queuedDrainIds(await readDemandQueue(join(dir, 'org-kb'))).length;
                  },
                  drain: async (dir: string) => {
                    const { queuedDrainIds, readDemandQueue } = await import('@sf-intelligence/vault');
                    const ids = queuedDrainIds(await readDemandQueue(join(dir, 'org-kb')));
                    if (ids.length === 0) return;
                    const { runDemandRetrieve } = await import('./refresh.js');
                    return runDemandRetrieve({ cwd: dir, components: ids });
                  },
                },
              }
            : {}),
        });
        return;
      }
      const state = readWatchState(cwd);
      if (state.state === 'running') {
        process.stderr.write(
          `watch: already running (pid ${state.pidState?.pid} since ${state.pidState?.startedAt}) — use 'sfi watch stop' first.\n`,
        );
        process.exit(1);
      }
      const child = spawn(
        process.execPath,
        [
          process.argv[1] ?? 'sfi',
          'watch',
          '--foreground',
          '--interval',
          flags.interval ?? '15m',
          ...(flags.autoRefresh !== undefined ? ['--auto-refresh', flags.autoRefresh] : []),
          ...(flags.drainDemandQueue === true ? ['--drain-demand-queue'] : []),
        ],
        { cwd, detached: true, stdio: 'ignore' },
      );
      child.unref();
      process.stdout.write(
        `watch: started (pid ${child.pid}, every ~${Math.round(intervalMs / 60000)}m with jitter). 'sfi watch status' to check, 'sfi watch stop' to end.\n`,
      );
    });

  watch
    .command('status')
    .description('Report the watcher daemon state and the last sweep stamp.')
    .action(() => {
      const cwd = process.cwd();
      const state = readWatchState(cwd);
      const stalenessPath = join(cwd, 'org-kb', 'meta', 'staleness.json');
      const lastSweep = existsSync(stalenessPath)
        ? (JSON.parse(readFileSync(stalenessPath, 'utf8')) as { generatedAt?: string; driftCount?: number }).generatedAt
        : undefined;
      if (state.state === 'running') {
        process.stdout.write(
          `watch: RUNNING (pid ${state.pidState?.pid} since ${state.pidState?.startedAt}, every ~${Math.round((state.pidState?.intervalMs ?? 0) / 60000)}m). Last sweep: ${lastSweep ?? '(none yet)'}.\n`,
        );
      } else if (state.state === 'stale') {
        process.stdout.write(
          `watch: NOT RUNNING (stale pidfile from a dead process — next 'sfi watch' recovers it). Last sweep: ${lastSweep ?? '(none)'}.\n`,
        );
      } else {
        process.stdout.write(`watch: not running. Last sweep: ${lastSweep ?? '(none)'}.\n`);
      }
    });

  watch
    .command('stop')
    .description('Stop the watcher daemon and clean up its pidfile.')
    .action(() => {
      const cwd = process.cwd();
      const state = readWatchState(cwd);
      if (state.state === 'running' && state.pidState !== undefined) {
        try {
          process.kill(state.pidState.pid, 'SIGTERM');
        } catch {
          // raced with exit — the daemon may already have cleaned its lock
        }
        process.stdout.write(`watch: stop requested (pid ${state.pidState.pid}).\n`);
        return;
      }
      removeStaleWatchLock(cwd, state);
      process.stdout.write('watch: was not running (cleaned any stale pidfile).\n');
    });
};
