/**
 * Handler for the `sfi.find_semantic_field` MCP tool.
 *
 * The v2.2 "do we already have a field for X?" discovery surface. Takes
 * a natural-language description (e.g., "customer health score",
 * "renewal date") and returns CustomField nodes whose combined apiName
 * + label + description token bag has the highest token-overlap score
 * against the query.
 *
 * **Heuristic-only:** the v2.2 implementation uses lexical token
 * overlap (Jaccard-style) rather than TF-IDF cosine similarity because
 * the in-process TF-IDF cache is the search-index infrastructure that
 * R4 (this task ships ahead of the v2.2.R4-mcp-tools dispatch) does not
 * have access to. Until the cache lands, the heuristic is:
 *
 *   1. Tokenize the query per the description-tokenization path in
 *      `SemanticSearchSemantics.md` § "Tokenization rules".
 *   2. Tokenize each CustomField's `apiName + label + description`
 *      per the identifier-tokenization path (CamelCase split,
 *      underscore split, suffix-strip, lowercase, length filter, stop-
 *      word filter).
 *   3. Score by a synonym-aware Jaccard: the denominator is the
 *      ordinary token union `|query ∪ field|`, but a query token
 *      counts as a hit when the field bag contains it (literal, full
 *      weight) OR contains a member of its org-agnostic synonym group
 *      (synonym-bridged, weight `SYNONYM_SCORE` = 0.9, mirroring
 *      `resolve.ts`). A literal-only query scores identically to the
 *      pre-synonym Jaccard (2 of 5 → `0.4`); a synonym bridge lifts a
 *      formerly-zero match (e.g. `date of birth` → a `DOB` field)
 *      above the floor, ranked just below an equivalent literal hit.
 *      See `synonymJaccard` for the formulation and why synonyms do
 *      not inflate the denominator. Higher is better.
 *   4. Filter results below `minScore` (default 0.1 — empirically the
 *      cut-off below which results share only one token and are
 *      noisy).
 *   5. Return the top `limit` (default 10).
 *
 * **Q95 honesty anchor (v2.2 constitutional axis):** every result
 * carries `confidence: 'heuristic'` and the response's `boundaries`
 * always surfaces the verbatim Q95 disclosure for similarity-ranked
 * results. This is the v2.2 axis that locks the disclosure language —
 * the skill MUST echo it verbatim to the user. A field named
 * `Customer_Industry__c` will rank above zero for the query
 * "customer health" because they share the `customer` token, even
 * though the semantic meaning differs. The disclosure names this
 * structural false-positive risk so the user knows to verify the
 * returned field's label and description before treating as the
 * answer.
 *
 * **Object filter:** optional `objectIds` narrows the candidate set
 * to fields whose `parentId` is one of the supplied CustomObject ids.
 *
 * **Tokenization rules** (per `SemanticSearchSemantics.md` §
 * "Tokenization rules"):
 *   - Strip API-namespace suffixes: `__c`, `__r`, `__mdt`, `__e`,
 *     `__b`, `__x`, `__s`.
 *   - Strip managed-package namespace prefix `Namespace__` up to the
 *     first `__`.
 *   - Split on underscores.
 *   - Split on CamelCase boundaries (lowercase-to-uppercase, multi-
 *     uppercase-to-lowercase, numeric boundary).
 *   - Lowercase all tokens.
 *   - Drop tokens shorter than 2 characters.
 *   - Drop stop words (`a`, `an`, `the`, `is`, `at`, `on`, `in`, `of`,
 *     `to`, `for`, `with`, `from`, `by`, `as`, `it`, `this`, `that`,
 *     `or`, `and`, `not`, `but`, `if`, `then`, `else`, `field`,
 *     `custom`, `value`, `record`).
 *
 * Implementation notes:
 *   - The CustomField corpus is scanned via repeated `listNodesByType`
 *     pages (the v0.1 `LIST_MAX_LIMIT` is 500 per page). The handler
 *     walks at most 20 pages (10,000 fields) — a hard cap that
 *     prevents pathological orgs from creating runaway queries.
 *   - Scoring is a synonym-aware symmetric Jaccard so a one-token query
 *     matching a 5-token field scores low (1/5 = 0.2), preventing tiny
 *     queries from dominating the ranking with unrelated wide-field
 *     matches. The denominator is the literal token union (synonyms do
 *     not widen it); synonyms only add weighted hits to the numerator.
 *   - The output `matchedTokens` array carries the query tokens that
 *     hit the field's token bag (literally or via synonym) — the
 *     user-facing explanation for "why was this field ranked highly"
 *     and the verification surface for the Q95 false-positive case.
 *   - `confidence: 'heuristic'` is hard-coded on every match (the type
 *     enforces it via the literal type rather than the broader
 *     `ConfidenceLevel` union).
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { expandSynonyms } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { mergeInputAliases } from './input-aliases.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { clampedNodeScanLimit, scanTruncationNote } from './scan-cap.js';

const FIND_SEMANTIC_FIELD_TOOL = 'sfi.find_semantic_field';

/** Inclusive upper bound on `limit`. */
const SEMANTIC_FIELD_MAX_LIMIT = 50;
/** Default `limit`. */
const SEMANTIC_FIELD_DEFAULT_LIMIT = 10;
/** Default `minScore` — empirically chosen cut-off for "one common token". */
const SEMANTIC_FIELD_DEFAULT_MIN_SCORE = 0.1;
/**
 * Weight of a synonym-bridged hit in the overlap numerator. A query token that
 * matches a field token only via its org-agnostic synonym group (e.g. `birth`
 * ↔ `dob`) counts as this much of a hit, where a literal token-equality hit
 * counts as a full 1.0. Mirrors `resolve.ts`'s `SYNONYM_SCORE` so a synonym
 * match ranks just below a literal match rather than equal to one.
 */
