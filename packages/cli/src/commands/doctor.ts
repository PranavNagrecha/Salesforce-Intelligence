import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { execHelper } from '@sf-intelligence/core';
import { gapLogPath } from '@sf-intelligence/mcp';
import {
  computeSourceTreeHash,
  findRegistryFile,
  findRegistryRoot,
  listRegisteredVaults,
  loadManifest,
  readCoverageEntries,
  vaultPaths,
} from '@sf-intelligence/vault';
import { Command } from 'commander';

import { FEEDBACK_ISSUES_URL } from './feedback.js';
import { ORG_ALIAS_RE } from './org-alias.js';
import {
  DEFAULT_STALE_AGE_DAYS,
  formatAge,
  isStaleByAge,
} from './status.js';

/**
 * Per-call timeout for doctor's `sf` probes (`--version`, `org display`), so a
 * hung/wedged `sf` (e.g. an auth prompt) cannot hang `sfi doctor` forever
 * (CR-01 / H8). Shares the `SFI_SF_QUERY_TIMEOUT_MS` knob with refresh so an
 * operator sets one value (2 min default). On timeout the child is sent
 * `SIGTERM` so `sf` can clean up.
 */
const SF_DOCTOR_TIMEOUT_MS = (() => {
  const n = Number(process.env['SFI_SF_QUERY_TIMEOUT_MS']);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 120_000;
})();

/** Default vault root, relative to CWD. Mirrors init/status. */
const DEFAULT_VAULT_ROOT = 'org-kb';

/**
 * Common absolute install locations to probe when a bare `sf` is not on PATH —
 * IDE / MCP subprocesses often don't inherit the shell PATH, so `sf` can fail to
 * resolve even when correctly installed. Platform-specific: on Windows the CLI
 * installs as a `sf.cmd` shim (npm-global under `%APPDATA%\npm`, or the
 * Salesforce CLI installer under `Program Files`), which `execHelper` launches
 * via cmd.exe; on macOS / Linux it lands in the usual bin dirs. Returned as a
 * function so `process.platform` is read at call time (tests stub it).
 */
const sfFallbackPaths = (): readonly string[] => {
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'];
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const localAppData = process.env['LOCALAPPDATA'];
    return [
      ...(appData !== undefined ? [`${appData}\\npm\\sf.cmd`] : []),
      `${programFiles}\\Salesforce CLI\\bin\\sf.cmd`,
      `${programFiles}\\sf\\bin\\sf.cmd`,
      ...(localAppData !== undefined
        ? [`${localAppData}\\sf\\client\\bin\\sf.cmd`]
        : []),
    ];
  }
  return ['/usr/local/bin/sf', '/opt/homebrew/bin/sf'];
};

/**
 * Parse `major.minor.patch` from an `sf --version` line, or null if none is
 * present. Used only to echo the version back in a warning — NOT as a quality
 * gate, because the version number alone can't separate the modern unified CLI
 * (`@salesforce/cli/2.x`) from the legacy toolbelt (`sfdx-cli/7.x`, a HIGHER
 * number but the older product). {@link isLegacySfdxToolbelt} handles that.
 */
export const parseSfCliVersion = (
  versionLine: string,
): readonly [number, number, number] | null => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(versionLine);
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};

/**
 * True when the version line is the legacy standalone `sfdx-cli` toolbelt (v7). That
 * line predates the `sf` command set — it has no `sf project retrieve start` and
 * cannot drive a refresh. The modern unified CLI reports `@salesforce/cli/2.x`
 * and passes. Detection is by product NAME, not version number, since 7 > 2.
 * A floor on the version number was considered and rejected: any real `sf`
 * binary is already ≥2.0.0, so a numeric floor would never fire, and we have no
 * verified-bad 2.x version to justify pinning higher.
 */
export const isLegacySfdxToolbelt = (versionLine: string): boolean =>
  /sfdx-cli\//i.test(versionLine);

/** Human-readable `major.minor.patch`. */
const formatVersion = (v: readonly [number, number, number]): string => v.join('.');

/**
 * Injectable `sf` runner so tests can drive `doctor` without spawning `sf`.
 * Argv-shaped (binary + args, NOT a single shell string) so the `targetOrg`
 * read from the vault config is never interpreted by a shell (CR-01 / C1).
 */
export type DoctorExec = (binary: string, args: readonly string[]) => Promise<{ stdout: string }>;

