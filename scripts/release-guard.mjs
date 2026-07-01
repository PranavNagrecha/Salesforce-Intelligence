#!/usr/bin/env node
/**
 * Privacy guard — a defensive check that no private source-org identifiers
 * leak into the committed tree. Wired into CI; run any time with `pnpm guard`.
 *
 * Scans every git-tracked text file for forbidden identifiers and exits
 * non-zero with a file:line list if any are found. The forbidden list is two
 * parts: generic patterns baked in here (the maintainer username and absolute
 * home paths), plus real private-org names loaded from a gitignored local file
 * (see loadForbidden). Generic Salesforce words (Account, etc.) are NOT
 * forbidden.
 *
 * Design intent: the committed tree carries NO private-org metadata, so the
 * guard is a seatbelt, not a filter. A fresh public clone (no local name file)
 * still passes because there is nothing private left to find.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Files/dirs that are maintainer-only and will NOT be in the public release.
// (They need the maintainer's private org vaults to run, so a stranger can't
// use them anyway.) Keep in sync with the release-snapshot script.
export const RELEASE_EXCLUDE = [
  /^tests\/integration\//, // need the maintainer's real-org fixtures to run
  /-report\.md$/, // generated QA reports (gitignored; excluded defensively)
  /^scripts\/r3-wave-smoke\.ts$/, // maintainer wave smoke script
  /^scripts\/release-guard\.mjs$/, // self: contains the forbidden list by design
  /^eval\/cases\.local\.json$/, // maintainer's private golden cases (gitignored)
];

// Generic identifiers that must never appear in ANY tree (public or private):
// absolute macOS/Linux home paths and a personal email. NOT the bare GitHub
// username — that legitimately appears in the public repo URL
// (github.com/PranavNagrecha/…), so matching it would flag every package.json.
// We forbid the *private* forms: the home-directory path and the email.
const GENERIC_FORBIDDEN = [
  /\/Users\/[a-z]/i,
  /[a-z0-9._%+-]+@gmail\.com/i,
];

// Intended-public values that LOOK like a forbidden pattern but are deliberate
// and published on purpose: the commercial-license contact email shown on the
// website and in the LICENSE file. Each is stripped from a line BEFORE the
// forbidden scan, so this exact address is allowed while any OTHER email/gmail
// still trips the guard. Add to this list only addresses that are meant to be
// public; never widen the gmail pattern itself.
export const ALLOWLIST = [
  'pranav.sfintelligence@gmail.com',
];

// Real private-org identifiers (org aliases, namespace prefix, real component
// names) live in a GITIGNORED maintainer-only file so this committed guard is
// itself public-clean. When the file is present (maintainer's machine) the
// guard scans for those names too; without it (a fresh public clone) only the
// generic patterns run — which is correct, because a public-clean tree has no
// private-org names left to find.
function loadForbidden() {
  const local = join(dirname(fileURLToPath(import.meta.url)), 'forbidden-names.local.json');
  const patterns = [...GENERIC_FORBIDDEN];
  if (existsSync(local)) {
    try {
      const { patterns: extra } = JSON.parse(readFileSync(local, 'utf8'));
      for (const p of extra ?? []) patterns.push(new RegExp(p, 'i'));
    } catch {
      // Malformed local file: fall back to the generic patterns only.
    }
  }
  return patterns;
}

// Identifiers that must never appear in shipped files.
export const FORBIDDEN = loadForbidden();

// Binary/asset extensions: copied verbatim into the public snapshot, but never
// scanned line-by-line for leaks (they aren't text).
export const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.duckdb', '.db', '.zip',
  '.woff', '.woff2', '.ico', '.lockb',
]);

/** True if `file` is excluded by a maintainer-only path rule. */
export function isExcludedPath(file) {
  return RELEASE_EXCLUDE.some((re) => re.test(file));
}

/** True if `file` is a binary/asset we copy but never scan. */
export function isBinary(file) {
  return BINARY_EXT.has(extname(file));
}

/**
 * Harness-gated tests depend on the maintainer's real-org fixtures (which
 * never ship). They keep real component names to match their goldens and are
 * MAINTAINER-ONLY — excluded from the public snapshot, so they are not a
 * public leak. The guard skips them when scanning; the snapshot skips them
 * when copying. Same predicate, one definition.
 */
export function isHarnessGated(text) {
  return /findHarnessRoot|itHarness|harness-root/.test(text);
}

/** All git-tracked files. */
export function trackedFiles() {
  return execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
}

/**
 * The shipping set the guard scans: tracked files minus maintainer-only paths
 * and minus binaries (which can't be scanned as text). Harness-gated files are
 * still in this list — `scan()` skips them and counts them, preserving the
 * guard's reported tallies.
 */
export function shippingFiles() {
  return trackedFiles().filter((f) => !isExcludedPath(f) && !isBinary(f));
}

