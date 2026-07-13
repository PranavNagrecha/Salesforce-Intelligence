#!/usr/bin/env node
/**
 * CI guard: if the diff against merge-base touches packages/** or product scripts/**
 * (excluding changelog.d itself), at least one changelog.d/*.md fragment (not README)
 * must be new or modified in the same diff.
 *
 * Exit 0 → OK (fragment present, or diff is docs/website/examples-only)
 * Exit 1 → Missing fragment — prints a clear message with how to fix
 *
 * Usage:
 *   node scripts/check-changelog-fragments.mjs
 *   pnpm changelog:check
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');

function git(...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0 && r.status !== null) {
    // Non-fatal: return empty on error (e.g. no upstream yet)
    return '';
  }
  return (r.stdout ?? '').trim();
}

// Resolve merge-base: prefer origin/main, fall back to main, then HEAD~1
function getMergeBase() {
  // Check if origin/main exists
  const originMain = git('rev-parse', '--verify', 'origin/main');
  if (originMain) {
    const base = git('merge-base', 'HEAD', 'origin/main');
    if (base) return base;
  }
  // Try main
  const main = git('rev-parse', '--verify', 'main');
  if (main) {
    const base = git('merge-base', 'HEAD', 'main');
    if (base) return base;
  }
  // Fallback: diff against parent commit
  const parent = git('rev-parse', '--verify', 'HEAD~1');
  if (parent) return parent;
  // Single-commit repo: compare against empty tree
  return git('hash-object', '-t', 'tree', '/dev/null') || '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
}

const mergeBase = getMergeBase();

// Get list of changed files vs merge-base (names only, including untracked staged)
const diffOutput = git('diff', '--name-only', mergeBase, 'HEAD');
// Staged files not yet committed
const stagedOutput = git('diff', '--name-only', '--cached');
// Untracked files (expand directories by listing individual files)
const untrackedOutput = git('ls-files', '--others', '--exclude-standard');

const diffFiles = diffOutput ? diffOutput.split('\n').filter(Boolean) : [];
const stagedFiles = stagedOutput ? stagedOutput.split('\n').filter(Boolean) : [];
const untrackedFiles = untrackedOutput ? untrackedOutput.split('\n').filter(Boolean) : [];

const allChangedFiles = [...new Set([...diffFiles, ...stagedFiles, ...untrackedFiles])];

// --- Classify files ---

/** Paths that count as "code" and require a fragment */
function isCodePath(f) {
  return (
    f.startsWith('packages/') ||
    (f.startsWith('scripts/') && !f.startsWith('scripts/../changelog.d/'))
  );
}

/** Paths that are explicitly the changelog.d/ fragment area */
function isFragmentPath(f) {
  return f.startsWith('changelog.d/') && /\.md$/i.test(f) && !/readme\.md$/i.test(f);
}

/** Paths that are docs/website/examples only (exempt) */
function isExemptPath(f) {
  return (
    f.startsWith('docs/') ||
    f.startsWith('website/') ||
    f.startsWith('examples/') ||
    f.startsWith('assets/') ||
    f === 'README.md' ||
    f === 'CONTRIBUTING.md' ||
    f === 'CHANGELOG.md' ||
    f === 'SECURITY.md' ||
    f === 'CODE_OF_CONDUCT.md' ||
    f === 'LICENSE' ||
    f === 'NOTICE' ||
    f === '.gitignore' ||
    f.endsWith('.md') && !f.startsWith('packages/') && !f.startsWith('scripts/')
  );
}

const codeFiles = allChangedFiles.filter(isCodePath);
const fragmentFiles = allChangedFiles.filter(isFragmentPath);

if (codeFiles.length === 0) {
  // Only docs/website/examples/config changes → no fragment required
  console.log('[changelog:check] No code changes detected (packages/ or scripts/) — skipping fragment check.');
  process.exit(0);
}

if (fragmentFiles.length > 0) {
  console.log(
    `[changelog:check] OK — ${fragmentFiles.length} fragment(s) found for ${codeFiles.length} code file(s) changed.`,
  );
  console.log(`  Fragments: ${fragmentFiles.join(', ')}`);
  process.exit(0);
}

// --- Fail ---
console.error('[changelog:check] FAIL — code changes detected but no changelog fragment found.\n');
console.error('Changed code files:');
for (const f of codeFiles.slice(0, 10)) console.error(`  ${f}`);
if (codeFiles.length > 10) console.error(`  … and ${codeFiles.length - 10} more`);
console.error('\nFix: add a fragment for your change:');
console.error('  echo "### Added\\n- Your change here." > changelog.d/<item-id>.md');
console.error('\nSee changelog.d/README.md for the fragment format.');
console.error('\nIf this is a docs/website/examples-only change, no fragment is needed');
console.error('but you must not touch packages/ or scripts/ in that diff.');
process.exit(1);
