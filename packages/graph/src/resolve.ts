/**
 * Deterministic component resolver — the typo-tolerant front door.
 *
 * Turns a messy human query (`wher is the emale field`) into a ranked,
 * evidence-bearing list of candidate canonical ids. It NEVER silently picks:
 * it returns candidates + a `disposition` so the caller (Claude, the user, or
 * a tool) decides. Resolution is always `heuristic` confidence.
 *
 * Pipeline:
 *   1. Tokenize the query (drop stop-words + filler).
 *   2. Load candidate nodes (api_name + label only — never properties_json,
 *      which was the source of Profile-at-1.0 noise) + inbound-reference counts.
 *   3. Score: per query token, best match over a node's tokens, where
 *      exact (1.0) > substring (0.92) > jaroWinkler(value). Base = mean of
 *      best-per-query-token.
 *   4. Rank: a two-tier sort — confident matches (base ≥ EXACT_THRESHOLD)
 *      always rank above weaker fuzzy matches, so a popular fuzzy match can't
 *      overtake an exact one; WITHIN a tier, base × typeWeight × (1 +
 *      POP_K·log10(1+inboundRefs)) breaks ties (`ACME_Transaction__c` over a
 *      "Transaction Layout").
 *   5. Disposition from the calibrated thresholds below.
 *
 * Today this scans all candidate nodes per call (acceptable: ≤ a few thousand
 * nodes, sub-100ms). SCALE work (persisted token index) makes it index-backed.
 */

import type {
  ComponentId,
  ComponentType,
  Result,
} from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';

import {
  gatherCandidates,
  getResolveIndex,
  type IndexedNode,
  type ResolveIndex,
} from './resolve-index.js';
import type { GraphError, GraphStore } from './store.js';
import {
  expandSynonyms,
  jaroWinkler,
  normalizeName,
  tokenizeText,
  trigramDice,
} from './tokenize.js';

/** How a candidate matched: did typo-correction have to happen? */
export type MatchKind = 'exact' | 'substring' | 'fuzzy';

/**
 * The resolver's verdict:
 *   - `exact`     — one confident winner; safe to proceed.
 *   - `ambiguous` — several plausible candidates (or only fuzzy ones). Ask /
 *                   surface; do not auto-pick.
 *   - `none`      — nothing matched confidently. Honest "not found"; the
 *                   `candidates` list may still hold weak near-misses for a
 *                   "did you mean …?" prompt, or be empty.
 */
export type ResolveDisposition = 'exact' | 'ambiguous' | 'none';

/** One ranked candidate with the evidence for why it matched. */
export interface ResolveCandidate {
  readonly id: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  readonly label: string | null;
  /**
   * API name of this component's parent (e.g. the object a field/layout lives
   * on), or null for top-level components. The qualifier that distinguishes
   * same-named candidates ("Email__c on Account" vs "Email__c on Contact")
   * without the caller having to parse the canonical id.
   */
  readonly parentApiName: string | null;
  /** Final ranked score (base × typeWeight × popularity). */
  readonly score: number;
  /** Pre-weight token-overlap score in [0,1]. The confidence signal. */
  readonly base: number;
  readonly matchKind: MatchKind;
  /** Human-readable explanation, e.g. `fuzzy match on "paymnet"≈"payment"`. */
  readonly evidence: string;
}

export interface ResolveResult {
  readonly disposition: ResolveDisposition;
  readonly candidates: readonly ResolveCandidate[];
  readonly queryTokens: readonly string[];
}

export interface ResolveOptions {
  /** Max candidates returned. Default 10, hard cap 50. */
  readonly limit?: number;
  /** Restrict to these component types. */
  readonly types?: readonly ComponentType[];
  /** Restrict to children of this component (e.g. fields of one object). */
  readonly parentId?: ComponentId;
  /** Override the base-score floor below which a node is discarded. */
  readonly minScore?: number;
  /**
   * DuckDB graph path — when set, {@link getResolveIndex} loads
   * `{graphDir}/resolve-index.json` before building in memory.
   */
  readonly graphDbPath?: string;
}

