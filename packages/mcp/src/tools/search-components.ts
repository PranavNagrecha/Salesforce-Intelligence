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
  searchNodes,
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
 * Zod schema for the `sfi.search_components` tool input. `query` must be a
 * non-empty string; `limit` is an integer bounded by the graph layer's
 * maximum; `types` is a free-form string array that the handler narrows to
 * `ComponentType[]` when forwarding to the graph (unknown types yield no
 * matches rather than a hard error, matching the underlying SQL semantics).
 */
export const searchComponentsInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).optional(),
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
   * Present ONLY when `matches` is empty AND the typo-tolerant resolver found
   * candidates. Lets clients recover from a misspelled/filler query without a
   * second round-trip. Absent on a normal hit.
   */
  readonly suggestions?: SearchComponentsSuggestions;
}

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
  // `searchNodes` returns `readonly SearchHit[]` whose shape — `{ id, score,
  // snippet }` — is identical to `SearchComponentsMatch`, so the value
  // forwards without remapping.
  const queryResult = await searchNodes(ctx.graph, input.query, {
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
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

  let matches = queryResult.value;

  // B22: when lexical search returns Flow hits, prefer api_name prefix matches
  // (searchNodes scores prefix 2.8 > contains 2.5) — re-sort Flow rows only so
  // Application_Status_Update beats Application_Field_Sync_To_Contact.
  const flowHits = matches.filter((m) => m.id.startsWith('Flow:'));
  if (flowHits.length > 1) {
    const prefix = input.query.replace(/%/g, '');
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
  let suggestions: SearchComponentsSuggestions | undefined;
  if (matches.length === 0) {
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

  return ok({
    data: {
      matches,
      ...(suggestions !== undefined ? { suggestions } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
