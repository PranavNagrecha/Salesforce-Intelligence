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

/**
 * Escape a user query for use inside a regular expression.
 *
 * The whole-token score tier puts caller input in front of a regex engine for
 * the first time. Every metacharacter is escaped so a query like `Amount(` is
 * matched literally rather than throwing or matching something else.
 */
const regexEscape = (query: string): string =>
  query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
  /**
   * SUBGRAPH-PHANTOM-ENDPOINT-EDGE-LOSS: present ONLY when ≥1 collected edge
   * was removed from `edges` because an ENDPOINT has no row in `nodes`.
   *
   * The self-contained-slice contract (CR-13) rightly filters those edges — a
   * consumer must never deref a node the slice omitted — but the removal used
   * to be INVISIBLE: `truncated` stayed false and the handler still opened
   * "Complete subgraph within N hop(s)". Measured on a real vault: a subgraph
   * walk rooted on a PHANTOM standard object (referenced by 14 access grants,
   * never itself retrieved) returned 15 nodes / 0 edges, `truncated: false`,
   * "Complete subgraph" — fifteen principals with nothing connecting them to
   * anything. Two causes, kept apart because the remedies differ:
   *
   *   - `phantomEndpointCount` — the id WAS visited by the walk but has no
   *     `nodes` row: a phantom (referenced by edges, never retrieved —
   *     typically a standard or managed-package component). A phantom ROOT
   *     loses its WHOLE neighbourhood this way, and nothing else flags it.
   *   - `nodeCapExcludedCount` — the edge was admitted and only then did the
   *     node cap close, so the endpoint was never visited. Those components
   *     ARE in the vault; `truncated` is already true in this case.
   *
   * Either way the dropped edges are REAL relationships. `sfi.get_edges` /
   * `sfi.find_component_usages` enumerate them (no node join).
   */
  readonly droppedEndpointEdges?: {
    readonly count: number;
    /** Endpoint visited by the walk but with no node row — a true phantom. */
    readonly phantomEndpointCount: number;
    /** Endpoint never visited because the node cap closed first. */
    readonly nodeCapExcludedCount: number;
    /** Distinct missing endpoint ids, sorted ascending, capped at 25. */
    readonly endpointIds: readonly ComponentId[];
  };
}

/**
 * How many missing-endpoint ids `Subgraph.droppedEndpointEdges` names before it
 * stops. Enough to act on, bounded so a hub cannot blow the response budget.
 */
const DROPPED_ENDPOINT_ID_CAP = 25;

/**
 * Summarise the edges the self-contained-slice filter is about to delete, so
 * the loss is reported instead of silent. See `Subgraph.droppedEndpointEdges`.
 * Returns `undefined` when nothing is dropped, so an unaffected slice keeps its
 * exact prior shape.
 */
const summarizeDroppedEndpointEdges = (
  collectedEdges: readonly Edge[],
  returnedIds: ReadonlySet<ComponentId>,
  visitedNodes: ReadonlySet<ComponentId>,
): Subgraph['droppedEndpointEdges'] => {
  const missingEndpointIds = new Set<ComponentId>();
  let count = 0;
  let phantomEndpointCount = 0;
  let nodeCapExcludedCount = 0;
  for (const edge of collectedEdges) {
    const missing = [edge.fromId, edge.toId].filter((id) => !returnedIds.has(id));
    if (missing.length === 0) continue;
    count += 1;
    for (const id of missing) missingEndpointIds.add(id);
    // Classify by the WORSE cause on this edge: a true phantom is the more
    // serious signal (nothing else discloses it), so it wins when both apply.
    if (missing.some((id) => visitedNodes.has(id))) phantomEndpointCount += 1;
    else nodeCapExcludedCount += 1;
  }
  if (count === 0) return undefined;
  return {
    count,
    phantomEndpointCount,
    nodeCapExcludedCount,
    endpointIds: [...missingEndpointIds].sort().slice(0, DROPPED_ENDPOINT_ID_CAP),
  };
};

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
  /**
   * Exact string matches on `properties_json` keys (e.g. Flow `status`,
   * `triggerObject`). Keys are parameterised JSON paths — never concatenated.
   */
  readonly propertyStringEquals?: Readonly<Record<string, string>>;
  /** When true, keep only nodes whose `triggerType` starts with `Record`. */
  readonly recordTriggered?: boolean;
  /**
   * Filter on whether the node carries a non-empty `properties.description`.
   * `'present'` keeps only nodes with a real description; `'absent'` keeps only
   * those with none. "None" folds together three cases into one honest bucket:
   * the key is absent (enterprise-metadata types omit it when the source has no
   * `<description>`), the value is JSON `null` (custom extractors write
   * `description: null`), and an empty string. All three mean "extracted, none
   * present" — distinct from a metadata type the vault does not model at all.
   */
  readonly descriptionPresence?: 'present' | 'absent';
}

