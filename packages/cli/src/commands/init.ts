import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { confirm, input } from '@inquirer/prompts';
import { err, execHelper, ok, type Result } from '@sf-intelligence/core';
import { vaultPaths } from '@sf-intelligence/vault';
import { Command } from 'commander';

import { readCliPackageVersion } from '../package-version.js';

import { validateOrgAlias } from './org-alias.js';
import { formatTrustStatement } from './trust-statement.js';
/** Default vault root, relative to the user's CWD. */
const DEFAULT_VAULT_ROOT = 'org-kb';
/** JSON indentation. 2 spaces for diffable committed configs. */
const JSON_INDENT = 2;
/** Entries appended to `.gitignore` so generated artifacts are not tracked. */
const GITIGNORE_ENTRIES: readonly string[] = ['org-kb/source/', 'org-kb/graph/'];
/** Salesforce metadata API version stamped into the scaffolded `sfdx-project.json`. */
const SF_API_VERSION = '62.0';
/** Default DX package directory that `sf project retrieve` requires to exist on disk. */
const DEFAULT_PACKAGE_DIR = 'force-app';

/**
 * Per-call timeout for init's best-effort `sf org list --json` probe (2 min
 * default, sharing refresh's `SFI_SF_QUERY_TIMEOUT_MS` knob), so a hung `sf`
 * cannot wedge `sfi init` forever (CR-01 / H8). `SIGTERM` on timeout.
 */
const SF_LIST_TIMEOUT_MS = (() => {
  const n = Number(process.env['SFI_SF_QUERY_TIMEOUT_MS']);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 120_000;
})();

/**
 * The error variants `runInit` can return.
 *
 *   - `already-exists`: the vault root already exists and `force` was false.
 *   - `mkdir-failed`: a directory could not be created (permission, etc.).
 *   - `write-failed`: a config or version file could not be written.
 */
export interface InitError {
  readonly kind: 'already-exists' | 'mkdir-failed' | 'write-failed';
  readonly message: string;
  readonly path?: string;
  readonly cause?: unknown;
}

/**
 * Options accepted by `runInit`. All values are pre-resolved by the caller —
 * the commander handler does any prompting before invoking this function,
 * which keeps `runInit` deterministic and testable.
 */
export interface RunInitOptions {
  /** Working directory used to resolve relative `vaultRoot` and write `.gitignore`. */
  readonly cwd: string;
  /** Salesforce org alias persisted into `meta/config.json`. */
  readonly targetOrg: string;
  /** Vault root path (absolute or relative to `cwd`). */
  readonly vaultRoot: string;
  /** When true, overwrite an existing vault's config instead of refusing. */
  readonly force: boolean;
}

/** Outcome of a successful `runInit` — useful for the CLI to print a summary. */
export interface RunInitSuccess {
  readonly vaultRoot: string;
  readonly targetOrg: string;
  readonly gitignoreUpdated: boolean;
  /** True if `sfi init` wrote a fresh `sfdx-project.json` (false if one already existed). */
  readonly dxProjectScaffolded: boolean;
}

/**
 * Initialise an `org-kb/` vault at `opts.vaultRoot` relative to `opts.cwd`.
 * Takes `cwd` explicitly so tests can drive it in a temp dir (vitest's
 * worker pool forbids `process.chdir`). Refuses to overwrite an existing
 * vault unless `opts.force` is true. `.gitignore` failures are non-fatal —
 * the result's `gitignoreUpdated` flag reports whether the file was written.
 *
 * @example
 *   const r = await runInit({ cwd: process.cwd(), targetOrg: 'prod',
 *     vaultRoot: 'org-kb', force: false });
 *   if (!r.ok) process.exit(1);
 */
export const runInit = async (
  opts: RunInitOptions,
): Promise<Result<RunInitSuccess, InitError>> => {
  // Reject a poisoned org alias at creation (CR-01 / C1), so a config that a
  // later `sfi refresh` would refuse is never written in the first place.
  const aliasCheck = validateOrgAlias(opts.targetOrg);
  if (!aliasCheck.ok) {
    return err({ kind: 'write-failed', message: aliasCheck.error });
  }
  const resolvedRoot = isAbsolute(opts.vaultRoot)
    ? opts.vaultRoot
    : resolve(opts.cwd, opts.vaultRoot);
  if (!opts.force && (await pathExists(resolvedRoot))) {
    return err({
      kind: 'already-exists',
      message: `vault already exists: ${resolvedRoot}`,
      path: resolvedRoot,
    });
  }
  const paths = vaultPaths(resolvedRoot);
  const mkdirResult = await createVaultDirs(paths);
  if (!mkdirResult.ok) return mkdirResult;
  const writeResult = await writeVaultMetadata(paths, opts.targetOrg, resolvedRoot);
  if (!writeResult.ok) return writeResult;
  const dxProjectScaffolded = await ensureDxProject(opts.cwd);
  const gitignoreUpdated = await updateGitignore(opts.cwd);
  return ok({ vaultRoot: resolvedRoot, targetOrg: opts.targetOrg, gitignoreUpdated, dxProjectScaffolded });
};

