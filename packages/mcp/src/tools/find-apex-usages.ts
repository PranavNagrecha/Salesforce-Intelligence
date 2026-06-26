/**
 * Handler for the `sfi.find_apex_usages` MCP tool.
 *
 * The developer-persona twin of `sfi.find_formula_references`: a
 * sharp-focus variant of `sfi.get_impact` that answers "where is this
 * component used in Apex source?". Returns only the incoming
 * `readsFrom`/`writesTo`/`callsApex` edges whose source node is an
 * `ApexClass:*` or `ApexTrigger:*`. Flow-emitted `callsApex` edges
 * (`source: 'flow-extractor'`) are intentionally excluded — they show up
 * in the broader `sfi.get_impact` view, but they are not "Apex usages"
 * by the developer's mental model.
 *
 * Implementation notes:
 *   - One `listEdges(targetId, { direction: 'in' })` call retrieves
 *     every incoming edge regardless of type, then we filter in memory
 *     against (a) the caller's `edgeTypes` set and (b) the source node's
 *     type. The two-axis filter is what makes this an Apex-only view.
 *   - `getNodeById` resolves each `fromId` to a `Node`; sparse-graph
 *     misses are dropped silently (matches `find-formula-references`'s
 *     tolerance for half-extracted dependencies).
 *   - The output's `id`, `type`, `apiName` come from the referrer node;
 *     `edgeType`, `source`, and `properties` come from the edge. This
 *     mirrors the architect's intent in `find-formula-references`: the
 *     edge carries the producer-specific metadata
 *     (`source: 'apex-scanner'`, scanner properties like line numbers)
 *     while the node provides identity.
 *   - Sort: by `(id ASC, edgeType ASC)` for deterministic output. The
 *     edgeType tiebreaker matters because one ApexClass can have multiple
 *     edges to the same target (e.g., both `readsFrom` and `writesTo`).
 *     `limit` is applied after sorting so truncation is stable.
 *   - Empty `edgeTypes: []` is allowed by the schema (filter to nothing
 *     → empty result). This keeps the boundary predictable: omit for
 *     default-all, supply for explicit subset. See R5 spec for the
 *     design choice.
 *   - Unknown `targetId` and "target exists but has no Apex referrers"
 *     both resolve to an empty list; the graph cannot distinguish them
 *     and neither is an error.
 */

