import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { registerAnnotateCommand } from './commands/annotate.js';
import { registerCompareVaultsCommand } from './commands/compare-vaults.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerFeedbackCommand } from './commands/feedback.js';
import { registerInitCommand } from './commands/init.js';
import { registerListVaultsCommand } from './commands/list-vaults.js';
import { registerMcpCommand } from './commands/mcp.js';
import { registerQuickstartCommand } from './commands/quickstart.js';
import { registerRefreshCommand } from './commands/refresh.js';
import { registerRegisterVaultCommand } from './commands/register-vault.js';
import { registerSelftestCommand } from './commands/selftest.js';
import { registerServeCommand } from './commands/serve.js';
import { registerSnapshotCommand } from './commands/snapshot.js';
import { registerStaleSweepCommand } from './commands/stale-sweep.js';
import { registerStatusCommand } from './commands/status.js';
import { registerVaultCommand } from './commands/vault-git.js';
import { registerWatchCommand } from './commands/watch.js';

/**
 * Resolve the CLI's own version by reading `package.json` at runtime.
 *
 * The file sits two directories above the compiled `program.js`
 * (`dist/src/program.js` → `../../package.json`). Reading it lazily — and
 * synchronously, since this is a CLI startup path — avoids embedding the
 * version at build time, which would force a rebuild on every bump.
 */
declare const SFI_BUILD_VERSION: string | undefined;

const readVersion = (): string => {
  // Bundled (esbuild) builds inline the version via `define`, skipping the file
  // read; unbundled builds (tsc/test) fall back to reading package.json.
  if (typeof SFI_BUILD_VERSION !== 'undefined') return SFI_BUILD_VERSION;
  const pkgUrl = new URL('../../package.json', import.meta.url);
  const raw = readFileSync(fileURLToPath(pkgUrl), 'utf8');
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? '0.0.0';
};

/**
 * Build the `sfi` commander program.
 *
 * Returns a fully configured `Command` instance with the full
 * subcommand surface wired in: the v0.1 baseline (`init`, `refresh`,
 * `status`, `mcp`), the v2.0c snapshot tier (`snapshot create/list/
 * delete`), and the v3.1 cross-vault tier (`register-vault`,
 * `list-vaults`, `compare-vaults`). The bin entrypoint
 * (`bin/sfi.js`) calls `.parseAsync(process.argv)` on the returned
 * program; tests can also call `createProgram()` to inspect or
 * mutate the program before parsing.
 *
 * @example
 *   import { createProgram } from '@sf-intelligence/cli';
 *
 *   const program = createProgram();
 *   await program.parseAsync(['node', 'sfi', 'status']);
 */
export const createProgram = (): Command => {
  const program = new Command();
  program
    .name('sfi')
    .description('SfIntelligence CLI — knowledge base for Salesforce orgs')
    .version(readVersion());

  registerInitCommand(program);
  registerQuickstartCommand(program);
  registerRefreshCommand(program);
  registerStatusCommand(program);
  registerStaleSweepCommand(program);
  registerWatchCommand(program);
  registerAnnotateCommand(program);
  registerVaultCommand(program);
  registerDoctorCommand(program);
  registerMcpCommand(program);
  registerServeCommand(program);
  registerSelftestCommand(program);
  registerFeedbackCommand(program);
  registerSnapshotCommand(program);
  // v3.1 R7 — cross-org / sandbox-vs-prod comparison tier.
  registerRegisterVaultCommand(program);
  registerListVaultsCommand(program);
  registerCompareVaultsCommand(program);

  return program;
};
