#!/usr/bin/env node
/**
 * P11-api-response-consistency — gate guard for the MCP tool response surface.
 *
 * Detect-only, additive: it does NOT rename any shipped key (0.1.7 is published,
 * so renames are breaking). It grandfathers today's id-key drift via a committed
 * baseline (`scripts/response-consistency-baseline.json`) and FAILS (exit 1)
 * only when a NEW tool — or a changed input schema — introduces a non-canonical
 * id key, steering new tools to the canonical `componentId`. See ADR-007.
 *
 * Run: `pnpm check:response-consistency`.
 *   --update-baseline   regenerate the baseline from the current roster (use
 *                       when you intentionally add a genuinely-distinct id key).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { V01_TOOLS } from '../packages/mcp/dist/src/tools/index.js';
import {
  analyzeIdKeyConsistency,
  buildBaseline,
} from '../packages/mcp/dist/src/response-consistency.js';

const here = dirname(fileURLToPath(import.meta.url));
const baselinePath = join(here, 'response-consistency-baseline.json');

if (process.argv.includes('--update-baseline')) {
  writeFileSync(baselinePath, `${JSON.stringify(buildBaseline(V01_TOOLS), null, 2)}\n`);
  console.log(`Regenerated ${baselinePath} from ${V01_TOOLS.length} tools.`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const { idKeyMap, violations } = analyzeIdKeyConsistency(V01_TOOLS, baseline);

console.log('MCP response-surface consistency (input id-keys)');
console.log(`  canonical key: ${baseline.canonicalKey}`);
const canonicalUsers = (idKeyMap[baseline.canonicalKey] ?? []).length;
console.log(`  ${baseline.canonicalKey}: ${canonicalUsers} tool(s)`);
const aliases = Object.keys(idKeyMap)
  .filter((k) => k !== baseline.canonicalKey)
  .sort();
console.log(`  non-canonical id keys still in use (grandfathered drift to unify later):`);
for (const key of aliases) {
  console.log(`    ${key}: ${idKeyMap[key].length} — ${idKeyMap[key].join(', ')}`);
}

if (violations.length > 0) {
  console.error('\nresponse-consistency FAILED — new non-canonical id key(s):');
  for (const v of violations) console.error(`  - ${v.message}`);
  console.error(
    '\nFix: use `componentId`, or run `pnpm check:response-consistency --update-baseline` ' +
      'after deciding the key is a genuinely distinct concept (and say why in the commit).',
  );
  process.exit(1);
}

console.log('\nOK — no new non-canonical id keys beyond the grandfathered baseline.');
