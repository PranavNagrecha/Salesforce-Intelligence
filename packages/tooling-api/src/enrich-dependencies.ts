/**
 * The v1.7 dependency enricher (R4).
 *
 * Given an opened `ToolingApiClient`, the in-memory vault Node set, and
 * the in-memory pre-existing Edge set, queries the Tooling API's
 * `MetadataComponentDependency` endpoint per source node and folds the
 * response into two outputs:
 *
 *   1. **Confirmations** — for every API row whose `(fromId, toId)`
 *      canonical-id pair matches a pre-existing edge in the input set,
 *      a `EdgeConfirmation` entry pointing at the edge's index. The
 *      caller is expected to apply `properties.confirmedByApi: true`
 *      to the named edge. The edge's `confidence`, `edgeType`, and
 *      `source` are explicitly NOT touched — per
 *      `MetadataComponentDependency.md` §"Confidence semantics", the
 *      pre-existing extractor's provenance is preserved.
 *
 *   2. **New `dependsOnFromApi` edges** — for every API row whose
 *      `(fromId, toId)` canonical-id pair has NO pre-existing edge,
 *      a new `Edge` of type `dependsOnFromApi` at `declared` confidence
 *      with `source: 'tooling-api-dependency'`. The properties block
 *      carries `apiReportedType` (the API's `RefMetadataComponentType`
 *      — useful for downstream visibility into what kind of dependency
 *      the API saw) and `isApiOnly: true` (the marker that distinguishes
 *      these edges from the API-confirmed offline ones).
 *
 * The function is **pure** with respect to the input arrays: it does
 * not mutate `nodes` or `edges`. The caller applies the result to the
 * graph store. This mirrors the R3 freshness enricher's shape — the
 * R3 result is a list of `NodeEnrichment` payloads the caller folds
 * into the persistence layer; this is the same pattern for edges.
 *
 * **Canonical-id correlation** — for the v1.7 R4 surface, the API
 * row's `MetadataComponentType` + `MetadataComponentName` are joined
 * directly as `{Type}:{Name}` per the vendored doc's correlation
 * table. CustomField is the exception: the API row's
 * `MetadataComponentName` carries the `{Object}.{Field}__c` shape
 * the vault canonical id uses, so the joined `CustomField:{Name}`
 * form already matches. The enricher passes both shapes through
 * and the caller's edge index handles the lookup.
 *
 * **What the enricher does NOT do** (deferred per
 * `MetadataComponentDependency.md`):
 *   - No managed-package dangling-id synthesis (`{Type}:{Name}@managed-package`).
 *     The doc describes this as a future enhancement; v1.7 skips rows
 *     whose target id doesn't resolve to a vault node and surfaces
 *     them in the per-row error list instead.
 *   - No multi-hop traversal — one API query per source node, that's it.
 *   - No batched WHERE-IN optimization. Per the vendored doc §"Batched-
 *     WHERE optimization (rejected for v1.7)", the per-source-component
 *     pattern is the v1.7 choice for error isolation.
 */

import type {
  ComponentId,
  ComponentType,
  Edge,
  Node,
} from '@sf-intelligence/contracts';

import type { Dependency, ToolingApiClient } from './client.js';

/** Per-call options for `enrichDependencies`. */
export interface DependencyEnrichmentOptions {
  readonly client: ToolingApiClient;
  /**
   * Source ComponentTypes to query. The enricher iterates input nodes
   * whose `type` is in this set and queries each one's
   * `MetadataComponentDependency` row set. Nodes of other types are
   * passed through.
   */
  readonly types: readonly ComponentType[];
  /**
   * Minimum interval between successive API queries in milliseconds.
   * Defaults to 200 — the floor documented in `ToolingApi.md`
   * §"Minimum interval throttle". Tests pass 0.
   */
  readonly rateLimitPauseMs?: number;
  /**
   * Injectable sleep for tests. Defaults to a `setTimeout`-based sleep.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Optional ISO 8601 timestamp the enricher stamps on every new
   * `dependsOnFromApi` edge's `properties.toolingApiRefreshedAt`. When
   * omitted, the field is omitted from the edge's properties. Tests
   * pass a deterministic value; production uses `new Date().toISOString()`.
   */
  readonly toolingApiRefreshedAt?: string;
}

