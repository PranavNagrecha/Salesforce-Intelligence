import { statSync } from 'node:fs';
import { join } from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  closeGraph,
  listNodesByType,
  openGraph,
  openGraphReadOnly,
  type GraphError,
  type GraphStore,
} from '@sf-intelligence/graph';
import {
  backfillCoverageInMemory,
  loadManifest,
  vaultPaths,
  type ExtendedVaultManifest,
} from '@sf-intelligence/vault';

import { registerResources } from './resources.js';
import { registerTools } from './tools/index.js';

/**
 * Identifies the MCP server in client-facing handshakes. Bumped in lockstep
 * with the package version when the server's contract changes.
 */
const SERVER_NAME = 'sf-intelligence';
const SERVER_VERSION = '0.1.0';

/**
 * Server-level usage guidance returned to the client in the `initialize`
 * handshake (MCP `InitializeResult.instructions`). This is the single
 * orientation channel that reaches a client BEFORE it has read the repo's
 * CLAUDE.md, loaded the entry skill, or called `sfi.capabilities` — and the
 * only one that is client-agnostic (a bare `mcp connect`, a non-Claude host).
 * It teaches the resolve-first contract protocol-side so the same pattern the
 * tool descriptions and `sfi.capabilities` already carry orients every fresh
 * session by default. Kept short on purpose: it is injected into context once
 * per connection, so it states the few rules that change routing and defers
 * the full catalog to `sfi.capabilities`.
 */
const SERVER_INSTRUCTIONS = `sf-intelligence is an offline, read-only knowledge base for ONE Salesforce org. It answers questions about that org's metadata — schema, fields, Apex, Flows, permissions & sharing, integrations, OmniStudio — plus dependency/impact analysis and generated documentation, all grounded in the last vault refresh (never the live org).

How to use it well:
- To orient a fresh session, or to answer "what can you do / what can I ask?", call \`sfi.capabilities\` (no arguments). It returns the categorized capability map, the live tool count, and the recommended conversational pattern.
- For a vague, broad, or compound question ("how many Accounts", "who can edit SSN", "which reports are useless", "what runs on save"), call \`sfi.route_question\` FIRST. In the default hybrid mode it returns \`toolCandidates\` — a meaning-ranked shortlist of tools — as the PRIMARY output, plus a \`guidance\` line: YOU read the candidates, resolve any named component, pick/sequence the tool(s), run them, and ground via \`sfi.synthesize_answer\`. The deterministic \`route\` (plane, ordered tools, dependency-aware plan) rides along as a non-authoritative HINT — use it to inform your pick, not as a command. If \`executionBlocked\` is true, STOP and ask \`route.clarification.question\` before running any routed tool; resume only with the exact offered \`clarificationId\` + selection, never an invented option. When neither the candidates nor the route place a question, tell the user the capability is not built rather than guessing. (A no-LLM host can set \`SFI_ROUTER_MODE=offline\` to make the deterministic route authoritative and omit candidates.)
- When the user names a component informally ("the email field", "the payment object", a typo), call \`sfi.resolve\` FIRST. It returns ranked candidates with a disposition: exact | ambiguous | none. Never guess a canonical id from memory. On \`ambiguous\`, ask the user to pick from the candidates; on \`none\`, offer \`/sfi-refresh\` (the vault may be stale) or stop — never fabricate a match.
- Every org artifact you name must come from an \`sfi.*\` tool call and be cited with its canonical id (e.g. \`CustomField:Account.Industry__c\`). Disclose provenance per claim: \`offline_snapshot\` for vault answers, \`live_org\` for live answers (stamp the as-of time from \`trust.freshness\`), \`hybrid\` when you fuse both — never let a live count imply the vault proved something, or vice-versa.
- Answers are only as fresh as the last refresh; if \`sfi.health_check\` reports stale or missing, tell the user to run \`/sfi-refresh\`. Record-level data (counts, samples, field population, org limits, inactive users) is LIVE, read-only, and queried at call time. The live plane is opt-in PER ORG: enable it once with \`sfi.live_consent { grant: true }\` (persists across sessions; still strictly read-only) — or SFI_LIVE_PLANE_ENABLED=1, or \`liveEnabled: true\` for a single call. If it is disabled, say so and offer to enable it; never infer record values from the vault.`;

