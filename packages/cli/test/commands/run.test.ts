/// <reference types="vitest/globals" />

/**
 * `sfi run <tool>` (spec §12) and the shared `--vault` option (§11.7): a
 * script names the tool and the vault, gets the MCP tool's JSON back, and
 * every vault-reading command means the same thing by `--vault`. Synthetic
 * vault only.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { V01_TOOLS } from '@sf-intelligence/mcp';
import { vaultPaths } from '@sf-intelligence/vault';
import { Command } from 'commander';

import { buildGapsReport } from '../../src/commands/gaps.js';
import { loadVaultConfig, runRefresh } from '../../src/commands/refresh.js';
import { argsFromFlags, findTool, registerRunCommand, toolNameOf } from '../../src/commands/run.js';
import { resolveVaultOption } from '../../src/vault-option.js';

const seedVault = async (cwd: string, vaultRootInConfig?: string): Promise<string> => {
  const vaultRoot = join(cwd, 'org-kb');
  const paths = vaultPaths(vaultRoot);
  await mkdir(paths.meta, { recursive: true });
  const classesDir = join(paths.source, 'main', 'default', 'classes');
  await mkdir(classesDir, { recursive: true });
  await writeFile(
    paths.config,
    JSON.stringify({ targetOrg: 'test', vaultRoot: vaultRootInConfig ?? vaultRoot, version: '0.1.0', createdAt: '2026-05-27T00:00:00.000Z' }),
    'utf8',
  );
  await writeFile(join(classesDir, 'AcmeGreeter.cls'), 'public class AcmeGreeter { public static void greet() {} }', 'utf8');
  await writeFile(
    join(classesDir, 'AcmeGreeter.cls-meta.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>60.0</apiVersion><status>Active</status></ApexClass>\n',
    'utf8',
  );
  return vaultRoot;
};

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), 'sfi-run-'));
  dirs.push(d);
  return d;
};
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** Run the CLI in-process, capturing stdout. */
const runCli = async (argv: string[]): Promise<{ out: string; exitCode: number | undefined }> => {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  const before = process.exitCode;
  process.exitCode = undefined;
  try {
    const program = new Command().exitOverride();
    registerRunCommand(program);
    await program.parseAsync(['node', 'sfi', ...argv]);
    return { out: chunks.join(''), exitCode: process.exitCode };
  } finally {
    spy.mockRestore();
    process.exitCode = before;
  }
};

describe('sfi run — argument typing', () => {
  const schema = findTool('list_components')?.inputSchema ?? {};

  it('accepts the tool name with or without the sfi. prefix', () => {
    expect(toolNameOf('list_components')).toBe('sfi.list_components');
    expect(toolNameOf('sfi.list_components')).toBe('sfi.list_components');
    expect(findTool('no_such_tool')).toBeNull();
  });

  it('types values from the tool schema, camel-cases names, and merges --input first', () => {
    expect(argsFromFlags(['--type', 'ApexClass', '--limit', '5'], schema)).toEqual({ type: 'ApexClass', limit: 5 });
    expect(argsFromFlags(['--limit=7'], schema, { type: 'Flow', limit: 1 })).toEqual({ type: 'Flow', limit: 7 });
    expect(argsFromFlags(['--object-api-name', 'Acme_Order__c'], {})).toEqual({ objectApiName: 'Acme_Order__c' });
    expect(argsFromFlags(['--id', 'A', '--id', 'B'], {})).toEqual({ id: ['A', 'B'] });
    expect(() => argsFromFlags(['--limit', 'many'], schema)).toThrow(/expected a number/);
    expect(() => argsFromFlags(['stray'], schema)).toThrow(/unexpected argument/);
  });

  it('every roster tool has an object input schema to type against', () => {
    for (const t of V01_TOOLS) expect((t.inputSchema as { type?: unknown }).type).toBe('object');
  });
});

describe('sfi run + --vault, end to end', () => {
  let project: string;
  beforeAll(async () => {
    project = await tempDir();
    await seedVault(project);
    const built = await runRefresh({ cwd: project, noPull: true });
    expect(built.status).not.toBe('failed');
  }, 60_000);

  it('calls the tool against the named vault and prints its JSON envelope', async () => {
    const { out, exitCode } = await runCli(['run', 'list_components', '--json', '--type', 'ApexClass', '--vault', project]);
    expect(exitCode).toBeUndefined();
    const envelope = JSON.parse(out) as { data: { components?: Array<{ id: string }> } };
    expect(JSON.stringify(envelope.data)).toContain('ApexClass:AcmeGreeter');
    expect(out.trim().split('\n')).toHaveLength(1);
  });

  it('exits 1 with the tool error when the input is invalid', async () => {
    const { out, exitCode } = await runCli(['run', 'list_components', '--json', '--limit', '0', '--vault', join(project, 'org-kb')]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(out)).toHaveProperty('error');
  });

  it('resolves --vault as the org-kb folder or the folder holding it, and refuses a path with no vault', async () => {
    const a = resolveVaultOption(project);
    const b = resolveVaultOption(join(project, 'org-kb'));
    expect(a.ok && b.ok && a.value.vaultRoot === b.value.vaultRoot && a.value.projectDir === project).toBe(true);
    const none = resolveVaultOption(join(project, 'nothing-here'));
    expect(none.ok).toBe(false);
    expect(resolveVaultOption(undefined, { cwd: project, env: ' ' })).toMatchObject({ ok: true, value: { bindSource: 'default ./org-kb' } });
  });

  it('scopes `gaps report` to one vault when asked', async () => {
    const log = join(project, 'gaps.jsonl');
    const vaultRoot = join(project, 'org-kb');
    await writeFile(
      log,
      [
        { at: '2026-10-01T00:00:00Z', category: 'unrouted', vaultRoot },
        { at: '2026-10-01T00:00:00Z', category: 'unrouted', vaultRoot: '/elsewhere/org-kb' },
        { at: '2026-10-01T00:00:00Z', category: 'folder-access' },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n'),
      'utf8',
    );
    expect((await buildGapsReport({ logFile: log })).summary.count).toBe(3);
    const scoped = await buildGapsReport({ logFile: log, vaultRoot });
    expect(scoped.summary).toMatchObject({ count: 1, unstampedExcluded: 1 });
    expect(scoped.vaultRoot).toBe(vaultRoot);
    const { gapsReportJson, formatGapsReport } = await import('../../src/commands/gaps.js');
    expect(gapsReportJson(scoped)).toMatchObject({ scope: 'vault', count: 1, unstampedExcluded: 1 });
    expect(JSON.stringify(gapsReportJson(scoped)) + formatGapsReport(scoped)).not.toContain(project);
  });
});

describe('a copied vault cannot write to the vault it was copied from', () => {
  it('refuses a config whose vaultRoot names another folder, with the fix', async () => {
    const original = await tempDir();
    const copy = await tempDir();
    await seedVault(copy, join(original, 'org-kb'));
    const r = await loadVaultConfig(copy);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/copied or moved/);
    expect(r.error).toContain(join(copy, 'org-kb'));
    const refreshed = await runRefresh({ cwd: copy, noPull: true });
    expect(refreshed.status).toBe('failed');
  });

  it('accepts the vault that names itself', async () => {
    const project = await tempDir();
    await seedVault(project);
    expect((await loadVaultConfig(project)).ok).toBe(true);
  });
});
