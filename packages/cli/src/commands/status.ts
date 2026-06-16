import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  computeSourceTreeHash,
  loadManifest,
  readSkippedDirectories,
  vaultPaths,
  type ExtendedVaultManifest,
} from '@sf-intelligence/vault';
import { Command } from 'commander';

/** JSON indentation, 2 spaces, matches the rest of the CLI. */
const JSON_INDENT = 2;
/** Default vault root, identical to `sfi init`'s default. Read-only command never overrides. */
const DEFAULT_VAULT_ROOT = 'org-kb';
/** Number of hex chars of `sourceTreeHash` to show in the summary table; the rest is elided. */
const HASH_PREFIX_LENGTH = 12;
/** Width of the label column in the summary table — chosen to fit the longest current label. */
const LABEL_WIDTH = 20;
/** Seconds per minute / minute per hour / hour per day for the age formatter. */
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

/**
 * The four states `runStatus` can report.
 *
 *   - `no-vault`: `meta/config.json` does not exist — the user has not run `sfi init`.
 *   - `no-manifest`: vault is initialised but `meta/manifest.json` is absent —
 *     `sfi refresh` has never completed.
 *   - `fresh`: manifest exists and its `sourceTreeHash` matches the current source tree.
 *   - `stale`: manifest exists but the current source tree's hash differs.
 *
 * `currentSourceHash` is populated when a hash could be computed (i.e., the
 * `source/` directory exists and is readable); on `fresh` it equals
 * `manifest.sourceTreeHash`, on `stale` it differs.
 */
export interface StatusOutput {
  readonly kind: 'no-vault' | 'no-manifest' | 'fresh' | 'stale';
  readonly message: string;
  readonly manifest?: ExtendedVaultManifest;
  readonly currentSourceHash?: string;
}

/** Options accepted by `runStatus`. `cwd` is explicit for test determinism. */
export interface RunStatusOptions {
  /** Working directory where `org-kb/` is expected. */
  readonly cwd: string;
}

/**
 * Inspect the vault rooted at `${opts.cwd}/org-kb` and report its state.
 *
 * Read-only: never writes to disk. `runStatus` returns a `StatusOutput`
 * directly rather than `Result<...>` because every reachable state is
 * informational, not an error — even "no vault" is a fine, recoverable
 * state for a brand-new project. The handler exits 0 in every case.
 *
 * @example
 *   const out = await runStatus({ cwd: process.cwd() });
 *   if (out.kind === 'stale') console.log('refresh needed');
 */
export const runStatus = async (opts: RunStatusOptions): Promise<StatusOutput> => {
  const vaultRoot = resolve(opts.cwd, DEFAULT_VAULT_ROOT);
  const paths = vaultPaths(vaultRoot);

  if (!(await pathExists(paths.config))) {
    return {
      kind: 'no-vault',
      message: 'No vault. Run `sfi init` followed by `sfi refresh`.',
    };
  }

  const manifestResult = await loadManifest(vaultRoot);
  if (!manifestResult.ok) {
    return {
      kind: 'no-manifest',
      message: 'Vault initialized but never refreshed. Run `sfi refresh`.',
    };
  }
  const manifest = manifestResult.value;

  const hashResult = await computeSourceTreeHash(paths.source);
  // If the source dir is missing we can't decide fresh vs stale; report
  // the manifest's recorded state and lean toward "stale" so the user is
  // nudged to refresh (which will recreate `source/`).
  if (!hashResult.ok) {
    return {
      kind: 'stale',
      message: 'Source directory unreadable. Run `sfi refresh` to rebuild.',
      manifest,
    };
  }

  const currentSourceHash = hashResult.value;
  if (currentSourceHash === manifest.sourceTreeHash) {
    return {
      kind: 'fresh',
      message:
        'Vault is locally consistent (source hash matches last refresh). Live org drift is not checked — run `sfi live_stale_check` when you need live confirmation.',
      manifest,
      currentSourceHash,
    };
  }
  return {
    kind: 'stale',
    message: 'Vault is STALE — run `sfi refresh` to update.',
    manifest,
    currentSourceHash,
  };
};

