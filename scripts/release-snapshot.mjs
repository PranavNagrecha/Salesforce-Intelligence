#!/usr/bin/env node
/**
 * Release snapshot — builds a clean PUBLIC copy of the repo.
 *
 * The source repo is private-org-aware: its files are scrubbed, but its git
 * HISTORY contains commit bodies that mention real org names, and a handful of
 * maintainer-only files (integration smoke tests, harness-gated tests, the
 * dev CHANGELOG, the enterprise spec) carry real component names by design.
 *
 * This script produces a throwaway directory containing ONLY the public file
 * set — the exact same set the release guard treats as "shipping" — with a
 * FRESH single-commit git history. None of the source repo's history goes
 * public. As a final gate it re-runs the guard's scan() against the snapshot's
 * own files and refuses to proceed if any forbidden identifier slipped in.
 *
 *   node scripts/release-snapshot.mjs [targetDir]
 *
 * targetDir defaults to ../sf-intelligence-public (sibling of the repo root).
 *
 * The public file set, the exclusion rules, and the leak scanner are imported
 * from scripts/release-guard.mjs — single source of truth. This script never
 * defines its own copy of those rules.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publicSnapshotFiles, scan } from './release-guard.mjs';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..');

function fail(msg) {
  console.error(`\nrelease-snapshot: ${msg}`);
  process.exit(1);
}

function resolveTarget(arg) {
  const raw = arg ?? '../sf-intelligence-public';
  // Relative paths resolve against the repo root, not the CWD, so the default
  // lands as a sibling of the repo regardless of where the script is invoked.
  return isAbsolute(raw) ? raw : resolve(repoRoot, raw);
}

const target = resolveTarget(process.argv[2]);

if (existsSync(target)) {
  fail(
    `target already exists: ${target}\n` +
      'Refusing to overwrite. Remove it (or pass a fresh path) and re-run.',
  );
}

// --- 1. Compute the public file set (single source of truth: the guard). ----
let files;
try {
  files = publicSnapshotFiles();
} catch (err) {
  fail(`could not compute the public file set (is this a git repo?): ${err.message}`);
}
if (!files || files.length === 0) {
  fail('the public file set is empty — aborting.');
}

console.log(`release-snapshot: ${files.length} public files -> ${target}`);

// --- 2. Copy the public file set, preserving directory structure. -----------
mkdirSync(target, { recursive: true });
let copied = 0;
for (const rel of files) {
  const src = join(repoRoot, rel);
  const dest = join(target, rel);
  if (!existsSync(src)) {
    fail(`tracked file missing on disk: ${rel}`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest); // copies bytes verbatim — safe for binary assets
  copied += 1;
}
console.log(`release-snapshot: copied ${copied} files.`);

// --- 3. Fresh git history: init + add + ONE clean commit. -------------------
// We deliberately do NOT copy the source .git, so the source repo's commit
// bodies (which mention real org names) never go public.
const git = (cmd) =>
  execSync(`git ${cmd}`, { cwd: target, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  git('init -q');
  // Local identity so the commit succeeds even if the machine has no global
  // git user configured. Scoped to the throwaway repo only.
  git('config user.email "release@sf-intelligence.local"');
  git('config user.name "sf-intelligence release"');
  git('add -A');
  git('commit -q -m "Initial public release of sf-intelligence"');
} catch (err) {
  const detail = (err.stderr || err.stdout || err.message || '').toString().trim();
  fail(`git init/commit in the snapshot failed: ${detail}`);
}
console.log('release-snapshot: initialized fresh git history (1 commit).');

// --- 4. Final gate: scan the SNAPSHOT's own files for leaks. ----------------
// Re-derive the file list from inside the snapshot via git ls-files so we are
// auditing exactly what was committed, not just what we intended to copy.
let snapTracked;
try {
  snapTracked = git('ls-files').split('\n').filter(Boolean);
} catch (err) {
  fail(`could not list the snapshot's tracked files: ${err.message}`);
}
const snapAbs = snapTracked.map((rel) => join(target, rel));
const { hits, scanned } = scan(snapAbs);

console.log(
  `release-snapshot: guard-scanned ${scanned} text files in the snapshot ` +
    `(${snapTracked.length} committed total).`,
);

if (hits.length > 0) {
  console.error(`\nFOUND ${hits.length} forbidden identifier(s) IN THE SNAPSHOT:`);
  for (const h of hits.slice(0, 200)) console.error(`  ${h}`);
  if (hits.length > 200) console.error(`  … and ${hits.length - 200} more`);
  fail(
    'snapshot is NOT clean — leaks above. The snapshot dir was left in place ' +
      'for inspection; delete it and fix the source before publishing.',
  );
}
console.log('release-snapshot: OK — snapshot is guard-clean.');

// --- 5. Manual next steps for the human. ------------------------------------
console.log(
  [
    '',
    'Next steps (manual — do these yourself):',
    '  1. Create an EMPTY public GitHub repo (no README/license/.gitignore).',
    '  2. Push the snapshot to it:',
    '',
    `       cd "${target}"`,
    '       git remote add origin <REPO_URL>',
    '       git branch -M main',
    '       git push -u origin main',
    '',
    '  (Replace <REPO_URL> with the new repo, e.g. git@github.com:<you>/sf-intelligence.git)',
    '',
  ].join('\n'),
);

process.exit(0);
