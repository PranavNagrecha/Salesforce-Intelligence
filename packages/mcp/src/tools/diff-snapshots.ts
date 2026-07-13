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
 *   - R7-W9: this module's `canonicalJson` carries the same defensive
 *     `undefined` branch added to `compare-vaults.ts` (R6-12) and
 *     `compare-object-across-vaults.ts` — see that function's own JSDoc.
 */

import { createHash } from 'node:crypto';

import type {
  ComponentId,
  ComponentType,
  EdgeType,
  McpError,
  McpResponse,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import type { GraphStore } from '@sf-intelligence/graph';
import {
  listSnapshots,
  loadSnapshot,
  type Snapshot,
  type SnapshotEdge,
  type SnapshotNode,
} from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  argsFingerprint,
  decodeCursor,
  paginateSection,
  type PageableSection,
  type SectionDisclosure,
} from './page-cursor.js';

/** Per-response byte budget for the designated list's page. */
const DIFF_SNAPSHOTS_BYTE_BUDGET = 38_000;

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
 * Disclosure for the STEP-2 `summary: true` MODE (folded-in `churn`): the digest
 * is structural (id/hash), not semantic risk. The full slices ride along in the
 * same response (`added`/`removed`/`modified`).
 */
const SUMMARY_DISCLOSURE =
  'Summary compares two snapshots by structural id / propertiesHash only — not semantic "risk". The full added / removed / modified slices are in this same response.';

/**
 * Zod schema for the `sfi.diff_snapshots` tool input.
 *
 *   - `fromLabel`: OPTIONAL non-empty string. Must name a persisted
 *     snapshot under `{vaultRoot}/snapshots/`; missing snapshots
 *     surface as `invalid-query`. When BOTH labels are omitted the diff
 *     auto-defaults to the two most-recent persisted snapshots (STEP-2:
 *     the folded-in `churn` ergonomic).
 *   - `toLabel`: OPTIONAL non-empty string. The special value
 *     `'current'` triggers a transient live-state capture; otherwise
 *     same missing-snapshot semantics as `fromLabel`.
 *   - `limit`: optional integer in [1, 500]. Defaults to 100.
 *   - `summary`: optional (STEP-2, the folded-in `churn` MODE). When
 *     `true`, the output additionally carries compact `addedCount` /
 *     `removedCount` / `modifiedCount` scalars + a `topChurn` top-25
 *     mixed id list + a `disclosure` — the churn shape.
 */