/**
 * The runtime dependencies every MCP tool needs at invocation time:
 *   - `vaultRoot`: absolute path to the on-disk `org-kb/` vault.
 *   - `manifest`: snapshot of `meta/manifest.json` loaded at server start.
 *     Tools copy `sourceTreeHash` and `refreshedAt` from this into their
 *     `McpResponse.vaultState` envelope so clients can detect stale answers.
 *   - `graph`: open `GraphStore` handle. Queries (`searchNodes`,
 *     `getNodeById`, etc.) route through this connection. The server owns
 *     the lifecycle; tools must never close it.
 */
export interface Context {
  readonly vaultRoot: string;
  /**
   * The vault-package extended manifest shape (`loadManifest` returns it):
   * base `VaultManifest` plus `skippedDirectories` and — mid-staged-build —
   * the `staged` tier marker that health/coverage tools surface.
   */
  readonly manifest: ExtendedVaultManifest;
  readonly graph: GraphStore;
}

/**
 * The error variants `buildContext` can return.
 *
 *   - `vault-missing`: the manifest file does not exist (the vault has
 *     not been refreshed). Distinct from a corrupt manifest.
 *   - `manifest-load-failed`: the manifest exists but cannot be read or
 *     parsed (I/O error, malformed JSON).
 *   - `graph-open-failed`: the DuckDB graph store at
 *     `{vaultRoot}/graph/graph.duckdb` could not be opened or migrated.
 */
export interface ServerError {
  readonly kind: 'vault-missing' | 'manifest-load-failed' | 'graph-open-failed';
  readonly message: string;
}

/**
 * Build a `Context` for the MCP server by loading the manifest and
 * opening the graph store at `vaultRoot`.
 *
 * On failure returns a typed `ServerError`; callers should never see a
 * thrown error from this function. On success the caller owns the
 * `Context` and must invoke `shutdown(ctx)` to release the graph
 * connection.
 *
 * @example
 *   const ctxResult = await buildContext('/abs/path/to/org-kb');
 *   if (!ctxResult.ok) {
 *     console.error(ctxResult.error.message);
 *     return;
 *   }
 *   const server = createServer(ctxResult.value);
 *   await startServer(server);
 *   await shutdown(ctxResult.value);
 */
/**
 * Open the vault graph for the MCP server (P5-duckdb-readonly).
 *
 * The server NEVER writes the graph while serving — every tool is read-only —
 * so it opens READ-ONLY. A read-only DuckDB handle takes a SHARED lock, which
 * lets MULTIPLE `sfi mcp` instances (an IDE's server + a QA-harness server) and
 * other read-only consumers serve the SAME vault concurrently, instead of the
 * single-writer exclusive lock that forced "kill the server before every
 * harness run". (A `sfi refresh` still needs exclusive write — see the
 * `locked` error from openGraph.)
 *
 * Fallbacks to a read-write open (which creates the file and runs migrations):
 *   - the read-only open fails (no `graph.duckdb` yet — read-only can't create);
 *   - the read-only handle opens but a cheap probe fails, which means the vault
 *     was built by older code at a stale schema that needs migrating (refresh
 *     runs migrations, so a freshly-refreshed vault never hits this).
 *
 * The read-write fallback re-takes the exclusive lock; if THAT is also denied
 * (a concurrent refresh holds it), its `locked` error surfaces to the caller.
 */
const openServerGraph = async (
  graphDb: string,
): Promise<Result<GraphStore, GraphError>> => {
  const ro = await openGraphReadOnly(graphDb);
  if (ro.ok) {
    const probe = await listNodesByType(ro.value, 'CustomObject', { limit: 1 });
    if (probe.ok) return ok(ro.value);
    // Stale schema (or otherwise unqueryable read-only) — migrate via RW.
    await closeGraph(ro.value);
    return openGraph(graphDb);
  }
  // No file yet, or a lock conflict — let the read-write path create/migrate
  // (or surface the actionable `locked` error).
  return openGraph(graphDb);
};

/**
 * P13-WATCH-epoch: the per-vault last-seen mtime of `meta/refresh-epoch`.
 * A refresh bumps the file; the next tool call notices, closes the old graph
 * connection, and rebuilds the context — so an open server serves the NEW
 * vault without a restart (retiring the stale-loaded-vault class). Absent
 * file = no epoch signal = today's behavior.
 */
const lastEpochMtime = new Map<string, number>();