const SYNONYM_SCORE = 0.9;

/** Verbatim Q95 disclosure surfaced on every result. */
const Q95_DISCLOSURE =
  "this is a similarity-ranked recommendation based on overlapping tokens in the field's apiName, label, and description; it is not a declared match. A field named `Customer_Industry__c` will rank highly for the query `customer health` because they share the token `customer`. Verify the returned field's label and description before treating as the answer.";
/**
 * Disclosure for the synonym layer. The ranking now bridges a fixed set of
 * org-agnostic synonym groups (e.g. `dob`↔`birthdate`, `rep`↔`owner`) so a
 * query token can match a field token that is a curated group-mate, scored
 * just below a literal token match. It is still a heuristic: the groups are
 * org-agnostic (not learned from this org's vocabulary), there is no spelling
 * correction, and there is no true semantic/embedding understanding — so a
 * query phrased in org-specific terminology outside the standard Salesforce
 * vocabulary may still miss relevant fields. Embedding-based semantic search
 * is future work.
 */
const SYNONYM_DISCLOSURE =
  'the similarity ranking applies a fixed set of org-agnostic synonym groups (e.g. `dob`↔`birthdate`, `rep`↔`owner`), so `date of birth` can reach a `DOB` field; a synonym-bridged match scores just below a literal token match. This is heuristic, not true semantic search: the synonym groups are org-agnostic (not learned from your org), there is no spelling correction, and there is no embedding-based semantic understanding. A query phrased in org-specific terminology outside the standard Salesforce vocabulary may still miss relevant fields. Embedding-based semantic search is future work.';

/**
 * Stop-word list per `SemanticSearchSemantics.md` § "Identifier-name
 * tokenization" step 7. Intentionally short — aggressive stop-word
 * removal damages recall, so the list focuses on near-universal
 * English tokens and Salesforce-corpus-specific terms with near-zero
 * discriminative value.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'is',
  'at',
  'on',
  'in',
  'of',
  'to',
  'for',
  'with',
  'from',
  'by',
  'as',
  'it',
  'this',
  'that',
  'or',
  'and',
  'not',
  'but',
  'if',
  'then',
  'else',
  'field',
  'custom',
  'value',
  'record',
]);

/**
 * API-namespace suffixes stripped at identifier-tokenization step 1.
 */