/** One diagnostic line. `fix` is the actionable next step when not `pass`. */
export interface DoctorCheck {
  readonly name: string;
  readonly status: 'pass' | 'info' | 'warn' | 'fail';
  readonly detail: string;
  readonly fix?: string;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  /** True when no check is `fail`. */
  readonly healthy: boolean;
}

export interface RunDoctorOptions {
  readonly cwd: string;
  /** Override the shell runner (tests inject a stub). */
  readonly exec?: DoctorExec;
  /** Override the route-gap log path (tests inject a fixture). */
  readonly gapLogFile?: string;
}

/**
 * Summarize the local route-gap log (`question-gaps.jsonl`): how many questions
 * hit a router gap, and the most common gap category. Best-effort and never
 * throws — a missing/garbled log just reports zero gaps. Local-only telemetry;
 * the file never leaves the machine. (P12-ROUTER-confusion-report.)
 */
export const summarizeRouteGaps = async (
  logFile: string,
): Promise<{ exists: boolean; count: number; topCategory: string | null; topCount: number }> => {
  let raw: string;
  try {
    raw = await readFile(logFile, 'utf8');
  } catch {
    // No log at all ≠ "ran clean": the MCP server has not logged anything on
    // this machine, so the check must not read as a passing routing audit.
    return { exists: false, count: 0, topCategory: null, topCount: 0 };
  }
  const byCategory = new Map<string, number>();
  let count = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const entry = JSON.parse(line) as { category?: unknown };
      const cat = typeof entry.category === 'string' ? entry.category : 'unknown';
      byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1);
      count += 1;
    } catch {
      // skip a malformed line; never break the diagnostic
    }
  }
  let topCategory: string | null = null;
  let topCount = 0;
  for (const [cat, n] of byCategory) {
    if (n > topCount) {
      topCategory = cat;
      topCount = n;
    }
  }
  return { exists: true, count, topCategory, topCount };
};

const pathExists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Read `targetOrg` from the vault config, or null if unreadable / absent / not
 * a valid org alias. The `ORG_ALIAS_RE` gate is defense in depth (CR-01 / C1):
 * a poisoned config value never reaches the `sf org display` probe; the
 * existing "no targetOrg" branch fires instead.
 */
const readTargetOrg = async (configPath: string): Promise<string | null> => {
  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as { targetOrg?: unknown };
    return typeof parsed.targetOrg === 'string' && ORG_ALIAS_RE.test(parsed.targetOrg)
      ? parsed.targetOrg
      : null;
  } catch {
    return null;
  }
};

/**
 * Diagnose the local sf-intelligence setup: the `sf` CLI, the vault, the bound
 * org's auth, the refresh state, freshness, and the graph file — each with an
 * actionable fix. Read-only: never writes, never mutates the org. Returns a
 * structured report so the command handler can render it and tests can assert
 * it. `exec` is injectable so tests don't spawn `sf`.
 *
 * @example
 *   const r = await runDoctor({ cwd: process.cwd() });
 *   if (!r.healthy) process.exitCode = 1;
 */
