/**
 * Offline semantic FUNNEL for the question router (CAE-01).
 *
 * The regex router decides nothing here: this module turns "170 tools" into a
 * meaning-ranked SHORTLIST of ~8 candidate tools for a natural-language question,
 * which the host LLM (already in the loop, free) then reads and chooses from. It
 * is an ADVISOR, not a decider — its job is to surface the right tools to read,
 * not to pick the final one.
 *
 * The index is a classic TF-IDF vector model over a per-tool document corpus
 * (each tool's MCP description + the example questions of the capability
 * categories it belongs to), cosine-ranked at query time. No neural embedding
 * model is bundled — it is fully offline, deterministic, and adds zero package
 * weight, which is the whole point versus a hosted competitor. A small,
 * high-precision synonym layer bridges the Salesforce vocabulary gap (e.g.
 * "access" ↔ permission / sharing / visibility) so a question phrased in
 * business terms still lands on the right tools.
 *
 * Pure + lazily memoized: the index is built once on first query (which also
 * sidesteps any import-cycle init order — `V01_TOOLS` is only read at call time).
 */
import { CATEGORIES } from './tools/capabilities.js';
import { V01_TOOLS } from './tools/index.js';

/** One meaning-ranked tool candidate for the host LLM to choose from. */
export interface ToolCandidate {
  /** Canonical `sfi.*` tool name. */
  readonly tool: string;
  /** Cosine similarity to the question in [0, 1] (rounded to 3 dp). */
  readonly score: number;
  /** Capability area the tool belongs to, or `null` when it is in none. */
  readonly category: string | null;
}

/**
 * Filler words that carry no routing signal. Mirrors the router's own scaffold
 * words plus generic English stopwords; kept small so domain terms survive.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are',
  'do', 'does', 'did', 'what', 'which', 'show', 'me', 'my', 'this', 'that',
  'these', 'those', 'how', 'where', 'when', 'who', 'whom', 'can', 'could', 'i',
  'it', 'its', 'have', 'has', 'had', 'with', 'from', 'get', 'give', 'list',
  'tell', 'about', 'all', 'any', 'our', 'we', 'us', 'you', 'your', 'be', 'been',
  'there', 'here', 'into', 'at', 'by', 'as', 'so', 'if', 'then', 'will',
]);

/**
 * High-precision Salesforce-domain synonym expansion. Each query token also
 * contributes its related terms so a business-language question reaches tools
 * whose descriptions use the technical vocabulary. Kept deliberately small and
 * one-directional-per-entry to avoid washing out the signal.
 */
const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  access: ['permission', 'permissions', 'sharing', 'visibility', 'visible', 'see', 'view', 'grant'],
  permission: ['access', 'grant', 'profile', 'permissionset'],
  see: ['access', 'visibility', 'visible', 'sharing'],
  edit: ['modify', 'write', 'update', 'change', 'editable'],
  modify: ['edit', 'write', 'change'],
  delete: ['remove', 'deletion', 'deletable'],
  remove: ['delete', 'deletion'],
  user: ['profile', 'permissionset', 'member', 'people'],
  field: ['column', 'attribute'],
  object: ['sobject', 'table', 'entity'],
  break: ['impact', 'depend', 'dependency', 'breaks', 'affected'],
  run: ['execute', 'fire', 'trigger', 'runs', 'execution'],
  doc: ['document', 'documentation', 'handbook', 'overview'],
  pii: ['sensitive', 'personal', 'compliance', 'privacy'],
  stale: ['fresh', 'freshness', 'outdated', 'current'],
  count: ['how', 'many', 'number'],
};

/** Lowercase, fold apostrophes, split on non-word chars, drop stopwords + 1-char tokens. */
export const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[‘’ʼ']/g, "'")
    .replace(/[^a-z0-9_]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));

/** Append synonym terms for each token, preserving the originals. */
const expand = (tokens: readonly string[]): string[] => {
  const out: string[] = [...tokens];
  for (const t of tokens) {
    const syn = SYNONYMS[t];
    if (syn !== undefined) out.push(...syn);
  }
  return out;
};

/**
 * Build the per-tool document corpus: every tool's MCP description, augmented
 * with the title / description / example questions of each capability category
 * that lists the tool. Tools in no category fall back to their description only.
 */
