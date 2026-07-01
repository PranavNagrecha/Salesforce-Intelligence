/**
 * Shared Group-membership expansion over `hasMember` edges — CR-CAP-12.
 *
 * A Salesforce public group's `<related>` rows declare its members. The group
 * extractor now emits one `hasMember` edge per row
 * (`Group:{G} --hasMember--> {member}`) where the member is a `User:` (dangling
 * — no User ComponentType), `Role:` (optionally carrying
 * `inheritance: 'subordinates'`), a nested `Group:` (transitive), or a
 * `Territory:` synthetic (`resolvable: false`). This module is the ONE place the
 * two record-access tools (`why_cant_user_see_record`, `who_can_access_object`)
 * turn that topology into a membership answer, so the two surfaces stay
 * consistent (the same nested group resolves the same way in both).
 *
 * Two directions, both a monotone fixpoint over `hasMember` (mirroring the
 * CR-CAP-04 PSG expansion — add-only, bounded by the node set, no revisits):
 *
 *   - UPWARD (`expandGroupMembership`): given the literal group ids a user
 *     belongs to, find every ANCESTOR group that contains them transitively by
 *     walking INBOUND `hasMember` edges (a parent group `P` with
 *     `P --hasMember--> G` contains everyone in `G`). A user typed into only the
 *     nested group then matches a sharing rule that grants the enclosing public
 *     group. Returns the expanded membership set plus a `truncated` flag the
 *     caller downgrades to `unknown` honesty: a missing ancestor group node
 *     means we could neither confirm nor rule out membership.
 *
 *   - DOWNWARD (`expandGroupMembers`): given a group a record is shared with,
 *     enumerate every member it grants by walking OUTBOUND `hasMember` edges,
 *     recursing through nested groups. Returns each member as a resolved row so
 *     `who_can_access_object` lists the actual principals, not just the group.
 *
 * Honesty: `hasMember` edges are `declared` (the `<related>` row is the
 * declaration), but a `Territory:` (or any `resolvable: false`) member is
 * dangling-by-design — callers must DISCLOSE it rather than read it as a
 * resolved membership. Edge orientation is always `Group -> member`, so the
 * UPWARD walk reads INBOUND edges and the DOWNWARD walk reads OUTBOUND edges.
 */

import type { ComponentId } from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import { listEdges } from '@sf-intelligence/graph';

import type { Context } from '../server.js';

/** Canonical id prefix that marks a (possibly nested) Group target. */
const GROUP_PREFIX = 'Group:';

/** Bound on fixpoint iterations / nodes visited, guarding pathological cycles. */
const MEMBERSHIP_WALK_CAP = 1000;

/** Result of expanding a user's literal group ids UPWARD to enclosing groups. */
export interface ExpandedGroupMembership {
  /**
   * The literal seed group ids PLUS every ancestor `Group:` id that contains
   * them transitively via `hasMember`. Always a superset of the seeds.
   */
  readonly groupIds: ReadonlySet<string>;
  /**
   * True when an enclosing group could not be fully resolved — a `hasMember`
   * edge pointed at a member the walk could read, but a graph error / cap was
   * hit, OR a seed/ancestor referenced a group whose enclosing edges may be
   * incomplete. The caller downgrades an otherwise-`restricted` membership
   * verdict to `unknown` (never a confident false-deny).
   */
  readonly truncated: boolean;
}

/**
 * Expand the literal `Group:` ids a user belongs to UPWARD into every group
 * that contains them transitively (CR-CAP-12). Walks INBOUND `hasMember` edges
 * to a monotone fixpoint: for each known member group `G`, any parent `P` with
 * `P --hasMember--> G` is added, then `P`'s own parents, and so on.
 *
 * Only `Group:` seeds participate (a role/user member of the user context is
 * matched directly by the caller, not expanded here). Non-group `hasMember`
 * sources are ignored — membership flows only group→group upward.
 *
 * @example
 *   // user is typed into Group:Nested, which Group:Public contains.
 *   const r = await expandGroupMembership(ctx, ['Group:Nested']);
 *   if (r.ok) r.value.groupIds.has('Group:Public'); // => true
 */
