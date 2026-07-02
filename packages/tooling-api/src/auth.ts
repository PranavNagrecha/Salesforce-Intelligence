/**
 * Auth delegation for the v1.7 Tooling API client.
 *
 * Per `docs/vendor/salesforce-metadata/ToolingApi.md` §"Authentication —
 * delegation to the `sf` CLI", v1.7 does NOT re-implement Salesforce
 * OAuth. The plugin spawns `sf org display --target-org X --json` and
 * parses the JSON payload for `accessToken`, `instanceUrl`, and
 * `apiVersion`. The `sf` CLI owns OS-keychain integration, token refresh,
 * and the broader OAuth surface (JWT / device-flow / web-flow); the
 * delegation pattern inherits all of it for free.
 *
 * The function shape is exec-delegating but the exec itself is injected
 * via `ExecCommand` so tests can stub the spawn without faking
 * `child_process`. The default `nodeExecFile` adapter calls Node's
 * built-in `child_process.execFile` (the `--json` arm of `sf` keeps
 * stdout bounded, so the buffered exec is appropriate here).
 */

import { err, execHelper, ok, type Result } from '@sf-intelligence/core';

/**
 * Auth bundle returned on successful delegation. The three fields are
 * what the `ToolingApiClient` constructor consumes — the URL prefix
 * builder, the `Authorization: Bearer {accessToken}` header builder,
 * and the per-org `/services/data/vXX.0/tooling/` versioning anchor.
 */
export interface ToolingApiAuth {
  readonly accessToken: string;
  readonly instanceUrl: string;
  readonly apiVersion: string;
}

/**
 * Error variants returned when auth delegation fails.
 *
 *   - `sf-cli-missing`: `sf` is not installed (ENOENT from execFile).
 *   - `sf-cli-failed`: `sf` exited non-zero (typical when the org alias
 *     is not authenticated; `sf` emits "No authentication for org: X").
 *   - `parse-error`: stdout was not valid JSON or did not carry the
 *     expected `result.accessToken` / `result.instanceUrl` shape.
 *   - `org-not-found`: the alias resolved to a `sf` error specifically
 *     about an unknown org. Distinct from generic `sf-cli-failed` so
 *     CLI callers can render a more actionable message.
 */
export interface AuthError {
  readonly kind:
    | 'sf-cli-missing'
    | 'sf-cli-failed'
    | 'parse-error'
    | 'org-not-found';
  readonly message: string;
}

/**
 * Default `apiVersion` to fall back to when the `sf` CLI's JSON does not
 * carry one. The Tooling API endpoint path uses this as the
 * `/services/data/vXX.0/tooling/` version. v60.0 is the documented
 * default in `ToolingApi.md`; orgs on newer API versions surface the
 * higher value via the `result.apiVersion` field and the fallback is
 * never used in that path.
 */
export const DEFAULT_API_VERSION = '60.0';

/**
 * Injectable exec abstraction. Tests stub this to simulate the four
 * failure modes (missing CLI, non-zero exit, malformed JSON, missing
 * fields) without spawning anything. Production code uses
 * `nodeExecFile`, the default below.
 *
 * The contract: resolve to `{ stdout, stderr }` on success; reject with
 * an Error whose `code` is `'ENOENT'` when the binary is missing, OR
 * whose `stderr`/`message` carries the underlying error text on
 * non-zero exit. This mirrors `promisify(execFile)`'s rejection shape.
 */
