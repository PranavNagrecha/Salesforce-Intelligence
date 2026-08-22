#!/usr/bin/env node
/**
 * INFRA-11 — CLI bundle size / ANTLR-inline guard.
 *
 * The published `sf-intelligence` package ships `dist/index.js` (+ INFRA-05
 * `dist/apex-ast-worker.js`). Before INFRA-11, esbuild inlined
 * `@apexdevtools/apex-parser` (~5.4 MB ANTLR grammar) into the main bundle
 * even though refresh lazy-loads the AST pass — the bundle was ~5.5 MB with
 * ~1,700+ ApexParser/antlr refs. After externalizing the grammar, the main
 * bundle must stay under a hard ceiling and must not regain thousands of
 * ANTLR references. The AST worker must also keep the grammar external.
 *
 * Run after `pnpm --filter sf-intelligence build` (also invoked from
 * packages/cli/build.mjs and CI).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = join(root, 'packages/cli/dist/index.js');
const workerPath = join(root, 'packages/cli/dist/apex-ast-worker.js');
const buildPath = join(root, 'packages/cli/build.mjs');

/**
 * Soft size backstop for a full grammar re-inline. The PRECISE grammar-inline
 * guard is `MAX_ANTLR_REFS` below (a re-inline mints ~1,700 ApexParser/antlr
 * refs); this byte ceiling is only defense-in-depth. The externalized bundle
 * grows with legitimate feature surface — it was ~4.1 MB at INFRA-11 and is
 * ~5.96 MB after the 2026-08-20 integration (PermissionDependency ingest,
 * platform-access oracle, action-chain model, reasoning reachability, report
 * graph persistence) — while a real grammar re-inline would add the ~5.4 MB
 * ANTLR grammar (bundle > 10 MB). The antlr-ref guard, not this number, is what
 * actually catches a re-inline.
 *
 * SET ONCE AT INTEGRATION (5_750_000 -> 6_300_000). Five branches independently
 * ratcheted this constant to three different values (5.75 / 5.80 / 5.90 MB)
 * because each one, in isolation, was the next feature to exhaust the ~9.6 KB of
 * headroom left at 5_740_339. Summed, their deltas land the merged bundle at
 * ~5_964_000 — so whichever branch merged LAST would have gone red on a ceiling
 * every earlier branch had already "fixed". Raising it per-branch is the
 * anti-pattern; this is one value with real headroom, chosen so the next feature
 * does not restart the ratchet, and still ~4.7 MB below any grammar re-inline.
 *
 * RAISED AGAIN by the apex-structure lane (6_300_000 -> 6_400_000), and this is
 * the very ratchet the paragraph above calls the anti-pattern — so it is flagged
 * rather than buried. What actually happened, measured: the branch arrived at
 * 6_247_823 (9 KB of the previous grant left, spent by earlier lanes), and
 * `sfi.apex_structure` adds 78_786 bytes — 65_125 of them the two new modules
 * (`parsers/apex-structure.js` 23_482, `mcp/tools/apex-structure.js` 41_643),
 * the rest its roster description, funnel utterances and router rule. esbuild
 * already strips this repo's JSDoc, so that number is code and verbatim
 * disclosure strings, not comments: there was no 27 KB of slack to reclaim
 * without deleting honesty text the tool exists to emit. The PRECISE re-inline
 * guard is untouched and green (10 ANTLR refs of 80; a real grammar re-inline
 * mints ~1_700 and ~5.4 MB), which is what this byte ceiling is a backstop for.
 * INTEGRATION OWNER: re-set this ONCE against the merged bundle, as the
 * paragraph above prescribes — do not treat 6_400_000 as the new floor to
 * ratchet from.
 */
const MAX_BYTES = 6_400_000;
/** Leftover string mentions of the external import path are fine; grammar class bodies are not. */
const MAX_ANTLR_REFS = 80;
/** Worker ships parsers/apex-ast logic but must not re-inline the ANTLR grammar. */
const MAX_WORKER_BYTES = 1_500_000;
const MAX_WORKER_ANTLR_REFS = 80;

