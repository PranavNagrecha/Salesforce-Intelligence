import type { DuckDBConnection, DuckDBValue } from '@duckdb/node-api';
import type { Edge, ExtractionResult, Node } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';

import type { GraphError, GraphStore } from './store.js';

/**
 * The summary of a bulk-import call.
 *
 * `nodesInserted` counts every row whose primary key was written or replaced —
 * with `INSERT OR REPLACE` semantics, that is every node passed in.
 * `edgesInserted` counts only edges whose composite key did not already exist;
 * duplicates that were silently ignored by `INSERT OR IGNORE` are excluded.
 *
 * Together these counts make re-runs observable: a fresh import reports the
 * full input size, a re-import of identical input reports `edgesInserted: 0`.
 */
export interface ImportCounts {
  readonly nodesInserted: number;
  readonly edgesInserted: number;
}

/**
 * Number of rows committed per transaction during a bulk import.
 *
 * DuckDB's `preserve_insertion_order=true` (the default) buffers every pending
 * write inside an open transaction until COMMIT. On the edu-org fixture
 * (~2,200 nodes plus several thousand edges) wrapping the whole import in a
 * single transaction grew the per-process working set to ~12.7 GiB and OOM-
 * killed the node process. Committing in fixed-size batches keeps the
 * in-memory buffer bounded by the batch size; 500 rows is conservative
 * (~5 MB at typical row sizes) and well within DuckDB's comfortable working
 * set on developer laptops.
 *
 * The constant is exported so tests can verify the multi-batch boundary
 * behaviour without recomputing the value.
 */
export const IMPORT_BATCH_SIZE = 500;

/**
 * Node upsert: `INSERT OR REPLACE` keyed on the canonical id. Shared by the
 * cold import and the incremental `applyChangeSet` path (both want
 * last-writer-wins on id), so the column order lives here once.
 */
export const INSERT_NODE_SQL = `INSERT OR REPLACE INTO nodes (
  id, type, api_name, label, parent_id, source_path,
  last_modified_date, last_modified_by, api_version, properties_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Cold-import edge insert: `INSERT OR IGNORE` keyed on the 4-col PK. First
 * writer wins; a re-run of identical input no-ops (the documented dedup
 * contract B29 relies on). The incremental path uses
 * {@link REPLACE_EDGE_SQL} instead — see its note.
 */
const INSERT_EDGE_SQL = `INSERT OR IGNORE INTO edges (
  from_id, to_id, edge_type, confidence, source, properties_json
) VALUES (?, ?, ?, ?, ?, ?)`;

/**
 * Incremental edge upsert: `INSERT OR REPLACE` keyed on the 4-col PK. Unlike
 * the cold path's `INSERT OR IGNORE`, this OVERWRITES an existing edge row so a
 * changed `confidence`/`properties_json` (or a flipped `targetMissing`) is
 * persisted. Used only by `applyChangeSet`, whose diff already removed deleted
 * edges and only ever upserts edges whose serialized row actually differs —
 * leaving the cold path's first-writer-wins dedup contract untouched.
 */
export const REPLACE_EDGE_SQL = `INSERT OR REPLACE INTO edges (
  from_id, to_id, edge_type, confidence, source, properties_json
) VALUES (?, ?, ?, ?, ?, ?)`;

/**
 * Stringify a value with deterministic key ordering at every depth.
 *
 * `JSON.stringify` preserves the runtime insertion order of object keys, which
 * means two objects with identical contents but different construction orders
 * produce different output. That non-determinism leaks into the graph's
 * `properties_json` column and breaks byte-stable diffs across refreshes.
 *
 * This recursive walk sorts every object's keys alphabetically before
 * serializing, while leaving arrays in their original order (arrays are
 * ordered; their order is data, not noise).
 */
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`,
  );
  return `{${parts.join(',')}}`;
};

/**
 * Normalize a node's `sourcePath` to a vault-relative, separator-portable
 * form so the persisted graph never leaks an absolute local path (which
 * carries the user's username + filesystem layout — a privacy + portability
 * problem, and noise in committed/shared artifacts).
 *
 * Strategy: keep the path from the vault root (`org-kb/`) onward; if that
 * marker is absent, fall back to the Salesforce DX `source/` root; if neither
 * is present (e.g. an already-relative test path) the value is returned
 * unchanged. Backslashes are normalized to `/` so vaults built on Windows and
 * POSIX produce identical ids/paths.
 *
 * @example
 *   relativizeSourcePath('/home/dev/proj/org-kb/source/main/default/classes/X.cls')
 *   // => 'source/main/default/classes/X.cls'
 */
export const relativizeSourcePath = (p: string): string => {
  if (p.length === 0) return p;
  const norm = p.replace(/\\/g, '/');
  const orgKb = norm.lastIndexOf('/org-kb/');
  if (orgKb !== -1) return norm.slice(orgKb + '/org-kb/'.length);
  const src = norm.lastIndexOf('/source/');
  if (src !== -1) return norm.slice(src + 1);
  return norm;
};

