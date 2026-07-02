/**
 * SPIKE (spike/embeddings) — neural-embedding hybrid layer for the semantic
 * funnel. NOT a product decision: this module exists to MEASURE whether a
 * small local sentence-embedding model lifts funnel candidate recall past the
 * lexical TF-IDF plateau at zero honesty cost.
 *
 * Design constraints (non-negotiable if this is ever adopted):
 *  - FULLY OFFLINE AT RUNTIME: the per-tool document vectors are pre-computed
 *    by scripts/build-embedding-index.mjs and checked in
 *    (data/embedding-index.json). At query time only the QUESTION is embedded,
 *    by a locally cached model — `allowRemoteModels` is disabled here, so the
 *    funnel can never phone home. If the model is not in the local cache the
 *    embed fails and the caller degrades to the lexical path.
 *  - DETERMINISTIC: pinned model + pinned dtype (recorded in the index file);
 *    onnxruntime CPU inference measured bit-identical across runs on this
 *    machine (maxdiff 0 in the spike smoke test).
 *  - ADDITIVE: this module is only ever loaded via the dynamic import behind
 *    the `SFI_EMBEDDINGS=1` gate in semantic-funnel.ts. Gate off ⇒ never
 *    imported ⇒ lexical path byte-identical.
 *
 * Model cache location (SPIKE decision, revisit at productionization): the
 * quantized model (~23 MB) is downloaded ONCE by the index-build script into
 * `packages/mcp/.sfi-embed-cache/` (gitignored), overridable via
 * `SFI_EMBED_CACHE`. Bundling vs optional-download is deliberately unsolved
 * here — see the spike report.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXCLUDED_FROM_CANDIDATES,
  getFunnelIndex,
  resolveCandidatePlane,
  semanticCandidates,
} from './semantic-funnel.js';
import type { FusionMode, ToolCandidate } from './semantic-funnel.js';

/** Shape of the checked-in data/embedding-index.json file. */
export interface EmbeddingIndexFile {
  /** Pinned transformers.js model id (e.g. Xenova/all-MiniLM-L6-v2). */
  readonly model: string;
  /** Pinned quantization dtype the vectors were produced with (e.g. q8). */
  readonly dtype: string;
  /** Embedding dimensionality (384 for MiniLM-L6). */
  readonly dim: number;
  /** Canonical `sfi.*` tool name → L2-normalized document vector. */
  readonly vectors: Readonly<Record<string, readonly number[]>>;
}

interface LoadedIndex {
  readonly file: EmbeddingIndexFile;
  /** Re-normalized Float64 vectors (defends against JSON rounding drift). */
  readonly vectors: ReadonlyMap<string, Float64Array>;
}

/**
 * Weight applied to the embedding cosine in `max` fusion. Lexical TF-IDF
 * cosines live in ~[0.05, 0.45] while MiniLM sentence cosines live in
 * ~[0.2, 0.8], so an unweighted max would let the embedding drown the lexical
 * evidence. 0.5 is the spike default; the measure phase sweeps this
 * (override: SFI_EMBED_WEIGHT).
 */
export const DEFAULT_EMBED_WEIGHT = 0.5;

/** Standard reciprocal-rank-fusion constant (Cormack et al.). */
export const RRF_K = 60;

/** Lexical pool depth fused against the embedding ranking (all scored rows). */
const LEXICAL_POOL = 10_000;

/**
 * Locate data/embedding-index.json by walking up from this module's directory
 * (works from both src/ under vitest and dist/src/ at runtime).
 */
export const findEmbeddingIndexPath = (): string | null => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let hop = 0; hop < 5; hop += 1) {
    const candidate = path.join(dir, 'data', 'embedding-index.json');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
};

let cachedIndex: LoadedIndex | null | undefined;

