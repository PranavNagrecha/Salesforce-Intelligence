/**
 * The `sfi list-vaults` CLI subcommand (v3.1 R7).
 *
 * Enumerates every registered vault under the co-resident root and
 * surfaces the per-vault freshness metadata read from each vault's
 * `meta/manifest.json`. When a vault has never been refreshed, the
 * freshness fields render as `(never refreshed)` — never as a
 * fabricated timestamp.
 *
 * Per PLAN-v3.1 §5, this is the surface the
 * `architect-cross-org-compare` skill points users at when they ask
 * "what orgs do you know about?". Per §12, it is CLI-only.
 *
 * The command is a thin shim around
 * `listRegisteredVaults` in `@sf-intelligence/vault`; the registry
 * helper carries the freshness-enrichment contract (a missing
 * `manifest.json` surfaces as `lastRefreshedAt: null` so the caller
 * never sees a fabricated date).
 */

import type { Result } from '@sf-intelligence/core';
import {
  listRegisteredVaults,
  type RegistryError,
  type VaultRef,
} from '@sf-intelligence/vault';
import { Command } from 'commander';

import { resolveRegistryRoot } from './register-vault.js';

/** JSON indentation, 2 spaces, matches the rest of the CLI. */
const JSON_INDENT = 2;
/** Width of the alias column in the text-output table. */
const ALIAS_COL_WIDTH = 20;
/** Width of the path column in the text-output table. */
const PATH_COL_WIDTH = 40;
/** Width of the refreshedAt column in the text-output table. */
const REFRESHED_COL_WIDTH = 32;

/** Options accepted by `runListVaults`. */
export interface RunListVaultsOptions {
  /** Co-resident registry root. Pre-resolved (see `resolveRegistryRoot`). */
  readonly rootDir: string;
}

/**
 * List every registered vault in the co-resident root. Each entry
 * carries the freshness metadata from its vault's manifest; vaults
 * that have never been refreshed show `lastRefreshedAt: null`.
 *
 * Returns an empty array when the registry file does not exist —
 * brand-new installs are a valid state and not an error.
 *
 * @example
 *   const r = await runListVaults({ rootDir: '/home/me/sf-intelligence-vaults' });
 *   if (r.ok) for (const v of r.value) console.log(v.alias);
 */
export const runListVaults = async (
  opts: RunListVaultsOptions,
): Promise<Result<readonly VaultRef[], RegistryError>> =>
  listRegisteredVaults(opts.rootDir);

/**
 * Format a `VaultRef[]` as a fixed-width text table for the CLI. When
 * the list is empty, returns a single line so the caller's stdout
 * write is still one operation.
 */
export const renderVaultsTable = (vaults: readonly VaultRef[]): string => {
  if (vaults.length === 0) {
    return 'No vaults registered. Run `sfi register-vault <alias> <path>` first.\n';
  }
  const headerLine = `${'ALIAS'.padEnd(ALIAS_COL_WIDTH)} ${'PATH'.padEnd(PATH_COL_WIDTH)} ${'LAST REFRESHED'.padEnd(REFRESHED_COL_WIDTH)} COMPONENTS`;
  const separatorLine = '-'.repeat(headerLine.length);
  const rows: string[] = [headerLine, separatorLine];
  for (const v of vaults) {
    const alias = v.alias.padEnd(ALIAS_COL_WIDTH);
    const path = truncate(v.path, PATH_COL_WIDTH).padEnd(PATH_COL_WIDTH);
    const refreshed = (v.lastRefreshedAt ?? '(never refreshed)').padEnd(
      REFRESHED_COL_WIDTH,
    );
    const components =
      v.componentCount === null ? '(none)' : String(v.componentCount);
    rows.push(`${alias} ${path} ${refreshed} ${components}`);
  }
  return `${rows.join('\n')}\n`;
};

/** Truncate `s` to `n` chars, appending `...` when it had to be cut. */
const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, Math.max(0, n - 3))}...` : s;

/** Commander flag shape. `--json` and `--root` are the only flags. */
interface ListVaultsCliFlags {
  readonly json?: boolean;
  readonly root?: string;
}

/**
 * Register the `sfi list-vaults` subcommand on `program`. Read-only —
 * prints to stdout, never writes. Always exits 0 on a successful
 * listing (including the "no vaults registered" case, which is a
 * structural answer not an error). Exits 1 only on registry I/O
 * failures (e.g., corrupt `registry.json`).
 *
 * @example
 *   registerListVaultsCommand(new Command());
 */
export const registerListVaultsCommand = (program: Command): void => {
  program
    .command('list-vaults')
    .description(
      'List every registered vault and its refresh state for v3.1 cross-vault tools',
    )
    .option(
      '--json',
      'Print the raw VaultRef array as pretty-printed JSON instead of the table',
      false,
    )
    .option(
      '--root <path>',
      'Co-resident registry root (default: $SF_INTELLIGENCE_REGISTRY_PATH or ~/sf-intelligence-vaults)',
    )
    .action(async (flags: ListVaultsCliFlags): Promise<void> => {
      const rootDir = resolveRegistryRoot({
        ...(flags.root !== undefined ? { root: flags.root } : {}),
      });
      const result = await runListVaults({ rootDir });
      if (!result.ok) {
        process.stderr.write(`sfi list-vaults: ${result.error.message}\n`);
        process.exit(1);
      }
      if (flags.json === true) {
        process.stdout.write(
          `${JSON.stringify(result.value, null, JSON_INDENT)}\n`,
        );
        return;
      }
      process.stdout.write(renderVaultsTable(result.value));
    });
};
