/**
 * P13-REMOTE-http — read-only HTTP serving of the SAME MCP server.
 *
 * `sfi serve --http` exposes the stdio server's exact tool surface over the
 * MCP streamable-HTTP transport. Security posture:
 *
 *   - BEARER TOKEN required on every request (constant-time comparison —
 *     SHA-256 both sides then `timingSafeEqual`, so neither content nor
 *     length leaks). 401 without it.
 *   - Optional `--tokens-file` map (R8-PERCALLER-TOKENS): each token resolves
 *     to a caller identity threaded into Context for write attribution.
 *     Solo `--token` / `--generate-token` remains the single-token default
 *     (no identity). Identity attribution only — no role tiers.
 *   - Binds 127.0.0.1 by default. A non-loopback host is a deliberate,
 *     warned choice and REQUIRES a token (the CLI enforces both).
 *   - LIVE PLANE HARD-DISABLED over HTTP regardless of host consent or
 *     env enablement: a remote caller must never be able to spend the
 *     host's Salesforce API budget. Enforced in the live-plane gate itself
 *     (SFI_TRANSPORT=http) and pinned by test, not by documentation.
 *   - The graph is opened read-only with the same epoch-reopen behavior as
 *     stdio (each request notices a refresh underneath and reopens).
 *
 * Stateless transport mode: each POST is a complete MCP exchange (no
 * session store) — right for a read-only Q&A surface and immune to session
 * fixation.
 */

