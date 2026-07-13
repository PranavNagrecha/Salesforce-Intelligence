#!/usr/bin/env node
/**
 * Assembles changelog.d/*.md fragments into CHANGELOG.md under ## [Unreleased].
 *
 * - Reads all *.md files in changelog.d/ (skips README.md, case-insensitive)
 * - Groups bullets by subsection heading (### Added / ### Changed / ### Fixed / ### Removed)
 * - Replaces the content block between ## [Unreleased] and the next ## [...] heading
 *   (or EOF) with the assembled fragment output
 * - Idempotent: running twice produces the same CHANGELOG.md
 *
 * Usage:
 *   node scripts/assemble-changelog.mjs
 *   pnpm changelog:assemble
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const fragmentsDir = join(root, 'changelog.d');
const changelogPath = join(root, 'CHANGELOG.md');

const KNOWN_SECTIONS = ['Added', 'Changed', 'Fixed', 'Removed', 'Deprecated', 'Security'];
const README_RE = /^readme\.md$/i;

/** Parse a fragment file into { [section]: string[] } */
function parseFragment(content) {
  const sections = {};
  let current = null;
  for (const raw of content.split('\n')) {
    const line = raw.trimEnd();
    const heading = line.match(/^###\s+(.+)$/);
    if (heading) {
      current = heading[1].trim();
      if (!sections[current]) sections[current] = [];
    } else if (current && line.startsWith('-')) {
      sections[current].push(line);
    } else if (current && line.startsWith(' ') && sections[current]?.length) {
      // continuation line for a bullet
      sections[current][sections[current].length - 1] += '\n' + line;
    }
  }
  return sections;
}

/** Merge all fragment maps into one, preserving canonical section order. */
function mergeFragments(maps) {
  const merged = {};
  for (const section of KNOWN_SECTIONS) merged[section] = [];
  for (const map of maps) {
    for (const [section, bullets] of Object.entries(map)) {
      if (!merged[section]) merged[section] = [];
      merged[section].push(...bullets);
    }
  }
  return merged;
}

/** Render merged sections as Markdown block (no trailing newline). */
function renderBlock(merged) {
  const parts = [];
  for (const section of KNOWN_SECTIONS) {
    const bullets = merged[section];
    if (bullets && bullets.length > 0) {
      parts.push(`### ${section}\n${bullets.join('\n')}`);
    }
  }
  // Include any non-canonical sections found in fragments
  for (const [section, bullets] of Object.entries(merged)) {
    if (!KNOWN_SECTIONS.includes(section) && bullets.length > 0) {
      parts.push(`### ${section}\n${bullets.join('\n')}`);
    }
  }
  return parts.join('\n\n');
}

// --- Read fragments ---
let files;
try {
  files = readdirSync(fragmentsDir).filter(
    (f) => f.endsWith('.md') && !README_RE.test(f),
  );
} catch {
  console.error('[assemble-changelog] changelog.d/ not found — nothing to assemble.');
  process.exit(0);
}

if (files.length === 0) {
  console.error('[assemble-changelog] No fragments found in changelog.d/ (skipping).');
  process.exit(0);
}

const maps = files.map((f) => {
  const content = readFileSync(join(fragmentsDir, f), 'utf8');
  return parseFragment(content);
});

const merged = mergeFragments(maps);
const block = renderBlock(merged);

// --- Read existing CHANGELOG.md ---
let changelog;
try {
  changelog = readFileSync(changelogPath, 'utf8');
} catch {
  // Bootstrap minimal CHANGELOG if none exists
  changelog = `# Changelog\n\nAll notable changes to **sf-intelligence** are documented here.\n\n## [Unreleased]\n\n`;
}

// Locate the ## [Unreleased] heading
const unreleasedMatch = changelog.match(/^(##\s*\[Unreleased\][^\n]*\n)/m);
if (!unreleasedMatch) {
  console.error(
    '[assemble-changelog] No ## [Unreleased] heading found in CHANGELOG.md — inserting after first heading.',
  );
  // Insert after the first # heading
  const firstHeading = changelog.match(/^#[^#][^\n]*\n/m);
  if (firstHeading) {
    const idx = changelog.indexOf(firstHeading[0]) + firstHeading[0].length;
    const newChangelog =
      changelog.slice(0, idx) +
      '\n## [Unreleased]\n\n' +
      block +
      '\n\n' +
      changelog.slice(idx);
    writeFileSync(changelogPath, newChangelog, 'utf8');
  } else {
    writeFileSync(changelogPath, `# Changelog\n\n## [Unreleased]\n\n${block}\n\n${changelog}`, 'utf8');
  }
  console.log(`[assemble-changelog] Inserted [Unreleased] block (${files.length} fragment(s)).`);
  process.exit(0);
}

const headingStart = changelog.indexOf(unreleasedMatch[1]);
const contentStart = headingStart + unreleasedMatch[1].length;

// Find the next ## [...] heading after [Unreleased]
const afterUnreleased = changelog.slice(contentStart);
const nextHeadingMatch = afterUnreleased.match(/\n(##\s)/);
let contentEnd;
if (nextHeadingMatch) {
  contentEnd = contentStart + nextHeadingMatch.index + 1; // keep the \n before next heading
} else {
  contentEnd = changelog.length;
}

const newContent = '\n' + block + '\n\n';
const newChangelog =
  changelog.slice(0, contentStart) + newContent + changelog.slice(contentEnd);

writeFileSync(changelogPath, newChangelog, 'utf8');
console.log(
  `[assemble-changelog] Updated CHANGELOG.md [Unreleased] from ${files.length} fragment(s): ${files.join(', ')}`,
);