/** Load + memoize the checked-in vector index; null when absent/unreadable. */
export const loadEmbeddingIndex = (): LoadedIndex | null => {
  if (cachedIndex !== undefined) return cachedIndex;
  cachedIndex = null;
  const indexPath = findEmbeddingIndexPath();
  if (indexPath === null) return cachedIndex;
  try {
    const file = JSON.parse(readFileSync(indexPath, 'utf8')) as EmbeddingIndexFile;
    const vectors = new Map<string, Float64Array>();
    for (const [tool, raw] of Object.entries(file.vectors)) {
      const v = Float64Array.from(raw);
      let norm = 0;
      for (const x of v) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < v.length; i += 1) v[i] = (v[i] ?? 0) / norm;
      vectors.set(tool, v);
    }
    cachedIndex = { file, vectors };
  } catch {
    cachedIndex = null;
  }
  return cachedIndex;
};

/** Drop the memoized index + embedder — test-only. */
export const resetEmbeddingRuntime = (): void => {
  cachedIndex = undefined;
  embedderPromise = null;
};

type Embedder = (text: string) => Promise<Float32Array>;

let embedderPromise: Promise<Embedder> | null = null;

/**
 * Lazy, memoized query embedder over the PINNED model/dtype from the index
 * file. Offline-only: remote model fetches are disabled, so this throws when
 * the model is not in the local cache — callers degrade to lexical.
 */
const getEmbedder = (model: string, dtype: string): Promise<Embedder> => {
  embedderPromise ??= (async (): Promise<Embedder> => {
    const tf = await import('@huggingface/transformers');
    const indexPath = findEmbeddingIndexPath();
    const packageRoot =
      indexPath !== null ? path.dirname(path.dirname(indexPath)) : process.cwd();
    tf.env.cacheDir = process.env['SFI_EMBED_CACHE'] ?? path.join(packageRoot, '.sfi-embed-cache');
    // OFFLINE AT RUNTIME: never fetch a model from the network in the funnel.
    tf.env.allowRemoteModels = false;
    tf.env.allowLocalModels = true;
    const extractor = await tf.pipeline('feature-extraction', model, {
      dtype: dtype as 'q8',
      device: 'cpu',
    });
    return async (text: string): Promise<Float32Array> => {
      const out = await extractor(text, { pooling: 'mean', normalize: true });
      return out.data as Float32Array;
    };
  })();
  return embedderPromise;
};

/**
 * PURE max-fusion scorer (unit-tested without the model): fused score per tool
 * = max(lexicalScore, w * embeddingCosine). Tools with neither positive
 * lexical score nor positive weighted embedding cosine are dropped, mirroring
 * the lexical funnel's `dot <= 0` cut.
 */
export const fuseScoresMax = (
  lexScores: ReadonlyMap<string, number>,
  embedCos: ReadonlyMap<string, number>,
  w: number,
): Map<string, number> => {
  const fused = new Map<string, number>();
  for (const [tool, s] of lexScores) fused.set(tool, s);
  for (const [tool, c] of embedCos) {
    const weighted = w * c;
    const prev = fused.get(tool);
    if (prev === undefined || weighted > prev) fused.set(tool, weighted);
  }
  for (const [tool, s] of fused) if (s <= 0) fused.delete(tool);
  return fused;
};

/**
 * PURE reciprocal-rank fusion (unit-tested without the model): fused score =
 * Σ 1/(RRF_K + rank) over the rankings the tool appears in (1-based ranks).
 * A tool absent from a ranking simply contributes no term for it.
 */
export const fuseScoresRrf = (
  lexRanked: readonly string[],
  embedRanked: readonly string[],
  kRrf: number = RRF_K,
): Map<string, number> => {
  const fused = new Map<string, number>();
  const addRanking = (ranked: readonly string[]): void => {
    for (let i = 0; i < ranked.length; i += 1) {
      const tool = ranked[i];
      if (tool === undefined) continue;
      fused.set(tool, (fused.get(tool) ?? 0) + 1 / (kRrf + i + 1));
    }
  };
  addRanking(lexRanked);
  addRanking(embedRanked);
  return fused;
};

