import type { DuckDBValue } from '@duckdb/node-api';
import type {
  ComponentId,
  ComponentType,
  ConfidenceLevel,
  Edge,
  EdgeType,
  Node,
  Result,
} from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';

import type { GraphError, GraphStore } from './store.js';

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 500;
const SEARCH_DEFAULT_LIMIT = 25;
const SEARCH_MAX_LIMIT = 100;
const SUBGRAPH_MAX_HOPS = 3;
/**
 * Result-size ceilings for `getSubgraph`. `hops` alone does NOT bound output —
 * a single hub node at hops=3 pulled 1,581 nodes / 54,736 edges (~14.7 MB of
 * JSON) in one response, blowing the caller's context window. These cap the BFS
 * so a hub yields a partial, deterministic slice flagged `truncated: true`
 * instead of detonating. ~200 nodes + ~400 edges keeps a worst-case response
 * near ~250 KB — an order of magnitude under the blow-up and within one
 * tool-result budget. Mirrored as message-only constants in `get-subgraph.ts`;
 * drift there is a code-review concern.
 */
const SUBGRAPH_MAX_NODES = 200;
const SUBGRAPH_MAX_EDGES = 400;

const NODE_COLUMNS =
  'id, type, api_name, label, parent_id, source_path, last_modified_date, last_modified_by, api_version, properties_json';
const EDGE_COLUMNS =
  'from_id, to_id, edge_type, confidence, source, properties_json';

/** A single result row from `searchNodes`. */
export interface SearchHit {
  readonly id: ComponentId;
  readonly score: number;
  readonly snippet: string;
}

/** A connected slice of the graph returned by `getSubgraph`. */
export interface Subgraph {
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
  /**
   * True when the node/edge caps clipped the slice (the root is a hub). The
   * returned nodes/edges are then a deterministic prefix (lowest ids first),
   * NOT the complete neighbourhood. Always present — `false` for un-clipped
   * results — so consumers can rely on the field.
   */
  readonly truncated: boolean;
}

/** Options for `listNodesByType`. */
export interface ListNodesOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly parentId?: ComponentId;
  /**
   * Optional boolean-property filters (P4-interface-impl). Each entry adds an
   * `AND json_extract_string(properties_json, '$.<key>') = '<true|false>'`
   * clause, so a caller can list e.g. every `isBatchable: true` ApexClass at
   * the DB layer (correct pagination, not a post-filtered page). An ABSENT
   * property never matches `true` (NULL = 'true' is NULL → excluded), which is
   * the right semantics for "not a Batchable". Keys are interpolated only as a
   * parameterised JSON path, never as raw SQL.
   */
  readonly propertyEquals?: Readonly<Record<string, boolean>>;
}

/** Options for `listEdges`. */
export interface ListEdgesOptions {
  readonly direction?: 'in' | 'out' | 'both';
  readonly edgeType?: EdgeType;
  readonly confidence?: ConfidenceLevel;
}

/** Options for `searchNodes`. */
export interface SearchNodesOptions {
  readonly limit?: number;
  readonly types?: readonly ComponentType[];
}

type Row = Readonly<Record<string, unknown>>;

const parseProperties = (raw: unknown): Readonly<Record<string, unknown>> => {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  const parsed = JSON.parse(raw) as unknown;
  // import.ts only writes objects via canonicalJson; treat anything else as
  // an upstream invariant violation rather than poisoning the caller.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return {};
  return parsed as Readonly<Record<string, unknown>>;
};

const rowToNode = (r: Row): Node => ({
  id: r['id'] as ComponentId,
  type: r['type'] as ComponentType,
  apiName: r['api_name'] as string,
  label: (r['label'] ?? null) as string | null,
  parentId: (r['parent_id'] ?? null) as ComponentId | null,
  sourcePath: r['source_path'] as string,
  lastModifiedDate: (r['last_modified_date'] ?? null) as string | null,
  lastModifiedBy: (r['last_modified_by'] ?? null) as string | null,
  apiVersion: (r['api_version'] ?? null) as number | null,
  properties: parseProperties(r['properties_json']),
});

const rowToEdge = (r: Row): Edge => ({
  fromId: r['from_id'] as ComponentId,
  toId: r['to_id'] as ComponentId,
  edgeType: r['edge_type'] as EdgeType,
  confidence: r['confidence'] as ConfidenceLevel,
  source: r['source'] as string,
  properties: parseProperties(r['properties_json']),
});

const queryFailed = (label: string, e: unknown): GraphError => ({
  kind: 'query-failed',
  message: `${label}: ${(e as Error).message}`,
});