// --- calibrated constants (tuned against probe data) ---
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
/** Below this base score a node is noise and dropped entirely. */
const MIN_BASE = 0.5;
/**
 * A query token whose best match against a node scores below this is treated
 * as noise (an unrelated word or a typo'd filler like "wher") and excluded
 * from that node's mean — so one strong term ("emale") isn't dragged down to
 * 'none' by a stray token. A node with zero tokens at/above this floor does
 * not match at all.
 */
const MATCHED_FLOOR = 0.6;
/**
 * Below this top base, nothing matched confidently → disposition `none`
 * (offer refresh/stop, don't present a confident clarifying question). Set
 * above the band where Jaro-Winkler's prefix bonus invents weak matches
 * (e.g. "nothing"≈"note" ≈0.81): real typos score >0.9 and synonym hits sit
 * at 0.90, so only genuine matches clear this bar.
 */
const NONE_THRESHOLD = 0.85;
/** At/above this top base with a single clear winner → disposition exact. */
const EXACT_THRESHOLD = 0.92;
/**
 * Fraction of a candidate's OWN name tokens the matched query tokens must cover
 * before a single winner is reported `exact`. Without it, one query token
 * landing inside a long multi-token name scored base 1.0 and was wrongly called
 * `exact` — e.g. query "opportunity" hitting the lone `opportunity` token of
 * `Sales_SPA_Opportunity_Stage_Task_Detail__mdt` (1 of 6 tokens). Requiring the
 * match to account for at least half the name keeps genuine single-target hits
 * exact (a typo'd whole name like `paymnet`→`Payment`, or a single namespace
 * prefix like `ACME_Transaction`) while demoting one-token-of-many hits to
 * `ambiguous`, so the caller surfaces candidates instead of auto-picking.
 */
const EXACT_COVERAGE = 0.5;
/**
 * BL-05: for a SINGLE-token query, the candidate name must be at least this
 * fraction of the query token's length to be reported `exact` when the match is
 * not a clean exact-token hit. A real component name that is a much-shorter
 * strict prefix of the query ("opportunity" ⊂ "opportunitytrigger") leaves
 * significant query content unaccounted for — the user likely named a different
 * component ("...trigger"), so we ask rather than fake an `exact`. Typos stay
 * exact (similar length: `paymnet`→`Payment` is 7/7), as do true exact-token
 * hits (matchKind 'exact').
 */
const PREFIX_EXACT_RATIO = 0.7;
/** Candidates within this ratio of the top score count as co-contenders. */
const CONTENDER_RATIO = 0.97;
/**
 * Below this token-length ratio (shorter/longer) the fuzzy score is penalized.
 * Jaro-Winkler over-rewards a short token sharing a prefix with a long one
 * ("pay" vs "paymnet" ≈ 0.87 unpenalized) — that produced confident false
 * positives on real data, so a large length gap discounts the match.
 */
const LENGTH_RATIO_FLOOR = 0.6;
/**
 * Score for a synonym hit (query token and node token are in the same
 * org-agnostic synonym group, e.g. rep↔owner). Deliberately below
 * EXACT_THRESHOLD so a synonym resolution surfaces as a candidate to verify,
 * never a silent `exact` pick.
 */
const SYNONYM_SCORE = 0.9;
/** Popularity weight applied to log10(1 + inbound reference count). */
const POP_K = 0.08;
/**
 * Coverage exponent. A candidate's base is `meanMatchedScore × coverage^EXP`,
 * where `coverage` = (content query tokens this node matched) / (content query
 * tokens total). This rewards covering MORE of the query: for a typo'd
 * multi-token identifier like `ADA_Accmomodation`, a node matching only the
 * clean token `ADA` (mean 1.0, coverage ½) scores 0.71, while the node matching
 * BOTH tokens with one typo'd (`ADA` + `accmomodation≈accommodation`, mean ~0.96,
 * coverage 1) scores ~0.96 and correctly wins. Before coverage-weighting the
 * clean-token-only node won at base 1.0 — the dominant typo-recall miss. The
 * exponent (sqrt) keeps the penalty gentle so a genuine one-of-two match still
 * clears `minBase` and stays a candidate. A single-token query has coverage 1,
 * so concept/exact queries are unaffected. */
