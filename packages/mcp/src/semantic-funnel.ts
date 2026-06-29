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
  // permissions / access / sharing
  access: ['permission', 'permissions', 'sharing', 'visibility', 'visible', 'crud', 'grant'],
  permission: ['access', 'permissions', 'grant', 'profile', 'permissionset', 'effective'],
  permissions: ['permission', 'access', 'effective', 'profile'],
  see: ['access', 'visibility', 'visible', 'sharing', 'view'],
  visible: ['access', 'visibility', 'see', 'sharing'],
  create: ['access', 'crud', 'object', 'insert'],
  read: ['access', 'crud', 'view'],
  edit: ['access', 'crud', 'modify', 'write', 'update', 'editable'],
  modify: ['edit', 'write', 'change', 'access'],
  delete: ['access', 'crud', 'remove', 'deletion', 'deletable'],
  remove: ['delete', 'deletion'],
  admin: ['permission', 'permissions', 'modify', 'view', 'risk', 'effective'],
  profile: ['permission', 'permissions', 'permissionset', 'effective'],
  // usage / dependency / impact
  references: ['usage', 'usages', 'used', 'reference', 'depends', 'uses', 'find'],
  reference: ['usage', 'usages', 'references', 'used'],
  referenced: ['usage', 'usages', 'references', 'used'],
  used: ['usage', 'usages', 'references', 'uses', 'find'],
  uses: ['usage', 'usages', 'used'],
  depends: ['dependency', 'usage', 'usages', 'impact', 'depend', 'references'],
  depend: ['dependency', 'usage', 'depends', 'impact'],
  break: ['impact', 'depend', 'dependency', 'breaks', 'affected'],
  // schema / enumeration
  objects: ['object', 'sobject', 'components', 'schema', 'list'],
  object: ['sobject', 'table', 'entity', 'components'],
  fields: ['field', 'columns', 'components', 'list'],
  list: ['components', 'enumerate', 'inventory'],
  relationship: ['lookup', 'child', 'parent', 'schema', 'related'],
  child: ['lookup', 'relationship', 'parent', 'components'],
  // counts / live records
  how: ['count', 'many', 'number'],
  many: ['count', 'number'],
  show: ['sample', 'records'],
  sample: ['records', 'show'],
  // change / audit / freshness
  changed: ['modified', 'change', 'history', 'audit'],
  change: ['modified', 'history', 'changed'],
  fresh: ['health', 'stale', 'freshness', 'vault', 'current'],
  stale: ['fresh', 'freshness', 'health', 'outdated', 'current'],
  inactive: ['active', 'disabled', 'draft', 'obsolete'],
  // meaning / docs / misc
  help: ['meaning', 'explain', 'description', 'text'],
  meaning: ['explain', 'field', 'help'],
  doc: ['document', 'documentation', 'handbook', 'overview'],
  compare: ['diff', 'difference', 'across'],
  pii: ['sensitive', 'personal', 'compliance', 'privacy'],
  run: ['execute', 'fire', 'trigger', 'runs', 'execution'],
  user: ['profile', 'permissionset', 'member'],
  field: ['column', 'attribute'],
  // Intent verbs (generalize across phrasings, unlike tool-specific keywords).
  touches: ['impact', 'depend', 'dependency', 'affected', 'usage', 'references', 'uses'],
  relies: ['depend', 'dependency', 'impact', 'usage', 'references'],
  falls: ['break', 'breaks', 'impact', 'affected'],
  dump: ['list', 'inventory', 'enumerate', 'components'],
  inventory: ['list', 'enumerate', 'components', 'all'],
  exist: ['list', 'count', 'inventory', 'many'],
  blow: ['governor', 'limit', 'risk', 'exceed'],
  populated: ['population', 'filled', 'fill', 'usage'],
  required: ['mandatory', 'needed', 'blank', 'null'],
  walk: ['explain', 'trace', 'describe', 'order', 'execution'],
};

/**
 * Ordered, high-precision PHRASE synonyms (F1) — mirrors the graph resolver's
 * `tokenize.ts` PHRASE_SYNONYMS so `route_question` collapses the same
 * multi-word business phrases the field resolver does ("social security
 * number" -> `ssn`). Longest-phrase-first; every key is multi-word and
 * unambiguous (no bare `social -> ssn`, which would collapse "social
 * media"/"social login").
 */
const PHRASE_SYNONYMS: readonly (readonly [string, string])[] = (
  [
    ['social security number', 'ssn'],
    ['social security', 'ssn'],
    ['date of birth', 'dob'],
    ['postal code', 'zip'],
    ['zip code', 'zip'],
  ] as [string, string][]
).sort((a, b) => b[0].length - a[0].length);