/**
 * Synthesize a minimal boundary `Node` for a `getSubgraph` edge endpoint that
 * has no real `nodes` row — used only under `includeUnresolved` so a surfaced
 * phantom edge does not dangle against the returned node set (CR-13). The
 * `type`/`apiName` are parsed best-effort from the canonical `Type:apiName`
 * ComponentId by splitting on the FIRST `:` (the apiName itself may contain
 * `.`, e.g. `CustomField:Account.Industry__c`). An id without a `:` falls back
 * to the whole string as `apiName` and an empty `type` cast — the stub is
 * always well-formed so the outer `try`/`catch` never turns a malformed
 * phantom into a query-failed error. `properties.unresolved` lets consumers
 * (and the MCP-layer disclosure) flag it as a stub, not a real component.
 */
const makeUnresolvedStubNode = (id: ComponentId): Node => {
  const sep = id.indexOf(':');
  const type = (sep > 0 ? id.slice(0, sep) : '') as ComponentType;
  const apiName = sep >= 0 ? id.slice(sep + 1) : id;
  return {
    id,
    type,
    apiName,
    label: null,
    parentId: null,
    sourcePath: '',
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: { unresolved: true },
  };
};

/**
 * A heuristic edge whose target was tagged `targetMissing` at import — its
 * `to_id` resolves to no real node. These are the Apex scanner's phantoms
 * (`callsApex -> ApexClass:acc` from a local var, `readsFrom ->
 * CustomField:a.Field__c` from a loop variable). Skipped during subgraph
 * traversal by default so a phantom can't extend the BFS or pad the result
 * with non-existent components; pass `includeUnresolved` to `getSubgraph` to
 * keep them. The filter is scoped to the `heuristic` tier: `declared` /
 * `parsed` edges to out-of-vault targets (e.g. a `triggersOn` to a standard
 * object the vault doesn't cover) are legitimate references, not noise.
 *
 * NOTE: deliberately NOT applied in `listEdges` — the developer tools that
 * build on it (`explain_apex_method`, `get_edges`) intentionally surface the
 * scanner's heuristic accesses, tagged with their `heuristic` confidence; the
 * `targetMissing` flag on each edge's `properties` lets those tools disclose
 * the unresolved target without the edge vanishing.
 */
const isHiddenUnresolved = (e: Edge): boolean =>
  e.confidence === 'heuristic' && e.properties['targetMissing'] === true;

const fetchRows = async (
  store: GraphStore,
  sql: string,
  params: DuckDBValue[],
): Promise<readonly Row[]> => {
  const reader = await store.connection.runAndReadAll(sql, params);
  return reader.getRowObjectsJS() as readonly Row[];
};

/**
 * Fetch a single node by canonical id, or `null` if absent. Errors are
 * surfaced as `query-failed`.
 *
 * @example
 *   const r = await getNodeById(store, 'CustomField:Account.Industry__c');
 *   if (r.ok && r.value) console.log(r.value.apiName);
 */
export const getNodeById = async (
  store: GraphStore,
  id: ComponentId,
): Promise<Result<Node | null, GraphError>> => {
  try {
    const rows = await fetchRows(
      store,
      `SELECT ${NODE_COLUMNS} FROM nodes WHERE id = ? LIMIT 1`,
      [id],
    );
    return ok(rows.length === 0 ? null : rowToNode(rows[0] as Row));
  } catch (e) {
    return err(queryFailed('getNodeById', e));
  }
};

/**
 * List nodes of a given type, sorted by `id` ascending. `limit` defaults
 * to 50 (max 500). Optional `parentId` narrows to children of one parent.
 *
 * @example
 *   const r = await listNodesByType(store, 'CustomField', {
 *     parentId: 'CustomObject:Account',
 *   });
 */
