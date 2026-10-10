#!/usr/bin/env node
/**
 * Scan for customer org identifiers and real schema leaks.
 * Usage:
 *   node scripts/scan-org-leaks.mjs [--strict] [--git-history] [--paths dir ...]
 * Exit 1 if any hit in --strict mode; exit 2 if the org blocklist is broken,
 * or missing under --strict without --allow-no-blocklist.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  allowNoBlocklistFromEnv,
  assertBlocklistPresent,
  describeBlocklist,
  loadForbiddenNames,
} from './lib/forbidden-names.mjs';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const gitHistory = args.includes('--git-history');
const pathsIdx = args.indexOf('--paths');
const roots =
  pathsIdx >= 0
    ? args.slice(pathsIdx + 1).filter((a) => !a.startsWith('-'))
    : [join(dirname(fileURLToPath(import.meta.url)), '..')];

const SKIP_DIRS = new Set([
  'node_modules',
  '.pnpm-store',
  '.git',
  'dist',
  'coverage',
  '.sfi-mega-backup',
  'end-user-transcripts', // gitignored maintainer runs (eval/)
  'org-kb', // user vault — never scan (gitignored)
]);

const SKIP_FILES = new Set([
  'scan-org-leaks.mjs',
  'scrub-replacements.txt',
  'scrub-policy.md',
  'BACKLOG.md',
  'loop-v0.1.6.md',
]);

/**
 * Real org-specific identifiers live ONLY in the gitignored maintainer config
 * `scripts/forbidden-names.local.json` — never in this committed file. The
 * ONE loader (`scripts/lib/forbidden-names.mjs`) fails CLOSED: a broken file
 * always aborts the scan, and in --strict mode a MISSING blocklist is a
 * failure unless `--allow-no-blocklist` / SFI_ALLOW_NO_BLOCKLIST=1 says a
 * generic-only scan is acceptable (contributors, fork-PR CI). Either way the
 * scan prints how many patterns it loaded, so a vacuous pass is visible.
 */
let blocklist;
try {
  blocklist = loadForbiddenNames(process.env.SFI_FORBIDDEN_NAMES_PATH || undefined);
  assertBlocklistPresent(blocklist, { strict, allowNoBlocklist: allowNoBlocklistFromEnv(args) });
} catch (e) {
  console.error(`scan-org-leaks: FAILED — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
console.log(`scan-org-leaks: ${describeBlocklist(blocklist)}`);
const ALL_PATTERNS = blocklist.scannerPatterns.map((p, i) => ({ id: `LOCAL-${i}`, re: new RegExp(p, 'i') }));
const GIT_HISTORY_TERMS = blocklist.historyTerms;

function walk(dir, files = []) {
  let st;
  try {
    st = statSync(dir);
  } catch {
    return files;
  }
  if (st.isFile()) {
    files.push(dir);
    return files;
  }
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (SKIP_DIRS.has(name)) continue;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, files);
    else if (st.isFile()) files.push(full);
  }
  return files;
}

function isTextFile(path) {
  const base = path.split('/').pop() ?? '';
  if (SKIP_FILES.has(base)) return false;
  if (/^qa-(transcript|revalidate|roster)/.test(base)) return false;
  if (/\.(png|jpg|jpeg|gif|webp|ico|zip|gz|duckdb|wal|pdf|woff2?|ttf|eot)$/i.test(path)) return false;
  return true;
}

function scanFile(path, root) {
  let rel = relative(root, path);
  if (!rel || rel === '.') rel = path.split('/').pop() || path;
  if (rel.startsWith('org-kb/') || rel.includes('/org-kb/')) {
    return [{ file: rel, pattern: 'PATH-org-kb', line: 0, snippet: '(entire org-kb tree should not be scanned in product — remove from git)' }];
  }
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { id, re } of ALL_PATTERNS) {
      if (re.test(line)) {
        hits.push({
          file: rel,
          pattern: id,
          line: i + 1,
          snippet: line.trim().slice(0, 120),
        });
      }
    }
  }
  return hits;
}

function scanGitHistory() {
  const hits = [];
  // Exclude skip-listed meta files: the detector itself, the scrub mapping,
  // and the scrub policy legitimately contain the very terms they describe,
  // so history scanning must not flag its own tooling as a leak.
  const excludes = [...SKIP_FILES].map((f) => `':(exclude,glob)**/${f}'`).join(' ');
  for (const term of GIT_HISTORY_TERMS) {
    try {
      const out = execSync(`git log --all -S "${term}" --oneline -- . ${excludes} 2>/dev/null`, {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      }).trim();
      if (out) {
        const count = out.split('\n').filter(Boolean).length;
        hits.push({ term, count, sample: out.split('\n').slice(0, 3).join(' | ') });
      }
    } catch {
      // not a git repo or git missing
    }
  }
  return hits;
}

const allHits = [];

/**
 * Default repo scan considers only git-tracked files. Gitignored local
 * artifacts (org-kb/, .pnpm-store/, maintainer smoke scripts, real vault
 * paths) are never committed, so scanning them only yields false positives.
 * Explicit `--paths` still walks the filesystem (for ad-hoc directory scans).
 */
function gitTrackedFiles(root) {
  try {
    const out = execSync('git ls-files -z', {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split('\0').filter(Boolean).map((rel) => join(root, rel));
  } catch {
    return null; // not a git repo — fall back to filesystem walk
  }
}

for (const root of roots) {
  const tracked = pathsIdx < 0 ? gitTrackedFiles(root) : null;
  const files = (tracked ?? walk(root)).filter(isTextFile);
  for (const f of files) {
    allHits.push(...scanFile(f, root));
  }
}

if (gitHistory) {
  const hist = scanGitHistory();
  if (hist.length) {
    console.error('\n=== GIT HISTORY LEAKS (git log -S) ===');
    for (const h of hist) {
      console.error(`  ${h.term}: ${h.count} commit(s) — ${h.sample}`);
    }
    if (strict) process.exit(1);
  } else {
    console.log('Git history: no hits for blocklist terms.');
  }
}

if (allHits.length === 0) {
  console.log('scan-org-leaks: OK (0 hits)');
  process.exit(0);
}

const byPattern = {};
for (const h of allHits) {
  byPattern[h.pattern] = (byPattern[h.pattern] || 0) + 1;
}

console.error(`\nscan-org-leaks: ${allHits.length} hit(s)`);
console.error('By pattern:', byPattern);
console.error('\nFirst 40 hits:');
for (const h of allHits.slice(0, 40)) {
  console.error(`  [${h.pattern}] ${h.file}:${h.line}  ${h.snippet}`);
}
if (allHits.length > 40) console.error(`  ... and ${allHits.length - 40} more`);

process.exit(strict ? 1 : 0);
