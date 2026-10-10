/**
 * Setup-mode MCP server — the server that answers when there is no vault yet.
 *
 * ## Why this exists
 *
 * The chat window is the ONLY interface a new user has. Before this module,
 * `sfi mcp` wrote an excellent, actionable "no vault — run `sfi init`" message
 * to **stderr** and then `process.exit(1)`. Every MCP host treats that as a
 * failed server: Claude Desktop shows "server disconnected", VS Code shows the
 * server stuck in "starting", Codex logs a startup failure. stderr is hidden or
 * buried in a log file, so the one sentence that would have unblocked the user
 * is the one sentence they never see. The product's own onboarding advice was
 * written to a channel the audience cannot read.
 *
 * Worse, the trigger is not rare — it is the DEFAULT first experience. Vault
 * discovery resolves `./org-kb` against the **server process's cwd**, and a GUI
 * host picks that cwd, not the user. Three separate ordinary paths land here:
 *
 *   1. the user registered the server before running `sfi init` (the common case);
 *   2. the user ran `sfi init` but has not run `sfi refresh` yet;
 *   3. the user did everything right, but the host launched the server from a
 *      directory that is not the DX repo — so `./org-kb` does not resolve.
 *
 * All three produced an identical, unexplained dead server.
 *
 * ## What this does instead
 *
 * Boot anyway, in a deliberately tiny mode: advertise MCP `instructions` (hosts
 * surface these without a tool call) and expose a single read-only tool,
 * `sfi.setup_status`, that reports exactly what is missing and the exact next
 * command — platform-correct, and naming the authenticated orgs when we know
 * them. The chat can then walk the user through setup, which is the whole point.
 *
 * ## What this deliberately does NOT do
 *
 * It does not run `sfi init` or `sfi refresh` for the user. `refresh` contacts
 * the org and takes minutes; `init` picks WHICH org a repo is bound to. The
 * product's standing rule is that it never guesses which org a question is
 * about, and a silent auto-bind would be exactly that guess. Setup mode reports;
 * the host's own shell runs the command. That also keeps this module free of the
 * graph/vault dependencies — it must boot when nothing else can.
 */

import { dirname } from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { DOCS_URL, FEEDBACK_ISSUES_URL } from '@sf-intelligence/core';

/** Why the full server could not start. Mirrors `prepareMcp`'s error kinds. */
export type SetupReason =
  | 'no-vault'
  /** An explicit `--vault` / `SFI_VAULT` path that does not exist or is not a directory (likely a typo). */
  | 'vault-path-not-found'
  | 'vault-missing'
  | 'manifest-load-failed'
  | 'graph-open-failed'
  | 'unknown';

/** Everything setup mode needs to give an accurate answer. */
export interface SetupState {
  /** Why the vault-backed server could not start. */
  readonly reason: SetupReason;
  /** The underlying message from `prepareMcp`, verbatim. */
  readonly detail: string;
  /** The directory the host launched the server in. */
  readonly cwd: string;
  /** Where a vault was looked for (absolute). */
  readonly expectedVaultRoot: string;
  /** How that location was chosen — `--vault`, `SFI_VAULT`, or the cwd default. */
  readonly bindSource: string;
  /** Salesforce orgs the local `sf` CLI is authenticated to, if discoverable. */
  readonly authedOrgs: readonly string[];
  /** The sf CLI's default org, if known — named as the default, never adopted. */
  readonly defaultOrg?: string;
  /** Product version, for the handshake. */
  readonly version: string;
}

/**
 * The `%FOO%` / `$env:FOO` / `export FOO=` split is a real onboarding tripwire:
 * a Windows user pasting a POSIX `export` line gets a syntax error, and the
 * product's docs are POSIX-only today. Setup mode answers in the shell the user
 * is actually in.
 */
const isWindows = (): boolean => process.platform === 'win32';

/**
 * Quote a path for the user's shell so a path containing spaces (the norm on
 * Windows — `C:\Users\First Last\...` — and common on macOS) is copy-pasteable.
 */
const quotePath = (p: string): string => (p.includes(' ') ? `"${p}"` : p);

/**
 * The ordered, copy-pasteable steps that get this user from where they are to a
 * working chat. Every step is a command the HOST runs, not something this server
 * does. `reason` decides where the list starts, so a user who already ran `init`
 * is not told to run it again.
 */
