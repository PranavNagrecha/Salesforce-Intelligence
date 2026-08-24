/// <reference types="vitest/globals" />

/**
 * Cross-platform `sf` exec helper (packages/core/src/exec-helper.ts).
 *
 * The Windows P0 (execFile cannot launch the `sf.cmd` shim) is fixed by routing
 * win32 through `cmd.exe /d /s /c` with cross-spawn-style argument escaping. CI
 * runs on macOS, so the win32 branch is exercised by stubbing `process.platform`
 * to `'win32'` and pointing `COMSPEC` at a real observable binary (`/bin/echo`)
 * to capture the exact argv the helper assembles — no real cmd.exe required.
 *
 * The timeout / SIGTERM→SIGKILL escalation is verified with real child
 * processes on the (default, non-win32) unix path.
 */

import { escapeWindowsArg, execHelper, isWindows } from '../src/exec-helper.js';

describe('escapeWindowsArg — cross-spawn cmd.exe quoting', () => {
  it('wraps a plain literal and caret-escapes the wrapping quotes', () => {
    // Wrap in double quotes (C-runtime argv), then caret-escape the quotes for
    // cmd.exe — exactly cross-spawn's output.
    expect(escapeWindowsArg('org')).toBe('^"org^"');
  });

  it('keeps a value with spaces as a single quoted token', () => {
    expect(escapeWindowsArg('two words')).toBe('^"two words^"');
  });

  it('backslash-escapes an embedded double quote and doubles preceding backslashes', () => {
    // A literal `"` becomes `\"`, then the `"`s are caret-escaped.
    expect(escapeWindowsArg('a"b')).toBe('^"a\\^"b^"');
  });

  it('doubles a trailing backslash run so the closing wrap-quote is not escaped', () => {
    // `a\` → the trailing `\` is doubled to `\\` before the wrap quote.
    expect(escapeWindowsArg('a\\')).toBe('^"a\\\\^"');
  });

  it('caret-escapes cmd.exe metacharacters so the interpreter passes them through', () => {
    // `&` and `|` and `%` are cmd.exe metacharacters — each gets a leading caret.
    expect(escapeWindowsArg('a&b|c%d')).toBe('^"a^&b^|c^%d^"');
  });

  it('neutralizes a shell-injection-shaped alias into one inert quoted token', () => {
    // The exact CR-01 attack shape: a metachar-laden org alias must NOT break
    // out of its argument. Every metachar is caret-escaped inside the quotes.
    const escaped = escapeWindowsArg('x" ; rm -rf ~ ; "');
    // The interior quotes are backslash+caret escaped; nothing is left bare to
    // terminate the argument early.
    expect(escaped.startsWith('^"')).toBe(true);
    expect(escaped.endsWith('^"')).toBe(true);
    expect(escaped).toContain('\\^"'); // interior quotes escaped, not bare
  });
});

describe('isWindows', () => {
  const ORIG = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: ORIG });
  });

  it('reflects process.platform at call time', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(isWindows()).toBe(true);
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(isWindows()).toBe(false);
  });
});

// Skipped ON Windows, deliberately. These two tests exercise the win32 branch
// FROM a POSIX host by stubbing `process.platform` and pointing COMSPEC at
// `/bin/echo` to observe the assembled argv; on a real Windows runner there is
// no `/bin/echo`, and the COMSPEC-deleted case expects a spawn to fail, which
// only holds on a host that genuinely has no cmd.exe. On Windows the win32
// branch is not a simulation — it is the live path, covered by every other
// `sf` shellout in the suite. Previously these were hidden by a CI-only `-t`
// negative-lookahead filter, which made the exclusion invisible in the source.
describe.skipIf(process.platform === 'win32')('execHelper — win32 branch (cmd.exe assembly, platform stubbed)', () => {
  const ORIG_PLATFORM = process.platform;
  const ORIG_COMSPEC = process.env['COMSPEC'];

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM });
    if (ORIG_COMSPEC === undefined) delete process.env['COMSPEC'];
    else process.env['COMSPEC'] = ORIG_COMSPEC;
  });

  it('invokes COMSPEC with /d /s /c and the fully-escaped command line', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    // /bin/echo prints back whatever argv it receives — a real, observable stand-in
    // for cmd.exe so we can assert the exact tokens the helper passed.
    process.env['COMSPEC'] = '/bin/echo';

    const { stdout } = await execHelper('sf', ['org', 'display', '--json']);
    const line = stdout.trim();
    // The first three tokens are the cmd.exe control flags.
    expect(line.startsWith('/d /s /c ')).toBe(true);
    // The payload is the outer-quoted, per-token-escaped command line.
    expect(line).toContain('^"sf^"');
    expect(line).toContain('^"org^"');
    expect(line).toContain('^"display^"');
    expect(line).toContain('^"--json^"');
    // The whole command line is wrapped in one outer quote pair for /s stripping.
    const payload = line.slice('/d /s /c '.length);
    expect(payload.startsWith('"')).toBe(true);
    expect(payload.endsWith('"')).toBe(true);
  });

  it('falls back to cmd.exe when COMSPEC is unset', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete process.env['COMSPEC'];
    // We cannot run cmd.exe on macOS, but we can prove the helper TRIED it: the
    // spawn rejects with ENOENT for `cmd.exe`, not for `sf`.
    let code: string | undefined;
    let spawnPath: string | undefined;
    try {
      await execHelper('sf', ['--version']);
    } catch (cause) {
      code = (cause as { code?: string }).code;
      // execFile's ENOENT message names the binary it tried to spawn.
      spawnPath = (cause as { message?: string }).message;
    }
    expect(code).toBe('ENOENT');
    expect(spawnPath).toContain('cmd.exe');
  });
});

