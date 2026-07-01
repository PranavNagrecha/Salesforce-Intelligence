/**
 * Cross-platform safe `sf` exec helper — the single seam every `sf` shellout
 * routes through so the plugin works on Windows as well as macOS / Linux.
 *
 * ## Why this exists (the Windows P0)
 *
 * On Windows the Salesforce CLI installs as a batch shim: `sf` resolves to
 * `sf.cmd`. Node's `child_process.execFile` / `spawn` WITHOUT `shell: true`
 * cannot launch a `.cmd` (or `.bat`) — the OS has no notion of "run this batch
 * file", only `cmd.exe` does — so every `execFile('sf', args)` throws `ENOENT`.
 * That breaks refresh and the entire live plane on Windows even when `sf` is
 * correctly installed and on `PATH`.
 *
 * ## Why NOT `shell: true`
 *
 * Passing `shell: true` (or building a single shell string) would let the shell
 * re-interpret the arguments — a `targetOrg` alias read from config could carry
 * shell metacharacters and inject a command. The no-shell, argv-shaped exec is a
 * deliberate hardening (CR-01 / C1). This helper keeps that guarantee: on
 * Windows it invokes `cmd.exe /d /s /c` with each argument individually escaped
 * per `cmd.exe`'s quoting rules (the same technique `cross-spawn` uses), so the
 * argv semantics are preserved and nothing is shell-interpreted beyond the
 * escaping we control. There is deliberately NO `shell` option on the contract.
 *
 * ## What it preserves
 *
 *   - The buffered `ExecCommand` signature `(binary, args) => { stdout, stderr }`
 *     — a drop-in for the previous `promisify(execFile)` adapters.
 *   - `maxBuffer` (10 MB, matching the live-exec leaf).
 *   - The native `timeout` → SIGTERM graceful first strike, then a SIGKILL
 *     escalation after {@link SF_EXEC_KILL_GRACE_MS} (CR-P3) so a wedged `sf`
 *     that ignores SIGTERM cannot outlive the timeout. On Windows Node maps the
 *     POSIX signals onto `TerminateProcess`, but the escalation timer still
 *     fires and the child is force-terminated.
 *   - The `SFI_SF_EXEC_TIMEOUT_MS` / `SFI_SF_EXEC_KILL_GRACE_MS` override knobs,
 *     read identically to the two former `nodeExecFile` leaves so an operator
 *     sets one value across every `sf` exec site.
 *
 * The four `sf` exec sites (tooling-api auth, the MCP live-exec leaf, refresh,
 * init) delegate to {@link execHelper}, so the Windows fix and the timeout
 * escalation live in exactly one place.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The buffered exec contract shared across the `sf` shellout sites. Resolves to
 * `{ stdout, stderr }` on a clean (zero-exit) run; rejects with an Error whose
 * `code` is `'ENOENT'` when the binary is missing, or whose `stderr` / `message`
 * carries the underlying error text (and `killed: true` / `signal` on a
 * timeout-kill) on a non-zero or signalled exit — mirroring
 * `promisify(execFile)`'s rejection shape so existing callers are unchanged.
 */