export const runDoctor = async (opts: RunDoctorOptions): Promise<DoctorReport> => {
  const run =
    opts.exec ??
    ((binary: string, args: readonly string[]) =>
      execHelper(binary, args, {
        maxBuffer: 64 * 1024 * 1024,
        timeout: SF_DOCTOR_TIMEOUT_MS,
      }));
  const checks: DoctorCheck[] = [];
  const vaultRoot = resolve(opts.cwd, DEFAULT_VAULT_ROOT);
  const paths = vaultPaths(vaultRoot);

  // 1. sf CLI present. IDE/MCP subprocesses often don't inherit /usr/local/bin
  // or /opt/homebrew/bin, so a bare `sf` can fail even when it IS installed.
  // Probe the common absolute locations and reuse whatever resolves for every
  // later sf call, so the rest of doctor still works and the failure is
  // diagnosed as a PATH issue rather than "not installed".
  const SF_FALLBACK_PATHS = sfFallbackPaths();
  let sfBin = 'sf';
  let sfDetail: string | null = null;
  let sfOnPath = false;
  try {
    const { stdout } = await run('sf', ['--version']);
    sfDetail = stdout.trim().split('\n')[0] ?? 'installed';
    sfOnPath = true;
  } catch {
    for (const abs of SF_FALLBACK_PATHS) {
      try {
        const { stdout } = await run(abs, ['--version']);
        sfDetail = stdout.trim().split('\n')[0] ?? 'installed';
        // Store the BARE absolute path — `run` spawns it as the execFile binary,
        // so a quoted form would ENOENT (no shell to strip the quotes).
        sfBin = abs;
        break;
      } catch {
        // keep probing the next location
      }
    }
  }
  // 1b. Legacy-toolbelt guard. The refresh path needs the v2 `sf` command set
  // (`sf project retrieve start`); the old standalone `sfdx-cli` (v7) lacks it
  // and fails every refresh with confusing cascading errors. Advisory `warn` —
  // never blocks doctor.
  if (sfDetail !== null && isLegacySfdxToolbelt(sfDetail)) {
    const parsed = parseSfCliVersion(sfDetail);
    checks.push({
      name: 'Salesforce CLI version',
      status: 'warn',
      detail:
        `legacy sfdx-cli${parsed !== null ? ` ${formatVersion(parsed)}` : ''} detected — it predates ` +
        '`sf project retrieve start` (used by refresh) and cannot drive a vault refresh',
      fix: 'Install the modern unified CLI: npm install --global @salesforce/cli@latest',
    });
  }
  if (sfOnPath) {
    checks.push({ name: 'Salesforce CLI', status: 'pass', detail: sfDetail ?? 'installed' });
  } else if (sfDetail !== null) {
    checks.push({
      name: 'Salesforce CLI',
      status: 'warn',
      detail: `${sfDetail} — found via absolute path, not on PATH`,
      fix: 'Add the Salesforce CLI directory (e.g. /usr/local/bin or /opt/homebrew/bin) to the PATH of whatever launches sfi; IDE/MCP subprocesses often do not inherit it.',
    });
  } else {
    checks.push({
      name: 'Salesforce CLI',
      status: 'fail',
      detail: '`sf` not found on PATH or common install locations',
      fix: 'Install the Salesforce CLI (npm install --global @salesforce/cli). If it IS installed, add its directory (/usr/local/bin or /opt/homebrew/bin) to your PATH; IDE/MCP subprocesses often do not inherit it.',
    });
  }

  // 2. Vault initialized.
  const vaultInit = await pathExists(paths.config);
  if (!vaultInit) {
    checks.push({
      name: 'Vault',
      status: 'fail',
      detail: `no vault at ${vaultRoot}`,
      fix: 'Run `sfi init --target-org <alias>` then `sfi refresh`.',
    });
  } else {
    checks.push({ name: 'Vault', status: 'pass', detail: `initialized at ${vaultRoot}` });
  }

  // 3. Target-org auth (only meaningful if the vault names one).
  const targetOrg = vaultInit ? await readTargetOrg(paths.config) : null;
  if (targetOrg === null) {
    checks.push({
      name: 'Org auth',
      status: vaultInit ? 'warn' : 'fail',
      detail: 'no targetOrg in vault config',
      fix: 'Re-run `sfi init --target-org <alias>`.',
    });
  } else {
    try {
      const { stdout } = await run(sfBin, ['org', 'display', '--target-org', targetOrg, '--json']);
      const parsed = JSON.parse(stdout) as { result?: { connectedStatus?: string; username?: string } };
      const status = parsed.result?.connectedStatus;
      if (status === 'Connected') {
        checks.push({ name: 'Org auth', status: 'pass', detail: `${targetOrg} → ${parsed.result?.username ?? 'connected'}` });
      } else {
        checks.push({
          name: 'Org auth',
          status: 'fail',
          detail: `${targetOrg}: ${status ?? 'not connected'}`,
          fix: `Re-authenticate: sf org login web --alias "${targetOrg}"`,
        });
      }
    } catch {
      checks.push({
        name: 'Org auth',
        status: 'fail',
        detail: `could not query ${targetOrg}`,
        fix: `Re-authenticate: sf org login web --alias "${targetOrg}"`,
      });
    }
  }

  // 4 + 5. Refresh state + freshness.
  if (vaultInit) {
    const manifestResult = await loadManifest(vaultRoot);
    if (!manifestResult.ok) {
      checks.push({
        name: 'Refresh',
        status: 'fail',
        detail: 'vault never refreshed (no manifest)',
        fix: 'Run `sfi refresh`.',
      });
    } else {
      const hashResult = await computeSourceTreeHash(paths.source);
      if (!hashResult.ok) {
        checks.push({ name: 'Refresh', status: 'warn', detail: 'source unreadable', fix: 'Run `sfi refresh`.' });
      } else if (hashResult.value === manifestResult.value.sourceTreeHash) {
        // Local source matches the manifest, but a vault that hasn't been
        // re-pulled in a long time can still be stale relative to the LIVE org
        // (FRESH-01). Surface the age, and warn past the threshold so "fresh"
        // never reads as "current with the org" on an old vault.
        const refreshedAt = manifestResult.value.refreshedAt;
        if (isStaleByAge(refreshedAt)) {
          checks.push({
            name: 'Freshness',
            status: 'warn',
            detail: `local source unchanged, but the vault was last refreshed ${formatAge(refreshedAt)} (> ${DEFAULT_STALE_AGE_DAYS}d) — the live org may have drifted since`,
            fix: 'Run `sfi refresh` to re-pull the org if metadata/record currency matters.',
          });
        } else {
          checks.push({ name: 'Freshness', status: 'pass', detail: `fresh (refreshed ${formatAge(refreshedAt)})` });
        }
      } else {
        checks.push({ name: 'Freshness', status: 'warn', detail: 'vault is STALE', fix: 'Run `sfi refresh`.' });
      }
      if (readCoverageEntries(manifestResult.value).length === 0) {
        checks.push({
          name: 'Coverage metadata',
          status: 'warn',
          detail: 'manifest has no coverage block (pre-v4 vault or interrupted refresh)',
          fix: 'Run `sfi refresh --no-pull` to recompute coverage from existing source without re-retrieving.',
        });
      }
      // EMPTY vault (P12-FIRSTRUN-failure-ux): a refresh that retrieved nothing
      // builds a manifest + graph but answers nothing — distinguish it from a
      // healthy vault so a newcomer gets the real reason, not "all green".
      const componentTotal = Object.values(manifestResult.value.components ?? {}).reduce(
        (a, b) => a + (typeof b === 'number' ? b : 0),
        0,
      );
      checks.push(
        componentTotal === 0
          ? {
              name: 'Vault contents',
              status: 'fail',
              detail: 'the vault has 0 components — the retrieve returned nothing',
              fix: 'Check the org actually has metadata and you are pointed at the right org; if you scoped with `--types`, widen it; then re-run `sfi refresh`.',
            }
          : { name: 'Vault contents', status: 'pass', detail: `${componentTotal.toLocaleString()} components modeled` },
      );
    }
  }

  // 6. Graph file present.
  if (vaultInit) {
    const graphOk = await pathExists(paths.graphDb);
    checks.push(
      graphOk
        ? { name: 'Graph', status: 'pass', detail: 'graph.duckdb present' }
        : { name: 'Graph', status: 'warn', detail: 'graph.duckdb missing', fix: 'Run `sfi refresh` to rebuild the graph.' },
    );
  }

  // 7. Route-gap telemetry (P12-ROUTER-confusion-report). Informational, never
  // blocking — the router appends a local entry whenever a question hits a gap
  // (an unrouted/no-good-tool question, or an honest live-plane disclosure), so
  // the count is a signal of where routing could improve, not a health failure.
  const gaps = await summarizeRouteGaps(opts.gapLogFile ?? gapLogPath());
  if (!gaps.exists) {
    // Distinguish "never used" from "used and clean" — a fresh machine with no
    // MCP traffic must not read as a passing routing audit.
    checks.push({
      name: 'Route gaps',
      status: 'info',
      detail:
        'no route-gap log yet on this machine (machine-global ~/.sfi/question-gaps.jsonl — not per-vault)',
    });
  } else if (gaps.count === 0) {
    checks.push({
      name: 'Route gaps',
      status: 'info',
      detail: 'no route gaps logged locally (machine-global gap log)',
    });
  } else {
    const top = gaps.topCategory !== null ? ` (top: ${gaps.topCategory} ×${gaps.topCount})` : '';
    checks.push({
      name: 'Route gaps',
      status: 'warn',
      detail:
        `${gaps.count.toLocaleString()} question(s) logged a route gap on this machine${top} — machine-global history, not this vault's health`,
      fix: 'Review locally-logged routing gaps (question-gaps.jsonl) — phrasings the router could not answer well are candidates for a new intent/gold case.',
    });
  }

  // P13-WATCH-daemon: watcher status — informational, never blocking. A
  // running watcher keeps meta/staleness.json current for the drift badges.
  try {
    const { readWatchState } = await import('./watch.js');
    const watch = readWatchState(opts.cwd ?? process.cwd());
    if (watch.state === 'running') {
      checks.push({
        name: 'Org-drift watch',
        status: 'pass',
        detail: `watcher running (pid ${watch.pidState?.pid} since ${watch.pidState?.startedAt})`,
      });
    } else if (watch.state === 'stale') {
      checks.push({
        name: 'Org-drift watch',
        status: 'pass',
        detail: 'stale watcher pidfile from a dead process',
        fix: "Run `sfi watch` to restart the drift watcher (it recovers the stale pidfile), or `sfi watch stop` to clean it.",
      });
    } else {
      checks.push({
        name: 'Org-drift watch',
        status: 'pass',
        detail: 'not running (optional — `sfi watch` keeps org-drift staleness current)',
      });
    }
  } catch {
    // best-effort informational line — never blocks doctor
  }

  if (vaultInit) {
    const { vaultGitEnabled } = await import('./vault-git.js');
    if (vaultGitEnabled(vaultRoot)) {
      checks.push({
        name: 'Vault git history',
        status: 'pass',
        detail: 'enabled — component_history / component_as_of available',
      });
    } else {
      checks.push({
        name: 'Vault git history',
        status: 'info',
        detail: 'disabled — change-over-time questions need local git history',
        fix: 'Run `sfi vault git enable` once for `sfi.component_history` / `sfi.component_as_of`.',
      });
    }

    const registryFile = findRegistryFile(vaultRoot);
    if (existsSync(registryFile)) {
      const listed = await listRegisteredVaults(findRegistryRoot(vaultRoot));
      if (listed.ok && listed.value.length >= 2) {
        checks.push({
          name: 'Multi-vault registry',
          status: 'info',
          detail: `${listed.value.length} vault(s) in ${registryFile} — fleet_find / compare_vaults / fleet_drift_ranking available`,
          fix: 'See docs/configuration.md § Multi-vault / fleet (`sfi register-vault`, `SF_INTELLIGENCE_REGISTRY_PATH`).',
        });
      } else if (listed.ok && listed.value.length === 1) {
        checks.push({
          name: 'Multi-vault registry',
          status: 'info',
          detail: 'registry exists with one vault — add more with `sfi register-vault` for cross-org tools',
          fix: 'Run `sfi register-vault <alias> <path>` (see docs/configuration.md § Multi-vault / fleet).',
        });
      }
    }
  }

  return { checks, healthy: !checks.some((c) => c.status === 'fail') };
};

