/**
 * Handler for the `sfi.search_components` MCP tool.
 *
 * Surfaces the graph layer's `searchNodes` query (LIKE-based,
 * case-insensitive, scored across `api_name` / `label` / `properties_json`)
 * through the MCP envelope. Input is validated by the exported Zod schema;
 * graph failures are translated into `internal` `McpError`s rather than
 * thrown so the JSON-RPC dispatch layer can serialize them cleanly.
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  resolveComponents,
  searchNodesPage,
  type MatchKind,
  type ResolveDisposition,
} from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

/**
 * Cap mirrored from `graph.searchNodes`. Surfacing it at the input boundary
 * gives clients a clean Zod-level rejection (`invalid-query`) for over-limit
 * requests instead of a downstream `query-failed` internal error.
 */
const SEARCH_MAX_LIMIT = 100;

/**
 * Default page size, mirrored from `graph.searchNodes`. Surfaced here so the
 * response can ECHO the limit it applied rather than leaving the reader to
 * infer it from the row count.
 */
const SEARCH_DEFAULT_LIMIT = 25;

/**
 * Zod schema for the `sfi.search_components` tool input. `query` must be a
 * non-empty string; `limit` is an integer bounded by the graph layer's
 * maximum; `types` is a free-form string array that the handler narrows to
 * `ComponentType[]` when forwarding to the graph (unknown types yield no
 * matches rather than a hard error, matching the underlying SQL semantics).
 */
export const searchComponentsInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).optional(),
  /** Zero-based page offset. Paired with `limit` to walk the FULL match set. */
  offset: z.number().int().nonnegative().optional(),
  types: z.array(z.string()).optional(),
});

/** Parsed input shape, inferred from `searchComponentsInputSchema`. */
export type SearchComponentsInput = z.infer<typeof searchComponentsInputSchema>;

/** A single ranked match returned by `sfi.search_components`. */
export interface SearchComponentsMatch {
  readonly id: string;
  readonly score: number;
  readonly snippet: string;
}

/**
 * One "did you mean" suggestion, surfaced ONLY when `matches` is empty. A lite
 * projection of a resolver candidate so a typo/filler query ("paymnet") still
 * lands the user on the right component instead of a dead 0-result.
 */
export interface SearchComponentsSuggestion {
  readonly componentId: ComponentId;
  readonly type: ComponentType;
  readonly score: number;
  readonly matchKind: MatchKind;
  readonly evidence: string;
}

