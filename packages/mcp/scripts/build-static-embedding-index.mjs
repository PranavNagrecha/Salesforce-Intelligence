/**
 * spike/embeddings (option 4a) — build the checked-in STATIC embedding assets:
 *
 *   data/static-embedding-table.bin   int8 token→vector matrix (potion-base-8M)
 *   data/static-embedding-meta.json   sidecar header + id-ordered WordPiece vocab
 *   data/static-embedding-index.json  191 pre-computed per-tool document vectors
 *
 * model2vec / potion is a distilled STATIC embedding: a `vocab × dim` matrix
 * (PCA + Zipf baked in at distill time) whose inference is a pure mean of the
 * token rows + L2 normalize — no ONNX, no native dep, fully synchronous and
 * deterministic. We reimplement that inference in pure TS (src/static-embed.ts +
 * src/wordpiece.ts); this script produces the assets they read.
 *
 * The token matrix is int8-quantized (symmetric, scale = maxabs/127). Because the
 * per-token dequant is a GLOBAL scale and the funnel L2-normalizes every vector,
 * the scale cancels exactly — int8 vs full-float cosine stays ≥ 0.999 (measured).
 *
 * Doc vectors are embedded from the IDENTICAL per-tool corpus the lexical index
 * uses (semantic-funnel.buildToolDocs) via the SAME runtime embed function, so
 * the checked-in index is exactly what the funnel would produce at query time.
 *
 * Run AFTER `pnpm --filter @sf-intelligence/mcp build` (imports from dist):
 *   cd packages/mcp && node scripts/build-static-embedding-index.mjs
 *
 * NETWORK: this build-time script is the ONE place the model is downloaded (once,
 * ~30 MB f32 → cached in .sfi-static-model-cache/, gitignored). Override the
 * cache dir with SFI_STATIC_MODEL_CACHE. The runtime funnel never downloads.
 * Deterministic: pinned model + pinned quantization; no RNG, no timestamps.
 */
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODEL = 'minishlab/potion-base-8M';
const FILES = ['model.safetensors', 'vocab.txt'];
const MAX_INPUT_CHARS = 100;
const ROUND_DP = 1e6;

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cacheDir =
  process.env.SFI_STATIC_MODEL_CACHE ?? path.join(packageRoot, '.sfi-static-model-cache');
const dataDir = path.join(packageRoot, 'data');
mkdirSync(cacheDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

/** Download a pinned model file into the cache once (skips if present). */
const ensureFile = async (name) => {
  const dest = path.join(cacheDir, name);
  if (existsSync(dest)) return dest;
  const url = `https://huggingface.co/${MODEL}/resolve/main/${name}`;
  console.log(`downloading ${name} …`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
};

for (const f of FILES) await ensureFile(f);

// --- parse the safetensors embedding matrix (single tensor `embeddings`) -------
const stBuf = readFileSync(path.join(cacheDir, 'model.safetensors'));
const headerLen = Number(stBuf.readBigUInt64LE(0));
const header = JSON.parse(stBuf.toString('utf8', 8, 8 + headerLen));
const info = header.embeddings;
if (info.dtype !== 'F32') throw new Error(`unexpected dtype ${info.dtype}`);
const [vocabCount, dim] = info.shape;
const dataStart = 8 + headerLen + info.data_offsets[0];
const dataEnd = 8 + headerLen + info.data_offsets[1];
const aligned = stBuf.buffer.slice(stBuf.byteOffset + dataStart, stBuf.byteOffset + dataEnd);
const matrix = new Float32Array(aligned);
if (matrix.length !== vocabCount * dim) throw new Error('matrix size mismatch');
console.log(`matrix ${vocabCount} × ${dim} (${MODEL})`);

// --- int8 quantize (symmetric, global scale) -----------------------------------
let maxabs = 0;
for (let i = 0; i < matrix.length; i += 1) {
  const a = Math.abs(matrix[i]);
  if (a > maxabs) maxabs = a;
}
const scale = maxabs / 127;
const q = new Int8Array(matrix.length);
for (let i = 0; i < matrix.length; i += 1) {
  q[i] = Math.max(-127, Math.min(127, Math.round(matrix[i] / scale)));
}

// --- id-ordered WordPiece vocab -------------------------------------------------
const vocab = readFileSync(path.join(cacheDir, 'vocab.txt'), 'utf8').split('\n');
// vocab.txt has a trailing newline → drop the final empty entry only.
if (vocab.length > 0 && vocab[vocab.length - 1] === '') vocab.pop();
if (vocab.length !== vocabCount) {
  throw new Error(`vocab.txt (${vocab.length}) != matrix rows (${vocabCount})`);
}
const unkId = vocab.indexOf('[UNK]');
if (unkId < 0) throw new Error('[UNK] not in vocab');

// --- write the table + meta -----------------------------------------------------
writeFileSync(path.join(dataDir, 'static-embedding-table.bin'), Buffer.from(q.buffer));
writeFileSync(
  path.join(dataDir, 'static-embedding-meta.json'),
  `${JSON.stringify(
    { model: MODEL, dim, vocabCount, scale, unkId, maxInputChars: MAX_INPUT_CHARS, vocab },
    null,
    0,
  )}\n`,
);
console.log(
  `wrote static-embedding-table.bin (${q.length} int8, ${(q.length / 1e6).toFixed(2)} MB) + meta`,
);

// --- pre-compute per-tool DOC vectors via the SAME runtime embed function -------
// Import from dist so the checked-in doc vectors are byte-for-byte what the funnel
// would produce at query time from the table we just wrote.
const distEmbed = pathToFileURL(path.join(packageRoot, 'dist/src/static-embed.js')).href;
const distFunnel = pathToFileURL(path.join(packageRoot, 'dist/src/semantic-funnel.js')).href;
const { embedTextStatic, loadStaticTable, resetStaticEmbed } = await import(distEmbed);
const { buildToolDocs } = await import(distFunnel);

resetStaticEmbed();
const table = loadStaticTable();
if (table === null) throw new Error('static table failed to load after write');

const vectors = {};
let embedded = 0;
for (const [tool, doc] of buildToolDocs()) {
  const vec = embedTextStatic(doc, table);
  if (vec === null) throw new Error(`empty doc vector for ${tool}`);
  vectors[tool] = Array.from(vec, (x) => Math.round(x * ROUND_DP) / ROUND_DP);
  embedded += 1;
}
writeFileSync(
  path.join(dataDir, 'static-embedding-index.json'),
  `${JSON.stringify({ model: MODEL, dim, vectors }, null, 1)}\n`,
);
console.log(`wrote static-embedding-index.json (${embedded} tool doc vectors, dim ${dim})`);