const SUFFIXES = ['__c', '__r', '__mdt', '__e', '__b', '__x', '__s'] as const;

/**
 * Strip the trailing API-namespace suffix if any. Returns the
 * remainder; pass-through when no recognized suffix is present.
 */
const stripSuffix = (raw: string): string => {
  for (const suffix of SUFFIXES) {
    if (raw.endsWith(suffix)) return raw.slice(0, -suffix.length);
  }
  return raw;
};

/**
 * Strip a leading managed-package namespace prefix (`ns__`). Returns
 * the remainder when stripping; pass-through when no `__` separator
 * appears or the prefix is too long to be a namespace (>15 chars).
 */
const stripNamespace = (raw: string): string => {
  const idx = raw.indexOf('__');
  if (idx <= 0 || idx > 15) return raw;
  return raw.slice(idx + 2);
};

/**
 * Split on CamelCase boundaries within one underscore-segment. Handles:
 *   - lowercase→uppercase (helperUtility → helper, Utility)
 *   - multi-uppercase→lowercase-uppercase (URLEndpoint → URL, Endpoint)
 *   - numeric boundary (Phase1Score → Phase, 1, Score)
 */
const splitCamelCase = (segment: string): string[] => {
  if (segment.length === 0) return [];
  // Insert a separator at every camel boundary.
  const out = segment
    // lowercase|digit -> uppercase
    .replace(/([a-z\d])([A-Z])/g, '$1$2')
    // uppercase -> uppercase + lowercase (URLEndpoint -> URLEndpoint)
    .replace(/([A-Z])([A-Z][a-z])/g, '$1$2')
    // letter -> digit boundary
    .replace(/([a-zA-Z])(\d)/g, '$1$2')
    // digit -> letter boundary
    .replace(/(\d)([a-zA-Z])/g, '$1$2')
    .split('');
  return out.filter((s) => s.length > 0);
};

/**
 * Identifier tokenization path — used for `apiName`. Applies suffix
 * strip, namespace strip, underscore split, CamelCase split per
 * underscore-segment, lowercase, length filter, stop-word filter.
 */
export const tokenizeIdentifier = (raw: string): string[] => {
  if (raw.length === 0) return [];
  const stripped = stripSuffix(raw);
  const denamespaced = stripNamespace(stripped);
  const segments = denamespaced.split('_').filter((s) => s.length > 0);
  const tokens: string[] = [];
  for (const seg of segments) {
    for (const piece of splitCamelCase(seg)) {
      const lower = piece.toLowerCase();
      if (lower.length < 2) continue;
      if (STOP_WORDS.has(lower)) continue;
      tokens.push(lower);
    }
  }
  return tokens;
};

/**
 * Ordered, high-precision PHRASE synonyms (F1) — mirrors the graph resolver's
 * `tokenize.ts` PHRASE_SYNONYMS so find_semantic_field collapses the same
 * multi-word business phrases ("social security number" -> `ssn`). Longest-
 * phrase-first; every key is multi-word and unambiguous (no bare `social ->
 * ssn`, which would collapse "social media"/"social login").
 *
 * Unlike the router's doc corpus, find_semantic_field's corpus is field LABELS
 * (a different corpus), so expanding both query AND label/description bag here
 * is the intended #19 improvement and does not affect router-recall.
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
 * Description / label / query tokenization path. Replace non-
 * alphanumeric with whitespace, split, lowercase, length filter,
 * stop-word filter. Does NOT apply CamelCase splitting — descriptions
 * are prose and `JSONPayload` / `iPhone` / `macOS` should be preserved
 * as written.
 *
 * The phrase-synonym pass is OPT-IN (default OFF): pass `{ expandPhrases:
 * true }` to collapse multi-word business phrases before splitting. Enabled
 * for both the query and this tool's OWN label/description corpus (#19) — a
 * different corpus from the router's, so expanding it is safe.
 */
