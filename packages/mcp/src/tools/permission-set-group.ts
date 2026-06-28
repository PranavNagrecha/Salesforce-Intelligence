/**
 * Shared PermissionSetGroup (PSG) expansion — CR-CAP-04.
 *
 * A Salesforce PermissionSetGroup aggregates N member PermissionSets; it may
 * also reference MUTING permission sets whose perms are SUBTRACTED from the
 * group total. So a user/profile assigned a PSG effectively has
 *   (union of member-permset perms) MINUS (muting-permset perms).
 *
 * This module is the ONE place the three access tools
 * (`effective_permissions`, `why_cant_user_see_record`, `who_can_access_object`)
 * — and `synthesis-reports` — go to turn a PSG id into its member permission
 * set ids. PSG membership is DECLARED metadata (the PSG XML lists its member
 * permission sets + muting permission sets), so consuming it yields a REAL,
 * `declared`-confidence answer.
 *
 * Two read paths, both backed by the PSG extractor
 * (`extractPermissionSetGroup`):
 *   - FORWARD (`expandPermissionSetGroup` / `expandAllPermissionSetGroups`):
 *     read the PSG node's `permissionSets` / `mutingPermissionSets` properties
 *     (bare member names) and prefix them to canonical ids. This is the
 *     cheapest path and exactly what `synthesis-reports` already does, so
 *     refactoring synthesis onto it is a no-behavior-change.
 *   - REVERSE (`findPermissionSetGroupsContaining`): given a PermissionSet id,
 *     walk its INBOUND `references` edges (`referenceKind === 'permissionSetGroupMember'`)
 *     to find every PSG that confers it. There is no node property for
 *     "groups that contain me", so the reverse direction must use edges.
 *
 * MUTING honesty boundary: the helper returns `mutingPermissionSetIds` for
 * DISCLOSURE only and NEVER nets them out. A MutingPermissionSet node carries
 * no enumerable denied perms (the generic extractor parses no permissions), so
 * there is literally nothing to subtract; honest subtraction would require a
 * dedicated MutingPermissionSet extractor, which is out of scope here.
 * Consumers that expand a PSG with `hasMuting === true` must emit a muting
 * caveat, and must NEVER claim muting was subtracted.
 */

import type {
  ComponentId,
  Node,
} from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import {
  getNodeById,
  listEdges,
  listNodesByType,
  type GraphError,
} from '@sf-intelligence/graph';

import type { Context } from '../server.js';

/** Canonical id prefixes for the families this helper composes. */
const PSG_PREFIX = 'PermissionSetGroup:';
const PERMISSION_SET_PREFIX = 'PermissionSet:';
const MUTING_PERMISSION_SET_PREFIX = 'MutingPermissionSet:';

/** PSG-member `references` edge discriminator stamped by the extractor. */
const MEMBER_REFERENCE_KIND = 'permissionSetGroupMember';

/** Cap on how many PSGs `expandAllPermissionSetGroups` enumerates. */
const PSG_SCAN_CAP = 500;

/** The declared expansion of one PermissionSetGroup. */
export interface ExpandedPsg {
  /** The PSG's canonical id (`PermissionSetGroup:<ApiName>`). */
  readonly psgId: ComponentId;
  /** Canonical ids of the member permission sets (the union contributors). */
  readonly memberPermissionSetIds: readonly ComponentId[];
  /**
   * Canonical ids of the muting permission sets. DISCLOSED only — NEVER
   * subtracted (the muting extractor parses no denied perms, so there is
   * nothing enumerable to net out).
   */
  readonly mutingPermissionSetIds: readonly ComponentId[];
  /** True when the PSG references ≥1 muting permission set (forces a caveat). */
  readonly hasMuting: boolean;
}

/** Read a node property that should be an array of bare member names. */
const readMemberNames = (node: Node, key: string): string[] => {
  const raw = node.properties[key];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === 'string' && v.length > 0) out.push(v);
  }
  return out;
};