if (!existsSync(bundlePath)) {
  console.error(
    'check-cli-bundle: missing packages/cli/dist/index.js — run `pnpm --filter sf-intelligence build` first',
  );
  process.exit(1);
}

const size = statSync(bundlePath).size;
const text = readFileSync(bundlePath, 'utf8');
const antlrRefs = (text.match(/ApexParser|antlr|ANTLR/gi) ?? []).length;

const buildSrc = existsSync(buildPath) ? readFileSync(buildPath, 'utf8') : '';
const listedExternal = /['"]@apexdevtools\/apex-parser['"]/.test(buildSrc);

let failed = false;

const ok = (label) => console.error(`check-cli-bundle: OK ${label}`);
const fail = (label) => {
  console.error(`check-cli-bundle: FAIL ${label}`);
  failed = true;
};

if (!listedExternal) {
  fail('@apexdevtools/apex-parser missing from packages/cli/build.mjs EXTERNAL_PACKAGES');
} else {
  ok('@apexdevtools/apex-parser listed in EXTERNAL_PACKAGES');
}

if (size > MAX_BYTES) {
  fail(`bundle size ${size} bytes > ceiling ${MAX_BYTES} (grammar likely re-inlined)`);
} else {
  ok(`bundle size ${size} bytes <= ${MAX_BYTES}`);
}

if (antlrRefs > MAX_ANTLR_REFS) {
  fail(
    `antlr/ApexParser refs ${antlrRefs} > ceiling ${MAX_ANTLR_REFS} (grammar likely re-inlined)`,
  );
} else {
  ok(`antlr/ApexParser refs ${antlrRefs} <= ${MAX_ANTLR_REFS}`);
}

// INFRA-05 moved the AST parse into dist/apex-ast-worker.js — the main bundle
// no longer needs (or should carry) a direct @apexdevtools/apex-parser import.
// Re-inlining is still caught by the size + antlr-ref ceilings above.
if (text.includes('@apexdevtools/apex-parser')) {
  ok('bundle retains external @apexdevtools/apex-parser import string');
} else {
  ok('bundle has no @apexdevtools/apex-parser import (AST parse lives in worker)');
}

// INFRA-05: published worker entry must exist and keep the grammar external.
if (!existsSync(workerPath)) {
  fail('missing packages/cli/dist/apex-ast-worker.js (INFRA-05 worker entry)');
} else {
  const workerSize = statSync(workerPath).size;
  const workerText = readFileSync(workerPath, 'utf8');
  const workerAntlrRefs = (workerText.match(/ApexParser|antlr|ANTLR/gi) ?? []).length;
  ok('apex-ast-worker.js present');
  if (workerSize > MAX_WORKER_BYTES) {
    fail(
      `worker size ${workerSize} bytes > ceiling ${MAX_WORKER_BYTES} (grammar likely re-inlined)`,
    );
  } else {
    ok(`worker size ${workerSize} bytes <= ${MAX_WORKER_BYTES}`);
  }
  if (workerAntlrRefs > MAX_WORKER_ANTLR_REFS) {
    fail(
      `worker antlr/ApexParser refs ${workerAntlrRefs} > ceiling ${MAX_WORKER_ANTLR_REFS}`,
    );
  } else {
    ok(`worker antlr/ApexParser refs ${workerAntlrRefs} <= ${MAX_WORKER_ANTLR_REFS}`);
  }
  if (!workerText.includes('@apexdevtools/apex-parser')) {
    fail('worker does not mention @apexdevtools/apex-parser (expected external import)');
  } else {
    ok('worker retains external @apexdevtools/apex-parser import string');
  }
}

if (failed) {
  console.error(
    'check-cli-bundle: keep @apexdevtools/apex-parser in EXTERNAL_PACKAGES + cli package.json dependencies',
  );
  process.exit(1);
}

console.error('check-cli-bundle: all checks passed');
process.exit(0);