export const tokenizeText = (
  raw: string,
  opts?: { readonly expandPhrases?: boolean },
): string[] => {
  if (raw.length === 0) return [];
  const normalized =
    opts?.expandPhrases === true ? applyPhraseSynonyms(raw.toLowerCase()) : raw;
  const tokens: string[] = [];
  for (const piece of normalized.replace(/[^a-zA-Z0-9]/g, ' ').split(/\s+/)) {
    const lower = piece.toLowerCase();
    if (lower.length < 2) continue;
    if (STOP_WORDS.has(lower)) continue;
    tokens.push(lower);
  }
  return tokens;
};

/**
 * Build the combined token-bag for a CustomField: union of identifier
 * tokens (apiName), text tokens (label), and text tokens (description).
 * Returns a deduplicated Set since the v2.2 R4 ships Jaccard rather
 * than TF — TF-IDF requires the in-process cache R4 has not yet
 * landed; this v2.2 R2 implementation surfaces a heuristic-grade
 * lexical-overlap score that approximates the same ranking signal.
 */
const fieldTokenBag = (node: Node): Set<string> => {
  const bag = new Set<string>();
  for (const t of tokenizeIdentifier(node.apiName)) bag.add(t);
  const label = node.label;
  if (label !== null && label.length > 0) {
    for (const t of tokenizeText(label, { expandPhrases: true })) bag.add(t);
  }
  const description = node.properties['description'];
  if (typeof description === 'string' && description.length > 0) {
    for (const t of tokenizeText(description, { expandPhrases: true })) bag.add(t);
  }
  return bag;
};

/**
 * Synonym-aware Jaccard-style overlap between a query bag and a field bag.
 *
 * A query token is a "hit" when the field bag contains that token (LITERAL
 * hit) OR contains any member of its org-agnostic synonym group (SYNONYM hit,
 * via `expandSynonyms`). This bridges the synonym gap a pure-lexical resolver
 * cannot cross — e.g. the query `birth` now reaches a field whose only token
 * is `dob` — exactly as `resolve.ts`'s `scoreToken` does.
 *
 * Scoring keeps clean Jaccard semantics while weighting the two hit kinds:
 *
 *   score = (Σ hit-weight) / (|query| + |field| − |literalIntersection|)
 *
 * where a literal hit contributes `1.0` to the numerator and a synonym-only
 * hit contributes `SYNONYM_SCORE` (0.9). Two properties fall out by design:
 *
 *   1. **No literal-match regression.** For a query with no synonym-only hits
 *      the numerator is exactly `|literalIntersection|` and the denominator is
 *      `|query| + |field| − |literalIntersection|` — bit-for-bit the old
 *      symmetric-Jaccard value. Queries that already worked score identically.
 *   2. **Synonyms add recall without inflating the union.** The denominator is
 *      built from the ORIGINAL bag sizes (and only the LITERAL intersection is
 *      subtracted), so synonym expansion never widens either bag and so never
 *      depresses any score. A synonym hit simply contributes `0.9` where it
 *      previously contributed `0`, lifting a formerly-zero match above
 *      `minScore` and ranking it just below an otherwise-identical literal hit.
 *
 * Returns 0 when either bag is empty or nothing hits (the documented "no
 * tokens overlap" boundary in `SemanticSearchSemantics.md`). The returned
 * `intersection` carries the QUERY tokens that hit (literally or via synonym)
 * — the user-facing `matchedTokens` explanation.
 */
