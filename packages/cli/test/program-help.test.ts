/// <reference types="vitest/globals" />

import type { Command } from 'commander';

import { createProgram } from '../src/program.js';

const ROOT_USAGE = 'Usage: sfi [options] [command]';

// `readVersion` reads the esbuild define first; without it, the unbundled
// `src/program.ts` looks for package.json one directory too high.
vi.stubGlobal('SFI_BUILD_VERSION', '0.0.0-test');

/**
 * Parse argv exactly as `bin/sfi.js` does (`createProgram().parseAsync`),
 * capturing what commander writes instead of printing and exiting.
 */
const helpFor = async (...args: string[]): Promise<string> => {
  let out = '';
  const capture = (cmd: Command): void => {
    cmd.exitOverride().configureOutput({
      writeOut: (s) => { out += s; },
      writeErr: (s) => { out += s; },
    });
    cmd.commands.forEach(capture);
  };
  const program = createProgram();
  capture(program);
  try {
    await program.parseAsync(['node', 'sfi', ...args]);
  } catch (e) {
    if ((e as { code?: string }).code !== 'commander.helpDisplayed') throw e;
  }
  return out;
};

describe('sfi <command> <subcommand> --help', () => {
  it.each([
    [['snapshot', 'list', '--help'], 'Usage: sfi snapshot list [options]'],
    [['snapshot', 'delete', 'X', '--help'], 'Usage: sfi snapshot delete [options] <label>'],
    [['vault', 'git', 'status', '--help'], 'Usage: sfi vault git status [options]'],
    [['feedback', 'export', '--help'], 'Usage: sfi feedback export [options]'],
    // Controls: the short flag, and a sibling subcommand.
    [['snapshot', 'list', '-h'], 'Usage: sfi snapshot list [options]'],
    [['snapshot', 'create', '--help'], 'Usage: sfi snapshot create [options]'],
  ])('%j prints that subcommand\'s own help', async (args, usage) => {
    const out = await helpFor(...args);
    expect(out.split('\n')[0]).toBe(usage);
    expect(out).not.toContain(ROOT_USAGE);
  });

  it('an operand that is not a subcommand gets the help of the deepest command matched', async () => {
    // `vault list` does not exist: vault's own help, not the root's.
    expect((await helpFor('vault', 'list', '--help')).split('\n')[0]).toBe('Usage: sfi vault [options] [command]');
    // One argument "snapshot list" (a shell that did not word-split) is not a
    // command either, so the root answers. This is the shape that looks like
    // "--help prints the top-level help" from a `for c in "snapshot list"; … $c` loop in zsh.
    expect((await helpFor('snapshot list', '--help')).split('\n')[0]).toBe(ROOT_USAGE);
  });
});
