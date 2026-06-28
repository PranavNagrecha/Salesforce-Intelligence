/// <reference types="vitest/globals" />

import { DEFAULT_API_VERSION, getAuthFromSfCli, type ExecCommand } from '../src/auth.js';

const STD_PAYLOAD = JSON.stringify({
  status: 0,
  result: {
    id: '00Dxx000001nXyzEAB',
    accessToken: 'TOKEN_xxx',
    instanceUrl: 'https://my-org.my.salesforce.com',
    alias: 'my-org',
    apiVersion: '60.0',
    username: 'user@example.com',
  },
});

const okExec = (stdout: string, stderr = ''): ExecCommand =>
  async () => ({ stdout, stderr });

const failExec = (fields: { code?: string; stderr?: string; message?: string }): ExecCommand =>
  async () => {
    const e: { code?: string; stderr?: string; message?: string } = {};
    if (fields.code !== undefined) e.code = fields.code;
    if (fields.stderr !== undefined) e.stderr = fields.stderr;
    if (fields.message !== undefined) e.message = fields.message;
    throw e;
  };

describe('getAuthFromSfCli — happy path', () => {
  it('returns the parsed auth bundle on a well-formed sf response', async () => {
    const result = await getAuthFromSfCli('my-org', okExec(STD_PAYLOAD));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.accessToken).toBe('TOKEN_xxx');
    expect(result.value.instanceUrl).toBe('https://my-org.my.salesforce.com');
    expect(result.value.apiVersion).toBe('60.0');
  });

  it('strips trailing slashes from instanceUrl so URL composition is unambiguous', async () => {
    const payload = JSON.stringify({
      status: 0,
      result: {
        accessToken: 'T',
        instanceUrl: 'https://example.my.salesforce.com///',
        apiVersion: '61.0',
      },
    });
    const result = await getAuthFromSfCli('a', okExec(payload));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.instanceUrl).toBe('https://example.my.salesforce.com');
  });

  it('falls back to DEFAULT_API_VERSION when sf omits the apiVersion field', async () => {
    const payload = JSON.stringify({
      status: 0,
      result: {
        accessToken: 'T',
        instanceUrl: 'https://e.com',
      },
    });
    const result = await getAuthFromSfCli('a', okExec(payload));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.apiVersion).toBe(DEFAULT_API_VERSION);
  });

  it('coerces a numeric apiVersion to string for URL path stability', async () => {
    const payload = JSON.stringify({
      status: 0,
      result: {
        accessToken: 'T',
        instanceUrl: 'https://e.com',
        apiVersion: 62,
      },
    });
    const result = await getAuthFromSfCli('a', okExec(payload));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.apiVersion).toBe('62');
  });
});

