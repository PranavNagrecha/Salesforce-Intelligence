/**
 * `sfi serve --http` — read-only HTTP serving of the MCP server
 * (P13-REMOTE-http). Same tool surface as stdio, plus the remote security
 * posture: bearer token (constant-time compare), loopback bind by default
 * (a non-loopback host warns AND requires a token), and the live plane
 * HARD-DISABLED over HTTP regardless of the host's consent state.
 */

import { resolve } from 'node:path';

import { generateToken, startHttpServer } from '@sf-intelligence/mcp';
import { Command } from 'commander';

import { loadVaultConfig } from './refresh.js';

export const registerServeCommand = (program: Command): void => {
  program
    .command('serve')
    .description(
      'Serve the MCP server over streamable HTTP (read-only; live plane hard-disabled over HTTP). Bearer token required; binds 127.0.0.1 unless --host is given (non-loopback warns and requires --token/--generate-token).',
    )
    .option('--http', 'Serve over HTTP (required — stdio remains `sfi mcp`)')
    .option('--port <n>', 'Port to listen on', '8787')
    .option('--host <addr>', 'Bind address', '127.0.0.1')
    .option('--token <token>', 'Bearer token clients must present')
    .option('--generate-token', 'Generate a token, print it once, and use it')
    .action(
      async (flags: {
        readonly http?: boolean;
        readonly port?: string;
        readonly host?: string;
        readonly token?: string;
        readonly generateToken?: boolean;
      }): Promise<void> => {
        if (flags.http !== true) {
          process.stderr.write('serve: pass --http (stdio serving remains `sfi mcp`).\n');
          process.exit(1);
        }
        const host = flags.host ?? '127.0.0.1';
        const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
        let token = flags.token;
        if (flags.generateToken === true) {
          token = generateToken();
          process.stderr.write(`serve: generated bearer token (shown ONCE):\n  ${token}\n`);
        }
        if (token === undefined || token.length === 0) {
          if (!loopback) {
            process.stderr.write(
              'serve: a non-loopback --host REQUIRES a token (--token or --generate-token).\n',
            );
            process.exit(1);
          }
          token = generateToken();
          process.stderr.write(`serve: no --token given — generated one (shown ONCE):\n  ${token}\n`);
        }
        if (!loopback) {
          process.stderr.write(
            `serve: WARNING — binding ${host} exposes the vault beyond this machine. The server is read-only and the live plane is disabled over HTTP, but treat the token like a password.\n`,
          );
        }
        const config = await loadVaultConfig(process.cwd());
        if (!config.ok) {
          process.stderr.write(`${config.error}\n`);
          process.exit(1);
        }
        const server = await startHttpServer({
          vaultRoot: resolve(config.value.vaultRoot),
          port: Number(flags.port ?? '8787'),
          host,
          token,
        });
        process.stderr.write(
          `serve: MCP over HTTP on http://${host}:${server.port}/ (read-only; live plane disabled; Ctrl-C to stop)\n`,
        );
        const stop = (): void => {
          void server.close().then(() => process.exit(0));
        };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
      },
    );
};
