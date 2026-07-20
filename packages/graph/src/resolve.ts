/**
 * Deterministic component resolver — the typo-tolerant front door.
 *
 * Turns a messy human query (`wher is the emale field`) into a ranked,
 * evidence-bearing list of candidate canonical ids. It NEVER silently picks:
 * it returns candidates + a `disposition` so the caller (Claude, the user, or
 * a tool) decides. Resolution is always `heuristic` confidence.
 *
 * Pipeline:
 *   1. Tokenize the query (drop stop-words + filler; leading/trailing schema
 *      nouns like "field"/"object"/"trigger" are TYPE hints, stripped from
 *      matching and folded into the type-intent ranking instead).
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
  /**
   * Fraction of this candidate's OWN name tokens the matched query tokens
   * landed on, in [0,1]. A whole-name exact match is 1. Distinguishes a
   * genuine name hit ("Resolution_Code__c" covering `Case.Resolution_Code__c`
   * fully) from a generic-token graze ("test" covering 1 of 4 tokens of
   * `ApplicationPortalTestData`) — callers use it to keep junk ties out of
   * clarification prompts (router-v2 P4 option hygiene). Optional so
   * hand-built fixtures and older candidate shapes stay valid; absent means
   * "treat as fully covered" (callers default to 1).
   */
  readonly nameCoverage?: number;
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
  if (/\bpermission\s+sets?\b/.test(lower)) return 'PermissionSet';
  if (/\brecord\s+types?\b/.test(lower)) return 'RecordType';
  if (/\bprofiles?\b/.test(lower)) return 'Profile';
  return null;
};

/**
 * OmniStudio family vocabulary. A query word/phrase naming one of these
 * families ("omniscript", "integration procedure", "flexcard", "dataraptor")
 * is a TYPE-CONSTRAINING signal, not name content: "omniscript application"
 * means an OmniStudio component, not the `Application__c` object. When the
 * named family is UNCOVERED in the vault (0 nodes of the type), the family
 * word anchors to nothing in the corpus, drops below `STRONG_ANCHOR`, and is
 * silently excluded from the coverage denominator — letting the remaining noun
 * ("application") reach `base` 1.0 and produce a FALSE `exact` on an unrelated
 * object/field (RESOLVE-OMNISCRIPT-TOKEN-DROPPED-FALSE-EXACT). Matched on the
 * RAW query so multi-word forms ("integration procedure", "flex card") are
 * caught before tokenization splits them. Each surface form maps to the
 * ComponentType(s) it constrains.
 */
const OMNI_FAMILY_VOCAB: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly types: readonly ComponentType[];
}> = [
  { pattern: /\bomni\s?scripts?\b/, types: ['OmniScript'] },
  { pattern: /\bintegration\s+procedures?\b/, types: ['OmniIntegrationProcedure'] },
  { pattern: /\bflex\s?cards?\b/, types: ['OmniUiCard'] },
  { pattern: /\bomni\s?ui\s?cards?\b/, types: ['OmniUiCard'] },
  { pattern: /\bdata\s?raptors?\b/, types: ['OmniDataTransform'] },
  { pattern: /\bomni\s?data\s?transforms?\b/, types: ['OmniDataTransform'] },
];

/** The OmniStudio family ComponentTypes a raw query names (empty if none). */
const queryNamesOmniFamilies = (raw: string): ReadonlySet<ComponentType> => {
  const lower = raw.toLowerCase();
  const out = new Set<ComponentType>();
  for (const { pattern, types } of OMNI_FAMILY_VOCAB) {
    if (pattern.test(lower)) for (const t of types) out.add(t);
  }
  return out;
};

/**
 * Metadata TYPE-NAME vocabulary (RESOLVE-NETWORK-TOKEN-MISBINDS-CMDT). A bare
 * query word that IS the name of a component TYPE — "network" is the Experience
 * Cloud `Network` (community) type — is a TYPE signal, not schema-name content.
 * A merely SAME-NAMED schema component (a CustomMetadataType `Network_*__mdt`, a
 * field, or a layout) must not silently win a confident `exact` when real
 * components of the named type exist in the vault; the host would be routed to
 * the wrong family with no way back. Mirrors {@link OMNI_FAMILY_VOCAB}: a
 * CURATED map (not every ComponentType) covering the genuinely confusable
 * platform-type-vs-schema-name collisions, keyed on the type's own name — so it
 * is org-INDEPENDENT (no org-specific component names baked in). The guard that
 * consumes it (below) only demotes a false `exact`; it never fabricates a pick.
 */