export const listNodesByType = async (
  store: GraphStore,
  type: ComponentType,
  options?: ListNodesOptions,
): Promise<Result<readonly Node[], GraphError>> => {
  const limit = options?.limit ?? LIST_DEFAULT_LIMIT;
  if (limit > LIST_MAX_LIMIT) {
    return err({
      kind: 'query-failed',
      message: `listNodesByType: limit exceeds ${LIST_MAX_LIMIT}`,
    });
  }
  const params: DuckDBValue[] = [type];
  let sql = `SELECT ${NODE_COLUMNS} FROM nodes WHERE type = ?`;
  if (options?.parentId !== undefined) {
    sql += ' AND parent_id = ?';
    params.push(options.parentId);
  }
  // P4-interface-impl: boolean-property filters via the JSON column. The key
  // is bound as a parameterised JSON path (`$.<key>`), never concatenated into
  // SQL, so it cannot inject. An absent property yields NULL, which fails the
  // `= 'true'` test — correct "not a Batchable" semantics.
  if (options?.propertyEquals !== undefined) {
    for (const [key, value] of Object.entries(options.propertyEquals)) {
      sql += ` AND json_extract_string(properties_json, ?) = ?`;
      params.push(`$.${key}`, value ? 'true' : 'false');
    }
  }
  sql += ' ORDER BY id ASC LIMIT ? OFFSET ?';
  params.push(limit, options?.offset ?? 0);

  try {
    const rows = await fetchRows(store, sql, params);
    return ok(rows.map(rowToNode));
  } catch (e) {
    return err(queryFailed('listNodesByType', e));
  }
};

/**
 * Count nodes of a given type with a `COUNT(*)` aggregate — the exact total,
 * NOT the length of a capped page. `listNodesByType` is bounded by `limit`
 * (max 500), so any caller that needs a true tally (e.g. `org_overview`'s
 * per-type counts) must use this rather than measuring `listNodesByType(...).length`,
 * which saturates at 500 and under-reports large types.
 *
 * @example
 *   const r = await countNodesByType(store, 'CustomField');
 *   if (r.ok) console.log(`${r.value} fields`);
 */
export const countNodesByType = async (
  store: GraphStore,
  type: ComponentType,
): Promise<Result<number, GraphError>> => {
  try {
    const rows = await fetchRows(
      store,
      `SELECT count(*)::INT AS n FROM nodes WHERE type = ?`,
      [type],
    );
    return ok(Number((rows[0] as Row)['n']));
  } catch (e) {
    return err(queryFailed('countNodesByType', e));
  }
};

/**
 * A lightweight node projection — identity + parent only, NOT the (potentially
 * large) `properties` blob. Used by whole-graph scans that need every node's
 * name but none of its payload (e.g. namespace / managed-package detection in
 * `sfi.package_impact`).
 */
export interface NodeIdentity {
  readonly id: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  readonly parentId: ComponentId | null;
}

/**
 * Hard ceiling on one identity scan. The CI scale budget is 10k nodes; this
 * leaves an order of magnitude of headroom while still bounding a pathological
 * vault so a scan can't detonate the caller.
 */
const IDENTITY_SCAN_MAX = 100_000;

/**
 * Project EVERY node down to its identity (`id`, `type`, `apiName`,
 * `parentId`), sorted by `id` ASC. Unlike `listNodesByType` this is
 * type-agnostic and skips the `properties` payload, so a whole-graph
 * namespace/package scan stays cheap. Bounded at `IDENTITY_SCAN_MAX` rows;
 * because the order is deterministic, a caller that hits the cap gets a stable
 * prefix and should disclose partial coverage.
 *
 * @example
 *   const r = await listNodeIdentities(store);
 *   if (r.ok) for (const n of r.value) console.log(n.id);
 */
export const listNodeIdentities = async (
  store: GraphStore,
  options?: { readonly limit?: number },
): Promise<Result<readonly NodeIdentity[], GraphError>> => {
  const limit = Math.min(options?.limit ?? IDENTITY_SCAN_MAX, IDENTITY_SCAN_MAX);
  try {
    const rows = await fetchRows(
      store,
      `SELECT id, type, api_name, parent_id FROM nodes ORDER BY id ASC LIMIT ?`,
      [limit],
    );
    return ok(
      rows.map((r) => ({
        id: r['id'] as ComponentId,
        type: r['type'] as ComponentType,
        apiName: r['api_name'] as string,
        parentId: (r['parent_id'] ?? null) as ComponentId | null,
      })),
    );
  } catch (e) {
    return err(queryFailed('listNodeIdentities', e));
  }
};

/**
 * List the immediate children of a node (rows whose `parent_id` matches).
 * Sorted by id. No limit — child counts are bounded by containment.
 *
 * @example
 *   const r = await listChildren(store, 'CustomObject:Account');
 */
export const listChildren = async (
  store: GraphStore,
  parentId: ComponentId,
): Promise<Result<readonly Node[], GraphError>> => {
  try {
    const rows = await fetchRows(
      store,
      `SELECT ${NODE_COLUMNS} FROM nodes WHERE parent_id = ? ORDER BY id ASC`,
      [parentId],
    );
    return ok(rows.map(rowToNode));
  } catch (e) {
    return err(queryFailed('listChildren', e));
  }
};

