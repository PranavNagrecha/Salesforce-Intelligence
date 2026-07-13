#!/usr/bin/env node
/**
 * R7-F3 — Single entrypoint for regenerating the embedding index.
 *
 * IMPORTANT — run ONLY at integration merge, never in parallel fleet branches.
 * Regenerating in a branch that will be rebased/merged causes unnecessary bit
 * noise in the checked-in embedding-index.json. The index is deterministic
 * given a fixed tool roster and model (ROUND_DP pinned at 1e6).
 *
 * Steps:
 *   1. Build @sf-intelligence/mcp (ensures dist is current)
 *   2. Run build-embedding-index.mjs (embeds all V01_TOOLS → data/embedding-index.json)
 *   3. Verify parity with check-embedding-index.mjs
 *
 * Usage (from product root):
 *   node scripts/regen-embedding-index.mjs
 *   pnpm regen:embedding-index
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const productRoot = path.dirname(fileURLToPath(import.meta.url));
const mcpDir = path.join(productRoot, 'packages', 'mcp');

function sh(cmd, cwd = productRoot) {
  console.error(`\n$ ${cmd}  (cwd: ${path.relative(productRoot, cwd) || '.'})`);
  const r = spawnSync(cmd, { shell: true, stdio: 'inherit', cwd });
  if (r.status !== 0) {
    throw new Error(`command failed (exit ${r.status}): ${cmd}`);
  }
}

console.log('[regen-embedding-index] step 1/3 — building @sf-intelligence/mcp …');
sh('pnpm --filter @sf-intelligence/mcp build', productRoot);

console.log('\n[regen-embedding-index] step 2/3 — regenerating embedding index …');
console.log('  (model download skipped when already cached in .sfi-embed-cache/)');
sh('node scripts/build-embedding-index.mjs', mcpDir);

console.log('\n[regen-embedding-index] step 3/3 — verifying parity …');
sh('node scripts/check-embedding-index.mjs', mcpDir);

console.log(
  '\n[regen-embedding-index] done.\n' +
    '  Commit packages/mcp/data/embedding-index.json at the integration merge point.\n' +
    '  Do NOT regenerate in individual fleet branches.',
);
