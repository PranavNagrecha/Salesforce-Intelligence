/**
 * Shared payload-bounding helpers for the architect-facing graph BFS tools
 * (`sfi.get_impact` and `sfi.get_subgraph`).
 *
 * Both tools return a slice of graph nodes + edges through the MCP envelope,
 * and both must keep that slice consumable by the MCP client. The node/edge
 * COUNT caps enforced upstream (≈200 nodes / 400 edges) bound cardinality but
 * NOT serialized byte size: a 200-node hub whose Profile/PermissionSet nodes
 * inline multi-KB grant matrices serializes to hundreds of KB, which an MCP
 * client rejects OUTRIGHT (the whole tool result is dropped and the user gets
 * an error, not a capped answer). These helpers bound the byte size in two
 * stages:
 *
 *   1. `slimGraphNodes` — summarise any single oversized property value to an
 *      `{ __omitted }` marker (content-agnostic; the full node is one
 *      `sfi.get_component` away).
 *   2. `enforceGraphPayloadBudget` — if the slimmed slice STILL exceeds
 *      `GRAPH_MAX_PAYLOAD_BYTES`, drop nodes from the tail of the id-sorted
 *      list (and any then-dangling edge) until it fits, always keeping the
 *      root node.
 *
 * The logic was previously duplicated byte-for-byte in `get-impact.ts` and
 * `get-subgraph.ts`; it lives here so the two tools cannot drift. Each tool
 * keeps its own disclosure wording (impact vs subgraph) — only the bounding
 * mechanics are shared.
 */

import type { ComponentId, Edge, Node } from '@sf-intelligence/contracts';

/**
 * Per-node property-value byte cap. Profile/PermissionSet nodes inline grant
 * matrices (layoutAssignments, userPermissions, field/object permissions) tens
 * of KB each; a count-capped slice of 200 such nodes is still a
 * multi-hundred-KB context bomb that the node/edge caps alone never bounded.
 * `slimGraphNodes` summarises any single property value whose JSON exceeds this
 * bound, keeping node identity + light properties intact.
 */
export const NODE_PROPERTY_MAX_BYTES = 1_500;

/**
 * HARD ceiling on the serialized slice. An MCP client rejects a tool result
 * above its token limit OUTRIGHT — a ~55 KB response on a hub node (e.g.
 * `get_impact(CustomObject:Payment__c, hops:2)`, or `get_subgraph` on a hub at
 * ~500 KB) is dropped entirely and the user gets an error, not a capped answer.
 * After per-node slimming, if the slice STILL exceeds this bound,
 * `enforceGraphPayloadBudget` drops trailing nodes (and edges referencing them)
 * until it fits. Sized well under a typical ~25k-token tool-result cap so the
 * response is always consumable.
 */
export const GRAPH_MAX_PAYLOAD_BYTES = 28_000;

/** UTF-8 byte length of a graph slice as serialized into the MCP envelope. */
export const estimateGraphPayloadBytes = (slice: {
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
}): number => Buffer.byteLength(JSON.stringify(slice), 'utf8');

/**
 * Slim oversized property values on each node, returning the (possibly
 * rewritten) list plus the count of slimmed nodes (for the disclosure).
 * Content-agnostic: ANY property over `NODE_PROPERTY_MAX_BYTES` — not just
 * permission matrices — is summarised to an `{ __omitted }` marker. The full
 * node is one `sfi.get_component` away.
 */
export const slimGraphNodes = (
  nodes: readonly Node[],
): { readonly nodes: readonly Node[]; readonly slimmedCount: number } => {
  let slimmedCount = 0;
  const out = nodes.map((node) => {
    let nodeSlimmed = false;
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node.properties)) {
      const json = JSON.stringify(value) ?? 'null';
      if (json.length > NODE_PROPERTY_MAX_BYTES) {
        props[key] = {
          __omitted: true,
          bytes: json.length,
          ...(Array.isArray(value) ? { count: value.length } : {}),
        };
        nodeSlimmed = true;
      } else {
        props[key] = value;
      }
    }
    if (!nodeSlimmed) return node;
    slimmedCount += 1;
    return { ...node, properties: props };
  });
  return { nodes: out, slimmedCount };
};

