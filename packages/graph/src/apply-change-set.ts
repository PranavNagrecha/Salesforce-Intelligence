import type { DuckDBConnection } from '@duckdb/node-api';
import type { ComponentType, Edge, ExtractionResult, Node } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';

import {
  buildMultiRowUpsertSql,
  canonicalizeApexCallEdgeTargets,
  canonicalizeFieldEdgeTargets,
  canonicalizeLabelEdgeTargets,
  canonicalizeObjectEdgeTargets,
  canonicalizeResourceEdgeTargets,
  EDGE_COLUMN_COUNT,
  edgeRowParams,
  IMPORT_BATCH_SIZE,
  mintFutureDispatchEdges,
  NODE_COLUMN_COUNT,
  nodeRowParams,
} from './import.js';
import { mintRelationshipTraversalEdges } from './relationship-refs.js';
import type { GraphError, GraphStore } from './store.js';

/**
 * The 4-column primary key of an `edges` row. Identifies an edge for deletion
 * without carrying its payload (`confidence` / `properties_json`).
 */
export interface EdgeKey {
  readonly fromId: string;
  readonly toId: string;
  readonly edgeType: string;
  readonly source: string;
}

/**
 * A transactional delta to bring the graph from its current contents to the
 * desired state (what a cold rebuild of the same source would produce).
 *
 * Produced by {@link computeChangeSet} and consumed by {@link applyChangeSet}.
 * The `finalNodeIds` set and the `desired*Count` fields are carried so the
 * apply can stamp `targetMissing` against the FINAL node set and self-check the
 * post-apply row counts — neither is derivable from the upsert/delete lists
 * alone (those omit the unchanged, surviving rows).
 */
export interface ComputeChangeSetOptions {
  /**
   * When set, only delete nodes (and their edges) whose component type is in
   * this set. Upserts are unchanged. Used when a scoped or partial pull
   * reconciled source for some types but the walk only re-extracted a subset.
   */
  readonly pruneNodeTypes?: ReadonlySet<ComponentType>;
}

const componentTypeFromNodeId = (id: string): ComponentType | null => {
  const sep = id.indexOf(':');
  if (sep < 0) return null;
  return id.slice(0, sep) as ComponentType;
};

export interface ChangeSet {
  /** Nodes to write (added + shape-changed); `INSERT OR REPLACE` by id. */
  readonly upsertNodes: readonly Node[];
  /** Node ids present in the graph but absent from the source — to delete. */
  readonly deleteNodeIds: readonly string[];
  /** Edges to write (added + changed + `targetMissing`-flipped); replace by PK. */
  readonly upsertEdges: readonly Edge[];
  /** Edge PKs present in the graph but absent from the source — to delete. */
  readonly deleteEdgeKeys: readonly EdgeKey[];
  /** Every node id that will exist after the apply — for `targetMissing`. */
  readonly finalNodeIds: ReadonlySet<string>;
  /** Distinct desired node count — post-apply `count(nodes)` must equal it. */
  readonly desiredNodeCount: number;
  /** Distinct desired edge count — post-apply `count(edges)` must equal it. */
  readonly desiredEdgeCount: number;
}

/** Per-apply summary, mirroring the spirit of {@link ImportCounts}. */
export interface ApplyCounts {
  readonly nodesUpserted: number;
  readonly nodesDeleted: number;
  readonly edgesUpserted: number;
  readonly edgesDeleted: number;
}

/**
 * Maximum number of mutated rows (upserts + deletes) an incremental apply will
 * attempt in its single transaction. Above this, the caller should prefer a
 * full batched rebuild: a single transaction buffers every pending write under
 * DuckDB's `preserve_insertion_order=true` (the same reason
 * `IMPORT_BATCH_SIZE` exists), so a near-total change set could exhaust process
 * memory. A genuine small-diff refresh — the feature's target — is far below
 * this; a large delta is no slower to rebuild cold than to apply.
 */
