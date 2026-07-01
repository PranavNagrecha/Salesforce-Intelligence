/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDoctor, formatDoctorReport, type DoctorExec } from '../../src/commands/doctor.js';

const makeTempCwd = async (): Promise<string> => mkdtemp(join(tmpdir(), 'sfi-doctor-'));

/**
 * A `sf` stub: version succeeds, org display reports Connected. Argv-shaped
 * (binary, args) to match the post-CR-01 `DoctorExec` seam — `run` spawns `sf`
 * via execFile, so the stub matches on the args array, never a shell string.
 */
const connectedStub: DoctorExec = async (_binary: string, args: readonly string[]) => {
  if (args.includes('--version')) return { stdout: '@salesforce/cli/2.0.0 darwin' };
  if (args.includes('display')) {
    return { stdout: JSON.stringify({ result: { connectedStatus: 'Connected', username: 'me@org' } }) };
  }
  return { stdout: '' };
};

const find = (report: Awaited<ReturnType<typeof runDoctor>>, name: string) =>
  report.checks.find((c) => c.name === name);

describe('runDoctor', () => {
  it('fails the Vault check (with a fix) when there is no vault', async () => {
    const cwd = await makeTempCwd();
    try {
      const report = await runDoctor({ cwd, exec: connectedStub });
      expect(find(report, 'Salesforce CLI')?.status).toBe('pass');
      expect(find(report, 'Vault')?.status).toBe('fail');
      expect(find(report, 'Vault')?.fix).toContain('sfi init');
      expect(report.healthy).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('passes Org auth (from config) but flags missing refresh', async () => {
    const cwd = await makeTempCwd();
    try {
      const metaDir = join(cwd, 'org-kb', 'meta');
      await mkdir(metaDir, { recursive: true });
      await writeFile(
        join(metaDir, 'config.json'),
        JSON.stringify({ targetOrg: 'MyOrg', vaultRoot: join(cwd, 'org-kb'), version: '0.1.0' }),
        'utf8',
      );
      const report = await runDoctor({ cwd, exec: connectedStub });
      expect(find(report, 'Vault')?.status).toBe('pass');
      expect(find(report, 'Org auth')?.status).toBe('pass');
      expect(find(report, 'Org auth')?.detail).toContain('MyOrg');
      expect(find(report, 'Refresh')?.status).toBe('fail'); // no manifest
      expect(report.healthy).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('reports a disconnected org as a fail with a login fix', async () => {
    const cwd = await makeTempCwd();
    try {
      const metaDir = join(cwd, 'org-kb', 'meta');
      await mkdir(metaDir, { recursive: true });
      await writeFile(join(metaDir, 'config.json'), JSON.stringify({ targetOrg: 'Dead' }), 'utf8');
      const disconnectedStub: DoctorExec = async (_binary, args) => {
        if (args.includes('--version')) return { stdout: 'x' };
        return { stdout: JSON.stringify({ result: { connectedStatus: 'Expired' } }) };
      };
      const report = await runDoctor({ cwd, exec: disconnectedStub });
      expect(find(report, 'Org auth')?.status).toBe('fail');
      expect(find(report, 'Org auth')?.fix).toContain('sf org login');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('detects sf installed but not on PATH and still runs via the absolute path (B9)', async () => {
    const cwd = await makeTempCwd();
    try {
      const metaDir = join(cwd, 'org-kb', 'meta');
      await mkdir(metaDir, { recursive: true });
      await writeFile(join(metaDir, 'config.json'), JSON.stringify({ targetOrg: 'MyOrg' }), 'utf8');
      // Bare `sf` isn't on PATH (as for an IDE-spawned MCP); only the absolute
      // /usr/local/bin/sf resolves.
      const notOnPathStub: DoctorExec = async (binary, args) => {
        if (binary === 'sf' && args.includes('--version')) throw new Error('command not found: sf');
        if (binary === '/usr/local/bin/sf' && args.includes('--version')) {
          return { stdout: '@salesforce/cli/2.0.0 darwin' };
        }
        if (args.includes('display')) {
          // org-auth must run via the RESOLVED bare absolute path, not bare `sf`
          // and NOT a quoted path (execFile would ENOENT a quoted binary).
          expect(binary).toBe('/usr/local/bin/sf');
          return {
            stdout: JSON.stringify({
              result: { connectedStatus: 'Connected', username: 'me@org' },
            }),
          };
        }
        throw new Error(`unexpected sf invocation: ${binary} ${args.join(' ')}`);
      };
      const report = await runDoctor({ cwd, exec: notOnPathStub });
      const sfCheck = find(report, 'Salesforce CLI');
      expect(sfCheck?.status).toBe('warn');
      expect(sfCheck?.detail).toContain('not on PATH');
      expect(sfCheck?.fix).toContain('PATH');
      // Org auth still resolves because doctor reused the absolute path.
      expect(find(report, 'Org auth')?.status).toBe('pass');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('passes when sf is on PATH at a non-standard location, never requiring the expected absolute paths (P5-doctor-sf-path / B9)', async () => {
    const cwd = await makeTempCwd();
    try {
      const metaDir = join(cwd, 'org-kb', 'meta');
      await mkdir(metaDir, { recursive: true });
      await writeFile(join(metaDir, 'config.json'), JSON.stringify({ targetOrg: 'MyOrg' }), 'utf8');
      // sf IS on PATH (bare `sf` resolves) but lives somewhere non-standard —
      // an nvm/asdf shim, a Windows install, etc. The hardcoded fallback
      // locations would NOT find it; doctor must still pass on the PATH hit
      // and must never need the absolute probes.
      const absoluteProbed: string[] = [];
      const onPathNonStandardStub: DoctorExec = async (binary, args) => {
        if (binary === '/usr/local/bin/sf' || binary === '/opt/homebrew/bin/sf') {
          absoluteProbed.push(binary);
          throw new Error('no such file');
        }
        if (binary === 'sf' && args.includes('--version')) return { stdout: '@salesforce/cli/2.9.9 linux' };
        if (args.includes('display')) {
          // Org-auth must use bare `sf`, since that is what resolved.
          expect(binary).toBe('sf');
          return { stdout: JSON.stringify({ result: { connectedStatus: 'Connected', username: 'me@org' } }) };
        }
        return { stdout: '' };
      };
      const report = await runDoctor({ cwd, exec: onPathNonStandardStub });
      const sfCheck = find(report, 'Salesforce CLI');
      expect(sfCheck?.status).toBe('pass');
      expect(sfCheck?.detail).toContain('2.9.9');
      // The expected absolute locations were never consulted — being on PATH is enough.
      expect(absoluteProbed).toEqual([]);
      expect(find(report, 'Org auth')?.status).toBe('pass');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('distinguishes an ABSENT gap log (never used) from a clean one (P12-ROUTER-confusion-report)', async () => {
    const cwd = await makeTempCwd();
    try {
      const report = await runDoctor({ cwd, exec: connectedStub, gapLogFile: join(cwd, 'nope.jsonl') });
      const g = find(report, 'Route gaps');
      expect(g?.status).toBe('info');
      // Absent log = "not used yet", NOT a passing routing audit.
      expect(g?.detail).toContain('no route-gap log yet');
      expect(g?.detail).toContain('machine-global');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('reports a present-but-empty gap log as genuinely clean (P12-ROUTER-confusion-report)', async () => {
    const cwd = await makeTempCwd();
    try {
      const logFile = join(cwd, 'question-gaps.jsonl');
      await writeFile(logFile, '\n', 'utf8');
      const report = await runDoctor({ cwd, exec: connectedStub, gapLogFile: logFile });
      const g = find(report, 'Route gaps');
      expect(g?.status).toBe('info');
      expect(g?.detail).toContain('no route gaps logged locally');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('counts logged route gaps and surfaces the top category, never blocking health (P12-ROUTER-confusion-report)', async () => {
    const cwd = await makeTempCwd();
    try {
      const logFile = join(cwd, 'question-gaps.jsonl');
      const entry = (category: string, q: string) =>
        JSON.stringify({ at: new Date().toISOString(), question: q, category, intent: 'x', plane: 'unknown', note: 'n' });
      // 3 valid entries (folder-access ×2), a blank line, and a garbled line that must be skipped.
      await writeFile(
        logFile,
        [entry('folder-access', 'q1'), entry('folder-access', 'q2'), entry('unsupported', 'q3'), '', 'garbled{'].join('\n'),
        'utf8',
      );
      const report = await runDoctor({ cwd, exec: connectedStub, gapLogFile: logFile });
      const g = find(report, 'Route gaps');
      expect(g?.status).toBe('warn'); // informational — never a fail
      expect(g?.detail).toContain('3 question');
      expect(g?.detail).toContain('machine-global');
      expect(g?.detail).toContain('folder-access ×2');
      expect(g?.fix).toContain('question-gaps.jsonl');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('flags an EMPTY vault (manifest with 0 components) with a re-refresh fix (P12-FIRSTRUN-failure-ux)', async () => {
    const cwd = await makeTempCwd();
    try {
      const metaDir = join(cwd, 'org-kb', 'meta');
      await mkdir(metaDir, { recursive: true });
      await writeFile(join(metaDir, 'config.json'), JSON.stringify({ targetOrg: 'MyOrg' }), 'utf8');
      await writeFile(
        join(metaDir, 'manifest.json'),
        JSON.stringify({
          version: '0.1.0',
          refreshedAt: new Date().toISOString(),
          sourceOrg: 'me@org',
          sourceTreeHash: 'sha256:empty',
          components: {},
          edges: {},
        }),
        'utf8',
      );
      const report = await runDoctor({ cwd, exec: connectedStub });
      const contents = find(report, 'Vault contents');
      expect(contents?.status).toBe('fail');
      expect(contents?.detail).toMatch(/0 components/);
      expect(contents?.fix).toMatch(/re-run `sfi refresh`/);
      expect(report.healthy).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('points a healthy setup at the MCP-client next step (the failure doctor can\'t probe)', () => {
    const text = formatDoctorReport({
      healthy: true,
      checks: [{ name: 'Vault', status: 'pass', detail: 'ok' }],
    });
    expect(text).toMatch(/MCP server may not be connected/);
    expect(text).toMatch(/sfi mcp/);
    expect(text).toMatch(/sfi quickstart/);
  });

  it('surfaces vault git history as INFO when disabled (P15-VAULT-git-adoption-nudge)', async () => {
    const cwd = await makeTempCwd();
    try {
      const metaDir = join(cwd, 'org-kb', 'meta');
      await mkdir(metaDir, { recursive: true });
      await writeFile(join(metaDir, 'config.json'), JSON.stringify({ targetOrg: 'MyOrg' }), 'utf8');
      await writeFile(
        join(metaDir, 'manifest.json'),
        JSON.stringify({
          version: '0.1.0',
          refreshedAt: new Date().toISOString(),
          sourceOrg: 'me@org',
          sourceTreeHash: 'sha256:x',
          components: { CustomObject: 1 },
          edges: {},
        }),
        'utf8',
      );
      const report = await runDoctor({ cwd, exec: connectedStub });
      const git = find(report, 'Vault git history');
      expect(git?.status).toBe('info');
      expect(git?.fix).toContain('sfi vault git enable');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('names multi-vault registry and fleet tools when registry has 2+ vaults (P15-VAULT-registry-discovery)', async () => {
    const cwd = await makeTempCwd();
    // Hermetic against an ambient `SF_INTELLIGENCE_REGISTRY_PATH` (CI sets it
    // globally to eval/registry.ci.json), which `findRegistryFile` honours
    // first — point it at THIS test's registry below and restore in `finally`.
    const priorRegistryEnv = process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
    try {
      const parentA = join(cwd, 'vault-a');
      const parentB = join(cwd, 'vault-b');
      const vaultA = join(parentA, 'org-kb');
      const vaultB = join(parentB, 'org-kb');
      for (const vaultRoot of [vaultA, vaultB]) {
        const metaDir = join(vaultRoot, 'meta');
        await mkdir(metaDir, { recursive: true });
        await writeFile(join(metaDir, 'config.json'), JSON.stringify({ targetOrg: 'MyOrg' }), 'utf8');
        await writeFile(
          join(metaDir, 'manifest.json'),
          JSON.stringify({
            version: '0.1.0',
            refreshedAt: new Date().toISOString(),
            sourceOrg: 'me@org',
            sourceTreeHash: 'sha256:x',
            components: { CustomObject: 1 },
            edges: {},
          }),
          'utf8',
        );
      }
      await writeFile(
        join(parentA, 'registry.json'),
        JSON.stringify({
          version: '1.0',
          registeredAt: new Date().toISOString(),
          vaults: {
            a: { path: vaultA, registeredAt: new Date().toISOString() },
            b: { path: vaultB, registeredAt: new Date().toISOString() },
          },
        }),
        'utf8',
      );
      process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = join(parentA, 'registry.json');
      const report = await runDoctor({ cwd: parentA, exec: connectedStub });
      const reg = find(report, 'Multi-vault registry');
      expect(reg?.status).toBe('info');
      expect(reg?.detail).toContain('2 vault');
      expect(reg?.detail).toContain('fleet_find');
      expect(reg?.fix).toContain('configuration.md');
    } finally {
      if (priorRegistryEnv === undefined) {
        delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
      } else {
        process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = priorRegistryEnv;
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does NOT reach `sf org display` for a poisoned targetOrg in config (CR-01 / C1 defense in depth)', async () => {
    const cwd = await makeTempCwd();
    try {
      const metaDir = join(cwd, 'org-kb', 'meta');
      await mkdir(metaDir, { recursive: true });
      // A config whose alias carries a shell-injection payload.
      await writeFile(
        join(metaDir, 'config.json'),
        JSON.stringify({ targetOrg: 'x" ; rm -rf ~ ; "' }),
        'utf8',
      );
      const displayCalls: string[][] = [];
      const recordingStub: DoctorExec = async (_binary, args) => {
        if (args.includes('--version')) return { stdout: '@salesforce/cli/2.0.0 darwin' };
        if (args.includes('display')) {
          displayCalls.push([...args]);
          return { stdout: JSON.stringify({ result: { connectedStatus: 'Connected' } }) };
        }
        return { stdout: '' };
      };
      const report = await runDoctor({ cwd, exec: recordingStub });
      // The poisoned alias is rejected at readTargetOrg, so org display never runs
      // and the "no targetOrg" branch fires instead.
      expect(displayCalls).toEqual([]);
      expect(find(report, 'Org auth')?.detail).toContain('no targetOrg');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('default `sf` runner passes a timeout + SIGTERM so a hung child cannot wedge doctor (CR-01 / H8)', async () => {
    // Drive the DEFAULT runner (no injected exec). `sf --version` may or may not
    // resolve on the box, but either way doctor must complete deterministically
    // — the timeout guarantees no hang. With SFI_SF_QUERY_TIMEOUT_MS tiny, even
    // a real spawn returns fast.
    const cwd = await makeTempCwd();
    const prior = process.env['SFI_SF_QUERY_TIMEOUT_MS'];
    process.env['SFI_SF_QUERY_TIMEOUT_MS'] = '250';
    try {
      const report = await runDoctor({ cwd });
      expect(report.checks.length).toBeGreaterThan(0);
    } finally {
      if (prior === undefined) delete process.env['SFI_SF_QUERY_TIMEOUT_MS'];
      else process.env['SFI_SF_QUERY_TIMEOUT_MS'] = prior;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('formatDoctorReport renders each check and the fixes', async () => {
    const cwd = await makeTempCwd();
    try {
      const report = await runDoctor({ cwd, exec: connectedStub });
      const text = formatDoctorReport(report);
      expect(text).toContain('sfi doctor');
      expect(text).toContain('Vault');
      expect(text).toContain('↳');
      // SYNTH-04 — doctor surfaces the grounding reminder.
      expect(text).toContain('synthesize_answer');
      expect(text).toContain('hallucinatedIds');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