/**
 * The public snapshot copy set: tracked files minus maintainer-only paths and
 * minus harness-gated tests. Binaries/assets ARE included (copied verbatim).
 * This is exactly the set release-snapshot.mjs copies into the public repo.
 */
export function publicSnapshotFiles() {
  return trackedFiles().filter((f) => {
    if (isExcludedPath(f)) return false;
    if (isBinary(f)) return true; // assets ship as-is, never harness-gated
    let text;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      return true; // unreadable-as-text but tracked & not excluded: keep (copied verbatim)
    }
    return !isHarnessGated(text);
  });
}

/**
 * Scan `files` for FORBIDDEN identifiers. Binaries and harness-gated files are
 * skipped (the latter counted as maintainer-only). Returns the leak hits plus
 * the tallies the CLI prints.
 *
 * @param {string[]} files
 * @returns {{ hits: string[], scanned: number, maintainerOnly: number, total: number }}
 */
export function scan(files) {
  const hits = [];
  let maintainerOnly = 0;
  let scanned = 0;
  for (const file of files) {
    if (isBinary(file)) continue; // not text; never scanned
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (isHarnessGated(text)) {
      maintainerOnly += 1;
      continue;
    }
    scanned += 1;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      // Remove intended-public allowlisted values before scanning, so a line
      // that contains only the published contact email passes, while a line
      // with the email AND a real leak still flags on the other match.
      const scanLine = ALLOWLIST.reduce((s, allowed) => s.split(allowed).join(''), lines[i]);
      for (const re of FORBIDDEN) {
        if (re.test(scanLine)) {
          hits.push(`${file}:${i + 1}  ${re}  ${lines[i].trim().slice(0, 100)}`);
          break;
        }
      }
    }
  }
  return { hits, scanned, maintainerOnly, total: files.length };
}

/**
 * Every commit MESSAGE reachable from HEAD — the public-facing history a
 * browser sees on the commit list. The file scan above never sees these, which
 * is how an org name in a commit message (an org alias, a permission-set or
 * field name) can ship to a public repo undetected. This closes that blind spot.
 */
export function commitMessages() {
  const out = execSync('git log --format=%H%x1f%B%x00 HEAD', {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return out
    .split('\0')
    .map((rec) => rec.trim())
    .filter(Boolean)
    .map((rec) => {
      const sep = rec.indexOf('\x1f');
      return { sha: rec.slice(0, sep), body: rec.slice(sep + 1) };
    });
}

/**
 * Scan commit messages for FORBIDDEN identifiers. Same allowlist stripping as
 * the file scan. Returns `sha  pattern  first-line` hits.
 *
 * @param {{sha:string, body:string}[]} messages
 */
export function scanMessages(messages) {
  const hits = [];
  for (const { sha, body } of messages) {
    const scanBody = ALLOWLIST.reduce((s, allowed) => s.split(allowed).join(''), body);
    for (const re of FORBIDDEN) {
      if (re.test(scanBody)) {
        hits.push(`${sha.slice(0, 9)}  ${re}  ${body.split('\n')[0].slice(0, 80)}`);
        break;
      }
    }
  }
  return hits;
}

/** The guard CLI: scan the shipping set + commit messages, print, set exit code. */
export function runGuard() {
  const tracked = trackedFiles();
  const shipped = shippingFiles();
  const { hits: fileHits, scanned, maintainerOnly } = scan(shipped);
  const msgs = commitMessages();
  const msgHits = scanMessages(msgs);
  const hits = [...fileHits, ...msgHits];

  console.log(
    `Release privacy guard: scanned ${scanned} public files + ${msgs.length} commit messages ` +
      `(${maintainerOnly} harness-gated maintainer-only skipped; ${tracked.length} tracked total).`,
  );
  if (hits.length === 0) {
    console.log('OK — no private identifiers in the shipping set or commit history.');
    return 0;
  }
  if (msgHits.length > 0) {
    console.log(`\nFOUND ${msgHits.length} leak(s) in COMMIT MESSAGES (history rewrite needed):`);
    for (const h of msgHits.slice(0, 100)) console.log(`  ${h}`);
  }
  if (fileHits.length > 0) {
    console.log(`\nFOUND ${fileHits.length} leak(s) in TRACKED FILES:`);
    for (const h of fileHits.slice(0, 200)) console.log(`  ${h}`);
    if (fileHits.length > 200) console.log(`  … and ${fileHits.length - 200} more`);
    const byFile = {};
    for (const h of fileHits) {
      const f = h.split(':')[0];
      byFile[f] = (byFile[f] ?? 0) + 1;
    }
    console.log('\nleaks per shipping file:');
    for (const [f, n] of Object.entries(byFile).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${n}\t${f}`);
    }
  }
  return 1;
}

// Run as a CLI only when invoked directly (not when imported by the snapshot).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(runGuard());
}
