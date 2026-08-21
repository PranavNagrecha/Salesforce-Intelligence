/**
 * `classifyEdge` — the per-edge `(edgeType, sourceType) -> {category, verdict}`
 * lookup over the curated `EDGE_SEMANTICS` concept-model table.
 *
 * WHY THIS IS ITS OWN LEAF. The function lived in `safe-to-delete-field.ts`,
 * whose module graph reaches `live-population-check.ts` and therefore the
 * live-plane seam. `sfi.object_360` is a `vault`-plane tool that needs the same
 * classification, and importing it from the field tool would have dragged that
 * seam into a tool whose `liveRequired` is never true — the exact ambient-live
 * reach `test/plane-import-guard.test.ts` exists to prevent, and (through
 * `roster.ts`) into `capabilities` / `route_question` / `run_analysis` as well.
 *
 * Copying the lookup instead would have been worse: two deletion vocabularies
 * that drift is precisely the failure the two-track concept model was built to
 * end. So the lookup moves DOWN to a leaf that imports nothing but the contract
 * types and the generated table, and both tools import it from here.
 * `safe-to-delete-field.ts` re-exports it so its existing importers (and the
 * `classifyEdge` golden-lock parity test) are unchanged.
 */

import type { Edge, Node } from '@sf-intelligence/contracts';

import { EDGE_SEMANTICS } from '../knowledge/loader.js';

/** A (category, verdict) classification for one incoming dependency edge. */
export interface EdgeClassification {
  readonly category: string;
  readonly verdict: string;
}

/**
 * Classify one incoming edge into a (category, verdict) pair.
 *
 * The per-edge `(edgeType, sourceType) → {category, verdict}` mapping — the
 * ordered source-marker special cases (checked first), every per-source-type
 * result, and every per-edgeType default — is curated DATA in the two-track
 * concept model (`packages/mcp/model/edge-semantics.yaml` → the generated,
 * frozen `EDGE_SEMANTICS`). This function only applies that lookup. The verdict
 * lattice, per-category aggregation, coverage caveat, and PII escalation stay
 * in the calling tools.
 *
 * Lookup order (mirrors the data table):
 *   1. `bySource[]` — ordered SPECIAL cases keyed on the extractor `source`
 *      marker (plus an optional `fromType` scope), first match wins. `references`
 *      has several producers whose semantics differ and whose referrer
 *      ComponentType does NOT tell them apart — a CustomField-sourced
 *      `references` edge is a formula reference, a roll-up coupling, or a
 *      resolved cross-object traversal depending ONLY on `source`. Classifying
 *      by type alone made the tool cite a roll-up summary that did not exist.
 *   2. `byEdgeType[edgeType].bySourceType[sourceType]` — keyed by the referrer
 *      node's ComponentType (e.g. `usedInLayout` / `grantedBy` classify to
 *      `review`: the platform auto-handles removal and nothing breaks — a
 *      heads-up, not a hard dependency).
 *   3. `byEdgeType[edgeType].default` — the edge type is known but the source
 *      ComponentType is not listed.
 *   4. `EDGE_SEMANTICS.default` — the edge type itself is not in the table.
 */
export const classifyEdgeSemantics = (
  edge: Edge,
  fromNode: Node,
): EdgeClassification => {
  for (const rule of EDGE_SEMANTICS.bySource) {
    if (edge.edgeType !== rule.edgeType) continue;
    if (edge.source !== rule.source) continue;
    if (rule.fromType !== undefined && fromNode.type !== rule.fromType) continue;
    return { category: rule.category, verdict: rule.verdict };
  }
  const rule = EDGE_SEMANTICS.byEdgeType[edge.edgeType];
  const resolved =
    rule === undefined
      ? EDGE_SEMANTICS.default
      : (rule.bySourceType[fromNode.type] ?? rule.default);
  return { category: resolved.category, verdict: resolved.verdict };
};
