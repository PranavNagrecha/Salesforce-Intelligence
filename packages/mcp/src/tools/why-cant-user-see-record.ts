/**
 * Handler for the `sfi.why_cant_user_see_record` MCP tool.
 *
 * The v1.1 headline tool — the buyer-facing answer to the #1 admin
 * call: "why can't this user VIEW / EDIT / DELETE / CREATE this record?". Walks
 * the Salesforce sharing cascade in the order the platform itself evaluates it
 * and returns a structured reasoning chain a caller can either render verbatim
 * or summarise for an end user.
 *
 * The `accessLevel` input (`'read'` default | `'edit'` | `'delete'` |
 * `'create'`) raises the bar at EVERY stage — a read-only OWD/grant/View-All
 * never reads as edit-capable, and no sharing rule grants delete. Ranks: `read`
 * needs OWD/grant ≥ Read; `edit` needs ≥ ReadWrite (or `allowEdit`/ModifyAll);
 * `delete` needs FullAccess (or `allowDelete`/ModifyAll/ownership).
 *
 * `create` is a SEPARATE model: it does NOT flow through OWD / sharing rules /
 * role hierarchy / restriction / scoping at all (you don't need access to
 * existing records to create one). It short-circuits the cascade and is
 * `visible` only when the user has object Create permission (`allowCreate`, or
 * object/system Modify-All) AND — if the object has record types — at least one
 * VISIBLE record type (a `RecordType` stage reads `recordTypeVisibilities`).
 * The record-type gate is ANDed onto the permission gate.
 *
 * The cascade, in this exact order:
 *
 *   1. **OWD** (Organization-Wide Default) — read `componentId`'s
 *      `properties.sharingModel`.
 *        - rank ≥ the operation's requirement → `visible`. No further
 *          restriction is possible; the cascade short-circuits and the
 *          reasoning array contains only the OWD step. (e.g. `Read` visible for
 *          read; `ReadWrite` for edit; `FullAccess` for delete.)
 *        - a recognised OWD below the requirement (`Private`, or `Read` for an
 *          edit check, etc.) → `restricted`. Continue the cascade; downstream
 *          grants / ownership / Modify-All can grant access back.
 *        - `null` (custom metadata, custom setting, etc.) → `unknown`.
 *          Stop the cascade and return `unknown` overall.
 *
 *   2. **PermissionGrant** — examine incoming `grantedBy` edges to
 *      `componentId` from every id in
 *      `userContext.profileId` + `userContext.permissionSetIds`. If any
 *      grants read-or-better access (`allowRead`, `viewAllRecords`,
 *      `modifyAllRecords`), the verdict is `visible` and overrides
 *      OWD-restricted (Modify-All-Data style). These are OBJECT-level perms.
 *
 *   2a. **SystemPermission** — the org-wide `ViewAllData` / `ModifyAllData`
 *      system permissions (read from a Profile / PermissionSet's
 *      `properties.userPermissions`) bypass OWD and ALL record sharing for
 *      every object, so a restricted OWD does not stop a god-mode user →
 *      `visible`. Exception: an active RestrictionRule on the object can still
 *      filter specific users even with View All Data, so god-mode reports
 *      `unknown` (with the caveat) when the object carries one.
 *
 *   3. **RoleHierarchy** — only when OWD is restricted and the user has
 *      a `roleId`. Walk `inheritsFrom` edges upward from the user's
 *      role. The v1.1 graph cannot tell which role owns records of this
 *      object (record-level data is out of scope), so this stage always
 *      returns `unknown` with the full role chain in `traversed`. The
 *      admin can then check ownership manually.
 *
 *   4. **OwnerSharingRule** — list all `SharingRule` nodes parented to
 *      `componentId` (incoming `parentOf`) where
 *      `properties.ruleType === 'owner'`. For each rule, walk outgoing
 *      `sharedWith` edges and check whether the resolved id matches the
 *      user's `roleId` / `groupIds` (treating `Group:AllInternalUsers`
 *      and the other synthetic groups in the variant table as members
 *      whenever any `userContext` field is supplied — every authenticated
 *      user is "internal"). One step per rule; `visible` if a match,
 *      `restricted` otherwise.
 *
 *   5. **CriteriaSharingRule** — similar enumeration but
 *      `ruleType === 'criteria'`. Criteria require record-level data to
 *      evaluate (the booleanFilter is over field values, not metadata),
 *      so this stage always returns `unknown` with the rule's
 *      `booleanFilter` (or `criteriaItemCount`) surfaced in the reason.
 *
 *   6/7/8/9. **TerritoryAndGuestRules**, **ManualSharing**,
 *      **SharingSets**, **AccountTeams** — always `unknown` with
 *      explanatory reasons. Territory & guest (Experience Cloud) sharing
 *      rules are SKIPPED by the extractor; the rest require record-level
 *      data or org-config beyond v1.1's metadata model. They appear at
 *      the tail so callers can show admins what was NOT modeled and
 *      recommend a manual check.
 *
 * **Aggregate verdict**:
 *   - `visible` if any step before a hard-restriction is `visible`
 *     (PermissionGrant overrides OWD; OwnerSharingRule overrides
 *     RoleHierarchy).
 *   - `restricted` if OWD is restricted, PermissionGrant doesn't
 *     override, every owner sharing rule misses, and no remaining
 *     stage is `unknown` *before* a `visible`.
 *   - `unknown` if OWD is `unknown`, OR if no step is `visible` and
 *     any step in the deciding chain is `unknown`.
 *
 * **Honesty axis**: this tool never fabricates. Stages whose verdict
 * the v1.1 metadata model cannot decide (criteria filters, manual
 * sharing, sharing sets, account teams, role-based ownership) report
 * `unknown` with an explanation the caller can pass to the admin
 * verbatim. A `restricted` verdict from this tool means the cascade
 * exhausted every modeled grant path; an `unknown` verdict means the
 * answer depends on data outside v1.1's read-side scope.
 *
 * Implementation notes:
 *   - `componentId` is the CustomObject being checked, NOT a User id.
 *     v1.1 has no User node extraction and no record-level data; the
 *     tool's surface is the user's access bundle
 *     (`profileId`/`permissionSetIds`/`roleId`/`groupIds`). v1.7's
 *     Tooling API integration will add a shim that resolves a real
 *     Salesforce User ID to this bundle.
 *   - Synthetic group memberships: when any `userContext` field is
 *     supplied, the user is treated as a member of
 *     `Group:AllInternalUsers`. Other synthetic groups
 *     (`AllCustomerPortalUsers`, `PartnerUsers`, `GuestUser`) require
 *     the caller to opt in explicitly via `groupIds`. The synthetic
 *     groups in the sharing-rule extractor's variant table are
 *     dangling-by-design (no Group node), so the membership decision
 *     happens here, not via a graph lookup.
 *   - Role hierarchy traversal: defends against malformed cycles with
 *     a visited-set; `traversed` lists only the parent chain (the
 *     starting role is implicit in `userContext.roleId`).
 */

