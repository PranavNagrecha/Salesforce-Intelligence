/**
 * Shared outgoing-edge-drift primitive for the cross-vault diff tools.
 *
 * Node-hash comparison alone is blind to DEPENDENCY drift: a Flow that
 * starts referencing a new field, or a validation rule that drops a
 * reference, changes NOTHING in the node's own `properties`, so it never
 * shows up as a shape-modified node. `buildEdgeDrift` closes that gap: for
 * every component present in BOTH vaults (regardless of whether its own
 * node hash matched), it diffs the two vaults' OUTGOING edge sets and
 * reports `edgesAdded[]` / `edgesRemoved[]` per component. The comparison
 * identity is deliberately narrow — `edgeType` + `toId` + the
 * `referenceKind` property when present — mirroring the node-side
 * volatile-property exclusion: every OTHER edge property (confidence,
 * source, extractor-internal bookkeeping) is excluded so it cannot
 * manufacture false drift the way a `lastModifiedDate` node property would.
 *
 * Originally built in `compare-vaults.ts` (R6-12, whole-vault scope);
 * extracted here in R7-W10 so `compare-object-across-vaults.ts` can reuse
 * the identical axis scoped to one object's components (the object node
 * itself plus its paired CustomFields) without duplicating the diff logic.
 * Both callers keep the SAME caps and disclosure text — see
 * `EDGE_DRIFT_MAX_COMPONENTS` / `EDGE_DRIFT_MAX_ROWS_PER_COMPONENT` /
 * `EDGE_DRIFT_SCOPE_DISCLOSURE` below.
 *
 * Also carries `buildExtractorVersionCaveat` (R6-12): when the two vaults'
 * manifests report different sf-intelligence product versions, callers
 * surface both versions so a drift is never silently attributed to the org
 * when it might reflect an EXTRACTOR change between versions. A manifest
 * read failure is disclosed as "not checked", never silently treated as
 * "versions match".
 */

import type { ComponentId, ComponentType, EdgeType } from '@sf-intelligence/contracts';
import type { GraphStore } from '@sf-intelligence/graph';
import { loadManifest } from '@sf-intelligence/vault';

/**
 * One normalized OUTGOING edge, used both as the edge-drift comparison
 * identity and as the row shape reported in `edgesAdded[]` /
 * `edgesRemoved[]`. Deliberately narrow — see the module JSDoc's
 * "edge-drift scope" discussion for why only these three fields are
 * compared.
 */
export interface EdgeDiffEntry {
  readonly edgeType: EdgeType;
  readonly toId: ComponentId;
  /** `properties.referenceKind` when the edge carries one (e.g. `subflow`, `fieldRef`). */
  readonly referenceKind?: string;
}

/** Per-component outgoing-edge drift — only emitted for components WITH at least one added/removed edge. */
export interface ComponentEdgeDrift {
  readonly id: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  readonly edgesAdded: readonly EdgeDiffEntry[];
  readonly edgesRemoved: readonly EdgeDiffEntry[];
}

/** The `edgeDrift` axis output shape shared by every cross-vault diff tool that wires it in. */
export interface EdgeDriftOutput {
  /** Components present in both vaults whose outgoing edge set differs. Capped — see `truncated`. */
  readonly components: readonly ComponentEdgeDrift[];
  readonly summary: {
    /** TRUE total of components with edge drift, before the `components` array is capped. */
    readonly componentsWithDriftCount: number;
    /** TRUE total of added edge rows across every drifted component. */
    readonly edgesAddedCount: number;
    /** TRUE total of removed edge rows across every drifted component. */
    readonly edgesRemovedCount: number;
  };
  /** True when `components` and/or a component's `edgesAdded`/`edgesRemoved` were clipped. `summary` stays the true totals. */
  readonly truncated: boolean;
  readonly disclosure: string;
}

/** Verbatim honesty note every `edgeDrift`-emitting tool includes in `boundaries[]`. */
export const EDGE_DRIFT_SCOPE_DISCLOSURE =
  'edgeDrift compares OUTGOING edges (edgeType + toId + referenceKind when present) only for components present in BOTH vaults; a component that was itself added or removed has nothing to diff its edges against, so it never appears in edgeDrift.components. Every other edge property (confidence, source, extractor bookkeeping) is excluded from the comparison, mirroring the node-side volatile-property filter.';

/** `edgeDrift` value for a response that never performed a comparison (e.g. a refusal path). */
export const EMPTY_EDGE_DRIFT: EdgeDriftOutput = {
  components: [],
  summary: { componentsWithDriftCount: 0, edgesAddedCount: 0, edgesRemovedCount: 0 },
  truncated: false,
  disclosure: 'No comparison performed — see boundaries.',
};

