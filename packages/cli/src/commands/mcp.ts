import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  checkForUpdate,
  err,
  execHelper,
  formatUpdateNotice,
  ok,
  type Result,
} from '@sf-intelligence/core';
import {
  buildContext,
  createServer,
  createSetupServer,
  shutdown,
  startServer,
  type Context,
} from '@sf-intelligence/mcp';
import { vaultPaths } from '@sf-intelligence/vault';
import { Command } from 'commander';

import { readCliPackageVersion } from '../package-version.js';

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
  /**
   * Where a vault was looked for. Carried on the ERROR (not just the success
   * path) because setup mode has to tell the user which directory came up
   * empty — the single most useful fact when a host launched the server from
   * a cwd the user never chose.
   */
  readonly vaultRoot: string;
  /**
   * Org aliases we can name in the setup guidance: every authed org when no
   * vault exists yet, or just the vault's bound org once one does. Empty when
   * the `sf` CLI is absent or failed — setup mode then falls back to a
   * placeholder rather than inventing an alias.
   */
  readonly authedOrgs: readonly string[];
}

/** Probe the authed Salesforce orgs (alias or username). Injectable for tests. */
export type ListOrgs = () => Promise<readonly string[]>;

/** Options accepted by `prepareMcp`. `cwd` is explicit for test determinism. */
export interface PrepareMcpOptions {
  /** Working directory where `org-kb/` is expected. */
  readonly cwd: string;
  /**
   * Whether the no-vault message may NAME the authenticated orgs, rather than
   * only counting them.
   *
   * The names are genuinely useful — the user has to pick one — but this
   * message is written to stderr, and when an MCP host launches the server
   * that stream is a LOG FILE on disk (`mcp-server-sf-intelligence.log` and
   * friends), where a list of an organisation's Salesforce org aliases then
   * persists indefinitely. So names are opt-in: the CLI passes `true` only
   * when stderr is a TTY (a human running `sfi mcp` in a terminal, where the
   * text is transient). Host-launched servers get the count, and the assistant
   * reads the full list in-band from `sfi.setup_status` instead — the channel
   * the person actually asked a question on.
   *
   * Defaults to `false`: the conservative branch is the one that ships.
   */
  readonly discloseOrgNames?: boolean;
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

/**
 * List the user's authenticated Salesforce orgs via `sf org list --json`.
 * Best-effort: any failure (no sf CLI, not logged in, malformed JSON, or a
 * wedged `sf` subprocess that outlives its timeout) yields an empty list so
 * the no-vault hint degrades gracefully rather than throwing or hanging.
 *
 * CR-RV3b: routed through {@link execHelper} (the shared cross-platform `sf`
 * exec seam) instead of a bare `promisify(execFile)` call, so this probe
 * inherits the same `SFI_SF_EXEC_TIMEOUT_MS`-backed timeout (10-min default)
 * and SIGTERM→SIGKILL escalation as every other `sf` shellout in the plugin
 * — a hung `sf` process can no longer wedge `sfi mcp` startup forever. The
 * timeout rejection is caught by the existing `catch` below exactly like any
 * other exec failure, so the graceful-degrade contract is unchanged.
 */
const defaultListOrgs: ListOrgs = async () => {
  try {
    const { stdout } = await execHelper('sf', ['org', 'list', '--json'], {
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
    // Make the dead-end actionable: say how many orgs are authed so the user
    // knows the `sf` CLI is working and a choice exists. We deliberately do NOT
    // auto-boot a live-only server against a guessed default org — with several
    // orgs authed that risks querying the wrong one, and the product never
    // guesses which org a question is about.
    //
    // The ALIASES are withheld unless `discloseOrgNames` is set, because this
    // string lands in the host's MCP log file (see the option's doc comment).
    // The names are not lost: `sfi.setup_status` returns them over MCP, in-band,
    // to the assistant that was asked for help.
    const names = opts.discloseOrgNames === true
      ? `: ${orgs.slice(0, 8).join(', ')}${orgs.length > 8 ? ', …' : ''}`
      : '';
    const hint =
      orgs.length > 0
        ? ` You are authenticated to ${orgs.length} org(s)${names}.` +
          ` Run \`sfi init\` to pick the one you want and build` +
          ` its knowledge base — live answers attach to a vault's org, so the product never` +
          ` guesses which of your orgs to query.`
        : '';
    return err({
      kind: 'no-vault',
      message: base + hint,
      vaultRoot,
      authedOrgs: orgs,
    });
  }

  const ctxResult = await buildContext(vaultRoot);
  if (!ctxResult.ok) {
    // A config exists, so the org is already chosen — name THAT one in the
    // setup guidance rather than re-listing every authed org (which would
    // invite the user to re-bind a repo that is already bound).
    const boundOrg = await readBoundOrg(paths.config).catch(() => null);
    return err({
      kind: 'buildContext-failed',
      message: ctxResult.error.message,
      vaultRoot,
      authedOrgs: boundOrg !== null ? [boundOrg] : [],
    });
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

/** The resolved vault binding for `sfi mcp`: the chosen root (or `undefined`
 *  to signal the `./org-kb` default) plus the human-readable source label the
 *  startup log announces on stderr. */
export interface VaultBinding {
  /** The vault root passed to {@link prepareMcp}, or `undefined` for `./org-kb`. */
  readonly vaultRoot: string | undefined;
  /** Which mechanism selected it, verbatim for the stderr announcement. */
  readonly bindSource: '--vault' | 'SFI_VAULT' | 'default ./org-kb';
}

/**
 * Resolve the vault-binding precedence for `sfi mcp`, most explicit first: the
 * `--vault` flag, then the `SFI_VAULT` env var (trimmed; blank/whitespace-only
 * is ignored so `plugin.json` can ship with an empty default), then the launch
 * directory's `./org-kb`. Pure + exported so the precedence — and the
 * `bindSource` label the server prints so an auto-selected bind is never silent
 * — is unit-testable without driving the blocking stdio server.
 *
 * @example
 *   resolveVaultBinding(undefined, '/srv/org-kb'); // env wins → { vaultRoot: '/srv/org-kb', bindSource: 'SFI_VAULT' }
 */
export const resolveVaultBinding = (
  flagVault: string | undefined,
  envVault: string | undefined,
): VaultBinding => {
  const trimmedEnv =
    envVault !== undefined && envVault.trim().length > 0
      ? envVault.trim()
      : undefined;
  const vaultRoot = flagVault ?? trimmedEnv;
  const bindSource =
    flagVault !== undefined
      ? '--vault'
      : vaultRoot !== undefined
        ? 'SFI_VAULT'
        : 'default ./org-kb';
  return { vaultRoot, bindSource };
};

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
      'Serve a specific org-kb vault instead of ./org-kb (bind a project to the right org). ' +
        'Also settable via the SFI_VAULT env var; precedence: --vault > SFI_VAULT > ./org-kb.',
    )
    .action(async (cmdOpts: { readonly vault?: string }): Promise<void> => {
      // Vault-binding precedence, most explicit first: the `--vault` flag, then
      // the `SFI_VAULT` env var (so `plugin.json` can ship as-is and a user
      // sets the path ONCE in their MCP config's `env` block instead of editing
      // the plugin), then the launch directory's `./org-kb`. Whichever wins is
      // named on stderr below, so an auto-selected bind is never silent — the
      // core cure for "which repo is bound to which org?" confusion.
      const { vaultRoot: boundVault, bindSource } = resolveVaultBinding(
        cmdOpts.vault,
        process.env['SFI_VAULT'],
      );
      const prepared = await prepareMcp({
        cwd: process.cwd(),
        // A TTY means a human is watching this scroll past in their own
        // terminal; anything else means a host is capturing it to a log file.
        discloseOrgNames: process.stderr.isTTY === true,
        ...(boundVault !== undefined ? { vaultRoot: boundVault } : {}),
      });
      if (!prepared.ok) {
        // Do NOT exit. An MCP host that loses the server shows the user
        // "failed to connect" and nothing else — this message goes to stderr,
        // which is hidden or buried in a log file, so exiting here made the
        // product's own setup instructions unreachable by the only audience
        // that needs them. Boot setup mode instead: the chat can then read
        // `sfi.setup_status` and walk the user through init/refresh. See
        // packages/mcp/src/setup-server.ts for the full rationale.
        process.stderr.write(`sfi mcp: ${prepared.error.message}\n`);
        const setup = createSetupServer({
          reason:
            prepared.error.kind === 'no-vault' ? 'no-vault' : 'vault-missing',
          detail: prepared.error.message,
          cwd: process.cwd(),
          expectedVaultRoot: prepared.error.vaultRoot,
          bindSource,
          authedOrgs: prepared.error.authedOrgs,
          version: readCliPackageVersion(),
        });
        await startServer(setup);
        return;
      }
      const { ctx, server, vaultRoot, targetOrg } = prepared.value;
      // Expose the running plugin version to in-process tools. health_check's
      // offline vault-version nudge compares it to the vault's builder version
      // (manifest.version) to advise a re-refresh when the plugin has moved on.
      process.env['SFI_PLUGIN_VERSION'] = readCliPackageVersion();
      // Announce the bound vault/org on stderr (stdout is reserved for JSON-RPC).
      // A wrong-org session is otherwise silent — the server serves whatever
      // vault its launch directory holds, so make that choice impossible to miss.
      process.stderr.write(
        `sfi mcp: serving vault ${vaultRoot} [bound via ${bindSource}]` +
          `${targetOrg !== null ? ` (org: ${targetOrg})` : ' (no targetOrg in config)'}\n`,
      );
      // One-time "update available" nudge on stderr (stdout is reserved for
      // JSON-RPC). Fire-and-forget: do NOT await — a cache miss triggers a
      // ~3s registry GET that would otherwise delay `startServer` and make the
      // server appear unresponsive to the MCP client. AUDIT-F2: opt-IN — no
      // network unless SFI_UPDATE_CHECK=1 or SFI_NETWORK_MODE=updates-only
      // (default networkMode=off). Still force-off via SFI_NO_UPDATE_CHECK=1 / CI.
      void checkForUpdate(readCliPackageVersion()).then(
        (result) => {
          const notice = formatUpdateNotice(result);
          if (notice !== null) process.stderr.write(`sfi mcp: ${notice}\n`);
        },
        () => {
          // The update check is best-effort; never let it stop the server.
        },
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