/**
 * List edges incident to a node. `direction` defaults to `'both'`; can
 * be narrowed to `'in'` (to_id = nodeId) or `'out'` (from_id = nodeId).
 * Optional edgeType and confidence filters. Sorted by `(to_id, edge_type)`.
 *
 * @example
 *   const r = await listEdges(store, 'CustomObject:Account', {
 *     direction: 'out',
 *     edgeType: 'parentOf',
 *   });
 */
export const listEdges = async (
  store: GraphStore,
  nodeId: ComponentId,
  options?: ListEdgesOptions,
): Promise<Result<readonly Edge[], GraphError>> => {
  const direction = options?.direction ?? 'both';
  const params: DuckDBValue[] = [];
  let where: string;
  if (direction === 'out') {
    where = 'from_id = ?';
    params.push(nodeId);
  } else if (direction === 'in') {
    where = 'to_id = ?';
    params.push(nodeId);
  } else {
    where = '(from_id = ? OR to_id = ?)';
    params.push(nodeId, nodeId);
  }
  if (options?.edgeType !== undefined) {
    where += ' AND edge_type = ?';
    params.push(options.edgeType);
  }
  if (options?.confidence !== undefined) {
    where += ' AND confidence = ?';
    params.push(options.confidence);
  }
  try {
    const rows = await fetchRows(
      store,
      `SELECT ${EDGE_COLUMNS} FROM edges WHERE ${where} ORDER BY to_id ASC, edge_type ASC`,
      params,
    );
    return ok(rows.map(rowToEdge));
  } catch (e) {
    return err(queryFailed('listEdges', e));
  }
};

/**
 * One `(targetType × edgeKind × confidence)` group of edges whose `to_id`
 * resolves to NO node in the vault — i.e. references to a component the last
 * refresh did not retrieve. The raw building block for
 * `sfi.retrieve_blindspot_report`.
 */
export interface DanglingTargetGroup {
  /** ComponentType prefix of the missing target id (e.g. `CustomObject`). */
  readonly targetType: string;
  /** The edge kind pointing at the missing target (e.g. `triggersOn`). */
  readonly edgeType: EdgeType;
  /** Confidence tier of those edges (`declared` | `parsed` | `heuristic`). */
  readonly confidence: ConfidenceLevel;
  /** Number of edges in this group. */
  readonly edgeCount: number;
  /** Distinct missing target ids in this group. */
  readonly distinctTargets: number;
  /** Up to `sampleLimit` distinct missing target ids (smallest ids, sorted). */
  readonly sampleTargets: readonly ComponentId[];
  /** Up to `sampleLimit` distinct source ids referencing them (sorted). */
  readonly sampleReferencedBy: readonly ComponentId[];
}

/**
 * Group every edge whose `to_id` resolves to NO node — a reference to a
 * component the last refresh did not retrieve — by `(targetType, edgeKind,
 * confidence)`, with per-group counts and a small deterministic id sample.
 *
 * This is the raw signal behind `sfi.retrieve_blindspot_report`: the consumer
 * classifies each group (an automation/code reference vs a permission grant vs
 * an Apex-scanner phantom) and intersects it with the manifest's coverage to
 * turn a silent blind spot into an actionable retrieve-manifest gap. Computed
 * with a `LEFT JOIN … IS NULL` anti-join over the whole edge table, so a fully
 * covered vault returns `[]`.
 *
 * @example
 *   const r = await danglingTargetSummary(store);
 *   if (r.ok) for (const g of r.value)
 *     console.log(g.targetType, g.edgeType, g.distinctTargets);
 */
