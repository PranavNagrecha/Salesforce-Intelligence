/**
 * Handler for the `sfi.domain_clusters` MCP tool.
 *
 * The v2.0g secondary tour tool — pairs with `sfi.org_overview` to
 * answer the buyer-priority #9 question ("I'm new — give me a tour
 * of this org"). Where `org_overview` returns a flat structured
 * snapshot, this tool surfaces SUGGESTED domain groupings: a greedy
 * clustering of the most-connected CustomObject / ApexClass / Flow
 * nodes into "domains" centred on a high-degree component.
 *
 * **Honesty axis — load-bearing**: clusters are HEURISTIC, not
 * authoritative. A real Salesforce org's domain boundaries are
 * decided by humans (data architects, business stakeholders); the
 * v1.x graph cannot infer them. This tool's clusters reflect
 * topology — "these components share many edges" — not semantics.
 * The response carries that disclaimer in every cluster's
 * `suggestedName` ("Sales domain — Opportunity-centered") wording
 * and in the per-cluster note. A caller MUST present clusters as
 * "suggested starting points for further investigation", not as
 * confirmed domain assignments.
 *
 * The clustering algorithm:
 *
 *   1. **Candidate enumeration** — fetch all CustomObject + ApexClass
 *      + Flow nodes (the three "domain-shaped" ComponentTypes per
 *      the v2.0g spec). Cap at `CANDIDATE_LIMIT` to keep the
 *      response bounded — orgs with more than that surface a
 *      candidate list trimmed to the first chunk by id ASC.
 *
 *   2. **Edge collection per candidate** — for each candidate, fetch
 *      every incident edge (`direction: 'both'`) and build a
 *      neighbor set. The cost is `O(N)` queries; for N ~ 200
 *      candidates the response stays under 1s on typical orgs.
 *
 *   3. **Greedy clustering** — sort candidates by neighbor count
 *      DESC (most-connected first). For each ungrouped candidate,
 *      walk other ungrouped candidates and compute the shared-edge
 *      density (`|shared neighbors| / max(|neighbors_A|,
 *      |neighbors_B|)`). Candidates whose density >= `minDensity`
 *      join the cluster. Mark the cluster's centre + members as
 *      grouped and continue.
 *
 *   4. **Naming** — name each cluster by its centre component (the
 *      highest-degree CustomObject in the cluster, falling back to
 *      the first centre if no CustomObject is present). The name
 *      pattern is "{ApiName}-centered domain" — explicit about its
 *      heuristic provenance.
 *
 *   5. **Sort + slice** — sort clusters by member count DESC, then
 *      by centre id ASC for ties. Trim to `limit`. Report the
 *      `unclustered` count (candidates that never reached
 *      `minDensity` with anyone).
 *
 * Implementation notes:
 *   - The algorithm is intentionally simple — greedy, not optimal.
 *     A more sophisticated clustering (Louvain, label-propagation)
 *     would produce tighter groupings but at higher implementation
 *     cost; v2.0g ships the simple version per the spec.
 *   - `minDensity` is bounded `[0.0, 1.0]`. Lower values produce
 *     fewer, looser clusters; higher values produce more, tighter
 *     ones. The default 0.3 is calibrated to surface "obvious"
 *     domains while not over-fragmenting.
 *   - Candidates with zero incident edges (isolated nodes) are
 *     immediately counted as `unclustered` since they can't share
 *     edges with anyone. This matches the v2.0g honesty axis: an
 *     unconnected component IS unclustered, not "in a cluster of
 *     one".
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listEdges, listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

/** Inclusive lower bound on `minDensity`. */
const MIN_DENSITY_LOWER = 0;
/** Inclusive upper bound on `minDensity`. */
const MIN_DENSITY_UPPER = 1;
/** Default `minDensity` when the caller omits it. */
const MIN_DENSITY_DEFAULT = 0.3;

/** Inclusive lower bound on `limit`. */
const LIMIT_LOWER = 1;
/** Inclusive upper bound on `limit`. */
const LIMIT_UPPER = 50;
/** Default `limit` when the caller omits it. */
const LIMIT_DEFAULT = 10;

/**
 * Cap on the per-type candidate enumeration. Orgs with more than
 * `CANDIDATE_LIMIT_PER_TYPE` instances of any of the three domain-
 * shaped types surface a candidate set trimmed to the first chunk by
 * id ASC. Matches the graph layer's own `LIST_MAX_LIMIT`.
 */
const CANDIDATE_LIMIT_PER_TYPE = 500;