const synonymJaccard = (
  query: ReadonlySet<string>,
  field: ReadonlySet<string>,
): { score: number; intersection: string[] } => {
  if (query.size === 0 || field.size === 0) {
    return { score: 0, intersection: [] };
  }
  const matched: string[] = [];
  let numerator = 0;
  let literalHits = 0;
  for (const qt of query) {
    if (field.has(qt)) {
      // Literal token-equality hit — full weight, same as the old Jaccard.
      numerator += 1;
      literalHits += 1;
      matched.push(qt);
      continue;
    }
    // Synonym-only hit: the field bag holds a group-mate of this query token.
    // expandSynonyms(qt) returns [qt, ...synonyms]; qt itself already failed
    // the literal test above, so any remaining match is a genuine synonym.
    let synonymHit = false;
    for (const expanded of expandSynonyms(qt)) {
      if (field.has(expanded)) {
        synonymHit = true;
        break;
      }
    }
    if (synonymHit) {
      numerator += SYNONYM_SCORE;
      matched.push(qt);
    }
  }
  if (numerator === 0) return { score: 0, intersection: [] };
  // Union over the ORIGINAL bag sizes; only literal hits are deduplicated, so
  // synonym expansion never inflates the denominator (see property 2 above).
  const union = query.size + field.size - literalHits;
  return { score: numerator / union, intersection: matched };
};

/**
 * Zod schema for the `sfi.find_semantic_field` tool input.
 *
 *   - `description`: required natural-language concept.
 *   - `objectIds`: optional array of `CustomObject:{ApiName}` ids that
 *     narrows the candidate field set.
 *   - `limit`: optional integer in `[1, 50]`. Defaults to 10.
 *   - `minScore`: optional number in `[0, 1]`. Defaults to 0.1.
 */
const findSemanticFieldInputBaseSchema = z.object({
  description: z.string().min(1),
  objectIds: z.array(z.string().min(1)).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SEMANTIC_FIELD_MAX_LIMIT)
    .optional(),
  minScore: z.number().min(0).max(1).optional(),
  // CR-22: page cursor for walking the full ranked match list when truncated.
  offset: z.number().int().min(0).optional(),
  cursor: z.string().min(1).optional(),
});

export const findSemanticFieldInputSchema = z.preprocess(
  (raw) =>
    mergeInputAliases(raw, [{ canonical: 'description', aliases: ['query'] }]),
  findSemanticFieldInputBaseSchema,
);

/** Parsed input shape. */
export type FindSemanticFieldInput = z.infer<
  typeof findSemanticFieldInputSchema
>;