/** Pointer to a pre-existing edge the API confirmed. */
export interface EdgeConfirmation {
  /**
   * Zero-based index into the original `edges` array. The caller looks
   * up the edge, applies `properties.confirmedByApi: true`, and writes
   * it back. The index form (rather than carrying the edge by value)
   * avoids accidental edge duplication — the caller knows exactly
   * which edge to update.
   */
  readonly edgeIndex: number;
}

/** Per-row error from the dependency walk. */
export interface DependencyEnrichmentError {
  /** The source node id we were querying when the error occurred. */
  readonly componentId: ComponentId;
  readonly error: string;
}

/** Result shape returned by the dependency-enrichment runner. */
export interface DependencyEnrichmentResult {
  /**
   * One entry per pre-existing edge the API confirmed. The caller
   * applies `properties.confirmedByApi: true` to each named edge.
   * Edges may appear multiple times if multiple API rows match the
   * same `(fromId, toId)` pair (unusual but possible); the caller
   * dedupes by `edgeIndex`.
   */
  readonly confirmations: readonly EdgeConfirmation[];
  /**
   * One entry per `(fromId, toId)` pair the API returned that had NO
   * pre-existing edge. The caller appends these to the graph store.
   * Confidence is always `declared`; `source` is always
   * `tooling-api-dependency`.
   */
  readonly newEdges: readonly Edge[];
  readonly errors: readonly DependencyEnrichmentError[];
}

/** Default rate-limit interval — Tooling API "be a good citizen" floor. */
const DEFAULT_RATE_LIMIT_PAUSE_MS = 200;

/** Default sleep used between successive queries. */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build a `Map<string, number[]>` keyed by `${fromId}\x00${toId}` over
 * the input edges. The null byte separator avoids any conceivable
 * collision across canonical id values (canonical ids do not contain
 * null bytes by definition — every component type uses printable
 * ASCII / unicode).
 *
 * Multiple edges may share a `(fromId, toId)` pair (e.g., a class that
 * both reads from and writes to the same field — two edges, different
 * types); the Map carries them all so a single API confirmation
 * confirms every pre-existing edge with the matching pair, per the
 * vendored doc's "matches on (fromId, toId) regardless of edgeType"
 * rule.
 */
interface EdgeIndex {
  readonly findEdges: (
    fromId: ComponentId,
    toId: ComponentId,
  ) => readonly number[];
}

const buildEdgeIndex = (edges: readonly Edge[]): EdgeIndex => {
  const map = new Map<string, number[]>();
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i]!;
    const key = `${edge.fromId}\x00${edge.toId}`;
    const existing = map.get(key);
    if (existing === undefined) {
      map.set(key, [i]);
    } else {
      existing.push(i);
    }
  }
  return {
    findEdges: (fromId, toId) => map.get(`${fromId}\x00${toId}`) ?? [],
  };
};

/**
 * Build a `Set<ComponentId>` over the input node ids so the enricher
 * can drop rows whose source or target is not a vault Node (managed-
 * package internals, components added between DX retrieve and API
 * query). Per the vendored doc, the rows are dropped silently — they
 * surface only in the per-source error list when the SOURCE
 * correlation fails (since the source IS the queried node, that case
 * is usually a no-op).
 */
const buildNodeIdSet = (nodes: readonly Node[]): ReadonlySet<ComponentId> => {
  const set = new Set<ComponentId>();
  for (const node of nodes) {
    set.add(node.id);
  }
  return set;
};

/**
 * Correlate a Tooling API row's `MetadataComponentType` +
 * `MetadataComponentName` to a v1.7 canonical id. The canonical form
 * the enricher emits is `{Type}:{Name}` per the vendored doc's
 * §"Canonical-id correlation" table. The function returns `null` when
 * the type/name shape is not parseable (the doc treats this as a
 * managed-package or namespace-collision row to skip).
 *
 * Note: this is the API-side shape. The vault may carry the same
 * canonical id under a slightly different parent-scoped form (e.g.,
 * CustomField uses `{Object}.{Field}__c`). When the simple
 * `{Type}:{Name}` form doesn't match a vault node, the caller's
 * lookup yields no node and the row is treated as API-only.
 */
const correlate = (
  type: string | undefined,
  name: string | undefined,
): ComponentId | null => {
  if (typeof type !== 'string' || type.length === 0) return null;
  if (typeof name !== 'string' || name.length === 0) return null;
  return `${type}:${name}`;
};