export const danglingTargetSummary = async (
  store: GraphStore,
  options?: { readonly sampleLimit?: number },
): Promise<Result<readonly DanglingTargetGroup[], GraphError>> => {
  const sampleLimit = Math.max(1, Math.min(options?.sampleLimit ?? 10, 50));
  const topSorted = (xs: unknown): ComponentId[] =>
    (Array.isArray(xs) ? (xs as ComponentId[]) : [])
      .slice()
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, sampleLimit);
  try {
    const rows = await fetchRows(
      store,
      `SELECT split_part(e.to_id, ':', 1) AS target_type,
              e.edge_type              AS edge_type,
              e.confidence             AS confidence,
              count(*)                 AS edge_count,
              count(DISTINCT e.to_id)  AS distinct_targets,
              list(DISTINCT e.to_id)   AS targets,
              list(DISTINCT e.from_id) AS sources
         FROM edges e
         LEFT JOIN nodes n ON e.to_id = n.id
        WHERE n.id IS NULL
        GROUP BY 1, 2, 3`,
      [],
    );
    const groups: DanglingTargetGroup[] = rows.map((r) => ({
      targetType: String(r['target_type'] ?? ''),
      edgeType: r['edge_type'] as EdgeType,
      confidence: r['confidence'] as ConfidenceLevel,
      edgeCount: Number(r['edge_count'] ?? 0),
      distinctTargets: Number(r['distinct_targets'] ?? 0),
      sampleTargets: topSorted(r['targets']),
      sampleReferencedBy: topSorted(r['sources']),
    }));
    // Most-referenced groups first; deterministic tie-break on type then kind.
    groups.sort(
      (a, b) =>
        b.distinctTargets - a.distinctTargets ||
        (a.targetType < b.targetType ? -1 : a.targetType > b.targetType ? 1 : 0) ||
        (a.edgeType < b.edgeType ? -1 : a.edgeType > b.edgeType ? 1 : 0),
    );
    return ok(groups);
  } catch (e) {
    return err(queryFailed('danglingTargetSummary', e));
  }
};

const buildSnippet = (
  query: string,
  apiName: string,
  label: string | null,
  propsJson: string,
): string => {
  const lc = query.toLowerCase();
  if (apiName.toLowerCase().includes(lc)) return apiName;
  if (label !== null && label.toLowerCase().includes(lc)) return label;
  const idx = propsJson.toLowerCase().indexOf(lc);
  if (idx === -1) return apiName;
  const radius = 40;
  return propsJson.slice(
    Math.max(0, idx - radius),
    Math.min(propsJson.length, idx + query.length + radius),
  );
};

/**
 * LIKE-based search (DuckDB ILIKE, case-insensitive) across `api_name`,
 * `label`, and `properties_json`. Score: 3.0 exact api_name, 2.8 api_name
 * prefix, 2.5 contains, 2.0 label, 1.0 properties. Sort: `score DESC,
 * api_name ASC`. Limit
 * defaults to 25 (max 100). Empty query returns `ok([])`.
 *
 * @example
 *   const r = await searchNodes(store, 'Industry', { limit: 10 });
 *   if (r.ok) for (const hit of r.value) console.log(hit.score, hit.snippet);
 */
export const searchNodes = async (
  store: GraphStore,
  query: string,
  options?: SearchNodesOptions,
): Promise<Result<readonly SearchHit[], GraphError>> => {
  const limit = options?.limit ?? SEARCH_DEFAULT_LIMIT;
  if (limit > SEARCH_MAX_LIMIT) {
    return err({
      kind: 'query-failed',
      message: `searchNodes: limit exceeds ${SEARCH_MAX_LIMIT}`,
    });
  }
  if (query.length === 0) return ok([]);

  const pattern = `%${query}%`;
  const prefixPattern = `${query}%`;
  // 1 exact + 4 score ILIKEs + 3 WHERE ILIKEs in this order.
  const params: DuckDBValue[] = [
    query,
    prefixPattern,
    pattern,
    pattern,
    pattern,
    pattern,
    pattern,
    pattern,
  ];
  let typesClause = '';
  if (options?.types !== undefined && options.types.length > 0) {
    typesClause = ` AND type IN (${options.types.map(() => '?').join(', ')})`;
    params.push(...options.types);
  }
  params.push(limit);

  const sql = `SELECT id, api_name, label, properties_json,
      CASE
        WHEN api_name = ? THEN 3.0
        WHEN api_name ILIKE ? THEN 2.8
        WHEN api_name ILIKE ? THEN 2.5
        WHEN label ILIKE ? THEN 2.0
        WHEN properties_json ILIKE ? THEN 1.0
        ELSE 0.0
      END AS score
    FROM nodes
    WHERE (api_name ILIKE ? OR label ILIKE ? OR properties_json ILIKE ?)${typesClause}
    ORDER BY score DESC, api_name ASC
    LIMIT ?`;

  try {
    const rows = await fetchRows(store, sql, params);
    return ok(
      rows.map((r) => ({
        id: r['id'] as ComponentId,
        score: Number(r['score']),
        snippet: buildSnippet(
          query,
          r['api_name'] as string,
          (r['label'] ?? null) as string | null,
          (r['properties_json'] as string | null) ?? '{}',
        ),
      })),
    );
  } catch (e) {
    return err(queryFailed('searchNodes', e));
  }
};

