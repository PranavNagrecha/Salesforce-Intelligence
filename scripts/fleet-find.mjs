#!/usr/bin/env node
/**
 * Fleet find — "which of our registered orgs contain X?" Resolves a query
 * (typo-tolerant) across every vault in the registry, read-only, and reports
 * per-org disposition + the confident match. The multi-org payoff of the
 * registry: cross-org drift / convention / cleanup sweeps from one command.
 *
 * Usage: pnpm fleet "<query>"   (honors SF_INTELLIGENCE_REGISTRY_PATH)
 * Exit: 0 always (report); 2 on usage/registry error.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { fleetResolve } from '../packages/graph/dist/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const registryPath =
  process.env.SF_INTELLIGENCE_REGISTRY_PATH ??
  join(here, '..', '..', 'registry.json');

const query = process.argv.slice(2).join(' ').trim();
if (query === '') {
  console.error('usage: pnpm fleet "<query>"');
  process.exit(2);
}

let registry;
try {
  registry = JSON.parse(readFileSync(registryPath, 'utf8'));
} catch {
  console.error(`fleet-find: no registry at ${registryPath}`);
  process.exit(2);
}

const vaults = Object.entries(registry.vaults ?? {}).map(([key, v]) => ({
  key,
  graphDbPath: join(v.path, 'graph', 'graph.duckdb'),
}));
if (vaults.length === 0) {
  console.error('fleet-find: no vaults registered');
  process.exit(2);
}

const results = await fleetResolve(vaults, query);

console.log(`Fleet find: "${query}" across ${vaults.length} vault(s)\n`);
const found = [];
for (const r of results) {
  if (r.disposition === 'unavailable') {
    console.log(`  ${r.vault}: unavailable (${r.error})`);
  } else if (r.top !== null) {
    console.log(
      `  ${r.vault}: ${r.disposition.toUpperCase()} -> ${r.top.id} (score ${r.top.score})`,
    );
    found.push(r.vault);
  } else {
    console.log(`  ${r.vault}: not found`);
  }
}
console.log(
  `\nConfidently found in ${found.length}/${vaults.length}: ${found.join(', ') || '(none)'}`,
);
process.exit(0);