const TYPE_NAME_VOCAB: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly types: readonly ComponentType[];
}> = [{ pattern: /\bnetworks?\b/, types: ['Network'] }];

/** The metadata-type-name ComponentTypes a raw query names (empty if none). */
const queryNamesTypeVocab = (raw: string): ReadonlySet<ComponentType> => {
  const lower = raw.toLowerCase();
  const out = new Set<ComponentType>();
  for (const { pattern, types } of TYPE_NAME_VOCAB) {
    if (pattern.test(lower)) for (const t of types) out.add(t);
  }
  return out;
};

/**
 * RESOLVE-NETWORK-TOKEN-MISBINDS-CMDT (recall half). Max named-type members to
 * surface when the query names a metadata TYPE ({@link TYPE_NAME_VOCAB}) whose
 * real components are named after their subject (e.g. an Experience Cloud
 * `Network` named after the community — no "network" token), so the token
 * prefilter never gathered them. A small cap: enough to reach the family,
 * bounded so a large type can't flood the candidate list.
 */
const TYPE_VOCAB_INJECT_CAP = 5;

/**
 * RESOLVE-STUDENT-APPLICATION-DROPS-OBJECT (rescue tiebreak). When a business
 * phrase names an object and MULTIPLE same-named objects are directly named
 * (e.g. "application" → both `Application__c` and the platform event
 * `Application_Event__e`), the object rescue must prefer the record-bearing
 * business object. Synthetic non-record variants — platform events (`__e`),
 * change events, big objects (`__b`), external objects (`__x`), CMDT (`__mdt`),
 * and the standard `__Share`/`__History`/`__Feed` sidecar objects — that merely
 * share the noun are de-prioritized so a look-alike occupying a slot never masks
 * the base object. Keyed on Salesforce platform SUFFIX conventions, not org
 * names, so it stays org-independent. Rank 0 = record object; 1 = synthetic.
 */
const OBJECT_RESCUE_DEPRIORITIZE = /(?:__(?:e|b|x|mdt)|ChangeEvent|__Share|__History|__Feed)$/i;
const objectRescueRank = (apiName: string): number =>
  OBJECT_RESCUE_DEPRIORITIZE.test(apiName) ? 1 : 0;

/**
 * Schema nouns a user attaches to a name as a TYPE hint, not name content —
 * "SSN field", "the payment object", "Contact trigger". Left in the token
 * stream they fuzzy-match unrelated corpus tokens ("object"≈"project") and
 * drag genuine matches below noise, so `stripTypeHintNouns` removes them from
 * the LEADING/TRAILING edge of the query before tokenization. The RAW query is
 * still used for the whole-name exact pass (a component literally named
 * `SSN_Field__c` stays findable) and for `queryNamesComponentType`, which
 * turns the stripped noun into the type-intent ranking factor.
 */
const TYPE_HINT_SINGLE_NOUNS: ReadonlySet<string> = new Set([
  'trigger', 'triggers', 'profile', 'profiles', 'field', 'fields',
  'object', 'objects', 'flow', 'flows', 'component', 'components',
]);
/** Two-word type hints, matched as a trailing/leading pair. */
const TYPE_HINT_NOUN_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['permission', 'set'], ['permission', 'sets'],
  ['record', 'type'], ['record', 'types'],
];

/**
 * Strip leading/trailing schema-noun type hints (and leading articles) from a
 * query so "SSN field" tokenizes exactly like bare "SSN". Interior words are
 * never touched ("pay period field" only loses the trailing noun), and a query
 * that is NOTHING BUT nouns/articles ("field", "permission set") is returned
 * unchanged so concept-word queries keep their existing behavior (including
 * the generic-type-word suppression below).
 */