const compareEdges = (a: Edge, b: Edge): number => {
  if (a.fromId !== b.fromId) return a.fromId < b.fromId ? -1 : 1;
  if (a.toId !== b.toId) return a.toId < b.toId ? -1 : 1;
  if (a.edgeType !== b.edgeType) return a.edgeType < b.edgeType ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return 0;
};

// \0 cannot appear inside any ComponentId (which uses : and . only) so the
// composite key is unambiguous across all possible ids.
const edgeKey = (e: Edge): string =>
  `${e.fromId}\0${e.toId}\0${e.edgeType}\0${e.source}`;

/** Caps + filter flags threaded through one BFS expansion. */
interface ExpandLimits {
  readonly maxNodes: number;
  readonly maxEdges: number;
  readonly includeUnresolved: boolean;
}

const bfsExpand = async (
  store: GraphStore,
  frontier: readonly ComponentId[],
  visitedNodes: Set<ComponentId>,
  visitedEdges: Set<string>,
  collectedEdges: Edge[],
  limits: ExpandLimits,
  state: { truncated: boolean },
): Promise<readonly ComponentId[]> => {
  const placeholders = frontier.map(() => '?').join(', ');
  // ORDER BY makes the capped subset deterministic: when a hub overflows the
  // budget, the kept edges are the lowest by (from,to,type,source) — the same
  // order `compareEdges` sorts the final result by, so it's reproducible.
  const rows = await fetchRows(
    store,
    `SELECT ${EDGE_COLUMNS} FROM edges
     WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})
     ORDER BY from_id ASC, to_id ASC, edge_type ASC, source ASC`,
    [...frontier, ...frontier],
  );
  const next: ComponentId[] = [];
  for (const row of rows) {
    // Both budgets spent — remaining frontier edges can't be added either way.
    if (
      collectedEdges.length >= limits.maxEdges &&
      visitedNodes.size >= limits.maxNodes
    ) {
      state.truncated = true;
      break;
    }
    const edge = rowToEdge(row);
    // Phantom heuristic edges (target not a real node) are skipped entirely:
    // they neither consume the budget nor extend the frontier.
    if (!limits.includeUnresolved && isHiddenUnresolved(edge)) continue;
    const key = edgeKey(edge);
    if (!visitedEdges.has(key)) {
      if (collectedEdges.length >= limits.maxEdges) {
        state.truncated = true;
      } else {
        visitedEdges.add(key);
        collectedEdges.push(edge);
      }
    }
    for (const neighbor of [edge.fromId, edge.toId]) {
      if (!visitedNodes.has(neighbor)) {
        if (visitedNodes.size >= limits.maxNodes) {
          state.truncated = true;
        } else {
          visitedNodes.add(neighbor);
          next.push(neighbor);
        }
      }
    }
  }
  return next;
};

/**
 * BFS from `rootId`, capped at `hops` (max 3; larger rejected). `1` =
 * root + immediate neighbors (both directions); `2`/`3` expand further.
 * Result deterministic: nodes by id, edges by `(fromId, toId, edgeType, source)`.
 *
 * Output is bounded independently of `hops`: at most `SUBGRAPH_MAX_NODES`
 * nodes and `SUBGRAPH_MAX_EDGES` edges. A hub node that would otherwise return
 * a multi-megabyte slice is clipped to a deterministic prefix and the result's
 * `truncated` flag is set. Heuristic phantom edges (`targetMissing`) are
 * omitted by default; pass `includeUnresolved: true` to surface them.
 *
 * Self-contained-slice contract (CR-13): every returned edge has BOTH
 * endpoints in the returned node set — no edge dangles. A node-capped clip
 * drops edges to the omitted (clipped) nodes; under `includeUnresolved`, a
 * surfaced GENUINE phantom edge's endpoint (a heuristic+`targetMissing` edge
 * whose `toId` has no real node row) is added as a minimal stub node carrying
 * `properties.unresolved: true` so the edge stays visible AND self-contained.
 * RV2: stubs cover ONLY genuine phantom targets (never budget-clipped REAL
 * nodes — those stay clipped and their edges are dropped), and the synthesized
 * stub is always the edge `toId` (the phantom endpoint per import stamping).
 *
 * @example
 *   const r = await getSubgraph(store, 'CustomObject:Account', 1);
 *   if (r.ok && r.value.truncated) console.warn('hub — partial slice');
 */