/**
 * The three "domain-shaped" ComponentTypes the clustering algorithm
 * considers as candidates. CustomObjects are the natural data-model
 * anchors; ApexClasses concentrate logic; Flows wire them together.
 * Other ComponentTypes (Profiles, ValidationRules, Layouts) are
 * intentionally excluded — they're typically associated with one
 * parent object, so they don't add domain-level signal and would
 * just dilute the density.
 */
const DOMAIN_CANDIDATE_TYPES: readonly ComponentType[] = [
  'CustomObject',
  'ApexClass',
  'Flow',
];

/**
 * Zod schema for the `sfi.domain_clusters` tool input.
 *
 *   - `minDensity`: optional, `[0.0, 1.0]`, default 0.3. The minimum
 *     shared-edge density two candidates must reach to be placed in
 *     the same cluster.
 *   - `limit`: optional, `[1, 50]`, default 10. The maximum number of
 *     clusters to return.
 */
export const domainClustersInputSchema = z.object({
  minDensity: z.number().min(MIN_DENSITY_LOWER).max(MIN_DENSITY_UPPER).optional(),
  limit: z.number().int().min(LIMIT_LOWER).max(LIMIT_UPPER).optional(),
});

/** Parsed input shape, inferred from `domainClustersInputSchema`. */
export type DomainClustersInput = z.infer<typeof domainClustersInputSchema>;

/**
 * One member of a domain cluster, including the centre. Carries the
 * identity fields a caller needs to render the cluster: the canonical
 * id, the api name, and the component type.
 */
export interface DomainMember {
  readonly id: ComponentId;
  readonly apiName: string;
  readonly type: ComponentType;
}

/**
 * One suggested domain cluster. `centerComponent` is the high-degree
 * anchor used for naming; `members` always includes the centre. The
 * `sharedEdgeCount` field is the total number of edges among the
 * cluster's member set — the rough "internal connectivity score".
 */
export interface Domain {
  readonly id: string;
  readonly suggestedName: string;
  readonly centerComponent: DomainMember;
  readonly members: readonly DomainMember[];
  readonly sharedEdgeCount: number;
  /**
   * `connected` when members have direct edges among themselves
   * (`sharedEdgeCount > 0`); `external-anchor` when they have NONE and were
   * grouped only because they share a common neighbour (e.g. many independent
   * flows that all touch the same object). An `external-anchor` cluster is a
   * co-location, NOT a cohesive dependency domain — surfaced so the caller does
   * not read a zero-edge group as tightly coupled.
   */
  readonly cohesion: 'connected' | 'external-anchor';
  /** TRUE member count — `members` may be capped (see `membersTruncated`). */
  readonly memberCount: number;
  /** True when `members` was capped at MAX_MEMBERS_PER_CLUSTER for response size. */
  readonly membersTruncated: boolean;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface DomainClustersOutput {
  readonly clusters: readonly Domain[];
  /** Count of candidates that didn't join any cluster. */
  readonly unclustered: number;
  /** Present when the cluster list was trimmed to fit the response size limit. */
  readonly note?: string;
}

/** Cap members listed per cluster so one large domain can't blow the response
 *  guard; `memberCount` still reports the true size. */
const MAX_MEMBERS_PER_CLUSTER = 40;
/** Keep the serialized response under the global ~45 KB MCP guard. */
const DOMAIN_CLUSTERS_BYTE_BUDGET = 36_000;

/**
 * One candidate the clustering algorithm considers. Combines the
 * graph Node with its precomputed neighbor set so the density
 * comparison can stay in pure CPU after stage 1.
 */
interface Candidate {
  readonly node: Node;
  readonly neighbors: ReadonlySet<ComponentId>;
}

/**
 * Fetch every domain-candidate Node, in stable order by type then
 * id. Limits the per-type fan-out at `CANDIDATE_LIMIT_PER_TYPE` so a
 * very large org doesn't generate a query storm; orgs with more than
 * that surface a candidate list trimmed by the graph's id ASC
 * ordering, which is honest but bounded.
 */
const fetchCandidateNodes = async (
  ctx: Context,
): Promise<Result<readonly Node[], McpError>> => {
  const all: Node[] = [];
  for (const type of DOMAIN_CANDIDATE_TYPES) {
    const result = await listNodesByType(ctx.graph, type, {
      limit: CANDIDATE_LIMIT_PER_TYPE,
    });
    if (!result.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${result.error.message}`,
      });
    }
    all.push(...result.value);
  }
  return ok(all);
};

/**
 * Build the neighbor set for one node: every node id on the other
 * end of an incident edge (in either direction). The `parentOf` edge
 * IS included — a CustomObject and its child CustomField share a
 * parentOf edge, and that's load-bearing signal for "Account-centered
 * domain includes Account fields". The neighbor set never includes
 * the node itself.
 */
const buildNeighborSet = async (
  ctx: Context,
  nodeId: ComponentId,
): Promise<Result<Set<ComponentId>, McpError>> => {
  const result = await listEdges(ctx.graph, nodeId, { direction: 'both' });
  if (!result.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${result.error.message}`,
    });
  }
  const neighbors = new Set<ComponentId>();
  for (const edge of result.value) {
    if (edge.fromId !== nodeId) neighbors.add(edge.fromId);
    if (edge.toId !== nodeId) neighbors.add(edge.toId);
  }
  return ok(neighbors);
};

