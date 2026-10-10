/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { formatQuickstart, runQuickstart, type QuickstartProbes } from '../../src/commands/quickstart.js';

const makeTempCwd = async (): Promise<string> => mkdtemp(join(tmpdir(), 'sfi-quickstart-'));

/** Deterministic local probes: sf installed, one logged-in org. */
const probes = (over: Partial<QuickstartProbes> = {}): QuickstartProbes => ({
  sfInstalled: async () => true,
  listOrgs: async () => ({ ok: true, orgs: [{ alias: 'MyOrg', isDefault: true }] }),
  ...over,
});

describe('runQuickstart (clean-room, no config)', () => {
  it('from zero config, points the newcomer at the auth step and prints no fake starter questions', async () => {
    const cwd = await makeTempCwd();
    try {
      const report = await runQuickstart({ cwd, probes: probes({ listOrgs: async () => ({ ok: true, orgs: [] }) }) });
      expect(report.ready).toBe(false);
      expect(report.starterQuestions).toEqual([]);
      // Step 1 (install) is done; step 2 (auth) is the NEXT step since there's no vault.
      const next = report.steps.find((s) => s.status === 'next');
      expect(next?.n).toBe(2);
      expect(next?.title).toMatch(/Authenticate/i);
      // Every step has an honest expectation.
      for (const s of report.steps) expect(s.expect.length).toBeGreaterThan(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('advances the NEXT marker to refresh once the vault is initialized but not refreshed', async () => {
    const cwd = await makeTempCwd();
    try {
      const metaDir = join(cwd, 'org-kb', 'meta');
      await mkdir(metaDir, { recursive: true });
      await writeFile(join(metaDir, 'config.json'), JSON.stringify({ targetOrg: 'MyOrg' }), 'utf8');
      const report = await runQuickstart({ cwd, probes: probes() });
      expect(report.ready).toBe(false);
      const next = report.steps.find((s) => s.status === 'next');
      expect(next?.n).toBe(4); // retrieve + build the vault
      expect(next?.title).toMatch(/Retrieve/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('formatQuickstart renders steps, the you-are-here marker, and the follow-up prompt', async () => {
    const cwd = await makeTempCwd();
    try {
      const text = formatQuickstart(await runQuickstart({ cwd, probes: probes() }));
      expect(text).toContain('quickstart');
      expect(text).toContain('← you are here');
      expect(text).toContain('Follow the');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// FR-07 — FAIL-BEFORE/PASS-AFTER: step 1 was hard-coded done, step 2 never
// consulted sf, step 5 was marked done with a pseudo-command, and SFI_VAULT /
// --vault were ignored.
describe('runQuickstart verifies instead of assuming (FR-07)', () => {
  it('does not mark the sf CLI installed when `sf --version` fails', async () => {
    const cwd = await makeTempCwd();
    try {
      const report = await runQuickstart({ cwd, probes: probes({ sfInstalled: async () => false }) });
      expect(report.steps[0]?.status).toBe('next');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not mark auth done when the vault\'s org is not logged in', async () => {
    const cwd = await makeTempCwd();
    try {
      await mkdir(join(cwd, 'org-kb', 'meta'), { recursive: true });
      await writeFile(join(cwd, 'org-kb', 'meta', 'config.json'), JSON.stringify({ targetOrg: 'OtherOrg' }), 'utf8');
      const report = await runQuickstart({ cwd, probes: probes() });
      expect(report.steps[1]?.status).toBe('next');
      expect(report.steps[1]?.expect).toContain('OtherOrg');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('honours SFI_VAULT and --vault like every other command', async () => {
    const cwd = await makeTempCwd();
    const elsewhere = await makeTempCwd();
    try {
      await mkdir(join(elsewhere, 'org-kb', 'meta'), { recursive: true });
      await writeFile(join(elsewhere, 'org-kb', 'meta', 'config.json'), JSON.stringify({ targetOrg: 'MyOrg' }), 'utf8');
      for (const report of [
        await runQuickstart({ cwd, envVault: join(elsewhere, 'org-kb'), probes: probes() }),
        await runQuickstart({ cwd, vault: elsewhere, probes: probes() }),
      ]) {
        expect(report.vaultRoot).toBe(join(elsewhere, 'org-kb'));
        expect(report.steps.find((s) => s.status === 'next')?.n).toBe(4);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('never marks the MCP step done, and gives a real command with the absolute vault path', async () => {
    const cwd = await makeTempCwd();
    try {
      const report = await runQuickstart({ cwd, probes: probes() });
      const last = report.steps[4];
      expect(last?.status).not.toBe('done');
      expect(last?.cmd).toContain(`mcp --vault "${join(cwd, 'org-kb')}"`);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});


// FR-07 follow-up — FAIL-BEFORE/PASS-AFTER: the starter-question ranking
// counted only '__' parts, so a platform event (`ErrorLog__e`) or custom
// metadata type ranked as the user's own custom object and seeded "What runs
// when a new ErrorLog__e record is saved?".
describe('starter-question ranking prefers the user\'s own __c objects', () => {
  it('orders __c, then standard, then __e/__mdt, then managed', async () => {
    const { byOwnership } = await import('../../src/commands/quickstart.js');
    const names = ['Settings__mdt', 'pkg__Thing__c', 'Account', 'ErrorLog__e', 'Invoice__c'];
    expect([...names].sort(byOwnership)).toEqual(['Invoice__c', 'Account', 'ErrorLog__e', 'Settings__mdt', 'pkg__Thing__c']);
  });
});

// FR-07 follow-up — FAIL-BEFORE/PASS-AFTER: `sf --version` ran under the 5s
// org-list timeout, so a cold sf start that was merely slow was reported as
// "sf not installed".
describe('probeSfInstalled', () => {
  it('a timeout-kill means sf is installed but slow; ENOENT means missing', async () => {
    const { probeSfInstalled } = await import('../../src/commands/quickstart.js');
    const timeouts: number[] = [];
    const slow = async (_b: string, _a: readonly string[], o: { timeout: number }): Promise<never> => {
      timeouts.push(o.timeout);
      throw Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' });
    };
    const missing = async (): Promise<never> => {
      throw Object.assign(new Error('spawn sf ENOENT'), { code: 'ENOENT' });
    };
    expect(await probeSfInstalled(slow)).toBe(true);
    expect(timeouts[0]).toBeGreaterThan(5_000);
    expect(await probeSfInstalled(missing)).toBe(false);
    expect(await probeSfInstalled(async () => ({ stdout: '@salesforce/cli/2.0.0', stderr: '' }))).toBe(true);
  });
});