const epochMtime = (vaultRoot: string): number => {
  try {
    return statSync(join(vaultRoot, 'meta', 'refresh-epoch')).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * Return `ctx` unchanged when the refresh epoch has not moved; otherwise
 * close the old graph connection and rebuild the context against the fresh
 * vault. On a rebuild failure (e.g. a refresh mid-write) the OLD context is
 * kept and the next call retries — never a dead server.
 */
export const maybeReopenOnEpochChange = async (ctx: Context): Promise<Context> => {
  // P13-REMOTE-http: the HTTP server owns its context lifecycle (serialized
  // epoch swap + grace-delayed close so concurrent requests never lose their
  // connection mid-flight). The per-dispatch hook must not fight it.
  if (process.env['SFI_TRANSPORT'] === 'http') return ctx;
  const current = epochMtime(ctx.vaultRoot);
  const seen = lastEpochMtime.get(ctx.vaultRoot);
  if (seen === undefined) {
    lastEpochMtime.set(ctx.vaultRoot, current);
    return ctx;
  }
  if (current === seen) return ctx;
  const rebuilt = await buildContext(ctx.vaultRoot);
  if (!rebuilt.ok) return ctx; // transient (mid-refresh) — retry next call
  lastEpochMtime.set(ctx.vaultRoot, current);
  await closeGraph(ctx.graph).catch(() => undefined);
  return rebuilt.value;
};

export const buildContext = async (
  vaultRoot: string,
): Promise<Result<Context, ServerError>> => {
  const manifestResult = await loadManifest(vaultRoot);
  if (!manifestResult.ok) {
    if (manifestResult.error.kind === 'manifest-missing') {
      return err({
        kind: 'vault-missing',
        message: manifestResult.error.message,
      });
    }
    return err({
      kind: 'manifest-load-failed',
      message: manifestResult.error.message,
    });
  }

  const { graphDb } = vaultPaths(vaultRoot);
  const graphResult = await openServerGraph(graphDb);
  if (!graphResult.ok) {
    return err({
      kind: 'graph-open-failed',
      message: graphResult.error.message,
    });
  }

  return ok({
    vaultRoot,
    manifest: backfillCoverageInMemory(manifestResult.value),
    graph: graphResult.value,
  });
};

/**
 * Construct an MCP `Server` instance, register the v0.1 tool list and
 * vault resources on it, and return the instance ready to be connected
 * to a transport.
 *
 * For v0.1, every tool handler is a stub that returns
 * `{ error: 'not-implemented' }`. Phase F's `mcp-tool-*` tasks replace
 * each stub by editing `dispatchTool` in `tools/index.ts`. The
 * registration shape and request handlers wired here are stable.
 *
 * @example
 *   const ctx = ctxResult.value;
 *   const server = createServer(ctx);
 *   await startServer(server);
 */
export const createServer = (ctx: Context): Server => {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );
  registerTools(server, ctx);
  registerResources(server, ctx);
  return server;
};

/**
 * Connect `server` to a `StdioServerTransport` and begin handling MCP
 * messages on stdin/stdout. Resolves once the transport's `connect`
 * promise resolves; the process continues to handle messages until the
 * transport closes.
 *
 * Callers needing graceful shutdown should additionally register
 * `process.on('SIGINT', ...)` handlers that invoke `shutdown(ctx)`.
 *
 * @example
 *   const server = createServer(ctx);
 *   await startServer(server);
 */
export const startServer = async (server: Server): Promise<void> => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // `server.connect()` resolves once CONNECTED — not when the client
  // disconnects. Block here until the transport actually closes, so the
  // caller's post-`startServer` shutdown (which closes the graph) runs at
  // disconnect rather than at startup. Without this, the graph connection was
  // closed immediately after connect and every tool query failed with
  // "connection disconnected".
  await new Promise<void>((resolveClosed) => {
    const priorOnClose = server.onclose;
    server.onclose = (): void => {
      if (priorOnClose !== undefined) priorOnClose();
      resolveClosed();
    };
  });
};

/**
 * Release the resources held by a `Context`. Currently closes the
 * graph store. Callers should invoke this exactly once per `Context`
 * — the underlying `closeGraph` calls DuckDB's synchronous disconnect,
 * which is not safe to repeat.
 *
 * @example
 *   await shutdown(ctx);
 */
export const shutdown = async (ctx: Context): Promise<void> => {
  await closeGraph(ctx.graph);
};