export const INCREMENTAL_DELTA_CAP = 2000;

/** Total mutated-row count of a change set (upserts + deletes, nodes + edges). */
export const changeSetSize = (cs: ChangeSet): number =>
  cs.upsertNodes.length +
  cs.deleteNodeIds.length +
  cs.upsertEdges.length +
  cs.deleteEdgeKeys.length;

const DELETE_NODE_SQL = `DELETE FROM nodes WHERE id = ?`;
const DELETE_EDGE_SQL = `DELETE FROM edges WHERE from_id = ? AND to_id = ? AND edge_type = ? AND source = ?`;

// NUL never appears inside a Salesforce component id, edge type, or extractor
// `source` string, so it is a collision-free join separator for the composite
// edge key (used only for in-memory Map keys during the diff, never persisted).
const PK_SEP = '\u0000';

const edgePk = (fromId: string, toId: string, edgeType: string, source: string): string =>
  `${fromId}${PK_SEP}${toId}${PK_SEP}${edgeType}${PK_SEP}${source}`;

/**
 * A byte-stable key for a serialized row, used only to decide whether a desired
 * row differs from the one already in the graph. Both sides are built from the
 * SAME column order; the only cross-representation columns are `api_version`
 * (a JS number on both sides) and `properties_json` (a string produced by the
 * shared `canonicalJson` on the desired side, stored verbatim on the DB side),
 * so equal rows produce equal keys. A false "changed" verdict is harmless (an
 * idempotent `INSERT OR REPLACE` of an identical row); only false "unchanged"
 * would corrupt, and the column-complete key cannot produce one.
 */
const rowKey = (columns: readonly unknown[]): string => JSON.stringify(columns);

/** Read all node rows into a `Map<id, rowKey>` for diffing. */
const readNodeRowKeys = async (
  connection: DuckDBConnection,
): Promise<Map<string, string>> => {
  const reader = await connection.runAndReadAll(
    `SELECT id, type, api_name, label, parent_id, source_path,
            last_modified_date, last_modified_by, api_version, properties_json
     FROM nodes`,
  );
  const rows = reader.getRowObjectsJS() as ReadonlyArray<Record<string, unknown>>;
  const map = new Map<string, string>();
  for (const r of rows) {
    map.set(
      r['id'] as string,
      rowKey([
        r['id'],
        r['type'],
        r['api_name'],
        r['label'],
        r['parent_id'],
        r['source_path'],
        r['last_modified_date'],
        r['last_modified_by'],
        r['api_version'],
        r['properties_json'],
      ]),
    );
  }
  return map;
};

interface CurrentEdge {
  readonly key: string;
  readonly edgeKey: EdgeKey;
}

/** Read all edge rows into a `Map<edgePk, {rowKey, EdgeKey}>` for diffing. */
const readEdgeRowKeys = async (
  connection: DuckDBConnection,
): Promise<Map<string, CurrentEdge>> => {
  const reader = await connection.runAndReadAll(
    `SELECT from_id, to_id, edge_type, confidence, source, properties_json FROM edges`,
  );
  const rows = reader.getRowObjectsJS() as ReadonlyArray<Record<string, unknown>>;
  const map = new Map<string, CurrentEdge>();
  for (const r of rows) {
    const fromId = r['from_id'] as string;
    const toId = r['to_id'] as string;
    const edgeType = r['edge_type'] as string;
    const source = r['source'] as string;
    map.set(edgePk(fromId, toId, edgeType, source), {
      key: rowKey([
        fromId,
        toId,
        edgeType,
        r['confidence'],
        source,
        r['properties_json'],
      ]),
      edgeKey: { fromId, toId, edgeType, source },
    });
  }
  return map;
};

