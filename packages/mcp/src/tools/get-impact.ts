/**
 * Handler for the `sfi.get_impact` MCP tool.
 *
 * Answers the architect's "what breaks if I change this component?"
 * question. Walks BFS from `componentId`, following INCOMING edges only
 * — the OPPOSITE direction from `getSubgraph`, which walks both. The
 * result is the slice of nodes and edges that *depend on* the target.
 *
 * GET-IMPACT-PARENT-FANIN-BLEED: the walk RECORDS an incoming `parentOf`
 * edge (so the structural parent object is visible in the slice) but never
 * EXPANDS through it. `parentOf` is structural containment (object → its
 * field / QuickAction / RecordType), not a dependency; expanding it would
 * cross up to the parent object and mint the OBJECT's referrers (Apex,
 * triggers, inbound lookups) as false dependents of the child. A
 * QuickAction whose only inbound edge is its parent object therefore
 * returns an empty-dependent slice with a structural-parent disclosure,
 * not the object's fan-in.
 *
 * Implementation notes:
 *   - Each hop expands the frontier with ONE batched
 *     `listEdgesForNodes(frontier, { direction: 'in', edgeTypes })`
 *     query (CR-17 — was one `listEdges` call per node × edgeType, an
 *     N+1 loop). The returned per-node buckets are then replayed in the
 *     SAME visit order the row-at-a-time loop used (frontier order, then
 *     `edgeTypes ?? [null]` order) so the cap/dedup/next-frontier logic
 *     is byte-for-byte preserved. The graph layer has no direct
 *     multi-hop incoming-only traversal, so the dispatcher composes the
 *     walk here.
 *   - On a cap hit the surviving prefix is the lowest edges by
 *     `(toId, edgeType, fromId, source)` within each `(node, edgeType)`
 *     group — `listEdgesForNodes` pins that total order, whereas the old
 *     per-`listEdges` path left the intra-group order DuckDB-unspecified.
 *     The cap-identity test in `get-impact.test.ts` is the contract for
 *     this pinned prefix.
 *   - Unknown `componentId` is REFUSED with `component-not-found`
 *     (GET-IMPACT-UNKNOWN-ID-READS-AS-SAFE). It previously resolved to
 *     `ok({ impact: { nodes: [], edges: [] } })` with the disclosure
 *     "Complete impact slice … 0 node(s) / 0 edge(s)" on the claim that the
 *     graph "cannot distinguish a missing component from one with no incoming
 *     edges" — which is untrue: `getNodeById` plus an unfiltered inbound-edge
 *     probe separates them exactly, as `sfi.find_component_usages` already
 *     does. A typo therefore read as a proven "nothing breaks". A PHANTOM root
 *     (no node row but referenced by inbound edges) still answers from those
 *     edges, disclosed in the `disclosure`.
 *   - Sort: nodes by id ASC, edges by `(fromId, toId, edgeType,
 *     source)` — matches `getSubgraph`'s deterministic output so
 *     consumer fixtures can share comparison logic across tools.
 */

import {
  EDGE_TYPES,
  UNPRODUCED_EDGE_TYPES,
  type ComponentId,
  type Edge,
  type EdgeType,
  type McpError,
  type McpResponse,
  type Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  getNodeById,
  listEdges,
  listEdgesForNodes,
  listNodesByIds,
} from '@sf-intelligence/graph';
import { buildSafeMermaidIdMap, safeMermaidLabel } from '@sf-intelligence/renderers';
import { z } from 'zod';

import type { Context } from '../server.js';

import { isUnresolvedApexCallTarget, isUnresolvedFieldReceiver } from './apex-receiver.js';
import {
  buildEmptyTraversalCoverageCaveat,
  type CoverageCaveat,
  GRAPH_TRAVERSAL_REQUIRED_COVERAGE,
} from './coverage-trust.js';
import {
  enforceGraphPayloadBudget,
  estimateGraphPayloadBytes,
  GRAPH_MAX_PAYLOAD_BYTES,
  slimGraphNodes,
} from './graph-payload-bounds.js';
import {
  formatNamedUsageClause,
  reportDashboardUsageDetail,
  type ReportDashboardUsageDetail,
} from './report-dashboard-usage.js';
import { soundnessForImpactWalk, type Soundness } from './soundness.js';

/**
 * Inclusive upper bound on `hops`. Mirrors `getSubgraph`'s ceiling so
 * the two architect-facing traversal tools share the same blast-radius
 * cap; drift between this constant and `SUBGRAPH_MAX_HOPS` in
 * `get-subgraph.ts` is a code-review concern.
 */
const IMPACT_MAX_HOPS = 3;

/**
 * Default `hops` when the caller omits the parameter. Set to 2 (not 1,
 * like `get_subgraph`) because the architect persona almost always
 * wants to see the transitive dependents — a flow that references a
 * validation rule that reads a field, for example.
 */
const IMPACT_DEFAULT_HOPS = 2;

/** Mirrors `getSubgraph` caps so architect-facing traversal tools share blast-radius limits. */
const IMPACT_MAX_NODES = 200;
const IMPACT_MAX_EDGES = 400;

/**
 * Payload-size comfort threshold mirrored from `graph.getSubgraph`'s design
 * note (~200 nodes + ~400 edges ≈ ~250 KB). Count caps alone do not bound
 * JSON size when Profile/PermissionSet grantedBy edges dominate.
 */
const IMPACT_COMFORT_PAYLOAD_BYTES = 250_000;

/**
 * R6-19: node cap for the `diagram` mermaid fence — deliberately much
 * smaller than `IMPACT_MAX_NODES` (200). A 200-box `graph TD` is unreadable
 * in a chat UI or a rendered HTML page; above this cap the diagram is
 * OMITTED (never silently truncated to a partial, misleadingly-complete
 * picture) and `diagramOmittedReason` names the actual node count.
 */
const IMPACT_DIAGRAM_MAX_NODES = 30;

/**
 * Zod schema for the `sfi.get_impact` tool input.
 *
 *   - `componentId`: required, non-empty string. Unknown ids surface
 *     as an empty impact set, not a Zod-level rejection.
 *   - `hops`: optional integer in `[1, 3]`. Defaults to 2 inside the
 *     handler when omitted. Values outside the range are rejected here.
 *   - `edgeTypes`: optional array of `EdgeType` values. When set, the
 *     walk only follows incoming edges whose type is in the array.
 */
export const getImpactInputSchema = z.object({
  componentId: z.string().min(1),
  hops: z.number().int().min(1).max(IMPACT_MAX_HOPS).optional(),
  edgeTypes: z.array(z.enum(EDGE_TYPES)).optional(),
});

