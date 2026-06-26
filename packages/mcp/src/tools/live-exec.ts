/**
 * Live-plane raw execution primitives — a dependency-free LEAF module.
 *
 * These are the low-level building blocks that actually reach the org: the sf
 * CLI runner, REST GET, auth, the API-version path builder, and secret
 * redaction. They live here, away from the handler-rich `live-plane.ts`, so the
 * budget/cache seam in `live-session.ts` can import them WITHOUT importing the
 * handlers — and `live-plane.ts` can in turn import the budgeted seam from
 * `live-session.ts` without forming an import cycle.
 *
 *   live-exec.ts (leaf, no live imports)
 *        ▲                    ▲
 *        │                    │
 *   live-session.ts ◀─────────┤   (imports runSfJson/restGet from the leaf)
 *        ▲                    │
 *        │                    │
 *   live-plane.ts  ───────────┘   (imports runLiveQuery/runLiveRest from
 *                                   live-session.ts AND the leaf for re-export)
 *
 * `live-plane.ts` re-exports every symbol here, so existing import paths that
 * pull `runSfJson` / `apiPath` / `redactSecrets` FROM `live-plane.ts` keep
 * resolving unchanged (CR-09 leaf extraction).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { McpError } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  getAuthFromSfCli,
  type ExecCommand,
  type ToolingApiAuth,
} from '@sf-intelligence/tooling-api';

import { formatSfCliFailure } from './input-aliases.js';

/**
 * Per-call timeout for every `sf` shellout that defaults to this leaf exec
 * (RV3 / CR-01 follow-up / H8). The handlers here run only SHORT read-only ops —
 * Tooling SELECTs, `sf org display`/auth, `sobject describe` — so a generous
 * 10-min default backstop kills NO legitimate call yet caps a wedged process
 * (e.g. an interactive `sf` auth re-prompt waiting on stdin). The slow
 * `sf project retrieve` runs ONLY via refresh.ts `runSf` (already timed at
 * 600s) and never through this helper, so it is unaffected. On timeout the
 * child is sent `SIGTERM` (graceful) and `execFile` rejects with `killed:true`,
 * which `runSfJson` already catches and reports as a redacted internal error.
 * Override with `SFI_SF_EXEC_TIMEOUT_MS`.
 */
const SF_EXEC_TIMEOUT_MS = (() => {
  const n = Number(process.env['SFI_SF_EXEC_TIMEOUT_MS']);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 600_000;
})();

export const nodeExecFile: ExecCommand = (binary, args) =>
  promisify(execFile)(binary, [...args], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: SF_EXEC_TIMEOUT_MS,
    killSignal: 'SIGTERM',
  });

/** Strip bearer tokens and long access-token-shaped strings from error text. */
export const redactSecrets = (message: string): string =>
  message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b00D[A-Za-z0-9]{12,}![A-Za-z0-9._~+/=-]{20,}\b/g, '[REDACTED_TOKEN]');

export const LIVE_PLANE_DISCLOSURE =
  'Live org data is read-only, queried at call time via the Salesforce CLI. It does not update the vault. Enable with SFI_LIVE_PLANE_ENABLED=1 or pass liveEnabled: true.';

export const getLiveAuth = async (
  org: string,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<ToolingApiAuth, McpError>> => {
  const authResult = await getAuthFromSfCli(org, exec);
  if (!authResult.ok) {
    return err({
      kind: 'internal',
      message: redactSecrets(
        formatSfCliFailure(
          `Salesforce CLI auth failed for org '${org}': ${authResult.error.message}`,
        ),
      ),
    });
  }
  return ok(authResult.value);
};

export const runSfJson = async (
  org: string,
  args: readonly string[],
  exec: ExecCommand = nodeExecFile,
): Promise<Result<unknown, McpError>> => {
  const fullArgs = [...args, '--target-org', org, '--json'];
  try {
    const { stdout } = await exec('sf', fullArgs);
    return ok(JSON.parse(stdout) as unknown);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err({
      kind: 'internal',
      message: redactSecrets(formatSfCliFailure(`sf CLI failed: ${message}`)),
    });
  }
};

/**
 * Build a Salesforce REST data-API URL. `auth.apiVersion` arrives from the sf
 * CLI as "67.0" (and could be "67" or "v67.0"); normalize to the major version
 * and the canonical `vNN.0` form. The previous code appended ".0"
 * unconditionally, producing "v67.0.0" — a NOT_FOUND 404 — whenever the CLI
 * already included the minor part (which it does: org apiVersion is "67.0").
 */
export const apiPath = (auth: ToolingApiAuth, suffix: string): string => {
  const major = auth.apiVersion.replace(/^v/i, '').split('.')[0];
  return `${auth.instanceUrl}/services/data/v${major}.0${suffix}`;
};

export const restGet = async (
  auth: ToolingApiAuth,
  path: string,
): Promise<Result<unknown, McpError>> => {
  try {
    const response = await fetch(path, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    if (!response.ok) {
      return err({
        kind: 'internal',
        message: `Salesforce REST ${response.status}: ${await response.text()}`,
      });
    }
    return ok((await response.json()) as unknown);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err({ kind: 'internal', message: redactSecrets(`REST request failed: ${message}`) });
  }
};
