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
// TYPE-ONLY import: erased at runtime, so it introduces NO runtime import cycle
// even though intent-router.ts and this module both read the tool roster. (And
// intent-router.ts does not import this funnel, so no cycle exists in either
// direction — verified at build time by the I1 contract test + tsc.)
import type { Plane } from './intent-router.js';
import { CATEGORIES } from './tools/capabilities.js';
import { V01_TOOLS } from './tools/index.js';

/** Funnel-local confidence in the shortlist itself (I2a-calibrated band). */
export type FunnelConfidence = 'high' | 'medium' | 'low';

/** One meaning-ranked tool candidate for the host LLM to choose from. */
export interface ToolCandidate {
  /** Canonical `sfi.*` tool name. */
  readonly tool: string;
  /** Cosine similarity to the question in [0, 1] (rounded to 3 dp). */
  readonly score: number;
  /** Capability area the tool belongs to, or `null` when it is in none. */
  readonly category: string | null;
  /**
   * The intelligence plane this candidate is answered from — `vault` | `live` |
   * `hybrid` (`knowledge`/`unknown` never reach a scored row). Carried on the
   * candidate ITSELF (not just the demoted regex route) so a host LLM can read
   * the consent requirement from the shortlist alone. I1 keystone for I2/I3.
   */
  readonly plane: Plane;
  /**
   * Does answering with this tool require the opt-in live plane? `true` only
   * for `live`-plane tools (their answer needs a live read). `hybrid` tools
   * answer from the vault with live as optional enrichment (the live part is a
   * separate `live` candidate), so they are `false`; vault tools are `false`.
   */
  readonly liveRequired: boolean;
  /**
   * Calibrated confidence in the SHORTLIST (margin + coverage led, not raw
   * score — vault/gap top-score distributions overlap). I2a tuned the band
   * against the corpus-gen distributions so gap shortlists read `low` ~2× as
   * often as vault shortlists, without truncating either.
   */
  readonly confidence: FunnelConfidence;
  /** Heuristic args when the regex route bound this tool (hybrid mode hint). */
  readonly suggestedArgs?: Readonly<Record<string, unknown>>;
  /** True when this row was promoted from the deterministic regex route hint. */
  readonly fromRoute?: boolean;
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
  count: ['many', 'number', 'inventory', 'components', 'list'],
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
    'custom fields how many fields on object contact account lead opportunity case ' +
    'metadata count layouts list views triggers validation rules record types web links ' +
    'flows classes triggers profiles permission sets layouts record types validation rules ' +
    'approval processes reports dashboards omniscripts custom standard relationship child ' +
    'parent inactive active picklist values ' +
    'which flows are inactive active draft obsolete flows triggers rules by status enumerate components',
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

/**
 * Tools whose plane is NOT derivable from the `live_` name prefix, classified
 * explicitly. The values are baked from intent-router.ts's RULES (the
 * authoritative plane source) but COPIED here as a literal so the funnel stays
 * cycle-free — it does NOT import the 188 RULES. A contract test
 * (`test/tool-plane-coverage.test.ts`) guards live coverage.
 *
 * Derivation (audited against the compiled RULES on 2026-06-30):
 *  - `blast_radius_live` is NOT routed by any rule, but it issues a live COUNT
 *    (its live magnitude is an opt-in enrichment over the static impact graph),
 *    so it is the documented non-`live_`-prefixed LIVE tool. Spec-mandated.
 *  - `fleet_drift_ranking` — every rule routes it `plane: 'live', liveRequired:
 *    true`. Genuinely live.
 *  - `field_cleanup_candidates`, `unused_fields_deep` — routed ONLY as
 *    `plane: 'hybrid'` (no vault rule); they fuse vault candidates with live
 *    field-population. Classified `hybrid`.
 *
 * DELIBERATELY OMITTED (kept at the `vault` DEFAULT despite appearing in a
 * minority of hybrid rules): `resolve`, `list_components`, `integration_map`.
 * Each is routed `vault`/`liveRequired:false` by the overwhelming majority of
 * its rules (resolve: ~80 vault vs 2 hybrid; list_components: ~22 vs 2;
 * integration_map: 3 vs 1) and answers fully from the vault — live is an
 * OPTIONAL enrichment, never a requirement. Marking them `hybrid`/liveRequired
 * would be a consent FALSE-POSITIVE (telling a host it must grant the live
 * plane to enumerate components or resolve a name), which directly undermines
 * the I3 honesty/consent goal this keystone exists to enable.
 */
const PLANE_OVERRIDES: Readonly<Record<string, Exclude<Plane, 'unknown' | 'knowledge'>>> = {
  'sfi.blast_radius_live': 'live',
  'sfi.fleet_drift_ranking': 'live',
  'sfi.field_cleanup_candidates': 'hybrid',
  'sfi.unused_fields_deep': 'hybrid',
};

/** Plane resolution for one tool name: name prefix, then override, then vault. */
const planeForTool = (toolName: string): Exclude<Plane, 'unknown' | 'knowledge'> => {
  if (/^sfi\.live_/.test(toolName)) return 'live';
  return PLANE_OVERRIDES[toolName] ?? 'vault';
};

/**
 * I2a — meta/orchestration tools that are NEVER the answer to a user's org
 * question, excluded from the ANSWER-candidate shortlist (`semanticCandidates`).
 *
 * `route_question`, `synthesize_answer`, `run_analysis`, `list_analyses`, and
 * `describe_analysis` are the funnel's own plumbing (route, ground, list/run a
 * saved analysis). A host LLM already IS the router and grounding layer, so
 * surfacing these as "tools to answer the question with" is noise that crowds a
 * real answer tool out of the top-K. They are still INDEXED and SCORED (so the
 * IDF corpus is unchanged — no ranking shift for the real tools); they are only
 * dropped from the returned candidate list.
 *
 * KEPT on purpose: `resolve` (the canonical first-move name lookup),
 * `guidance`, and `capabilities` (real knowledge answers — "what can you do",
 * "how do I…"). None of these five appears as an `expectedTool` / `anyOf`
 * family in the QA gold (router-goldset, router-recall, funnel-generalization),
 * verified before exclusion, so recall is unaffected.
 */
const EXCLUDED_FROM_CANDIDATES: ReadonlySet<string> = new Set([
  'sfi.route_question',
  'sfi.synthesize_answer',
  'sfi.run_analysis',
  'sfi.list_analyses',
  'sfi.describe_analysis',
]);

/**
 * Only a `live`-plane tool needs the opt-in live read to answer at all. A
 * `hybrid` tool answers from the vault and treats live as OPTIONAL enrichment
 * (its live magnitude rides on a separate `live` companion candidate), so it
 * does NOT require consent — marking it liveRequired would be a consent
 * false-positive that undermines the honesty this keystone enables. A vault
 * tool never blocks on consent.
 */
const liveRequiredForPlane = (plane: Plane): boolean => plane === 'live';

interface PlaneEntry {
  readonly plane: Exclude<Plane, 'unknown' | 'knowledge'>;
  readonly liveRequired: boolean;
}

/**
 * Build-once `sfi.*` tool name → { plane, liveRequired } over the WHOLE V01
 * roster, so every candidate (and every route-inserted candidate) can stamp its
 * consent requirement from the candidate alone. Keyed by full `sfi.*` name.
 */
const buildPlaneByTool = (): ReadonlyMap<string, PlaneEntry> => {
  const map = new Map<string, PlaneEntry>();
  for (const tool of V01_TOOLS) {
    const plane = planeForTool(tool.name);
    map.set(tool.name, { plane, liveRequired: liveRequiredForPlane(plane) });
  }
  return map;
};

let cachedPlanes: ReadonlyMap<string, PlaneEntry> | null = null;

/** Memoized plane/liveRequired lookup keyed by full `sfi.*` tool name. */
export const getPlaneByTool = (): ReadonlyMap<string, PlaneEntry> =>
  (cachedPlanes ??= buildPlaneByTool());

/**
 * Plane + liveRequired for ONE tool name, defaulting to the `vault` plane for
 * any name not in the roster (e.g. a route hint for a tool absent from V01).
 */
export const resolveCandidatePlane = (toolName: string): PlaneEntry => {
  const entry = getPlaneByTool().get(toolName);
  if (entry !== undefined) return entry;
  const plane = planeForTool(toolName);
  return { plane, liveRequired: liveRequiredForPlane(plane) };
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
 * I2a — funnel-confidence thresholds, CALIBRATED against the real corpus-gen
 * distributions (QA scripts/corpus-gen.mjs, --seed 1/2 --per 4). Per the Phase-0
 * finding, absolute top-score alone is a BLUNT signal — the vault-positive and
 * gap (nothing-answers-it) top-score distributions OVERLAP:
 *
 *            top1 med   margin med   coverage med
 *   vault      0.24        0.046         0.83
 *   live       0.19        0.035         0.85
 *   gap        0.17        0.031         0.75
 *
 * So an absolute score floor would either pass the gaps or kill real low-scoring
 * vault hits (BA recall is the weakest at ~68%). Confidence therefore leans on
 * the top1−top2 MARGIN (how decisively ONE tool leads) and query-term COVERAGE
 * (the fraction of the user's own non-stopword tokens the corpus understood),
 * with top1 only as a strength rescue. The result: gap shortlists read `low`
 * roughly twice as often as vault shortlists do, WITHOUT truncating either.
 */
// `high`: one tool leads decisively AND the corpus understood most of the query.
const CONF_HIGH_TOP1 = 0.27;
const CONF_HIGH_MARGIN = 0.05;
const CONF_HIGH_COVERAGE = 0.8;
// Conservative absolute gap FLOOR — set BELOW the gap median (0.17) so it only
// catches the CLEAREST non-matches; it does NOT truncate, it forces `low`.
const CONF_FLOOR_TOP1 = 0.09;
// Near-zero coverage: most of the user's words were unknown to the corpus.
const CONF_MIN_COVERAGE = 0.34;
// `low` band: a thin top1−top2 lead (the #1 tool barely beats #2) UNLESS rescued
// by a strong absolute lead or strong coverage; or sub-vault-median coverage.
const CONF_LOW_MARGIN = 0.045;
const CONF_RESCUE_TOP1 = 0.26;
const CONF_RESCUE_COVERAGE = 0.84;
const CONF_LOW_COVERAGE = 0.72;

/**
 * Deterministic, calibrated confidence from the ranked head + query coverage.
 *
 * GAP-HONESTY, NOT TRUNCATION: when the clearest gap signals fire (top1 below the
 * conservative floor OR almost no query tokens understood), we force `low` and
 * STILL return the candidates. The honest gap signal is `confidence: low` — I3
 * turns that into a user-facing disclosure. We never return [] / truncate here
 * because the vault/gap overlap means truncation would silently drop real
 * low-scoring vault hits (esp. BA), trading a false-confidence problem for a
 * false-negative one.
 */
const funnelConfidence = (top1: number, top2: number, coverage: number): FunnelConfidence => {
  const margin = top1 - top2;
  // Conservative gap floor + near-zero coverage → the clearest non-matches.
  if (top1 < CONF_FLOOR_TOP1 || coverage < CONF_MIN_COVERAGE) return 'low';
  if (top1 >= CONF_HIGH_TOP1 && margin >= CONF_HIGH_MARGIN && coverage >= CONF_HIGH_COVERAGE) {
    return 'high';
  }
  // A weak lead (top1 barely beats top2) reads `low` unless a strong absolute
  // lead or strong coverage rescues it — that is the margin-led gap signal.
  const weakLead =
    margin < CONF_LOW_MARGIN && top1 < CONF_RESCUE_TOP1 && coverage < CONF_RESCUE_COVERAGE;
  if (weakLead || coverage < CONF_LOW_COVERAGE) return 'low';
  return 'medium';
};

/**
 * Rank tools by meaning against `question`, returning the top `k` candidates
 * (cosine > 0), highest score first. Empty when the question has no indexable
 * terms. This is the funnel: the host LLM picks from what this surfaces.
 */
export const semanticCandidates = (question: string, k = 8): ToolCandidate[] => {
  const idx = getFunnelIndex();
  const planes = getPlaneByTool();
  // The RAW (pre-synonym-expansion) non-stopword query tokens — the user's own
  // words. COVERAGE is the fraction of these distinct tokens the corpus knows
  // (appears in ≥1 doc, i.e. has an IDF entry). Computed on the raw query, NOT
  // the synonym-expanded set, so confidence reflects how much of what the user
  // actually typed was understood — not how many synonyms we bolted on.
  const rawQueryTokens = new Set(tokenize(question, true));
  // Expand multi-word phrases on the QUERY only — the doc corpus (buildIndex)
  // is tokenized verbatim so the corpus IDF stays intact (F1 regression fix).
  const qTokens = expand(tokenize(question, true));
  if (qTokens.length === 0) return [];

  let coverage = 0;
  if (rawQueryTokens.size > 0) {
    let hits = 0;
    for (const t of rawQueryTokens) if (idx.idf.has(t)) hits += 1;
    coverage = hits / rawQueryTokens.size;
  }

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

  // Score rows WITHOUT confidence first — confidence needs the ranked head
  // (top1 / top2), known only after the sort below.
  type ScoredRow = Omit<ToolCandidate, 'confidence'>;
  const scored: ScoredRow[] = [];
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
    const planeEntry = planes.get(tool) ?? { plane: 'vault' as const, liveRequired: false };
    scored.push({
      tool,
      score: Math.round(score * 1000) / 1000,
      category: idx.toolCategory.get(tool) ?? null,
      plane: planeEntry.plane,
      liveRequired: planeEntry.liveRequired,
    });
  }
  scored.sort((a, b) => b.score - a.score || a.tool.localeCompare(b.tool));

  // I2a — DROP meta/orchestration tools from the ANSWER-candidate set. They were
  // fully indexed + scored above (so the IDF corpus and the cosine ranking of the
  // real tools are unchanged — no top-1 shift), but they are never the answer to
  // a user's org question, so they are filtered out here to free top-K slots for
  // real tools. top1/top2 and the returned shortlist all come from the filtered
  // ranking, so confidence reflects the actual candidate set the host LLM reads.
  const candidates = scored.filter((row) => !EXCLUDED_FROM_CANDIDATES.has(row.tool));

  // One confidence for the shortlist, derived from the ranked head + coverage,
  // then stamped on every returned candidate (I2 may make this per-row).
  const top1 = candidates[0]?.score ?? 0;
  const top2 = candidates[1]?.score ?? 0;
  const confidence = funnelConfidence(top1, top2, coverage);
  return candidates.slice(0, k).map((row) => ({ ...row, confidence }));
};