export const getSubgraph = async (
  store: GraphStore,
  rootId: ComponentId,
  hops: number,
  options?: { readonly includeUnresolved?: boolean },
): Promise<Result<Subgraph, GraphError>> => {
  if (hops > SUBGRAPH_MAX_HOPS) {
    return err({
      kind: 'query-failed',
      message: `getSubgraph: hops exceeds ${SUBGRAPH_MAX_HOPS}`,
    });
  }
  if (hops < 0) {
    return err({
      kind: 'query-failed',
      message: 'getSubgraph: hops must be non-negative',
    });
  }
  try {
    const visitedNodes = new Set<ComponentId>([rootId]);
    const visitedEdges = new Set<string>();
    const collectedEdges: Edge[] = [];
    const state = { truncated: false };
    const limits: ExpandLimits = {
      maxNodes: SUBGRAPH_MAX_NODES,
      maxEdges: SUBGRAPH_MAX_EDGES,
      includeUnresolved: options?.includeUnresolved === true,
    };
    let frontier: readonly ComponentId[] = [rootId];
    for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
      frontier = await bfsExpand(
        store,
        frontier,
        visitedNodes,
        visitedEdges,
        collectedEdges,
        limits,
        state,
      );
    }
    const ids = [...visitedNodes];
    const placeholders = ids.map(() => '?').join(', ');
    const nodeRows = await fetchRows(
      store,
      `SELECT ${NODE_COLUMNS} FROM nodes WHERE id IN (${placeholders})`,
      [...ids],
    );
    const returnedNodes: Node[] = nodeRows.map(rowToNode);
    // CR-13 self-contained-slice contract: an edge must never point at a node
    // absent from the returned node set. The dangling-edge guard must filter
    // against the RETURNED nodes (`sortedNodes`), NOT the visited-id set — a
    // visited id can lack a `nodes` row (node-capped clip, or an
    // includeUnresolved phantom endpoint the scanner never imported), in which
    // case filtering on `visitedNodes` would leave its edge dangling.
    const returnedIds = new Set(returnedNodes.map((n) => n.id));
    if (limits.includeUnresolved) {
      // The opt-in flag's whole purpose is to SURFACE phantom edges, so a node
      // set that omits the phantom endpoint would gut the feature. Synthesize a
      // stub boundary node for the phantom endpoint, marked `unresolved` so
      // consumers can disclose it.
      //
      // RV2: stub ONLY genuine phantom edges (`isHiddenUnresolved` = heuristic
      // AND properties.targetMissing), NEVER budget-clipped REAL nodes. A hub
      // that overflows SUBGRAPH_MAX_NODES leaves edges to clipped real leaves in
      // `collectedEdges` (edges are budgeted to maxEdges independently of the
      // node cap); stubbing every missing endpoint would mislabel those real
      // nodes `unresolved:true` and push the node count past the cap. The
      // clipped reals stay out and their edges are dropped by the returnedIds
      // filter below, exactly as on the default (no-includeUnresolved) path. The
      // phantom endpoint is ALWAYS the edge `toId`: import.ts stamps
      // `targetMissing` solely from `edge.toId`, and a phantom edge's `fromId`
      // is the real scanned class/trigger that always has a node row.
      for (const edge of collectedEdges) {
        if (!isHiddenUnresolved(edge)) continue;
        if (!returnedIds.has(edge.toId)) {
          returnedIds.add(edge.toId);
          returnedNodes.push(makeUnresolvedStubNode(edge.toId));
        }
      }
    }
    const sortedNodes = returnedNodes.sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    // Drop any edge whose endpoints aren't both in the RETURNED node set, so a
    // node-capped result never carries a dangling edge to a node it omitted.
    // When un-truncated (and, under includeUnresolved, after stub synthesis)
    // every endpoint is a returned node, so this is a no-op.
    const edges = collectedEdges
      .filter((e) => returnedIds.has(e.fromId) && returnedIds.has(e.toId))
      .sort(compareEdges);
    return ok({ nodes: sortedNodes, edges, truncated: state.truncated });
  } catch (e) {
    return err(queryFailed('getSubgraph', e));
  }
};

/** One dated component in a freshness summary. */
export interface FreshnessEntry {
  readonly id: ComponentId;
  readonly type: ComponentType;
  readonly lastModifiedDate: string;
}

/** Aggregate freshness coverage for the whole vault. */
export interface FreshnessSummary {
  readonly total: number;
  readonly withKnownDate: number;
  readonly unknownDate: number;
  /** Percentage of nodes with a known lastModifiedDate, 0..100 (1 decimal). */
  readonly coveragePct: number;
  readonly oldest: readonly FreshnessEntry[];
  readonly newest: readonly FreshnessEntry[];
}