/** Return `true` if `path` exists. Permission errors are treated as "exists" so
 *  we never silently downgrade to `no-vault` on a directory we can't read. */
const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    return !isEnoent(cause);
  }
};

/** Treat unknown errors that smell like ENOENT as missing-file signals. */
const isEnoent = (cause: unknown): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  'code' in cause &&
  (cause as { code?: unknown }).code === 'ENOENT';

/**
 * Format an ISO 8601 timestamp's distance from `now` as a coarse
 * human-readable phrase: "5 minutes ago", "2 hours ago", "3 days ago".
 *
 * Falls back to the raw ISO string when the input does not parse — we
 * never want a status summary to throw.
 *
 * @example
 *   formatAge('2026-05-27T10:00:00Z', new Date('2026-05-27T10:05:00Z'));
 *   // => '5 minutes ago'
 */
export const formatAge = (iso: string, now: Date = new Date()): string => {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return iso;
  const deltaSec = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1000));
  if (deltaSec < SECONDS_PER_MINUTE) return `${deltaSec} seconds ago`;
  const deltaMin = Math.floor(deltaSec / SECONDS_PER_MINUTE);
  if (deltaMin < MINUTES_PER_HOUR) return pluralize(deltaMin, 'minute');
  const deltaHr = Math.floor(deltaMin / MINUTES_PER_HOUR);
  if (deltaHr < HOURS_PER_DAY) return pluralize(deltaHr, 'hour');
  const deltaDay = Math.floor(deltaHr / HOURS_PER_DAY);
  return pluralize(deltaDay, 'day');
};

/** Pluralize a `count`/`noun` pair: "1 minute ago" / "5 minutes ago". */
const pluralize = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'} ago`;

/** Default age (days) beyond which a vault is "stale" even if local source is unchanged. */
export const DEFAULT_STALE_AGE_DAYS = 14;

/**
 * Whole days between `iso` and `now`, or `null` when `iso` does not parse.
 * Used for time-based staleness (distinct from the source-hash check): a vault
 * whose local source is unchanged can still be stale relative to the *live org*,
 * which may have drifted since the last `sf project retrieve`.
 *
 * @example
 *   ageInDays('2026-05-01T00:00:00Z', new Date('2026-05-16T00:00:00Z')); // => 15
 */
export const ageInDays = (iso: string, now: Date = new Date()): number | null => {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  const ms = now.getTime() - then.getTime();
  return Math.max(0, Math.floor(ms / (SECONDS_PER_MINUTE * MINUTES_PER_HOUR * HOURS_PER_DAY * 1000)));
};

/**
 * True when the vault is older than `thresholdDays` (default
 * `DEFAULT_STALE_AGE_DAYS`). Unparseable timestamps are treated as NOT stale so
 * a malformed manifest never produces a false alarm. The caller decides what to
 * do — `sfi status` already shows the age; `sfi doctor` raises a `warn`.
 */
export const isStaleByAge = (
  iso: string,
  now: Date = new Date(),
  thresholdDays: number = DEFAULT_STALE_AGE_DAYS,
): boolean => {
  const days = ageInDays(iso, now);
  return days !== null && days > thresholdDays;
};

/**
 * Render a `StatusOutput` as a plain-text summary table.
 *
 * For `no-vault` / `no-manifest` we emit only the message; there is
 * nothing to tabulate. For `fresh` / `stale` we render the vault-state
 * header, the components table, and the edges table.
 */
export const renderStatusTable = (out: StatusOutput, now: Date = new Date()): string => {
  if (out.manifest === undefined) {
    return `${out.message}\n`;
  }
  const m = out.manifest;
  const lines: string[] = [
    'Vault state',
    '-----------',
    formatRow('Target org:', m.sourceOrg),
    formatRow('Last refreshed:', `${m.refreshedAt} (${formatAge(m.refreshedAt, now)})`),
    formatRow('Source tree hash:', `${m.sourceTreeHash.slice(0, HASH_PREFIX_LENGTH)}...`),
    '',
    'Components extracted',
    '--------------------',
    ...formatCountSection(m.components),
    '',
    'Edges',
    '-----',
    ...formatCountSection(m.edges),
    '',
    out.message,
    '',
  ];
  return lines.join('\n');
};