export const diffSnapshotsInputSchema = z.object({
  fromLabel: z.string().min(1).optional(),
  toLabel: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(DIFF_SNAPSHOTS_MAX_LIMIT).optional(),
  // CR-22 continuation cursor: an OPAQUE token echoed back from a prior
  // truncated page's `nextCursor`; carries the resume offset + which list
  // (added | removed | modified) it advances. Omit = today's behavior.
  cursor: z.string().min(1).optional(),
  summary: z.boolean().optional(),
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
  /**
   * CR-22 opaque continuation token, present ONLY when the designated (largest)
   * list overflowed `limit`/the byte budget. Echo it back as `cursor` to resume
   * THAT list; absent on a whole-fits page so the response is byte-identical.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata for the designated list; truncation only. */
  readonly pageInfo?: PageInfo;
  /** Which list the cursor advances (`'added'` | `'removed'` | `'modified'`); truncation only. */
  readonly designatedList?: string;
  /** The two non-designated lists, disclosed with their full counts; truncation only. */
  readonly otherSections?: readonly SectionDisclosure[];
  /**
   * STEP-2 `summary: true` MODE (folded-in `churn`): compact top-level counts
   * that mirror `summary.*` so a churn consumer reads `addedCount` directly.
   * Present ONLY when `summary: true`.
   */
  readonly addedCount?: number;
  readonly removedCount?: number;
  readonly modifiedCount?: number;
  /**
   * STEP-2 `summary: true` MODE: the top-25 CHANGED ids across all three lists
   * (added | removed | modified), sorted by id ASC — the compact churn digest.
   * Present ONLY when `summary: true`.
   */
  readonly topChurn?: readonly {
    readonly id: string;
    readonly change: 'added' | 'removed' | 'modified';
  }[];
  /** STEP-2 `summary: true` MODE: the churn disclosure. Present ONLY when `summary: true`. */
  readonly disclosure?: string;
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
 *
 * R7-W9 crash-class sweep: `compare-vaults.ts`'s identical implementation
 * crashed for real under R6-12 — `JSON.stringify(undefined)` returns the JS
 * value `undefined`, NOT the string `"undefined"`, so the primitive
 * fallthrough silently returned a non-string, and that sibling's
 * `boundValue` helper threw calling `.length` on it. This file's two call
 * sites (`hashRecord`, below, invoked only on fully-populated inline object
 * literals in `captureLiveSnapshot`) have no currently-reachable path that
 * passes `canonicalJson` an `undefined` value — `JSON.parse` can never
 * produce `undefined`, and every hash-input record here is built from
 * required fields, not a key-union diff like `compare-vaults.ts`'s
 * `collectDrift`. The explicit `undefined` branch is applied anyway, for
 * consistency with the other two (patched) implementations of this exact
 * function shape and to close the landmine for any future caller. Exported
 * so the branch can be unit-tested directly (see
 * `diff-snapshots.test.ts` — there is no handler-level path that reproduces
 * an `undefined` input to exercise here).
 */
export const canonicalJson = (value: unknown): string => {
  if (value === undefined) return '\0undefined\0';
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
  // STEP-2 (folded-in churn ergonomic): when a label is omitted, default it to
  // the most-recent (`toLabel`) / second-most-recent (`fromLabel`) PERSISTED
  // snapshot. Only touch the snapshot list when a default is actually needed, so
  // an explicit two-label call is unchanged.
  let fromLabel = input.fromLabel;
  let toLabel = input.toLabel;
  if (fromLabel === undefined || toLabel === undefined) {
    const listed = await listSnapshots(ctx.vaultRoot);
    if (!listed.ok) {
      return err({ kind: 'internal', message: listed.error.message });
    }
    if (listed.value.length < 2) {
      return err({
        kind: 'invalid-query',
        message:
          'Need at least two persisted snapshots to diff without explicit labels. ' +
          'Run `sfi snapshot create --label <name>` after refreshes, or pass fromLabel + toLabel.',
      });
    }
    const byTime = [...listed.value].sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    );
    fromLabel = fromLabel ?? byTime[byTime.length - 2]!.label;
    toLabel = toLabel ?? byTime[byTime.length - 1]!.label;
  }

  const fromResult = await resolveSnapshot(ctx, fromLabel);
  if (!fromResult.ok) return fromResult;
  const toResult = await resolveSnapshot(ctx, toLabel);
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

  // id ASC is unique WITHIN each list (added/removed/modified are Map-keyed by
  // id), so it is already a strict total order per list — safe for offset resume
  // with no extra tiebreak.
  added.sort(compareComponents);
  removed.sort(compareComponents);
  modified.sort(compareComponents);

  const limit = input.limit ?? DIFF_SNAPSHOTS_DEFAULT_LIMIT;
  const totalCount = added.length + removed.length + modified.length;
  // KEEP the pre-CR-22 `truncated` semantics (sum-vs-single-limit) byte-for-byte
  // so the golden does not move; the cursor block is layered ON TOP, emitted only
  // when the DESIGNATED list is actually paged.
  const truncated = totalCount > limit;

  // CR-22 section cursor: page ONE designated list (the largest at request time)
  // and disclose the others honestly. On resume the handler feeds token.listId
  // back as designatedListId (paginateSection does NOT cross-check — B0 note).
  const TOOL = 'sfi.diff_snapshots';
  // Bind the cursor to the RESOLVED labels (post-default) so a defaulted-latest-two
  // page resumes against the same pair.
  const fingerprint = argsFingerprint({ fromLabel, toLabel });
  const sections: readonly PageableSection<DiffSnapshotComponent>[] = [
    { listId: 'added', items: added },
    { listId: 'removed', items: removed },
    { listId: 'modified', items: modified },
  ];
  // Default designated = largest by length (tiebreak added > removed > modified).
  let designatedListId = 'added';
  if (removed.length > added.length && removed.length >= modified.length) {
    designatedListId = 'removed';
  } else if (modified.length > added.length && modified.length > removed.length) {
    designatedListId = 'modified';
  }
  let offset = 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
    if (decoded.value.listId !== undefined) designatedListId = decoded.value.listId;
  }

  const pagedResult = paginateSection(sections, designatedListId, {
    offset,
    limit,
    byteBudget: DIFF_SNAPSHOTS_BYTE_BUDGET,
    keyOf: (c) => c.id,
    binding: { tool: TOOL, vaultHash: ctx.manifest.sourceTreeHash, argsFingerprint: fingerprint },
  });
  if (!pagedResult.ok) return err(pagedResult.error);
  const paged = pagedResult.value;
  const emitCursor = paged.pageInfo.nextCursor !== null;

  // The designated list shows its (byte-budgeted) page; the non-designated two
  // stay sliced-to-limit and disclosed via summary + otherSections. On a
  // whole-fits call no list is byte-trimmed and the designated page == its
  // slice(0,limit), so the three arrays are byte-identical to pre-CR-22.
  const pageFor = (listId: string, full: readonly DiffSnapshotComponent[]): readonly DiffSnapshotComponent[] =>
    listId === designatedListId ? paged.items : full.slice(0, limit);

  // STEP-2 `summary: true` MODE (folded-in churn): the compact top-level counts +
  // a top-25 mixed CHANGED-id digest across all three lists + the churn
  // disclosure. Added additively; a non-summary call is byte-unchanged.
  const summaryMode =
    input.summary === true
      ? {
          addedCount: added.length,
          removedCount: removed.length,
          modifiedCount: modified.length,
          topChurn: [
            ...added.map((c) => ({ id: c.id, change: 'added' as const })),
            ...removed.map((c) => ({ id: c.id, change: 'removed' as const })),
            ...modified.map((c) => ({ id: c.id, change: 'modified' as const })),
          ]
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            .slice(0, 25),
          disclosure: SUMMARY_DISCLOSURE,
        }
      : {};

  // The slice strategy: per-bucket trim proportional to the limit,
  // but never trim below the actual entry counts. The simple shape
  // — slice each bucket independently to `limit` — keeps each
  // category's signal intact even when one category dominates.
  return ok({
    data: {
      fromLabel,
      toLabel,
      added: pageFor('added', added),
      removed: pageFor('removed', removed),
      modified: pageFor('modified', modified),
      summary: {
        addedCount: added.length,
        removedCount: removed.length,
        modifiedCount: modified.length,
      },
      truncated,
      ...(emitCursor
        ? {
            nextCursor: paged.pageInfo.nextCursor as string,
            pageInfo: paged.pageInfo,
            designatedList: paged.listId,
            otherSections: paged.otherSections,
          }
        : {}),
      ...summaryMode,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
