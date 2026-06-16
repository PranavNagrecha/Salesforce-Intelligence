#!/usr/bin/env node
/**
 * npm prepublishOnly hook for the published `sf-intelligence` CLI package.
 * Blocks publish when the monorepo tree fails leak scan or release guard.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(label, cmd) {
  console.error(`\nprepublish: ${label}`);
  const r = spawnSync(cmd, { shell: true, cwd: root, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\nprepublish: FAILED (${label}) — npm publish aborted.`);
    process.exit(r.status ?? 1);
  }
}

run('scan-org-leaks (--strict)', 'node scripts/scan-org-leaks.mjs --strict');
run('release-guard', 'node scripts/release-guard.mjs');
console.error('\nprepublish: OK — safe to pack/publish sf-intelligence.');