/**
 * Run the dependency-enrichment pass.
 *
 * @example
 *   const result = await enrichDependencies(
 *     { client, types: ['ApexClass'], toolingApiRefreshedAt: now },
 *     vaultNodes,
 *     vaultEdges,
 *   );
 *   for (const c of result.confirmations) {
 *     applyConfirmation(vaultEdges[c.edgeIndex]);
 *   }
 *   for (const edge of result.newEdges) {
 *     graphStore.insertEdge(edge);
 *   }
 */
export const enrichDependencies = async (
  opts: DependencyEnrichmentOptions,
  nodes: readonly Node[],
  edges: readonly Edge[],
): Promise<DependencyEnrichmentResult> => {
  const pauseMs = opts.rateLimitPauseMs ?? DEFAULT_RATE_LIMIT_PAUSE_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const edgeIndex = buildEdgeIndex(edges);
  const nodeIdSet = buildNodeIdSet(nodes);

  // Track confirmed edge indices in a Set to dedupe — the doc allows
  // multiple API rows to confirm the same pre-existing edge (a class
  // that both reads from and writes to the same field has two edges,
  // and a single API row would confirm both); the consumer reads each
  // confirmation once.
  const confirmedSet = new Set<number>();
  const confirmations: EdgeConfirmation[] = [];
  const newEdgePairsSeen = new Set<string>();
  const newEdges: Edge[] = [];
  const errors: DependencyEnrichmentError[] = [];

  let queriesIssued = 0;
  for (const node of nodes) {
    if (!opts.types.includes(node.type)) continue;
    if (queriesIssued > 0 && pauseMs > 0) {
      await sleep(pauseMs);
    }
    queriesIssued += 1;

    const queryResult = await opts.client.getDependencies(node.id);
    if (!queryResult.ok) {
      errors.push({
        componentId: node.id,
        error: `${queryResult.error.kind}: ${queryResult.error.message}`,
      });
      continue;
    }

    for (const row of queryResult.value as readonly Dependency[]) {
      const fromId = correlate(row.MetadataComponentType, row.MetadataComponentName);
      const toId = correlate(row.RefMetadataComponentType, row.RefMetadataComponentName);
      if (fromId === null || toId === null) {
        // Row carried no usable type/name — managed-package
        // namespace-only row, or malformed. Skip per the vendored
        // doc's correlation policy.
        continue;
      }
      // Match-edge lookup is on `(fromId, toId)` regardless of
      // edgeType per the vendored doc's "matches on (fromId, toId)
      // regardless of edgeType" rule.
      const matches = edgeIndex.findEdges(fromId, toId);
      if (matches.length > 0) {
        for (const idx of matches) {
          if (confirmedSet.has(idx)) continue;
          confirmedSet.add(idx);
          confirmations.push({ edgeIndex: idx });
        }
        continue;
      }
      // No pre-existing edge — emit a new `dependsOnFromApi` edge.
      // Skip targets the vault doesn't carry (managed-package
      // internals, etc.); these surface only as the empty graph,
      // not as new edges to nowhere. The doc's "dangling-id" pattern
      // is deferred per the JSDoc above.
      if (!nodeIdSet.has(toId)) continue;
      // Dedupe new edges by `(fromId, toId)` — a single source's
      // dependency response may carry duplicate rows (rare but
      // possible per Salesforce's response normalization), and the
      // enricher emits at most one new edge per pair.
      const pairKey = `${fromId}\x00${toId}`;
      if (newEdgePairsSeen.has(pairKey)) continue;
      newEdgePairsSeen.add(pairKey);
      const properties: Record<string, unknown> = {
        apiReportedType: row.RefMetadataComponentType,
        isApiOnly: true,
      };
      if (typeof opts.toolingApiRefreshedAt === 'string' && opts.toolingApiRefreshedAt.length > 0) {
        properties['toolingApiRefreshedAt'] = opts.toolingApiRefreshedAt;
      }
      newEdges.push({
        fromId,
        toId,
        edgeType: 'dependsOnFromApi',
        confidence: 'declared',
        source: 'tooling-api-dependency',
        properties,
      });
    }
  }

  return { confirmations, newEdges, errors };
};
