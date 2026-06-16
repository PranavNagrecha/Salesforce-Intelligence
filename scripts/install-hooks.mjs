#!/usr/bin/env node
/**
 * Installs this repo's git hooks by pointing core.hooksPath at .githooks.
 * Wired to the `prepare` npm lifecycle, so it runs on `pnpm install` for
 * every clone — contributors automatically get the org-leak pre-commit hook.
 *
 * No-op outside this repo's own git work tree (e.g. when sf-intelligence is
 * installed as a dependency, or packed into a tarball with no .git).
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

try {
  execSync('git rev-parse --is-inside-work-tree', { cwd: root, stdio: 'ignore' });
  if (!existsSync(join(root, '.githooks'))) process.exit(0);
  execSync('git config core.hooksPath .githooks', { cwd: root, stdio: 'ignore' });
  console.error('install-hooks: git hooks enabled (core.hooksPath → .githooks)');
} catch {
  // Not a git work tree — dependency/tarball install. Nothing to install.
}
