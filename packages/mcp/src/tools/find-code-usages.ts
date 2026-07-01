/**
 * Handler for the `sfi.find_code_usages` MCP tool.
 *
 * The v1.4 broadening of `sfi.find_apex_usages`: same incoming-edge
 * shape, same per-edge metadata, but the set of node types that count
 * as "code" is expanded to include the v1.4 frontend tier
 * (`LightningComponentBundle`, `AuraDefinitionBundle`,
 * `VisualforcePage`, `VisualforceComponent`) alongside the original
 * `ApexClass` and `ApexTrigger`. The tool also accepts the
 * `references` edge type because LWC/Aura/VF extractors emit
 * `references` edges to other components in addition to the
 * `readsFrom`/`writesTo`/`callsApex` triad the Apex scanner emits.
 *
 * `sfi.find_apex_usages` is retained as a strictly-Apex view; callers
 * that want the broader code persona's answer ("what touches this from
 * code anywhere?") use `find_code_usages` and optionally narrow with
 * `nodeTypes` (e.g., `nodeTypes: ['LightningComponentBundle']` for
 * "what LWC components touch this field?").
 *
 * Implementation notes:
 *   - One `listEdges(targetId, { direction: 'in' })` call retrieves
 *     every incoming edge regardless of type, then we filter in memory
 *     against (a) the caller's `edgeTypes` set, (b) the caller's
 *     optional `nodeTypes` set, and (c) the canonical
 *     `CODE_NODE_TYPES` set. The three-axis filter is what makes this a
 *     code-persona view: Flow-emitted `callsApex` edges from a Flow
 *     node are still excluded (Flow is not in CODE_NODE_TYPES) and
 *     non-code referrers like Profile or Layout never appear.
 *   - `getNodeById` resolves each `fromId` to a `Node`; sparse-graph
 *     misses are dropped silently (matches `find-apex-usages`'s
 *     tolerance for half-extracted dependencies).
 *   - The output's `id`, `type`, `apiName` come from the referrer node;
 *     `edgeType`, `source`, and `properties` come from the edge. This
 *     mirrors the architect's intent in `find-apex-usages`: the edge
 *     carries the producer-specific metadata (`source: 'apex-scanner'`,
 *     `source: 'lwc-aura-vf-scanner'`, etc., scanner properties like
 *     line numbers) while the node provides identity.
 *   - Sort: by `(id ASC, edgeType ASC)` for deterministic output. The
 *     edgeType tiebreaker matters because one LWC bundle can have
 *     multiple edges to the same target (e.g., a `references` edge
 *     from an `@salesforce/apex` import alongside a `readsFrom` from a
 *     field reference). `limit` is applied after sorting so truncation
 *     is stable.
 *   - Empty `edgeTypes: []` and empty `nodeTypes: []` are both allowed
 *     by the schema (filter to nothing → empty result). This keeps the
 *     boundary predictable: omit for default-all, supply for explicit
 *     subset. Matches the v0.3 `find-apex-usages` design choice.
 *   - Unknown `targetId` and "target exists but has no code referrers"
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
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  buildEmptyTraversalCoverageCaveat,
  CODE_USAGE_REQUIRED_COVERAGE,
  type CoverageCaveat,
} from './coverage-trust.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';

const FIND_CODE_USAGES_TOOL = 'sfi.find_code_usages';

/**
 * Inclusive upper bound on `limit`. Mirrors `find-apex-usages`'s
 * `APEX_USAGES_MAX_LIMIT` and the other enumeration-style MCP tools so
 * every developer-persona tool shares the same blast-radius cap.
 */
const CODE_USAGES_MAX_LIMIT = 500;

/**
 * Default `limit` when the caller omits it. Set to 50 to match the
 * `find-apex-usages` default — code referrers, even with LWC/Aura/VF
 * folded in, rarely number more than a handful per target and the
 * developer almost always wants the full list rather than a paginated
 * slice.
 */
const CODE_USAGES_DEFAULT_LIMIT = 50;

