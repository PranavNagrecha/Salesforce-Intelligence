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
 * **The two-plane access model.** Seeing a record requires BOTH planes:
 *   (A) object-level READ CRUD (from the profile UNION any assigned permission
 *       set, or system View/Modify All Data), AND
 *   (B) record-level access (OWD-public, ownership, a sharing grant, or a
 *       View/Modify-All bypass).
 * Missing object Read => NOT visible, full stop, regardless of OWD. Plain
 * object Edit/Delete is NOT a record-visibility grant — it satisfies plane A
 * (Edit/Delete imply Read) but on a Private object never grants plane B. FLS
 * (field-level security) is irrelevant to record VISIBILITY and never enters
 * the verdict.
 *
 * The cascade, in this exact order:
 *
 *   0. **Object-CRUD precondition (plane A, operation-aware)** — evaluated in
 *      the handler BEFORE any record-visibility verdict. `hasObjectAccess(level)`
 *      checks whether the profile-UNION-permsets set holds the object CRUD for
 *      THIS operation: object Read for read; object Edit (or Modify All) for
 *      edit; object Delete (or Modify All) for delete; plus the system perm that
 *      covers the level (`ViewAllData`/`ModifyAllData` for read, `ModifyAllData`
 *      only for edit/delete — View All Data is read-only). When a profile or
 *      permission set was supplied and the precondition is NOT met, the handler
 *      returns `restricted` immediately (the ONLY precondition-driven
 *      `restricted`) — this kills both H1 (zero-perm user on a Public-Read OWD)
 *      and CR-RV6 (Read-only user told they can EDIT a ReadWriteTransfer OWD
 *      object / Edit-only user told they can DELETE a FullAccess OWD object). A
 *      role/group-only context cannot decide object perms, so the gate is
 *      skipped and the cascade runs to an honest answer.
 *
 *   1. **OWD** (Organization-Wide Default) — read `componentId`'s
 *      `properties.sharingModel`.
 *        - public (rank ≥ the operation's requirement) → OWD step `visible`.
 *          This `visible` only survives to the aggregate once the object-Read
 *          precondition (step 0) passed — a public OWD with zero object
 *          permission already returned `restricted`. (e.g. `Read` for read;
 *          `ReadWrite` for edit; `FullAccess` for delete.)
 *        - a recognised OWD below the requirement (`Private`, or `Read` for an
 *          edit check, etc.) → `restricted`. Continue the cascade; downstream
 *          grants / ownership / Modify-All can grant access back.
 *        - `null` / unrecognised (custom metadata, custom setting, etc.) →
 *          `unknown`. Stop the cascade and return `unknown` overall.
 *
 *   2. **PermissionGrant** — examine incoming `grantedBy` edges to
 *      `componentId` from every id in
 *      `userContext.profileId` + `userContext.permissionSetIds`. Reports
 *      `visible` ONLY for a record-sharing BYPASS — object "View All"
 *      (`viewAllRecords`, read) or "Modify All" (`modifyAllRecords`, any
 *      level). Plain object CRUD (`allowRead`/`allowEdit`/`allowDelete`)
 *      satisfies the plane-A precondition but NOT plane B on a Private object,
 *      so it reports `restricted` here (record visibility then depends on the
 *      OWD-public path or a sharing grant). These are OBJECT-level perms.
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
 *      `sharedWith` edges and check whether the resolved id reaches the
 *      user. A plain `role` / `group` / synthetic / `portalRole` target
 *      matches EXACTLY against the user's `roleId` / `groupIds`
 *      (treating `Group:AllInternalUsers` and the other synthetic groups
 *      in the variant table as members whenever any `userContext` field
 *      is supplied — every authenticated user is "internal"). A
 *      `roleAndSubordinates` / `roleAndSubordinatesInternal` Role target
 *      (carrying `inheritance: subordinates | subordinatesInternal`) ALSO
 *      matches when the target role is an ANCESTOR of the user role — i.e.
 *      the user is a SUBORDINATE of the named role — resolved via the
 *      user's upward role-hierarchy chain (CR-CAP-05). One step per rule;
 *      `visible` if a match, `restricted` if not. **Incomplete-tree
 *      honesty:** if a subordinate-aware rule did NOT match but the user's
 *      ancestor chain was cut short by a role node the refresh never
 *      retrieved, the step is `unknown` (the rule could still reach the
 *      user via an unretrieved ancestor) rather than a confident
 *      false-deny — the reason names the missing role and points to
 *      `/sfi-refresh` / `coverage_report`.
 *
 *   5. **CriteriaSharingRule** — similar enumeration but
 *      `ruleType === 'criteria'`. Criteria require record-level data to
 *      evaluate (the booleanFilter is over field values, not metadata),
 *      so this stage always returns `unknown` with the rule's
 *      `booleanFilter` (or `criteriaItemCount`) surfaced in the reason.
 *
 *   6. **TerritoryAndGuestRules** (CR-CAP-16) — a real per-rule
 *      enumeration over the attached guest / territory / territoryGroup
 *      sharing rules (the extractor now models them). Each rule surfaces
 *      its declared detail — id, accessLevel, Experience-Cloud site name
 *      (guest) or shared target (territory), and predicate — but the
 *      verdict stays `unknown`: existence is declarable, applicability is
 *      record-level (guest = is the requester the site guest user;
 *      territory = the user's + record's territory assignment). When no
 *      such rules attach, a single `unknown` step preserves the
 *      absence-is-not-no-access disclosure.
 *
 *   7/8/9. **ManualSharing**, **SharingSets**, **AccountTeams** — always
 *      `unknown` with explanatory reasons; these require record-level data
 *      or org-config beyond v1.1's metadata model. They appear at the tail
 *      so callers can show admins what was NOT modeled and recommend a
 *      manual check.
 *
 * **Aggregate verdict** (after the object-Read precondition has already passed
 * or is undecidable):
 *   - `visible` if any step is `visible` (a View/Modify-All bypass, a public
 *     OWD on top of the satisfied precondition, an OwnerSharingRule match, or
 *     System god-mode).
 *   - `unknown` if no step is `visible` and any step is `unknown` — the honesty
 *     axis: on a Private/ControlledByParent object where object Read is present
 *     but no modeled bypass or grant exists, unmodeled manual sharing / teams /
 *     sets (and, for ControlledByParent, the master object's sharing) could
 *     still grant access, so prefer `unknown` over a wrong `restricted`.
 *   - `restricted` only when every step is `restricted`, OR (the precondition
 *     path) when a profile/permset was supplied with no object Read — in which
 *     case the handler returned `restricted` before this aggregate ran.
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
import { expandGroupMembership } from './group-membership.js';
import { expandPermissionSetGroup } from './permission-set-group.js';

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
 * Does a `grantedBy` object-permission edge satisfy the object-level READ
 * PRECONDITION? To SEE a record at all a user needs object Read CRUD; in
 * Salesforce object Edit, Delete, and Create each IMPLY Read (you cannot enable
 * any of them without Read), and View All / Modify All records both subsume it.
 * This is plane A — the object precondition — NOT a record-visibility grant
 * (that is plane B, see `grantSatisfiesRecordVisible`). Plain object CRUD here
 * only means "IF the user can reach the record, they may act on it"; whether
 * they can reach a Private record is decided by OWD + sharing on top.
 */
const grantSatisfiesObjectRead = (edge: Edge): boolean => {
  const p = edge.properties;
  return (
    p['allowRead'] === true ||
    p['allowEdit'] === true ||
    p['allowDelete'] === true ||
    p['allowCreate'] === true ||
    p['viewAllRecords'] === true ||
    p['modifyAllRecords'] === true
  );
};

/**
 * CR-RV6: does a `grantedBy` object-permission edge satisfy the object-CRUD
 * PRECONDITION for the requested OPERATION? The object precondition is
 * operation-specific in Salesforce: to EDIT a record a user needs object Edit
 * CRUD, to DELETE needs object Delete CRUD; plain object Read satisfies only the
 * read precondition. View All / Modify All are a SEPARATE (record-sharing)
 * plane, but they also subsume the relevant object precondition:
 *   - edit  => allowEdit   OR object Modify All (modifyAllRecords)
 *   - delete=> allowDelete OR object Modify All (modifyAllRecords)
 *   - read  => the broader `grantSatisfiesObjectRead` (Edit/Delete/Create all
 *     imply Read in Salesforce; View All also reads every record)
 *
 * CRITICAL (the false-permissive class CR-RV6 fixes): `viewAllRecords` (object
 * "View All") is READ-ONLY — it must NOT satisfy the edit/delete precondition;
 * and plain `allowRead` must NOT satisfy edit/delete. Mirrors the system-perm
 * bypass encoded in `systemPermsForLevel` (ModifyAllData only for edit/delete).
 *
 * `create` is OFF this precondition (it has its own `allowCreate` path in the
 * create branch) and never reaches `hasObjectAccess`, so it is not handled here.
 */
const grantSatisfiesObjectLevel = (edge: Edge, level: AccessLevel): boolean => {
  const p = edge.properties;
  if (level === 'read') return grantSatisfiesObjectRead(edge);
  // edit / delete: the matching CRUD bit, or object Modify All (which both
  // edits and deletes every record). View All / plain Read are read-only.
  if (p['modifyAllRecords'] === true) return true;
  if (level === 'edit') return p['allowEdit'] === true;
  if (level === 'delete') return p['allowDelete'] === true;
  return false;
};

/**
 * Does a `grantedBy` object-permission edge grant RECORD VISIBILITY (plane B)
 * for `level` — i.e. does it BYPASS record sharing? Only the object "View All" /
 * "Modify All" records bypasses do: `modifyAllRecords` (object "Modify All")
 * reads/edits/deletes every record at every level; `viewAllRecords` (object
 * "View All") reads every record (read only). Plain `allowRead` / `allowEdit` /
 * `allowDelete` are object CRUD — they satisfy the object precondition (plane A)
 * but on a Private object they do NOT grant record access; that comes from OWD
 * or a sharing grant. Mirrors `who_can_access_object`'s scope model
 * (viewAll/modifyAll = `all-records`; plain read/edit = `shared-records`).
 *
 * `create` is OFF the record-visibility ladder (you don't need to access an
 * existing record to create one); the create branch evaluates `allowCreate`
 * directly, so create never reaches this predicate.
 */
const grantSatisfiesRecordVisible = (edge: Edge, level: AccessLevel): boolean => {
  const p = edge.properties;
  if (p['modifyAllRecords'] === true) return true;
  if (level === 'read') return p['viewAllRecords'] === true;
  // edit / delete: only object "Modify All" records bypasses sharing. View All
  // is read-only, and plain allowEdit/allowDelete are precondition-only.
  return false;
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
      // RV11: the precondition is now operation-aware (hasObjectAccess(level)),
      // so this claim is finally TRUE for edit/delete — and we name the actual
      // bit checked (object ${level}), not the old "object-Read precondition"
      // misnomer that lied for edit/delete.
      `OWD '${sharingModel}' grants ${level} access to all records (given the user has object ${level} permission — checked separately as the object ${level} precondition)`,
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
 * Evaluate the PermissionGrant stage by enumerating incoming `grantedBy` edges
 * to `componentId` from the user's `profileId`+`permissionSetIds`.
 *
 * For the record-visibility cascade (`read` / `edit` / `delete`) this reports
 * `visible` ONLY when a grant BYPASSES record sharing — object "View All" /
 * "Modify All" records (`grantSatisfiesRecordVisible`). A grant that carries
 * only plain object CRUD (`allowRead` / `allowEdit` / `allowDelete`) satisfies
 * the object precondition (plane A, evaluated separately in
 * `hasObjectAccess(level)`) but does NOT by itself make a Private record visible —
 * on a Private object that comes from OWD or a sharing grant — so it reports
 * `restricted` here, with a reason that distinguishes "object CRUD present,
 * record visibility depends on OWD/sharing" from "View/Modify All grants all
 * records".
 *
 * For `create` the predicate is `allowCreate` (or object Modify All) directly —
 * create is off the record-sharing ladder, so the bypass narrowing does not
 * apply; the create branch depends on a plain `allowCreate` grant reading as
 * `visible`.
 *
 * When no grant matches, the verdict is `restricted` with a reason naming the
 * granters that were inspected, so the admin can see which permission containers
 * the user actually has.
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
  // RV11: track granters that hold the OPERATION-LEVEL object CRUD (precondition
  // only) but no record-visibility bypass, so the `restricted` reason names a
  // bit ACTUALLY held — `grantSatisfiesObjectLevel(edge, level)` is the per-
  // operation predicate (object Read for read, object Edit/Delete or Modify All
  // for edit/delete), NOT the any-CRUD `grantSatisfiesObjectRead` which would
  // claim "object edit permission present" for a Read-only granter.
  let anyObjectLevelCrud = false;
  for (const edge of edgesResult.value) {
    if (!granterSet.has(edge.fromId)) continue;
    const recordVisible =
      level === 'create'
        ? edge.properties['allowCreate'] === true ||
          edge.properties['modifyAllRecords'] === true
        : grantSatisfiesRecordVisible(edge, level);
    if (recordVisible) {
      granting.push(edge.fromId);
    } else if (level !== 'create' && grantSatisfiesObjectLevel(edge, level)) {
      anyObjectLevelCrud = true;
    }
  }
  if (granting.length > 0) {
    const detail =
      level === 'create'
        ? `${level} object permission granted by: ${granting.join(', ')}`
        : `object View All / Modify All grants ${level} access to all records: ${granting.join(', ')}`;
    return ok(step('PermissionGrant', 'visible', detail));
  }
  if (anyObjectLevelCrud && level !== 'create') {
    // Object CRUD present (the precondition is met) but no View/Modify All
    // bypass — on a Private object record visibility depends on OWD/sharing.
    // RV1: this branch is gated to read/edit/delete. For `create`, object
    // CRUD does NOT imply the Create permission (the granter may hold Read/
    // Edit/Delete but allowCreate:false), and create is never OWD/sharing-
    // gated, so emitting an OWD-dependence reason would contradict the
    // `restricted` verdict. The create-specific reason is emitted below.
    return ok(
      step(
        'PermissionGrant',
        'restricted',
        `object ${level} permission present on the supplied granters but record visibility depends on OWD / sharing (no object View All / Modify All): ${granterIds.join(', ')}`,
      ),
    );
  }
  if (level === 'create') {
    // RV1: no granter holds object Create (`allowCreate`) or object/system
    // Modify-All; create is gated solely by the Create permission, so the
    // honest `restricted` reason names the missing Create permission rather
    // than (incorrectly) invoking OWD / sharing.
    return ok(
      step(
        'PermissionGrant',
        'restricted',
        `no object Create permission on the supplied granters: ${granterIds.join(', ')}`,
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
 * Plane A — the operation-aware OBJECT-CRUD PRECONDITION. To ACT on a record a
 * user needs the object-level CRUD for THAT OPERATION, drawn from the profile
 * UNION any assigned permission set:
 *   - read   needs object Read   (Edit/Delete/Create all imply Read);
 *   - edit   needs object Edit   (or object Modify All);
 *   - delete needs object Delete (or object Modify All).
 *
 * CR-RV6: the precondition was previously READ-ONLY regardless of `level`, so a
 * Read-only user passed the precondition for `edit`/`delete` and the FIRST
 * cascade step (OWD) could then visible an operation the user had no CRUD for —
 * a false-PERMISSIVE access answer. The precondition is now satisfied only by:
 *   - an object `grantedBy` edge satisfying the per-level CRUD bit
 *     (`grantSatisfiesObjectLevel`); OR
 *   - the system perm that satisfies `level` (`systemPermsForLevel`:
 *     ViewAllData OR ModifyAllData for read; ModifyAllData ONLY for edit/delete
 *     — View All Data is read-only, so it must NOT pass the edit/delete
 *     precondition).
 *
 * Returns `false` when neither path is present — the user lacks object CRUD for
 * the operation, so no OWD value and no record-level sharing can make the record
 * actionable (record sharing layers on TOP of object access; it never confers
 * it). `create` is off this precondition (its own `allowCreate` path) and never
 * calls this helper.
 *
 * FLS note: this reads ONLY the object's own incoming `grantedBy` edges
 * (`direction: 'in'`, `edgeType: 'grantedBy'` on the CustomObject id). FLS
 * grants target CustomField ids, never the CustomObject, so field-level
 * security can never leak into the record-visibility precondition.
 */
const hasObjectAccess = async (
  ctx: Context,
  componentId: ComponentId,
  userContext: UserContext,
  level: AccessLevel,
): Promise<Result<boolean, string>> => {
  const granterIds: string[] = [];
  if (userContext.profileId !== undefined) granterIds.push(userContext.profileId);
  if (userContext.permissionSetIds !== undefined) {
    granterIds.push(...userContext.permissionSetIds);
  }
  if (granterIds.length === 0) return ok(false);
  const granterSet: ReadonlySet<string> = new Set(granterIds);

  // Object-level grants: incoming `grantedBy` edges on the CustomObject.
  const edgesResult = await listEdges(ctx.graph, componentId, {
    direction: 'in',
    edgeType: 'grantedBy',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  for (const edge of edgesResult.value) {
    if (!granterSet.has(edge.fromId)) continue;
    if (grantSatisfiesObjectLevel(edge, level)) return ok(true);
  }

  // System View All Data / Modify All Data also satisfies the precondition for
  // the levels they cover (read: View/Modify All Data; edit/delete: Modify All
  // Data only). `systemPermsForLevel` already encodes the read-only nature of
  // View All Data, so this branch can never let it pass the edit/delete gate.
  const relevantPerms = systemPermsForLevel(level);
  for (const id of granterIds) {
    const nodeResult = await getNodeById(ctx.graph, id as ComponentId);
    if (!nodeResult.ok) return err(nodeResult.error.message);
    const node = nodeResult.value;
    if (node === null) continue;
    const perms = node.properties['userPermissions'];
    if (!Array.isArray(perms)) continue;
    if (relevantPerms.some((p) => perms.includes(p))) {
      return ok(true);
    }
  }
  return ok(false);
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
 * Result of an upward role-hierarchy walk.
 *
 *   - `chain`: the parent role ids, nearest-first, NOT including the
 *     starting role.
 *   - `truncated`: `true` when the walk stopped at a role node that was
 *     NOT retrieved (manifest `notModeled` / partial refresh) BEFORE
 *     reaching a genuine top-of-hierarchy role. A missing node yields
 *     zero outgoing `inheritsFrom` edges, which is indistinguishable
 *     from a real top role by edge count alone — so we probe the node's
 *     existence. CR-CAP-05 uses this so a subordinate-aware sharing rule
 *     that did NOT match on a SHORT chain downgrades to `unknown` rather
 *     than asserting a confident (possibly false) `restricted`.
 */
interface RoleHierarchyWalk {
  readonly chain: readonly string[];
  readonly truncated: boolean;
}

/**
 * Walk `inheritsFrom` edges upward from `roleId` collecting the
 * parent chain. Stops at the top of the hierarchy (a role with no
 * outgoing `inheritsFrom`), at a missing node, or at
 * `ROLE_HIERARCHY_MAX_DEPTH` rungs — whichever comes first. The
 * visited-set defends against malformed graphs with cycles.
 *
 * Surfaces `truncated` (see {@link RoleHierarchyWalk}) so callers that
 * need a complete ancestor chain (CR-CAP-05's subordinate match) can
 * tell a genuinely-empty walk from one cut short by a missing role node.
 */
const walkRoleHierarchy = async (
  ctx: Context,
  roleId: ComponentId,
): Promise<Result<RoleHierarchyWalk, string>> => {
  const chain: string[] = [];
  const visited = new Set<string>([roleId]);
  let cursor = roleId;
  let truncated = false;
  for (let depth = 0; depth < ROLE_HIERARCHY_MAX_DEPTH; depth++) {
    const edgesResult = await listEdges(ctx.graph, cursor, {
      direction: 'out',
      edgeType: 'inheritsFrom',
    });
    if (!edgesResult.ok) {
      return err(edgesResult.error.message);
    }
    if (edgesResult.value.length === 0) {
      // Zero outgoing `inheritsFrom` is ambiguous: either `cursor` is a
      // real top-of-hierarchy role, or its node was never retrieved (so
      // a parent could exist above it that the vault can't see). Probe
      // the node — a missing one means the walk is TRUNCATED, not done.
      const cursorNode = await getNodeById(ctx.graph, cursor as ComponentId);
      if (!cursorNode.ok) {
        return err(cursorNode.error.message);
      }
      if (cursorNode.value === null) truncated = true;
      break;
    }
    // Role.md models exactly one `parentRole` per role, so the
    // extractor emits at most one `inheritsFrom` per role. Take the
    // first; anything beyond it is a graph anomaly.
    const parentId = edgesResult.value[0]!.toId;
    if (visited.has(parentId)) break;
    visited.add(parentId);
    chain.push(parentId);
    cursor = parentId;
  }
  return ok({ chain, truncated });
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
  const chain = chainResult.value.chain;
  const traversed = chain.length === 0 ? undefined : chain;
  const reason =
    chain.length === 0
      ? `role ${roleId} is at the top of the hierarchy; ownership of records of this type cannot be inferred from metadata alone`
      : `role hierarchy walked ${chain.length} level(s) up from ${roleId}; ownership of records of this type cannot be inferred from metadata alone`;
  return ok(step('RoleHierarchy', 'unknown', reason, traversed));
};

/**
 * The LITERAL set of `sharedWith` target ids the user is treated as belonging
 * to. Includes every id the caller supplied plus `Group:AllInternalUsers`
 * (every authenticated user is "internal" for sharing purposes). The other
 * three synthetic groups in the variant table are not auto-included — callers
 * wanting them must pass them in `groupIds` explicitly.
 *
 * CR-CAP-12: this is only the LITERAL membership. `evaluateOwnerSharingRules`
 * then expands it UPWARD through `hasMember` (so a user typed into a nested
 * group matches a rule granting the enclosing public group); the expansion is
 * NOT folded in here so the literal/expanded split stays auditable.
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

/** The canonical `Role:` id prefix on a `sharedWith` target. */
const SHARED_TO_ROLE_PREFIX = 'Role:';

/**
 * Inheritance markers (from the sharing-rules extractor `VARIANT_TABLE`)
 * that make a `sharedTo` Role target reach the named role AND every role
 * BELOW it in the hierarchy:
 *   - `subordinates`          ← `roleAndSubordinates`
 *   - `subordinatesInternal`  ← `roleAndSubordinatesInternal`
 * A plain `role` carries no `inheritance` prop (named role only), and
 * `portalRole` carries only `portal: true` — neither expands to
 * subordinates, so both stay exact.
 */
const SUBORDINATE_INHERITANCE: ReadonlySet<string> = new Set([
  'subordinates',
  'subordinatesInternal',
]);

/** Outcome of testing one owner rule's `sharedTo` edges against the user. */
type OwnerRuleMatch =
  | { readonly kind: 'match'; readonly targetId: string }
  | { readonly kind: 'no-match' }
  /**
   * A subordinate-aware (`roleAndSubordinates`) rule did NOT match on the
   * user's KNOWN ancestor chain, but that chain was TRUNCATED by a missing
   * role node — so the rule MIGHT reach the user via an ancestor the vault
   * never retrieved. CR-CAP-05: the caller downgrades this to `unknown`
   * (never a confident false-deny). `targetId` is the inheritance-gated
   * role we could neither confirm nor rule out as an ancestor.
   */
  | { readonly kind: 'indeterminate'; readonly targetId: string };

/**
 * Determine whether an owner-type `SharingRule` grants access to the
 * user. Walks the rule's outgoing `sharedWith` edges and checks the
 * `toId` against the user. The first definite MATCH short-circuits. The
 * `direction === 'from'` edge on owner rules describes *whose records
 * the rule applies to* (the source of the shared records), not who
 * receives access — we only check the `sharedTo` edge
 * (`direction === 'to'` or undefined for criteria rules).
 *
 * Matching rule per `sharedTo` edge (CR-CAP-05):
 *   - Plain role / group / synthetic / portalRole (NO `inheritance`
 *     prop): EXACT — `membership.has(edge.toId)`. portalRole carries
 *     only `portal: true`, so it stays the named role only.
 *   - `inheritance === subordinates | subordinatesInternal` on a `Role:`
 *     target: the rule reaches the named role itself
 *     (`membership.has`) OR any role BELOW it — i.e. the target is an
 *     ANCESTOR of the user role (`userAncestorRoleIds.has(edge.toId)`).
 *     If neither holds AND the user's ancestor chain was TRUNCATED by a
 *     missing role node, the result is `indeterminate` (the caller emits
 *     `unknown`) rather than a confident no-match.
 *
 * Bounded by the SINGLE user ancestor chain (computed once by the
 * caller), regardless of how large the rule's role subtree is.
 */
const ownerRuleMatches = async (
  ctx: Context,
  ruleNode: Node,
  membership: ReadonlySet<string>,
  userAncestorRoleIds: ReadonlySet<string>,
  userAncestorChainTruncated: boolean,
  groupMembershipTruncated: boolean,
): Promise<Result<OwnerRuleMatch, string>> => {
  const edgesResult = await listEdges(ctx.graph, ruleNode.id, {
    direction: 'out',
    edgeType: 'sharedWith',
  });
  if (!edgesResult.ok) {
    return err(edgesResult.error.message);
  }
  // Defer a possible `indeterminate` so a definite match on ANOTHER edge of
  // the same rule always wins (a rule can carry several sharedTo targets).
  let indeterminate: { readonly targetId: string } | null = null;
  for (const edge of edgesResult.value) {
    if (edge.properties['direction'] === 'from') continue;
    // Exact membership match always wins (covers the named role itself,
    // groups [incl. CR-CAP-12 enclosing groups folded into `membership`],
    // synthetic groups, and the plain-role / portalRole cases).
    if (membership.has(edge.toId)) {
      return ok({ kind: 'match', targetId: edge.toId });
    }
    const inheritance = edge.properties['inheritance'];
    const isSubordinateRole =
      typeof inheritance === 'string' &&
      SUBORDINATE_INHERITANCE.has(inheritance) &&
      edge.toId.startsWith(SHARED_TO_ROLE_PREFIX);
    if (isSubordinateRole) {
      // The target reaches every role below it: match if it is an ancestor
      // of the user role.
      if (userAncestorRoleIds.has(edge.toId)) {
        return ok({ kind: 'match', targetId: edge.toId });
      }
      // No ancestor match — but if the user's chain is short because a role
      // node was missing, we cannot be sure the target ISN'T an ancestor.
      if (userAncestorChainTruncated && indeterminate === null) {
        indeterminate = { targetId: edge.toId };
      }
    } else if (
      // CR-CAP-12: a Group: target that the EXPANDED membership did not reach,
      // while the upward `hasMember` walk was truncated (a missing enclosing /
      // nested group node), cannot be confidently ruled out — the rule MIGHT
      // reach the user via an unretrieved group. Downgrade to indeterminate
      // (→ `unknown`) rather than a confident false-deny.
      groupMembershipTruncated &&
      edge.toId.startsWith(GROUP_PREFIX) &&
      indeterminate === null
    ) {
      indeterminate = { targetId: edge.toId };
    }
  }
  if (indeterminate !== null) {
    return ok({ kind: 'indeterminate', targetId: indeterminate.targetId });
  }
  return ok({ kind: 'no-match' });
};

/**
 * Evaluate the OwnerSharingRule stage. Emits one step per owner-typed
 * rule attached to the target object.
 *
 *   - `visible` when the rule's `sharedTo` target reaches the user — by
 *     exact membership, OR (for a `roleAndSubordinates` /
 *     `…Internal` Role target) because the target is an ANCESTOR of the
 *     user role, i.e. the user is a subordinate — AND the rule's access
 *     level satisfies the requested operation (CR-CAP-05).
 *   - `unknown` when a subordinate-aware rule did NOT match but the
 *     user's ancestor chain was TRUNCATED by a missing role node, so the
 *     rule MIGHT reach the user via an unretrieved ancestor (honesty: no
 *     confident false-deny).
 *   - `restricted` otherwise.
 *
 * The user's ancestor chain is computed ONCE here (via the existing
 * upward `walkRoleHierarchy`), not per rule — bounded by a single chain
 * regardless of subtree fan-out. Ancestors are NOT folded into the base
 * membership set: that set still drives the EXACT plain-role/group path,
 * so plain rules never leak to ancestors. If no owner rules exist,
 * returns a single step explaining that.
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
  const literalMembership = buildUserMembership(userContext);
  // CR-CAP-12: expand the user's literal Group: ids UPWARD through `hasMember`
  // so a sharing rule granting an ENCLOSING public group matches a user typed
  // into only a nested member group (the literal set would miss it). Monotone
  // fixpoint; a truncated walk (missing enclosing-group node) downgrades an
  // otherwise-`restricted` group rule to `unknown`, never a false-deny.
  const expanded = await expandGroupMembership(ctx, [...literalMembership]);
  if (!expanded.ok) return err(expanded.error);
  const membership: ReadonlySet<string> = new Set<string>([
    ...literalMembership,
    ...expanded.value.groupIds,
  ]);
  const groupMembershipTruncated = expanded.value.truncated;
  // CR-CAP-05: the ancestor chain only feeds the inheritance-gated path.
  // Compute it once; an absent roleId means no ancestors (and no truncation).
  let userAncestorRoleIds: ReadonlySet<string> = new Set<string>();
  let userAncestorChainTruncated = false;
  if (userContext.roleId !== undefined) {
    const walk = await walkRoleHierarchy(
      ctx,
      userContext.roleId as ComponentId,
    );
    if (!walk.ok) return err(walk.error);
    userAncestorRoleIds = new Set<string>(walk.value.chain);
    userAncestorChainTruncated = walk.value.truncated;
  }
  const steps: AccessReasoningStep[] = [];
  for (const rule of ownerRules) {
    const matchResult = await ownerRuleMatches(
      ctx,
      rule,
      membership,
      userAncestorRoleIds,
      userAncestorChainTruncated,
      groupMembershipTruncated,
    );
    if (!matchResult.ok) return err(matchResult.error);
    const match = matchResult.value;
    const ruleAccess =
      typeof rule.properties['accessLevel'] === 'string'
        ? (rule.properties['accessLevel'] as string)
        : 'Read';
    if (match.kind === 'match' && ruleAccessSatisfiesLevel(ruleAccess, level)) {
      // The user is in (or a subordinate of) the shared target AND the rule's
      // access level reaches the op (a Read rule never grants edit; no sharing
      // rule grants delete).
      steps.push(
        step(
          'OwnerSharingRule',
          'visible',
          `owner sharing rule ${rule.id} grants ${level} access via shared target ${match.targetId} (rule access: ${ruleAccess})`,
        ),
      );
    } else if (match.kind === 'match') {
      // Membership/subtree matches but the rule's access level is too low.
      steps.push(
        step(
          'OwnerSharingRule',
          'restricted',
          `owner sharing rule ${rule.id} shares to the user but grants only ${ruleAccess}, not ${level}`,
        ),
      );
    } else if (match.kind === 'indeterminate') {
      // Honesty: either the role tree is truncated above the user (CR-CAP-05)
      // OR the group-membership walk hit a missing nested/enclosing group
      // (CR-CAP-12), so we can neither confirm nor deny the match — never a
      // confident false-deny.
      const reason = match.targetId.startsWith(GROUP_PREFIX)
        ? `owner sharing rule ${rule.id} shares to group ${match.targetId}, but the group-membership graph is incomplete (a nested/enclosing group node was not retrieved), so membership cannot be resolved — run /sfi-refresh or see coverage_report, then re-check`
        : `owner sharing rule ${rule.id} shares to subordinates of ${match.targetId}, but the role hierarchy above ${String(userContext.roleId)} is incomplete (a role node was not retrieved), so the subordinate match cannot be resolved — run /sfi-refresh or see coverage_report, then re-check`;
      steps.push(step('OwnerSharingRule', 'unknown', reason));
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

/** The guest / territory rule families CR-CAP-16 now surfaces in this stage. */
const TERRITORY_GUEST_RULE_TYPES: ReadonlySet<string> = new Set([
  'guest',
  'territory',
  'territoryGroup',
]);

/**
 * CR-CAP-16: evaluate the TerritoryAndGuestRules stage. Mirrors
 * `evaluateCriteriaSharingRules` — one step per attached guest / territory /
 * territoryGroup rule. The verdict is ALWAYS `unknown`: a rule's EXISTENCE,
 * `accessLevel`, site / territory name, and predicate are declared in the
 * metadata (surfaced in the reason), but its APPLICABILITY is record-level
 * (guest = is the requester the site's guest user; territory = the user's +
 * record's territory assignment) — context the offline vault lacks. So the step
 * never fabricates a confident `visible` / `restricted`.
 *
 * When NO such rules attach, returns a SINGLE `unknown` step preserving the
 * absence-is-not-no-access disclosure — never `restricted` (a territory rule we
 * never retrieved, or guest access in a community, could still grant it).
 */
const evaluateTerritoryAndGuestRules = (
  rules: readonly Node[],
  level: AccessLevel,
): readonly AccessReasoningStep[] => {
  const tgRules = rules.filter((r) => {
    const rt = r.properties['ruleType'];
    return typeof rt === 'string' && TERRITORY_GUEST_RULE_TYPES.has(rt);
  });
  if (tgRules.length === 0) {
    return [
      step(
        'TerritoryAndGuestRules',
        'unknown',
        'no territory or guest (Experience Cloud) sharing rules attached to this object — but absence here is "not modeled / not retrieved", not "no access": these rules need record-level + requester context to evaluate, so verify in the org if relevant',
      ),
    ];
  }
  const steps: AccessReasoningStep[] = [];
  for (const rule of tgRules) {
    const ruleType = String(rule.properties['ruleType']);
    const ruleAccess =
      typeof rule.properties['accessLevel'] === 'string'
        ? (rule.properties['accessLevel'] as string)
        : 'Read';
    const booleanFilter = rule.properties['booleanFilter'];
    const criteriaItemCount = rule.properties['criteriaItemCount'];
    const predicate =
      typeof booleanFilter === 'string' && booleanFilter.length > 0
        ? booleanFilter
        : typeof criteriaItemCount === 'number' && criteriaItemCount > 0
          ? `${criteriaItemCount} criteria item(s)`
          : 'unspecified criteria';
    // The site (guest) or shared target (territory) name, when present.
    const siteName = rule.properties['siteName'];
    const sharedToName = rule.properties['sharedToName'];
    const targetDetail =
      ruleType === 'guest' && typeof siteName === 'string'
        ? ` for Experience Cloud site '${siteName}'`
        : typeof sharedToName === 'string'
          ? ` shared to '${sharedToName}'`
          : '';
    // Existence is declared; applicability is record-level → always unknown.
    steps.push(
      step(
        'TerritoryAndGuestRules',
        'unknown',
        `${ruleType} sharing rule ${rule.id} (${ruleAccess})${targetDetail} grants ${level} if the record matches \`${predicate}\` AND the requester is in the matching ${ruleType === 'guest' ? 'guest/site' : 'territory'} context — record-level data the offline vault lacks, so this cannot be confirmed or denied here`,
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
 * CR-CAP-04: PermissionSetGroup is now MODELED. Any PSG passed in the user's
 * `permissionSetIds` has already been EXPANDED into its member permission sets
 * by `coerceUserContext`, and those members flow through the real grant cascade
 * (object-Read precondition + PermissionGrant + SystemPermission) — so the
 * verdict is decided there, not here. This step is INFORMATIONAL: it reports how
 * many assigned PSGs were expanded into how many member permission sets, and
 * carries a muting caveat where a group references a muting set (muting is
 * disclosed but NEVER subtracted — declared confidence).
 *
 * `restricted` (not `unknown`): the step itself confers no record-visibility
 * BYPASS, and PSG membership is no longer an undecidable gap — the grant stages
 * already accounted for the members. A `restricted` here cannot wrongly demote
 * the overall verdict (a PSG-conferred grant surfaces as `visible` in the grant
 * stage, which wins).
 */
const evaluatePermissionSetGroups = async (
  ctx: Context,
  userContext: UserContext,
): Promise<Result<AccessReasoningStep, string>> => {
  // The coerced+folded permissionSetIds still carry the PSG ids alongside their
  // expanded members, so the assigned PSGs are read straight off the context.
  const assignedPsgIds = (userContext.permissionSetIds ?? []).filter((id) =>
    id.startsWith(PERMISSION_SET_GROUP_PREFIX),
  );

  if (assignedPsgIds.length > 0) {
    let memberCount = 0;
    const mutingPsgs: string[] = [];
    for (const psgId of assignedPsgIds) {
      const expanded = await expandPermissionSetGroup(ctx, psgId as ComponentId);
      if (!expanded.ok) return err(expanded.error.message);
      if (expanded.value === null) continue;
      memberCount += expanded.value.memberPermissionSetIds.length;
      if (expanded.value.hasMuting) mutingPsgs.push(psgId);
    }
    const caveat =
      mutingPsgs.length > 0
        ? ` ${mutingPsgs.length} of them reference a muting permission set (${[...new Set(mutingPsgs)].sort().join(', ')}); muting is NOT subtracted, so effective access may be lower.`
        : '';
    return ok(
      step(
        'PermissionSetGroup',
        'restricted',
        `${assignedPsgIds.length} assigned permission set group(s) expanded into ${memberCount} member permission set(s), evaluated via the permission-grant cascade above (declared membership).${caveat}`,
        assignedPsgIds,
      ),
    );
  }

  // No assigned PSG. Report whether any exist in the vault (informational).
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
  return ok(
    step(
      'PermissionSetGroup',
      'restricted',
      `${psgResult.value.length} permission set group(s) exist in vault but none were supplied in this user's context; pass an assigned PermissionSetGroup id in permissionSetIds to evaluate group-derived access (membership is expanded automatically).`,
    ),
  );
};

/**
 * The trailing trio: stages whose verdict the v1.1 model cannot
 * decide under any circumstance. The reasons cite the data v1.x
 * would need to model (record-level shares, sharing-set config,
 * account-team membership). Frozen because the steps never vary
 * across invocations — every call appends the same three entries.
 *
 * CR-CAP-16: `TerritoryAndGuestRules` is NO LONGER in this frozen tail — it is
 * now a real per-rule evaluator (`evaluateTerritoryAndGuestRules`) that surfaces
 * each attached guest / territory rule's declared detail while keeping the
 * verdict `unknown`. The tail keeps only the genuinely-unmodeled stages.
 */
const UNKNOWN_TAIL: readonly AccessReasoningStep[] = Object.freeze([
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
 * Aggregate the cascade into a single verdict. The first `visible` step in
 * cascade order wins; otherwise any `unknown` in the chain demotes the answer to
 * `unknown` per the honesty axis; only a chain that is uniformly `restricted`
 * yields `restricted`.
 *
 * The two-plane access model: seeing a record needs BOTH (A) object-level Read
 * CRUD and (B) record-level access. Plane A — the object-Read PRECONDITION — is
 * checked by the handler BEFORE this function runs: when a profile or permission
 * set was supplied and the precondition is unmet, the handler returns
 * `restricted` early (the only place a precondition-driven `restricted` is
 * emitted), so this function never sees that case. By the time it runs either
 * (i) object Read is present, or (ii) object perms are undecidable (a
 * role/group-only context with no profile/permset).
 *
 * Therefore the OLD object-CRUD hard gate is GONE: object Read is no longer
 * inferred from `PermissionGrant === 'restricted'`. After the H2 split a
 * `PermissionGrant === 'restricted'` step means "object access present but no
 * record-visibility bypass" — NOT "no object access". So on a Private /
 * ControlledByParent object where object Read IS present but no modeled bypass
 * or sharing grant exists, the unknown tail (manual sharing / teams / sets /
 * the parent object's sharing for ControlledByParent) legitimately demotes the
 * answer to `unknown` — "we cannot see a grant" is NOT "the user definitely
 * cannot see it".
 */
const aggregateVerdict = (
  steps: readonly AccessReasoningStep[],
): 'visible' | 'restricted' | 'unknown' => {
  // First, any visible step grants access (PermissionGrant override, OWD public,
  // OwnerSharingRule match, System god-mode, etc.).
  for (const s of steps) {
    if (s.verdict === 'visible') return 'visible';
  }
  // No visible step. The object-Read precondition is already satisfied (or
  // undecidable) by the time we get here, so any `unknown` in the chain makes
  // the honest answer `unknown` — prefer "I don't know" over a wrong
  // `restricted` (the load-bearing honesty axis: unmodeled manual sharing /
  // teams / sets / ControlledByParent's master sharing could still grant it).
  for (const s of steps) {
    if (s.verdict === 'unknown') return 'unknown';
  }
  // Every step is restricted; the cascade exhausted every modeled path.
  return 'restricted';
};

/** Canonical-id prefixes for the four userContext id families. */
const PROFILE_PREFIX = 'Profile:';
const PERMISSION_SET_PREFIX = 'PermissionSet:';
/** CR-CAP-04: a PSG id that may be passed in `permissionSetIds`; expanded to members. */
const PERMISSION_SET_GROUP_PREFIX = 'PermissionSetGroup:';
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
 *
 * **CR-CAP-04 PSG expansion is also verdict-preserving.** A `PermissionSetGroup:`
 * id in `permissionSetIds` is expanded into the member permission sets it
 * DENOTES and those are ADDED to the context (the PSG id is also kept so the
 * PermissionSetGroup reasoning step can report it; it never matches a grant
 * edge). Expansion only ever ADDS the real containers a PSG aggregates, turning
 * a PSG-assigned user's formerly-`unknown` answer into the real cascade verdict
 * — it cannot re-point or remove an existing grant.
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
    const coerced = uc.permissionSetIds.map((p) =>
      coercePrefix(p, [PERMISSION_SET_PREFIX]),
    );
    // CR-CAP-04: fold every PSG passed here into its member permission sets so
    // the REAL grant cascade (object-Read precondition, PermissionGrant,
    // SystemPermission, ModifyAll-for-create) decides PSG-derived access. A PSG
    // is detected by its `PermissionSetGroup:` prefix; a member that is a
    // phantom (no node) simply never matches a grant edge, exactly as today.
    // Dedupe so a permset reachable both directly and via a PSG is unioned once.
    const folded = new Set<string>();
    for (const id of coerced) {
      if (id.startsWith(PERMISSION_SET_GROUP_PREFIX)) {
        const expanded = await expandPermissionSetGroup(ctx, id as ComponentId);
        if (expanded.ok && expanded.value !== null) {
          for (const memberId of expanded.value.memberPermissionSetIds) {
            folded.add(memberId);
          }
          // Keep the PSG id too so the PermissionSetGroup reasoning step can
          // report which groups were expanded; it never matches a grant edge.
          folded.add(id);
          continue;
        }
      }
      folded.add(id);
    }
    out.permissionSetIds = [...folded];
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

  // Stage 1: OWD. Classify the org-wide default. A null/unrecognised OWD is the
  // ONLY OWD short-circuit: the entity variant has no OWD and we cannot reason
  // past it, so return `unknown` with the single OWD step. A PUBLIC OWD
  // (Read/ReadWrite/FullAccess) no longer short-circuits to `visible` here — the
  // object-Read PRECONDITION (plane A) must be confirmed FIRST. A public OWD
  // alone, with zero object permission, does NOT make a record visible; that was
  // the H1 bug. The OWD's `visible` verdict only survives to the aggregate when
  // the precondition (checked just below) passed.
  const owdStep = evaluateOWD(nodeResult.value, level);
  if (owdStep.verdict === 'unknown') {
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
  // OWD-unknown short-circuit so a null/unrecognised OWD skips the group graph
  // lookups. Verdict-preserving (see coerceUserContext): the coerced verdict
  // equals the equivalent prefixed-id verdict.
  const userContext = await coerceUserContext(ctx, input.userContext);

  // Plane A — the operation-aware OBJECT-CRUD PRECONDITION. To ACT on a record
  // the user needs object CRUD for THIS OPERATION (from the profile UNION any
  // assigned permission set): object Read for read, object Edit (or Modify All)
  // for edit, object Delete (or Modify All) for delete. Missing the
  // operation-level CRUD => NOT visible, full stop, regardless of OWD.
  //   - kills H1: a zero-permission user is no longer told they can see any
  //     Public-Read object; AND
  //   - kills CR-RV6: a Read-only user is no longer told they can EDIT every
  //     record on a ReadWriteTransfer OWD object (the OWD `visible` step can no
  //     longer win for an operation the user lacks the CRUD for), and an
  //     Edit-but-not-Delete user is no longer told they can DELETE on a
  //     FullAccess OWD object.
  // Honesty nuance: object perms are only decidable when a profile or permission
  // set was supplied — a role/group-only context cannot decide them, so we do
  // NOT hard-deny there; the cascade runs and the answer can stay an honest
  // `unknown` (mirrors the old profileAnchored nuance). FLS never enters this:
  // it reads only object-level grantedBy edges.
  const profileOrPermSetSupplied =
    userContext.profileId !== undefined ||
    (userContext.permissionSetIds !== undefined &&
      userContext.permissionSetIds.length > 0);
  if (profileOrPermSetSupplied) {
    const objectAccessResult = await hasObjectAccess(ctx, componentId, userContext, level);
    if (!objectAccessResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${objectAccessResult.error}`,
      });
    }
    if (!objectAccessResult.value) {
      // RV11: name the CRUD bit actually required for THIS operation, not Read.
      const levelLabel =
        level === 'read' ? 'Read' : level === 'edit' ? 'Edit' : 'Delete';
      return ok({
        data: {
          verdict: 'restricted',
          reasoning: [
            step(
              'PermissionGrant',
              'restricted',
              `no object ${levelLabel} permission on the supplied profile / permission sets — object ${levelLabel} is a precondition for record ${level}, so no OWD value or sharing grant can make the record ${level === 'read' ? 'visible' : level + 'able'}`,
            ),
          ],
        },
        vaultState: {
          sourceTreeHash: ctx.manifest.sourceTreeHash,
          refreshedAt: ctx.manifest.refreshedAt,
        },
      });
    }
  }

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

  // Stage 6 (CR-CAP-16): TerritoryAndGuestRules — a real per-rule evaluator over
  // the already-loaded sharing rules. Each attached guest / territory rule
  // surfaces its declared detail with an `unknown` verdict; absence preserves
  // the not-modeled disclosure (never `restricted`).
  reasoning.push(...evaluateTerritoryAndGuestRules(rulesResult.value, level));

  // Stages 7-9: ManualSharing, SharingSets, AccountTeams. Always `unknown` with
  // explanatory reasons. These document what v1.1 could not check so the admin
  // knows where to look manually.
  reasoning.push(...UNKNOWN_TAIL);

  return ok({
    data: {
      verdict: aggregateVerdict(reasoning),
      reasoning,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