const COVERAGE_EXP = 0.5;
/**
 * A query token counts as a coverage ANCHOR only if it matches something in the
 * corpus at/above this (near-exact) score. This separates a real content token
 * (a genuine name or a close typo: `accmomodation`≈`accommodation` ~0.93, a
 * synonym hit at 0.90) from spurious filler that incidentally fuzzy-matches an
 * unrelated token in the 0.6–0.85 band (`wher`≈`owner` ~0.78). Only anchors form
 * the coverage denominator, so a typo'd stop word can't dilute a node that
 * matched the genuine term. When a query has NO anchors (e.g. a single
 * medium-strength typo), coverage is neutral (1) — recall is preserved. */
const STRONG_ANCHOR = 0.9;
/**
 * Per-component-type prior. Structural components a human usually means rank
 * above UI/permission chrome. Derived from the live-vault probe where a
 * "Transaction Layout" wrongly outranked the Transaction object.
 */
/** Internal/synthetic node types that must not outrank a user-facing owner. */
const INTERNAL_RESOLVE_TYPES: ReadonlySet<ComponentType> = new Set(['ConditionalContext']);

const queryNamesComponentType = (q: string): ComponentType | null => {
  const lower = q.toLowerCase();
  if (/\bflows?\b/.test(lower)) return 'Flow';
  if (/\bobjects?\b/.test(lower)) return 'CustomObject';
  if (/\bfields?\b/.test(lower)) return 'CustomField';
  if (/\b(classes?|apex)\b/.test(lower)) return 'ApexClass';
  if (/\btriggers?\b/.test(lower)) return 'ApexTrigger';
  return null;
};

const TYPE_WEIGHT: Readonly<Partial<Record<ComponentType, number>>> = {
  CustomObject: 1.0,
  CustomField: 0.95,
  ApexClass: 0.9,
  ApexTrigger: 0.9,
  Flow: 0.9,
  ValidationRule: 0.85,
  OmniScript: 0.85,
  OmniIntegrationProcedure: 0.85,
  DecisionTable: 0.8,
  OmniDataTransform: 0.7,
  OmniUiCard: 0.65,
  PermissionSet: 0.6,
  Layout: 0.55,
  Profile: 0.5,
};
const typeWeight = (t: ComponentType): number => TYPE_WEIGHT[t] ?? 0.75;

interface ScoredToken {
  readonly score: number;
  readonly kind: MatchKind;
  readonly matchedToken: string;
}

/** Best match of one query token against a node's token bag. */
const scoreToken = (qt: string, nodeTokens: readonly string[]): ScoredToken => {
  // Synonym expansion once per query token (org-agnostic groups). Lets "rep"
  // match an "owner" token and "dob" a "birthdate" token.
  const synonyms = new Set(expandSynonyms(qt));

  let best = 0;
  let kind: MatchKind = 'fuzzy';
  let matchedToken = '';
  for (const nt of nodeTokens) {
    if (nt === qt) return { score: 1, kind: 'exact', matchedToken: nt };

    const lenRatio =
      Math.min(qt.length, nt.length) / Math.max(qt.length, nt.length);

    // Fuzzy (Jaro-Winkler), discounted when token lengths differ sharply so a
    // short token can't ride the prefix bonus into a high score against a much
    // longer one ("pay" vs "paymnet").
    let fuzzy = jaroWinkler(qt, nt);
    if (lenRatio < LENGTH_RATIO_FLOOR) {
      fuzzy *= lenRatio + (1 - LENGTH_RATIO_FLOOR);
    }

    // Trigram (Dice) — recall for stem/reorder variants; length-aware by
    // construction so it doesn't over-reward short-vs-long pairs.
    const tri = trigramDice(qt, nt);

    // Synonym — a curated semantic bridge no string metric can cross.
    const syn = synonyms.has(nt) ? SYNONYM_SCORE : 0;

    // Containment: a true prefix/substring, scored by how much it covers
    // (length ratio) — never a flat value, so "pay" ⊂ "paymnet" ≈ 0.43.
    let contain = 0;
    if (
      qt.length >= 3 &&
      nt.length >= 3 &&
      (nt.includes(qt) || qt.includes(nt))
    ) {
      contain = lenRatio;
    }

    const nonContain = Math.max(fuzzy, tri, syn);
    const s = Math.max(nonContain, contain);
    const k: MatchKind = contain > nonContain ? 'substring' : 'fuzzy';
    if (s > best) {
      best = s;
      kind = k;
      matchedToken = nt;
    }
  }
  return { score: best, kind, matchedToken };
};