/**
 * Compute the change set that reconciles the graph to the state a cold rebuild
 * of `results` would produce — full id reconciliation, not a cache-trusting
 * shortcut (correctness over speed; the cheap part is the in-memory id diff,
 * the expensive part was always the row writes).
 *
 * Desired-set dedup mirrors the cold import EXACTLY so the end state is
 * byte-identical: nodes are last-writer-wins (cold path's `INSERT OR REPLACE`),
 * edges are first-writer-wins (cold path's `INSERT OR IGNORE`). `targetMissing`
 * is stamped into each desired edge row against the final node set BEFORE the
 * diff, so an edge whose target's presence flipped (added or deleted) is
 * correctly seen as changed even though its source row never moved.
 */
export const computeChangeSet = async (
  store: GraphStore,
  results: readonly ExtractionResult[],
  options?: ComputeChangeSetOptions,
): Promise<Result<ChangeSet, GraphError>> => {
  const pruneNodeTypes = options?.pruneNodeTypes;
  const { connection } = store;

  // Desired node set: last-writer-wins on id (matches INSERT OR REPLACE).
  const desiredNodes = new Map<string, Node>();
  const desiredEdgeList: Edge[] = [];
  for (const result of results) {
    for (const node of result.nodes) desiredNodes.set(node.id, node);
    for (const edge of result.edges) desiredEdgeList.push(edge);
  }
  // GRF-01: mirror cold import — canonicalize Apex call targets before the
  // first-writer-wins dedupe so incremental apply matches full rebuild.
  canonicalizeApexCallEdgeTargets([...desiredNodes.values()], desiredEdgeList);
  // R6-03: mirror cold import — remap case-variant CustomField targets onto
  // the vaulted field id. INCREMENTAL GAP: only sees the change-set's node
  // view, so a field node outside the change set can't anchor a remap and the
  // edge stays dangling until a full rebuild; full `/sfi-refresh` is the
  // ground truth (same bound as the GRF-01/CR-CAP-09 mirrors above).
  canonicalizeFieldEdgeTargets([...desiredNodes.values()], desiredEdgeList);
  // R7-W3: mirror cold import — remap case-variant CustomObject targets onto
  // the vaulted object id. Same INCREMENTAL GAP as the CustomField mirror
  // above: only sees the change-set's node view.
  canonicalizeObjectEdgeTargets([...desiredNodes.values()], desiredEdgeList);
  // C-2 (finding 25): mirror cold import — remap case-variant CustomLabel
  // ($Label.foo) and StaticResource ($Resource.bar) targets onto the vaulted
  // label/resource id. Same INCREMENTAL GAP as the CustomField/CustomObject
  // mirrors above: only sees the change-set's node view.
  canonicalizeLabelEdgeTargets([...desiredNodes.values()], desiredEdgeList);
  canonicalizeResourceEdgeTargets([...desiredNodes.values()], desiredEdgeList);
  // CR-CAP-09: mirror cold import — mint class-granular @future dispatchesAsync
  // edges after canonicalize. INCREMENTAL GAP: this only sees the change-set's
  // node view (`desiredNodes`), so a future-holding target class outside the
  // change set is invisible and under-mints vs a full refresh; full
  // `/sfi-refresh` is the ground truth. Run before the PK dedupe so the minted
  // edges participate in the same first-writer-wins collapse.
  mintFutureDispatchEdges([...desiredNodes.values()], desiredEdgeList);
  // Mirror cold import — resolve formula `__r` traversals and FlexiPage
  // related-list column aliases into `references` edges. This call is NOT
  // optional here, and the reason is sharper than for the mirrors above: these
  // edges exist ONLY because this pass mints them, so when it did not run the
  // reconcile saw every one of them as absent-from-desired. On the whole-graph
  // path (`pruneNodeTypes` undefined) the preserve-guard below is skipped
  // entirely and every absent edge is deleted — so a routine incremental
  // refresh silently DROPPED real dependency evidence and returned those fields
  // to "no referrers", which `safe_to_delete_field` reads as deletable.
  //
  // INCREMENTAL GAP (same bound as the canonicalize/CR-CAP-09 mirrors above):
  // the relationship map is built from the change-set's node view, so a scoped
  // pull (`--types X`) cannot see lookup fields outside the pull and under-mints
  // versus a full refresh; full `/sfi-refresh` is the ground truth. The
  // whole-graph incremental path passes the complete node set, so it resolves
  // exactly as a cold rebuild does. Run before the PK dedupe so minted edges
  // join the same first-writer-wins collapse.
  mintRelationshipTraversalEdges([...desiredNodes.values()], desiredEdgeList);
  const desiredEdges = new Map<string, Edge>();
  for (const edge of desiredEdgeList) {
    const pk = edgePk(edge.fromId, edge.toId, edge.edgeType, edge.source);
    if (!desiredEdges.has(pk)) desiredEdges.set(pk, edge);
  }
  const finalNodeIds = new Set<string>(desiredNodes.keys());

  // CR-P3-1: the set of extractor `source`s that actually re-ran this reconcile,
  // derived ONLY from the desired edges (an extractor that produced no results
  // for this scoped pull contributes none). A static type→source map is NOT
  // usable: sources are not 1:1 with types (flow-extractor spans
  // Flow→{CustomObject,ApexClass,CustomField}; custom-field.ts emits parentOf
  // with fromId=CustomObject but source=custom-field-extractor). Used below to
  // preserve an absent-from-desired edge whose emitter did not re-run when both
  // endpoints survive (the headline inbound-cross-extractor data-loss fix).
  const reRanSources = new Set<string>();
  for (const e of desiredEdges.values()) reRanSources.add(e.source);

  let currentNodeKeys: Map<string, string>;
  let currentEdges: Map<string, CurrentEdge>;
  try {
    currentNodeKeys = await readNodeRowKeys(connection);
    currentEdges = await readEdgeRowKeys(connection);
  } catch (e) {
    return err({
      kind: 'query-failed',
      message: `failed to read current graph for change set: ${(e as Error).message}`,
    });
  }

  const upsertNodes: Node[] = [];
  for (const [id, node] of desiredNodes) {
    if (currentNodeKeys.get(id) !== rowKey(nodeRowParams(node))) {
      upsertNodes.push(node);
    }
  }
  const deleteNodeIds: string[] = [];
  for (const id of currentNodeKeys.keys()) {
    if (desiredNodes.has(id)) continue;
    if (pruneNodeTypes !== undefined) {
      const type = componentTypeFromNodeId(id);
      if (type === null || !pruneNodeTypes.has(type)) continue;
    }
    deleteNodeIds.push(id);
  }
  // CR-P3-1: set form of the just-computed node deletes, used by the edge loop's
  // orphan clause to drop edges incident to a deleted node.
  const deleteNodeSet = new Set<string>(deleteNodeIds);

  const upsertEdges: Edge[] = [];
  for (const [pk, edge] of desiredEdges) {
    const desiredKey = rowKey(edgeRowParams(edge, finalNodeIds));
    if (currentEdges.get(pk)?.key !== desiredKey) upsertEdges.push(edge);
  }
  const deleteEdgeKeys: EdgeKey[] = [];
  for (const [pk, current] of currentEdges) {
    if (desiredEdges.has(pk)) continue;
    // CR-P3-1 HYBRID criterion (scoped/pruned path only — gated on
    // pruneNodeTypes set). Delete an absent-from-desired edge IFF (i) it is
    // incident to a DELETED node, OR (ii) its emitting source RE-RAN this
    // reconcile AND it touches a pruned type. The plain `touchesPrunedType`
    // guard alone silently deleted an inbound cross-extractor edge (e.g.
    // QuickAction:N→Flow:Y) on `sfi refresh --types Flow` even though both
    // endpoints survived and its emitter never re-ran. The whole-graph
    // (--incremental-graph) path leaves pruneNodeTypes undefined and is
    // UNCHANGED: every absent edge is deleted there as before.
    if (pruneNodeTypes !== undefined) {
      const { fromId, toId, source } = current.edgeKey;
      const incidentToDeletedNode = deleteNodeSet.has(fromId) || deleteNodeSet.has(toId);
      if (!incidentToDeletedNode) {
        const fromType = componentTypeFromNodeId(fromId);
        const toType = componentTypeFromNodeId(toId);
        const touchesPrunedType =
          (fromType !== null && pruneNodeTypes.has(fromType)) ||
          (toType !== null && pruneNodeTypes.has(toType));
        const sourceReRan = reRanSources.has(source);
        // Preserve (req #1): not an orphan and not a genuinely-stale same-source
        // edge. The type-gate conjunct neutralizes a source shared across types
        // (e.g. vf-scanner over VisualforcePage + VisualforceComponent).
        if (!(sourceReRan && touchesPrunedType)) continue;
      }
    }
    deleteEdgeKeys.push(current.edgeKey);
  }

  return ok({
    upsertNodes,
    deleteNodeIds,
    upsertEdges,
    deleteEdgeKeys,
    finalNodeIds,
    desiredNodeCount: desiredNodes.size,
    desiredEdgeCount: desiredEdges.size,
  });
};