describe('execHelper — unix branch (default, real children)', () => {
  const PRIOR = process.env['SFI_SF_EXEC_TIMEOUT_MS'];
  const PRIOR_GRACE = process.env['SFI_SF_EXEC_KILL_GRACE_MS'];
  afterEach(() => {
    if (PRIOR === undefined) delete process.env['SFI_SF_EXEC_TIMEOUT_MS'];
    else process.env['SFI_SF_EXEC_TIMEOUT_MS'] = PRIOR;
    if (PRIOR_GRACE === undefined) delete process.env['SFI_SF_EXEC_KILL_GRACE_MS'];
    else process.env['SFI_SF_EXEC_KILL_GRACE_MS'] = PRIOR_GRACE;
  });

  it('runs the binary directly with verbatim args (no shell) and returns stdout', async () => {
    // On the unix path the helper calls execFile(binary, args) unchanged, so a
    // metachar arg reaches the child as one inert argv element — never a shell.
    const payload = 'x" ; echo pwned ; "';
    const { stdout } = await execHelper(process.execPath, [
      '-e',
      'process.stdout.write(process.argv[1])',
      payload,
    ]);
    // The child echoes its first extra argv element back verbatim — proof the
    // metachar arg was passed as-is, not shell-interpreted.
    expect(stdout).toBe(payload);
  });

  it('lets a fast child complete under the generous default timeout', async () => {
    delete process.env['SFI_SF_EXEC_TIMEOUT_MS'];
    const { stdout } = await execHelper(process.execPath, [
      '-e',
      'process.stdout.write("ok")',
    ]);
    expect(stdout.trim()).toBe('ok');
  });

  it('kills a hung child and rejects with killed:true under a small timeout override', async () => {
    process.env['SFI_SF_EXEC_TIMEOUT_MS'] = '200';
    const start = Date.now();
    let rejected = false;
    let killed = false;
    try {
      await execHelper(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
    } catch (cause) {
      rejected = true;
      killed = (cause as { killed?: boolean }).killed === true;
    }
    expect(rejected).toBe(true);
    expect(killed).toBe(true);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  // POSIX-only: spawns a real child that installs a SIGTERM handler and hangs,
  // then asserts the grace timer escalates to SIGKILL. Windows has no real
  // SIGTERM/SIGKILL child semantics (node reports 'SIGTERM'), so skip on win32 —
  // the win32 exec path is covered by the platform-stubbed describe above.
  it.skipIf(process.platform === 'win32')('escalates to SIGKILL when a child swallows SIGTERM (CR-P3)', async () => {
    // The native execFile timeout sends ONE SIGTERM and never escalates; a child
    // that installs a SIGTERM handler and hangs would run forever. The helper's
    // grace timer must force SIGKILL so a wedged `sf` cannot outlive the timeout.
    process.env['SFI_SF_EXEC_TIMEOUT_MS'] = '200';
    process.env['SFI_SF_EXEC_KILL_GRACE_MS'] = '300';
    const start = Date.now();
    let rejected = false;
    let killed = false;
    let signal: string | undefined;
    try {
      await execHelper(process.execPath, [
        '-e',
        'process.on("SIGTERM", () => {}); setTimeout(() => {}, 60000);',
      ]);
    } catch (cause) {
      rejected = true;
      killed = (cause as { killed?: boolean }).killed === true;
      signal = (cause as { signal?: string }).signal;
    }
    expect(rejected).toBe(true);
    expect(killed).toBe(true);
    expect(signal).toBe('SIGKILL');
    expect(Date.now() - start).toBeLessThan(4000);
  }, 10000);

  it('enforces the maxBuffer ceiling', async () => {
    let rejected = false;
    let code: string | undefined;
    try {
      await execHelper(
        process.execPath,
        ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024))'],
        { maxBuffer: 1024 },
      );
    } catch (cause) {
      rejected = true;
      code = (cause as { code?: string }).code;
    }
    expect(rejected).toBe(true);
    expect(code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
  });
});