/** Self-heal block attached only when the lexical search returns nothing. */
export interface SearchComponentsSuggestions {
  readonly disposition: ResolveDisposition;
  readonly candidates: readonly SearchComponentsSuggestion[];
  /** Verbatim heuristic disclosure — these are fuzzy guesses, not matches. */
  readonly note: string;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface SearchComponentsOutput {
  readonly matches: readonly SearchComponentsMatch[];
  /**
   * TRUE total matching the query (post-`types` filter), before limit/offset —
   * on EVERY page, an over-run `offset` included. A `0` here therefore always
   * means "nothing matched", never "you paged past the end".
   */
  readonly totalCount: number;
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly nextOffset: number | null;
  /** Verbatim; on EVERY response. */
  readonly boundaries: readonly string[];
  /**
   * Verbatim. Present when `hasMore` (the page is a prefix) OR when `offset`
   * ran past the end of the match set (empty page, non-zero `totalCount`) —
   * the two empty-ish outcomes a reader must never confuse.
   */
  readonly note?: string;
  /**
   * Present ONLY when `matches` is empty AND the typo-tolerant resolver found
   * candidates. Lets clients recover from a misspelled/filler query without a
   * second round-trip. Absent on a normal hit.
   */
  readonly suggestions?: SearchComponentsSuggestions;
}

/**
 * Verbatim boundary on EVERY response. Returning 25 rows out of 1,931 with no
 * total and no `hasMore` left the reader unable to tell a complete answer from
 * a 1.3% sample — and a lexical score is not a relevance score.
 */
const LEXICAL_MATCH_BOUNDARY =
  'Matches are lexical, case-insensitive substring hits across api name, label, and raw node properties. A hit may be an incidental substring ("age" inside "Page"), not a semantic match. Ranking is a lexical score, not relevance — for meaning-based search use `sfi.find_semantic_field`.';

/** Verbatim note attached to fallback suggestions. */
const SUGGESTIONS_NOTE =
  'No exact substring matches. These are typo-tolerant, fuzzy-ranked guesses (heuristic) at what you may have meant — verify the canonical id before acting.';

/**
 * The `sfi.search_components` MCP tool. Free-text search across the vault's
 * component graph, returning ranked hits with preview snippets. Input is
 * already Zod-validated by `dispatchTool`; this handler only deals in the
 * happy and graph-error paths.
 *
 * @example
 *   const result = await searchComponentsHandler(ctx, {
 *     query: 'Industry',
 *     limit: 10,
 *   });
 *   if (result.ok) console.log(result.value.data.matches);
 */
export const searchComponentsHandler = async (
  ctx: Context,
  input: SearchComponentsInput,
): Promise<Result<McpResponse<SearchComponentsOutput>, McpError>> => {
  // `searchNodesPage` returns `{ hits, totalCount }`; each hit's shape —
  // `{ id, score, snippet }` — is identical to `SearchComponentsMatch`, so the
  // rows forward without remapping. The total comes from the SAME query, so it
  // cannot drift from the rows it describes.
  const limit = input.limit ?? SEARCH_DEFAULT_LIMIT;
  const offset = input.offset ?? 0;
  const queryResult = await searchNodesPage(ctx.graph, input.query, {
    limit,
    offset,
    ...(input.types !== undefined
      ? { types: input.types as readonly ComponentType[] }
      : {}),
  });

  if (!queryResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${queryResult.error.message}`,
    });
  }

  let matches = queryResult.value.hits;
  const totalCount = queryResult.value.totalCount;

  // B22: when lexical search returns Flow hits, prefer api_name prefix matches
  // (searchNodes scores prefix 2.8 > contains 2.5) — re-sort Flow rows only so
  // Application_Status_Update beats Application_Field_Sync_To_Contact.
  const flowHits = matches.filter((m) => m.id.startsWith('Flow:'));
  if (flowHits.length > 1) {
    const prefix = input.query.replace(/%/g, '');
    // NOTE: this re-sort is PAGE-LOCAL — it only ever sees the rows in the
    // current page, and it always did. Do not extend it; SQL-side ranking is
    // where a cross-page ordering belongs.
    const sortedFlows = [...flowHits].sort((a, b) => {
      const aApi = a.id.slice('Flow:'.length);
      const bApi = b.id.slice('Flow:'.length);
      const aPrefix = aApi.toLowerCase().startsWith(prefix.toLowerCase()) ? 1 : 0;
      const bPrefix = bApi.toLowerCase().startsWith(prefix.toLowerCase()) ? 1 : 0;
      if (aPrefix !== bPrefix) return bPrefix - aPrefix;
      if (b.score !== a.score) return b.score - a.score;
      return a.id < b.id ? -1 : 1;
    });
    const nonFlows = matches.filter((m) => !m.id.startsWith('Flow:'));
    matches = [...sortedFlows, ...nonFlows];
  }

  // Self-heal: substring search is exact-character. When it finds nothing, a
  // typo/filler query ("paymnet", "payment stuff") would dead-end at 0 results
  // and read as "broken". Fall through to the typo-tolerant resolver and
  // surface ranked candidates as `suggestions` — heuristic, clearly labelled.
  //
  // Gated on `totalCount === 0`, NOT on an empty page: an over-run offset also
  // returns zero rows, and firing the self-heal there published SUGGESTIONS_NOTE
  // ("No exact substring matches") over a query that had 646 of them. A page
  // past the end is the END of a walk, not a miss.
  let suggestions: SearchComponentsSuggestions | undefined;
  if (matches.length === 0 && totalCount === 0) {
    const resolved = await resolveComponents(ctx.graph, input.query, {
      limit: 5,
      ...(input.types !== undefined
        ? { types: input.types as readonly ComponentType[] }
        : {}),
    });
    if (resolved.ok && resolved.value.candidates.length > 0) {
      suggestions = {
        disposition: resolved.value.disposition,
        candidates: resolved.value.candidates.map((c) => ({
          componentId: c.id,
          type: c.type,
          score: c.score,
          matchKind: c.matchKind,
          evidence: c.evidence,
        })),
        note: SUGGESTIONS_NOTE,
      };
    }
  }

  // Simple arithmetic beats `paginateLegacy` here: the slice already happened
  // in SQL, so there is no in-memory list for that pager to page.
  const hasMore = offset + matches.length < totalCount;
  // An offset PAST the end of the match set: empty page, real total. Before the
  // graph layer counted on an over-run page this response was `totalCount: 0,
  // matches: [], hasMore: false` — byte-identical to "nothing matched this
  // query". It now says which of the two it is, in the payload, unprompted.
  const pastEnd = matches.length === 0 && totalCount > 0 && offset >= totalCount;

  return ok({
    data: {
      matches,
      totalCount,
      limit,
      offset,
      hasMore,
      nextOffset: hasMore ? offset + matches.length : null,
      boundaries: [LEXICAL_MATCH_BOUNDARY],
      ...(hasMore
        ? {
            note: `Showing ${matches.length} of ${totalCount} match(es) (offset=${offset}). MORE remain — advance with offset=${
              offset + matches.length
            }. This list is INCOMPLETE; do not treat it as every component matching this query.`,
          }
        : pastEnd
          ? {
              note: `offset=${offset} is PAST THE END of this query's ${totalCount} match(es), so this page is empty. That is the end of the walk, NOT a query that matched nothing — re-query with an offset below ${totalCount} to see rows.`,
            }
          : {}),
      ...(suggestions !== undefined ? { suggestions } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
