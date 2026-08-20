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
 * grows with legitimate feature surface (the Graph-B concept model + the tool
 * roster) — it was ~4.1 MB at INFRA-11, ~5.6 MB now — while a real grammar
 * re-inline would add the ~5.4 MB ANTLR grammar (bundle > 10 MB). Ceiling set
 * with headroom above current legitimate size and far below any re-inline; the
 * antlr-ref guard, not this number, is what actually catches a re-inline.
 *
 * PLATFORM-ACCESS-ORACLE raise (5_750_000 -> 5_900_000): the ceiling had run
 * down to ~9.6 KB of headroom (bundle 5_740_339), so the NEXT tool anyone added
 * was going to trip it regardless of what that tool was — one live-plane tool
 * plus its parity engine and Tooling fetcher is ~48 KB of bundled source
 * (esbuild is not minified here, so JSDoc ships too). That is legitimate
 * feature surface, not a grammar re-inline: the precise guard, `MAX_ANTLR_REFS`,
 * stayed at 5 of an allowed 80 across this change. Raised to ~110 KB of
 * headroom so the ceiling keeps catching a re-inline (> 10 MB) without failing
 * every ordinary feature addition.
 */
const MAX_BYTES = 5_900_000;
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