import type {
  ComponentId,
  ComponentType,
  Edge,
  EdgeType,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

/**
 * Inclusive upper bound on `limit`. Mirrors the
 * `FORMULA_REFS_MAX_LIMIT` and `LIST_MAX_LIMIT` ceilings so every
 * enumeration-style MCP tool shares the same blast-radius cap.
 */
const APEX_USAGES_MAX_LIMIT = 500;

/**
 * Default `limit` when the caller omits it. Set to 50 to match
 * `find-formula-references`'s default — real components rarely have
 * more than a handful of Apex referrers and the developer almost
 * always wants the full list rather than a paginated slice.
 */
const APEX_USAGES_DEFAULT_LIMIT = 50;

/**
 * The three edge types the v0.3 heuristic Apex scanner emits, and the
 * default `edgeTypes` set when the caller omits the parameter. Order is
 * the order the scanner declares them (`readsFrom` -> `writesTo` ->
 * `callsApex`); preserving it keeps the JSON-Schema enum diffable
 * against the contracts union.
 */
const APEX_EDGE_TYPES = [
  'readsFrom',
  'writesTo',
  'callsApex',
] as const satisfies readonly EdgeType[];

/**
 * The set of node types that count as "Apex source". A `callsApex`
 * edge from a Flow node is real and shows up in `sfi.get_impact`, but
 * it is not an Apex usage and this tool filters it out.
 */
const APEX_NODE_TYPES: ReadonlySet<ComponentType> = new Set([
  'ApexClass',
  'ApexTrigger',
]);

/**
 * Zod schema for the `sfi.find_apex_usages` tool input.
 *
 *   - `targetId`: required, non-empty string. Unknown ids surface as an
 *     empty usages list, not a Zod-level rejection.
 *   - `limit`: optional integer in `[1, 500]`. Defaults to 50 inside
 *     the handler when omitted.
 *   - `edgeTypes`: optional array whose members are restricted to the
 *     three Apex-emitted edge types. Empty array is allowed and means
 *     "filter to nothing" (the result is an empty list); omitted means
 *     "include all three". Per R5 spec, the empty case is chosen for
 *     predictable boundary semantics over a `.min(1)` rejection.
 */
export const findApexUsagesInputSchema = z.object({
  targetId: z.string().min(1),
  limit: z.number().int().min(1).max(APEX_USAGES_MAX_LIMIT).optional(),
  /**
   * Zero-based page offset (CR-13). Defaults to 0. Paired with `limit` so the
   * caller can walk the FULL usage set when the result is truncated — a
   * blast-radius tool must never silently drop referrers.
   */
  offset: z.number().int().nonnegative().optional(),
  edgeTypes: z.array(z.enum(APEX_EDGE_TYPES)).optional(),
});

/** Parsed input shape, inferred from `findApexUsagesInputSchema`. */
export type FindApexUsagesInput = z.infer<typeof findApexUsagesInputSchema>;

/**
 * One Apex referrer in the output list. Combines the source node's
 * identity (`id`, `type`, `apiName`) with the edge's metadata
 * (`edgeType`, `source`, `properties`). `edgeType` is included
 * directly on the result so callers can tell at a glance whether the
 * referrer reads, writes, or calls — saving them an extra pass through
 * `properties`.
 */
export interface ApexUsage {
  readonly id: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  readonly edgeType: EdgeType;
  readonly source: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface FindApexUsagesOutput {
  /** The requested page of usages (after sort + `offset`/`limit`). */
  readonly usages: readonly ApexUsage[];
  /** §C3 honesty: heuristic-confidence + empty≠absent disclosure (never a silent empty). */
  readonly boundaries: readonly string[];
  /**
   * CR-13 truncation honesty: the TRUE total number of Apex usages matching the
   * filters BEFORE `offset`/`limit` paging (post sparse-graph-miss and
   * `edgeTypes` filtering — i.e. every returnable referrer, not a raw edge
   * count). A `totalCount` greater than `usages.length` means the page is a
   * partial slice; the truncation note in `boundaries[]` says so explicitly.
   */
  readonly totalCount: number;
  /** Zero-based offset of this page. */
  readonly offset: number;
  /** Page size applied (the effective `limit`). */
  readonly limit: number;
  /** True when more usages remain past this page. */
  readonly hasMore: boolean;
  /** Cursor for the next page, or `null` when the list is exhausted. */
  readonly nextOffset: number | null;
}

const APEX_USAGE_HEURISTIC_DISCLOSURE =
  'Apex usages come from the parser-grade Apex pass (confidence: parsed — the default since 0.1.9, incl. field-level SOQL and constant-string Database.query) supplemented by the heuristic recall scanner. Still NOT modeled: DYNAMIC SOQL built at runtime, reflective field access (get()/put()), and string-built references. Cite the per-edge confidence; verify heuristic edges before refactoring.';
const APEX_USAGE_EMPTY_DISCLOSURE =
  'No Apex usages found in the vault — NOT proof nothing uses it. The scanner is heuristic (dynamic/reflective invisible) and managed-package code is not retrieved. Cross-check `find_component_usages` before concluding it is unused.';

/**
 * Deterministic comparator: `id` ASC, then `edgeType` ASC. The
 * tiebreaker handles the case where a single Apex class has multiple
 * incoming edge types to the same target (e.g., both `readsFrom` and
 * `writesTo` on the same field).
 */
const compareUsages = (a: ApexUsage, b: ApexUsage): number => {
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  if (a.edgeType !== b.edgeType) return a.edgeType < b.edgeType ? -1 : 1;
  return 0;
};

/**
 * Resolve one incoming edge into an `ApexUsage` when its source node is
 * an Apex class or trigger. Returns `null` for non-Apex sources
 * (intentional exclusion: Flow callers, etc.) and for sparse-graph
 * misses where `getNodeById` returns null.
 */
const resolveApexUsage = async (
  ctx: Context,
  edge: Edge,
): Promise<Result<ApexUsage | null, string>> => {
  const nodeResult = await getNodeById(ctx.graph, edge.fromId);
  if (!nodeResult.ok) {
    return err(nodeResult.error.message);
  }
  const node: Node | null = nodeResult.value;
  if (node === null) {
    return ok(null);
  }
  if (!APEX_NODE_TYPES.has(node.type)) {
    return ok(null);
  }
  return ok({
    id: node.id,
    type: node.type,
    apiName: node.apiName,
    edgeType: edge.edgeType,
    source: edge.source,
    properties: edge.properties,
  });
};

/**
 * The `sfi.find_apex_usages` MCP tool. Returns the Apex-source-only
 * incoming `readsFrom`/`writesTo`/`callsApex` edges to `targetId`,
 * each carrying the referrer node's identity and the edge's metadata.
 * Sorted by `(id, edgeType)` ASC; PAGED by `offset`/`limit` (default
 * limit 50, max 500) with `totalCount`/`hasMore`/`nextOffset` so a
 * heavily-used field's full blast radius is reachable rather than
 * silently clipped — when the page is partial a truncation note is
 * appended to `boundaries[]` (CR-13). `edgeTypes` narrows to a subset;
 * empty list yields an empty result.
 *
 * @example
 *   const r = await findApexUsagesHandler(ctx, {
 *     targetId: 'CustomField:Account.Industry__c',
 *   });
 *   if (r.ok) console.log(r.value.data.usages.length);
 */
export const findApexUsagesHandler = async (
  ctx: Context,
  input: FindApexUsagesInput,
): Promise<Result<McpResponse<FindApexUsagesOutput>, McpError>> => {
  const limit = input.limit ?? APEX_USAGES_DEFAULT_LIMIT;
  const allowedEdgeTypes: ReadonlySet<EdgeType> = new Set(
    input.edgeTypes ?? APEX_EDGE_TYPES,
  );

  const edgesResult = await listEdges(ctx.graph, input.targetId, {
    direction: 'in',
  });
  if (!edgesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${edgesResult.error.message}`,
    });
  }

  const usages: ApexUsage[] = [];
  for (const edge of edgesResult.value) {
    if (!allowedEdgeTypes.has(edge.edgeType)) {
      continue;
    }
    const resolved = await resolveApexUsage(ctx, edge);
    if (!resolved.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${resolved.error}`,
      });
    }
    if (resolved.value !== null) {
      usages.push(resolved.value);
    }
  }

  // CR-13: page after sorting so truncation is stable AND disclosed. `total`
  // is the full pre-slice count of returnable referrers — the honest blast
  // radius — and the truncation note tells the caller the page is incomplete.
  const ordered = usages.sort(compareUsages);
  const total = ordered.length;
  const offset = input.offset ?? 0;
  const page = ordered.slice(offset, offset + limit);
  const returned = offset + page.length;
  const hasMore = returned < total;

  const boundaries: string[] = [APEX_USAGE_HEURISTIC_DISCLOSURE];
  if (total === 0) {
    boundaries.push(APEX_USAGE_EMPTY_DISCLOSURE);
  }
  if (hasMore) {
    boundaries.push(
      `Showing ${page.length} of ${total} Apex usage(s) (offset=${offset}). ` +
        `MORE remain — advance with offset=${returned}. This list is ` +
        `INCOMPLETE; do not treat it as the full blast radius.`,
    );
  }

  return ok({
    data: {
      usages: page,
      boundaries,
      totalCount: total,
      offset,
      limit,
      hasMore,
      nextOffset: hasMore ? returned : null,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
