#!/usr/bin/env node
/**
 * R7-F3 — Embedding index parity gate.
 *
 * Verifies that data/embedding-index.json covers exactly the V01_TOOLS roster:
 *   • tool count == vector count
 *   • no tool missing a vector
 *   • no orphan vector (not in roster)
 *
 * Tool roster source (in priority order):
 *   1. packages/mcp/dist/src/tools/index.js  — preferred; requires prior build
 *   2. packages/mcp/src/tools/index.ts       — fallback; regex-parsed from source
 *
 * Regenerate only at integration merge:
 *   cd packages/mcp && node scripts/build-embedding-index.mjs
 *
 * Usage:
 *   node packages/mcp/scripts/check-embedding-index.mjs   (from product root)
 *   node scripts/check-embedding-index.mjs                 (from packages/mcp)
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
// Script lives at packages/mcp/scripts/ — mcpRoot is one level up.
const mcpRoot = path.resolve(scriptDir, '..');
const indexPath = path.join(mcpRoot, 'data', 'embedding-index.json');
const distToolsPath = path.join(mcpRoot, 'dist', 'src', 'tools', 'index.js');
const srcToolsPath = path.join(mcpRoot, 'src', 'tools', 'index.ts');

// ── 1. Load embedding index ───────────────────────────────────────────────────
if (!existsSync(indexPath)) {
  console.error(`[check-embedding-index] FAIL: index not found at ${indexPath}`);
  process.exit(1);
}
const index = JSON.parse(readFileSync(indexPath, 'utf8'));
const vectorKeys = new Set(Object.keys(index.vectors ?? {}));

// ── 2. Load tool roster ───────────────────────────────────────────────────────
let toolNames;
let rosterSource;

if (existsSync(distToolsPath)) {
  // Dynamic import from built dist — canonical path used by the gate after ci:build.
  const distUrl = new URL(`file://${distToolsPath}`);
  const mod = await import(distUrl.href);
  toolNames = (mod.V01_TOOLS ?? []).map((t) => t.name);
  rosterSource = 'dist';
} else if (existsSync(srcToolsPath)) {
  // Fallback: parse tool names directly from TypeScript source via regex.
  // Matches:  name: 'sfi.foo_bar'
  const src = readFileSync(srcToolsPath, 'utf8');
  const seen = new Set();
  toolNames = [];
  for (const m of src.matchAll(/name:\s*'(sfi\.[^']+)'/g)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      toolNames.push(m[1]);
    }
  }
  rosterSource = 'source (dist not built)';
  console.warn(
    `[check-embedding-index] dist not found — parsed ${toolNames.length} tool names from TypeScript source`,
  );
} else {
  console.error('[check-embedding-index] FAIL: neither dist nor src/tools/index.ts found');
  process.exit(1);
}

// ── 3. Compare roster vs index ────────────────────────────────────────────────
const rosterNames = new Set(toolNames);
const missing = [...rosterNames].filter((n) => !vectorKeys.has(n));
const stray = [...vectorKeys].filter((n) => !rosterNames.has(n));

const toolCount = rosterNames.size;
const vectorCount = vectorKeys.size;

console.log(
  `[check-embedding-index] roster=${toolCount} (${rosterSource})  vectors=${vectorCount}  dim=${index.dim ?? '?'}  model=${index.model ?? '?'}`,
);

let failed = false;

if (toolCount !== vectorCount) {
  console.error(`  ✗ count mismatch: ${toolCount} tools vs ${vectorCount} vectors`);
  failed = true;
}
if (missing.length > 0) {
  console.error(`  ✗ missing vectors (${missing.length}): ${missing.join(', ')}`);
  failed = true;
}
if (stray.length > 0) {
  console.error(`  ✗ orphan vectors — not in roster (${stray.length}): ${stray.join(', ')}`);
  failed = true;
}

if (failed) {
  console.error(
    '\n[check-embedding-index] FAIL — regenerate the index at integration merge:\n' +
      '  node scripts/regen-embedding-index.mjs\n' +
      '  (or: cd packages/mcp && pnpm build && node scripts/build-embedding-index.mjs)',
  );
  process.exit(1);
}

console.log('[check-embedding-index] OK — index is in parity with the tool roster');
