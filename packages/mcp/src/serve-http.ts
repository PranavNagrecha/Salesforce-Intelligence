/**
 * P13-REMOTE-http — read-only HTTP serving of the SAME MCP server.
 *
 * `sfi serve --http` exposes the stdio server's exact tool surface over the
 * MCP streamable-HTTP transport. Security posture:
 *
 *   - BEARER TOKEN required on every request (constant-time comparison —
 *     SHA-256 both sides then `timingSafeEqual`, so neither content nor
 *     length leaks). 401 without it.
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
import { statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { buildContext, createServer as createMcpServer, shutdown } from './server.js';

/** Constant-time bearer comparison: hash first so length never leaks. */
export const tokenEquals = (presented: string, expected: string): boolean => {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
};

/** Generate a fresh URL-safe bearer token. */
export const generateToken = (): string => randomBytes(24).toString('base64url');

export interface ServeHttpOptions {
  /** Absolute path to the org-kb vault root. */
  readonly vaultRoot: string;
  readonly port: number;
  readonly host: string;
  readonly token: string;
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
    if (presented.length === 0 || !tokenEquals(presented, options.token)) {
      unauthorized(res);
      return;
    }
    void (async () => {
      try {
        // Stateless TRANSPORT per request over the PERSISTENT shared
        // context (epoch-swapped above): the standing read connection
        // forces a concurrent refresh into its side-build path, so readers
        // never see a write lock and a refresh never sees readers.
        const ctx = await ctxForRequest();
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
