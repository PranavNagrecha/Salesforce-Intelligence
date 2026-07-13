/**
 * Static-embedding retrieval layer for the semantic funnel (spike/embeddings,
 * option 4a — model2vec / potion family).
 *
 * WHY THIS EXISTS: the MiniLM hybrid (embedding-funnel.ts) was never wired into
 * the shipped router because query embedding is ASYNC (onnxruntime inference)
 * while the funnel candidate chain (semanticCandidates → buildFunnelCandidates →
 * the I6 margin gate + funnel-primary fallback) is SYNCHRONOUS. A static
 * embedding is a pure integer-table lookup + mean-pool + normalize — synchronous,
 * sub-millisecond, no model load, no native dep — so it drops into the sync chain
 * with zero async refactor. semantic-funnel.ts folds this fusion INTO
 * semanticCandidates behind a default-OFF gate (opt-in via `SFI_STATIC_EMBED=1`),
 * so BOTH route_question call sites AND both recall harnesses inherit it with
 * no rewiring once enabled.
 *
 * DETERMINISM: the checked-in int8 token table + WordPiece tokenizer are pure
 * integer math + IEEE add; same input → identical vector → identical ranking.
 * No Math.random, no Date.now, no float model. (Pinned by static-embed tests.)
 *
 * OFFLINE: the token→vector table (data/static-embedding-table.bin) and the
 * pre-computed per-tool document vectors (data/static-embedding-index.json) are
 * checked in and read from disk. Nothing is ever downloaded at runtime — the
 * download happens once at BUILD time in scripts/build-static-embedding-index.mjs.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeToIds } from './wordpiece.js';
import type { WordPieceVocab } from './wordpiece.js';

/** Sidecar header for the checked-in static-embedding table. */
interface StaticEmbeddingMeta {
  /** Source static model id (e.g. minishlab/potion-base-8M). */
  readonly model: string;
  /** Embedding dimensionality. */
  readonly dim: number;
  /** Number of rows in the int8 table (== vocab size). */
  readonly vocabCount: number;
  /** int8 dequant scale (documentation only — cancels under L2 normalization). */
  readonly scale: number;
  /** `[UNK]` token id. */
  readonly unkId: number;
  /** WordPiece `max_input_chars_per_word`. */
  readonly maxInputChars: number;
  /** id-ordered token strings. */
  readonly vocab: readonly string[];
}

/** Shape of the checked-in per-tool document vector index. */
interface StaticDocIndexFile {
  readonly model: string;
  readonly dim: number;
  /** Canonical `sfi.*` tool name → L2-normalized document vector. */
  readonly vectors: Readonly<Record<string, readonly number[]>>;
}

interface LoadedTable {
  readonly dim: number;
  /** int8 token embedding matrix, row-major `[vocabCount × dim]`. */
  readonly matrix: Int8Array;
  readonly vocab: WordPieceVocab;
}

interface LoadedDocIndex {
  readonly dim: number;
  /** tool name → L2-normalized doc vector. */
  readonly vectors: ReadonlyMap<string, Float64Array>;
}

const DATA_DIR = 'data';
const META_FILE = 'static-embedding-meta.json';
const TABLE_FILE = 'static-embedding-table.bin';
const INDEX_FILE = 'static-embedding-index.json';

/** Walk up from this module looking for the `data/` dir that holds the table. */
const findDataDir = (): string | null => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let hop = 0; hop < 6; hop += 1) {
    const candidate = path.join(dir, DATA_DIR);
    if (existsSync(path.join(candidate, META_FILE))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
};

let cachedTable: LoadedTable | null | undefined;
let cachedDocIndex: LoadedDocIndex | null | undefined;

/** Load + memoize the int8 token table; null when absent/unreadable. */
export const loadStaticTable = (): LoadedTable | null => {
  if (cachedTable !== undefined) return cachedTable;
  cachedTable = null;
  const dataDir = findDataDir();
  if (dataDir === null) return cachedTable;
  try {
    const meta = JSON.parse(
      readFileSync(path.join(dataDir, META_FILE), 'utf8'),
    ) as StaticEmbeddingMeta;
    const buf = readFileSync(path.join(dataDir, TABLE_FILE));
    const matrix = new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    if (matrix.length !== meta.vocabCount * meta.dim) return cachedTable;
    const vocabMap = new Map<string, number>();
    for (let i = 0; i < meta.vocab.length; i += 1) vocabMap.set(meta.vocab[i] ?? '', i);
    cachedTable = {
      dim: meta.dim,
      matrix,
      vocab: { vocab: vocabMap, unkId: meta.unkId, maxInputChars: meta.maxInputChars },
    };
  } catch {
    cachedTable = null;
  }
  return cachedTable;
};

/** Load + memoize the pre-computed per-tool document vectors; null when absent. */
export const loadStaticDocIndex = (): LoadedDocIndex | null => {
  if (cachedDocIndex !== undefined) return cachedDocIndex;
  cachedDocIndex = null;
  const dataDir = findDataDir();
  if (dataDir === null) return cachedDocIndex;
  try {
    const file = JSON.parse(
      readFileSync(path.join(dataDir, INDEX_FILE), 'utf8'),
    ) as StaticDocIndexFile;
    const vectors = new Map<string, Float64Array>();
    for (const [tool, raw] of Object.entries(file.vectors)) {
      const v = Float64Array.from(raw);
      // Re-normalize defensively against JSON rounding drift (cosine == dot).
      let norm = 0;
      for (const x of v) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < v.length; i += 1) v[i] = (v[i] ?? 0) / norm;
      vectors.set(tool, v);
    }
    cachedDocIndex = { dim: file.dim, vectors };
  } catch {
    cachedDocIndex = null;
  }
  return cachedDocIndex;
};