describe('getAuthFromSfCli — error paths', () => {
  it('returns sf-cli-missing when execFile rejects with ENOENT', async () => {
    const result = await getAuthFromSfCli('my-org', failExec({ code: 'ENOENT', message: 'spawn sf ENOENT' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('sf-cli-missing');
  });

  it('returns org-not-found when sf reports an unauthenticated alias', async () => {
    const result = await getAuthFromSfCli('mystery-org', failExec({
      stderr: 'Error: No authentication for org: mystery-org',
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('org-not-found');
    expect(result.error.message).toContain('mystery-org');
  });

  it('returns sf-cli-failed for an arbitrary non-zero exit', async () => {
    const result = await getAuthFromSfCli('a', failExec({ stderr: 'kaboom' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('sf-cli-failed');
    expect(result.error.message).toContain('kaboom');
  });

  it('returns parse-error when stdout is not valid JSON', async () => {
    const result = await getAuthFromSfCli('a', okExec('not-json'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('parse-error');
  });

  it('returns parse-error when result.accessToken is missing', async () => {
    const payload = JSON.stringify({ status: 0, result: { instanceUrl: 'https://e.com' } });
    const result = await getAuthFromSfCli('a', okExec(payload));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('parse-error');
    expect(result.error.message).toContain('accessToken');
  });

  it('returns parse-error when result.instanceUrl is missing', async () => {
    const payload = JSON.stringify({ status: 0, result: { accessToken: 'T' } });
    const result = await getAuthFromSfCli('a', okExec(payload));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('parse-error');
    expect(result.error.message).toContain('instanceUrl');
  });

  it('returns sf-cli-failed when status is non-zero', async () => {
    const payload = JSON.stringify({ status: 1, message: 'something wrong' });
    const result = await getAuthFromSfCli('a', okExec(payload));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('sf-cli-failed');
    expect(result.error.message).toContain('something wrong');
  });

  it('rejects an empty targetOrg without spawning sf', async () => {
    let spawned = false;
    const exec: ExecCommand = async () => {
      spawned = true;
      return { stdout: '', stderr: '' };
    };
    const result = await getAuthFromSfCli('', exec);
    expect(result.ok).toBe(false);
    expect(spawned).toBe(false);
  });
});

describe('nodeExecFile — un-timed auth shellout backstop (RV3 / H8)', () => {
  const PRIOR = process.env['SFI_SF_EXEC_TIMEOUT_MS'];
  const PRIOR_GRACE = process.env['SFI_SF_EXEC_KILL_GRACE_MS'];
  afterEach(() => {
    if (PRIOR === undefined) delete process.env['SFI_SF_EXEC_TIMEOUT_MS'];
    else process.env['SFI_SF_EXEC_TIMEOUT_MS'] = PRIOR;
    if (PRIOR_GRACE === undefined) delete process.env['SFI_SF_EXEC_KILL_GRACE_MS'];
    else process.env['SFI_SF_EXEC_KILL_GRACE_MS'] = PRIOR_GRACE;
    vi.resetModules();
  });

  // CR-P3: a child that SWALLOWS SIGTERM must still be force-killed (SIGKILL)
  // after the grace, so a wedged `sf` cannot outlive the timeout. The native
  // `execFile` timeout sends ONE SIGTERM and never escalates, so such a child
  // runs forever and the promise never settles (the JSDoc overstated the cap).
  it('FAIL-BEFORE/PASS-AFTER: escalates to SIGKILL when a child ignores SIGTERM', async () => {
    process.env['SFI_SF_EXEC_TIMEOUT_MS'] = '200';
    process.env['SFI_SF_EXEC_KILL_GRACE_MS'] = '300';
    vi.resetModules();
    const { nodeExecFile } = await import('../src/auth.js');
    const start = Date.now();
    let rejected = false;
    let signal: string | undefined;
    let killed = false;
    try {
      // A child that installs a SIGTERM handler (swallowing it) and then hangs.
      await nodeExecFile(process.execPath, [
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
    // timeout(200) + grace(300) + headroom — must settle well under the old
    // never-settles behavior.
    expect(Date.now() - start).toBeLessThan(4000);
  }, 10000);

  it('kills a hung child and rejects with killed:true under a small timeout override', async () => {
    // RV3: the default auth exec (`sf org display`) can wedge on an interactive
    // re-prompt waiting on stdin. With a tiny override, the real nodeExecFile
    // must SIGTERM a 60s child and reject — proving the refresh-path auth call
    // (getAuthFromSfCli with no injected exec) can no longer block forever.
    process.env['SFI_SF_EXEC_TIMEOUT_MS'] = '200';
    vi.resetModules();
    const { nodeExecFile } = await import('../src/auth.js');
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

  it('lets a fast child complete under the generous default timeout', async () => {
    // Guards that the backstop does not regress short legitimate calls.
    delete process.env['SFI_SF_EXEC_TIMEOUT_MS'];
    vi.resetModules();
    const { nodeExecFile } = await import('../src/auth.js');
    const { stdout } = await nodeExecFile(process.execPath, [
      '-e',
      'process.stdout.write("ok")',
    ]);
    expect(stdout.trim()).toBe('ok');
  });
});
