#!/usr/bin/env node
// Optional scale gate — measures resolve latency against a budget.
// Run after `pnpm --filter @sf-intelligence/graph build`.
//   node eval/benchmark-scale.mjs
//   SCALE_BUDGET_MS=2000 node eval/benchmark-scale.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  closeGraph,
  openGraphReadOnly,
  resolveComponents,
} from '../packages/graph/dist/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const budgetMs = Number(process.env.SCALE_BUDGET_MS ?? '2000');
const registryPath =
  process.env.SF_INTELLIGENCE_REGISTRY_PATH ??
  join(here, '..', '..', 'registry.json');

const queries = ['Account', 'Industry', 'Flow', 'Permission'];

const main = async () => {
  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  } catch {
    console.log('No registry — scale gate skipped.');
    return 0;
  }

  const firstVault = Object.entries(registry.vaults ?? {})[0];
  if (!firstVault) {
    console.log('No vaults in registry — scale gate skipped.');
    return 0;
  }

  const [vaultName, entry] = firstVault;
  const graphPath = join(entry.path, 'graph', 'graph.duckdb');
  const opened = await openGraphReadOnly(graphPath);
  if (!opened.ok) {
    console.error(`Cannot open graph for ${vaultName}: ${opened.error.message}`);
    console.error(`  path: ${graphPath}`);
    return 1;
  }

  const started = performance.now();
  for (const query of queries) {
    await resolveComponents(opened.value, query, { limit: 25, graphDbPath: graphPath });
  }
  await closeGraph(opened.value);
  const elapsed = performance.now() - started;

  console.log(`scale gate: ${queries.length} resolves in ${elapsed.toFixed(0)}ms (budget ${budgetMs}ms)`);
  if (elapsed > budgetMs) {
    console.error('scale gate FAILED');
    return 1;
  }
  return 0;
};

process.exit(await main());