/** Parsed input shape, inferred from `getImpactInputSchema`. */
export type GetImpactInput = z.infer<typeof getImpactInputSchema>;

/**
 * Payload wrapped inside the `McpResponse` envelope on success.
 *
 *   - `impact.nodes`: every node touched by the walk, including the
 *     root if it exists. Sorted by id ASC.
 *   - `impact.edges`: every incoming edge visited during the walk,
 *     deduped on `(fromId, toId, edgeType, source)`. Sorted by the same
 *     tuple.
 *   - `traversedEdgeTypes`: the distinct edge types the WALK followed.
 *     GET-IMPACT-TRUNCATION-DROPS-FAMILIES: this is the walk's reach, NOT
 *     the returned slice's contents — the count caps and the byte budget can
 *     drop every edge of a type the walk did follow, so a type listed here
 *     may have ZERO rows in `impact.edges`. When `truncated` is true, read
 *     `truncationReason.omittedEdgeTypes` /
 *     `truncationReason.omittedReferrerTypes` for the families that were
 *     found and then cut. Sorted alphabetically.
 */
export interface GetImpactOutput {
  readonly impact: {
    readonly nodes: readonly Node[];
    readonly edges: readonly Edge[];
  };
  readonly traversedEdgeTypes: readonly EdgeType[];
  readonly truncated: boolean;
  /**
   * Structured truncation detail — present iff `truncated`. Promotes the
   * caveat out of the prose `disclosure` so a caller reading the summary
   * (not the disclosure string) still learns the impact slice is partial,
   * why, and how to widen it.
   */
  readonly truncationReason?: {
    readonly reason: 'node-cap' | 'edge-cap' | 'payload-budget' | 'dropped-endpoint';
    readonly nodeCap: number;
    readonly edgeCap: number;
    readonly payloadByteBudget: number;
    readonly returnedNodes: number;
    readonly returnedEdges: number;
    /**
     * GET-IMPACT-TRUNCATION-DROPS-FAMILIES: how many nodes/edges the walk
     * actually collected BEFORE the caps and the byte budget cut it down.
     * Without these, `returnedEdges: 18` on a hub with 234 inbound edges reads
     * like a complete answer with a generic `truncated` flag.
     */
    readonly walkedNodes: number;
    readonly walkedEdges: number;
    /**
     * Edge types the walk followed that have ZERO rows left in `impact.edges`.
     * Trimming is by component-id ORDER (`enforceGraphPayloadBudget` drops the
     * id-sorted TAIL), so it removes whole alphabetically-late families rather
     * than a proportional sample — every `Flow:`/`ValidationRule:`/`WebLink:`
     * referrer can vanish while every `ApexClass:` referrer survives. Empty
     * when nothing was lost by family.
     */
    readonly omittedEdgeTypes: readonly string[];
    /**
     * Referrer component-type prefixes the walk found that have ZERO rows left
     * in `impact.edges` — the "which families disappeared" axis of the same
     * order-biased trim. Re-query with `edgeTypes` narrowed to one of these to
     * see it.
     */
    readonly omittedReferrerTypes: readonly string[];
    readonly remedy: string;
  };
  /**
   * GET-IMPACT-DROPPED-ENDPOINT-EDGE-LOSS: present ONLY when ≥1 collected edge
   * was removed from `impact.edges` because an ENDPOINT is absent from
   * `impact.nodes`. The shared `enforceGraphPayloadBudget` filters every such
   * edge (rightly — a consumer must not deref a missing node), but the removal
   * was invisible: `truncated` stayed false and the disclosure still opened
   * "Complete impact slice". Two distinct causes, kept separate because the
   * remedies differ:
   *
   *   - `phantomEndpointCount` — the id was requested but has NO node row (a
   *     PHANTOM: referenced by edges, never retrieved — typically a standard or
   *     managed-package component). A PHANTOM ROOT loses ITS WHOLE DEPENDENT
   *     SET this way. Measured on a real vault: an impact walk on a phantom
   *     standard object returned `14 node(s) / 0 edge(s)`, `truncated: false`,
   *     "Complete impact slice" — 14 granting containers with nothing
   *     connecting them to anything.
   *   - `nodeCapExcludedCount` — the walk admitted the EDGE and only then hit
   *     the 200-node cap, so the endpoint was never requested. Measured: a hub
   *     object's slice carried one such edge whose Flow referrer is fully
   *     present in the vault.
   *
   * Either way the dropped edges are REAL references;
   * `sfi.find_component_usages` (no node join) enumerates them.
   */
  readonly droppedEndpointEdges?: {
    readonly count: number;
    /** Endpoint requested but no node row exists — a true phantom. */
    readonly phantomEndpointCount: number;
    /** Endpoint never requested because the node cap closed first. */
    readonly nodeCapExcludedCount: number;
    /** Distinct missing endpoint ids, sorted, capped at 25. */
    readonly endpointIds: readonly string[];
    readonly note: string;
  };
  /** True when ≥1 node had an oversized property value summarised to bound payload. */
  readonly payloadSlimmed: boolean;
  /** UTF-8 byte length of `JSON.stringify(impact)` — the slice the caller receives. */
  readonly estimatedPayloadBytes: number;
  /** Static-analysis blind spots: `complete: false` when an impacted class uses dynamic Apex. */
  readonly soundness: Soundness;
  /**
   * I3b (empty ≠ none): present ONLY when the impact slice found NO dependents
   * (`impact.edges` is empty) AND a dependency family that would produce an
   * inbound edge is NOT fully covered by the vault. Names the not-checked
   * families so an empty impact reads "not retrieved", not a proven "nothing
   * depends on this". Absent when dependents exist or the vault is fully covered
   * (byte-identical to before).
   */
  readonly coverageCaveat?: CoverageCaveat;
  /**
   * Present ONLY when `edgeTypes` named a type no extractor produces
   * (`UNPRODUCED_EDGE_TYPES`). Distinct from `coverageCaveat`: that reports a
   * family THIS VAULT did not retrieve, which a refresh can close. This one
   * cannot be closed by any refresh on any org.
   */
  readonly unproducedEdgeTypes?: string;
  readonly disclosure: string;
  /**
   * R6-19: a ```` ```mermaid graph TD ``` ```` fence visualizing the impact
   * slice — nodes labeled `{ComponentType}: {apiName}` (the root rendered as
   * a circle, everything else a box), edges labeled by `edgeType`. Present
   * ONLY when `impact.nodes.length` is at or under `IMPACT_DIAGRAM_MAX_NODES`
   * (30); see `diagramOmittedReason` when absent. Mirrors the already-capped
   * `impact.nodes`/`impact.edges` — never a separate, uncapped query.
   */
  readonly diagram?: string;
  /**
   * Present ONLY when `diagram` is omitted because `impact.nodes.length`
   * exceeded `IMPACT_DIAGRAM_MAX_NODES`. Names the actual count so a caller
   * knows how far over the cap the slice is (fewer `hops` / a narrower
   * `edgeTypes` would bring it back under).
   */
  readonly diagramOmittedReason?: string;
  /**
   * R6-24 Option B / Finding #36: when the root is a `CustomField` whose
   * refresh fold stamped capped report/dashboard name lists (`usedInReports` /
   * `usedInDashboards`), surface those names here. Report/Dashboard nodes are
   * dropped at refresh (volume), so they never appear as graph edges in
   * `impact` — without this field, "which reports break?" is unanswerable
   * from `get_impact` alone. Absent when the root is not a field, or the
   * field has no folded analytics usage (including pre-#36 vaults that only
   * carry the boolean flags — then `reportNames`/`dashboardNames` are empty
   * and callers should fall back to boolean phrasing).
   */
  readonly reportUsage?: ReportDashboardUsageDetail;
}