/**
 * Upsert `rows` into `table` via multi-row `INSERT OR REPLACE` statements,
 * chunked at {@link IMPORT_BATCH_SIZE}. Each chunk is ONE `connection.run` (a
 * statement of `chunk.length` value-tuples with flattened positional params),
 * issued on the connection the caller has ALREADY put in an open transaction.
 *
 * This is the CR-20 Part-1 batching: it replaces the row-at-a-time upsert loops
 * but deliberately does NOT begin/commit anything — atomicity stays with the
 * single transaction `applyChangeSet` owns. (Contrast cold import's
 * `commitBatched`, which commits per chunk; adopting that here would break the
 * documented all-or-nothing invariant.) Chunking still bounds the in-flight
 * write buffer per statement, the same reason `IMPORT_BATCH_SIZE` exists.
 *
 * Insertion order is preserved: chunks run in array order and each multi-row
 * statement binds rows in array order, so the end state matches a row-at-a-time
 * apply (and a cold rebuild) byte-for-byte under last-writer-wins on the PK.
 */
const upsertRowsChunked = async <T>(
  connection: DuckDBConnection,
  table: 'nodes' | 'edges',
  columnCount: number,
  rows: readonly T[],
  rowParams: (row: T) => readonly unknown[],
): Promise<void> => {
  for (let start = 0; start < rows.length; start += IMPORT_BATCH_SIZE) {
    const chunk = rows.slice(start, start + IMPORT_BATCH_SIZE);
    const sql = buildMultiRowUpsertSql(table, columnCount, chunk.length);
    const params: unknown[] = [];
    for (const row of chunk) {
      for (const p of rowParams(row)) params.push(p);
    }
    await connection.run(sql, params as never);
  }
};

