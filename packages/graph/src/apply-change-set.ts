import type { DuckDBConnection } from '@duckdb/node-api';
import type { ComponentType, Edge, ExtractionResult, Node } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';

import {
  canonicalizeApexCallEdgeTargets,
  edgeRowParams,
  INSERT_NODE_SQL,
  nodeRowParams,
  REPLACE_EDGE_SQL,
} from './import.js';
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
  const desiredEdges = new Map<string, Edge>();
  for (const edge of desiredEdgeList) {
    const pk = edgePk(edge.fromId, edge.toId, edge.edgeType, edge.source);
    if (!desiredEdges.has(pk)) desiredEdges.set(pk, edge);
  }
  const finalNodeIds = new Set<string>(desiredNodes.keys());

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

  const upsertEdges: Edge[] = [];
  for (const [pk, edge] of desiredEdges) {
    const desiredKey = rowKey(edgeRowParams(edge, finalNodeIds));
    if (currentEdges.get(pk)?.key !== desiredKey) upsertEdges.push(edge);
  }
  const deleteEdgeKeys: EdgeKey[] = [];
  for (const [pk, current] of currentEdges) {
    if (desiredEdges.has(pk)) continue;
    if (pruneNodeTypes !== undefined) {
      const fromType = componentTypeFromNodeId(current.edgeKey.fromId);
      const toType = componentTypeFromNodeId(current.edgeKey.toId);
      const touchesPrunedType =
        (fromType !== null && pruneNodeTypes.has(fromType)) ||
        (toType !== null && pruneNodeTypes.has(toType));
      if (!touchesPrunedType) continue;
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
    for (const k of changeSet.deleteEdgeKeys) {
      await connection.run(DELETE_EDGE_SQL, [k.fromId, k.toId, k.edgeType, k.source]);
    }
    for (const id of changeSet.deleteNodeIds) {
      await connection.run(DELETE_NODE_SQL, [id]);
    }
    for (const node of changeSet.upsertNodes) {
      await connection.run(INSERT_NODE_SQL, nodeRowParams(node));
    }
    for (const edge of changeSet.upsertEdges) {
      await connection.run(
        REPLACE_EDGE_SQL,
        edgeRowParams(edge, changeSet.finalNodeIds),
      );
    }

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
