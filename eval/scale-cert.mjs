#!/usr/bin/env node
// Scale certification (P21-MOAT-scale-cert): proves the graph engine imports +
// resolves a 50,000-component synthetic org within a documented budget, beyond
// the 10k CI gate (packages/graph/test/scale-import.test.ts). Synthetic data
// only — no org. Run after `pnpm --filter @sf-intelligence/graph build`.
//   node eval/scale-cert.mjs                 # 50,000 components
//   SCALE_CERT_COUNT=100000 node eval/scale-cert.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  closeGraph,
  importExtractionResults,
  openGraph,
  openGraphReadOnly,
  resolveComponents,
} from '../packages/graph/dist/src/index.js';

const COUNT = Number(process.env.SCALE_CERT_COUNT ?? '50000');
const FIELDS_PER_OBJECT = 50;
const here = dirname(fileURLToPath(import.meta.url));

// --- generate a realistic synthetic org: objects, each with fields ---
const objectCount = Math.max(1, Math.floor(COUNT / FIELDS_PER_OBJECT));
const nodes = [];
for (let o = 0; o < objectCount; o += 1) {
  nodes.push({
    id: `CustomObject:ScaleObj_${o}__c`,
    type: 'CustomObject',
    apiName: `ScaleObj_${o}__c`,
    label: `Scale Object ${o}`,
    parentId: null,
    sourcePath: `objects/ScaleObj_${o}__c/ScaleObj_${o}__c.object-meta.xml`,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {},
  });
}
let fieldIndex = 0;
while (nodes.length < COUNT) {
  const o = fieldIndex % objectCount;
  nodes.push({
    id: `CustomField:ScaleObj_${o}__c.F_${fieldIndex}__c`,
    type: 'CustomField',
    apiName: `F_${fieldIndex}__c`,
    label: `Field ${fieldIndex}`,
    parentId: `CustomObject:ScaleObj_${o}__c`,
    sourcePath: `objects/ScaleObj_${o}__c/fields/F_${fieldIndex}__c.field-meta.xml`,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {},
  });
  fieldIndex += 1;
}

const tmp = mkdtempSync(join(tmpdir(), 'sfi-scale-cert-'));
const dbPath = join(tmp, 'graph.duckdb');

const fail = (msg) => {
  console.error(`scale-cert: ${msg}`);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
};

// --- import ---
const g = await openGraph(dbPath);
if (!g.ok) fail(`openGraph: ${g.error.message}`);
const t0 = performance.now();
const imported = await importExtractionResults(g.value, [{ nodes, edges: [] }]);
const importMs = performance.now() - t0;
await closeGraph(g.value);
if (!imported.ok) fail(`import: ${imported.error.message}`);

// --- resolve (typo-tolerant front door) against the large graph ---
const ro = await openGraphReadOnly(dbPath);
if (!ro.ok) fail(`openGraphReadOnly: ${ro.error.message}`);
const queries = [
  `ScaleObj_${Math.floor(objectCount / 2)}`,
  `F_${Math.floor(COUNT / 2)}`,
  `Scale Object ${objectCount - 1}`,
  `scaleobj_1`, // case/typo-ish
];
const r0 = performance.now();
for (const q of queries) {
  await resolveComponents(ro.value, q, { limit: 25, graphDbPath: dbPath });
}
const resolveMs = performance.now() - r0;
await closeGraph(ro.value);

rmSync(tmp, { recursive: true, force: true });

const importBudget = Number(process.env.SCALE_CERT_IMPORT_BUDGET_MS ?? '420000'); // 7 min
const resolveBudget = Number(process.env.SCALE_CERT_RESOLVE_BUDGET_MS ?? '5000'); // 5 s for the batch

console.log(`scale-cert: ${COUNT.toLocaleString()} components (${objectCount.toLocaleString()} objects × ~${FIELDS_PER_OBJECT} fields)`);
console.log(`  import : ${imported.value.nodesInserted.toLocaleString()} nodes in ${(importMs / 1000).toFixed(1)}s (budget ${(importBudget / 1000).toFixed(0)}s)`);
console.log(`  resolve: ${queries.length} queries in ${resolveMs.toFixed(0)}ms (avg ${(resolveMs / queries.length).toFixed(0)}ms, budget ${resolveBudget}ms)`);

const ok = importMs < importBudget && resolveMs < resolveBudget;
console.log(ok ? 'scale-cert: PASS' : 'scale-cert: OVER BUDGET');
process.exit(ok ? 0 : 1);