/** Apply the ordered phrase-synonym rewrites to a lowercased string. */
const applyPhraseSynonyms = (lower: string): string => {
  let out = lower;
  for (const [phrase, canonical] of PHRASE_SYNONYMS) {
    if (!out.includes(phrase)) continue;
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${escaped}\\b`, 'g'), canonical);
  }
  return out;
};

/**
 * Lowercase, fold apostrophes, split on non-word chars AND underscores (so
 * snake_case tool names and field api-names break into their words —
 * `object_access_audit` → object, access, audit; `Payment_Status__c` → payment,
 * status), drop stopwords + 1-char tokens.
 *
 * The phrase-synonym pass is OPT-IN (default OFF): pass `expandPhrases = true`
 * to collapse multi-word phrases ("social security number" -> `ssn`) before
 * splitting. Enabled ONLY on the QUERY (`semanticCandidates`), NEVER on the
 * doc corpus (`buildIndex`) — rewriting the corpus shifts every term's IDF and
 * tips borderline gold queries out of the top-K (the F1 router-recall
 * regression). The doc corpus is tokenized verbatim.
 */
export const tokenize = (text: string, expandPhrases = false): string[] => {
  const lowered = text.toLowerCase().replace(/[‘’ʼ']/g, "'");
  const raw = (expandPhrases ? applyPhraseSynonyms(lowered) : lowered)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  // Light plural stem (keep BOTH): apps→app, objects→object, fields→field, so a
  // plural question matches a singular tool name/description and vice-versa.
  // Applied to query and corpus alike, so the two stay consistent.
  const out: string[] = [];
  for (const t of raw) {
    out.push(t);
    if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) out.push(t.slice(0, -1));
  }
  return out;
};

/**
 * Curated per-tool keyword overlay — funnel-internal, NOT user-facing. A handful
 * of tools whose name + description do not echo the way people actually phrase the
 * question. Most important: `list_components` is THE generic "enumerate every X of
 * a type" tool, but its description shares no words with "what omniscripts do we
 * have" / "approval process steps" / "relationship between A and B", so it was
 * absent from those shortlists; the type vocabulary here puts it back IN the
 * top-K (alongside any type-specific tool) so the host LLM can choose. Bounded +
 * guarded by the recall gate; not a place to dump the whole roster.
 */
const TOOL_KEYWORDS: Readonly<Record<string, string>> = {
  'sfi.list_components':
    'list inventory enumerate catalog all what do we have how many exist objects fields ' +
    'flows classes triggers profiles permission sets layouts record types validation rules ' +
    'approval processes reports dashboards omniscripts custom standard relationship child ' +
    'parent inactive active picklist values',
  'sfi.capabilities': 'what can you do help capabilities what can i ask how do i use',
  'sfi.automation_risk_report':
    'objects more than one multiple triggers per object trigger quality automation risk',
  'sfi.live_group_count': 'how many users assigned to profile membership group count',
  'sfi.annotations': 'who owns owner steward responsible curated note',
  'sfi.last_modified': 'who changed when modified last edited touched',
  'sfi.search_flow_metadata': 'find flows matching named sync search flow by name',
  'sfi.who_can_access_object': 'who can access object which profiles can read create edit delete',
  'sfi.live_sample': 'show me sample example first few records rows give me',
  'sfi.governor_limit_risks': 'queries soql governor limit large data volume bulk dml',
  'sfi.what_if_change_method_signature': 'change method signature parameter argument breaks',
  'sfi.layout_for_user': 'which layout does the profile user see page on object',
  'sfi.integration_map': 'api limits at risk integration volume callout capacity external',
  'sfi.find_apex_usages': 'which flows invoke call use apex classes methods from',
  'sfi.live_folder_access': 'who can access report dashboard folder pipeline see view shared',
};

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
  for (const tool of V01_TOOLS) {
    // The tool NAME encodes the intent (object_access_audit, live_count,
    // find_component_usages). Weight it by repeating it, so a question whose
    // words match the name ranks the tool even when the prose description does
    // not echo them.
    const nameWords = tool.name.replace(/^sfi\./, '').replace(/_/g, ' ');
    const keywords = TOOL_KEYWORDS[tool.name] ?? '';
    docs.set(tool.name, `${nameWords} ${nameWords} ${tool.description} ${keywords}`);
  }
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
  // Expand multi-word phrases on the QUERY only — the doc corpus (buildIndex)
  // is tokenized verbatim so the corpus IDF stays intact (F1 regression fix).
  const qTokens = expand(tokenize(question, true));
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