/**
 * Vault-level freshness coverage: how much of the corpus carries a known
 * `lastModifiedDate`, plus the oldest/newest dated components. Complements the
 * per-component `last_modified` / `changed_since` with a single contract-style
 * overview ("N% of the vault has known provenance; oldest untouched since …").
 *
 * @example
 *   const r = await freshnessSummary(store);
 *   if (r.ok) console.log(`${r.value.coveragePct}% dated`);
 */
export const freshnessSummary = async (
  store: GraphStore,
  limit = 5,
): Promise<Result<FreshnessSummary, GraphError>> => {
  try {
    const totals = await fetchRows(
      store,
      `SELECT count(*)::INT AS total, count(last_modified_date)::INT AS with_date FROM nodes`,
      [],
    );
    const total = Number((totals[0] as Row)['total']);
    const withDate = Number((totals[0] as Row)['with_date']);
    const toEntry = (r: Row): FreshnessEntry => ({
      id: r['id'] as ComponentId,
      type: r['type'] as ComponentType,
      lastModifiedDate: r['last_modified_date'] as string,
    });
    const oldestRows = await fetchRows(
      store,
      `SELECT id, type, last_modified_date FROM nodes WHERE last_modified_date IS NOT NULL ORDER BY last_modified_date ASC, id ASC LIMIT ?`,
      [limit],
    );
    const newestRows = await fetchRows(
      store,
      `SELECT id, type, last_modified_date FROM nodes WHERE last_modified_date IS NOT NULL ORDER BY last_modified_date DESC, id ASC LIMIT ?`,
      [limit],
    );
    return ok({
      total,
      withKnownDate: withDate,
      unknownDate: total - withDate,
      coveragePct:
        total === 0 ? 0 : Number(((100 * withDate) / total).toFixed(1)),
      oldest: oldestRows.map(toEntry),
      newest: newestRows.map(toEntry),
    });
  } catch (e) {
    return err(queryFailed('freshnessSummary', e));
  }
};

/** One author's footprint in the vault. */
export interface Contributor {
  readonly author: string;
  readonly componentCount: number;
  readonly mostRecentDate: string | null;
  readonly sampleIds: readonly ComponentId[];
}

/** Author-attribution summary across the whole vault. */
export interface ContributorsSummary {
  readonly totalWithAuthor: number;
  readonly totalUnknownAuthor: number;
  readonly contributors: readonly Contributor[];
}

/**
 * "Who shaped this org" — aggregate components by `lastModifiedBy`, ranked by
 * footprint, each with their most-recent change and a few sample ids. Pairs
 * with the SAST gate for governance ("who last touched the class with the
 * injection?") and the time dimension. Honest about unknown authorship:
 * offline vaults without Tooling-API enrichment carry null authors, counted
 * as `totalUnknownAuthor`.
 *
 * @example
 *   const r = await contributorsSummary(store);
 *   if (r.ok) console.log(r.value.contributors[0]?.author);
 */
export const contributorsSummary = async (
  store: GraphStore,
  limit = 10,
): Promise<Result<ContributorsSummary, GraphError>> => {
  try {
    const totals = await fetchRows(
      store,
      `SELECT count(*)::INT AS total, count(last_modified_by)::INT AS with_author FROM nodes`,
      [],
    );
    const total = Number((totals[0] as Row)['total']);
    const withAuthor = Number((totals[0] as Row)['with_author']);
    const grouped = await fetchRows(
      store,
      `SELECT last_modified_by AS author, count(*)::INT AS cnt, max(last_modified_date) AS recent
       FROM nodes WHERE last_modified_by IS NOT NULL
       GROUP BY last_modified_by ORDER BY cnt DESC, author ASC LIMIT ?`,
      [limit],
    );
    const contributors: Contributor[] = [];
    for (const row of grouped) {
      const author = (row as Row)['author'] as string;
      // eslint-disable-next-line no-await-in-loop -- bounded by `limit` (<=10)
      const sampleRows = await fetchRows(
        store,
        `SELECT id FROM nodes WHERE last_modified_by = ? ORDER BY id ASC LIMIT 3`,
        [author],
      );
      contributors.push({
        author,
        componentCount: Number((row as Row)['cnt']),
        mostRecentDate: ((row as Row)['recent'] ?? null) as string | null,
        sampleIds: sampleRows.map((s) => (s as Row)['id'] as ComponentId),
      });
    }
    return ok({
      totalWithAuthor: withAuthor,
      totalUnknownAuthor: total - withAuthor,
      contributors,
    });
  } catch (e) {
    return err(queryFailed('contributorsSummary', e));
  }
};