/**
 * Optional narrows for `countNodesByType` — the SAME WHERE-clause filters
 * `listNodesByType` accepts (CR-22 B3), so a caller can get a TRUE total for a
 * filtered enumeration (e.g. ListViews of ONE object, or every `isBatchable`
 * ApexClass) rather than over-counting the whole type.
 */
export interface CountNodesOptions {
  readonly parentId?: ComponentId;
  readonly propertyEquals?: Readonly<Record<string, boolean>>;
  readonly propertyStringEquals?: Readonly<Record<string, string>>;
  readonly recordTriggered?: boolean;
  readonly descriptionPresence?: 'present' | 'absent';
}

const appendNodePropertyFilters = (
  sql: string,
  params: DuckDBValue[],
  options?: Pick<
    ListNodesOptions,
    'propertyEquals' | 'propertyStringEquals' | 'recordTriggered' | 'descriptionPresence'
  >,
): string => {
  let out = sql;
  if (options?.propertyEquals !== undefined) {
    for (const [key, value] of Object.entries(options.propertyEquals)) {
      out += ` AND json_extract_string(properties_json, ?) = ?`;
      params.push(`$.${key}`, value ? 'true' : 'false');
    }
  }
  if (options?.propertyStringEquals !== undefined) {
    for (const [key, value] of Object.entries(options.propertyStringEquals)) {
      out += ` AND json_extract_string(properties_json, ?) = ?`;
      params.push(`$.${key}`, value);
    }
  }
  if (options?.recordTriggered === true) {
    out += ` AND json_extract_string(properties_json, '$.triggerType') LIKE 'Record%'`;
  }
  // Description presence/absence. `json_extract_string` returns SQL NULL when
  // the `description` key is absent OR its value is JSON null; `coalesce(...,'')`
  // folds those plus empty-string into one "absent" bucket, so enterprise types
  // (key omitted) and custom extractors (`description: null`) behave identically.
  // Literal JSON path, no user input interpolated (mirrors `recordTriggered`).
  //
  // REPORT-DASHBOARD-GRAPH-PERSISTENCE: `Report`/`Dashboard` nodes deliberately
  // persist NO description TEXT (it is freeform admin prose on a high-volume,
  // now-persisted node family — see the extractor's `descriptionPresenceOnly`
  // note). They carry a `descriptionPresent` BOOLEAN instead. Without honoring
  // it here, `missingDescription: true` would return every report in the org
  // and `hasDescription: true` none of them — a filter that answers confidently
  // and wrongly. Any node WITHOUT `descriptionPresent` is unaffected: the
  // added disjunct/conjunct is false/true respectively for a missing key, so
  // every pre-existing type's result set is byte-identical.
  if (options?.descriptionPresence === 'present') {
    out +=
      ` AND (coalesce(json_extract_string(properties_json, '$.description'), '') <> ''` +
      ` OR coalesce(json_extract_string(properties_json, '$.descriptionPresent'), '') = 'true')`;
  } else if (options?.descriptionPresence === 'absent') {
    out +=
      ` AND coalesce(json_extract_string(properties_json, '$.description'), '') = ''` +
      ` AND coalesce(json_extract_string(properties_json, '$.descriptionPresent'), '') <> 'true'`;
  }
  return out;
};

