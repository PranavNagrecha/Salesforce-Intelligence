/**
 * Shared Role-subtree expansion over `inheritsFrom` edges — CR-CAP-05b.
 *
 * A Salesforce sharing rule that shares with a `roleAndSubordinates` /
 * `roleAndSubordinatesInternal` target grants access not only to the named role
 * but to EVERY role BELOW it in the role hierarchy. The role extractor emits one
 * `inheritsFrom` edge per role with a `<parentRole>` (role.ts:201-213), oriented
 * `fromId = child --inheritsFrom--> toId = parent`. So a role's subordinates are
 * reached by walking INBOUND `inheritsFrom` edges: for a role `R`, every child
 * `C` with `C --inheritsFrom--> R` is a DIRECT subordinate, and the subtree is
 * the transitive closure of that walk.
 *
 * This is the DESCENDING mirror of CR-CAP-05's ascending `walkRoleHierarchy`
 * (why-cant-user-see-record.ts) — but descent FANS OUT (a parent has many
 * children), so it cannot reuse that single-cursor walk (which takes only the
 * first edge). It is shaped exactly like `expandGroupMembers`
 * (group-membership.ts): a BFS frontier + visited-set + node-count cap +
 * `truncated` flag + deterministic sort, walking INBOUND `inheritsFrom` instead
 * of OUTBOUND `hasMember`.
 *
 * This module is the ONE place the sharing-access surfaces
 * (`who_can_access_object`, `generate_sharing_summary`) turn a subordinate-marked
 * role target into the descending role set, so the two surfaces never drift.
 *
 * Honesty (mirror of CR-CAP-05's truncation discipline):
 *
 *   - The named role itself is ALWAYS in the result (a `subordinates` share
 *     includes the role).
 *   - Every role actually reached is `declared`-confidence — a real subordinate.
 *   - When a child node referenced by an inbound edge was NOT retrieved into the
 *     vault (getNodeById null — partial refresh), a `listEdges` call errors, or
 *     the cap is hit, `truncated` is set true. The reached roles are still
 *     returned; the caller DISCLOSES the incomplete subtree (additive blindSpot
 *     → /sfi-refresh + coverage_report) and NEVER fabricates an unenumerated
 *     role row. This is an under-list, never an over-grant.
 *
 * `roleAndSubordinatesInternal` honesty boundary: the "internal" variant is
 * meant to EXCLUDE partner / community (portal) roles below `R`. But Role nodes
 * carry no portal/internal marker in the offline metadata (role.ts properties =
 * caseAccessLevel/contactAccessLevel/opportunityAccessLevel/
 * mayForecastManagerShare/description only), so the descend CANNOT filter portal
 * roles offline. This helper runs the SAME inbound descend for both variants;
 * the caller must DISCLOSE that the internal-vs-portal exclusion could not be
 * applied (the subtree may include portal roles the real rule excludes) rather
 * than silently dropping or silently over-including them.
 */

import type { ComponentId } from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';

import type { Context } from '../server.js';

/** Canonical id prefix that marks a Role target. */
export const ROLE_PREFIX = 'Role:';

/**
 * Bound on roles visited, guarding pathological fan-out / cycles. Salesforce
 * caps a role hierarchy at 500 roles; a node-count cap an order of magnitude
 * above that is safe headroom (mirrors group-membership's MEMBERSHIP_WALK_CAP).
 */
const ROLE_SUBTREE_CAP = 1000;

/** Outcome of expanding a role DOWNWARD into its (transitive) subordinates. */
export interface ExpandedRoleSubtree {
  /**
   * The seed role id PLUS every subordinate `Role:` id reached transitively via
   * INBOUND `inheritsFrom`. Always a superset of the seed (the named role is
   * included). Does NOT include the seed's ancestors (this is a descend).
   */
  readonly roleIds: ReadonlySet<string>;
  /**
   * True when the subtree could not be fully enumerated — a child role node
   * referenced by an inbound `inheritsFrom` edge was NOT retrieved into the
   * vault (partial refresh), a graph error occurred, or the cap was hit. The
   * caller DISCLOSES the incomplete subtree (additive blindSpot) and never
   * fabricates an unenumerated role; the reached roles in `roleIds` are real.
   */
  readonly truncated: boolean;
}

/**
 * Expand a role DOWNWARD into the role subtree a `roleAndSubordinates` /
 * `roleAndSubordinatesInternal` share grants (CR-CAP-05b). Walks INBOUND
 * `inheritsFrom` edges to a monotone fixpoint: for the seed role `R`, every
 * child `C` with `C --inheritsFrom--> R` is added, then `C`'s own children, and
 * so on. The seed role is always included.
 *
 * Cycle-safe: a visited-set seeded with the start role terminates any malformed
 * back-edge (e.g. `Role:A inheritsFrom Role:B` AND `Role:B inheritsFrom
 * Role:A`). Bounded by {@link ROLE_SUBTREE_CAP}; the cap sets `truncated`.
 *
 * @example
 *   // Role:Sales_Mgr --inheritsFrom--> Role:VP_Sales (Mgr is VP's subordinate)
 *   const r = await expandRoleSubordinates(ctx, 'Role:VP_Sales');
 *   if (r.ok) r.value.roleIds.has('Role:Sales_Mgr'); // => true
 *   if (r.ok) r.value.roleIds.has('Role:VP_Sales');  // => true (seed included)
 */
export const expandRoleSubordinates = async (
  ctx: Context,
  roleId: string,
): Promise<Result<ExpandedRoleSubtree, string>> => {
  const resolved = new Set<string>([roleId]);
  const frontier: string[] = [roleId];
  let truncated = false;
  let visited = 0;
  while (frontier.length > 0) {
    if (visited >= ROLE_SUBTREE_CAP) {
      truncated = true;
      break;
    }
    visited += 1;
    const currentId = frontier.shift()!;
    // INBOUND inheritsFrom: children `C` with `C --inheritsFrom--> currentId`.
    const edgesResult = await listEdges(ctx.graph, currentId as ComponentId, {
      direction: 'in',
      edgeType: 'inheritsFrom',
    });
    if (!edgesResult.ok) {
      // Could not read this role's subordinate edges — be honest, not silent.
      truncated = true;
      continue;
    }
    for (const edge of edgesResult.value) {
      const childId = edge.fromId;
      if (!childId.startsWith(ROLE_PREFIX)) continue; // only roles inherit
      if (resolved.has(childId)) continue; // cycle / re-converging path
      // Mirror walkRoleHierarchy's missing-node probe: a child referenced by an
      // inbound edge whose NODE was never retrieved means the subtree is
      // possibly larger than we can enumerate — disclose, don't drop silently.
      const childNode = await getNodeById(ctx.graph, childId as ComponentId);
      if (!childNode.ok) {
        truncated = true;
        continue;
      }
      if (childNode.value === null) {
        truncated = true;
        // Still record the reached role id (the edge declared it) so the named
        // subordinate is listed; its own subtree is what we cannot enumerate.
      }
      resolved.add(childId);
      frontier.push(childId);
    }
  }
  return ok({ roleIds: resolved, truncated });
};