/**
 * Ensure the directory is a usable Salesforce DX project so the very next
 * `sfi refresh` can run `sf project retrieve` without manual setup. Writes a
 * minimal `sfdx-project.json` when none exists and guarantees the default
 * package directory is present on disk (retrieve refuses to run otherwise).
 * Both steps are idempotent and non-fatal — an existing project is respected.
 *
 * @example
 *   const scaffolded = await ensureDxProject(process.cwd());
 */
const ensureDxProject = async (cwd: string): Promise<boolean> => {
  const projectPath = join(cwd, 'sfdx-project.json');
  let wrote = false;
  if (!(await pathExists(projectPath))) {
    const project = {
      packageDirectories: [{ path: DEFAULT_PACKAGE_DIR, default: true }],
      namespace: '',
      sourceApiVersion: SF_API_VERSION,
    };
    try {
      await writeFile(projectPath, `${JSON.stringify(project, null, JSON_INDENT)}\n`, 'utf8');
      wrote = true;
    } catch {
      // Non-fatal: the operator can supply their own sfdx-project.json.
    }
  }
  try {
    await mkdir(join(cwd, DEFAULT_PACKAGE_DIR), { recursive: true });
  } catch {
    // Non-fatal: surfaced later as a retrieve error if it actually matters.
  }
  return wrote;
};

/** Create the five canonical vault directories; returns the first mkdir failure. */
const createVaultDirs = async (
  paths: ReturnType<typeof vaultPaths>,
): Promise<Result<void, InitError>> => {
  for (const dir of [paths.root, paths.source, paths.components, paths.graph, paths.meta]) {
    try {
      await mkdir(dir, { recursive: true });
    } catch (cause) {
      return err({ kind: 'mkdir-failed', message: `failed to create directory: ${dir}`, path: dir, cause });
    }
  }
  return ok(undefined);
};

/**
 * Write `config.json` and `version.txt` into the vault's `meta/` directory.
 * `vaultPaths` exposes `meta/version` (no extension); the task spec wants
 * the dotted filename, so we compute it here.
 */
const writeVaultMetadata = async (
  paths: ReturnType<typeof vaultPaths>,
  targetOrg: string,
  resolvedRoot: string,
): Promise<Result<void, InitError>> => {
  const config = {
    createdAt: new Date().toISOString(),
    targetOrg,
    vaultRoot: resolvedRoot,
    version: readCliPackageVersion(),
    snapshotOnRefresh: true,
  };
  try {
    await writeFile(paths.config, `${JSON.stringify(config, null, JSON_INDENT)}\n`, 'utf8');
  } catch (cause) {
    return err({ kind: 'write-failed', message: `failed to write config: ${paths.config}`, path: paths.config, cause });
  }
  const versionTxtPath = join(paths.meta, 'version.txt');
  try {
    await writeFile(versionTxtPath, `${readCliPackageVersion()}\n`, 'utf8');
  } catch (cause) {
    return err({ kind: 'write-failed', message: `failed to write version.txt: ${versionTxtPath}`, path: versionTxtPath, cause });
  }
  return ok(undefined);
};

/** Idempotently append `GITIGNORE_ENTRIES` to `.gitignore` in `cwd`. Returns `true` if written. */
const updateGitignore = async (cwd: string): Promise<boolean> => {
  const gitignorePath = join(cwd, '.gitignore');
  let existing = '';
  let exists = true;
  try {
    existing = await readFile(gitignorePath, 'utf8');
  } catch (cause) {
    if (!isEnoent(cause)) return false;
    exists = false;
  }
  const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = GITIGNORE_ENTRIES.filter((entry) => !present.has(entry));
  if (missing.length === 0) return false;
  const needsNewline = exists && existing.length > 0 && !existing.endsWith('\n');
  const next = `${existing}${needsNewline ? '\n' : ''}${missing.join('\n')}\n`;
  try {
    await writeFile(gitignorePath, next, 'utf8');
    return true;
  } catch {
    return false;
  }
};

/**
 * Return `true` if `path` exists. Permission errors return `true` so we do
 * not silently clobber a directory we cannot read.
 */
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
  typeof cause === 'object' && cause !== null && 'code' in cause &&
  (cause as { code?: unknown }).code === 'ENOENT';

/** Org list array categories returned by `sf org list --json`. */
const ORG_CATEGORIES = ['nonScratchOrgs', 'scratchOrgs', 'otherOrgs', 'devHubs', 'sandboxes'] as const;

/**
 * Best-effort lookup of the user's default Salesforce org alias via
 * `sf org list --json`. Returns `null` if the CLI is unavailable, fails, or
 * yields no default — never throws.
 *
 * @example
 *   const alias = await getDefaultOrgAlias();
 *   const orgPrompt = await input({ message: 'Org:', default: alias ?? 'prod' });
 */
