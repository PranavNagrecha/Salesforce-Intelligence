/**
 * Refresh-time phantom bucket roll-up — aggregates distinct dangling edge
 * targets into the taxonomy without materializing stub nodes (ADR-004).
 * Mirrors the on-demand loop in `classifyForDemandRetrieve`.
 *
 * SCOPE: `PhantomClassification` has SEVEN members, but this roll-up calls
 * `classifyPhantom` directly and so can only ever emit the SIX it returns. The
 * seventh, `unresolved-profile-id`, is an id-shape short-circuit that lives
 * upstream in `mcp/tools/phantom-taxonomy.ts` and runs BEFORE `classifyPhantom`
 * — so an `UnresolvedProfile:{id}` phantom is bucketed here by its generic
 * coverage/edge shape, while `get_component` reports it as
 * `unresolved-profile-id`. The two surfaces disagree by construction; do not
 * read this summary as the full taxonomy.
 */

import type { ComponentId, PhantomClassification } from '@sf-intelligence/contracts';

import { classifyPhantom, type CoverageStatus } from './phantom-classify.js';
import type { GraphStore } from './store.js';

type Row = Readonly<Record<string, unknown>>;

const runRows = async (
  store: GraphStore,
  sql: string,
): Promise<readonly Row[]> => {
  const reader = await store.connection.runAndReadAll(sql, []);
  return reader.getRowObjectsJS() as readonly Row[];
};

/** Lookup manifest coverage for a ComponentType when classifying phantoms. */
export type PhantomCoverageLookup = (componentType: string) => CoverageStatus;

export interface PhantomBucketSummary {
  readonly distinctPhantoms: number;
  readonly buckets: Readonly<Partial<Record<PhantomClassification, number>>>;
}

/**
 * Count distinct phantom ids by taxonomy bucket. Each phantom id is classified
 * once from its inbound edge kinds and manifest coverage — same inputs as
 * `classifyPhantom` on demand.
 */
export const computePhantomBucketSummary = async (
  store: GraphStore,
  coverageOf: PhantomCoverageLookup,
): Promise<PhantomBucketSummary> => {
  const rows = await runRows(
    store,
    `SELECT e.to_id AS id, e.edge_type, e.confidence
     FROM edges e
     LEFT JOIN nodes n ON e.to_id = n.id
     WHERE n.id IS NULL`,
  );

  const byId = new Map<
    string,
    { edgeKinds: Set<string>; nonHeuristic: Set<string> }
  >();
  for (const row of rows) {
    const id = row['id'] as string;
    let entry = byId.get(id);
    if (entry === undefined) {
      entry = { edgeKinds: new Set(), nonHeuristic: new Set() };
      byId.set(id, entry);
    }
    const kind = row['edge_type'] as string;
    entry.edgeKinds.add(kind);
    if (row['confidence'] !== 'heuristic') entry.nonHeuristic.add(kind);
  }

  const buckets: Partial<Record<PhantomClassification, number>> = {};
  for (const [id, agg] of byId) {
    const type = id.slice(0, Math.max(0, id.indexOf(':')));
    const classification = classifyPhantom(
      id as ComponentId,
      [...agg.edgeKinds],
      [...agg.nonHeuristic],
      coverageOf(type),
    );
    buckets[classification] = (buckets[classification] ?? 0) + 1;
  }

  return { distinctPhantoms: byId.size, buckets };
};
