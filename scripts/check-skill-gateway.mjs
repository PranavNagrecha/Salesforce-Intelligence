#!/usr/bin/env node
/**
 * Fail if skills/agents/commands instruct a direct MCP call to a non-core
 * sfi.* tool under the default core profile (Decision 2=C).
 *
 *   node scripts/check-skill-gateway.mjs
 *   node scripts/check-skill-gateway.mjs --fix   # rewrite then re-check
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  findDirectInvokeViolations,
  rewriteDirectInvokes,
} from './lib/skill-gateway.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fix = process.argv.includes('--fix');

const walkMd = (dir) => {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMd(path));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(path);
  }
  return out;
};

const files = [
  ...walkMd(join(root, '.claude/skills')),
  ...walkMd(join(root, '.claude/agents')),
  ...walkMd(join(root, '.claude/commands')),
];

const failures = [];
let rewritten = 0;

for (const path of files) {
  const before = readFileSync(path, 'utf8');
  let text = before;
  if (fix) {
    text = rewriteDirectInvokes(text);
    if (text !== before) {
      writeFileSync(path, text);
      rewritten += 1;
    }
  }
  for (const hit of findDirectInvokeViolations(text)) {
    failures.push({ path, ...hit });
  }
}

if (fix) {
  console.log(`Rewrote ${rewritten} file(s).`);
}

if (failures.length > 0) {
  console.error(
    `skill-gateway: ${failures.length} direct non-core invoke(s) under default core profile:`,
  );
  for (const f of failures.slice(0, 80)) {
    console.error(`  ${f.path}:${f.line}  ${f.tool}`);
    console.error(`    ${f.text}`);
  }
  if (failures.length > 80) {
    console.error(`  … and ${failures.length - 80} more`);
  }
  console.error(
    fix
      ? 'Re-run after manual cleanup of remaining hits (ambiguous prose).'
      : 'Run: node scripts/check-skill-gateway.mjs --fix',
  );
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      filesScanned: files.length,
      rewritten,
      violations: 0,
    },
    null,
    2,
  ),
);