/** Options for `listEdges`. */
export interface ListEdgesOptions {
  readonly direction?: 'in' | 'out' | 'both';
  readonly edgeType?: EdgeType;
  readonly confidence?: ConfidenceLevel;
}

/** Options for `listEdgesForNodes` — the batched, multi-node `listEdges`. */
export interface ListEdgesForNodesOptions {
  /** Defaults to `'both'`, matching `listEdges`. */
  readonly direction?: 'in' | 'out' | 'both';
  /**
   * When set, restrict to edges whose `edge_type` is in this list (a batched
   * `edge_type IN (...)`). Reproduces the union of N per-`(node, edgeType)`
   * `listEdges` calls in one round-trip. Omit for all edge types.
   */
  readonly edgeTypes?: readonly EdgeType[];
}

/** Options for `searchNodes` / `searchNodesPage`. */
export interface SearchNodesOptions {
  readonly limit?: number;
  /** Zero-based page offset. Applied in SQL alongside `limit`. */
  readonly offset?: number;
  readonly types?: readonly ComponentType[];
}

/**
 * A page of search hits PLUS the true match count before `limit`/`offset`.
 *
 * `hits.length` is a page length. Returning it alone — which is all
 * `searchNodes` ever did — left the caller unable to tell a complete answer
 * from a 1.3% sample of 1,931 matches.
 */
export interface SearchNodesPage {
  readonly hits: readonly SearchHit[];
  /**
   * TRUE total matching the query (post-`types` filter), before paging — on
   * EVERY page, including one whose `offset` has already run past the end (that
   * page costs one extra `COUNT(*)` rather than reporting a misleading `0`).
   */
  readonly totalCount: number;
}

type Row = Readonly<Record<string, unknown>>;

/**
 * C-3 (finding 34) — defensive try/catch around `JSON.parse`. The prior bare
 * `JSON.parse(raw)` assumed `import.ts` only ever writes valid-JSON objects
 * via `canonicalJson` — true for the common path, but `canonicalJson`'s
 * pre-fix `undefined`-value handling could (latently) emit an invalid
 * `properties_json` string, and a hand-edited/corrupted DB file is also not
 * impossible. Without a catch, a single malformed row threw an anonymous
 * `SyntaxError` that crashed EVERY query touching it. Degrading to `{}` (the
 * same fallback already used for a structurally-wrong-but-parseable value,
 * e.g. a JSON array) keeps one bad row from poisoning the whole read path;
 * `idHint` (the row's own id, when the caller has it) is folded into the
 * `console.warn` so the offending row is identifiable instead of an
 * anonymous parse failure.
 */
const parseProperties = (
  raw: unknown,
  idHint?: string,
): Readonly<Record<string, unknown>> => {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (e) {
    console.warn(
      `sf-intelligence: malformed properties_json${idHint !== undefined ? ` on ${idHint}` : ''} — degrading to {} (${(e as Error).message})`,
    );
    return {};
  }
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
  properties: parseProperties(r['properties_json'], r['id'] as string | undefined),
});