/** A scored query token, carrying the source query token for evidence. */
interface MatchedToken extends ScoredToken {
  readonly qt: string;
}

/** Weakest tier across the matched tokens becomes the candidate's kind. */
const rollupKind = (matched: readonly ScoredToken[]): MatchKind => {
  if (matched.every((t) => t.kind === 'exact')) return 'exact';
  if (matched.every((t) => t.kind !== 'fuzzy')) return 'substring';
  return 'fuzzy';
};

const buildEvidence = (
  kind: MatchKind,
  matched: readonly MatchedToken[],
): string => {
  const parts = matched.map((m) =>
    m.kind === 'exact' ? `"${m.qt}"` : `"${m.qt}"≈"${m.matchedToken}"`,
  );
  return `${kind} match on ${parts.join(', ')}`;
};

/**
 * Resolve a messy query into ranked candidate components with a disposition.
 *
 * @example
 *   const r = await resolveComponents(store, 'wher is the emale field');
 *   if (r.ok && r.value.disposition === 'exact') use(r.value.candidates[0].id);
 */
export const resolveComponents = async (
  store: GraphStore,
  query: string,
  options?: ResolveOptions,
): Promise<Result<ResolveResult, GraphError>> => {
  const limit = Math.min(options?.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const minBase = options?.minScore ?? MIN_BASE;
  // Expand multi-word business phrases ("social security number" -> `ssn`) on
  // the QUERY only — the corpus (node.parentApiName below) stays verbatim.
  const queryTokens = tokenizeText(query, { expandPhrases: true });
  // Whole-query comparison key for the exact/prefix boost (see the per-node loop).
  const normQuery = normalizeName(query);
  // Space-delimited words of the raw query, each normalized. Used to detect
  // when the query names an OBJECT as its own word (see `namedObjectWords`
  // once the index loads): "Contact Email" names the object Contact, so a field
  // literally named "Contact_Email__c" on a DIFFERENT object (Account) must NOT
  // claim a whole-name-exact match. The SPACE is the discriminator normalizeName
  // erases — a single-token query of the literal field name ("Contact_Email__c")
  // names no object and stays a whole-name-exact match.
  const querySpaceWords = new Set(
    query
      .trim()
      .split(/\s+/)
      .map(normalizeName)
      .filter((w) => w.length > 0),
  );

  // An empty token list (all stop words — e.g. a component literally named
  // "IT", where "it" is a stop word) is deliberately NOT short-circuited here:
  // the whole-name exact pass below still recovers a node whose normalized name
  // equals the normalized query, so stop-word-named components stay findable.
  // (A truly empty/short query simply matches nothing and falls through to
  // disposition `none`.)

  // Candidate prefilter — gather only the nodes that COULD match (sharing a
  // token, char bigram, synonym, or the whole normalized name) and score those,
  // instead of every node in the graph. Recall-safe: the union is a superset of
  // everything the full scan could score above the floor (see resolve-index.ts).
  let index: ResolveIndex;
  try {
    index = await getResolveIndex(
      store,
      options?.graphDbPath !== undefined ? { graphDbPath: options.graphDbPath } : undefined,
    );
  } catch (e) {
    return err({
      kind: 'query-failed',
      message: `resolveComponents: ${(e as Error).message}`,
    });
  }
  const candidateIdx = gatherCandidates(index, queryTokens, normQuery);

  // Normalized names of every object in the vault, and the subset of the query's
  // space-words that name one. When the query names an object as its own word, a
  // whole-name-exact match on a FIELD parented to a DIFFERENT object is a
  // coincidental collision (normalizeName erased the space), not the user's
  // intent — those are denied the exact boost below so the field on the named
  // object can win. Empty for a single-token query (no separate object word),
  // which keeps a literal field-name query exact.
  const objectNormNames = new Set<string>();
  for (const n of index.nodes) {
    if (n.type === 'CustomObject') objectNormNames.add(n.normName);
  }
  const namedObjectWords = new Set(
    [...querySpaceWords].filter((w) => objectNormNames.has(w)),
  );

  // Optional type / parent scoping, applied to the (small) candidate set.
  const typeFilter =
    options?.types !== undefined && options.types.length > 0
      ? new Set<string>(options.types as readonly string[])
      : null;
  const parentFilter = options?.parentId;

  // PASS 1 — score every candidate node per query token, and track the best
  // score per query token across the candidate set. A query token whose best
  // match is below MATCHED_FLOOR is noise/filler (a typo'd stop word like
  // "wher", or garbage) and must not count against coverage; the rest are the
  // "anchor" tokens the user actually named. (Scoring over the candidate set,
  // not the whole graph, is equivalent: a node that strongly matches a token is
  // always a candidate, so the per-token best is the same.)
  interface Pass1 {
    readonly node: IndexedNode;
    readonly perToken: readonly MatchedToken[];
    readonly wholeExact: boolean;
    /** A query token matched this candidate's PARENT object (not its own name). */
    readonly parentMatched: boolean;
  }
  const pass1: Pass1[] = [];
  const globalBest = new Array<number>(queryTokens.length).fill(0);
  for (const ci of candidateIdx) {
    const node = index.nodes[ci]!;
    if (typeFilter !== null && !typeFilter.has(node.type)) continue;
    if (parentFilter !== undefined && node.parentId !== parentFilter) continue;
    if (node.tokens.length === 0) continue;

    const perToken: MatchedToken[] = queryTokens.map((qt) => ({
      qt,
      ...scoreToken(qt, node.tokens),
    }));

    // Parent-object refinement: a query token that names this candidate's
    // PARENT object is a genuine match the field-name tokens can't see. For
    // "Email on Contact" the field-name token `email` matches `Contact.Email`
    // AND `Account.Contact_Email__c` equally, but only the former is parented
    // to Contact — so without this, the field whose NAME merely contains
    // "Contact" wins and is reported `exact` (the headline resolver bug).
    //
    // Credit is granted ONLY when the candidate is already name-relevant (>=1
    // field-name token matched) and ONLY upgrades tokens the name didn't
    // already satisfy. That asymmetry is load-bearing: a bare object name
    // ("account") matches no field's NAME, so it earns no parent credit and
    // still resolves to the OBJECT rather than flooding every field parented
    // to it.
    const nameMatchedSomething = perToken.some((t) => t.score >= MATCHED_FLOOR);
    let parentMatched = false;
    if (nameMatchedSomething && node.parentApiName) {
      const parentTokens = tokenizeText(node.parentApiName);
      if (parentTokens.length > 0) {
        for (let i = 0; i < perToken.length; i += 1) {
          if (perToken[i]!.score >= MATCHED_FLOOR) continue; // name already covered it
          const pm = scoreToken(queryTokens[i]!, parentTokens);
          if (pm.score > perToken[i]!.score) {
            // kind 'substring' (never 'exact'): a parent hit is contextual,
            // not a literal name match, so it can't make the candidate's
            // rolled-up kind `exact`.
            perToken[i] = {
              qt: queryTokens[i]!,
              score: pm.score,
              kind: 'substring',
              matchedToken: pm.matchedToken,
            };
            if (pm.score >= MATCHED_FLOOR) parentMatched = true;
          }
        }
      }
    }

    for (let i = 0; i < perToken.length; i += 1) {
      if (perToken[i]!.score > globalBest[i]!) globalBest[i] = perToken[i]!.score;
    }

    // Whole-string EXACT match — robust to tokenizer chunking. When the whole
    // normalized query equals the whole normalized API name, this is a
    // definitive hit that must surface even if per-token averaging would dilute
    // it or a popular fuzzy neighbour would bury it (regression: resolve(
    // "ZeeToDo__c") -> none; resolve("Zee_MS_Alert__c") buried below popular
    // siblings). Deliberately only whole-name equality — a prefix like
    // "opportunity" ⊂ "Opportunity_X__mdt" must stay ambiguous.
    // A DOTTED query ("Contact.Email") expresses Object.Field structure — the
    // dot is a separator, not a name character. normalizeName collapses both
    // "." and "_", so without this guard "Contact.Email" whole-name-matches a
    // field literally named "Contact_Email__c" and is reported as the confident
    // answer (the resolver bug). Requiring query and node to AGREE on dotted-ness
    // keeps an exact API-name query working (objects and fields are dotless;
    // a dotted CMDT record id still matches a dotted query) while letting the
    // dotted form fall through to the parent-aware token path.
    // A FIELD whose name only equals the query because normalizeName erased a
    // space ("Contact Email" -> "Contact_Email__c") is NOT a true exact match
    // when the query named a DIFFERENT object as its own word: the user meant
    // the field ON that object, not this same-named decoy elsewhere. Denying the
    // boost is enough — the parent-object tiebreak below then floats the field on
    // the named object above this decoy. Top-level components named exactly (a
    // trigger "ContactTrigger"), and fields ON the named object, keep the boost.
    const crossObjectFieldDecoy =
      node.type === 'CustomField' &&
      namedObjectWords.size > 0 &&
      (node.parentApiName === null ||
        !namedObjectWords.has(normalizeName(node.parentApiName)));
    const wholeExact =
      normQuery.length >= 2 &&
      node.normName === normQuery &&
      query.includes('.') === node.apiName.includes('.') &&
      !crossObjectFieldDecoy;
    pass1.push({ node, perToken, wholeExact, parentMatched });
  }

  // Anchor query tokens: those that matched something STRONGLY (near-exact /
  // synonym) somewhere in the corpus. Their count is the coverage denominator —
  // a node is rewarded for covering MORE of them, so a clean-token-only match
  // can't outrank a fuller typo'd match — while filler that only fuzzy-grazes
  // an unrelated token (`wher`≈`owner`) is excluded and can't dilute coverage.
  const anchorIdx: number[] = [];
  for (let i = 0; i < queryTokens.length; i += 1) {
    if (globalBest[i]! >= STRONG_ANCHOR) anchorIdx.push(i);
  }
  const anchorCount = anchorIdx.length;

  const scored: ResolveCandidate[] = [];
  // How much of each candidate's own name its matched query tokens cover, by
  // id — consulted for the `exact` gate so a one-token-of-many hit can't claim
  // a confident single match.
  const coverageById = new Map<string, number>();
  // Ids whose WHOLE normalized name equals the whole normalized query. These
  // are sorted ahead of everything else so an exact API-name query always
  // returns its component first.
  const wholeExactIds = new Set<string>();
  // Ids that earned PARENT-object credit — a query token named their parent
  // object ("...on Contact"). Sorted ahead of non-parent matches WITHIN a tier
  // so "the field on the stated object" wins over a same-tier field whose name
  // merely contains the object token, regardless of which is more popular.
  const parentMatchedIds = new Set<string>();

  // PASS 2 — coverage-weighted base.
  for (const c of pass1) {
    // Per-node matched tokens (>= floor) drive match QUALITY — including a
    // weakly-but-genuinely matched non-anchor token, as before.
    const matched = c.perToken.filter((t) => t.score >= MATCHED_FLOOR);

    if (matched.length === 0 && !c.wholeExact) continue;

    const meanMatched =
      matched.length > 0
        ? matched.reduce((sum, t) => sum + t.score, 0) / matched.length
        : 0;
    // Coverage = fraction of the query's ANCHOR tokens this node matched. When
    // the query has no anchors (a lone medium typo), coverage is neutral so
    // recall is preserved; otherwise a node missing an anchor the query clearly
    // named is penalized — demoting clean-token-only hits below fuller matches.
    const matchedAnchors = anchorIdx.filter(
      (i) => c.perToken[i]!.score >= MATCHED_FLOOR,
    ).length;
    const coverage = anchorCount > 0 ? matchedAnchors / anchorCount : 1;
    let base = meanMatched * Math.pow(coverage, COVERAGE_EXP);
    if (c.wholeExact) base = 1;
    if (base < minBase) continue;

    const type = c.node.type as ComponentType;
    const refs = c.node.inbound;
    const namedType = queryNamesComponentType(query);
    let typeIntentFactor = 1;
    if (namedType !== null) {
      if (type === namedType) {
        typeIntentFactor = 1.25;
      } else if (INTERNAL_RESOLVE_TYPES.has(type)) {
        typeIntentFactor = 0.12;
      } else if (namedType === 'CustomObject' && type === 'CustomField') {
        typeIntentFactor = 0.35;
      } else if (namedType === 'Flow' && type.startsWith('Flow')) {
        typeIntentFactor = 0.35;
      } else if (type !== namedType) {
        typeIntentFactor = 0.55;
      }
    }
    const score =
      base * typeWeight(type) * typeIntentFactor * (1 + POP_K * Math.log10(1 + refs));
    const kind: MatchKind = c.wholeExact ? 'exact' : rollupKind(matched);
    // Distinct node tokens the matched query tokens actually landed on, over
    // the candidate's total token count — its name-coverage fraction. A
    // whole-name exact match covers the whole name (coverage 1). Parent-credit
    // matches land on the PARENT's tokens, not this node's, so they are
    // excluded here — coverage measures how much of the node's OWN name matched.
    const nodeTokenSet = new Set(c.node.tokens);
    const matchedNodeTokens = new Set(
      matched.map((m) => m.matchedToken).filter((t) => nodeTokenSet.has(t)),
    );
    coverageById.set(
      c.node.id,
      c.wholeExact ? 1 : matchedNodeTokens.size / c.node.tokens.length,
    );
    if (c.wholeExact) wholeExactIds.add(c.node.id);
    if (c.parentMatched) parentMatchedIds.add(c.node.id);

    scored.push({
      id: c.node.id as ComponentId,
      type,
      apiName: c.node.apiName,
      label: c.node.label,
      parentApiName: c.node.parentApiName,
      score: Number(score.toFixed(6)),
      base: Number(base.toFixed(6)),
      matchKind: kind,
      evidence: c.wholeExact
        ? `exact name match on "${query.trim()}"`
        : buildEvidence(kind, matched),
    });
  }

  // Two-tier rank: confident matches (base >= EXACT_THRESHOLD) always rank
  // above weaker fuzzy matches, so a popular fuzzy match can't overtake an
  // exact-name match — a heavily-referenced field whose name merely resembles
  // the query out-ranked the component literally named that ("prescreener").
  // Within a tier, score (typeWeight × popularity) breaks ties — preserving the
  // Transaction object over its like-named Layout, and leaving an all-confident
  // result set (e.g. several `*Log*` matches for "error log") ordered exactly as
  // the score dictates. Then id ASC for determinism.
  const namedTypeForSort = queryNamesComponentType(query);
  const typeIntentTier = (t: ComponentType): number => {
    if (namedTypeForSort === null) return 0;
    if (t === namedTypeForSort) return 0;
    if (INTERNAL_RESOLVE_TYPES.has(t)) return 2;
    return 1;
  };
  scored.sort((a, b) => {
    if (namedTypeForSort !== null) {
      const ttA = typeIntentTier(a.type);
      const ttB = typeIntentTier(b.type);
      if (ttA !== ttB) return ttA - ttB;
    }
    // Whole-name exact matches first — typing a component's exact API name
    // must return that component above any popular fuzzy neighbour. (A field
    // whose name only collides with a spaced query naming a DIFFERENT object
    // was denied this boost above, so the parent-object tiebreak below floats
    // the field on the named object over the decoy.)
    const weA = wholeExactIds.has(a.id) ? 0 : 1;
    const weB = wholeExactIds.has(b.id) ? 0 : 1;
    if (weA !== weB) return weA - weB;
    const tierA = a.base >= EXACT_THRESHOLD ? 0 : 1;
    const tierB = b.base >= EXACT_THRESHOLD ? 0 : 1;
    if (tierA !== tierB) return tierA - tierB;
    // Within a tier, a candidate whose PARENT object the query named ranks
    // first — "field on the stated object" beats a same-tier field that merely
    // contains the object token, even when the latter is more heavily
    // referenced (the resolve-first-picks-wrong-field case). Popularity only
    // breaks ties among same-parent-match-status candidates.
    const pmA = parentMatchedIds.has(a.id) ? 0 : 1;
    const pmB = parentMatchedIds.has(b.id) ? 0 : 1;
    if (pmA !== pmB) return pmA - pmB;
    if (a.score !== b.score) return b.score - a.score;
    return a.id < b.id ? -1 : 1;
  });

  const candidates = scored.slice(0, limit);
  const top = candidates[0];

  // Decide `none` on the best BASE across candidates, not the top-by-score
  // row's base. Final score folds in type-weight × popularity, which can float
  // a weak fuzzy match (e.g. a heavily-referenced CustomField whose name merely
  // resembles the query) above genuine exact-base matches. Keying `none` off
  // `candidates[0].base` then discarded those buried exact matches — e.g.
  // "prescreener" returned `none` even though several components have a
  // PreScreener token (base 1.0) that ranked below a popular fuzzy field.
  const bestBase = candidates.reduce((m, c) => (c.base > m ? c.base : m), 0);

  let disposition: ResolveDisposition;
  if (top === undefined || bestBase < NONE_THRESHOLD) {
    disposition = 'none';
  } else {
    // When the query is the LITERAL whole API name of exactly one component
    // (e.g. "Opportunity_Status__c"), that is a definitive, non-ambiguous hit —
    // the user typed the exact name. A parent-matched sibling must NOT demote it:
    // a multi-token literal name like `Opportunity_Status__c` contains the parent
    // object's own token (`opportunity`), which incidentally flags genuine
    // same-object siblings (e.g. `StageName` on Opportunity) as parent-matched and
    // inflated the contender count to `ambiguous`. The whole-name-exact match owns
    // the answer; the parent-credit contender rule only applies when the top is
    // NOT a literal whole-name match (the "Contact Email" -> like-named decoy case).
    const topIsSoleWholeExact =
      wholeExactIds.has(top.id) && wholeExactIds.size === 1;
    // A parent-matched candidate (a field ON an object the query named) is
    // always a contender: when the query names an object, the field on THAT
    // object is a legitimate interpretation even next to a like-named decoy
    // that happens to win on score or whole-name match. This keeps a query
    // like "Contact Email" `ambiguous` (surfacing both Contact.Email and
    // Account.Contact_Email__c) instead of confidently picking the decoy.
    // Skipped for a sole whole-name-exact top: that literal-name hit is
    // definitive, so a coincidental parent-token sibling can't make it ambiguous.
    const contenders = candidates.filter(
      (c) =>
        c.score >= top.score * CONTENDER_RATIO ||
        (!topIsSoleWholeExact && parentMatchedIds.has(c.id)),
    );
    const topCoverage = coverageById.get(top.id) ?? 0;
    // BL-05: a single-token query whose top match is a much-shorter strict
    // prefix (e.g. "opportunitytrigger" → "Opportunity") leaves real query
    // content uncovered — not a confident exact. Exact-token hits and same-length
    // typos are unaffected.
    const soleQueryToken =
      queryTokens.length === 1 ? queryTokens[0] : undefined;
    const topName =
      top.apiName.split('.').pop()?.replace(/__[a-z]+$/i, '') ?? '';
    const partialPrefixOnly =
      soleQueryToken !== undefined &&
      top.matchKind !== 'exact' &&
      topName.length > 0 &&
      topName.length / soleQueryToken.length < PREFIX_EXACT_RATIO;
    disposition =
      top.base >= EXACT_THRESHOLD &&
      contenders.length === 1 &&
      topCoverage >= EXACT_COVERAGE &&
      !partialPrefixOnly
        ? 'exact'
        : 'ambiguous';
  }

  return ok({ disposition, candidates, queryTokens });
};