/**
 * Compute the shared-edge density of two candidates. Density is
 * `|A ∩ B| / max(|A|, |B|)` over the two candidates' neighbor sets,
 * bounded `[0, 1]`. Pure edge-share metric — two candidates can
 * reach 1.0 only when one's neighbor set is a subset of the other's
 * (and equal in size to the union). Returns 0 when either candidate
 * has no neighbors (avoids divide-by-zero).
 */
const sharedDensity = (a: Candidate, b: Candidate): number => {
  const sizeA = a.neighbors.size;
  const sizeB = b.neighbors.size;
  if (sizeA === 0 || sizeB === 0) return 0;
  let shared = 0;
  const smaller = sizeA <= sizeB ? a.neighbors : b.neighbors;
  const larger = sizeA <= sizeB ? b.neighbors : a.neighbors;
  for (const id of smaller) {
    if (larger.has(id)) shared += 1;
  }
  const denominator = Math.max(sizeA, sizeB);
  return shared / denominator;
};

/**
 * Pick the cluster's centre. Per the spec, prefer the most-edge-
 * connected CustomObject; fall back to the first member sorted by
 * id ASC if no CustomObject is in the cluster. The centre's apiName
 * drives the cluster's suggested name.
 */
const pickCentre = (members: readonly Candidate[]): Candidate => {
  const customObjects = members.filter((m) => m.node.type === 'CustomObject');
  const pool = customObjects.length > 0 ? customObjects : members;
  let best: Candidate = pool[0] as Candidate;
  for (const member of pool) {
    if (member.neighbors.size > best.neighbors.size) {
      best = member;
    } else if (
      member.neighbors.size === best.neighbors.size &&
      member.node.id < best.node.id
    ) {
      best = member;
    }
  }
  return best;
};

/**
 * Render a member-list ordering: id ASC. Stable across runs so
 * fixture-based tests can pin to a specific ordering.
 */
const memberCompare = (a: DomainMember, b: DomainMember): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Render a domain cluster from its candidate list. The cluster's
 * `id` is a deterministic `domain-N` slug derived from the input
 * index; the suggested name names the centre explicitly so the
 * caller can show "Account-centered domain (8 members)" verbatim.
 */
const renderCluster = (
  index: number,
  candidates: readonly Candidate[],
  sharedEdgeCount: number,
): Domain => {
  const centre = pickCentre(candidates);
  const allMembers: DomainMember[] = candidates
    .map((c) => ({ id: c.node.id, apiName: c.node.apiName, type: c.node.type }))
    .sort(memberCompare);
  const members = allMembers.slice(0, MAX_MEMBERS_PER_CLUSTER);
  const cohesion: Domain['cohesion'] =
    sharedEdgeCount > 0 ? 'connected' : 'external-anchor';
  const suggestedName =
    cohesion === 'connected'
      ? `${centre.node.apiName}-centered domain (suggested grouping)`
      : `${centre.node.apiName}-anchored group (co-located, no internal edges)`;
  return {
    id: `domain-${index.toString()}`,
    suggestedName,
    centerComponent: {
      id: centre.node.id,
      apiName: centre.node.apiName,
      type: centre.node.type,
    },
    members,
    sharedEdgeCount,
    cohesion,
    memberCount: allMembers.length,
    membersTruncated: allMembers.length > members.length,
  };
};

/**
 * Count the edges among the candidate set (unordered, undirected for
 * the purpose of the connectivity score). The implementation walks
 * each member's neighbor set and counts neighbors that are also in
 * the cluster set, divided by 2 because each shared edge is counted
 * from both endpoints.
 */
const countInternalEdges = (
  members: readonly Candidate[],
): number => {
  const memberIds = new Set(members.map((m) => m.node.id));
  let total = 0;
  for (const member of members) {
    for (const neighbor of member.neighbors) {
      if (memberIds.has(neighbor)) total += 1;
    }
  }
  return Math.floor(total / 2);
};

/**
 * Greedy clustering pass. The algorithm walks candidates sorted by
 * neighbor count DESC, builds a cluster around each ungrouped seed,
 * and stops when every candidate is either in a cluster or marked
 * unclustered. Returns the clusters in seed order; the caller sorts
 * + slices to the requested limit.
 */
