#!/usr/bin/env node
/**
 * Portability guard — stop the hand-rolled path-separator class from regrowing.
 *
 * The class this guards against cost three silent Windows failures at once: an
 * entire metadata type extracting to zero rows, a deploy gate that printed
 * `overallVerdict: 'safe'` because it had parsed nothing, and the operator's
 * username leaking into every MCP response. None of them threw, none of them
 * failed a test, and each was "protected" only by a comment claiming some
 * upstream boundary had already normalised the input.
 *
 * A comment cannot be executed. This can.
 *
 * The rule: every "split a path" / "render a path relative to" goes through
 * `@sf-intelligence/core`'s `path-portable` module. Anything else in a package
 * source tree is a finding, unless it is on the allowlist below WITH a reason.
 *
 * Run: `pnpm check:portability`. Exit 0 = clean, 1 = a new copy appeared.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = join(root, 'packages');

/**
 * Sites that legitimately hand-roll, each with the reason it cannot use the
 * shared helper. A path may only appear here with a justification — an
 * allowlist without reasons decays into a mute button.
 */
const ALLOW = new Map([
  [
    'packages/core/src/path-portable.ts',
    'the module itself — this is where the one correct spelling lives',
  ],
  [
    'packages/graph/src/relativize.ts',
    'canonical UNCONDITIONAL normaliser for graph source_path; must rewrite backslashes on POSIX too (see its own test)',
  ],
  [
    'packages/vault/src/source-path.ts',
    'thin alias over toRelativePosix, kept so vault does not re-export core wholesale',
  ],
  [
    'packages/tooling-api/src/client.ts',
    'builds Salesforce REST URLs, not filesystem paths — a URL separator is always "/"',
  ],
]);

/**
 * Patterns that indicate a hand-rolled separator decision. Deliberately narrow:
 * `join`/`resolve`/`basename` from node:path are separator-correct and are NOT
 * flagged. What is flagged is code that decides for itself what a separator is.
 */
const PATTERNS = [
  { re: /\.split\('\/'\)/, why: "split on '/' — use splitPathSegments (accepts either separator)" },
  { re: /\.split\("\/"\)/, why: "split on '/' — use splitPathSegments" },
  { re: /\.split\(sep\)/, why: 'split on the host separator — use splitPathSegments' },
  { re: /\.split\(\/\[\\\\\\\\\/\]\+\/\)/, why: 'inline both-separator regex — use splitPathSegments / PATH_SEPARATORS' },
  { re: /startsWith\(`\$\{[A-Za-z_$][\w$]*\}\/`\)/, why: 'hand-rolled path-prefix test — use toRelativePosix / collapseHome' },
  { re: /replace\(\/\\\\\\\\\/g, '\/'\)/, why: 'hand-rolled backslash rewrite — use toPosixPath' },
];

/** Every .ts file under packages/<pkg>/src, excluding tests and build output. */
const sourceFiles = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'test') continue;
      sourceFiles(abs, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(abs);
    }
  }
  return out;
};

const findings = [];
for (const pkg of readdirSync(PACKAGES)) {
  const src = join(PACKAGES, pkg, 'src');
  try {
    if (!statSync(src).isDirectory()) continue;
  } catch {
    continue;
  }
  for (const abs of sourceFiles(src)) {
    const rel = relative(root, abs).split('\\').join('/');
    if (ALLOW.has(rel)) continue;
    const lines = readFileSync(abs, 'utf8').split('\n');
    lines.forEach((line, i) => {
      // Skip comment lines: this file's own findings are quoted in prose all
      // over the codebase now, and a guard that trips on its own explanation
      // teaches people to delete the explanation.
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
      for (const { re, why } of PATTERNS) {
        if (re.test(line)) findings.push({ rel, line: i + 1, why, text: trimmed.slice(0, 100) });
      }
    });
  }
}

if (findings.length > 0) {
  console.error('check-portability: FAIL — hand-rolled path separator logic found\n');
  for (const f of findings) {
    console.error(`  ${f.rel}:${f.line}`);
    console.error(`    ${f.text}`);
    console.error(`    → ${f.why}\n`);
  }
  console.error(
    'Import the helper from @sf-intelligence/core instead. If a site genuinely\n' +
      'cannot (a URL, an unconditional normaliser), add it to ALLOW in this file\n' +
      'WITH the reason — the reason is the point.',
  );
  process.exit(1);
}

console.log(
  `check-portability: OK — no hand-rolled separator logic outside ${ALLOW.size} justified sites`,
);