/**
 * The four edge types the code-persona scanners emit and the default
 * `edgeTypes` set when the caller omits the parameter. Order matches
 * the contracts `EdgeType` union ordering for the code-relevant
 * subset; preserving it keeps the JSON-Schema enum diffable against
 * the contracts union.
 *
 * v1.4 broadens beyond `find-apex-usages`'s triad to include
 * `references`. LWC bundles emit `references` from the bundle to other
 * components (e.g., `<c-child-component>` tag usage); Aura bundles
 * emit `references` from the bundle to other Aura/LWC components in
 * the markup; VF pages and components emit `references` to their
 * controller/extension `ApexClass` (declared) plus to fields they
 * touch (heuristic). All four producers also emit the existing
 * `readsFrom`/`writesTo`/`callsApex` triad where applicable.
 */
const CODE_EDGE_TYPES = [
  'readsFrom',
  'writesTo',
  'callsApex',
  'references',
] as const satisfies readonly EdgeType[];

/**
 * The set of node types that count as "code source" for the v1.4
 * code-persona view. The original `ApexClass`/`ApexTrigger` pair from
 * v0.3 is extended with the v1.4 frontend tier:
 * `LightningComponentBundle`, `AuraDefinitionBundle`,
 * `VisualforcePage`, and `VisualforceComponent`.
 *
 * Flow-emitted `callsApex` edges are still real and still show up in
 * `sfi.get_impact`, but Flow is intentionally NOT in this set: the
 * developer's mental model of "code" excludes declarative automation.
 * Callers who want the full incoming picture use `sfi.get_impact`.
 *
 * Declared as a `const` tuple (rather than a `Set` literal) so the
 * Zod `nodeTypes` enum below gets a non-empty tuple type without an
 * unsafe cast. `CODE_NODE_TYPES` (below) re-projects it as a `Set`
 * for O(1) membership checks in the handler.
 */
const CODE_NODE_TYPES_LIST = [
  'ApexClass',
  'ApexTrigger',
  'LightningComponentBundle',
  'AuraDefinitionBundle',
  'VisualforcePage',
  'VisualforceComponent',
] as const satisfies readonly ComponentType[];

/**
 * O(1) membership-check projection of `CODE_NODE_TYPES_LIST`. Used by
 * `resolveCodeUsage` to filter out non-code source nodes (Flow,
 * Profile, Layout, etc.) before the optional caller-supplied
 * `nodeTypes` narrowing.
 */
const CODE_NODE_TYPES: ReadonlySet<ComponentType> = new Set(
  CODE_NODE_TYPES_LIST,
);

/**
 * Zod schema for the `sfi.find_code_usages` tool input.
 *
 *   - `targetId`: required, non-empty string. Unknown ids surface as an
 *     empty usages list, not a Zod-level rejection.
 *   - `limit`: optional integer in `[1, 500]`. Defaults to 50 inside
 *     the handler when omitted.
 *   - `edgeTypes`: optional array whose members are restricted to the
 *     four code-emitted edge types. Empty array is allowed and means
 *     "filter to nothing" (the result is an empty list); omitted means
 *     "include all four". Matches the `find-apex-usages` design
 *     choice: empty array for predictable boundary semantics over a
 *     `.min(1)` rejection.
 *   - `nodeTypes`: optional array whose members are restricted to the
 *     six code node types. Empty array is allowed and means "filter to
 *     nothing"; omitted means "include all six". Lets callers narrow
 *     to a single producer (e.g., `['LightningComponentBundle']` for
 *     "what LWC bundles touch this field?").
 */
export const findCodeUsagesInputSchema = z.object({
  targetId: z.string().min(1),
  limit: z.number().int().min(1).max(CODE_USAGES_MAX_LIMIT).optional(),
  // CR-22: page offset + continuation cursor for walking the full usage set
  // when the result is truncated. Omit for today's behavior.
  offset: z.number().int().nonnegative().optional(),
  cursor: z.string().min(1).optional(),
  edgeTypes: z.array(z.enum(CODE_EDGE_TYPES)).optional(),
  nodeTypes: z.array(z.enum(CODE_NODE_TYPES_LIST)).optional(),
});

/** Parsed input shape, inferred from `findCodeUsagesInputSchema`. */
export type FindCodeUsagesInput = z.infer<typeof findCodeUsagesInputSchema>;

/**
 * One code referrer in the output list. Combines the source node's
 * identity (`id`, `type`, `apiName`) with the edge's metadata
 * (`edgeType`, `source`, `properties`). `edgeType` is included
 * directly on the result so callers can tell at a glance whether the
 * referrer reads, writes, calls, or references — saving them an extra
 * pass through `properties`. `type` will be one of `CODE_NODE_TYPES`.
 */