/** One ranked CustomField in the response. */
export interface SemanticFieldMatch {
  readonly componentId: ComponentId;
  readonly apiName: string;
  readonly label: string | null;
  readonly description: string | null;
  readonly objectId: ComponentId | null;
  readonly score: number;
  readonly matchedTokens: readonly string[];
  /** Always 'heuristic' — Q95 enforcement at the type level. */
  readonly confidence: 'heuristic';
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface FindSemanticFieldOutput {
  readonly matches: readonly SemanticFieldMatch[];
  readonly totalCount: number;
  readonly tokenizedQuery: readonly string[];
  readonly boundaries: readonly string[];
  /**
   * Page size applied to this response. Present ONLY on a PAGED response
   * (`truncated` or a resumed `offset > 0`); omitted on a whole-fits no-cursor
   * call so that response stays byte-identical to the pre-CR-22 shape.
   */
  readonly limit?: number;
  /** Zero-based offset of the first returned match. Present only when paged (see `limit`). */
  readonly offset?: number;
  /** Offset to pass on the next call to fetch the following page. Present only when truncated. */
  readonly nextOffset?: number;
  /**
   * CR-22 opaque continuation token, present ONLY when this page is truncated.
   * Echo it back as `cursor` to resume. Absent on a complete page so an
   * in-budget response is byte-identical to pre-CR-22.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
}

/**
 * The `sfi.find_semantic_field` MCP tool. Tokenizes `description` and
 * ranks CustomFields by token-overlap with their combined apiName +
 * label + description bag. Returns up to `limit` matches above
 * `minScore`, each carrying `confidence: 'heuristic'` and the
 * `matchedTokens` array for verification.
 *
 * @example
 *   const r = await findSemanticFieldHandler(ctx, {
 *     description: 'customer health score',
 *   });
 *   if (r.ok) console.log(r.value.data.matches[0]?.apiName);
 */
export const findSemanticFieldHandler = async (
  ctx: Context,
  input: FindSemanticFieldInput,
): Promise<Result<McpResponse<FindSemanticFieldOutput>, McpError>> => {
  const limit = input.limit ?? SEMANTIC_FIELD_DEFAULT_LIMIT;
  const minScore = input.minScore ?? SEMANTIC_FIELD_DEFAULT_MIN_SCORE;
  const queryTokens = tokenizeText(input.description, { expandPhrases: true });
  const queryBag = new Set<string>(queryTokens);

  // If the query is empty after tokenization, return zero matches with
  // an honest boundary — the user can re-query with different terms.
  if (queryBag.size === 0) {
    return ok({
      data: {
        matches: [],
        totalCount: 0,
        tokenizedQuery: queryTokens,
        boundaries: [Q95_DISCLOSURE, SYNONYM_DISCLOSURE],
      },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  }

  const objectFilter: ReadonlySet<string> | null =
    input.objectIds !== undefined && input.objectIds.length > 0
      ? new Set(input.objectIds)
      : null;

  // CR-22 B4: scan EVERY CustomField by paging the SQL OFFSET forward (window-
  // by-window) so fields past 10k are reachable — the old FIELD_PAGE_SIZE(500) x
  // FIELD_MAX_PAGES(20) loop SILENTLY dropped fields past 10,000 from BOTH
  // scoring and totalCount with no disclosure. objectFilter is applied post-scan
  // exactly as before. The scan completes here; the ranked output is paged below.
  const scan = await scanAllNodesOfTypes(ctx.graph, ['CustomField']);
  if (!scan.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${scan.error.message}`,
    });
  }
  const scored: SemanticFieldMatch[] = [];
  for (const node of scan.value.nodes) {
    if (objectFilter !== null && node.parentId !== null) {
      if (!objectFilter.has(node.parentId)) continue;
    } else if (objectFilter !== null && node.parentId === null) {
      continue;
    }
    const bag = fieldTokenBag(node);
    const { score, intersection } = synonymJaccard(queryBag, bag);
    if (score < minScore) continue;
    const description = node.properties['description'];
    scored.push({
      componentId: node.id,
      apiName: node.apiName,
      label: node.label,
      description: typeof description === 'string' ? description : null,
      objectId: node.parentId,
      score,
      matchedTokens: intersection.slice().sort(),
      confidence: 'heuristic',
    });
  }

  // Rank: score DESC, then componentId ASC for determinism. componentId is the
  // unique field id, so (score DESC, componentId ASC) is a STRICT TOTAL order —
  // the componentId-ASC tiebreak resolves any score tie uniquely, so a CR-22
  // offset resume cannot dup or skip across a tie boundary.
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.componentId < b.componentId ? -1 : 1;
  });

  // CR-22: resolve the resume offset (echoed cursor wins over explicit offset).
  // The fingerprint covers the NARROWING args — the canonical description (after
  // alias merge), objectIds, and minScore — so a token can't replay against a
  // different query.
  const fingerprint = argsFingerprint({
    description: input.description,
    ...(input.objectIds !== undefined ? { objectIds: input.objectIds } : {}),
    ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
  });
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: FIND_SEMANTIC_FIELD_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  const paged = paginateLegacy(scored, {
    offset,
    limit,
    keyOf: (m) => m.componentId,
    binding: {
      tool: FIND_SEMANTIC_FIELD_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const slice = paged.items;
  const truncated = paged.hasMore;
  const emitCursor = paged.nextCursor !== null;
  const isPaged = truncated || offset > 0;

  const boundaries = [Q95_DISCLOSURE, SYNONYM_DISCLOSURE];
  if (scan.value.scanIncomplete) {
    boundaries.push(
      scanTruncationNote(scan.value.incompleteTypes, clampedNodeScanLimit()),
    );
  }

  return ok({
    data: {
      matches: slice,
      totalCount: scored.length,
      tokenizedQuery: queryTokens,
      boundaries,
      ...(isPaged ? { limit, offset } : {}),
      ...(truncated ? { nextOffset: offset + slice.length } : {}),
      ...(emitCursor
        ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo }
        : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
