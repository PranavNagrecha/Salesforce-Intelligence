/**
 * Handler for the `sfi.who_can_access_object` MCP tool
 * (P11-ACCESS-who-can-see).
 *
 * The REVERSE of `sfi.why_cant_user_see_record`: that tool answers "can
 * THIS user see a record" (single user, forward); this one enumerates
 * WHICH profiles / permission sets / roles / groups gain access to an
 * object's records. It is a bounded, `declared`-confidence static view —
 * the three statically-knowable access sources:
 *
 *   1. **OWD** — a public org-wide default (`Read` / `ReadWrite` /
 *      `FullAccess`) grants every internal user access to every record.
 *   2. **Object permissions** — Profiles / PermissionSets whose
 *      `grantedBy` edge to the object carries `allowRead` / `allowCreate` /
 *      `allowEdit` / `allowDelete` (records visible per OWD + sharing; each
 *      CRUD bit enumerated independently per CR-04) or `viewAllRecords` /
 *      `modifyAllRecords` (ALL records of this object).
 *   3. **System god-mode** — `ViewAllData` / `ModifyAllData` on a profile
 *      or permission set (read / modify every record of every object).
 *   4. **Sharing rules** — the `sharedWith` targets (roles / groups) of
 *      the owner and criteria sharing rules on this object. CR-CAP-12: when a
 *      target is a public Group, its members (walked transitively through
 *      nested groups via `hasMember`) are each listed as their own granter
 *      row, not just the group; a dangling member (e.g. a Territory) is listed
 *      but flagged as unresolved. CR-CAP-05b: when a target is a Role carrying a
 *      `roleAndSubordinates` / `roleAndSubordinatesInternal` inheritance marker,
 *      it expands to the DESCENDING role subtree (every role below it via
 *      INBOUND `inheritsFrom`) — each subordinate role is its own granter row
 *      alongside the named role. An incomplete subtree (a subordinate Role node
 *      not retrieved, or the cap hit) sets a `blindSpot`, never a fabricated
 *      row. The `…Internal` variant runs the SAME descend, but its
 *      internal-vs-portal exclusion CANNOT be applied offline (Role nodes carry
 *      no portal flag), so an extra blindSpot discloses the enumerated subtree
 *      may include portal/partner roles the real rule excludes.
 *
 * Record-level paths it CANNOT enumerate statically are disclosed in
 * `blindSpots`, never fabricated: record ownership + the role hierarchy
 * above each owner, whether a given record matches a criteria predicate,
 * manual / Apex-managed sharing, account-teams, and sharing sets. When the
 * object carries RestrictionRules, an extra blind spot + a per-row caveat on
 * the god-mode granters disclose that any row — View/Modify All Data
 * included — can be narrowed at runtime (mirrors why_cant_user_see_record's
 * `unknown` god-mode verdict on such objects).
 *
 * Input: `{ componentId: 'CustomObject:X', limit?, offset? }`.
 */

import type {
  ComponentId,
  ComponentType,
  Edge,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges, listNodesByType } from '@sf-intelligence/graph';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { readActiveHoldersFor, type HoldersShape } from './facts-block.js';
import { expandGroupMembers } from './group-membership.js';
import {
  canonicalizeObjectScope,
  mergeInputAliases,
  toCustomObjectId,
  toObjectApiName,
} from './input-aliases.js';
import { paginateLegacy } from './page-cursor.js';
import { toolLocalPayloadBudgetBytes } from './response-budget.js';
import { expandRoleSubordinates, ROLE_PREFIX } from './role-hierarchy.js';
import { clampedNodeScanLimit, scanHitCap, scanTruncationNote } from './scan-cap.js';
import {
  SHARING_USER_ENUMERATION_NOT_AVAILABLE,
  USER_ASSIGNMENT_NOT_IN_VAULT,
  userAssignmentUnavailable,
} from './vault-assignment-disclosure.js';

/** Tool name the shared pager binds a minted cursor to. */
const WHO_CAN_ACCESS_OBJECT_TOOL = 'sfi.who_can_access_object';

const CUSTOM_OBJECT_PREFIX = 'CustomObject:';
/** CR-CAP-12: a `sharedWith` target that is a Group whose members we expand. */
const GROUP_MEMBER_PREFIX = 'Group:';
/** Page size for the granter list (a public object can have hundreds). */
const DEFAULT_LIMIT = 120;
const MAX_LIMIT = 250;
/**
 * How many distinct `granterId`s `summary.byGranterType[].sample` names per
 * kind. Enough to make a kind CONCRETE ("which profiles?" gets profile names,
 * not just a count) without turning the summary into a second copy of the list.
 */
const GRANTER_KIND_SAMPLE_LIMIT = 5;

/** Public org-wide defaults — every internal user can read (or read/write). */
const PUBLIC_OWD_READ = new Set(['Read', 'ReadWrite', 'ReadWriteTransfer', 'FullAccess']);

const whoCanAccessObjectInputBaseSchema = z.object({
  componentId: z.string().min(1),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
});

/** Zod schema for the `sfi.who_can_access_object` tool input. */
export const whoCanAccessObjectInputSchema = z.preprocess((raw) => {
  const merged = mergeInputAliases(raw, [
    { canonical: 'componentId', aliases: ['objectId', 'objectApiName'] },
  ]);
  if (merged !== null && typeof merged === 'object' && !Array.isArray(merged)) {
    const o = merged as Record<string, unknown>;
    const id = typeof o.componentId === 'string' ? o.componentId : '';
    if (id.length > 0 && !id.startsWith(CUSTOM_OBJECT_PREFIX)) {
      o.componentId = toCustomObjectId(id);
    }
  }
  return merged;
}, whoCanAccessObjectInputBaseSchema);