/**
 * Comparator for the deterministic edge sort. Lifted from
 * `get-subgraph.ts`'s shape so the two tools emit byte-identical edge
 * orderings for overlapping inputs.
 */
const compareEdges = (a: Edge, b: Edge): number => {
  if (a.fromId !== b.fromId) return a.fromId < b.fromId ? -1 : 1;
  if (a.toId !== b.toId) return a.toId < b.toId ? -1 : 1;
  if (a.edgeType !== b.edgeType) return a.edgeType < b.edgeType ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return 0;
};

/**
 * Composite key for edge deduplication. `\0` never appears in any
 * `ComponentId` (which uses only `:` and `.`), so the join is
 * unambiguous.
 */
const edgeKey = (e: Edge): string =>
  `${e.fromId}\0${e.toId}\0${e.edgeType}\0${e.source}`;

/** Split a canonical id into its `{Type}` prefix and the rest, for a diagram label. */
const describeId = (id: string): { readonly typePrefix: string; readonly rest: string } => {
  const colon = id.indexOf(':');
  return colon === -1 ? { typePrefix: '', rest: id } : { typePrefix: id.slice(0, colon), rest: id.slice(colon + 1) };
};

/**
 * R6-19: build the ```` ```mermaid graph TD ``` ```` fence for the (already
 * capped) impact slice. Declares every node first (root as a circle,
 * everything else a box, labeled `{ComponentType}: {apiName}`), then every
 * edge as a bare `code -->|edgeType| code` line — the same two-pass shape
 * `generate_architecture_overview`'s existing diagrams use. Node ids come
 * from a collision-safe sanitizer (`@sf-intelligence/renderers`) since
 * canonical component ids carry `:` and `.`, neither mermaid-identifier-safe.
 *
 * `nodes`/`edges` are the FINAL, already-budgeted slice the caller is about
 * to return — the diagram never re-queries or widens beyond what the JSON
 * payload itself contains.
 */
const buildImpactDiagram = (
  nodes: readonly Node[],
  edges: readonly Edge[],
  rootId: ComponentId,
): string => {
  const nodeById = new Map<string, Node>();
  for (const n of nodes) nodeById.set(n.id, n);

  // Dangling edge endpoints (a target with no corresponding Node row) still
  // need a diagram box — collect every id that appears anywhere.
  const allIds = new Set<string>();
  for (const n of nodes) allIds.add(n.id);
  for (const e of edges) {
    allIds.add(e.fromId);
    allIds.add(e.toId);
  }
  const sortedIds = [...allIds].sort();
  const idMap = buildSafeMermaidIdMap(sortedIds);

  const lines: string[] = ['```mermaid', 'graph TD'];
  for (const id of sortedIds) {
    const code = idMap.get(id);
    if (code === undefined) continue;
    const node = nodeById.get(id);
    const { typePrefix, rest } = describeId(id);
    const labelName = node !== undefined ? node.apiName : rest;
    const label = safeMermaidLabel(`${typePrefix}: ${labelName}`);
    const shape = id === rootId ? `(("${label}"))` : `["${label}"]`;
    lines.push(`    ${code}${shape}`);
  }
  for (const edge of edges) {
    const fromCode = idMap.get(edge.fromId);
    const toCode = idMap.get(edge.toId);
    if (fromCode === undefined || toCode === undefined) continue;
    lines.push(`    ${fromCode} -->|${edge.edgeType}| ${toCode}`);
  }
  lines.push('```');
  return lines.join('\n');
};

