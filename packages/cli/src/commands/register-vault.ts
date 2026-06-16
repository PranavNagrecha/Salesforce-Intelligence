/**
 * The `sfi register-vault` CLI subcommand (v3.1 R7).
 *
 * Registers a vault alias under a co-resident root, mapping the user-
 * typed name (e.g., `acme-prod`) to an absolute vault path. The
 * registry is the load-bearing primitive for the four cross-vault MCP
 * tools (`sfi.compare_vaults` and siblings); this command writes the
 * `registry.json` file those tools read.
 *
 * Per PLAN-v3.1 §12, registration is a one-time setup action and is
 * CLI-only — no MCP-tool equivalent. The skill cannot register vaults
 * on the user's behalf; it surfaces the verbatim command and waits.
 *
 * Co-resident root resolution (in order):
 *   1. `--root <path>` flag if provided.
 *   2. `SF_INTELLIGENCE_REGISTRY_PATH` env var when set.
 *   3. Default `~/sf-intelligence-vaults` (the PLAN-v3.1 §3 default).
 *
 * Vault-path resolution: the second positional argument is resolved
 * to an absolute path (relative paths resolve against `process.cwd()`).
 *
 * The command is a thin shim around
 * `registerVault` in `@sf-intelligence/vault`; the registry helper
 * carries the contract (duplicate-alias refusal, atomic write, alias
 * validation).
 */

import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

import { err, ok, type Result } from '@sf-intelligence/core';
import { registerVault, type RegistryError } from '@sf-intelligence/vault';
import { Command } from 'commander';

/** Default co-resident root, per PLAN-v3.1 §3. */
const DEFAULT_REGISTRY_ROOT_SUBDIR = 'sf-intelligence-vaults' as const;

/**
 * Options accepted by `runRegisterVault`. Each field is pre-resolved by
 * the commander handler — `runRegisterVault` itself stays deterministic
 * so tests can drive it with arbitrary temp roots.
 */
export interface RunRegisterVaultOptions {
  /** Working directory used to resolve relative `vaultPath`. */
  readonly cwd: string;
  /** Alias the user typed (e.g., `acme-prod`). */
  readonly alias: string;
  /** Vault path (absolute or relative to `cwd`). */
  readonly vaultPath: string;
  /** Co-resident root path. Pre-resolved (see `resolveRegistryRoot`). */
  readonly rootDir: string;
  /** When true, overwrite an existing alias. Default false. */
  readonly force: boolean;
}

/** Outcome of a successful registration, useful for the CLI summary. */
export interface RunRegisterVaultSuccess {
  readonly alias: string;
  readonly resolvedPath: string;
  readonly registryRoot: string;
}

/**
 * Resolve the co-resident registry root. The CLI commands consult the
 * same fallback chain so users get consistent behavior across
 * `register-vault`, `list-vaults`, and `compare-vaults`.
 *
 *   1. `--root <path>` flag if provided.
 *   2. `SF_INTELLIGENCE_REGISTRY_PATH` env var.
 *   3. `~/sf-intelligence-vaults` default.
 *
 * @example
 *   resolveRegistryRoot({ root: undefined });
 *   // => '/home/me/sf-intelligence-vaults'
 */
export const resolveRegistryRoot = (opts: {
  readonly root?: string | undefined;
}): string => {
  if (opts.root !== undefined && opts.root.length > 0) {
    return isAbsolute(opts.root) ? opts.root : resolve(opts.root);
  }
  const fromEnv = process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return resolve(homedir(), DEFAULT_REGISTRY_ROOT_SUBDIR);
};

/**
 * Register a vault alias in the co-resident root's `registry.json`.
 *
 * Resolves `opts.vaultPath` to absolute; delegates to
 * `registerVault` in `@sf-intelligence/vault`. The helper validates
 * the alias, writes the registry atomically, and refuses duplicates
 * unless `opts.force` is set.
 *
 * @example
 *   const r = await runRegisterVault({
 *     cwd: process.cwd(),
 *     alias: 'acme-prod',
 *     vaultPath: './acme-prod',
 *     rootDir: '/home/me/sf-intelligence-vaults',
 *     force: false,
 *   });
 *   if (!r.ok) console.error(r.error.message);
 */
export const runRegisterVault = async (
  opts: RunRegisterVaultOptions,
): Promise<Result<RunRegisterVaultSuccess, RegistryError>> => {
  const resolvedPath = isAbsolute(opts.vaultPath)
    ? opts.vaultPath
    : resolve(opts.cwd, opts.vaultPath);

  const registered = await registerVault(
    opts.rootDir,
    opts.alias,
    resolvedPath,
    { force: opts.force },
  );
  if (!registered.ok) return err(registered.error);

  return ok({
    alias: opts.alias,
    resolvedPath,
    registryRoot: opts.rootDir,
  });
};

/**
 * Format a successful registration for the CLI's text output. Single
 * line with the alias, the resolved path, and the registry root so the
 * operator can confirm at a glance.
 */
export const formatRegisterSuccess = (
  result: RunRegisterVaultSuccess,
): string =>
  `Registered '${result.alias}' -> ${result.resolvedPath} (registry: ${result.registryRoot})\n`;

/** Commander flag shape. `--force` and `--root` are optional. */
interface RegisterVaultCliFlags {
  readonly force?: boolean;
  readonly root?: string;
}

/**
 * Register the `sfi register-vault <alias> <path>` subcommand on
 * `program`. Exits 0 on success, 1 on registry errors. The error path
 * surfaces the `RegistryError.message` verbatim so the caller can see
 * why registration failed (duplicate alias, invalid path, etc.).
 *
 * @example
 *   registerRegisterVaultCommand(new Command());
 */
export const registerRegisterVaultCommand = (program: Command): void => {
  program
    .command('register-vault <alias> <path>')
    .description(
      'Register a Salesforce vault alias under the co-resident root for v3.1 cross-vault tools',
    )
    .option('--force', 'Overwrite an existing alias instead of refusing')
    .option(
      '--root <path>',
      'Co-resident registry root (default: $SF_INTELLIGENCE_REGISTRY_PATH or ~/sf-intelligence-vaults)',
    )
    .action(
      async (
        alias: string,
        path: string,
        flags: RegisterVaultCliFlags,
      ): Promise<void> => {
        const rootDir = resolveRegistryRoot({
          ...(flags.root !== undefined ? { root: flags.root } : {}),
        });
        const result = await runRegisterVault({
          cwd: process.cwd(),
          alias,
          vaultPath: path,
          rootDir,
          force: flags.force === true,
        });
        if (!result.ok) {
          process.stderr.write(`sfi register-vault: ${result.error.message}\n`);
          process.exit(1);
        }
        process.stdout.write(formatRegisterSuccess(result.value));
      },
    );
};