/**
 * Enforce the HARD payload-byte budget (`GRAPH_MAX_PAYLOAD_BYTES`) so the
 * response is always consumable by the MCP client. Per-node slimming bounds
 * individual fat properties but not the slice TOTAL (200 light nodes still
 * serialize to tens of KB), so on a hub node the slimmed slice can still be
 * rejected. We drop nodes from the tail of the id-sorted list — and any edge
 * that then dangles — until the serialized slice fits, always keeping the root
 * node. Returns the trimmed slice (re-sorted by id) and whether trimming ran.
 *
 * CR-RV7: dangling edges (referencing a node absent from the returned `nodes`)
 * are dropped on BOTH paths — the under-budget early return AND the trim path —
 * so no consumer can deref a node missing from the slice. This is the single
 * chokepoint both `get_impact` and `get_subgraph` flow through, filtering
 * against the FINAL returned node set, so the two tools cannot drift.
 */
export const enforceGraphPayloadBudget = (
  rootId: ComponentId,
  nodes: readonly Node[],
  edges: readonly Edge[],
): {
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
  readonly trimmed: boolean;
} => {
  // CR-RV7 (mirrors CR-13's getSubgraph fix): drop DANGLING edges — those
  // referencing a node absent from `nodes` — UNCONDITIONALLY, including on the
  // under-budget early-return branch. The caller's edge list is sliced
  // INDEPENDENTLY of its node list (e.g. `get-impact.ts` caps nodes and edges
  // separately, and `fetchNodes`/`listNodesByIds` silently drops ids with no
  // node row), so an edge can reference an id absent from the returned `nodes`.
  // Filtering here — the single chokepoint both `get_impact` and `get_subgraph`
  // flow through, against the FINAL `nodes` set (post-fetch, post-slim) — means
  // a consumer can never deref a node missing from the slice. The trim path
  // below already filters; this closes the early-return gap. Self-contained
  // slices are unaffected (every edge with both endpoints in `nodes` is kept).
  const allNodeIds = new Set(nodes.map((n) => n.id));
  // The dangler-free edge set against the FULL `nodes`. Computed once and
  // threaded into BOTH the early return and the trim path — the trim path then
  // narrows it against `keptNodes` (a subset of `nodes`), so a dangler against
  // `nodes` is necessarily a dangler against `keptNodes` and never re-appears.
  const selfContainedEdges = edges.filter(
    (e) => allNodeIds.has(e.fromId) && allNodeIds.has(e.toId),
  );
  if (
    estimateGraphPayloadBytes({ nodes, edges: selfContainedEdges }) <=
    GRAPH_MAX_PAYLOAD_BYTES
  ) {
    return { nodes, edges: selfContainedEdges, trimmed: false };
  }
  const byId = (a: Node, b: Node): number =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const fits = (ns: readonly Node[]): boolean => {
    const ids = new Set(ns.map((n) => n.id));
    const es = selfContainedEdges.filter((e) => ids.has(e.fromId) && ids.has(e.toId));
    return (
      estimateGraphPayloadBytes({ nodes: ns, edges: es }) <=
      GRAPH_MAX_PAYLOAD_BYTES
    );
  };
  const root = nodes.filter((n) => n.id === rootId);
  let rest = nodes.filter((n) => n.id !== rootId);
  while (rest.length > 0 && !fits([...root, ...rest])) {
    const drop = Math.max(1, Math.floor(rest.length * 0.1));
    rest = rest.slice(0, rest.length - drop);
  }
  const keptNodes = [...root, ...rest].sort(byId);
  const keptIds = new Set(keptNodes.map((n) => n.id));
  const keptEdges = selfContainedEdges.filter(
    (e) => keptIds.has(e.fromId) && keptIds.has(e.toId),
  );
  return { nodes: keptNodes, edges: keptEdges, trimmed: true };
};