/** Human-readable payload size for disclosure text. */
const formatPayloadSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `~${Math.round(bytes / 1024)} KB`;
  return `~${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * Name the dominant payload contributors when security-grant edges or
 * permission-container nodes inflate an otherwise count-capped slice.
 */
const describePayloadHeavyContributors = (
  nodes: readonly Node[],
  edges: readonly Edge[],
): string | null => {
  let grantedByCount = 0;
  let profileCount = 0;
  let permSetCount = 0;
  for (const edge of edges) {
    if (edge.edgeType === 'grantedBy') grantedByCount++;
  }
  for (const node of nodes) {
    if (node.type === 'Profile') profileCount++;
    else if (node.type === 'PermissionSet') permSetCount++;
  }
  const parts: string[] = [];
  if (grantedByCount > 0) {
    parts.push(
      `${grantedByCount} grantedBy edge(s) (Profile/PermissionSet permission matrices)`,
    );
  }
  if (profileCount > 0 && grantedByCount === 0) {
    parts.push(`${profileCount} Profile node(s)`);
  }
  if (permSetCount > 0 && grantedByCount === 0) {
    parts.push(`${permSetCount} PermissionSet node(s)`);
  }
  return parts.length > 0 ? parts.join('; ') : null;
};

/**
 * R6-24 Option B: prose clause naming folded report/dashboard dependents.
 * Empty when the root has no folded analytics usage (or only pre-#36 booleans
 * with empty name lists — then we still disclose the boolean-only signal).
 */
const formatFoldedReportUsageNote = (
  detail: ReportDashboardUsageDetail | undefined,
): string => {
  if (detail === undefined) return '';
  if (!detail.usedInReport && !detail.usedInDashboard) return '';
  const where = [
    detail.usedInReport
      ? formatNamedUsageClause(
          'report(s)',
          detail.reportNames,
          detail.reportsTruncatedTotal,
        )
      : null,
    detail.usedInDashboard
      ? formatNamedUsageClause(
          'dashboard(s)',
          detail.dashboardNames,
          detail.dashboardsTruncatedTotal,
        )
      : null,
  ].filter((x): x is string => x !== null);
  const hasNames =
    detail.reportNames.length > 0 || detail.dashboardNames.length > 0;
  if (!hasNames) {
    return (
      ' Folded report/dashboard usage is present as a field property' +
      ' (boolean only — names need a re-refresh); Report/Dashboard nodes are' +
      ' not kept as graph edges.'
    );
  }
  return (
    ` Also depends on folded ${where.join(' and ')}` +
    ' (capped name lists on the field — Report/Dashboard nodes are dropped at' +
    ' refresh to avoid graph bloat, so they do not appear as impact edges).'
  );
};

/**
 * GET-IMPACT-TRUNCATION-DROPS-FAMILIES: name the referrer families the walk
 * FOUND and the response then dropped. `enforceGraphPayloadBudget` trims the
 * id-sorted TAIL, so truncation is not a proportional sample — it deletes whole
 * alphabetically-late families. Measured on a real vault: a hub object's walk
 * collected 6 referrer families and the returned slice held only `ApexClass`;
 * every `Flow` / `ValidationRule` / `WebLink` dependent was gone while
 * `truncated: true` said nothing about WHICH dependents vanished.
 */
const formatOmittedFamilyNote = (params: {
  readonly returnedEdges: number;
  readonly walkedEdges: number;
  readonly omittedEdgeTypes: readonly string[];
  readonly omittedReferrerTypes: readonly string[];
}): string => {
  if (
    params.omittedEdgeTypes.length === 0 &&
    params.omittedReferrerTypes.length === 0
  ) {
    return '';
  }
  const parts: string[] = [];
  if (params.omittedReferrerTypes.length > 0) {
    parts.push(`referrer type(s) ${params.omittedReferrerTypes.join(', ')}`);
  }
  if (params.omittedEdgeTypes.length > 0) {
    parts.push(`edge type(s) ${params.omittedEdgeTypes.join(', ')}`);
  }
  return (
    ` ENTIRE DEPENDENT FAMILIES WERE DROPPED: this slice returns` +
    ` ${params.returnedEdges} of the ${params.walkedEdges} dependency edge(s)` +
    ` the walk collected, and the trim is by component-id ORDER (the id-sorted` +
    ` TAIL is cut), not a proportional sample — so ${parts.join(' and ')} were` +
    ` FOUND by the walk and are NOT in this slice. Do NOT read the families` +
    ` present here as the complete dependent set; re-query with \`edgeTypes\`` +
    ` narrowed to a missing type to see it.`
  );
};

/** Verbatim honesty note combining count caps, truncation, and payload size. */
const buildImpactDisclosure = (params: {
  readonly componentId: string;
  readonly hops: number;
  readonly truncated: boolean;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly payloadBytes: number;
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
  readonly slimmedCount: number;
  readonly byteTrimmed: boolean;
  readonly rootIsObject: boolean;
  readonly rootIsField: boolean;
  readonly walkedEdges: number;
  readonly omittedEdgeTypes: readonly string[];
  readonly omittedReferrerTypes: readonly string[];
  readonly reportUsage?: ReportDashboardUsageDetail;
}): string => {
  const payloadLabel = formatPayloadSize(params.payloadBytes);
  const countSummary = `${params.nodeCount} node(s) / ${params.edgeCount} edge(s)`;
  const heavy = describePayloadHeavyContributors(params.nodes, params.edges);
  const payloadLarge = params.payloadBytes > IMPACT_COMFORT_PAYLOAD_BYTES;
  const slimNote =
    params.slimmedCount > 0
      ? ` ${params.slimmedCount} node(s) had an oversized property value (e.g. Profile/PermissionSet grant matrices) summarised to an \`{__omitted}\` marker to bound response size — fetch the full node with \`sfi.get_component\`.`
      : '';
  // Lookup / master-detail relationships ARE modeled as `lookupTo` edges
  // (extraction-time, since 0.1.7). They point from the field to the referenced
  // object, so an impact walk over INCOMING edges to a CustomObject includes the
  // inbound lookup fields that point AT it. On a vault refreshed before that edge
  // existed the slice would miss them, so the note is freshness-aware rather than
  // claiming the slice is exhaustive.
  const lookupCaveat = params.rootIsObject
    ? ' Lookup / master-detail relationships are modeled as `lookupTo` edges' +
      ' (extraction-time): inbound lookup fields that point at this object appear' +
      ' in this slice when the vault has them. If you expected inbound' +
      ' relationships and see none, the vault may predate `lookupTo` — re-run' +
      ' `/sfi-refresh`; the field-level `referenceTo` is also surfaced by' +
      ' `sfi.field_360` / `sfi.generate_data_dictionary`.'
    : '';
  const reportNote = formatFoldedReportUsageNote(params.reportUsage);

  // D3-soundness-overclaim: for a CustomField / CustomObject root, the walk only
  // sees referrers modeled as incoming edges. Name the referrer classes that are
  // NOT edge-modeled (and so NOT walked) so "no referrers" is never read as
  // certainty — mirrors the structured `soundness.blindSpots` disclosure.
  const referrerBlindNote =
    params.rootIsField || params.rootIsObject
      ? ' This walk covers only edge-modeled referrers; roll-up source coupling,' +
        ' layout placement, flow decision/filter reads, and tab/app membership are' +
        ' NOT modeled as incoming edges and were NOT walked (see' +
        ' `soundness.blindSpots`) — treat "no referrers" as "not checked", not' +
        ' proven none.'
      : '';

  // GET-IMPACT-PARENT-FANIN-BLEED: when the ONLY edges reaching the root are
  // structural `parentOf` (its parent object), there are NO usage dependents in
  // the slice. Disclose that plainly rather than letting the parent object read
  // as a "dependent" — and name that UI placements (layouts / FlexiPages / apps)
  // may not be modeled yet, so "no dependents" is "not found", not proven "none".
  const structuralParentOnly =
    params.edges.length > 0 && params.edges.every((e) => e.edgeType === 'parentOf');
  const structuralNote = structuralParentOnly
    ? ' The only inbound edge is the STRUCTURAL parent object (`parentOf`) — no usage' +
      ' dependents were found. The impact walk does NOT cross `parentOf` into the' +
      ' parent object’s own referrers (those depend on the object, not on this' +
      ' component). UI placements (Layouts / FlexiPages / apps) may not be modeled;' +
      ' treat this as "no dependents found", not a proven "nothing uses it".'
    : '';

  if (params.truncated) {
    const cap = params.byteTrimmed
      ? `trimmed to fit the ~${Math.round(GRAPH_MAX_PAYLOAD_BYTES / 1000)} KB response budget`
      : `capped at ${IMPACT_MAX_NODES} nodes / ${IMPACT_MAX_EDGES} edges`;
    const omittedNote = formatOmittedFamilyNote({
      returnedEdges: params.edgeCount,
      walkedEdges: params.walkedEdges,
      omittedEdgeTypes: params.omittedEdgeTypes,
      omittedReferrerTypes: params.omittedReferrerTypes,
    });
    return (
      `Impact slice ${cap} and TRUNCATED: ` +
      `\`${params.componentId}\` is a hub or has a wide dependency fan-in (${countSummary}; ` +
      `estimated JSON payload ${payloadLabel}).${slimNote}${omittedNote} ` +
      `Re-query with fewer hops or a narrower edgeTypes filter for a complete view.` +
      lookupCaveat +
      reportNote +
      structuralNote +
      referrerBlindNote
    );
  }

  if (payloadLarge) {
    const heavyNote = heavy !== null ? ` Dominated by ${heavy}.` : '';
    return (
      `Impact slice within ${params.hops} hop(s): ${countSummary} (within count cap), ` +
      `but estimated JSON payload is still ${payloadLabel} after per-node slimming.${heavyNote}${slimNote} ` +
      `Re-query with fewer hops or edgeTypes excluding grantedBy to shrink the response.` +
      lookupCaveat +
      reportNote +
      structuralNote +
      referrerBlindNote
    );
  }

  // GET-IMPACT-EMPTY-READS-COMPLETE: an empty dependent set is the one answer
  // "Complete impact slice" must never open with — the same payload carries a
  // `coverageCaveat` saying coverage is PARTIAL, so the two contradicted each
  // other and the reader kept the confident half. "Complete" describes the CAP
  // (nothing was cut), never the KNOWLEDGE, so an empty slice says so plainly.
  if (params.edgeCount === 0) {
    return (
      `NO dependent edges found within ${params.hops} hop(s) for ` +
      `\`${params.componentId}\` (nothing was cut by the ${IMPACT_MAX_NODES}-node / ` +
      `${IMPACT_MAX_EDGES}-edge cap). This is "no modeled dependency was FOUND", ` +
      `NOT a proven "nothing depends on it" — see \`coverageCaveat\` for the ` +
      `dependency families this vault did not fully retrieve.${slimNote}` +
      lookupCaveat +
      reportNote +
      structuralNote +
      referrerBlindNote
    );
  }

  return (
    `Complete impact slice within ${params.hops} hop(s): ${countSummary} under the ` +
    `${IMPACT_MAX_NODES}-node / ${IMPACT_MAX_EDGES}-edge cap; estimated JSON payload ${payloadLabel}.${slimNote}` +
    lookupCaveat +
    reportNote +
    structuralNote +
    referrerBlindNote
  );
};

