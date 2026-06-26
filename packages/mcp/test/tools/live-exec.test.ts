/// <reference types="vitest/globals" />

/**
 * RV3 / CR-01 follow-up / H8: the shared live-plane `nodeExecFile` leaf must
 * carry a per-call timeout + SIGTERM so a hung `sf` shellout (e.g. an
 * interactive auth re-prompt waiting on stdin) cannot wedge refresh /
 * stale-sweep / the ~25 live-plane handlers that default their exec to it.
 */

describe('nodeExecFile — un-timed live-plane sf exec backstop (RV3 / H8)', () => {
  const PRIOR = process.env['SFI_SF_EXEC_TIMEOUT_MS'];
  afterEach(() => {
    if (PRIOR === undefined) delete process.env['SFI_SF_EXEC_TIMEOUT_MS'];
    else process.env['SFI_SF_EXEC_TIMEOUT_MS'] = PRIOR;
    vi.resetModules();
  });

  it('kills a hung 60s child and rejects with killed:true under a small override', async () => {
    process.env['SFI_SF_EXEC_TIMEOUT_MS'] = '200';
    vi.resetModules();
    const { nodeExecFile } = await import('../../src/tools/live-exec.js');
    const start = Date.now();
    let rejected = false;
    let killed = false;
    try {
      await nodeExecFile(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
    } catch (cause) {
      rejected = true;
      killed = (cause as { killed?: boolean }).killed === true;
    }
    expect(rejected).toBe(true);
    expect(killed).toBe(true);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it('lets a fast child resolve with its stdout under the generous default', async () => {
    delete process.env['SFI_SF_EXEC_TIMEOUT_MS'];
    vi.resetModules();
    const { nodeExecFile } = await import('../../src/tools/live-exec.js');
    const { stdout } = await nodeExecFile(process.execPath, [
      '-e',
      'process.stdout.write("ok")',
    ]);
    expect(stdout.trim()).toBe('ok');
  });

  it('still enforces the maxBuffer ceiling alongside the new timeout backstop', async () => {
    // Behavioral guard that the RV3 timeout/killSignal options were ADDED to the
    // existing options object, not substituted for maxBuffer: a child writing
    // well over the 10MB ceiling must reject (ERR_CHILD_PROCESS_STDIO_MAXBUFFER)
    // rather than buffer unbounded. Default (generous) timeout so the rejection
    // is the maxBuffer cap, not a timeout.
    delete process.env['SFI_SF_EXEC_TIMEOUT_MS'];
    vi.resetModules();
    const { nodeExecFile } = await import('../../src/tools/live-exec.js');
    let rejected = false;
    let code: string | undefined;
    try {
      await nodeExecFile(process.execPath, [
        '-e',
        // Write ~12MB to stdout, over the 10MB maxBuffer.
        'process.stdout.write("x".repeat(12 * 1024 * 1024))',
      ]);
    } catch (cause) {
      rejected = true;
      code = (cause as { code?: string }).code;
    }
    expect(rejected).toBe(true);
    expect(code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
  });
});