/** Format `Components` / `Edges` blocks. Empty sections collapse to "(none)". */
const formatCountSection = (counts: Readonly<Record<string, number | undefined>>): string[] => {
  const entries = Object.entries(counts).filter(([, count]) => count !== undefined);
  if (entries.length === 0) return ['(none)'];
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([key, count]) => formatRow(`${key}:`, String(count)));
};

/** Format one `label/value` row, left-padding the label to `LABEL_WIDTH`. */
const formatRow = (label: string, value: string): string => `${label.padEnd(LABEL_WIDTH)} ${value}`;

/**
 * Render the per-directory skip inventory from a `StatusOutput` as a
 * plain-text table. Surfaces the architectural-bug-fix counter so
 * operators can see exactly which Salesforce DX directories the
 * walker dropped on the floor — and roughly how big the coverage gap
 * is.
 *
 * Returns the table text including a trailing newline. When the
 * manifest is absent or the counter is empty/missing, returns a
 * single informational line instead.
 *
 * Examples (for the doc reader):
 * - empty:  "No skipped directories. The walker covered every retrieved file.\n"
 * - 3 dirs: "Vault skipped 245 files in 3 directory types:\n
 *            omniProcesses           184 files\n
 *            omniDataTransforms       50 files\n
 *            omniIntegrationProcs     11 files\n"
 */
export const renderSkippedTable = (out: StatusOutput): string => {
  if (out.manifest === undefined) {
    return `${out.message}\n`;
  }
  const skipped = readSkippedDirectories(out.manifest);
  const entries = Object.entries(skipped);
  if (entries.length === 0) {
    return 'No skipped directories. The walker covered every retrieved file.\n';
  }
  const sorted = [...entries].sort(([aKey, aCount], [bKey, bCount]) =>
    bCount !== aCount ? bCount - aCount : aKey < bKey ? -1 : aKey > bKey ? 1 : 0,
  );
  const totalFiles = sorted.reduce((sum, [, n]) => sum + n, 0);
  const labelWidth = Math.max(...sorted.map(([k]) => k.length)) + 2;
  const rows = sorted.map(
    ([name, count]) => `${name.padEnd(labelWidth)} ${count} ${count === 1 ? 'file' : 'files'}`,
  );
  return [
    `Vault skipped ${totalFiles} ${totalFiles === 1 ? 'file' : 'files'} in ${sorted.length} directory ${sorted.length === 1 ? 'type' : 'types'}:`,
    ...rows,
    '',
  ].join('\n');
};

/** Commander flag shape. `--json` and `--skipped` are the surface. */
interface StatusCliFlags {
  readonly json?: boolean;
  readonly skipped?: boolean;
}

/**
 * Register the `sfi status` subcommand on `program`.
 *
 * Read-only: prints to stdout, never writes. Always exits 0; the human
 * is informed of `no-vault` / `no-manifest` / `stale` states through the
 * message text, not the exit code.
 *
 * @example
 *   const program = new Command();
 *   registerStatusCommand(program);
 *   await program.parseAsync(['node', 'sfi', 'status', '--json']);
 */
export const registerStatusCommand = (program: Command): void => {
  program
    .command('status')
    .description('Report the freshness of the local vault')
    .option('--json', 'Print the raw status as pretty-printed JSON instead of the table', false)
    .option(
      '--skipped',
      'Print the per-directory skip inventory the refresh walker recorded. Use this when the warning at the end of `sfi refresh` flagged unknown directories.',
      false,
    )
    .action(async (flags: StatusCliFlags): Promise<void> => {
      const out = await runStatus({ cwd: process.cwd() });
      if (flags.json === true) {
        process.stdout.write(`${JSON.stringify(out, null, JSON_INDENT)}\n`);
        return;
      }
      if (flags.skipped === true) {
        process.stdout.write(renderSkippedTable(out));
        return;
      }
      process.stdout.write(renderStatusTable(out));
    });
};