const greedyCluster = (
  candidates: readonly Candidate[],
  minDensity: number,
): { clusters: Candidate[][]; unclustered: number } => {
  const grouped = new Set<ComponentId>();
  const clusters: Candidate[][] = [];
  // Sort seeds by neighbor count DESC so the densest candidate
  // anchors its cluster first.
  const ordered = [...candidates].sort((a, b) => {
    if (a.neighbors.size !== b.neighbors.size) {
      return b.neighbors.size - a.neighbors.size;
    }
    return a.node.id < b.node.id ? -1 : 1;
  });
  let unclustered = 0;
  for (const seed of ordered) {
    if (grouped.has(seed.node.id)) continue;
    if (seed.neighbors.size === 0) {
      // Isolated node — can't share edges with anyone, so it's
      // honestly unclustered, not "a cluster of one".
      grouped.add(seed.node.id);
      unclustered += 1;
      continue;
    }
    const cluster: Candidate[] = [seed];
    grouped.add(seed.node.id);
    for (const other of ordered) {
      if (grouped.has(other.node.id)) continue;
      if (other.node.id === seed.node.id) continue;
      const density = sharedDensity(seed, other);
      if (density >= minDensity) {
        cluster.push(other);
        grouped.add(other.node.id);
      }
    }
    if (cluster.length === 1) {
      // The seed found no neighbors that meet the density bar.
      // Per the spec, single-member clusters are not "clusters" —
      // demote the seed to unclustered.
      unclustered += 1;
      continue;
    }
    clusters.push(cluster);
  }
  return { clusters, unclustered };
};

/**
 * Comparator for the cluster ordering returned to the caller:
 * member count DESC, then centre id ASC for ties.
 */
const compareClustersDesc = (a: Domain, b: Domain): number => {
  if (a.members.length !== b.members.length) {
    return b.members.length - a.members.length;
  }
  return a.centerComponent.id < b.centerComponent.id ? -1 : 1;
};

/**
 * The `sfi.domain_clusters` MCP tool. Returns suggested domain
 * groupings of the org's CustomObject / ApexClass / Flow nodes.
 * Clusters are heuristic and must be presented as suggestions, not
 * authoritative assignments. See the module JSDoc for the
 * algorithm and the honesty axis.
 *
 * @example
 *   const r = await domainClustersHandler(ctx, { minDensity: 0.4 });
 *   if (r.ok) console.log(r.value.data.clusters.length);
 */
export const domainClustersHandler = async (
  ctx: Context,
  input: DomainClustersInput,
): Promise<Result<McpResponse<DomainClustersOutput>, McpError>> => {
  const minDensity = input.minDensity ?? MIN_DENSITY_DEFAULT;
  const limit = input.limit ?? LIMIT_DEFAULT;

  // Stage 1: candidate enumeration.
  const nodesResult = await fetchCandidateNodes(ctx);
  if (!nodesResult.ok) return err(nodesResult.error);

  // Stage 2: neighbor-set construction.
  const candidates: Candidate[] = [];
  for (const node of nodesResult.value) {
    const neighborsResult = await buildNeighborSet(ctx, node.id);
    if (!neighborsResult.ok) return err(neighborsResult.error);
    candidates.push({ node, neighbors: neighborsResult.value });
  }

  // Stage 3: greedy clustering.
  const { clusters: rawClusters, unclustered } = greedyCluster(
    candidates,
    minDensity,
  );

  // Stage 4: render + sort + slice.
  const rendered: Domain[] = rawClusters.map((members, idx) =>
    renderCluster(idx + 1, members, countInternalEdges(members)),
  );
  const sorted = [...rendered].sort(compareClustersDesc);

  // Members are already capped per cluster; this byte-budget backstop reduces the
  // cluster COUNT if the page would still exceed the response guard (a real org
  // overflowed at ~63 KB), so the tool never fails outright.
  const build = (n: number): DomainClustersOutput => ({
    clusters: sorted.slice(0, n),
    unclustered,
    ...(n < sorted.length
      ? { note: `Showing ${n} of ${sorted.length} clusters — trimmed to fit the response size limit; raise specificity (minDensity) or lower \`limit\`.` }
      : {}),
  });
  let n = Math.min(limit, sorted.length);
  let data = build(n);
  while (n > 1 && Buffer.byteLength(JSON.stringify(data), 'utf8') > DOMAIN_CLUSTERS_BYTE_BUDGET) {
    n = Math.max(1, Math.floor(n * 0.8));
    data = build(n);
  }

  return ok({
    data,
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
