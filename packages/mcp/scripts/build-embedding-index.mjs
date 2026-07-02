/**
 * SPIKE (spike/embeddings) — build the per-tool embedding index consumed by
 * src/embedding-funnel.ts.
 *
 * For every tool in V01_TOOLS, embeds the tool's DOCUMENT — its name words +
 * MCP description, plus each synthetic ask-phrasing from funnel-utterances.ts
 * as a separate part — with the pinned quantized sentence-embedding model,
 * mean-pools the part vectors into ONE L2-normalized vector per tool, and
 * writes data/embedding-index.json (checked in; tool-roster order; 6 dp).
 *
 * Multi-part mean (rather than one concatenated string) keeps the utterances
 * inside the model's context window — a concatenated doc would truncate at the
 * model's max sequence length and silently drop most utterances.
 *
 * Run AFTER `pnpm --filter @sf-intelligence/mcp build` (imports from dist):
 *   cd packages/mcp && node scripts/build-embedding-index.mjs
 *
 * NETWORK NOTE: this build-time script is the ONE place the model may be
 * downloaded (once, into .sfi-embed-cache/, ~23 MB quantized). The runtime
 * funnel path never downloads — embedding-funnel.ts sets allowRemoteModels
 * false.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { env, pipeline } from '@huggingface/transformers';

import { FUNNEL_UTTERANCES } from '../dist/src/funnel-utterances.js';
import { V01_TOOLS } from '../dist/src/tools/index.js';

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const DTYPE = 'q8';
const ROUND_DP = 1e6;

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
env.cacheDir = process.env.SFI_EMBED_CACHE ?? path.join(packageRoot, '.sfi-embed-cache');
env.allowLocalModels = true;

const t0 = performance.now();
const extractor = await pipeline('feature-extraction', MODEL, { dtype: DTYPE, device: 'cpu' });
console.log(`model loaded in ${Math.round(performance.now() - t0)} ms (cache: ${env.cacheDir})`);

/** Embed a batch of texts → array of Float32Array (mean-pooled, normalized). */
const embedBatch = async (texts) => {
  const out = await extractor(texts, { pooling: 'mean', normalize: true });
  const [n, dim] = out.dims;
  const rows = [];
  for (let i = 0; i < n; i += 1) rows.push(out.data.slice(i * dim, (i + 1) * dim));
  return rows;
};

const vectors = {};
let dim = 0;
const tEmbed = performance.now();
for (const tool of V01_TOOLS) {
  const nameWords = tool.name.replace(/^sfi\./, '').replace(/_/g, ' ');
  const utterances = FUNNEL_UTTERANCES[tool.name] ?? [];
  const parts = [`${nameWords}. ${tool.description}`, ...utterances];
  const rows = await embedBatch(parts);
  dim = rows[0].length;
  // Mean of part vectors, then re-normalize → one vector per tool (172 × dim).
  const mean = new Float64Array(dim);
  for (const row of rows) for (let i = 0; i < dim; i += 1) mean[i] += row[i];
  let norm = 0;
  for (let i = 0; i < dim; i += 1) {
    mean[i] /= rows.length;
    norm += mean[i] * mean[i];
  }
  norm = Math.sqrt(norm) || 1;
  vectors[tool.name] = Array.from(mean, (x) => Math.round((x / norm) * ROUND_DP) / ROUND_DP);
}
console.log(
  `embedded ${Object.keys(vectors).length} tool docs in ${Math.round(performance.now() - tEmbed)} ms`,
);

const outPath = path.join(packageRoot, 'data', 'embedding-index.json');
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  `${JSON.stringify({ model: MODEL, dtype: DTYPE, dim, vectors }, null, 1)}\n`,
);
console.log(`wrote ${outPath} (dim ${dim})`);