export type WhoCanAccessObjectInput = z.infer<typeof whoCanAccessObjectInputSchema>;

/**
 * How a principal gains access to this object's records.
 *
 * CR-04: object CRUD capabilities (read / create / edit / delete) are
 * ORTHOGONAL planes — a grantor can hold any combination, so each is enumerated
 * independently with its OWN `via` value. Distinct `via` values keep the
 * caller's `granterId|via` addressing collision-free FOR OBJECT-PERMISSION AND
 * SYSTEM GOD-MODE ROWS (a grantor with both Read and Edit emits two rows that
 * are individually addressable — one `grantedBy` edge per grantor, one node
 * per god-mode check). `view-all-object` / `modify-all-object` are the
 * object-level record-scope bypasses; the `system-*` pair is god-mode.
 *
 * The four `…-sharing-rule` variants do NOT carry this guarantee: `via`
 * encodes the RULE TYPE, not the rule's identity, so two DIFFERENT rules of
 * the same type sharing with the same principal (e.g. two criteria rules on
 * one object both targeting the same Group, one Read and one Edit) emit two
 * rows with the identical `granterId|via` pair — measured on a real vault:
 * `Group:nonO_A_Users|criteria-sharing-rule` from two distinct
 * `SharingRule` components. Those rows — and their expanded group-member /
 * role-subordinate rows — carry {@link AccessGranter.sourceRuleId}
 * specifically so `granterId|via|sourceRuleId` IS collision-free; do not
 * address a sharing-rule-derived row by `granterId|via` alone.
 */
export type AccessVia =
  | 'object-permission-read'
  | 'object-permission-create'
  | 'object-permission-edit'
  | 'object-permission-delete'
  | 'view-all-object'
  | 'modify-all-object'
  | 'system-view-all-data'
  | 'system-modify-all-data'
  | 'owner-sharing-rule'
  | 'criteria-sharing-rule'
  // CR-CAP-16: the guest / territory sharing-rule families. Without these the
  // else branch mislabeled them `owner-sharing-rule`, hiding that they are
  // record-level-context-gated (guest = site guest user; territory = territory
  // assignment) and shaped like criteria rules, not owner rules.
  | 'guest-sharing-rule'
  | 'territory-sharing-rule';