export type ExecCommand = (
  binary: string,
  args: readonly string[],
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

/** Options for a single {@link execHelper} call. */
export interface ExecHelperOptions {
  /** Max bytes buffered from stdout/stderr before rejecting. Default 10 MB. */
  readonly maxBuffer?: number;
  /**
   * Per-call timeout in ms overriding the `SFI_SF_EXEC_TIMEOUT_MS` default. Used
   * by the refresh runner, whose retrieve (10 min) and query (2 min) shellouts
   * carry their own distinct budgets rather than the shared auth/live default.
   */
  readonly timeout?: number;
  /** Working directory for the child (refresh runs `sf project retrieve` in the DX project dir). */
  readonly cwd?: string;
}

/**
 * Per-call timeout for every `sf` shellout that defaults through this helper
 * (RV3 / CR-01 follow-up / H8). Read from `SFI_SF_EXEC_TIMEOUT_MS`, falling back
 * to a generous 10-min backstop that clips no legitimate read-only call yet caps
 * a wedged process (e.g. an interactive `sf` auth re-prompt waiting on stdin).
 */
const SF_EXEC_TIMEOUT_MS = (): number => {
  const n = Number(process.env['SFI_SF_EXEC_TIMEOUT_MS']);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 600_000;
};

/** Grace after the SIGTERM timeout before escalating to SIGKILL (CR-P3). */
const SF_EXEC_KILL_GRACE_MS = (): number => {
  const n = Number(process.env['SFI_SF_EXEC_KILL_GRACE_MS']);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5_000;
};

/** Default stdout/stderr buffer ceiling (matches the live-exec leaf). */
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * True on Windows, where the `sf` shim is `sf.cmd` and `execFile` cannot launch
 * a batch file directly. Split out so a test can exercise the win32 branch by
 * stubbing `process.platform`, which is what the CI-on-mac tests do.
 */
export const isWindows = (): boolean => process.platform === 'win32';

/**
 * Escape a single argument for `cmd.exe /c` invocation — the `cross-spawn`
 * technique, kept inline to avoid a runtime dependency.
 *
 * Two passes:
 *   1. Escape the argument for the Windows C-runtime `CommandLineToArgvW`
 *      parser: any run of backslashes that immediately precedes a `"` (or the
 *      end of the arg, when the whole arg gets wrapped in quotes) is doubled,
 *      and every literal `"` is backslash-escaped. The whole argument is then
 *      wrapped in double quotes so embedded whitespace stays one argv token.
 *   2. Escape the `cmd.exe` metacharacters (`()%!^"<>&|`) with a caret `^` so
 *      the command interpreter passes them through to the child untouched
 *      rather than acting on them.
 *
 * A `%` is caret-escaped like the other metacharacters. This does not defuse
 * batch-time `%VAR%` expansion inside a `.cmd` (only doubling `%%` does, which
 * would corrupt a literal `%`), but `sf`'s own shim does not expand its argv, so
 * for the `sf` exec sites this is safe and preserves literal `%`.
 */
export const escapeWindowsArg = (arg: string): string => {
  // Pass 1 — C-runtime argv quoting.
  let quoted = arg;
  // Double any backslashes that precede a double-quote, then escape the quote.
  quoted = quoted.replace(/(\\*)"/g, '$1$1\\"');
  // Double the trailing backslash run so the closing wrap-quote is not escaped.
  quoted = quoted.replace(/(\\*)$/, '$1$1');
  quoted = `"${quoted}"`;
  // Pass 2 — caret-escape cmd.exe metacharacters so the interpreter passes them
  // through to the child rather than acting on them.
  return quoted.replace(/[()%!^"<>&|]/g, '^$&');
};

/**
 * Cross-platform buffered exec. On Windows, launches
 * `cmd.exe /d /s /c "<binary> <escaped args...>"` so a `.cmd` / `.bat` shim
 * (the `sf` CLI installs as `sf.cmd`) can actually run — `execFile` cannot spawn
 * a batch file directly. On every other platform it calls `execFile(binary,
 * args)` unchanged. Both paths keep the native `timeout` → SIGTERM first strike
 * and a SIGKILL escalation after the grace (CR-P3), and both reject in the same
 * shape as `promisify(execFile)`.
 *
 * @example
 *   const { stdout } = await execHelper('sf', ['org', 'display', '--json']);
 */
export const execHelper: (
  binary: string,
  args: readonly string[],
  options?: ExecHelperOptions,
) => Promise<{ readonly stdout: string; readonly stderr: string }> = (
  binary,
  args,
  options = {},
) => {
  const timeoutMs = options.timeout ?? SF_EXEC_TIMEOUT_MS();
  const graceMs = SF_EXEC_KILL_GRACE_MS();
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;

  // On Windows a `.cmd`/`.bat` shim must be run via cmd.exe. Escape every token
  // (binary + args) with the cross-spawn quoting so no argument is shell-
  // interpreted; `/d` skips AutoRun, `/s` + the OUTER wrapping-quote pair keep
  // cmd.exe's quote stripping predictable (it strips exactly that outer pair),
  // and `/c` runs and exits. The join is trimmed so a no-args call has no
  // trailing space inside the outer quotes.
  const [file, spawnArgs] = isWindows()
    ? ([
        process.env['COMSPEC'] ?? 'cmd.exe',
        [
          '/d',
          '/s',
          '/c',
          `"${[binary, ...args].map(escapeWindowsArg).join(' ')}"`,
        ],
      ] as const)
    : ([binary, [...args]] as const);

  // `windowsVerbatimArguments` tells Node NOT to re-quote our already-escaped
  // argv when it builds the command line — we own the quoting above.
  const child = execFileAsync(file, spawnArgs, {
    maxBuffer,
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(isWindows() ? { windowsVerbatimArguments: true } : {}),
  });

  // After the native SIGTERM lands at `timeout`, escalate to SIGKILL once the
  // grace elapses if the child is still alive. Unref so the timer never keeps
  // the event loop alive on its own.
  const killTimer = setTimeout(() => {
    const proc = child.child;
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGKILL');
    }
  }, timeoutMs + graceMs);
  killTimer.unref?.();

  return child.finally(() => {
    clearTimeout(killTimer);
  });
};