const buildToolDocs = (): Map<string, string> => {
  const docs = new Map<string, string>();
  for (const tool of V01_TOOLS) docs.set(tool.name, tool.description);
  for (const cat of CATEGORIES) {
    const catText = ` ${cat.title} ${cat.description} ${cat.exampleQuestions.join(' ')}`;
    for (const toolName of cat.tools) {
      const prev = docs.get(toolName);
      // Only augment tools that are real registered tools (skip stale category refs).
      if (prev !== undefined) docs.set(toolName, prev + catText);
    }
  }
  return docs;
};

interface FunnelIndex {
  /** tool name → L2-normalized TF-IDF vector (term → weight). */
  readonly vectors: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** term → inverse document frequency. */
  readonly idf: ReadonlyMap<string, number>;
  /** tool name → first capability category id that lists it. */
  readonly toolCategory: ReadonlyMap<string, string>;
}

let cached: FunnelIndex | null = null;

const buildIndex = (): FunnelIndex => {
  const docs = buildToolDocs();
  const toolCategory = new Map<string, string>();
  for (const cat of CATEGORIES) {
    for (const tool of cat.tools) if (!toolCategory.has(tool)) toolCategory.set(tool, cat.id);
  }

  const docTokens = new Map<string, string[]>();
  const df = new Map<string, number>();
  for (const [tool, doc] of docs) {
    const toks = tokenize(doc);
    docTokens.set(tool, toks);
    for (const term of new Set(toks)) df.set(term, (df.get(term) ?? 0) + 1);
  }

  const n = docs.size;
  const idf = new Map<string, number>();
  for (const [term, d] of df) idf.set(term, Math.log((n + 1) / (d + 1)) + 1);

  const vectors = new Map<string, Map<string, number>>();
  for (const [tool, toks] of docTokens) {
    if (toks.length === 0) {
      vectors.set(tool, new Map());
      continue;
    }
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    const vec = new Map<string, number>();
    let norm = 0;
    for (const [term, f] of tf) {
      const w = (f / toks.length) * (idf.get(term) ?? 0);
      vec.set(term, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [term, w] of vec) vec.set(term, w / norm);
    vectors.set(tool, vec);
  }

  return { vectors, idf, toolCategory };
};

/** Build-once, memoized. Exposed for tests that need a clean rebuild. */
export const getFunnelIndex = (): FunnelIndex => (cached ??= buildIndex());

/** Drop the memoized index — test-only. */
export const resetFunnelIndex = (): void => {
  cached = null;
};

/**
 * Rank tools by meaning against `question`, returning the top `k` candidates
 * (cosine > 0), highest score first. Empty when the question has no indexable
 * terms. This is the funnel: the host LLM picks from what this surfaces.
 */
export const semanticCandidates = (question: string, k = 8): ToolCandidate[] => {
  const idx = getFunnelIndex();
  const qTokens = expand(tokenize(question));
  if (qTokens.length === 0) return [];

  const qtf = new Map<string, number>();
  for (const t of qTokens) qtf.set(t, (qtf.get(t) ?? 0) + 1);
  const qvec = new Map<string, number>();
  let qnorm = 0;
  for (const [term, f] of qtf) {
    const w = (f / qTokens.length) * (idx.idf.get(term) ?? 0);
    if (w > 0) {
      qvec.set(term, w);
      qnorm += w * w;
    }
  }
  qnorm = Math.sqrt(qnorm) || 1;
  if (qvec.size === 0) return [];

  const scored: ToolCandidate[] = [];
  for (const [tool, vec] of idx.vectors) {
    let dot = 0;
    // Iterate the smaller map for the sparse dot product.
    const [small, large] = qvec.size <= vec.size ? [qvec, vec] : [vec, qvec];
    for (const [term, w] of small) {
      const o = large.get(term);
      if (o !== undefined) dot += w * o;
    }
    if (dot <= 0) continue;
    const score = dot / qnorm; // doc vectors are unit-normalized → cosine
    scored.push({
      tool,
      score: Math.round(score * 1000) / 1000,
      category: idx.toolCategory.get(tool) ?? null,
    });
  }
  scored.sort((a, b) => b.score - a.score || a.tool.localeCompare(b.tool));
  return scored.slice(0, k);
};