export const getDefaultOrgAlias = async (): Promise<string | null> => {
  try {
    const { stdout } = await execHelper('sf', ['org', 'list', '--json'], {
      timeout: SF_LIST_TIMEOUT_MS,
    });
    const parsed = JSON.parse(stdout) as { result?: Record<string, unknown> };
    const result = parsed.result;
    if (result === undefined || result === null) return null;
    for (const key of ORG_CATEGORIES) {
      const entries = result[key];
      if (!Array.isArray(entries)) continue;
      for (const item of entries) {
        if (typeof item !== 'object' || item === null) continue;
        const entry = item as Record<string, unknown>;
        if (entry['isDefaultUsername'] !== true && entry['isDefaultDevHubUsername'] !== true) continue;
        const alias = entry['alias'] ?? entry['username'];
        if (typeof alias === 'string' && alias.length > 0) return alias;
      }
    }
    return null;
  } catch {
    return null;
  }
};

/** Commander flag shape — all optional so the handler prompts for what is missing. */
interface InitCliFlags {
  readonly targetOrg?: string;
  readonly vaultRoot?: string;
  readonly force?: boolean;
}

/**
 * Register the `sfi init` subcommand on `program`. Prompts for anything not
 * provided via flags and delegates to `runInit`.
 *
 * @example
 *   const program = new Command();
 *   registerInitCommand(program);
 *   await program.parseAsync(process.argv);
 */
export const registerInitCommand = (program: Command): void => {
  program
    .command('init')
    .description('Initialise a new org-kb vault in the current directory')
    .option('--target-org <alias>', 'Salesforce org alias to bind to this vault')
    .option('--vault-root <path>', 'Vault root directory (relative to CWD)')
    .option('--force', 'Overwrite an existing org-kb/ vault config', false)
    .action(async (flags: InitCliFlags): Promise<void> => {
      const cwd = process.cwd();
      const exitCode = await handleInit(cwd, flags);
      if (exitCode !== 0) process.exit(exitCode);
    });
};

/**
 * Drive the interactive portion of `sfi init` and call `runInit`. Prompts are
 * gated on an interactive TTY: under Claude, CI, or any piped invocation the
 * command falls back to sane defaults (vault root `org-kb`, the default org
 * alias) or exits with an actionable message instead of hanging on a prompt
 * that can never be answered.
 */
const handleInit = async (cwd: string, flags: InitCliFlags): Promise<number> => {
  const interactive = process.stdin.isTTY === true;
  const vaultRoot =
    flags.vaultRoot ??
    (interactive
      ? await input({ message: 'Vault root directory:', default: DEFAULT_VAULT_ROOT })
      : DEFAULT_VAULT_ROOT);
  const resolvedRoot = isAbsolute(vaultRoot) ? vaultRoot : resolve(cwd, vaultRoot);
  let force = flags.force ?? false;

  if (!force && (await pathExists(resolvedRoot))) {
    if (!interactive) {
      process.stderr.write(`sfi init: ${vaultRoot}/ already exists. Re-run with --force to overwrite.\n`);
      return 1;
    }
    const overwrite = await confirm({
      message: `${vaultRoot}/ already exists. Overwrite config?`,
      default: false,
    });
    if (!overwrite) {
      process.stdout.write('Existing init preserved.\n');
      return 0;
    }
    force = true;
  }

  const targetOrg = await resolveTargetOrg(flags, interactive);
  if (targetOrg === null) {
    process.stderr.write(
      'sfi init: no --target-org given and no default Salesforce org found. Pass --target-org <alias>.\n',
    );
    return 1;
  }
  return runAndReport({ cwd, targetOrg, vaultRoot, force });
};

/**
 * Resolve the target-org alias from flags, prompting only when interactive.
 * Non-interactively, falls back to the default org alias and returns `null`
 * when none can be determined so the caller can emit an actionable error.
 */
const resolveTargetOrg = async (flags: InitCliFlags, interactive: boolean): Promise<string | null> => {
  if (flags.targetOrg !== undefined) return flags.targetOrg;
  const detected = await getDefaultOrgAlias();
  if (!interactive) return detected;
  // Spread the `default` key conditionally — `exactOptionalPropertyTypes`
  // forbids `default: undefined` on inquirer's InputConfig.
  return input({
    message: 'Target org alias:',
    ...(detected !== null ? { default: detected } : {}),
  });
};

/** Invoke `runInit` and pretty-print its outcome. Returns a CLI exit code. */
const runAndReport = async (opts: RunInitOptions): Promise<number> => {
  const result = await runInit(opts);
  if (!result.ok) {
    process.stderr.write(`sfi init: ${result.error.message}\n`);
    return 1;
  }
  process.stdout.write(
    [
      `Initialised vault at ${result.value.vaultRoot}`,
      `Target org: ${result.value.targetOrg}`,
      result.value.gitignoreUpdated
        ? 'Updated .gitignore'
        : '.gitignore already up to date (or could not be written)',
      result.value.dxProjectScaffolded
        ? 'Scaffolded sfdx-project.json (ready for sf project retrieve)'
        : 'sfdx-project.json already present',
      '',
    ].join('\n'),
  );
  // The loud, one-screen "what this does (and does NOT) do to your org"
  // guarantee — the first thing an enterprise tester wants before refresh.
  process.stdout.write(formatTrustStatement());
  process.stdout.write('Next: run sfi refresh\n\n');
  return 0;
};