export interface CodeUsage {
  readonly id: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  readonly edgeType: EdgeType;
  readonly source: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface FindCodeUsagesOutput {
  readonly usages: readonly CodeUsage[];
  /** §C3 honesty: heuristic-confidence + empty≠absent disclosure (never a silent empty). */
  readonly boundaries: readonly string[];
  /**
   * I3b (empty ≠ none): present ONLY when the FULL result is empty AND a code
   * family (Apex / LWC / Aura / Visualforce) that would produce a usage edge is
   * NOT fully covered by the vault. Names the not-checked families so an empty
   * usage list reads "not retrieved", not a proven "none". Absent on a
   * non-empty result and on a fully-covered vault (byte-identical to before).
   */
  readonly coverageCaveat?: CoverageCaveat;
  /**
   * Page size applied to this response. Present ONLY on a PAGED response
   * (`hasMore` or a resumed `offset > 0`); omitted on a whole-fits no-cursor
   * call so that response stays byte-identical to the pre-CR-22 shape
   * (`{ usages, boundaries }`).
   */
  readonly limit?: number;
  /** Zero-based offset of this page. Present only when paged (see `limit`). */
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

const CODE_USAGE_HEURISTIC_DISCLOSURE =
  'Apex referrers come from the parser-grade Apex pass (confidence: parsed — the default since 0.1.9) plus the heuristic recall scanner; frontend referrers from the heuristic LWC/Aura/VF scanner. Still NOT modeled as edges: DYNAMIC SOQL built at runtime, reflective field access (`get()`/`put()`), LWC `record[fieldName]` dynamic access, and string-built references. Confidence per edge is on each usage; verify heuristic edges before acting.';
const CODE_USAGE_EMPTY_DISCLOSURE =
  'No code usages found in the vault — this is NOT proof that no code uses it. The scanner is heuristic (dynamic/reflective references are invisible) and managed-package code is not retrieved. Cross-check `find_component_usages` (graph + grep) before concluding it is unused.';

/**
 * Deterministic TOTAL-ORDER comparator: `id` ASC, `edgeType` ASC, then
 * `source` ASC. The `(id, edgeType)` keys handle a single code referrer with
 * multiple incoming edge types to the same target (e.g., an LWC bundle with both
 * a `references` edge from an `@salesforce/apex` import and a `readsFrom` from a
 * static field reference in a `getRecord` wire). The `source` tiebreak (CR-22)
 * makes the order UNIQUE: the edge PK is `(from_id, to_id, edge_type, source)`,
 * and here `from_id` = `id`, `to_id` = the fixed `targetId`, `edge_type` =
 * `edgeType`, so within a fixed `(id, edgeType)` only `source` can differ (the
 * same referrer's same edge type from two scanners) — adding it guarantees a
 * unique final key so an offset resume cannot dup or skip.
 */
const compareUsages = (a: CodeUsage, b: CodeUsage): number => {
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  if (a.edgeType !== b.edgeType) return a.edgeType < b.edgeType ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return 0;
};

/**
 * Resolve one incoming edge into a `CodeUsage` when its source node is
 * one of `CODE_NODE_TYPES` and its type passes the caller's optional
 * `nodeTypes` filter. Returns `null` for non-code sources (intentional
 * exclusion: Flow, Profile, Layout, etc.) and for sparse-graph misses
 * where `getNodeById` returns null.
 */
const resolveCodeUsage = async (
  ctx: Context,
  edge: Edge,
  allowedNodeTypes: ReadonlySet<ComponentType>,
): Promise<Result<CodeUsage | null, string>> => {
  const nodeResult = await getNodeById(ctx.graph, edge.fromId);
  if (!nodeResult.ok) {
    return err(nodeResult.error.message);
  }
  const node: Node | null = nodeResult.value;
  if (node === null) {
    return ok(null);
  }
  if (!CODE_NODE_TYPES.has(node.type)) {
    return ok(null);
  }
  if (!allowedNodeTypes.has(node.type)) {
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
 * The `sfi.find_code_usages` MCP tool. Returns the code-only incoming
 * `readsFrom`/`writesTo`/`callsApex`/`references` edges to `targetId`,
 * each carrying the referrer node's identity and the edge's metadata.
 * Sorted by `(id, edgeType)` ASC; truncated to `limit` (default 50,
 * max 500). `edgeTypes` and `nodeTypes` each narrow to a subset; empty
 * arrays yield an empty result.
 *
 * Broader-than-`sfi.find_apex_usages`: the source node may be any of
 * `ApexClass`, `ApexTrigger`, `LightningComponentBundle`,
 * `AuraDefinitionBundle`, `VisualforcePage`, `VisualforceComponent`.
 *
 * @example
 *   const r = await findCodeUsagesHandler(ctx, {
 *     targetId: 'CustomField:Account.Industry__c',
 *     nodeTypes: ['LightningComponentBundle'],
 *   });
 *   if (r.ok) console.log(r.value.data.usages.length);
 */
export const findCodeUsagesHandler = async (
  ctx: Context,
  input: FindCodeUsagesInput,
): Promise<Result<McpResponse<FindCodeUsagesOutput>, McpError>> => {
  const limit = input.limit ?? CODE_USAGES_DEFAULT_LIMIT;
  const allowedEdgeTypes: ReadonlySet<EdgeType> = new Set(
    input.edgeTypes ?? CODE_EDGE_TYPES,
  );
  const allowedNodeTypes: ReadonlySet<ComponentType> = new Set(
    input.nodeTypes ?? CODE_NODE_TYPES_LIST,
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

  const usages: CodeUsage[] = [];
  for (const edge of edgesResult.value) {
    if (!allowedEdgeTypes.has(edge.edgeType)) {
      continue;
    }
    const resolved = await resolveCodeUsage(ctx, edge, allowedNodeTypes);
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

  const ordered = usages.sort(compareUsages);

  // CR-22: resolve the resume offset (echoed cursor wins over explicit offset);
  // a stale/forged cursor (changed targetId/edgeTypes/nodeTypes, different tool,
  // or refreshed vault) is rejected with invalid-query. nodeTypes MUST be in the
  // fingerprint — it narrows the result set, so a token minted for one nodeTypes
  // filter must not replay against another.
  const fingerprint = argsFingerprint({
    targetId: input.targetId,
    ...(input.edgeTypes !== undefined ? { edgeTypes: input.edgeTypes } : {}),
    ...(input.nodeTypes !== undefined ? { nodeTypes: input.nodeTypes } : {}),
  });
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: FIND_CODE_USAGES_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  // No per-handler byte budget (offset/limit only) — matches the B1 twin
  // find_apex_usages; the global jsonResult guard remains the byte backstop.
  const paged = paginateLegacy(ordered, {
    offset,
    limit,
    byteBudget: Number.MAX_SAFE_INTEGER,
    binding: {
      tool: FIND_CODE_USAGES_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const page = paged.items;
  const truncated = paged.hasMore;
  const emitCursor = paged.nextCursor !== null;
  // Diverges from the B1 twin's always-on emit shape: find_code_usages today
  // emits ONLY { usages, boundaries }, so paging fields are spread CONDITIONALLY
  // (only when truncated OR resumed) to keep a whole-fits no-cursor call
  // byte-identical to pre-CR-22.
  const isPaged = truncated || offset > 0;

  // The empty-disclosure is keyed on the FULL result count (paged.totalCount),
  // not the page, so a non-first page that happens to be empty still discloses
  // honestly and a target with usages never trips the empty note mid-walk.
  // I3b (empty ≠ none): on an empty FULL result also name the code families the
  // vault did NOT fully retrieve, so "no code uses this" carries "…among the
  // families the vault covers". Non-empty output is untouched.
  const coverageCaveat =
    paged.totalCount === 0
      ? buildEmptyTraversalCoverageCaveat(ctx, CODE_USAGE_REQUIRED_COVERAGE)
      : undefined;
  const boundaries =
    paged.totalCount === 0
      ? [
          CODE_USAGE_HEURISTIC_DISCLOSURE,
          CODE_USAGE_EMPTY_DISCLOSURE,
          ...(coverageCaveat !== undefined ? [coverageCaveat.message] : []),
        ]
      : [CODE_USAGE_HEURISTIC_DISCLOSURE];

  return ok({
    data: {
      usages: page,
      boundaries,
      ...(isPaged ? { limit, offset } : {}),
      ...(truncated ? { nextOffset: offset + page.length } : {}),
      ...(emitCursor
        ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo }
        : {}),
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