/** Effective max-fusion weight (env override for the measure phase). */
const embedWeight = (): number => {
  const raw = process.env['SFI_EMBED_WEIGHT'];
  if (raw === undefined) return DEFAULT_EMBED_WEIGHT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EMBED_WEIGHT;
};

/**
 * Embedding-hybrid candidate shortlist. Fuses the FULL lexical ranking with
 * embedding cosine over every indexed tool (meta/orchestration tools stay
 * excluded, exactly as in the lexical funnel), then re-assembles ToolCandidate
 * rows: a tool the lexical funnel already scored keeps its row (category /
 * plane / lexical cosine intact, score replaced by the fused score); a tool
 * surfaced ONLY by the embedding gets a new row with `cosine: 0` (zero LEXICAL
 * semantic evidence — the honesty contract on that field is preserved) and its
 * `embedCosine` carried for calibration.
 *
 * Confidence: the fused shortlist currently INHERITS the lexical shortlist's
 * calibrated confidence (or `low` when the lexical funnel returned nothing).
 * Recalibrating confidence for fused scores is measure-phase work — flagged in
 * the spike report, deliberately not invented here.
 */
export const hybridCandidates = async (
  question: string,
  k = 8,
  fusion: FusionMode = 'max',
): Promise<ToolCandidate[]> => {
  const lexical = semanticCandidates(question, LEXICAL_POOL);
  const index = loadEmbeddingIndex();
  if (index === null) return lexical.slice(0, k);

  let queryVec: Float32Array;
  try {
    const embed = await getEmbedder(index.file.model, index.file.dtype);
    queryVec = await embed(question);
  } catch {
    // Model unavailable (not cached / runtime failure) → lexical floor.
    return lexical.slice(0, k);
  }

  const embedCos = new Map<string, number>();
  for (const [tool, vec] of index.vectors) {
    if (EXCLUDED_FROM_CANDIDATES.has(tool)) continue;
    const n = Math.min(vec.length, queryVec.length);
    let dot = 0;
    for (let i = 0; i < n; i += 1) dot += (vec[i] ?? 0) * (queryVec[i] ?? 0);
    embedCos.set(tool, dot);
  }

  const lexScores = new Map<string, number>(lexical.map((c) => [c.tool, c.score]));
  let fused: Map<string, number>;
  if (fusion === 'max') {
    fused = fuseScoresMax(lexScores, embedCos, embedWeight());
  } else {
    const embedRanked = [...embedCos.entries()]
      .filter(([, c]) => c > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tool]) => tool);
    fused = fuseScoresRrf(
      lexical.map((c) => c.tool),
      embedRanked,
    );
  }

  const lexByTool = new Map(lexical.map((c) => [c.tool, c]));
  const funnelIndex = getFunnelIndex();
  const confidence = lexical[0]?.confidence ?? 'low';
  // `max` scores share the lexical 3-dp scale; RRF scores are ~1/60-sized, so
  // they keep 5 dp to stay distinguishable.
  const dp = fusion === 'max' ? 1000 : 100_000;

  const rows: ToolCandidate[] = [];
  for (const [tool, score] of fused) {
    const rounded = Math.round(score * dp) / dp;
    const embedCosine = Math.round((embedCos.get(tool) ?? 0) * 1000) / 1000;
    const prior = lexByTool.get(tool);
    if (prior !== undefined) {
      rows.push({ ...prior, score: rounded, confidence, embedCosine });
      continue;
    }
    const planeEntry = resolveCandidatePlane(tool);
    rows.push({
      tool,
      score: rounded,
      cosine: 0, // zero LEXICAL semantic evidence — embedding-only candidate
      embedCosine,
      category: funnelIndex.toolCategory.get(tool) ?? null,
      plane: planeEntry.plane,
      liveRequired: planeEntry.liveRequired,
      confidence,
    });
  }
  rows.sort((a, b) => b.score - a.score || a.tool.localeCompare(b.tool));
  return rows.slice(0, k);
};
