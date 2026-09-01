/**
 * Shared "referenced but absent" fact — UNUSED-CERTIFIED-ZERO-CONTRADICTED-BY-
 * OWN-GRAPH, hoisted out of `unused-components.ts` so every tool that reports
 * a per-type zero reads the SAME upstream fact instead of re-deriving its own
 * notion of it.
 *
 * ## Why this exists
 *
 * A metadata family the vault holds ZERO nodes of, while the vault's OWN
 * edges name specific members of it, is a self-contradiction the manifest
 * alone cannot see: the coverage row reads `{requested: true, retrieved: 0,
 * retrieveConfirmed: true}` (a "confirmed-clean, checked zero" by every
 * upstream signal), while every retrieved referrer in the graph points at
 * members that were never brought back.
 *
 * Measured on a real vault: ZERO nodes of a folder-scoped family, 79
 * `declared` edges from approval processes and workflow alerts naming 30
 * distinct members of it. Before this module existed, `sfi.unused_components`
 * certified that 0 as checked, `sfi.coverage_report` reported the family
 * `covered`, and `sfi.retrieve_blindspot_report` (built on the same
 * `danglingTargetSummary` query) reported it `partial` in the SAME run — three
 * tools, one vault, one fact, three different stories. An admin who checks two
 * of them sees them disagree about the same org.
 *
 * `referencedButAbsentFamilies` is the ONE place that fact is computed. Every
 * tool that needs to know whether a per-type zero is a genuinely checked zero
 * or a contradicted one calls this instead of re-deriving it, so the three
 * surfaces cannot drift apart again as they are edited independently — the
 * same reasoning as `absence-disclosure.ts` / `declared-only-disclosure.ts`.
 *
 * Why the upstream fact cannot be trusted for such a family: a bare wildcard
 * retrieve of a FOLDER-SCOPED metadata type returns nothing whether or not the
 * org holds any, so "retrieve completed, zero members" is guaranteed and can
 * never be evidence of absence. The graph's dangling references are the
 * arbiter and they win.
 */

import type { ComponentType, McpError } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { countNodesByType, danglingTargetSummary } from '@sf-intelligence/graph';

import type { Context } from '../server.js';

/** A candidate family that is wholly absent yet named by the vault's own edges. */
export interface ReferencedButAbsentFamily {
  /** Non-heuristic edges pointing at members of this family that do not exist. */
  readonly referenceEdges: number;
  /** Distinct missing member ids those edges name. */
  readonly distinctTargets: number;
}

/**
 * Confidence tiers whose dangling references are strong enough to unseat a
 * "confirmed-empty" certification. `heuristic` is DELIBERATELY excluded: that
 * is the unresolved-Apex-scanner phantom tier `sfi.retrieve_blindspot_report`
 * rolls up as documented noise, and a phantom must never be able to convert a
 * genuinely checked zero into a hedge — the false-positive direction is just
 * as dishonest as the false-negative one this fixes.
 */
export const CONTRADICTING_CONFIDENCE: ReadonlySet<string> = new Set([
  'declared',
  'parsed',
]);

/**
 * Which of `candidates` are REFERENCED BUT ABSENT: zero nodes in the vault, yet
 * one or more non-heuristic edges name a member of them.
 *
 * Built on the SHARED `danglingTargetSummary` graph query (the same anti-join
 * `sfi.retrieve_blindspot_report` is built on) rather than re-deriving a second
 * notion of "referenced but never retrieved" per caller — the whole point is
 * that every consumer of this function reads the identical fact.
 *
 * Fails CLOSED: a graph error propagates to the caller as an error rather than
 * silently restoring the certified zero.
 */
export const referencedButAbsentFamilies = async (
  ctx: Context,
  candidates: readonly string[],
): Promise<Result<ReadonlyMap<string, ReferencedButAbsentFamily>, McpError>> => {
  const out = new Map<string, ReferencedButAbsentFamily>();
  if (candidates.length === 0) return ok(out);
  const summary = await danglingTargetSummary(ctx.graph);
  if (!summary.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${summary.error.message}`,
    });
  }
  const wanted = new Set(candidates);
  const tallies = new Map<string, { edges: number; targets: number }>();
  for (const group of summary.value) {
    if (!wanted.has(group.targetType)) continue;
    if (!CONTRADICTING_CONFIDENCE.has(group.confidence)) continue;
    const prev = tallies.get(group.targetType) ?? { edges: 0, targets: 0 };
    tallies.set(group.targetType, {
      edges: prev.edges + group.edgeCount,
      // Groups are split by (edgeType, confidence), so distinct-target counts
      // can overlap across groups of the same family. Sum is the honest upper
      // bound on "at least this many members are named"; it is only ever used
      // to say the number is non-zero and to size the disclosure.
      targets: prev.targets + group.distinctTargets,
    });
  }
  for (const [type, tally] of tallies) {
    // Only a WHOLLY absent family is a contradiction of "the org holds none".
    // A family with nodes plus some dangling members (managed-package member,
    // a community context outside the retrieve scope) is the ordinary blind
    // spot `coverageCaveat` already covers — not a false certification.
    const count = await countNodesByType(ctx.graph, type as ComponentType);
    if (!count.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${count.error.message}`,
      });
    }
    if (count.value > 0) continue;
    out.set(type, {
      referenceEdges: tally.edges,
      distinctTargets: tally.targets,
    });
  }
  return ok(out);
};
