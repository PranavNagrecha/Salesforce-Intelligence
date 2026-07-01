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
  'answered offline. Run the live org plane (read-only) or refresh with a ' +
  'PermissionSetAssignment facts capture for user-assignment questions.';

/** When a question asks for intersection of two permission sets per user. */
export const PERMSET_INTERSECTION_NOT_AVAILABLE =
  'Which users have multiple permission sets assigned requires ' +
  'PermissionSetAssignment rows (user assignment data not in vault). ' +
  'This tool can list each permission set structurally but cannot name users ' +
  'with both assignments without querying live assignment data.';

/** Sharing-rule path expanded to groups/roles but not to User identities. */
export const SHARING_USER_ENUMERATION_NOT_AVAILABLE =
  'Sharing rules name group/role targets, but User records and group membership ' +
  'to individual users are not fully available offline — cannot enumerate every ' +
  'user who effectively receives Edit from a group-based sharing rule without ' +
  'live User / GroupMember / PermissionSetAssignment data.';

/**
 * True when the vault refresh did not retrieve User or PermissionSetAssignment
 * metadata (the normal case). Tools embed {@link USER_ASSIGNMENT_NOT_IN_VAULT}
 * when this returns true.
 */
export const userAssignmentUnavailable = (ctx: Context): boolean => {
  const userCov = summarizeCoverage(ctx.manifest, ['User']);
  const psaCov = summarizeCoverage(ctx.manifest, ['PermissionSetAssignment']);
  return userCov.status !== 'complete' || psaCov.status !== 'complete';
};