export type ExecCommand = (
  binary: string,
  args: readonly string[],
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

/**
 * Production adapter for the `sf org display` auth shellout (RV3 / CR-01
 * follow-up / H8): the shared cross-platform {@link execHelper} from
 * `@sf-intelligence/core`.
 *
 * `sf org display` can wedge on an interactive auth re-prompt waiting on stdin;
 * an un-timed exec would block its callers forever — including the refresh-time
 * auth path (runToolingApiEnrichment, data-shape-capture, staged-refresh) which
 * calls `getAuthFromSfCli` with NO injected exec and so falls through to this
 * default. `execHelper` carries the generous 10-min default timeout backstop
 * (never clips a legitimate short auth call yet caps a hang) with the
 * SIGTERM→SIGKILL escalation (CR-P3) so a wedged `sf` that ignores SIGTERM
 * cannot outlive the timeout; the reject carries `killed:true`, surfaced here as
 * a `sf-cli-failed` AuthError. It ALSO makes the call work on Windows, where
 * `sf` resolves to `sf.cmd` and a bare `execFile` cannot launch a batch shim.
 *
 * Override the timeout with `SFI_SF_EXEC_TIMEOUT_MS` and the grace with
 * `SFI_SF_EXEC_KILL_GRACE_MS` (the same knobs every `sf` exec site reads).
 */
export const nodeExecFile: ExecCommand = (binary, args) =>
  execHelper(binary, args);

/**
 * The shape `sf org display --target-org X --json` writes to stdout
 * (per `ToolingApi.md` §"Delegation pattern"). The plugin extracts
 * the three required fields from `result`.
 */
interface SfOrgDisplayJson {
  readonly status: number;
  readonly result?: {
    readonly accessToken?: unknown;
    readonly instanceUrl?: unknown;
    readonly apiVersion?: unknown;
  };
  readonly message?: string;
}

/**
 * Get a Tooling API auth bundle by spawning the `sf` CLI and parsing
 * the JSON output. The `exec` parameter defaults to the Node
 * `execFile` adapter; tests inject a stub.
 *
 * @example
 *   const auth = await getAuthFromSfCli('my-org-alias');
 *   if (!auth.ok) { console.error(auth.error.message); return; }
 *   const client = createToolingApiClient(auth.value);
 */
export const getAuthFromSfCli = async (
  targetOrg: string,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<ToolingApiAuth, AuthError>> => {
  if (targetOrg.length === 0) {
    return err({
      kind: 'sf-cli-failed',
      message: 'targetOrg must be a non-empty alias',
    });
  }

  let stdout: string;
  try {
    const result = await exec('sf', [
      'org',
      'display',
      '--target-org',
      targetOrg,
      '--json',
    ]);
    stdout = result.stdout;
  } catch (cause) {
    // ENOENT means `sf` itself is missing from PATH (posix path, or Windows
    // when using execFile directly). On Windows, execHelper routes through
    // cmd.exe so the OS does NOT throw ENOENT — instead cmd.exe exits non-zero
    // with "'sf' is not recognized as an internal or external command" in
    // stderr. Both shapes map to the same sf-cli-missing classification.
    const codeBag = cause as { code?: string; stderr?: string; message?: string };
    const stderrOrMsg = codeBag.stderr ?? codeBag.message ?? String(cause);
    // ENOENT = posix "sf not on PATH". On Windows, execHelper routes through
    // cmd.exe so the OS never throws ENOENT; instead cmd.exe emits "'sf' is
    // not recognized as an internal or external command". Both shapes map to
    // the same sf-cli-missing classification.
    if (
      codeBag.code === 'ENOENT' ||
      stderrOrMsg.includes('is not recognized as an internal or external command')
    ) {
      return err({
        kind: 'sf-cli-missing',
        message:
          "The `sf` CLI is not installed or not on PATH. Install it from https://developer.salesforce.com/tools/sfdxcli and run `sf org login web --target-org <alias>` to authenticate.",
      });
    }
    if (
      stderrOrMsg.includes('No authentication for org') ||
      stderrOrMsg.includes('NoOrgFound') ||
      stderrOrMsg.includes('Unknown org')
    ) {
      return err({
        kind: 'org-not-found',
        message: `Org alias '${targetOrg}' is not authenticated. Run \`sf org login web --target-org ${targetOrg}\` and retry.`,
      });
    }
    return err({
      kind: 'sf-cli-failed',
      message: `\`sf org display\` exited non-zero: ${stderrOrMsg}`,
    });
  }

  let parsed: SfOrgDisplayJson;
  try {
    parsed = JSON.parse(stdout) as SfOrgDisplayJson;
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : 'unknown';
    return err({
      kind: 'parse-error',
      message: `\`sf org display\` stdout is not valid JSON: ${msg}`,
    });
  }

  if (parsed.status !== 0 || parsed.result === undefined) {
    const detail = parsed.message ?? `status=${parsed.status}`;
    return err({
      kind: 'sf-cli-failed',
      message: `\`sf org display\` reported non-success: ${detail}`,
    });
  }

  const { accessToken, instanceUrl, apiVersion } = parsed.result;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    return err({
      kind: 'parse-error',
      message: '`sf org display` JSON is missing `result.accessToken`',
    });
  }
  if (typeof instanceUrl !== 'string' || instanceUrl.length === 0) {
    return err({
      kind: 'parse-error',
      message: '`sf org display` JSON is missing `result.instanceUrl`',
    });
  }

  // `apiVersion` is optional in the response payload; fall back to the
  // documented default when absent. Cast to string (the field can be a
  // number on some sf-CLI versions).
  const resolvedApiVersion =
    typeof apiVersion === 'string' && apiVersion.length > 0
      ? apiVersion
      : typeof apiVersion === 'number'
        ? String(apiVersion)
        : DEFAULT_API_VERSION;

  return ok({
    accessToken,
    instanceUrl: instanceUrl.replace(/\/+$/, ''),
    apiVersion: resolvedApiVersion,
  });
};