/**
 * Build the 10-column parameter tuple for a node's `nodes` row, in the exact
 * column order of {@link INSERT_NODE_SQL}. Applies `relativizeSourcePath` and
 * `canonicalJson` so the serialized row is byte-stable and path-portable.
 *
 * Exported as the single source of truth for node-row serialization: the cold
 * `importExtractionResults` path and the incremental `applyChangeSet` path both
 * build their rows here, so an incremental apply is byte-identical to a cold
 * rebuild by construction (P7-incremental-graph-update).
 */
export const nodeRowParams = (node: Node): DuckDBValue[] => [
  node.id,
  node.type,
  node.apiName,
  node.label,
  node.parentId,
  relativizeSourcePath(node.sourcePath),
  node.lastModifiedDate,
  node.lastModifiedBy,
  node.apiVersion,
  canonicalJson(node.properties),
];

/**
 * Build the 6-column parameter tuple for an edge's `edges` row, in the exact
 * column order of {@link INSERT_EDGE_SQL}.
 *
 * Flags edges whose target resolves to no real node — the Apex scanner's
 * phantom `CustomField:a.POP_Code__c`/`ApexClass:acc` (a loop/local variable
 * misread as a component), or a declared reference to a standard object the
 * vault doesn't cover. Read paths hide *heuristic* targetMissing edges by
 * default (they're extraction noise pointing at things that don't exist);
 * declared/parsed ones stay visible as honest out-of-vault references. The flag
 * is set only when missing, so present-target edges keep clean properties and
 * byte-stable `properties_json`.
 *
 * `knownNodeIds` must be the FINAL node-id set (every node that will exist after
 * the import/apply), so the `targetMissing` stamp matches what a cold rebuild —
 * which evaluates it against the fully-imported node table — would produce.
 * Exported alongside {@link nodeRowParams} as the shared edge-row serializer.
 */
export const edgeRowParams = (
  edge: Edge,
  knownNodeIds: ReadonlySet<string>,
): DuckDBValue[] => {
  const properties = knownNodeIds.has(edge.toId)
    ? edge.properties
    : { ...edge.properties, targetMissing: true };
  return [
    edge.fromId,
    edge.toId,
    edge.edgeType,
    edge.confidence,
    edge.source,
    canonicalJson(properties),
  ];
};

const insertNode = async (
  connection: DuckDBConnection,
  node: Node,
): Promise<number> => {
  const result = await connection.run(INSERT_NODE_SQL, nodeRowParams(node));
  return result.rowsChanged;
};

const insertEdge = async (
  connection: DuckDBConnection,
  edge: Edge,
  knownNodeIds: ReadonlySet<string>,
): Promise<number> => {
  const result = await connection.run(
    INSERT_EDGE_SQL,
    edgeRowParams(edge, knownNodeIds),
  );
  return result.rowsChanged;
};

/**
 * The result of a single batched-commit pass over a list of items.
 *
 * On success carries the accumulated `rowsChanged` total. On failure carries
 * how many batches did commit before the failure, the (1-indexed) failing
 * batch number, and the underlying error message so the caller can build a
 * `partial import` message.
 */
type BatchOutcome =
  | { readonly ok: true; readonly rowsChanged: number }
  | {
      readonly ok: false;
      readonly batchesCommitted: number;
      readonly failedBatch: number;
      readonly message: string;
    };

/**
 * Insert `items` in batches of `IMPORT_BATCH_SIZE`, committing after each
 * batch. On any failure inside a batch the batch is rolled back and the
 * function returns a non-ok outcome; batches that already committed remain
 * persisted (that is by design — atomicity is at the batch boundary, not the
 * whole import).
 */
const commitBatched = async <T>(
  connection: DuckDBConnection,
  items: readonly T[],
  insertOne: (connection: DuckDBConnection, item: T) => Promise<number>,
): Promise<BatchOutcome> => {
  let rowsChanged = 0;
  let batchesCommitted = 0;
  for (let start = 0; start < items.length; start += IMPORT_BATCH_SIZE) {
    const batch = items.slice(start, start + IMPORT_BATCH_SIZE);
    const batchNumber = batchesCommitted + 1;

    try {
      await connection.run('BEGIN TRANSACTION;');
    } catch (e) {
      return {
        ok: false,
        batchesCommitted,
        failedBatch: batchNumber,
        message: `failed to begin transaction: ${(e as Error).message}`,
      };
    }

    try {
      for (const item of batch) {
        rowsChanged += await insertOne(connection, item);
      }
      await connection.run('COMMIT;');
      batchesCommitted += 1;
    } catch (e) {
      // Best-effort rollback. If the rollback itself fails we still want to
      // surface the original error, which is more actionable.
      try {
        await connection.run('ROLLBACK;');
      } catch {
        // Swallow; the outer error is what callers need to see.
      }
      return {
        ok: false,
        batchesCommitted,
        failedBatch: batchNumber,
        message: (e as Error).message,
      };
    }
  }
  return { ok: true, rowsChanged };
};

