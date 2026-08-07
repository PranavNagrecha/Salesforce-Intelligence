/**
 * Handler for the `sfi.resolve` MCP tool — the typo-tolerant front door.
 *
 * Turns a messy/misspelled natural-language query into ranked candidate
 * canonical ids with a `disposition` (exact | ambiguous | none) and per-
 * candidate evidence. It is the recommended FIRST call when the user names a
 * component informally ("the emale field", "payment object", "error log"):
 * it tolerates typos, filler, and the org's own misspellings — none of which
 * `sfi.search_components` (substring LIKE) survives.
 *
 * Resolution is ALWAYS `heuristic` confidence and the tool NEVER silently
 * commits to a guess — `ambiguous`/`none` hand the decision back to the
 * caller. The `disclosure` (surfaced verbatim, mirroring the
 * `sfi.find_semantic_field` honesty convention) names the false-positive
 * risk explicitly.
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  UntrustedOrgText,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  getNodeById,
  resolveComponents,
  type MatchKind,
  type ResolveDisposition,
} from '@sf-intelligence/graph';
import {
  readAnnotations,
  summarizeCoverage,
  vaultPaths,
} from '@sf-intelligence/vault';
import { z } from 'zod';

import { renderResolveMarkdown } from '../answer-render.js';
import {
  buildClarify,
  type Clarification,
  type NextAction,
} from '../clarify.js';
import type { Context } from '../server.js';

import { brandOrgText } from './untrusted-org-text.js';

/** Hard cap mirrored from the graph resolver. */
const RESOLVE_MAX_LIMIT = 50;

/**
 * Verbatim honesty disclosure. Surfaced on every response so the caller can
 * relay it to the user. Mirrors the `find_semantic_field` Q95 convention:
 * resolution is similarity, not proof.
 */
const RESOLVE_DISCLOSURE =
  "These are typo-tolerant, fuzzy-ranked guesses at which component you meant — heuristic, not declared. disposition 'exact' = one confident match; 'ambiguous' = several plausible candidates, confirm the right one before acting; 'none' = nothing matched confidently (any listed items are weak near-misses). A high score is string similarity, not proof — verify the candidate's canonical id and label.";

/**
 * Zod schema for `sfi.resolve`.
 *   - `query`: required, non-empty. The messy human phrasing.
 *   - `types`: optional component-type filter (free-form strings; unknown
 *     types simply match nothing, matching the graph layer's semantics).
 *   - `parentId`: optional scope to children of one component (e.g. resolve
 *     a field within a known object).
 *   - `limit`: optional 1..50, default applied by the graph layer.
 */
export const resolveInputSchema = z.object({
  query: z.string().min(1),
  types: z.array(z.string()).optional(),
  parentId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(RESOLVE_MAX_LIMIT).optional(),
});

export type ResolveInput = z.infer<typeof resolveInputSchema>;

/** One ranked candidate in the response. */
export interface ResolveToolCandidate {
  readonly componentId: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  readonly label: string | null;
  /**
   * AUDIT-F8 — same string as {@link label}, branded as untrusted org text.
   * Prefer this over treating `label` as product prose.
   */
  readonly labelOrgText?: UntrustedOrgText;
  /**
   * Parent object's API name (e.g. the object a field lives on), or null for
   * top-level components. The qualifier that distinguishes same-named
   * candidates without parsing the canonical id — relay it to the user when
   * candidates share a name ("Email__c on Account" vs "Email__c on Contact").
   */
  readonly parentApiName: string | null;
  /** Final ranked score (similarity × type-weight × popularity). */
  readonly score: number;
  /** Pre-weight token-overlap score in [0,1] — the confidence signal. */
  readonly base: number;
  /**
   * `glossary-alias` (P13-ANNOT-glossary-resolve) marks a candidate reached
   * through a CURATED synonym (a confirmed `glossary` annotation), not
   * string similarity. Alias candidates only ever surface when the base
   * resolver found no exact api-name match — an alias never shadows one.
   */
  readonly matchKind: MatchKind | 'glossary-alias';
  readonly evidence: string;
}

const withLabelOrgText = (
  candidate: ResolveToolCandidate,
): ResolveToolCandidate => {
  const labelOrgText = brandOrgText(candidate.label);
  return labelOrgText === undefined
    ? candidate
    : { ...candidate, labelOrgText };
};

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface ResolveOutput {
  readonly disposition: ResolveDisposition;
  readonly candidates: readonly ResolveToolCandidate[];
  readonly queryTokens: readonly string[];
  /** Always 'heuristic' — resolution is similarity, never a declared fact. */
  readonly confidence: 'heuristic';
  readonly disclosure: string;
  /**
   * A ready-to-ask clarifying question when the result is `ambiguous` (one
   * option per candidate), else null. The client should present this via its
   * clarifying-question UI rather than silently picking.
   */
  readonly clarification: Clarification | null;
  /**
   * Suggested next steps the client can offer the user — e.g. `refresh` (with
   * `/sfi-refresh`) or `stop` when nothing matched, `narrow` when ambiguous.
   */
  readonly nextActions: readonly NextAction[];
  /**
   * Pass-through-ready Markdown rendering of this result (verdict line, or a
   * candidate table when ambiguous). The structured fields above remain the
   * source of truth; this is a convenience for showing a clean answer.
   */
  readonly rendered: string;
}

/** Normalization for alias equality: lowercase, alphanumerics only. */
const normalizeAlias = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * P13-ANNOT-glossary-resolve: candidates reached through CONFIRMED curated
 * glossary synonyms whose normalized value equals the normalized query.
 * Unconfirmed AI proposals never resolve; aliases pointing at ids no longer
 * in the graph are silently skipped (the orphan report owns that surface).
 */