/**
 * Expand one BFS level: for every node in `frontier`, fetch its
 * incoming edges (optionally filtered by `edgeTypes`) and return the
 * `fromId`s that have not yet been visited. Visited sets and edge
 * collector are mutated in place to keep the recursion cheap.
 *
 * CR-17: the per-node incoming edges are fetched in ONE batched
 * `listEdgesForNodes` query for the whole frontier (was an N+1 loop of
 * `listEdges` per node × edgeType). The returned buckets are then replayed in
 * the IDENTICAL visit order the row-at-a-time loop used — outer loop over
 * `frontier` in order, inner loop over `edgeTypes ?? [null]` in order, and
 * within each `(node, edgeType)` group the bucket's deterministic
 * `(toId, edgeType, fromId, source)` order — so the cap/dedup/next-push logic
 * produces the same visited set, the same `collectedEdges`, the same
 * `truncated` flag, and the same `next` frontier as before.
 */
const expandIncoming = async (
  ctx: Context,
  frontier: readonly ComponentId[],
  edgeTypes: readonly EdgeType[] | null,
  visitedNodes: Set<ComponentId>,
  visitedEdges: Set<string>,
  collectedEdges: Edge[],
  traversedTypes: Set<EdgeType>,
): Promise<{
  next: readonly ComponentId[];
  error: string | null;
  truncated: boolean;
}> => {
  // One round-trip fetches every frontier node's incoming edges; the helper
  // restricts to `edgeTypes` (a batched `edge_type IN (...)`) reproducing the
  // union of the old per-`(node, edgeType)` calls, and partitions per node so
  // the replay below can walk each node's bucket in the same admission order.
  const batched = await listEdgesForNodes(ctx.graph, frontier, {
    direction: 'in',
    ...(edgeTypes !== null ? { edgeTypes } : {}),
  });
  if (!batched.ok) {
    return { next: [], error: batched.error.message, truncated: false };
  }

  const next: ComponentId[] = [];
  let truncated = false;
  for (const nodeId of frontier) {
    if (visitedNodes.size >= IMPACT_MAX_NODES || collectedEdges.length >= IMPACT_MAX_EDGES) {
      truncated = true;
      break;
    }
    const bucket = batched.value.get(nodeId) ?? [];
    // Replay the old `edgeTypes ?? [null]` inner loop. `null` = a single pass
    // over the whole bucket (all types); otherwise one pass per requested type,
    // each filtered to that type — exactly as the per-call `listEdges(edgeType)`
    // loop decomposed it, and in the same order.
    const filters = edgeTypes ?? [null];
    for (const edgeType of filters) {
      const groupEdges =
        edgeType === null ? bucket : bucket.filter((e) => e.edgeType === edgeType);
      for (const edge of groupEdges) {
        if (collectedEdges.length >= IMPACT_MAX_EDGES) {
          truncated = true;
          break;
        }
        const key = edgeKey(edge);
        if (!visitedEdges.has(key)) {
          visitedEdges.add(key);
          collectedEdges.push(edge);
          traversedTypes.add(edge.edgeType);
        }
        if (!visitedNodes.has(edge.fromId)) {
          if (visitedNodes.size >= IMPACT_MAX_NODES) {
            truncated = true;
            break;
          }
          visitedNodes.add(edge.fromId);
          // GET-IMPACT-PARENT-FANIN-BLEED: `parentOf` is a STRUCTURAL
          // containment edge (parent object → child field/QuickAction/…), not a
          // usage/dependency. Record the edge and the parent node so the
          // structural parent stays visible, but NEVER expand the parent's OWN
          // inbound fan-in — otherwise a QuickAction/field impact walk crosses up
          // to the parent object and drags the object's referrers (Apex,
          // triggers, inbound lookups) in as false dependents of the child.
          if (edge.edgeType !== 'parentOf') {
            next.push(edge.fromId);
          }
        }
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  return { next, error: null, truncated };
};

/**
 * Fetch the `Node` records for every id in `ids`. Missing rows are
 * dropped silently — the graph can be sparser than the edge table
 * (an edge can reference an id that does not have a corresponding
 * node row, e.g., when only one half of a dependency was extracted).
 *
 * CR-17: batched into ONE `listNodesByIds` query (was an N+1 loop of
 * `getNodeById` per id). This sub-change is PROVABLY identical to the old
 * loop: the inputs are pre-sorted + capped (`[...visitedNodes].sort().slice`),
 * the absent-id drop matches `WHERE id IN (...)` returning no row, and the
 * caller re-sorts the result by id — so output order is unaffected. Unlike the
 * order-sensitive BFS edge walk above, nothing here depends on row order.
 */
const fetchNodes = async (
  ctx: Context,
  ids: readonly ComponentId[],
): Promise<Result<readonly Node[], string>> => {
  const result = await listNodesByIds(ctx.graph, ids);
  if (!result.ok) {
    return err(result.error.message);
  }
  return ok(result.value);
};

/**
 * The `sfi.get_impact` MCP tool. Returns the BFS-reachable slice that
 * *depends on* `componentId`, walking INCOMING edges up to `hops`
 * traversals (default 2, max 3). Optional `edgeTypes` narrows the
 * walk to specific dependency kinds.
 *
 * @example
 *   const r = await getImpactHandler(ctx, {
 *     componentId: 'CustomField:Account.Industry__c',
 *     hops: 2,
 *     edgeTypes: ['references', 'readsFrom'],
 *   });
 *   if (r.ok) console.log(r.value.data.impact.nodes.length);
 */
export const getImpactHandler = async (
  ctx: Context,
  input: GetImpactInput,
): Promise<Result<McpResponse<GetImpactOutput>, McpError>> => {
  const hops = input.hops ?? IMPACT_DEFAULT_HOPS;
  const edgeTypes =
    input.edgeTypes !== undefined && input.edgeTypes.length > 0
      ? input.edgeTypes
      : null;

  const rootId = input.componentId as ComponentId;
  // P14-PHANTOM-edges: an un-type-resolved Apex receiver id
  // (`CustomField:app.Id`, `ApexClass:oldMap`) is a heuristic-scanner parse
  // artifact, not a component — walking "what depends on it" would dress the
  // artifact's incoming parse edges up as a real blast radius. Refuse with
  // the honest classification instead. GRF-01: when the vault holds a real
  // node at this id (e.g. `ApexClass:pkb_Controller`), allow the walk.
  if (isUnresolvedFieldReceiver(rootId) || isUnresolvedApexCallTarget(rootId)) {
    const rootProbe = await getNodeById(ctx.graph, rootId);
    if (!rootProbe.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${rootProbe.error.message}`,
      });
    }
    const vaulted =
      rootProbe.value !== null &&
      (rootProbe.value.type === 'ApexClass' ||
        rootProbe.value.type === 'ApexTrigger' ||
        rootProbe.value.type === 'CustomField');
    if (!vaulted) {
      return err({
        kind: 'invalid-query',
        message:
          `\`${rootId}\` is an un-type-resolved Apex receiver (a heuristic-scanner parse artifact keyed on a local variable / context handle), not a real component — impact analysis would be meaningless. Resolve the variable's declared type and ask about that component instead.`,
        path: 'componentId',
      });
    }
  }
  const visitedNodes = new Set<ComponentId>([rootId]);
  const visitedEdges = new Set<string>();
  const collectedEdges: Edge[] = [];
  const traversedTypes = new Set<EdgeType>();

  let frontier: readonly ComponentId[] = [rootId];
  let truncated = false;
  for (let hop = 0; hop < hops && frontier.length > 0 && !truncated; hop++) {
    const expanded = await expandIncoming(
      ctx,
      frontier,
      edgeTypes,
      visitedNodes,
      visitedEdges,
      collectedEdges,
      traversedTypes,
    );
    if (expanded.error !== null) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${expanded.error}`,
      });
    }
    if (expanded.truncated) {
      truncated = true;
      break;
    }
    frontier = expanded.next;
  }

  // GET-IMPACT-UNKNOWN-ID-READS-AS-SAFE: an id that does not exist in this
  // vault used to resolve to `ok({ nodes: [], edges: [] })` with the disclosure
  // "Complete impact slice … 0 node(s) / 0 edge(s)". A typo'd or wrong-prefix
  // component ("contact", `CustomObject:Zzz_Nope__c`) therefore read as a
  // PROVEN "nothing breaks if you change this" — the single most dangerous
  // sentence this tool can emit. The old rationale ("the graph cannot
  // distinguish a missing component from one with no incoming edges") is false:
  // `getNodeById` + an unfiltered inbound-edge probe separates them exactly,
  // which is what the sibling `sfi.find_component_usages` already does. Refuse
  // with the same `component-not-found` classification.
  //
  // Cost is paid ONLY on the empty path (the probe never runs when the walk
  // found an edge), and a PHANTOM root — no node row but referenced by inbound
  // edges (a managed-package / standard object reached only through permission
  // or lookup edges) — still answers, since its edges prove it exists.
  let rootIsPhantom = false;
  if (collectedEdges.length === 0) {
    const rootNodeProbe = await getNodeById(ctx.graph, rootId);
    if (!rootNodeProbe.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${rootNodeProbe.error.message}`,
      });
    }
    if (rootNodeProbe.value === null) {
      // No node row. An `edgeTypes` filter may have hidden real inbound edges,
      // so probe UNFILTERED before calling the id unknown.
      const anyInbound = await listEdges(ctx.graph, rootId, { direction: 'in' });
      if (!anyInbound.ok) {
        return err({
          kind: 'internal',
          message: `graph query failed: ${anyInbound.error.message}`,
        });
      }
      if (anyInbound.value.length === 0) {
        return err({
          kind: 'component-not-found',
          message: `no component or referring edge matches \`${rootId}\` in this vault — an impact walk over an id that does not exist would return an empty slice that reads like a proven "nothing depends on this". Check the type prefix and api-name spelling (\`sfi.resolve\` disambiguates a bare name).`,
          path: rootId,
        });
      }
      rootIsPhantom = true;
    }
  }

  const nodeIds = [...visitedNodes].sort().slice(0, IMPACT_MAX_NODES);
  if (visitedNodes.size > IMPACT_MAX_NODES) {
    truncated = true;
  }
  const edgesCapped = [...collectedEdges].sort(compareEdges).slice(0, IMPACT_MAX_EDGES);
  if (collectedEdges.length > IMPACT_MAX_EDGES) {
    truncated = true;
  }

  const nodesResult = await fetchNodes(ctx, nodeIds);
  if (!nodesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodesResult.error}`,
    });
  }
  const sortedNodes = [...nodesResult.value].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  // Bound per-node payload (the node/edge count caps don't): summarise
  // any oversized property value (Profile grant matrices etc.).
  // Soundness from the FULL (pre-slim) nodes so the dynamic-apex signal in
  // properties.qualityIssues is read intact, before payload slimming.
  // D3-soundness-overclaim: for a CustomField / CustomObject root, whole classes
  // of referrer (roll-ups, layout placement, flow decision/filter reads, tab/app
  // membership) are structurally NOT modeled as incoming edges, so this walk is
  // blind to them — `soundnessForImpactWalk` downgrades `complete`/`full` and
  // names the un-walked classes rather than implying a completeness it can't have.
  // Derive the root type from the id prefix (robust when the root node row is
  // absent, e.g. an unknown field), mirroring the `rootIsObject` disclosure below.
  const rootTypeForSoundness =
    rootId.startsWith('CustomField:')
      ? 'CustomField'
      : rootId.startsWith('CustomObject:')
        ? 'CustomObject'
        : null;
  const soundness = soundnessForImpactWalk(sortedNodes, rootTypeForSoundness);
  const { nodes: slimNodes, slimmedCount } = slimGraphNodes(sortedNodes);
  // Per-node slimming bounds fat properties but not the slice total; enforce a
  // hard byte budget so the response always fits the MCP client's token limit.
  // GET-IMPACT-DROPPED-ENDPOINT-EDGE-LOSS: measure the edges the shared
  // dangling-edge filter inside `enforceGraphPayloadBudget` is about to delete
  // because an endpoint is absent from the fetched node set. Two causes, kept
  // apart because they are different bugs with different remedies:
  //   - PHANTOM: the id WAS requested (`nodeIds`) but `listNodesByIds` returned
  //     no row. For a phantom ROOT this silently deletes the entire dependent
  //     set — previously reported as `truncated: false` + "Complete impact
  //     slice … 14 node(s) / 0 edge(s)".
  //   - NODE-CAP: `expandIncoming` pushes the EDGE into `collectedEdges` and
  //     only THEN checks `visitedNodes.size >= IMPACT_MAX_NODES`, so the last
  //     edges admitted at the cap boundary reference ids that were never
  //     requested. Their referrers are fully present in the vault.
  const fetchedNodeIds = new Set<string>(slimNodes.map((n) => n.id));
  const requestedNodeIds = new Set<string>(nodeIds);
  const missingEndpointIds = new Set<string>();
  let droppedEdgeCount = 0;
  let phantomEndpointCount = 0;
  let nodeCapExcludedCount = 0;
  for (const edge of edgesCapped) {
    const missing = [edge.fromId, edge.toId].filter(
      (id) => !fetchedNodeIds.has(id),
    );
    if (missing.length === 0) continue;
    droppedEdgeCount += 1;
    for (const id of missing) missingEndpointIds.add(id);
    // Classify by the WORST cause on this edge: a true phantom is the more
    // serious signal, so it wins when both apply.
    if (missing.some((id) => requestedNodeIds.has(id))) phantomEndpointCount += 1;
    else nodeCapExcludedCount += 1;
  }
  const budgeted = enforceGraphPayloadBudget(rootId, slimNodes, edgesCapped);
  // An edge silently deleted is a partial answer, whatever the mechanism —
  // `truncated: false` on a slice that lost every one of its edges is the
  // "capped list, truncated flag says clean" failure mode.
  const finalTruncated = truncated || budgeted.trimmed || droppedEdgeCount > 0;
  const droppedEndpointEdges =
    droppedEdgeCount > 0
      ? {
          count: droppedEdgeCount,
          phantomEndpointCount,
          nodeCapExcludedCount,
          endpointIds: [...missingEndpointIds].sort().slice(0, 25),
          note:
            `${droppedEdgeCount} collected edge(s) are NOT in \`impact.edges\`: an endpoint is absent from \`impact.nodes\`, and an edge with a missing endpoint is filtered out of the returned slice. ` +
            (phantomEndpointCount > 0
              ? `${phantomEndpointCount} of them point at a PHANTOM — an id referenced by edges but never retrieved into this vault (typically a standard or managed-package component), so a phantom ROOT loses its whole dependent set here. `
              : '') +
            (nodeCapExcludedCount > 0
              ? `${nodeCapExcludedCount} of them reference a component the ${IMPACT_MAX_NODES}-node cap excluded — those referrers ARE in the vault, they just did not fit this slice. `
              : '') +
            `These are REAL references that were FOUND and then dropped — do not read their absence as "nothing depends on this". Use \`sfi.find_component_usages\` on the same id to enumerate them (it reads the edge table without a node join).`,
        }
      : undefined;
  const sortedTypes = [...traversedTypes].sort();
  const impact = { nodes: budgeted.nodes, edges: budgeted.edges };
  const estimatedPayloadBytes = estimateGraphPayloadBytes(impact);

  // R6-24 Option B / Finding #36: Report/Dashboard dependents are folded onto
  // the CustomField as capped name lists (no graph edges). Read from the
  // pre-slim root so payload slimming cannot erase the identity signal.
  const rootNode = sortedNodes.find((n) => n.id === rootId);
  const reportUsage =
    rootNode?.type === 'CustomField'
      ? (() => {
          const detail = reportDashboardUsageDetail(rootNode);
          return detail.usedInReport || detail.usedInDashboard ? detail : undefined;
        })()
      : undefined;

  // GET-IMPACT-TRUNCATION-DROPS-FAMILIES: diff what the walk COLLECTED against
  // what survived the caps + byte budget. `enforceGraphPayloadBudget` drops the
  // id-sorted TAIL, so the loss is not a proportional sample — whole referrer
  // families (every `Flow:`, every `ValidationRule:`) disappear while
  // alphabetically-early ones survive intact. Measured on a real vault: a hub
  // object walked 6 referrer families and returned only `ApexClass`.
  const returnedEdgeTypes = new Set<string>(budgeted.edges.map((e) => e.edgeType));
  const omittedEdgeTypes = [...traversedTypes]
    .filter((t) => !returnedEdgeTypes.has(t))
    .sort();
  const returnedReferrerTypes = new Set<string>(
    budgeted.edges.map((e) => describeId(e.fromId).typePrefix),
  );
  const omittedReferrerTypes = [
    ...new Set(collectedEdges.map((e) => describeId(e.fromId).typePrefix)),
  ]
    .filter((t) => t !== '' && !returnedReferrerTypes.has(t))
    .sort();

  const disclosure = buildImpactDisclosure({
    componentId: input.componentId,
    rootIsObject: rootId.startsWith('CustomObject:'),
    rootIsField: rootId.startsWith('CustomField:'),
    hops,
    truncated: finalTruncated,
    nodeCount: budgeted.nodes.length,
    edgeCount: budgeted.edges.length,
    payloadBytes: estimatedPayloadBytes,
    nodes: budgeted.nodes,
    edges: budgeted.edges,
    slimmedCount,
    byteTrimmed: budgeted.trimmed,
    walkedEdges: collectedEdges.length,
    omittedEdgeTypes,
    omittedReferrerTypes,
    ...(reportUsage !== undefined ? { reportUsage } : {}),
  });
  // A phantom root (no node row, but inbound edges prove it is referenced)
  // answers from those edges — say so, mirroring `find_component_usages`, so a
  // caller does not read the missing definition as a missing component.
  const rootPhantomNote = rootIsPhantom
    ? ` \`${rootId}\` is a PHANTOM — referenced by inbound edges but NOT retrieved into this vault, so its own definition is unavailable.`
    : '';
  const droppedEdgeNote =
    droppedEndpointEdges !== undefined ? ` ${droppedEndpointEdges.note}` : '';
  const disclosureText = `${disclosure}${rootPhantomNote}${droppedEdgeNote}`;

  // I3b (empty ≠ none): an impact walk with NO dependent edges is exactly where
  // "nothing depends on this" is dangerous — name the dependency families the
  // vault did NOT fully retrieve so the host discloses the boundary. Keyed on
  // the edge set (the root node is always present, so node count is not the
  // emptiness signal). Non-empty impact slices are untouched.
  // When folded report/dashboard names are present, the empty edge set is NOT
  // "nothing depends on this" for analytics — still emit coverageCaveat for
  // other missing families, but `reportUsage` carries the named dependents.
  // GET-IMPACT-PARENTOF-ONLY-SUPPRESSES-CAVEAT: a slice whose ONLY inbound edge
  // is the structural `parentOf` from the owning object has ZERO usage
  // dependents — the disclosure already says so ("no usage dependents were
  // found") — yet `edges.length === 0` was false, so the empty≠none caveat did
  // not fire and the honest half of the answer was unreachable on exactly that
  // shape. Measured: a ValidationRule whose only inbound edge is its parent
  // object returned `coverageCaveat: undefined` while claiming no dependents.
  // Treat parentOf-only as empty for the caveat, matching the disclosure.
  const hasUsageDependent = budgeted.edges.some((e) => e.edgeType !== 'parentOf');
  const coverageCaveat = !hasUsageDependent
    ? buildEmptyTraversalCoverageCaveat(ctx, GRAPH_TRAVERSAL_REQUIRED_COVERAGE)
    : undefined;

  // Same "empty is not none" hazard as `sfi.get_edges`, and more absolute than a
  // coverage gap: an edge type in `UNPRODUCED_EDGE_TYPES` has NO producer in the
  // product, so filtering on it contributes nothing BY CONSTRUCTION and no
  // refresh on any org can change that. Emitted only when such a type was
  // actually requested, so every other response stays byte-identical.
  const requestedUnproduced = (input.edgeTypes ?? []).filter((t) =>
    (UNPRODUCED_EDGE_TYPES as readonly string[]).includes(t),
  );
  const unproducedEdgeTypes =
    requestedUnproduced.length > 0
      ? `${requestedUnproduced.map((t) => `\`${t}\``).join(', ')} ${
          requestedUnproduced.length === 1 ? 'is a DECLARED edge type that' : 'are DECLARED edge types that'
        } NO extractor in this product emits, so ${
          requestedUnproduced.length === 1 ? 'it contributes' : 'they contribute'
        } NOTHING to this impact walk BY CONSTRUCTION. Absence here is not ` +
        `evidence that no such relationship exists — it is never recorded. ` +
        `Unlike a coverage gap, re-running \`sfi refresh\` on any org cannot ` +
        `populate ${requestedUnproduced.length === 1 ? 'it' : 'them'}.`
      : undefined;

  const truncationReason = finalTruncated
    ? {
        // Endpoint-drop loss is reported when it is the only cause —
        // labelling it `node-cap` (the old fall-through) pointed the reader at
        // a cap that was never hit.
        reason: budgeted.trimmed
          ? ('payload-budget' as const)
          : budgeted.edges.length >= IMPACT_MAX_EDGES
            ? ('edge-cap' as const)
            : !truncated && droppedEdgeCount > 0
              ? ('dropped-endpoint' as const)
              : ('node-cap' as const),
        nodeCap: IMPACT_MAX_NODES,
        edgeCap: IMPACT_MAX_EDGES,
        payloadByteBudget: GRAPH_MAX_PAYLOAD_BYTES,
        returnedNodes: budgeted.nodes.length,
        returnedEdges: budgeted.edges.length,
        walkedNodes: visitedNodes.size,
        walkedEdges: collectedEdges.length,
        omittedEdgeTypes,
        omittedReferrerTypes,
        remedy:
          omittedReferrerTypes.length > 0 || omittedEdgeTypes.length > 0
            ? `Impact slice is PARTIAL and WHOLE DEPENDENT FAMILIES ARE MISSING (see \`omittedReferrerTypes\` / \`omittedEdgeTypes\`) — the trim drops the id-sorted TAIL, not a proportional sample. Re-query with \`edgeTypes\` narrowed to a missing type (one call per family) to enumerate what is not shown here.`
            : 'Impact slice is PARTIAL. Re-query with fewer `hops` or a narrower `edgeTypes` filter for a complete view of this hub.',
      }
    : undefined;

  // R6-19: diagram gated on the FINAL (already-capped) node count — never a
  // separate, uncapped query. Above the cap: OMIT + name the actual count
  // rather than silently render a partial (and misleadingly-complete-looking)
  // picture.
  const diagram =
    budgeted.nodes.length <= IMPACT_DIAGRAM_MAX_NODES
      ? buildImpactDiagram(budgeted.nodes, budgeted.edges, rootId)
      : undefined;
  const diagramOmittedReason =
    diagram === undefined
      ? `diagram omitted: ${budgeted.nodes.length.toString()} nodes exceeds cap (${IMPACT_DIAGRAM_MAX_NODES.toString()})`
      : undefined;

  return ok({
    data: {
      impact,
      traversedEdgeTypes: sortedTypes,
      truncated: finalTruncated,
      ...(truncationReason !== undefined ? { truncationReason } : {}),
      estimatedPayloadBytes,
      ...(droppedEndpointEdges !== undefined ? { droppedEndpointEdges } : {}),
      payloadSlimmed: slimmedCount > 0,
      soundness,
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
      ...(unproducedEdgeTypes !== undefined ? { unproducedEdgeTypes } : {}),
      disclosure: disclosureText,
      ...(diagram !== undefined ? { diagram } : {}),
      ...(diagramOmittedReason !== undefined ? { diagramOmittedReason } : {}),
      ...(reportUsage !== undefined ? { reportUsage } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
