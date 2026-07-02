/**
 * Shared honesty disclosures for tools that enumerate permission / sharing
 * grantors but cannot resolve which USERS hold those grants offline.
 *
 * User rows and PermissionSetAssignment are runtime assignment data — they
 * are not extracted into the vault unless an explicit facts capture ran.
 */

import { summarizeCoverage } from '@sf-intelligence/vault';

import type { Context } from '../server.js';

/** Verbatim disclosure consumed by judges and synthesize_answer grounding. */
export const USER_ASSIGNMENT_NOT_IN_VAULT =
  'User and PermissionSetAssignment data are not retrieved into this vault — ' +
  'which users hold a profile, permission set, or group membership cannot be ' +
  'answered offline. It is answerable via the live plane: run ' +
  '`sfi.live_permset_holders` (who holds a permission set / PSG / profile), ' +
  '`sfi.live_group_members` (who is in a queue / public group), or ' +
  '`sfi.live_user_permsets` (what a named user holds) — read-only, ' +
  'consent-gated — or refresh with a PermissionSetAssignment facts capture ' +
  'for offline holder counts.';

/** When a question asks for intersection of two permission sets per user. */
export const PERMSET_INTERSECTION_NOT_AVAILABLE =
  'Which users have multiple permission sets assigned requires ' +
  'PermissionSetAssignment rows (user assignment data not in vault). ' +
  'This tool can list each permission set structurally but cannot name users ' +
  'with both assignments offline. It is answerable via the live plane: ' +
  '`sfi.live_permset_holders` (read-only, consent-gated) lists the holders ' +
  'of each set for the intersection.';

/** Sharing-rule path expanded to groups/roles but not to User identities. */
export const SHARING_USER_ENUMERATION_NOT_AVAILABLE =
  'Sharing rules name group/role targets, but User records and group membership ' +
  'to individual users are not fully available offline — cannot enumerate every ' +
  'user who effectively receives Edit from a group-based sharing rule without ' +
  'live User / GroupMember / PermissionSetAssignment data. It is answerable ' +
  'via the live plane: `sfi.live_group_members` (read-only, consent-gated) ' +
  'enumerates the current members of a named queue / public group.';

/**
 * The consent-gated read-only live tools that answer assignment-data
 * questions (ENGINE-ARC §2+§3). Single source of truth for the
 * coverage_report / health_check assignmentData surfacing — runtime
 * assignment data is NOT a retrieve gap, it is live-first by design.
 */
export const ASSIGNMENT_DATA_LIVE_TOOLS = [
  'sfi.live_permset_holders',
  'sfi.live_user_permsets',
  'sfi.live_group_members',
  'sfi.live_zombie_accounts',
] as const;

/**
 * True when the vault refresh did not retrieve User or PermissionSetAssignment
 * metadata (the normal case). Tools embed {@link USER_ASSIGNMENT_NOT_IN_VAULT}
 * when this returns true — the disclosure names the live tools above as the
 * answer path, so an OFFLINE ask still gets an honest, actionable boundary.
 */
export const userAssignmentUnavailable = (ctx: Context): boolean => {
  const userCov = summarizeCoverage(ctx.manifest, ['User']);
  const psaCov = summarizeCoverage(ctx.manifest, ['PermissionSetAssignment']);
  return userCov.status !== 'complete' || psaCov.status !== 'complete';
};
