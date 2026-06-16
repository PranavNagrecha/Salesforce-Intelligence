/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runQuickstart, formatQuickstart } from '../../src/commands/quickstart.js';

const makeTempCwd = async (): Promise<string> => mkdtemp(join(tmpdir(), 'sfi-quickstart-'));

describe('runQuickstart (clean-room, no config)', () => {
  it('from zero config, points the newcomer at the auth step and prints no fake starter questions', async () => {
    const cwd = await makeTempCwd();
    try {
      const report = await runQuickstart({ cwd });
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
      const report = await runQuickstart({ cwd });
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
      const text = formatQuickstart(await runQuickstart({ cwd }));
      expect(text).toContain('quickstart');
      expect(text).toContain('← you are here');
      expect(text).toContain('Follow the');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