/** Render a `DoctorReport` to a multi-line string for the CLI. */
export const formatDoctorReport = (report: DoctorReport): string => {
  const icon = (s: DoctorCheck['status']): string =>
    s === 'pass' ? 'PASS' : s === 'info' ? 'INFO' : s === 'warn' ? 'WARN' : 'FAIL';
  const lines = ['sfi doctor', ''];
  for (const c of report.checks) {
    lines.push(`  ${icon(c.status)}  ${c.name}: ${c.detail}`);
    if (c.fix !== undefined) lines.push(`        ↳ ${c.fix}`);
  }
  lines.push('', report.healthy ? 'No blocking problems.' : 'Found blocking problems — see the fixes above.', '');
  // The last common newcomer failure doctor can't probe: the MCP client isn't
  // wired up. When everything else is green, point at that next step explicitly.
  if (report.healthy) {
    lines.push(
      'Next step: if answers aren\'t coming through, the MCP server may not be connected — add `sfi mcp` to',
      'your MCP client (Claude Code / Desktop / any MCP client) and restart it, then ask. `sfi quickstart` walks the full path.',
      '',
    );
  }
  // SYNTH-04 — grounding reminder: every org answer should cite only ids the
  // tools returned. `sfi.synthesize_answer` enforces that (flags hallucinatedIds).
  lines.push(
    'Grounding: build org answers from sfi.* tool output and pass them through `sfi.synthesize_answer`,',
    'which flags any canonical id in the prose that no tool returned (hallucinatedIds) — never invent ids.',
    '',
  );
  // Feedback channel (P12-FEEDBACK-loop): a wrong/weak answer or a route gap has a
  // home. `sfi feedback export` writes a scrubbed file (no org PII, nothing uploaded).
  lines.push(
    'Feedback: a weak/wrong answer or a missing capability? `sfi feedback mark "<question>" --wrong`,',
    'then `sfi feedback export` for a scrubbed file to share at',
    `  ${FEEDBACK_ISSUES_URL}`,
    '',
  );
  return lines.join('\n');
};

/** Register the `sfi doctor` subcommand. */
export const registerDoctorCommand = (program: Command): void => {
  program
    .command('doctor')
    .description('Diagnose the sf-intelligence setup (CLI, vault, org auth, freshness) with fixes')
    .action(async (): Promise<void> => {
      const report = await runDoctor({ cwd: process.cwd() });
      process.stdout.write(formatDoctorReport(report));
      if (!report.healthy) process.exit(1);
    });
};