/**
 * Minimal node shape `buildEdgeDrift` needs from its `commonNodes` map —
 * satisfied structurally by every tool's own richer `CompactNode`-style
 * type, so callers pass their existing node maps without conversion.
 */
export interface EdgeDriftNodeRef {
  readonly type: ComponentType;
  readonly apiName: string;
}

interface EdgeRow {
  readonly from_id: string;
  readonly to_id: string;
  readonly edge_type: string;
  readonly properties_json: string;
}

const parseEdgePropertiesJson = (
  raw: string | null | undefined,
): Readonly<Record<string, unknown>> => {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      return {};
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    return {};
  }
};

/**
 * Load every edge in `store` and group by `from_id`, normalizing each row to
 * the {@link EdgeDiffEntry} comparison identity (`edgeType` + `toId` +
 * `referenceKind` when present). ONE table scan per vault — mirrors
 * `diff-snapshots.ts` / `apply-change-set.ts`'s full-edges-table read, which
 * this codebase already treats as an acceptable cost for a whole-vault
 * comparison (the caller's own node-side filter — `typeFilter`/
 * `objectFilter`, or a single object's fields — narrows which of these
 * buckets are ever consulted via `buildEdgeDrift`'s `commonNodes`).
 */
export const loadEdgesByFrom = async (
  store: GraphStore,
): Promise<Map<ComponentId, EdgeDiffEntry[]>> => {
  const reader = await store.connection.runAndReadAll(
    'SELECT from_id, to_id, edge_type, properties_json FROM edges',
  );
  const rows = reader.getRowObjectsJS() as unknown as readonly EdgeRow[];
  const map = new Map<ComponentId, EdgeDiffEntry[]>();
  for (const row of rows) {
    const props = parseEdgePropertiesJson(row.properties_json);
    const rawKind = props['referenceKind'];
    const referenceKind = typeof rawKind === 'string' ? rawKind : undefined;
    const entry: EdgeDiffEntry = {
      edgeType: row.edge_type as EdgeType,
      toId: row.to_id as ComponentId,
      ...(referenceKind !== undefined ? { referenceKind } : {}),
    };
    const fromId = row.from_id as ComponentId;
    const bucket = map.get(fromId);
    if (bucket === undefined) map.set(fromId, [entry]);
    else bucket.push(entry);
  }
  return map;
};

/** Composite key for edge-identity dedup — a `from_id` can carry the same normalized edge from more than one extractor `source`. */
const edgeDiffKey = (e: EdgeDiffEntry): string =>
  `${e.edgeType}\0${e.toId}\0${e.referenceKind ?? ''}`;

/** Dedup a component's outgoing edges onto their comparison identity. */
const dedupeEdges = (edges: readonly EdgeDiffEntry[]): Map<string, EdgeDiffEntry> => {
  const m = new Map<string, EdgeDiffEntry>();
  for (const e of edges) m.set(edgeDiffKey(e), e);
  return m;
};

/** Deterministic ordering for `edgesAdded` / `edgesRemoved` rows. */
const compareEdgeDiffEntries = (a: EdgeDiffEntry, b: EdgeDiffEntry): number => {
  if (a.edgeType !== b.edgeType) return a.edgeType < b.edgeType ? -1 : 1;
  if (a.toId !== b.toId) return a.toId < b.toId ? -1 : 1;
  const ak = a.referenceKind ?? '';
  const bk = b.referenceKind ?? '';
  return ak < bk ? -1 : ak > bk ? 1 : 0;
};

/** Output-size caps for the edge-drift axis — mirrors each tool's own node-side caps (`COMPARE_MAX_PER_BUCKET` / `DRIFT_MAX_ROWS`). Shared so every caller applies the SAME discipline. */
export const EDGE_DRIFT_MAX_COMPONENTS = 200;
export const EDGE_DRIFT_MAX_ROWS_PER_COMPONENT = 50;

/**
 * Compute the `edgeDrift` axis: for every id present in `commonNodes`
 * (already scoped by the caller — a whole-vault typeFilter/objectFilter
 * intersection, or a single object's own id plus its paired fields), diff
 * the two vaults' outgoing edge sets and collect per-component
 * `edgesAdded[]` / `edgesRemoved[]`. Only components with actual drift are
 * included in `components` — mirrors a node-diff tool only listing nodes
 * whose hash actually differs.
 */