import { timingSafeEqual, createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import {
  bindCallerIdentity,
  buildContext,
  createServer as createMcpServer,
  shutdown,
  type CallerIdentity,
} from './server.js';

/** Constant-time bearer comparison: hash first so length never leaks. */
export const tokenEquals = (presented: string, expected: string): boolean => {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
};

/** Generate a fresh URL-safe bearer token. */
export const generateToken = (): string => randomBytes(24).toString('base64url');

/** One row in a `--tokens-file` map (identity attribution only). */
export interface TokenEntry {
  readonly token: string;
  readonly id: string;
  readonly label?: string;
}

export interface ServeHttpOptions {
  /** Absolute path to the org-kb vault root. */
  readonly vaultRoot: string;
  readonly port: number;
  readonly host: string;
  /**
   * Solo path: one shared bearer for the process (no caller identity).
   * Mutually exclusive with {@link tokens}.
   */
  readonly token?: string;
  /**
   * Team path: token→identity map from `--tokens-file`.
   * Mutually exclusive with {@link token}.
   */
  readonly tokens?: readonly TokenEntry[];
}

export interface RunningHttpServer {
  readonly port: number;
  readonly close: () => Promise<void>;
}

const unauthorized = (res: ServerResponse): void => {
  res.writeHead(401, {
    'content-type': 'application/json',
    'www-authenticate': 'Bearer realm="sf-intelligence"',
  });
  res.end(JSON.stringify({ error: 'unauthorized — pass Authorization: Bearer <token>' }));
};

const identityFromEntry = (entry: TokenEntry): CallerIdentity =>
  entry.label !== undefined ? { id: entry.id, label: entry.label } : { id: entry.id };

/**
 * Match a presented bearer against a token→identity map.
 * Compares every entry (no early return) so which row matched does not
 * leak via short-circuit timing; each compare is itself length-safe.
 */
export const matchTokenEntry = (
  presented: string,
  entries: readonly TokenEntry[],
): TokenEntry | undefined => {
  let matched: TokenEntry | undefined;
  for (const entry of entries) {
    if (tokenEquals(presented, entry.token)) {
      matched = entry;
    }
  }
  return matched;
};

export type AuthResolution =
  | { readonly ok: true; readonly identity: CallerIdentity | undefined }
  | { readonly ok: false };

/**
 * Resolve a presented bearer against solo `token` or team `tokens`.
 * Solo success yields `identity: undefined` (attribute writes as today).
 */
export const resolveBearerAuth = (
  presented: string,
  options: Pick<ServeHttpOptions, 'token' | 'tokens'>,
): AuthResolution => {
  if (presented.length === 0) return { ok: false };
  if (options.tokens !== undefined) {
    const entry = matchTokenEntry(presented, options.tokens);
    if (entry === undefined) return { ok: false };
    return { ok: true, identity: identityFromEntry(entry) };
  }
  if (options.token !== undefined && tokenEquals(presented, options.token)) {
    return { ok: true, identity: undefined };
  }
  return { ok: false };
};

/**
 * Load and validate a tokens file for `--tokens-file`.
 * Accepts a bare array or `{ "tokens": [...] }`. Synthetic tokens only in tests.
 */
export const loadTokensFile = (filePath: string): readonly TokenEntry[] => {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch (cause) {
    throw new Error(
      `tokens-file: cannot read/parse ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  let list: unknown[] | undefined;
  if (Array.isArray(raw)) {
    list = raw;
  } else if (
    raw !== null &&
    typeof raw === 'object' &&
    Array.isArray((raw as { tokens?: unknown }).tokens)
  ) {
    list = (raw as { tokens: unknown[] }).tokens;
  }
  if (list === undefined) {
    throw new Error('tokens-file: expected a JSON array or { "tokens": [...] }');
  }
  if (list.length === 0) {
    throw new Error('tokens-file: must contain at least one entry');
  }
  const seen = new Set<string>();
  const entries: TokenEntry[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const row = list[i];
    if (row === null || typeof row !== 'object') {
      throw new Error(`tokens-file: entry[${i}] must be an object`);
    }
    const token = (row as { token?: unknown }).token;
    const id = (row as { id?: unknown }).id;
    const label = (row as { label?: unknown }).label;
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error(`tokens-file: entry[${i}].token must be a non-empty string`);
    }
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`tokens-file: entry[${i}].id must be a non-empty string`);
    }
    if (label !== undefined && (typeof label !== 'string' || label.length === 0)) {
      throw new Error(`tokens-file: entry[${i}].label must be a non-empty string when set`);
    }
    if (seen.has(token)) {
      throw new Error(`tokens-file: duplicate token at entry[${i}]`);
    }
    seen.add(token);
    entries.push(label !== undefined ? { token, id, label } : { token, id });
  }
  return entries;
};

const normalizeAuthOptions = (options: ServeHttpOptions): void => {
  const hasToken = options.token !== undefined && options.token.length > 0;
  const hasTokens = options.tokens !== undefined && options.tokens.length > 0;
  if (hasToken && hasTokens) {
    throw new Error('serve-http: pass either token or tokens, not both');
  }
  if (!hasToken && !hasTokens) {
    throw new Error('serve-http: a bearer token or tokens map is required');
  }
};

/**
 * Start the HTTP MCP server. The caller owns the lifecycle.
 *
 * @example
 *   const s = await startHttpServer({ cwd, port: 8787, host: '127.0.0.1', token });
 *   // … later
 *   await s.close();
 */
export const startHttpServer = async (
  options: ServeHttpOptions,
): Promise<RunningHttpServer> => {
  normalizeAuthOptions(options);

  // The live-plane gate reads this BEFORE any tool runs: HTTP callers can
  // never reach the org, regardless of the host machine's consent state.
  // (Also disarms the stdio per-dispatch epoch hook — this server owns its
  // context lifecycle below.)
  process.env['SFI_TRANSPORT'] = 'http';

  // PERSISTENT read-only context: holding one read connection at all times
  // forces a concurrent `sfi refresh` into its side-build + atomic-rename
  // path (the soak proved per-request opens 503 for the whole refresh
  // window otherwise — the refresh wins the write lock between requests).
  // Epoch swaps are SERIALIZED, and the old connection closes after a grace
  // period so in-flight requests finish against the old (unlinked) file.
  const epochOf = (): number => {
    try {
      return statSync(join(options.vaultRoot, 'meta', 'refresh-epoch')).mtimeMs;
    } catch {
      return 0;
    }
  };
  const first = await buildContext(options.vaultRoot);
  if (!first.ok) {
    throw new Error(`vault unavailable: ${first.error.message}`);
  }
  let shared = first.value;
  let sharedEpoch = epochOf();
  let swapChain: Promise<void> = Promise.resolve();
  const ctxForRequest = async (): Promise<typeof shared> => {
    if (epochOf() === sharedEpoch) return shared;
    swapChain = swapChain.then(async () => {
      const now = epochOf();
      if (now === sharedEpoch) return; // another request already swapped
      const rebuilt = await buildContext(options.vaultRoot);
      if (!rebuilt.ok) return; // transient mid-refresh — retry next request
      const old = shared;
      shared = rebuilt.value;
      sharedEpoch = now;
      const graceTimer = setTimeout(() => {
        void shutdown(old).catch(() => undefined);
      }, 5_000);
      graceTimer.unref();
    });
    await swapChain;
    return shared;
  };

  const httpServer: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const auth = req.headers.authorization ?? '';
    const presented = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
    const resolved = resolveBearerAuth(presented, options);
    if (!resolved.ok) {
      unauthorized(res);
      return;
    }
    const { identity } = resolved;
    void (async () => {
      try {
        // Stateless TRANSPORT per request over the PERSISTENT shared
        // context (epoch-swapped above): the standing read connection
        // forces a concurrent refresh into its side-build path, so readers
        // never see a write lock and a refresh never sees readers.
        // Caller identity is a per-request overlay (never mutated onto shared).
        const base = await ctxForRequest();
        const ctx = bindCallerIdentity(base, identity);
        const mcp = createMcpServer(ctx);
        // The SDK's option/transport types predate exactOptionalPropertyTypes;
        // cast at the SDK boundary only (stateless mode = no session ids).
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        } as never);
        res.on('close', () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport as never);
        await transport.handleRequest(req, res);
      } catch (cause) {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: `server error: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
          );
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port, options.host, resolve);
  });
  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  return {
    port,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((cause) => (cause ? reject(cause) : resolve()));
      });
      await shutdown(shared).catch(() => undefined);
    },
  };
};