/** One principal that gains access, with the path and operation level. */
export interface AccessGranter {
  readonly granterId: string;
  readonly granterType: string;
  readonly granterLabel: string;
  readonly via: AccessVia;
  /**
   * The operation this path grants. CR-04: `create` and `delete` are now
   * enumerated independently (the old else-if chain dropped `delete` entirely
   * and subsumed lower capabilities); `all` is reserved for the record-scope
   * bypasses (View/Modify-All, god-mode).
   */
  readonly access: 'read' | 'create' | 'edit' | 'delete' | 'all';
  /** Whether the path reaches ALL records or only records visible per OWD/sharing. */
  readonly scope: 'all-records' | 'shared-records';
  readonly detail: string;
  /**
   * The exact `SharingRule` component id this row came from. Present ONLY on
   * sharing-rule-derived rows (`via` one of the four `…-sharing-rule`
   * variants, including their expanded group-member / role-subordinate
   * rows) — absent on object-permission and system god-mode rows, where
   * `granterId|via` is already collision-free on its own.
   *
   * `via` names the rule TYPE, not the rule; two different rules of the same
   * type sharing with the same principal at different access levels produce
   * two rows whose `granterId|via` pair is IDENTICAL (measured on a real
   * vault: `Group:nonO_A_Users|criteria-sharing-rule` from two distinct
   * rules). `granterId|via|sourceRuleId` is the addressing key that is
   * actually unique per row.
   */
  readonly sourceRuleId?: string;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface WhoCanAccessObjectOutput {
  readonly componentId: string;
  readonly objectLabel: string;
  readonly owd: string;
  /** True when a public OWD grants every internal user access to every record. */
  readonly owdGrantsAllInternalUsers: boolean;
  /**
   * External OWD (externalSharingModel) — controls access for Experience Cloud
   * / community (external) users. `null` when the object metadata does not
   * declare an external OWD (standard objects or non-sharing variants).
   */
  readonly externalOwd: string | null;
  readonly granters: readonly AccessGranter[];
  readonly summary: {
    /** ROW count — a grantor with multiple capability paths contributes >1 row. */
    readonly total: number;
    /** DISTINCT principal count (unique `granterId`) — count ACTORS by this. */
    readonly distinctGranters: number;
    readonly allRecordsAccess: number;
    readonly sharedRecordsAccess: number;
    /**
     * WHO-CAN-ACCESS-DEFAULT-PAGE-UNREPRESENTATIVE: the COMPLETE per-kind
     * breakdown, independent of paging.
     *
     * The granter list used to be sorted by `granterId` alone, which sorts by
     * TYPE PREFIX first — `Group:` < `PermissionSet:` < `Profile:` < `Role:` —
     * so the default page was a contiguous alphabetical block, not a sample.
     * Measured on a real vault: 218 rows, default page 120 = 98 PermissionSet +
     * 18 Profile + 4 Group, cutting mid-alphabet through the profiles and
     * showing ZERO of the 3 Role rows. The literal question this tool exists to
     * answer — "which profiles will be affected?" — came back with 18 of 113
     * profile rows and no signal that the rest existed.
     *
     * Two things fix that together: the page is now INTERLEAVED across kinds
     * (see the round-robin below), and this block reports each kind's TRUE
     * totals plus a named `sample` drawn from the complete set — so every kind
     * is both counted and named even when the page cannot hold it. Rows are
     * ordered by `granterType` ascending.
     */
    readonly byGranterType: readonly {
      readonly granterType: string;
      /** TRUE row count for this kind across ALL pages. */
      readonly rows: number;
      /** TRUE distinct principal count for this kind across ALL pages. */
      readonly distinctGranters: number;
      /** How many of this kind's rows are on the page in `granters`. */
      readonly rowsOnThisPage: number;
      /** Up to 5 distinct `granterId`s of this kind, from the COMPLETE set. */
      readonly sample: readonly string[];
    }[];
  };
  /**
   * WHO-CAN-ACCESS-NO-RESUME-POINTER — the SECOND HALF of the 0.3.2 fix.
   *
   * 0.3.2 repaired this tool's completeness FLAGS after it shipped 109 of 218
   * real rows reading `hasMore: false` / `truncated: false`. It never added the
   * pointer those flags imply. The payload that shipped from 0.3.2 to here said
   * "there are more granters" and then handed the caller nothing to reach them
   * with: no `nextOffset`, no `nextCursor`, and not even a top-level
   * `totalCount` to compare the shipped rows against — the row total lived only
   * inside `summary.total`, one level down, where no generic page reader looks.
   *
   * A caller walking that payload — a host agent asking "which profiles will
   * this change affect?" — saw `hasMore: true` and had to GUESS the next
   * `offset` from `granters.length`, which is only right when it happens to
   * equal the applied `limit`; the whole-response byte fit below routinely
   * ships FEWER rows than the requested limit, so the obvious guess
   * (`offset + limit`) silently skipped a whole window of profiles. The three
   * fields below close that: `totalCount` says how many rows exist,
   * `returnedCount` says how many arrived, and `nextOffset` says exactly where
   * to resume — all three computed by the shared `paginateLegacy` pager, never
   * re-spelled here.
   */
  readonly totalCount: number;
  /** Granter rows actually shipped in `granters` on THIS page. */
  readonly returnedCount: number;
  /** Page size APPLIED to this response (may be below the requested `limit` — see the byte fit). */
  readonly limit: number;
  /** Zero-based offset of the first row in `granters`. */
  readonly offset: number;
  readonly hasMore: boolean;
  /**
   * Offset to pass on the next call to reach the following page — always
   * `offset + granters.length`, so it describes the rows ACTUALLY shipped
   * rather than the rows the limit asked for. `null` when this page ends the
   * list. No `nextCursor` is emitted: this tool advertises only `limit` and
   * `offset`, and shipping an opaque token no advertised input accepts would be
   * a second unusable pointer.
   */
  readonly nextOffset: number | null;
  /**
   * True when rows remain past this page. Was `hasMore || offset > 0`, which
   * made the LAST page of a resumed walk publish `truncated: true` alongside
   * `hasMore: false` — the two completeness axes contradicting each other
   * (`envelope-honesty.ts` Law 2, P4). It now tracks `hasMore` exactly.
   */
  readonly truncated: boolean;
  /** True when a grantor/rule scan hit the per-type node cap — the list may be incomplete. */
  readonly scanTruncated: boolean;
  readonly confidence: 'declared';
  /** Record-level access paths that cannot be enumerated statically. */
  readonly blindSpots: readonly string[];
  readonly boundaryNote: string;
  /**
   * P13-PSA-counts: active-holder counts for the Profile/PermissionSet
   * granters on THIS page (`data_snapshot`), when captured — "held by N
   * active users" alongside the static grant.
   */
  readonly dataShape?: HoldersShape;
}

const BLIND_SPOTS: readonly string[] = Object.freeze([
  'Record ownership: a record owner — and every role ABOVE them in the role hierarchy — can access owned records. Owners are record data, not metadata, so they cannot be enumerated here.',
  'Criteria-based sharing rules grant access to records MATCHING a predicate; whether a given record matches needs record data. The rule targets are listed, but the matched record set is not.',
  'Manual sharing, Apex-managed sharing, account/opportunity/case teams, and sharing sets are record/runtime-level and are not modeled.',
]);

const flag = (p: Readonly<Record<string, unknown>>, k: string): boolean => p[k] === true;

const stringProp = (p: Readonly<Record<string, unknown>>, k: string): string =>
  typeof p[k] === 'string' ? (p[k] as string) : '';

/** Serialized size of a value, the same measure `jsonResult`'s global guard uses. */
const utf8Bytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');

/**
 * The parent CustomObject api name a SharingRule applies to. The v1.1 sharing
 * extractor sets the rule's `parentId` to `CustomObject:{Object}` and its
 * `apiName` to `{Object}.{RuleName}`; it does NOT emit a `properties.sObjectType`.
 * Keying on that non-existent property silently dropped EVERY sharing rule (the
 * filter `sObjectType !== objectApiName` was always true), so this surface
 * invented "no sharing rules gain access" under a Private OWD. Derive from
 * `parentId` first, then the `apiName` head, then the legacy `sObjectType`.
 */
const sharingRuleObjectApiName = (rule: Node): string => {
  const parentId = rule.parentId;
  if (typeof parentId === 'string' && parentId.startsWith('CustomObject:')) {
    return parentId.slice('CustomObject:'.length);
  }
  const dot = rule.apiName.indexOf('.');
  if (dot > 0) return rule.apiName.slice(0, dot);
  return stringProp(rule.properties, 'sObjectType');
};

/** A sharing rule's access level maps to the operation it grants. */
const ruleAccessToOp = (accessLevel: string): 'read' | 'edit' =>
  accessLevel === 'Edit' || accessLevel === 'ReadWrite' ? 'edit' : 'read';

/**
 * The `sfi.who_can_access_object` MCP tool. Enumerates the profiles /
 * permission sets / roles / groups that statically gain access to an
 * object's records, with each path and the record-level blind spots.
 */
export const whoCanAccessObjectHandler = async (
  ctx: Context,
  input: WhoCanAccessObjectInput,
): Promise<Result<McpResponse<WhoCanAccessObjectOutput>, McpError>> => {
  if (!input.componentId.startsWith(CUSTOM_OBJECT_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `componentId must start with '${CUSTOM_OBJECT_PREFIX}'; got '${input.componentId}'`,
      path: 'componentId',
    });
  }
  // Case-INSENSITIVE resolution through the ONE shared canonicalizer: api names
  // are case-insensitive on the platform, so `CustomObject:contact` names the
  // same object as `CustomObject:Contact`. The id used and echoed below is the
  // VAULT's exact casing; a case-only ambiguity is a named `invalid-query`; an
  // unknown name is left alone for the `component-not-found` just below.
  const canonical = await canonicalizeObjectScope(ctx.graph, {
    componentId: input.componentId,
    object: toObjectApiName(input.componentId),
  });
  if (!canonical.ok) return err(canonical.error);
  const componentId = canonical.value.componentId as ComponentId;
  const objectApiName = canonical.value.object;