/** Drop the memoized table + doc index — test/build only. */
export const resetStaticEmbed = (): void => {
  cachedTable = undefined;
  cachedDocIndex = undefined;
};

/**
 * Embed one text into an L2-normalized static vector: WordPiece tokenize → mean
 * of the int8 token rows → normalize. Returns `null` when the text yields no
 * tokens (empty / all-OOV-to-nothing) — matching the funnel's "no signal" cut.
 *
 * The int8 dequant scale is a GLOBAL constant multiplier on every row, so it
 * cancels exactly under the final L2 normalization — we read the int8 values as
 * the vector components directly. This is what makes the embedding bit-stable.
 */
export const embedTextStatic = (text: string, table: LoadedTable): Float64Array | null => {
  const ids = encodeToIds(text, table.vocab);
  if (ids.length === 0) return null;
  const { dim, matrix } = table;
  const acc = new Float64Array(dim);
  for (const id of ids) {
    const base = id * dim;
    for (let d = 0; d < dim; d += 1) acc[d] = (acc[d] ?? 0) + (matrix[base + d] ?? 0);
  }
  let norm = 0;
  for (let d = 0; d < dim; d += 1) {
    acc[d] = (acc[d] ?? 0) / ids.length;
    norm += (acc[d] ?? 0) * (acc[d] ?? 0);
  }
  norm = Math.sqrt(norm);
  if (norm === 0) return null;
  for (let d = 0; d < dim; d += 1) acc[d] = (acc[d] ?? 0) / norm;
  return acc;
};

/** True only when BOTH the token table and the doc index are present + valid. */
export const staticIndexAvailable = (): boolean =>
  loadStaticTable() !== null && loadStaticDocIndex() !== null;

/**
 * Rank the tool corpus against `question` by static-embedding cosine. Returns a
 * `tool → cosine` map over every tool with a positive cosine (doc vectors are
 * L2-normalized, so cosine == dot). Empty when the layer is unavailable or the
 * question has no tokens. Meta/orchestration filtering is the CALLER's job (the
 * funnel applies EXCLUDED_FROM_CANDIDATES over the fused pool).
 */
export const staticEmbedRanking = (question: string): Map<string, number> => {
  const out = new Map<string, number>();
  const table = loadStaticTable();
  const docIndex = loadStaticDocIndex();
  if (table === null || docIndex === null) return out;
  const qvec = embedTextStatic(question, table);
  if (qvec === null) return out;
  const n = Math.min(qvec.length, docIndex.dim);
  for (const [tool, vec] of docIndex.vectors) {
    let dot = 0;
    for (let i = 0; i < n; i += 1) dot += (qvec[i] ?? 0) * (vec[i] ?? 0);
    if (dot > 0) out.set(tool, dot);
  }
  return out;
};

/**
 * ASYMMETRIC reciprocal-rank fusion (mirrors embedding-funnel.ts `fuseScoresRrf`,
 * copied here so the SYNC funnel path has no dependency on the async MiniLM
 * module — importing it would create a semantic-funnel ↔ embedding-funnel import
 * cycle). Fused score = Σ 1/(k + rank), with a SEPARATE k per ranking.
 *
 * The lexical and embedding rankings are NOT peers here. Measurement (spike/
 * embeddings A/B) showed the static-embedding signal is weaker than the tuned
 * lexical funnel on this corpus (embed-only recall@8 ~79% vs lexical ~90%), so a
 * SYMMETRIC RRF (equal k) drags good lexical hits out of the top-k and REGRESSES
 * recall. The fix is to make lexical the AUTHORITY (small `RRF_K_LEX` → large
 * per-rank weight) and the embedding a gentle RESCUE layer (large `RRF_K_EMBED` →
 * small weight): the arithmetic guarantees an embedding-only tool can never
 * displace a lexical top-k hit — it can only promote a lexical NEAR-MISS (ranked
 * just outside top-k) that the embedding also ranks highly. That is the additive,
 * "never remove a strong lexical hit" behavior, and it lifts recall on both sets
 * with zero goldset regression (kL=10, kE=60 was the measured sweet spot).
 */
export const RRF_K_LEX = 10;
export const RRF_K_EMBED = 60;
export const fuseScoresRrf = (
  lexRanked: readonly string[],
  embedRanked: readonly string[],
  kLex: number = RRF_K_LEX,
  kEmbed: number = RRF_K_EMBED,
): Map<string, number> => {
  const fused = new Map<string, number>();
  const add = (ranked: readonly string[], k: number): void => {
    for (let i = 0; i < ranked.length; i += 1) {
      const tool = ranked[i];
      if (tool === undefined) continue;
      fused.set(tool, (fused.get(tool) ?? 0) + 1 / (k + i + 1));
    }
  };
  add(lexRanked, kLex);
  add(embedRanked, kEmbed);
  return fused;
};
