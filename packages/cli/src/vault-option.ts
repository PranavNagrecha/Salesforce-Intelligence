/**
 * `--vault <path>` — one meaning for every command that reads or writes a
 * vault, so a script can name the vault instead of `cd`-ing into its folder.
 *
 * The path may name the vault itself (`…/org-kb`) or the folder that holds it.
 * Precedence, most explicit first: the flag, then the `SFI_VAULT` env var
 * (blank ignored), then `./org-kb`. Commands that look for `./org-kb` take the
 * returned `projectDir` as their working directory; commands that open the
 * vault directly take `vaultRoot`.
 */

import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { err, ok, type Result } from '@sf-intelligence/core';
import type { Command } from 'commander';

/** Help text shared by every command's `--vault` option. */
export const VAULT_OPTION_HELP =
  'The vault to use: an org-kb folder or the folder that holds one (default: SFI_VAULT, then ./org-kb).';

/** Where the vault is, and which mechanism chose it. */
export interface ResolvedVault {
  /** Absolute path of the vault (`…/org-kb`). */
  readonly vaultRoot: string;
  /**
   * The folder holding the vault — the working directory for commands that
   * look for `./org-kb`. `null` when the vault folder has another name (only
   * commands that open the vault directly can use it).
   */
  readonly projectDir: string | null;
  readonly bindSource: '--vault' | 'SFI_VAULT' | 'default ./org-kb';
}

const looksLikeVault = (dir: string): boolean =>
  existsSync(join(dir, 'meta')) || existsSync(join(dir, 'graph'));

/**
 * Resolve `--vault` (or `SFI_VAULT`, or `./org-kb`). A named path that holds
 * no vault is an error rather than a silent fall-back to `./org-kb`; the
 * default is returned as-is so each command keeps its own "no vault yet"
 * message.
 */
export const resolveVaultOption = (
  flag: string | undefined,
  opts: { readonly cwd?: string; readonly env?: string | undefined } = {},
): Result<ResolvedVault, string> => {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env !== undefined && opts.env.trim().length > 0 ? opts.env.trim() : undefined;
  const named = flag ?? env;
  if (named === undefined) {
    return ok({ vaultRoot: resolve(cwd, 'org-kb'), projectDir: cwd, bindSource: 'default ./org-kb' });
  }
  const bindSource = flag !== undefined ? '--vault' : 'SFI_VAULT';
  const path = resolve(cwd, named);
  if (looksLikeVault(join(path, 'org-kb'))) {
    return ok({ vaultRoot: join(path, 'org-kb'), projectDir: path, bindSource });
  }
  if (looksLikeVault(path)) {
    return ok({ vaultRoot: path, projectDir: basename(path) === 'org-kb' ? dirname(path) : null, bindSource });
  }
  return err(`${bindSource} ${named}: no vault at ${path} (expected an org-kb folder, or a folder holding one).`);
};

/**
 * Resolve the vault for a command action, or print the reason and set a
 * non-zero exit code. `flags.vault` is the command's `--vault`.
 */
export const vaultForAction = (flags: { readonly vault?: string | undefined }): ResolvedVault | null => {
  const resolved = resolveVaultOption(flags.vault, { env: process.env['SFI_VAULT'] });
  if (!resolved.ok) {
    process.stderr.write(`sfi: ${resolved.error}\n`);
    process.exitCode = 1;
    return null;
  }
  return resolved.value;
};

/**
 * The working directory for a command that looks for `./org-kb`, from its
 * `--vault`; `null` (reason printed, exit code set) when the vault cannot be
 * used that way.
 */
export const projectDirForAction = (flags: { readonly vault?: string | undefined }): string | null => {
  const vault = vaultForAction(flags);
  if (vault === null) return null;
  if (vault.projectDir === null) {
    process.stderr.write(`sfi: this command needs the vault folder to be named org-kb (got ${vault.vaultRoot}); pass the folder that holds org-kb.\n`);
    process.exitCode = 1;
    return null;
  }
  return vault.projectDir;
};

/** Add the shared `--vault <path>` option to a command. */
export const withVaultOption = (command: Command): Command => command.option('--vault <path>', VAULT_OPTION_HELP);