export const buildEdgeDrift = (
  commonNodes: ReadonlyMap<ComponentId, EdgeDriftNodeRef>,
  edgesByFromA: ReadonlyMap<ComponentId, EdgeDiffEntry[]>,
  edgesByFromB: ReadonlyMap<ComponentId, EdgeDiffEntry[]>,
): EdgeDriftOutput => {
  const drifted: ComponentEdgeDrift[] = [];
  for (const [id, node] of commonNodes) {
    const edgesA = dedupeEdges(edgesByFromA.get(id) ?? []);
    const edgesB = dedupeEdges(edgesByFromB.get(id) ?? []);
    const edgesAdded: EdgeDiffEntry[] = [];
    const edgesRemoved: EdgeDiffEntry[] = [];
    for (const [key, entry] of edgesB) {
      if (!edgesA.has(key)) edgesAdded.push(entry);
    }
    for (const [key, entry] of edgesA) {
      if (!edgesB.has(key)) edgesRemoved.push(entry);
    }
    if (edgesAdded.length === 0 && edgesRemoved.length === 0) continue;
    edgesAdded.sort(compareEdgeDiffEntries);
    edgesRemoved.sort(compareEdgeDiffEntries);
    drifted.push({
      id,
      type: node.type,
      apiName: node.apiName,
      edgesAdded,
      edgesRemoved,
    });
  }
  drifted.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const componentsWithDriftCount = drifted.length;
  const edgesAddedCount = drifted.reduce((sum, c) => sum + c.edgesAdded.length, 0);
  const edgesRemovedCount = drifted.reduce((sum, c) => sum + c.edgesRemoved.length, 0);

  const componentsClipped = drifted.length > EDGE_DRIFT_MAX_COMPONENTS;
  const kept = componentsClipped ? drifted.slice(0, EDGE_DRIFT_MAX_COMPONENTS) : drifted;
  let rowsClipped = false;
  const components: ComponentEdgeDrift[] = kept.map((c) => {
    const addedOver = c.edgesAdded.length > EDGE_DRIFT_MAX_ROWS_PER_COMPONENT;
    const removedOver = c.edgesRemoved.length > EDGE_DRIFT_MAX_ROWS_PER_COMPONENT;
    if (addedOver || removedOver) rowsClipped = true;
    return {
      ...c,
      edgesAdded: addedOver ? c.edgesAdded.slice(0, EDGE_DRIFT_MAX_ROWS_PER_COMPONENT) : c.edgesAdded,
      edgesRemoved: removedOver
        ? c.edgesRemoved.slice(0, EDGE_DRIFT_MAX_ROWS_PER_COMPONENT)
        : c.edgesRemoved,
    };
  });

  const truncated = componentsClipped || rowsClipped;
  const disclosure = truncated
    ? `edgeDrift capped: at most ${EDGE_DRIFT_MAX_COMPONENTS} components (lowest id first) and ${EDGE_DRIFT_MAX_ROWS_PER_COMPONENT} rows per component's edgesAdded/edgesRemoved. \`summary\` counts are the TRUE totals. Narrow the request for a complete edge-drift slice.`
    : `Complete edge-drift slice; under the ${EDGE_DRIFT_MAX_COMPONENTS}-component cap.`;

  return {
    components,
    summary: { componentsWithDriftCount, edgesAddedCount, edgesRemovedCount },
    truncated,
    disclosure,
  };
};

/** Outcome of {@link buildExtractorVersionCaveat} — at most one of `caveat` / `readFailureNote` is ever set. */
export interface ExtractorVersionCaveatResult {
  readonly caveat: string | undefined;
  readonly readFailureNote: string | undefined;
}

/**
 * Build the `extractorVersionCaveat`: present ONLY when both manifests were
 * read successfully AND their `version` fields differ. A manifest read
 * failure is disclosed separately (never silently folded into "versions
 * match") via the returned `readFailureNote`.
 */
export const buildExtractorVersionCaveat = async (
  vaultAPath: string,
  vaultBPath: string,
  aliasA: string,
  aliasB: string,
): Promise<ExtractorVersionCaveatResult> => {
  const [manifestA, manifestB] = await Promise.all([
    loadManifest(vaultAPath),
    loadManifest(vaultBPath),
  ]);
  if (!manifestA.ok || !manifestB.ok) {
    const failed = !manifestA.ok ? aliasA : aliasB;
    return {
      caveat: undefined,
      readFailureNote: `extractor-version drift NOT checked: '${failed}'s manifest could not be read, so vaultA/vaultB product-version parity is unknown (treated as "not checked", not "same version").`,
    };
  }
  if (manifestA.value.version === manifestB.value.version) {
    return { caveat: undefined, readFailureNote: undefined };
  }
  return {
    caveat: `'${aliasA}' was extracted with sf-intelligence ${manifestA.value.version}; '${aliasB}' was extracted with sf-intelligence ${manifestB.value.version}. Edge-set (and node-shape) differences between the two vaults MAY reflect an EXTRACTOR change between versions rather than a real change in the org — re-refresh both vaults on the same product version before trusting a drift as org-only.`,
    readFailureNote: undefined,
  };
};
