/**
 * Handler for the `sfi.diff_snapshots` MCP tool.
 *
 * The v2.0c headline tool for buyer-priority #8 — "what changed in
 * this org since last week?". Reads two persisted snapshots (or one
 * persisted + the live current state) off `{vaultRoot}/snapshots/` and
 * reports the per-component-id `added`/`removed`/`modified` slices.
 *
 * Algorithm:
 *
 *   1. Resolve `fromLabel` -> a persisted `Snapshot`. If missing,
 *      return `invalid-query` with the file the caller would have
 *      read.
 *   2. Resolve `toLabel`. The special value `'current'` triggers a
 *      transient capture from the live graph; any other string is a
 *      persisted-label lookup with the same missing-snapshot
 *      semantics.
 *   3. Build the `from` and `to` id sets, then:
 *        - `added` = ids in `to` but not `from`
 *        - `removed` = ids in `from` but not `to`
 *        - `modified` = ids present in both whose `propertiesHash`
 *          differs (the per-node hash already covers apiName/label/
 *          type/properties, so renames and metadata changes both fall
 *          here).
 *   4. Sort each list by `id` ASC for stable output, then trim to
 *      `limit` if needed and set `truncated` accordingly.
 *
 * **Honesty axis** (per the v2.0c spec):
 *
 *   - The diff is structural: it reports ids that came in / went out /
 *     mutated between the two snapshots. It does NOT classify changes
 *     into "breaking" vs "safe" — that's the territory of the
 *     v2.0c change-history-narrator skill that consumes this tool's
 *     output.
 *   - Edges are not surfaced in the v2.0c output shape (added/removed
 *     edges would explode the volume past what a chat UI can render).
 *     The diff narrator can re-query specific components via
 *     `sfi.compare_components` when the user wants edge-level detail.
 *   - `truncated: true` always indicates that more entries exist than
 *     the cap — callers can re-run with a higher `limit` or fall
 *     through to `sfi.list_components` for the full enumeration.
 */

import { createHash } from 'node:crypto';

