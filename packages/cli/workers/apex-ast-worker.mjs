/**
 * INFRA-05 — Apex AST parse worker.
 *
 * Pure `string → edges` work for the refresh AST pass. The published CLI
 * ships a bundled copy at `dist/apex-ast-worker.js` (esbuild inlines the
 * parsers package; `@apexdevtools/apex-parser` stays external per INFRA-11).
 * Dev/vitest resolves this source file so monorepo workspace imports work.
 */
import { parentPort, workerData } from 'node:worker_threads';

import { extractApexAstEdges } from '@sf-intelligence/parsers/apex-ast';

if (parentPort === null) {
  throw new Error('apex-ast-worker must run as a worker_thread');
}

const knownClasses = new Set(
  Array.isArray(workerData?.knownClasses) ? workerData.knownClasses : [],
);

parentPort.on('message', (job) => {
  const result = extractApexAstEdges(job.source, job.apiName, {
    knownClasses,
    kind: job.kind,
  });
  parentPort.postMessage({ index: job.index, result });
});