import type {
  ComponentId,
  Edge,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges, listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { coercePrefix } from './coerce-id.js';

/**
 * The set of OWD values that imply records are private and access
 * must be granted by a subsequent stage. `ControlledByParent` (and
 * `ControlledByCampaign`, the CampaignMember OWD) are grouped here
 * because the v1.1 model does not walk to the parent object / campaign
 * — the admin still needs to verify the parent's OWD manually.
 */
const OWD_RESTRICTED: ReadonlySet<string> = new Set([
  'Private',
  'ControlledByParent',
  'ControlledByCampaign',
]);

/** The record operation being evaluated. */
type AccessLevel = 'read' | 'edit' | 'delete' | 'create';

/**
 * Numeric requirement of each operation, compared against an OWD/grant rank.
 * `create` is OFF the read<edit<delete record-visibility ladder — it does not
 * flow through OWD/sharing at all (see the create branch in the handler), so it
 * is never compared against `owdRank`; the entry exists only to keep the record
 * total and is given a sentinel above `delete`.
 */
const ACCESS_RANK: Readonly<Record<AccessLevel, number>> = {
  read: 1,
  edit: 2,
  delete: 3,
  create: 4,
};

/**
 * Rank an OWD value: 0 = restricted (no public access), 1 = public Read,
 * 2 = public Read/Write, 3 = full access (incl. delete). An OWD `visible`s an
 * operation when its rank ≥ the operation's `ACCESS_RANK`. Returns `null` for an
 * unrecognised value so the caller reports `unknown` rather than a guess.
 */
const owdRank = (sharingModel: string): number | null => {
  if (OWD_RESTRICTED.has(sharingModel)) return 0;
  if (sharingModel === 'Read') return 1;
  if (sharingModel === 'ReadWrite' || sharingModel === 'ReadWriteTransfer') return 2;
  if (sharingModel === 'FullAccess') return 3;
  return null;
};

/**
 * Does a `grantedBy` object-permission edge satisfy `level`? Read needs
 * `allowRead` (or View/Modify-All); edit needs `allowEdit` (or Modify-All);
 * delete needs `allowDelete` (or Modify-All). `modifyAllRecords` (object
 * "Modify All") satisfies every level; `viewAllRecords` satisfies read only.
 */
const grantSatisfiesLevel = (edge: Edge, level: AccessLevel): boolean => {
  const p = edge.properties;
  if (p['modifyAllRecords'] === true) return true;
  if (level === 'read') {
    return p['allowRead'] === true || p['viewAllRecords'] === true;
  }
  if (level === 'edit') return p['allowEdit'] === true;
  if (level === 'create') return p['allowCreate'] === true;
  return p['allowDelete'] === true; // delete
};

/**
 * The system permission that satisfies `level`: `ModifyAllData` is full
 * god-mode (read/edit/delete); `ViewAllData` is read-only — it must NOT read
 * as edit/delete capable.
 */
const systemPermsForLevel = (level: AccessLevel): readonly string[] =>
  level === 'read' ? ['ViewAllData', 'ModifyAllData'] : ['ModifyAllData'];

/**
 * Does a sharing rule's `accessLevel` satisfy `level`? A `Read` rule grants
 * read only; an `Edit` (Read/Write) rule grants read + edit. Sharing rules
 * NEVER grant delete — delete requires FullAccess/ownership/Modify-All.
 */
const ruleAccessSatisfiesLevel = (ruleAccess: string, level: AccessLevel): boolean => {
  // Sharing rules never grant create (or delete) — create is gated by object
  // permission + record-type availability, never a record-share path. The
  // create branch in the handler skips sharing entirely; this guard is
  // belt-and-suspenders so a stray call can never read a share as create.
  if (level === 'create' || level === 'delete') return false;
  if (level === 'edit') return ruleAccess === 'Edit' || ruleAccess === 'ReadWrite';
  return ruleAccess === 'Read' || ruleAccess === 'Edit' || ruleAccess === 'ReadWrite';
};

/**
 * Synthetic group id every authenticated user is implicitly a member
 * of. The sharing-rule extractor emits this id as a dangling
 * `sharedWith` target with `properties.synthetic: true`; the
 * membership decision lives here because no Group node exists to walk
 * to. The other three synthetic groups
 * (`Group:AllCustomerPortalUsers`, `Group:PartnerUsers`,
 * `Group:GuestUser`) require explicit opt-in via `userContext.groupIds`.
 */
const ALL_INTERNAL_USERS_GROUP_ID = 'Group:AllInternalUsers';

/**
 * Defensive cap on the role hierarchy walk. Salesforce limits the role
 * hierarchy to 500 roles per org and prohibits cycles; we cap at 100
 * to keep `traversed` bounded and stop walking immediately if a
 * malformed graph contains a cycle (the visited-set is the primary
 * defense; this is the belt-and-suspenders).
 */
const ROLE_HIERARCHY_MAX_DEPTH = 100;

/**
 * Zod schema for the `sfi.why_cant_user_see_record` tool input.
 *
 *   - `componentId`: required, non-empty. The CustomObject whose
 *     visibility is being checked. Unknown ids surface as the
 *     canonical `component-not-found` error envelope (per journal 0160's
 *     silent-accept fix — they used to surface as a single OWD step
 *     inside the data envelope, which hid typos).
 *   - `userContext`: required object containing the user's access
 *     bundle. All four sub-fields are optional individually but at
 *     least one MUST be provided — a refine enforces this so callers
 *     get a Zod-level rejection for the genuinely-empty case rather
 *     than a misleading "no PermissionGrant" reasoning step.
 */
export const whyCantUserSeeRecordInputSchema = z.object({
  componentId: z.string().min(1),
  /**
   * Which record operation to evaluate. `read` (default) = can the user VIEW
   * the record; `edit` = can they UPDATE it (needs ReadWrite OWD or an Edit
   * grant / ModifyAll, never a read-only path); `delete` = can they DELETE it
   * (needs Delete object perm + FullAccess/ModifyAll/ownership — sharing rules
   * never grant delete); `create` = can they CREATE a record (needs object
   * Create permission / Modify-All AND, if the object has record types, a
   * visible record type — create does NOT flow through OWD / sharing / role
   * hierarchy). Read-only access must not read as edit-capable.
   */
  accessLevel: z.enum(['read', 'edit', 'delete', 'create']).optional(),
  userContext: z
    .object({
      profileId: z.string().min(1).optional(),
      permissionSetIds: z.array(z.string().min(1)).optional(),
      roleId: z.string().min(1).optional(),
      groupIds: z.array(z.string().min(1)).optional(),
    })
    .refine(
      (uc) =>
        uc.profileId !== undefined ||
        (uc.permissionSetIds !== undefined && uc.permissionSetIds.length > 0) ||
        uc.roleId !== undefined ||
        (uc.groupIds !== undefined && uc.groupIds.length > 0),
      {
        message:
          'userContext must supply at least one of: profileId, permissionSetIds, roleId, groupIds',
      },
    ),
});

/** Parsed input shape, inferred from `whyCantUserSeeRecordInputSchema`. */
export type WhyCantUserSeeRecordInput = z.infer<
  typeof whyCantUserSeeRecordInputSchema
>;

/**
 * One step in the access-reasoning cascade. The structure mirrors the
 * order Salesforce itself evaluates sharing and is the contract the
 * v1.1 `admin-sharing-troubleshooting` skill renders.
 *
 *   - `stage`: which step of the cascade this entry comes from.
 *   - `verdict`: `visible` if this stage grants access, `restricted`
 *     if it denies, `unknown` if the v1.1 model cannot decide.
 *   - `reason`: a plain-English explanation citing the metadata the
 *     verdict rests on. Never empty.
 *   - `traversed`: optional list of component ids the stage walked
 *     (currently used by RoleHierarchy to surface the parent chain).
 */
export interface AccessReasoningStep {
  readonly stage:
    | 'OWD'
    | 'PermissionGrant'
    | 'SystemPermission'
    | 'RecordType'
    | 'RoleHierarchy'
    | 'OwnerSharingRule'
    | 'CriteriaSharingRule'
    | 'RestrictionRule'
    | 'ScopingRule'
    | 'PermissionSetGroup'
    | 'TerritoryAndGuestRules'
    | 'ManualSharing'
    | 'SharingSets'
    | 'AccountTeams';
  readonly verdict: 'visible' | 'restricted' | 'unknown';
  readonly reason: string;
  readonly traversed?: readonly string[];
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface WhyCantUserSeeRecordOutput {
  readonly verdict: 'visible' | 'restricted' | 'unknown';
  readonly reasoning: readonly AccessReasoningStep[];
}

/** Parsed `userContext` field. Carried in a typed shape to keep helpers honest. */
type UserContext = WhyCantUserSeeRecordInput['userContext'];

/**
 * Build a reasoning step. Centralised because every helper produces a
 * step and `exactOptionalPropertyTypes` makes the `traversed?` branch
 * sharper here than at each call site.
 */
const step = (
  stage: AccessReasoningStep['stage'],
  verdict: AccessReasoningStep['verdict'],
  reason: string,
  traversed?: readonly string[],
): AccessReasoningStep =>
  traversed === undefined
    ? { stage, verdict, reason }
    : { stage, verdict, reason, traversed };

/**
 * Evaluate the OWD stage from the target component's
 * `properties.sharingModel`. Per the cascade spec:
 *   - `sharingModel === null` → `unknown` (entity variant has no OWD).
 *   - `Read`/`ReadWrite`/`FullAccess` → `visible`.
 *   - `Private`/`ControlledByParent` → `restricted`.
 *   - any other value → `unknown` (defensive; the extractor enforces
 *     the allowed set at extraction time but the metadata model could
 *     widen).
 *
 * The "missing component" branch lived here before journal 0160's
 * silent-accept fix; the caller now refuses with `component-not-found`
 * before this function runs, so the signature requires a `Node`.
 */
const evaluateOWD = (
  componentNode: Node,
  level: AccessLevel,
): AccessReasoningStep => {
  const sharingModel = componentNode.properties['sharingModel'];
  if (sharingModel === null || sharingModel === undefined) {
    return step(
      'OWD',
      'unknown',
      'OWD not defined for this entity variant',
    );
  }
  if (typeof sharingModel !== 'string') {
    return step(
      'OWD',
      'unknown',
      `OWD value is not a string: ${String(sharingModel)}`,
    );
  }
  const rank = owdRank(sharingModel);
  if (rank === null) {
    return step('OWD', 'unknown', `unrecognised OWD value: ${sharingModel}`);
  }
  if (rank >= ACCESS_RANK[level]) {
    return step(
      'OWD',
      'visible',
      `OWD '${sharingModel}' grants ${level} access to all records`,
    );
  }
  // The OWD does not grant THIS operation org-wide (e.g. a Read OWD for an edit
  // check, or anything but FullAccess for delete) — a downstream grant /
  // ownership / Modify-All may still apply, so continue the cascade.
  return step(
    'OWD',
    'restricted',
    `OWD '${sharingModel}' does not grant ${level} access org-wide; downstream grants may apply`,
  );
};

/**
 * Evaluate the PermissionGrant stage by enumerating incoming
 * `grantedBy` edges to `componentId` from the user's
 * `profileId`+`permissionSetIds`. The first grant that satisfies the requested
 * `level` (read / edit / delete — see `grantSatisfiesLevel`) flips the verdict
 * to `visible`; if none match, the verdict is `restricted` (with a reason that
 * names the granters that were inspected, so the admin can see which permission
 * containers the user actually has).
 */
const evaluatePermissionGrants = async (
  ctx: Context,
  componentId: ComponentId,
  userContext: UserContext,
  level: AccessLevel,
): Promise<Result<AccessReasoningStep, string>> => {
  const granterIds: string[] = [];
  if (userContext.profileId !== undefined) granterIds.push(userContext.profileId);
  if (userContext.permissionSetIds !== undefined) {
    granterIds.push(...userContext.permissionSetIds);
  }
  if (granterIds.length === 0) {
    return ok(
      step(
        'PermissionGrant',
        'restricted',
        'no profile or permission sets supplied',
      ),
    );
  }

  const edgesResult = await listEdges(ctx.graph, componentId, {
    direction: 'in',
    edgeType: 'grantedBy',
  });
  if (!edgesResult.ok) {
    return err(edgesResult.error.message);
  }
  const granterSet: ReadonlySet<string> = new Set(granterIds);
  const granting: string[] = [];
  for (const edge of edgesResult.value) {
    if (!granterSet.has(edge.fromId)) continue;
    if (grantSatisfiesLevel(edge, level)) {
      granting.push(edge.fromId);
    }
  }
  if (granting.length > 0) {
    return ok(
      step(
        'PermissionGrant',
        'visible',
        `${level} object permission granted by: ${granting.join(', ')}`,
      ),
    );
  }
  return ok(
    step(
      'PermissionGrant',
      'restricted',
      `no ${level} grant from supplied granters: ${granterIds.join(', ')}`,
    ),
  );
};

/**
 * The org-wide SYSTEM permissions that bypass OWD and ALL record sharing for
 * every object (god-mode). Distinct from the OBJECT-level "View All" / "Modify
 * All" the PermissionGrant stage reads from a grant edge's
 * `viewAllRecords`/`modifyAllRecords` flags — these live on a Profile /
 * PermissionSet's `properties.userPermissions` (the extractor surfaces enabled
 * `<userPermissions>` names there). `ModifyAllData` implies `ViewAllData`.
 */
/**
 * Evaluate the SystemPermission stage. A Profile or PermissionSet whose
 * `userPermissions` grants `ViewAllData` (or `ModifyAllData`) reads every record
 * of every object regardless of OWD or sharing — so a `restricted` OWD does NOT
 * stop them. Without this stage the cascade reported a god-mode user as
 * `restricted`, which is wrong.
 *
 * Honesty caveat (restriction rules): a RestrictionRule can still filter
 * specific users even with View All Data, and whether THIS user is in scope
 * needs the rule's user-criteria + record data (undecidable from metadata). So
 * when the object carries an active restriction rule, god-mode reports `unknown`
 * with the caveat rather than a possibly-wrong `visible`.
 */
const evaluateSystemPermissions = async (
  ctx: Context,
  componentId: ComponentId,
  userContext: UserContext,
  level: AccessLevel,
): Promise<Result<AccessReasoningStep, string>> => {
  const granterIds: string[] = [];
  if (userContext.profileId !== undefined) granterIds.push(userContext.profileId);
  if (userContext.permissionSetIds !== undefined) {
    granterIds.push(...userContext.permissionSetIds);
  }
  if (granterIds.length === 0) {
    return ok(step('SystemPermission', 'restricted', 'no profile or permission sets supplied'));
  }
  // For edit/delete only ModifyAllData bypasses; ViewAllData is read-only.
  const relevantPerms = systemPermsForLevel(level);
  const holders: string[] = [];
  for (const id of granterIds) {
    const nodeResult = await getNodeById(ctx.graph, id as ComponentId);
    if (!nodeResult.ok) return err(nodeResult.error.message);
    const node = nodeResult.value;
    if (node === null) continue;
    const perms = node.properties['userPermissions'];
    if (!Array.isArray(perms)) continue;
    const found = relevantPerms.filter((p) => perms.includes(p));
    if (found.length > 0) holders.push(`${id} (${found.join(', ')})`);
  }
  if (holders.length === 0) {
    const need = level === 'read' ? 'View All Data / Modify All Data' : 'Modify All Data';
    return ok(
      step(
        'SystemPermission',
        'restricted',
        `no ${need} system permission on: ${granterIds.join(', ')}`,
      ),
    );
  }
  // God-mode present — but an active restriction rule can still filter this user.
  const restrictionResult = await listObjectChildRules(ctx, componentId, 'RestrictionRule');
  if (!restrictionResult.ok) return err(restrictionResult.error);
  if (restrictionResult.value.length > 0) {
    return ok(
      step(
        'SystemPermission',
        'unknown',
        `${holders.join('; ')} bypasses OWD and sharing, but an active restriction rule on this object can still filter specific users — verify the rule's user scope`,
      ),
    );
  }
  return ok(
    step(
      'SystemPermission',
      'visible',
      `system permission grants access to all records regardless of OWD/sharing: ${holders.join('; ')}`,
    ),
  );
};

/**
 * Walk `inheritsFrom` edges upward from `roleId` collecting the
 * parent chain. Stops at the top of the hierarchy (a role with no
 * outgoing `inheritsFrom`), at a missing node, or at
 * `ROLE_HIERARCHY_MAX_DEPTH` rungs — whichever comes first. The
 * visited-set defends against malformed graphs with cycles.
 */
const walkRoleHierarchy = async (
  ctx: Context,
  roleId: ComponentId,
): Promise<Result<readonly string[], string>> => {
  const chain: string[] = [];
  const visited = new Set<string>([roleId]);
  let cursor = roleId;
  for (let depth = 0; depth < ROLE_HIERARCHY_MAX_DEPTH; depth++) {
    const edgesResult = await listEdges(ctx.graph, cursor, {
      direction: 'out',
      edgeType: 'inheritsFrom',
    });
    if (!edgesResult.ok) {
      return err(edgesResult.error.message);
    }
    if (edgesResult.value.length === 0) break;
    // Role.md models exactly one `parentRole` per role, so the
    // extractor emits at most one `inheritsFrom` per role. Take the
    // first; anything beyond it is a graph anomaly.
    const parentId = edgesResult.value[0]!.toId;
    if (visited.has(parentId)) break;
    visited.add(parentId);
    chain.push(parentId);
    cursor = parentId;
  }
  return ok(chain);
};

/**
 * Evaluate the RoleHierarchy stage. The v1.1 graph models who is
 * above the user in the role tree (`inheritsFrom`) but cannot tell
 * which role *owns* records of a given object — that requires
 * record-level data. So the verdict is always `unknown`: we surface
 * the parent chain so the admin knows where to look.
 *
 * Returns a single step with the role parent chain in `traversed`.
 * Empty chain (top-of-hierarchy role) still produces an `unknown`
 * step but with no `traversed` (the field is omitted via the `step`
 * helper to keep the output minimal).
 */
const evaluateRoleHierarchy = async (
  ctx: Context,
  roleId: ComponentId,
): Promise<Result<AccessReasoningStep, string>> => {
  const chainResult = await walkRoleHierarchy(ctx, roleId);
  if (!chainResult.ok) {
    return err(chainResult.error);
  }
  const chain = chainResult.value;
  const traversed = chain.length === 0 ? undefined : chain;
  const reason =
    chain.length === 0
      ? `role ${roleId} is at the top of the hierarchy; ownership of records of this type cannot be inferred from metadata alone`
      : `role hierarchy walked ${chain.length} level(s) up from ${roleId}; ownership of records of this type cannot be inferred from metadata alone`;
  return ok(step('RoleHierarchy', 'unknown', reason, traversed));
};

/**
 * The set of `sharedWith` target ids the user is treated as belonging
 * to. Includes every id the caller supplied plus
 * `Group:AllInternalUsers` (every authenticated user is "internal"
 * for sharing purposes). The other three synthetic groups in the
 * variant table are not auto-included — callers wanting them must
 * pass them in `groupIds` explicitly.
 */
const buildUserMembership = (userContext: UserContext): ReadonlySet<string> => {
  const ids = new Set<string>([ALL_INTERNAL_USERS_GROUP_ID]);
  if (userContext.roleId !== undefined) ids.add(userContext.roleId);
  if (userContext.groupIds !== undefined) {
    for (const g of userContext.groupIds) ids.add(g);
  }
  return ids;
};

/**
 * Fetch every `SharingRule` parented to `componentId` via outgoing
 * `parentOf` edges, then resolve each rule's node so the caller can
 * inspect `properties.ruleType`. Missing rule nodes are dropped
 * silently — matches the sparse-graph tolerance the other tools use.
 *
 * Edge orientation: the sharing-rules extractor emits `parentOf` as
 * `from: CustomObject -> to: SharingRule` (matches the CustomObject
 * → CustomField convention every other parent-child edge in the
 * graph uses). So the rules attached to an object are reachable via
 * the object's OUTGOING `parentOf` edges.
 */
const fetchSharingRules = async (
  ctx: Context,
  componentId: ComponentId,
): Promise<Result<readonly Node[], string>> => {
  const edgesResult = await listEdges(ctx.graph, componentId, {
    direction: 'out',
    edgeType: 'parentOf',
  });
  if (!edgesResult.ok) {
    return err(edgesResult.error.message);
  }
  const rules: Node[] = [];
  for (const edge of edgesResult.value) {
    const nodeResult = await getNodeById(ctx.graph, edge.toId);
    if (!nodeResult.ok) return err(nodeResult.error.message);
    if (nodeResult.value === null) continue;
    if (nodeResult.value.type !== 'SharingRule') continue;
    rules.push(nodeResult.value);
  }
  // Deterministic order by id so the reasoning output is stable
  // across runs, mirroring the (id ASC) convention every other tool
  // uses.
  return ok([...rules].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
};

/**
 * Determine whether an owner-type `SharingRule` grants access to the
 * user. Walks the rule's outgoing `sharedWith` edges and checks the
 * `toId` against `membership`. The first match short-circuits. The
 * `direction === 'from'` edge on owner rules describes *whose records
 * the rule applies to* (the source of the shared records), not who
 * receives access — we only check the `sharedTo` edge
 * (`direction === 'to'` or undefined for criteria rules).
 *
 * Returns the matched target id directly so the caller can build a
 * reasoning step without a non-null assertion; `null` means no match.
 */
const ownerRuleMatches = async (
  ctx: Context,
  ruleNode: Node,
  membership: ReadonlySet<string>,
): Promise<Result<string | null, string>> => {
  const edgesResult = await listEdges(ctx.graph, ruleNode.id, {
    direction: 'out',
    edgeType: 'sharedWith',
  });
  if (!edgesResult.ok) {
    return err(edgesResult.error.message);
  }
  for (const edge of edgesResult.value) {
    if (edge.properties['direction'] === 'from') continue;
    if (membership.has(edge.toId)) {
      return ok(edge.toId);
    }
  }
  return ok(null);
};

/**
 * Evaluate the OwnerSharingRule stage. Emits one step per
 * owner-typed rule attached to the target object. `visible` when the
 * rule's `sharedTo` target is in the user's membership set;
 * `restricted` otherwise. If no owner rules exist, returns a single
 * step explaining that.
 */
const evaluateOwnerSharingRules = async (
  ctx: Context,
  rules: readonly Node[],
  userContext: UserContext,
  level: AccessLevel,
): Promise<Result<readonly AccessReasoningStep[], string>> => {
  const ownerRules = rules.filter((r) => r.properties['ruleType'] === 'owner');
  if (ownerRules.length === 0) {
    return ok([
      step(
        'OwnerSharingRule',
        'restricted',
        'no owner-based sharing rules attached to this object',
      ),
    ]);
  }
  const membership = buildUserMembership(userContext);
  const steps: AccessReasoningStep[] = [];
  for (const rule of ownerRules) {
    const matchResult = await ownerRuleMatches(ctx, rule, membership);
    if (!matchResult.ok) return err(matchResult.error);
    const sharedTo = matchResult.value;
    const ruleAccess =
      typeof rule.properties['accessLevel'] === 'string'
        ? (rule.properties['accessLevel'] as string)
        : 'Read';
    // A rule grants the operation only if the user is in the shared target AND
    // the rule's access level reaches it (a Read rule never grants edit; no
    // sharing rule grants delete).
    if (sharedTo !== null && ruleAccessSatisfiesLevel(ruleAccess, level)) {
      steps.push(
        step(
          'OwnerSharingRule',
          'visible',
          `owner sharing rule ${rule.id} grants ${level} access via shared target ${sharedTo} (rule access: ${ruleAccess})`,
        ),
      );
    } else if (sharedTo !== null) {
      // Membership matches but the rule's access level is too low for this op.
      steps.push(
        step(
          'OwnerSharingRule',
          'restricted',
          `owner sharing rule ${rule.id} shares to the user but grants only ${ruleAccess}, not ${level}`,
        ),
      );
    } else {
      steps.push(
        step(
          'OwnerSharingRule',
          'restricted',
          `owner sharing rule ${rule.id} does not match the user's role or groups`,
        ),
      );
    }
  }
  return ok(steps);
};

/**
 * Evaluate the CriteriaSharingRule stage. Emits one step per
 * criteria-typed rule attached to the target object. Always
 * `unknown` because criteria are over record-level field values and
 * v1.1 has no record-level data. The reason cites the rule's
 * `booleanFilter` (or `criteriaItemCount` if no boolean filter is
 * set) so the admin can see what predicate would have to hold.
 */
const evaluateCriteriaSharingRules = (
  rules: readonly Node[],
  level: AccessLevel,
): readonly AccessReasoningStep[] => {
  const criteriaRules = rules.filter(
    (r) => r.properties['ruleType'] === 'criteria',
  );
  if (criteriaRules.length === 0) {
    return [
      step(
        'CriteriaSharingRule',
        'restricted',
        'no criteria-based sharing rules attached to this object',
      ),
    ];
  }
  const steps: AccessReasoningStep[] = [];
  for (const rule of criteriaRules) {
    const booleanFilter = rule.properties['booleanFilter'];
    const criteriaItemCount = rule.properties['criteriaItemCount'];
    const predicate =
      typeof booleanFilter === 'string' && booleanFilter.length > 0
        ? booleanFilter
        : typeof criteriaItemCount === 'number' && criteriaItemCount > 0
          ? `${criteriaItemCount} criteria item(s)`
          : 'unspecified criteria';
    const ruleAccess =
      typeof rule.properties['accessLevel'] === 'string'
        ? (rule.properties['accessLevel'] as string)
        : 'Read';
    // If the rule's access level can't reach this operation (a Read rule for an
    // edit check, or any criteria rule for delete), it's a definitive
    // `restricted` — no record-level evaluation needed. Otherwise the predicate
    // is undecidable from metadata, so `unknown`.
    if (!ruleAccessSatisfiesLevel(ruleAccess, level)) {
      steps.push(
        step(
          'CriteriaSharingRule',
          'restricted',
          `rule ${rule.id} grants only ${ruleAccess}, which cannot grant ${level}`,
        ),
      );
      continue;
    }
    steps.push(
      step(
        'CriteriaSharingRule',
        'unknown',
        `rule ${rule.id} grants ${level} (rule access: ${ruleAccess}) if record matches: ${predicate}`,
      ),
    );
  }
  return steps;
};

/**
 * List child rules of a given type parented by `componentId`. Restriction
 * and scoping rules attach via `parentId` on the node (enterprise extractor).
 */
const listObjectChildRules = async (
  ctx: Context,
  componentId: ComponentId,
  ruleType: 'RestrictionRule' | 'ScopingRule',
): Promise<Result<readonly Node[], string>> => {
  const nodesResult = await listNodesByType(ctx.graph, ruleType, { limit: 500 });
  if (!nodesResult.ok) return err(nodesResult.error.message);
  return ok(nodesResult.value.filter((node) => node.parentId === componentId));
};

/**
 * Evaluate RestrictionRule nodes on the target object. Each active rule
 * can hide records the sharing cascade would otherwise grant; criteria
 * require record-level data, so the stage is `unknown` when rules exist.
 */
const evaluateRestrictionRules = async (
  ctx: Context,
  componentId: ComponentId,
): Promise<Result<readonly AccessReasoningStep[], string>> => {
  const rulesResult = await listObjectChildRules(ctx, componentId, 'RestrictionRule');
  if (!rulesResult.ok) return rulesResult;
  if (rulesResult.value.length === 0) {
    return ok([
      step(
        'RestrictionRule',
        'restricted',
        'no restriction rules attached to this object',
      ),
    ]);
  }
  return ok(
    rulesResult.value.map((rule) =>
      step(
        'RestrictionRule',
        'unknown',
        `restriction rule ${rule.id} may hide records from this user; record-level criteria evaluation required`,
      ),
    ),
  );
};

/**
 * Evaluate ScopingRule nodes on the target object. Scoping rules limit
 * which records a user sees; without record data the stage is `unknown`.
 */
const evaluateScopingRules = async (
  ctx: Context,
  componentId: ComponentId,
): Promise<Result<readonly AccessReasoningStep[], string>> => {
  const rulesResult = await listObjectChildRules(ctx, componentId, 'ScopingRule');
  if (!rulesResult.ok) return rulesResult;
  if (rulesResult.value.length === 0) {
    return ok([
      step(
        'ScopingRule',
        'restricted',
        'no scoping rules attached to this object',
      ),
    ]);
  }
  return ok(
    rulesResult.value.map((rule) =>
      step(
        'ScopingRule',
        'unknown',
        `scoping rule ${rule.id} may limit visible records; record-level evaluation required`,
      ),
    ),
  );
};

/**
 * Surface Permission Set Group boundary when the vault models PSGs.
 * Membership and muting are not extracted yet, so any PSG in the vault
 * forces `unknown` when the user carries permission-set context.
 */
const evaluatePermissionSetGroups = async (
  ctx: Context,
  userContext: UserContext,
): Promise<Result<AccessReasoningStep, string>> => {
  const psgResult = await listNodesByType(ctx.graph, 'PermissionSetGroup', {
    limit: 500,
  });
  if (!psgResult.ok) return err(psgResult.error.message);
  if (psgResult.value.length === 0) {
    return ok(
      step(
        'PermissionSetGroup',
        'restricted',
        'no permission set groups in vault',
      ),
    );
  }
  const hasPsContext =
    (userContext.permissionSetIds !== undefined &&
      userContext.permissionSetIds.length > 0) ||
    userContext.profileId !== undefined;
  if (!hasPsContext) {
    return ok(
      step(
        'PermissionSetGroup',
        'unknown',
        `${psgResult.value.length} permission set group(s) exist in vault; supply permissionSetIds to evaluate group-derived access`,
      ),
    );
  }
  return ok(
    step(
      'PermissionSetGroup',
      'unknown',
      `${psgResult.value.length} permission set group(s) in vault; group membership and muting are not modeled — verify assigned PSGs manually`,
    ),
  );
};

/**
 * The trailing trio: stages whose verdict the v1.1 model cannot
 * decide under any circumstance. The reasons cite the data v1.x
 * would need to model (record-level shares, sharing-set config,
 * account-team membership). Frozen because the steps never vary
 * across invocations — every call appends the same three entries.
 */
const UNKNOWN_TAIL: readonly AccessReasoningStep[] = Object.freeze([
  step(
    'TerritoryAndGuestRules',
    'unknown',
    'territory sharing rules and guest (Experience Cloud) sharing rules are skipped by the extractor — not evaluated here (absence is not "no access")',
  ),
  step(
    'ManualSharing',
    'unknown',
    'manual sharing requires record-level data; check {RecordId}__Share in the org',
  ),
  step(
    'SharingSets',
    'unknown',
    'sharing sets require Experience Cloud configuration not modeled in v1.1',
  ),
  step(
    'AccountTeams',
    'unknown',
    'account team membership requires record-level data not modeled in v1.1',
  ),
]);

/**
 * Aggregate the cascade into a single verdict. The first `visible`
 * step in cascade order wins; a `restricted` OWD without a `visible`
 * downstream falls through to `restricted`; any `unknown` in the
 * deciding chain (no `visible` step before it) demotes the answer to
 * `unknown` per the honesty axis.
 *
 * Object-level CRUD hard gate (the read/edit/delete cascade): object
 * Read/Edit/Delete permission is a PRE-CONDITION for record access.
 * Record-level sharing — OWD, role hierarchy, sharing rules, territory,
 * manual shares, sharing sets, account teams — can only grant record
 * VISIBILITY on top of an existing object permission; it can NEVER grant
 * the object permission itself. So when the modeled object-permission
 * stages (`PermissionGrant` + `SystemPermission`) BOTH definitively deny,
 * the downstream record-level `unknown` stages cannot change the outcome:
 * the answer is `restricted`, not `unknown`. (Permission-set groups and
 * any permission sets not supplied in `userContext` remain a manual-verify
 * caveat in the reasoning chain — they are the only un-modeled path to the
 * object permission.)
 */
const aggregateVerdict = (
  steps: readonly AccessReasoningStep[],
  profileAnchored: boolean,
): 'visible' | 'restricted' | 'unknown' => {
  // First, any visible step grants access (PermissionGrant overrides
  // OWD, OwnerSharingRule overrides RoleHierarchy, etc.).
  for (const s of steps) {
    if (s.verdict === 'visible') return 'visible';
  }
  // Object-CRUD hard gate: object permission is denied by every modeled
  // object-level stage, so no record-level sharing can grant access. Only
  // valid when a PROFILE was supplied — a user has exactly one profile whose
  // object permissions are fixed, so its `restricted` is a definitive denial.
  // A role/group/permission-set-only context makes PermissionGrant /
  // SystemPermission report `restricted` merely because no profile was given
  // (an unknown, not a denial), so the gate must not fire there.
  const stageVerdict = (stage: AccessReasoningStep['stage']) =>
    steps.find((s) => s.stage === stage)?.verdict;
  if (
    profileAnchored &&
    stageVerdict('PermissionGrant') === 'restricted' &&
    stageVerdict('SystemPermission') === 'restricted'
  ) {
    return 'restricted';
  }
  // No visible step and object access not definitively denied. If any
  // step is unknown, the answer is unknown — the honesty axis: prefer
  // "I don't know" over a wrong `restricted`.
  for (const s of steps) {
    if (s.verdict === 'unknown') return 'unknown';
  }
  // Every step is restricted; the cascade exhausted every path.
  return 'restricted';
};

/** Canonical-id prefixes for the four userContext id families. */
const PROFILE_PREFIX = 'Profile:';
const PERMISSION_SET_PREFIX = 'PermissionSet:';
const ROLE_PREFIX = 'Role:';
const GROUP_PREFIX = 'Group:';
const QUEUE_PREFIX = 'Queue:';

/**
 * Coerce a bare group apiName to a canonical id. A bare group name is
 * AMBIGUOUS — a Queue is a kind of group — so this is graph-aware: it picks
 * whichever of `Group:{name}` / `Queue:{name}` actually exists, defaulting to
 * `Group:` when neither does. A coerced id that doesn't exist simply never
 * matches a `sharedWith` membership (exactly as the bare name didn't before),
 * so the verdict can only become MORE correct, never wrong. An id that
 * already carries a `Group:`/`Queue:` prefix — or any other `Type:` prefix —
 * passes through unchanged.
 */
const coerceGroupId = async (ctx: Context, raw: string): Promise<string> => {
  if (raw.startsWith(GROUP_PREFIX) || raw.startsWith(QUEUE_PREFIX)) return raw;
  if (raw.includes(':')) return raw;
  const asGroup = `${GROUP_PREFIX}${raw}`;
  const g = await getNodeById(ctx.graph, asGroup as ComponentId);
  if (g.ok && g.value !== null) return asGroup;
  const asQueue = `${QUEUE_PREFIX}${raw}`;
  const q = await getNodeById(ctx.graph, asQueue as ComponentId);
  if (q.ok && q.value !== null) return asQueue;
  return asGroup;
};

/**
 * Coerce bare apiNames in a `userContext` to canonical ids so a caller can
 * pass `profileId: 'Admin'` rather than `'Profile:Admin'` — the same
 * forgiveness `objectApiName` tools already give. Profile / permission-set /
 * role each have a single unambiguous prefix (pure `coercePrefix`); groups are
 * graph-disambiguated (`coerceGroupId`). An id already carrying a different
 * `Type:` prefix passes through unchanged so a wrong-type input behaves exactly
 * as before.
 *
 * **Verdict-preserving by construction.** Each field is matched downstream by
 * exact id against grant / membership edges. Coercion only ever turns a bare
 * name into the canonical container that name denotes; it never re-points a
 * field at a different real container. So the cascade verdict for a coerced
 * context equals the verdict for the equivalent prefixed-id context — the
 * property the unit tests pin.
 */
const coerceUserContext = async (
  ctx: Context,
  uc: UserContext,
): Promise<UserContext> => {
  const out: {
    profileId?: string;
    permissionSetIds?: string[];
    roleId?: string;
    groupIds?: string[];
  } = {};
  if (uc.profileId !== undefined) {
    out.profileId = coercePrefix(uc.profileId, [PROFILE_PREFIX]);
  }
  if (uc.permissionSetIds !== undefined) {
    out.permissionSetIds = uc.permissionSetIds.map((p) =>
      coercePrefix(p, [PERMISSION_SET_PREFIX]),
    );
  }
  if (uc.roleId !== undefined) {
    out.roleId = coercePrefix(uc.roleId, [ROLE_PREFIX]);
  }
  if (uc.groupIds !== undefined) {
    out.groupIds = await Promise.all(
      uc.groupIds.map((g) => coerceGroupId(ctx, g)),
    );
  }
  return out;
};

/**
 * Evaluate the `ModifyAllData` god-mode for CREATE. Unlike read/edit/delete,
 * the create path applies NO restriction-rule caveat — a RestrictionRule
 * filters which records a user can SEE, it never blocks creating one. So
 * `ModifyAllData` on any granter is a clean `visible`. `ViewAllData` does NOT
 * grant create (read-only), so it is excluded.
 */
const evaluateModifyAllDataForCreate = async (
  ctx: Context,
  userContext: UserContext,
): Promise<Result<AccessReasoningStep, string>> => {
  const granterIds: string[] = [];
  if (userContext.profileId !== undefined) granterIds.push(userContext.profileId);
  if (userContext.permissionSetIds !== undefined) {
    granterIds.push(...userContext.permissionSetIds);
  }
  if (granterIds.length === 0) {
    return ok(step('SystemPermission', 'restricted', 'no profile or permission sets supplied'));
  }
  const holders: string[] = [];
  for (const id of granterIds) {
    const nodeResult = await getNodeById(ctx.graph, id as ComponentId);
    if (!nodeResult.ok) return err(nodeResult.error.message);
    const node = nodeResult.value;
    if (node === null) continue;
    const perms = node.properties['userPermissions'];
    if (Array.isArray(perms) && perms.includes('ModifyAllData')) holders.push(id);
  }
  if (holders.length === 0) {
    return ok(
      step(
        'SystemPermission',
        'restricted',
        `no Modify All Data system permission on: ${granterIds.join(', ')}`,
      ),
    );
  }
  return ok(
    step(
      'SystemPermission',
      'visible',
      `Modify All Data grants create on every object: ${holders.join(', ')}`,
    ),
  );
};

/**
 * The object-api-name portion of a `CustomObject:{name}` canonical id.
 * `recordTypeVisibilities` entries name `{Object}.{RecordType}`, so this is the
 * key we match record-type entries against.
 */
const objectApiNameOf = (objectNode: Node, componentId: ComponentId): string =>
  typeof objectNode.apiName === 'string' && objectNode.apiName.length > 0
    ? objectNode.apiName
    : componentId.replace(/^CustomObject:/, '');

/**
 * Evaluate the RecordType availability stage for CREATE. If the object has
 * record types, Salesforce requires the user's profile/permission-set to mark
 * at least one as VISIBLE before they can create a record (the create UI forces
 * a record-type choice). Reuses the same `recordTypeVisibilities` read as
 * `sfi.recordtype_availability`.
 *
 *   - object has NO record types        → `visible` (create is not RT-gated).
 *   - ≥1 visible record type for user    → `visible`.
 *   - record types exist, all hidden     → `restricted` (must pick one, can't).
 *   - record types exist, no visibility
 *     data on the supplied granters      → `unknown` (honest — can't decide).
 */
const evaluateRecordTypeForCreate = async (
  ctx: Context,
  componentId: ComponentId,
  objectNode: Node,
  userContext: UserContext,
): Promise<Result<AccessReasoningStep, string>> => {
  // The object's record types: outgoing `parentOf` edges to RecordType nodes.
  const edgesResult = await listEdges(ctx.graph, componentId, {
    direction: 'out',
    edgeType: 'parentOf',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  const objectRecordTypes = edgesResult.value
    .map((e) => e.toId)
    .filter((id) => id.startsWith('RecordType:'));
  if (objectRecordTypes.length === 0) {
    return ok(
      step(
        'RecordType',
        'visible',
        'object has no record types; create is not record-type-gated',
      ),
    );
  }

  const objectApiName = objectApiNameOf(objectNode, componentId);
  const granterIds: string[] = [];
  if (userContext.profileId !== undefined) granterIds.push(userContext.profileId);
  if (userContext.permissionSetIds !== undefined) {
    granterIds.push(...userContext.permissionSetIds);
  }
  const visibleNames: string[] = [];
  let entriesForObject = 0;
  for (const id of granterIds) {
    const nodeResult = await getNodeById(ctx.graph, id as ComponentId);
    if (!nodeResult.ok) return err(nodeResult.error.message);
    const node = nodeResult.value;
    if (node === null) continue;
    const raw = node.properties['recordTypeVisibilities'];
    if (!Array.isArray(raw)) continue;
    for (const item of raw) {
      if (item === null || typeof item !== 'object') continue;
      const e = item as Record<string, unknown>;
      const rt = e['recordType'];
      if (typeof rt !== 'string') continue;
      const dot = rt.indexOf('.');
      if (dot < 0 || rt.slice(0, dot) !== objectApiName) continue;
      entriesForObject += 1;
      // `<visible>` omitted (null) in older metadata means available.
      if (e['visible'] !== false) visibleNames.push(rt);
    }
  }

  if (visibleNames.length > 0) {
    const shown = [...new Set(visibleNames)].slice(0, 10);
    return ok(
      step(
        'RecordType',
        'visible',
        `creatable record type(s) for this user: ${shown.join(', ')}`,
      ),
    );
  }
  if (entriesForObject > 0) {
    return ok(
      step(
        'RecordType',
        'restricted',
        `object has ${objectRecordTypes.length} record type(s) but none are visible to the supplied granters — a record type must be selectable to create a record`,
      ),
    );
  }
  return ok(
    step(
      'RecordType',
      'unknown',
      `object has ${objectRecordTypes.length} record type(s); no recordTypeVisibilities found on the supplied granters — verify record-type assignment for this profile/permission set`,
    ),
  );
};

/**
 * Evaluate CREATE access. Create does NOT flow through OWD / sharing rules /
 * role hierarchy / restriction / scoping (you don't need to see existing
 * records to create one), so those stages are short-circuited with a note. It
 * is `visible` when the user has object Create permission (`allowCreate`, or
 * object/system Modify-All) AND — if the object has record types — at least one
 * visible record type. The record-type gate is ANDed onto the permission gate,
 * so a Create grant with no visible record type is `restricted`, not `visible`.
 */
const evaluateCreateAccess = async (
  ctx: Context,
  componentId: ComponentId,
  objectNode: Node,
  userContext: UserContext,
): Promise<
  Result<
    { verdict: 'visible' | 'restricted' | 'unknown'; reasoning: AccessReasoningStep[] },
    string
  >
> => {
  const reasoning: AccessReasoningStep[] = [];

  // 1. Object Create permission (`allowCreate`) or object Modify All.
  const grantResult = await evaluatePermissionGrants(
    ctx,
    componentId,
    userContext,
    'create',
  );
  if (!grantResult.ok) return err(grantResult.error);
  const g = grantResult.value;
  reasoning.push(
    step(
      'PermissionGrant',
      g.verdict,
      `${g.reason} — create is gated by object Create permission, NOT by OWD / sharing rules / role hierarchy (you don't need access to existing records to create one)`,
    ),
  );

  // 2. Modify All Data god-mode (no restriction-rule caveat for create).
  const madResult = await evaluateModifyAllDataForCreate(ctx, userContext);
  if (!madResult.ok) return err(madResult.error);
  reasoning.push(madResult.value);

  // 3. Record-type availability (ANDed onto the permission gate).
  const rtResult = await evaluateRecordTypeForCreate(
    ctx,
    componentId,
    objectNode,
    userContext,
  );
  if (!rtResult.ok) return err(rtResult.error);
  const rt = rtResult.value;
  reasoning.push(rt);

  const permVisible = g.verdict === 'visible' || madResult.value.verdict === 'visible';
  let verdict: 'visible' | 'restricted' | 'unknown';
  if (!permVisible) {
    verdict = 'restricted';
  } else if (rt.verdict === 'visible') {
    verdict = 'visible';
  } else if (rt.verdict === 'unknown') {
    verdict = 'unknown';
  } else {
    verdict = 'restricted';
  }
  return ok({ verdict, reasoning });
};

/**
 * The `sfi.why_cant_user_see_record` MCP tool. Walks the Salesforce
 * sharing cascade (OWD → PermissionGrant → RoleHierarchy →
 * OwnerSharingRule → CriteriaSharingRule → TerritoryAndGuestRules →
 * ManualSharing → SharingSets → AccountTeams) for a given object + user-context
 * bundle and returns a structured reasoning chain plus an aggregate
 * verdict. See the module JSDoc for the cascade rules and the
 * honesty-axis design.
 *
 * @example
 *   const r = await whyCantUserSeeRecordHandler(ctx, {
 *     componentId: 'CustomObject:Account',
 *     userContext: { profileId: 'Profile:System Administrator' },
 *   });
 *   if (r.ok) console.log(r.value.data.verdict);
 */
export const whyCantUserSeeRecordHandler = async (
  ctx: Context,
  input: WhyCantUserSeeRecordInput,
): Promise<Result<McpResponse<WhyCantUserSeeRecordOutput>, McpError>> => {
  const { componentId } = input;

  // Resolve the target node up front. A nonexistent `componentId`
  // previously surfaced as a single OWD step with `verdict: 'unknown'`
  // and `reason: 'component not found'` in the data envelope — silent
  // accept that hid typos behind a real-looking cascade. Per journal
  // 0160's deep smoke, return the canonical `component-not-found`
  // error envelope instead so callers can distinguish "wrong id" from
  // "valid id with no OWD".
  const nodeResult = await getNodeById(ctx.graph, componentId);
  if (!nodeResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodeResult.error.message}`,
    });
  }
  if (nodeResult.value === null) {
    return err({
      kind: 'component-not-found',
      message: `no component matches \`${componentId}\` in this vault`,
      path: componentId,
    });
  }

  // The operation being evaluated (read / edit / delete / create). Every stage
  // is parameterised by it: read-only OWD/grants/View-All never read as edit,
  // and sharing rules never grant delete.
  const level: AccessLevel = input.accessLevel ?? 'read';

  // CREATE is a different model: it does NOT flow through OWD / sharing / role
  // hierarchy (you don't need to see existing records to create one). It needs
  // object Create permission (or Modify-All) AND, if the object has record
  // types, a visible record type. Short-circuit the whole sharing cascade.
  if (level === 'create') {
    const userContext = await coerceUserContext(ctx, input.userContext);
    const createResult = await evaluateCreateAccess(
      ctx,
      componentId,
      nodeResult.value,
      userContext,
    );
    if (!createResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${createResult.error}`,
      });
    }
    return ok({
      data: {
        verdict: createResult.value.verdict,
        reasoning: createResult.value.reasoning,
      },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  }

  // Stage 1: OWD. Short-circuit on visible (no further restriction
  // possible) and on unknown (the entity variant has no OWD; we
  // can't reason past this).
  const owdStep = evaluateOWD(nodeResult.value, level);
  if (owdStep.verdict !== 'restricted') {
    return ok({
      data: { verdict: owdStep.verdict, reasoning: [owdStep] },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  }

  // Coerce bare apiNames in the userContext to canonical ids so a caller can
  // pass `profileId: 'Admin'` (not just 'Profile:Admin'). Built only after the
  // OWD short-circuit so a visible/unknown OWD skips the group graph lookups.
  // Verdict-preserving (see coerceUserContext): the coerced verdict equals the
  // equivalent prefixed-id verdict.
  const userContext = await coerceUserContext(ctx, input.userContext);

  const reasoning: AccessReasoningStep[] = [owdStep];

  // Stage 2: PermissionGrant. A profile/permission-set with read-or-
  // better on this object overrides the OWD restriction (Modify-All-
  // Data style). On override, every downstream sharing-rule stage is
  // moot — the user already has access — but we still walk them so
  // the reasoning chain is complete and the caller can show the full
  // picture. The aggregate verdict already accounts for the override.
  const grantStepResult = await evaluatePermissionGrants(
    ctx,
    componentId,
    userContext,
    level,
  );
  if (!grantStepResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${grantStepResult.error}`,
    });
  }
  reasoning.push(grantStepResult.value);

  // Stage 2a: SystemPermission. View All Data / Modify All Data on the profile
  // or a permission set bypasses OWD and ALL record sharing (god-mode) — so a
  // restricted OWD does not stop them. Reads `properties.userPermissions`.
  const systemPermResult = await evaluateSystemPermissions(ctx, componentId, userContext, level);
  if (!systemPermResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${systemPermResult.error}`,
    });
  }
  reasoning.push(systemPermResult.value);

  const psgStepResult = await evaluatePermissionSetGroups(ctx, userContext);
  if (!psgStepResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${psgStepResult.error}`,
    });
  }
  reasoning.push(psgStepResult.value);

  // Stage 3: RoleHierarchy. Skip when the user has no roleId — the
  // architect can't be in the role hierarchy if they don't have a
  // role. Always `unknown` when present (see helper JSDoc).
  if (userContext.roleId !== undefined) {
    const roleStepResult = await evaluateRoleHierarchy(
      ctx,
      userContext.roleId,
    );
    if (!roleStepResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${roleStepResult.error}`,
      });
    }
    reasoning.push(roleStepResult.value);
  }

  // Stages 4 + 5: SharingRules. Fetch all rules once, then split by
  // ruleType. Owner rules are evaluated for membership match; criteria
  // rules always report `unknown` with the booleanFilter in the reason.
  const rulesResult = await fetchSharingRules(ctx, componentId);
  if (!rulesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${rulesResult.error}`,
    });
  }
  const ownerStepsResult = await evaluateOwnerSharingRules(
    ctx,
    rulesResult.value,
    userContext,
    level,
  );
  if (!ownerStepsResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${ownerStepsResult.error}`,
    });
  }
  reasoning.push(...ownerStepsResult.value);
  reasoning.push(...evaluateCriteriaSharingRules(rulesResult.value, level));

  const restrictionStepsResult = await evaluateRestrictionRules(ctx, componentId);
  if (!restrictionStepsResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${restrictionStepsResult.error}`,
    });
  }
  reasoning.push(...restrictionStepsResult.value);

  const scopingStepsResult = await evaluateScopingRules(ctx, componentId);
  if (!scopingStepsResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${scopingStepsResult.error}`,
    });
  }
  reasoning.push(...scopingStepsResult.value);

  // Stages 6-9: TerritoryAndGuestRules, ManualSharing, SharingSets,
  // AccountTeams. Always `unknown` with explanatory reasons. These document
  // what v1.1 could not check so the admin knows where to look manually.
  reasoning.push(...UNKNOWN_TAIL);

  return ok({
    data: {
      verdict: aggregateVerdict(reasoning, userContext.profileId !== undefined),
      reasoning,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
