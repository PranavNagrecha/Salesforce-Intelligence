import type { DuckDBConnection, DuckDBValue } from '@duckdb/node-api';
import type {
  ComponentType,
  Edge,
  ExtractionResult,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';

import { mintRelationshipTraversalEdges } from './relationship-refs.js';
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

/** Column count of a `nodes` row — the param-tuple width of {@link nodeRowParams}. */
export const NODE_COLUMN_COUNT = 10;
/** Column count of an `edges` row — the param-tuple width of {@link edgeRowParams}. */
export const EDGE_COLUMN_COUNT = 6;

/**
 * Build a single multi-row `INSERT OR REPLACE` statement for `rowCount` rows of
 * `columnCount` columns each, expanding the `(?, ?, ...)` value template once
 * per row and joining with `, `. The caller binds the FLATTENED concatenation of
 * each row's positional params, in row order, so DuckDB applies the rows
 * left-to-right — preserving the same insertion order (and last-writer-wins /
 * first-writer-wins dedup parity) as the row-at-a-time path.
 *
 * Used by the incremental `applyChangeSet` to collapse N per-row `connection.run`
 * calls into one statement per chunk, inside the SAME single transaction (no
 * per-chunk commit — that is the cold-import {@link commitBatched} pattern, which
 * would BREAK applyChangeSet's all-or-nothing invariant).
 *
 * Param-ceiling note: DuckDB's prepared-statement bind list is a uint16, so a
 * single statement tops out at 65535 params. At {@link IMPORT_BATCH_SIZE}=500
 * that is 500×10=5000 node params / 500×6=3000 edge params — far under the
 * ceiling. The safe row ceiling per statement is ~6553 nodes / ~10922 edges;
 * keep the chunk size at IMPORT_BATCH_SIZE so this can never be approached.
 */
export const buildMultiRowUpsertSql = (
  table: 'nodes' | 'edges',
  columnCount: number,
  rowCount: number,
): string => {
  const columns =
    table === 'nodes'
      ? 'id, type, api_name, label, parent_id, source_path, last_modified_date, last_modified_by, api_version, properties_json'
      : 'from_id, to_id, edge_type, confidence, source, properties_json';
  const rowTemplate = `(${new Array<string>(columnCount).fill('?').join(', ')})`;
  const values = new Array<string>(rowCount).fill(rowTemplate).join(', ');
  return `INSERT OR REPLACE INTO ${table} (${columns}) VALUES ${values}`;
};

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
 *
 * C-3 (findings 28 + 34) — `canonicalJson(undefined)` crash-class sweep,
 * THIS copy's variant. Unlike the compare-tool copies (which only ever use
 * their output for in-memory string equality / hashing), this copy's
 * return value is the literal string PERSISTED into the `properties_json`
 * column and later re-parsed by `queries.ts`'s `parseProperties` — so it
 * must stay syntactically valid JSON. Naively adopting R6-12's `'\0undefined
 * \0'` sentinel here would corrupt the persisted column (an unquoted,
 * NUL-containing token spliced into what must be JSON). Nothing type-level
 * prevents an extractor from ever emitting `{foo: possiblyUndefined}`
 * (`Node.properties`/`Edge.properties` are `Record<string, unknown>`), and
 * the pre-fix fallthrough (`typeof undefined !== 'object'` →
 * `JSON.stringify(undefined)` → the JS value `undefined`, not a string)
 * would coerce to the bare word `undefined` when spliced into the parent's
 * template-literal `${...}` — invalid JSON that crashes every subsequent
 * read of that row (finding 34).
 *
 * Fix: match `JSON.stringify`'s OWN documented `undefined` semantics
 * instead — an object key whose value is `undefined` is OMITTED (mirrors
 * `JSON.stringify({a: undefined}) === '{}'`), and an array element that is
 * `undefined` serializes as `null` (mirrors `JSON.stringify([undefined])
 * === '[null]'`, since an array can't skip an index). Both keep the output
 * valid JSON and — per the suggested action in finding 34 — are
 * hash-compatible with every existing vault, since a bounded search found
 * no current emitter of explicit-undefined properties: this branch never
 * fires on real data, so no existing `properties_json` byte changes.
 */
const canonicalJson = (value: unknown): string => {
  if (value === undefined) return '{}';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
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
 *
 * C-2 (finding 25): also covers `references`-type edges targeting
 * `ApexClass:`/`ApexTrigger:` — Visualforce `controller=`/`extensions=`
 * attributes are case-insensitive class names in Salesforce, and
 * `visualforce-page.ts` mints those as `edgeType: 'references'` (not
 * `callsApex`), so a VF page naming its controller in a different case used
 * to dangle past this remap and `find_dead_code`/`find_apex_usages` would
 * then read the class as unreferenced — the same false-"dead"
 * destructive-verdict failure this canonicalizer exists to prevent. Other
 * `references` edges (e.g. to `CustomLabel:`/`StaticResource:`/
 * `CustomObject:`) are unaffected — the prefix check below only fires for
 * `ApexClass:`/`ApexTrigger:` targets.
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
    if (
      edge.edgeType !== 'callsApex' &&
      edge.edgeType !== 'dispatchesAsync' &&
      edge.edgeType !== 'references'
    ) {
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

/**
 * Shared engine behind {@link canonicalizeFieldEdgeTargets} and
 * {@link canonicalizeObjectEdgeTargets} (R6-03 / R7-W3): remap a DANGLING edge
 * target whose id starts with `idPrefix` onto the vaulted `nodeType` node that
 * matches case-insensitively. Apex and SOQL are case-insensitive languages, so
 * a scanner/AST edge minted from source-text casing (e.g.
 * `CustomField:account.custom_flag__c`, `CustomObject:account`) can miss the
 * graph's exact-match edge walk (`listEdges` filters on `to_id = ?`) even
 * though the referenced component is real and vaulted under different
 * casing. Edge-only consumers (`safe_to_delete_field`, `unused_fields_deep`
 * tier 1, `find_dead_code`, impact/usage walks) would then read the component
 * as unreferenced — a false "safe"/"dead" verdict.
 *
 * Producer-agnostic on purpose: apex-ast (parsed), apex-scanner (heuristic),
 * and frontend scanners all key component usage by source-text casing;
 * whatever the producer, a case-variant of a real component id means that
 * component. The whole id (including any `ns__` namespace prefix) is
 * case-folded as a single unit — a namespaced id only matches its own
 * namespaced counterpart, never a bare same-named component.
 *
 * Honesty invariants:
 *   - Only DANGLING targets are remapped (an exact node-id match is final).
 *   - Salesforce component API names are case-insensitive unique within their
 *     scope (fields per object, objects per org), so the lowercase key is
 *     collision-free on real metadata; a synthetic collision (two vaulted ids
 *     differing only by case) drops the key — an ambiguous target is never
 *     guessed.
 *   - An unknown component (no vaulted node under any casing) stays dangling
 *     — absence is preserved (`targetMissing`), never invented.
 *   - Edge `properties` are untouched: the verbatim source-text path remains
 *     the raw evidence.
 */
const canonicalizeEdgeTargetsByCase = (
  idPrefix: string,
  nodeType: ComponentType,
  nodes: readonly Node[],
  edges: Edge[],
): void => {
  /** lowercased id → canonical id, or null when two ids collide on case. */
  const byLower = new Map<string, string | null>();
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    nodeIds.add(node.id);
    if (node.type !== nodeType) continue;
    const lower = node.id.toLowerCase();
    const existing = byLower.get(lower);
    if (existing === undefined) byLower.set(lower, node.id);
    else if (existing !== node.id) byLower.set(lower, null);
  }
  if (byLower.size === 0) return;
  for (let i = 0; i < edges.length; i += 1) {
    const edge = edges[i];
    if (edge === undefined) continue;
    if (!edge.toId.startsWith(idPrefix)) continue;
    if (nodeIds.has(edge.toId)) continue;
    const canonical = byLower.get(edge.toId.toLowerCase());
    if (canonical !== undefined && canonical !== null && canonical !== edge.toId) {
      edges[i] = { ...edge, toId: canonical as Edge['toId'] };
    }
  }
};

/** Canonical id prefix for a CustomField node. */
const CUSTOM_FIELD_PREFIX = 'CustomField:';

/**
 * Lowercased object API name shared by the polymorphic-base remap: a custom
 * field defined on `Activity` is physically stored on that object and shared by
 * its two children.
 */
const ACTIVITY_OBJECT_LOWER = 'activity';

/**
 * Lowercased API names of the two polymorphic children of `Activity`. A custom
 * field written/read through one of these receivers is really the shared
 * `Activity` field (Salesforce has no per-child custom-field storage).
 */
const ACTIVITY_CHILD_OBJECTS_LOWER: ReadonlySet<string> = new Set([
  'task',
  'event',
]);

/**
 * Split a `CustomField:{Object}.{Field}` id into its object + field parts on the
 * FIRST `.` — the id format is always `CustomField:` + object + `.` + field (see
 * `custom-field.ts`: `CustomField:${objectApiName}.${fieldApiName}`), and
 * neither a Salesforce object nor field API name contains a `.`. Returns null
 * when the id is not a well-formed CustomField id (no prefix, or no `.`).
 */
const splitFieldId = (
  id: string,
): { readonly object: string; readonly field: string } | null => {
  if (!id.startsWith(CUSTOM_FIELD_PREFIX)) return null;
  const body = id.slice(CUSTOM_FIELD_PREFIX.length);
  const dot = body.indexOf('.');
  if (dot === -1) return null;
  return { object: body.slice(0, dot), field: body.slice(dot + 1) };
};

/**
 * D2 (polymorphic Activity-base alias): remap a DANGLING
 * `CustomField:Task.<field>` / `CustomField:Event.<field>` edge target onto the
 * shared `CustomField:Activity.<field>` node when that Activity field actually
 * exists in the graph.
 *
 * Salesforce `Activity` CUSTOM fields are defined on the `Activity` object and
 * SHARED by its polymorphic children `Task`/`Event` — there is no per-child
 * custom-field storage. When Apex writes `someTask.CAP_Field__c = …`, the
 * writesTo/readsFrom edge is keyed on the RECEIVER type (`Task`/`Event`),
 * projecting to a `CustomField:Task.CAP_Field__c` / `CustomField:Event.…`
 * target that never attaches to the real `CustomField:Activity.CAP_Field__c`
 * node. The case-only remap in {@link canonicalizeEdgeTargetsByCase} can't
 * bridge it (`task` ≠ `activity`), so the target dangles and an edge-only
 * consumer (`safe_to_delete_field`, `unused_fields_deep`, impact/usage walks)
 * reads the Activity field as unreferenced — flipping a blocking
 * `ApexClass writesTo` into a false "safe to delete".
 *
 * Precision guards (mirrors {@link canonicalizeEdgeTargetsByCase}'s honesty
 * invariants):
 *   - Only DANGLING targets are remapped (an exact node-id match is final).
 *   - The source object must be `Task`/`Event` (case-insensitive) — the only
 *     two Activity children.
 *   - The target `CustomField:Activity.<field>` node MUST already exist; a
 *     dangling Activity ref is NEVER minted. This "Activity node exists" guard
 *     is exactly what keeps standard Task/Event-own fields (which have no
 *     Activity counterpart) unremapped while the shared custom fields (which
 *     live on Activity) are attached.
 *   - The field name is matched case-insensitively; a synthetic case collision
 *     between two Activity fields drops the key (never guesses).
 *   - Edge `properties` are untouched — the verbatim source-text path stays as
 *     the raw evidence, and the alias is disclosed as a name-based (heuristic)
 *     import remap by the tools that surface it.
 *
 * NB: name-based, not a declared parent relationship. That Task/Event ARE
 * Activity is general Salesforce truth, but the attribution is applied here from
 * a matched {object, field} name pair, so consumers disclose it as a
 * confirm-before-you-delete alias rather than a parsed edge.
 */
export const canonicalizeActivityPolymorphicFieldEdgeTargets = (
  nodes: readonly Node[],
  edges: Edge[],
): void => {
  /** lowercased Activity field name -> canonical id, or null on a case collision. */
  const activityFieldByLowerName = new Map<string, string | null>();
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    nodeIds.add(node.id);
    if (node.type !== 'CustomField') continue;
    const parts = splitFieldId(node.id);
    if (parts === null) continue;
    if (parts.object.toLowerCase() !== ACTIVITY_OBJECT_LOWER) continue;
    const key = parts.field.toLowerCase();
    const existing = activityFieldByLowerName.get(key);
    if (existing === undefined) activityFieldByLowerName.set(key, node.id);
    else if (existing !== node.id) activityFieldByLowerName.set(key, null);
  }
  if (activityFieldByLowerName.size === 0) return;
  for (let i = 0; i < edges.length; i += 1) {
    const edge = edges[i];
    if (edge === undefined) continue;
    if (!edge.toId.startsWith(CUSTOM_FIELD_PREFIX)) continue;
    if (nodeIds.has(edge.toId)) continue; // an exact node-id match is final
    const parts = splitFieldId(edge.toId);
    if (parts === null) continue;
    if (!ACTIVITY_CHILD_OBJECTS_LOWER.has(parts.object.toLowerCase())) continue;
    const canonical = activityFieldByLowerName.get(parts.field.toLowerCase());
    if (
      canonical !== undefined &&
      canonical !== null &&
      canonical !== edge.toId
    ) {
      edges[i] = { ...edge, toId: canonical as Edge['toId'] };
    }
  }
};

/** The three polymorphic forms of a shared Activity field, in canonical priority. */
const ACTIVITY_POLYMORPHIC_SLOTS = ['activity', 'task', 'event'] as const;
type ActivitySlot = (typeof ACTIVITY_POLYMORPHIC_SLOTS)[number];

/** Field-edge types whose target identifies a CustomField dependency. */
const POLYMORPHIC_MIRROR_EDGE_TYPES: ReadonlySet<Edge['edgeType']> = new Set([
  'readsFrom',
  'writesTo',
  'references',
]);

/** Source marker stamped on minted polymorphic-mirror edges. */
const ACTIVITY_POLYMORPHIC_SOURCE = 'graph-activity-polymorphic';

/**
 * D2 (polymorphic Activity-field mirror): when a shared Activity custom field is
 * materialized in the graph as MORE THAN ONE polymorphic representation (its
 * `Task` and `Event` describe-snapshot siblings, and/or its `Activity` base),
 * ensure a field-reference edge (`readsFrom` / `writesTo` / `references`) that
 * lands on ONE representation is also present (incoming) on every OTHER existing
 * representation — because they are ONE physical field.
 *
 * Why this exists ON TOP of {@link canonicalizeActivityPolymorphicFieldEdgeTargets}:
 * a Metadata-API retrieve that ships the field's own `Activity/fields/*.field-
 * meta.xml` yields a single `CustomField:Activity.<field>` node, and the remap
 * above attaches dangling `Task`/`Event` edges to it. But a vault whose activity
 * fields come from the offline `sobject describe` snapshot has NO `Activity`
 * object node at all — the SAME field is materialized twice, as
 * `CustomField:Task.<field>` AND `CustomField:Event.<field>`. Apex that writes it
 * through a `Task` receiver (`someTask.<field> = …`) attaches its `writesTo` ONLY
 * to the `Task` sibling; querying the `Event` sibling then walks zero
 * dependencies and `safe_to_delete_field` reads it as a false `safe`/`review`,
 * even though deleting the (one shared) field breaks that Apex. Mirroring the
 * edge onto the `Event` sibling makes both representations report the blocking
 * write.
 *
 * Precision + honesty invariants:
 *   - A field is treated as SHARED only when it has >= 2 existing polymorphic
 *     representations among {Activity, Task, Event}. A field present on ONLY one
 *     of them (a Task-own / Event-own standard field) is never mirrored — a
 *     Salesforce activity CUSTOM field always exists on both children, so
 *     "same-named field on both" is a reliable shared-field signal, and the
 *     >= 2 guard is the mirror-side analogue of the remap's "Activity node
 *     exists" guard.
 *   - Minted edges are `confidence: 'heuristic'`, carry the distinct
 *     `source: 'graph-activity-polymorphic'` marker and
 *     `properties.polymorphicMirror: true` / `mirroredFrom`, and are DEDUPED
 *     against every existing `(fromId, toId, edgeType)` — a real edge is never
 *     duplicated or downgraded. The attribution is a name-based alias, disclosed
 *     as a confirm-before-you-delete limitation by the tools that surface it.
 *   - Only field-reference edge types are mirrored — `grantedBy` (per-object
 *     FLS) and `parentOf` (structural containment) are legitimately per-sibling
 *     and are left alone.
 *
 * INCREMENTAL caveat (mirrors {@link mintFutureDispatchEdges}): on the
 * apply-change-set path it only sees the change-set's node view, so a sibling
 * representation outside the change set is invisible and it under-mints vs a
 * full refresh. A full `/sfi-refresh` is the ground truth.
 */
export const mintPolymorphicActivityFieldEdges = (
  nodes: readonly Node[],
  edges: Edge[],
): void => {
  // lowercased field name -> existing rep node id per polymorphic slot.
  const repsByField = new Map<string, Partial<Record<ActivitySlot, string>>>();
  for (const node of nodes) {
    if (node.type !== 'CustomField') continue;
    const parts = splitFieldId(node.id);
    if (parts === null) continue;
    const slot = parts.object.toLowerCase() as ActivitySlot;
    if (!ACTIVITY_POLYMORPHIC_SLOTS.includes(slot)) continue;
    const key = parts.field.toLowerCase();
    const rec = repsByField.get(key) ?? {};
    if (rec[slot] === undefined) rec[slot] = node.id;
    repsByField.set(key, rec);
  }

  // A field is SHARED only when >= 2 of its polymorphic representations exist.
  const repIdsByField = new Map<string, readonly string[]>();
  const fieldByRepId = new Map<string, string>();
  for (const [field, rec] of repsByField) {
    const ids = ACTIVITY_POLYMORPHIC_SLOTS.map((s) => rec[s]).filter(
      (x): x is string => x !== undefined,
    );
    if (ids.length < 2) continue;
    repIdsByField.set(field, ids);
    for (const id of ids) fieldByRepId.set(id, field);
  }
  if (repIdsByField.size === 0) return;

  // Every existing (fromId, toId, edgeType) so a real edge is never duplicated.
  const seen = new Set<string>();
  for (const edge of edges) {
    seen.add(`${edge.fromId} ${edge.toId} ${edge.edgeType}`);
  }

  // Snapshot the length so mirrored edges are not themselves re-mirrored.
  const originalLength = edges.length;
  const minted: Edge[] = [];
  for (let i = 0; i < originalLength; i += 1) {
    const edge = edges[i];
    if (edge === undefined) continue;
    if (!POLYMORPHIC_MIRROR_EDGE_TYPES.has(edge.edgeType)) continue;
    const field = fieldByRepId.get(edge.toId);
    if (field === undefined) continue;
    const reps = repIdsByField.get(field);
    if (reps === undefined) continue;
    for (const rep of reps) {
      if (rep === edge.toId) continue;
      const key = `${edge.fromId} ${rep} ${edge.edgeType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      minted.push({
        fromId: edge.fromId,
        toId: rep as Edge['toId'],
        edgeType: edge.edgeType,
        confidence: 'heuristic',
        source: ACTIVITY_POLYMORPHIC_SOURCE,
        properties: {
          polymorphicMirror: true,
          mirroredFrom: edge.toId,
          mechanism: 'activity-shared-field',
        },
      });
    }
  }
  for (const edge of minted) edges.push(edge);
};

/**
 * R6-03: remap `CustomField:` edge targets to the canonical vaulted field id
 * when the producer used a different casing. See
 * {@link canonicalizeEdgeTargetsByCase} for the shared mechanics and honesty
 * invariants.
 *
 * Runs the case-fold remap FIRST (an exact / case-variant Task/Event-own field
 * is the more specific target and wins), THEN the D2 polymorphic Activity-base
 * alias ({@link canonicalizeActivityPolymorphicFieldEdgeTargets}) for the
 * dangling `CustomField:Task.<field>` / `CustomField:Event.<field>` targets that
 * are really the shared `Activity` field — so both `writesTo` and `readsFrom`
 * edges land on the Activity field node when that base node exists. The
 * describe-snapshot case (siblings but no Activity base) is handled separately
 * by {@link mintPolymorphicActivityFieldEdges}.
 */
export const canonicalizeFieldEdgeTargets = (
  nodes: readonly Node[],
  edges: Edge[],
): void => {
  canonicalizeEdgeTargetsByCase('CustomField:', 'CustomField', nodes, edges);
  canonicalizeActivityPolymorphicFieldEdgeTargets(nodes, edges);
};

/**
 * R7-W3: remap `CustomObject:` edge targets to the canonical vaulted object
 * id when the producer used a different casing — mirrors R6-03's CustomField
 * fix for the object side of the same problem. `[select id from account]`
 * mints a heuristic `readsFrom` edge targeting `CustomObject:account`; the
 * `EventBus.subscribe('x__e', ...)` `listensTo` edge and every other
 * `CustomObject:`-prefixed target (trigger `on Account`, lookup/master-detail
 * declarations, custom-tab bindings) are equally susceptible — none of them
 * would ever attach to the vaulted `CustomObject:Account` node without this
 * remap. Every object variant (CustomObject / CustomSetting /
 * CustomMetadataType / PlatformEvent / BigObject / KnowledgeArticle) is
 * extracted with node `type: 'CustomObject'` regardless of its declared
 * variant, so a single `nodeType` match covers all of them. See
 * {@link canonicalizeEdgeTargetsByCase} for the shared mechanics and honesty
 * invariants (including the case-collision-drops-the-key ambiguity guard and
 * the whole-id, namespace-inclusive case-fold).
 */
export const canonicalizeObjectEdgeTargets = (
  nodes: readonly Node[],
  edges: Edge[],
): void => {
  canonicalizeEdgeTargetsByCase('CustomObject:', 'CustomObject', nodes, edges);
};

/**
 * C-2 (finding 25): remap `CustomLabel:` edge targets to the canonical
 * vaulted label id when the producer used a different casing. `$Label.foo`
 * value-provider tokens are case-insensitive in Salesforce (Aura/VF
 * templates), but `buildResourceRefEdges` (apex-edges.ts) mints
 * `CustomLabel:{apiName}` verbatim from the source-text casing captured by
 * the frontend regex scanner — so a lowercase-typed `$Label.foo` reference
 * used to dangle against the vaulted `CustomLabel:Foo` node, and
 * `find_dead_code`/`unused_components` would then read the label as
 * unreferenced. See {@link canonicalizeEdgeTargetsByCase} for the shared
 * mechanics and honesty invariants (including the case-collision-drops-the-
 * key ambiguity guard and the whole-id, namespace-inclusive case-fold).
 */
export const canonicalizeLabelEdgeTargets = (
  nodes: readonly Node[],
  edges: Edge[],
): void => {
  canonicalizeEdgeTargetsByCase('CustomLabel:', 'CustomLabel', nodes, edges);
};

/**
 * C-2 (finding 25): remap `StaticResource:` edge targets to the canonical
 * vaulted resource id when the producer used a different casing.
 * `$Resource.bar` value-provider tokens are case-insensitive in Salesforce
 * (Aura/VF templates), but `buildResourceRefEdges` (apex-edges.ts) mints
 * `StaticResource:{apiName}` verbatim from the source-text casing captured
 * by the frontend regex scanner — so a lowercase-typed `$Resource.bar`
 * reference used to dangle against the vaulted `StaticResource:Bar` node,
 * and `find_dead_code`/`unused_components` would then read the resource as
 * unreferenced. See {@link canonicalizeEdgeTargetsByCase} for the shared
 * mechanics and honesty invariants (including the case-collision-drops-the-
 * key ambiguity guard and the whole-id, namespace-inclusive case-fold).
 */
export const canonicalizeResourceEdgeTargets = (
  nodes: readonly Node[],
  edges: Edge[],
): void => {
  canonicalizeEdgeTargetsByCase('StaticResource:', 'StaticResource', nodes, edges);
};

/**
 * CR-CAP-09: mint class-granular `@future` dispatch edges at graph-build time.
 *
 * The Apex extractor detects `@future` only at CLASS granularity — the
 * annotation scanner (`collectMethodAnnotations`) cannot bind the annotation to
 * a specific method declaration, so each class node carries a single boolean
 * `properties.hasFutureMethod`. Cross-class calls are modeled as class-level
 * `callsApex` edges. Joining the two yields a class-granular async signal:
 * "caller has a `callsApex` edge to a class that has SOME `@future` method".
 *
 * This is a deliberate over-attribution: the edge fires when the TARGET class
 * has ANY `@future` method, even if the caller invoked a synchronous method of
 * that class — because `hasFutureMethod` cannot say WHICH method is `@future`.
 * That is honored honestly, not hidden: the minted edge is `confidence:
 * 'heuristic'` and carries `properties.granularity: 'class'`. Method-level
 * precision is gated on CR-CAP-06 (caller-method attribution). Reuses the
 * existing `dispatchesAsync` EdgeType (whose contract already names `@future`
 * as a legitimate target) — no new EdgeType.
 *
 * Honesty / safety invariants:
 *   - Only mints when the TARGET node genuinely has `hasFutureMethod === true`.
 *   - The future-set is guarded to `ApexClass` nodes only — triggers can't hold
 *     `@future`, so a trigger target is never minted even if mislabeled.
 *   - Dedups by `(fromId, toId, edgeType)`: if a `dispatchesAsync` edge already
 *     exists for the pair (e.g. a `declared` inline-constructor
 *     `System.enqueueJob(new ClassB())` edge), NOTHING is minted — the
 *     higher-trust declared edge is never duplicated or downgraded.
 *
 * Must run AFTER `canonicalizeApexCallEdgeTargets` so `callsApex` targets are
 * already canonicalized to real node ids before the future-set membership test.
 *
 * INCREMENTAL caveat (apply-change-set path): operates on the change-set's node
 * view, so a future-holding target class outside the change set is invisible
 * and under-mints vs a full refresh. A full `/sfi-refresh` is the ground truth.
 */
export const mintFutureDispatchEdges = (
  nodes: readonly Node[],
  edges: Edge[],
): void => {
  const futureClassIds = new Set<string>();
  for (const node of nodes) {
    if (node.type === 'ApexClass' && node.properties['hasFutureMethod'] === true) {
      futureClassIds.add(node.id);
    }
  }
  if (futureClassIds.size === 0) return;

  // Existing dispatchesAsync pairs — minting must never duplicate/downgrade a
  // pre-existing (e.g. declared inline-constructor) edge for the same pair.
  const existingDispatchPairs = new Set<string>();
  for (const edge of edges) {
    if (edge.edgeType === 'dispatchesAsync') {
      existingDispatchPairs.add(`${edge.fromId} ${edge.toId}`);
    }
  }

  // Distinct callsApex pairs whose target is a @future-holding class. Use a set
  // so multiple call-sites to the same target collapse to one minted edge.
  const toMint = new Map<string, { fromId: string; toId: string }>();
  for (const edge of edges) {
    if (edge.edgeType !== 'callsApex') continue;
    if (!futureClassIds.has(edge.toId)) continue;
    const pairKey = `${edge.fromId} ${edge.toId}`;
    if (existingDispatchPairs.has(pairKey)) continue;
    if (!toMint.has(pairKey)) {
      toMint.set(pairKey, { fromId: edge.fromId, toId: edge.toId });
    }
  }

  for (const { fromId, toId } of toMint.values()) {
    edges.push({
      fromId,
      toId,
      edgeType: 'dispatchesAsync',
      confidence: 'heuristic',
      source: 'graph-future-dispatch',
      properties: {
        dispatchMechanism: 'future',
        granularity: 'class',
        derivedFrom: 'callsApex+hasFutureMethod',
      },
    });
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
  // R6-03: remap case-variant CustomField targets (SOQL/Apex are case-
  // insensitive; the graph's edge walk is not) onto the vaulted field id.
  // Includes the D2 polymorphic Activity-base remap (dangling Task/Event field
  // edges -> the shared Activity field node when that base node exists).
  canonicalizeFieldEdgeTargets(allNodes, allEdges);
  // D2: mirror field-reference edges across the existing polymorphic siblings
  // of a shared Activity field (Task/Event describe-snapshot duplicates), so a
  // write via a Task receiver is visible from the Event representation too.
  // Runs after canonicalizeFieldEdgeTargets so remapped targets are considered.
  mintPolymorphicActivityFieldEdges(allNodes, allEdges);
  // R7-W3: same remap for CustomObject targets (SOQL FROM, listensTo, trigger
  // `on Object`, etc.) onto the vaulted object id.
  canonicalizeObjectEdgeTargets(allNodes, allEdges);
  // C-2 (finding 25): same remap for CustomLabel ($Label.foo) and
  // StaticResource ($Resource.bar) targets — both are case-insensitive
  // value-provider tokens minted verbatim by the frontend regex scanner.
  canonicalizeLabelEdgeTargets(allNodes, allEdges);
  canonicalizeResourceEdgeTargets(allNodes, allEdges);
  // CR-CAP-09: mint class-granular @future dispatchesAsync edges AFTER targets
  // are canonicalized so the future-set membership test sees real node ids.
  mintFutureDispatchEdges(allNodes, allEdges);
  // FLEXIPAGE-RELATEDLIST-ALIASES + formula `__r` traversals: resolve the
  // relationship-scoped references the per-file extractors could not, now that
  // every object's lookup fields are visible. Runs AFTER canonicalization so the
  // relationship map is built from canonical ids, and it only emits targets that
  // match a real vaulted CustomField — resolve or drop, never a dangling guess.
  mintRelationshipTraversalEdges(allNodes, allEdges);

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