const scalarCount = async (
  connection: DuckDBConnection,
  table: 'nodes' | 'edges',
): Promise<number> => {
  const reader = await connection.runAndReadAll(
    `SELECT count(*)::INT AS n FROM ${table}`,
  );
  const rows = reader.getRowObjectsJS() as ReadonlyArray<Record<string, unknown>>;
  return Number(rows[0]?.['n'] ?? 0);
};

/**
 * Apply a change set in a SINGLE transaction — all-or-nothing. On any error
 * (including the post-apply count self-check failing) the transaction is rolled
 * back, leaving the graph byte-for-byte as it was before the call. This is the
 * "consistent under a mid-import failure" invariant: a half-applied graph is
 * never observable.
 *
 * The self-check compares the post-apply `count(nodes)`/`count(edges)` against
 * the change set's distinct desired counts BEFORE committing. A mismatch means
 * the diff was wrong; rather than commit a subtly-corrupt graph, the call rolls
 * back and returns an error so the caller can fall back to a full rebuild.
 */
export const applyChangeSet = async (
  store: GraphStore,
  changeSet: ChangeSet,
): Promise<Result<ApplyCounts, GraphError>> => {
  const { connection } = store;

  try {
    await connection.run('BEGIN TRANSACTION;');
  } catch (e) {
    return err({
      kind: 'query-failed',
      message: `applyChangeSet: failed to begin transaction: ${(e as Error).message}`,
    });
  }

  const rollback = async (): Promise<void> => {
    try {
      await connection.run('ROLLBACK;');
    } catch {
      // Swallow; the original error is what the caller needs to see.
    }
  };

  try {
    // Order: delete edges, delete nodes, upsert nodes, upsert edges. Deletes
    // first keeps the working set small; node upserts before edge upserts so an
    // edge's freshly-added target node already exists when the edge is written.
    //
    // CR-20 Part 1: the two upsert loops are batched into multi-row statements
    // (one `connection.run` per IMPORT_BATCH_SIZE chunk) to cut the per-row
    // round-trips on a large diff — still inside this single transaction, so the
    // all-or-nothing invariant is unchanged. Deletes stay per-row: the volume
    // lives in the upserts, and a row-at-a-time delete is the simplest exact-PK
    // guarantee (the composite edge key has four columns).
    for (const k of changeSet.deleteEdgeKeys) {
      await connection.run(DELETE_EDGE_SQL, [k.fromId, k.toId, k.edgeType, k.source]);
    }
    for (const id of changeSet.deleteNodeIds) {
      await connection.run(DELETE_NODE_SQL, [id]);
    }
    await upsertRowsChunked(
      connection,
      'nodes',
      NODE_COLUMN_COUNT,
      changeSet.upsertNodes,
      nodeRowParams,
    );
    await upsertRowsChunked(
      connection,
      'edges',
      EDGE_COLUMN_COUNT,
      changeSet.upsertEdges,
      (edge) => edgeRowParams(edge, changeSet.finalNodeIds),
    );

    const nodeCount = await scalarCount(connection, 'nodes');
    const edgeCount = await scalarCount(connection, 'edges');
    if (
      nodeCount !== changeSet.desiredNodeCount ||
      edgeCount !== changeSet.desiredEdgeCount
    ) {
      await rollback();
      return err({
        kind: 'query-failed',
        message:
          `applyChangeSet: post-apply count mismatch (nodes ${nodeCount} vs ` +
          `${changeSet.desiredNodeCount}, edges ${edgeCount} vs ` +
          `${changeSet.desiredEdgeCount}); rolled back — caller should rebuild full`,
      });
    }

    await connection.run('COMMIT;');
    return ok({
      nodesUpserted: changeSet.upsertNodes.length,
      nodesDeleted: changeSet.deleteNodeIds.length,
      edgesUpserted: changeSet.upsertEdges.length,
      edgesDeleted: changeSet.deleteEdgeKeys.length,
    });
  } catch (e) {
    await rollback();
    return err({
      kind: 'query-failed',
      message: `applyChangeSet: ${(e as Error).message}; transaction rolled back`,
    });
  }
};

