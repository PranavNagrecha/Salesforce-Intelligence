import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { err, ok, type Result } from '@sf-intelligence/core';
import {
  buildContext,
  createServer,
  shutdown,
  startServer,
  type Context,
} from '@sf-intelligence/mcp';
import { vaultPaths } from '@sf-intelligence/vault';
import { Command } from 'commander';

/**
 * Inferred return type of `@sf-intelligence/mcp`'s `createServer`. We avoid
 * importing the `Server` type directly from `@modelcontextprotocol/sdk`
 * because that SDK is a transitive dep of `@sf-intelligence/mcp`, not a
 * direct dep of the CLI package — depending on it explicitly would couple
 * the CLI to a transport implementation detail.
 */
type McpServer = ReturnType<typeof createServer>;

/** Default vault root, identical to `sfi init`'s default. The MCP command is
 *  invoked by clients (Claude Desktop/Code) from the project root. */
const DEFAULT_VAULT_ROOT = 'org-kb';
/** Signals that should trigger a graceful MCP shutdown. */
const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

/**
 * The error variants `prepareMcp` can return.
 *
 *   - `no-vault`: `org-kb/meta/config.json` does not exist — the user has not
 *     run `sfi init`. Message instructs them to run `sfi init` followed by
 *     `sfi refresh` so the failure mode is recoverable in two steps.
 *   - `buildContext-failed`: the vault exists but the MCP server's
 *     `buildContext` (which loads the manifest and opens the graph) failed.
 *     The wrapped message comes straight from `@sf-intelligence/mcp`.
 */
export interface McpStartupError {
  readonly kind: 'no-vault' | 'buildContext-failed';
  readonly message: string;
}

/** Probe the authed Salesforce orgs (alias or username). Injectable for tests. */
export type ListOrgs = () => Promise<readonly string[]>;

/** Options accepted by `prepareMcp`. `cwd` is explicit for test determinism. */
export interface PrepareMcpOptions {
  /** Working directory where `org-kb/` is expected. */
  readonly cwd: string;
  /**
   * Explicit vault root, overriding `cwd/org-kb`. Lets a multi-org host bind
   * each project to the right vault (`sfi mcp --vault <path>`) instead of
   * relying on the launch directory — the server cannot know which repo the
   * question is about, so the operator points it at the correct org.
   */
  readonly vaultRoot?: string;
  /** Override the authed-org probe (defaults to `sf org list --json`). */
  readonly listOrgs?: ListOrgs;
}

/** Read `targetOrg` from a vault `config.json`, or null if unreadable/absent. */
const readBoundOrg = async (configPath: string): Promise<string | null> => {
  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as { targetOrg?: unknown };
    return typeof parsed.targetOrg === 'string' ? parsed.targetOrg : null;
  } catch {
    return null;
  }
};

const nodeExecFile = promisify(execFile);

/**
 * List the user's authenticated Salesforce orgs via `sf org list --json`.
 * Best-effort: any failure (no sf CLI, not logged in, malformed JSON) yields an
 * empty list so the no-vault hint degrades gracefully rather than throwing.
 */
const defaultListOrgs: ListOrgs = async () => {
  try {
    const { stdout } = await nodeExecFile('sf', ['org', 'list', '--json'], {
      maxBuffer: 10 * 1024 * 1024,
    });
    const json = JSON.parse(stdout) as {
      result?: Record<string, readonly { alias?: string; username?: string }[]>;
    };
    const groups = json.result ?? {};
    const seen = new Set<string>();
    const out: string[] = [];
    for (const list of Object.values(groups)) {
      for (const org of list ?? []) {
        const label = org.alias ?? org.username;
        if (label && !seen.has(label)) {
          seen.add(label);
          out.push(label);
        }
      }
    }
    return out;
  } catch {
    return [];
  }
};

/**
 * Outcome of a successful `prepareMcp` — a wired-up server and the context
 * that owns the open graph connection. Callers must connect the server to
 * a transport (via `startServer`) and call `shutdown(ctx)` when done.
 */
export interface McpReady {
  readonly ctx: Context;
  readonly server: McpServer;
  /** Absolute vault root this server is serving (for the startup log line). */
  readonly vaultRoot: string;
  /** Org alias the served vault is bound to, or null if the config omits it. */
  readonly targetOrg: string | null;
}

/**
 * Load the vault config, build the MCP context, and construct the server —
 * everything needed to start the stdio transport except the `startServer`
 * call itself. Splitting startup from the blocking transport call keeps
 * the bulk of the command testable without ever opening real stdio.
 *
 * @example
 *   const r = await prepareMcp({ cwd: process.cwd() });
 *   if (!r.ok) { console.error(r.error.message); process.exit(1); }
 *   await startServer(r.value.server);  // blocks until client disconnects
 *   await shutdown(r.value.ctx);
 */
