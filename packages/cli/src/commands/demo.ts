import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { shutdown, startServer } from '@sf-intelligence/mcp';
import { Command } from 'commander';

import { runInit } from './init.js';
import { prepareMcp } from './mcp.js';
import { runRefresh } from './refresh.js';

/**
 * Build-time injected version (esbuild `define`). Lets the cached demo vault
 * rebuild automatically after a package upgrade. Falls back to `'dev'` in
 * unbundled (tsc/test) runs.
 */
declare const SFI_BUILD_VERSION: string | undefined;
const buildVersion = (): string =>
  typeof SFI_BUILD_VERSION !== 'undefined' ? SFI_BUILD_VERSION : 'dev';

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * Locate the synthetic demo source tree (`.../main/default`). Resolves both
 * the SHIPPED copy (`<pkg>/demo-source`, written by `build.mjs` and whitelisted
 * in `package.json` "files") and the in-repo canonical source
 * (`examples/demo-vault/source`) for dev/test runs — walking up from this
 * module so it works whether bundled to `dist/index.js` or run from
 * `dist/src/commands/`.
 */
export const resolveDemoSource = (): string | null => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 7; i += 1) {
    const shipped = join(dir, 'demo-source', 'main', 'default');
    if (existsSync(shipped)) return shipped;
    const repo = join(dir, 'examples', 'demo-vault', 'source', 'main', 'default');
    if (existsSync(repo)) return repo;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
};

/**
 * Register the `sfi demo` subcommand.
 *
 * Lets anyone try sf-intelligence with **no Salesforce org**: it builds the
 * bundled synthetic "Verdant Energy" org into a cached vault at
 * `~/.sf-intelligence/demo/org-kb` on first run (offline, a few seconds), then
 * serves it over MCP exactly like `sfi mcp --vault`. Subsequent runs reuse the
 * cache; `--rebuild` forces a fresh build, and a package upgrade triggers one
 * automatically via the version stamp.
 *
 * stdio constraint: like `sfi mcp`, stdout is reserved for MCP JSON-RPC. The
 * build phase and the startup notice write to stderr only.
 */
export const registerDemoCommand = (program: Command): void => {
  program
    .command('demo')
    .description(
      'Try sf-intelligence with no Salesforce org — serve a built-in synthetic demo org over MCP',
    )
    .option('--rebuild', 'Force a rebuild of the cached demo vault', false)
    .action(async (opts: { readonly rebuild?: boolean }): Promise<void> => {
      const source = resolveDemoSource();
      if (source === null) {
        process.stderr.write(
          'sfi demo: bundled demo source not found (expected a shipped demo-source/ or examples/demo-vault/source).\n',
        );
        process.exit(1);
      }

      const cacheCwd = join(homedir(), '.sf-intelligence', 'demo');
      const vaultRoot = join(cacheCwd, 'org-kb');
      const graphDb = join(vaultRoot, 'graph', 'graph.duckdb');
      const stampPath = join(vaultRoot, 'meta', 'demo-build.stamp');
      const stamp = `${buildVersion()}`;

      const stampOk = ((): boolean => {
        try {
          return readFileSync(stampPath, 'utf8').trim() === stamp;
        } catch {
          return false;
        }
      })();

      const needBuild = opts.rebuild === true || !existsSync(graphDb) || !stampOk;
      if (needBuild) {
        process.stderr.write('sfi demo: building the synthetic demo vault (first run, ~a few seconds)...\n');
        const init = await runInit({
          cwd: cacheCwd,
          targetOrg: 'demo-org',
          vaultRoot: 'org-kb',
          force: true,
        });
        if (!init.ok) {
          process.stderr.write(`sfi demo: could not initialise the demo vault: ${init.error.message}\n`);
          process.exit(1);
        }
        const sourceDest = join(vaultRoot, 'source', 'main', 'default');
        mkdirSync(dirname(sourceDest), { recursive: true });
        cpSync(source, sourceDest, { recursive: true });
        await runRefresh({ cwd: cacheCwd, noPull: true });
        if (!existsSync(graphDb)) {
          process.stderr.write('sfi demo: demo build failed — no graph was produced.\n');
          process.exit(1);
        }
        try {
          writeFileSync(stampPath, `${stamp}\n`);
        } catch {
          /* non-fatal: the cache just rebuilds next run */
        }
      }

      const prepared = await prepareMcp({ cwd: cacheCwd, vaultRoot: 'org-kb' });
      if (!prepared.ok) {
        process.stderr.write(`sfi demo: ${prepared.error.message}\n`);
        process.exit(1);
      }
      const { ctx, server, vaultRoot: served } = prepared.value;
      process.stderr.write(
        `sfi demo: serving the synthetic "Verdant Energy" demo org from ${served} (read-only, offline).\n`,
      );

      let shuttingDown: Promise<void> | null = null;
      const shutdownOnce = (): Promise<void> => (shuttingDown ??= shutdown(ctx));
      for (const signal of SHUTDOWN_SIGNALS) {
        process.on(signal, () => {
          void shutdownOnce().then(() => process.exit(0));
        });
      }
      await startServer(server);
      await shutdownOnce();
    });
};