/**
 * Bulk-import extractor results into the graph store. Idempotent —
 * re-running with the same input produces the same DB state.
 *
 * The import runs in batches of `IMPORT_BATCH_SIZE` rows, each batch wrapped
 * in its own transaction. This keeps DuckDB's in-flight write buffer bounded
 * on large fixtures where a single-transaction import would exhaust process
 * memory (DuckDB buffers pending writes inside an open transaction with
 * `preserve_insertion_order=true`).
 *
 * Atomicity is **per batch**, not per import: if batch N+1 fails, batches
 * 1..N remain committed. The returned error message names how many batches
 * persisted so callers can decide whether to re-run.
 *
 * Nodes use `INSERT OR REPLACE` keyed on the canonical component id, so
 * re-importing a node with the same id overwrites the prior row. Edges use
 * `INSERT OR IGNORE` keyed on `(from_id, to_id, edge_type, source)`, so
 * duplicate edges from re-runs are silently dropped. Both make per-batch
 * commits safe under re-run: a re-import of a previously-imported batch
 * either replaces (nodes) or no-ops (edges).
 *
 * @example
 *   const result = await importExtractionResults(store, [
 *     extractorResult1,
 *     extractorResult2,
 *   ]);
 *   if (!result.ok) {
 *     console.error(result.error.message);
 *     return;
 *   }
 *   console.log(
 *     `Inserted ${result.value.nodesInserted} nodes, ${result.value.edgesInserted} edges`,
 *   );
 */
/**
 * GRF-01: remap heuristic `callsApex` / `dispatchesAsync` targets to the
 * canonical vaulted ApexClass id when the scanner used a different casing
 * (`ApexClass:pkb_controller` → `ApexClass:pkb_Controller`).
 */
export const canonicalizeApexCallEdgeTargets = (
  nodes: readonly Node[],
  edges: Edge[],
): void => {
  const apexByLower = new Map<string, string>();
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    nodeIds.add(node.id);
    if (node.type === 'ApexClass' || node.type === 'ApexTrigger') {
      apexByLower.set(node.apiName.toLowerCase(), node.id);
    }
  }
  for (let i = 0; i < edges.length; i += 1) {
    const edge = edges[i];
    if (edge === undefined) continue;
    if (edge.edgeType !== 'callsApex' && edge.edgeType !== 'dispatchesAsync') {
      continue;
    }
    const prefix = edge.toId.startsWith('ApexTrigger:')
      ? 'ApexTrigger:'
      : edge.toId.startsWith('ApexClass:')
        ? 'ApexClass:'
        : null;
    if (prefix === null) continue;
    if (nodeIds.has(edge.toId)) continue;
    const apiName = edge.toId.slice(prefix.length);
    const canonical = apexByLower.get(apiName.toLowerCase());
    if (canonical !== undefined && canonical !== edge.toId) {
      edges[i] = { ...edge, toId: canonical };
      nodeIds.add(canonical);
    }
  }
};

export const importExtractionResults = async (
  store: GraphStore,
  results: readonly ExtractionResult[],
): Promise<Result<ImportCounts, GraphError>> => {
  const { connection } = store;

  const allNodes: Node[] = [];
  const allEdges: Edge[] = [];
  for (const result of results) {
    for (const node of result.nodes) allNodes.push(node);
    for (const edge of result.edges) allEdges.push(edge);
  }

  canonicalizeApexCallEdgeTargets(allNodes, allEdges);

  const nodeOutcome = await commitBatched(connection, allNodes, insertNode);
  if (!nodeOutcome.ok) {
    return err({
      kind: 'query-failed',
      message: `node partial import: ${nodeOutcome.batchesCommitted} batches committed, batch ${nodeOutcome.failedBatch} failed: ${nodeOutcome.message}`,
    });
  }

  // Nodes are committed above, so the table now holds this import's nodes plus
  // any already persisted. Snapshot the full id set so edge import can flag
  // targets that resolve to no node (`targetMissing`). Reading once here keeps
  // the per-edge check an O(1) Set lookup rather than a per-row query.
  let knownNodeIds: ReadonlySet<string>;
  try {
    const reader = await connection.runAndReadAll('SELECT id FROM nodes', []);
    const rows = reader.getRowObjectsJS() as ReadonlyArray<
      Readonly<Record<string, unknown>>
    >;
    knownNodeIds = new Set(rows.map((r) => r['id'] as string));
  } catch (e) {
    return err({
      kind: 'query-failed',
      message: `failed to read node ids for edge target resolution: ${(e as Error).message}`,
    });
  }

  const edgeOutcome = await commitBatched(connection, allEdges, (conn, edge) =>
    insertEdge(conn, edge, knownNodeIds),
  );
  if (!edgeOutcome.ok) {
    return err({
      kind: 'query-failed',
      message: `edge partial import: ${edgeOutcome.batchesCommitted} batches committed, batch ${edgeOutcome.failedBatch} failed: ${edgeOutcome.message}`,
    });
  }

  return ok({
    nodesInserted: nodeOutcome.rowsChanged,
    edgesInserted: edgeOutcome.rowsChanged,
  });
};
