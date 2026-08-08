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
  // Resolve the tarball WITHOUT trusting the JSON shape. npm 10 reports
  // `filename`; the npm 11 the publish workflow upgrades to for OIDC reports
  // neither `filename` nor `name` here, so `join(staging, undefined)` threw
  // ERR_INVALID_ARG_TYPE before the directory-scan fallback below could run —
  // and it threw only in CI, because local pnpm pins npm 10. Compute the
  // candidate first, join only when it is actually a string, and let the
  // staging-dir scan (which needs no JSON at all) be the real answer.
  const first = (Array.isArray(meta) ? meta[0] : meta) ?? {};
  const reported =
    typeof first.filename === 'string'
      ? first.filename
      : typeof first.name === 'string'
        ? first.name
        : null;
  tarball = reported === null ? null : join(staging, reported);
  if (tarball === null || !existsSync(tarball)) {
    // Authoritative path: we packed into an empty temp dir, so the sole .tgz
    // in it IS the tarball, whatever npm chose to print.
    const tgz = readdirSync(staging).filter((f) => f.endsWith('.tgz'));
    if (tgz.length !== 1) {
      console.error(
        `check-pack-allowlist: expected exactly 1 .tgz in ${staging}, found ${tgz.length}` +
          (tgz.length > 1 ? ` (${tgz.join(', ')})` : ''),
      );
      process.exit(1);
    }
    tarball = join(staging, tgz[0]);
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
