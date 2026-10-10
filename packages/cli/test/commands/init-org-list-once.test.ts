/// <reference types="vitest/globals" />
/**
 * FAIL-BEFORE/PASS-AFTER: non-interactive `sfi init` with no --target-org ran
 * `sf org list` twice (once to look up a default it then ignored, once to name
 * the orgs in the error). A cold sf start costs seconds, so init now reads the
 * local login list at most once.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const listAuthenticatedOrgs = vi.fn(async () => ({ ok: true as const, orgs: [{ alias: 'acme-dev', isDefault: true }] }));

vi.mock('../../src/sf-org-list.js', async (orig) => ({
  ...(await orig<typeof import('../../src/sf-org-list.js')>()),
  listAuthenticatedOrgs,
}));

describe('sfi init reads the sf login list once', () => {
  it('non-interactive, no --target-org: one org-list call, and the error names the orgs', async () => {
    const commander = await import('commander');
    const { registerInitCommand } = await import('../../src/commands/init.js');
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-init-once-'));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const errs: string[] = [];
    const errOut = vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
      errs.push(String(s));
      return true;
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const program = new commander.Command();
      program.exitOverride();
      registerInitCommand(program);
      await program.parseAsync(['node', 'sfi', 'init', '--vault', join(cwd, 'org-kb')]);
      expect(exit).toHaveBeenCalledWith(1);
      expect(errs.join('')).toContain('acme-dev');
      expect(listAuthenticatedOrgs).toHaveBeenCalledTimes(1);
    } finally {
      exit.mockRestore();
      errOut.mockRestore();
      cwdSpy.mockRestore();
      if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