const setupSteps = (state: SetupState): readonly string[] => {
  // FR-02: never the cwd-derived path (that is where the server already
  // looked and failed) and never an arbitrary authed org — `authedOrgs[0]` is
  // just the first row of `sf org list`, not a choice anyone made.
  const vaultFlag = '--vault <absolute path to your project>/org-kb';
  const org = '<your-org-alias>';
  const orgHint =
    state.defaultOrg !== undefined
      ? ` (your sf default org is \`${state.defaultOrg}\` — use it only if that is the org this project models)`
      : state.authedOrgs.length > 0
        ? ' (pick one of the authenticated orgs listed in `authenticatedOrgs`)'
        : '';
  if (state.reason === 'vault-path-not-found') {
    return [
      `The vault path given via ${state.bindSource} (${quotePath(state.expectedVaultRoot)}) does not exist or is not a directory — check it for a typo. It must be the absolute path of an existing \`org-kb\` directory.`,
      'Fix the path in the MCP server config, then restart the MCP server (or reconnect it in your client).',
      `If you have not built a vault yet, run \`npx -y sf-intelligence init --target-org ${org}\`${orgHint} and \`npx -y sf-intelligence refresh\` in your Salesforce DX project first.`,
    ];
  }
  const needsInit = state.reason === 'no-vault';

  const steps: string[] = [];
  if (needsInit) {
    steps.push(
      'Change into the Salesforce DX repo you want to model (the directory holding `sfdx-project.json`).',
      `Run \`npx -y sf-intelligence init --target-org ${org}\`${orgHint} to create the vault and bind it to one org.`,
    );
  }
  // After init the earlier step named the project; otherwise name it here —
  // the vault's parent directory is the project `refresh` must run in.
  const where = needsInit
    ? 'in that project'
    : `in the project that holds the vault (${quotePath(dirname(state.expectedVaultRoot))})`;
  steps.push(
    `Run \`npx -y sf-intelligence refresh\` ${where} to retrieve metadata and build the vault. First run takes a few minutes on a real org.`,
  );
  steps.push(
    'Restart this MCP server (or reconnect it in your client) — it does not reload by itself after the vault is built.',
  );
  // The cwd trap is invisible from inside the chat, so name it explicitly
  // whenever the bind came from the launch directory rather than an explicit
  // choice — that is exactly the configuration that silently breaks.
  if (state.bindSource.includes('org-kb')) {
    steps.push(
      `If the vault already exists somewhere else, the server is looking in the wrong place: it resolved \`./org-kb\` against its launch directory (${quotePath(state.cwd)}), which your MCP client chose — not you. Pin it instead by adding \`${vaultFlag}\` to the server's args, or setting the \`SFI_VAULT\` environment variable in the server's config.`,
    );
  }
  return steps;
};

/** Human-readable one-liner for the `instructions` handshake field. */
const headline = (state: SetupState): string => {
  switch (state.reason) {
    case 'no-vault':
      return 'sf-intelligence is running but has no knowledge base yet — the user has not built a vault for this project.';
    case 'vault-path-not-found':
      return `sf-intelligence was pointed at a vault path that does not exist (${state.expectedVaultRoot}) — likely a typo in --vault / SFI_VAULT.`;
    case 'vault-missing':
      return 'sf-intelligence found a vault config but no built vault — `refresh` has not completed for this project.';
    case 'manifest-load-failed':
      return "sf-intelligence found a vault whose manifest could not be read — it is likely from an interrupted refresh.";
    case 'graph-open-failed':
      return 'sf-intelligence found a vault whose dependency graph could not be opened — it is likely from an interrupted refresh.';
    default:
      return 'sf-intelligence could not open a knowledge base for this project.';
  }
};

/**
 * MCP `instructions`. Hosts surface these at connect time WITHOUT a tool call,
 * so the guidance reaches the model even if it never thinks to ask. Keep it
 * short and unambiguous about the one thing that matters: do not answer org
 * questions from guesswork.
 */
const setupInstructions = (state: SetupState): string =>
  [
    headline(state),
    '',
    `IMPORTANT: in this state the server can answer NOTHING about the user's Salesforce org — no objects, fields, permissions, Apex or Flows. Do not guess, and do not answer org questions from general Salesforce knowledge; ${
      state.reason === 'vault-path-not-found'
        ? 'say the configured vault path does not exist.'
        : 'say the knowledge base is not available yet.'
    }`,
    '',
    'Call `sfi.setup_status` for the exact next command, then offer to run it for the user. Once the vault is built, the user must restart this MCP server (or reconnect it) to get the full tool set — it does not reload by itself.',
  ].join('\n');