const stripTypeHintNouns = (raw: string): string => {
  const words = raw.trim().split(/\s+/);
  const norm = (w: string): string => w.toLowerCase().replace(/[^a-z0-9]/g, '');
  let start = 0;
  let end = words.length;
  const isPairAt = (i: number): boolean =>
    i >= 0 &&
    i + 1 < end &&
    TYPE_HINT_NOUN_PAIRS.some(([a, b]) => norm(words[i]!) === a && norm(words[i + 1]!) === b);
  // Leading: articles, then noun hints ("the trigger ContactSync").
  for (;;) {
    if (start < end && /^(?:the|a|an)$/i.test(norm(words[start]!))) { start += 1; continue; }
    if (isPairAt(start) && start + 2 < end) { start += 2; continue; }
    if (start < end - 1 && TYPE_HINT_SINGLE_NOUNS.has(norm(words[start]!))) { start += 1; continue; }
    break;
  }
  // Trailing: noun hints ("SSN field", "Admin permission set").
  for (;;) {
    if (isPairAt(end - 2) && end - 2 > start) { end -= 2; continue; }
    if (end - 1 > start && TYPE_HINT_SINGLE_NOUNS.has(norm(words[end - 1]!))) { end -= 1; continue; }
    break;
  }
  const kept = words.slice(start, end).join(' ');
  return kept.length > 0 ? kept : raw;
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

/**
 * A short (3–4 char) query token contained in a much-longer COMPOUND node token
 * (`ssn` ⊂ `msn_professional_status`) is almost always noise, not a real match:
 * the shared substring covers a tiny fraction of the compound name and the two
 * are unrelated words that happen to overlap. Suppress the containment score for
 * exactly that pattern so an acronym like `ssn` cannot ride a 0.33 length-ratio
 * substring hit into a candidate over the field genuinely named `Student_SSN__c`
 * (an exact TOKEN hit, unaffected). Longer query tokens, same-length pairs, and
 * short-to-short containment ("pay" ⊂ "pay_period") are NOT suppressed — this
 * only fires for the short-in-long-compound false-positive band.
 */
const isPureShortSubstringOfCompound = (qt: string, nt: string): boolean => {
  if (qt.length < 3 || qt.length > 4) return false;
  if (!nt.includes(qt)) return false;
  const isCompound = /_/.test(nt) || /[A-Z]{2,}|[a-z][A-Z]/.test(nt);
  return isCompound && nt.length > qt.length + 2;
};

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
    // Suppress pure-short-substring-of-compound false positives: a 3–4 char
    // token contained in a much-longer compound name (e.g. "ssn" ⊂
    // "msn_professional_status") is likely noise, not a real match. Typos and
    // genuine containment are unaffected (longer query tokens, same-length
    // pairs, and short-to-short containment are not suppressed).
    let contain = 0;
    if (
      qt.length >= 3 &&
      nt.length >= 3 &&
      (nt.includes(qt) || qt.includes(nt)) &&
      !isPureShortSubstringOfCompound(qt, nt)
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
  // Leading/trailing schema nouns ("SSN field", "the payment object", "Contact
  // trigger") are TYPE hints, not name content: they are stripped from the
  // token stream (so "SSN field" scores exactly like bare "SSN") while the raw
  // query still drives the whole-name exact pass and the type-intent ranking.
  const strippedQuery = stripTypeHintNouns(query);
  const queryTokens = tokenizeText(strippedQuery, { expandPhrases: true });
  // OmniStudio family vocabulary the query names ("omniscript", "flexcard",
  // "integration procedure", …). A type-constraining signal that must not let
  // the remaining noun produce a false `exact` on an off-family component (see
  // the disposition guard below — RESOLVE-OMNISCRIPT-TOKEN-DROPPED-FALSE-EXACT).
  const queryOmniFamilies = queryNamesOmniFamilies(query);
  // Whole-query comparison key for the exact/prefix boost (see the per-node loop).
  const normQuery = normalizeName(query);
  // Bug 3 — exact api-name match wins over a superset/substring rival.
  // When the user appends a leading/trailing type hint ("Calculate_Contact_Budget_Group
  // flow"), normQuery encodes that hint ("calculatecontactbudgetgroupflow") and
  // can no longer whole-name-match a node whose normName is the bare api-name
  // ("calculatecontactbudgetgroup"). The stripped form removes the hint so the
  // whole-name-exact gate fires correctly for that node. Guard: only fire when the
  // stripped form is SHORTER than the raw form (i.e. something was actually
  // stripped) and the stripped query has content — a no-op when the query is
  // already bare (stripped === query → normStrippedQuery === normQuery, harmless).
  const normStrippedQuery =
    strippedQuery.length < query.trim().length
      ? normalizeName(strippedQuery)
      : normQuery;
  // Canonical-id form ("Flow:Calculate_Contact_Budget_Group"): the "Type:" prefix
  // is stripped so the name segment can whole-name-match the node's api-name.
  // Applied only when the query is a single space-free token containing exactly
  // one colon (not a multi-word question that happens to contain a colon).
  const queryTrimmed = query.trim();
  const normAfterTypePrefix: string = (() => {
    if (!queryTrimmed.includes(':') || /\s/.test(queryTrimmed)) return normQuery;
    const colonIdx = queryTrimmed.indexOf(':');
    const afterColon = queryTrimmed.slice(colonIdx + 1);
    // Only the simple "Type:ApiName" case (no second colon, no dot already
    // handled by the dottedExact path). A dotted afterColon is for
    // "Type:Object.Field" which the dottedExact path owns.
    if (afterColon.includes(':') || afterColon.includes('.')) return normQuery;
    const n = normalizeName(afterColon);
    return n.length >= 2 ? n : normQuery;
  })();
  // A CONFIRMED multi-word business phrase ("social security number" -> `ssn`,
  // "date of birth" -> `dob`) is collapsed to its canonical Salesforce token by
  // the expandPhrases pass that built `queryTokens`. The ABBREVIATION form
  // ("SSN") whole-name-matches a field named `SSN__c` (normQuery === normName)
  // and resolves `exact`; the PHRASE form's normQuery ("socialsecuritynumber")
  // does not, so the synonym hit only ever reached TOKEN scoring and — tied by
  // sibling fields sharing the `ssn` token — fell to `ambiguous`. Feed the
  // expanded form into the whole-name exact pass so a UNIQUE synonym target
  // resolves `exact` like the abbreviation. Gated to the case where phrase
  // expansion ACTUALLY changed the tokens (vs the no-expand tokenization) — a
  // no-op for every non-phrase query, so no existing calibration shifts.
  const unexpandedTokens = tokenizeText(strippedQuery);
  const phraseExpanded =
    queryTokens.length > 0 &&
    (unexpandedTokens.length !== queryTokens.length ||
      unexpandedTokens.some((t, i) => t !== queryTokens[i]));
  const normPhraseExpanded = phraseExpanded
    ? normalizeName(queryTokens.join(' '))
    : normQuery;

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

  // Dotted Object.Field form (or a full canonical id `Type:Object.Field`): the
  // user named BOTH the parent object AND the field's literal api name, the most
  // specific way to point at a field. The dotted whole-name pass below treats a
  // field whose name only collides with a SPACE-joined query as a decoy, and a
  // dotted query never whole-name-matches a dotless field — so `Opportunity.
  // Opportunity_Status__c` would otherwise fall to the parent-aware token path
  // and be reported `ambiguous` against same-object `*Status*` siblings. When
  // the query is a single dotted token, capture its normalized object-part and
  // field-part so a candidate matching BOTH exactly is a definitive `exact` hit.
  // Guarded to a lone token with exactly one dot (no spaces) so multi-word
  // questions ("email on Contact.Account") never trigger it. A leading
  // canonical-id `Type:` segment is stripped first.
  let dottedObjectNorm: string | null = null;
  let dottedFieldNorm: string | null = null;
  {
    const rawTrim = query.trim();
    const afterColon = rawTrim.includes(':')
      ? rawTrim.slice(rawTrim.indexOf(':') + 1)
      : rawTrim;
    if (!/\s/.test(afterColon) && (afterColon.match(/\./g)?.length ?? 0) === 1) {
      const [objPart, fieldPart] = afterColon.split('.');
      const on = normalizeName(objPart ?? '');
      const fn = normalizeName(fieldPart ?? '');
      if (on.length >= 2 && fn.length >= 2) {
        dottedObjectNorm = on;
        dottedFieldNorm = fn;
      }
    }
  }

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
  // Bug 3 — gather candidates using all three norm keys so exact-api-name
  // nodes are never excluded from scoring even when the raw normQuery doesn't
  // match (e.g. "ApiName flow" or "Flow:ApiName" queries).
  const candidateIdxSet = new Set(gatherCandidates(index, queryTokens, normQuery));
  // Additional byNormName lookups for the stripped-query and after-type-prefix
  // norms. The token-based buckets above already cover most of these nodes,
  // but stop-word-named components (e.g. "IT") rely solely on byNormName and
  // would be missed if their normName doesn't match normQuery.
  if (normStrippedQuery !== normQuery) {
    const extra = index.byNormName.get(normStrippedQuery);
    if (extra !== undefined) for (const i of extra) candidateIdxSet.add(i);
  }
  if (normAfterTypePrefix !== normQuery && normAfterTypePrefix !== normStrippedQuery) {
    const extra = index.byNormName.get(normAfterTypePrefix);
    if (extra !== undefined) for (const i of extra) candidateIdxSet.add(i);
  }
  // A confirmed phrase-synonym target (`SSN__c` for "social security number")
  // is reached by its `ssn` token bucket already, but add the byNormName lookup
  // for parity with the other norm keys so the whole-name-exact node is never
  // missed from scoring.
  if (
    phraseExpanded &&
    normPhraseExpanded !== normQuery &&
    normPhraseExpanded !== normStrippedQuery &&
    normPhraseExpanded !== normAfterTypePrefix
  ) {
    const extra = index.byNormName.get(normPhraseExpanded);
    if (extra !== undefined) for (const i of extra) candidateIdxSet.add(i);
  }
  const candidateIdx = [...candidateIdxSet];

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
    // Dotted Object.Field (or canonical-id) form: this candidate's parent object
    // AND its own field name both equal the dotted parts of the query. That is a
    // definitive, maximally-specific hit — promote it to whole-name-exact so the
    // disposition short-circuit reports it `exact` and same-object `*Status*`
    // siblings (which share only the parent + a common suffix token) can't demote
    // it. A field on a DIFFERENT object, or an object-part the query did not name,
    // does not qualify.
    const dottedExact =
      dottedObjectNorm !== null &&
      dottedFieldNorm !== null &&
      node.parentApiName !== null &&
      normalizeName(node.parentApiName) === dottedObjectNorm &&
      normalizeName(node.apiName) === dottedFieldNorm;
    // Bug 3 — also check the stripped-query norm and the after-type-prefix norm
    // so that "ApiName flow" and "Flow:ApiName" forms reach wholeExact just
    // like a bare "ApiName" query. The dot-agreement guard uses the original
    // query's dot-ness; the crossObjectFieldDecoy guard is unchanged.
    const wholeExactNormMatch =
      (normQuery.length >= 2 && node.normName === normQuery) ||
      (normStrippedQuery !== normQuery &&
        normStrippedQuery.length >= 2 &&
        node.normName === normStrippedQuery) ||
      (normAfterTypePrefix !== normQuery &&
        normAfterTypePrefix.length >= 2 &&
        node.normName === normAfterTypePrefix) ||
      // Confirmed phrase-synonym whole-name match ("social security number" ->
      // `ssn` == `SSN__c`.normName). Only when phrase expansion actually fired.
      (phraseExpanded &&
        normPhraseExpanded !== normQuery &&
        normPhraseExpanded.length >= 2 &&
        node.normName === normPhraseExpanded);
    const wholeExact =
      dottedExact ||
      (wholeExactNormMatch &&
        query.includes('.') === node.apiName.includes('.') &&
        !crossObjectFieldDecoy);
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
  // RESOLVE-STUDENT-APPLICATION-DROPS-OBJECT: ids of CustomObjects the multi-token
  // phrase DIRECTLY NAMES — an ANCHOR query token exactly equals one of the
  // object's OWN name tokens ("student application" names the Application object
  // via `application`). Such an object is a legitimate resolution target that a
  // flood of its own qualifier fields (which borrow the object's name via
  // parent-credit to reach full coverage) can otherwise slice out of the
  // candidate set entirely, leaving a fields-only result. Consulted post-slice
  // to guarantee the object a slot (see the inclusion pass before return).
  const directlyNamedObjectIds = new Set<string>();
  // Per-object name-CENTRALITY (id -> fraction of the object's own name tokens
  // an anchor query token exactly names). Ranks WHICH directly-named object the
  // rescue surfaces, so the object the phrase most centrally names wins over an
  // incidental same-noun look-alike (`hed__Application__c` 0.5 over
  // `Ns__Application_Template_Item__c` 0.25) rather than whichever fluked a
  // higher fuzzy score into the top-N.
  const directlyNamedObjectCentrality = new Map<string, number>();

  // Generic-type-word suppression: when the query is a bare singular type word
  // (Profile, Permission Set, Record Type, etc.), suppress candidates whose
  // apiName is JUST that type name. This prevents a conceptual "what's a
  // Profile?" from resolving to a component literally named "Profile" and
  // triggering an unwanted disambiguation. Detection: a single-token query
  // matching a known type word. Suppression: candidates whose normalized apiName
  // equals the type word. Conservative by design — it only fires for a lone
  // type-name token, never for "Profile Reports" or "the Account Layout".
  const typeWord =
    queryTokens.length === 1 ? (queryTokens[0] ?? '').toLowerCase() : null;
  const GENERIC_TYPE_WORDS: ReadonlySet<string> = new Set([
    'profile',
    'permissionset',
    'recordtype',
    'permissionsetgroup',
    'layout',
    'flow',
  ]);
  const isGenericTypeQuery = typeWord !== null && GENERIC_TYPE_WORDS.has(typeWord);
  const suppressTypeNames = new Set<string>();
  if (isGenericTypeQuery && typeWord !== null) {
    for (const c of pass1) {
      if (normalizeName(c.node.apiName).toLowerCase() === typeWord) {
        suppressTypeNames.add(c.node.id);
      }
    }
  }

  // PASS 2 — coverage-weighted base.
  for (const c of pass1) {
    // Skip generic-type-name candidates (e.g. a Profile component when the
    // query is just "Profile").
    if (suppressTypeNames.has(c.node.id)) continue;

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

    // RESOLVE-STUDENT-APPLICATION-DROPS-OBJECT — is this a CustomObject the
    // multi-token phrase DIRECTLY NAMES (an ANCHOR query token exactly equals
    // one of the object's OWN name tokens, e.g. "student application" names the
    // Application object via `application`)? Such an object is a legitimate
    // resolution target even though it cannot contain the phrase's QUALIFIER
    // token ("student") in its own name — so its anchor coverage (and thus
    // `base`) is penalized below the qualifier FIELDS, which borrow the object's
    // name via parent-credit to cover BOTH tokens and reach `base` 1.0. Detected
    // HERE, before the min-base drop, so a long qualifier phrase can never evict
    // the object from `scored` entirely (leaving nothing to surface). Reused
    // below to flag the object and to score its name-centrality for the rescue.
    const nodeTokenSet = new Set(c.node.tokens);
    const isDirectlyNamedObject =
      c.node.type === 'CustomObject' &&
      queryTokens.length >= 2 &&
      anchorIdx.some((i) => nodeTokenSet.has(queryTokens[i]!));

    // Keep a directly-named object in `scored` even below min-base: it is the
    // subject the phrase names, and the tail-inclusion pass reserves it a slot.
    if (base < minBase && !isDirectlyNamedObject) continue;

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
    const matchedNodeTokens = new Set(
      matched.map((m) => m.matchedToken).filter((t) => nodeTokenSet.has(t)),
    );
    const nameCoverage = c.wholeExact
      ? 1
      : matchedNodeTokens.size / c.node.tokens.length;
    coverageById.set(c.node.id, nameCoverage);
    if (c.wholeExact) wholeExactIds.add(c.node.id);
    if (c.parentMatched) parentMatchedIds.add(c.node.id);
    // RESOLVE-STUDENT-APPLICATION-DROPS-OBJECT: record the CustomObject the
    // phrase DIRECTLY NAMES plus its object-name CENTRALITY — the fraction of
    // the object's OWN name tokens an anchor query token exactly names. The noun
    // `application` names 1 of the 2 tokens of `hed__Application__c` (0.5) but
    // only 1 of the 4 of `Ns__Application_Template_Item__c` (0.25), so the
    // record object the phrase most centrally names outranks an incidental
    // same-noun look-alike whose name is mostly OTHER words. Exact-token (not
    // fuzzy) so a stray `student`≈`template` graze can't inflate a look-alike's
    // centrality. (A single-token query already surfaces the object; parent-
    // credit fields never qualify — their type is not CustomObject.)
    if (isDirectlyNamedObject) {
      directlyNamedObjectIds.add(c.node.id);
      const named = anchorIdx.filter((i) => nodeTokenSet.has(queryTokens[i]!)).length;
      directlyNamedObjectCentrality.set(
        c.node.id,
        c.node.tokens.length > 0 ? named / c.node.tokens.length : 0,
      );
    }

    scored.push({
      id: c.node.id as ComponentId,
      type,
      apiName: c.node.apiName,
      label: c.node.label,
      parentApiName: c.node.parentApiName,
      score: Number(score.toFixed(6)),
      base: Number(base.toFixed(6)),
      nameCoverage: Number(nameCoverage.toFixed(6)),
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
    // Type intent breaks ties WITHIN a base tier only. Ranking it above the
    // base tier let a weak fuzzy match of the hinted type ("ssn"≈"asn" on a
    // CustomField) resurrect over an exact-token match of another type — the
    // "<name> field" acronym-false-positive regression. A type hint prefers
    // the named type among comparable matches; it never outranks confidence.
    if (namedTypeForSort !== null) {
      const ttA = typeIntentTier(a.type);
      const ttB = typeIntentTier(b.type);
      if (ttA !== ttB) return ttA - ttB;
    }
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
    //
    // The score-tie path is the second half of the same bug: when the query is
    // the LITERAL full api name of one component (e.g. "Opportunity_Status__c"),
    // same-object siblings that share its non-discriminating tokens — the parent
    // object token via parent-credit ("opportunity") plus a common suffix token
    // ("status") — reach base 1.0 and the SAME score, so they tie the top on
    // `score >= top.score * CONTENDER_RATIO` and inflate the contender count to
    // `ambiguous` even though the user typed an exact, unambiguous name. A
    // definitive sole whole-name-exact hit is only genuinely AMBIGUOUS against
    // ANOTHER whole-name-exact match (a real name collision, e.g. `Email__c` on
    // both Account and Contact). For such a top, count as contenders only OTHER
    // whole-name-exact candidates; a score-tied or parent-credited sibling that
    // is NOT itself a literal whole-name match cannot demote it.
    const contenders = topIsSoleWholeExact
      ? candidates.filter((c) => c.id === top.id || wholeExactIds.has(c.id))
      : candidates.filter(
          (c) =>
            c.score >= top.score * CONTENDER_RATIO ||
            parentMatchedIds.has(c.id),
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

  // RESOLVE-OMNISCRIPT-TOKEN-DROPPED-FALSE-EXACT: the query named an OmniStudio
  // family ("omniscript application", "flexcard …") — a TYPE-CONSTRAINING word.
  // When the family is uncovered in the vault, that word anchors to nothing,
  // is silently dropped from the coverage denominator, and the remaining noun
  // ("application") reaches `base` 1.0 to fake an `exact` on an unrelated
  // object/field. A confident `exact` for such a query therefore REQUIRES the
  // top match to actually be of the named family (the query's own type
  // constraint) — otherwise the family word was ignored and the answer is not
  // confident. Demote to `ambiguous` so the host disambiguates (and the resolve
  // tool can attach its Omni coverage caveat) instead of being sent into
  // object/save tools with a wrong id. A literal whole-name-exact hit (the user
  // typed a real component's exact name) is exempt.
  if (
    disposition === 'exact' &&
    queryOmniFamilies.size > 0 &&
    top !== undefined &&
    !wholeExactIds.has(top.id) &&
    !queryOmniFamilies.has(top.type)
  ) {
    disposition = 'ambiguous';
  }

  // RESOLVE-NETWORK-TOKEN-MISBINDS-CMDT: the query names a metadata TYPE ("network"
  // → the Experience Cloud `Network`/community type) whose real components exist
  // in the vault, but the confident `exact` landed on a DIFFERENT, merely
  // same-named family — e.g. a `Network_*__mdt` CustomMetadataType for a bare
  // "Network". Silently binding the schema look-alike routes the host to the
  // wrong component family with no way back; demote to `ambiguous` so both the
  // named type's components and the look-alike surface for disambiguation.
  // Gated on the named type actually HAVING members (an org with no such family
  // legitimately keeps its exact). A literal whole-name-exact hit (the user typed
  // a real component's exact name) and a top that IS of the named type are exempt.
  if (disposition === 'exact' && top !== undefined && !wholeExactIds.has(top.id)) {
    const queryTypeVocab = queryNamesTypeVocab(query);
    if (
      queryTypeVocab.size > 0 &&
      !queryTypeVocab.has(top.type) &&
      index.nodes.some((n) => queryTypeVocab.has(n.type as ComponentType))
    ) {
      disposition = 'ambiguous';
    }
  }

  // RESOLVE-STUDENT-APPLICATION-DROPS-OBJECT: a business phrase that NAMES an
  // object ("student application" → the Application object, qualified by
  // "student") ranks the object's qualifier FIELDS above the object itself
  // (they borrow the object's name via parent-credit to reach full coverage,
  // while the object's partial coverage sinks it below the `limit` cut) — a
  // fields-only result the host cannot turn into an object-level answer
  // (what_happens_on_save) without inventing the api name. When such a directly
  // named object was sliced out while its own fields survived, guarantee it a
  // slot in the tail so the candidate set is never object-omitted. Runs AFTER
  // disposition + slicing and only when NOT `exact`, so it never changes the
  // verdict, the top candidate, or any surviving candidate's rank — it only
  // rescues an omitted object. General: keyed on structure, not org names.
  let finalCandidates: readonly ResolveCandidate[] = candidates;
  if (
    disposition !== 'exact' &&
    limit > 1 &&
    directlyNamedObjectIds.size > 0 &&
    candidates.length >= limit
  ) {
    // Pick WHICH directly-named object to surface. `scored` is already
    // rank-ordered, and a STABLE sort keeps that order within each tie band:
    //   1. record-bearing object before an event/CDC/CMDT/sidecar look-alike
    //      that merely shares the noun (`Application_Event__e` for "application");
    //   2. object-name CENTRALITY — the object whose OWN name the phrase most
    //      fully names (`hed__Application__c` 0.5 over the incidental
    //      `Ns__Application_Template_Item__c` 0.25). This is the fix's crux: the
    //      base score buries the record object below its own qualifier fields AND
    //      below a same-noun look-alike that fluked a fuzzy graze into the top-N,
    //      so a score-only pick rescued the WRONG object (and, finding it already
    //      present, did nothing). Centrality restores the object the phrase names.
    //   3. within a tie, the score-ranked `scored` order (popularity/type-weight)
    //      breaks it deterministically (stable sort, comparator returns 0).
    const directlyNamed = scored.filter((c) => directlyNamedObjectIds.has(c.id));
    const preferred = [...directlyNamed].sort((a, b) => {
      const r = objectRescueRank(a.apiName) - objectRescueRank(b.apiName);
      if (r !== 0) return r;
      const cvA = directlyNamedObjectCentrality.get(a.id) ?? 0;
      const cvB = directlyNamedObjectCentrality.get(b.id) ?? 0;
      if (cvA !== cvB) return cvB - cvA;
      return 0;
    })[0];
    if (preferred !== undefined && !candidates.some((c) => c.id === preferred.id)) {
      finalCandidates = [...candidates.slice(0, limit - 1), preferred];
    }
  }

  // RESOLVE-NETWORK-TOKEN-MISBINDS-CMDT (recall half): the query names a metadata
  // TYPE ("network" → the Experience Cloud `Network`/community type) whose real
  // components are named after the community, so their names carry no "network"
  // token, the prefilter never gathered them, and the demotion above had nothing
  // of the named type to offer — leaving a same-named CMDT as the only candidate.
  // Surface the named type's members (capped, id-sorted for determinism) so the
  // host reaches the right family. Gated exactly like the demotion: the query
  // names such a type, real members exist, NONE are already present, and the top
  // is NOT the user's literal whole-name-exact hit. Appended at the tail (they
  // matched by type name, not string similarity) and never left `exact` on the
  // wrong family.
  const queryTypeVocab = queryNamesTypeVocab(query);
  if (
    queryTypeVocab.size > 0 &&
    (top === undefined || !wholeExactIds.has(top.id)) &&
    !finalCandidates.some((c) => queryTypeVocab.has(c.type))
  ) {
    const members = index.nodes
      .filter((n) => queryTypeVocab.has(n.type as ComponentType))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, TYPE_VOCAB_INJECT_CAP);
    if (members.length > 0) {
      const typeLabel = [...queryTypeVocab].join('/');
      const injected: ResolveCandidate[] = members.map((n) => ({
        id: n.id as ComponentId,
        type: n.type as ComponentType,
        apiName: n.apiName,
        label: n.label,
        parentApiName: n.parentApiName,
        score: 0,
        base: 0,
        nameCoverage: 0,
        matchKind: 'fuzzy',
        evidence: `names the "${typeLabel}" metadata type (surfaced by type name, not a string match)`,
      }));
      const room = Math.max(0, limit - injected.length);
      finalCandidates = [...finalCandidates.slice(0, room), ...injected];
      // A confident single hit on the WRONG family is not confident once the
      // named type's own members are in play; an honest disambiguation between
      // the look-alike and the real family is `ambiguous`, never `exact`/`none`.
      disposition = 'ambiguous';
    }
  }

  return ok({ disposition, candidates: finalCandidates, queryTokens });
};