  const objectResult = await getNodeById(ctx.graph, componentId);
  if (!objectResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${objectResult.error.message}` });
  }
  if (objectResult.value === null) {
    return err({
      kind: 'component-not-found',
      message: `no CustomObject matches \`${componentId}\` in this vault`,
      path: componentId,
    });
  }
  const objectNode = objectResult.value;
  const owd = stringProp(objectNode.properties, 'sharingModel') || 'Unknown';
  const owdGrantsAllInternalUsers = PUBLIC_OWD_READ.has(owd);
  const externalOwd = stringProp(objectNode.properties, 'externalSharingModel') ?? null;

  // Restriction rules on this object FILTER records for users matching each
  // rule's user criteria — narrowing even View/Modify All Data holders.
  // why_cant_user_see_record's god-mode stage returns `unknown` on such an
  // object; this enumeration must carry the same caveat or it overstates.
  const restrictionRulesResult = await listNodesByType(ctx.graph, 'RestrictionRule', {
    limit: 500,
  });
  if (!restrictionRulesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${restrictionRulesResult.error.message}`,
    });
  }
  const restrictionRules = restrictionRulesResult.value.filter(
    (n) => n.parentId === componentId,
  );
  const restrictionCaveat =
    restrictionRules.length > 0
      ? ` — caveat: ${restrictionRules.length} restriction rule(s) on this object can still filter records for matching users`
      : '';

  const granters: AccessGranter[] = [];
  // CR-RV10: clamp to the graph's hard cap so an operator with
  // SFI_NODE_SCAN_LIMIT > 500 gets a 500-row scan, not a hard `internal` error.
  // (Full B3 two-axis conversion is DEFERRED for this tool — it merges THREE
  // node types under one cursor and the SharingRule axis needs an
  // object-FILTERED count that countNodesByType's type-only form can't give.)
  const scanLimit = clampedNodeScanLimit();
  const truncatedTypes: string[] = [];
  // CR-CAP-12: set when a group's `hasMember` expansion hit a missing
  // nested/enclosing group node, so the member roster is possibly incomplete.
  let groupMembershipTruncated = false;
  // CR-CAP-05b: set when a roleAndSubordinates descend was capped or referenced
  // a subordinate role node not retrieved into the vault — the subtree is
  // possibly larger than enumerated (mirror CR-CAP-05: disclose, never invent).
  let roleSubtreeTruncated = false;
  // CR-CAP-05b: set when ANY shared target was `roleAndSubordinatesInternal` —
  // the internal-vs-portal exclusion cannot be applied offline (Role nodes carry
  // no portal flag), so the enumerated subtree may include portal/partner roles
  // the real rule excludes. Disclosed, never silently applied.
  let internalSubordinatesUndisclosable = false;

  // 1. Object permissions: incoming `grantedBy` edges from Profiles/PermSets.
  const grantsResult = await listEdges(ctx.graph, componentId, {
    direction: 'in',
    edgeType: 'grantedBy',
  });
  if (!grantsResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${grantsResult.error.message}` });
  }
  for (const edge of grantsResult.value) {
    const grantorResult = await getNodeById(ctx.graph, edge.fromId);
    if (!grantorResult.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${grantorResult.error.message}` });
    }
    const grantor: Node | null = grantorResult.value;
    if (grantor === null) continue;
    if (grantor.type !== 'Profile' && grantor.type !== 'PermissionSet') continue;
    const p = edge.properties;
    const base = {
      granterId: grantor.id,
      granterType: grantor.type,
      granterLabel: grantor.label ?? grantor.apiName,
    };
    // CR-04: object CRUD bits are ORTHOGONAL — evaluate each independently
    // rather than in an exclusive else-if chain (the old chain dropped Delete
    // entirely and let a higher capability subsume lower ones). A grantor with
    // Read+Edit+Modify-All now emits multiple rows, each individually
    // addressable by `granterId|via` (distinct `via` values). Mirrors
    // object-access-audit.ts's per-capability filters.
    // Record-scope bypasses (all-records) first:
    if (flag(p, 'modifyAllRecords')) {
      granters.push({ ...base, via: 'modify-all-object', access: 'all', scope: 'all-records', detail: 'object "Modify All" — read/edit/delete every record' });
    }
    if (flag(p, 'viewAllRecords')) {
      granters.push({ ...base, via: 'view-all-object', access: 'read', scope: 'all-records', detail: 'object "View All" — read every record' });
    }
    // Object-permission CRUD bits (shared-records — gated by OWD + sharing):
    if (flag(p, 'allowEdit')) {
      granters.push({ ...base, via: 'object-permission-edit', access: 'edit', scope: 'shared-records', detail: 'object Edit — records visible via OWD + sharing' });
    }
    if (flag(p, 'allowRead')) {
      granters.push({ ...base, via: 'object-permission-read', access: 'read', scope: 'shared-records', detail: 'object Read — records visible via OWD + sharing' });
    }
    if (flag(p, 'allowDelete')) {
      granters.push({ ...base, via: 'object-permission-delete', access: 'delete', scope: 'shared-records', detail: 'object Delete — records visible via OWD + sharing' });
    }
    if (flag(p, 'allowCreate')) {
      granters.push({ ...base, via: 'object-permission-create', access: 'create', scope: 'shared-records', detail: 'object Create — new records of this object' });
    }
  }

  // 2. System god-mode: scan Profiles + PermissionSets for View/Modify All Data.
  for (const type of ['Profile', 'PermissionSet'] as const) {
    const nodesResult = await listNodesByType(ctx.graph, type as ComponentType, {
      limit: scanLimit,
    });
    if (!nodesResult.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${nodesResult.error.message}` });
    }
    if (scanHitCap(nodesResult.value.length, scanLimit)) truncatedTypes.push(type);
    for (const node of nodesResult.value) {
      const perms = node.properties['userPermissions'];
      if (!Array.isArray(perms)) continue;
      const base = { granterId: node.id, granterType: type, granterLabel: node.label ?? node.apiName };
      if (perms.includes('ModifyAllData')) {
        granters.push({ ...base, via: 'system-modify-all-data', access: 'all', scope: 'all-records', detail: `Modify All Data — read/edit/delete every record of every object${restrictionCaveat}` });
      } else if (perms.includes('ViewAllData')) {
        granters.push({ ...base, via: 'system-view-all-data', access: 'read', scope: 'all-records', detail: `View All Data — read every record of every object${restrictionCaveat}` });
      }
    }
  }

  // 3. Sharing rules on this object: each rule's `sharedWith` targets gain its
  //    access level. Owner rules share to a fixed group/role; criteria / guest /
  //    territory rules share records matching a predicate (the matched set is a
  //    blind spot, and guest/territory add a requester-context blind spot).
  const rulesResult = await listNodesByType(ctx.graph, 'SharingRule', { limit: scanLimit });
  if (!rulesResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${rulesResult.error.message}` });
  }
  if (scanHitCap(rulesResult.value.length, scanLimit)) truncatedTypes.push('SharingRule');
  for (const rule of rulesResult.value) {
    if (sharingRuleObjectApiName(rule) !== objectApiName) continue;
    const ruleType = stringProp(rule.properties, 'ruleType');
    const accessLevel = stringProp(rule.properties, 'accessLevel') || 'Read';
    // CR-CAP-16: map each family to its own `via` so guest / territory rules are
    // not mislabeled `owner-sharing-rule` by the else branch.
    const via: AccessVia =
      ruleType === 'criteria'
        ? 'criteria-sharing-rule'
        : ruleType === 'guest'
          ? 'guest-sharing-rule'
          : ruleType === 'territory' || ruleType === 'territoryGroup'
            ? 'territory-sharing-rule'
            : 'owner-sharing-rule';
    // Criteria / guest / territory rules carry a predicate; owner rules do not.
    const predicate =
      ruleType === 'owner' ? '' : stringProp(rule.properties, 'booleanFilter');
    const siteName = ruleType === 'guest' ? stringProp(rule.properties, 'siteName') : '';
    const targetsResult = await listEdges(ctx.graph, rule.id, {
      direction: 'out',
      edgeType: 'sharedWith',
    });
    if (!targetsResult.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${targetsResult.error.message}` });
    }
    for (const edge of targetsResult.value as readonly Edge[]) {
      if (edge.properties['direction'] === 'from') continue; // the sharedFrom source side
      const targetLabel = edge.toId.includes(':') ? edge.toId.slice(edge.toId.indexOf(':') + 1) : edge.toId;
      const targetType = edge.toId.includes(':') ? edge.toId.slice(0, edge.toId.indexOf(':')) : 'Group';
      granters.push({
        granterId: edge.toId,
        granterType: targetType,
        granterLabel: targetLabel,
        via,
        access: ruleAccessToOp(accessLevel),
        scope: 'shared-records',
        // Disambiguates `granterId|via` when a second rule of the SAME type
        // shares with the SAME principal — see AccessGranter.sourceRuleId.
        sourceRuleId: rule.id,
        detail:
          ruleType === 'criteria'
            ? `criteria sharing rule ${rule.id} (${accessLevel}) shares records matching \`${predicate || '(predicate not extracted)'}\``
            : ruleType === 'guest'
              ? `guest sharing rule ${rule.id} (${accessLevel}) shares records matching \`${predicate || '(predicate not extracted)'}\` with the${siteName ? ` '${siteName}'` : ''} Experience Cloud site guest user (record-level + requester context required)`
              : ruleType === 'territory' || ruleType === 'territoryGroup'
                ? `${ruleType} sharing rule ${rule.id} (${accessLevel}) shares records matching \`${predicate || '(predicate not extracted)'}\` by territory assignment (record-level + territory context required)`
                : `owner sharing rule ${rule.id} (${accessLevel}) shares this user/group's owned records`,
      });
      // CR-CAP-12: a rule shared with a Group also reaches every member that
      // group contains (transitively, through nested groups), so list each
      // member as its own granter row instead of stopping at the group. The
      // member edges are `declared` (the group's `<related>` rows). A dangling
      // member (`resolvable: false`, e.g. a Territory) is still listed but
      // flagged in its detail so it is never read as a fully resolved principal.
      if (edge.toId.startsWith(GROUP_MEMBER_PREFIX)) {
        const expanded = await expandGroupMembers(ctx, edge.toId);
        if (!expanded.ok) {
          return err({ kind: 'internal', message: `graph query failed: ${expanded.error}` });
        }
        if (expanded.value.truncated) groupMembershipTruncated = true;
        for (const member of expanded.value.members) {
          const memberLabel = member.memberId.includes(':')
            ? member.memberId.slice(member.memberId.indexOf(':') + 1)
            : member.memberId;
          const memberType = member.memberId.includes(':')
            ? member.memberId.slice(0, member.memberId.indexOf(':'))
            : 'Group';
          const subDetail =
            member.inheritance === 'subordinates' ||
            member.inheritance === 'subordinatesInternal'
              ? ' (and its subordinate roles)'
              : '';
          const unresolved = member.resolvable
            ? ''
            : ' — dangling member (not a resolvable principal in this vault); verify in the org';
          granters.push({
            granterId: member.memberId,
            granterType: memberType,
            granterLabel: memberLabel,
            via,
            access: ruleAccessToOp(accessLevel),
            scope: 'shared-records',
            sourceRuleId: rule.id,
            detail: `${ruleType || 'owner'} sharing rule ${rule.id} (${accessLevel}) shares with group ${edge.toId}, which contains this ${member.memberType} member${subDetail}${unresolved}`,
          });
        }
      }
      // CR-CAP-05b: a rule shared with a Role carrying a `subordinates` /
      // `subordinatesInternal` inheritance marker also reaches every role BELOW
      // it in the role hierarchy. Walk the descending subtree (INBOUND
      // `inheritsFrom`) and list each subordinate role as its own granter row,
      // alongside the verbatim named-role row above. The marker is on the
      // `sharedWith` edge (sharing-rules.ts extraProps). Gated strictly on a
      // Role target + the marker so plain-role / group / criteria targets are
      // byte-identical to before.
      const inheritance = edge.properties['inheritance'];
      if (
        edge.toId.startsWith(ROLE_PREFIX) &&
        (inheritance === 'subordinates' || inheritance === 'subordinatesInternal')
      ) {
        if (inheritance === 'subordinatesInternal') {
          internalSubordinatesUndisclosable = true;
        }
        const subtree = await expandRoleSubordinates(ctx, edge.toId);
        if (!subtree.ok) {
          return err({ kind: 'internal', message: `graph query failed: ${subtree.error}` });
        }
        if (subtree.value.truncated) roleSubtreeTruncated = true;
        const internalNote =
          inheritance === 'subordinatesInternal'
            ? ' [internal-only filter NOT applied offline — may include portal/partner roles; verify in org]'
            : '';
        for (const subRoleId of subtree.value.roleIds) {
          if (subRoleId === edge.toId) continue; // the named role already emitted
          const subLabel = subRoleId.includes(':')
            ? subRoleId.slice(subRoleId.indexOf(':') + 1)
            : subRoleId;
          granters.push({
            granterId: subRoleId,
            granterType: 'Role',
            granterLabel: subLabel,
            via,
            access: ruleAccessToOp(accessLevel),
            scope: 'shared-records',
            sourceRuleId: rule.id,
            detail: `${ruleType || 'owner'} sharing rule ${rule.id} (${accessLevel}) shares with ${edge.toId} and its subordinate roles, which include this descendant role${internalNote}`,
          });
        }
      }
    }
  }

  // C2: an empty `granters` set for the sharing-rule paths is byte-identical
  // whether the object genuinely has no sharing rules or the SharingRule type
  // was never retrieved into this vault. `scanTruncated` only fires when the
  // scan HIT the per-type cap — never for a non-executed / empty retrieve — so
  // it does not cover this case. Consult manifest coverage and add a blind spot
  // when SharingRule was requested-but-empty / errored / scoped out, so the
  // (possibly empty) granter list is never read as the complete static access
  // model. Only when coverage is KNOWN (v4+ vault): a pre-v4 vault has no
  // coverage array, so we stay silent rather than emit spurious noise (mirrors
  // `buildEnumerationCoverageCaveat`'s `!coverage.coverageKnown` guard).
  const sharingRuleCoverage = summarizeCoverage(ctx.manifest, ['SharingRule']);
  const sharingRuleNotRetrieved =
    sharingRuleCoverage.coverageKnown &&
    sharingRuleCoverage.missingCoverage.includes('SharingRule');

  granters.sort((a, b) => {
    if (a.granterId !== b.granterId) return a.granterId < b.granterId ? -1 : 1;
    return a.via < b.via ? -1 : a.via > b.via ? 1 : 0;
  });

  const total = granters.length;
  // CR-04: a grantor can now hold several independent capabilities, so it spans
  // multiple rows. `total` is the ROW count; `distinctGranters` is the ACTOR
  // count consumers should use when "how many principals" matters.
  const distinctGranters = new Set(granters.map((g) => g.granterId)).size;
  const allRecordsAccess = granters.filter((g) => g.scope === 'all-records').length;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const offset = input.offset ?? 0;

  // WHO-CAN-ACCESS-DEFAULT-PAGE-UNREPRESENTATIVE: `granterId` ASC sorts by TYPE
  // PREFIX first, so a straight `slice(offset, offset + limit)` returned one
  // contiguous alphabetical block — every PermissionSet, then a partial run of
  // Profiles, then nothing. On a real vault the default page answered "which
  // profiles?" with 18 of 113 profile rows and showed no Role at all.
  //
  // Interleave the kinds ROUND-ROBIN instead: take the 1st row of each kind,
  // then the 2nd of each, and so on, kinds in `granterType` order and each
  // kind's rows in the existing `(granterId, via)` order. The result is a
  // deterministic PERMUTATION of the same list — every row appears exactly
  // once — so `offset`/`limit` still page the whole set exactly as before; only
  // WHICH rows land on page one changes, and page one now carries every kind
  // that exists (small kinds in full, large kinds evenly).
  const byKind = new Map<string, AccessGranter[]>();
  for (const g of granters) {
    const bucket = byKind.get(g.granterType);
    if (bucket === undefined) byKind.set(g.granterType, [g]);
    else bucket.push(g);
  }
  const kindOrder = [...byKind.keys()].sort();
  const interleaved: AccessGranter[] = [];
  const deepestKind = Math.max(0, ...[...byKind.values()].map((v) => v.length));
  for (let i = 0; i < deepestKind; i += 1) {
    for (const kind of kindOrder) {
      const row = byKind.get(kind)?.[i];
      if (row !== undefined) interleaved.push(row);
    }
  }

  const externalOwdNote =
    externalOwd !== null
      ? ` External OWD (externalSharingModel): '${externalOwd}' — controls access for Experience Cloud / community users.`
      : '';
  const owdNote = owdGrantsAllInternalUsers
    ? `OWD '${owd}' is PUBLIC — every internal user can ${owd === 'Read' ? 'read' : 'read and edit'} EVERY record of this object, beyond the principals listed.${externalOwdNote}`
    : `OWD '${owd}' is private/controlled — record access flows only from the listed grants/rules plus ownership.${externalOwdNote}`;
  const multiRowNote =
    total > distinctGranters
      ? ` ${total} granter rows come from ${distinctGranters} distinct Profile/PermissionSet/role/group(s) — each independent capability (read/create/edit/delete + View/Modify-All) is its own row, so a principal can appear in several. Count ACTORS by \`summary.distinctGranters\`, not row count.`
      : '';
  const scanTruncated = truncatedTypes.length > 0;
  const scanNote = scanTruncated ? ` ${scanTruncationNote(truncatedTypes, scanLimit)}` : '';

  // WHO-CAN-ACCESS-SILENT-BUDGET-DROP: at a large `limit` the handler's own
  // page fits `limit` but not the GLOBAL response byte budget, so the
  // envelope's blind tail-truncation pass (`jsonResult`) used to cut
  // `granters` out from under this handler's already-computed `hasMore` /
  // `truncated` — 218 real rows became 109 delivered while `data.truncated`
  // still read `false`. Fit the WHOLE `data` payload to the response budget
  // HERE, before jsonResult ever sees it, so `hasMore` / `truncated` / the
  // resume `offset` always describe the rows actually shipped (mirrors
  // flow_fault_audit's `flowFaultResponseBudgetBytes` fix — same defect
  // class, same cure: size the page against the whole response, not just the
  // one array).
  //
  // Dedup the holder-query ids ONCE against the full requested-limit page (a
  // superset of any smaller candidate page below, since a fixed `offset`
  // makes every smaller `pageLimit` a PREFIX of this one) — the search below
  // then only needs to FILTER this one result, never re-query the graph.
  const fullPage = interleaved.slice(offset, offset + limit);
  const fullContainerIds = [
    ...new Set(
      fullPage
        .map((g) => g.granterId)
        .filter((id) => id.startsWith('Profile:') || id.startsWith('PermissionSet:')),
    ),
  ];
  const fullDataShape = await readActiveHoldersFor(ctx, fullContainerIds as never);

  const blindSpots: string[] = [...BLIND_SPOTS];
  if (restrictionRules.length > 0) {
    blindSpots.push(
      `Active restriction rule(s) on this object (${restrictionRules
        .map((r) => r.id)
        .join(', ')}) FILTER records for users matching each rule's user criteria — any granter row here, including View/Modify All Data, can be narrowed at runtime. Use why_cant_user_see_record for a per-user verdict.`,
    );
  }
  if (sharingRuleNotRetrieved) {
    blindSpots.push(
      'Sharing-rule grants could not be enumerated because the `SharingRule` type was NOT retrieved into this vault (a scoped, errored, or empty retrieve). Any owner / criteria sharing-rule paths are **not checked**, never "none" — the listed granters are NOT the complete static access model. Run `sfi refresh` including SharingRule.',
    );
  }
  if (groupMembershipTruncated) {
    blindSpots.push(
      'A group shared with this object references a nested / member group whose node was NOT retrieved into this vault, so its membership expansion is INCOMPLETE — some member principals may be missing from the granter list. Run `sfi refresh` including Group.',
    );
  }
  if (roleSubtreeTruncated) {
    blindSpots.push(
      'A roleAndSubordinates sharing rule shares with a role whose role hierarchy BELOW it is INCOMPLETE — a subordinate Role node was not retrieved into this vault (a partial refresh) or the subtree scan was capped, so additional subordinate roles may also gain access but could NOT be enumerated here. Run `sfi refresh` including Role, or see `coverage_report`.',
    );
  }
  if (internalSubordinatesUndisclosable) {
    blindSpots.push(
      'A roleAndSubordinatesInternal sharing rule shares with a role and its INTERNAL subordinates only (excluding partner / community portal roles). Role nodes carry no portal/partner marker in the offline metadata, so the internal-vs-portal filter could NOT be applied — the enumerated subordinate roles may INCLUDE portal/partner roles the real rule excludes. Verify those roles in the org.',
    );
  }
  if (userAssignmentUnavailable(ctx)) {
    blindSpots.push(USER_ASSIGNMENT_NOT_IN_VAULT);
    blindSpots.push(SHARING_USER_ENUMERATION_NOT_AVAILABLE);
  }

  // Builds the COMPLETE `data` payload for a candidate page size — every
  // field the response ships, not just the paged ones — so the byte check
  // below measures exactly what `jsonResult` will measure. Sizing only the
  // paged subset (granters/summary/…) undercounted the fixed fields
  // (componentId/objectLabel/owd/…/blindSpots) and let a "fits" candidate
  // still land over budget once assembled — caught by re-running the FIX 2
  // repro after the first pass of this fix and seeing the global guard
  // engage anyway.
  const buildData = (pageLimit: number): WhoCanAccessObjectOutput => {
    // ADOPT the shared CR-22 pager rather than re-slicing here. It owns the
    // slice, `totalCount`, `returnedCount`, `hasMore` and the `nextOffset`
    // pointer in ONE place shared with ~50 other tools, so this tool cannot
    // drift from them again — a hand-rolled second copy of exactly this
    // arithmetic is what left the pointer missing for a whole release.
    //
    // `byteBudget` is deliberately disabled (`Number.MAX_SAFE_INTEGER`): the
    // pager's budget measures only the `granters` ARRAY, while this tool fits
    // the WHOLE `data` payload — fixed fields, summary and blindSpots included —
    // via the binary search below (WHO-CAN-ACCESS-SILENT-BUDGET-DROP). Letting
    // both trim would double-trim the page and leave the pointer describing the
    // pre-trim slice. The outer search varies `pageLimit`; the pager then
    // recomputes every pointer for the page that actually fits.
    const paged = paginateLegacy(interleaved, {
      offset,
      limit: pageLimit,
      byteBudget: Number.MAX_SAFE_INTEGER,
      binding: { tool: WHO_CAN_ACCESS_OBJECT_TOOL, vaultHash: ctx.manifest.sourceTreeHash },
    });
    const page = paged.items;
    const hasMore = paged.hasMore;
    const truncated = hasMore;

    // Per-kind TRUE totals + a named sample of EACH kind, so a kind the page
    // cannot hold is still counted and named rather than silently absent.
    const pageRowsByKind = new Map<string, number>();
    for (const g of page) {
      pageRowsByKind.set(g.granterType, (pageRowsByKind.get(g.granterType) ?? 0) + 1);
    }
    const byGranterType = kindOrder.map((granterType) => {
      const rows = byKind.get(granterType) ?? [];
      const distinctIds = [...new Set(rows.map((g) => g.granterId))].sort();
      return {
        granterType,
        rows: rows.length,
        distinctGranters: distinctIds.length,
        rowsOnThisPage: pageRowsByKind.get(granterType) ?? 0,
        sample: distinctIds.slice(0, GRANTER_KIND_SAMPLE_LIMIT),
      };
    });
    const kindNote =
      byGranterType.length > 0
        ? ` Rows are INTERLEAVED across granter kinds (round-robin), so this page samples every kind rather than one alphabetical block: ${byGranterType
            .map(
              (k) =>
                `${k.granterType} ${k.rowsOnThisPage.toString()} of ${k.rows.toString()} row(s) / ${k.distinctGranters.toString()} principal(s)`,
            )
            .join('; ')}. \`summary.byGranterType\` carries the complete per-kind counts and a named sample of each kind.`
        : '';
    // The note fires whenever this response IS a page — including the LAST
    // page of a resumed walk, where `truncated` is now correctly false but the
    // caller still needs to know they are looking at a window. It names the
    // exact resume offset rather than telling the caller to work it out: the
    // byte fit can ship fewer rows than `limit`, so `offset + limit` is the
    // wrong guess and was the only guess the old payload allowed.
    const pageNote =
      truncated || offset > 0
        ? ` Showing granters ${offset}–${offset + page.length} of ${paged.totalCount}; summary holds the complete counts. ${
            paged.nextOffset === null
              ? 'This is the last page.'
              : `Resume with offset=${paged.nextOffset} (same limit).`
          }`
        : '';

    // `fullDataShape.holders` was queried for the FULL requested-limit page;
    // every smaller candidate's container ids are a SUBSET of it (same fixed
    // `offset`, shorter prefix), so a candidate's shape is a pure in-memory
    // FILTER — no extra graph round-trips inside the fit search below.
    const pageContainerIds = new Set(
      page
        .map((g) => g.granterId)
        .filter((id) => id.startsWith('Profile:') || id.startsWith('PermissionSet:')),
    );
    const dataShape =
      fullDataShape === undefined
        ? undefined
        : { ...fullDataShape, holders: fullDataShape.holders.filter((h) => pageContainerIds.has(h.id)) };

    return {
      componentId,
      objectLabel: objectNode.label ?? objectNode.apiName,
      owd,
      owdGrantsAllInternalUsers,
      externalOwd,
      granters: page,
      summary: {
        total,
        distinctGranters,
        allRecordsAccess,
        sharedRecordsAccess: total - allRecordsAccess,
        byGranterType,
      },
      totalCount: paged.totalCount,
      returnedCount: page.length,
      limit: pageLimit,
      offset,
      hasMore,
      nextOffset: paged.nextOffset,
      truncated,
      scanTruncated,
      confidence: 'declared',
      ...(dataShape !== undefined ? { dataShape } : {}),
      blindSpots,
      boundaryNote: `${owdNote} Declared static view (object permissions + sharing-rule targets + system god-mode); record-level paths are in blindSpots.${multiRowNote}${kindNote}${pageNote}${scanNote}`,
    };
  };

  // Largest page that fits the WHOLE-response budget. Binary search rather
  // than a shrink-until-it-fits loop so the answer is the MAXIMUM fitting
  // page (an under-filled page is not wrong, but it costs the caller extra
  // round-trips) — mirrors flow_fault_audit's search exactly. Measures the
  // COMPLETE `data` object (`buildData`'s return), not just the paged
  // subset, so a candidate that "fits" here really does fit what
  // `jsonResult` will measure.
  const budget = toolLocalPayloadBudgetBytes();
  let data = buildData(limit);
  if (utf8Bytes(data) > budget && data.granters.length > 1) {
    let lo = 1;
    let hi = data.granters.length - 1;
    let best = buildData(1);
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const candidate = buildData(mid);
      if (utf8Bytes(candidate) <= budget) {
        best = candidate;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    data = best;
  }

  return ok({
    data,
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
