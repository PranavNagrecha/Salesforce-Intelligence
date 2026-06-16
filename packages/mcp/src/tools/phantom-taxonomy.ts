/**
 * P7-reference-stub-nodes — the phantom taxonomy classifier, computed ON DEMAND.
 *
 * A referenced-but-unretrieved id (an edge target with no node) is classified
 * into one of six buckets — the same taxonomy measured in
 * `docs/reports/phantom-taxonomy-audit.md` (GATE 0) — from its inbound edge
 * kinds, its id shape, and the manifest coverage of its ComponentType. The
 * result is a {@link ReferenceStub}: a structured, classified stub returned in
 * place of a bare not-found, with an honest remedy and whether it is a
 * demand-retrieve candidate.
 *
 * Deliberately NOT materialized into the graph: inserting stub nodes would make
 * the previously-dangling edges resolve to a node and break the `targetMissing`
 * / `retrieve_blindspot_report` / taxonomy semantics that depend on those edges
 * staying dangling. On-demand classification gives the same user-facing value
 * (a classified stub on lookup) without that blast radius.
 */

import type {
  ComponentId,
  PhantomClassification,
  ReferenceStub,
} from '@sf-intelligence/contracts';
import {
  classifyPhantom,
  listEdges,
  managedNamespaceOf,
  type CoverageStatus,
} from '@sf-intelligence/graph';
import { buildCoverageEntries } from '@sf-intelligence/vault';

import type { Context } from '../server.js';

// The pure classifier lives in @sf-intelligence/graph so the CLI's
// demand-retrieve gate shares it; re-export for existing MCP consumers/tests.
export { classifyPhantom, managedNamespaceOf };

const coverageStatusOf = (ctx: Context, type: string): CoverageStatus => {
  const e = buildCoverageEntries(ctx.manifest).find((c) => c.type === type);
  if (e === undefined) return 'absent';
  if (e.neverModeled) return 'notModeled';
  if (e.requested && e.retrieved > 0 && !e.errored) return 'covered';
  return 'partial';
};

const REMEDY: Record<PhantomClassification, string> = {
  'automation-critical':
    'Automation or code depends on this but it was never retrieved. It is a demand-retrieve candidate — run `sfi refresh --components <id>` to pull it.',
  'blindspot-manifest':
    'Its ComponentType was never retrieved (a manifest gap). Widen the retrieve manifest and run /sfi-refresh; see sfi.retrieve_blindspot_report.',
  'managed-extension':
    'A managed-package member — its source is not retrievable. Treat it as external; it stays a stub.',
  'standard-field-phantom':
    'A standard object or a field on one — referenced but not retrieved into the custom vault. Treat it as standard; it stays a stub.',
  'grant-only':
    'Only permission grants reference this — typically a managed or standard grant target. Not worth retrieving; it stays a stub.',
  unknown:
    'Referenced but not retrieved, and not obviously automation- or grant-related. Run /sfi-refresh if it should be in scope.',
};

/**
 * Build a {@link ReferenceStub} for `id` on demand, or `null` when `id` has NO
 * inbound edges (a genuinely-unknown id, not a phantom). Reads the inbound
 * edges, derives the distinct referrers / edge kinds, and classifies.
 */
export const buildReferenceStub = async (
  ctx: Context,
  id: ComponentId,
): Promise<ReferenceStub | null> => {
  const inbound = await listEdges(ctx.graph, id, { direction: 'in' });
  if (!inbound.ok || inbound.value.length === 0) return null;
  const edges = inbound.value;
  const edgeKinds = [...new Set(edges.map((e) => e.edgeType))].sort();
  const nonHeuristicEdgeKinds = [
    ...new Set(edges.filter((e) => e.confidence !== 'heuristic').map((e) => e.edgeType)),
  ];
  const referenceCount = new Set(edges.map((e) => e.fromId)).size;
  const type = id.slice(0, Math.max(0, id.indexOf(':')));
  const classification = classifyPhantom(
    id,
    edgeKinds,
    nonHeuristicEdgeKinds,
    coverageStatusOf(ctx, type),
  );
  const namespace = managedNamespaceOf(id);
  return {
    stub: true,
    id,
    classification,
    tier: 'stub',
    referenceCount,
    edgeKinds,
    ...(namespace !== undefined ? { namespace } : {}),
    demandRetrievable: classification === 'automation-critical',
    remedy: REMEDY[classification],
  };
};