/** The one tool setup mode exposes. Read-only, closed-world, no arguments. */
const SETUP_TOOL = {
  name: 'sfi.setup_status',
  description:
    'Report why sf-intelligence has no usable knowledge base in this session (none built yet, an unfinished build, or a configured vault path that does not exist), and the exact ordered commands to fix it. Read-only; runs nothing. Call this before telling the user anything about their Salesforce org — in this state the server has no org data at all.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    required: [] as readonly string[],
    additionalProperties: false,
  },
  annotations: {
    title: 'Setup status',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

/**
 * Build the `sfi.setup_status` payload. Exported so tests can assert the
 * contract without standing up a transport.
 */
export const setupStatusPayload = (
  state: SetupState,
): Readonly<Record<string, unknown>> => ({
  data: {
    status: 'setup-required',
    reason: state.reason,
    // FR-02: `prepareMcp`'s message for a missing path says "run sfi init",
    // which contradicts nextSteps for a mistyped explicit path.
    detail:
      state.reason === 'vault-path-not-found'
        ? `No directory at ${state.expectedVaultRoot} (set via ${state.bindSource}).`
        : state.detail,
    summary: headline(state),
    /**
     * Honest statement of capability. The router/answer surfaces are absent in
     * this mode, so say so rather than letting a host infer that an empty tool
     * list means "nothing to report".
     */
    canAnswerOrgQuestions: false,
    lookedForVaultAt: state.expectedVaultRoot,
    vaultBoundVia: state.bindSource,
    serverLaunchDirectory: state.cwd,
    authenticatedOrgs: state.authedOrgs,
    nextSteps: setupSteps(state),
    shell: isWindows() ? 'windows' : 'posix',
    /**
     * The env-var form differs per shell and a wrong one is a dead end for a
     * non-developer. Give the exact line for the shell they are in.
     */
    pinVaultExample: isWindows()
      ? `$env:SFI_VAULT = '<absolute path to your project>\\org-kb'`
      : `export SFI_VAULT='<absolute path to your project>/org-kb'`,
    docs: DOCS_URL,
    /**
     * The feedback channel, stated where the failure is.
     *
     * This is the one tool a stranger reaches when the server started but found
     * no org — the single moment a first run is most likely to be going wrong.
     * It offered a docs link and no way to tell anyone that the documented
     * steps did not work. The repository has had issues open and unrestricted
     * since publication and has never received one; a feedback path that lives
     * only in `sfi doctor` and near the end of a 724-line README is a path for
     * people who already succeeded.
     *
     * Deliberately phrased as "these steps did not work" rather than "report a
     * bug": the common case here is a config the docs got wrong, which is worth
     * more to fix than it is to a user to diagnose.
     */
    ifTheseStepsDoNotWork: `Tell us — the setup path getting something wrong is the likeliest cause: ${FEEDBACK_ISSUES_URL}`,
  },
  provenance: 'setup_mode',
  disclosures: [
    'sf-intelligence is running in setup mode: no vault is bound, so no org metadata is available.',
  ],
});

/**
 * Construct the setup-mode MCP server: the MCP `instructions` handshake plus a
 * single read-only `sfi.setup_status` tool. Connect it with the same
 * {@link startServer} used for the vault-backed server.
 *
 * @example
 *   const server = createSetupServer({ reason: 'no-vault', … });
 *   await startServer(server);
 */
export const createSetupServer = (state: SetupState): Server => {
  const server = new Server(
    { name: 'sf-intelligence', version: state.version },
    {
      capabilities: { tools: {} },
      instructions: setupInstructions(state),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [SETUP_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== SETUP_TOOL.name) {
      const body = {
        error: {
          kind: 'setup-required',
          message: `${headline(state)} So \`${request.params.name}\` cannot answer. Call \`${SETUP_TOOL.name}\` for the exact next commands.`,
        },
        provenance: 'setup_mode',
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(body) }],
        isError: true,
      } satisfies CallToolResult;
    }
    const body = setupStatusPayload(state);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(body) }],
    } satisfies CallToolResult;
  });

  return server;
};