/** Per-prune summary: how many stale nodes/edges the scoped prune dropped. */
export interface PruneCounts {
  readonly nodesDeleted: number;
  readonly edgesDeleted: number;
}

/**
 * Prune ONLY the stale rows a scoped/partial reconcile produced — the delete
 * lists of a change set built with `computeChangeSet(..., { pruneNodeTypes })`.
 *
 * This is the CR-20 Part-2 path for the scoped/pruned WITH-PULL refresh, where
 * `importExtractionResults` has ALREADY persisted the reconciled type's fresh
 * rows; all that remains is dropping the stale rows of the reconciled types.
 *
 * It deliberately does NOT route through {@link applyChangeSet}: that function's
 * post-apply self-check compares the GLOBAL `count(nodes)`/`count(edges)` to the
 * change set's `desiredNodeCount`/`desiredEdgeCount`, which `computeChangeSet`
 * derives ONLY from the reconciled subset (`results`). On any multi-type graph
 * the global count is larger than the reconciled-only desired count, so the
 * self-check trips, rolls back, and leaves the stale rows orphaned (and the CLI
 * branch hard-fails). `pruneStaleNodes` sidesteps the whole-graph self-check
 * entirely and only executes the already-type-scoped DELETEs:
 *   - `deleteNodeIds` holds only current nodes whose type ∈ `pruneNodeTypes` and
 *     that the reconcile no longer contains, so surviving types are never in it.
 *   - `deleteEdgeKeys` (CR-P3-1 hybrid criterion) holds an absent-from-desired
 *     edge ONLY when it is incident to a deleted node OR its emitting source
 *     re-ran this reconcile AND it touches a pruned type. So it covers the
 *     pruned nodes' orphan edges and genuinely-stale same-source edges, but
 *     NEVER an inbound cross-extractor edge whose emitter did not re-run while
 *     both endpoints survive (the silent-data-loss class CR-P3-1 fixed).
 *
 * The DELETEs run in {@link IMPORT_BATCH_SIZE}-sized transactions (the proven
 * cold-import batched-commit pattern). That bounds the in-flight working set, so
 * an OVER-`INCREMENTAL_DELTA_CAP` prune is still safe to run in full — on this
 * branch the cap is therefore informational only: over-cap STILL prunes (never
 * no-ops, never falls back to a whole-graph rebuild that would defeat the scope).
 *
 * Atomicity is per batch, not per call (matching `commitBatched`). The upserts
 * were already committed by `importExtractionResults`; these deletes only remove
 * orphans, and a re-run re-issues the same idempotent DELETEs, so a mid-prune
 * failure leaves a coherent (if not-yet-fully-pruned) graph that the next
 * refresh finishes.
 */