export const resolveGlossaryAlias = async (
  ctx: Context,
  query: string,
  types: readonly ComponentType[] = [],
): Promise<readonly ResolveToolCandidate[]> => {
  const nq = normalizeAlias(query);
  if (nq.length < 2) return [];
  const glossary = (await readAnnotations(ctx.vaultRoot)).filter(
    (a) => a.key === 'glossary' && a.confirmed && normalizeAlias(a.value) === nq,
  );
  if (glossary.length === 0) return [];
  const out: ResolveToolCandidate[] = [];
  const seen = new Set<string>();
  for (const hit of glossary) {
    if (seen.has(hit.componentId)) continue;
    seen.add(hit.componentId);
    const node = await getNodeById(ctx.graph, hit.componentId as ComponentId);
    if (!node.ok || node.value === null) continue;
    const n = node.value;
    if (types.length > 0 && !types.includes(n.type)) continue;
    out.push(
      withLabelOrgText({
        componentId: n.id,
        type: n.type,
        apiName: n.apiName,
        label: n.label,
        parentApiName:
          n.parentId === null ? null : n.parentId.slice(n.parentId.indexOf(':') + 1),
        score: 1,
        base: 1,
        matchKind: 'glossary-alias',
        evidence: `glossary-alias: curated synonym "${hit.value}" (annotation by ${hit.author}, confirmed)`,
      }),
    );
  }
  return out.sort((a, b) => (a.componentId < b.componentId ? -1 : 1));
};

/**
 * The `sfi.resolve` MCP tool. Resolves messy text to ranked candidate
 * components with a disposition. See module JSDoc for the never-silently-pick
 * contract and the heuristic disclosure.
 *
 * @example
 *   const r = await resolveHandler(ctx, { query: 'wher is the emale field' });
 *   if (r.ok && r.value.data.disposition === 'exact')
 *     use(r.value.data.candidates[0].componentId);
 */
export const resolveHandler = async (
  ctx: Context,
  input: ResolveInput,
): Promise<Result<McpResponse<ResolveOutput>, McpError>> => {
  const { graphDb } = vaultPaths(ctx.vaultRoot);
  const result = await resolveComponents(ctx.graph, input.query, {
    graphDbPath: graphDb,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.types !== undefined
      ? { types: input.types as readonly ComponentType[] }
      : {}),
    ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
  });

  if (!result.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${result.error.message}`,
    });
  }

  let baseCandidates: readonly ResolveToolCandidate[] = result.value.candidates.map(
    (c) =>
      withLabelOrgText({
        componentId: c.id,
        type: c.type,
        apiName: c.apiName,
        label: c.label,
        parentApiName: c.parentApiName,
        score: c.score,
        base: c.base,
        matchKind: c.matchKind,
        evidence: c.evidence,
      }),
  );

  // P13-ANNOT-glossary-resolve: curated glossary synonyms feed resolution —
  // ONLY when the base resolver did not land an exact api-name match (an
  // alias NEVER shadows one, structurally), and ONLY from CONFIRMED
  // annotations (an unconfirmed AI proposal is not a fact). A multi-target
  // alias yields `ambiguous` + clarification, never a silent pick.
  let disposition: ResolveDisposition = result.value.disposition;
  let aliasResolution = result.value;
  if (disposition !== 'exact') {
    const alias = await resolveGlossaryAlias(ctx, input.query);
    if (alias.length > 0) {
      const aliasIds = new Set(alias.map((a) => a.componentId));
      baseCandidates = [
        ...alias,
        ...baseCandidates.filter((c) => !aliasIds.has(c.componentId)),
      ];
      disposition = alias.length === 1 ? 'exact' : 'ambiguous';
      // Re-shape for the clarification builder so an alias-ambiguous result
      // gets the standard pick-one envelope.
      aliasResolution = {
        ...result.value,
        disposition,
        candidates: [
          ...alias.map((a) => ({
            id: a.componentId,
            type: a.type,
            apiName: a.apiName,
            label: a.label,
            parentApiName: a.parentApiName,
            score: a.score,
            base: a.base,
            nameCoverage: 1,
            matchKind: 'exact' as MatchKind,
            evidence: a.evidence,
          })),
          ...result.value.candidates.filter((c) => !aliasIds.has(c.id)),
        ],
      };
    }
  }
  const candidates = baseCandidates;

  // Honesty fix (batch 8): a `none` disposition on a query SCOPED to one or
  // more metadata families whose coverage is COMPLETE is a determinate
  // negative — the component does not exist (false premise) — NOT a coverage
  // gap. Only true when `types` was supplied AND every requested type is fully
  // covered; an unscoped or partially-covered resolve stays inconclusive and
  // keeps leading with `/sfi-refresh`.
  const scopedCoverageComplete =
    disposition === 'none' &&
    input.types !== undefined &&
    input.types.length > 0 &&
    summarizeCoverage(ctx.manifest, input.types).status === 'complete';

  const clarify = buildClarify(input.query, aliasResolution, {
    refreshedAt: ctx.manifest.refreshedAt,
    scopedCoverageComplete,
  });

  const rendered = renderResolveMarkdown({
    disposition,
    candidates,
    clarification: clarify.clarification,
  });

  return ok({
    data: {
      disposition,
      candidates,
      queryTokens: result.value.queryTokens,
      confidence: 'heuristic',
      disclosure: scopedCoverageComplete
        ? `No component named "${input.query}" exists among the scoped metadata families, which have COMPLETE coverage in this vault — so this is a FALSE PREMISE (the component does not exist), not a coverage gap. Do not hedge toward "the vault did not retrieve it" or imply a refresh would surface it. ${RESOLVE_DISCLOSURE}`
        : RESOLVE_DISCLOSURE,
      clarification: clarify.clarification,
      nextActions: clarify.nextActions,
      rendered,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