const rowToEdge = (r: Row): Edge => ({
  fromId: r['from_id'] as ComponentId,
  toId: r['to_id'] as ComponentId,
  edgeType: r['edge_type'] as EdgeType,
  confidence: r['confidence'] as ConfidenceLevel,
  source: r['source'] as string,
  properties: parseProperties(
    r['properties_json'],
    r['from_id'] !== undefined && r['to_id'] !== undefined
      ? `${r['from_id'] as string} -> ${r['to_id'] as string}`
      : undefined,
  ),
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
 *
 * Exported so self-contained-slice consumers that build their OWN node set (and
 * so cannot lean on `getSubgraph`'s bookkeeping) — e.g. `call_graph`'s BFS —
 * apply the SAME phantom predicate rather than re-deriving a divergent one.
 */
export const isHiddenUnresolved = (e: Edge): boolean =>
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
 * Batched form of {@link getNodeById}: fetch the `Node` rows for every id in
 * `ids` in ONE `WHERE id IN (...)` round-trip. Ids with no matching row are
 * dropped from the result EXACTLY like the per-id `getNodeById` null-skip — so
 * a caller iterating `ids` and dropping nulls gets the same node SET (the
 * result is unordered; callers re-sort). An empty `ids` self-guards to
 * `ok([])` rather than emitting an invalid `IN ()`. Duplicate ids collapse to
 * one row (a node id is unique), matching a per-id loop that fetches the same
 * row twice but produces a set.
 *
 * The N+1 batching primitive for `get_impact`'s `fetchNodes` (CR-17);
 * `getNodeById` stays unchanged for its single-id callers.
 *
 * @example
 *   const r = await listNodesByIds(store, ['CustomObject:Account']);
 *   if (r.ok) console.log(r.value.length);
 */
export const listNodesByIds = async (
  store: GraphStore,
  ids: readonly ComponentId[],
): Promise<Result<readonly Node[], GraphError>> => {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) {
    return ok([]);
  }
  const placeholders = uniqueIds.map(() => '?').join(', ');
  try {
    const rows = await fetchRows(
      store,
      `SELECT ${NODE_COLUMNS} FROM nodes WHERE id IN (${placeholders})`,
      [...uniqueIds],
    );
    return ok(rows.map(rowToNode));
  } catch (e) {
    return err(queryFailed('listNodesByIds', e));
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
  sql = appendNodePropertyFilters(sql, params, options);
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
 * CR-22 B3: accepts the SAME `parentId` / `propertyEquals` narrows as
 * `listNodesByType`, so a TRUE total can back a FILTERED paginated enumeration
 * (e.g. ListViews of one object, or `{type, isBatchable:true}`) instead of
 * over-counting the whole type. With no options the SQL is unchanged (a bare
 * `WHERE type = ?`), so existing callers are byte-identical.
 *
 * @example
 *   const r = await countNodesByType(store, 'CustomField');
 *   if (r.ok) console.log(`${r.value} fields`);
 *   const v = await countNodesByType(store, 'ListView', { parentId: 'CustomObject:Account' });
 */
export const countNodesByType = async (
  store: GraphStore,
  type: ComponentType,
  options?: CountNodesOptions,
): Promise<Result<number, GraphError>> => {
  try {
    const params: DuckDBValue[] = [type];
    let sql = `SELECT count(*)::INT AS n FROM nodes WHERE type = ?`;
    if (options?.parentId !== undefined) {
      sql += ' AND parent_id = ?';
      params.push(options.parentId);
    }
    // Same parameterised JSON-path filter as `listNodesByType` — key bound as
    // `$.<key>`, never concatenated, so it cannot inject. An absent property is
    // NULL, which fails `= 'true'` (correct "not a Batchable" semantics).
    sql = appendNodePropertyFilters(sql, params, options);
    const rows = await fetchRows(store, sql, params);
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
 *
 * EXPORTED because a caller cannot tell a capped scan from a complete one
 * without it: {@link listNodeIdentities} returns a bare array, so the only
 * truncation signal is `result.length >= IDENTITY_SCAN_MAX`. While this was
 * module-private every such caller hand-copied the literal, and a copy that
 * drifts low makes a truncated scan report itself COMPLETE — the caller then
 * answers "no dependencies found" off a scan that never saw the tail. Import
 * this constant rather than re-typing the number.
 */
export const IDENTITY_SCAN_MAX = 100_000;

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
 * Optional edgeType and confidence filters.
 *
 * Sorted by the FULL total order `(to_id, edge_type, from_id, source)` — the
 * same order {@link compareEdgesByEndpoint} pins. The leading `(to_id,
 * edge_type)` keys are unchanged, so any group with at most one edge per
 * `(to_id, edge_type)` keeps its previous order byte-for-byte; the
 * `(from_id, source)` tiebreak only ever decides order WITHIN a same-endpoint
 * group, which was previously DuckDB-unspecified. CR-22: offset-resumed paging
 * (`get_edges`) requires this unique final tiebreak so a resume cannot skip or
 * duplicate an edge that shares `(to_id, edge_type)` with its neighbor. The
 * `(from_id, source)` pair is unique per `(to_id, edge_type)` because the
 * edges table PK is `(from_id, to_id, edge_type, source)`.
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
      `SELECT ${EDGE_COLUMNS} FROM edges WHERE ${where} ` +
        `ORDER BY to_id ASC, edge_type ASC, from_id ASC, source ASC`,
      params,
    );
    return ok(rows.map(rowToEdge));
  } catch (e) {
    return err(queryFailed('listEdges', e));
  }
};

/**
 * Total order over edges: `(to_id, edge_type, from_id, source)`. `listEdges`
 * sorts only by `(to_id, edge_type)`, leaving the intra-group order
 * DuckDB-unspecified; the batched `listEdgesForNodes` pins this FULL tiebreak
 * so each per-node bucket is deterministic and reproducible across runs. The
 * leading `(to_id, edge_type)` keys keep the prefix identical to `listEdges`
 * for any group with at most one edge per `(to_id, edge_type)`; the
 * `(from_id, source)` tiebreak only ever decides order WITHIN a same-endpoint
 * group, which is exactly where `listEdges`' order was undefined.
 */
const compareEdgesByEndpoint = (a: Edge, b: Edge): number => {
  if (a.toId !== b.toId) return a.toId < b.toId ? -1 : 1;
  if (a.edgeType !== b.edgeType) return a.edgeType < b.edgeType ? -1 : 1;
  if (a.fromId !== b.fromId) return a.fromId < b.fromId ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return 0;
};

/**
 * Batched, multi-node form of {@link listEdges}: fetch every edge incident to
 * ANY id in `nodeIds` in ONE SQL round-trip, then partition the rows per node
 * in memory. Returns a `Map` keyed by each requested id; a node with no
 * incident edges maps to `[]`, and every requested id is always present as a
 * key. Each bucket is sorted by the FULL `(to_id, edge_type, from_id, source)`
 * total order (see {@link compareEdgesByEndpoint}) so the partition is
 * deterministic — `listEdges`' `(to_id, edge_type)` sort left the intra-group
 * order undefined.
 *
 * This is the N+1 batching primitive for CR-17: callers that previously ran
 * `listEdges` once per frontier/page node (`get_impact`'s BFS,
 * `renderVault`'s per-node render) issue O(1) queries per batch instead of
 * O(nodes). `listEdges` itself is intentionally left unchanged for its ~84
 * single-node callers.
 *
 * Semantics per `direction` mirror `listEdges`:
 *   - `'both'` (default): an edge buckets under id X iff `from_id === X` OR
 *     `to_id === X`. A self-loop or a within-batch edge whose BOTH endpoints
 *     are requested appears in BOTH buckets — exactly as N separate
 *     `listEdges(X)` calls would each return it.
 *   - `'in'`: buckets under `to_id` only.
 *   - `'out'`: buckets under `from_id` only.
 *
 * `edgeTypes` (optional) restricts to those types via a batched
 * `edge_type IN (...)`, reproducing the union of N per-`(node, edgeType)`
 * `listEdges` calls. An empty `nodeIds` self-guards to `ok(new Map())` without
 * emitting an invalid `IN ()`; an empty `edgeTypes` array is treated as "no
 * edge-type filter" (same as omitting it).
 *
 * @example
 *   const r = await listEdgesForNodes(store, ['CustomObject:Account'], {
 *     direction: 'in',
 *   });
 *   if (r.ok) for (const e of r.value.get('CustomObject:Account') ?? []) ...
 */
export const listEdgesForNodes = async (
  store: GraphStore,
  nodeIds: readonly ComponentId[],
  options?: ListEdgesForNodesOptions,
): Promise<Result<ReadonlyMap<ComponentId, readonly Edge[]>, GraphError>> => {
  const direction = options?.direction ?? 'both';
  // Always return a key for every requested id (de-duplicated; order of
  // insertion follows first occurrence in `nodeIds`).
  const buckets = new Map<ComponentId, Edge[]>();
  for (const id of nodeIds) {
    if (!buckets.has(id)) buckets.set(id, []);
  }
  // Self-guard: an empty placeholder list produces invalid `IN ()` SQL.
  if (buckets.size === 0) {
    return ok(buckets);
  }
  const uniqueIds = [...buckets.keys()];
  const idPlaceholders = uniqueIds.map(() => '?').join(', ');
  const params: DuckDBValue[] = [];
  let where: string;
  if (direction === 'out') {
    where = `from_id IN (${idPlaceholders})`;
    params.push(...uniqueIds);
  } else if (direction === 'in') {
    where = `to_id IN (${idPlaceholders})`;
    params.push(...uniqueIds);
  } else {
    where = `(from_id IN (${idPlaceholders}) OR to_id IN (${idPlaceholders}))`;
    params.push(...uniqueIds, ...uniqueIds);
  }
  const edgeTypes = options?.edgeTypes;
  if (edgeTypes !== undefined && edgeTypes.length > 0) {
    where += ` AND edge_type IN (${edgeTypes.map(() => '?').join(', ')})`;
    params.push(...edgeTypes);
  }
  try {
    const rows = await fetchRows(
      store,
      `SELECT ${EDGE_COLUMNS} FROM edges WHERE ${where}`,
      params,
    );
    const requested = new Set(uniqueIds);
    for (const row of rows) {
      const edge = rowToEdge(row);
      // Bucket under each requested endpoint the edge is incident to. With
      // `direction !== 'both'` only one side can match a requested id, so an
      // edge lands in exactly one bucket; with `'both'` a self-loop or a
      // both-endpoints-requested edge lands in both, mirroring N separate
      // `listEdges` calls.
      if (
        (direction === 'in' || direction === 'both') &&
        requested.has(edge.toId)
      ) {
        buckets.get(edge.toId)!.push(edge);
      }
      if (
        (direction === 'out' || direction === 'both') &&
        requested.has(edge.fromId) &&
        // Guard the both-direction self-loop: when fromId === toId the edge was
        // already pushed under the `in`/both branch above; a single
        // `listEdges(X)` call returns a self-loop ONCE, so don't double-count.
        !(direction === 'both' && edge.fromId === edge.toId)
      ) {
        buckets.get(edge.fromId)!.push(edge);
      }
    }
    for (const bucket of buckets.values()) {
      bucket.sort(compareEdgesByEndpoint);
    }
    return ok(buckets);
  } catch (e) {
    return err(queryFailed('listEdgesForNodes', e));
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

/**
 * The COMPLETE (un-sampled) set of distinct `to_id`s of edges whose target
 * resolves to NO node — references to a component the last refresh did not
 * retrieve — pre-filtered to ids containing `substring` (case-insensitive).
 *
 * Unlike {@link danglingTargetSummary}, this is NOT capped by a per-group
 * sample: a caller counting a package's phantom touchpoints (a managed Apex
 * class granted by a PermissionSet whose class node was never retrieved) needs
 * EVERY dangling target in the namespace, not a truncated prefix — a busy vault
 * has far more than 50 dangling `ApexClass` grant targets across its packages,
 * and a namespace whose members sort late (e.g. `SparkTable__*`) would fall
 * outside a smallest-50 sample and be under-counted
 * (PACKAGE-IMPACT-TWO-SEGMENT-NAMESPACE-BLIND count residual). The `substring`
 * is a cheap, case-insensitive pre-filter that bounds the result to the
 * namespace of interest — it is deliberately LOOSE (matches the namespace token
 * anywhere in the id): it can never drop a genuine member (whose id necessarily
 * contains the namespace token), and the caller applies the AUTHORITATIVE
 * namespace rule on top. An empty `substring` returns `[]` (a namespace is
 * always non-empty in the caller). Ids come back sorted ASC for determinism.
 *
 * @example
 *   const r = await danglingTargetIdsMatching(store, 'SparkTable');
 *   if (r.ok) for (const id of r.value) console.log(id); // ApexClass:SparkTable__…
 */
export const danglingTargetIdsMatching = async (
  store: GraphStore,
  substring: string,
): Promise<Result<readonly ComponentId[], GraphError>> => {
  const needle = substring.trim();
  if (needle.length === 0) return ok([]);
  try {
    const rows = await fetchRows(
      store,
      `SELECT DISTINCT e.to_id AS to_id
         FROM edges e
         LEFT JOIN nodes n ON e.to_id = n.id
        WHERE n.id IS NULL
          AND e.to_id ILIKE ?
        ORDER BY 1`,
      [`%${needle}%`],
    );
    return ok(rows.map((r) => String(r['to_id'] ?? '')) as ComponentId[]);
  } catch (e) {
    return err(queryFailed('danglingTargetIdsMatching', e));
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
 * length(api_name) ASC, api_name ASC, id ASC` — see PAGING TOTAL ORDER at the
 * SQL below for why the `id` key is load-bearing. Limit defaults to 25
 * (max 100). Empty query returns `ok([])`.
 *
 * `totalCount` is the TRUE post-filter match count on EVERY page, including a
 * page whose `offset` has already run past the end of the result set.
 *
 * @example
 *   const r = await searchNodes(store, 'Industry', { limit: 10 });
 *   if (r.ok) for (const hit of r.value) console.log(hit.score, hit.snippet);
 */
export const searchNodesPage = async (
  store: GraphStore,
  query: string,
  options?: SearchNodesOptions,
): Promise<Result<SearchNodesPage, GraphError>> => {
  const limit = options?.limit ?? SEARCH_DEFAULT_LIMIT;
  const offset = options?.offset ?? 0;
  if (limit > SEARCH_MAX_LIMIT) {
    return err({
      kind: 'query-failed',
      message: `searchNodes: limit exceeds ${SEARCH_MAX_LIMIT}`,
    });
  }
  if (query.length === 0) return ok({ hits: [], totalCount: 0 });

  const pattern = `%${query}%`;
  const prefixPattern = `${query}%`;
  // LIKE patterns are UNCHANGED — a `%` / `_` in a query keeps behaving exactly
  // as it did, because changing LIKE semantics is not this fix. The new
  // whole-token tier is the only place caller input reaches a REGEX engine, and
  // it is escaped for that engine specifically.
  const tokenPattern = `(^|[^A-Za-z0-9])${regexEscape(query)}([^A-Za-z0-9]|$)`;
  // The WHERE clause and ITS parameters are built ONCE and shared by the page
  // query and the over-run total below, so the two can never describe different
  // row sets. (A hand-copied second predicate is exactly how a total drifts from
  // the rows it claims to count.)
  let typesClause = '';
  const whereParams: DuckDBValue[] = [pattern, pattern, pattern];
  if (options?.types !== undefined && options.types.length > 0) {
    typesClause = ` AND type IN (${options.types.map(() => '?').join(', ')})`;
    whereParams.push(...options.types);
  }
  const whereSql =
    `WHERE (api_name ILIKE ? OR label ILIKE ? OR properties_json ILIKE ?)` +
    typesClause;
  // 1 exact + 1 prefix + 1 token-regex + 3 score ILIKEs, then the WHERE params.
  const params: DuckDBValue[] = [
    query,
    prefixPattern,
    tokenPattern,
    pattern,
    pattern,
    pattern,
    ...whereParams,
    limit,
    offset,
  ];

  // `COUNT(*) OVER ()` gives the TRUE post-filter match count in the SAME
  // round-trip and against the SAME WHERE clause — no second query, and no way
  // for the total to drift from the rows it describes.
  //
  // PAGING TOTAL ORDER — the rule for EVERY `LIMIT ? OFFSET ?` query in this
  // file: the last `ORDER BY` key must be UNIQUE across the rows being paged.
  // `score` / `length(api_name)` / `api_name` are all non-unique (a vault can
  // hold ten `Name` fields on ten objects), so a tie left DuckDB free to order
  // those rows differently for each OFFSET window: a row could land in two
  // windows while a tied sibling landed in none. `id` is the `nodes` primary
  // key, so appending it makes the order TOTAL and the walk exhaustive.
  // The only other paged query here (`listNodesByType`) already ends on
  // `id ASC`; nothing else in this file takes an OFFSET.
  const sql = `SELECT id, api_name, label, properties_json,
      COUNT(*) OVER () AS total_matches,
      CASE
        WHEN api_name = ? THEN 3.0
        WHEN api_name ILIKE ? THEN 2.8
        WHEN regexp_matches(lower(api_name), lower(?)) THEN 2.6
        WHEN api_name ILIKE ? THEN 2.5
        WHEN label ILIKE ? THEN 2.0
        WHEN properties_json ILIKE ? THEN 1.0
        ELSE 0.0
      END AS score
    FROM nodes
    ${whereSql}
    ORDER BY score DESC, length(api_name) ASC, api_name ASC, id ASC
    LIMIT ? OFFSET ?`;

  try {
    const rows = await fetchRows(store, sql, params);
    const hits = rows.map((r) => ({
      id: r['id'] as ComponentId,
      score: Number(r['score']),
      snippet: buildSnippet(
        query,
        r['api_name'] as string,
        (r['label'] ?? null) as string | null,
        (r['properties_json'] as string | null) ?? '{}',
      ),
    }));
    // `total_matches` is constant across the window, so the page carries its own
    // total for free. An OVER-RUN page (offset already past the end) returns no
    // rows and therefore no window value — and a `0` there would be an UNCHECKED
    // zero wearing a CHECKED zero's clothes: indistinguishable from "nothing
    // matched". One extra COUNT, on the SAME `whereSql`/`whereParams`, is paid
    // only on that page and makes `totalCount` TRUE on every response.
    let totalCount =
      rows.length > 0 ? Number(rows[0]?.['total_matches'] ?? 0) : 0;
    if (rows.length === 0 && offset > 0) {
      const countRows = await fetchRows(
        store,
        `SELECT COUNT(*) AS total_matches FROM nodes ${whereSql}`,
        whereParams,
      );
      totalCount = Number(countRows[0]?.['total_matches'] ?? 0);
    }
    return ok({ hits, totalCount });
  } catch (e) {
    return err(queryFailed('searchNodes', e));
  }
};

/**
 * Back-compat projection: the hit list alone, for callers that never wanted
 * the total (`object_360`'s case-insensitive object-id probe). ONE
 * implementation, one thin projection.
 */
export const searchNodes = async (
  store: GraphStore,
  query: string,
  options?: SearchNodesOptions,
): Promise<Result<readonly SearchHit[], GraphError>> => {
  const page = await searchNodesPage(store, query, options);
  return page.ok ? ok(page.value.hits) : page;
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
 * The stub synthesis itself is capped at `SUBGRAPH_MAX_NODES`: a class with
 * more genuine phantom edges than the node cap stops stubbing at the budget and
 * flags `truncated`, so the node bound holds even under `includeUnresolved`.
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
          // Mirror the normal-path node cap: synthesizing a stub still grows the
          // returned node set, so the documented `at most SUBGRAPH_MAX_NODES`
          // bound must hold here too. A single class can carry MORE genuine
          // phantom heuristic edges than maxNodes (edges are budgeted to
          // maxEdges independently of the node cap), so without this guard the
          // stub loop blows past the cap. Stop stubbing once the node budget is
          // spent and flag truncation; the unstubbed phantom endpoints stay out
          // of returnedIds and their edges are dropped by the filter below, so
          // the slice stays self-contained.
          if (returnedNodes.length >= limits.maxNodes) {
            state.truncated = true;
            break;
          }
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
    // SUBGRAPH-PHANTOM-ENDPOINT-EDGE-LOSS: measure the loss BEFORE the filter
    // runs, at the only place that knows what is about to disappear.
    const droppedEndpointEdges = summarizeDroppedEndpointEdges(
      collectedEdges,
      returnedIds,
      visitedNodes,
    );
    const edges = collectedEdges
      .filter((e) => returnedIds.has(e.fromId) && returnedIds.has(e.toId))
      .sort(compareEdges);
    return ok({
      nodes: sortedNodes,
      edges,
      truncated: state.truncated,
      ...(droppedEndpointEdges !== undefined ? { droppedEndpointEdges } : {}),
    });
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