import type {
  ComponentId,
  ComponentType,
  EdgeType,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import type { GraphStore } from '@sf-intelligence/graph';
import {
  loadSnapshot,
  type Snapshot,
  type SnapshotEdge,
  type SnapshotNode,
} from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

/**
 * Inclusive upper bound on `limit`. Mirrors the cap convention every
 * enumeration-style v0.1+ tool uses (500 is the universal blast-radius
 * limit).
 */
const DIFF_SNAPSHOTS_MAX_LIMIT = 500;

/**
 * Default `limit` when the caller omits it. 100 keeps the response
 * compact for chat-style consumers while still surfacing the bulk of
 * a meaningful refresh diff (the edu-org fixture typically refreshes
 * ~20-50 components across a real metadata change).
 */
const DIFF_SNAPSHOTS_DEFAULT_LIMIT = 100;

/**
 * Sentinel value that means "compare against the live graph rather
 * than a persisted snapshot". The handler treats this as a transient
 * capture; nothing is written to disk.
 */
const CURRENT_LABEL = 'current';

/**
 * Zod schema for the `sfi.diff_snapshots` tool input.
 *
 *   - `fromLabel`: required non-empty string. Must name a persisted
 *     snapshot under `{vaultRoot}/snapshots/`; missing snapshots
 *     surface as `invalid-query`.
 *   - `toLabel`: required non-empty string. The special value
 *     `'current'` triggers a transient live-state capture; otherwise
 *     same missing-snapshot semantics as `fromLabel`.
 *   - `limit`: optional integer in [1, 500]. Defaults to 100.
 */
export const diffSnapshotsInputSchema = z.object({
  fromLabel: z.string().min(1),
  toLabel: z.string().min(1),
  limit: z.number().int().min(1).max(DIFF_SNAPSHOTS_MAX_LIMIT).optional(),
});

/** Parsed input shape, inferred from `diffSnapshotsInputSchema`. */
export type DiffSnapshotsInput = z.infer<typeof diffSnapshotsInputSchema>;

/**
 * One component entry in `added`/`removed`/`modified`. Carries enough
 * identity for a UI consumer to render the change without re-querying
 * the graph: the canonical id, the type, and the apiName.
 *
 * For `added` and `modified` entries the metadata is taken from the
 * `to` snapshot; for `removed` entries it comes from `from` (since by
 * definition the id is no longer in `to`).
 */
export interface DiffSnapshotComponent {
  readonly id: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface DiffSnapshotsOutput {
  readonly fromLabel: string;
  readonly toLabel: string;
  readonly added: readonly DiffSnapshotComponent[];
  readonly removed: readonly DiffSnapshotComponent[];
  readonly modified: readonly DiffSnapshotComponent[];
  readonly summary: {
    readonly addedCount: number;
    readonly removedCount: number;
    readonly modifiedCount: number;
  };
  readonly truncated: boolean;
}

/** Compact projection from a `SnapshotNode` to the response shape. */
const toDiffComponent = (node: SnapshotNode): DiffSnapshotComponent => ({
  id: node.id,
  type: node.type,
  apiName: node.apiName,
});

/** Compare two diff components by id ASC for deterministic output. */
const compareComponents = (a: DiffSnapshotComponent, b: DiffSnapshotComponent): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Stringify `value` with deterministic key ordering at every depth.
 *
 * Matches the canonicalization in the CLI's snapshot module and the
 * graph layer's `canonicalJson` so per-row hashes from a live capture
 * line up character-for-character with the hashes stored in any
 * persisted snapshot of equivalent state.
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

const hashRecord = (record: Readonly<Record<string, unknown>>): string =>
  createHash('sha256').update(canonicalJson(record)).digest('hex');

interface RawNodeRow {
  readonly id: string;
  readonly type: string;
  readonly api_name: string;
  readonly label: string | null;
  readonly properties_json: string;
}

interface RawEdgeRow {
  readonly from_id: string;
  readonly to_id: string;
  readonly edge_type: string;
  readonly confidence: string;
  readonly source: string;
  readonly properties_json: string;
}

const parsePropertiesJson = (raw: string | null | undefined): Readonly<Record<string, unknown>> => {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    return {};
  }
};

/**
 * Capture a transient snapshot of the current live graph store. Uses
 * the already-open `GraphStore` rather than opening a new connection —
 * the MCP server owns the lifecycle, and reusing the connection means
 * the diff tool never contends with an `sfi refresh` writing to the
 * same DB file.
 *
 * Sorted output guarantees the same byte stream as a persisted
 * snapshot of equivalent state.
 */
const captureLiveSnapshot = async (
  store: GraphStore,
  manifest: Snapshot['manifest'],
): Promise<Result<Snapshot, McpError>> => {
  try {
    const nodeReader = await store.connection.runAndReadAll(
      'SELECT id, type, api_name, label, properties_json FROM nodes',
    );
    const rawNodes = nodeReader.getRowObjectsJS() as unknown as readonly RawNodeRow[];
    const nodes: SnapshotNode[] = rawNodes
      .map((row) => {
        const props = parsePropertiesJson(row.properties_json);
        const hashInput: Readonly<Record<string, unknown>> = {
          type: row.type,
          apiName: row.api_name,
          label: row.label,
          properties: props,
        };
        return {
          id: row.id as ComponentId,
          type: row.type as ComponentType,
          apiName: row.api_name,
          label: row.label,
          propertiesHash: hashRecord(hashInput),
        };
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const edgeReader = await store.connection.runAndReadAll(
      'SELECT from_id, to_id, edge_type, confidence, source, properties_json FROM edges',
    );
    const rawEdges = edgeReader.getRowObjectsJS() as unknown as readonly RawEdgeRow[];
    const edges: SnapshotEdge[] = rawEdges
      .map((row) => {
        const props = parsePropertiesJson(row.properties_json);
        const hashInput: Readonly<Record<string, unknown>> = {
          confidence: row.confidence,
          properties: props,
        };
        return {
          fromId: row.from_id as ComponentId,
          toId: row.to_id as ComponentId,
          edgeType: row.edge_type as EdgeType,
          source: row.source,
          propertiesHash: hashRecord(hashInput),
        };
      })
      .sort((a, b) => {
        if (a.fromId !== b.fromId) return a.fromId < b.fromId ? -1 : 1;
        if (a.toId !== b.toId) return a.toId < b.toId ? -1 : 1;
        if (a.edgeType !== b.edgeType) return a.edgeType < b.edgeType ? -1 : 1;
        if (a.source !== b.source) return a.source < b.source ? -1 : 1;
        return 0;
      });

    return ok({
      meta: {
        label: CURRENT_LABEL,
        createdAt: new Date().toISOString(),
        sourceTreeHash: manifest.sourceTreeHash,
        componentCount: nodes.length,
        edgeCount: edges.length,
      },
      manifest,
      nodes,
      edges,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err({
      kind: 'internal',
      message: `live graph capture failed: ${message}`,
    });
  }
};

/**
 * Resolve a label to a `Snapshot`. The special `'current'` label
 * triggers a live-graph capture against `ctx.graph`; every other
 * label is a persisted-snapshot lookup that returns `invalid-query`
 * if missing.
 */
const resolveSnapshot = async (
  ctx: Context,
  label: string,
): Promise<Result<Snapshot, McpError>> => {
  if (label === CURRENT_LABEL) {
    return captureLiveSnapshot(ctx.graph, ctx.manifest);
  }
  const loaded = await loadSnapshot(ctx.vaultRoot, label);
  if (!loaded.ok) {
    if (loaded.error.kind === 'snapshot-missing') {
      return err({
        kind: 'invalid-query',
        message: `snapshot '${label}' not found. Capture it first with \`sfi snapshot create --label ${label}\` or pick an existing label from \`sfi snapshot list\`.`,
        path: loaded.error.path ?? label,
      });
    }
    return err({
      kind: 'internal',
      message: `failed to load snapshot '${label}': ${loaded.error.message}`,
    });
  }
  return ok(loaded.value);
};

/**
 * The `sfi.diff_snapshots` MCP tool. Returns the structural diff
 * between two snapshots (or one snapshot and the live current state).
 * See the module JSDoc for the algorithm and honesty axis.
 *
 * @example
 *   const r = await diffSnapshotsHandler(ctx, {
 *     fromLabel: 'weekly-2026-05-20',
 *     toLabel: 'current',
 *   });
 *   if (r.ok) console.log(r.value.data.summary);
 */
export const diffSnapshotsHandler = async (
  ctx: Context,
  input: DiffSnapshotsInput,
): Promise<Result<McpResponse<DiffSnapshotsOutput>, McpError>> => {
  const fromResult = await resolveSnapshot(ctx, input.fromLabel);
  if (!fromResult.ok) return fromResult;
  const toResult = await resolveSnapshot(ctx, input.toLabel);
  if (!toResult.ok) return toResult;

  const fromSnapshot = fromResult.value;
  const toSnapshot = toResult.value;

  // Build id -> node maps from both sides. The hash check below cares
  // about the per-node `propertiesHash`, so retain the full node row
  // rather than just the id.
  const fromMap = new Map<ComponentId, SnapshotNode>();
  for (const node of fromSnapshot.nodes) fromMap.set(node.id, node);
  const toMap = new Map<ComponentId, SnapshotNode>();
  for (const node of toSnapshot.nodes) toMap.set(node.id, node);

  const added: DiffSnapshotComponent[] = [];
  const removed: DiffSnapshotComponent[] = [];
  const modified: DiffSnapshotComponent[] = [];

  for (const [id, toNode] of toMap) {
    const fromNode = fromMap.get(id);
    if (fromNode === undefined) {
      added.push(toDiffComponent(toNode));
    } else if (fromNode.propertiesHash !== toNode.propertiesHash) {
      modified.push(toDiffComponent(toNode));
    }
  }
  for (const [id, fromNode] of fromMap) {
    if (!toMap.has(id)) {
      removed.push(toDiffComponent(fromNode));
    }
  }

  added.sort(compareComponents);
  removed.sort(compareComponents);
  modified.sort(compareComponents);

  const limit = input.limit ?? DIFF_SNAPSHOTS_DEFAULT_LIMIT;
  const totalCount = added.length + removed.length + modified.length;
  const truncated = totalCount > limit;

  // The slice strategy: per-bucket trim proportional to the limit,
  // but never trim below the actual entry counts. The simple shape
  // — slice each bucket independently to `limit` — keeps each
  // category's signal intact even when one category dominates.
  return ok({
    data: {
      fromLabel: input.fromLabel,
      toLabel: input.toLabel,
      added: added.slice(0, limit),
      removed: removed.slice(0, limit),
      modified: modified.slice(0, limit),
      summary: {
        addedCount: added.length,
        removedCount: removed.length,
        modifiedCount: modified.length,
      },
      truncated,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