/** Prefix a list of bare names with a canonical type prefix, de-duplicated + sorted. */
const toIds = (names: readonly string[], prefix: string): ComponentId[] =>
  [...new Set(names.map((n) => `${prefix}${n}`))].sort() as ComponentId[];

/** Build an `ExpandedPsg` from a resolved PSG node (FORWARD property read). */
const expandFromNode = (psgNode: Node): ExpandedPsg => {
  const memberPermissionSetIds = toIds(
    readMemberNames(psgNode, 'permissionSets'),
    PERMISSION_SET_PREFIX,
  );
  const mutingPermissionSetIds = toIds(
    readMemberNames(psgNode, 'mutingPermissionSets'),
    MUTING_PERMISSION_SET_PREFIX,
  );
  return {
    psgId: psgNode.id,
    memberPermissionSetIds,
    mutingPermissionSetIds,
    hasMuting: mutingPermissionSetIds.length > 0,
  };
};

/**
 * Expand ONE PermissionSetGroup into its member + muting permission set ids
 * (FORWARD, property read). Returns `null` when no PSG node exists for `psgId`
 * (a phantom / wrong id) — the caller treats that exactly as "not a PSG".
 *
 * This is the reusable kernel the brief's `synthesis-reports.ts` membership
 * read already performs inline; refactoring synthesis onto it is a
 * no-behavior-change because the bare-name → `PermissionSet:<name>`
 * reconstruction is identical.
 *
 * @example
 *   const r = await expandPermissionSetGroup(ctx, 'PermissionSetGroup:Sales');
 *   if (r.ok && r.value) console.log(r.value.memberPermissionSetIds);
 */
export const expandPermissionSetGroup = async (
  ctx: Context,
  psgId: ComponentId,
): Promise<Result<ExpandedPsg | null, GraphError>> => {
  const nodeResult = await getNodeById(ctx.graph, psgId);
  if (!nodeResult.ok) return nodeResult;
  if (nodeResult.value === null || nodeResult.value.type !== 'PermissionSetGroup') {
    return ok(null);
  }
  return ok(expandFromNode(nodeResult.value));
};

/**
 * Expand EVERY PermissionSetGroup in the vault (FORWARD). Used by consumers
 * that need the full PSG roster (e.g. a reverse scan that the edge lookup
 * cannot serve).
 */
export const expandAllPermissionSetGroups = async (
  ctx: Context,
): Promise<Result<readonly ExpandedPsg[], GraphError>> => {
  const nodesResult = await listNodesByType(ctx.graph, 'PermissionSetGroup', {
    limit: PSG_SCAN_CAP,
  });
  if (!nodesResult.ok) return nodesResult;
  return ok(nodesResult.value.map(expandFromNode));
};

/**
 * REVERSE lookup: every PermissionSetGroup that confers `permissionSetId`
 * through membership. Walks the permission set's INBOUND `references` edges
 * and keeps those whose `referenceKind === 'permissionSetGroupMember'`,
 * returning each edge's `fromId` (the PSG). Edge-based because there is no node
 * property for "groups that contain me". De-duplicated + sorted.
 *
 * @example
 *   const r = await findPermissionSetGroupsContaining(ctx, 'PermissionSet:Sales_PS');
 *   if (r.ok) console.log(r.value); // ['PermissionSetGroup:Sales_Group', ...]
 */
export const findPermissionSetGroupsContaining = async (
  ctx: Context,
  permissionSetId: ComponentId,
): Promise<Result<readonly ComponentId[], GraphError>> => {
  const edgesResult = await listEdges(ctx.graph, permissionSetId, {
    direction: 'in',
    edgeType: 'references',
  });
  if (!edgesResult.ok) return edgesResult;
  const groups = new Set<ComponentId>();
  for (const edge of edgesResult.value) {
    if (edge.properties['referenceKind'] !== MEMBER_REFERENCE_KIND) continue;
    if (!edge.fromId.startsWith(PSG_PREFIX)) continue;
    groups.add(edge.fromId);
  }
  return ok([...groups].sort());
};