export const prepareMcp = async (
  opts: PrepareMcpOptions,
): Promise<Result<McpReady, McpStartupError>> => {
  const vaultRoot =
    opts.vaultRoot !== undefined
      ? resolve(opts.cwd, opts.vaultRoot)
      : resolve(opts.cwd, DEFAULT_VAULT_ROOT);
  const paths = vaultPaths(vaultRoot);

  if (!(await pathExists(paths.config))) {
    const orgs = await (opts.listOrgs ?? defaultListOrgs)();
    const where = opts.vaultRoot !== undefined ? ` at ${vaultRoot}` : '';
    const base = `No vault${where}. Run \`sfi init\` followed by \`sfi refresh\`, or point \`sfi mcp --vault <path>\` at an existing org-kb.`;
    // Make the dead-end actionable: name the authed orgs so the user can pick
    // one. We deliberately do NOT auto-boot a live-only server against a guessed
    // default org — with several orgs authed that risks querying the wrong one,
    // and the product never guesses which org a question is about.
    const hint =
      orgs.length > 0
        ? ` You are authenticated to ${orgs.length} org(s): ${orgs.slice(0, 8).join(', ')}` +
          `${orgs.length > 8 ? ', …' : ''}. Run \`sfi init\` to pick the one you want and build` +
          ` its knowledge base — live answers attach to a vault's org, so the product never` +
          ` guesses which of your orgs to query.`
        : '';
    return err({ kind: 'no-vault', message: base + hint });
  }

  const ctxResult = await buildContext(vaultRoot);
  if (!ctxResult.ok) {
    return err({ kind: 'buildContext-failed', message: ctxResult.error.message });
  }

  const targetOrg = await readBoundOrg(paths.config);
  return ok({
    ctx: ctxResult.value,
    server: createServer(ctxResult.value),
    vaultRoot,
    targetOrg,
  });
};

/** Return `true` if `path` exists. Permission errors are treated as "exists"
 *  so the command does not silently misreport as `no-vault` on a directory
 *  it cannot read. */
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
 * Register the `sfi mcp` subcommand on `program`.
 *
 * stdio constraint: this command's stdout is reserved for MCP JSON-RPC.
 * The handler writes only to stderr (`console.error`/`process.stderr`),
 * never stdout. Any extra bytes on stdout would corrupt the protocol.
 *
 * @example
 *   const program = new Command();
 *   registerMcpCommand(program);
 *   await program.parseAsync(['node', 'sfi', 'mcp']);
 */
export const registerMcpCommand = (program: Command): void => {
  program
    .command('mcp')
    .description('Run the MCP server backing the org-kb vault')
    .option(
      '--vault <path>',
      'Serve a specific org-kb vault instead of ./org-kb (bind a project to the right org)',
    )
    .action(async (cmdOpts: { readonly vault?: string }): Promise<void> => {
      const prepared = await prepareMcp({
        cwd: process.cwd(),
        ...(cmdOpts.vault !== undefined ? { vaultRoot: cmdOpts.vault } : {}),
      });
      if (!prepared.ok) {
        process.stderr.write(`sfi mcp: ${prepared.error.message}\n`);
        process.exit(1);
      }
      const { ctx, server, vaultRoot, targetOrg } = prepared.value;
      // Announce the bound vault/org on stderr (stdout is reserved for JSON-RPC).
      // A wrong-org session is otherwise silent — the server serves whatever
      // vault its launch directory holds, so make that choice impossible to miss.
      process.stderr.write(
        `sfi mcp: serving vault ${vaultRoot}` +
          `${targetOrg !== null ? ` (org: ${targetOrg})` : ' (no targetOrg in config)'}\n`,
      );
      const shutdownOnce = makeShutdownOnce(ctx);
      for (const signal of SHUTDOWN_SIGNALS) {
        process.on(signal, () => {
          void shutdownOnce().then(() => process.exit(0));
        });
      }
      // Blocks until the stdio transport closes (MCP client disconnect).
      await startServer(server);
      await shutdownOnce();
    });
};

/**
 * Return a `shutdown(ctx)` wrapper that runs at most once. `mcp.shutdown`
 * calls DuckDB's synchronous disconnect, which is not safe to repeat —
 * the wrapper protects both the signal-driven and transport-close-driven
 * exit paths from double-invoking it.
 */
const makeShutdownOnce = (ctx: Context): (() => Promise<void>) => {
  let done: Promise<void> | null = null;
  return (): Promise<void> => {
    if (done === null) done = shutdown(ctx);
    return done;
  };
};
