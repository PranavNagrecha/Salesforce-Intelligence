#!/usr/bin/env node
/**
 * AUDIT-F10 — assert the published `sf-intelligence` tarball contains only
 * paths allowed by packages/cli/package.json#files (plus npm's always-included
 * package.json / LICENSE), and that every allowlisted entry is present.
 *
 * Usage (repo root, after `pnpm --filter sf-intelligence build`):
 *   node scripts/check-pack-allowlist.mjs
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliDir = join(root, 'packages/cli');
const pkgPath = join(cliDir, 'package.json');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const filesField = pkg.files;
if (!Array.isArray(filesField) || filesField.length === 0) {
  console.error('check-pack-allowlist: packages/cli/package.json#files missing');
  process.exit(1);
}

/** Paths npm always includes when present (not listed in `files`). */
const NPM_ALWAYS = new Set(['package.json', 'LICENSE', 'LICENSE.md', 'LICENCE']);

const requiredRoots = filesField.map((f) => f.replace(/\/$/, ''));

const matchesAllowlist = (entryPath) => {
  const norm = entryPath.replace(/^\.\//, '');
  if (NPM_ALWAYS.has(norm)) return true;
  for (const allowed of requiredRoots) {
    if (norm === allowed || norm.startsWith(`${allowed}/`)) return true;
  }
  return false;
};

const distIndex = join(cliDir, 'dist/index.js');
if (!existsSync(distIndex)) {
  console.error(
    'check-pack-allowlist: missing packages/cli/dist/index.js — run `pnpm --filter sf-intelligence build` first',
  );
  process.exit(1);
}

const staging = mkdtempSync(join(tmpdir(), 'sfi-pack-allowlist-'));
let tarball;
try {
  const pack = spawnSync('npm', ['pack', '--json', '--pack-destination', staging], {
    cwd: cliDir,
    encoding: 'utf8',
  });
  if (pack.status !== 0) {
    console.error(pack.stderr || pack.stdout);
    console.error('check-pack-allowlist: npm pack failed');
    process.exit(pack.status ?? 1);
  }
  let meta;
  try {
    meta = JSON.parse(pack.stdout.trim());
  } catch {
    console.error('check-pack-allowlist: could not parse npm pack --json output');
    console.error(pack.stdout);
    process.exit(1);
  }
  const first = Array.isArray(meta) ? meta[0] : meta;
  tarball = join(staging, first.filename ?? first.name);
  if (!existsSync(tarball)) {
    // npm pack --json sometimes returns basename only; find the sole .tgz
    const tgz = readdirSync(staging).find((f) => f.endsWith('.tgz'));
    if (!tgz) {
      console.error('check-pack-allowlist: no .tgz in staging', staging);
      process.exit(1);
    }
    tarball = join(staging, tgz);
  }

  const list = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
  if (list.status !== 0) {
    console.error(list.stderr);
    console.error('check-pack-allowlist: tar -tzf failed');
    process.exit(list.status ?? 1);
  }

  // npm packs as package/<path>
  const entries = list.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^package\//, ''))
    .filter((l) => l.length > 0 && !l.endsWith('/'));

  const extras = entries.filter((e) => !matchesAllowlist(e));
  const presentRoots = new Set();
  for (const e of entries) {
    for (const allowed of requiredRoots) {
      if (e === allowed || e.startsWith(`${allowed}/`)) presentRoots.add(allowed);
    }
  }
  const missing = requiredRoots.filter((r) => !presentRoots.has(r));

  let failed = false;
  if (extras.length > 0) {
    failed = true;
    console.error('check-pack-allowlist: FAIL paths outside package.json#files:');
    for (const e of extras.slice(0, 40)) console.error(`  + ${e}`);
    if (extras.length > 40) console.error(`  … +${extras.length - 40} more`);
  } else {
    console.error(
      `check-pack-allowlist: OK ${entries.length} packed files ⊆ allowlist (${requiredRoots.length} roots + npm always)`,
    );
  }

  if (missing.length > 0) {
    failed = true;
    console.error('check-pack-allowlist: FAIL allowlisted roots missing from tarball:');
    for (const m of missing) console.error(`  - ${m}`);
  } else {
    console.error('check-pack-allowlist: OK all allowlisted roots present');
  }

  if (failed) process.exit(1);
  console.error('check-pack-allowlist: PASS');
} finally {
  rmSync(staging, { recursive: true, force: true });
}
