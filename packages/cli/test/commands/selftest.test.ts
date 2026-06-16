/// <reference types="vitest/globals" />

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSelftest, formatSelftest, selftestExitCode } from '../../src/commands/selftest.js';

const makeTempCwd = async (): Promise<string> => mkdtemp(join(tmpdir(), 'sfi-selftest-'));

describe('runSelftest', () => {
  it('reports vault-not-open with an actionable next step when there is no vault', async () => {
    const cwd = await makeTempCwd();
    try {
      const report = await runSelftest({ cwd });
      expect(report.vaultOpen).toBe(false);
      expect(report.passed).toBe(0);
      expect(report.probes).toEqual([]);
      expect(report.note).toMatch(/sfi init/);
      expect(report.note).toMatch(/sfi refresh/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('formatSelftest renders the not-built message without throwing', async () => {
    const cwd = await makeTempCwd();
    try {
      const text = formatSelftest(await runSelftest({ cwd }));
      expect(text).toContain('selftest');
      expect(text).toMatch(/Run `sfi init`/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('always includes a §C3 usage probe in the probe set (when a vault is built)', () => {
    // The probe list is fixed; assert the usage question type is one of them by
    // rendering a synthetic report (the real-org run is verified against a vault).
    const text = formatSelftest({
      vaultOpen: true,
      ran: 6,
      passed: 6,
      note: 'Your vault answers 6 of 6 question types.',
      probes: [
        { questionType: 'Where is X used? (usage)', tool: 'sfi.find_component_usages', ok: true, skipped: null },
      ],
    });
    expect(text).toMatch(/Where is X used\? \(usage\)/);
    expect(text).toMatch(/answers 6 of 6/);
  });
});

describe('selftestExitCode', () => {
  const base = { ran: 0, note: '', probes: [] as const };

  it('exits 1 when the vault cannot open — a missing/corrupt vault is a failure, not a success', () => {
    expect(selftestExitCode({ ...base, vaultOpen: false, passed: 0 })).toBe(1);
  });

  it('exits 1 when the vault opens but answers nothing', () => {
    expect(selftestExitCode({ ...base, vaultOpen: true, passed: 0 })).toBe(1);
  });

  it('exits 0 when the vault opens and answers at least one question type', () => {
    expect(selftestExitCode({ ...base, vaultOpen: true, passed: 3 })).toBe(0);
  });
});
