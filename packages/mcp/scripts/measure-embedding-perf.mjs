/**
 * SPIKE (spike/embeddings) — perf measurement for the embedding-hybrid funnel.
 * Reports: model cold-start (pipeline load from local cache), first-query
 * latency, warm per-query embed latency (p50/p95), and end-to-end
 * hybridCandidates latency for both fusion modes.
 *
 * Run AFTER `pnpm --filter @sf-intelligence/mcp build` and after the index
 * exists (scripts/build-embedding-index.mjs):
 *   cd packages/mcp && SFI_EMBEDDINGS=1 node scripts/measure-embedding-perf.mjs
 */
import { hybridCandidates, loadEmbeddingIndex, resetEmbeddingRuntime } from '../dist/src/embedding-funnel.js';
import { semanticCandidates } from '../dist/src/semantic-funnel.js';

const QUERIES = [
  'who is allowed to look at the Amount field on Opportunity',
  'what goes on behind the scenes when somebody saves a case',
  'is anything going to break if we get rid of the Discount field',
  'give me a quick health readout for this org',
  'roughly how many open opportunities are there right now',
  'which permission sets are collecting dust',
  'trace everything that writes to the account status',
  'do we have any apex nobody calls anymore',
  'what outside services does this org exchange data with',
  'draft an onboarding document for a new admin',
];

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

const index = loadEmbeddingIndex();
if (index === null) {
  console.error('no embedding index — run scripts/build-embedding-index.mjs first');
  process.exit(1);
}
console.log(`index: ${index.vectors.size} tools × ${index.file.dim} (${index.file.model}, ${index.file.dtype})`);

// Cold start: first hybrid call pays the pipeline load + first inference.
resetEmbeddingRuntime();
const tCold = performance.now();
await hybridCandidates(QUERIES[0], 8, 'max');
const coldMs = performance.now() - tCold;
console.log(`cold start (model load + first query, local cache): ${Math.round(coldMs)} ms`);

// Warm per-query: full hybrid path (lexical + embed + fuse), both modes.
for (const fusion of ['max', 'rrf']) {
  const times = [];
  for (let round = 0; round < 5; round += 1) {
    for (const q of QUERIES) {
      const t = performance.now();
      await hybridCandidates(q, 8, fusion);
      times.push(performance.now() - t);
    }
  }
  times.sort((a, b) => a - b);
  console.log(
    `warm hybrid (${fusion}): p50 ${pct(times, 0.5).toFixed(1)} ms, p95 ${pct(times, 0.95).toFixed(1)} ms over ${times.length} queries`,
  );
}

// Lexical baseline for comparison.
const lexTimes = [];
for (let round = 0; round < 5; round += 1) {
  for (const q of QUERIES) {
    const t = performance.now();
    semanticCandidates(q, 8);
    lexTimes.push(performance.now() - t);
  }
}
lexTimes.sort((a, b) => a - b);
console.log(
  `lexical baseline: p50 ${pct(lexTimes, 0.5).toFixed(1)} ms, p95 ${pct(lexTimes, 0.95).toFixed(1)} ms`,
);