export const expandGroupMembership = async (
  ctx: Context,
  seedGroupIds: readonly string[],
): Promise<Result<ExpandedGroupMembership, string>> => {
  const resolved = new Set<string>();
  // Seed the frontier with the literal Group: ids only.
  const frontier: string[] = [];
  for (const id of seedGroupIds) {
    if (id.startsWith(GROUP_PREFIX) && !resolved.has(id)) {
      resolved.add(id);
      frontier.push(id);
    }
  }
  let truncated = false;
  let visited = 0;
  while (frontier.length > 0) {
    if (visited >= MEMBERSHIP_WALK_CAP) {
      truncated = true;
      break;
    }
    visited += 1;
    const memberId = frontier.shift()!;
    // INBOUND hasMember: parents `P` with `P --hasMember--> memberId`.
    const edgesResult = await listEdges(ctx.graph, memberId as ComponentId, {
      direction: 'in',
      edgeType: 'hasMember',
    });
    if (!edgesResult.ok) {
      // Could not read this group's enclosing edges — be honest, not silent.
      truncated = true;
      continue;
    }
    for (const edge of edgesResult.value) {
      const parentId = edge.fromId;
      if (!parentId.startsWith(GROUP_PREFIX)) continue; // only groups enclose
      if (resolved.has(parentId)) continue;
      resolved.add(parentId);
      frontier.push(parentId);
    }
  }
  return ok({ groupIds: resolved, truncated });
};

/** One member reached by walking a group's `hasMember` edges DOWNWARD. */
export interface ResolvedGroupMember {
  /** The member's canonical id (`User:…`, `Role:…`, `Group:…`, `Territory:…`). */
  readonly memberId: string;
  /** The `<related>` row `type` the edge recorded (e.g. `RoleAndSubordinates`). */
  readonly memberType: string;
  /** Subordinate inheritance marker when the member is a `roleAndSubordinates`. */
  readonly inheritance: string | null;
  /**
   * False for dangling-by-design members (e.g. `Territory:`) the caller must
   * DISCLOSE rather than treat as a fully resolved principal. True otherwise.
   */
  readonly resolvable: boolean;
  /** The group whose `hasMember` edge produced this member (provenance). */
  readonly viaGroupId: string;
}

/** Outcome of expanding a group DOWNWARD into its (transitive) members. */
export interface ExpandedGroupMembers {
  /**
   * Every member reached from the seed group through `hasMember`, recursing
   * into nested groups. The nested `Group:` members themselves are INCLUDED as
   * rows (a nested group is both a member AND a container) so the caller can
   * surface group-level grants too.
   */
  readonly members: readonly ResolvedGroupMember[];
  /** True when a graph error / cap stopped the walk before it completed. */
  readonly truncated: boolean;
}

/**
 * Expand a group DOWNWARD into the members it grants (CR-CAP-12). Walks
 * OUTBOUND `hasMember` edges from `seedGroupId`, recursing through nested
 * `Group:` members so a record shared with the outer group lists the principals
 * the inner group contributes. Each member is returned once (dedup by id); a
 * nested group appears both as a member row and as a recursion frontier.
 *
 * @example
 *   // Group:Outer hasMember Group:Inner; Group:Inner hasMember User:x.
 *   const r = await expandGroupMembers(ctx, 'Group:Outer');
 *   if (r.ok) r.value.members.map(m => m.memberId);
 *   //   => ['Group:Inner', 'User:x']
 */
export const expandGroupMembers = async (
  ctx: Context,
  seedGroupId: string,
): Promise<Result<ExpandedGroupMembers, string>> => {
  const members: ResolvedGroupMember[] = [];
  const seenMembers = new Set<string>();
  const visitedGroups = new Set<string>([seedGroupId]);
  const frontier: string[] = [seedGroupId];
  let truncated = false;
  let visited = 0;
  while (frontier.length > 0) {
    if (visited >= MEMBERSHIP_WALK_CAP) {
      truncated = true;
      break;
    }
    visited += 1;
    const groupId = frontier.shift()!;
    const edgesResult = await listEdges(ctx.graph, groupId as ComponentId, {
      direction: 'out',
      edgeType: 'hasMember',
    });
    if (!edgesResult.ok) {
      truncated = true;
      continue;
    }
    for (const edge of edgesResult.value) {
      const memberId = edge.toId;
      const inheritanceRaw = edge.properties['inheritance'];
      const inheritance =
        typeof inheritanceRaw === 'string' ? inheritanceRaw : null;
      const memberTypeRaw = edge.properties['memberType'];
      const memberType =
        typeof memberTypeRaw === 'string'
          ? memberTypeRaw
          : memberId.includes(':')
            ? memberId.slice(0, memberId.indexOf(':'))
            : 'Unknown';
      // `resolvable: false` is stamped on dangling-by-design members (Territory).
      const resolvable = edge.properties['resolvable'] !== false;
      if (!seenMembers.has(memberId)) {
        seenMembers.add(memberId);
        members.push({
          memberId,
          memberType,
          inheritance,
          resolvable,
          viaGroupId: groupId,
        });
      }
      // Recurse into nested groups for transitivity.
      if (memberId.startsWith(GROUP_PREFIX) && !visitedGroups.has(memberId)) {
        visitedGroups.add(memberId);
        frontier.push(memberId);
      }
    }
  }
  // Deterministic order so reasoning / granter output is stable across runs.
  members.sort((a, b) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0));
  return ok({ members, truncated });
};