export const pruneStaleNodes = async (
  store: GraphStore,
  changeSet: ChangeSet,
): Promise<Result<PruneCounts, GraphError>> => {
  const { connection } = store;

  // Edges first so a node's incident edges are gone before the node row, then
  // nodes. Both batched at IMPORT_BATCH_SIZE, each batch in its own transaction.
  for (let start = 0; start < changeSet.deleteEdgeKeys.length; start += IMPORT_BATCH_SIZE) {
    const batch = changeSet.deleteEdgeKeys.slice(start, start + IMPORT_BATCH_SIZE);
    try {
      await connection.run('BEGIN TRANSACTION;');
      for (const k of batch) {
        await connection.run(DELETE_EDGE_SQL, [k.fromId, k.toId, k.edgeType, k.source]);
      }
      await connection.run('COMMIT;');
    } catch (e) {
      try {
        await connection.run('ROLLBACK;');
      } catch {
        // Swallow; the original error is what the caller needs to see.
      }
      return err({
        kind: 'query-failed',
        message: `pruneStaleNodes: failed deleting stale edges: ${(e as Error).message}`,
      });
    }
  }

  for (let start = 0; start < changeSet.deleteNodeIds.length; start += IMPORT_BATCH_SIZE) {
    const batch = changeSet.deleteNodeIds.slice(start, start + IMPORT_BATCH_SIZE);
    try {
      await connection.run('BEGIN TRANSACTION;');
      for (const id of batch) {
        await connection.run(DELETE_NODE_SQL, [id]);
      }
      await connection.run('COMMIT;');
    } catch (e) {
      try {
        await connection.run('ROLLBACK;');
      } catch {
        // Swallow; the original error is what the caller needs to see.
      }
      return err({
        kind: 'query-failed',
        message: `pruneStaleNodes: failed deleting stale nodes: ${(e as Error).message}`,
      });
    }
  }

  return ok({
    nodesDeleted: changeSet.deleteNodeIds.length,
    edgesDeleted: changeSet.deleteEdgeKeys.length,
  });
};
